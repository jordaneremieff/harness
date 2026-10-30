import assert from "node:assert/strict";
import { test } from "node:test";
import { ActionApprovals, type ActionBinding, sameActionInput, sealActionInput } from "./action-approval.ts";
import { planInput, type ProgramRule, validateFactsProgram } from "./program.ts";
import { controlResult } from "./control.ts";

const binding: ActionBinding = {
	session: "session",
	scope: { cwd: "/project", provider: null, model: null },
	authority: "current",
	mode: "enforce",
};
const rules: ProgramRule[] = ["machine.write", "machine.target"].map((id) => ({
	id,
	revision: "123456abcdef",
	program: {
		phase: "input",
		when: { op: "exists", path: ["input"] },
		action: { kind: "require-approval" },
		onUnavailable: "deny",
	},
}));
function plan(args: Record<string, unknown> = { room: "release-notices", text: "Ready" }, selected = rules) {
	return planInput(selected, args, { tool: "send", scope: binding.scope });
}
function pending(book: ActionApprovals, b = binding): { actionId: string; revision: string } {
	const value = book.control({ operation: "actions" }, b) as { actions: Array<{ actionId: string; revision: string }> };
	assert.equal(value.actions.length, 1);
	const { actionId, revision } = value.actions[0];
	return { actionId, revision };
}
function approve(book: ActionApprovals, b = binding) {
	const entry = pending(book, b);
	book.control(
		{ operation: "action-approve", ...entry, authorization: "The operator approved this exact target and payload." },
		b,
	);
	return entry;
}

test("all matching gates bind one complete action and one unchanged retry", () => {
	const book = new ActionApprovals();
	const first = plan();
	assert.equal(first.denied, true);
	assert.match(book.gate(first, "send", binding) ?? "", /Operator approval required/);
	const entry = pending(book);
	const inspected = book.control({ operation: "action-inspect", actionId: entry.actionId }, binding) as {
		arguments: unknown;
		rules: unknown[];
	};
	assert.deepEqual(inspected.arguments, { room: "release-notices", text: "Ready" });
	assert.equal(inspected.rules.length, 2);
	approve(book);
	const retry = plan();
	assert.equal(book.gate(retry, "send", binding), undefined);
	assert.equal(retry.denied, false);
	assert.throws(
		() => book.control({ operation: "action-approve", ...entry, authorization: "Repeat." }, binding),
		/No current action/,
	);
	const future = plan();
	assert.match(book.gate(future, "send", binding) ?? "", /Operator approval required/);
	assert.notEqual(pending(book).actionId, entry.actionId);
});

test("canonical key order is equal, changed payload, target and tool are not", () => {
	assert.equal(sameActionInput({ b: [1, { x: "A" }], a: true }, { a: true, b: [1, { x: "A" }] }), true);
	const book = new ActionApprovals();
	book.gate(plan(), "send", binding);
	approve(book);
	for (const [tool, args] of [
		["topic", { room: "release-notices", text: "Ready" }],
		["send", { room: "other", text: "Ready" }],
		["send", { room: "release-notices", text: "Changed" }],
	] as const) {
		const candidate = plan(args);
		assert.match(book.gate(candidate, tool, binding) ?? "", /approval required/);
		assert.equal(candidate.denied, true);
	}
	const unchanged = plan();
	book.gate(unchanged, "send", binding);
	assert.equal(unchanged.denied, false);
});

test("parallel retries consume synchronously once", async () => {
	const book = new ActionApprovals();
	book.gate(plan(), "send", binding);
	approve(book);
	const candidates = [plan(), plan()];
	await Promise.all(candidates.map(async (candidate) => book.gate(candidate, "send", binding)));
	assert.equal(candidates.filter((candidate) => !candidate.denied).length, 1);
});

test("other denials and invalid plans do not consume the armed action", () => {
	const book = new ActionApprovals();
	book.gate(plan(), "send", binding);
	approve(book);
	const denied = plan({}, [
		...rules,
		{
			id: "other.deny",
			revision: "123456abcdef",
			program: {
				phase: "input",
				when: { op: "exists", path: ["input"] },
				action: { kind: "deny" },
				onUnavailable: "deny",
			},
		},
	]);
	assert.match(book.gate(denied, "send", binding) ?? "", /Other approved/);
	const invalid = plan();
	invalid.valid = false;
	assert.match(book.gate(invalid, "send", binding) ?? "", /Other approved/);
	const retry = plan();
	book.gate(retry, "send", binding);
	assert.equal(retry.denied, false);
});

test("scope, rule/schema authority, mode and runtime loss invalidate the permission", () => {
	for (const changed of [
		{ ...binding, authority: "changed" },
		{ ...binding, scope: { ...binding.scope, cwd: "/other" } },
		{ ...binding, mode: "observe" },
	]) {
		const book = new ActionApprovals();
		book.gate(plan(), "send", binding);
		const entry = approve(book);
		assert.throws(
			() => book.control({ operation: "action-inspect", actionId: entry.actionId }, changed),
			/No current action/,
		);
		assert.throws(
			() => book.control({ operation: "action-approve", ...entry, authorization: "Stale." }, binding),
			/No current action/,
		);
	}
	const book = new ActionApprovals();
	book.gate(plan(), "send", binding);
	const entry = approve(book);
	book.clear();
	assert.throws(
		() => book.control({ operation: "action-inspect", actionId: entry.actionId }, binding),
		/No current action/,
	);
	assert.throws(
		() => new ActionApprovals().control({ operation: "action-inspect", actionId: entry.actionId }, binding),
		/No current action/,
	);
});

test("foreign conversations cannot inspect or consume another action", () => {
	const book = new ActionApprovals();
	book.gate(plan(), "send", binding);
	const entry = approve(book);
	const foreign = { ...binding, session: "sibling" };
	assert.throws(
		() => book.control({ operation: "action-inspect", actionId: entry.actionId }, foreign),
		/No current action/,
	);
	const retry = plan();
	assert.match(book.gate(retry, "send", foreign) ?? "", /approval required/);
	const original = plan();
	book.gate(original, "send", binding);
	assert.equal(original.denied, false);
});

test("stale revision, blank authority, rejection and repeated approval do not add uses", () => {
	const book = new ActionApprovals();
	book.gate(plan(), "send", binding);
	const entry = pending(book);
	assert.throws(
		() =>
			book.control({ operation: "action-approve", ...entry, revision: "000000000000", authorization: "Yes." }, binding),
		/revision changed/,
	);
	assert.throws(
		() => book.control({ operation: "action-approve", ...entry, authorization: " " }, binding),
		/authorization/,
	);
	approve(book);
	assert.throws(
		() => book.control({ operation: "action-approve", ...entry, authorization: "Again." }, binding),
		/already approved/,
	);
	book.control(
		{ operation: "action-reject", ...entry, authorization: "The operator rejected this operation." },
		binding,
	);
	const retry = plan();
	assert.match(book.gate(retry, "send", binding) ?? "", /approval required/);
});

test("unknown evidence and non-enforce modes create no permission", () => {
	const unknown = planInput(
		[{ ...rules[0], program: { ...rules[0].program, when: { op: "eq", path: ["input", "missing"], value: true } } }],
		{},
		{ tool: "send" },
	);
	const book = new ActionApprovals();
	assert.match(book.gate(unknown, "send", binding) ?? "", /evidence is unavailable/);
	assert.deepEqual((book.control({ operation: "actions" }, binding) as { actions: unknown[] }).actions, []);
	for (const mode of ["observe", "notice", "annotate"]) book.gate(plan(), "send", { ...binding, mode });
	assert.deepEqual((book.control({ operation: "actions" }, binding) as { actions: unknown[] }).actions, []);
});

test("approval action grammar requires final input and no observation state", () => {
	assert.equal(validateFactsProgram(rules[0].program), undefined);
	assert.match(validateFactsProgram({ ...rules[0].program, phase: "result" }) ?? "", /unavailable/);
	assert.match(validateFactsProgram({ ...rules[0].program, inputView: "original" }) ?? "", /always use final/);
	assert.match(
		validateFactsProgram({ ...rules[0].program, state: { observe: { op: "exists", path: ["input"] } } }) ?? "",
		/always use final/,
	);
});

test("maximum-capacity action list fits the control output bound without rule duplication", () => {
	const book = new ActionApprovals();
	const manyRules = Array.from({ length: 16 }, (_, index) => ({ ...rules[0], id: `machine.rule-${index}` }));
	for (let index = 0; index < 64; index++)
		book.gate(plan({ room: "release-notices", text: String(index) }, manyRules), "send", binding);
	const list = book.control({ operation: "actions" }, binding) as {
		actions: Array<{ actionId: string; rules?: unknown }>;
	};
	assert.equal(list.actions.length, 64);
	assert.ok(Buffer.byteLength(controlResult(list).content[0].text) < 48 * 1024);
	assert.equal(list.actions[0].rules, undefined);
	const complete = book.control({ operation: "action-inspect", actionId: list.actions[0].actionId }, binding) as {
		rules: unknown[];
	};
	assert.equal(complete.rules.length, 16);
	assert.match(
		book.gate(plan({ room: "release-notices", text: "overflow" }, manyRules), "send", binding) ?? "",
		/capacity reached/,
	);
});

test("preflight peeks do not consume final execution permission", () => {
	const book = new ActionApprovals();
	book.gate(plan(), "send", binding);
	const armed = approve(book);
	const before = plan();
	book.gate(before, "send", binding, undefined, false);
	assert.equal(before.denied, false);
	assert.equal(
		(book.control({ operation: "action-inspect", actionId: armed.actionId }, binding) as { state: string }).state,
		"approved",
	);
	const final = plan();
	book.gate(final, "send", binding);
	assert.equal(final.denied, false);
	const replay = plan();
	assert.match(book.gate(replay, "send", binding) ?? "", /approval required/);
});

test("exact input rejects lossy JSON, bounds payloads, and seals nested references", () => {
	for (const value of [
		{ a: undefined },
		{ a: NaN },
		{ a: -0 },
		{ a: () => {} },
		Object.defineProperty({}, "a", { value: 1 }),
		{ [Symbol("hidden")]: 1 },
	])
		assert.equal(sameActionInput(value, {}), false);
	const book = new ActionApprovals();
	assert.match(book.gate(plan({ room: "room", text: "x".repeat(17000) }), "send", binding) ?? "", /byte bound/);
	const value = { payload: { items: ["text"] } };
	sealActionInput(value);
	assert.throws(() => {
		value.payload.items[0] = "changed";
	}, TypeError);
	assert.throws(() => {
		Object.assign(value, { payload: {} });
	}, TypeError);
});
