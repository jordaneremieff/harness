import assert from "node:assert/strict";
import { appendFile, chmod, mkdir, mkdtemp, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
	LocalRuleRegistry,
	LOCAL_RULES_FILE,
	localRuleScopeVisibility,
	makeRuleAudit,
	matchLocalRules,
	MAX_REGISTRY_BYTES,
	reduceLocalRuleEvents,
	validateCandidate,
	validateLocalRuleEvent,
	type LocalRule,
	type LocalRuleCandidate,
	type RuleAudit,
} from "./local-rules.ts";

const agentAudit = (session = "session-a"): RuleAudit => ({
	at: "2026-09-03T12:00:00.000Z",
	session,
	model: "provider/model",
	surface: "agent-tool",
});
const commandAudit = (session = "session-a"): RuleAudit => ({
	...agentAudit(session),
	at: "2026-09-03T12:01:00.000Z",
	surface: "command",
});
const candidate = (overrides: Partial<LocalRuleCandidate> = {}): LocalRuleCandidate => ({
	slug: "shell.clean",
	note: "Use the bounded form.",
	match: { command: "scan" },
	suggest: { command: "scan", flags: ["--limit", "50"] },
	...overrides,
});

async function tempRegistry(): Promise<{ dir: string; registry: LocalRuleRegistry }> {
	const dir = join(await mkdtemp(join(tmpdir(), "policy-local-")), "store");
	return { dir, registry: new LocalRuleRegistry(dir) };
}

async function activeRule(
	registry: LocalRuleRegistry,
	value: LocalRuleCandidate = candidate(),
	effect: "steer" | "block" = "block",
): Promise<LocalRule> {
	const proposal = await registry.proposeUpsert(value, "Keep this command bounded.", agentAudit());
	await registry.decide(proposal.id, "approved", effect, commandAudit());
	return (await registry.snapshot()).rules.find((rule) => rule.slug === value.slug)!;
}

describe("LocalRuleRegistry lifecycle and store", () => {
	it("keeps a proposal inert until approval and records the chosen effect", async () => {
		const { dir, registry } = await tempRegistry();
		const proposal = await registry.proposeUpsert(candidate(), "Keep this command bounded.", agentAudit());
		let snapshot = await registry.snapshot();
		assert.equal(snapshot.rules.length, 0);
		assert.equal(snapshot.pending[0].id, proposal.id);
		await registry.decide(proposal.id, "approved", "block", commandAudit());
		snapshot = await registry.snapshot();
		assert.equal(snapshot.pending.length, 0);
		assert.equal(snapshot.rules[0].state, "active");
		assert.equal(snapshot.rules[0].effect, "block");
		assert.equal(snapshot.rules[0].approvedAudit.surface, "command");
		const path = join(dir, LOCAL_RULES_FILE);
		assert.equal((await stat(dir)).mode & 0o777, 0o700);
		assert.equal((await stat(path)).mode & 0o777, 0o600);
		assert.equal((await readFile(path, "utf8")).trim().split("\n").length, 2);
	});

	it("rejection changes no rule and an approved update replaces content only at the gate", async () => {
		const { registry } = await tempRegistry();
		await activeRule(registry);
		const rejected = await registry.proposeUpsert(candidate({ note: "Rejected wording." }), "Try wording.", agentAudit());
		assert.equal((await registry.snapshot()).rules[0].note, "Use the bounded form.");
		await registry.decide(rejected.id, "rejected", undefined, commandAudit());
		assert.equal((await registry.snapshot()).rules[0].note, "Use the bounded form.");
		const accepted = await registry.proposeUpsert(candidate({ note: "Accepted wording." }), "Use new wording.", agentAudit());
		assert.equal((await registry.snapshot()).rules[0].note, "Use the bounded form.");
		await registry.decide(accepted.id, "approved", "steer", commandAudit());
		const rule = (await registry.snapshot()).rules[0];
		assert.equal(rule.note, "Accepted wording.");
		assert.equal(rule.effect, "steer");
	});

	it("makes discard terminal and enforces one pending proposal per slug", async () => {
		const { registry } = await tempRegistry();
		await activeRule(registry);
		const pending = await registry.proposeDiscard("shell.clean", "No longer useful.", agentAudit());
		await assert.rejects(
			registry.proposeUpsert(candidate({ note: "Competing." }), "Competing change.", agentAudit()),
			/already pending/,
		);
		await assert.rejects(registry.setState("shell.clean", "discarded", commandAudit()), /reject the pending proposal/);
		await assert.rejects(registry.decide(pending.id, "approved", "block", commandAudit()), /does not accept an effect/);
		await registry.decide(pending.id, "approved", undefined, commandAudit());
		const snapshot = await registry.snapshot();
		assert.equal(snapshot.rules.length, 0);
		assert.equal(snapshot.discarded[0].state, "discarded");
		await assert.rejects(registry.setState("shell.clean", "active", commandAudit()), /terminal/);
		await assert.rejects(registry.setEffect("shell.clean", "steer", commandAudit()), /terminal/);
		await assert.rejects(registry.proposeUpsert(candidate(), "Try again.", agentAudit()), /cannot be reused/);
	});

	it("requires the right approval effect and rejects missing targets before append", async () => {
		const { dir, registry } = await tempRegistry();
		const proposal = await registry.proposeUpsert(candidate(), "Bound output.", agentAudit());
		await assert.rejects(registry.decide(proposal.id, "approved", undefined, commandAudit()), /requires effect/);
		const before = (await readFile(join(dir, LOCAL_RULES_FILE), "utf8")).trim().split("\n").length;
		await assert.rejects(
			registry.decide("00000000-0000-4000-8000-000000000001", "rejected", undefined, commandAudit()),
			/no pending proposal/,
		);
		await assert.rejects(registry.setState("missing.rule", "active", commandAudit()), /no retained rule/);
		await assert.rejects(registry.setEffect("missing.rule", "block", commandAudit()), /no retained rule/);
		assert.equal((await readFile(join(dir, LOCAL_RULES_FILE), "utf8")).trim().split("\n").length, before);
	});

	it("drops valid missing-target events during reduction and rejects agent gate events", () => {
		const audit = commandAudit();
		const snapshot = reduceLocalRuleEvents([
			{
				kind: "decision",
				id: "00000000-0000-4000-8000-000000000001",
				proposalId: "00000000-0000-4000-8000-000000000002",
				decision: "approved",
				effect: "block",
				audit,
			},
			{
				kind: "state",
				id: "00000000-0000-4000-8000-000000000003",
				slug: "missing.rule",
				state: "active",
				audit,
			},
		]);
		assert.deepEqual(snapshot, { rules: [], discarded: [], pending: [] });
		assert.throws(
			() =>
				validateLocalRuleEvent({
					kind: "effect",
					id: "00000000-0000-4000-8000-000000000004",
					slug: "missing.rule",
					effect: "block",
					audit: agentAudit(),
				}),
			/operator surface/,
		);
	});

	it("fails the whole snapshot on malformed, non-private, broad-directory, or oversized data", async () => {
		const malformed = await tempRegistry();
		await mkdir(malformed.dir, { recursive: true, mode: 0o700 });
		await writeFile(join(malformed.dir, LOCAL_RULES_FILE), "not-json\n", { mode: 0o600 });
		await assert.rejects(malformed.registry.snapshot(), /invalid local rule registry line 1/);
		await writeFile(join(malformed.dir, LOCAL_RULES_FILE), '{"kind":"unknown"}\n', { mode: 0o600 });
		await assert.rejects(malformed.registry.snapshot(), /event kind/);

		const partial = await tempRegistry();
		await partial.registry.proposeUpsert(candidate(), "Valid first line.", agentAudit());
		await appendFile(join(partial.dir, LOCAL_RULES_FILE), "broken\n");
		await assert.rejects(partial.registry.snapshot(), /line 2/);

		const linked = await tempRegistry();
		await mkdir(linked.dir, { recursive: true, mode: 0o700 });
		const target = join(linked.dir, "target.jsonl");
		await writeFile(target, "not-json\n", { mode: 0o600 });
		await symlink(target, join(linked.dir, LOCAL_RULES_FILE));
		await assert.rejects(linked.registry.snapshot(), /not a regular file/);

		const broadFile = await tempRegistry();
		await mkdir(broadFile.dir, { recursive: true, mode: 0o700 });
		const broadPath = join(broadFile.dir, LOCAL_RULES_FILE);
		await writeFile(broadPath, "not-json\n", { mode: 0o600 });
		await chmod(broadPath, 0o644);
		await assert.rejects(broadFile.registry.snapshot(), /permissions are not private/);

		const broadDir = await tempRegistry();
		await mkdir(broadDir.dir, { recursive: true, mode: 0o700 });
		await writeFile(join(broadDir.dir, LOCAL_RULES_FILE), "not-json\n", { mode: 0o600 });
		await chmod(broadDir.dir, 0o755);
		await assert.rejects(broadDir.registry.snapshot(), /policy store permissions are not private/);

		const longLine = await tempRegistry();
		await mkdir(longLine.dir, { recursive: true, mode: 0o700 });
		await writeFile(join(longLine.dir, LOCAL_RULES_FILE), `${" ".repeat(64 * 1024)}\n`, { mode: 0o600 });
		await assert.rejects(longLine.registry.snapshot(), /line 1 exceeds/);

		const oversized = await tempRegistry();
		await mkdir(oversized.dir, { recursive: true, mode: 0o700 });
		await writeFile(join(oversized.dir, LOCAL_RULES_FILE), Buffer.alloc(MAX_REGISTRY_BYTES + 1), { mode: 0o600 });
		await assert.rejects(oversized.registry.snapshot(), /exceeds/);
	});

	it("serializes concurrent proposal checks across registry instances", async () => {
		const { dir, registry } = await tempRegistry();
		const other = new LocalRuleRegistry(dir);
		const results = await Promise.allSettled([
			registry.proposeUpsert(candidate(), "First request.", agentAudit("one")),
			other.proposeUpsert(candidate(), "Second request.", agentAudit("two")),
		]);
		assert.deepEqual(results.map((result) => result.status).sort(), ["fulfilled", "rejected"]);
		assert.equal((await registry.snapshot()).pending.length, 1);
		assert.equal((await readFile(join(dir, LOCAL_RULES_FILE), "utf8")).trim().split("\n").length, 1);
	});

	it("accepts modelProviders scope and rejects providers as unknown", () => {
		assert.deepEqual(
			validateCandidate({
				...candidate(),
				scope: { modelProviders: ["openai-codex"] },
			}).scope,
			{ modelProviders: ["openai-codex"] },
		);
		assert.throws(
			() =>
				validateCandidate({
					...candidate(),
					scope: { providers: ["bash"] },
				}),
			/unknown field "providers"/,
		);
	});

	it("validates slugs, built-in namespace collisions, and audit construction", async () => {
		const { registry } = await tempRegistry();
		await assert.rejects(
			registry.proposeUpsert(candidate({ slug: "routing.local" }), "Collision.", agentAudit()),
			/built-in rule namespace/,
		);
		await assert.rejects(
			registry.proposeUpsert(candidate({ slug: "Bad_Slug" }), "Invalid.", agentAudit()),
			/slug must start/,
		);
		assert.deepEqual(
			makeRuleAudit(
				{ sessionManager: { getSessionId: () => "s1" }, model: { provider: "provider", id: "model" } },
				"panel",
				new Date("2026-09-03T12:00:00.000Z"),
			),
			{ at: "2026-09-03T12:00:00.000Z", session: "s1", model: "provider/model", surface: "panel" },
		);
	});
});

function rule(overrides: Partial<LocalRule> = {}): LocalRule {
	return {
		...candidate(),
		state: "active",
		effect: "block",
		proposalId: "00000000-0000-4000-8000-000000000001",
		proposedAudit: agentAudit(),
		approvedAudit: commandAudit(),
		...overrides,
	};
}

describe("local rule matching", () => {
	it("matches command, required and absent flags, and operand constraints", () => {
		const rules = [
			rule({
				slug: "shape.operands",
				match: {
					command: "scan",
					flags: ["--json"],
					absentFlags: ["--all"],
					operands: { min: 2, max: 2, any: ["src"], at: { "0": ["src"], "1": ["tests"] } },
				},
			}),
		];
		assert.deepEqual(
			matchLocalRules("scan --json src tests", rules, { provider: "p", model: "p/m", cwd: "/work" }).map((entry) => entry.slug),
			["shape.operands"],
		);
		for (const command of ["other --json src tests", "scan src tests", "scan --json --all src tests", "scan --json src", "scan --json src lib"]) {
			assert.equal(matchLocalRules(command, rules, { cwd: "/work" }).length, 0, command);
		}
	});

	it("matches every pipe and redirect shape plus immediate and later commands", () => {
		const variants: Array<[string, LocalRule["match"]]> = [
			["printf x | scan", { command: "scan", pipe: { from: true } }],
			["scan | head", { command: "scan", pipe: { to: true } }],
			["scan < in", { command: "scan", pipe: { fromRedirect: true } }],
			["scan > out", { command: "scan", pipe: { toRedirect: true } }],
			["scan | sort | head", { command: "scan", pipe: { next: ["sort"], later: ["head"] } }],
			["scan", { command: "scan", pipe: { from: false, to: false, fromRedirect: false, toRedirect: false } }],
		];
		for (const [command, match] of variants) {
			assert.equal(matchLocalRules(command, [rule({ match })], { cwd: "/work" }).length, 1, command);
		}
		assert.equal(
			matchLocalRules("scan | sort | head", [rule({ match: { command: "scan", pipe: { next: ["head"] } } })], { cwd: "/work" }).length,
			0,
		);
	});

	it("applies model provider, model, and cwd prefix scope and sorts slugs", () => {
		const scoped = rule({
			slug: "z.scoped",
			scope: { modelProviders: ["provider"], models: ["provider/model"], cwdPrefixes: ["/work/project"] },
		});
		const first = rule({ slug: "a.first" });
		assert.deepEqual(
			matchLocalRules("scan", [scoped, first], {
				provider: "provider",
				model: "provider/model",
				cwd: "/work/project/src",
			}).map((entry) => entry.slug),
			["a.first", "z.scoped"],
		);
		for (const context of [
			{ provider: "other", model: "provider/model", cwd: "/work/project" },
			{ provider: "provider", model: "provider/other", cwd: "/work/project" },
			{ provider: "provider", model: "provider/model", cwd: "/elsewhere" },
		]) assert.deepEqual(matchLocalRules("scan", [scoped], context), []);
	});

	it("reports whether each scope field admits the current session", () => {
		const context = {
			provider: "openai-codex",
			model: "openai-codex/gpt-5.6-sol",
			cwd: "/work/project/src",
		};
		assert.equal(
			localRuleScopeVisibility(
				rule({
					scope: {
						modelProviders: ["openai-codex"],
						models: ["openai-codex/gpt-5.6-sol"],
						cwdPrefixes: ["/work/project"],
					},
				}),
				context,
			),
			"scope matches this session: yes",
		);
		assert.equal(
			localRuleScopeVisibility(rule({ scope: { modelProviders: ["anthropic"] } }), context),
			"scope matches this session: no (modelProviders)",
		);
		assert.equal(
			localRuleScopeVisibility(rule({ scope: { models: ["openai-codex/gpt-5.5"] } }), context),
			"scope matches this session: no (models)",
		);
		assert.equal(
			localRuleScopeVisibility(rule({ scope: { cwdPrefixes: ["/elsewhere"] } }), context),
			"scope matches this session: no (cwdPrefixes)",
		);
	});

	it("matches only active entries and does not expand variables or comments", () => {
		const active = rule({ slug: "rule.active" });
		const disabled = rule({ slug: "rule.disabled", state: "disabled" });
		const discarded = rule({ slug: "rule.discarded", state: "discarded" });
		assert.deepEqual(matchLocalRules("scan", [discarded, disabled, active], { cwd: "/work" }).map((entry) => entry.slug), ["rule.active"]);
		assert.equal(matchLocalRules('VALUE="scan"; printf "%s" "$VALUE"', [active], { cwd: "/work" }).length, 0);
		assert.equal(matchLocalRules("printf ok # scan", [active], { cwd: "/work" }).length, 0);
	});
});
