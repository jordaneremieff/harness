import assert from "node:assert/strict";
import test from "node:test";
import {
	SessionManager,
	type ExtensionAPI,
	type ExtensionContext,
	type SessionEntry,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { LIMITS, readHistory, searchHistory, toolResult, type HistorySource } from "./core.ts";
import history from "./index.ts";

type Result = ReturnType<typeof searchHistory>;
function matches(result: Result) {
	return result.matches as { entry: Record<string, unknown>; pointer: string; offset: number; excerpt: string }[];
}
function next(result: Result) {
	return result.next as Record<string, unknown>;
}
function user(sm: SessionManager, content: string) {
	return sm.appendMessage({ role: "user", content, timestamp: 1 });
}
function source(entries: SessionEntry[], leaf = entries.at(-1)?.id ?? null) {
	const map = new Map(entries.map((entry) => [entry.id, entry]));
	let calls = 0;
	return {
		getSessionId: () => "synthetic-session",
		getLeafId: () => leaf,
		getEntry: (id: string) => {
			calls++;
			return map.get(id);
		},
		calls: () => calls,
	};
}
function raw(id: string, parentId: string | null, text = "sample"): Extract<SessionEntry, { type: "message" }> {
	return {
		id,
		parentId,
		timestamp: "2026-01-01T00:00:00Z",
		type: "message",
		message: { role: "user", content: text, timestamp: 1 },
	};
}

test("real session search retains raw evidence across compaction and branch changes", () => {
	const sm = SessionManager.inMemory();
	const original = user(sm, "decision amber raw detail");
	const kept = user(sm, "recent cyan");
	const compact = sm.appendCompaction("summary amber", kept, 1000);
	const before = JSON.stringify(sm.getEntries());
	const found = searchHistory(sm, { query: "amber" });
	assert.equal(found.status, "ancestry_exhausted");
	assert.deepEqual(
		matches(found).map((m) => m.entry.id),
		[compact, original],
	);
	assert.equal(matches(found)[0].entry.summaryKind, "compaction");
	assert.equal(matches(found)[0].entry.firstKeptEntryId, kept);
	assert.equal(matches(found)[1].entry.role, "user");
	assert.equal(JSON.stringify(sm.getEntries()), before);
	const summary = sm.branchWithSummary(original, "abandoned route");
	user(sm, "new route");
	const listing = searchHistory(sm, {});
	assert.equal(matches(listing).find((m) => m.entry.id === summary)?.entry.fromId, compact);
	assert.equal(matches(searchHistory(sm, { query: "cyan" })).length, 0);
	assert.equal(matches(searchHistory(sm, { query: "cyan", fromId: compact }))[0].entry.id, kept);
	assert.equal(readHistory(sm, { entryId: kept, pointer: "/message/content" }).membership, "not_checked");
	assert.equal(readHistory(sm, { entryId: kept, pointer: "/message/content" }).text, "recent cyan");
});

test("stateless visit continuations stay on the selected ancestry after a branch switch", () => {
	const sm = SessionManager.inMemory();
	const root = user(sm, "root choice");
	const left = user(sm, "left choice");
	user(sm, "tip choice");
	const first = searchHistory(sm, { query: "choice", maxVisits: 1 });
	assert.equal(first.status, "visit_limit");
	assert.equal(next(first).fromId, left);
	sm.branch(root);
	user(sm, "right choice");
	const rest = searchHistory(sm, { query: "choice", ...next(first) });
	assert.deepEqual(
		matches(rest).map((m) => m.entry.id),
		[left, root],
	);
	assert.equal(rest.currentLeafId, sm.getLeafId());
	assert.throws(() => searchHistory(SessionManager.inMemory(), { query: "choice", ...next(first) }), /Session changed/);
	assert.throws(
		() => readHistory(SessionManager.inMemory(), { entryId: root, sessionId: sm.getSessionId() }),
		/Session changed/,
	);
});

test("absence, unknown IDs, broken parents, cycles and malformed identities remain distinct", () => {
	assert.equal(searchHistory(source([]), { query: "x" }).status, "ancestry_exhausted");
	assert.equal(searchHistory(source([]), { query: "x", fromId: "missing" }).status, "unknown_entry");
	assert.equal(readHistory(source([]), { entryId: "missing" }).status, "unknown_entry");
	assert.equal(searchHistory(source([raw("a", "missing")]), { query: "x" }).status, "missing_parent");
	assert.equal(searchHistory(source([raw("a", "b"), raw("b", "a")]), { query: "x" }).status, "cycle");
	for (const result of [
		searchHistory(source([]), { fromId: "missing" }),
		searchHistory(source([raw("a", "missing")]), {}),
		searchHistory(source([raw("a", "b"), raw("b", "a")]), {}),
	]) {
		assert.equal(result.next, null);
		assert.ok(result.gap);
	}
	assert.throws(
		() => searchHistory({ getSessionId: () => "s", getLeafId: () => "a", getEntry: () => raw("b", null) }, {}),
		/identity/,
	);
	assert.throws(
		() => searchHistory(source([{ ...raw("a", null), parentId: undefined } as unknown as SessionEntry]), {}),
		/parentId/,
	);
});

test("entry visits, slot visits and text scan bytes have independent hard caps", () => {
	const entries = Array.from({ length: 200 }, (_, i) => raw(String(i), i ? String(i - 1) : null));
	const sm = source(entries);
	const result = searchHistory(sm, { query: "absent" });
	assert.ok(Number(result.visited) <= LIMITS.visits);
	assert.ok(Number(result.slotsVisited) <= LIMITS.slots);
	assert.ok(sm.calls() <= LIMITS.visits);
	const listing = searchHistory(source(entries), { maxMatches: 20, maxVisits: 2 });
	assert.equal(listing.status, "visit_limit");
	assert.equal(listing.visited, 2);
	const long = source([raw("long", null, "x".repeat(1000000))]);
	const scan = searchHistory(long, { query: "absent", maxScanBytes: 2048 });
	assert.equal(scan.status, "scan_limit");
	assert.equal(scan.scannedBytes, 2048);
	assert.ok(Number(next(scan).offset) > 0);
	const blocks = raw("blocks", null);
	blocks.message = {
		role: "user",
		content: Array.from({ length: 1000 }, () => ({ type: "text", text: "" })),
		timestamp: 1,
	};
	const limited = searchHistory(source([blocks]), { query: "absent" });
	assert.equal(limited.status, "slot_limit");
	assert.equal(limited.slotsVisited, LIMITS.slots);
});

test("scan continuation retains matches across chunk boundaries without duplicates", () => {
	const text = `${"a".repeat(2046)}needle${"b".repeat(2500)}needle`;
	const sm = source([raw("a", null, text)]);
	let result = searchHistory(sm, { query: "needle", maxScanBytes: 2048 });
	const offsets = matches(result).map((m) => m.offset);
	for (let i = 0; result.next !== null && i < 10; i++) {
		result = searchHistory(sm, { query: "needle", maxScanBytes: 2048, ...next(result) });
		offsets.push(...matches(result).map((m) => m.offset));
	}
	assert.equal(result.status, "ancestry_exhausted");
	assert.deepEqual(offsets, [2046, 4552]);
});

test("literal queries and match continuations preserve exact offsets", () => {
	const sm = source([raw("a", null, "A.* aaa .* aaa")]);
	const literal = searchHistory(sm, { query: ".*" });
	assert.deepEqual(
		matches(literal).map((m) => m.offset),
		[1, 8],
	);
	assert.equal(matches(searchHistory(sm, { query: "a.*" })).length, 0);
	let result = searchHistory(sm, { query: "aa", maxMatches: 1 });
	const offsets: number[] = [];
	for (let i = 0; i < 10; i++) {
		offsets.push(...matches(result).map((m) => m.offset));
		if (result.next === null) break;
		result = searchHistory(sm, { query: "aa", maxMatches: 1, ...next(result) });
	}
	assert.deepEqual(offsets, [4, 5, 11, 12]);
});

test("JSON-pointer reads preserve Unicode, controls, nonzero offsets and exact provenance", () => {
	const text = "A😀é\n\u001b\u0085Z";
	const sm = source([raw("a", null, text)]);
	const first = readHistory(sm, { entryId: "a", pointer: "/message/content", offset: 1, maxBytes: 4 });
	assert.equal(first.text, "😀");
	assert.equal(first.offset, 1);
	assert.equal(first.endOffset, 3);
	const second = readHistory(sm, { ...next(first) });
	assert.equal(second.text, text.slice(3));
	assert.equal(second.totalCodeUnits, text.length);
	assert.throws(() => readHistory(sm, { entryId: "a", pointer: "/message/content", offset: 2 }), /Unicode boundary/);
	assert.throws(() => readHistory(sm, { entryId: "a", pointer: "/message/content", offset: 99 }), /within the string/);
	const wire = toolResult(second).content[0].text;
	assert.ok(!wire.includes("\u001b"));
	assert.ok(!wire.includes("\u0085"));
	assert.equal(JSON.parse(wire).text, text.slice(3));
	assert.equal(
		JSON.parse(
			toolResult(readHistory(source([raw("b", null, "\ud800")]), { entryId: "b", pointer: "/message/content" }))
				.content[0].text,
		).text,
		"\ud800",
	);
});

test("control-heavy output fits the complete wire JSON cap and has useful continuation", () => {
	const sm = source([raw("a", null, "\u0001".repeat(100000))]);
	const read = readHistory(sm, { entryId: "a", pointer: "/message/content", maxOutputBytes: 4096 });
	assert.ok(Buffer.byteLength(JSON.stringify(toolResult(read))) <= 4096);
	assert.ok(Number(next(read).offset) > 0);
	const search = searchHistory(sm, { query: "\u0001", maxOutputBytes: 4096 });
	assert.ok(Buffer.byteLength(JSON.stringify(toolResult(search))) <= 4096);
	assert.equal(search.status, "output_limit");
	assert.ok(search.next);
	assert.ok(matches(search).length > 0);
	assert.ok(Number(next(search).offset) > 0);
	const more = searchHistory(sm, { query: "\u0001", maxOutputBytes: 4096, ...next(search) });
	assert.ok(matches(more)[0].offset > matches(search)[0].offset);
});

test("manifests and opaque fields avoid enumeration, getters, toJSON and large payload serialization", () => {
	const sm = SessionManager.inMemory();
	let enumerated = false;
	const details = new Proxy(
		{
			result: "exact nested value",
			data: "ordinary tool data",
			toJSON() {
				throw new Error("no serialization");
			},
		},
		{
			ownKeys() {
				enumerated = true;
				throw new Error("no enumeration");
			},
		},
	);
	const id = sm.appendMessage({
		role: "toolResult",
		toolName: "synthetic_tool",
		toolCallId: "synthetic-call",
		content: [{ type: "text", text: "stored truncation notice" }],
		details,
		isError: true,
		timestamp: 1,
	});
	const result = readHistory(sm, { entryId: id, pointer: "/message/details" });
	assert.equal(result.status, "structured_omitted");
	assert.equal((result.entry as Record<string, unknown>).isError, true);
	assert.equal(readHistory(sm, { entryId: id, pointer: "/message/details/result" }).text, "exact nested value");
	assert.equal(readHistory(sm, { entryId: id, pointer: "/message/details/data" }).text, "ordinary tool data");
	assert.equal(enumerated, false);
	assert.equal(searchHistory(sm, { query: "nested" }).status, "ancestry_exhausted");
	assert.equal(matches(searchHistory(sm, { query: "nested" })).length, 0);
	const manifest = readHistory(sm, { entryId: id });
	assert.ok((manifest.items as Record<string, unknown>[]).some((item) => item.pointer === "/message"));
	const message = readHistory(sm, { entryId: id, pointer: "/message" });
	assert.ok(
		(message.items as Record<string, unknown>[]).some(
			(item) => item.pointer === "/message/details" && item.omitted === true,
		),
	);
	const getter = source([raw("get", null)]);
	const entry = getter.getEntry("get")!;
	Object.defineProperty(entry, "summary", {
		get() {
			throw new Error("getter ran");
		},
	});
	assert.throws(() => searchHistory(getter, { query: "x" }), /Accessor fields/);
});

test("custom entries retain their entry class and literal nested pointers", () => {
	const sm = SessionManager.inMemory();
	const custom = sm.appendCustomEntry("state-example", { "a/b": { "~key": "opaque data" } });
	const customMessage = sm.appendCustomMessageEntry("note-example", "custom body", true);
	const listing = matches(searchHistory(sm, {}));
	assert.equal(listing[1].entry.type, "custom");
	assert.equal(listing[1].entry.role, undefined);
	assert.equal(listing[1].entry.contextParticipation, "plain custom entry: not context");
	assert.equal(listing[0].entry.type, "custom_message");
	assert.equal(readHistory(sm, { entryId: customMessage, pointer: "/content" }).text, "custom body");
	assert.equal(readHistory(sm, { entryId: custom, pointer: "/data/a~1b/~0key" }).text, "opaque data");
	assert.equal(readHistory(sm, { entryId: custom, pointer: "/data/missing" }).status, "field_absent");
});

test("tool arguments remain available by pointer while provider payloads and redactions stay withheld", () => {
	const sm = source([
		{
			id: "a",
			parentId: null,
			timestamp: "2026-01-01",
			type: "message",
			message: {
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: "call",
						name: "synthetic_tool",
						arguments: { data: "tool input", query: "specific request" },
						thoughtSignature: "opaque call signature",
					},
					{ type: "thinking", thinking: "hidden reasoning", thinkingSignature: "opaque signature", redacted: true },
					{ type: "text", text: "shown answer", textSignature: "opaque text signature" },
					{ type: "image", data: "synthetic-image-payload", mimeType: "image/png" },
				],
			},
		} as unknown as SessionEntry,
	]);
	assert.equal(readHistory(sm, { entryId: "a", pointer: "/message/content/0/arguments" }).status, "structured_omitted");
	assert.equal(readHistory(sm, { entryId: "a", pointer: "/message/content/0/arguments/data" }).text, "tool input");
	for (const pointer of [
		"/message/content/0/thoughtSignature",
		"/message/content/1/thinking",
		"/message/content/1/thinkingSignature",
		"/message/content/2/textSignature",
		"/message/content/3/data",
	]) {
		assert.equal(readHistory(sm, { entryId: "a", pointer }).status, "withheld");
	}
	assert.equal(matches(searchHistory(sm, { query: "hidden" })).length, 0);
	assert.equal(matches(searchHistory(sm, { query: "opaque" })).length, 0);
	const manifest = readHistory(sm, { entryId: "a", pointer: "/message/content/1" });
	assert.ok(
		(manifest.items as Record<string, unknown>[]).some(
			(item) => item.pointer === "/message/content/1/redacted" && item.value === true,
		),
	);
	assert.equal(readHistory(sm, { entryId: "a", pointer: "/message/content", offset: 1, maxItems: 1 }).status, "page");
});

test("stored bash truncation stays distinct from a read page", () => {
	const sm = SessionManager.inMemory();
	const id = sm.appendMessage({
		role: "bashExecution",
		command: "synthetic",
		output: "stored truncated text",
		exitCode: 1,
		cancelled: false,
		truncated: true,
		excludeFromContext: true,
		timestamp: 1,
	});
	const result = readHistory(sm, { entryId: id, pointer: "/message/output", maxBytes: 4 });
	assert.equal(result.status, "page");
	assert.equal((result.entry as Record<string, unknown>).truncated, true);
	assert.equal((result.entry as Record<string, unknown>).excludeFromContext, true);
	assert.equal((result.entry as Record<string, unknown>).role, "bashExecution");
});

test("defensive execute validation rejects mutated parameters and observes cancellation", async () => {
	const tools: ToolDefinition[] = [];
	history({
		registerTool: (tool: ToolDefinition) => {
			tools.push(tool);
		},
	} as ExtensionAPI);
	assert.deepEqual(
		tools.map((tool) => tool.name),
		["history_search", "history_read"],
	);
	const sm = SessionManager.inMemory();
	const id = user(sm, "original");
	const ctx = { sessionManager: sm } as unknown as ExtensionContext;
	const search = tools[0];
	const read = tools[1];
	for (const args of [
		null,
		[],
		{ query: "" },
		{ query: "x".repeat(257) },
		{ query: "\ud800" },
		{ maxVisits: Infinity },
		{ maxVisits: 129 },
		{ maxScanBytes: 1 },
		{ maxMatches: -1 },
		{ slot: 1 },
		{ offset: 0.5 },
		{ fromId: "x", offset: -1 },
		{ query: 7 },
	]) {
		await assert.rejects(search.execute("call", args, undefined, undefined, ctx));
	}
	for (const args of [
		{ entryId: id, maxBytes: Infinity },
		{ entryId: id, pointer: "/bad~escape" },
		{ entryId: id, pointer: "bad" },
		{ entryId: id, pointer: "/a".repeat(33) },
		{ entryId: id, maxItems: 0 },
		{ entryId: id, maxOutputBytes: 1 },
	]) {
		await assert.rejects(read.execute("call", args, undefined, undefined, ctx));
	}
	const controller = new AbortController();
	controller.abort();
	await assert.rejects(search.execute("call", {}, controller.signal, undefined, ctx), /abort/i);
	await assert.rejects(read.execute("call", { entryId: id }, controller.signal, undefined, ctx), /abort/i);
	const output = await search.execute("call", { query: "original" }, undefined, undefined, ctx);
	const a = JSON.parse((output.content[0] as { text: string }).text);
	assert.equal(a.sessionId, sm.getSessionId());
	const other = SessionManager.inMemory();
	user(other, "replacement");
	const b = await search.execute("call", { query: "original" }, undefined, undefined, {
		sessionManager: other,
	} as unknown as ExtensionContext);
	assert.equal(JSON.parse((b.content[0] as { text: string }).text).matches.length, 0);
});

test("abort during bounded source access stops before another entry", () => {
	const controller = new AbortController();
	const original = source([raw("a", null), raw("b", "a")]);
	let calls = 0;
	const sm: HistorySource = {
		...original,
		getEntry(id) {
			calls++;
			controller.abort();
			return original.getEntry(id);
		},
	};
	assert.throws(() => searchHistory(sm, { query: "x" }, controller.signal), /abort/i);
	assert.equal(calls, 1);
});
