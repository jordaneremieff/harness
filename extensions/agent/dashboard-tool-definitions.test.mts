import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { stripVTControlCharacters } from "node:util";
import {
	createCodemodeExtension, createReadToolDefinition, initTheme, ToolExecutionComponent,
	type ExtensionAPI, type ToolDefinition, type ToolRenderers,
} from "@earendil-works/pi-coding-agent";
import { KeybindingsManager, setKeybindings, visibleWidth, type TUI } from "@earendil-works/pi-tui";
import { captureCodemodeRenderers, createDashboardToolDefinitions } from "./dashboard-tool-definitions.ts";
import type { AgentConversationSummary } from "./dashboard-types.ts";
import { createAgentToolCards } from "./tool-cards.ts";

initTheme("dark");
setKeybindings(new KeybindingsManager({ "app.tools.expand": { defaultKeys: "ctrl+o" } }));
const tui = { requestRender() {} } as TUI;
const cwd = "/work";
const background = /\x1b\[48;/u;
function nativeCodemode(): ToolDefinition {
	const definitions: ToolDefinition[] = [];
	const pi = new Proxy({}, { get(_target, key) {
		assert.equal(key, "registerTool", "capture touches only registerTool");
		return (definition: ToolDefinition) => definitions.push(definition);
	} });
	assert.equal(createCodemodeExtension()(pi as ExtensionAPI), undefined);
	assert.equal(definitions.length, 1);
	assert.equal(definitions[0].name, "codemode");
	return definitions[0];
}
function rendered(definition: ToolDefinition, args: unknown, result: { content: Array<{ type: string; text?: string }>; isError: boolean } | undefined, expanded: boolean, width = 80, partial = false): string[] {
	const tool = new ToolExecutionComponent(definition.name, "call", args, { showImages: false }, definition, tui, cwd);
	tool.setArgsComplete();
	tool.setExpanded(expanded);
	if (result) tool.updateResult(result, partial);
	return tool.render(width);
}
const text = (lines: string[]) => stripVTControlCharacters(lines.join("\n"));

it("captures Pi codemode presentation through its synchronous public factory", () => {
	const definition = nativeCodemode();
	const renderers = captureCodemodeRenderers();
	assert.equal(typeof renderers.renderCall, "function");
	assert.equal(typeof renderers.renderResult, "function");
	assert.equal(renderers.renderCall, definition.renderCall);
	assert.equal(renderers.renderResult, definition.renderResult);
	assert.equal(renderers.renderShell, definition.renderShell);
	assert.deepEqual(Object.keys(renderers).sort(), ["renderCall", "renderResult", "renderShell"]);
});

it("keeps display definitions inert and gives every dashboard tool the self-render shell", async () => {
	const custom: ToolRenderers = { renderCall: () => new (class { render() { return ["custom"]; } invalidate() {} })() };
	const define = createDashboardToolDefinitions(cwd, () => custom);
	const native = createReadToolDefinition(cwd);
	const cards = createAgentToolCards();
	for (const name of ["read", "bash", "edit", "write", "grep", "find", "ls", "powershell", "codemode", ...Object.keys(cards), "unregistered_tool", "toString", "custom"]) {
		const definition = define(name);
		await assert.rejects(definition.execute("display", {}, undefined, undefined, {} as never), /Transcript tools cannot execute/u);
		assert.equal(definition.prepareLoadout, undefined);
		assert.equal(definition.renderShell, "self", name);
		assert.equal(typeof definition.renderCall, "function", name);
	}
	assert.deepEqual(define("read").parameters, native.parameters);
	assert.equal(define("read").renderShell, "self");
	assert.equal(define("unregistered_tool").renderShell, "self");
	assert.equal(define("read", false).renderShell, "self");
	assert.equal(native.renderShell, undefined, "the main Pi definition keeps its own shell");
	assert.equal(nativeCodemode().renderShell, undefined);
});

it("shows one plain summary line for a generic tool and no tool background", () => {
	const definition = createDashboardToolDefinitions(cwd)("unregistered_tool");
	const args = { topic: "named argument", count: 2 };
	const collapsed = rendered(definition, args, { content: [{ type: "text", text: "first output\nsecond output" }], isError: false }, false);
	const collapsedLines = collapsed.filter((line) => line.trim().length > 0);
	assert.equal(collapsedLines.length, 1, "one summary line beside Pi's leading spacer");
	assert.doesNotMatch(collapsed.join("\n"), background);
	assert.match(stripVTControlCharacters(collapsedLines[0]), /^unregistered_tool · named argument → first output/u);
	const summary = (lines: string[]) => lines.filter((line) => line.trim().length > 0).at(-1) ?? "";
	const pending = rendered(definition, args, undefined, false);
	assert.match(stripVTControlCharacters(summary(pending)), /→ pending$/u);
	const partial = rendered(definition, args, { content: [{ type: "text", text: "current output" }], isError: false }, false, 80, true);
	assert.match(stripVTControlCharacters(summary(partial)), /→ current output…$/u);
	const empty = rendered(definition, args, { content: [], isError: false }, false);
	assert.match(stripVTControlCharacters(summary(empty)), /^unregistered_tool · named argument$/u);
	const failed = rendered(definition, args, { content: [{ type: "text", text: "first error line\nstack line" }], isError: true }, false);
	assert.match(stripVTControlCharacters(summary(failed)), /→ first error line$/u);
	assert.match(summary(failed), /\x1b\[38;/u, "the error outcome keeps a foreground colour");
});

it("shortens display paths, counts read lines and drops an edit path suffix", () => {
	const definition = createDashboardToolDefinitions("/work")("read");
	const summary = (args: unknown, text: string, isError = false) => stripVTControlCharacters(rendered(definition, args, { content: [{ type: "text", text }], isError }, false).filter((line) => line.trim()).at(-1) ?? "").trim();
	assert.match(summary({ path: "/work/src/index.ts" }, "line"), /^read · src\/index\.ts → 1 line$/u);
	assert.match(summary({ path: `${homedir()}/notes.md` }, "one\ntwo\nthree"), /^read · ~\/notes\.md → 3 lines$/u);
	const image = stripVTControlCharacters(rendered(definition, { path: "/work/image.png" }, { content: [{ type: "image" }], isError: false }, false).filter((line) => line.trim()).at(-1) ?? "").trim();
	assert.match(image, /^read · image\.png → image$/u);
	assert.match(summary({ path: "/work/src/index.ts" }, "boom", true), /→ boom$/u);
	assert.match(summary({ path: "/work/src/index.ts" }, "<harness>\n[error] Validation failed\n</harness>", true), /→ Validation failed$/u, "a wrapper tag and the [error] mark give way to the message");
	const edit = createDashboardToolDefinitions("/work")("edit");
	const edited = stripVTControlCharacters(rendered(edit, { path: "extensions/agent/tool-cards.ts" }, { content: [{ type: "text", text: "Successfully replaced 2 block(s) in /work/extensions/agent/tool-cards.ts" }], isError: false }, false).filter((line) => line.trim()).at(-1) ?? "").trim();
	assert.match(edited, /^edit · extensions\/agent\/tool-cards\.ts → Successfully replaced 2 block\(s\)$/u);
	const bash = createDashboardToolDefinitions("/work")("bash");
	const bashSummary = (command: string) => stripVTControlCharacters(rendered(bash, { command }, { content: [{ type: "text", text: "ok" }], isError: false }, false).filter((line) => line.trim()).at(-1) ?? "").trim();
	assert.match(bashSummary("cd /work && npx biome lint"), /^bash · npx biome lint → ok/u);
	assert.match(bashSummary("cd /other && node /work/tool.ts"), /^bash · cd \/other && node tool\.ts → ok/u);
	const rex = createDashboardToolDefinitions("/work")("rex_terminal");
	const rexSummary = (text: string, isError = false) => stripVTControlCharacters(rendered(rex, { action: "window" }, { content: [{ type: "text", text }], isError }, false).filter((line) => line.trim()).at(-1) ?? "").trim();
	assert.match(rexSummary('{"ok":true,"outcome":"created","data":{}}'), /^rex_terminal · window → created/u);
	assert.match(rexSummary('{"ok":true,"data":{"x":1}}'), /^rex_terminal · window$/u);
	assert.match(rexSummary('{"error":"quota wall"}', true), /→ quota wall/u);
});

it("keeps the outcome visible when the argument is long", () => {
	const definition = createDashboardToolDefinitions("/work")("bash");
	const command = `node --test --test-concurrency=1 ${Array.from({ length: 20 }, (_, i) => `--flag-${i}`).join(" ")} extensions/agent/dashboard-state.test.mts`;
	const line = stripVTControlCharacters(rendered(definition, { command }, { content: [{ type: "text", text: "4 pass" }], isError: false }, false, 100).filter((value) => value.trim()).at(-1) ?? "").trim();
	assert.match(line, /^bash · .+… → 4 pass$/u);
	assert.ok(visibleWidth(line) <= 100);
});

it("suppresses the expansion hint under a dashboard agent card", () => {
	const identity = "01a106df-0000-4000-8000-000000000001";
	const rows: AgentConversationSummary[] = [{ id: identity, storageId: identity, name: "Named target", cwd: "/work", modifiedAt: 0, owner: "here", state: "idle", cost: 0, partial: false, model: { provider: "provider", modelId: "model", thinkingLevel: "high" } }];
	const definition = createDashboardToolDefinitions("/work", undefined, () => rows)("agent_send");
	const text = stripVTControlCharacters(rendered(definition, { sessionId: identity, message: "Task text" }, undefined, false).join("\n"));
	assert.match(text, /agent_send/u);
	assert.doesNotMatch(text, /to expand|click/u);
});

it("keeps the native call and full output on expansion without an outer block", () => {
	const definition = createDashboardToolDefinitions(cwd)("unregistered_tool");
	const output = Array.from({ length: 13 }, (_, i) => `row ${i + 1}`).join("\n");
	const expanded = rendered(definition, { topic: "named argument", count: 2 }, { content: [{ type: "text", text: output }], isError: false }, true);
	assert.doesNotMatch(expanded.join("\n"), background);
	const visible = text(expanded);
	assert.match(visible, /topic: named argument/u);
	assert.match(visible, /row 13/u);
});

it("summarises codemode on one line and keeps the self-shell native card on expansion", () => {
	const native = nativeCodemode();
	const display = createDashboardToolDefinitions(cwd)("codemode");
	const args = { code: "return 42;" };
	const result = {
		content: [{ type: "text", text: "Script completed\nWall time 0.1 seconds\nOutput:\n" }, { type: "text", text: "answer" }],
		details: { calls: [{ id: 1, name: "lookup", args: "{}", status: "ok", durationMs: 2 }] },
		isError: false,
	};
	const collapsed = rendered(display, args, result, false);
	assert.equal(collapsed.filter((line) => line.trim().length > 0).length, 1);
	assert.match(stripVTControlCharacters(collapsed.join("\n")), /^\n?codemode · return 42; → Script completed/u);
	assert.doesNotMatch(collapsed.join("\n"), background);
	const expandedDisplay = rendered(display, args, result, true);
	assert.doesNotMatch(expandedDisplay.join("\n"), background);
	const selfShellNative: ToolDefinition = { ...native, renderShell: "self" };
	assert.deepEqual(expandedDisplay, rendered(selfShellNative, args, result, true));
	assert.match(text(expandedDisplay), /✓ lookup \{\} 2ms/u);
});

it("keeps the native codemode detail on expansion at every width", () => {
	const args = { code: Array.from({ length: 14 }, (_, i) => `console.log("code line ${i + 1}");`).join("\n") };
	const details = { calls: Array.from({ length: 12 }, (_, i) => ({
		id: i + 1, name: i % 2 ? "models.classify" : "lookup", status: ["ok", "error", "cancelled", "running"][i % 4],
		args: "a".repeat(200), error: "error ".repeat(80), durationMs: i * 100,
	})), fullOutputPath: "output.txt" };
	const native = nativeCodemode();
	const display = createDashboardToolDefinitions(cwd)("codemode");
	const result = {
		content: [{ type: "text", text: "Script failed\nWall time 1.0 seconds\nOutput:\n" }, { type: "text", text: Array.from({ length: 9 }, (_, i) => `output ${i}`).join("\n") }],
		details,
		isError: true,
	};
	for (const width of [30, 80, 120]) {
		const selfShellNative: ToolDefinition = { ...native, renderShell: "self" };
		assert.deepEqual(rendered(display, args, result, true, width), rendered(selfShellNative, args, result, true, width));
		const collapsed = rendered(display, args, result, false, width);
		assert.equal(collapsed.filter((line) => line.trim().length > 0).length, 1);
		assert.ok(stripVTControlCharacters(collapsed.join("\n")).trim().length > 0);
	}
});

it("falls back to a summary line for broken or asynchronous capture without unhandled rejection", () => {
	const root = mkdtempSync(join(tmpdir(), "dashboard-definition-"));
	try {
		const code = `import assert from "node:assert/strict";
import { mock } from "node:test";
import * as pi from "@earendil-works/pi-coding-agent";
const failure = process.env.CAPTURE_FAILURE;
mock.module("@earendil-works/pi-coding-agent", { namedExports: { ...pi, createCodemodeExtension: () => failure === "async" ? async () => { throw new Error("async failure"); } : failure === "missing" ? () => {} : (api) => api.getSettings() } });
const { captureCodemodeRenderers, createDashboardToolDefinitions } = await import(${JSON.stringify(new URL("./dashboard-tool-definitions.ts", import.meta.url).href)});
assert.throws(captureCodemodeRenderers);
const definition = createDashboardToolDefinitions("/work")("codemode");
assert.equal(definition.renderShell, "self");
assert.equal(typeof definition.renderCall, "function");
assert.equal(typeof definition.renderResult, "function");
await assert.rejects(definition.execute(), /Transcript tools cannot execute/);
`;
		for (const failure of ["unsupported", "missing", "async"]) {
			const child = spawnSync(process.execPath, ["--experimental-test-module-mocks", "--input-type=module", "-e", code], {
				encoding: "utf8", timeout: 30000,
				env: { ...process.env, CAPTURE_FAILURE: failure, PI_AGENT_DIR: join(root, "agent"), PI_AGENT_SESSIONS_DIR: join(root, "sessions") },
			});
			assert.equal(child.status, 0, child.stderr || String(child.error));
		}
	} finally { rmSync(root, { recursive: true, force: true }); }
});
