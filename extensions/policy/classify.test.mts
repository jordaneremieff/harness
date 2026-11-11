import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { captureFor, classify, evaluateCommandRecords, matchRuleRecords, notesFor, redactFor, ruleScopeMatches } from "./classify.ts";
import type { RuleRecord } from "./rule.ts";

describe("CLI command-operand evidence", () => {
	const record: RuleRecord = {
		id: "synthetic.git", source: { kind: "package" },
		matcher: { kind: "declarative", language: "command-shape/v1", onUnavailable: "deny",
			spec: { command: "git", cli: { profile: "git", subcommand: ["push"] } } },
		definition: { purpose: "Evaluate the declared command.", authority: "exact", revision: "123456abcdef",
			state: "active", effect: "block", note: "Use a permitted command shape." },
		matcherAvailable: true, staleOverride: false,
	};
	const scope = { cwd: "/project", provider: "test", model: "test/model" };
	it("does not infer child argv from wrappers or find expressions", () => {
		for (const command of ["timeout 1 git push", "setsid git push", "flock 9 git push",
			"flock lock -c 'git push'", "parallel git push ::: origin", "xargs git push",
			"find src -exec git push \\;", "find src -execdir git push +", "find src -ok git push \\;",
			"find src -okdir git push \\;", "find src $expression"] ) {
			const evidence = evaluateCommandRecords("bash", command, [record], scope);
			assert.equal(evidence.get(record.id), "unknown", command);
			assert.deepEqual(evidence.reasons.get(record.id), ["opaque-command-operand"]);
			assert.equal(evidence.segments.get(record.id), undefined);
		}
	});
	it("retains lexical matches and lets direct true evidence win", () => {
		for (const command of ["git push", "timeout 1 echo x; git push", "for x in a; do git push; done"])
			assert.equal(evaluateCommandRecords("bash", command, [record], scope).get(record.id), true);
		for (const command of ["git status", "find src -type f", "echo safe", 'for f in $(fd -t f design | head -n 20); do wc -c "$f"; done'])
			assert.equal(evaluateCommandRecords("bash", command, [record], scope).get(record.id), false, command);
		const lexical = { ...record, matcher: { kind: "declarative" as const, language: "command-shape/v1" as const, spec: { command: "timeout" } } };
		assert.equal(evaluateCommandRecords("bash", "timeout 1 git push", [lexical], scope).get(record.id), true);
	});
	it("admits newline bodies but keeps malformed list and pipeline evidence unknown", () => {
		assert.equal(evaluateCommandRecords("bash", "for x in a; do\necho safe\ndone", [record], scope).get(record.id), false);
		for (const command of ["for x in a; do echo safe;; done", "for x in a; do echo safe |; done", "for x in a; do | echo safe; done"]) {
			const evidence = evaluateCommandRecords("bash", command, [record], scope);
			assert.equal(evidence.get(record.id), "unknown", command);
			assert.ok(evidence.reasons.get(record.id)?.includes("malformed-for-syntax"));
			assert.equal(evidence.segments.get(record.id), undefined);
		}
	});
	for (const command of [
		"while true; do echo hi; done",
		"until false; do echo hi; done",
		'while read -r l; do echo "$l"; done < file',
		'rg -l x | while read -r f; do wc -l "$f"; done',
	]) {
		it(`reads condition-loop evidence for ${command}`, () => {
			const evidence = evaluateCommandRecords("bash", command, [record], scope);
			assert.equal(evidence.get(record.id), false);
			assert.deepEqual(evidence.reasons.get(record.id) ?? [], []);
		});
	}
	it("retains a direct match inside a condition-loop body", () => {
		const evidence = evaluateCommandRecords("bash", "while true; do git push; done", [record], scope);
		assert.equal(evidence.get(record.id), true);
		assert.equal(evidence.segments.get(record.id), "git push");
	});
	it("does not infer substitution from an escaped here-document delimiter", () => {
		assert.equal(evaluateCommandRecords("bash", "cat <<\\EOF\n$(git push)\nEOF", [record], scope).get(record.id), false);
		for (const command of ["bash <<\\EOF\n$(git push)\nEOF", "cat <<\\EOF | sh\n$(git push)\nEOF"])
			assert.equal(evaluateCommandRecords("bash", command, [record], scope).get(record.id), "unknown");
	});
	it("keeps scope and tool exclusions ahead of unavailable evidence", () => {
		const excluded = structuredClone(record);
		excluded.definition.scope = { cwdPrefixes: ["/elsewhere"] };
		assert.equal(evaluateCommandRecords("bash", "timeout 1 git push", [excluded], scope).get(record.id), false);
		assert.equal(evaluateCommandRecords("read", "timeout 1 git push", [record], scope).get(record.id), false);
	});
});

describe("captureFor", () => {
	it("returns the declared command text", () => {
		assert.equal(captureFor("bash", { command: "ls -R ." }), "ls -R .");
	});

	it("returns nothing for a tool without command input", () => {
		assert.equal(captureFor("read", { path: "/etc/hosts" }), undefined);
	});

	it("returns nothing when the declared field has another type", () => {
		assert.equal(captureFor("bash", { command: 7 }), undefined);
		assert.equal(captureFor("bash", {}), undefined);
	});
});

describe("classify", () => {
	it("extracts command evidence for bash", () => {
		assert.deepEqual(classify("bash", { command: "cat notes.md" }), ["routing.cat-read"]);
	});

	it("returns no command match for other tools", () => {
		assert.deepEqual(classify("write", { path: "/tmp/x", content: "cat notes.md" }), []);
	});

	it("returns no command match without command text", () => {
		assert.deepEqual(classify("bash", { timeout: 5 }), []);
	});
});

describe("redactFor", () => {
	it("redacts command secrets", () => {
		assert.equal(redactFor("bash", "TOKEN=abcdef cat x"), "TOKEN=[redacted] cat x");
	});

	it("keeps an unowned tool's capture unchanged", () => {
		const opaque = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.signature";
		assert.equal(redactFor("read", opaque), opaque);
	});
});

describe("unified record dispatch", () => {
	const codeRecord = (changes: Partial<RuleRecord> = {}): RuleRecord => ({
		id: "routing.test",
		source: { kind: "package" },
		matcher: { kind: "code", key: "routing.test" },
		definition: {
			purpose: "Use the appropriate information source.",
			authority: "steer-or-block",
			revision: "000000000000",
			state: "active",
			effect: "block",
			note: "Use the structured tool.",
		},
		matcherAvailable: true,
		staleOverride: false,
		...changes,
	});
	const declarativeRecord = (changes: Partial<RuleRecord> = {}): RuleRecord => ({
		id: "local.grep-r",
		source: {
			kind: "local",
			proposalId: "00000000-0000-4000-8000-000000000001",
			approvedAudit: {
				at: "2026-09-01T00:00:00.000Z",
				session: "s1",
				model: "openai/gpt-5",
				surface: "command",
			},
		},
		matcher: {
			kind: "declarative",
			language: "command-shape/v1",
			spec: {
				command: "grep",
				flags: ["-R"],
				absentFlags: ["-q"],
				operands: { min: 1, max: 2, any: ["src"], at: { "0": ["needle"] } },
				pipe: { from: false, to: true, next: ["head"], later: ["head"] },
			},
		},
		definition: {
			purpose: "Use bounded text search.",
			authority: "steer-or-block",
			revision: "000000000001",
			state: "active",
			effect: "steer",
			note: "Prefer rg.",
			scope: { modelProviders: ["openai"], models: ["openai/gpt-5"], cwdPrefixes: ["/work/project"] },
		},
		matcherAvailable: true,
		staleOverride: false,
		...changes,
	});

	it("filters disabled and retired code records before predicate dispatch", () => {
		let calls = 0;
		const resolver = () => {
			calls++;
			return () => true;
		};
		const retired = codeRecord({ definition: { ...codeRecord().definition, state: "retired" } });
		const disabled = codeRecord({
			id: "routing.disabled",
			override: {
				state: "disabled",
				reason: "pause",
				audit: { at: "2026-09-01T00:00:00.000Z", session: "s", model: null, surface: "command" },
				againstDefinitionRevision: "000000000000",
			},
		});
		assert.deepEqual(matchRuleRecords("bash", "anything", [retired, disabled], { cwd: "/work" }, resolver), []);
		assert.equal(calls, 0);
	});

	it("filters unavailable and out-of-scope records before resolution", () => {
		let calls = 0;
		const resolver = () => {
			calls++;
			return () => true;
		};
		const unavailable = codeRecord({ matcherAvailable: false });
		const scoped = codeRecord({
			id: "routing.scoped",
			definition: { ...codeRecord().definition, scope: { models: ["openai/gpt-5"] } },
		});
		assert.deepEqual(
			matchRuleRecords(
				"bash",
				"anything",
				[unavailable, scoped],
				{ cwd: "/work", model: "anthropic/claude" },
				resolver,
			),
			[],
		);
		assert.equal(calls, 0);
	});

	it("keeps declarative matching separate from the code predicate registry", () => {
		let resolutions = 0;
		const matched = matchRuleRecords(
			"bash",
			"grep -R needle src | head -20",
			[declarativeRecord()],
			{ cwd: "/work/project/sub", provider: "openai", model: "openai/gpt-5" },
			() => {
				resolutions++;
				return () => false;
			},
		);
		assert.deepEqual(
			matched.map((record) => record.id),
			["local.grep-r"],
		);
		assert.equal(resolutions, 0);
	});

	it("leaves facts programs to the event interpreter rather than command-shape parsing", () => {
		const record = codeRecord({
			id: "local.tool-check",
			matcher: {
				kind: "declarative",
				language: "facts/v1",
				spec: {
					phase: "input",
					selector: { tools: ["bash"] },
					when: { op: "exists", path: ["tool"] },
					action: { kind: "deny" },
					onUnavailable: "skip",
				},
			},
		});
		let resolutions = 0;
		assert.deepEqual(
			matchRuleRecords("bash", "echo ok", [record], { cwd: "/work" }, () => {
				resolutions++;
				return () => true;
			}),
			[],
		);
		assert.equal(resolutions, 0);
	});

	it("uses exact declared scope dimensions and exact command-shape fields", () => {
		const record = declarativeRecord();
		const context = { cwd: "/work/project/sub", provider: "openai", model: "openai/gpt-5" };
		assert.equal(ruleScopeMatches(record.definition.scope, context), true);
		assert.equal(ruleScopeMatches(record.definition.scope, { ...context, provider: "OpenAI" }), false);
		assert.equal(ruleScopeMatches(record.definition.scope, { ...context, model: "openai/gpt-5-mini" }), false);
		assert.equal(ruleScopeMatches(record.definition.scope, { ...context, cwd: "/other" }), false);
		assert.equal(matchRuleRecords("bash", "grep -R -q needle src | head -20", [record], context).length, 0);
		assert.equal(matchRuleRecords("bash", "grep -R needle lib | head -20", [record], context).length, 0);
		assert.equal(matchRuleRecords("bash", "grep -R needle src | sort | head -20", [record], context).length, 0);
	});

	it("resolves active command evidence by its declared key", () => {
		const record = codeRecord();
		const keys: string[] = [];
		const matched = matchRuleRecords("bash", "echo ok", [record], { cwd: "/work" }, (key) => {
			keys.push(key);
			return () => true;
		});
		assert.deepEqual(keys, ["routing.test"]);
		assert.deepEqual(
			matched.map((entry) => entry.id),
			[record.id],
		);
	});

	it("preserves supplied evidence order without origin priority", () => {
		const packageMatch = codeRecord({
			id: "routing.zzz",
			matcher: { kind: "code", key: "routing.zzz" },
		});
		const localMatch = declarativeRecord({ id: "a.local" });
		const matched = matchRuleRecords(
			"bash",
			"grep -R needle src | head -20",
			[localMatch, packageMatch],
			{ cwd: "/work/project/sub", provider: "openai", model: "openai/gpt-5" },
			() => () => true,
		);
		assert.deepEqual(
			matched.map((record) => record.id),
			[localMatch.id, packageMatch.id],
		);
	});
});

describe("notesFor", () => {
	it("returns guidance in the order the ids are given", () => {
		const notes = notesFor("bash", ["form.env-grep", "routing.cat-read"]);
		assert.equal(notes.length, 2);
		assert.match(notes[0], /printenv/);
		assert.match(notes[1], /read tool/);
	});

	it("returns one line for ids that share wording", () => {
		assert.deepEqual(
			notesFor("bash", ["bounds.ls-recursive-uncapped", "bounds.find-output-uncapped"]),
			notesFor("bash", ["bounds.ls-recursive-uncapped"]),
		);
	});

	it("skips an unknown id and an unowned tool", () => {
		assert.deepEqual(notesFor("bash", ["routing.no-such-rule"]), []);
		assert.deepEqual(notesFor("read", ["routing.cat-read"]), []);
	});
});
