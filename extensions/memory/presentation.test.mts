import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { stripVTControlCharacters } from "node:util";
import type { AgentToolResult, Theme, ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { renderCall, renderResult } from "./presentation.ts";

const theme = { fg: (_color: string, value: string) => value, bold: (value: string) => value } as unknown as Theme;
const colorTheme = {
	fg: (color: string, value: string) => `{${color}}${value}`,
	bold: (value: string) => value,
} as unknown as Theme;
const screen = (component: { render(width: number): string[] }, width = 120) =>
	component
		.render(width)
		.map((line) => stripVTControlCharacters(line).trimEnd())
		.join("\n");
const lines = (component: { render(width: number): string[] }, width = 120) =>
	component
		.render(width)
		.map((line) => stripVTControlCharacters(line).trimEnd())
		.filter((line) => line !== "");
const call = { expanded: false, argsComplete: true };
const expandedCall = { expanded: true, argsComplete: true };
const collapsed = { expanded: false, isPartial: false } satisfies ToolRenderResultOptions;
const expandedView = { expanded: true, isPartial: false } satisfies ToolRenderResultOptions;
const okContext = { isError: false };
const errorContext = { isError: true };

const result = (text: string, details: unknown): AgentToolResult<unknown> => ({
	content: [{ type: "text", text }],
	details,
});

/** No lone surrogate anywhere: every code point is complete. */
const wellFormed = (text: string) =>
	assert.ok(/^(?:[^\uD800-\uDFFF]|[\uD800-\uDBFF][\uDC00-\uDFFF])*$/.test(text), "unpaired surrogate in render");

describe("memory_search call cards", () => {
	it("quotes one query and names the continuation index and result limit", () => {
		const view = renderCall("memory_search", { query: "provider lessons", index: 25, limit: 5 }, theme, call);
		const shown = screen(view);
		assert.match(shown, /memory_search · "provider lessons"/);
		assert.match(shown, /from 25 · limit 5/);
		assert.doesNotMatch(shown, /expand arguments/i);
		assert.equal(lines(view).length, 2);
	});

	it("shows the first formulation and a count for array queries", () => {
		const view = renderCall(
			"memory_search",
			{ query: ["provider lessons", "model fallback notes", "provider corrections"] },
			theme,
			call,
		);
		const shown = screen(view);
		assert.match(shown, /memory_search · "provider lessons"/);
		assert.match(shown, /3 queries/);
		assert.doesNotMatch(shown, /model fallback notes/);
		const expanded = screen(renderCall("memory_search", { query: ["a", "b"] }, theme, expandedCall));
		assert.match(expanded, /"a"/);
		assert.match(expanded, /"b"/);
	});

	it("drops malformed query entries and falls back to browse", () => {
		const mixed = screen(renderCall("memory_search", { query: ["valid", 5, null] }, theme, call));
		assert.match(mixed, /memory_search · "valid"/);
		assert.doesNotMatch(mixed, /queries/);
		assert.match(screen(renderCall("memory_search", {}, theme, call)), /memory_search · browse/);
		assert.match(screen(renderCall("memory_search", {}, theme, call)), /byte-bounded cues/);
		const reduced = screen(renderCall("memory_search", { limit: 50 }, theme, call));
		assert.match(reduced, /limit 50/);
		assert.doesNotMatch(reduced, /byte-bounded cues/);
		const streaming = screen(renderCall("memory_search", {}, theme, { expanded: false, argsComplete: false }));
		assert.doesNotMatch(streaming, /browse/);
	});

	it("tolerates malformed argument values", () => {
		for (const args of [null, undefined, "text", 42, { query: 123 }, []]) {
			const shown = screen(renderCall("memory_search", args, theme, call));
			assert.match(shown, /memory_search/);
			wellFormed(shown);
		}
	});

	it("shows full arguments with controls escaped when expanded", () => {
		const view = renderCall("memory_search", { query: "line\nbreak\ttab", index: 0 }, theme, expandedCall);
		const shown = screen(view);
		assert.match(shown, /"query": "line\\nbreak\\ttab"/);
		assert.doesNotMatch(shown, /[\x1b\x07]/);
	});
});

describe("memory_read call cards", () => {
	it("names the slug with offset and digest qualifiers", () => {
		const view = renderCall(
			"memory_read",
			{ slug: "provider-lessons", offset: 4000, digest: "0f1e2d3c4b5a6978" },
			theme,
			call,
		);
		const shown = screen(view);
		assert.match(shown, /memory_read · provider-lessons/);
		assert.match(shown, /offset 4000 · digest 0f1e2d3c/);
	});

	it("marks a pending slug during streaming", () => {
		assert.match(
			screen(renderCall("memory_read", {}, theme, { expanded: false, argsComplete: false })),
			/memory_read\s*$/,
		);
		assert.match(screen(renderCall("memory_read", {}, theme, call)), /\(slug pending\)/);
	});
});

describe("memory_write call cards", () => {
	it("names the slug, mode, and payload size without printing body fields", () => {
		const args = {
			slug: "provider-lessons",
			title: "Provider lessons",
			summary: "use the pinned provider",
		};
		const view = renderCall("memory_write", args, theme, call);
		const shown = screen(view);
		assert.match(shown, /memory_write · provider-lessons/);
		assert.match(shown, /create/);
		assert.match(shown, /payload 39 chars/);
		assert.doesNotMatch(shown, /use the pinned provider|Provider lessons/);
		assert.equal(lines(view).length, 2);
	});

	it("marks update mode from expectedDigest", () => {
		assert.match(
			screen(renderCall("memory_write", { slug: "s", summary: "x", expectedDigest: "0f1e2d3c" }, theme, call)),
			/update/,
		);
	});

	it("withholds short body-field values in the expanded preview", () => {
		const args = {
			slug: "provider-lessons",
			title: "Secret title",
			summary: "pin provider X",
			details: ["credential abc"],
			sources: ["doc.md", "talk.md"],
		};
		const view = renderCall("memory_write", args, theme, expandedCall);
		const shown = screen(view);
		assert.match(shown, /"slug": "provider-lessons"/);
		assert.match(shown, /"title": "<withheld: 12 chars>"/);
		assert.match(shown, /"summary": "<withheld: 14 chars>"/);
		assert.match(shown, /"details": "<withheld: 1 items>"/);
		assert.match(shown, /"sources": "<withheld: 2 items>"/);
		assert.doesNotMatch(shown, /Secret title|pin provider X|credential abc|doc\.md/);
	});

	it("withholds long strings under unfamiliar keys and bounds long arrays", () => {
		const args = { slug: "s", novel: "x".repeat(200), tags: Array.from({ length: 30 }, (_, i) => `t${i}`) };
		const shown = screen(renderCall("memory_write", args, theme, expandedCall));
		assert.match(shown, /"novel": "<withheld: 200 chars>"/);
		assert.match(shown, /\(\+10 more\)/);
	});

	it("escapes hostile control sequences in the slug", () => {
		const view = renderCall("memory_write", { slug: `\x1b]52;c;clip\x07${"s".repeat(80)}`, summary: "x" }, theme, call);
		const shown = screen(view, 60);
		assert.doesNotMatch(shown, /[\x1b\x07]/);
		assert.ok(shown.includes("…"));
		wellFormed(shown);
	});
});

describe("memory_search result cards", () => {
	const indexPage = {
		ok: true,
		kind: "index",
		query: "provider",
		totalNotes: 42,
		totalMatches: 5,
		returned: 2,
		hasMore: true,
		nextIndex: 2,
		notes: [
			{ slug: "a", title: "A" },
			{ slug: "b", title: "B" },
		],
		scan: { complete: true, issueCount: 0 },
		search: { complete: true, unavailableNotes: 1 },
	};

	it("reports the page with its coverage and continuation", () => {
		const view = renderResult("memory_search", result("page text", indexPage), collapsed, theme, okContext);
		const shown = screen(view);
		assert.match(shown, /2 of 5 matches · coverage complete/);
		assert.match(shown, /1 unavailable notes · continuation available/);
		assert.equal(lines(view).length, 2);
	});

	it("marks partial coverage as a warning", () => {
		const details = { ...indexPage, search: { complete: false } };
		const shown = screen(renderResult("memory_search", result("t", details), collapsed, colorTheme, okContext));
		assert.match(shown, /coverage partial/);
		assert.match(shown, /\{warning\}/);
	});

	it("treats array-query pages as query pages", () => {
		const details = { ...indexPage, query: ["provider", "lessons"] };
		const shown = screen(renderResult("memory_search", result("t", details), collapsed, colorTheme, okContext));
		assert.match(shown, /2 of 5 matches · coverage complete/);
		assert.match(shown, /\{success\}/);
		const partialScan = {
			...indexPage,
			query: ["provider", "lessons"],
			search: { complete: false },
			scan: { complete: true, issueCount: 0 },
		};
		const partial = screen(renderResult("memory_search", result("t", partialScan), collapsed, colorTheme, okContext));
		assert.match(partial, /matches · coverage partial/);
		assert.match(partial, /\{warning\}/);
	});

	it("reports browse pages and scan issues", () => {
		const details = {
			ok: true,
			kind: "index",
			query: null,
			totalNotes: 9,
			returned: 9,
			hasMore: false,
			notes: [{ slug: "a", title: "A" }],
			scan: { complete: true, issueCount: 2, unavailableNotes: 1 },
		};
		const shown = screen(renderResult("memory_search", result("t", details), collapsed, colorTheme, okContext));
		assert.match(shown, /9 of 9 notes · directory scan complete/);
		assert.match(shown, /1 unavailable notes/);
		assert.match(shown, /\{warning\}/);
		assert.match(shown, /2 scan issues/);
	});

	it("states an empty corpus without claiming a search found nothing", () => {
		const details = {
			ok: true,
			kind: "index",
			query: null,
			returned: 0,
			totalNotes: 0,
			hasMore: false,
			corpusEmpty: true,
			notes: [],
			scan: { complete: true, issueCount: 0 },
		};
		const shown = screen(renderResult("memory_search", result("t", details), collapsed, colorTheme, okContext));
		assert.match(shown, /corpus empty · directory scan complete/);
		assert.match(shown, /\{muted\}/);
	});

	it("shows the result text expanded", () => {
		const shown = screen(
			renderResult("memory_search", result("full page text", indexPage), expandedView, theme, okContext),
		);
		assert.match(shown, /full page text/);
	});

	it("renders errors, partial state, and malformed details safely", () => {
		const error = screen(
			renderResult(
				"memory_search",
				result("Memory unavailable: set PI_MEMORY_DIR", undefined),
				collapsed,
				theme,
				errorContext,
			),
		);
		assert.match(error, /Memory unavailable: set PI_MEMORY_DIR/);
		assert.match(
			screen(renderResult("memory_search", result("", {}), { expanded: false, isPartial: true }, theme, okContext)),
			/Searching memory\.\.\./,
		);
		for (const details of ["broken", null, 7]) {
			const shown = screen(
				renderResult("memory_search", result("fallback text", details), collapsed, theme, okContext),
			);
			assert.match(shown, /fallback text/);
		}
		const sparse = screen(
			renderResult("memory_search", result("t", { notes: [{ slug: "a" }] }), collapsed, theme, okContext),
		);
		assert.match(sparse, /1 of 1 notes · directory scan partial/);
	});
});

describe("memory_read result cards", () => {
	const notePage = {
		ok: true,
		kind: "note",
		slug: "provider-lessons",
		file: "provider-lessons.md",
		source: "note",
		digest: "0f1e2d3c4b5a6978",
		offset: 0,
		nextOffset: 4000,
		totalCodePoints: 9000,
		contentCodePoints: 4000,
		hasMore: true,
		content: "page one",
	};

	it("separates the returned page from the remaining source", () => {
		const view = renderResult("memory_read", result("page one", notePage), collapsed, theme, okContext);
		const shown = screen(view);
		assert.match(shown, /provider-lessons · 4000 of 9000 chars · more/);
		assert.match(shown, /(?:to expand result|expand for result)/i);
		assert.equal(lines(view).length, 2);
	});

	it("marks the final page and contract source", () => {
		const details = { ...notePage, hasMore: false, contentCodePoints: 9000, source: "contract" };
		const shown = screen(renderResult("memory_read", result("t", details), collapsed, theme, okContext));
		assert.match(shown, /9000 of 9000 chars/);
		assert.doesNotMatch(shown, /· more/);
		assert.match(shown, /contract source/);
	});

	it("shows the page text expanded", () => {
		const shown = screen(renderResult("memory_read", result("", notePage), expandedView, theme, okContext));
		assert.match(shown, /page one/);
	});

	it("renders errors, partial state, and malformed details safely", () => {
		const error = screen(
			renderResult(
				"memory_read",
				result("Error: note source changed since the supplied digest: provider-lessons.md", undefined),
				collapsed,
				theme,
				errorContext,
			),
		);
		assert.match(error, /note source changed since the supplied digest/);
		assert.match(
			screen(renderResult("memory_read", result("", {}), { expanded: false, isPartial: true }, theme, okContext)),
			/Reading note\.\.\./,
		);
		const malformed = screen(renderResult("memory_read", result("fallback", "broken"), collapsed, theme, okContext));
		assert.match(malformed, /fallback/);
	});
});

describe("memory_write result cards", () => {
	const receipt = {
		ok: true,
		slug: "provider-lessons",
		file: "provider-lessons.md",
		digest: "0f1e2d3c4b5a6978",
		written: ["provider-lessons.md", "README.md"],
		notWritten: [],
		initialized: true,
	};

	it("reports the stored slug, digest, and initialization", () => {
		const view = renderResult("memory_write", result("stored", receipt), collapsed, colorTheme, okContext);
		const shown = screen(view);
		assert.match(shown, /provider-lessons written · corpus initialized/);
		assert.match(shown, /digest 0f1e2d3c/);
		assert.match(shown, /\{success\}/);
		assert.doesNotMatch(shown, /README\.md/);
		assert.equal(lines(view).length, 2);
	});

	it("marks a partial receipt as a warning with both counts", () => {
		const details = { ...receipt, written: ["provider-lessons.md"], notWritten: ["other.md"] };
		const shown = screen(renderResult("memory_write", result("t", details), collapsed, colorTheme, okContext));
		assert.match(shown, /\{warning\}/);
		assert.match(shown, /1 written · 1 not written/);
	});

	it("recovers a partial receipt from a thrown write error message", () => {
		const thrown = {
			ok: false,
			slug: "provider-lessons",
			file: "provider-lessons.md",
			written: ["provider-lessons.md"],
			notWritten: ["other.md", "third.md"],
			initialized: true,
			error: "EACCES: other.md",
		};
		const failed = result(`Memory write incomplete: ${JSON.stringify(thrown)}`, undefined);
		const view = renderResult("memory_write", failed, collapsed, colorTheme, errorContext);
		const shown = screen(view);
		assert.match(shown, /provider-lessons write incomplete · 1 written · 2 not written/);
		assert.match(shown, /EACCES: other\.md/);
		assert.match(shown, /\{warning\}/);
		const expanded = screen(renderResult("memory_write", failed, expandedView, theme, errorContext));
		assert.match(expanded, /"ok":false/);
	});

	it("classifies a total failure from a receipt", () => {
		const thrown = {
			ok: false,
			slug: "s",
			file: "s.md",
			written: [],
			notWritten: ["s.md"],
			initialized: false,
			error: "disk full",
		};
		const shown = screen(
			renderResult(
				"memory_write",
				result(`Memory write incomplete: ${JSON.stringify(thrown)}`, undefined),
				collapsed,
				colorTheme,
				errorContext,
			),
		);
		assert.match(shown, /write failed · s · disk full/);
		assert.match(shown, /\{error\}/);
	});

	it("says incomplete when the thrown receipt does not parse", () => {
		const failed = result('Memory write incomplete: {"ok":false,"written":["a', undefined);
		const shown = screen(renderResult("memory_write", failed, collapsed, colorTheme, errorContext));
		assert.match(shown, /write incomplete ·/);
		assert.match(shown, /\{error\}/);
		assert.doesNotMatch(shown, /\{warning\}/);
		const empty = screen(renderResult("memory_write", result("", undefined), collapsed, theme, errorContext));
		assert.match(empty, /write incomplete/);
	});

	it("renders partial state and malformed details safely", () => {
		assert.match(
			screen(renderResult("memory_write", result("", {}), { expanded: false, isPartial: true }, theme, okContext)),
			/Writing note\.\.\./,
		);
		const malformed = screen(renderResult("memory_write", result("fallback", "broken"), collapsed, theme, okContext));
		assert.match(malformed, /fallback/);
	});
});

describe("renderer hygiene", () => {
	it("never splits surrogate pairs when clipping", () => {
		const query = `x${"🌍".repeat(40)}`;
		const shown = screen(renderCall("memory_search", { query }, theme, call), 200);
		assert.ok(shown.includes("…"));
		wellFormed(shown);
		const body = screen(renderCall("memory_read", { slug: `🌍${"a".repeat(80)}` }, theme, expandedCall), 200);
		wellFormed(body);
	});

	it("preserves non-BMP characters inside the preview", () => {
		const shown = screen(renderCall("memory_search", { query: "providers 🌍 lessons" }, theme, call));
		assert.match(shown, /providers 🌍 lessons/);
	});

	it("renders unknown tool names without dumping arguments", () => {
		const view = renderCall("memory_evict", { secret: "payload" }, theme, expandedCall);
		const shown = screen(view);
		assert.match(shown, /memory_evict/);
		assert.doesNotMatch(shown, /secret|payload/);
		const outcome = screen(renderResult("memory_evict", result("done", { n: 1 }), collapsed, theme, okContext));
		assert.match(outcome, /done/);
	});

	it("does not mutate the arguments or the result", () => {
		const args = { query: ["a", "b"], slug: "s", summary: "x".repeat(300) };
		const argsBefore = structuredClone(args);
		renderCall("memory_write", args, theme, expandedCall);
		renderCall("memory_search", args, theme, call);
		assert.deepEqual(args, argsBefore);
		const writeResult = result("stored", {
			ok: true,
			slug: "s",
			file: "s.md",
			written: ["s.md"],
			notWritten: [],
			initialized: false,
		});
		const before = structuredClone(writeResult);
		renderResult("memory_write", writeResult, collapsed, theme, okContext);
		renderResult("memory_write", writeResult, expandedView, theme, okContext);
		assert.deepEqual(writeResult, before);
	});

	it("reuses the previous component instance", () => {
		const previous = new Text("", 0, 0);
		const view = renderCall("memory_read", { slug: "s" }, theme, { ...call, lastComponent: previous });
		assert.equal(view, previous);
		const outcome = renderResult("memory_read", result("t", { slug: "s" }), collapsed, theme, {
			isError: false,
			lastComponent: previous,
		});
		assert.equal(outcome, previous);
	});
});
