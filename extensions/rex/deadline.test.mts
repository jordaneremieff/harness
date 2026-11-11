import assert from "node:assert/strict";
import test from "node:test";
import { createRexBudget, RexStopped, type BudgetClock } from "./deadline.ts";

function scheduler() {
	let now = 0;
	const tasks = new Map<number, { at: number; action: () => void }>();
	let id = 0;
	const clock: BudgetClock = {
		now: () => now,
		schedule(action, milliseconds) { const key = ++id; tasks.set(key, { at: now + milliseconds, action }); return () => { tasks.delete(key); }; },
	};
	return {
		clock,
		get pending() { return tasks.size; },
		advance(milliseconds: number) {
			const end = now + milliseconds;
			for (;;) {
				const next = [...tasks.entries()].filter(([, task]) => task.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
				if (!next) break;
				now = next[1].at; tasks.delete(next[0]); next[1].action();
			}
			now = end;
		},
	};
}

for (const [total, work] of [[1000, 900], [13500, 12500]] as const) {
	test(`one ${total} ms allowance includes observation and teardown`, () => {
		const time = scheduler();
		const budget = createRexBudget(total, 300000, undefined, time.clock);
		assert.equal(budget.workEndsAt, work);
		assert.equal(budget.endsAt, total);
		time.advance(work - 1);
		budget.check("observe");
		assert.equal(budget.remaining("work"), 1);
		time.advance(1);
		assert.throws(() => budget.check("observe"), RexStopped);
		assert.equal(budget.stopReason(), "timeout");
		budget.check("finalise");
		time.advance(total - work);
		assert.throws(() => budget.check("finalise"), RexStopped);
		budget.dispose();
		assert.equal(time.pending, 0);
	});
}

test("caller cancellation shortens only mandatory finalisation and preserves its cause", () => {
	const time = scheduler();
	const caller = new AbortController();
	const budget = createRexBudget(1000, 300000, caller.signal, time.clock);
	time.advance(200); caller.abort();
	assert.equal(budget.stopReason(), "cancelled");
	assert.equal(budget.endsAt, 300);
	assert.throws(() => budget.check("effect"), RexStopped);
	budget.check("finalise");
	time.advance(100);
	assert.equal(budget.finaliseSignal.aborted, true);
	time.advance(1000);
	assert.equal(budget.stopReason(), "cancelled");
	budget.dispose();
	assert.equal(time.pending, 0);
});

test("delayed resolution spends the same allowance as later calls", () => {
	const time = scheduler();
	const budget = createRexBudget(1000, 300000, undefined, time.clock);
	time.advance(450);
	budget.check("resolve");
	assert.equal(budget.remaining("work"), 450);
	time.advance(450);
	assert.equal(budget.remaining("work"), 0);
	assert.equal(budget.remaining("finalise"), 100);
	budget.dispose();
});

test("immediate cancellation admits no work and disposal removes all timers", () => {
	const time = scheduler();
	const caller = new AbortController(); caller.abort();
	const budget = createRexBudget(1000, 300000, caller.signal, time.clock);
	assert.throws(() => budget.check("resolve"), RexStopped);
	assert.equal(budget.stopReason(), "cancelled");
	assert.equal(budget.endsAt, 100);
	budget.dispose();
	assert.equal(time.pending, 0);
});

test("invalid allowances create no timers and the configured cap is effective", () => {
	const time = scheduler();
	assert.throws(() => createRexBudget(Number.NaN, 1000, undefined, time.clock));
	assert.equal(time.pending, 0);
	const budget = createRexBudget(300000, 1000, undefined, time.clock);
	assert.equal(budget.effectiveMs, 1000);
	assert.equal(budget.workEndsAt, 900);
	budget.dispose();
});
