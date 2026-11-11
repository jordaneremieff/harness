import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { compile } from "@earendil-works/pi-schema";
import { authoringGuide, checkDraft, type DraftCase } from "./authoring.ts";
import { PACKAGE_CATALOG } from "./catalog.ts";
import { namedDataRevision, RuleRegistry, type RuleSnapshot } from "./local-rules.ts";
import type { FactsProgram } from "./program.ts";
import type { PolicyRecord } from "./record.ts";
import { PolicyRuntime } from "./runtime.ts";
import { parseAuthoringDraft, PolicyRulesParams, registerRuleTools, validateInspectionParams } from "./tools.ts";

interface Row {
	kind: string;
	denied?: boolean;
	guidance?: boolean;
	resultError?: boolean;
	outcome?: string;
	input?: unknown;
	inputEvaluations?: Array<{ id: string; truth: unknown }>;
	mismatches: string[];
}
interface Check {
	admitted: boolean;
	diagnostics: Array<{ severity: string; message: string }>;
	cases: Array<{ name: string; scopeMatches: boolean; rows: Row[];
		state?: { observationPeriods: Array<{ count: number; windowCount: number; eligible: boolean; projected: number; resetReason: string }> };
		unavailable?: string }>;
	omittedCases?: number;
}
interface Tool {
	name: string;
	execute(
		id: string,
		params: Record<string, unknown>,
		signal: undefined,
		update: undefined,
		ctx: ExtensionContext,
	): Promise<{ content: Array<{ text: string }> }>;
}
const ctx = {
	cwd: "/project",
	model: { provider: "test", id: "model" },
	mode: "print",
	hasUI: false,
	sessionManager: { getSessionId: () => "authoring-test" },
	getSystemPrompt: () => "",
} as unknown as ExtensionContext;
function fixture() {
	const tools = new Map<string, Tool>();
	let executions = 0;
	const pi = {
		registerTool: (tool: Tool) => tools.set(tool.name, tool),
		getAllTools: () => [
			{
				name: "bash",
				parameters: {
					type: "object",
					properties: {
						command: { type: "string" },
						timeout: { type: "number" },
						old: { type: "string" },
						name: { type: "string" },
					},
					additionalProperties: false,
				},
				execute: () => {
					executions++;
					assert.fail("No simulated tool executes");
				},
			},
		],
		getActiveTools: () => ["bash"],
	} as unknown as ExtensionAPI;
	const snapshot: RuleSnapshot = {
		records: new Map(),
		pending: [],
		data: new Map(),
		health: { status: "ok", path: "unused" },
	};
	return { pi, snapshot, tools, executions: () => executions };
}
const program: FactsProgram = {
	phase: "input",
	selector: { tools: ["bash"] },
	when: { op: "eq", path: ["input", "command"], value: "restricted" },
	action: { kind: "deny" },
	onUnavailable: "skip",
};
function draft(spec: FactsProgram = program) {
	return {
		operation: "add",
		id: "local.example",
		purpose: "Apply the declared restriction.",
		authority: "exact",
		reason: "Use the restriction.",
		note: "Use the permitted shape.",
		language: "facts/v1",
		program: structuredClone(spec),
	};
}
function call(command = "restricted", isError = false, at = 0): Extract<DraftCase["steps"][number], { kind: "call" }> {
	return { kind: "call", at, turn: 1, tool: "bash", input: { command }, result: { isError } };
}
function context(at = 0): Extract<DraftCase["steps"][number], { kind: "context" }> {
	return { kind: "context", at, turn: 1 };
}
async function check(
	value: Record<string, unknown>,
	cases: DraftCase[] = [],
	f = fixture(),
	extra: Record<string, unknown> = {},
): Promise<Check> {
	const params = { view: "check", draft: value, cases, ...extra };
	validateInspectionParams(params);
	return (await checkDraft(params, f.snapshot, f.pi, ctx, parseAuthoringDraft)) as Check;
}
function noMismatches(result: Check) {
	assert.equal(result.admitted, true, JSON.stringify(result.diagnostics));
	for (const entry of result.cases) {
		assert.equal(entry.unavailable, undefined);
		for (const row of entry.rows) assert.deepEqual(row.mismatches, []);
	}
}

test("guided command replacements admit without changing their synthetic registry", async () => {
	const f = fixture();
	const rows = PACKAGE_CATALOG.filter((row) => row.matcher.kind === "code" && row.effect === "steer");
	for (const row of rows) f.snapshot.records.set(row.id, {
		id: row.id, source: { kind: "package" }, matcher: row.matcher, definition: { ...row, state: "active" },
		matcherAvailable: true, staleOverride: false,
	});
	const before = JSON.stringify([...f.snapshot.records]);
	for (const row of rows) {
		assert.equal(row.matcher.kind, "code");
		if (row.matcher.kind !== "code") continue;
		noMismatches(await check({ operation: "replace", id: row.id, expectedRevision: row.revision,
			purpose: row.purpose, authority: row.authority, reason: "Keep command preferences as guidance.",
			note: row.note, predicate: row.matcher.key,
		}, [], f, { effect: "steer" }));
	}
	const fd = rows.find((row) => row.id === "bounds.fd-uncapped");
	assert.ok(fd);
	const result = await check({ operation: "replace", id: fd.id, expectedRevision: fd.revision,
		purpose: fd.purpose, authority: fd.authority, reason: "Preserve result semantics.", note: fd.note,
		predicate: "bounds.fd-uncapped", scope: { cwdPrefixes: ["/selected"] },
	}, [
		{ name: "details", scope: { cwd: "/selected" }, steps: [{ ...call("fd -l . design"), expect: { denied: false, guidance: true } }] },
		{ name: "producer cap", scope: { cwd: "/selected" }, steps: [{ ...call("fd --max-results 2 . design"), expect: { denied: false, guidance: false } }] },
		{ name: "outside scope", scope: { cwd: "/elsewhere" }, steps: [{ ...call("fd -l . design"), expect: { denied: false, guidance: false } }] },
	], f, { effect: "steer" });
	noMismatches(result);
	assert.equal(JSON.stringify([...f.snapshot.records]), before);
	assert.equal(f.snapshot.pending.length, 0);
	assert.equal(f.executions(), 0);
});

test("substitute does not insert an absent timeout from a null mapping", async () => {
	const f = fixture();
	const table = { name: "timeout-defaults", kind: "table" as const, rows: [{ key: null, value: 30 }],
		source: "synthetic", capturedAt: 0, revision: "000000000000" };
	table.revision = namedDataRevision(table);
	f.snapshot.data.set(table.name, table);
	const result = await check(draft({ phase: "input", selector: { tools: ["bash"] },
		when: { not: { op: "exists", path: ["input", "timeout"] } }, data: [table.name],
		action: { kind: "substitute", path: ["timeout"], table: table.name }, onUnavailable: "skip",
	}), [{ name: "missing timeout", steps: [{ ...call("echo safe"), expect: { correctedInput: false, denied: false } }] }], f);
	noMismatches(result);
	assert.deepEqual(result.cases[0].rows[0].input, { command: "echo safe" });
	assert.equal(f.executions(), 0);
});

test("draft checks share proposal admission without proposal or data writes", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "policy-authoring-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const registry = new RuleRegistry(dir, { catalog: [] });
	const f = fixture();
	f.snapshot = await registry.snapshot();
	registerRuleTools(f.pi, { registry, loadRegistry: () => registry.snapshot() });
	const inspect = f.tools.get("policy_rules");
	const propose = f.tools.get("policy_propose");
	assert.ok(inspect);
	assert.ok(propose);
	const before = await readFile(registry.path, "utf8");
	const params = { view: "check", draft: draft(), cases: [{ name: "positive", steps: [call()] }] };
	assert.equal(compile(PolicyRulesParams).check(params), true);
	const inspected = JSON.parse(
		(await inspect.execute("check", params, undefined, undefined, ctx)).content[0].text,
	) as Check;
	assert.equal(inspected.admitted, true);
	assert.equal(inspected.cases[0].rows[0].denied, true);
	assert.equal(await readFile(registry.path, "utf8"), before);
	assert.equal(f.executions(), 0);
	await propose.execute("proposal", draft(), undefined, undefined, ctx);
	const snapshot = await registry.snapshot();
	assert.equal(snapshot.pending.length, 1);
	assert.equal(snapshot.records.size, 0);
	assert.equal(snapshot.data.size, 0);
	const pending = JSON.parse(
		(await inspect.execute("check", params, undefined, undefined, ctx)).content[0].text,
	) as Check;
	assert.equal(pending.admitted, false);
	assert.match(pending.diagnostics[0].message, /pending/);
});

test("a command draft returns step outcomes with the complete starter catalog", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "policy-authoring-catalog-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const f = fixture();
	f.snapshot = await new RuleRegistry(dir).snapshot();
	const { program: _program, language: _language, ...common } = draft();
	const result = await check(
		{ ...common, authority: "steer-or-block", match: { command: "sleep" }, onUnavailable: "skip" },
		[{ name: "sleep blocked", steps: [{ ...call("sleep 5"), expect: { denied: true, correctedInput: false, guidance: false } }] }],
		f,
		{ effect: "block" },
	);
	noMismatches(result);
	assert.equal(result.cases[0].rows[0].denied, true);
	assert.ok(Buffer.byteLength(JSON.stringify(result)) < 8000);
	assert.equal(f.executions(), 0);
});

test("the real inspection invocation produces only its ordinary completion record", async () => {
	const f = fixture();
	const records: PolicyRecord[] = [];
	const registry = { snapshot: async () => f.snapshot } as unknown as RuleRegistry;
	registerRuleTools(f.pi, { registry, loadRegistry: async () => f.snapshot });
	const tool = f.tools.get("policy_rules");
	assert.ok(tool);
	const runtime = new PolicyRuntime(
		f.pi,
		async () => f.snapshot,
		() => "enforce",
		"",
		() => true,
		{
			enqueue: (record) => {
				records.push(record);
				return true;
			},
			close: async () => {},
			health: () => ({ state: "ok", lostRecords: 0, lostBytes: 0 }),
		},
	);
	runtime.sync(f.snapshot);
	const identity = { toolName: "policy_rules", toolCallId: "inspection" };
	const input = {
		view: "check",
		draft: draft(recovery),
		cases: [{ name: "errors", steps: [call("allowed", true), call("allowed", true), context()] }],
	};
	await runtime.toolStart({ ...identity, args: input }, ctx);
	await runtime.toolCall({ type: "tool_call", ...identity, input }, ctx);
	const response = await tool.execute("inspection", input, undefined, undefined, ctx);
	assert.equal(records.length, 0);
	const result = { content: response.content.map(({ text }) => ({ type: "text" as const, text })), isError: false };
	await runtime.toolResult({ type: "tool_result", ...identity, input, details: {}, ...result }, ctx);
	await runtime.toolEnd({ ...identity, result, isError: false }, ctx);
	assert.equal(records.length, 1);
	assert.equal(records[0].tool, "policy_rules");
	assert.equal(records[0].outcome, "success");
	assert.equal(f.executions(), 0);
	assert.deepEqual(f.snapshot.pending, []);
	assert.equal(f.snapshot.data.size, 0);
});

test("invalid draft diagnostics are separate from failed case expectations", async () => {
	for (const invalid of [
		{ ...draft(), extra: true },
		draft({ ...program, phase: "result" }),
		{ ...draft(), operation: "replace", expectedRevision: "123456abcdef" },
		{ ...draft(), program: { ...program, when: { op: "eq", path: ["other"], value: 1 } } },
	]) {
		assert.equal((await check(invalid)).admitted, false);
	}
	const mismatch = await check(draft(), [
		{ name: "wrong-expectation", steps: [{ ...call(), expect: { denied: false } }] },
	]);
	assert.equal(mismatch.admitted, true);
	assert.deepEqual(mismatch.diagnostics, []);
	assert.match(mismatch.cases[0].rows[0].mismatches[0], /expected false/);
});

test("all authoring forms require supported predicates and explicit simulated authority", async () => {
	const { program: _program, language: _language, ...common } = draft();
	const predicate = { ...common, authority: "steer-or-block", predicate: "routing.cat-read" };
	assert.equal((await check(predicate)).admitted, false);
	assert.equal((await check(predicate, [], fixture(), { effect: "block" })).admitted, true);
	assert.equal(
		(await check({ ...predicate, predicate: "missing.predicate" }, [], fixture(), { effect: "block" })).admitted,
		false,
	);
	const command = { ...common, match: { command: "scan" } };
	assert.equal((await check(command)).admitted, true);
	assert.equal((await check(command, [], fixture(), { effect: "block" })).admitted, false);
});

test("positive, negative, unknown, and scope cases use independent state and do not execute tools", async () => {
	const f = fixture();
	const before = structuredClone(f.snapshot);
	const result = await check(
		{ ...draft(), scope: { models: ["test/model"] } },
		[
			{ name: "positive", steps: [{ ...call(), expect: { denied: true } }] },
			{ name: "negative", steps: [{ ...call("allowed"), expect: { denied: false } }] },
			{
				name: "unknown",
				steps: [{ kind: "call", at: 0, turn: 1, tool: "bash", input: {}, expect: { denied: false } }],
			},
			{
				name: "scope",
				scope: { model: "other/model", cwd: "/project" },
				steps: [{ ...call(), expect: { denied: false } }],
			},
		],
		f,
	);
	noMismatches(result);
	assert.equal(
		result.cases[2].rows[0].inputEvaluations?.find((entry) => entry.id === "local.example")?.truth,
		"unknown",
	);
	assert.equal(result.cases[3].scopeMatches, false);
	assert.deepEqual(f.snapshot, before);
	assert.equal(f.executions(), 0);
});

const recovery: FactsProgram = {
	phase: "completion",
	selector: { tools: ["bash"] },
	when: { op: "gte", path: ["state", "count"], value: 2 },
	state: {
		observe: { op: "eq", path: ["outcome", "kind"], value: "execution-error" },
		resetWhen: { op: "eq", path: ["outcome", "kind"], value: "success" },
		once: "period",
		expiresAfterMs: 100,
	},
	action: { kind: "guide", text: "Review the errors." },
	onUnavailable: "skip",
};
test("completion guidance survives a later success and cases isolate clock, reset, and projection allowances", async () => {
	const result = await check(draft(recovery), [
		{
			name: "retained",
			steps: [
				call("allowed", true),
				call("allowed", true, 1),
				call("allowed", false, 2),
				{ ...context(3), expect: { guidance: true } },
				{ ...context(4), expect: { guidance: false } },
			],
		},
		{ name: "fresh", steps: [call("allowed", true), { ...context(1), expect: { guidance: false } }] },
		{
			name: "expired",
			steps: [call("allowed", true), call("allowed", true, 101), { ...context(102), expect: { guidance: false } }],
		},
		{
			name: "reset",
			steps: [
				call("allowed", true),
				call("allowed", false, 1),
				call("allowed", true, 2),
				{ ...context(3), expect: { guidance: false } },
			],
		},
	]);
	noMismatches(result);
});

test("synthetic observation time controls window, cooldown, once and expiry boundaries", async () => {
	const program: FactsProgram = { phase: "context",
		when: { op: "gte", path: ["state", "windowCount"], value: 2 },
		action: { kind: "guide", text: "Inspect the repeated errors." }, onUnavailable: "skip",
		state: { observe: { op: "eq", path: ["outcome", "kind"], value: "execution-error" },
			window: { maxEvents: 4, maxAgeMs: 10 }, cooldownMs: 5, once: "turn", expiresAfterMs: 30 },
	};
	const result = await check(draft(program), [
		{ name: "window and cooldown", steps: [
			call("allowed", true, 0), call("allowed", true, 9),
			{ ...context(9), expect: { guidance: true } },
			{ ...call("allowed", true, 10), turn: 2 },
			{ ...context(10), turn: 2, expect: { guidance: false } },
			{ ...context(14), turn: 2, expect: { guidance: false } },
		] },
		{ name: "cooldown waits", steps: [
			call("allowed", true, 0), call("allowed", true, 9),
			{ ...context(9), expect: { guidance: true } },
			{ ...call("allowed", true, 10), turn: 2 },
			{ ...context(10), turn: 2, expect: { guidance: false } },
		] },
		{ name: "once and strict age", steps: [
			call("allowed", true, 0), call("allowed", true, 9),
			{ ...context(9), expect: { guidance: true } },
			{ ...context(10), expect: { guidance: false } },
		] },
		{ name: "natural expiry", steps: [
			call("allowed", true, 0), call("allowed", true, 1),
			{ ...context(1), expect: { guidance: true } },
			{ ...call("allowed", true, 30), turn: 2 },
			{ ...context(31), turn: 2, expect: { guidance: false } },
			{ ...call("allowed", true, 32), turn: 2 },
			{ ...context(32), turn: 2, expect: { guidance: false } },
		] },
	]);
	noMismatches(result);
	const periods = result.cases.map((entry) => {
		const period = entry.state?.observationPeriods[0];
		assert.ok(period, entry.name);
		return period;
	});
	assert.equal(periods[0].eligible, true);
	assert.equal(periods[0].windowCount, 2);
	assert.equal(periods[0].projected, 1);
	assert.equal(periods[1].eligible, false);
	assert.equal(periods[1].windowCount, 2);
	assert.equal(periods[2].eligible, false);
	assert.equal(periods[2].windowCount, 1);
	assert.equal(periods[3].eligible, true);
	assert.equal(periods[3].resetReason, "expiry");
	assert.equal(periods[3].count, 2);
	assert.equal(periods[3].projected, 0);
});

test("checks apply production input/result corrections before completion guidance", async () => {
	const correction: FactsProgram = {
		phase: "result",
		selector: { tools: ["bash"] },
		when: { op: "eq", path: ["result", "details", "failed"], value: true },
		action: { kind: "assert-error" },
		onUnavailable: "skip",
	};
	const result = await check(draft(correction), [
		{
			name: "result-error",
			steps: [
				{
					kind: "call",
					tool: "bash",
					input: { command: "allowed" },
					result: { isError: false, details: { failed: true } },
					at: 0,
					turn: 1,
					expect: { resultError: true },
				},
			],
		},
	]);
	noMismatches(result);
	assert.equal(result.cases[0].rows[0].outcome, "execution-error");
	const rename: FactsProgram = {
		phase: "input",
		selector: { tools: ["bash"] },
		when: { op: "exists", path: ["input", "old"] },
		action: { kind: "rename-key", path: [], from: "old", to: "name" },
		onUnavailable: "skip",
	};
	const renamed = await check(draft(rename), [
		{
			name: "rename",
			steps: [
				{
					kind: "call",
					tool: "bash",
					input: { old: "value" },
					result: { isError: false },
					at: 0,
					turn: 1,
					expect: { correctedInput: true },
				},
			],
		},
	]);
	noMismatches(renamed);
	assert.deepEqual(renamed.cases[0].rows[0].input, { name: "value" });
});

test("omitted results stay unexecuted and user text does not impersonate guidance", async () => {
	const result = await check(draft(), [
		{
			name: "unexecuted",
			steps: [
				{ kind: "call", tool: "bash", input: { command: "allowed" }, at: 0, turn: 1 },
				{
					kind: "call",
					tool: "bash",
					input: { command: "allowed" },
					at: 1,
					turn: 1,
					result: { isError: false, content: [{ type: "text", text: "[policy] user text" }] },
					expect: { guidance: false },
				},
			],
		},
	]);
	noMismatches(result);
	assert.equal(result.cases[0].rows[0].outcome, "unexecuted");
});

test("check requests enforce aggregate, event, time, turn, and output bounds", async () => {
	const base = { view: "check", draft: draft() };
	for (const cases of [
		[{ name: "time", steps: [call("allowed", false, 2), call("allowed", false, 1)] }],
		[{ name: "turn", steps: [{ ...call(), turn: 65 }] }],
		[{ name: "context", steps: [{ ...context(), expect: { denied: false } }] }],
		[{ name: "scope", scope: { provider: "test", cwd: "/project" }, steps: [call()] }],
		Array.from({ length: 17 }, (_, index) => ({ name: `case-${index}`, steps: [call()] })),
		[{ name: "oversize", steps: [{ ...call(), input: { command: "x".repeat(70000) } }] }],
	])
		assert.throws(() => validateInspectionParams({ ...base, cases }));
	const result = await check(draft(), [
		{ name: "large", steps: [{ ...call(), input: { command: "x".repeat(30000) } }] },
	]);
	assert.match(result.cases[0].unavailable ?? "", /byte bound/);
	assert.ok(Buffer.byteLength(JSON.stringify(result)) < 50 * 1024);
});

test("authoring guidance permits verified recovery candidates but requires activation approval", async () => {
	const guide = (await authoringGuide()).replace(/\s+/g, " ");
	assert.match(guide, /when automatic policy diagnostics identify a verified repeatable recovery/);
	assert.match(guide, /Present the complete pending proposal for operator review\. After clear contextual approval, call `policy_approve`/);
	assert.match(guide, /Checks and proposal submission grant no activation authority/);
	assert.match(guide, /Agent inference or recommendation is not operator approval/);
	assert.doesNotMatch(guide, /policy_propose` only under operator instruction/);
});

test("the canonical authoring guide examples satisfy admission and behavior checks", async () => {
	const guide = await authoringGuide();
	let examples = 0;
	for (const block of guide.matchAll(/^```json\n([\s\S]*?)^```/gm)) {
		const value = JSON.parse(block[1]) as Record<string, unknown>;
		const params = value.operation ? { view: "check", draft: value } : value;
		assert.equal(compile(PolicyRulesParams).check(params), true);
		validateInspectionParams(params);
		const f = fixture();
		noMismatches((await checkDraft(params, f.snapshot, f.pi, ctx, parseAuthoringDraft)) as Check);
		examples++;
	}
	assert.ok(examples > 0);
});
