import assert from "node:assert/strict";
import { test } from "node:test";
import { UNKNOWN } from "./data.ts";
import { ObservationState, STATE_LIMITS } from "./state.ts";
import { evaluatePrograms, PROGRAM_LIMITS, type ProgramRule, type StateSpec } from "./program.ts";

const rule = (state: Partial<StateSpec> = {}): ProgramRule => ({
	id: "failures",
	revision: "one",
	program: {
		phase: "context",
		when: { op: "gte", path: ["state", "count"], value: 2 },
		action: { kind: "guide", text: "Check the target before retry." },
		onUnavailable: "skip",
		state: { observe: { op: "eq", path: ["outcome", "kind"], value: "execution-error" }, ...state },
	},
});
const failed = { outcome: { kind: "execution-error", tokens: 7 } };

test("completed outcomes count execution failures separately from denied, invalid, and aborted calls", () => {
	const state = new ObservationState();
	state.sync([rule({ totalPath: ["outcome", "tokens"] })], 1);
	const pin = state.pin("failures")!;
	for (const kind of ["denied", "invalid", "aborted", "success"])
		assert.equal(state.complete(pin, { outcome: { kind } }, 1, 2), true);
	state.complete(pin, failed, 1, 3);
	state.complete(pin, failed, 2, 4);
	assert.equal(state.view("failures", 4, 2)?.count, 2);
	assert.equal(state.view("failures", 4, 2)?.total, 14);
	assert.equal(state.view("failures", 4, 2)?.turns, 2);
	assert.equal(state.view("failures", 4, 2)?.turnCount, 1);
	assert.equal(state.view("failures", 4, 2)?.turnTotal, 7);
});

test("unknown observation evidence does not count, and views are copies", () => {
	const state = new ObservationState();
	state.sync([rule()], 1);
	state.complete(state.pin("failures")!, {}, 1, 2);
	const view = state.view("failures", 2)!;
	view.count = 999;
	assert.equal(state.view("failures", 2)?.count, 0);
});

test("unavailable measured totals remain unknown until their affected period or window ends", () => {
	const state = new ObservationState();
	state.sync([rule({ totalPath: ["outcome", "tokens"], window: { maxEvents: 4, maxAgeMs: 10 } })], 0);
	const pin = state.pin("failures")!;
	state.complete(pin, { outcome: { kind: "execution-error", tokens: 0 } }, 1, 1);
	assert.equal(state.view("failures", 1, 1)?.total, 0);
	state.complete(pin, { outcome: { kind: "execution-error" } }, 2, 2);
	assert.equal(state.view("failures", 2, 2)?.count, 2);
	assert.equal(state.view("failures", 2, 2)?.total, UNKNOWN);
	assert.equal(state.view("failures", 2, 2)?.turnTotal, UNKNOWN);
	assert.equal(state.view("failures", 2, 1)?.turnTotal, 0);
	assert.equal(state.view("failures", 2)?.windowTotal, UNKNOWN);
	state.complete(pin, failed, 3, 12);
	assert.equal(state.view("failures", 12)?.windowTotal, 7);
	assert.equal(state.view("failures", 12)?.total, UNKNOWN);
	state.reset("operator", 13);
	assert.equal(state.view("failures", 13)?.total, 0);
});

test("window aggregates use the last-N and age intersection without stale samples", () => {
	const state = new ObservationState();
	state.sync([rule({ totalPath: ["outcome", "tokens"], window: { maxEvents: 2, maxAgeMs: 10 } })], 0);
	const pin = state.pin("failures")!;
	state.complete(pin, failed, 1, 1);
	state.complete(pin, failed, 1, 2);
	state.complete(pin, failed, 2, 3);
	const view = state.view("failures", 3)!;
	assert.equal(view.count, 3);
	assert.equal(view.windowCount, 2);
	assert.equal(view.windowTotal, 14);
	assert.equal(view.windowTurns, 2);
	assert.equal(state.view("failures", 12)?.windowCount, 1);
	assert.equal(state.view("failures", 13)?.windowCount, 0);
	assert.equal(state.view("failures", 13)?.count, 3);
});

test("success reset clears failure windows, turn totals, and guidance flags", () => {
	const state = new ObservationState();
	state.sync(
		[
			rule({
				resetWhen: { op: "eq", path: ["outcome", "kind"], value: "success" },
				once: "period",
				totalPath: ["outcome", "tokens"],
				window: { maxEvents: 10, maxAgeMs: 100 },
			}),
		],
		0,
	);
	const pin = state.pin("failures")!;
	state.complete(pin, failed, 1, 1);
	assert.equal(state.project("failures", 2, 1), true);
	assert.equal(state.eligible("failures", 2, 1), false);
	state.complete(pin, { outcome: { kind: "success" } }, 2, 3);
	const view = state.view("failures", 3, 1)!;
	for (const field of [
		"count",
		"total",
		"windowCount",
		"windowTotal",
		"windowTurns",
		"turns",
		"turnCount",
		"turnTotal",
		"projected",
	] as const)
		assert.equal(view[field], 0);
	assert.equal(view.resetReason, "condition");
	assert.equal(view.eligible, true);
	assert.equal(state.complete(pin, failed, 2, 4), true);
	assert.equal(state.view("failures", 4)?.count, 1);
});

test("once-per-turn and cooldown flags change only on actual projection", () => {
	const state = new ObservationState();
	state.sync([rule({ once: "turn", cooldownMs: 10 })], 0);
	assert.equal(state.eligible("failures", 1, 1), true);
	assert.equal(state.eligible("failures", 1, 1), true);
	assert.equal(state.view("failures", 1)?.projected, 0);
	assert.equal(state.project("failures", 1, 1), true);
	assert.equal(state.project("failures", 20, 1), false);
	assert.equal(state.project("failures", 5, 2), false);
	assert.equal(state.project("failures", 11, 2), true);
});

test("semantic and lifecycle resets reject stale generations; ordinary sync preserves periods", () => {
	for (const reason of ["load", "reload", "new", "resume", "fork", "tree-navigation"]) {
		const state = new ObservationState();
		state.sync([rule()], 1);
		const pin = state.pin("failures")!;
		state.complete(pin, failed, 1, 2);
		state.sync([rule()], 3);
		assert.equal(state.view("failures", 3)?.count, 1);
		state.reset(reason, 4);
		assert.equal(state.complete(pin, failed, 1, 5), false);
		assert.equal(state.view("failures", 5)?.count, 0);
		assert.equal(state.view("failures", 5)?.resetReason, reason);
	}
	const state = new ObservationState();
	state.sync([rule()], 1);
	const old = state.pin("failures")!;
	state.sync([{ ...rule(), revision: "two" }], 2);
	assert.equal(state.complete(old, failed, 1, 3), false);
	const revised = state.pin("failures")!;
	state.sync([], 4);
	state.sync([{ ...rule(), revision: "two" }], 5);
	assert.equal(state.complete(revised, failed, 1, 6), false);
});

test("expiry previews do not mutate state; long calls enter the new completion period", () => {
	const state = new ObservationState();
	state.sync([rule({ expiresAfterMs: 10, once: "period" })], 1);
	const pin = state.pin("failures")!;
	state.complete(pin, failed, 1, 2);
	state.project("failures", 2, 1);
	assert.equal(state.view("failures", 11)?.count, 0);
	assert.equal(state.view("failures", 11)?.eligible, true);
	assert.deepEqual(state.pin("failures"), pin);
	assert.equal(state.view("failures", 3)?.projected, 1);
	assert.equal(state.complete(pin, failed, 2, 11), true);
	assert.deepEqual(state.pin("failures"), pin);
	assert.equal(state.view("failures", 11)?.resetReason, "expiry");
	assert.equal(state.view("failures", 11)?.count, 1);
	assert.equal(state.view("failures", 11)?.projected, 0);
});

test("rule reset affects only its rule and stateless programs still receive pins", () => {
	const state = new ObservationState();
	const plain = rule();
	delete plain.program.state;
	plain.id = "plain";
	state.sync([rule(), plain], 1);
	const retained = state.pin("plain")!;
	state.reset("operator", 2, "failures");
	assert.deepEqual(state.pin("plain"), retained);
	assert.equal(state.complete(retained, failed, 1, 3), true);
	assert.equal(state.snapshot(3).length, 2);
});

test("turn bounds retain exact current totals and expose unavailable historical counts", () => {
	const state = new ObservationState();
	state.sync([rule({ totalPath: ["outcome", "tokens"] })], 0);
	const pin = state.pin("failures")!;
	for (let turn = 1; turn <= STATE_LIMITS.turns + 2; turn++) state.complete(pin, failed, turn, turn);
	const latest = state.view("failures", 2000, STATE_LIMITS.turns + 2)!;
	assert.equal(latest.turnCount, 1);
	assert.equal(latest.turnTotal, 7);
	assert.equal(latest.turns, UNKNOWN);
	assert.equal(latest.saturated, true);
	assert.equal(state.view("failures", 2000, STATE_LIMITS.turns + 1)?.turnCount, UNKNOWN);
	state.complete(pin, failed, STATE_LIMITS.turns + 2, 2001);
	assert.equal(state.view("failures", 2001, STATE_LIMITS.turns + 2)?.turnCount, 2);
});

test("the shared capacity admits mixed shell-derived and facts plans without truncation", () => {
	const state = new ObservationState();
	const plans = Array.from(
		{ length: PROGRAM_LIMITS.rules },
		(_, index): ProgramRule =>
			index % 2 === 0
				? { ...rule(), id: `facts-${index}` }
				: {
						id: `shell-${index}`,
						revision: "one",
						program: {
							phase: "result",
							when: { op: "eq", path: ["tool"], value: "bash" },
							action: { kind: "guide", text: "Use the approved command shape." },
							onUnavailable: "skip",
						},
					},
	);
	state.sync(plans, 0);
	assert.equal(state.snapshot(0).length, PROGRAM_LIMITS.rules);
	assert.equal(evaluatePrograms(plans, "result", { tool: "bash" }).length, PROGRAM_LIMITS.rules / 2);
	const excess = [...plans, { ...rule(), id: "overflow" }];
	assert.throws(() => state.sync(excess, 1));
	assert.throws(() => evaluatePrograms(excess, "result", { tool: "bash" }));
	assert.equal(state.snapshot(1).length, PROGRAM_LIMITS.rules);
});

test("invalid times and overbound rule sets do not enter state", () => {
	const state = new ObservationState();
	assert.throws(() => state.sync([rule()], NaN));
	assert.throws(() => state.sync([rule(), rule()], 0));
	state.sync([rule()], 1);
	assert.equal(state.complete(state.pin("failures")!, failed, 1, 0), false);
	assert.equal(state.complete(state.pin("failures")!, failed, -1, 2), false);
	assert.equal(state.project("failures", NaN, 1), false);
	assert.equal(state.view("missing", 2), undefined);
});
