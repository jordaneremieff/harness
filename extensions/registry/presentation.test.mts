import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { stripVTControlCharacters } from "node:util";
import type { ExtensionAPI, ExtensionContext, ExtensionToolContext, Theme, ToolDefinition } from "@earendil-works/pi-coding-agent";
import registerRegistry, { type RegistryParams } from "./index.ts";
import { renderRegistryCall, renderRegistryResult } from "./presentation.ts";

const theme = { fg: (_color: string, value: string) => value, bold: (value: string) => value } as unknown as Theme;
const screen = (component: { render(width: number): string[] }, width = 140) =>
	component.render(width).map((line) => stripVTControlCharacters(line).trimEnd()).join("\n");
const rows = (component: { render(width: number): string[] }, width = 100) =>
	component.render(width).map((line) => stripVTControlCharacters(line).trimEnd()).filter((line) => line !== "");
const resultOf = (text: string, details: Record<string, unknown>) => ({ content: [{ type: "text" as const, text }], details });

const sourceInfo = { path: "/fixtures/TOOL.ts", source: "fixture", scope: "temporary" as const, origin: "top-level" as const };
const baseContext = {
	cwd: "/fixtures",
	mode: "rpc",
	hasUI: false,
	isProjectTrusted: () => true,
	model: { provider: "provider", id: "model" },
	thinkingLevel: "high",
	getContextUsage: () => ({ tokens: 7500, contextWindow: 10000, percent: 75 }),
	sessionManager: { getSessionId: () => "session-1", getSessionFile: () => null },
} as unknown as ExtensionContext;
const context = {
	...baseContext,
	tools: [],
	executeTool: async () => { throw new Error("Unexpected nested tool call"); },
} satisfies ExtensionToolContext;

function registryTool(): ToolDefinition<typeof RegistryParams, Record<string, unknown>> {
	let tool: ToolDefinition<typeof RegistryParams, Record<string, unknown>> | undefined;
	const pi = {
		on: () => {},
		events: { emit: () => {}, on: () => () => {} },
		registerTool: (value: NonNullable<typeof tool>) => {
			tool = value;
		},
		getAllTools: () => [
			{ name: "bash", description: "Run a shell command", sourceInfo },
			{ name: "read", sourceInfo },
		],
		getActiveTools: () => ["bash"],
		getCommands: () => [{ name: "skill:example", source: "skill", sourceInfo }],
	} as unknown as ExtensionAPI;
	registerRegistry(pi);
	assert.ok(tool);
	return tool;
}

describe("registry tool registration", () => {
	it("attaches call and result renderers without changing execution", async () => {
		const tool = registryTool();
		assert.equal(tool.renderCall, renderRegistryCall);
		assert.equal(tool.renderResult, renderRegistryResult);
		assert.equal(typeof tool.execute, "function");
		const result = await tool.execute("lookup", {}, undefined, undefined, context);
		assert.equal(result.details?.outcome, "host_summary");
	});
});

describe("registry call card", () => {
	it("names the lookup and carries one qualifier row", () => {
		const named = renderRegistryCall(
			{ name: "registry", kind: "tool", detail: true, limit: 5 },
			theme,
			{ expanded: false, argsComplete: true },
		);
		assert.match(screen(named), /registry · registry/);
		assert.match(screen(named), /tool · detail · limit 5/);
		assert.equal(rows(named).length, 2);
		assert.match(screen(renderRegistryCall({}, theme, { argsComplete: true })), /registry · session overview/);
		assert.equal(rows(renderRegistryCall({}, theme, { argsComplete: true })).length, 1);
		assert.match(screen(renderRegistryCall({ search: "file contents", kind: "tool" }, theme, { argsComplete: true })), /registry · search "file contents"/);
		assert.match(screen(renderRegistryCall({ contains: "needle", kind: "skill" }, theme, { argsComplete: true })), /registry · contains "needle"/);
		assert.match(screen(renderRegistryCall({ kind: "model", provider: "p", available: true }, theme, { argsComplete: true })), /registry · model/);
		assert.match(screen(renderRegistryCall({ kind: "model", provider: "p", available: true }, theme, { argsComplete: true })), /provider p · available only/);
		const continuation = renderRegistryCall({ cursor: "opaque-cursor" }, theme, { argsComplete: true });
		assert.match(screen(continuation), /registry · continuation/);
		assert.doesNotMatch(screen(continuation), /expand result|expand arguments/i);
	});

	it("clips long values, escapes controls, and expands the full arguments", () => {
		const view = renderRegistryCall({ name: `\x1b]52;c;x\x07${"n".repeat(200)}` }, theme, { expanded: false, argsComplete: true });
		const shown = screen(view, 80);
		assert.doesNotMatch(shown, /[\x1b\x07]/);
		assert.match(shown, /(?:to expand arguments|expand for arguments)/i);
		const expanded = screen(renderRegistryCall({ name: "registry", detail: true }, theme, { expanded: true, argsComplete: true }));
		assert.match(expanded, /"detail": true/);
	});
});

describe("registry result card", () => {
	it("summarizes a real host summary with model, context, and counts", async () => {
		const result = await registryTool().execute("host", {}, undefined, undefined, context);
		const view = renderRegistryResult(result, { expanded: false, isPartial: false }, theme, { isError: false });
		const shown = screen(view);
		assert.match(shown, /session overview · model provider\/model · context 75%/);
		assert.match(shown, /tool 2 · command 0 · skill 1 · prompt 0/);
		assert.equal(rows(view).length, 2);
	});

	it("summarizes a real tool listing by count and kind", async () => {
		const result = await registryTool().execute("list", { kind: "tool" }, undefined, undefined, context);
		assert.equal(result.details?.outcome, "ok");
		const view = renderRegistryResult(result, { expanded: false, isPartial: false }, theme, { isError: false });
		const shown = screen(view);
		assert.match(shown, /ok · 2 shown of 2/);
		assert.match(shown, /tool 2/);
		assert.doesNotMatch(shown, /TOOL bash|description:/);
		assert.equal(rows(view).length, 2);
	});

	it("reports no match without claiming absence", async () => {
		const result = await registryTool().execute("miss", { kind: "tool", name: "nope" }, undefined, undefined, context);
		assert.equal(result.details?.outcome, "missing");
		assert.match(screen(renderRegistryResult(result, { expanded: false, isPartial: false }, theme, { isError: false })), /no match · 0 shown of 0/);
	});

	it("keeps the chat-only boundary visible on a missing model card", async () => {
		const modelContext = { ...context, model: undefined, scopedModels: [], modelRegistry: {
			getAll: () => [], getAvailable: () => [], getError: () => undefined, getRegisteredProviderIds: () => [],
		} } as unknown as ExtensionToolContext;
		const result = await registryTool().execute("model", { kind: "model", name: "cloudflare-workers-ai/@cf/cloudflare/clef" }, undefined, undefined, modelContext);
		assert.equal(result.details?.outcome, "missing");
		const card = renderRegistryResult(result, { expanded: false, isPartial: false }, theme, { isError: false });
		const shown = screen(card);
		assert.match(shown, /no match · 0 shown of 0 · chat models only/);
		assert.match(shown, /Classifier\/image discovery: codemode models\.\*/);
		assert.match(shown, /(?:to expand result|expand for result)/i);
		assert.equal(rows(card, 140).length, 2);
		const expanded = screen(renderRegistryResult(result, { expanded: true, isPartial: false }, theme, { isError: false }));
		assert.match(expanded, /missing here does not establish their absence/);
		assert.match(expanded, /models\.getModelsOfType\("classifier"\)/);
	});
	it("summarizes a scanned file result with counts, scan coverage, and bounds", () => {
		const scanned = resultOf("registry outcome=ok", {
			outcome: "ok",
			scanned: true,
			resolved: { kind: "skill", name: "example" },
			total: 2,
			returnedRecords: 2,
			records: [{ line: 3, text: "needle here" }],
			partialScan: false,
		});
		const view = renderRegistryResult(scanned, { expanded: false, isPartial: false }, theme, { isError: false });
		const shown = screen(view);
		assert.match(shown, /ok · 2 of 2 matches · in skill example/);
		assert.match(shown, /whole file scanned/);
		assert.match(shown, /(?:to expand result|expand for result)/i);
		const partial = screen(
			renderRegistryResult(
				resultOf("x", { outcome: "partial", scanned: true, resolved: { kind: "skill", name: "example" }, total: 3, returnedRecords: 1, records: [], partialScan: true }),
				{ expanded: false, isPartial: false },
				theme,
				{ isError: false },
			),
		);
		assert.match(partial, /partial scan · 1 of 3 matches · in skill example/);
		assert.match(partial, /scan partial · absence not established/);
	});

	it("reports bounds, page blocking, and continuation", () => {
		const bounded = resultOf("x", {
			outcome: "ok",
			total: 5,
			returnedRecords: 2,
			records: [{ kind: "tool", name: "a" }, { kind: "tool", name: "b" }],
			resultBounded: true,
			omittedRecordBlocks: 3,
			cursor: "opaque",
		});
		const shown = screen(renderRegistryResult(bounded, { expanded: false, isPartial: false }, theme, { isError: false }));
		assert.match(shown, /ok · 2 shown of 5/);
		assert.match(shown, /tool 2 · 3 omitted from this page · continuation available/);
		const blocked = resultOf("x", { outcome: "ok", total: 5, returnedRecords: 0, records: [], resultBounded: true, omittedRecordBlocks: 5, pageBlocked: true });
		assert.match(screen(renderRegistryResult(blocked, { expanded: false, isPartial: false }, theme, { isError: false })), /first record exceeds the result bound/);
	});

	it("distinguishes stale cursors, read errors, and invalid arguments", () => {
		const stale = screen(renderRegistryResult(resultOf("x", { outcome: "stale_cursor", staleCursor: true, reason: "the session changed" }), { expanded: false, isPartial: false }, theme, { isError: false }));
		assert.match(stale, /stale cursor · the session changed/);
		const io = screen(renderRegistryResult(resultOf("x", { outcome: "io_error", scanned: false, ioError: "EACCES" }), { expanded: false, isPartial: false }, theme, { isError: false }));
		assert.match(io, /read error · EACCES/);
		const invalid = screen(renderRegistryResult(resultOf("x", { outcome: "invalid_arguments", reason: "invalid_arguments" }), { expanded: false, isPartial: false }, theme, { isError: false }));
		assert.match(invalid, /invalid arguments/);
		assert.doesNotMatch(invalid, /· invalid_arguments/);
		const cancelled = screen(renderRegistryResult(resultOf("x", { outcome: "cancelled", cancelled: true }), { expanded: false, isPartial: false }, theme, { isError: false }));
		assert.match(cancelled, /cancelled/);
	});

	it("summarizes a model discovery page with kind counts and a health line", () => {
		const discovery = resultOf("x", {
			outcome: "ok",
			total: 3,
			returnedRecords: 2,
			records: [{ kind: "model", name: "p/a" }, { kind: "model", name: "p/b" }],
			cursor: "next",
		});
		const shown = screen(renderRegistryResult(discovery, { expanded: false, isPartial: false }, theme, { isError: false }));
		assert.match(shown, /ok · 2 shown of 3/);
		assert.match(shown, /model 2 · continuation available/);
	});

	it("replaces the tally with key facts for a single-record page", () => {
		const model = resultOf("x", {
			outcome: "ok",
			total: 1,
			returnedRecords: 1,
			records: [
				{
					kind: "model",
					name: "provider/model",
					available: true,
					configuredAuth: true,
					contextWindow: 1_000_000,
					supportedThinkingLevels: ["low", "high", "max"],
				},
			],
		});
		const shown = screen(renderRegistryResult(model, { expanded: false, isPartial: false }, theme, { isError: false }));
		assert.match(shown, /ok · 1 shown of 1/);
		assert.match(shown, /available \(cached\) · auth configured · 1M context · thinking low, high, max/);
		assert.doesNotMatch(shown, /model 1/);
		const tool = resultOf("x", { outcome: "ok", total: 1, returnedRecords: 1, records: [{ kind: "tool", name: "bash", configured: true, active: true }] });
		assert.match(screen(renderRegistryResult(tool, { expanded: false, isPartial: false }, theme, { isError: false })), /configured · active/);
		const unknown = resultOf("x", { outcome: "ok", total: 1, returnedRecords: 1, records: [{ kind: "command", name: "x" }] });
		assert.match(screen(renderRegistryResult(unknown, { expanded: false, isPartial: false }, theme, { isError: false })), /command 1/);
		const many = resultOf("x", {
			outcome: "ok",
			total: 8,
			returnedRecords: 8,
			records: ["a", "b", "c", "d", "e", "f", "g", "h"].map((kind) => ({ kind, name: kind })),
		});
		assert.match(screen(renderRegistryResult(many, { expanded: false, isPartial: false }, theme, { isError: false })), /\+2 more/);
	});

	it("rounds the host context percent to a whole number", () => {
		const result = resultOf("x", {
			outcome: "host_summary",
			host: true,
			context: { model: "provider/model", percent: 8.1392, state: "available" },
			counts: { tool: 1, command: 0, skill: 0, prompt: 0 },
		});
		assert.match(screen(renderRegistryResult(result, { expanded: false, isPartial: false }, theme, { isError: false })), /context 8%/);
	});

	it("handles partial state, errors, empty details, and malformed details", () => {
		assert.match(
			screen(renderRegistryResult(resultOf("", {}), { expanded: false, isPartial: true }, theme, { isError: false })),
			/Reading the registry\.\.\./,
		);
		const errored = screen(renderRegistryResult(resultOf("registry failed", {}), { expanded: false, isPartial: false }, theme, { isError: true }));
		assert.match(errored, /registry failed/);
		assert.match(screen(renderRegistryResult(resultOf("plain text", {}), { expanded: false, isPartial: false }, theme, { isError: false })), /plain text/);
		assert.ok(screen(renderRegistryResult({ content: [], details: "broken" } as never, { expanded: false, isPartial: false }, theme, { isError: false })).trim().length > 0);
	});

	it("escapes controls, expands the bounded text, and reuses the previous component", () => {
		const hostile = screen(renderRegistryResult(resultOf("outcome=ok\x1b]52;c;d\x07\u202e", { outcome: "ok" }), { expanded: false, isPartial: false }, theme, { isError: false }));
		assert.doesNotMatch(hostile, /[\x1b\x07\u202e]/u);
		const initial = renderRegistryCall({ name: "x" }, theme, { expanded: false, argsComplete: true });
		const updated = renderRegistryCall({ name: "x" }, theme, { expanded: true, argsComplete: true, lastComponent: initial });
		assert.equal(initial, updated);
		assert.match(screen(updated), /"name": "x"/);
		const long = "line\n".repeat(9000);
		const expanded = screen(renderRegistryResult(resultOf(long, { outcome: "ok" }), { expanded: true, isPartial: false }, theme, { isError: false }), 400);
		assert.match(expanded, /Display limit; full text remains in native tool history/);
		assert.ok(expanded.length < 90_000);
	});
});

describe("registry card safety", () => {
	const hostile = "safe\u009b\u202e\x1b[31m";
	it("escapes C1 and bidi controls in values and expanded output", () => {
		const result = resultOf(`outcome=ok\n${hostile}`, { outcome: hostile, total: 1, returnedRecords: 1, records: [{ kind: hostile, name: hostile }] });
		assert.doesNotMatch(screen(renderRegistryResult(result, { expanded: false, isPartial: false }, theme, { isError: false })), /[\x1b\u009b\u202e]/u);
		assert.doesNotMatch(screen(renderRegistryResult(result, { expanded: true, isPartial: false }, theme, { isError: false })), /[\x1b\u009b\u202e]/u);
		assert.doesNotMatch(screen(renderRegistryCall({ name: hostile, kind: hostile }, theme, { expanded: true, argsComplete: true })), /[\x1b\u009b\u202e]/u);
	});
	it("labels configured snapshots and partial settings coverage on collapsed cards", () => {
		const result = resultOf("Configuration snapshot.", { outcome: "partial", total: 1, returnedRecords: 1,
			records: [{ kind: "setting", name: "example.count" }], settingsCoverage: { respondingSlices: ["example"] } });
		const text = screen(renderRegistryResult(result, { expanded: false, isPartial: false }, theme, { isError: false }));
		assert.match(text, /partial configuration/);
		assert.match(text, /configured snapshot/);
		assert.match(text, /responding publishers only/);
	});
	it("tolerates null and undefined arguments", () => {
		assert.doesNotThrow(() => renderRegistryCall(null, theme, { expanded: false, argsComplete: false }));
		assert.doesNotThrow(() => renderRegistryCall(undefined, theme, { expanded: false, argsComplete: false }));
	});
});
