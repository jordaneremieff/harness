import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { stripVTControlCharacters } from "node:util";
import {
	createCodemodeExtension, createReadToolDefinition, initTheme, ToolExecutionComponent,
	type ExtensionAPI, type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { KeybindingsManager, setKeybindings, type TUI } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { captureCodemodeRenderers, createDashboardToolDefinitions } from "./dashboard-tool-definitions.ts";
import { createAgentToolCards } from "./tool-cards.ts";

initTheme("dark");
setKeybindings(new KeybindingsManager({ "app.tools.expand": { defaultKeys: "ctrl+o" } }));
const tui = { requestRender() {} } as TUI;
const cwd = "/work";
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

it("keeps display definitions inert and native or shared presentation intact", async () => {
	const define = createDashboardToolDefinitions(cwd);
	const native = createReadToolDefinition(cwd);
	const cards = createAgentToolCards();
	for (const name of ["read", "bash", "edit", "write", "grep", "find", "ls", "powershell", "codemode", ...Object.keys(cards), "unregistered_tool", "toString"]) {
		const definition = define(name);
		await assert.rejects(definition.execute("display", {}, undefined, undefined, {} as never), /Transcript tools cannot execute/u);
		assert.equal(definition.prepareLoadout, undefined);
	}
	assert.deepEqual(define("read").parameters, native.parameters);
	assert.equal(typeof define("read").renderCall, "function");
	assert.equal(typeof define("agent_send").renderResult, "function");
	assert.equal(typeof define("codemode", false).renderResult, "function");
	assert.equal(typeof define("agent_send", false).renderResult, "function");
	for (const definition of [define("read", false), define("unregistered_tool"), define("toString")]) {
		assert.equal(definition.renderCall, undefined);
		assert.equal(definition.renderResult, undefined);
		assert.equal(definition.renderShell, undefined);
	}
});

it("uses Pi standard named-argument calls and ten logical output lines for unknown tools", () => {
	const definition = createDashboardToolDefinitions(cwd)("unregistered_tool");
	const native: ToolDefinition = { name: definition.name, label: definition.name, description: "Display", parameters: Type.Object({}), execute: async () => { throw new Error("inert"); } };
	for (const width of [30, 80, 120]) for (const expanded of [false, true]) {
		const pair = [definition, native].map((display) => {
			const tool = new ToolExecutionComponent(display.name, "call", { topic: "named argument", count: 2 }, { showImages: false }, display, tui, cwd);
			tool.setExpanded(expanded);
			tool.updateResult({ content: [{ type: "text", text: Array.from({ length: 13 }, (_, i) => `row ${i + 1}`).join("\n") }], isError: false });
			return tool.render(width);
		});
		assert.deepEqual(pair[0], pair[1]);
		const text = stripVTControlCharacters(pair[0].join("\n"));
		assert.match(text, expanded ? /topic:/u : /topic=/u);
		assert.match(text, /row 10/u);
		assert.equal(text.includes("row 11"), expanded);
		if (!expanded) assert.match(text, /expand/u);
	}
});

it("uses collapsed fallback and expanded native summaries for args-less codemode details", () => {
	const definition = createDashboardToolDefinitions(cwd)("codemode");
	for (const expanded of [false, true]) {
		const tool = new ToolExecutionComponent("codemode", "outer", { code: "return 42;" }, { showImages: false }, definition, tui, cwd);
		tool.setExpanded(expanded);
		tool.updateResult({ content: [{ type: "text", text: "Script completed\nWall time 0.1 seconds\nOutput:\n" }, { type: "text", text: "answer" }], details: { calls: [{ name: "lookup", status: "ok", durationMs: 2 }] }, isError: false });
		const visible = stripVTControlCharacters(tool.render(80).join("\n"));
		assert.match(visible, /return 42;/u);
		assert.deepEqual(visible.split("\n").map((line) => line.trim()).filter(Boolean), ["codemode", "return 42;", ...(expanded ? ["✓ lookup 2ms"] : ["Script completed", "Wall time 0.1 seconds", "Output:"]), "answer"]);
	}
});

it("matches a fresh native codemode card line for line at equal widths", () => {
	const args = { code: Array.from({ length: 14 }, (_, i) => `console.log("code line ${i + 1}");`).join("\n") };
	const details = { calls: Array.from({ length: 12 }, (_, i) => ({
		id: `outer/${i + 1}`, name: i % 2 ? "models.classify" : "lookup", status: ["ok", "error", "cancelled", "running"][i % 4],
		args: "a".repeat(200), error: "error ".repeat(80), cost: i === 0 ? 0 : 0.02, durationMs: i * 100,
	})), fullOutputPath: "output.txt" };
	const native = nativeCodemode();
	const display = createDashboardToolDefinitions(cwd)("codemode");
	for (const width of [30, 80, 120]) for (const expanded of [false, true]) for (const partial of [false, true]) {
		const pair = [native, display].map((definition) => {
			const tool = new ToolExecutionComponent("codemode", "outer", args, { showImages: false }, definition, tui, cwd);
			tool.markExecutionStarted(); tool.setArgsComplete(); tool.setExpanded(expanded);
			tool.updateResult({ content: [{ type: "text", text: "Script failed\nWall time 1.0 seconds\nOutput:\n" }, { type: "text", text: Array.from({ length: 9 }, (_, i) => `output ${i}`).join("\n") }], details, isError: true }, partial);
			return tool.render(width);
		});
		assert.deepEqual(pair[0], pair[1]);
	}
});

it("falls back to standard cards for broken or asynchronous capture without unhandled rejection", () => {
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
assert.equal(definition.renderCall, undefined);
assert.equal(definition.renderResult, undefined);
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
