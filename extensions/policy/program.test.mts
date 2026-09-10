import assert from "node:assert/strict";
import { test } from "node:test";
import { Compile } from "typebox/compile";
import { snapshotData, UNKNOWN, type NamedData } from "./data.ts";
import { ObservationState } from "./state.ts";
import {
	evaluateCondition,
	evaluatePrograms,
	FactsProgramSchema,
	planInput,
	programFacts,
	validateFactsProgram,
	type Condition,
	type FactsProgram,
	type ProgramRule,
} from "./program.ts";

const yes: Condition = { op: "eq", path: ["tool"], value: "dispatch" };
const rule = (id: string, action: FactsProgram["action"], changes: Partial<FactsProgram> = {}): ProgramRule => ({
	id,
	revision: "revision-1",
	program: { phase: "input", when: yes, action, onUnavailable: "skip", ...changes },
});
const table = (name: string, rows: { key: string; value: string }[]): NamedData => ({
	name,
	revision: "123456789abc",
	source: "operator-table",
	capturedAt: 1,
	kind: "table",
	rows,
});
const context = { tool: "dispatch", schema: { type: "object", additionalProperties: true } };

test("closed grammar accepts nested facts through the public schema", () => {
	const program = rule(
		"deny",
		{ kind: "deny" },
		{ when: { all: [yes, { any: [{ not: { op: "exists", path: ["input", "missing"] } }, yes] }] } },
	).program;
	assert.equal(validateFactsProgram(program), undefined);
	assert.equal(Compile(FactsProgramSchema).Check(program), true);
	assert.ok(validateFactsProgram({ ...program, arbitrary: true }));
	assert.ok(validateFactsProgram({ ...program, selector: { eval: "x" } }));
	assert.ok(validateFactsProgram({ ...program, when: { op: "regex", path: ["input"], value: "*" } }));
});

test("three-valued logic retains unknown under not, all, and any", () => {
	const missing: Condition = { op: "eq", path: ["input", "missing"], value: "x" };
	const no: Condition = { op: "eq", path: ["tool"], value: "other" };
	const facts = { tool: "dispatch", input: {} };
	assert.equal(evaluateCondition(missing, facts), "unknown");
	assert.equal(evaluateCondition({ not: missing }, facts), "unknown");
	assert.equal(evaluateCondition({ all: [yes, missing] }, facts), "unknown");
	assert.equal(evaluateCondition({ all: [no, missing] }, facts), false);
	assert.equal(evaluateCondition({ any: [no, missing] }, facts), "unknown");
	assert.equal(evaluateCondition({ any: [yes, missing] }, facts), true);
	assert.equal(evaluateCondition({ op: "exists", path: ["input", "missing"] }, facts), false);
	assert.equal(evaluateCondition({ op: "exists", path: ["input", "missing"] }, { input: UNKNOWN }), "unknown");
});

test("typed conditions do not coerce values", () => {
	assert.equal(evaluateCondition({ op: "eq", path: ["input", "n"], value: 2 }, { input: { n: "2" } }), false);
	for (const [op, value, expected] of [
		["gt", 3, true],
		["gte", 2, true],
		["lt", 1, true],
		["lte", 2, true],
	] as const)
		assert.equal(evaluateCondition({ op, path: ["input", "n"], value: 2 }, { input: { n: value } }), expected);
	assert.equal(evaluateCondition({ op: "in", path: ["input", "n"], value: [2, false] }, { input: { n: false } }), true);
	for (const op of ["starts-with", "ends-with", "contains"] as const)
		assert.equal(evaluateCondition({ op, path: ["input", "s"], value: "alpha" }, { input: { s: "alpha" } }), true);
	for (const [value, type] of [
		[null, "null"],
		[[], "array"],
		[{}, "object"],
		[3, "integer"],
	] as const)
		assert.equal(evaluateCondition({ op: "type", path: ["input"], value: type }, { input: value }), true);
});

test("grammar bounds and phase/action compatibility reject unsafe plans", () => {
	const base = rule("test", { kind: "deny" }).program;
	for (const value of [
		{ ...base, action: { kind: "assert-error" } },
		{ ...base, phase: "completion", action: { kind: "deny" } },
		{ ...base, phase: "result", action: { kind: "guide", text: "x" }, onUnavailable: "deny" },
		{ ...base, when: { op: "eq", path: ["input", "__proto__"], value: true } },
		{ ...base, when: { op: "eq", path: ["unregistered"], value: true } },
		{ ...base, action: { kind: "rename-key", path: [], from: "a", to: "constructor" } },
		{ ...base, action: { kind: "substitute", path: ["team"], table: "teams" } },
		{ ...base, when: { op: "gt", path: ["input"], value: "2" } },
		{ ...base, inputView: "effective", action: { kind: "rename-key", path: [], from: "a", to: "b" } },
	])
		assert.ok(validateFactsProgram(value));
	let deep: Condition = yes;
	for (let index = 0; index < 10; index++) deep = { not: deep };
	assert.ok(validateFactsProgram({ ...base, when: deep }));
	assert.ok(validateFactsProgram({ ...base, when: { all: Array.from({ length: 17 }, () => yes) } }));
	assert.ok(
		validateFactsProgram({
			...base,
			when: { all: Array.from({ length: 16 }, () => ({ all: Array.from({ length: 8 }, () => yes) })) },
		}),
	);
});

test("admitted guidance fits the actual UTF-8 projection bound", () => {
	assert.equal(
		validateFactsProgram(rule("guide", { kind: "guide", text: "é".repeat(1000) }, { phase: "result" }).program),
		undefined,
	);
	assert.ok(
		validateFactsProgram(rule("guide", { kind: "guide", text: "é".repeat(1021) }, { phase: "result" }).program),
	);
	assert.ok(validateFactsProgram(rule("guide", { kind: "guide", text: " \n\t " }, { phase: "result" }).program));
});

test("data lookups and unavailable dependencies remain explicit", () => {
	const data = snapshotData([table("teams", [{ key: "blue", value: "team-2" }])], 2);
	const condition: Condition = { op: "lookup", path: ["input", "team"], table: "teams", value: "unique" };
	assert.equal(evaluateCondition(condition, { input: { team: "blue" }, data }), true);
	assert.equal(evaluateCondition(condition, { input: { team: "blue" }, data: {} }), "unknown");
	const program = rule("required", { kind: "deny" }, { data: ["teams"], onUnavailable: "deny" });
	assert.equal(evaluatePrograms([program], "input", context)[0].deny, true);
	assert.equal(evaluatePrograms([program], "input", { ...context, tool: "other" })[0].truth, "unknown");
	assert.equal(
		evaluatePrograms([{ ...program, program: { ...program.program, selector: { tools: ["dispatch"] } } }], "input", {
			...context,
			tool: "other",
		})[0].truth,
		false,
	);
});

test("original prohibitions prevent corrections and effective gates reject final candidates", () => {
	const data = snapshotData([table("teams", [{ key: "blue", value: "team-2" }])], 2);
	const substitute = rule("sub", { kind: "substitute", path: ["team"], table: "teams" }, { data: ["teams"] });
	const denyOriginal = rule(
		"deny-original",
		{ kind: "deny" },
		{ when: { op: "eq", path: ["input", "team"], value: "blue" } },
	);
	const input = { team: "blue" };
	const denied = planInput([substitute, denyOriginal], input, { ...context, data });
	assert.equal(denied.denied, true);
	assert.equal(denied.changed, false);
	const denyEffective = rule(
		"deny-effective",
		{ kind: "deny" },
		{ inputView: "effective", when: { op: "eq", path: ["input", "team"], value: "team-2" } },
	);
	assert.equal(planInput([substitute, denyEffective], input, { ...context, data }).denied, true);
	const observed = planInput([substitute, denyEffective], input, { ...context, data, applyCorrections: false });
	assert.equal(observed.denied, false);
	assert.deepEqual(observed.candidate, { team: "team-2" });
	assert.deepEqual(input, { team: "blue" });
});

test("fixed stages compose logical target, keys, and values in stable order", () => {
	const data = snapshotData(
		[table("operations", [{ key: "friendly", value: "send" }]), table("teams", [{ key: "blue", value: "team-2" }])],
		2,
	);
	const programs = [
		rule(
			"z-operation",
			{ kind: "substitute", path: ["operation"], table: "operations", stage: "logical-target" },
			{ data: ["operations"] },
		),
		rule(
			"m-key",
			{ kind: "rename-key", path: [], from: "oldTeam", to: "team" },
			{ when: { op: "eq", path: ["input", "operation"], value: "send" } },
		),
		rule("a-value", { kind: "substitute", path: ["team"], table: "teams" }, { data: ["teams"] }),
	];
	const input = { operation: "friendly", oldTeam: "blue" };
	const schema = {
		type: "object",
		properties: { operation: { const: "send" }, team: { const: "team-2" } },
		required: ["operation", "team"],
		additionalProperties: false,
	};
	const plan = planInput(programs, input, { ...context, schema, data });
	assert.equal(plan.valid, true);
	assert.deepEqual(plan.candidate, { operation: "send", team: "team-2" });
	assert.deepEqual(
		plan.corrections.map((entry) => entry.stage),
		["logical-target", "keys", "values"],
	);
	assert.deepEqual(planInput([...programs].reverse(), input, { ...context, schema, data }), plan);
	assert.deepEqual(input, { operation: "friendly", oldTeam: "blue" });
});

test("same-stage conditions use one snapshot and conflicting writes reject atomically", () => {
	const first = rule("first", { kind: "rename-key", path: [], from: "a", to: "b" });
	const dependent = rule(
		"second",
		{ kind: "rename-key", path: [], from: "c", to: "d" },
		{ when: { op: "exists", path: ["input", "b"] } },
	);
	assert.deepEqual(planInput([first, dependent], { a: 1, c: 2 }, context).candidate, { b: 1, c: 2 });
	const conflict = rule("conflict", { kind: "rename-key", path: [], from: "a", to: "c" });
	const rejected = planInput([first, conflict], { a: 1 }, context);
	assert.equal(rejected.valid, false);
	assert.equal(rejected.changed, false);
	assert.deepEqual(rejected.candidate, { a: 1 });
	assert.equal(planInput([first], { a: 1, b: 2 }, context).valid, false);
	const actualGate = rule(
		"actual-gate",
		{ kind: "deny" },
		{ inputView: "effective", when: { op: "eq", path: ["input", "a"], value: 1 } },
	);
	const observed = planInput([first, conflict, actualGate], { a: 1 }, { ...context, applyCorrections: false });
	assert.equal(observed.valid, false);
	assert.equal(observed.evaluations.find((entry) => entry.id === "actual-gate")?.truth, true);
});

test("invalid, ambiguous, and missing-schema corrections preserve the input", () => {
	const action = rule("sub", { kind: "substitute", path: ["team"], table: "teams" }, { data: ["teams"] });
	const data = snapshotData([table("teams", [{ key: "blue", value: "team-2" }])], 2);
	const plan = planInput(
		[action],
		{ team: "blue" },
		{ ...context, schema: { type: "object", properties: { team: { const: "blue" } } }, data },
	);
	assert.equal(plan.valid, false);
	assert.deepEqual(plan.candidate, { team: "blue" });
	const ambiguous = snapshotData(
		[
			table("teams", [
				{ key: "blue", value: "team-2" },
				{ key: "blue", value: "team-3" },
			]),
		],
		2,
	);
	assert.equal(planInput([action], { team: "blue" }, { ...context, data: ambiguous }).valid, false);
	const missing = planInput([action], { team: "blue" }, { tool: "dispatch", data });
	assert.equal(missing.valid, true);
	assert.equal(missing.changed, false);
	assert.equal(missing.evaluations[0].unavailable, true);
	const required = { ...action, program: { ...action.program, onUnavailable: "deny" as const } };
	assert.equal(planInput([required], { team: "blue" }, { tool: "dispatch", data }).denied, true);
});

test("declared JSON codecs validate composed inner corrections only after all stages", () => {
	const inner: NamedData = {
		name: "send-schema",
		revision: "123456789abc",
		source: "operator-schema",
		capturedAt: 1,
		kind: "schema",
		schema: {
			type: "object",
			properties: { team: { const: "team-2" } },
			required: ["team"],
			additionalProperties: false,
		},
	};
	const data = snapshotData([inner, table("teams", [{ key: "blue", value: "team-2" }])], 2);
	const selector = {
		codec: { argumentsPath: ["arguments"], operationPath: ["operation"], schemaData: "send-schema" },
		operations: ["send"],
	};
	const key = rule(
		"key",
		{ kind: "rename-key", path: [], from: "oldTeam", to: "team" },
		{ selector, data: ["send-schema"] },
	);
	const value = rule(
		"value",
		{ kind: "substitute", path: ["team"], table: "teams" },
		{ selector, data: ["send-schema", "teams"] },
	);
	const input = { operation: "send", arguments: '{"oldTeam":"blue"}' };
	const plan = planInput([value, key], input, { ...context, data });
	assert.equal(plan.valid, true);
	assert.deepEqual(JSON.parse(String(plan.candidate.arguments)), { team: "team-2" });
	assert.deepEqual(input, { operation: "send", arguments: '{"oldTeam":"blue"}' });
	const noSchema = {
		...key,
		program: { ...key.program, selector: { codec: { argumentsPath: ["arguments"] } }, data: [] },
	};
	assert.equal(planInput([noSchema], input, context).changed, false);
	assert.equal(planInput([key], { operation: "send", arguments: "not-json" }, { ...context, data }).changed, false);
	assert.equal(programFacts(key, { ...context, facts: { input }, data }).operation, "send");
});

test("context selectors qualify completed observations and do not invent a current tool", () => {
	const scoped = rule(
		"context",
		{ kind: "guide", text: "Check the target." },
		{
			phase: "context",
			selector: { tools: ["dispatch"], operations: ["send"] },
			when: { op: "gte", path: ["state", "count"], value: 1 },
			state: { observe: { op: "eq", path: ["outcome", "kind"], value: "success" } },
		},
	);
	assert.equal(validateFactsProgram(scoped.program), undefined);
	const state = new ObservationState();
	state.sync([scoped], 0);
	state.complete(state.pin(scoped.id)!, { outcome: { kind: "success" } }, 1, 1);
	assert.equal(
		evaluatePrograms([scoped], "context", { tool: "", states: { context: state.view(scoped.id, 1)! } })[0].truth,
		true,
	);
	assert.equal(programFacts(scoped, { tool: "" }).tool, UNKNOWN);
	const noState = { ...scoped.program };
	delete noState.state;
	assert.ok(validateFactsProgram(noState));
	const completion = {
		...scoped,
		program: {
			...scoped.program,
			phase: "completion" as const,
			action: { kind: "observe" as const, label: "scoped" },
			when: { op: "exists" as const, path: ["tool"] },
		},
	};
	assert.equal(evaluatePrograms([completion], "completion", { tool: "other", operation: "send" })[0].truth, false);
});

test("only actual result facts support structural error assertions", () => {
	const correction = rule(
		"meaning",
		{ kind: "assert-error" },
		{ phase: "result", when: { op: "eq", path: ["result", "details", "status"], value: "failed" } },
	);
	const error = { isError: false, details: { status: "failed" } };
	assert.equal(evaluatePrograms([correction], "result", { ...context, facts: { result: error } })[0].truth, true);
	assert.equal(error.isError, false);
	assert.ok(validateFactsProgram({ ...correction.program, action: { kind: "assert-error", value: false } }));
});
