import assert from "node:assert/strict";
import { it } from "node:test";
import type { TuiMouseEvent, TuiMouseButton, TuiMouseEventType } from "@earendil-works/pi-tui";
import { HitMap } from "./hits.ts";

interface MousePatch {
	readonly type?: TuiMouseEventType;
	readonly button?: TuiMouseButton;
	readonly shift?: boolean;
	readonly alt?: boolean;
	readonly ctrl?: boolean;
	readonly wheelDelta?: number;
	readonly clickCount?: number;
}

function mouse(x: number, y: number, width: number, height: number, patch: MousePatch = {}): TuiMouseEvent {
	return {
		type: "click",
		button: "left",
		x,
		y,
		screenX: x,
		screenY: y,
		width,
		height,
		shift: false,
		alt: false,
		ctrl: false,
		...patch,
	};
}

it("a completed left click inside a region runs its handler with local coordinates", () => {
	const hits = new HitMap();
	hits.begin(10, 5);
	hits.add({
		x: 2,
		y: 1,
		width: 3,
		height: 2,
		click: (event) => {
			assert.equal(event.x, 1);
			assert.equal(event.y, 1);
			assert.equal(event.width, 3);
			assert.equal(event.height, 2);
			return { focus: true };
		},
	});
	const result = hits.handle(mouse(3, 2, 10, 5));
	assert.deepEqual(result, { handled: true, render: true, focus: true });
});

it("presses and non-left buttons are left to Pi", () => {
	const hits = new HitMap();
	let clicks = 0;
	hits.begin(10, 5);
	hits.add({ x: 0, y: 0, width: 10, height: 5, click: () => { clicks++; } });
	assert.equal(hits.handle(mouse(1, 1, 10, 5, { type: "press" })), undefined);
	assert.equal(hits.handle(mouse(1, 1, 10, 5, { button: "right" })), undefined);
	assert.equal(hits.handle(mouse(1, 1, 10, 5, { button: "middle" })), undefined);
	assert.equal(clicks, 0);
});

it("a wheel turn inside a region scrolls it and is consumed", () => {
	const hits = new HitMap();
	const deltas: number[] = [];
	hits.begin(10, 5);
	hits.add({ x: 0, y: 0, width: 10, height: 5, wheel: (delta) => deltas.push(delta) });
	assert.deepEqual(hits.handle(mouse(4, 2, 10, 5, { type: "wheel", wheelDelta: -3 })), { handled: true, render: true });
	assert.deepEqual(deltas, [-3]);
});

it("a wheel turn over a region without a wheel handler is left to Pi", () => {
	const hits = new HitMap();
	hits.begin(10, 5);
	hits.add({ x: 0, y: 0, width: 10, height: 5, click: () => undefined });
	assert.equal(hits.handle(mouse(4, 2, 10, 5, { type: "wheel", wheelDelta: 2 })), undefined);
});

it("an event for another size than the last begin is refused", () => {
	const hits = new HitMap();
	let clicks = 0;
	hits.begin(10, 5);
	hits.add({ x: 0, y: 0, width: 10, height: 5, click: () => { clicks++; } });
	assert.equal(hits.handle(mouse(1, 1, 11, 5)), undefined);
	assert.equal(hits.handle(mouse(1, 1, 10, 6)), undefined);
	assert.equal(clicks, 0);
});

it("a click with a modifier is refused", () => {
	const hits = new HitMap();
	let clicks = 0;
	hits.begin(10, 5);
	hits.add({ x: 0, y: 0, width: 10, height: 5, click: () => { clicks++; } });
	assert.equal(hits.handle(mouse(1, 1, 10, 5, { shift: true })), undefined);
	assert.equal(hits.handle(mouse(1, 1, 10, 5, { alt: true })), undefined);
	assert.equal(hits.handle(mouse(1, 1, 10, 5, { ctrl: true })), undefined);
	assert.equal(clicks, 0);
});

it("a click handler that returns false declines so Pi keeps the event", () => {
	const hits = new HitMap();
	hits.begin(10, 5);
	hits.add({ x: 0, y: 0, width: 10, height: 5, click: () => false });
	assert.equal(hits.handle(mouse(1, 1, 10, 5)), undefined);
});

it("a click outside every region is left to Pi", () => {
	const hits = new HitMap();
	hits.begin(10, 5);
	hits.add({ x: 0, y: 0, width: 2, height: 1, click: () => undefined });
	assert.equal(hits.handle(mouse(5, 3, 10, 5)), undefined);
});

it("include offsets a child map's regions by the child's origin, and clicks arrive in region coordinates", () => {
	const child = new HitMap();
	child.begin(4, 2);
	const seen: Array<[number, number]> = [];
	child.add({ x: 1, y: 1, width: 2, height: 1, click: (event) => { seen.push([event.x, event.y]); } });
	const parent = new HitMap();
	parent.begin(20, 10);
	parent.include(child, 5, 3);
	assert.deepEqual(parent.handle(mouse(6, 4, 20, 10)), { handled: true, render: true });
	assert.deepEqual(parent.handle(mouse(7, 4, 20, 10)), { handled: true, render: true });
	assert.deepEqual(seen, [[0, 0], [1, 0]], "a handler reads the click relative to its own region");
	assert.equal(parent.handle(mouse(1, 1, 20, 10)), undefined);
});
