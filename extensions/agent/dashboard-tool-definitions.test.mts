import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { stripVTControlCharacters } from "node:util";
import {
	createCodemodeExtension,
	createReadToolDefinition,
	createBashToolDefinition,
	createEditToolDefinition,
	createWriteToolDefinition,
	createGrepToolDefinition,
	createFindToolDefinition,
	createLsToolDefinition,
	createPowerShellToolDefinition,
	initTheme,
	ToolExecutionComponent,
	type ExtensionAPI,
	type ToolDefinition,
	type ToolRenderers,
} from "@earendil-works/pi-coding-agent";
import { KeybindingsManager, setKeybindings, Text, visibleWidth, type TUI } from "@earendil-works/pi-tui";
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
	const pi = new Proxy(
		{},
		{
			get(_target, key) {
				assert.equal(key, "registerTool", "capture touches only registerTool");
				return (definition: ToolDefinition) => definitions.push(definition);
			},
		},
	);
	assert.equal(createCodemodeExtension()(pi as ExtensionAPI), undefined);
	assert.equal(definitions.length, 1);
	assert.equal(definitions[0].name, "codemode");
	return definitions[0];
}
function rendered(
	definition: { name: string },
	args: unknown,
	result: { content: Array<{ type: string; text?: string }>; isError: boolean } | undefined,
	expanded: boolean,
	width = 80,
	partial = false,
): readonly string[] {
	const tool = new ToolExecutionComponent(
		definition.name,
		"call",
		args,
		{ showImages: false },
		definition as ToolDefinition,
		tui,
		cwd,
	);
	tool.setArgsComplete();
	tool.setExpanded(expanded);
	if (result) tool.updateResult(result, partial);
	return tool.render(width);
}
const text = (lines: readonly string[]) => stripVTControlCharacters(lines.join("\n"));

it("captures Pi codemode presentation through its synchronous public factory", () => {
	const definition = nativeCodemode();
	const renderers = captureCodemodeRenderers();
	assert.equal(renderers.renderCall, definition.renderCall);
	assert.equal(renderers.renderResult, definition.renderResult);
	assert.equal(renderers.renderShell, definition.renderShell);
	assert.deepEqual(Object.keys(renderers).sort(), ["renderCall", "renderResult", "renderShell"]);
});

it("keeps transcript tool definitions inert without loadout hooks", async () => {
	const define = createDashboardToolDefinitions(cwd);
	for (const name of [
		"read",
		"bash",
		"edit",
		"write",
		"grep",
		"find",
		"ls",
		"powershell",
		"codemode",
		...Object.keys(createAgentToolCards()),
		"unregistered_tool",
		"toString",
	]) {
		const definition = define(name);
		await assert.rejects(
			definition.execute("display", {}, undefined, undefined, {} as never),
			/Transcript tools cannot execute/u,
		);
		assert.equal(definition.prepareLoadout, undefined);
	}
});

it("preserves each built-in tool's native renderers, shell and argument schema", () => {
	const define = createDashboardToolDefinitions(cwd);
	for (const factory of [
		createReadToolDefinition,
		createBashToolDefinition,
		createEditToolDefinition,
		createWriteToolDefinition,
		createGrepToolDefinition,
		createFindToolDefinition,
		createLsToolDefinition,
		createPowerShellToolDefinition,
	]) {
		const native = factory(cwd);
		const display = define(native.name);
		assert.equal(typeof display.renderCall, typeof native.renderCall, native.name);
		assert.equal(typeof display.renderResult, typeof native.renderResult, native.name);
		assert.equal(
			define(native.name).renderCall,
			display.renderCall,
			"renderer identities stay stable within the transcript",
		);
		const args = { path: "file.txt", command: "echo native", pattern: "example", content: "text", edits: [] };
		const result = { content: [{ type: "text", text: "native output" }], isError: false };
		for (const expanded of [false, true])
			assert.deepEqual(
				rendered(display, args, result, expanded),
				rendered(native, args, result, expanded),
				native.name,
			);
		assert.equal(display.renderShell, native.renderShell, native.name);
		assert.deepEqual(display.parameters, native.parameters, native.name);
	}
});

it("uses Pi's coloured shell and collapsed preview for a built-in shell tool", () => {
	const display = createDashboardToolDefinitions(cwd)("bash");
	const native = createBashToolDefinition(cwd);
	const args = { command: "printf native-output" };
	const result = {
		content: [{ type: "text", text: Array.from({ length: 30 }, (_, i) => `row ${i + 1}`).join("\n") }],
		isError: false,
	};
	for (const expanded of [false, true]) {
		const lines = rendered(display, args, result, expanded);
		assert.deepEqual(lines, rendered(native, args, result, expanded));
		assert.match(lines.join("\n"), background);
		assert.match(text(lines), /printf native-output/u);
		assert.match(text(lines), /row 30/u);
	}
	assert.ok(rendered(display, args, result, false).length < rendered(display, args, result, true).length);
});

it("uses Pi's generic fallback for unknown calls, missing calls and every result state", () => {
	const define = createDashboardToolDefinitions(cwd);
	for (const [name, known] of [
		["unregistered_tool", true],
		["read", false],
	] as const) {
		const display = define(name, known);
		assert.equal(display.renderCall, undefined);
		assert.equal(display.renderResult, undefined);
		assert.equal(display.renderShell, undefined);
		const fallback = { ...display, renderCall: undefined, renderResult: undefined, renderShell: undefined };
		for (const payload of [undefined, "", "first output\nsecond output", '{"error":{"message":"Host unavailable"}}']) {
			for (const isError of [false, true]) {
				const result = payload === undefined ? undefined : { content: [{ type: "text", text: payload }], isError };
				for (const expanded of [false, true]) {
					assert.deepEqual(
						rendered(display, { topic: "named argument" }, result, expanded),
						rendered(fallback, { topic: "named argument" }, result, expanded),
					);
				}
			}
		}
	}
});

it("preserves custom presentation and renderer identity across retained calls", () => {
	const custom: ToolRenderers = {
		renderShell: "default",
		renderCall: () => new Text("custom call", 0, 0),
		renderResult: () => new Text("custom result", 0, 0),
	};
	const define = createDashboardToolDefinitions(cwd, (name) => (name === "custom" ? custom : undefined));
	const display = define("custom");
	assert.equal(display.renderCall, custom.renderCall);
	assert.equal(display.renderResult, custom.renderResult);
	assert.equal(display.renderShell, custom.renderShell);
	assert.equal(define("custom").renderCall, display.renderCall);
	assert.match(text(rendered(display, {}, { content: [], isError: false }, false)), /custom call[\s\S]*custom result/u);
});

it("suppresses the expansion hint under a self-rendered agent card", () => {
	const identity = "01a106df-0000-4000-8000-000000000001";
	const rows: AgentConversationSummary[] = [
		{
			id: identity,
			storageId: identity,
			name: "Named target",
			cwd,
			modifiedAt: 0,
			owner: "here",
			state: "idle",
			cost: 0,
			partial: false,
			model: { provider: "provider", modelId: "model", thinkingLevel: "high" },
		},
	];
	const define = createDashboardToolDefinitions(cwd, undefined, () => rows);
	const definition = define("agent_send");
	assert.equal(definition.renderShell, "self");
	assert.equal(define("agent_send").renderCall, definition.renderCall);
	const lines = rendered(definition, { sessionId: identity, message: "Task text" }, undefined, false);
	assert.match(text(lines), /agent_send/u);
	assert.doesNotMatch(text(lines), /to expand|click/u);
});

it("keeps native codemode collapsed previews and expanded details at every width", () => {
	const args = { code: Array.from({ length: 14 }, (_, i) => `console.log("code line ${i + 1}");`).join("\n") };
	const result = {
		content: [
			{ type: "text", text: "Script completed\nWall time 1.0 seconds\nOutput:\n" },
			{ type: "text", text: Array.from({ length: 9 }, (_, i) => `output ${i}`).join("\n") },
		],
		details: {
			calls: Array.from({ length: 12 }, (_, i) => ({
				id: i + 1,
				name: "lookup",
				status: "ok",
				args: "{}",
				durationMs: i * 100,
			})),
			fullOutputPath: "output.txt",
		},
		isError: false,
	};
	const native = nativeCodemode();
	const display = createDashboardToolDefinitions(cwd)("codemode");
	assert.equal(display.renderShell, native.renderShell);
	for (const width of [30, 80, 120]) {
		for (const expanded of [false, true]) {
			const lines = rendered(display, args, result, expanded, width);
			assert.deepEqual(lines, rendered(native, args, result, expanded, width));
			assert.match(lines.join("\n"), background);
			assert.ok(lines.every((line) => visibleWidth(line) <= width));
		}
	}
	assert.match(text(rendered(display, args, result, true)), /✓ lookup \{\} 100ms/u);
});

it("falls back to Pi's default presentation after broken or asynchronous capture", () => {
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
assert.equal(definition.renderShell, undefined);
assert.equal(definition.renderCall, undefined);
assert.equal(definition.renderResult, undefined);
await assert.rejects(definition.execute(), /Transcript tools cannot execute/);
`;
		for (const failure of ["unsupported", "missing", "async"]) {
			const child = spawnSync(
				process.execPath,
				["--experimental-test-module-mocks", "--input-type=module", "-e", code],
				{
					encoding: "utf8",
					timeout: 30000,
					env: {
						...process.env,
						CAPTURE_FAILURE: failure,
						PI_AGENT_DIR: join(root, "agent"),
						PI_AGENT_SESSIONS_DIR: join(root, "sessions"),
					},
				},
			);
			assert.equal(child.status, 0, child.stderr || String(child.error));
		}
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
