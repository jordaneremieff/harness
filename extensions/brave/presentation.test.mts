import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { stripVTControlCharacters } from "node:util";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { renderReadCall, renderReadResult, renderSearchCall, renderSearchResult } from "./presentation.ts";

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

describe("web_read call cards", () => {
	it("names the URL and stays on one row when no other argument is set", () => {
		const card = renderReadCall({ url: "https://example.com/a" }, theme, collapsed);
		assert.equal(screen(card), "web_read · https://example.com/a");
		assertFits(card);
	});

	it("adds one qualifier row for view, find, offsets, source, and budget", () => {
		const card = renderReadCall(
			{
				url: "https://example.com/a",
				view: "links",
				find: "exact phrase",
				link_offset: 2,
				expected_source_id: "a1b2c3d4e5f6a7b8",
				max_bytes: 20000,
			},
			theme,
			collapsed,
		);
		assert.equal(
			screen(card),
			"web_read · https://example.com/a\nview links · find exact phrase · link offset 2 · source a1b2c3d4e5f6a7b8 · max bytes 20000",
		);
	});

	it("hints expansion only when the URL is clipped", () => {
		const short = renderReadCall({ url: "https://example.com/a", excerpt_offset: 3 }, theme, collapsed);
		assert.doesNotMatch(screen(short), /[Ee]xpand/);
		const long = renderReadCall({ url: `https://example.com/${"a".repeat(200)}` }, theme, collapsed);
		assert.match(screen(long), /[Ee]xpand/);
		assertFits(long);
	});

	it("shows the complete arguments when expanded", () => {
		const card = renderReadCall({ url: "https://example.com/a", view: "links" }, theme, expanded);
		assert.match(screen(card, 400), /"url": "https:\/\/example\.com\/a"/);
	});

	it("renders safely with missing, partial, and malformed arguments", () => {
		for (const value of [undefined, {}, { url: 42 }, { url: null }, [], "https://x"]) {
			const card = renderReadCall(value, theme, collapsed);
			assertFits(card);
			assert.match(screen(card), /^web_read/);
		}
		const escaped = renderReadCall({ url: "https://example.com/a\nsecond" }, theme, collapsed);
		assert.match(screen(escaped), /https:\/\/example\.com\/a\\nsecond/);
	});
});

describe("web_read result cards", () => {
	it("counts excerpts and labels their range", () => {
		const card = renderReadResult(
			text("Final URL: https://example.com/a\nexcerpts", {
				status: "readable",
				excerptCount: 3,
				excerptOffset: 2,
				nextOffset: 5,
				requestedUrl: "https://example.com/a",
				finalUrl: "https://example.com/a",
			}),
			{ expanded: false, isPartial: false },
			theme,
			{ ...collapsed, args: { url: "https://example.com/a" } },
		);
		assert.match(screen(card), /^readable · 3 excerpts \(E3\.\.E5\) · continuation/);
		assertFits(card);
	});

	it("uses the singular label for one excerpt and reports an empty read", () => {
		const single = renderReadResult(
			text("x", { status: "readable", excerptCount: 1, excerptOffset: 0, nextOffset: null }),
			{ expanded: false, isPartial: false },
			theme,
			collapsed,
		);
		assert.match(screen(single), /^readable · 1 excerpt \(E1\)/);
		const none = renderReadResult(
			text("x", { status: "readable", excerptCount: 0, excerptOffset: 0, nextOffset: null }),
			{ expanded: false, isPartial: false },
			theme,
			collapsed,
		);
		assert.match(screen(none), /^readable · 0 excerpts/);
	});

	it("states coverage bounds and a missing readable body", () => {
		const bounded = renderReadResult(
			text("x", { status: "readable", excerptCount: 1, excerptOffset: 0, nextOffset: null, extractionTruncated: true, outputTruncated: true }),
			{ expanded: false, isPartial: false },
			theme,
			collapsed,
		);
		assert.match(screen(bounded), /extraction truncated · output truncated/);
		const empty = renderReadResult(text("x", { status: "no-readable-text" }), { expanded: false, isPartial: false }, theme, collapsed);
		assert.match(screen(empty), /^no readable text($|\n)/);
	});

	it("shows a redirect target only when the final URL differs", () => {
		const same = renderReadResult(
			text("x", { status: "readable", excerptCount: 1, requestedUrl: "https://example.com/a", finalUrl: "https://example.com/a" }),
			{ expanded: false, isPartial: false },
			theme,
			collapsed,
		);
		assert.doesNotMatch(screen(same), /→/);
		const moved = renderReadResult(
			text("x", { status: "readable", excerptCount: 1, requestedUrl: "https://example.com/a", finalUrl: "https://example.com/final" }),
			{ expanded: false, isPartial: false },
			theme,
			collapsed,
		);
		assert.match(screen(moved), /→ https:\/\/example\.com\/final/);
	});

	it("counts links and states the budget the next record needs", () => {
		const card = renderReadResult(
			text("links", { view: "links", linkCount: 2, linkOffset: 0, nextOffset: 4, requiredMaxBytes: 20000, extractionTruncated: true }),
			{ expanded: false, isPartial: false },
			theme,
			collapsed,
		);
		assert.match(screen(card), /^2 links · continuation · extraction truncated · next record needs max_bytes 20000($|\n)/);
	});

	it("does not invent an excerpt range for a find result", () => {
		const card = renderReadResult(
			text("x", { status: "readable", find: { query: "phrase", firstMatchOffset: 2 }, excerptCount: 1, excerptOffset: 0, nextOffset: null }),
			{ expanded: false, isPartial: false },
			theme,
			collapsed,
		);
		assert.match(screen(card), /^readable · 1 matching excerpt · first E3/);
		assert.ok(!screen(card).includes("E1"));
		const none = renderReadResult(
			text("x", { status: "readable", find: { query: "phrase", firstMatchOffset: null }, excerptCount: 0, excerptOffset: 0, nextOffset: null }),
			{ expanded: false, isPartial: false },
			theme,
			collapsed,
		);
		assert.match(screen(none), /^readable · 0 matching excerpts/);
	});

	it("escapes bidi and C1 controls in collapsed and expanded text", () => {
		const hostile = "a\u202eb\u009bc";
		const call = renderReadCall({ url: `https://example.com/${hostile}` }, theme, expanded);
		assert.ok(!raw(call).includes("\u202e"));
		assert.ok(!raw(call).includes("\u009b"));
		assert.match(screen(call, 1000), /\\u\{202e\}/);
		assert.match(screen(call, 1000), /\\x9b/);
		const search = renderSearchCall({ query: hostile }, theme, expanded);
		assert.ok(!raw(search).includes("\u202e"));
		assert.ok(!raw(search).includes("\u009b"));
		const result = renderReadResult(text(`body ${hostile}`), { expanded: true, isPartial: false }, theme, expanded);
		assert.ok(!raw(result).includes("\u202e"));
		assert.ok(!raw(result).includes("\u009b"));
		assert.match(screen(result, 1000), /\\u\{202e\}/);
	});

	it("styles errors and partial results and shows a full result when expanded", () => {
		const error = renderReadResult(text("Web reader links view refuses XHTML"), { expanded: false, isPartial: false }, theme, {
			...collapsed,
			isError: true,
		});
		assert.equal(screen(error), "web_read: Web reader links view refuses XHTML");
		const partial = renderReadResult(text(""), { expanded: false, isPartial: true }, theme, collapsed);
		assert.equal(screen(partial), "Reading the page...");
		const full = renderReadResult(text("readable body text"), { expanded: true, isPartial: false }, theme, expanded);
		assert.match(screen(full, 400), /readable body text/);
	});
});

describe("web_search call cards", () => {
	it("names the query and adds one qualifier row for the search controls", () => {
		assert.equal(screen(renderSearchCall({ query: "pi coding agent" }, theme, collapsed)), "web_search · pi coding agent");
		const card = renderSearchCall(
			{
				query: "pi coding agent",
				count: 20,
				offset: 1,
				country: "US",
				search_lang: "en",
				freshness: "pw",
				safesearch: "strict",
				extra_snippets: true,
				spellcheck: false,
			},
			theme,
			collapsed,
		);
		assert.equal(
			screen(card, 400).split("\n")[1],
			"count 20 · offset 1 · country US · lang en · freshness pw · safesearch strict · extra snippets · spellcheck off",
		);
	});

	it("omits non-default qualifiers that carry no information", () => {
		const card = renderSearchCall({ query: "q", safesearch: "moderate", spellcheck: true, extra_snippets: false }, theme, collapsed);
		assert.equal(screen(card), "web_search · q");
	});

	it("hints expansion only when the query is clipped", () => {
		const long = renderSearchCall({ query: "q".repeat(300) }, theme, collapsed);
		assert.match(screen(long), /[Ee]xpand/);
		assertFits(long);
	});

	it("renders safely with missing and malformed arguments", () => {
		for (const value of [undefined, {}, { query: 7 }, { query: null }, []]) {
			const card = renderSearchCall(value, theme, collapsed);
			assertFits(card);
			assert.match(screen(card), /^web_search/);
		}
	});
});

describe("web_search result cards", () => {
	it("counts results and marks more pages available", () => {
		const card = renderSearchResult(
			text("results", { resultCount: 10, moreResultsAvailable: true, nextOffset: 1 }),
			{ expanded: false, isPartial: false },
			theme,
			collapsed,
		);
		assert.match(screen(card), /^10 results · more available/);
		assertFits(card);
	});

	it("uses the singular and reports an altered query and truncation", () => {
		const one = renderSearchResult(
			text("x", { resultCount: 1, moreResultsAvailable: false, alteredQuery: "corrected query", outputTruncated: true }),
			{ expanded: false, isPartial: false },
			theme,
			collapsed,
		);
		assert.match(screen(one), /^1 result · altered query corrected query · output truncated/);
	});

	it("styles errors and partial results and shows a full result when expanded", () => {
		const error = renderSearchResult(text("Brave search failed: 429"), { expanded: false, isPartial: false }, theme, {
			...collapsed,
			isError: true,
		});
		assert.equal(screen(error), "web_search: Brave search failed: 429");
		const partial = renderSearchResult(text(""), { expanded: false, isPartial: true }, theme, collapsed);
		assert.equal(screen(partial), "Searching the web...");
		const full = renderSearchResult(text("1. Result title\n   https://example.com"), { expanded: true, isPartial: false }, theme, expanded);
		assert.match(screen(full, 400), /Result title/);
	});
});
