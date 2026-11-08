import assert from "node:assert/strict";
import { it } from "node:test";
import { fixture, source, row, turn, theme, conversationFrame } from "./dashboard-test-fixture.mts";
import { manualClock } from "./observation-clock-fixture.mts";
import { rosterLines } from "./dashboard-roster.ts";
import { AgentConsole } from "./agent-console.ts";
import { ConversationHistory } from "./conversation-view.ts";
import type { AgentConversationEntry } from "./dashboard-types.ts";
import { ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { buildLiveEntries } from "./live-frames.ts";
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

function userEntry(id: string, content: string): AgentConversationEntry {
	return { id, kind: "pi.user", model: [{ role: "user", content, timestamp: 1 }] };
}

it("unchanged history skips reconciliation and committed usage while live facts update", async (t) => {
	const tail = t.mock.method(ConversationHistory.prototype, "tail");
	const usage = t.mock.method(AgentConsole.prototype, "observeUsage");
	const historyEntries = t.mock.method(ConversationHistory.prototype, "entries");
	const live = liveSource(["one"]);
	const clock = manualClock();
	const initial = conversationFrame({ entries: [userEntry("1", "Retained history")] });
	live.frames.set("one", initial);
	const f = fixture(120, 40, live.observed, undefined, undefined, theme, undefined, clock);
	try {
		await turn();
		const tails = tail.mock.callCount();
		const usages = usage.mock.callCount();
		const snapshots = historyEntries.mock.callCount();
		const currentUsage = { models: {}, tools: {} } as NonNullable<typeof initial.status.usage>;
		live.frames.set("one", { ...initial, revision: 2, live: [userEntry("live:message", "New live output")], status: { ...initial.status, busy: false, usage: currentUsage } });
		live.notify(); clock.advance(50); await turn();
		assert.equal(tail.mock.callCount(), tails);
		assert.equal(usage.mock.callCount(), usages);
		assert.equal(historyEntries.mock.callCount(), snapshots, "the committed snapshot is not rebuilt");
		const console = usage.mock.calls.at(-1)?.this as AgentConsole;
		assert.strictEqual(console.usage, currentUsage);
		assert.match(visible(f.ui.render(120)), /New live output/u);
		assert.match(visible(f.ui.render(120)), /Idle/u);
		for (const patch of [{ coverage: { ...initial.coverage, complete: false } }, { nextBefore: 1 }]) {
			const previous = live.frames.get("one");
			assert.ok(previous);
			live.frames.set("one", { ...previous, ...patch, revision: previous.revision + 1 });
			live.notify(); clock.advance(50); await turn();
		}
		assert.equal(tail.mock.callCount(), tails + 2, "coverage and cursor changes each reconcile history");
		assert.equal(usage.mock.callCount(), usages, "coverage and cursor changes do not recompute committed usage");
		assert.match(visible(f.ui.render(120)), /Partial history/u);
	} finally { f.ui.dispose(); }
});

it("append and truncated history frames render identically with shared or rebuilt history", async () => {
	const shared = liveSource(["one"]);
	const rebuilt = liveSource(["one"]);
	const clock = manualClock();
	const otherClock = manualClock();
	const entries = [userEntry("1", "First message"), userEntry("2", "Second message")];
	const initial = conversationFrame({ entries });
	shared.frames.set("one", initial);
	rebuilt.frames.set("one", structuredClone(initial));
	const f = fixture(120, 40, shared.observed, undefined, undefined, theme, undefined, clock);
	const reference = fixture(120, 40, rebuilt.observed, undefined, undefined, theme, undefined, otherClock);
	try {
		await turn();
		const appended = [...entries, userEntry("3", "Appended message")];
		for (const frame of [
			{ ...initial, revision: 2, live: [userEntry("live:message", "Text append")] },
			{ ...initial, revision: 3, entries: appended },
			{ ...initial, revision: 4, entries: appended.slice(1), coverage: { ...initial.coverage, complete: false }, nextBefore: 2 },
			{ ...initial, revision: 5, entries: appended.slice(1), live: [userEntry("live:message", "Final live state")], coverage: { ...initial.coverage, complete: false }, nextBefore: 2 },
		]) {
			shared.frames.set("one", frame);
			rebuilt.frames.set("one", structuredClone(frame));
			shared.notify(); rebuilt.notify(); clock.advance(50); otherClock.advance(50); await turn();
			assert.deepEqual(f.ui.render(120), reference.ui.render(120));
		}
		assert.match(visible(f.ui.render(120)), /Appended message/u);
		assert.match(visible(f.ui.render(120)), /Final live state/u);
	} finally { f.ui.dispose(); reference.ui.dispose(); }
});

it("live slot removal finalises a partial card without a history reconciliation", async (t) => {
	const updates = t.mock.method(ToolExecutionComponent.prototype, "updateResult");
	const tail = t.mock.method(ConversationHistory.prototype, "tail");
	const live = liveSource(["one"]);
	const clock = manualClock();
	const initial = conversationFrame({
		entries: [userEntry("1", "Read the file")],
		live: buildLiveEntries({ nestedTools: [{ callId: "outer/call", parentCallId: "outer", parentTaskId: 10, taskId: 11, name: "read", arguments: { path: "file.ts" }, status: "running", output: "partial text" }] }, []),
	});
	live.frames.set("one", initial);
	const f = fixture(120, 40, live.observed, undefined, undefined, theme, undefined, clock);
	try {
		await turn(); f.ui.render(120);
		const tails = tail.mock.callCount();
		const calls = updates.mock.callCount();
		assert.ok(updates.mock.calls.some((call) => call.arguments[1] === true), "the live slot starts a partial card");
		live.frames.set("one", { ...initial, revision: 2, live: [] });
		live.notify(); clock.advance(50); await turn(); f.ui.render(120);
		assert.equal(tail.mock.callCount(), tails);
		assert.ok(updates.mock.calls.slice(calls).some((call) => call.arguments[1] !== true), "removal sends a non-partial result to release renderer timers");
		assert.doesNotMatch(visible(f.ui.render(120)), /file.ts/u);
	} finally { f.ui.dispose(); }
});

it("history navigation invalidates retained history without losing the loaded window", async (t) => {
	const tail = t.mock.method(ConversationHistory.prototype, "tail");
	const live = liveSource(["one"]);
	const clock = manualClock();
	const initial = conversationFrame({ entries: [userEntry("2", "Current message")], nextBefore: 2, coverage: { ...conversationFrame().coverage, complete: false } });
	live.frames.set("one", initial);
	let reads = 0;
	live.observed.earlier = async (_id, before) => {
		reads++;
		assert.equal(before, 2);
		return { entries: [userEntry("1", "Earlier message")], partial: false, revision: "earlier", nextBefore: null, coverage: { ...initial.coverage, complete: true } };
	};
	const f = fixture(120, 40, live.observed, undefined, undefined, theme, undefined, clock);
	try {
		await turn(); f.ui.render(120);
		const before = tail.mock.callCount();
		f.ui.handleInput("\x1b[5~"); await turn();
		assert.equal(reads, 1);
		assert.match(visible(f.ui.render(120)), /Earlier message/u);
		live.frames.set("one", { ...initial, revision: 2 });
		live.notify(); clock.advance(50); await turn();
		assert.equal(tail.mock.callCount(), before + 1);
		assert.match(visible(f.ui.render(120)), /Earlier message/u);
		assert.match(visible(f.ui.render(120)), /Current message/u);
	} finally { f.ui.dispose(); }
});

it("reconnect and selection changes clear retained history references", async (t) => {
	const tail = t.mock.method(ConversationHistory.prototype, "tail");
	const live = liveSource(["one", "two"]);
	const clock = manualClock();
	const initial = conversationFrame({ entries: [userEntry("1", "Retained message")] });
	live.frames.set("one", initial); live.frames.set("two", initial);
	let state: "live" | "unavailable" = "live";
	live.observed.availability = () => ({ state, at: new Date(0).toISOString() });
	const f = fixture(120, 40, live.observed, undefined, undefined, theme, undefined, clock);
	try {
		await turn();
		state = "unavailable"; live.notify(); clock.advance(50); await turn();
		assert.match(visible(f.ui.render(120)), /Connection lost/u);
		const before = tail.mock.callCount();
		state = "live"; live.notify(); clock.advance(50); await turn();
		assert.equal(tail.mock.callCount(), before + 1, "the first reconnected frame reconciles even with the same entries");
		assert.doesNotMatch(visible(f.ui.render(120)), /Connection lost/u);
		assert.match(visible(f.ui.render(120)), /Retained message/u);
		f.ui.handleInput("\x1b[B"); await turn();
		assert.equal(tail.mock.callCount(), before + 2, "another selection does not inherit the retained reference");
	} finally { f.ui.dispose(); }
});
