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

const innerSchema: NamedData = {
	name: "request-schema",
	kind: "schema",
	source: "operator",
	capturedAt: 1,
	revision: "123456abcdef",
	schema: {
		type: "object",
		properties: { name: { type: "string" } },
		required: ["name"],
		additionalProperties: false,
	},
};
const outerSchema = {
	type: "object",
	properties: {
		server: { type: "string" },
		operation: { type: "string" },
		arguments: { type: "string" },
	},
	required: ["operation", "arguments"],
	additionalProperties: false,
};
const data = snapshotData([innerSchema], 2);
const context = { tool: "gateway", schema: outerSchema, data };
const exactServer: Condition = { op: "eq", path: ["outer", "server"], value: "alpha" };
const repair: ProgramRule = {
	id: "repair",
	revision: "123456abcdef",
	applicability: exactServer,
	program: {
		phase: "input",
		selector: {
			tools: ["gateway"],
			operations: ["send"],
			codec: { argumentsPath: ["arguments"], operationPath: ["operation"], schemaData: "request-schema" },
		},
		data: ["request-schema"],
		when: { op: "exists", path: ["input", "oldName"] },
		action: { kind: "rename-key", path: [], from: "oldName", to: "name" },
		onUnavailable: "skip",
	},
};
const input = { server: "alpha", operation: "send", arguments: '{"oldName":"room"}' };

test("raw outer roots coexist with decoded original and current facts", () => {
	const current = { ...input, server: "beta", arguments: '{"name":"room"}' };
	const facts = programFacts(repair, context, current, input);
	assert.deepEqual(facts.outer, current);
	assert.deepEqual(facts.originalOuter, input);
	assert.deepEqual(facts.input, { name: "room" });
	assert.deepEqual(facts.original, { oldName: "room" });
	assert.equal(facts.operation, "send");
	assert.equal(validateApplicability(exactServer, repair.program), undefined);
	assert.equal(
		validateFactsProgram({ ...repair.program, when: { op: "eq", path: ["originalOuter", "server"], value: "alpha" } }),
		undefined,
	);
	assert.equal(programFacts(repair, { tool: "gateway" }).outer, UNKNOWN);
	assert.equal(programFacts(repair, { tool: "gateway" }).originalOuter, UNKNOWN);
	const noCodec = { ...repair, program: { ...repair.program, selector: { tools: ["gateway"] } } };
	const direct = programFacts(noCodec, { ...context, facts: { input: current, original: input } });
	assert.deepEqual(direct.outer, direct.input);
	assert.deepEqual(direct.originalOuter, direct.original);
});

test("exact tool, server, and operation qualify inner repairs independently", () => {
	const accepted = planInput([repair], input, context);
	assert.equal(accepted.valid, true);
	assert.equal(accepted.changed, true);
	assert.deepEqual(accepted.candidate, { ...input, arguments: '{"name":"room"}' });
	for (const [candidate, tool, applicable] of [
		[{ ...input, server: "beta" }, "gateway", false],
		[{ operation: "send", arguments: input.arguments }, "gateway", "unknown"],
		[{ ...input, operation: "read" }, "gateway", true],
		[input, "other-gateway", true],
	] as const) {
		const plan = planInput([repair], candidate, { ...context, tool });
		assert.equal(plan.valid, true);
		assert.equal(plan.changed, false);
		assert.equal(plan.denied, false);
		assert.deepEqual(plan.candidate, candidate);
		assert.equal(plan.evaluations[0].applicable, applicable);
	}
	assert.deepEqual(input, { server: "alpha", operation: "send", arguments: '{"oldName":"room"}' });
});

test("malformed inner arguments retain raw qualification without repair authority", () => {
	for (const argumentsValue of ["not-json", "null", "[]", "42", '"text"']) {
		const candidate = { ...input, arguments: argumentsValue };
		const facts = programFacts(repair, context, candidate);
		assert.equal(facts.input, UNKNOWN);
		assert.equal(evaluateCondition(exactServer, facts), true);
		const plan = planInput([repair], candidate, context);
		assert.equal(plan.changed, false);
		assert.equal(plan.evaluations[0].truth, "unknown");
		assert.deepEqual(plan.candidate, candidate);
		const required = { ...repair, program: { ...repair.program, onUnavailable: "deny" as const } };
		assert.equal(planInput([required], candidate, context).denied, true);
		assert.equal(planInput([required], { ...candidate, server: "beta" }, context).denied, false);
		assert.equal(planInput([required], { operation: "send", arguments: argumentsValue }, context).denied, false);
	}
});

test("logical target changes qualify later stages against current outer and fixed original outer", () => {
	const servers: NamedData = {
		name: "servers",
		kind: "table",
		source: "operator",
		capturedAt: 1,
		revision: "123456abcdef",
		rows: [{ key: "friendly", value: "alpha" }],
	};
	const target: ProgramRule = {
		id: "target",
		revision: "123456abcdef",
		program: {
			phase: "input",
			selector: { tools: ["gateway"] },
			data: ["servers"],
			when: { op: "lookup", path: ["outer", "server"], table: "servers", value: "unique" },
			action: { kind: "substitute", path: ["server"], table: "servers", stage: "logical-target" },
			onUnavailable: "skip",
		},
	};
	const original = { ...input, server: "friendly" };
	const key: ProgramRule = {
		...repair,
		applicability: {
			all: [exactServer, { op: "eq", path: ["originalOuter", "server"], value: "friendly" }],
		},
	};
	const ctx = { ...context, data: snapshotData([innerSchema, servers], 2) };
	const plan = planInput([key, target], original, ctx);
	assert.equal(plan.valid, true);
	assert.equal(plan.changed, true);
	assert.deepEqual(plan.candidate, { ...input, arguments: '{"name":"room"}' });
	assert.deepEqual(
		plan.corrections.map((entry) => entry.stage),
		["logical-target", "keys"],
	);
	const gate = (inputView: "original" | "effective"): ProgramRule => ({
		id: "gate",
		revision: "123456abcdef",
		program: {
			phase: "input",
			inputView,
			selector: repair.program.selector,
			data: ["request-schema"],
			when: {
				all: [exactServer, { op: "eq", path: ["originalOuter", "server"], value: "friendly" }],
			},
			action: { kind: "deny" },
			onUnavailable: "skip",
		},
	});
	assert.equal(planInput([target, key, gate("original")], original, ctx).denied, false);
	const denied = planInput([target, key, gate("effective")], original, ctx);
	assert.equal(denied.denied, true);
	assert.deepEqual(denied.candidate, original);
	assert.equal(
		planInput([target, key, gate("effective")], original, { ...ctx, applyCorrections: false }).denied,
		false,
	);
});

test("all repairs within one stage read the same outer snapshot", () => {
	const gate: ProgramRule = {
		...repair,
		id: "not-yet-renamed",
		program: {
			...repair.program,
			when: { op: "contains", path: ["outer", "arguments"], value: '"name"' },
			action: { kind: "rename-key", path: [], from: "name", to: "other" },
		},
	};
	const plan = planInput([repair, gate], input, context);
	assert.equal(plan.valid, true);
	assert.deepEqual(plan.candidate, { ...input, arguments: '{"name":"room"}' });
	assert.equal(plan.evaluations.find((entry) => entry.id === gate.id)?.truth, false);
	const resultRule: ProgramRule = {
		...repair,
		program: {
			...repair.program,
			phase: "result",
			when: { all: [exactServer, { op: "exists", path: ["original", "oldName"] }] },
			action: { kind: "assert-error" },
		},
	};
	assert.equal(
		evaluatePrograms([resultRule], "result", { ...context, facts: { input: plan.candidate, original: input } })[0]
			.truth,
		true,
	);
});
