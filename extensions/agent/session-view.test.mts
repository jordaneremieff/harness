import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createBranchSummaryMessage, findCutPoint, prepareCompaction, type AgentMessage, type Entry } from "@earendil-works/pi-agent-core";
import { CURRENT_SESSION_VERSION, type SessionEntry } from "@earendil-works/pi-coding-agent";
import {
	SessionView,
	CUSTOM_MESSAGE_WRAPPER_TYPE,
	type SessionViewFeed,
	type SessionViewIdentity,
	type SessionViewSnapshot,
	type SessionViewValueUpdate,
} from "./session-view.ts";

const identity: SessionViewIdentity = {
	sessionId: "session-1",
	cwd: "/work",
	createdAtMs: 1_700_000_000_000,
	sessionDir: "/store/session-1",
	sessionFile: "/store/session-1/session.jsonl",
};

const BASE_MS = 1_700_000_000_000;

function userMessage(text: string): AgentMessage {
	return { role: "user", content: [{ type: "text", text }] } as AgentMessage;
}

function assistantMessage(text: string): AgentMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		stopReason: "stop",
		provider: "test-provider",
		model: "test-model",
	} as AgentMessage;
}

function messageEntry(id: string, parentId: string | null, seq: number, message: AgentMessage): Extract<Entry, { type: "message" }> {
	return {
		id,
		parentId,
		seq,
		timestamp: BASE_MS + seq,
		type: "message",
		message,
	};
}

function customEntry(id: string, parentId: string | null, seq: number, customType: string, data: unknown): Entry {
	return {
		id,
		parentId,
		seq,
		timestamp: BASE_MS + seq,
		type: "custom",
		customType,
		data,
	} as Entry;
}

function branchSummaryEntry(id: string, parentId: string | null, seq: number, fromId: string | null): Entry {
	return {
		id,
		parentId,
		seq,
		timestamp: BASE_MS + seq,
		type: "branch_summary",
		fromId,
		summary: `summary of ${fromId ?? "root"}`,
		fromHook: false,
	};
}

function compactionEntry(id: string, parentId: string | null, seq: number, retainedTail: AgentMessage[]): Entry {
	return {
		id,
		parentId,
		seq,
		timestamp: BASE_MS + seq,
		type: "compaction",
		summary: "summary of summarized messages",
		retainedTail,
		tokensBefore: 100,
		fromHook: false,
	};
}

interface TestFeed {
	feed: SessionViewFeed;
	snapshot: SessionViewSnapshot;
	emitEntry: (entry: Entry) => void;
	emitValue: (update: SessionViewValueUpdate) => void;
	entryListenerCount: () => number;
}

function testFeed(initialSnapshot: SessionViewSnapshot): TestFeed {
	const entryListeners: Array<(entry: Entry) => void> = [];
	const valueListeners: Array<(update: SessionViewValueUpdate) => void> = [];
	return {
		snapshot: initialSnapshot,
		emitEntry: (entry) => {
			for (const listener of entryListeners) listener(entry);
		},
		emitValue: (update) => {
			for (const listener of valueListeners) listener(update);
		},
		entryListenerCount: () => entryListeners.length,
		feed: {
			load: async () => ({ ...initialSnapshot, entries: [...initialSnapshot.entries] }),
			onEntryAdded: (listener) => {
				entryListeners.push(listener);
				return () => {
					const index = entryListeners.indexOf(listener);
					if (index >= 0) entryListeners.splice(index, 1);
				};
			},
			onValueUpdate: (listener) => {
				valueListeners.push(listener);
				return () => {
					const index = valueListeners.indexOf(listener);
					if (index >= 0) valueListeners.splice(index, 1);
				};
			},
		},
	};
}

async function viewOf(snapshot: SessionViewSnapshot): Promise<{ view: SessionView; test: TestFeed }> {
	const harness = testFeed(snapshot);
	const view = new SessionView(identity, harness.feed);
	await view.initialize();
	return { view, test: harness };
}

function firstKeptEntryIdOf(view: SessionView, id: string): string | undefined {
	const entry = view.getEntry(id);
	return entry?.type === "compaction" ? entry.firstKeptEntryId : undefined;
}

describe("SessionView read surface", () => {
	it("projects identity and empty state", async () => {
		const { view } = await viewOf({ entries: [], labels: [], name: undefined, tipId: null });
		assert.equal(view.getSessionId(), "session-1");
		assert.equal(view.getCwd(), "/work");
		assert.equal(view.getSessionDir(), identity.sessionDir);
		assert.equal(view.getSessionFile(), identity.sessionFile);
		assert.equal(view.getLeafId(), null);
		assert.deepEqual(view.getEntries(), []);
		assert.deepEqual(view.getBranch(), []);
		assert.deepEqual(view.getTree(), []);
		assert.equal(view.getSessionName(), undefined);
	});

	it("projects the ordinary session header from identity", async () => {
		const { view } = await viewOf({ entries: [], labels: [], name: undefined, tipId: null });
		assert.deepEqual(view.getHeader(), {
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: "session-1",
			timestamp: new Date(BASE_MS).toISOString(),
			cwd: "/work",
		});
		const forked = new SessionView(
			{ ...identity, parentSession: "/store/parent/session.jsonl" },
			testFeed({ entries: [], labels: [], name: undefined, tipId: null }).feed,
		);
		assert.equal(forked.getHeader()?.parentSession, "/store/parent/session.jsonl");
	});

	it("ingests entries with exact ids, parents, and timestamps, keeping the snapshot tip as leaf", async () => {
		const { view } = await viewOf({
			entries: [messageEntry("a", null, 1, userMessage("first")), messageEntry("b", "a", 2, userMessage("second"))],
			labels: [],
			name: undefined,
			tipId: "b",
		});
		const first = view.getEntry("a");
		const second = view.getEntry("b");
		assert.equal(first?.type, "message");
		assert.equal(second?.type, "message");
		assert.equal(first?.parentId, null);
		assert.equal(second?.parentId, "a");
		assert.equal(first?.timestamp, new Date(BASE_MS + 1).toISOString());
		assert.equal(view.getLeafId(), "b");
		assert.equal(view.getLeafEntry()?.id, "b");
		assert.deepEqual(
			view.getEntries().map((entry) => entry.id),
			["a", "b"],
		);
		assert.deepEqual(
			view.getBranch().map((entry) => entry.id),
			["a", "b"],
		);
		const tree = view.getTree();
		assert.equal(tree.length, 1);
		assert.equal(tree[0].entry.id, "a");
		assert.equal(tree[0].children[0].entry.id, "b");
	});

	it("receives live entry additions after initialize and advances the leaf", async () => {
		const { view, test } = await viewOf({
			entries: [messageEntry("a", null, 1, userMessage("first"))],
			labels: [],
			name: undefined,
			tipId: "a",
		});
		test.emitEntry(customEntry("c", "a", 2, "agent.test", { n: 1 }));
		assert.equal(view.getLeafId(), "c");
		const entry = view.getEntry("c");
		assert.equal(entry?.type, "custom");
		assert.equal(entry?.type === "custom" ? entry.customType : undefined, "agent.test");
	});

	it("keeps entries and value updates committed while the snapshot loads (no race loss)", async () => {
		const a = messageEntry("a", null, 1, userMessage("first"));
		const duringLoad = messageEntry("b", "a", 2, userMessage("during load"));
		const afterSnapshot = messageEntry("c", "b", 3, userMessage("after snapshot"));
		const entryListeners: Array<(entry: Entry) => void> = [];
		const valueListeners: Array<(update: SessionViewValueUpdate) => void> = [];
		const feed: SessionViewFeed = {
			load: async () => {
				// Committed after the snapshot was read but before it is ingested.
				for (const listener of entryListeners) listener(duringLoad);
				for (const listener of valueListeners) listener({ kind: "name", name: "during-load-name" });
				return { entries: [a], labels: [], name: "snapshot-name", tipId: "a" };
			},
			onEntryAdded: (listener) => {
				entryListeners.push(listener);
				return () => {
					const index = entryListeners.indexOf(listener);
					if (index >= 0) entryListeners.splice(index, 1);
				};
			},
			onValueUpdate: (listener) => {
				valueListeners.push(listener);
				return () => {
					const index = valueListeners.indexOf(listener);
					if (index >= 0) valueListeners.splice(index, 1);
				};
			},
		};
		const view = new SessionView(identity, feed);
		await view.initialize();
		// The in-flight entry arrives through the buffer; a duplicate copy
		// through the snapshot would be deduplicated by entry id.
		assert.deepEqual(
			view.getEntries().map((entry) => entry.id),
			["a", "b"],
		);
		// The buffered entry was committed after the snapshot read, so the
		// durable tip advanced past the snapshot tip.
		assert.equal(view.getLeafId(), "b");
		// A value update whose durable write happened after the snapshot read wins.
		assert.equal(view.getSessionName(), "during-load-name");
		// Post-initialize additions flow through the live subscription.
		for (const listener of entryListeners) listener(afterSnapshot);
		assert.equal(view.getEntry("c")?.id, "c");
	});

	it("restores labels and session name from durable session values on reopen", async () => {
		const { view } = await viewOf({
			entries: [messageEntry("a", null, 1, userMessage("first")), messageEntry("b", "a", 2, userMessage("second"))],
			labels: [{ targetId: "b", label: "checkpoint" }],
			name: "research",
			tipId: "b",
		});
		assert.equal(view.getLabel("b"), "checkpoint");
		assert.equal(view.getLabel("a"), undefined);
		assert.equal(view.getSessionName(), "research");
		const tree = view.getTree();
		assert.equal(tree[0].children[0].label, "checkpoint");
		assert.equal(tree[0].label, undefined);
	});

	it("applies live session value updates for labels and names", async () => {
		const { view, test } = await viewOf({
			entries: [messageEntry("a", null, 1, userMessage("first"))],
			labels: [],
			name: undefined,
			tipId: "a",
		});
		test.emitValue({ kind: "label", targetId: "a", label: "mark" });
		assert.equal(view.getLabel("a"), "mark");
		test.emitValue({ kind: "label", targetId: "a", label: undefined });
		assert.equal(view.getLabel("a"), undefined);
		test.emitValue({ kind: "label", targetId: "a", label: "" });
		assert.equal(view.getLabel("a"), undefined);
		test.emitValue({ kind: "name", name: "renamed" });
		assert.equal(view.getSessionName(), "renamed");
		test.emitValue({ kind: "name", name: undefined });
		assert.equal(view.getSessionName(), undefined);
	});

	it("warms label and name reads synchronously through the write actions", async () => {
		const { view } = await viewOf({
			entries: [messageEntry("a", null, 1, userMessage("first"))],
			labels: [],
			name: undefined,
			tipId: "a",
		});
		view.markLabel("a", "now");
		assert.equal(view.getLabel("a"), "now");
		view.markLabel("a", undefined);
		assert.equal(view.getLabel("a"), undefined);
		view.markName("sync-name");
		assert.equal(view.getSessionName(), "sync-name");
	});

	it("preserves custom entries with exact custom type and data", async () => {
		const data = { provider: "anthropic", modelId: "claude-sonnet-4-5", thinkingLevel: "high" };
		const { view } = await viewOf({
			entries: [customEntry("meta-1", null, 1, "agent.meta", data)],
			labels: [],
			name: undefined,
			tipId: "meta-1",
		});
		const entry = view.getEntry("meta-1");
		assert.equal(entry?.type, "custom");
		assert.deepEqual(entry?.type === "custom" ? entry.data : undefined, data);
		assert.equal(entry?.type === "custom" ? entry.customType : undefined, "agent.meta");
	});

	it("derives firstKeptEntryId from the retained tail and keeps kept entries in context", async () => {
		const a = messageEntry("a", null, 1, userMessage("old-1"));
		const b = messageEntry("b", "a", 2, userMessage("kept-1"));
		const c = messageEntry("c", "b", 3, userMessage("kept-2"));
		const compaction = compactionEntry("compact", "c", 4, [b.message, c.message]);
		const d = messageEntry("d", "compact", 5, userMessage("after"));
		const { view } = await viewOf({
			entries: [a, b, c, compaction, d],
			labels: [],
			name: undefined,
			tipId: "d",
		});
		const projected = view.getEntry("compact");
		assert.equal(projected?.type, "compaction");
		assert.equal(firstKeptEntryIdOf(view, "compact"), "b");
		assert.deepEqual(
			view.buildContextEntries().map((entry) => entry.id),
			["compact", "b", "c", "d"],
		);
		// The branch read surface keeps the full path regardless of compaction.
		assert.deepEqual(
			view.getBranch().map((entry) => entry.id),
			["a", "b", "c", "compact", "d"],
		);
	});

	it("exposes wrapped custom messages as ordinary custom_message entries", async () => {
		const wrapper = customEntry("msg-1", "a", 3, CUSTOM_MESSAGE_WRAPPER_TYPE, {
			customType: "acme.note",
			content: [{ type: "text", text: "injected context" }],
			display: true,
			details: { origin: "acme" },
		});
		const { view } = await viewOf({
			entries: [messageEntry("a", null, 1, userMessage("first")), wrapper],
			labels: [],
			name: undefined,
			tipId: "msg-1",
		});
		const entry = view.getEntry("msg-1");
		assert.equal(entry?.type, "custom_message");
		if (entry?.type === "custom_message") {
			assert.equal(entry.customType, "acme.note");
			assert.deepEqual(entry.content, [{ type: "text", text: "injected context" }]);
			assert.equal(entry.display, true);
			assert.deepEqual(entry.details, { origin: "acme" });
		}
		assert.equal(entry?.parentId, "a");
		assert.equal(entry?.timestamp, new Date(BASE_MS + 3).toISOString());
		assert.ok(view.getEntries().some((candidate) => candidate.type === "custom_message"));
	});

	it("keeps malformed custom message wrappers as plain custom entries", async () => {
		const noData = customEntry("bad-1", null, 1, CUSTOM_MESSAGE_WRAPPER_TYPE, undefined);
		const noOriginalType = customEntry("bad-2", "bad-1", 2, CUSTOM_MESSAGE_WRAPPER_TYPE, {
			content: "text only",
			display: true,
		});
		const noContent = customEntry("bad-3", "bad-2", 3, CUSTOM_MESSAGE_WRAPPER_TYPE, {
			customType: "acme.note",
			display: false,
		});
		const { view } = await viewOf({
			entries: [noData, noOriginalType, noContent],
			labels: [],
			name: undefined,
			tipId: "bad-3",
		});
		for (const id of ["bad-1", "bad-2", "bad-3"]) {
			const entry = view.getEntry(id);
			assert.equal(entry?.type, "custom", id);
			assert.equal(entry?.type === "custom" ? entry.customType : undefined, CUSTOM_MESSAGE_WRAPPER_TYPE, id);
		}
	});

	it("projects worker history entries as the ordinary typed entries those mutations produce", async () => {
		const nameChange = customEntry("h1", null, 1, "agent.name_change", { name: "renamed" });
		const labelChange = customEntry("h2", "h1", 2, "agent.label_change", { targetId: "h1", label: "mark" });
		const { view } = await viewOf({
			entries: [nameChange, labelChange],
			labels: [{ targetId: "h1", label: "mark" }],
			name: "renamed",
			tipId: "h2",
		});
		const nameEntry = view.getEntry("h1");
		assert.equal(nameEntry?.type, "session_info");
		assert.equal(nameEntry?.type === "session_info" ? nameEntry.name : undefined, "renamed");
		const labelEntry = view.getEntry("h2");
		assert.equal(labelEntry?.type, "label");
		assert.deepEqual(labelEntry?.type === "label" ? labelEntry.targetId : undefined, "h1");
		assert.deepEqual(labelEntry?.type === "label" ? labelEntry.label : undefined, "mark");
		// Real harness ids are preserved through the projection.
		assert.equal(view.getLabel("h1"), "mark");
		assert.equal(view.getSessionName(), "renamed");
	});

	it("keeps malformed history payloads as plain custom entries", async () => {
		const malformed = customEntry("h9", null, 9, "agent.model_change", { provider: 42 });
		const { view } = await viewOf({
			entries: [malformed],
			labels: [],
			name: undefined,
			tipId: "h9",
		});
		const entry = view.getEntry("h9");
		assert.equal(entry?.type, "custom");
	});

	it("derives the kept entry from a real harness compaction preparation", async () => {
		// Alternating turns the way the harness reduces them.
		const path: Extract<Entry, { type: "message" }>[] = [];
		for (let turn = 0; turn < 6; turn += 1) {
			path.push(
				messageEntry(
					`u${turn}`,
					turn === 0 ? null : `a${turn - 1}`,
					turn * 2 + 1,
					userMessage(`request ${turn} with enough body text to carry a token estimate`),
				),
				messageEntry(
					`a${turn}`,
					`u${turn}`,
					turn * 2 + 2,
					assistantMessage(`response ${turn} with further body text so the heuristic counts tokens`),
				),
			);
		}
		const settings = { enabled: true, reserveTokens: 64, keepRecentTokens: 64 };
		const prepared = prepareCompaction(path, settings);
		assert.ok(prepared.ok && prepared.value, "the real preparation produces a compaction plan");
		const cut = findCutPoint(path, 0, path.length, settings.keepRecentTokens);
		assert.ok(cut.firstKeptEntryIndex > 0, "the real cut lands inside the path");
		// The harness commits the compaction entry as a child of the branch tip
		// and carries the prepared retained tail verbatim.
		const compaction = compactionEntry(
			"compact-real",
			path[path.length - 1].id,
			99,
			prepared.value.retainedTail,
		);
		const { view } = await viewOf({
			entries: [...path, compaction],
			labels: [],
			name: undefined,
			tipId: "compact-real",
		});
		assert.equal(firstKeptEntryIdOf(view, "compact-real"), path[cut.firstKeptEntryIndex].id);
		assert.deepEqual(
			view.buildContextEntries().map((entry) => entry.id),
			["compact-real", ...path.slice(cut.firstKeptEntryIndex).map((entry) => entry.id)],
		);
	});

	it("matches synthesized branch summary messages inside the retained tail", async () => {
		const a = messageEntry("a", null, 1, userMessage("before summary"));
		const summary = branchSummaryEntry("s", "a", 2, "a");
		const tailMessage = createBranchSummaryMessage("summary of a", "a", BASE_MS + 2);
		const compaction = compactionEntry("compact", "s", 3, [tailMessage]);
		const { view } = await viewOf({
			entries: [a, summary, compaction],
			labels: [],
			name: undefined,
			tipId: "compact",
		});
		assert.equal(firstKeptEntryIdOf(view, "compact"), "s");
		assert.deepEqual(
			view.buildContextEntries().map((entry) => entry.id),
			["compact", "s"],
		);
	});

	it("uses the no-kept representation when the tail is empty or unmatched", async () => {
		const a = messageEntry("a", null, 1, userMessage("old"));
		const emptyTail = compactionEntry("compact-empty", "a", 2, []);
		const postEmpty = messageEntry("d1", "compact-empty", 3, userMessage("after"));
		const { view } = await viewOf({
			entries: [a, emptyTail, postEmpty],
			labels: [],
			name: undefined,
			tipId: "d1",
		});
		assert.equal(firstKeptEntryIdOf(view, "compact-empty"), "");
		assert.deepEqual(
			view.buildContextEntries().map((entry) => entry.id),
			["compact-empty", "d1"],
		);

		const alien = messageEntry("alien", null, 99, userMessage("not on this branch"));
		const unmatchedTail = compactionEntry("compact-bad", "a", 2, [alien.message]);
		const other = await viewOf({
			entries: [a, unmatchedTail],
			labels: [],
			name: undefined,
			tipId: "compact-bad",
		});
		assert.equal(firstKeptEntryIdOf(other.view, "compact-bad"), "");
	});

	it("follows navigated tips including the reset-leaf state", async () => {
		const a = messageEntry("a", null, 1, userMessage("root"));
		const b = messageEntry("b", "a", 2, userMessage("child"));
		const c = messageEntry("c", "b", 3, userMessage("grandchild"));
		const { view, test } = await viewOf({ entries: [a, b, c], labels: [], name: undefined, tipId: "c" });
		test.emitEntry(messageEntry("d", "c", 4, userMessage("live")));
		assert.deepEqual(
			view.getBranch().map((entry) => entry.id),
			["a", "b", "c", "d"],
		);

		view.setLeafFromHarness("b");
		assert.equal(view.getLeafId(), "b");
		assert.deepEqual(
			view.getBranch().map((entry) => entry.id),
			["a", "b"],
		);
		assert.deepEqual(
			view.buildContextEntries().map((entry) => entry.id),
			["a", "b"],
		);

		view.setLeafFromHarness(null);
		assert.equal(view.getLeafId(), null);
		assert.deepEqual(view.getBranch(), []);
		assert.deepEqual(view.buildContextEntries(), []);
		assert.equal(view.getLeafEntry(), undefined);
	});

	it("resolves an unknown tip like the ordinary manager: strict for getBranch, last entry for context", async () => {
		const a = messageEntry("a", null, 1, userMessage("root"));
		const b = messageEntry("b", "a", 2, userMessage("child"));
		const { view } = await viewOf({ entries: [a, b], labels: [], name: undefined, tipId: "b" });
		view.setLeafFromHarness("missing");
		assert.equal(view.getLeafId(), "missing");
		assert.deepEqual(view.getBranch(), []);
		assert.deepEqual(
			view.buildContextEntries().map((entry) => entry.id),
			["a", "b"],
		);
	});

	it("is idempotent: initialize after live updates keeps current state", async () => {
		const harness = testFeed({
			entries: [messageEntry("a", null, 1, userMessage("first"))],
			labels: [],
			name: "initial",
			tipId: "a",
		});
		const view = new SessionView(identity, harness.feed);
		await view.initialize();
		view.markName("live");
		await view.initialize();
		assert.equal(view.getSessionName(), "live");
		assert.equal(view.getEntry("a")?.id, "a");
	});

	it("types projected entries as ordinary session entries", async () => {
		const { view } = await viewOf({
			entries: [messageEntry("a", null, 1, userMessage("first")), customEntry("m", "a", 2, "agent.meta", {})],
			labels: [],
			name: undefined,
			tipId: "m",
		});
		const entries: SessionEntry[] = view.getEntries();
		assert.equal(entries.length, 2);
		const branch: SessionEntry[] = view.getBranch();
		assert.equal(branch.length, 2);
		assert.equal(view.getEntry("m")?.type, "custom");
	});
});
