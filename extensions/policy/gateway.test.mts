import assert from "node:assert/strict";
import { test } from "node:test";
import { type NamedData, snapshotData, UNKNOWN } from "./data.ts";
import {
	type Condition,
	evaluateCondition,
	evaluatePrograms,
	type ProgramRule,
	planInput,
	programFacts,
	validateApplicability,
	validateFactsProgram,
} from "./program.ts";

const outerSchema = {
	type: "object",
	properties: { server: { type: "string" }, operation: { type: "string" }, arguments: { type: "string" } },
	required: ["operation", "arguments"],
	additionalProperties: false,
};
const context = { tool: "gateway", schema: outerSchema };
const exactServer: Condition = { op: "eq", path: ["outer", "server"], value: "alpha" };
const gate: ProgramRule = {
	id: "gate",
	revision: "123456abcdef",
	applicability: exactServer,
	program: {
		phase: "input",
		selector: {
			tools: ["gateway"],
			operations: ["send"],
			codec: { argumentsPath: ["arguments"], operationPath: ["operation"] },
		},
		when: { op: "eq", path: ["input", "name"], value: "forbidden" },
		action: { kind: "deny" },
		onUnavailable: "skip",
	},
};
const input = { server: "alpha", operation: "send", arguments: '{"name":"forbidden"}' };

test("raw outer roots coexist with decoded facts without inner schema evidence", () => {
	const current = { ...input, server: "beta", arguments: '{"name":"safe"}' };
	const facts = programFacts(gate, context, current, input);
	assert.deepEqual(facts.outer, current);
	assert.deepEqual(facts.originalOuter, input);
	assert.deepEqual(facts.input, { name: "safe" });
	assert.deepEqual(facts.original, { name: "forbidden" });
	assert.deepEqual(facts.schema, { valid: UNKNOWN });
	assert.equal(facts.operation, "send");
	assert.equal(validateApplicability(exactServer, gate.program), undefined);
	assert.equal(validateFactsProgram(gate.program), undefined);
	assert.equal(programFacts(gate, { tool: "gateway" }).outer, UNKNOWN);
	const direct = { ...gate, program: { ...gate.program, selector: { tools: ["gateway"] } } };
	assert.deepEqual(programFacts(direct, context, input).schema, { valid: true });
});

test("exact tool, server, and operation qualify read-only inner conditions", () => {
	assert.equal(planInput([gate], input, context).denied, true);
	for (const [candidate, tool, applicable] of [
		[{ ...input, server: "beta" }, "gateway", false],
		[{ operation: "send", arguments: input.arguments }, "gateway", "unknown"],
		[{ ...input, operation: "read" }, "gateway", true],
		[input, "other-gateway", true],
	] as const) {
		const plan = planInput([gate], candidate, { ...context, tool });
		assert.equal(plan.valid, true);
		assert.equal(plan.changed, false);
		assert.equal(plan.denied, false);
		assert.deepEqual(plan.candidate, candidate);
		assert.equal(plan.evaluations[0].applicable, applicable);
	}
});

test("malformed inner arguments retain raw facts and explicit unavailable handling", () => {
	for (const argumentsValue of ["not-json", "null", "[]", "42", '"text"']) {
		const candidate = { ...input, arguments: argumentsValue };
		const facts = programFacts(gate, context, candidate);
		assert.equal(facts.input, UNKNOWN);
		assert.deepEqual(facts.schema, { valid: UNKNOWN });
		assert.equal(evaluateCondition(exactServer, facts), true);
		const plan = planInput([gate], candidate, context);
		assert.equal(plan.changed, false);
		assert.equal(plan.evaluations[0].truth, "unknown");
		assert.deepEqual(plan.candidate, candidate);
		const required = { ...gate, program: { ...gate.program, onUnavailable: "deny" as const } };
		assert.equal(planInput([required], candidate, context).denied, true);
		assert.equal(planInput([required], { ...candidate, server: "beta" }, context).denied, false);
	}
});

test("outer logical-target substitutions preserve inner bytes and feed effective gates", () => {
	const servers: NamedData = {
		name: "servers", kind: "table", source: "operator", capturedAt: 1, revision: "123456abcdef",
		rows: [{ key: "friendly", value: "alpha" }],
	};
	const target: ProgramRule = {
		id: "target", revision: "123456abcdef",
		program: {
			phase: "input", selector: gate.program.selector, data: ["servers"],
			when: { op: "lookup", path: ["outer", "server"], table: "servers", value: "unique" },
			action: { kind: "substitute", path: ["server"], table: "servers", stage: "logical-target" },
			onUnavailable: "skip",
		},
	};
	assert.equal(validateFactsProgram(target.program), undefined);
	const original = { ...input, server: "friendly" };
	const ctx = { ...context, data: snapshotData([servers], 2) };
	const corrected = planInput([target], original, ctx);
	assert.equal(corrected.valid, true);
	assert.equal(corrected.changed, true);
	assert.deepEqual(corrected.candidate, input);
	assert.deepEqual(planInput([target, gate], original, ctx).candidate, input);
	const effective = { ...gate, program: { ...gate.program, inputView: "effective" as const } };
	const denied = planInput([target, effective], original, ctx);
	assert.equal(denied.denied, true);
	assert.deepEqual(denied.candidate, original);
	assert.equal(planInput([target, effective], original, { ...ctx, applyCorrections: false }).denied, false);
	const result = { ...gate, program: { ...gate.program, phase: "result" as const, action: { kind: "assert-error" as const } } };
	assert.equal(evaluatePrograms([result], "result", { ...ctx, facts: { input, original } })[0].truth, true);
});
