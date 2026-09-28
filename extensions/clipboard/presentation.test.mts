import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { stripVTControlCharacters } from "node:util";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
	renderCopyCall,
	renderCopyResult,
	renderGetCall,
	renderGetResult,
	renderListCall,
	renderListResult,
	renderPasteCall,
	renderPasteResult,
	renderRestoreCall,
	renderRestoreResult,
} from "./presentation.ts";

const theme = { fg: (_color: string, value: string) => value, bold: (value: string) => value } as unknown as Theme;
const screen = (component: { render(width: number): string[] }, width = 100) =>
	component.render(width).map((line) => stripVTControlCharacters(line).trimEnd()).join("\n").replace(/^\n+/, "");
const raw = (component: { render(width: number): string[] }, width = 1000) => component.render(width).join("\n");
const text = (value: string, details?: unknown) => ({ content: [{ type: "text" as const, text: value }], details });
const collapsed = { expanded: false, isError: false };
const expanded = { expanded: true, isError: false };

function assertFits(component: { render(width: number): string[] }, widths: number[] = [20, 60, 100]): void {
	for (const width of widths)
		assert.ok(
			component.render(width).every((line) => visibleWidth(line) <= width),
			`width ${width}`,
		);
}

const SECRET = "rollback-draft-secret-body";

describe("clipboard_copy cards", () => {
	it("shows label and size at the call, never the copied content", () => {
		const card = renderCopyCall({ content: SECRET, label: "rollback" }, theme, { ...collapsed, argsComplete: true });
		const rendered = screen(card);
		assert.match(rendered, /^clipboard_copy · rollback/);
		assert.match(rendered, /26 UTF-16 code units · [Ee]xpand/);
		assert.ok(!rendered.includes(SECRET));
		assertFits(card);
	});

	it("does not claim a size while the content still streams", () => {
		const card = renderCopyCall({ content: SECRET }, theme, { ...collapsed, argsComplete: false });
		const rendered = screen(card);
		assert.match(rendered, /content pending/);
		assert.ok(!rendered.includes(SECRET));
	});

	it("shows the copied content only when the arguments are expanded", () => {
		const card = renderCopyCall({ content: SECRET, label: "rollback" }, theme, { ...expanded, argsComplete: true });
		assert.match(screen(card, 400), /rollback-draft-secret-body/);
	});

	it("escapes bidi and C1 controls in collapsed and expanded text", () => {
		const hostile = "a\u202eb\u009bc";
		const call = renderCopyCall({ content: hostile, label: "l" }, theme, { ...expanded, argsComplete: true });
		assert.ok(!raw(call).includes("\u202e"));
		assert.ok(!raw(call).includes("\u009b"));
		assert.match(screen(call, 1000), /\\u202e/);
		assert.match(screen(call, 1000), /\\x9b/);
		const result = renderCopyResult(text(`body ${hostile}`), { expanded: true, isPartial: false }, theme, expanded);
		assert.ok(!raw(result).includes("\u202e"));
		assert.ok(!raw(result).includes("\u009b"));
		const list = renderListCall({ query: hostile }, theme, expanded);
		assert.ok(!raw(list).includes("\u202e"));
		assert.ok(!raw(list).includes("\u009b"));
	});

	it("reports size and id without the preview", () => {
		const card = renderCopyResult(
			text(`Copied to clipboard | rollback (1 lines, 26 chars)\nPreview: ${SECRET}`, { lines: 1, chars: 26, id: "entry-1" }),
			{ expanded: false, isPartial: false },
			theme,
			collapsed,
		);
		const rendered = screen(card);
		assert.match(rendered, /^copied 26 chars · 1 lines · id entry-1/);
		assert.ok(!rendered.includes(SECRET));
		assertFits(card);
	});

	it("appends a warning when the archive write failed", () => {
		const card = renderCopyResult(
			text("Copied to clipboard (1 lines, 26 chars)\nWarning: archive write failed: disk full", {
				lines: 1,
				chars: 26,
				archiveError: "disk full is not available",
			}),
			{ expanded: false, isPartial: false },
			theme,
			collapsed,
		);
		assert.match(screen(card), /archive write failed: disk full/);
	});

	it("styles the error and partial states", () => {
		const error = renderCopyResult(text("pbcopy failed: not found"), { expanded: false, isPartial: false }, theme, {
			...collapsed,
			isError: true,
		});
		assert.equal(screen(error), "clipboard_copy: pbcopy failed: not found");
		const partial = renderCopyResult(text(""), { expanded: false, isPartial: true }, theme, collapsed);
		assert.equal(screen(partial), "Copying to the clipboard...");
	});
});

describe("clipboard_paste cards", () => {
	it("names only the page bounds at the call", () => {
		assert.equal(screen(renderPasteCall({}, theme, collapsed)), "clipboard_paste");
		const bounded = renderPasteCall({ offset: 8000, max_chars: 100 }, theme, collapsed);
		assert.equal(screen(bounded), "clipboard_paste\noffset 8000 · max 100");
	});

	it("summarizes the page without pasted content", () => {
		const card = renderPasteResult(
			text(`Clipboard contents (2 lines, 30 characters):\n\n${SECRET}`, { lines: 2, chars: 30, offset: 8000 }),
			{ expanded: false, isPartial: false },
			theme,
			{ ...collapsed, args: { offset: 8000 } },
		);
		const rendered = screen(card);
		assert.match(rendered, /^clipboard 30 chars · 2 lines/);
		assert.ok(!rendered.includes(SECRET));
		assertFits(card);
	});

	it("flags an empty clipboard and a continuation page", () => {
		const empty = renderPasteResult(text("Clipboard is empty.", { lines: 0, chars: 0 }), { expanded: false, isPartial: false }, theme, {
			...collapsed,
			args: {},
		});
		assert.equal(screen(empty), "clipboard is empty");
		const continued = renderPasteResult(text("Clipboard contents (2 lines, 30 characters): x", { lines: 2, chars: 30, nextOffset: 20 }), { expanded: false, isPartial: false }, theme, collapsed);
		assert.match(screen(continued), /continuation offset 20/);
	});

	it("styles the error and partial states", () => {
		const error = renderPasteResult(text("pbpaste failed"), { expanded: false, isPartial: false }, theme, {
			...collapsed,
			isError: true,
		});
		assert.equal(screen(error), "clipboard_paste: pbpaste failed");
		const partial = renderPasteResult(text(""), { expanded: false, isPartial: true }, theme, collapsed);
		assert.equal(screen(partial), "Reading the clipboard...");
	});
});

describe("clipboard_list cards", () => {
	it("names the query and its bounds at the call", () => {
		const card = renderListCall({ query: "rollback instructions", date: "2026-01-02", limit: 5 }, theme, collapsed);
		assert.equal(screen(card), "clipboard_list · query rollback instructions\ndate 2026-01-02 · limit 5");
		assert.equal(screen(renderListCall({ date: "2026-01-02" }, theme, collapsed)), "clipboard_list · 2026-01-02");
	});

	it("counts recent entries and marks more available", () => {
		const card = renderListResult(text("Clipboard history (10+ entries, newest first):\n- ...", { count: 10, hasMore: true }), { expanded: false, isPartial: false }, theme, {
			...collapsed,
			args: {},
		});
		assert.match(screen(card), /^10 entries · more available/);
		const single = renderListResult(text("Clipboard history (1 entries): x", { count: 1, hasMore: false }), { expanded: false, isPartial: false }, theme, {
			...collapsed,
			args: {},
		});
		assert.match(screen(single), /^1 entry/);
	});

	it("counts query matches and states scan limits", () => {
		const paging = renderListResult(text("{}", { count: 3, hasMore: true, nextCursor: "next-page" }), { expanded: false, isPartial: false }, theme, {
			...collapsed,
			args: { query: "rollback" },
		});
		assert.match(screen(paging), /^3 matches · more available \(not absence\) · continuation/);
		const complete = renderListResult(text("{}", { count: 3, hasMore: false }), { expanded: false, isPartial: false }, theme, {
			...collapsed,
			args: { query: "rollback" },
		});
		assert.match(screen(complete), /^3 matches · end of scan/);
	});

	it("styles the error and partial states", () => {
		const error = renderListResult(text("cursor requires the original query"), { expanded: false, isPartial: false }, theme, {
			...collapsed,
			isError: true,
		});
		assert.equal(screen(error), "clipboard_list: cursor requires the original query");
		const partial = renderListResult(text(""), { expanded: false, isPartial: true }, theme, collapsed);
		assert.equal(screen(partial), "Listing clipboard history...");
	});
});

describe("clipboard_get cards", () => {
	it("names the entry and page bounds at the call", () => {
		const card = renderGetCall({ id: "entry-1", date: "2026-01-02", offset: 20, max_chars: 500 }, theme, collapsed);
		assert.equal(screen(card), "clipboard_get · entry-1\ndate 2026-01-02 · offset 20 · max 500");
	});

	it("summarizes the entry without its text", () => {
		const card = renderGetResult(
			text(`Entry entry-1 (2 lines, 30 characters, 2026-01-02T00:00:00Z):\n\n${SECRET}`, { lines: 2, chars: 30, offset: 20 }),
			{ expanded: false, isPartial: false },
			theme,
			{ ...collapsed, args: { id: "entry-1", offset: 20 } },
		);
		const rendered = screen(card);
		assert.match(rendered, /^30 chars · 2 lines/);
		assert.ok(!rendered.includes(SECRET));
		assertFits(card);
	});

	it("styles the error and partial states", () => {
		const error = renderGetResult(text('no clipboard entry with id "entry-9"'), { expanded: false, isPartial: false }, theme, {
			...collapsed,
			isError: true,
		});
		assert.match(screen(error), /clipboard_get: no clipboard entry/);
		const partial = renderGetResult(text(""), { expanded: false, isPartial: true }, theme, collapsed);
		assert.equal(screen(partial), "Reading the entry...");
	});
});

describe("clipboard_restore cards", () => {
	it("names the entry at the call and reports the new size without repeating the id", () => {
		const call = renderRestoreCall({ id: "entry-1", date: "2026-01-02" }, theme, collapsed);
		assert.equal(screen(call), "clipboard_restore · entry-1\ndate 2026-01-02");
		const result = renderRestoreResult(
			text("Restored entry-1 to clipboard (2 lines, 30 chars).", { lines: 2, chars: 30 }),
			{ expanded: false, isPartial: false },
			theme,
			{ ...collapsed, args: { id: "entry-1" } },
		);
		assert.equal(screen(result), "restored · 30 chars · 2 lines");
	});

	it("surfaces an archive warning and styles errors", () => {
		const warned = renderRestoreResult(
			text("Restored entry-1 to clipboard (2 lines, 30 chars). Warning: archive write failed: disk full", {
				lines: 2,
				chars: 30,
				archiveError: "disk full is not available",
			}),
			{ expanded: false, isPartial: false },
			theme,
			collapsed,
		);
		assert.match(screen(warned), /archive write failed: disk full/);
		const error = renderRestoreResult(text("pbcopy failed"), { expanded: false, isPartial: false }, theme, {
			...collapsed,
			isError: true,
		});
		assert.equal(screen(error), "clipboard_restore: pbcopy failed");
	});
});

describe("clipboard card robustness", () => {
	it("escapes controls and clips long values", () => {
		const id = `\u0007${"y".repeat(300)}`;
		const card = renderGetCall({ id }, theme, collapsed);
		const rendered = screen(card, 1000);
		assert.ok(!rendered.includes("\u0007"));
		assert.match(rendered, /\\x07y{90,}…/);
		assertFits(card);
	});

	it("renders with missing, partial, and malformed arguments and details", () => {
		const cards = [
			renderCopyCall(undefined, theme, { ...collapsed, argsComplete: false }),
			renderCopyCall({ content: 5, label: null }, theme, collapsed),
			renderPasteCall([], theme, collapsed),
			renderListCall({ query: 7, limit: "5" }, theme, collapsed),
			renderGetCall({ id: null }, theme, collapsed),
			renderRestoreCall("entry-1", theme, collapsed),
			renderCopyResult(text("x", "bad"), { expanded: false, isPartial: false }, theme, collapsed),
			renderPasteResult(text("", { lines: "two" }), { expanded: false, isPartial: false }, theme, collapsed),
			renderListResult(text("", []), { expanded: false, isPartial: false }, theme, collapsed),
			renderGetResult(text("x", null), { expanded: false, isPartial: false }, theme, collapsed),
			renderRestoreResult(text("x", { chars: "n" }), { expanded: false, isPartial: false }, theme, collapsed),
		];
		for (const card of cards) {
			assertFits(card);
			assert.ok(screen(card).length > 0);
		}
	});

	it("bounds the expanded result text", () => {
		const long = "line\n".repeat(9000);
		const card = renderPasteResult(text(long), { expanded: true, isPartial: false }, theme, expanded);
		assert.match(screen(card, 4000), /Display limit\. The full text remains in the native tool history\./);
	});
});
