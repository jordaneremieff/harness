import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import {
	createEventBus,
	initTheme,
	Theme,
	ToolExecutionComponent,
	type ExtensionAPI,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
	getKeybindings,
	KeybindingsManager,
	type KeyId,
	setKeybindings,
	stripTerminalSequences,
	TUI_KEYBINDINGS,
	type TUI,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { toolDisplay } from "./display.ts";
import registerGoogle from "./index.ts";
import { failure, GoogleError, ok, toolResult, type Result } from "./result.ts";

initTheme("dark", false);

function expansionKey(t: TestContext, keys: KeyId[]): void {
	const previous = getKeybindings();
	setKeybindings(
		new KeybindingsManager(
			{ ...TUI_KEYBINDINGS, "app.tools.expand": { defaultKeys: "ctrl+o", description: "Expand tool output" } },
			{ "app.tools.expand": keys },
		),
	);
	t.after(() => setKeybindings(previous));
}

function card(): ToolExecutionComponent {
	const record = toolDisplay().tools[0];
	return new ToolExecutionComponent(
		record.name,
		"google-test-call",
		{},
		{ outputPad: 1 },
		record,
		{ requestRender() {} } as TUI,
		"/synthetic",
	);
}

function rows(component: ToolExecutionComponent, width = 100): string[] {
	const rendered = component.render(width);
	assert.ok(
		rendered.every((line) => visibleWidth(line) <= width),
		"every row fits the Pi shell",
	);
	return rendered.map((line) => stripTerminalSequences(line).trimEnd().slice(1));
}

function settle(component: ToolExecutionComponent, result: Result<unknown>): void {
	const returned = toolResult(result);
	component.updateResult({ ...returned, isError: returned.isError === true });
}

test("Pi renders an argument-free call, progress, and a ready status with one disclosure hint", (t) => {
	expansionKey(t, ["ctrl+g"]);
	const colours = t.mock.method(Theme.prototype, "fg");
	const component = card();
	assert.deepEqual(rows(component), ["", "", "google_status Google Workspace access", ""]);
	assert.ok(
		colours.mock.calls.some(({ arguments: [role, value] }) => role === "accent" && value === "Google Workspace access"),
	);
	assert.ok(
		colours.mock.calls.some(({ arguments: [role, value] }) => role === "toolTitle" && value.includes("google_status")),
	);
	component.markExecutionStarted();
	assert.doesNotMatch(rows(component).join("\n"), /expand|ready|pending/);
	component.updateResult({ content: [], isError: false }, true);
	assert.match(rows(component).join("\n"), /Checking Google Workspace access\./);
	assert.doesNotMatch(rows(component).join("\n"), /expand/);

	settle(
		component,
		ok({
			ready: true,
			observedAccount: "reader@example.invalid",
			expectedAccount: "reader@example.invalid",
			backend: { name: "gws", requiredVersion: "1.2.3" },
			grantedScopes: ["scope-read"],
			capabilities: { gmailRead: true, gmailSend: false },
		}),
	);
	const collapsed = rows(component).join("\n");
	assert.match(collapsed, /google_status Google Workspace access\n\nAccess is ready\./);
	assert.match(collapsed, /Signed in as reader@example\.invalid\nRequires gws 1\.2\.3/);
	assert.deepEqual(
		collapsed.split("\n").filter((line) => line.includes("to expand")),
		["... (ctrl+g to expand)"],
	);
	assert.doesNotMatch(collapsed, /scope-read|Expected account|schemaVersion|unknown|none/);
	component.setExpanded(true);
	const expanded = rows(component).join("\n");
	assert.match(expanded, /scope-read/);
	assert.match(expanded, /"gmailSend": false/);
	assert.doesNotMatch(expanded, /to expand|to collapse/);
});

test("a successful observation of not-ready is distinct from an error that prevents the check", (t) => {
	expansionKey(t, []);
	const colours = t.mock.method(Theme.prototype, "fg");
	const component = card();
	settle(
		component,
		ok({
			ready: false,
			expectedAccount: null,
			error: { code: "SETUP_REQUIRED", message: "Set up access first.", retryable: false },
		}),
	);
	const notReady = rows(component).join("\n");
	assert.match(notReady, /Access is not ready\.\nSet up access first\./);
	assert.doesNotMatch(notReady, /Expected account|SETUP_REQUIRED/);
	assert.match(notReady, /\.\.\. \(click to expand\)/);
	assert.equal(rows(component, 22).filter(Boolean)[1], "Access is not ready.");
	assert.ok(
		colours.mock.calls.some(
			({ arguments: [role, value] }) => role === "toolOutput" && value.trimEnd() === "Set up access first.",
		),
	);
	assert.ok(!colours.mock.calls.some(({ arguments: [role] }) => role === "error"));

	settle(component, failure(new GoogleError("ADAPTER_ERROR", "Status snapshot could not be read.")));
	const error = rows(component).join("\n");
	assert.match(error, /Status snapshot could not be read\./);
	assert.doesNotMatch(error, /is not ready|is ready/);
	assert.ok(
		colours.mock.calls.some(
			({ arguments: [role, value] }) => role === "error" && value === "Status snapshot could not be read.",
		),
	);
	settle(component, failure(new GoogleError("ABORTED", "The operation was cancelled.")));
	assert.equal(rows(component).filter(Boolean)[1], "Cancelled");
	settle(
		component,
		ok({
			ready: false,
			error: { code: "ABORTED", message: "The operation was cancelled.", retryable: true },
		}),
	);
	assert.equal(rows(component).filter(Boolean)[1], "Cancelled");
});

test("a long diagnostic uses five visual body lines and counts only the hidden body lines", (t) => {
	expansionKey(t, ["ctrl+o"]);
	const component = card();
	const width = 42;
	const token = "x".repeat(width - 2);
	settle(
		component,
		ok({
			ready: false,
			error: { code: "SETUP_REQUIRED", message: `\u001b[31m${token.repeat(7)}END\u001b[0m`, retryable: false },
		}),
	);
	const collapsed = rows(component, width).filter(Boolean);
	assert.equal(collapsed[1], "Access is not ready.");
	assert.deepEqual(collapsed.slice(2, 7), Array(5).fill(token));
	assert.equal(collapsed[7], "... (3 more lines, ctrl+o to expand)");
	assert.equal(collapsed.length, 8);
	assert.doesNotMatch(collapsed.join("\n"), /END/);
	component.setExpanded(true);
	const expanded = rows(component, width).join("\n");
	assert.match(expanded, /END/);
	assert.doesNotMatch(expanded, /to expand/);
	component.setExpanded(false);
	assert.ok(rows(component, 22).some((line) => line.endsWith("…")));
});

test("a bare Pi diagnostic stays intact without a hint that adds nothing", (t) => {
	expansionKey(t, ["ctrl+o"]);
	const component = card();
	component.updateResult({ content: [{ type: "text", text: "Could not start status check." }], isError: true });
	assert.deepEqual(rows(component).filter(Boolean), [
		"google_status Google Workspace access",
		"Could not start status check.",
	]);
	const narrow = rows(component, 24).filter(Boolean);
	assert.ok(narrow[1].endsWith("…"));
	component.setExpanded(true);
	assert.match(rows(component, 24).join("\n"), /Could not start status\ncheck\./);
});

test("ordinary registration, the display event bus and the Durable descriptor use the pure display records", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "google-display-"));
	const agentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = dir;
	t.after(async () => {
		if (agentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = agentDir;
		await rm(dir, { recursive: true, force: true });
	});
	const bus = createEventBus();
	const publications: unknown[] = [];
	const tools = new Map<string, ToolDefinition>();
	const shutdown: Array<() => void> = [];
	let descriptor: { entry: string; export: string; version: number } | undefined;
	bus.on("harness:tool-display:publish", (value) => publications.push(value));
	bus.on("durable:contribution", (value) => {
		descriptor = (value as { display: typeof descriptor }).display;
	});
	registerGoogle({
		events: bus,
		on: (event: string, listener: () => void) => {
			if (event === "session_shutdown") shutdown.push(listener);
		},
		registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
		registerCommand: () => {},
	} as unknown as ExtensionAPI);

	const display = toolDisplay();
	assert.deepEqual(publications, [display]);
	assert.deepEqual(descriptor, { version: 1, entry: "./display.ts", export: "toolDisplay" });
	assert.deepEqual(Object.keys(await import("./display.ts")), ["toolDisplay"]);
	const [record] = display.tools;
	assert.deepEqual(Object.keys(record).sort(), ["name", "renderCall", "renderResult", "renderShell"].sort());
	assert.deepEqual(
		[...tools.values()].filter((tool) => tool.renderCall || tool.renderResult).map((tool) => tool.name),
		[record.name],
	);
	const status = tools.get(record.name);
	assert.ok(status);
	assert.equal(status.renderCall, record.renderCall);
	assert.equal(status.renderResult, record.renderResult);
	assert.equal(status.renderShell, record.renderShell);
	bus.emit("harness:tool-display:request", { version: 42 });
	assert.equal(publications.length, 1);
	bus.emit("harness:tool-display:request", { version: 1 });
	assert.deepEqual(publications, [display, display]);
	for (const stop of shutdown) stop();
	bus.emit("harness:tool-display:request", { version: 1 });
	assert.equal(publications.length, 2);
});
