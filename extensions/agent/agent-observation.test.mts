import assert from "node:assert/strict";
import { it } from "node:test";
import { createAgentObservationSource, type AgentObservationHost } from "./agent-observation.ts";
import type { ObservationFrame } from "./live-frames.ts";
import { page, row, turn } from "./dashboard-test-fixture.mts";
function fixture() {
	const listeners = new Map<
		string,
		(frame: ObservationFrame | undefined, fresh: boolean, state?: "live" | "unavailable") => void
	>();
	const closed: string[] = [];
	let rosterListener = () => {};
	const snapshot = {
		entries: [],
		partial: true,
		revision: "cold",
		nextBefore: 7,
		coverage: {
			complete: false,
			entries: 0,
			bytes: 0,
			hiddenExcluded: 0,
			entryLimitReached: true,
			byteLimitReached: false,
		},
	};
	const host: AgentObservationHost = {
		list: async () => page([row()]),
		snapshot: async () => snapshot,
		observeLive: async (id, scope, listener) => {
			listeners.set(`${id}:${scope}`, listener);
			return () => {
				closed.push(`${id}:${scope}`);
				listeners.delete(`${id}:${scope}`);
			};
		},
		subscribeRoster: (listener) => {
			rosterListener = listener;
			return () => {
				rosterListener = () => {};
			};
		},
	};
	return { host, listeners, closed, snapshot, roster: () => rosterListener() };
}
it("only the selected conversation remains watched and cold reads keep continuation", async () => {
	const f = fixture();
	const source = createAgentObservationSource(f.host);
	const off = source.subscribe(() => {});
	source.select("one");
	await turn();
	assert.equal((await source.snapshot("one")).nextBefore, 7);
	source.select("two");
	await turn();
	assert.deepEqual(f.closed, ["one:conversation"]);
	assert.deepEqual([...f.listeners.keys()], ["two:conversation"]);
	off();
	assert.deepEqual(f.closed, ["one:conversation", "two:conversation"]);
});
it("a delayed attach after close releases its handle", async () => {
	const f = fixture();
	let resolve!: (off: () => void) => void;
	let closed = 0;
	f.host.observeLive = () =>
		new Promise((done) => {
			resolve = done;
		});
	const source = createAgentObservationSource(f.host);
	const off = source.subscribe(() => {});
	source.select("one");
	off();
	resolve(() => {
		closed++;
	});
	await turn();
	assert.equal(closed, 1);
});
it("Tasks acquires one storage scope and releases it separately from conversation observation", async () => {
	const f = fixture();
	const source = createAgentObservationSource(f.host);
	const off = source.subscribe(() => {});
	source.select("00000000-0000-4000-8000-000000000001:1");
	await source.tasks("00000000-0000-4000-8000-000000000001:1");
	await turn();
	source.releaseTasks();
	assert.ok(f.closed.includes("00000000-0000-4000-8000-000000000001:tasks"));
	assert.ok(f.listeners.has("00000000-0000-4000-8000-000000000001:1:conversation"));
	off();
});
it("roster notifications are distinct from frame changes and repeated revisions do not notify", async () => {
	const f = fixture();
	const source = createAgentObservationSource(f.host);
	let frames = 0;
	let roster = 0;
	const off = source.subscribe(() => {
		frames++;
	});
	const rosterOff = source.subscribeRoster(() => {
		roster++;
	});
	source.select("one");
	await turn();
	f.roster();
	assert.equal(roster, 1);
	assert.equal(frames, 0);
	const listener = f.listeners.get("one:conversation");
	assert.ok(listener);
	listener(undefined, false, "unavailable");
	assert.equal(source.availability("one")?.state, "unavailable");
	assert.equal(frames, 1);
	rosterOff();
	off();
});
