import assert from "node:assert/strict";
import { it } from "node:test";
import { manualClock } from "./observation-clock-fixture.mts";
import { createObservationPump } from "./observation-pump.ts";

/** Let the pump's asynchronous pass settle without using a clock timer. */
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => { resolve = done; });
	return { promise, resolve };
}

it("a burst of marks admits one pass and waits the interval from its start", async () => {
	const clock = manualClock();
	let runs = 0;
	const pump = createObservationPump({ intervalMs: 100, run: () => { runs++; }, onError: () => assert.fail("unexpected failure"), clock });
	pump.markDirty();
	pump.markDirty();
	pump.markDirty();
	assert.equal(clock.pending, 1, "marks share one waiting pass");
	clock.advance(0);
	assert.equal(runs, 1, "the first pass does not wait behind a quiet period");
	await settle();
	assert.equal(clock.pending, 0);
	pump.markDirty();
	assert.equal(clock.pending, 1);
	clock.advance(99);
	assert.equal(runs, 1, "a later pass waits the full interval from the last start");
	clock.advance(1);
	assert.equal(runs, 2);
	await settle();
	pump.dispose();
});

it("a mark during a pass keeps the trailing dirty state and schedules after it settles", async () => {
	const clock = manualClock();
	const gate = deferred();
	let runs = 0;
	const pump = createObservationPump({
		intervalMs: 100,
		run: async () => {
			runs++;
			if (runs === 1) await gate.promise;
		},
		onError: () => assert.fail("unexpected failure"),
		clock,
	});
	pump.markDirty();
	clock.advance(0);
	pump.markDirty();
	pump.markDirty();
	assert.equal(clock.pending, 0, "a pass in flight holds the trailing state instead of a second timer");
	gate.resolve();
	await settle();
	assert.equal(clock.pending, 1);
	clock.advance(99);
	assert.equal(runs, 1, "the trailing pass does not rebuild immediately");
	clock.advance(1);
	assert.equal(runs, 2);
	await settle();
	pump.dispose();
});

it("reports a failed pass and keeps accepting later work", async () => {
	const clock = manualClock();
	const errors: unknown[] = [];
	let runs = 0;
	const pump = createObservationPump({
		intervalMs: 100,
		run: () => {
			runs++;
			if (runs === 1) throw new Error("pass failed");
		},
		onError: (error) => { errors.push(error); },
		clock,
	});
	pump.markDirty();
	clock.advance(0);
	await settle();
	assert.equal(errors.length, 1);
	pump.markDirty();
	clock.advance(100);
	await settle();
	assert.equal(runs, 2);
	assert.equal(errors.length, 1);
	pump.dispose();
});

it("cancelling a waiting pass drops its dirty state and later marks run again", async () => {
	const clock = manualClock();
	let runs = 0;
	const pump = createObservationPump({ intervalMs: 100, run: () => { runs++; }, onError: () => assert.fail("unexpected failure"), clock });
	pump.markDirty();
	assert.equal(clock.pending, 1);
	pump.cancelPending();
	assert.equal(clock.pending, 0);
	clock.advance(1000);
	assert.equal(runs, 0, "a cancelled pass never runs");
	pump.markDirty();
	clock.advance(0);
	assert.equal(runs, 1);
	await settle();
	pump.dispose();
});

it("disposal stops later marks and a pass in flight schedules nothing", async () => {
	const clock = manualClock();
	const gate = deferred();
	let runs = 0;
	const pump = createObservationPump({ intervalMs: 100, run: async () => { runs++; await gate.promise; }, onError: () => assert.fail("unexpected failure"), clock });
	pump.markDirty();
	clock.advance(0);
	pump.markDirty();
	pump.dispose();
	pump.dispose();
	pump.markDirty();
	pump.cancelPending();
	gate.resolve();
	await settle();
	assert.equal(clock.pending, 0, "a trailing mark is dropped on disposal");
	clock.advance(1000);
	assert.equal(runs, 1);
	await settle();
	assert.equal(runs, 1);
});

it("sustained marks stay within the cadence and apply the final state", async () => {
	const clock = manualClock();
	let runs = 0;
	let applied = 0;
	let state = 0;
	const pump = createObservationPump({
		intervalMs: 100,
		run: () => {
			runs++;
			applied = state;
		},
		onError: () => assert.fail("unexpected failure"),
		clock,
	});
	pump.markDirty();
	for (let step = 0; step < 100; step++) {
		clock.advance(10);
		await settle();
		state++;
		pump.markDirty();
	}
	assert.ok(runs <= 11, `one simulated second admitted ${runs} passes`);
	assert.ok(runs >= 9, "sustained work still reaches the pump");
	clock.advance(100);
	await settle();
	assert.equal(applied, state, "the last mark is not lost");
	pump.dispose();
});
