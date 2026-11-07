import assert from "node:assert/strict";
import { test } from "node:test";
import type { NamedData } from "./data.ts";
import type { RuleSnapshot } from "./local-rules.ts";
import { attachPreparedPolicy, preparedPolicyFor, preparePolicy } from "./prepared.ts";
import type { FactsProgram } from "./program.ts";
import type { RuleRecord } from "./rule.ts";

const program = (changes: Partial<FactsProgram> = {}): FactsProgram => ({
	phase: "input",
	when: { op: "exists", path: ["input"] },
	action: { kind: "deny" },
	onUnavailable: "skip",
	...changes,
});
const record = (
	id: string,
	spec: FactsProgram,
	options: { state?: "active" | "retired"; available?: boolean } = {},
): RuleRecord => ({
	id,
	source: { kind: "package" },
	matcher: { kind: "declarative", language: "facts/v1", spec },
	definition: {
		purpose: `Preserve ${id}.`,
		authority: "exact",
		revision: "123456789abc",
		state: options.state ?? "active",
		effect: "observe",
		note: `Rule ${id}.`,
	},
	matcherAvailable: options.available ?? true,
	staleOverride: false,
});
const table: NamedData = {
	name: "teams",
	kind: "table",
	revision: "aaaabbbbcccc",
	source: "operator",
	capturedAt: 10,
	rows: [{ key: "blue", value: "team-2" }],
};

test("a prepared generation compiles each record once and filters active available rules", () => {
	const records = new Map<string, RuleRecord>([
		["b.result", record("b.result", program({ phase: "result", action: { kind: "guide", text: "Check it." } }))],
		["a.guide", record("a.guide", program({ action: { kind: "guide", text: "Prefer the reader." } }))],
		["c.retired", record("c.retired", program(), { state: "retired" })],
		["d.unavailable", record("d.unavailable", program(), { available: false })],
	]);
	const policy = preparePolicy({ revision: "verified", records, data: new Map([["teams", table]]) });
	assert.equal(policy.revision, "verified");
	assert.deepEqual(
		policy.rules.map((rule) => rule.id),
		["b.result", "a.guide"],
	);
	assert.deepEqual(
		[...policy.compiled.keys()],
		["b.result", "a.guide", "c.retired", "d.unavailable"],
	);
	assert.deepEqual(
		policy.byPhase.input.map((rule) => rule.id),
		["a.guide"],
	);
	assert.deepEqual(
		policy.byPhase.result.map((rule) => rule.id),
		["a.guide", "b.result"],
	);
	assert.equal(policy.data.snapshot(20).teams.status, "ready");
});

test("a snapshot uses its attached generation and re-prepares caller-built records", () => {
	const records = new Map([["sample", record("sample", program())]]);
	const snapshot: RuleSnapshot = {
		records,
		pending: [],
		data: new Map(),
		health: { status: "ok", path: "rules.jsonl" },
	};
	const callerPolicy = preparedPolicyFor(snapshot);
	assert.equal(callerPolicy.compiled.get("sample")?.id, "sample");
	assert.equal(preparedPolicyFor(snapshot).compiled.get("sample")?.id, "sample");
	const owned = preparePolicy({ revision: "verified", records, data: new Map() });
	attachPreparedPolicy(snapshot, owned);
	assert.equal(preparedPolicyFor(snapshot), owned);
});
