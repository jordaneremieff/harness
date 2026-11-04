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
		assert.match(screen(card), /^example\.com\nreadable · 3 excerpts \(E3\.\.E5\) · continuation/);
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

describe("source identity before extraction mechanics", () => {
	it("leads the web_read card with the page title and domain", () => {
		const card = renderReadResult(
			text("body", { status: "readable", excerptCount: 1, title: "Example \u2014 A Page", requestedUrl: "https://example.com/a", finalUrl: "https://example.com/a" }),
			{ expanded: false, isPartial: false },
			theme,
			collapsed,
		);
		assert.equal(screen(card).split("\n")[0], "Example \u2014 A Page · example.com");
		assert.match(screen(card).split("\n")[1] ?? "", /^readable · 1 excerpt/);
		assertFits(card);
	});

	it("keeps a missing title to the domain alone and cleans control characters", () => {
		const card = renderReadResult(
			text("body", { status: "readable", excerptCount: 1, title: "bad\u202etitle", finalUrl: "https://example.com/x" }),
			{ expanded: false, isPartial: false },
			theme,
			collapsed,
		);
		assert.equal(screen(card).split("\n")[0], "bad title · example.com");
	});

	it("lists ranked source identities before the web_search outcome row", () => {
		const card = renderSearchResult(
			text("results", {
				resultCount: 5,
				moreResultsAvailable: true,
				offset: 1,
				sources: [
					{ rank: 11, title: "Alpha", domain: "a.com" },
					{ rank: 12, title: "Beta \u65e5\u672c\u8a9e", domain: "b.org" },
					{ rank: 13, title: "Gamma", domain: "c.io" },
				],
			}),
			{ expanded: false, isPartial: false },
			theme,
			collapsed,
		);
		const lines = screen(card).split("\n");
		assert.equal(lines[0], "#11 · Alpha · a.com");
		assert.equal(lines[1], "#12 · Beta \u65e5\u672c\u8a9e · b.org");
		assert.equal(lines[2], "#13 · Gamma · c.io");
		assert.match(lines[3] ?? "", /^5 results · more available · 2 more sources in detail · page 2$/);
		assertFits(card);
	});

	it("shows every source when the page is short and no result is omitted", () => {
		const card = renderSearchResult(
			text("results", { resultCount: 2, moreResultsAvailable: false, sources: [{ rank: 1, title: "One", domain: "one.dev" }, { rank: 2, title: "Two", domain: "two.dev" }] }),
			{ expanded: false, isPartial: false },
			theme,
			collapsed,
		);
		assert.doesNotMatch(screen(card), /more sources in detail/);
		assert.match(screen(card).split("\n")[2] ?? "", /^2 results/);
	});
});

describe("retained error diagnostics", () => {
	const hostile = `Brave search failed: 429\nsecond line \u202e with \x1b[31m controls\n\u65e5\u672c\u8a9e\u306e\u8a3a\u65ad https://example.com/very/long/path/that/keeps/going`;

	it("collapses an error to its first line and expands the retained diagnostic", () => {
		const collapsedError = renderSearchResult(text(hostile), { expanded: false, isPartial: false }, theme, { ...collapsed, isError: true });
		const collapsedScreen = screen(collapsedError);
		assert.equal(collapsedScreen.split("\n").length, 1);
		assert.match(collapsedScreen, /^web_search: Brave search failed: 429$/);
		assert.doesNotMatch(collapsedScreen, /second line/);
		const expandedError = renderSearchResult(text(hostile), { expanded: true, isPartial: false }, theme, { ...expanded, isError: true });
		const expandedScreen = screen(expandedError, 400);
		assert.match(expandedScreen, /^web_search: Brave search failed: 429$/m);
		assert.match(expandedScreen, /second line \\u\{202e\} with \\x1b\[31m controls/);
		assert.match(expandedScreen, /\u65e5\u672c\u8a9e\u306e\u8a3a\u65ad/);
		assertFits(expandedError);
	});

	it("expands a web_read error across lines without a second row when collapsed", () => {
		const diagnostic = "Web reader refused the URL\nbecause the host is private";
		const collapsedError = renderReadResult(text(diagnostic), { expanded: false, isPartial: false }, theme, { ...collapsed, isError: true });
		assert.equal(screen(collapsedError), "web_read: Web reader refused the URL");
		const expandedError = renderReadResult(text(diagnostic), { expanded: true, isPartial: false }, theme, { ...expanded, isError: true });
		assert.match(screen(expandedError, 200), /because the host is private/);
	});
});

describe("host-injected expansion hints", () => {
	it("names the configured key when the host supplies keyText", () => {
		const card = renderReadResult(
			text("body", { status: "readable", excerptCount: 1, nextOffset: 2 }),
			{ expanded: false, isPartial: false },
			theme,
			{ ...collapsed, keyText: () => "ctrl+o" },
		);
		assert.match(screen(card), /ctrl\+o to expand result/);
	});

	it("uses neutral wording when no binding is supplied", () => {
		const card = renderReadResult(
			text("body", { status: "readable", excerptCount: 1, nextOffset: 2 }),
			{ expanded: false, isPartial: false },
			theme,
			collapsed,
		);
		assert.match(screen(card), /Expand for full result/);
		const longQuery = renderSearchCall({ query: "q".repeat(300) }, theme, { ...collapsed, keyText: () => "ctrl+o" });
		assert.match(screen(longQuery), /ctrl\+o to expand arguments/);
	});
});
