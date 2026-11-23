import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { describe, it } from "node:test";
import { stripVTControlCharacters } from "node:util";
import {
	initTheme,
	SessionManager,
	type Theme,
	type ToolDefinition,
	ToolExecutionComponent,
} from "@earendil-works/pi-coding-agent";
import { type KeyId, type TUI, visibleWidth } from "@earendil-works/pi-tui";
import { readHistory, searchHistory, toolResult } from "./core.ts";
import { toolDisplay } from "./display.ts";
import history from "./index.ts";
import { renderReadCall, renderReadResult, renderSearchCall, renderSearchResult } from "./presentation.ts";

const theme = { fg: (_color: string, value: string) => value, bold: (value: string) => value } as unknown as Theme;
const screen = (component: { render(width: number): readonly string[] }, width = 140) =>
	component
		.render(width)
		.map((line) => stripVTControlCharacters(line).trimEnd())
		.join("\n");
const rows = (component: { render(width: number): readonly string[] }, width = 100) =>
	component
		.render(width)
		.map((line) => stripVTControlCharacters(line).trimEnd())
		.filter((line) => line !== "");
const emptyResult = (text: string) => ({ content: [{ type: "text" as const, text }], details: {} });

function registeredTools(): Map<string, ToolDefinition> {
	const tools = new Map<string, ToolDefinition>();
	history({
		registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
		events: { emit: () => {}, on: () => () => {} },
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
	const collapsed = { expanded: false, isPartial: false };
	const expanded = { ...collapsed, expanded: true };
	const context = { isError: false };

	it("names the query, filter and cursor without inventing a listing while input streams", () => {
		const args = {
			query: "amber decision",
			filter: { source: "toolResult", toolName: "bash", errorsOnly: true },
			fromId: "entry-1",
			slot: 2,
			offset: 40,
		};
		const shown = screen(renderSearchCall(args, theme, { argsComplete: true }));
		assert.match(shown, /history_search "amber decision"/u);
		assert.match(shown, /filter toolResult\(bash\) errors only · from entry-1 · continuation slot 2 offset 40/u);
		assert.equal(screen(renderSearchCall({}, theme, { argsComplete: true })), "history_search listing");
		assert.equal(screen(renderSearchCall({}, theme, { argsComplete: false })), "history_search");
		const native = { query: "x", fromId: 42, position: { message: 1, block: -1 }, offset: 0 };
		assert.match(
			screen(renderSearchCall(native, theme, { argsComplete: true })),
			/from 42 · continuation message 1 block -1 offset 0/u,
		);
	});

	it("reports complete, paged, absent, and missing-start outcomes within scope", () => {
		const sm = SessionManager.inMemory();
		const older = sessionUser(sm, "decision amber raw detail");
		const recent = sessionUser(sm, "recent amber");
		const show = (args: Record<string, unknown>) =>
			screen(renderSearchResult(toolResult(searchHistory(sm, args)), collapsed, theme, { ...context, args }));
		assert.match(show({ query: "amber" }), /2 matches; 2 entries visited; reached the end of the selected ancestry/u);
		assert.match(show({ query: "amber" }), /Retained excerpt offsets \d+\.\.\d+:\namber/u);
		assert.match(show({ query: "none" }), /0 matches; 2 entries visited; reached the end of the selected ancestry/u);
		assert.match(show({ fromId: "missing-entry" }), /start entry not found/u);
		assert.match(show({}), /2 entries returned; 2 entries visited/u);
		const args = { query: "amber", maxMatches: 1, maxVisits: 8 };
		const value = searchHistory(sm, args);
		const page = show(args);
		assert.match(page, /1 match; 1 entry visited; match limit; continuation available/u);
		assert.doesNotMatch(page, /\[Truncated:/u);
		const open = screen(renderSearchResult(toolResult(value), expanded, theme, { ...context, args }));
		const cursor = open.match(/Continue with history_search:\n(\{[\s\S]*?\n\})/u)?.[1];
		assert.ok(cursor);
		const next = JSON.parse(cursor);
		assert.equal(next.fromId, recent);
		assert.deepEqual(next, { ...args, ...(value.next as object) });
		const resumed = searchHistory(sm, next).matches as { entry: { id: string } }[];
		assert.deepEqual(
			resumed.map(({ entry }) => entry.id),
			[older],
		);
	});

	it("renders skipped argument values, the native limit and its complete exact cursor", () => {
		const args = { query: "notes\u202E.txt", mode: "arguments", maxMatches: 8 };
		const next = {
			sessionId: "s",
			fromId: 42,
			mode: "arguments",
			position: { message: 0, block: 1, path: [0, 3] },
			offset: 12,
		};
		const value = {
			status: "candidate_limit",
			visited: 1,
			skipped: { depth: 1, pointerLength: 1 },
			next,
			matches: [
				{
					entry: { id: 42, type: "message", role: "assistant" },
					call: { name: "edit", id: "call-1" },
					pointer: "/model/0/content/1/arguments/path",
					offset: 12,
					endOffset: 22,
					excerptEndOffset: 22,
					excerpt: "notes\u202E.txt",
				},
			],
		};
		const result = { ...emptyResult("typed details win"), details: value };
		const view = screen(renderSearchResult(result, collapsed, theme, { ...context, args }));
		assert.match(view, /physical candidate limit; continuation available/u);
		assert.match(view, /42 · message · assistant · call edit/u);
		assert.match(view, /\[2 argument values skipped\]/u);
		assert.doesNotMatch(view, /more lines|#42|typed details win|\u202E/u);
		const open = screen(renderSearchResult(result, expanded, theme, { ...context, args }));
		const cursor = open.match(/Continue with history_search:\n(\{[\s\S]*?\n\})/u)?.[1];
		assert.ok(cursor);
		assert.deepEqual(JSON.parse(cursor), { ...args, ...next });
		assert.match(open, /"id": "call-1"/u);
	});

	it("does not invent a count, continuation or binding, and retains real error diagnostics", () => {
		const outcome = (value: string, isError = false) =>
			screen(renderSearchResult(emptyResult(value), collapsed, theme, { isError }));
		assert.equal(outcome('{"status":"ancestry_exhausted"}').trim(), "Reached the end of the selected ancestry.");
		const gap = '{"status":"missing_parent","next":null,"gap":{"entryId":"e","action":"Use a known ID."}}';
		assert.match(outcome(gap), /parent entry missing\.\ne\n/iu);
		assert.doesNotMatch(outcome(gap), /Use a known ID/u);
		assert.match(screen(renderSearchResult(emptyResult(gap), expanded, theme, { isError: false })), /Use a known ID/u);
		assert.match(outcome('{"status":"cycle","next":null}'), /Parent cycle/u);
		assert.doesNotMatch(outcome('{"status":"cycle","next":null}'), /continuation|to expand/u);
		assert.match(
			outcome("fromId must be valid\nExact cause", true),
			/fromId must be valid\n\.\.\. \(click to expand\)/u,
		);
		assert.match(
			screen(renderSearchResult(emptyResult("fromId must be valid\nExact cause"), expanded, theme, { isError: true })),
			/Exact cause/u,
		);
		assert.match(outcome("not json"), /not json/u);
		assert.match(
			screen(renderSearchResult(emptyResult("{}"), { ...collapsed, isPartial: true }, theme, context)),
			/Searching history…/u,
		);
	});
});

describe("history_read cards", () => {
	it("names the entry and pointer", () => {
		const shown = screen(
			renderReadCall({ entryId: "entry-9", pointer: "/message/content/0/text", offset: 12 }, theme, {
				argsComplete: true,
			}),
		);
		assert.match(shown, /history_read entry-9/);
		assert.match(shown, /\/message\/content\/0\/text · offset 12/);
		assert.equal(screen(renderReadCall({}, theme, { argsComplete: true })), "history_read");
	});

	it("reads a string field and reports the page versus the total", () => {
		const sm = SessionManager.inMemory();
		const id = sessionUser(sm, "the exact stored sentence");
		const value = readHistory(sm, { entryId: id, pointer: "/message/content" });
		assert.equal(value.status, "complete");
		const view = renderReadResult(toolResult(value), { expanded: false, isPartial: false }, theme, { isError: false });
		const shown = screen(view);
		assert.match(shown, /Read the field: \d+ of \d+ code units\./);
		assert.match(shown, /the exact stored sentence/);
		assert.doesNotMatch(shown, new RegExp(id));
		assert.equal(rows(view).length, 3);
		const expanded = screen(
			renderReadResult(toolResult(value), { expanded: true, isPartial: false }, theme, { isError: false }),
		);
		assert.match(expanded, /Result details:/);
		assert.match(expanded, /"totalCodeUnits"/);
	});

	it("reports UTF-16 code units for a multibyte string", () => {
		const sm = SessionManager.inMemory();
		const id = sessionUser(sm, "日本語テスト");
		const value = readHistory(sm, { entryId: id, pointer: "/message/content" });
		assert.equal(value.bytes, 18);
		assert.equal(value.totalCodeUnits, 6);
		const shown = screen(
			renderReadResult(toolResult(value), { expanded: false, isPartial: false }, theme, { isError: false }),
		);
		assert.match(shown, /6 of 6 code units/);
		assert.doesNotMatch(shown, /18 of/);
	});

	it("shows a withheld reason with the expansion hint", () => {
		const withheld = emptyResult(
			JSON.stringify({ status: "withheld", startId: "e", reason: "Image payloads are not exposed." }),
		);
		const view = renderReadResult(withheld, { expanded: false, isPartial: false }, theme, { isError: false });
		const shown = screen(view);
		assert.match(shown, /Withheld content/);
		assert.match(shown, /Image payloads are not exposed/);
		assert.match(shown, /\.\.\. \(click to expand\)/);
		assert.doesNotMatch(shown, /more lines/);
		assert.equal(rows(view).length, 3);
	});

	it("reports a bounded string page with continuation", () => {
		const sm = SessionManager.inMemory();
		const id = sessionUser(sm, "x".repeat(500));
		const value = readHistory(sm, { entryId: id, pointer: "/message/content", maxBytes: 4 });
		assert.equal(value.status, "page");
		const shown = screen(
			renderReadResult(toolResult(value), { expanded: false, isPartial: false }, theme, { isError: false }),
		);
		assert.match(shown, /Returned a page: 4 of 500 code units; continuation at offset 4\./);
		const expanded = screen(
			renderReadResult(toolResult(value), { expanded: true, isPartial: false }, theme, { isError: false }),
		);
		assert.match(
			expanded,
			/Continue with history_read:\n\{\s*"sessionId": "[^"]+",\s*"entryId": "[^"]+",\s*"pointer": "\/message\/content",\s*"offset": 4/u,
		);
	});

	it("reports unknown entries and absent fields and keeps retry guidance in expansion", () => {
		const sm = SessionManager.inMemory();
		const id = sessionUser(sm, "body");
		const unknown = readHistory(sm, { entryId: "missing", pointer: "/message/content" });
		assert.equal(unknown.status, "unknown_entry");
		const unknownShown = screen(
			renderReadResult(toolResult(unknown), { expanded: false, isPartial: false }, theme, { isError: false }),
		);
		assert.match(unknownShown, /Entry not found/);
		assert.doesNotMatch(unknownShown, /Use an entry ID/);
		assert.match(
			screen(renderReadResult(toolResult(unknown), { expanded: true, isPartial: false }, theme, { isError: false })),
			/Use an entry ID/u,
		);
		const absent = readHistory(sm, { entryId: id, pointer: "/message/noSuchField" });
		assert.equal(absent.status, "field_absent");
		assert.match(
			screen(renderReadResult(toolResult(absent), { expanded: false, isPartial: false }, theme, { isError: false })),
			/Field absent/,
		);
	});

	it("escapes controls, handles errors, and reuses the previous component", () => {
		const hostile = screen(
			renderReadResult(
				emptyResult(JSON.stringify({ status: "complete", startId: "e", pointer: "/x", text: "\x1b]52;c;d\x07\u202e" })),
				{ expanded: false, isPartial: false },
				theme,
				{ isError: false },
			),
		);
		assert.doesNotMatch(hostile, /[\x1b\x07\u202e]/u);
		assert.match(
			screen(
				renderReadResult(emptyResult("read failed"), { expanded: false, isPartial: false }, theme, { isError: true }),
			),
			/read failed/,
		);
		const args = { entryId: "e", maxBytes: 50 };
		const initial = renderReadCall(args, theme, { expanded: false, argsComplete: true });
		const updated = renderReadCall(args, theme, {
			expanded: true,
			argsComplete: true,
			lastComponent: initial,
		});
		assert.equal(initial, updated);
		assert.match(screen(updated), /history_read e\n {2}maxBytes: 50/);
	});

	it("labels a display cap without implying another source page", () => {
		const long = JSON.stringify({ status: "complete", startId: "e", text: "line\n".repeat(9000) });
		const expanded = screen(
			renderReadResult(emptyResult(long), { expanded: true, isPartial: false }, theme, { isError: false }),
			400,
		);
		assert.match(expanded, /\[Truncated: showing 32000 of \d+ characters\]/u);
		assert.doesNotMatch(expanded, /continuation at offset/u);
		assert.ok(expanded.length < 90_000);
	});
});

describe("history_search in Pi's tool card", () => {
	it("retains numeric start and continuation IDs on an already completed card", () => {
		initTheme("dark", false);
		const args = { query: "needle", fromId: 42, maxMatches: 1 };
		const display = toolDisplay().tools.find((tool) => tool.name === "history_search");
		assert.ok(display);
		const card = new ToolExecutionComponent(
			"history_search",
			"search-history",
			args,
			undefined,
			display as ToolDefinition,
			{ requestRender() {} } as unknown as TUI,
			".",
		);
		card.setArgsComplete();
		card.updateResult({
			...toolResult({
				status: "match_limit",
				visited: 1,
				matches: [{ entry: { id: 42, kind: "pi.user" }, excerpt: "needle" }],
				next: { sessionId: "test-session", fromId: 41, position: { message: 0, block: -1 }, offset: 0 },
			}),
			isError: false,
		});
		const shown = screen(card);
		assert.match(shown, /history_search "needle"\n\s+from 42/u);
		assert.match(shown, /42 · pi.user/u);
		assert.equal(shown.match(/to expand/gu)?.length, 1);
		assert.doesNotMatch(shown, /#42|more lines/u);
		card.setExpanded(true);
		assert.match(screen(card), /Continue with history_search:[\s\S]*"maxMatches": 1,[\s\S]*"fromId": 41/u);
		assert.doesNotMatch(screen(card), /to expand/u);
	});
});

describe("history_read in Pi's tool card", () => {
	it("uses a native entry ID and one binding-aware disclosure at the actual result boundary", async (t) => {
		initTheme("dark", false);
		const nativeTui = (await import(
			createRequire(import.meta.resolve("@earendil-works/pi-coding-agent")).resolve("@earendil-works/pi-tui")
		)) as typeof import("@earendil-works/pi-tui");
		const previous = nativeTui.getKeybindings();
		t.after(() => nativeTui.setKeybindings(previous));
		const bindings = (keys: KeyId[]) =>
			nativeTui.setKeybindings(
				new nativeTui.KeybindingsManager({
					...nativeTui.TUI_KEYBINDINGS,
					"app.tools.expand": { defaultKeys: keys, description: "Expand tool output" },
				}),
			);
		bindings([]);
		const display = toolDisplay().tools.find((tool) => tool.name === "history_read");
		assert.ok(display);
		const args = { entryId: 42, pointer: "/model/0/content/0/text", maxBytes: 4096 };
		const roles = new Set<string>();
		const probe = (actual: Theme) =>
			({
				fg(role: Parameters<Theme["fg"]>[0], value: string) {
					roles.add(role);
					return actual.fg(role, value);
				},
				bold: actual.bold.bind(actual),
			}) as Theme;
		const card = new ToolExecutionComponent(
			"history_read",
			"call-history",
			args,
			undefined,
			{
				...display,
				renderCall: (input, actual, context) => display.renderCall?.(input, probe(actual), context),
				renderResult: (result, options, actual, context) =>
					display.renderResult?.(result, options, probe(actual), context),
			} as ToolDefinition,
			{ requestRender() {} } as unknown as TUI,
			".",
		);
		card.setArgsComplete();
		assert.match(screen(card), /history_read 42/u);
		assert.doesNotMatch(screen(card), /pending|to expand/u);
		bindings(["ctrl+shift+p"]);
		card.invalidate();
		assert.equal(rows(card).at(-1)?.trim(), "... (ctrl+shift+p to expand)");
		bindings([]);
		const body = `${"一".repeat(80)}\n(line 2)\n(line 3)\n(line 4)\n(line 5)\n(line 6)\n(line 7)`;
		const result = {
			content: [{ type: "text" as const, text: '{"status":"withheld","reason":"TEXT SHOULD NOT WIN"}' }],
			details: { status: "complete", text: body },
			isError: false,
		};
		card.updateResult(result);
		const width = 170;
		const collapsed = rows(card, width);
		assert.match(collapsed[0], /history_read 42/u);
		assert.equal(collapsed[1]?.trim(), args.pointer);
		assert.equal(collapsed[2]?.trim(), "Read the field.");
		assert.equal(collapsed[7]?.trim(), "(line 5)");
		assert.equal(collapsed[8]?.trim(), "... (2 more lines, click to expand)");
		assert.doesNotMatch(collapsed.join("\n"), /TEXT SHOULD NOT WIN|line [67]|maxBytes/u);
		assert.deepEqual([...roles].sort(), ["accent", "muted", "toolOutput", "toolTitle"]);

		const narrow = card.render(38);
		assert.ok(narrow.every((line) => visibleWidth(line) <= 38));
		assert.doesNotMatch(rows(card, 38).join("\n"), /\(line 2\)/u, "one wide logical line fills the visual preview");
		const clickRow = card.render(width).findIndex((line) => line.includes("click to expand"));
		assert.ok(clickRow > 0);
		assert.equal(
			card.handleMouse({
				type: "click",
				button: "left",
				x: 4,
				y: clickRow,
				screenX: 4,
				screenY: clickRow,
				width,
				height: card.render(width).length,
				shift: false,
				alt: false,
				ctrl: false,
				clickCount: 1,
			})?.handled,
			true,
		);
		const expanded = screen(card, width);
		assert.match(expanded, /\(line 7\)/u);
		assert.match(expanded, /maxBytes: 4096/u);
		assert.doesNotMatch(expanded, /to expand/u);

		bindings(["ctrl+shift+p"]);
		card.setExpanded(false);
		assert.equal(rows(card, width).at(-1)?.trim(), "... (2 more lines, ctrl+shift+p to expand)");
		assert.equal(screen(card, width).match(/to expand/gu)?.length, 1);
		roles.clear();
		card.updateResult({
			...result,
			content: [{ type: "text", text: "Source changed\nRetained cause" }],
			isError: true,
		});
		assert.match(screen(card), /Source changed/u);
		assert.doesNotMatch(screen(card), /Read the field|Retained cause/u);
		assert.ok(roles.has("error"));
		assert.ok(!roles.has("toolOutput"));
		card.setExpanded(true);
		assert.match(screen(card), /Retained cause/u);

		const ordinaryId = `entry-${"x".repeat(100)}`;
		card.updateArgs({ entryId: ordinaryId });
		card.setExpanded(false);
		assert.match(rows(card, 60)[0]?.trim() ?? "", /^history_read entry-x+…$/u);
		assert.ok(screen(card, 140).includes(ordinaryId));

		card.updateArgs({ entryId: 42, pointer: "/model/0/sections" });
		const guidance =
			"Read this pointer, or append a known child key as a JSON pointer. Opaque object keys are not enumerated.";
		card.updateResult({
			...toolResult({
				status: "structured_omitted",
				entry: { id: 42, kind: "pi.system" },
				pointer: "/model/0/sections",
				kind: "object",
				omitted: true,
				action: guidance,
			}),
			isError: false,
		});
		assert.match(screen(card), /history_read 42/u);
		assert.match(screen(card), /Structured value omitted\./u);
		assert.doesNotMatch(screen(card), /#42|Read this pointer|known child key/u);
		card.setExpanded(true);
		assert.ok(screen(card).includes(guidance));
		const next = { sessionId: "test-session", entryId: 42, pointer: "/model/0/content", offset: 4 };
		card.updateArgs({ entryId: 42, pointer: next.pointer, maxBytes: 4 });
		card.updateResult({
			...toolResult({ status: "page", text: "text", next, offset: 0, endOffset: 4, totalCodeUnits: 8 }),
			isError: false,
		});
		const cursor = screen(card).match(/Continue with history_read:\n(\s*\{[\s\S]*?\n\s*\})/u)?.[1];
		assert.ok(cursor);
		assert.deepEqual(JSON.parse(cursor), { maxBytes: 4, ...next });
	});

	it("adds no hint for a short result and counts visually hidden descriptor lines", () => {
		const options = { expanded: false, isPartial: false };
		const context = { isError: false, args: { entryId: 42 } };
		const noDetails = renderReadResult(
			{ ...emptyResult(""), details: { status: "complete", text: "Short." } },
			options,
			theme,
			context,
		);
		assert.deepEqual(rows(noDetails), ["Read the field.", "Short."]);
		const descriptors = Array.from({ length: 7 }, (_, index) => ({
			pointer: `/field${index}`,
			kind: "scalar",
			value: index,
		}));
		const manifest = { ...emptyResult(""), details: { status: "complete", items: descriptors } };
		assert.match(
			screen(renderReadResult(manifest, options, theme, context)),
			/\.\.\. \(2 more lines, click to expand\)$/u,
		);
		assert.doesNotMatch(screen(renderReadResult(manifest, options, theme, context)), /\/field5/u);
		assert.match(
			screen(renderReadResult(manifest, { ...options, expanded: true }, theme, context)),
			/\/field6 · scalar · 6/u,
		);
	});

	it("falls back to the first meaningful text line for malformed evidence", () => {
		const result = { ...emptyResult("\nOutput unavailable.\nAdditional diagnostic."), details: { status: "other" } };
		const context = { isError: false };
		assert.deepEqual(rows(renderReadResult(result, { expanded: false, isPartial: false }, theme, context)), [
			"Output unavailable.",
			"... (click to expand)",
		]);
		assert.match(
			screen(renderReadResult(result, { expanded: true, isPartial: false }, theme, context)),
			/Additional diagnostic\./u,
		);
		const sameSlice = {
			...emptyResult('{"status":"complete","text":"Retained JSON evidence"}'),
			details: { status: "complete", text: 17 },
		};
		assert.match(
			screen(renderReadResult(sameSlice, { expanded: false, isPartial: false }, theme, context)),
			/Retained JSON evidence/u,
		);
	});
});

describe("expanded history cards", () => {
	it("discloses all retained matches and distinguishes stored clipping from display clipping", () => {
		const value = {
			status: "ancestry_exhausted",
			visited: 5,
			matches: [1, 2, 3, 4, 5].map((id) => ({
				entry: { id, kind: "pi.tool-result", toolName: "bash", isError: id === 2, truncated: id === 2 },
				pointer: "/model/0/content",
				offset: id,
				endOffset: id + 2,
				excerptEndOffset: id + 300,
				excerpt: id === 5 ? `${"x".repeat(300)}retained tail` : "\x1b[31m\u202eclean excerpt",
			})),
			next: null,
		};
		const result = emptyResult(JSON.stringify(value));
		const view = screen(renderSearchResult(result, { expanded: false, isPartial: false }, theme, { isError: false }));
		assert.doesNotMatch(view, /retained tail/u);
		assert.match(view, /\.\.\. \(\d+ more lines, click to expand\)/u);
		const open = screen(
			renderSearchResult(result, { expanded: true, isPartial: false }, theme, { isError: false }),
			400,
		);
		assert.match(open, /2 · pi.tool-result · tool bash · stored error · stored source truncated/u);
		assert.match(open, /Retained excerpt offsets 5\.\.305:[\s\S]*retained tail/u);
		assert.doesNotMatch(open, /\[31m|\u202e|\[Truncated:|#2/u);
	});

	it("shows the entire safe page once before supplemental details", () => {
		const sm = SessionManager.inMemory();
		const id = sessionUser(sm, `${"x".repeat(4500)}\npage tail	with spaces`);
		const value = readHistory(sm, { entryId: id, pointer: "/message/content" });
		const shown = screen(
			renderReadResult(toolResult(value), { expanded: true, isPartial: false }, theme, { isError: false }),
			400,
		);
		assert.match(shown, /page tail {3}with spaces\nResult details:/u);
		assert.equal(shown.match(/page tail/gu)?.length, 1);
		assert.match(shown, /"role": "user"/);
		assert.match(shown, /"membership": "not_checked"/);
		assert.match(shown, /"totalCodeUnits"/);
	});

	it("lists item pointers as read evidence for manifest reads", () => {
		const value = {
			status: "complete",
			startId: 9,
			pointer: "/message/content",
			sessionId: "s",
			membership: "not_checked",
			entry: { id: 9, type: "message", role: "assistant", timestamp: "2026-11-04T10:31:05.000Z" },
			items: [
				{ pointer: "/message/content/0", kind: "block", action: "Read this pointer for details." },
				{ pointer: "/message/content/1", kind: "block" },
			],
			next: null,
		};
		const shown = screen(
			renderReadResult(emptyResult(JSON.stringify(value)), { expanded: true, isPartial: false }, theme, {
				isError: false,
			}),
			400,
		);
		assert.match(shown, /Read the field: 2 items\./);
		assert.match(shown, /\/message\/content\/0 · block/);
		assert.match(shown, /Read this pointer for details\./u);
		assert.doesNotMatch(
			screen(renderReadResult(toolResult(value), { expanded: false, isPartial: false }, theme, { isError: false })),
			/Read this pointer for details\./u,
		);
	});
});

describe("retained error diagnostics and injected hints", () => {
	it("collapses an error to one clipped line and expands the retained diagnostic", () => {
		const diagnostic =
			"history_read failed: source changed\nsecond line \u202e with \x1b[31m controls\n\u65e5\u672c\u8a9e\u306e\u8a3a\u65ad";
		const collapsedRows = rows(
			renderReadResult(emptyResult(diagnostic), { expanded: false, isPartial: false }, theme, { isError: true }),
			400,
		);
		assert.equal(collapsedRows.length, 2, "the first diagnostic line and an uncounted hint");
		assert.match(collapsedRows[0], /^history_read failed: source changed/);
		assert.doesNotMatch(collapsedRows[0], /second line/);
		assert.equal(collapsedRows[1], "... (click to expand)");
		const expandedView = screen(
			renderReadResult(emptyResult(diagnostic), { expanded: true, isPartial: false }, theme, { isError: true }),
			400,
		);
		assert.match(expandedView, /second line {2}with {2}controls/);
		assert.match(expandedView, /\u65e5\u672c\u8a9e\u306e\u8a3a\u65ad/);
	});
});

describe("history card safety", () => {
	const hostile = "safe\u009b\u202e\x1b[31m";
	it("escapes C1 and bidi controls from payload values and expanded output", () => {
		const search = emptyResult(JSON.stringify({ status: hostile, matches: [], visited: 0, next: null }));
		assert.doesNotMatch(
			screen(renderSearchResult(search, { expanded: false, isPartial: false }, theme, { isError: false })),
			/[\x1b\u009b\u202e]/u,
		);
		const read = emptyResult(JSON.stringify({ status: "complete", startId: hostile, pointer: hostile, text: hostile }));
		assert.doesNotMatch(
			screen(renderReadResult(read, { expanded: false, isPartial: false }, theme, { isError: false })),
			/[\x1b\u009b\u202e]/u,
		);
		assert.doesNotMatch(
			screen(renderReadResult(read, { expanded: true, isPartial: false }, theme, { isError: false })),
			/[\x1b\u009b\u202e]/u,
		);
	});
	it("tolerates null and undefined arguments", () => {
		assert.doesNotThrow(() => renderSearchCall(null, theme, { expanded: false, argsComplete: false }));
		assert.doesNotThrow(() => renderReadCall(undefined, theme, { expanded: false, argsComplete: false }));
	});
});
