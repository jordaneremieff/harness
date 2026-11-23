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
import { Text, type TUI, visibleWidth } from "@earendil-works/pi-tui";
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

describe("memory_search in Pi's tool component", () => {
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
		const tool = toolDisplay().tools.find(({ name }) => name === "memory_search");
		assert.ok(tool?.renderCall && tool.renderResult);
		const { renderResult: render } = tool;
		let hostTheme: Theme | undefined;
		const definition = {
			...tool,
			renderResult: ((response, options, theme, context) => {
				hostTheme = theme;
				return render(response, options, theme, context);
			}) satisfies NonNullable<ToolDefinition["renderResult"]>,
		} as ToolDefinition;
		const component = (args: Record<string, unknown>) =>
			new ToolExecutionComponent(
				"memory_search",
				"call-search",
				args,
				undefined,
				definition,
				{ requestRender() {} } as unknown as TUI,
				".",
			);
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

describe("memory_edit cards", () => {
	it("names the subject and edit count while withholding both texts in every view", () => {
		const args = {
			slug: "editor-choice",
			expectedDigest: "a".repeat(64),
			verified: false,
			edits: [{ oldText: "private old text", newText: "private new text" }],
		};
		for (const context of [call, expandedCall]) {
			const shown = screen(renderCall("memory_edit", args, theme, context));
			assert.match(shown, /memory_edit · editor-choice/);
			assert.doesNotMatch(shown, /private old text|private new text/);
		}
		assert.match(screen(renderCall("memory_edit", args, theme, call)), /1 edit/);
		assert.match(screen(renderCall("memory_edit", args, theme, expandedCall)), /"oldText": "<withheld: 16 chars>"/);
	});

	it("escapes controls, bounds long payloads, and handles partial arguments", () => {
		const args = { slug: "\x1b]52;c;clip\x07", edits: [{ oldText: "x".repeat(40000), newText: "\x1b" }] };
		for (const context of [call, expandedCall]) {
			const shown = screen(renderCall("memory_edit", args, theme, context), 40);
			assert.doesNotMatch(shown, /[\x1b\x07]/);
			assert.ok(shown.length < 1000);
			wellFormed(shown);
		}
		for (const args of [null, {}, { edits: "partial" }]) {
			assert.match(screen(renderCall("memory_edit", args, theme, { argsComplete: false })), /memory_edit/);
		}
	});

	it("uses publication receipts for success and failure and escapes expanded evidence", () => {
		const receipt = {
			ok: true,
			slug: "editor-choice",
			written: ["editor-choice.md"],
			notWritten: [],
			digest: "12345678abcdef",
			initialized: false,
		};
		assert.match(
			screen(renderResult("memory_edit", result("saved", receipt), collapsed, theme, okContext)),
			/editor-choice edited/,
		);
		const failed = { ...receipt, ok: false, written: [], notWritten: ["editor-choice.md"], error: "Source changed" };
		const shown = screen(
			renderResult(
				"memory_edit",
				result(`Memory write incomplete: ${JSON.stringify(failed)}`, undefined),
				collapsed,
				theme,
				errorContext,
			),
		);
		assert.match(shown, /edit failed.*editor-choice.*Source changed/);
		assert.match(
			screen(renderResult("memory_edit", result("Unknown refusal", undefined), collapsed, theme, errorContext)),
			/edit incomplete/,
		);
		assert.match(
			screen(
				renderResult(
					"memory_edit",
					result("", { ...failed, written: ["editor-choice.md"] }),
					collapsed,
					theme,
					errorContext,
				),
			),
			/edit incomplete/,
		);
		assert.match(
			screen(renderResult("memory_edit", result("", {}), { ...collapsed, isPartial: true }, theme, okContext)),
			/Editing note/,
		);
		const expanded = screen(
			renderResult("memory_edit", result("Evidence\x1b[2J", receipt), expandedView, theme, okContext),
		);
		assert.match(expanded, /Evidence/);
		assert.doesNotMatch(expanded, /\x1b/);
		assert.match(screen(renderResult("memory_edit", result("", null), collapsed, theme, okContext)), /memory_edit/);
	});
});

describe("memory review and retirement cards", () => {
	it("withholds reasons and sources in every mutation call view", () => {
		for (const name of ["memory_review", "memory_retire"]) {
			const args = {
				slug: "subject",
				expectedDigest: "a".repeat(64),
				outcome: "confirmed",
				reactivate: true,
				reason: "private reason",
				sources: "private source",
			};
			const before = structuredClone(args);
			for (const view of [call, expandedCall]) {
				const shown = screen(renderCall(name, args, theme, view));
				assert.ok(shown.includes(`${name} · subject`));
				assert.doesNotMatch(shown, /private reason|private source/);
			}
			assert.match(screen(renderCall(name, args, theme, expandedCall)), /"reason": "<withheld: 14 chars>"/);
			assert.match(screen(renderCall(name, args, theme, expandedCall)), /"sources": "<withheld: 14 chars>"/);
			assert.deepEqual(args, before);
		}
		assert.match(
			screen(renderCall("memory_review", { slug: "subject", outcome: "confirmed", reactivate: true }, theme, call)),
			/confirmed · reactivation requested/,
		);
	});

	it("uses shared receipt semantics without claiming a review confirmed the note", () => {
		for (const [name, operation, past] of [
			["memory_review", "review", "reviewed"],
			["memory_retire", "retire", "retired"],
		]) {
			const receipt = {
				ok: true,
				slug: "subject",
				written: ["subject.md"],
				notWritten: [],
				captured: [{ revision: "prior" }],
			};
			const shown = screen(renderResult(name, result("stored", receipt), collapsed, theme, okContext));
			assert.ok(shown.includes(`subject ${past}`));
			assert.match(shown, /1 prior captures/);
			assert.doesNotMatch(shown, /confirmed|reactivated/);
			const failed = { ...receipt, ok: false, written: [], notWritten: ["subject.md"], error: "Source changed" };
			const failure = screen(
				renderResult(
					name,
					result(`Memory write incomplete: ${JSON.stringify(failed)}`, undefined),
					collapsed,
					theme,
					errorContext,
				),
			);
			assert.ok(failure.includes(`${operation} failed`));
			assert.match(failure, /Source changed/);
			assert.match(
				screen(renderResult(name, result("", {}), { ...collapsed, isPartial: true }, theme, okContext)),
				/note\.\.\./,
			);
		}
	});

	it("handles partial, malformed, hostile and narrow call views without leaking payloads", () => {
		for (const name of ["memory_review", "memory_retire"])
			for (const args of [null, {}, { slug: "subject\x1b[2J", reason: "r".repeat(10000), sources: "\x07" }])
				for (const expanded of [false, true]) {
					const shown = screen(renderCall(name, args, theme, { argsComplete: false, expanded }), 24);
					assert.doesNotMatch(shown, /[\x1b\x07]|r{50}/);
					assert.ok(shown.length < 1000);
					wellFormed(shown);
				}
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

	it("bounds collapsed subject previews and shows zero-match guidance without expansion", () => {
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
			assert.match(shown, /Try alternate inflections, exact identifier forms, or quoted fragments/);
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

describe("memory_read result cards", () => {
	const notePage = {
		ok: true,
		kind: "note",
		slug: "provider-lessons",
		file: "provider-lessons.md",
		source: "note",
		digest: "0f1e2d3c".repeat(8),
		offset: 0,
		nextOffset: 12000,
		totalCodePoints: 19000,
		contentCodePoints: 12000,
		hasMore: true,
		lifecycle: { status: "active", supersededBy: null },
		content: "page one",
	};

	it("separates the returned page from the remaining source", () => {
		const view = renderResult("memory_read", result("page one", notePage), collapsed, theme, okContext);
		const shown = screen(view);
		assert.match(shown, /provider-lessons · 12000 of 19000 chars · more/);
		assert.match(shown, /status active/);
		assert.match(shown, /(?:to expand result|expand for result)/i);
		assert.equal(lines(view).length, 2);
	});

	it("marks the final page and contract source", () => {
		const details = {
			...notePage,
			hasMore: false,
			nextOffset: 19000,
			offset: 12000,
			contentCodePoints: 7000,
			source: "contract",
			lifecycle: null,
		};
		const shown = screen(renderResult("memory_read", result("t", details), collapsed, theme, okContext));
		assert.match(shown, /7000 of 19000 chars/);
		assert.doesNotMatch(shown, /· more/);
		assert.match(shown, /contract source/);
	});

	it("shows actual source text with digest, code-point range, and escaped terminal controls", () => {
		const details = { ...notePage, content: "# Actual title\n\nFirst line\nSecond line\tvalue\x1b[2J\u202e" };
		const response = result(JSON.stringify(details), details);
		const before = structuredClone(response);
		const shown = screen(renderResult("memory_read", response, expandedView, theme, okContext), 200);
		assert.match(shown, /# Actual title\n\nFirst line\nSecond line\\tvalue\\u\{1b\}\[2J\\u\{202e\}/);
		assert.match(shown, /Digest: (?:0f1e2d3c){8}/);
		assert.match(shown, /Source range: \[0, 12000\) code points/);
		assert.match(shown, /Continue at offset 12000 with the same digest/);
		assert.doesNotMatch(shown, /"content":|\\nFirst|\x1b|\u202e/);
		assert.deepEqual(response, before);
	});

	it("keeps supersession and unknown lifecycle warnings visible in both views", () => {
		for (const lifecycle of [
			{ status: "superseded", supersededBy: "new-subject" },
			{ status: "unknown", supersededBy: null, problem: "invalid or ambiguous frontmatter" },
			{ status: "retired", supersededBy: null },
		])
			for (const view of [collapsed, expandedView]) {
				const details = { ...notePage, lifecycle };
				const shown = screen(
					renderResult("memory_read", result(JSON.stringify(details), details), view, colorTheme, okContext),
					200,
				);
				assert.match(shown, /\{warning\}/);
				assert.match(shown, new RegExp(`status ${lifecycle.status}`));
				if (lifecycle.supersededBy) assert.match(shown, /replacement new-subject/);
				if (lifecycle.problem) assert.match(shown, /Lifecycle problem: invalid or ambiguous frontmatter/);
			}
	});

	it("keeps the escaped display within its bound and leaves the full result intact", () => {
		const details = { ...notePage, content: "\u0001".repeat(12000) };
		const response = result(JSON.stringify(details), details);
		const shown = screen(renderResult("memory_read", response, expandedView, theme, okContext), 100000);
		assert.ok(shown.length < 32200);
		assert.match(shown, /Display limit; full text remains in native tool history/);
		assert.doesNotMatch(shown, /\u0001/);
		assert.equal(response.details, details);
		assert.equal(details.content.length, 12000);
		wellFormed(shown);
	});

	it("renders errors, partial state, and malformed details safely", () => {
		const error = screen(
			renderResult(
				"memory_read",
				result(
					'Error: note source changed since the supplied digest: provider-lessons.md. Restart memory_read with {"slug":"provider-lessons","offset":0} without digest for the current note and digest. If the slug is absent, use memory_search; do not continue the previous page',
					undefined,
				),
				collapsed,
				theme,
				errorContext,
			),
		);
		assert.match(error, /note source changed since the supplied digest/);
		assert.match(error, /Restart memory_read with/);
		assert.match(error, /"slug":"provider-lessons","offset":0/);
		assert.match(error, /without digest for the current note and digest/);
		assert.match(error, /If the slug is absent, use\s+memory_search/);
		const missing =
			"note not found: absent.md. Use memory_search to find the current slug; read it from offset 0 with its current digest";
		assert.match(
			screen(renderResult("memory_read", result(missing, undefined), collapsed, theme, errorContext), 200),
			/memory_search.*offset 0.*current digest/,
		);
		assert.match(
			screen(renderResult("memory_read", result("", {}), { expanded: false, isPartial: true }, theme, okContext)),
			/Reading note\.\.\./,
		);
		const malformed = screen(renderResult("memory_read", result("fallback", "broken"), collapsed, theme, okContext));
		assert.match(malformed, /fallback/);
	});
});

describe("freshness evidence cards", () => {
	const freshness = {
		evaluatedOn: "2026-09-29",
		verified: true,
		verifiedDate: "2026-01-01",
		policy: "before-use",
		reviewAfter: "2026-09-01",
		deadline: "due",
		concern: {
			date: "2026-09-28",
			reason: "Only the release claim differs.\x1b[2J",
			sources: "Current release source.",
		},
		lastReview: { date: "2026-01-01", digest: "b".repeat(64), sources: "Inspected prior source." },
		retirement: null,
		problems: ["Verification date requires interpretation"],
	};
	it("exposes policy, deadline and concerns without labeling the note fresh or false", () => {
		const details = {
			slug: "subject",
			source: "note",
			content: "Source body",
			lifecycle: { status: "active", supersededBy: null },
			freshness,
		};
		const response = result(JSON.stringify(details), details);
		const before = structuredClone(response);
		const compact = screen(renderResult("memory_read", response, collapsed, colorTheme, okContext), 300);
		assert.match(compact, /\{warning\}.*subject/);
		assert.match(compact, /review due · unresolved concern · 1 freshness problems/);
		const expanded = screen(renderResult("memory_read", response, expandedView, theme, okContext), 300);
		for (const pattern of [
			/Freshness evaluated on: 2026-09-29/,
			/Declared verified: true/,
			/Declared verification date: 2026-01-01/,
			/Review policy: before-use/,
			/Review deadline: due/,
			/Review after: 2026-09-01/,
			/Unresolved concern reason: Only the release claim differs\.\\u\{1b\}\[2J/,
			/Unresolved concern sources: Current release source\./,
			/Last review digest: b{64}/,
			/Last review sources: Inspected prior source\./,
			/Freshness problem: Verification date requires interpretation/,
			/Metadata records declarations, not proof of current truth\./,
		])
			assert.match(expanded, pattern);
		assert.doesNotMatch(expanded, /\x1b|status false|status fresh/);
		assert.deepEqual(response, before);
	});

	it("preserves retired and historical evidence in search and direct reads", () => {
		const note = {
			slug: "subject",
			lifecycle: { status: "retired", supersededBy: null },
			freshness: {
				...freshness,
				retirement: { date: "2026-09-29", reason: "Withdrawn by operator.", sources: "Current instruction." },
			},
		};
		const details = {
			notes: [note],
			includeRetired: true,
			excludedRetired: 0,
			returned: 1,
			totalNotes: 1,
			scan: { complete: true, issueCount: 0, retiredNotes: 1 },
		};
		assert.match(screen(renderCall("memory_search", { includeRetired: true }, theme, call)), /includes retired/);
		const search = screen(renderResult("memory_search", result("", details), expandedView, theme, okContext), 300);
		assert.match(search, /Includes retired notes: true/);
		assert.match(search, /Retired notes in this window: 1/);
		assert.match(search, /status retired/);
		assert.match(search, /Retirement reason: Withdrawn by operator\./);
		const excluded = { ...details, notes: [], includeRetired: false, excludedRetired: 1, returned: 0, totalNotes: 0 };
		assert.match(
			screen(renderResult("memory_search", result("", excluded), collapsed, theme, okContext), 300),
			/1 retired note excluded in this window/,
		);
		const history = screen(
			renderResult(
				"memory_read",
				result("", { ...note, source: "history", content: "Prior bytes" }),
				expandedView,
				theme,
				okContext,
			),
			300,
		);
		assert.match(history, /historical evidence · prior status retired/);
		assert.match(history, /Retirement sources: Current instruction\./);
	});

	it("renders unknown and malformed freshness data without upgrading it", () => {
		for (const value of [
			null,
			{},
			"bad",
			{ policy: "unknown", deadline: "unknown", verified: "yes", problems: ["Malformed policy", 1] },
		]) {
			const details = { slug: "subject", content: "text", freshness: value };
			const shown = screen(renderResult("memory_read", result("", details), expandedView, theme, okContext));
			assert.doesNotMatch(shown, /Declared verified: true/);
			if (value && typeof value === "object" && "verified" in value) assert.match(shown, /Declared verified: unknown/);
			wellFormed(shown);
		}
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

describe("historical evidence cards", () => {
	const revision = `20260101T120000000Z-00000000-0000-0000-0000-000000000001-${"a".repeat(64)}`;
	it("keeps exact revision identity and prior lifecycle separate from current authority", () => {
		const details = {
			slug: "subject",
			source: "history",
			revision,
			capturedAt: "2026-01-01T12:00:00.000Z",
			digest: "a".repeat(64),
			lifecycle: { status: "active", supersededBy: null },
			content: "Old source",
			authority: "Historical evidence, not current authority",
			hasMore: true,
			nextOffset: 12,
		};
		for (const options of [collapsed, expandedView]) {
			const shown = screen(renderResult("memory_read", result("", details), options, theme, okContext), 300);
			assert.match(shown, /historical evidence · prior status active/);
			assert.ok(shown.includes(revision.slice(0, 28)), "collapsed keeps the timestamp and first identifier group");
		}
		const fullRevision = screen(renderResult("memory_read", result("", details), expandedView, theme, okContext), 300);
		assert.ok(fullRevision.includes(revision), "expanded keeps the exact revision");
		assert.ok(
			screen(renderCall("memory_read", { slug: "subject", revision }, theme, expandedCall), 300).includes(revision),
		);
		const history = {
			slug: "subject",
			revisions: [{ revision, capturedAt: details.capturedAt, digest: details.digest, bytes: 100 }],
			coverage: { unavailable: 1 },
			nextCursor: "opaque",
			authority: details.authority,
		};
		const expanded = screen(renderResult("memory_history", result("", history), expandedView, theme, okContext), 300);
		assert.ok(expanded.includes(revision));
		assert.match(expanded, /not current authority/);
		assert.match(expanded, /nextCursor: opaque/);
		assert.match(
			screen(renderResult("memory_history", result("", history), collapsed, theme, okContext)),
			/1 unavailable revisions/,
		);
		assert.match(
			screen(renderCall("memory_history", { slug: "subject", cursor: "opaque" }, theme, call)),
			/continuation/,
		);
	});
	it("shows exact history-plan selections and page totals without deletion authority", () => {
		const plan = {
			capturedBefore: "2026-02-01T00:00:00.000Z",
			keepNewest: 1,
			scope: "metadata-page",
			availableBytes: 300,
			keepBytes: 100,
			candidateBytes: 200,
			kept: 1,
			candidates: 1,
			unavailable: 1,
			digestsVerified: false,
			meaning: "The retention floor includes unavailable revision names; it promises no recoverable floor.",
		};
		const details = {
			slug: "subject",
			plan,
			coverage: { unavailable: 1, bodiesRead: false },
			nextCursor: "opaque",
			revisions: [
				{
					revision,
					capturedAt: "2026-01-01T12:00:00.000Z",
					digest: "a".repeat(64),
					bytes: 200,
					selection: "candidate",
					reason: "before-cutoff-outside-floor",
				},
				{ revision: "newest-revision", bytes: 100, selection: "keep", reason: "newest-retention-floor" },
			],
		};
		assert.match(screen(renderCall("memory_history", { slug: "subject", plan }, theme, call)), /read-only plan/);
		assert.match(
			screen(renderResult("memory_history", result("", details), collapsed, theme, okContext), 300),
			/1 candidates on this page; read-only plan/,
		);
		const expanded = screen(renderResult("memory_history", result("", details), expandedView, theme, okContext), 300);
		for (const pattern of [
			/Read-only history plan: captured before 2026-02-01T00:00:00\.000Z; keep newest 1/,
			/Available bytes on this metadata page: 300/,
			/Keep bytes on this metadata page: 100/,
			/Candidate bytes on this metadata page: 200/,
			/Unavailable revisions on this page: 1/,
			/Selection: candidate\nReason: before-cutoff-outside-floor/,
			/Selection: keep\nReason: newest-retention-floor/,
			/Capture-name digests are unverified/,
			/Plan scope: The retention floor includes unavailable revision names; it promises no recoverable floor\./,
			/authorizes no removal/,
			/imposes no retained-storage bound/,
			/Repeat slug and plan with nextCursor: opaque/,
		])
			assert.match(expanded, pattern);
		assert.ok(expanded.includes(revision));
	});
	it("separates prior captures and policy omissions from live publication failure", () => {
		const details = {
			ok: false,
			slug: "subject",
			written: [],
			notWritten: ["subject.md"],
			captured: [{ revision }],
			historyOmitted: [{ file: "other.md", reason: "credential-policy" }],
		};
		const shown = screen(renderResult("memory_write", result("", details), collapsed, theme, errorContext), 300);
		assert.match(shown, /write failed/);
		assert.match(shown, /1 prior captures \(not proof of write success\)/);
		assert.match(shown, /1 history omissions \(credential policy\)/);
	});
});

describe("renderer hygiene", () => {
	it("never splits surrogate pairs when clipping", () => {
		const query = `x${"🌍".repeat(40)}`;
		const shown = screen(renderCall("memory_search", { query }, theme, call), 53);
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

	describe("dense rows and host hints", () => {
		it("uses the host-injected binding and stays neutral without one", () => {
			const pending = { slug: "s", title: "T", summary: "x" };
			assert.match(
				screen(renderCall("memory_write", pending, theme, { ...call, keyText: () => "ctrl+g" })),
				/ctrl\+g to expand arguments/,
			);
			assert.match(
				screen(
					renderResult("memory_read", result("t", { slug: "s" }), collapsed, theme, {
						...okContext,
						keyText: () => "ctrl+g",
					}),
				),
				/ctrl\+g to expand result/,
			);
			for (const neutral of [{ ...call }, { ...call, keyText: () => "" }]) {
				const shown = screen(renderCall("memory_write", pending, theme, neutral));
				assert.match(shown, /Expand for arguments/);
				assert.doesNotMatch(shown, /ctrl\+g/);
			}
		});

		it("bounds collapsed subject rows at 60, 80, and 100 columns", () => {
			const details = {
				ok: true,
				kind: "index",
				query: "provider",
				totalMatches: 1,
				returned: 1,
				hasMore: false,
				notes: [
					{
						slug: "s".repeat(120),
						title: "T".repeat(120),
						lifecycle: { status: "superseded", supersededBy: "r".repeat(60) },
						freshness: { deadline: "due", concern: { reason: "x" }, problems: ["p1"] },
					},
				],
				scan: { complete: true, issueCount: 0 },
				search: { complete: true },
			};
			const view = renderResult("memory_search", result("t", details), collapsed, theme, okContext);
			const shown = screen(view, 100);
			assert.match(shown, /T{10}/);
			assert.match(shown, /s{10}/);
			for (const width of [60, 80, 100]) {
				const rows = view
					.render(width)
					.map((line) => stripVTControlCharacters(line).trimEnd())
					.filter((line) => line !== "");
				const preview = rows.slice(1, -2);
				assert.equal(preview.length, 5, `preview lines at width ${width}`);
				assert.ok(rows.every((row) => visibleWidth(row) <= width));
			}
		});

		it("bounds the collapsed read qualifier row with the same budget", () => {
			const details = {
				slug: "subject",
				source: "history",
				revision: `20260101T120000000Z-${"0".repeat(60)}`,
				lifecycle: { status: "superseded", supersededBy: "replacement", problem: "p".repeat(200) },
				content: "text",
			};
			const view = renderResult("memory_read", result("t", details), collapsed, theme, okContext);
			for (const width of [60, 80, 100]) {
				const rows = view
					.render(width)
					.map((line) => stripVTControlCharacters(line).trimEnd())
					.filter((line) => line !== "");
				assert.ok(rows.length <= 4, `card rows at width ${width}: ${rows.length}`);
			}
			const shown = screen(view, 100);
			assert.match(
				shown,
				/status superseded · replacement replacement/,
				"lifecycle outranks the revision prefix in a crowded row",
			);
			assert.doesNotMatch(shown, /revision 2026/, "the revision prefix yields to the budget");
			const expanded = screen(renderResult("memory_read", result("t", details), expandedView, theme, okContext), 300);
			assert.match(expanded, /Revision: 20260101T120000000Z-0{60}/, "the expanded evidence keeps the exact revision");
		});
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
