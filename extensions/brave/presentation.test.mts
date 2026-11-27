import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { it, type TestContext } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { defineTool, initTheme, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { obj } from "@earendil-works/pi-schema";
import { type KeyId, type TUI, visibleWidth } from "@earendil-works/pi-tui";
import { toolDisplay } from "./display.ts";
import { formatSearchResults } from "./format.ts";

const requirePi = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"));
const tui: typeof import("@earendil-works/pi-tui") = await import(requirePi.resolve("@earendil-works/pi-tui"));
const ui = { requestRender() {} } as unknown as TUI;
const display = toolDisplay().tools.find((tool) => tool.name === "web_search");
assert.ok(display);
const definition = defineTool({
	...display,
	label: "Brave web search",
	description: "Display fixture",
	parameters: obj({}, { open: true }),
	async execute() {
		throw new Error("Display fixture must not execute");
	},
});

function theme(t: TestContext, keys: KeyId | KeyId[] = "ctrl+g") {
	initTheme("dark", false);
	const previous = tui.getKeybindings();
	tui.setKeybindings(
		new tui.KeybindingsManager({
			...tui.TUI_KEYBINDINGS,
			"app.tools.expand": { defaultKeys: keys, description: "Expand tool output" },
		}),
	);
	t.after(() => tui.setKeybindings(previous));
}

function card(args: Record<string, unknown> = { query: "parsers" }) {
	const component = new ToolExecutionComponent("web_search", "fixture", args, { outputPad: 1 }, definition, ui, ".");
	component.setArgsComplete();
	return component;
}

function screen(component: ToolExecutionComponent, width = 120): string {
	return component
		.render(width)
		.map((row) => stripVTControlCharacters(row).trim())
		.filter(Boolean)
		.join("\n");
}

function result(text: string, details?: unknown, isError = false) {
	return { content: [{ type: "text" as const, text }], details, isError };
}

it("summarises the search page and discloses ranked records, correction and continuation", (t) => {
	theme(t);
	const request = { query: "parsers", count: 2, offset: 1, country: "US", spellcheck: false };
	const component = card(request);
	assert.equal(screen(component), "web_search parsers\n... (ctrl+g to expand)");
	const formatted = formatSearchResults(
		{
			originalQuery: "parsers",
			alteredQuery: "parser",
			moreResultsAvailable: true,
			results: [
				{ title: "Ranked first", url: "https://example.org/1", description: "First snippet", extraSnippets: [] },
				{ title: "Ranked second", url: "https://example.org/2", description: "Second snippet", extraSnippets: [] },
			],
		},
		request,
	);
	component.updateResult(result(formatted.text, { ...request, resultCount: 2, alteredQuery: "parser", nextOffset: 2 }));
	const collapsed = screen(component);
	assert.equal(
		collapsed,
		"web_search parsers\nFound 2 matches on search page 2; more results follow.\n... (ctrl+g to expand)",
	);
	component.setExpanded(true);
	const expanded = screen(component, 160);
	assert.match(expanded, /corrected query parser · count 2 · offset 1 · country US · spellcheck off/);
	assert.match(expanded, /1\. Ranked first[\s\S]*First snippet[\s\S]*2\. Ranked second[\s\S]*Second snippet/);
	assert.ok(expanded.includes(`web_search ${JSON.stringify({ ...request, offset: 2 })}`));
	assert.doesNotMatch(expanded, /to expand/);
	component.setExpanded(false);
	component.updateResult(result(formatted.text));
	assert.match(screen(component), /Search records are available\.\n\.\.\. \(ctrl\+g to expand\)$/);
	assert.doesNotMatch(screen(component), /Brave Search used|Repeat the search|Ranked first/);
	component.setExpanded(true);
	assert.match(screen(component), /1\. Ranked first/);
});

it("preserves the formatter's labels and page wording in expanded results", (t) => {
	theme(t);
	const request = { query: "railway maps", count: 3 };
	const component = card(request);
	const title = "Railway maps: diagrams of coastal stations and junctions from the district archives";
	const url = "https://example.org/railway-maps";
	const description = "A collection of track maps and station diagrams from the coastal district.";
	const formatted = formatSearchResults(
		{
			originalQuery: request.query,
			moreResultsAvailable: true,
			results: [
				{ title, url, description, extraSnippets: [] },
				{
					title: "URL: a page title",
					url: "https://example.org/Snippet:%20archive",
					description: "Snippet: page-origin copy with URL: inside it",
					extraSnippets: [],
				},
			],
		},
		request,
	);
	const retained = result(formatted.text, { ...request, resultCount: 2, offset: 0, nextOffset: 1 });
	component.updateResult(retained);
	assert.doesNotMatch(screen(component, 100), /1\. Railway maps|example\.org|Snippet:/);
	assert.match(screen(component, 60), /\(ctrl\+g to expand\)/);
	component.setExpanded(true);
	const expanded = screen(component);
	assert.ok(expanded.includes(`1. ${title}\nURL: ${url}\nSnippet: ${description}`));
	assert.match(expanded, /URL: https:\/\/example\.org\/Snippet:%20archive/);
	assert.match(expanded, /Snippet: Snippet: page-origin copy with URL: inside it/);
	assert.equal(retained.content[0].text, formatted.text);
});

it("adds optional match evidence only in the expanded view", (t) => {
	theme(t);
	const request = { query: "parsers", extra_snippets: true };
	const component = card(request);
	const update = (extraSnippets: string[]) => {
		const { text } = formatSearchResults(
			{
				originalQuery: request.query,
				moreResultsAvailable: false,
				results: [
					{
						title: "Ranked first",
						url: "https://example.org/source",
						age: "2 days ago",
						description: "Published: wording from the source",
						extraSnippets,
					},
				],
			},
			request,
		);
		component.updateResult(result(text, { resultCount: 1, offset: 0 }));
	};
	const excerpt = "Additional excerpts: wording from the source";
	update([excerpt, "Second excerpt"]);
	assert.match(screen(component), /\.\.\. \(ctrl\+g to expand\)$/);
	assert.doesNotMatch(screen(component), /Ranked first|2 days ago|Additional excerpts|Second excerpt/);
	component.setExpanded(true);
	assert.match(screen(component), /^Published: 2 days ago$/m);
	assert.match(
		screen(component),
		/^Additional excerpts:\n- Additional excerpts: wording from the source\n- Second excerpt$/m,
	);
	assert.doesNotMatch(screen(component), /to expand/);
});

it("distinguishes no matches, exhausted search pages, and actual producer errors", (t) => {
	theme(t);
	const component = card();
	component.updateResult(
		result("Brave Search results for parsers:\n\nNo web results found.", { resultCount: 0, offset: 0 }),
	);
	assert.match(screen(component), /No matches on search page 1\./);
	assert.doesNotMatch(screen(component), /Brave Search results|to expand/);
	component.updateResult(
		result("Brave Search results:\n\n1. Match", { resultCount: 1, offset: 9, moreResultsAvailable: true }),
	);
	assert.match(screen(component), /Found 1 match on search page 10; search page limit reached\./);
	assert.doesNotMatch(screen(component), /more results follow|1\. Match/);
	assert.match(screen(component), /\.\.\. \(ctrl\+g to expand\)$/);
	component.updateResult(result("1. Evidence", { resultCount: 1, offset: 0, outputTruncated: true }));
	assert.match(screen(component), /Found 1 match on search page 1\. · search output shortened/);
	component.updateResult(result("Brave Search returned HTTP 429", { resultCount: 0 }, true));
	assert.match(screen(component), /Brave Search returned HTTP 429/);
	assert.doesNotMatch(screen(component), /No matches|to expand/);
});

it("clips to Pi width, uses one hint after progress, and bounds a single long body line", (t) => {
	theme(t);
	const component = card({
		query: "parsers",
		country: "US",
		freshness: "2025-01-01to2026-01-01",
		extra_snippets: true,
	});
	assert.equal(screen(component, 55), "web_search parsers\n... (ctrl+g to expand)");
	component.updateResult(result(""), true);
	assert.match(screen(component, 55), /Searching the web…\n\.\.\. \(ctrl\+g to expand\)$/);
	assert.equal(screen(component, 55).match(/to expand/g)?.length, 1);
	component.updateResult(result(`Search header\n\n1. ${"X".repeat(32_001)}\u202e\x1b[31mTAIL`, { resultCount: 1 }));
	assert.equal(screen(component, 50).split("\n").length, 3);
	assert.doesNotMatch(screen(component, 50), /XXX|Truncated/);
	for (const row of component.render(50)) {
		assert.ok(visibleWidth(row) <= 50);
		assert.doesNotMatch(row, /\x1b\[0m/);
	}
	component.setExpanded(true);
	assert.match(screen(component), /\[Truncated: showing 32000 of/);
	assert.doesNotMatch(screen(component), /TAIL|\u202e|\[31m|to expand/);
});

it("escapes format controls without changing a continuation query", (t) => {
	theme(t);
	const query = "join👩‍💻";
	const component = card({ query });
	component.updateResult(result("1. Evidence", { query, resultCount: 1, nextOffset: 1, count: 10 }));
	component.setExpanded(true);
	const expanded = screen(component);
	const call = expanded.split("\n").find((line) => line.startsWith("web_search {"));
	assert.ok(call);
	assert.equal(JSON.parse(call.slice("web_search ".length)).query, query);
	assert.doesNotMatch(expanded, /\u200d/);
});

it("does not offer a pre-result click without a bound key", (t) => {
	theme(t, []);
	const component = card({ query: "long ".repeat(40) });
	assert.doesNotMatch(screen(component), /to expand/);
	component.updateResult(result("Brave Search cancelled.", undefined, true));
	assert.match(screen(component), /\.\.\. \(click to expand\)$/);
});
