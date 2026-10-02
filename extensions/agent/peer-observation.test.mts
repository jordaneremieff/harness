import assert from "node:assert/strict";
import { it } from "node:test";
import type { ConversationId } from "@earendil-works/pi-durable";
import type { AgentConversationPage, AgentConversationSummary } from "./dashboard-types.ts";
import type { ConversationSnapshotPage } from "./durable-observation.ts";
import type { ConversationFrame, ObservationFrame, TasksFrame } from "./live-frames.ts";
import { createPeerObservationSource, type PeerObservationHost } from "./peer-observation.ts";

const STORAGE = "11111111-2222-4333-8444-555555555555";

function summary(id: string): AgentConversationSummary {
	return { id, storageId: id, cwd: "/work/agent", modifiedAt: 1, owner: "here", state: "idle", cost: 0, partial: false };
}

function page(rows: readonly AgentConversationSummary[]): AgentConversationPage {
	return { rows, coverage: { complete: true, storagesVisited: 1, skipped: 0, omitted: 0, nextCursor: null }, observedAt: new Date(0).toISOString() };
}

function snapshotPage(revision: string, texts: readonly string[]): ConversationSnapshotPage {
	return {
		entries: texts.map((text, index) => ({ id: `${index}`, kind: "pi.user", model: [{ role: "user", content: text, timestamp: index }] })),
		partial: false,
		revision,
		nextBefore: null,
		coverage: { complete: true, entries: texts.length, bytes: 0, hiddenExcluded: 0, entryLimitReached: false, byteLimitReached: false },
	};
}

function conversationFrame(revision: number, texts: readonly string[]): ConversationFrame {
	const snapshot = snapshotPage(`r${revision}`, texts);
	return {
		scope: "conversation",
		storageId: STORAGE,
		conversationId: 1 as ConversationId,
		revision,
		observedAt: new Date(0).toISOString(),
		entries: snapshot.entries,
		nextBefore: null,
		live: [],
		status: { conversationId: 1 as ConversationId, identity: STORAGE, busy: false, lastText: texts[texts.length - 1] ?? null, live: null, inbox: null, agent: { thinkingLevel: "off", extensions: [], tools: [] }, tasks: [], submissions: [], usage: undefined },
		coverage: snapshot.coverage,
	};
}

function tasksFrame(revision: number): TasksFrame {
	return { scope: "tasks", storageId: STORAGE, revision, observedAt: new Date(0).toISOString(), tasks: [], labels: [], coverage: { complete: true, live: true } };
}

it("serves the live frame to the window and notifies on each pushed frame", async () => {
	const emissions: Array<(frame: ObservationFrame, fresh: boolean) => void> = [];
	const released: number[] = [];
	const host: PeerObservationHost = {
		list: async () => page([summary(STORAGE)]),
		snapshot: async () => snapshotPage("cold", ["cold entry"]),
		observeLive: async (_id, _scope, listener) => {
			emissions.push(listener);
			return () => released.push(1);
		},
	};
	const source = createPeerObservationSource(host);
	let notified = 0;
	if (!source.subscribe) assert.fail("the source must publish change notifications");
	const unsubscribe = source.subscribe(() => {
		notified++;
	});
	const first = await source.snapshot(STORAGE);
	assert.equal(first.revision, "cold", "without a live frame the source serves the manager snapshot");
	assert.equal(emissions.length, 1, "reading the agent opens one host observation");
	emissions[0]?.(conversationFrame(3, ["live entry"]), true);
	assert.equal(notified, 1);
	assert.equal(source.frame(STORAGE)?.revision, 3);
	const second = await source.snapshot(STORAGE);
	assert.equal(second.revision, "r3", "the live frame replaces the cold reading");
	assert.equal(source.live(STORAGE), true);
	unsubscribe();
	await new Promise((resolve) => setTimeout(resolve, 0));
	assert.equal(released.length, 1, "the last unsubscribe releases the host observation");
	assert.equal(source.live(STORAGE), false);
});

it("continues earlier pages through the host and reports cold tasks explicitly", async () => {
	const calls: Array<{ id: string; before?: number }> = [];
	const host: PeerObservationHost = {
		list: async () => page([]),
		snapshot: async (id, params) => {
			calls.push({ id, ...(params?.before === undefined ? {} : { before: params.before }) });
			return snapshotPage("older", ["older entry"]);
		},
		observeLive: async () => undefined,
	};
	const source = createPeerObservationSource(host);
	const earlier = await source.earlier(STORAGE, 7);
	assert.equal(earlier.revision, "older");
	assert.deepEqual(calls, [{ id: STORAGE, before: 7 }], "the earlier read carries the page anchor");
	const tasks = await source.tasks(STORAGE);
	assert.equal(tasks.coverage.live, false, "a storage with no live host reports no live tasks");
	assert.equal(tasks.tasks.length, 0);
	assert.equal(await source.frame(STORAGE), undefined);
});

it("pushes task frames through the same observation subscription", async () => {
	let taskListener: ((frame: ObservationFrame, fresh: boolean) => void) | undefined;
	const host: PeerObservationHost = {
		list: async () => page([]),
		snapshot: async () => snapshotPage("cold", []),
		observeLive: async (_id, scope, listener) => {
			if (scope === "tasks") taskListener = listener;
			return () => {};
		},
	};
	const source = createPeerObservationSource(host);
	let notified = 0;
	if (!source.subscribe) assert.fail("the source must publish change notifications");
	const unsubscribe = source.subscribe(() => {
		notified++;
	});
	const cold = await source.tasks(STORAGE);
	assert.equal(cold.coverage.live, false);
	taskListener?.(tasksFrame(4), true);
	assert.equal(notified, 1);
	const live = await source.tasks(STORAGE);
	assert.equal(live.revision, 4);
	assert.equal(live.coverage.live, true);
	unsubscribe();
});
