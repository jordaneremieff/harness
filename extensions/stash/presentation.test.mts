import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { stripVTControlCharacters } from "node:util";
import type { Theme, ToolDefinition } from "@earendil-works/pi-coding-agent";
import registerStash from "./index.ts";
import {
	renderCompleteCall,
	renderCompleteResult,
	renderListCall,
	renderListResult,
	renderReadCall,
	renderReadResult,
	renderRotateCall,
	renderRotateResult,
	renderWriteCall,
	renderWriteResult,
} from "./presentation.ts";

const theme = { fg: (_color: string, value: string) => value, bold: (value: string) => value } as unknown as Theme;
const screen = (component: { render(width: number): string[] }, width = 120) =>
	component.render(width).map((line) => stripVTControlCharacters(line).trimEnd()).join("\n");
const lines = (component: { render(width: number): string[] }, width = 120) =>
	component.render(width).map((line) => stripVTControlCharacters(line).trimEnd()).filter((line) => line !== "");

function registeredTools(): Map<string, ToolDefinition> {
	const tools = new Map<string, ToolDefinition>();
	registerStash({
		on: () => {},
		registerCommand: () => {},
		registerShortcut: () => {},
		registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
		sendUserMessage: () => {},
		exec: async () => ({ code: 0, stdout: "", stderr: "", killed: false }),
		appendEntry: () => {},
	} as unknown as Parameters<typeof registerStash>[0]);
	return tools;
}

const text = (value: string) => ({ content: [{ type: "text" as const, text: value }], details: {} });

describe("stash tool registration", () => {
	it("attaches call and result renderers to every stash tool", () => {
		const tools = registeredTools();
		const expected: Array<[string, unknown, unknown]> = [
			["stash_write", renderWriteCall, renderWriteResult],
			["stash_list", renderListCall, renderListResult],
			["stash_read", renderReadCall, renderReadResult],
			["stash_complete", renderCompleteCall, renderCompleteResult],
			["stash_rotate", renderRotateCall, renderRotateResult],
		];
		for (const [name, call, result] of expected) {
			assert.equal(tools.get(name)?.renderCall, call, name);
			assert.equal(tools.get(name)?.renderResult, result, name);
		}
	});
});

describe("stash_write cards", () => {
	it("names the title and summarizes the payload shape in one qualifier row", () => {
		const view = renderWriteCall(
			{
				title: "Registry tool cards",
				summary: "What is true now.",
				decisions: ["one", "two"],
				openLoops: ["question"],
				nextActions: ["a", "b", "c"],
				files: ["extensions/stash/presentation.ts"],
				tags: ["continuity"],
			},
			theme,
			{ expanded: false, argsComplete: true },
		);
		const shown = screen(view);
		assert.match(shown, /stash_write · Registry tool cards/);
		assert.match(shown, /summary 17 chars/);
		assert.match(shown, /2 decisions · 1 loop · 3 actions · 1 file · 1 tag/);
		assert.match(shown, /(?:to expand arguments|expand for arguments)/i);
		assert.doesNotMatch(shown, /What is true now/);
		assert.equal(lines(view).length, 2);
	});

	it("shows full arguments with controls escaped when expanded", () => {
		const args = { title: "line\nbreak\ttab", summary: "body" };
		const view = renderWriteCall(args, theme, { expanded: true, argsComplete: true });
		const shown = screen(view);
		assert.match(shown, /"summary": "body"/);
		assert.match(shown, /line\\nbreak\\ttab/);
		assert.doesNotMatch(shown, /[\x1b\x07]/);
	});

	it("tolerates streaming, missing, and malformed arguments", () => {
		assert.match(screen(renderWriteCall({ summary: "partial" }, theme, { argsComplete: false })), /stash_write\s/);
		const missing = screen(renderWriteCall(undefined, theme, { argsComplete: true }));
		assert.match(missing, /stash_write · \(untitled\)/);
		assert.doesNotMatch(missing, /summary/);
		const hostile = renderWriteCall(
			{ title: `\x1b]52;c;clip\x07${"long ".repeat(60)}`, summary: "x" },
			theme,
			{ expanded: false, argsComplete: true },
		);
		const shown = screen(hostile, 60);
		assert.doesNotMatch(shown, /[\x1b\x07]/);
		assert.ok(shown.includes("…"));
	});

	it("marks checkpoint writes without the handover subject", () => {
		const shown = screen(renderWriteCall({ checkpoint: true, title: "Synthesis", summary: "s" }, theme, { argsComplete: true }));
		assert.match(shown, /checkpoint/);
	});

	it("reports a handover record without claiming the effort is complete", () => {
		const result = {
			content: [{ type: "text" as const, text: "Stashed \"x\" as 20260928T101010Z-x\n/path/stash.md" }],
			details: { id: "20260928T101010Z-x", path: "/path/stash.md", state: "open" },
		};
		const before = structuredClone(result);
		const view = renderWriteResult(result, { expanded: false, isPartial: false }, theme, { isError: false });
		const shown = screen(view);
		assert.match(shown, /20260928T101010Z-x written · open/);
		assert.doesNotMatch(shown, /\/path\/stash\.md/);
		assert.doesNotMatch(shown, /complet/i);
		assert.equal(lines(view).length, 1);
		const expanded = screen(renderWriteResult(result, { expanded: true, isPartial: false }, theme, { isError: false }));
		assert.match(expanded, /Stashed "x"/);
		assert.match(expanded, /\/path\/stash\.md/);
		assert.deepEqual(result, before);
	});

	it("distinguishes checkpoints from pickup handovers", () => {
		const result = text("Saved working checkpoint \"Synthesis\".");
		result.details = { path: "/path/checkpoints/x.md", checkpoint: true };
		const shown = screen(renderWriteResult(result, { expanded: false, isPartial: false }, theme, { isError: false }));
		assert.match(shown, /checkpoint saved · not listed for pickup/);
	});

	it("renders errors, partial state, and malformed details safely", () => {
		const error = screen(
			renderWriteResult(text("stash_write failed: store unavailable"), { expanded: false, isPartial: false }, theme, { isError: true }),
		);
		assert.match(error, /stash_write failed: store unavailable/);
		assert.match(screen(renderWriteResult(text(""), { expanded: false, isPartial: true }, theme, { isError: false })), /Saving stash\.\.\./);
		const malformed = screen(renderWriteResult({ content: [], details: "broken" } as never, { expanded: false, isPartial: false }, theme, { isError: false }));
		assert.ok(malformed.trim().length > 0);
		const absent = screen(renderWriteResult(text("fallback"), { expanded: false, isPartial: false }, theme, { isError: false }));
		assert.match(absent, /fallback/);
	});
});

describe("stash_list cards", () => {
	it("names the query with its filters and continuations", () => {
		const shown = screen(
			renderListCall({ query: "registry tool", tag: "continuity", limit: 5, cursor: "opaque" }, theme, { argsComplete: true }),
		);
		assert.match(shown, /stash_list · "registry tool"/);
		assert.match(shown, /tag continuity · limit 5/);
		assert.match(shown, /(?:to expand arguments|expand for arguments)/i);
		assert.match(screen(renderListCall({}, theme, { argsComplete: true })), /stash_list · recent/);
	});

	it("summarizes a search page with counts, coverage, states, and continuation", () => {
		const result = text(JSON.stringify({ matches: [{ id: "a", excerpt: "the remembered decision" }] }));
		result.details = {
			matches: [{ id: "a", title: "A", state: "open", excerpt: "the remembered decision" }],
			skipped: [],
			coverage: { complete: true },
			nextCursor: "cursor-1",
		};
		const shown = screen(renderListResult(result, { expanded: false, isPartial: false }, theme, { isError: false }));
		assert.match(shown, /1 match · 0 skipped · coverage complete/);
		assert.match(shown, /open 1/);
		assert.match(shown, /continuation available/);
		assert.doesNotMatch(shown, /↳|remembered decision/);
	});

	it("keeps an empty partial page from reading as proof of absence", () => {
		const result = text("{}");
		result.details = { matches: [], skipped: [{ id: "b", reason: "unreadable" }], coverage: { complete: false }, nextCursor: null };
		const shown = screen(renderListResult(result, { expanded: false, isPartial: false }, theme, { isError: false }));
		assert.match(shown, /0 matches · 1 skipped · coverage partial/);
		assert.doesNotMatch(shown, /no stashes|not found/i);
	});

	it("agrees in number and marks an omitted state", () => {
		const single = text("x");
		single.details = { count: 1, ids: ["a"], states: ["open"], truncated: false };
		assert.match(screen(renderListResult(single, { expanded: false, isPartial: false }, theme, { isError: false })), /1 stash listed/);
		const many = text("x");
		many.details = { count: 6, ids: [], states: ["a", "b", "c", "d", "e", "f"], truncated: false };
		assert.match(screen(renderListResult(many, { expanded: false, isPartial: false }, theme, { isError: false })), /\+2 more/);
	});

	it("summarizes recent-list pages by state with truncation and empty stores", () => {
		const listed = text("ids");
		listed.details = { count: 2, ids: ["20260928T1-a", "20260928T2-b"], states: ["open", "closed"], truncated: true };
		const shown = screen(renderListResult(listed, { expanded: false, isPartial: false }, theme, { isError: false }));
		assert.match(shown, /2 stashes listed/);
		assert.match(shown, /open 1, closed 1 · list truncated/);
		const empty = text("No stashes found.");
		empty.details = { count: 0 };
		assert.match(screen(renderListResult(empty, { expanded: false, isPartial: false }, theme, { isError: false })), /0 stashes listed/);
		const malformed = screen(renderListResult(text("raw"), { expanded: false, isPartial: false }, theme, { isError: false }));
		assert.match(malformed, /raw/);
	});
});

describe("stash_read, stash_complete, and stash_rotate cards", () => {
	it("shows the requested id and the page versus the file", () => {
		assert.match(screen(renderReadCall({ id: "20260928T101010Z-x" }, theme, { argsComplete: true })), /stash_read · 20260928T101010Z-x/);
		const result = text("body");
		result.details = { path: "/path/stash.md", truncated: true, controlsEscaped: true, totalBytes: 1000, totalLines: 40 };
		const shown = screen(renderReadResult(result, { expanded: false, isPartial: false }, theme, { isError: false }));
		assert.match(shown, /artifact read · 40 lines · truncated, full artifact remains in the file/);
		assert.doesNotMatch(shown, /\/path\/stash\.md/);
		assert.doesNotMatch(shown, /20260928T101010Z-x/);
		assert.match(screen(renderReadResult(result, { expanded: true, isPartial: false }, theme, { isError: false })), /path: \/path\/stash\.md/);
	});

	it("leads a read with the artifact's frontmatter state and title", () => {
		const artifact = '---\nid: "x"\ntitle: "Add evidence-based application change review"\nstate: "open"\n---\n\nbody';
		const result = text(artifact);
		result.details = { path: "/path/x.md", truncated: false, totalLines: 91 };
		const shown = screen(renderReadResult(result, { expanded: false, isPartial: false }, theme, { isError: false }));
		assert.match(shown, /open · Add evidence-based application change review · 91 lines/);
	});

	it("previews the requested outcome and records retention on close", () => {
		const call = screen(renderCompleteCall({ id: "20260928T-x", outcome: "Shipped in release 1.2" }, theme, { argsComplete: true }));
		assert.match(call, /stash_complete · 20260928T-x/);
		assert.match(call, /outcome: Shipped in release 1\.2/);
		const result = text("Closed stash 20260928T-x.\nOutcome: Shipped in release 1.2");
		result.details = { id: "20260928T-x", state: "closed", outcome: "Shipped in release 1.2" };
		const shown = screen(renderCompleteResult(result, { expanded: false, isPartial: false }, theme, { isError: false }));
		assert.match(shown, /closed · artifact retained/);
		assert.doesNotMatch(shown, /Shipped in release 1\.2/);
		assert.match(screen(renderCompleteResult(result, { expanded: true, isPartial: false }, theme, { isError: false })), /Outcome: Shipped in release 1\.2/);
	});

	it("reports rotation as recoverable archiving", () => {
		assert.match(screen(renderRotateCall({ id: "stale-id" }, theme, { argsComplete: true })), /stash_rotate · stale-id/);
		const result = text("Rotated stash stale-id to the stash archive.");
		result.details = { id: "stale-id", state: "rotated", archivePath: "/store/.trash/stale-id.md" };
		const shown = screen(renderRotateResult(result, { expanded: false, isPartial: false }, theme, { isError: false }));
		assert.match(shown, /rotated · recoverable/);
		assert.match(shown, /\/store\/\.trash\/stale-id\.md/);
		const error = screen(renderRotateResult(text("rotate failed: active stash"), { expanded: false, isPartial: false }, theme, { isError: true }));
		assert.match(error, /rotate failed: active stash/);
	});

	it("reuses the previous component and bounds the expanded body", () => {
		const initial = renderReadCall({ id: "x" }, theme, { expanded: false, argsComplete: true });
		const updated = renderReadCall({ id: "x", extra: "ignored" } as never, theme, { expanded: true, argsComplete: true, lastComponent: initial });
		assert.equal(initial, updated);
		const long = "line\n".repeat(9000);
		const expanded = screen(renderReadResult(text(long), { expanded: true, isPartial: false }, theme, { isError: false }), 400);
		assert.match(expanded, /Display limit; full text remains in native tool history/);
		assert.ok(expanded.length < 90_000);
	});
});

describe("stash card safety", () => {
	const hostile = "safe\u009b\u202e\x1b[31m";
	it("escapes C0, C1, and bidi controls in collapsed and expanded views", () => {
		assert.doesNotMatch(screen(renderWriteCall({ title: hostile, summary: hostile }, theme, { expanded: false, argsComplete: true })), /[\x1b\u009b\u202e]/u);
		assert.doesNotMatch(
			screen(renderWriteCall({ title: "t", summary: hostile }, theme, { expanded: true, argsComplete: true })),
			/[\x1b\u009b\u202e]/u,
		);
		const result = text(hostile);
		result.details = { id: "x", state: hostile, path: hostile };
		assert.doesNotMatch(screen(renderWriteResult(result, { expanded: false, isPartial: false }, theme, { isError: false })), /[\x1b\u009b\u202e]/u);
		assert.doesNotMatch(screen(renderWriteResult(result, { expanded: true, isPartial: false }, theme, { isError: false })), /[\x1b\u009b\u202e]/u);
	});
	it("escapes values taken from list details", () => {
		const result = text("{}");
		result.details = { count: 1, ids: [hostile], states: [hostile], truncated: false };
		assert.doesNotMatch(screen(renderListResult(result, { expanded: false, isPartial: false }, theme, { isError: false })), /[\x1b\u009b\u202e]/u);
	});
	it("tolerates null and undefined arguments", () => {
		assert.doesNotThrow(() => renderWriteCall(null, theme, { expanded: false, argsComplete: false }));
		assert.doesNotThrow(() => renderListCall(null, theme, { expanded: false, argsComplete: false }));
		assert.doesNotThrow(() => renderReadCall(undefined, theme, { expanded: false, argsComplete: false }));
		assert.doesNotThrow(() => renderCompleteCall(null, theme, { expanded: false, argsComplete: false }));
		assert.doesNotThrow(() => renderRotateCall(null, theme, { expanded: false, argsComplete: false }));
	});
});
