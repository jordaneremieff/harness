import assert from "node:assert/strict";
import { test } from "node:test";
import { createObservationClock } from "./observation-clock.ts";

test("wall-clock jumps do not change observation time after its origin is captured", () => {
	let wall = 1_000;
	let monotonic = 50;
	let wallReads = 0;
	let monotonicReads = 0;
	const clock = createObservationClock(
		() => { wallReads++; return wall; },
		() => { monotonicReads++; return monotonic; },
	);
	assert.equal(wallReads, 1);
	assert.equal(monotonicReads, 1);
	assert.equal(clock.now(), 1_000);
	wall = 0;
	monotonic += 5;
	assert.equal(clock.now(), 1_005);
	wall = 100_000;
	monotonic += 5;
	assert.equal(clock.now(), 1_010);
	assert.equal(wallReads, 1);
	assert.equal(monotonicReads, 4);
});

test("each observation clock retains its own process origins", () => {
	let wall = 100;
	let monotonic = 10;
	const first = createObservationClock(() => wall, () => monotonic);
	wall = 200;
	monotonic = 20;
	const second = createObservationClock(() => wall, () => monotonic);
	wall = 0;
	monotonic = 25;
	assert.equal(first.now(), 115);
	assert.equal(second.now(), 205);
});
