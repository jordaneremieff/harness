import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { stripVTControlCharacters } from "node:util";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { renderSearchCall, renderSearchResult } from "./presentation.ts";

const theme = { fg: (_color: string, value: string) => value, bold: (value: string) => value } as unknown as Theme;
const screen = (component: { render(width: number): readonly string[] }, width = 100) =>
	component
		.render(width)
		.map((line) => stripVTControlCharacters(line).trimEnd())
		.join("\n")
		.replace(/^\n+/, "");
const raw = (component: { render(width: number): readonly string[] }, width = 1000) =>
	component.render(width).join("\n");
const text = (value: string, details?: unknown) => ({ content: [{ type: "text" as const, text: value }], details });
const collapsed = { expanded: false, isError: false };
const expanded = { expanded: true, isError: false };

function assertFits(component: { render(width: number): readonly string[] }, widths: number[] = [20, 60, 100]): void {
	for (const width of widths)
		assert.ok(
			component.render(width).every((line) => visibleWidth(line) <= width),
			`width ${width}`,
		);
}

describe("web_search call cards", () => {
	it("names the query and adds one qualifier row for the search controls", () => {
		assert.equal(
			screen(renderSearchCall({ query: "pi coding agent" }, theme, collapsed)),
			"web_search · pi coding agent",
		);
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
		const card = renderSearchCall(
			{ query: "q", safesearch: "moderate", spellcheck: true, extra_snippets: false },
			theme,
			collapsed,
		);
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
			text("x", {
				resultCount: 1,
				moreResultsAvailable: false,
				alteredQuery: "corrected query",
				outputTruncated: true,
			}),
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
		const full = renderSearchResult(
			text("1. Result title\n   https://example.com"),
			{ expanded: true, isPartial: false },
			theme,
			expanded,
		);
		assert.match(screen(full, 400), /Result title/);
	});
});

describe("source identity before extraction mechanics", () => {
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
			text("results", {
				resultCount: 2,
				moreResultsAvailable: false,
				sources: [
					{ rank: 1, title: "One", domain: "one.dev" },
					{ rank: 2, title: "Two", domain: "two.dev" },
				],
			}),
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
		const collapsedError = renderSearchResult(text(hostile), { expanded: false, isPartial: false }, theme, {
			...collapsed,
			isError: true,
		});
		const collapsedScreen = screen(collapsedError);
		assert.equal(collapsedScreen.split("\n").length, 1);
		assert.match(collapsedScreen, /^web_search: Brave search failed: 429$/);
		assert.doesNotMatch(collapsedScreen, /second line/);
		const expandedError = renderSearchResult(text(hostile), { expanded: true, isPartial: false }, theme, {
			...expanded,
			isError: true,
		});
		const expandedScreen = screen(expandedError, 400);
		assert.match(expandedScreen, /^web_search: Brave search failed: 429$/m);
		assert.match(expandedScreen, /second line \\u\{202e\} with \\x1b\[31m controls/);
		assert.match(expandedScreen, /\u65e5\u672c\u8a9e\u306e\u8a3a\u65ad/);
		assertFits(expandedError);
	});
});

it("escapes bidi and C1 controls in expanded search arguments", () => {
	const component = renderSearchCall({ query: "a\u202eb\u009bc" }, theme, expanded);
	assert.doesNotMatch(raw(component), /\u202e|\u009b/u);
});

it("names the configured key when search arguments are clipped", () => {
	const longQuery = renderSearchCall({ query: "q".repeat(300) }, theme, { ...collapsed, keyText: () => "ctrl+o" });
	assert.match(screen(longQuery), /ctrl\+o to expand arguments/);
});
