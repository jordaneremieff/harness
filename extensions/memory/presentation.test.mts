import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { describe, it } from "node:test";
import { stripVTControlCharacters } from "node:util";
import {
	type AgentToolResult,
	initTheme,
	type Theme,
	type ToolDefinition,
	ToolExecutionComponent,
	type ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { type TUI, visibleWidth } from "@earendil-works/pi-tui";
import { toolDisplay } from "./display.ts";
import { renderCall, renderResult } from "./presentation.ts";

const theme = { fg: (_color: string, value: string) => value, bold: (value: string) => value } as unknown as Theme;
const colorTheme = {
	fg: (color: string, value: string) => `{${color}}${value}`,
	bold: (value: string) => value,
} as unknown as Theme;
const screen = (component: { render(width: number): readonly string[] }, width = 120) =>
	component
		.render(width)
		.map((line) => stripVTControlCharacters(line).trimEnd())
		.join("\n");
const lines = (component: { render(width: number): readonly string[] }, width = 120) =>
	component
		.render(width)
		.map((line) => stripVTControlCharacters(line).trimEnd())
		.filter((line) => line !== "");
const call = { expanded: false, argsComplete: true };
const expandedCall = { expanded: true, argsComplete: true };
const collapsed: ToolRenderResultOptions = { expanded: false, isPartial: false };
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
	it("quotes one query and names continuation and result limit", () => {
		const view = renderCall(
			"memory_search",
			{ query: "provider lessons", cursor: "opaque-cursor", limit: 5 },
			theme,
			call,
		);
		const shown = screen(view);
		assert.match(shown, /memory_search "provider lessons"/);
		assert.match(shown, /continuation · limit 5/);
		assert.doesNotMatch(shown, /to expand/);
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
		assert.match(shown, /memory_search "provider lessons"/);
		assert.match(shown, /3 queries/);
		assert.doesNotMatch(shown, /model fallback notes/);
		const expanded = screen(renderCall("memory_search", { query: ["a", "b"] }, theme, expandedCall));
		assert.match(expanded, /^ {2}query: \[/m);
		assert.match(expanded, /^ {4}"a"/m);
		assert.match(expanded, /^ {4}"b"/m);
	});

	it("drops malformed query entries and falls back to browse", () => {
		const mixed = screen(renderCall("memory_search", { query: ["valid", 5, null] }, theme, call));
		assert.match(mixed, /memory_search "valid"/);
		assert.doesNotMatch(mixed, /queries/);
		assert.match(screen(renderCall("memory_search", {}, theme, call)), /memory_search browse/);
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
		const view = renderCall("memory_search", { query: "line\nbreak\ttab" }, theme, expandedCall);
		const shown = screen(view);
		assert.match(shown, /query: "line\\nbreak\\ttab"/);
		assert.doesNotMatch(shown, /[\x1b\x07]/);
	});
});

describe("Memory cards in Pi's tool component", () => {
	it("uses one real hint, preserves the cursor, and bounds wrapped previews", async (t) => {
		initTheme("dark", false);
		const tui = await import(
			createRequire(import.meta.resolve("@earendil-works/pi-coding-agent")).resolve("@earendil-works/pi-tui")
		);
		const previous = tui.getKeybindings();
		const definitions = {
			...tui.TUI_KEYBINDINGS,
			"app.tools.expand": { defaultKeys: [], description: "Expand tool output" },
		};
		t.after(() => tui.setKeybindings(previous));
		const setBinding = (key: string[] = []) =>
			tui.setKeybindings(new tui.KeybindingsManager(definitions, { "app.tools.expand": key }));
		setBinding();
		let hostTheme: Theme | undefined;
		const component = (args: Record<string, unknown>, name = "memory_search") => {
			const tool = toolDisplay().tools.find((tool) => tool.name === name);
			assert.ok(tool?.renderCall && tool.renderResult);
			const { renderResult: render } = tool;
			const definition = {
				...tool,
				renderResult: ((response, options, theme, context) => {
					hostTheme = theme;
					return render(response, options, theme, context);
				}) satisfies NonNullable<ToolDefinition["renderResult"]>,
			} as ToolDefinition;
			return new ToolExecutionComponent(
				name,
				"call",
				args,
				undefined,
				definition,
				{ requestRender() {} } as unknown as TUI,
				".",
			);
		};
		const card = component({ query: ["fixture", "second formulation"], limit: 3 });
		card.setArgsComplete();
		assert.doesNotMatch(screen(card, 85), /to expand/);
		setBinding(["ctrl+g"]);
		card.markExecutionStarted();
		assert.equal(lines(card, 85).at(-1)?.trim(), "... (ctrl+g to expand)");
		card.updateResult({ ...result("", null), isError: false }, true);
		const partial = screen(card, 85);
		assert.match(partial, /Search in progress\n\s*\.\.\. \(ctrl\+g to expand\)/);
		assert.equal(partial.match(/to expand/g)?.length, 1);
		setBinding();
		const cursor = "opaque_-".repeat(8);
		card.updateResult({
			...result("retained model text", {
				query: ["fixture", "second formulation"],
				totalMatches: 2,
				includeRetired: false,
				hasMore: true,
				nextCursor: cursor,
				search: { complete: false, unavailableNotes: 1 },
				scan: { inventoryComplete: true, complete: true, unavailableNotes: 1, issueCount: 1 },
				notes: [{ slug: "first", title: `\x1b[2J${"測試".repeat(145)}` }],
			}),
			isError: false,
		});
		const width = 85;
		const visible = lines(card, width).map((line) => line.trimStart());
		assert.deepEqual(visible.slice(0, 3), [
			'memory_search "fixture"',
			"2 queries · limit 3",
			"1 of 2 matches in this source window; more pages available",
		]);
		assert.equal(visible.slice(3, -2).length, 5);
		assert.match(visible.at(-2) ?? "", /^\[Partial source coverage · 1 unavailable note · 1 scan issue\]$/);
		assert.equal(visible.at(-1), "... (click to expand)");
		assert.doesNotMatch(screen(card, width), /\[2J|opaque_|more lines|unknown/);
		assert.ok(card.render(width).every((line) => visibleWidth(line) <= width));
		assert.ok(hostTheme);
		const styled = card.render(width).join("\n");
		assert.ok(styled.includes(`${hostTheme.getFgAnsi("toolOutput")}1 of 2 matches`));
		assert.ok(styled.includes(`${hostTheme.getFgAnsi("warning")}[Partial source coverage`));
		const y = card.render(width).findIndex((row) => row.includes("more pages available"));
		assert.ok(y > 0);
		assert.equal(card.handleMouse({ type: "click", button: "left", x: 4, y, width } as never)?.handled, true);
		const expanded = screen(card, width);
		assert.match(expanded, /query: \[\n\s*"fixture",\n\s*"second formulation"/);
		assert.match(expanded, /\blimit: 3/);
		assert.ok(expanded.includes(`"cursor": "${cursor}"`));
		assert.match(expanded, /"includeRetired": false/);
		assert.match(expanded, /Continue with memory_search:/);
		assert.doesNotMatch(expanded, /to expand|retained model text|\[2J/);
		assert.ok(
			card
				.render(width)
				.join("\n")
				.includes(`${hostTheme.getFgAnsi("warning")}[Partial source coverage`),
		);

		const error = component({ query: "fixture" });
		error.updateResult({ ...result("Memory source is unavailable", null), isError: true });
		assert.match(screen(error, width), /Memory source is unavailable/);
		assert.doesNotMatch(screen(error, width), /to expand|No notes/);
		assert.ok(
			error
				.render(width)
				.join("\n")
				.includes(`${hostTheme.getFgAnsi("error")}Memory source is unavailable`),
		);

		const edit = component(
			{ slug: "subject", edits: [{ oldText: "private anchor", newText: "private replacement" }] },
			"memory_edit",
		);
		assert.doesNotMatch(screen(edit, width), /to expand/);
		edit.updateResult({
			...result("Anchor mismatch: current excerpt \x1b[2Jis different", {
				ok: false,
				slug: "subject",
				written: [],
				notWritten: [],
			}),
			isError: true,
		});
		assert.match(screen(edit, width), /No live files were written for subject/);
		assert.doesNotMatch(screen(edit, width), /private|current excerpt/);
		assert.equal(screen(edit, width).match(/to expand/g)?.length, 1);
		edit.setExpanded(true);
		const editExpanded = screen(edit, width);
		assert.match(editExpanded, /"oldText": "14 characters"/);
		assert.match(editExpanded, /Anchor mismatch: current excerpt is different/);
		assert.doesNotMatch(editExpanded, /private|to expand|\[2J/);

		const read = component({ slug: "editor" }, "memory_read");
		read.updateResult({
			...result("model text", { content: "0\n1\n2\n3\n4\n5\n6", hasMore: false, nextOffset: null }),
			isError: false,
		});
		assert.match(screen(read, width), /\.\.\. \(2 more lines, click to expand\)/);
		assert.doesNotMatch(screen(read, width), /\n\s+5\s*\n|model text/);
	});
});

describe("memory_search result cards", () => {
	it("renders compact matches and material freshness without inventing missing declarations", () => {
		const details = {
			...indexPage,
			detail: false,
			notes: [
				{
					slug: "editor",
					title: "Editor",
					lifecycle: { status: "active", supersededBy: null },
					matched: ["editor", "choice"],
					freshness: {
						deadline: "due",
						reviewAfter: "2026-09-01",
						evaluatedOn: "2026-09-29",
						concern: { date: "2026-09-28", reason: "One disputed claim.", sources: "Synthetic source." },
						problems: ["Invalid review_policy"],
					},
				},
			],
		};
		const shown = screen(renderResult("memory_search", result("t", details), expandedView, theme, okContext), 200);
		assert.match(shown, /Matched: editor; choice/);
		assert.match(shown, /Review deadline: due/);
		assert.match(shown, /Unresolved concern reason: One disputed claim/);
		assert.match(shown, /Freshness problem: Invalid review_policy/);
		assert.doesNotMatch(shown, /Declared verified|Declared verification date|Review policy:|Formulation:/);
		const preview = screen(renderResult("memory_search", result("t", details), collapsed, theme, okContext));
		assert.match(preview, /review due/);
		assert.match(screen(renderCall("memory_search", { detail: true }, theme, call)), /full evidence/);
	});
	const indexPage = {
		ok: true,
		kind: "index",
		query: "provider",
		totalNotes: 42,
		totalMatches: 5,
		returned: 2,
		hasMore: true,
		nextCursor: "opaque-cursor",
		notes: [
			{ slug: "a", title: "A" },
			{ slug: "b", title: "B" },
		],
		scan: { inventoryComplete: true, complete: true, issueCount: 0, unavailableNotes: 0 },
		search: { complete: true, unavailableNotes: 0 },
	};

	it("reports the page with its coverage and continuation", () => {
		const view = renderResult("memory_search", result("page text", indexPage), collapsed, theme, okContext);
		const shown = screen(view);
		assert.match(shown, /2 of 5 matches in this source window; more pages available/);
		assert.doesNotMatch(shown, /Partial source coverage/);
		assert.match(shown, /• A · a/);
		assert.match(shown, /• B · b/);
		assert.equal(lines(view).length, 4);
	});

	it("lists replaced matches and overflow only in expanded search cards", () => {
		const replacement = { slug: "old-topic", title: "Earlier \u001b[31m topic" };
		const details = {
			...indexPage,
			notes: [{ ...indexPage.notes[0], replacedMatches: [replacement], omittedReplacedMatches: 2 }, indexPage.notes[1]],
		};
		const expanded = screen(renderResult("memory_search", result("t", details), expandedView, theme, okContext), 200);
		assert.match(expanded, /Replaced matches:/);
		assert.match(expanded, /old-topic · Earlier/);
		assert.doesNotMatch(expanded, /\u001b/);
		assert.match(expanded, /2 more replaced matches omitted\./);
		const collapsedCard = (page: typeof indexPage) =>
			screen(renderResult("memory_search", result("t", page), collapsed, theme, okContext));
		assert.equal(collapsedCard(details), collapsedCard(indexPage));
	});

	it("marks partial coverage as a warning", () => {
		const details = { ...indexPage, search: { complete: false } };
		const shown = screen(renderResult("memory_search", result("t", details), collapsed, colorTheme, okContext));
		assert.match(shown, /\{toolOutput\}2 of 5 matches/);
		assert.match(shown, /\{warning\}\[Partial source coverage\]/);
	});

	it("treats array-query pages as query pages", () => {
		const details = { ...indexPage, query: ["provider", "lessons"] };
		const shown = screen(renderResult("memory_search", result("t", details), collapsed, colorTheme, okContext));
		assert.match(shown, /\{toolOutput\}2 of 5 matches in this source window/);
		assert.doesNotMatch(shown, /\{success\}|\{warning\}/);
		const partialScan = {
			...indexPage,
			query: ["provider", "lessons"],
			search: { complete: false },
			scan: { complete: true, issueCount: 0 },
		};
		const partial = screen(renderResult("memory_search", result("t", partialScan), collapsed, colorTheme, okContext));
		assert.match(partial, /2 of 5 matches in this source window/);
		assert.match(partial, /\{warning\}\[Partial source coverage\]/);
	});

	it("reports browse pages and scan issues", () => {
		const details = {
			ok: true,
			kind: "index",
			query: null,
			totalNotes: 1,
			returned: 1,
			hasMore: false,
			notes: [{ slug: "a", title: "A" }],
			scan: { inventoryComplete: true, complete: true, issueCount: 2, unavailableNotes: 1 },
			coverage: { traversalComplete: true },
		};
		const shown = screen(renderResult("memory_search", result("t", details), collapsed, colorTheme, okContext));
		assert.match(shown, /\{toolOutput\}1 of 1 note in this source window/);
		assert.match(shown, /\{warning\}\[Partial source coverage · 1 unavailable note · 2 scan issues\]/);
		const evidence = screen(renderResult("memory_search", result("t", details), expandedView, theme, okContext));
		assert.match(evidence, /Source coverage: partial/);
		assert.match(evidence, /Filename inventory: complete/);
		assert.match(evidence, /Candidates visited by this scan: all/);
		assert.match(evidence, /Cursor traversal: reached the end of the inventory/);
		assert.match(evidence, /Unavailable notes: 1/);
		assert.doesNotMatch(evidence, /Source coverage: complete/);
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
			scan: { inventoryComplete: true, complete: true, issueCount: 0, unavailableNotes: 0 },
		};
		const shown = screen(renderResult("memory_search", result("t", details), collapsed, colorTheme, okContext));
		assert.match(shown, /\{toolOutput\}The memory corpus is empty/);
		assert.doesNotMatch(shown, /\{warning\}|No matches/);
	});

	it("shows labeled source evidence and all retained qualifications without a JSON dump", () => {
		const details = {
			...indexPage,
			notes: [
				{
					slug: "subject",
					title: "Subject title",
					digest: "a".repeat(64),
					rank: 1,
					status: '"superseded"',
					superseded_by: '"replacement"',
					tags: '["topic"]',
					supersedes: "[]",
					cueProblem: "unsupported multiline cue: tags",
					formulations: [
						{
							query: "provider lessons",
							rank: 2,
							matched: [{ term: "provider", fields: ["body"] }],
							missing: ["lessons"],
						},
					],
					sourceMatch: {
						offset: 10,
						endOffset: 18,
						excerptOffset: 8,
						excerptEndOffset: 40,
						excerpt: "First line\nSecond line\x1b[2J",
					},
				},
			],
			scan: {
				complete: false,
				visited: 5000,
				visitCap: 16384,
				inventoryComplete: true,
				issueCount: 21,
				issuesShown: 1,
				unavailableNotes: 1,
				issues: [{ code: "note.unreadable", message: "Unreadable source remains unknown" }],
			},
			search: {
				complete: false,
				unavailableNotes: 1,
				notesSearched: 20,
				maxSourceBytes: 65536,
				ranking: "lexical",
				ignored: ["the"],
			},
		};
		const response = result(JSON.stringify(details), details);
		const before = structuredClone(response);
		const shown = screen(renderResult("memory_search", response, expandedView, theme, okContext), 200);
		for (const pattern of [
			/Source coverage: partial/,
			/Filename inventory: complete/,
			/Query coverage: partial/,
			/Scan issues: 21/,
			/Scan issues shown: 1/,
			/note.unreadable · Unreadable source remains unknown/,
			/Unavailable notes: 1/,
			/Continue with memory_search:\n\{\n {2}"query": "provider",\n {2}"cursor": "opaque-cursor"/,
			/subject · Subject title/,
			/status cue: "superseded"/,
			/superseded_by cue: "replacement"/,
			/Cue problem: unsupported multiline cue: tags/,
			/Digest: a{64}/,
			/Formulation: provider lessons · rank 2/,
			/Matched: provider \(body\)/,
			/Missing: lessons/,
			/Match \[10, 18\)/,
			/Source excerpt \[8, 40\)/,
			/First line\nSecond line/,
		])
			assert.match(shown, pattern);
		assert.doesNotMatch(shown, /"notes":|\\nSecond|\x1b|\[2J/);
		assert.deepEqual(response, before);
	});

	it("bounds collapsed subject previews and keeps zero-match guidance for expansion", () => {
		const details = {
			...indexPage,
			returned: 6,
			totalMatches: 6,
			hasMore: false,
			nextCursor: null,
			notes: Array.from({ length: 6 }, (_, index) => ({ slug: `subject-${index}`, title: `Title ${index}` })),
		};
		const shown = screen(
			renderResult("memory_search", result(JSON.stringify(details), details), collapsed, theme, okContext),
		);
		for (const index of [0, 1, 2, 3, 4]) assert.match(shown, new RegExp(`subject-${index}`));
		assert.doesNotMatch(shown, /subject-5|more lines/);
		assert.match(shown, /\.\.\. \(click to expand\)$/);
		const empty = {
			...details,
			returned: 0,
			totalMatches: 0,
			notes: [],
			search: { complete: false },
			guidance: "Try alternate inflections, exact identifier forms, or quoted fragments; inspect coverage gaps.",
		};
		for (const view of [collapsed, expandedView]) {
			const shown = screen(
				renderResult("memory_search", result(JSON.stringify(empty), empty), view, theme, okContext),
				200,
			);
			assert.match(shown, /No matches returned from this source window/);
			if (view.expanded) assert.match(shown, /Try alternate inflections, exact identifier forms, or quoted fragments/);
			else assert.doesNotMatch(shown, /Try alternate inflections/);
		}
	});

	it("keeps the cursor on an empty browse window without inventing an empty corpus", () => {
		const details = {
			query: null,
			includeRetired: true,
			totalNotes: 0,
			notes: [],
			hasMore: true,
			nextCursor: "empty-window-token",
			scan: { inventoryComplete: true, complete: false, unavailableNotes: 0, issueCount: 0 },
		};
		const compact = screen(renderResult("memory_search", result("", details), collapsed, theme, okContext));
		assert.match(compact, /No notes returned from this source window; more pages available/);
		assert.doesNotMatch(compact, /corpus is empty|empty-window-token/);
		const evidence = screen(renderResult("memory_search", result("", details), expandedView, theme, okContext));
		assert.match(
			evidence,
			/Continue with memory_search:\n\{\n {2}"includeRetired": true,\n {2}"cursor": "empty-window-token"\n\}/,
		);
		assert.doesNotMatch(evidence, /"query"|Source coverage: complete/);
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
			/Search in progress/,
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
		assert.match(sparse, /1 note on this page/);
		assert.match(sparse, /\[Partial source coverage\]/);
	});
});

describe("read and history cards", () => {
	const digest = "a".repeat(64);
	const revision = `20260101T120000000Z-00000000-0000-0000-0000-000000000001-${digest}`;
	const notePage = {
		ok: true,
		kind: "note",
		slug: "editor",
		source: "note",
		digest,
		offset: 0,
		nextOffset: 12,
		totalCodePoints: 12003,
		contentCodePoints: 12,
		hasMore: true,
		lifecycle: { status: "active", supersededBy: null },
		content: "line\nsecond\n",
	};
	const show = (name: string, details: unknown, options = collapsed, context = okContext, width = 160) =>
		screen(renderResult(name, result("model text", details), options, theme, context), width);

	it("names the exact subject, revision, offset and digest without a placeholder", () => {
		const args = { slug: "editor", revision, offset: 12, digest };
		const view = renderCall("memory_read", args, theme, { ...call, keyText: () => "ctrl+g" });
		const wide = screen(view, 250);
		assert.equal(wide.split("\n")[0], "memory_read editor");
		assert.ok(wide.includes(`revision ${revision} · offset 12 · digest ${digest}`));
		assert.doesNotMatch(wide, /to expand/);
		assert.match(screen(view, 60), /…\n\.\.\. \(ctrl\+g to expand\)/);
		for (const argsComplete of [false, true])
			assert.equal(screen(renderCall("memory_read", {}, theme, { argsComplete })), "memory_read");
	});

	it("states scope and discloses both the remaining body and the exact continuation", () => {
		const body = Array.from({ length: 7 }, (_, index) => `Line ${index}`).join("\n");
		const read = { ...notePage, content: body };
		const compact = show("memory_read", read);
		assert.match(compact, /12 of 12003 characters on this page; more source follows/);
		assert.deepEqual(
			compact.split("\n").filter((line) => line.startsWith("Line")),
			body.split("\n").slice(0, 5),
		);
		assert.match(compact, /\.\.\. \(2 more lines, click to expand\)$/);
		const expanded = show("memory_read", read, expandedView);
		assert.ok(expanded.includes(body));
		assert.doesNotMatch(expanded, /to expand|model text/);
		assert.match(expanded, /Continue with memory_read:\n\{\n.*"slug": "editor",\n.*"offset": 12,\n.*"digest": "a{64}"/);
	});

	it("reports the exact final Unicode range and keeps advisory evidence separate", () => {
		const details = {
			...notePage,
			offset: 12000,
			nextOffset: null,
			contentCodePoints: 3,
			hasMore: false,
			content: "A🌍Z",
			lifecycle: { status: "superseded", supersededBy: "replacement", problem: "Bad source metadata" },
			freshness: {
				policy: "before-use",
				deadline: "due",
				verified: true,
				concern: { date: "2026-09-29", reason: "Current source differs\x1b[2J", sources: "Source A" },
				problems: ["Invalid date"],
			},
			staleReferences: [{ slug: "stale-subject", status: "retired" }],
			staleReferenceCoverage: { complete: false, count: 5, entriesVisited: 16, notesChecked: 10 },
			staleReferenceGuidance: "Read the replacement before applying the claim.",
		};
		const response = result(JSON.stringify(details), details);
		const before = structuredClone(response);
		const compact = screen(renderResult("memory_read", response, collapsed, colorTheme, okContext), 220);
		assert.match(compact, /\{toolOutput\}3 of 12003 characters on this page/);
		assert.match(compact, /\{warning\}\[status superseded · replacement replacement · review due · unresolved concern/);
		assert.match(compact, /1 stale reference · reference coverage partial/);
		assert.doesNotMatch(compact, /Read the replacement before/);
		const full = show("memory_read", details, expandedView, okContext, 220);
		for (const pattern of [
			/Source range: \[12000, 12003\) code points/,
			/End of source\./,
			/Lifecycle problem: Bad source metadata/,
			/Review policy: before-use/,
			/Declared verified: true/,
			/Unresolved concern reason: Current source differs/,
			/Unresolved concern sources: Source A/,
			/Stale reference: stale-subject · retired/,
			/Reference matches observed: 5/,
			/Reference notes checked: 10/,
			/Read the replacement before applying the claim\./,
		])
			assert.match(full, pattern);
		assert.doesNotMatch(full, /\[2J|nextOffset|Continue with memory_read/);
		assert.deepEqual(response, before);
	});

	it("reads a current JSON note envelope and strips controls without changing the retained bytes", () => {
		const content = `Line\twith tab\x1b[2J\u202e\n${"🌍".repeat(17000)}`;
		const details = { ...notePage, content, source: "contract", lifecycle: null };
		const response = result(JSON.stringify(details), undefined);
		const shown = screen(renderResult("memory_read", response, expandedView, theme, okContext), 50000);
		assert.match(shown, /Contract source/);
		assert.match(shown, /Line {3}with tab/);
		assert.match(shown, /\[Truncated: showing [\d]+ of [\d]+ characters\]/);
		assert.doesNotMatch(shown, /\x1b|\u202e|\[2J/);
		assert.equal(JSON.parse(response.content[0].type === "text" ? response.content[0].text : "").content, content);
		wellFormed(shown);
	});

	it("shows today's local capture time and keeps the historical identity in the continuation", () => {
		const today = new Date();
		today.setHours(14, 32, 21, 789);
		const details = {
			...notePage,
			source: "history",
			revision,
			capturedAt: today.toISOString(),
			authority: "Historical evidence, not current authority.",
		};
		assert.match(show("memory_read", details), /on this historical page/);
		const full = show("memory_read", details, expandedView);
		assert.match(full, /Historical evidence · prior status active/);
		assert.match(full, /Captured: 2:32 PM/);
		assert.match(full, /not current authority/);
		assert.ok(full.includes(`"revision": "${revision}"`));
	});

	it("keeps history metadata, partial coverage and an exact plan cursor on empty pages", () => {
		const plan = { capturedBefore: new Date(2001, 10, 23, 14, 32, 21, 789).toISOString(), keepNewest: 1 };
		const details = {
			ok: true,
			kind: "history",
			slug: "editor",
			revisions: [],
			nextCursor: "opaque-history-token",
			coverage: { inventoryComplete: true, unavailable: 1, bodiesRead: false, totalRevisions: 2 },
			plan: { ...plan, candidates: 0, availableBytes: 0, meaning: "Inventory floor includes unavailable names." },
		};
		const compact = show("memory_history", details);
		assert.match(compact, /No prior captures returned on this metadata page; more pages available/);
		assert.match(compact, /\[1 unavailable revision\]/);
		assert.doesNotMatch(compact, /opaque-history-token|End of/);
		const body = show("memory_history", details, expandedView);
		assert.match(body, /Captured before: 23 Nov 2001 2:32 PM/);
		assert.match(body, /Capture name inventory: complete/);
		assert.match(body, /Historical bodies were not read/);
		assert.match(body, /Capture-name digests are unverified/);
		assert.match(body, /authorises no removal/);
		const continuation = body.match(/Continue with memory_history:\n(\{[\s\S]+?\n\})/);
		assert.ok(continuation);
		assert.deepEqual(JSON.parse(continuation[1]), { slug: "editor", plan, cursor: details.nextCursor });
		const final = {
			...details,
			nextCursor: null,
			revisions: [
				{
					revision,
					capturedAt: new Date(2001, 10, 22, 0, 1).toISOString(),
					digest,
					bytes: 200,
					selection: "candidate",
					reason: "before-cutoff-outside-floor",
				},
			],
		};
		const finalBody = show("memory_history", final, expandedView);
		assert.match(finalBody, /End of the capture inventory/);
		assert.ok(finalBody.includes(revision));
		assert.match(finalBody, /Captured: 22 Nov 2001 12:01 AM/);
		assert.match(finalBody, /Selection: candidate\nReason: before-cutoff-outside-floor/);
		assert.match(finalBody, /Bytes: 200/);
	});

	it("does not claim zero or end from absent history and keeps real read errors", () => {
		const malformed = screen(
			renderResult("memory_history", result("\nDetails unavailable\nEvidence", {}), collapsed, theme, okContext),
		);
		assert.match(malformed, /Details unavailable/);
		assert.doesNotMatch(malformed, /No prior|End of/);
		const readError = screen(
			renderResult(
				"memory_read",
				result("Source changed\nRestart at offset 0", {}),
				expandedView,
				colorTheme,
				errorContext,
			),
		);
		assert.match(readError, /\{error\}Source changed\nRestart at offset 0/);
		const pending = show("memory_history", {}, { expanded: false, isPartial: true });
		assert.match(pending, /History read in progress/);
		assert.doesNotMatch(pending, /to expand/);
	});
});

describe("mutation cards", () => {
	const receipt = {
		ok: true,
		slug: "editor",
		written: ["editor.md"],
		notWritten: [],
		digest: "a".repeat(64),
		captured: [{ slug: "editor", revision: "prior", capturedAt: new Date(2001, 10, 23, 14, 32).toISOString() }],
		historyOmitted: [{ file: "other.md", reason: "credential-policy" }],
	};
	const show = (name: string, details: unknown, options = collapsed, ctx = okContext, diagnostic = "") =>
		screen(renderResult(name, result(diagnostic, details), options, colorTheme, ctx), 180);

	it("withholds all designated arguments even on expansion", () => {
		const args = {
			slug: "editor",
			expectedDigest: "a".repeat(64),
			title: "Private title",
			summary: "Secret for fixture",
			details: "A withheld body",
			sources: "Withheld source",
			reason: "Withheld reason",
			edits: [{ oldText: "Withheld anchor", newText: "Withheld replacement" }],
			novel: "x".repeat(200),
			tags: Array.from({ length: 30 }, (_, index) => `tag-${index}`),
		};
		const before = structuredClone(args);
		for (const name of ["memory_write", "memory_edit", "memory_review", "memory_retire"]) {
			for (const ctx of [call, expandedCall]) {
				const shown = screen(renderCall(name, args, theme, ctx));
				assert.ok(shown.startsWith(`${name} editor`));
				assert.doesNotMatch(
					shown,
					/Private title|Secret for fixture|A withheld body|Withheld (?:source|reason|anchor|replacement)|x{30}/,
				);
				if (ctx.expanded) {
					assert.match(shown, /title: 13 characters/);
					assert.match(shown, /"oldText": "15 characters"/);
					assert.match(shown, /10 omitted items/);
				}
			}
		}
		assert.deepEqual(args, before);
		assert.match(screen(renderCall("memory_edit", args, theme, call)), /1 edit/);
		assert.match(
			screen(renderCall("memory_review", { slug: "editor", outcome: "confirmed", reactivate: true }, theme, call)),
			/confirmed · reactivation requested/,
		);
		assert.doesNotMatch(
			screen(renderCall("memory_retire", { slug: "editor", reactivate: true }, theme, call)),
			/reactivation/,
		);
	});

	it("labels successful mutations without upgrading historical captures or review authority", () => {
		for (const [name, effect] of [
			["memory_write", "Wrote"],
			["memory_edit", "Edited"],
			["memory_review", "Reviewed"],
			["memory_retire", "Retired"],
		]) {
			const shown = show(name, receipt);
			assert.ok(shown.includes(`{toolOutput}${effect} editor`));
			assert.match(shown, /1 prior capture \(not proof of publication\)/);
			assert.match(shown, /1 history omission \(credential policy\)/);
			assert.doesNotMatch(shown, /Confirmed|Reactivated|\{success\}|\{warning\}/);
		}
		const full = show("memory_write", { ...receipt, initialized: true }, expandedView);
		assert.match(full, /initialised the corpus/);
		assert.match(full, /Prior capture: editor · prior · 23 Nov 2001 2:32 PM/);
		assert.match(full, /Written: editor\.md/);
		assert.match(full, /Digest: a{64}/);
	});

	it("distinguishes no publication, partial publication, cleanup failure and absent effects", () => {
		const failed = { ...receipt, ok: false };
		const cases = [
			[{ ...failed, written: [], notWritten: ["editor.md"] }, /No live files were written for editor/],
			[{ ...failed, notWritten: ["other.md", "third.md"] }, /Published 1 live file; 2 files not written/],
			[failed, /Published all live files; cleanup failed/],
			[{ ok: false, slug: "editor" }, /Memory write failed for editor/],
		] as const;
		for (const [details, expected] of cases) {
			const shown = show("memory_write", details, collapsed, errorContext, "Sensitive diagnostic");
			assert.match(shown, /\{error\}/);
			assert.match(shown, expected);
			assert.doesNotMatch(shown, /Sensitive diagnostic/);
		}
		const text = 'Current failure: {"ok":false,"written":["a"],"notWritten":["b"]}';
		const fallback = show("memory_write", {}, collapsed, errorContext, text);
		assert.match(fallback, /Memory write failed/);
		assert.doesNotMatch(fallback, /Published|no live files|Current failure/i);
		const full = show("memory_write", {}, expandedView, errorContext, text);
		assert.ok(full.includes(text));
	});

	it("does not over-disclose before a result or print text for unknown call arguments", () => {
		const args = { slug: "editor", summary: "Private body" };
		const bound = screen(renderCall("memory_write", args, theme, { ...call, keyText: () => "ctrl+g" }));
		assert.match(bound, /\.\.\. \(ctrl\+g to expand\)$/);
		assert.doesNotMatch(screen(renderCall("memory_write", args, theme, call)), /to expand/);
		assert.equal(screen(renderCall("memory_evict", { private: "value" }, theme, expandedCall)), "memory_evict");
		const clipped = screen(renderCall("memory_write", { slug: "🌍".repeat(40) }, theme, call), 45);
		assert.match(clipped.split("\n")[0], /…$/);
		wellFormed(clipped);
	});
});
