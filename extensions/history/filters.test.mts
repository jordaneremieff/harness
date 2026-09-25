import assert from "node:assert/strict";
import test from "node:test";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { SessionManager, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { searchHistory, type HistorySource } from "./core.ts";

const assistant = (text: string): AssistantMessage => ({
	role: "assistant",
	content: [{ type: "text", text }],
	api: "openai-completions",
	provider: "synthetic",
	model: "synthetic",
	usage: {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
	stopReason: "stop",
	timestamp: 1,
});
const hits = (result: ReturnType<typeof searchHistory>) =>
	result.matches as { entry: Record<string, unknown>; pointer: string }[];
const ids = (result: ReturnType<typeof searchHistory>) => hits(result).map((hit) => hit.entry.id);

function fixture() {
	const sm = SessionManager.inMemory();
	const user = sm.appendMessage({ role: "user", content: "release choice", timestamp: 1 });
	const compact = sm.appendCompaction("release summary", user, 100);
	const branch = sm.branchWithSummary(compact, "release branch");
	sm.appendCustomEntry("synthetic-state", { text: "release" });
	sm.appendCustomMessageEntry("synthetic-note", "release echo", true);
	sm.appendMessage({
		role: "custom",
		customType: "synthetic-note",
		content: "release echo",
		display: true,
		timestamp: 1,
	});
	sm.appendMessage({ role: "system", content: "release echo", timestamp: 1 });
	sm.appendMessage({
		role: "bashExecution",
		command: "release",
		output: "release",
		exitCode: 1,
		cancelled: false,
		truncated: false,
		timestamp: 1,
	});
	sm.appendMessage(assistant("release echo"));
	sm.appendMessage({
		...assistant("release call"),
		content: [{ type: "toolCall", id: "call", name: "probe", arguments: { query: "release" } }],
		stopReason: "toolUse",
	});
	const result = (toolName: string, isError: boolean) =>
		sm.appendMessage({
			role: "toolResult",
			toolName,
			toolCallId: "call",
			content: [{ type: "text", text: "release result" }],
			isError,
			timestamp: 1,
		});
	const failure = result("probe", true);
	const success = result("probe", false);
	const other = result("Probe", true);
	const missing = result("probe", false);
	const stored = sm.getEntry(missing);
	assert.ok(stored?.type === "message");
	// Malformed current record: the declared required flag is absent.
	Reflect.deleteProperty(stored.message, "isError");
	const edited = sm.appendContextEdit(user, { content: "release replacement" });
	return { sm, user, compact, branch, failure, success, other, missing, edited };
}

test("source selection uses raw entry kinds and roles, not model-facing user conversion", () => {
	const { sm, user, compact, branch } = fixture();
	for (const query of [undefined, "release"]) {
		const users = searchHistory(sm, { query, filter: { source: "user" } });
		assert.deepEqual(ids(users), [user]);
		assert.equal(users.excluded, Number(users.visited) - 1);
		assert.deepEqual(users.filter, { source: "user" });
		const summaries = searchHistory(sm, { query, filter: { source: "summary" } });
		assert.deepEqual(ids(summaries), [branch, compact]);
		assert.equal(hits(summaries)[0].entry.fromId, compact);
		assert.equal(hits(summaries)[1].entry.firstKeptEntryId, user);
	}
	assert.equal(searchHistory(sm, {}).filter, undefined);
	assert.equal(searchHistory(sm, {}).excluded, undefined);
	assert.match(String(searchHistory(sm, { filter: { source: "user" } }).notice), /metadata only/);
});

test("tool filters match exact result names and strictly true stored errors", () => {
	const { sm, failure, success, other, missing } = fixture();
	for (const query of [undefined, "release"]) {
		assert.deepEqual(
			ids(searchHistory(sm, { query, filter: { source: "toolResult", toolName: "probe", errorsOnly: true } })),
			[failure],
		);
		for (const errorsOnly of [undefined, false]) {
			assert.deepEqual(
				ids(searchHistory(sm, { query, filter: { source: "toolResult", toolName: "probe", errorsOnly } })),
				[missing, success, failure],
			);
		}
		assert.deepEqual(ids(searchHistory(sm, { query, filter: { source: "toolResult", errorsOnly: true } })), [
			other,
			failure,
		]);
		assert.deepEqual(ids(searchHistory(sm, { query, filter: { source: "toolResult", toolName: "Probe" } })), [other]);
		assert.deepEqual(ids(searchHistory(sm, { query, filter: { source: "toolResult" } })), [
			missing,
			other,
			success,
			failure,
		]);
	}
});

test("selection precedes metadata and text access but does not bypass visit bounds", () => {
	const { sm, user } = fixture();
	const entry = sm.getLeafEntry();
	assert.ok(entry);
	for (const key of ["message", "summary", "content", "targetId"]) {
		Object.defineProperty(entry, key, {
			get() {
				throw new Error("excluded payload accessed");
			},
		});
	}
	for (const query of [undefined, "release"]) {
		const page = searchHistory(sm, { query, filter: { source: "user" }, maxVisits: 1 });
		assert.equal(page.status, "visit_limit");
		assert.equal(page.visited, 1);
		assert.equal(page.excluded, 1);
		assert.equal(page.scannedBytes, 0);
		assert.equal(page.slotsVisited, 0);
		assert.deepEqual(ids(page), []);
		assert.deepEqual((page.next as Record<string, unknown>).filter, { source: "user" });
		assert.deepEqual(ids(searchHistory(sm, { query, ...(page.next as object) })), [user]);
	}
});

test("filtered continuations retain alternate ancestry and reject a changed session", () => {
	const sm = SessionManager.inMemory();
	const root = sm.appendMessage({ role: "user", content: "release root", timestamp: 1 });
	const left = sm.appendMessage({ role: "user", content: "release left", timestamp: 1 });
	sm.appendCustomMessageEntry("note", "release echo", true);
	const tip = sm.getLeafId();
	const page = searchHistory(sm, { query: "release", filter: { source: "user" }, maxVisits: 1 });
	sm.branch(root);
	sm.appendMessage({ role: "user", content: "release right", timestamp: 1 });
	assert.deepEqual(ids(searchHistory(sm, { query: "release", ...(page.next as object) })), [left, root]);
	assert.deepEqual(ids(searchHistory(sm, { query: "release", filter: { source: "user" }, fromId: tip })), [left, root]);
	assert.throws(() => searchHistory(SessionManager.inMemory(), { ...(page.next as object) }), /Session changed/);
});

test("filtered boundaries preserve gaps, cycles, cancellation, and raw content exclusions", () => {
	const { sm, user } = fixture();
	assert.deepEqual(ids(searchHistory(sm, { query: "replacement", filter: { source: "user" } })), []);
	const checkpoint = sm.appendCompaction("visible summary", user, 100);
	assert.deepEqual(ids(searchHistory(sm, { query: "visible", filter: { source: "summary" } })), [checkpoint]);
	assert.deepEqual(ids(searchHistory(sm, { query: "release echo", filter: { source: "summary" } })), []);
	const entry: SessionEntry = {
		id: "excluded",
		parentId: "absent",
		type: "custom",
		customType: "note",
		timestamp: "2026-01-01",
	};
	const source: HistorySource = {
		getSessionId: () => "s",
		getLeafId: () => entry.id,
		getEntry: (id) => (id === entry.id ? entry : undefined),
	};
	assert.equal(searchHistory(source, { filter: { source: "user" } }).status, "missing_parent");
	assert.equal(searchHistory(source, { fromId: "unknown", filter: { source: "user" } }).status, "unknown_entry");
	entry.parentId = entry.id;
	assert.equal(searchHistory(source, { filter: { source: "user" } }).status, "cycle");
	const controller = new AbortController();
	let calls = 0;
	assert.throws(
		() =>
			searchHistory(
				{
					...source,
					getEntry(id) {
						calls++;
						controller.abort();
						return source.getEntry(id);
					},
				},
				{ filter: { source: "user" } },
				controller.signal,
			),
		/abort/i,
	);
	assert.equal(calls, 1);
});

test("malformed filter inputs and incompatible combinations fail without source access", () => {
	const source: HistorySource = {
		getSessionId: () => {
			throw new Error("source accessed");
		},
		getLeafId: () => null,
		getEntry: () => undefined,
	};
	for (const filter of [
		null,
		[],
		"user",
		{},
		{ source: "assistant" },
		{ source: "User" },
		{ source: "user", toolName: "probe" },
		{ source: "summary", errorsOnly: false },
		{ source: "toolResult", errorsOnly: 1 },
		{ source: "toolResult", toolName: "" },
		{ source: "toolResult", toolName: "x".repeat(257) },
	]) {
		assert.throws(() => searchHistory(source, { filter }), /filter/);
	}
	const { sm, user } = fixture();
	assert.throws(
		() => searchHistory(sm, { query: "release", fromId: user, slot: 1, filter: { source: "summary" } }),
		/Retain the original filter/,
	);
	assert.throws(
		() => searchHistory(sm, { fromId: user, offset: 1, filter: { source: "user" } }),
		/listing does not accept/,
	);
});
