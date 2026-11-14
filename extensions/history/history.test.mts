import assert from "node:assert/strict";
import test from "node:test";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import {
	SessionManager,
	type ExtensionAPI,
	type ExtensionContext,
	type ExtensionToolContext,
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

test("manifests contain malformed opaque fields without enumeration, getters, toJSON or payload serialization", () => {
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
	// Malformed source data bypasses Pi's JSON-only append contract deliberately.
	const entry = {
		...raw("opaque", null),
		message: {
			role: "toolResult",
			toolName: "synthetic_tool",
			toolCallId: "synthetic-call",
			content: [{ type: "text", text: "stored truncation notice" }],
			details,
			isError: true,
			timestamp: 1,
		},
	} as unknown as SessionEntry;
	const sm = source([entry]);
	const id = entry.id;
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
	const getterEntry = getter.getEntry("get");
	assert.ok(getterEntry);
	Object.defineProperty(getterEntry, "summary", {
		get() {
			throw new Error("getter ran");
		},
	});
	assert.throws(() => searchHistory(getter, { query: "x" }), /Accessor fields/);
});

test("system messages and compaction checkpoints expose bounded prompt and tool selectors", () => {
	const sm = SessionManager.inMemory();
	const system = sm.appendMessage({
		role: "system",
		content: [{ type: "text", text: "base instructions", textSignature: "opaque signature" }],
		sections: { rules: "exact rule text", removed: null },
		toolsAdded: [{ name: "synthetic_tool", description: "tool contract", parameters: {} }],
		toolsRemoved: [{ name: "removed_tool" }],
		timestamp: 1,
	});
	const kept = user(sm, "retained request");
	const compact = sm.appendCompaction("summary", kept, 1000);
	assert.equal(matches(searchHistory(sm, { query: "base instructions" }))[0].entry.id, system);
	assert.equal(matches(searchHistory(sm, { query: "exact rule text" })).length, 0);
	const fields = readHistory(sm, { entryId: system, pointer: "/message" }).items as Record<string, unknown>[];
	for (const key of ["sections", "toolsAdded", "toolsRemoved"]) {
		assert.ok(fields.some((field) => field.pointer === `/message/${key}`));
	}
	assert.equal(readHistory(sm, { entryId: system, pointer: "/message/sections" }).status, "structured_omitted");
	assert.equal(readHistory(sm, { entryId: system, pointer: "/message/sections/rules" }).text, "exact rule text");
	assert.equal(readHistory(sm, { entryId: system, pointer: "/message/sections/removed" }).value, null);
	assert.equal(readHistory(sm, { entryId: system, pointer: "/message/toolsAdded/0/name" }).text, "synthetic_tool");
	const root = readHistory(sm, { entryId: compact }).items as Record<string, unknown>[];
	assert.ok(root.some((field) => field.pointer === "/systemMessage"));
	const checkpoint = readHistory(sm, { entryId: compact, pointer: "/systemMessage" }).items as Record<string, unknown>[];
	assert.ok(checkpoint.some((field) => field.pointer === "/systemMessage/sections"));
	assert.equal(readHistory(sm, { entryId: compact, pointer: "/systemMessage/sections/rules" }).text, "exact rule text");
	assert.equal(readHistory(sm, { entryId: compact, pointer: "/systemMessage/content" }).text, "base instructions");
	const stored = sm.getEntry(compact);
	assert.ok(stored);
	assert.equal(stored.type, "compaction");
	if (stored.type !== "compaction") throw new Error("Expected a compaction checkpoint");
	const arrayCheckpoint = source([{ ...stored, systemMessage: {
		role: "system", content: [{ type: "text", text: "base instructions", textSignature: "opaque signature" }], timestamp: 1,
	} }]);
	assert.equal(readHistory(arrayCheckpoint, { entryId: compact, pointer: "/systemMessage/content/0/textSignature" }).status, "withheld");
	const block = readHistory(arrayCheckpoint, { entryId: compact, pointer: "/systemMessage/content/0" }).items as Record<string, unknown>[];
	assert.ok(block.some((field) => field.pointer === "/systemMessage/content/0/textSignature" && field.kind === "withheld"));
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
	assert.deepEqual(readHistory(sm, { entryId: "a", pointer: "/message/content/0/arguments" }).items, [
		{ key: "data", pointer: "/message/content/0/arguments/data", kind: "string", totalCodeUnits: 10, text: "tool input" },
		{ key: "query", pointer: "/message/content/0/arguments/query", kind: "string", totalCodeUnits: 16, text: "specific request" },
	]);
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

test("context-edit replacement blocks withhold payloads and signatures in direct reads and manifests", () => {
	const cases = [
		{
			block: { type: "thinking", thinking: "synthetic redacted text", thinkingSignature: "synthetic thinking signature", redacted: true },
			keys: ["thinking", "thinkingSignature"],
		},
		{
			block: { type: "text", text: "readable replacement", textSignature: "synthetic text signature" },
			keys: ["textSignature"],
		},
		{
			block: { type: "image", data: "synthetic image payload", mimeType: "image/png" },
			keys: ["data"],
		},
		{
			block: {
				type: "toolCall", id: "call", name: "synthetic_tool",
				arguments: { data: "readable input" }, thoughtSignature: "synthetic call signature",
			},
			keys: ["thoughtSignature"],
		},
	];
	for (const { block, keys } of cases) {
		const entry = {
			id: "edit", parentId: null, timestamp: "2026-01-01", type: "context_edit",
			targetId: "target", replacement: { content: [block] },
		} as unknown as SessionEntry;
		const sm = source([entry]);
		const manifest = readHistory(sm, { entryId: "edit", pointer: "/replacement/content/0" });
		for (const key of keys) {
			const pointer = `/replacement/content/0/${key}`;
			for (const selected of [pointer, `${pointer}/nested`]) {
				const result = readHistory(sm, { entryId: "edit", pointer: selected });
				assert.equal(result.status, "withheld", selected);
				assert.equal(result.reason, "Image payloads, opaque provider signatures, and redacted thinking are not exposed.");
				assert.equal(result.text, undefined);
			}
			assert.ok((manifest.items as Record<string, unknown>[]).some(
				(item) => item.pointer === pointer && item.kind === "withheld" &&
					item.reason === "Image payload, provider signature, or redacted thinking.",
			));
			assert.ok(!JSON.stringify(toolResult(manifest)).includes(Reflect.get(block, key)));
		}
	}
});

test("context-edit manifests expose replacement content and preserve ordinary selectors", () => {
	const sm = source([{
		id: "edit", parentId: null, timestamp: "2026-01-01", type: "context_edit", targetId: "target",
		replacement: { content: [
			{ type: "text", text: "readable replacement" },
			{ type: "thinking", thinking: "readable thinking", redacted: false },
			{ type: "thinking", thinking: "synthetic redacted text", redacted: true },
			{ type: "image", data: "synthetic image payload", mimeType: "image/png" },
			{ type: "toolCall", id: "call", name: "synthetic_tool", arguments: { data: "readable input", textSignature: "ordinary field" } },
		] },
	} as unknown as SessionEntry]);
	const root = readHistory(sm, { entryId: "edit" });
	assert.ok((root.items as Record<string, unknown>[]).some((item) => item.pointer === "/replacement" && item.kind === "object"));
	assert.equal((root.entry as Record<string, unknown>).targetId, "target");
	const replacement = readHistory(sm, { entryId: "edit", pointer: "/replacement" });
	assert.equal(replacement.status, "complete");
	assert.deepEqual((replacement.items as Record<string, unknown>[]).map((item) => item.pointer), ["/replacement/content"]);
	const first = readHistory(sm, { entryId: "edit", pointer: "/replacement/content", maxItems: 1 });
	assert.equal(first.status, "page");
	assert.equal((first.items as Record<string, unknown>[])[0].pointer, "/replacement/content/0");
	const rest = readHistory(sm, next(first));
	assert.equal(rest.status, "complete");
	assert.equal((rest.items as Record<string, unknown>[]).length, 4);
	for (const [pointer, text] of [
		["/replacement/content/0/text", "readable replacement"],
		["/replacement/content/1/thinking", "readable thinking"],
		["/replacement/content/3/mimeType", "image/png"],
		["/replacement/content/4/arguments/data", "readable input"],
		["/replacement/content/4/arguments/textSignature", "ordinary field"],
	]) {
		const result = readHistory(sm, { entryId: "edit", pointer });
		assert.equal(result.status, "complete");
		assert.equal(result.text, text);
	}
	assert.equal(readHistory(sm, { entryId: "edit", pointer: "/replacement/content/2/redacted" }).value, true);
	assert.equal(matches(searchHistory(sm, { query: "readable replacement" })).length, 0);
});

test("context edits preserve null, string and empty replacements without withholding ordinary custom data", () => {
	for (const replacement of [null, { content: "replacement text" }, { content: [] }]) {
		const sm = source([{
			id: "edit", parentId: null, timestamp: "2026-01-01", type: "context_edit", targetId: "target", replacement,
		} as unknown as SessionEntry]);
		const result = readHistory(sm, { entryId: "edit", pointer: "/replacement" });
		assert.equal(result.status, "complete");
		if (replacement === null) {
			assert.equal(result.value, null);
		} else {
			const content = readHistory(sm, { entryId: "edit", pointer: "/replacement/content" });
			assert.equal(content.status, "complete");
			if (typeof replacement.content === "string") assert.equal(content.text, replacement.content);
			else assert.deepEqual(content.items, []);
		}
		assert.equal(readHistory(sm, { entryId: "edit", pointer: "/replacement/content/0/thinkingSignature" }).status, "field_absent");
	}
	const sm = SessionManager.inMemory();
	const id = sm.appendCustomEntry("ordinary-data", { replacement: { content: [{ type: "image", data: "ordinary data" }] } });
	assert.equal(readHistory(sm, { entryId: id, pointer: "/data/replacement/content/0/data" }).text, "ordinary data");
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
		events: { emit: () => {}, on: () => () => {} },
	} as unknown as ExtensionAPI);
	assert.deepEqual(
		tools.map((tool) => tool.name),
		["history_search", "history_read"],
	);
	const sm = SessionManager.inMemory();
	const id = user(sm, "original");
	const ctx = {
		...({ sessionManager: sm } as unknown as ExtensionContext),
		tools: [],
		executeTool: async () => { throw new Error("Unexpected nested tool call"); },
	} satisfies ExtensionToolContext;
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
		...ctx,
		sessionManager: other,
	});
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

type ArgumentMatch = {
	entry: Record<string, unknown>;
	call?: Record<string, unknown>;
	pointer: string;
	offset: number;
	excerpt: string;
};
function argumentMatches(result: Result) {
	return result.matches as ArgumentMatch[];
}
function callEntry(id: string, parentId: string | null, content: unknown[]): SessionEntry {
	return {
		id,
		parentId,
		timestamp: "2026-01-01T00:00:00Z",
		type: "message",
		message: { ...fauxAssistantMessage("placeholder"), content },
	} as SessionEntry;
}
function nest(depth: number, leaf: string): unknown {
	let value: unknown = leaf;
	for (let level = 0; level < depth; level++) value = { k: value };
	return value;
}
/** Follow argument-search continuations until the walk ends; every call keeps the original query and limits. */
function allPages(sm: HistorySource, args: Record<string, unknown>) {
	const pages = [searchHistory(sm, args)];
	while (pages.at(-1)?.next !== null && pages.length < 50) pages.push(searchHistory(sm, { ...args, ...next(pages.at(-1) as Result) }));
	return pages;
}

test("argument search finds an edit argument that text search cannot reach, and the reader returns it exactly", () => {
	const sm = SessionManager.inMemory();
	user(sm, "apply the planned change");
	const token = 'const marker = "argument-only-token";';
	const calls = sm.appendMessage(
		fauxAssistantMessage(
			[
				{ type: "text", text: "Reading, then editing." },
				fauxToolCall("read", { path: "extensions/demo/core.ts" }, { id: "call-read" }),
				fauxToolCall(
					"edit",
					{ path: "extensions/demo/core.ts", edits: [{ oldText: "const marker = 1;", newText: token }] },
					{ id: "call-edit" },
				),
			],
			{ stopReason: "toolUse" },
		),
	);
	sm.appendMessage({
		role: "toolResult",
		toolCallId: "call-read",
		toolName: "read",
		content: [{ type: "text", text: "const marker = 1;" }],
		isError: false,
		timestamp: 1,
	});
	const editResult = sm.appendMessage({
		role: "toolResult",
		toolCallId: "call-edit",
		toolName: "edit",
		content: [{ type: "text", text: "Successfully replaced 1 block(s) in extensions/demo/core.ts." }],
		isError: false,
		timestamp: 1,
	});

	const text = searchHistory(sm, { query: "argument-only-token" });
	assert.equal(text.status, "ancestry_exhausted");
	assert.equal(matches(text).length, 0);
	assert.equal(text.mode, undefined);
	assert.equal(typeof text.slotsVisited, "number");
	assert.equal(text.nodesVisited, undefined);
	assert.match(String(text.coverage), /tool arguments, images and other fields are not searched/);

	const found = searchHistory(sm, { query: "argument-only-token", mode: "arguments" });
	assert.equal(found.status, "ancestry_exhausted");
	assert.equal(found.mode, "arguments");
	assert.equal(found.slotsVisited, undefined);
	assert.deepEqual(found.skipped, { depth: 0, pointerLength: 0 });
	assert.match(String(found.coverage), /Argument search covers string values/);
	assert.equal(argumentMatches(found).length, 1);
	const [hit] = argumentMatches(found);
	assert.equal(hit.entry.id, calls);
	assert.equal(hit.entry.role, "assistant");
	assert.deepEqual(hit.call, { name: "edit", id: "call-edit" });
	assert.equal(hit.pointer, "/message/content/2/arguments/edits/0/newText");
	assert.equal(hit.offset, token.indexOf("argument-only-token"));
	assert.equal(hit.excerpt, 'argument-only-token";');
	const read = readHistory(sm, { entryId: String(hit.entry.id), pointer: hit.pointer });
	assert.equal(read.status, "complete");
	assert.equal(read.text, token);

	const byPath = searchHistory(sm, { query: "extensions/demo/core.ts", mode: "arguments" });
	assert.deepEqual(
		argumentMatches(byPath).map((match) => [match.call?.name, match.pointer]),
		[
			["read", "/message/content/1/arguments/path"],
			["edit", "/message/content/2/arguments/path"],
		],
	);
	assert.deepEqual(
		matches(searchHistory(sm, { query: "extensions/demo/core.ts" })).map((match) => match.entry.id),
		[editResult],
	);
});

test("argument search continues across match, scan and node bounds without lost or repeated matches", () => {
	const twice = callEntry("twice", null, [
		fauxToolCall("edit", { edits: [{ newText: "needle one, needle two" }] }, { id: "a" }),
		fauxToolCall("bash", { command: `${"x".repeat(3000)}needle${"y".repeat(3000)}` }, { id: "b" }),
	]);
	const pages = allPages(source([twice]), { query: "needle", mode: "arguments", maxMatches: 1, maxScanBytes: 2048 });
	const statuses = pages.map((page) => page.status);
	assert.ok(statuses.includes("match_limit"));
	assert.ok(statuses.includes("scan_limit"));
	assert.equal(statuses.at(-1), "ancestry_exhausted");
	for (const page of pages.slice(0, -1)) {
		const cursor = next(page);
		assert.equal(cursor.mode, "arguments");
		assert.equal(cursor.fromId, "twice");
		assert.ok(Array.isArray((cursor.position as { path: unknown }).path));
	}
	assert.deepEqual(
		pages.flatMap((page) => argumentMatches(page).map((match) => [match.pointer, match.offset])),
		[
			["/message/content/0/arguments/edits/0/newText", 0],
			["/message/content/0/arguments/edits/0/newText", 12],
			["/message/content/1/arguments/command", 3000],
		],
	);

	const reads: number[] = [];
	const items = new Proxy(
		Array.from({ length: 3000 }, () => "v"),
		{
			getOwnPropertyDescriptor(target, key) {
				if (typeof key === "string" && /^\d+$/.test(key)) reads.push(Number(key));
				return Reflect.getOwnPropertyDescriptor(target, key);
			},
		},
	);
	const wide = source([callEntry("wide", null, [fauxToolCall("write", { items, tail: "needle" }, { id: "w" })])]);
	const first = searchHistory(wide, { query: "needle", mode: "arguments" });
	assert.equal(first.status, "node_limit");
	assert.equal(first.nodesVisited, LIMITS.argumentNodes);
	const position = next(first).position as { block: number; path: number[] };
	assert.equal(position.block, 0);
	assert.equal(position.path[0], 0);
	const resumeAt = position.path[1];
	assert.equal(Math.max(...reads), resumeAt, "the walk reads at most one value past its node budget");
	reads.length = 0;
	const rest = allPages(wide, { query: "needle", mode: "arguments", ...next(first) });
	assert.equal(Math.min(...reads), resumeAt, "a resumed call starts at its position without a prefix walk");
	assert.deepEqual(
		[first, ...rest].flatMap((page) => argumentMatches(page).map((match) => match.pointer)),
		["/message/content/0/arguments/tail"],
	);
	assert.ok(rest.every((page) => Number(page.nodesVisited) <= LIMITS.argumentNodes));
});

test("argument search reports depth and pointer-length skips and returns only pointers the reader accepts", () => {
	const args = {
		"a/b~c": "needle escaped",
		d: nest(LIMITS.argumentDepth - 1, "needle deep"),
		e: nest(LIMITS.argumentDepth, "needle deeper"),
		["p".repeat(900)]: "needle long key",
		["q".repeat(1000)]: "needle hidden",
	};
	const sm = source([callEntry("deep", null, [{ type: "toolCall", id: "c", name: "probe", arguments: args }])]);
	const found = searchHistory(sm, { query: "needle", mode: "arguments" });
	assert.equal(found.status, "ancestry_exhausted");
	assert.deepEqual(found.skipped, { depth: 1, pointerLength: 1 });
	const hits = argumentMatches(found);
	assert.deepEqual(
		hits.map((match) => match.excerpt),
		["needle escaped", "needle deep", "needle long key"],
	);
	assert.equal(hits[0].pointer, "/message/content/0/arguments/a~1b~0c");
	assert.equal(hits[1].pointer, `/message/content/0/arguments/d${"/k".repeat(LIMITS.argumentDepth - 1)}`);
	for (const hit of hits) {
		assert.ok(hit.pointer.length <= LIMITS.pointerUnits);
		const read = readHistory(sm, { entryId: "deep", pointer: hit.pointer });
		assert.equal(read.status, "complete", hit.pointer);
		assert.equal(read.text, hit.excerpt);
	}
});

test("argument search leaves out the calling call, withheld payloads and unrelated structured fields", () => {
	const entries: SessionEntry[] = [
		callEntry("call", null, [
			{ type: "thinking", thinking: "needle", redacted: true, thinkingSignature: "needle" },
			{ type: "text", text: "plain", textSignature: "needle" },
			{ type: "toolCall", id: "other", name: "probe", arguments: { ok: "plain" }, thoughtSignature: "needle" },
			{ type: "toolCall", id: "self", name: "history_search", arguments: { query: "needle", mode: "arguments" } },
		]),
		{
			id: "result",
			parentId: "call",
			timestamp: "2026-01-01T00:00:00Z",
			type: "message",
			message: {
				role: "toolResult",
				toolCallId: "other",
				toolName: "probe",
				content: [{ type: "image", data: "needle", mimeType: "image/png" }],
				details: { note: "needle" },
				isError: false,
				timestamp: 1,
			},
		},
		{
			id: "custom",
			parentId: "result",
			timestamp: "2026-01-01T00:00:00Z",
			type: "custom",
			customType: "probe",
			data: { arguments: { note: "needle" } },
		} as SessionEntry,
	];
	const sm = source(entries);
	assert.deepEqual(
		argumentMatches(searchHistory(sm, { query: "needle", mode: "arguments" })).map((match) => match.pointer),
		["/message/content/3/arguments/query"],
	);
	const own = searchHistory(sm, { query: "needle", mode: "arguments" }, undefined, "self");
	assert.equal(own.status, "ancestry_exhausted");
	assert.equal(own.visited, 3);
	assert.equal(argumentMatches(own).length, 0);
});

test("argument search validates its mode, query, filter and position arguments", () => {
	const sm = source([
		callEntry("a", null, [{ type: "text", text: "plain" }, fauxToolCall("probe", { list: ["needle"] }, { id: "c" })]),
	]);
	const base = { query: "needle", mode: "arguments", fromId: "a" };
	for (const [args, message] of [
		[{ mode: "arguments" }, /requires a query/],
		[{ query: "needle", mode: "arguments", filter: { source: "user" } }, /omit filter/],
		[{ ...base, slot: 0 }, /omit slot/],
		[{ query: "needle", fromId: "a", position: { block: 1 } }, /retain mode/],
		[{ ...base, offset: 2 }, /requires a position/],
		[{ query: "needle", mode: "arguments", position: { block: 1 } }, /requires fromId/],
		[{ query: "needle", mode: "regex" }, /mode must be/],
		[{ ...base, position: {} }, /block index/],
		[{ ...base, position: { block: 1, path: [-1] } }, /nonnegative/],
		[{ ...base, position: { block: 1, path: Array(LIMITS.argumentDepth + 1).fill(0) } }, /at most/],
		[{ ...base, position: { block: 1, path: [1] } }, /does not select an argument value/],
		[{ ...base, position: { block: 1, path: [0, 0, 0] } }, /does not select an argument value/],
		[{ ...base, position: { block: 3 } }, /does not select a content block/],
		[{ ...base, position: { block: 0, path: [0] } }, /does not select a tool call/],
		[{ ...base, position: { block: 1, path: [0] }, offset: 1 }, /Offset does not select a text field/],
	] as const) {
		assert.throws(() => searchHistory(sm, args), message, JSON.stringify(args));
	}
	const resumed = searchHistory(sm, { ...base, position: { block: 1, path: [0, 0] }, offset: 1 });
	assert.equal(argumentMatches(resumed).length, 0);
	assert.equal(argumentMatches(searchHistory(sm, { ...base, position: { block: 1, path: [0, 0] } })).length, 1);
});

test("scan continuations resume after a surrogate pair at the overlap boundary without repeating a match", () => {
	const value = `${"a".repeat(2044)}😀x`;
	for (const [sm, args] of [
		[source([raw("t", null, value)]), { query: "😀", maxScanBytes: 2048 }],
		[
			source([callEntry("c", null, [fauxToolCall("probe", { s: value }, { id: "c" })])]),
			{ query: "😀", mode: "arguments", maxScanBytes: 2048 },
		],
	] as const) {
		const pages = allPages(sm, args);
		assert.equal(pages[0].status, "scan_limit");
		assert.equal(pages.at(-1)?.status, "ancestry_exhausted");
		assert.deepEqual(
			pages.flatMap((page) => argumentMatches(page).map((match) => match.offset)),
			[2044],
		);
	}
});

test("an argument-search match and one read of the call's arguments answer every argument", () => {
	let deep: Record<string, unknown> = { leaf: "bottom" };
	for (let level = 0; level < LIMITS.argumentDepth; level++) deep = { next: deep };
	const longKey = "k".repeat(LIMITS.pointerUnits);
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
						name: "clipboard_copy",
						arguments: {
							content: "use-path marker 42",
							archive: false,
							"odd/key~": 3,
							long: "x".repeat(300),
							edits: [{ oldText: "a", newText: "b" }],
							options: { mode: "fast" },
							deep,
							[longKey]: "unreachable",
						},
					},
				],
			},
		} as unknown as SessionEntry,
	]);
	const found = matches(searchHistory(sm, { query: "use-path marker", mode: "arguments" }));
	assert.equal(found[0]?.pointer, "/message/content/0/arguments/content");
	const listing = readHistory(sm, { entryId: "a", pointer: "/message/content/0/arguments" });
	assert.equal(listing.status, "complete");
	assert.deepEqual(listing.items, [
		{ key: "content", pointer: "/message/content/0/arguments/content", kind: "string", totalCodeUnits: 18, text: "use-path marker 42" },
		{ key: "archive", pointer: "/message/content/0/arguments/archive", kind: "scalar", value: false },
		{ key: "odd/key~", pointer: "/message/content/0/arguments/odd~1key~0", kind: "scalar", value: 3 },
		{
			key: "long",
			pointer: "/message/content/0/arguments/long",
			kind: "string",
			totalCodeUnits: 300,
			omitted: true,
			action: "Read this pointer with offset and maxBytes.",
		},
		{ key: "edits", pointer: "/message/content/0/arguments/edits", kind: "array", length: 1, omitted: true, action: "Read this pointer with offset and maxItems." },
		{ key: "options", pointer: "/message/content/0/arguments/options", kind: "object", omitted: true, action: "Read this pointer to list its argument keys." },
		{ key: "deep", pointer: "/message/content/0/arguments/deep", kind: "object", omitted: true, action: "Read this pointer to list its argument keys." },
		{ kind: "skipped", reason: "pointerLength", totalCodeUnits: LIMITS.pointerUnits },
	]);
	assert.equal(readHistory(sm, { entryId: "a", pointer: "/message/content/0/arguments/odd~1key~0" }).value, 3);
	assert.deepEqual(readHistory(sm, { entryId: "a", pointer: "/message/content/0/arguments/edits/0" }).items, [
		{ key: "oldText", pointer: "/message/content/0/arguments/edits/0/oldText", kind: "string", totalCodeUnits: 1, text: "a" },
		{ key: "newText", pointer: "/message/content/0/arguments/edits/0/newText", kind: "string", totalCodeUnits: 1, text: "b" },
	]);
	const paged = readHistory(sm, { entryId: "a", pointer: "/message/content/0/arguments", maxItems: 2 });
	assert.equal((paged.items as unknown[]).length, 2);
	assert.deepEqual(paged.next, { sessionId: "synthetic-session", entryId: "a", pointer: "/message/content/0/arguments", offset: 2 });
	let pointer = "/message/content/0/arguments/deep";
	for (let level = 1; level < LIMITS.argumentDepth - 1; level++) pointer += "/next";
	const lastListed = readHistory(sm, { entryId: "a", pointer });
	assert.deepEqual((lastListed.items as Record<string, unknown>[])[0]?.action, "Read this pointer, or append a known child key as a JSON pointer. Opaque object keys are not enumerated.", "the listing stops at the argument-search depth");
	assert.equal(readHistory(sm, { entryId: "a", pointer: `${pointer}/next` }).status, "structured_omitted");
});
