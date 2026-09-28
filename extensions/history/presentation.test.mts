import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { SessionManager, type Theme, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { readHistory, searchHistory, toolResult } from "./core.ts";
import history from "./index.ts";
import { renderReadCall, renderReadResult, renderSearchCall, renderSearchResult } from "./presentation.ts";

const theme = { fg: (_color: string, value: string) => value, bold: (value: string) => value } as unknown as Theme;
const screen = (component: { render(width: number): string[] }, width = 140) =>
	component.render(width).map((line) => stripVTControlCharacters(line).trimEnd()).join("\n");
const rows = (component: { render(width: number): string[] }, width = 100) =>
	component.render(width).map((line) => stripVTControlCharacters(line).trimEnd()).filter((line) => line !== "");
const emptyResult = (text: string) => ({ content: [{ type: "text" as const, text }], details: {} });

function registeredTools(): Map<string, ToolDefinition> {
	const tools = new Map<string, ToolDefinition>();
	history({
		registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
	} as never);
	return tools;
}

function sessionUser(sm: SessionManager, content: string): string {
	return sm.appendMessage({ role: "user", content, timestamp: 1 });
}

describe("history tool registration", () => {
	it("attaches call and result renderers to both history tools", () => {
		const tools = registeredTools();
		assert.equal(tools.get("history_search")?.renderCall, renderSearchCall);
		assert.equal(tools.get("history_search")?.renderResult, renderSearchResult);
		assert.equal(tools.get("history_read")?.renderCall, renderReadCall);
		assert.equal(tools.get("history_read")?.renderResult, renderReadResult);
	});
});

describe("history_search cards", () => {
	it("names the query, filter, and continuation", () => {
		const shown = screen(
			renderSearchCall(
				{ query: "amber decision", filter: { source: "toolResult", toolName: "bash", errorsOnly: true }, fromId: "entry-1", slot: 2, offset: 40 },
				theme,
				{ expanded: false, argsComplete: true },
			),
		);
		assert.match(shown, /history_search · "amber decision"/);
		assert.match(shown, /filter toolResult\(bash\) errors only/);
		assert.match(shown, /from entry-1 · continuation slot 2 offset 40/);
		assert.match(screen(renderSearchCall({}, theme, { argsComplete: true })), /history_search · listing/);
		assert.match(screen(renderSearchCall(undefined, theme, { argsComplete: false })), /history_search/);
	});

	it("summarizes a real exhaustive search with count, scope, and status", () => {
		const sm = SessionManager.inMemory();
		sessionUser(sm, "decision amber raw detail");
		sessionUser(sm, "recent cyan");
		const value = searchHistory(sm, { query: "amber" });
		assert.equal(value.status, "ancestry_exhausted");
		const view = renderSearchResult(toolResult(value), { expanded: false, isPartial: false }, theme, { isError: false });
		const shown = screen(view);
		assert.match(shown, /1 match · \d+ entries visited · ancestry exhausted/);
		assert.match(shown, /1 message/);
		assert.doesNotMatch(shown, /amber raw detail/);
		assert.doesNotMatch(shown, /continuation available/);
		assert.equal(rows(view).length, 2);
		const expanded = screen(renderSearchResult(toolResult(value), { expanded: true, isPartial: false }, theme, { isError: false }));
		assert.match(expanded, /"status": "ancestry_exhausted"/);
		assert.match(expanded, /"notice":/);
	});

	it("reports a limited page with continuation and an empty exhaustive scope", () => {
		const sm = SessionManager.inMemory();
		sessionUser(sm, "alpha one");
		sessionUser(sm, "alpha two");
		const limited = searchHistory(sm, { query: "alpha", maxMatches: 1 });
		assert.equal(limited.status, "match_limit");
		const shown = screen(renderSearchResult(toolResult(limited), { expanded: false, isPartial: false }, theme, { isError: false }));
		assert.match(shown, /1 match · 1 entry visited · match limit/);
		assert.match(shown, /continuation available/);
		const empty = searchHistory(sm, { query: "nothing-matches-this" });
		const emptyShown = screen(renderSearchResult(toolResult(empty), { expanded: false, isPartial: false }, theme, { isError: false }));
		assert.match(emptyShown, /0 matches · \d+ entries visited · ancestry exhausted/);
	});

	it("marks omitted entry types in the tally", () => {
		const matches = ["message", "compaction", "branch_summary", "context_edit", "custom", "label"].map((type) => ({ entry: { type } }));
		const value = { status: "ancestry_exhausted", matches, visited: 6, next: null };
		const shown = screen(renderSearchResult(emptyResult(JSON.stringify(value)), { expanded: false, isPartial: false }, theme, { isError: false }));
		assert.match(shown, /\+2 more/);
	});

	it("reports an unknown entry and a listing without claiming absence", () => {
		const sm = SessionManager.inMemory();
		sessionUser(sm, "listing body");
		const unknown = searchHistory(sm, { fromId: "missing-entry" });
		const shown = screen(renderSearchResult(toolResult(unknown), { expanded: false, isPartial: false }, theme, { isError: false }));
		assert.match(shown, /0 matches · 1 entry visited · unknown entry/);
		const listing = searchHistory(sm, {});
		const listingShown = screen(renderSearchResult(toolResult(listing), { expanded: false, isPartial: false }, theme, { isError: false }));
		assert.match(listingShown, /1 match · 1 entry visited · ancestry exhausted/);
	});

	it("renders errors, partial state, and malformed payloads safely", () => {
		const error = screen(renderSearchResult(emptyResult("history_search failed: source changed"), { expanded: false, isPartial: false }, theme, { isError: true }));
		assert.match(error, /history_search failed: source changed/);
		assert.match(screen(renderSearchResult(emptyResult("{}"), { expanded: false, isPartial: true }, theme, { isError: false })), /Searching history\.\.\./);
		const malformed = screen(renderSearchResult(emptyResult("not json"), { expanded: false, isPartial: false }, theme, { isError: false }));
		assert.match(malformed, /not json/);
	});

	it("escapes controls and clips long queries in the call card", () => {
		const shown = screen(renderSearchCall({ query: `\x1b]52;c;clip\x07${"q".repeat(200)}` }, theme, { argsComplete: true }), 60);
		assert.doesNotMatch(shown, /[\x1b\x07]/);
		assert.ok(shown.includes("…"));
	});
});

describe("history_read cards", () => {
	it("names the entry and pointer", () => {
		const shown = screen(renderReadCall({ entryId: "entry-9", pointer: "/message/content/0/text", offset: 12 }, theme, { argsComplete: true }));
		assert.match(shown, /history_read · entry-9/);
		assert.match(shown, /\/message\/content\/0\/text · offset 12/);
		assert.match(screen(renderReadCall({}, theme, { argsComplete: true })), /history_read · \(entry pending\)/);
	});

	it("reads a string field and reports the page versus the total", () => {
		const sm = SessionManager.inMemory();
		const id = sessionUser(sm, "the exact stored sentence");
		const value = readHistory(sm, { entryId: id, pointer: "/message/content" });
		assert.equal(value.status, "complete");
		const view = renderReadResult(toolResult(value), { expanded: false, isPartial: false }, theme, { isError: false });
		const shown = screen(view);
		assert.match(shown, /complete · \d+ of \d+ code units/);
		assert.match(shown, /the exact stored sentence/);
		assert.doesNotMatch(shown, new RegExp(id));
		assert.equal(rows(view).length, 2);
		const expanded = screen(renderReadResult(toolResult(value), { expanded: true, isPartial: false }, theme, { isError: false }));
		assert.match(expanded, /"status": "complete"/);
		assert.match(expanded, /"totalCodeUnits"/);
	});

	it("reports UTF-16 code units for a multibyte string", () => {
		const sm = SessionManager.inMemory();
		const id = sessionUser(sm, "日本語テスト");
		const value = readHistory(sm, { entryId: id, pointer: "/message/content" });
		assert.equal(value.bytes, 18);
		assert.equal(value.totalCodeUnits, 6);
		const shown = screen(renderReadResult(toolResult(value), { expanded: false, isPartial: false }, theme, { isError: false }));
		assert.match(shown, /6 of 6 code units/);
		assert.doesNotMatch(shown, /18 of/);
	});

	it("shows a withheld reason with the expansion hint", () => {
		const withheld = emptyResult(JSON.stringify({ status: "withheld", startId: "e", reason: "Image payloads are not exposed." }));
		const view = renderReadResult(withheld, { expanded: false, isPartial: false }, theme, { isError: false });
		const shown = screen(view);
		assert.match(shown, /withheld content/);
		assert.match(shown, /Image payloads are not exposed/);
		assert.match(shown, /(?:to expand result|expand for result)/i);
		assert.equal(rows(view).length, 2);
	});

	it("reports a bounded string page with continuation", () => {
		const sm = SessionManager.inMemory();
		const id = sessionUser(sm, "x".repeat(500));
		const value = readHistory(sm, { entryId: id, pointer: "/message/content", maxBytes: 4 });
		assert.equal(value.status, "page");
		const shown = screen(renderReadResult(toolResult(value), { expanded: false, isPartial: false }, theme, { isError: false }));
		assert.match(shown, /page · \d+ of \d+ code units/);
		assert.match(shown, /continuation available/);
	});

	it("reports unknown entries and absent fields with their action", () => {
		const sm = SessionManager.inMemory();
		const id = sessionUser(sm, "body");
		const unknown = readHistory(sm, { entryId: "missing", pointer: "/message/content" });
		assert.equal(unknown.status, "unknown_entry");
		const unknownShown = screen(renderReadResult(toolResult(unknown), { expanded: false, isPartial: false }, theme, { isError: false }));
		assert.match(unknownShown, /unknown entry/);
		assert.match(unknownShown, /Use an entry ID/);
		const absent = readHistory(sm, { entryId: id, pointer: "/message/noSuchField" });
		assert.equal(absent.status, "field_absent");
		assert.match(
			screen(renderReadResult(toolResult(absent), { expanded: false, isPartial: false }, theme, { isError: false })),
			/field absent/,
		);
	});

	it("escapes controls, handles errors, and reuses the previous component", () => {
		const hostile = screen(
			renderReadResult(emptyResult(JSON.stringify({ status: "complete", startId: "e", pointer: "/x", text: "\x1b]52;c;d\x07\u202e" })),
				{ expanded: false, isPartial: false },
				theme,
				{ isError: false },
			),
		);
		assert.doesNotMatch(hostile, /[\x1b\x07\u202e]/u);
		assert.match(screen(renderReadResult(emptyResult("read failed"), { expanded: false, isPartial: false }, theme, { isError: true })), /read failed/);
		const initial = renderReadCall({ entryId: "e" }, theme, { expanded: false, argsComplete: true });
		const updated = renderReadCall({ entryId: "e" }, theme, { expanded: true, argsComplete: true, lastComponent: initial });
		assert.equal(initial, updated);
		assert.match(screen(updated), /"entryId": "e"/);
	});

	it("bounds an oversized expanded body", () => {
		const long = JSON.stringify({ status: "complete", startId: "e", text: "line\n".repeat(9000) });
		const expanded = screen(renderReadResult(emptyResult(long), { expanded: true, isPartial: false }, theme, { isError: false }), 400);
		assert.match(expanded, /Display limit; full text remains in native tool history/);
		assert.ok(expanded.length < 90_000);
	});
});

describe("history card safety", () => {
	const hostile = "safe\u009b\u202e\x1b[31m";
	it("escapes C1 and bidi controls from payload values and expanded output", () => {
		const search = emptyResult(JSON.stringify({ status: hostile, matches: [], visited: 0, next: null }));
		assert.doesNotMatch(screen(renderSearchResult(search, { expanded: false, isPartial: false }, theme, { isError: false })), /[\x1b\u009b\u202e]/u);
		const read = emptyResult(JSON.stringify({ status: "complete", startId: hostile, pointer: hostile, text: hostile }));
		assert.doesNotMatch(screen(renderReadResult(read, { expanded: false, isPartial: false }, theme, { isError: false })), /[\x1b\u009b\u202e]/u);
		assert.doesNotMatch(screen(renderReadResult(read, { expanded: true, isPartial: false }, theme, { isError: false })), /[\x1b\u009b\u202e]/u);
	});
	it("tolerates null and undefined arguments", () => {
		assert.doesNotThrow(() => renderSearchCall(null, theme, { expanded: false, argsComplete: false }));
		assert.doesNotThrow(() => renderReadCall(undefined, theme, { expanded: false, argsComplete: false }));
	});
});
