import assert from "node:assert/strict";
import { it } from "node:test";
import { fixture, source, row, turn, theme, conversationFrame } from "./dashboard-test-fixture.mts";
import { manualClock } from "./observation-clock-fixture.mts";
import { rosterLines } from "./dashboard-roster.ts";
it("key dispatch and render do not read sources or start hosts", async () => {
	let reads = 0;
	const observed = source(Array.from({ length: 100 }, (_, index) => row(String(index))));
	const list = observed.list;
	observed.list = async (input) => {
		reads++;
		return list(input);
	};
	let snapshots = 0;
	const snapshot = observed.snapshot;
	observed.snapshot = async (id) => {
		snapshots++;
		return snapshot(id);
	};
	const f = fixture(140, 45, observed);
	await turn();
	const count = reads;
	const selected = snapshots;
	for (let index = 0; index < 100; index++) f.ui.render(140);
	assert.equal(reads, count);
	assert.equal(snapshots, selected);
	f.ui.handleInput("?");
	f.ui.render(140);
	f.ui.handleInput("\x1b");
	assert.equal(reads, count);
	assert.equal(snapshots, selected);
	f.ui.dispose();
});

it("roster derivation reuses lines until the minute, selection or width changes", () => {
	let reads = 0;
	const measured = new Proxy(row("one"), {
		get(target, property, receiver) {
			if (property === "modifiedAt") reads++;
			return Reflect.get(target, property, receiver);
		},
	});
	const rows = [measured, row("two")];
	const paint = (now: number, selected = "one", width = 80) => rosterLines(rows, selected, width, 16, now, theme, false);
	paint(0);
	const initial = reads;
	assert.ok(initial > 0);
	paint(0);
	assert.equal(reads, initial, "an unchanged paint does not derive roster lines again");
	paint(60000);
	assert.ok(reads > initial, "a new minute derives new relative times");
	const beforeSelection = reads;
	paint(60000, "two");
	assert.ok(reads > beforeSelection, "a selection change derives the newly painted rows");
	const beforeWidth = reads;
	paint(60000, "two", 40);
	assert.ok(reads > beforeWidth, "a width change derives newly clipped lines");
});

it("selection reads follow key dispatch instead of blocking it", async () => {
	const observed = source([row("one"), row("two")]);
	let reads = 0;
	const read = observed.snapshot;
	observed.snapshot = async (id) => {
		reads++;
		return read(id);
	};
	const f = fixture(80, 24, observed);
	await turn();
	const count = reads;
	f.ui.handleInput("\x1b[B");
	assert.equal(f.state.selected, "two");
	assert.equal(reads, count);
	await turn();
	assert.equal(reads, count + 1);
	f.ui.dispose();
});

/** A source whose selected conversation publishes frames the test advances. */
function liveSource(ids: string[]) {
	const observed = source(ids.map((id) => row(id)));
	let notify = () => {};
	observed.subscribe = (listener) => { notify = listener; return () => {}; };
	const frames = new Map<string, ReturnType<typeof conversationFrame>>();
	let selected: string | undefined;
	const reads: string[] = [];
	observed.select = (id) => { selected = id; };
	observed.frame = (id) => { reads.push(id); return id === selected ? frames.get(id) : undefined; };
	observed.availability = (id) => (id === selected && frames.has(id) ? { state: "live", at: new Date(0).toISOString() } : undefined);
	return { observed, notify: () => notify(), frames, reads };
}

it("sustained frame updates apply the newest frame at most twenty times a second", async () => {
	const live = liveSource(["one"]);
	const clock = manualClock();
	live.frames.set("one", conversationFrame({ revision: 1 }));
	const f = fixture(100, 30, live.observed, undefined, undefined, theme, undefined, clock);
	try {
		await turn();
		const baseline = live.reads.length;
		for (let tick = 0; tick < 200; tick++) {
			live.frames.set("one", conversationFrame({ revision: tick + 2 }));
			live.notify();
			clock.advance(5);
			await turn();
		}
		const applications = live.reads.length - baseline;
		assert.ok(applications <= 20, `one simulated second applied ${applications} frames`);
		assert.ok(applications >= 10, "updates still reach the view");
		live.frames.set("one", conversationFrame({ revision: 500, status: { ...conversationFrame().status, busy: false } }));
		live.notify();
		clock.advance(50);
		await turn();
		assert.match(visible(f.ui.render(100)), /Idle/u, "the final state is presented");
	} finally { f.ui.dispose(); }
});

it("the first frame of a selection applies at once", async () => {
	const live = liveSource(["one"]);
	const clock = manualClock();
	live.frames.set("one", conversationFrame({ revision: 1 }));
	const f = fixture(100, 30, live.observed, undefined, undefined, theme, undefined, clock);
	try {
		await turn();
		assert.equal(clock.pending, 0, "the first application waited for no timer");
		assert.ok(live.reads.length > 0);
	} finally { f.ui.dispose(); }
});

it("a pending application never reaches a different selection", async () => {
	const live = liveSource(["one", "two"]);
	const clock = manualClock();
	live.frames.set("one", conversationFrame({ revision: 1 }));
	live.frames.set("two", conversationFrame({ revision: 1, storageId: "two" }));
	const f = fixture(100, 30, live.observed, undefined, undefined, theme, undefined, clock);
	try {
		await turn();
		live.frames.set("one", conversationFrame({ revision: 2 }));
		live.notify();
		live.notify();
		assert.equal(clock.pending, 1, "both changes share one waiting application");
		f.ui.handleInput("\x1b[B");
		assert.equal(f.state.selected, "two");
		const before = live.reads.filter((id) => id === "one").length;
		clock.advance(1000);
		await turn();
		assert.equal(live.reads.filter((id) => id === "one").length, before, "the earlier conversation is never read after the selection moved");
		assert.equal(clock.pending, 0);
	} finally { f.ui.dispose(); }
});

it("closing the view cancels a pending application", async () => {
	const live = liveSource(["one"]);
	const clock = manualClock();
	live.frames.set("one", conversationFrame({ revision: 1 }));
	const f = fixture(100, 30, live.observed, undefined, undefined, theme, undefined, clock);
	await turn();
	live.frames.set("one", conversationFrame({ revision: 2 }));
	live.notify();
	live.notify();
	const reads = live.reads.length;
	f.ui.dispose();
	assert.equal(clock.pending, 0, "disposal cancels the waiting pass");
	live.notify();
	clock.advance(1000);
	await turn();
	assert.equal(live.reads.length, reads);
});

function visible(lines: string[]): string {
	return lines.join("\n");
}
