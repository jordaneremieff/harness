import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
	type AgentMatch,
	type AgentRule,
	AgentRules,
	agentClass,
	appendLine,
	countFires,
	defineRuleSchema,
	isAgentClass,
	MAX_AGENT_RULES,
	MAX_MATCH_BYTES,
	MAX_NOTE_BYTES,
	MAX_RULES_FILE_BYTES,
	needsOperatorConfirm,
	RULES_FILE,
	SCHEMA_VERSION,
	scopeAllows,
	validateMatch,
	validateNote,
	validateScope,
	validateSlug,
	validateSuggestion,
} from "./agent-rules.ts";

const timestamp = "2026-09-01T07:00:00Z";
const basicMatch: AgentMatch = { tool: "bash", command: "git" };

function rule(slug: string, overrides: Partial<AgentRule> = {}): AgentRule {
	return {
		version: SCHEMA_VERSION,
		slug,
		note: `Guidance for ${slug}.`,
		match: basicMatch,
		state: "active",
		model: "xai/grok-4.6",
		session: "session-1",
		at: timestamp,
		...overrides,
	};
}

async function loadLines(lines: unknown[]): Promise<{ dir: string; rules: AgentRules }> {
	const dir = await mkdtemp(join(tmpdir(), "policy-agent-rules-"));
	await writeFile(join(dir, RULES_FILE), `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`, "utf8");
	return { dir, rules: AgentRules.load(dir) };
}

async function classifier(match: AgentMatch, scope?: AgentRule["scope"]): Promise<AgentRules> {
	const record: Record<string, unknown> = { kind: "rule", ...rule("test", { match }) };
	if (scope !== undefined) record.scope = scope;
	return (await loadLines([record])).rules;
}

function expectInvalid(value: unknown, pattern: RegExp): void {
	assert.match(validateMatch(value) ?? "", pattern);
}

describe("agent rule schema", () => {
	it("accepts additive paths and requires migration across breaking transitions", () => {
		const additive = defineRuleSchema(3, { 2: "additive", 3: "additive" });
		assert.deepEqual(additive(1), { load: true, version: 1 });
		assert.deepEqual(additive(3), { load: true, version: 3 });

		const breaking = defineRuleSchema(3, { 2: "additive", 3: "breaking" });
		const rejected = breaking(1);
		assert.equal(rejected.load, false);
		if (!rejected.load) assert.match(rejected.reason, /breaking transition 2 to 3.*explicit migration/);
		assert.deepEqual(breaking(3), { load: true, version: 3 });
	});

	it("fails loudly when the current schema has an undeclared transition", () => {
		assert.throws(() => defineRuleSchema(3, { 2: "additive" }), /schema transition 2 to 3 is undeclared/);
	});
});

describe("agent rule validators", () => {
	it("accepts valid slugs and rejects every slug boundary", () => {
		assert.equal(validateSlug("no-force_push.v2"), null);
		assert.match(validateSlug(7) ?? "", /non-empty string/);
		assert.match(validateSlug("") ?? "", /non-empty string/);
		assert.match(validateSlug("Upper") ?? "", /must match/);
		assert.match(validateSlug(`a${"b".repeat(64)}`) ?? "", /must match/);
		assert.match(validateSlug("agent.force") ?? "", /must not start/);
		assert.match(validateSlug("routing.cat-read", ["routing.cat-read"]) ?? "", /built-in/);
	});

	it("enforces note content and its UTF-8 byte bound", () => {
		assert.equal(validateNote("Prefer the safe form."), null);
		assert.match(validateNote(7) ?? "", /non-empty string/);
		assert.match(validateNote("") ?? "", /non-empty string/);
		assert.match(validateNote("first\nsecond") ?? "", /newline/);
		assert.match(validateNote("first\rsecond") ?? "", /newline/);
		assert.equal(Buffer.byteLength("é".repeat(MAX_NOTE_BYTES / 2), "utf8"), MAX_NOTE_BYTES);
		assert.equal(validateNote("é".repeat(MAX_NOTE_BYTES / 2)), null);
		assert.match(validateNote(`a${"é".repeat(MAX_NOTE_BYTES / 2)}`) ?? "", /exceeds/);
	});

	it("closes and validates the suggested command form", () => {
		assert.equal(validateSuggestion(undefined), null);
		assert.equal(validateSuggestion({ command: "rg" }), null);
		assert.equal(validateSuggestion({ command: "rg", flags: ["files", "hidden"] }), null);
		assert.match(validateSuggestion(null) ?? "", /must be an object/);
		assert.match(validateSuggestion({ command: "rg", operands: ["src"] }) ?? "", /unknown key/);
		assert.match(validateSuggestion({}) ?? "", /non-empty string/);
		assert.match(validateSuggestion({ command: "" }) ?? "", /non-empty string/);
		assert.match(validateSuggestion({ command: ["rg", "fd"] }) ?? "", /non-empty string/);
		assert.match(validateSuggestion({ command: "/usr/bin/rg" }) ?? "", /without \/$/);
		assert.match(validateSuggestion({ command: "rg", flags: [] }) ?? "", /non-empty string array/);
		assert.match(validateSuggestion({ command: "rg", flags: [""] }) ?? "", /entries/);
		assert.match(validateSuggestion({ command: "rg", flags: ["--files"] }) ?? "", /normalized/);
		assert.match(validateSuggestion({ command: "rg", flags: ["max-count=1"] }) ?? "", /normalized/);
	});

	it("rejects unknown match keys and invalid required fields", () => {
		expectInvalid(null, /must be an object/);
		expectInvalid({ ...basicMatch, extra: true }, /unknown key/);
		expectInvalid({ command: "git" }, /tool/);
		expectInvalid({ ...basicMatch, tool: "read" }, /must equal/);
		expectInvalid({ tool: "bash" }, /command/);
		expectInvalid({ ...basicMatch, command: 3 }, /string/);
		expectInvalid({ ...basicMatch, command: "" }, /must not be empty/);
		expectInvalid({ ...basicMatch, command: [] }, /non-empty string array/);
		expectInvalid({ ...basicMatch, command: ["git", ""] }, /entries/);
	});

	it("rejects invalid flag arrays", () => {
		for (const key of ["flags", "absentFlags"] as const) {
			expectInvalid({ ...basicMatch, [key]: "force" }, new RegExp(key));
			expectInvalid({ ...basicMatch, [key]: [] }, new RegExp(key));
			expectInvalid({ ...basicMatch, [key]: [""] }, /entries/);
		}
	});

	it("closes and validates the operands object", () => {
		expectInvalid({ ...basicMatch, operands: [] }, /operands must be an object/);
		expectInvalid({ ...basicMatch, operands: { count: 2 } }, /unknown key/);
		for (const [key, value] of [
			["min", -1],
			["min", 1.5],
			["max", "2"],
		] as const) {
			expectInvalid({ ...basicMatch, operands: { [key]: value } }, /non-negative integer/);
		}
		expectInvalid({ ...basicMatch, operands: { min: 2, max: 1 } }, /must not exceed/);
		expectInvalid({ ...basicMatch, operands: { any: [] } }, /non-empty string array/);
		expectInvalid({ ...basicMatch, operands: { any: [""] } }, /entries/);
		expectInvalid({ ...basicMatch, operands: { at: [] } }, /at must be an object/);
		expectInvalid({ ...basicMatch, operands: { at: { first: "push" } } }, /non-numeric key/);
		expectInvalid({ ...basicMatch, operands: { at: { "0": "" } } }, /must not be empty/);
		expectInvalid({ ...basicMatch, operands: { at: { "0": [] } } }, /non-empty string array/);
	});

	it("closes and validates the pipe object", () => {
		expectInvalid({ ...basicMatch, pipe: [] }, /pipe must be an object/);
		expectInvalid({ ...basicMatch, pipe: { previous: "cat" } }, /unknown key/);
		for (const key of ["from", "to", "fromRedirect", "toRedirect"] as const) {
			expectInvalid({ ...basicMatch, pipe: { [key]: 1 } }, /boolean/);
		}
		expectInvalid({ ...basicMatch, pipe: { next: "" } }, /must not be empty/);
		expectInvalid({ ...basicMatch, pipe: { next: [] } }, /non-empty string array/);
		expectInvalid({ ...basicMatch, pipe: { later: [] } }, /non-empty string array/);
		expectInvalid({ ...basicMatch, pipe: { later: [""] } }, /entries/);
	});

	it("accepts the complete match vocabulary and enforces its byte bound", () => {
		assert.equal(
			validateMatch({
				tool: "bash",
				command: ["git", "gitu"],
				flags: ["f", "force"],
				absentFlags: ["dry-run"],
				operands: { min: 1, max: 3, any: ["push"], at: { "0": ["push", "fetch"] } },
				pipe: {
					from: false,
					to: true,
					fromRedirect: false,
					toRedirect: false,
					next: ["head", "sort"],
					later: ["uniq"],
				},
			}),
			null,
		);
		assert.match(validateMatch({ tool: "bash", command: "x".repeat(MAX_MATCH_BYTES) }) ?? "", /exceeds/);
	});

	it("closes scope and enforces every scope relationship", () => {
		assert.equal(validateScope(undefined), null);
		assert.match(validateScope({}) ?? "", /must name exclude or providers/);
		assert.equal(validateScope({ exclude: ["anthropic", "xai/grok-4.5"] }), null);
		assert.equal(validateScope({ providers: ["xai"], models: ["xai/grok-4.6"] }), null);
		assert.match(validateScope(null) ?? "", /object/);
		assert.match(validateScope({ everywhere: true }) ?? "", /unknown key/);
		assert.match(validateScope({ exclude: ["xai"], providers: ["xai"] }) ?? "", /mutually exclusive/);
		assert.match(validateScope({ models: ["xai/grok-4.6"] }) ?? "", /requires/);
		for (const key of ["exclude", "providers", "models"] as const) {
			const scoped = (value: unknown) => (key === "models" ? { providers: ["xai"], models: value } : { [key]: value });
			assert.match(validateScope(scoped("xai")) ?? "", /non-empty string array/);
			assert.match(validateScope(scoped([])) ?? "", /non-empty string array/);
			assert.match(validateScope(scoped([""])) ?? "", /entries/);
		}
		assert.match(validateScope({ providers: ["xai/grok"] }) ?? "", /must not contain/);
		assert.match(validateScope({ exclude: ["xai/grok/version"] }) ?? "", /at most one/);
		assert.match(validateScope({ providers: ["xai"], models: ["xai/grok/version"] }) ?? "", /at most one/);
	});
});

describe("agent match evaluation", () => {
	it("matches exact and any-of commands", async () => {
		const exact = await classifier({ tool: "bash", command: "git" });
		assert.deepEqual(exact.classify("git status"), ["agent.test"]);
		assert.deepEqual(exact.classify("gitu status"), []);
		const any = await classifier({ tool: "bash", command: ["git", "hg"] });
		assert.deepEqual(any.classify("hg status"), ["agent.test"]);
	});

	it("requires present flags, rejects absent flags, and reads combined shorts", async () => {
		const required = await classifier({ tool: "bash", command: "git", flags: ["f", "v"] });
		assert.deepEqual(required.classify("git -fv push"), ["agent.test"]);
		assert.deepEqual(required.classify("git -f push"), []);
		const absent = await classifier({ tool: "bash", command: "git", absentFlags: ["force", "f"] });
		assert.deepEqual(absent.classify("git push"), ["agent.test"]);
		assert.deepEqual(absent.classify("git push --force"), []);
	});

	it("matches operand min, max, any, and positional any-of constraints", async () => {
		const rules = await classifier({
			tool: "bash",
			command: "git",
			operands: { min: 1, max: 2, any: ["push", "fetch"], at: { "0": ["push", "fetch"] } },
		});
		assert.deepEqual(rules.classify("git push --force"), ["agent.test"]);
		assert.deepEqual(rules.classify("git fetch origin"), ["agent.test"]);
		assert.deepEqual(rules.classify("git"), []);
		assert.deepEqual(rules.classify("git push origin main"), []);
		assert.deepEqual(rules.classify("git status"), []);
	});

	it("matches pipeline direction and redirect booleans", async () => {
		const producer = await classifier({ tool: "bash", command: "printf", pipe: { from: false, to: true } });
		assert.deepEqual(producer.classify("printf x | grep x"), ["agent.test"]);
		assert.deepEqual(producer.classify("printf x"), []);
		const consumer = await classifier({ tool: "bash", command: "grep", pipe: { from: true, to: false } });
		assert.deepEqual(consumer.classify("printf x | grep x"), ["agent.test"]);
		const redirects = await classifier({
			tool: "bash",
			command: "cat",
			pipe: { fromRedirect: true, toRedirect: true },
		});
		assert.deepEqual(redirects.classify("cat < input > output"), ["agent.test"]);
		assert.deepEqual(redirects.classify("cat input"), []);
	});

	it("matches immediate and any later pipeline commands", async () => {
		const next = await classifier({ tool: "bash", command: "find", pipe: { next: ["sort", "head"] } });
		assert.deepEqual(next.classify("find . | sort | head"), ["agent.test"]);
		assert.deepEqual(next.classify("find . | uniq | sort"), []);
		const later = await classifier({ tool: "bash", command: "find", pipe: { later: ["head", "tail"] } });
		assert.deepEqual(later.classify("find . | sort | head"), ["agent.test"]);
		assert.deepEqual(later.classify("find . | sort | uniq"), []);
	});

	it("fires on any matching stage or statement and returns sorted classes", async () => {
		const { rules } = await loadLines([
			{ kind: "rule", ...rule("z-last", { match: { tool: "bash", command: "git" } }) },
			{ kind: "rule", ...rule("a-first", { match: { tool: "bash", command: "rm" } }) },
		]);
		assert.deepEqual(rules.classify("echo ok; git status; rm file"), ["agent.a-first", "agent.z-last"]);
		assert.deepEqual(rules.classify("echo safe"), []);
	});
});

describe("agent rule scope and posture", () => {
	it("applies the provider and model scope matrix", () => {
		assert.equal(scopeAllows(undefined, null), true);
		assert.equal(scopeAllows(undefined, "xai/grok-4.6"), true);
		assert.equal(scopeAllows({ exclude: ["xai"] }, "xai/grok-4.6"), false);
		assert.equal(scopeAllows({ exclude: ["xai"] }, "anthropic/claude"), true);
		assert.equal(scopeAllows({ exclude: ["xai/grok-4.5"] }, "xai/grok-4.5"), false);
		assert.equal(scopeAllows({ exclude: ["xai/grok-4.5"] }, "xai/grok-4.6"), true);
		assert.equal(scopeAllows({ providers: ["xai"] }, "xai/grok-4.6"), true);
		assert.equal(scopeAllows({ providers: ["xai"] }, "anthropic/claude"), false);
		assert.equal(scopeAllows({ providers: ["xai"], models: ["xai/grok-4.6"] }, "xai/grok-4.6"), true);
		assert.equal(scopeAllows({ providers: ["xai"], models: ["xai/grok-4.6"] }, "xai/grok-4.7"), false);
		assert.equal(scopeAllows({ providers: ["xai"] }, null), false);
		assert.equal(scopeAllows({ exclude: ["anthropic"] }, null), false);
	});

	it("classifies every scope while scope gates notes and blocking", async () => {
		const matrix: Array<{
			slug: string;
			scope?: AgentRule["scope"];
			allowed: Array<string | null>;
		}> = [
			{
				slug: "unscoped",
				allowed: [null, "anthropic/claude", "xai/grok-4.5", "xai/grok-4.6"],
			},
			{ slug: "exclude-provider", scope: { exclude: ["xai"] }, allowed: ["anthropic/claude"] },
			{
				slug: "exclude-model",
				scope: { exclude: ["xai/grok-4.5"] },
				allowed: ["anthropic/claude", "xai/grok-4.6"],
			},
			{
				slug: "provider",
				scope: { providers: ["xai"] },
				allowed: ["xai/grok-4.5", "xai/grok-4.6"],
			},
			{
				slug: "model",
				scope: { providers: ["xai"], models: ["xai/grok-4.6"] },
				allowed: ["xai/grok-4.6"],
			},
		];
		const lines: unknown[] = [];
		for (const entry of matrix) {
			lines.push({ kind: "rule", ...rule(entry.slug, { scope: entry.scope }) });
			lines.push({
				kind: "state",
				slug: entry.slug,
				state: "promoted",
				model: "xai/grok-4.6",
				session: "session-2",
				at: timestamp,
			});
		}
		const { rules } = await loadLines(lines);
		assert.deepEqual(rules.classify("git status"), matrix.map((entry) => agentClass(entry.slug)).sort());
		for (const entry of matrix) {
			for (const model of [null, "anthropic/claude", "xai/grok-4.5", "xai/grok-4.6"] as const) {
				const allowed = entry.allowed.includes(model);
				assert.equal(rules.noteFor(agentClass(entry.slug), model), allowed ? `Guidance for ${entry.slug}.` : undefined);
				assert.equal(rules.isBlocking(agentClass(entry.slug), model), allowed);
			}
		}
	});

	it("requires confirmation exactly when a promoted posture is lowered", () => {
		const states = ["active", "promoted", "disabled", "discarded"] as const;
		for (const from of states) {
			for (const to of states) {
				assert.equal(needsOperatorConfirm(from, to), from === "promoted" && to !== "promoted", `${from} -> ${to}`);
			}
		}
	});
});

describe("AgentRules registry", () => {
	it("names and recognizes the agent class namespace", () => {
		assert.equal(agentClass("no-force"), "agent.no-force");
		assert.equal(isAgentClass("agent.no-force"), true);
		assert.equal(isAgentClass("routing.cat-read"), false);
	});

	it("adds current-version rules, refuses duplicates, and enforces the registry cap", async () => {
		const dir = await mkdtemp(join(tmpdir(), "policy-agent-rules-"));
		const rules = new AgentRules(dir);
		const { version: suppliedVersion, ...same } = rule("same");
		assert.equal(suppliedVersion, SCHEMA_VERSION);
		assert.equal(await rules.add(same), null);
		assert.equal(rules.get("same")?.version, SCHEMA_VERSION);
		assert.match((await rules.add(rule("same"))) ?? "", /already exists/);
		for (let index = 1; index < MAX_AGENT_RULES; index++) {
			assert.equal(await rules.add(rule(`rule-${index}`)), null);
		}
		assert.equal(rules.list().length, MAX_AGENT_RULES);
		assert.match((await rules.add(rule("overflow"))) ?? "", /full/);
	});

	it("refuses self-flagging and enabled-rule suggestions while allowing clean forms", async () => {
		const dir = await mkdtemp(join(tmpdir(), "policy-agent-rules-"));
		const rules = new AgentRules(dir);
		assert.match(
			(await rules.add(
				rule("self-flagging", {
					match: { tool: "bash", command: "git" },
					suggest: { command: "git" },
				}),
			)) ?? "",
			/agent\.self-flagging/,
		);
		assert.equal(rules.get("self-flagging"), undefined);

		assert.equal(
			await rules.add(
				rule("force-form", {
					match: { tool: "bash", command: "git", flags: ["force"] },
					scope: { providers: ["anthropic"] },
				}),
			),
			null,
		);
		assert.match(
			(await rules.add(
				rule("suggest-force", {
					match: { tool: "bash", command: "danger" },
					suggest: { command: "git", flags: ["force"] },
				}),
			)) ?? "",
			/agent\.force-form/,
		);
		assert.equal(await rules.setState("force-form", "promoted", "xai/grok-4.6", "s2", timestamp), null);
		assert.match(
			(await rules.add(
				rule("suggest-promoted-force", {
					match: { tool: "bash", command: "other-danger" },
					suggest: { command: "git", flags: ["force"] },
				}),
			)) ?? "",
			/agent\.force-form/,
		);
		assert.equal(
			await rules.add(
				rule("suggest-lease", {
					match: { tool: "bash", command: "danger" },
					suggest: { command: "git", flags: ["force-with-lease"] },
				}),
			),
			null,
		);
		assert.equal(
			await rules.add(
				rule("suggest-ls", {
					match: { tool: "bash", command: "other-danger" },
					suggest: { command: "ls" },
				}),
			),
			null,
		);
		assert.match(
			(await rules.add(
				rule("suggest-recursive-ls", {
					match: { tool: "bash", command: "third-danger" },
					suggest: { command: "ls", flags: ["R"] },
				}),
			)) ?? "",
			/bounds\.ls-recursive-uncapped|form\.ls-recursive/,
		);
	});

	it("rechecks suggestions before promotion and leaves refused rules active", async () => {
		const dir = await mkdtemp(join(tmpdir(), "policy-agent-rules-"));
		const rules = new AgentRules(dir);
		assert.equal(
			await rules.add(
				rule("candidate", {
					match: { tool: "bash", command: "danger" },
					suggest: { command: "safe-command" },
				}),
			),
			null,
		);
		assert.equal(await rules.add(rule("later-rule", { match: { tool: "bash", command: "safe-command" } })), null);
		assert.match(
			(await rules.setState("candidate", "promoted", "xai/grok-4.6", "s2", timestamp)) ?? "",
			/agent\.later-rule/,
		);
		assert.equal(rules.get("candidate")?.state, "active");
		assert.equal(await rules.setState("later-rule", "disabled", "xai/grok-4.6", "s2", timestamp), null);
		assert.equal(await rules.setState("candidate", "promoted", "xai/grok-4.6", "s2", timestamp), null);
		assert.equal(rules.get("candidate")?.state, "promoted");
	});

	it("refuses promotion when the target would flag another enabled rule's suggestion", async () => {
		const dir = await mkdtemp(join(tmpdir(), "policy-agent-rules-"));
		const rules = new AgentRules(dir);
		assert.equal(
			await rules.add(
				rule("first-rule", {
					match: { tool: "bash", command: "danger" },
					suggest: { command: "later-safe" },
				}),
			),
			null,
		);
		assert.equal(await rules.setState("first-rule", "promoted", "xai/grok-4.6", "s2", timestamp), null);
		assert.equal(await rules.add(rule("later-rule", { match: { tool: "bash", command: "later-safe" } })), null);
		assert.equal(await rules.add(rule("unrelated", { match: { tool: "bash", command: "unrelated" } })), null);
		assert.equal(await rules.setState("unrelated", "promoted", "xai/grok-4.6", "s2", timestamp), null);
		assert.match(
			(await rules.setState("later-rule", "promoted", "xai/grok-4.6", "s2", timestamp)) ?? "",
			/rule "first-rule"[\s\S]*agent\.later-rule/,
		);
		assert.equal(rules.get("later-rule")?.state, "active");
		assert.equal(await rules.setState("first-rule", "disabled", "xai/grok-4.6", "s2", timestamp), null);
		assert.equal(await rules.setState("later-rule", "promoted", "xai/grok-4.6", "s2", timestamp), null);
		assert.equal(rules.get("later-rule")?.state, "promoted");
	});

	it("changes posture, hides discarded rules, and resolves notes and blocking", async () => {
		const dir = await mkdtemp(join(tmpdir(), "policy-agent-rules-"));
		const rules = new AgentRules(dir);
		assert.equal(await rules.add(rule("z-rule")), null);
		assert.equal(await rules.add(rule("a-rule", { note: "Use a safer command." })), null);
		assert.deepEqual(
			rules.list().map((entry) => entry.slug),
			["a-rule", "z-rule"],
		);
		assert.equal(rules.noteFor("agent.a-rule", null), "Use a safer command.");
		assert.equal(rules.noteFor("routing.cat-read", "xai/grok-4.6"), undefined);
		assert.equal(rules.isBlocking("agent.a-rule", "xai/grok-4.6"), false);
		assert.equal(await rules.setState("a-rule", "promoted", "xai/grok-4.6", "s2", timestamp), null);
		assert.equal(rules.isBlocking("agent.a-rule", "xai/grok-4.6"), true);
		assert.equal(await rules.setState("a-rule", "disabled", "xai/grok-4.6", "s2", timestamp), null);
		assert.deepEqual(rules.classify("git status"), ["agent.z-rule"]);
		assert.equal(await rules.setState("a-rule", "discarded", "xai/grok-4.6", "s2", timestamp), null);
		assert.deepEqual(
			rules.list().map((entry) => entry.slug),
			["z-rule"],
		);
		assert.equal(rules.noteFor("agent.a-rule", null), "Use a safer command.");
		assert.match((await rules.setState("a-rule", "active", "xai/grok-4.6", "s2", timestamp)) ?? "", /cannot/);
		assert.match((await rules.setState("unknown", "active", "xai/grok-4.6", "s2", timestamp)) ?? "", /unknown/);
	});

	it("updates memory only after a successful append", async () => {
		const base = await mkdtemp(join(tmpdir(), "policy-agent-rules-"));
		const blocked = join(base, "not-a-directory");
		await writeFile(blocked, "x", "utf8");
		const rules = new AgentRules(blocked);
		assert.ok(await rules.add(rule("not-added")));
		assert.deepEqual(rules.list(), []);
	});
});

describe("agent rule file", () => {
	it("round-trips appends, replays the last state, and skips invalid records", async () => {
		const dir = await mkdtemp(join(tmpdir(), "policy-agent-rules-"));
		const rules = new AgentRules(dir);
		assert.equal(await rules.add(rule("persisted", { suggest: { command: "printf" } })), null);
		assert.equal(await rules.setState("persisted", "promoted", "anthropic/claude", "s2", timestamp), null);
		assert.equal(await rules.setState("persisted", "disabled", "xai/grok-4.6", "s3", timestamp), null);
		assert.equal(
			await appendLine(
				dir,
				JSON.stringify({
					kind: "rule",
					...rule("bad-match", { match: { tool: "bash", command: "git", surprise: true } as AgentMatch }),
				}),
			),
			null,
		);
		assert.equal(
			await appendLine(
				dir,
				JSON.stringify({
					kind: "state",
					slug: "unknown",
					state: "promoted",
					model: "xai/grok",
					session: "s",
					at: timestamp,
				}),
			),
			null,
		);
		const loaded = AgentRules.load(dir);
		assert.deepEqual(
			loaded.list().map((entry) => [entry.slug, entry.state]),
			[["persisted", "disabled"]],
		);
		assert.deepEqual(loaded.get("persisted")?.suggest, { command: "printf" });
		assert.equal(loaded.noteFor("agent.bad-match", "xai/grok-4.6"), undefined);
		assert.equal((await stat(join(dir, RULES_FILE))).mode & 0o777, 0o600);
	});

	it("loads additive version-1 rules, classifies them, and applies their state records", async () => {
		assert.equal(SCHEMA_VERSION, 2);
		const oldRule = { kind: "rule", ...rule("version-one"), version: 1 };
		const oldState = {
			kind: "state",
			slug: "version-one",
			state: "promoted",
			model: "xai/grok-4.6",
			session: "session-2",
			at: timestamp,
		};
		const text = `${JSON.stringify(oldRule)}\n${JSON.stringify(oldState)}\n${JSON.stringify({ kind: "rule", ...rule("current") })}\n`;
		const dir = await mkdtemp(join(tmpdir(), "policy-agent-rules-"));
		const path = join(dir, RULES_FILE);
		await writeFile(path, text, "utf8");
		const warnings: string[] = [];
		const original = console.warn;
		console.warn = (message: string) => warnings.push(message);
		let loaded: AgentRules;
		try {
			loaded = AgentRules.load(dir);
		} finally {
			console.warn = original;
		}
		assert.deepEqual(
			loaded.list().map((entry) => [entry.slug, entry.version, entry.state]),
			[
				["current", 2, "active"],
				["version-one", 1, "promoted"],
			],
		);
		assert.equal(loaded.get("version-one")?.suggest, undefined);
		assert.deepEqual(loaded.classify("git status"), ["agent.current", "agent.version-one"]);
		assert.equal(loaded.isBlocking("agent.version-one", "xai/grok-4.6"), true);
		assert.deepEqual(warnings, []);
		assert.equal(await readFile(path, "utf8"), text);
	});

	it("warns once and ignores missing and newer rule versions and their state records", async () => {
		assert.equal(SCHEMA_VERSION, 2);
		const dir = await mkdtemp(join(tmpdir(), "policy-agent-rules-"));
		const versionless: Record<string, unknown> = { kind: "rule", ...rule("versionless") };
		delete versionless.version;
		const state = (slug: string) => ({
			kind: "state",
			slug,
			state: "promoted",
			model: "xai/grok-4.6",
			session: "session-2",
			at: timestamp,
		});
		await writeFile(
			join(dir, RULES_FILE),
			`${[
				versionless,
				state("versionless"),
				{ kind: "rule", ...rule("version-three"), version: 3 },
				state("version-three"),
				{ kind: "rule", ...rule("current") },
			]
				.map((entry) => JSON.stringify(entry))
				.join("\n")}\n`,
			"utf8",
		);
		const warnings: string[] = [];
		const original = console.warn;
		console.warn = (message: string) => warnings.push(message);
		let loaded: AgentRules;
		try {
			loaded = AgentRules.load(dir);
		} finally {
			console.warn = original;
		}
		assert.deepEqual(
			loaded.list().map((entry) => entry.slug),
			["current"],
		);
		assert.equal(loaded.get("versionless"), undefined);
		assert.equal(loaded.get("version-three"), undefined);
		assert.equal(warnings.length, 1);
		assert.match(warnings[0], /skipped 2 rule records/);
		assert.match(warnings[0], /missing or invalid schema version/);
		assert.match(warnings[0], /record schema version 3.*build's schema version 2/);
	});

	it("upserts valid rule records in line order", async () => {
		const first = { kind: "rule", ...rule("same", { note: "First note." }) };
		const second = { kind: "rule", ...rule("same", { note: "Last note." }) };
		const { rules } = await loadLines([first, second]);
		assert.equal(rules.noteFor("agent.same", null), "Last note.");
		assert.equal(rules.get("same")?.state, "active");
	});

	it("loads a missing file as an empty registry", async () => {
		const dir = await mkdtemp(join(tmpdir(), "policy-agent-rules-"));
		assert.deepEqual(AgentRules.load(join(dir, "missing")).list(), []);
	});

	it("warns once and uses an empty registry after a JSON parse failure", async () => {
		const dir = await mkdtemp(join(tmpdir(), "policy-agent-rules-"));
		await writeFile(
			join(dir, RULES_FILE),
			`${JSON.stringify({ kind: "rule", ...rule("before") })}\nnot-json\n`,
			"utf8",
		);
		const warnings: string[] = [];
		const original = console.warn;
		console.warn = (message: string) => warnings.push(message);
		let loaded: AgentRules;
		try {
			loaded = AgentRules.load(dir);
		} finally {
			console.warn = original;
		}
		assert.deepEqual(loaded.list(), []);
		assert.equal(warnings.length, 1);
		assert.match(warnings[0], /line 2/);
	});

	it("keeps each append within the file byte cap", async () => {
		const dir = await mkdtemp(join(tmpdir(), "policy-agent-rules-"));
		const path = join(dir, RULES_FILE);
		await writeFile(path, Buffer.alloc(MAX_RULES_FILE_BYTES - 1, "x"));
		assert.match((await appendLine(dir, "{}")) ?? "", /exceeds/);
		assert.equal((await stat(path)).size, MAX_RULES_FILE_BYTES - 1);
	});

	it("writes complete JSONL lines", async () => {
		const dir = await mkdtemp(join(tmpdir(), "policy-agent-rules-"));
		assert.equal(await appendLine(dir, '{"kind":"one"}'), null);
		assert.equal(await appendLine(dir, '{"kind":"two"}'), null);
		assert.equal(await readFile(join(dir, RULES_FILE), "utf8"), '{"kind":"one"}\n{"kind":"two"}\n');
	});
});

describe("firing counts", () => {
	it("treats a missing store directory as a complete empty history", async () => {
		const root = await mkdtemp(join(tmpdir(), "policy-agent-fires-"));
		const result = await countFires(join(root, "missing"));
		assert.equal(result.partial, false);
		assert.equal(result.allFires.size, 0);
		assert.equal(result.firesByModel.size, 0);
	});

	it("retains agent-only totals while also counting built-ins by model", async () => {
		const dir = await mkdtemp(join(tmpdir(), "policy-agent-fires-"));
		await writeFile(
			join(dir, "2026-08-31.jsonl"),
			`${JSON.stringify({ classes: ["agent.alpha", "routing.cat-read", "agent.alpha"] })}\n${JSON.stringify({ classes: ["agent.beta", 7] })}\n`,
			"utf8",
		);
		await writeFile(
			join(dir, "2026-09-01.jsonl"),
			`${JSON.stringify({ classes: ["agent.alpha", "agent.gamma"] })}\n`,
			"utf8",
		);
		await writeFile(join(dir, RULES_FILE), `${JSON.stringify({ classes: ["agent.from-rules-file"] })}\n`, "utf8");
		await writeFile(join(dir, "notes.jsonl"), `${JSON.stringify({ classes: ["agent.from-other-file"] })}\n`, "utf8");
		const result = await countFires(dir);
		assert.equal(result.partial, false);
		assert.deepEqual([...result.fires.entries()].sort(), [
			["agent.alpha", 3],
			["agent.beta", 1],
			["agent.gamma", 1],
		]);
		assert.equal(result.allFires.get("routing.cat-read"), 1);
		assert.equal(result.firesByModel.get("agent.alpha")?.get(null), 3);
	});

	it("returns counts through the byte bound and marks them partial", async () => {
		const dir = await mkdtemp(join(tmpdir(), "policy-agent-fires-"));
		const first = `${JSON.stringify({ classes: ["agent.first"] })}\n`;
		const second = `${JSON.stringify({ classes: ["agent.second"] })}\n`;
		await writeFile(join(dir, "2026-09-01.jsonl"), `${first}${second}`, "utf8");
		const result = await countFires(dir, Buffer.byteLength(first, "utf8"));
		assert.equal(result.partial, true);
		assert.equal(result.fires.get("agent.first"), 1);
		assert.equal(result.fires.has("agent.second"), false);
	});
});
