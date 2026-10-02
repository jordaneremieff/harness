import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { KeybindingsManager as Keys, setKeybindings, TUI_KEYBINDINGS, type TUI } from "@earendil-works/pi-tui";
import { createAgentCommand, type AgentCommandAction } from "./command.ts";
import type { AgentConversationPage, AgentConversationSnapshot, AgentConversationSummary } from "./dashboard-types.ts";
import type { PrimaryObserver, PrimarySnapshot } from "./peer-contract.ts";
import { PeerWindow } from "./peer-window.ts";
import registerAgentExtension from "./index.ts";

initTheme("dark");
setKeybindings(new Keys(TUI_KEYBINDINGS));
const theme = { fg: (_color: string, text: string) => text, bg: (_color: string, text: string) => text, bold: (text: string) => text } as Theme;
const keys = new Keys(TUI_KEYBINDINGS) as KeybindingsManager;
const tui = { terminal: { rows: 24, columns: 80 }, requestRender() {} } as unknown as TUI;
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const F5 = "\x1b[15~";
const F6 = "\x1b[17~";
const DOWN = "\x1b[B";
const ENTER = "\r";

function row(overrides: Partial<AgentConversationSummary> & { id: string }): AgentConversationSummary {
	return { storageId: "storage", name: "Agent", cwd: "/work", owner: "here", state: "idle", modifiedAt: 1, cost: 0, partial: false, ...overrides };
}
const rows = [row({ id: "agent:one", name: "One", state: "working", modifiedAt: 2 }), row({ id: "agent:two", name: "Two", modifiedAt: 1 })];
const source = {
	async list(): Promise<AgentConversationPage> { return { rows, coverage: { complete: true, storagesVisited: 1, skipped: 0, omitted: 0, nextCursor: null }, observedAt: new Date(0).toISOString() }; },
	async snapshot(id: string): Promise<AgentConversationSnapshot> { return { entries: [{ id: `${id}:u`, kind: "pi.user", model: [{ role: "user", content: "task", timestamp: 1 }] }], partial: false, revision: "r1" }; },
};
const primaryValue: PrimarySnapshot = {
	descriptor: { id: "primary", kind: "primary", name: "this Pi", cwd: "/work", model: "test/model", thinkingLevel: "high", state: "idle", cost: 0 },
	entries: [],
	revision: "p1",
	live: [],
	liveRevision: "l1",
	busy: false,
};
const primary: PrimaryObserver = {
	attach() {}, observe() {}, refresh() {}, subscribe: () => () => {}, snapshot: () => primaryValue, sendPlain() {}, handoffToNative: () => "", nativeDraft: () => "",
};

interface Capture { window?: PeerWindow; opens: number; close?: () => void }
function context(capture: Capture): ExtensionCommandContext {
	const ui = {
		custom: async (factory: (tui: TUI, theme: Theme, keys: KeybindingsManager, done: (value?: unknown) => void) => { dispose?(): void }) => {
			capture.opens++;
			let finish!: (value?: unknown) => void;
			const result = new Promise((resolve) => { finish = resolve; });
			let component!: { dispose?(): void };
			const complete = (value?: unknown) => { component.dispose?.(); finish(value); };
			capture.close = () => complete(undefined);
			component = factory(tui, theme, keys, complete);
			capture.window = component as PeerWindow;
			return result as never;
		},
		notify() {}, getEditorText: () => "", setEditorText() {}, select: async () => undefined, input: async () => undefined, confirm: async () => false,
	};
	return { mode: "tui", hasUI: true, cwd: "/work", sessionManager: { getSessionId: () => "session-1", getSessionName: () => undefined, buildSessionProjection: () => ({ entries: [], messages: [], thinkingLevel: "off", model: null }) }, ui } as unknown as ExtensionCommandContext;
}

it("opens the peer window through /agent, selects an agent in All, and keeps one open guard", async () => {
	const calls: string[][] = [];
	const action: AgentCommandAction = { name: "send", description: "Send a task", args: [{ name: "session" }, { name: "message", rest: true }], run: async (args) => { calls.push(args); return "Sent"; } };
	const command = createAgentCommand([action], source, { primary });
	const capture: Capture = { opens: 0 };
	const ctx = context(capture);
	const opened = command.handler("", ctx);
	assert.ok(capture.window instanceof PeerWindow, "the command opens the peer window");
	const window = capture.window;
	await window.ready();
	assert.deepEqual(window.state.right, { kind: "agent", id: "agent:one" }, "the working agent pairs with the primary");

	window.handleInput("OR"); // F3: focus the agent pane.
	window.handleInput(F5);
	assert.equal(window.state.right, undefined);
	window.handleInput(F6);
	window.handleInput(DOWN);
	window.handleInput(ENTER);
	assert.deepEqual(window.state.right, { kind: "agent", id: "agent:one" }, "All opens the selected agent in the agent pane");
	assert.equal(window.state.focus, "right");

	await command.handler("", ctx);
	assert.equal(capture.opens, 1, "a second open while the window is mounted does nothing");
	capture.close?.();
	await opened;
});

it("routes submit, new, fork, and repair through the operator command actions", async () => {
	const calls: Array<{ name: string; args: string[] }> = [];
	const action = (name: string, args: AgentCommandAction["args"], outcome: string): AgentCommandAction => ({ name, description: name, args, run: async (received) => { calls.push({ name, args: received }); return { text: outcome, sessionId: name === "new" || name === "fork" ? "agent:new" : received[0] }; } });
	const command = createAgentCommand([
		action("send", [{ name: "session" }, { name: "message", rest: true }], "Sent"),
		action("steer", [{ name: "session" }, { name: "message", rest: true }], "Steered"),
		action("new", [{ name: "task", rest: true, optional: true }], "Created"),
		action("fork", [{ name: "session" }, { name: "entry", optional: true }], "Forked"),
		action("rewind", [{ name: "session" }, { name: "entry" }, { name: "correction", rest: true }], "Repaired"),
	], source, { primary });
	const capture: Capture = { opens: 0 };
	const ctx = context(capture);
	const opened = command.handler("", ctx);
	const windowValue = capture.window;
	assert.ok(windowValue instanceof PeerWindow, "the command opens the peer window");
	const window = windowValue;
	await window.ready();

	window.handleInput("\x1bOR"); // F3: focus the agent pane.
	for (const char of "do it") window.handleInput(char);
	window.handleInput(ENTER);
	await tick();
	assert.deepEqual(calls.at(-1), { name: "steer", args: ["agent:one", "do it"] });

	window.handleInput("\x1b[18~"); // F7: new agent task.
	for (const char of "make two") window.handleInput(char);
	window.handleInput(ENTER);
	await tick();
	assert.deepEqual(calls.at(-1), { name: "new", args: ["make two"] });
	assert.ok([window.state.left, window.state.right].some((slot) => slot?.kind === "agent" && slot.id === "agent:new"), "the created agent opens in a pane");

	for (const char of "/view") window.handleInput(char);
	window.handleInput(ENTER);
	for (let index = 0; index < 7; index++) window.handleInput(DOWN);
	window.handleInput(ENTER);
	window.handleInput(ENTER);
	await tick();
	assert.deepEqual(calls.at(-1), { name: "fork", args: ["agent:new", "agent:new:u"] });

	for (const char of "/repair") window.handleInput(char);
	window.handleInput(ENTER);
	window.handleInput(ENTER);
	for (const char of "other file") window.handleInput(char);
	window.handleInput(ENTER);
	await tick();
	assert.deepEqual(calls.at(-1), { name: "rewind", args: ["agent:new", "agent:new:u", "other file"] });

	capture.close?.();
	await opened;
});

it("registers Ctrl+Alt+G for the peer window and opens it against an isolated store", async () => {
	const previous = process.env.PI_AGENT_SESSIONS_DIR;
	const root = mkdtempSync(join(tmpdir(), "peer-wiring-"));
	process.env.PI_AGENT_SESSIONS_DIR = root;
	try {
		let command!: Parameters<ExtensionAPI["registerCommand"]>[1];
		let shortcut!: Parameters<ExtensionAPI["registerShortcut"]>[1];
		const api: Partial<ExtensionAPI> = { events: { emit() {}, on: () => () => {} }, registerTool() {}, registerMessageRenderer() {}, on: () => () => {},
			registerCommand(name, value) { if (name === "agent") command = value; else assert.equal(name, "restart"); },
			registerShortcut(key, value) { assert.equal(key, "ctrl+alt+g"); shortcut = value; },
			getThinkingLevel: () => "off",
		};
		registerAgentExtension(api as ExtensionAPI);
		assert.equal(shortcut.description, "Open the agent peer window");
		const capture: Capture = { opens: 0 };
		const ctx = context(capture);
		const opened = shortcut.handler(ctx as ExtensionContext);
		assert.ok(capture.window instanceof PeerWindow, "Ctrl+Alt+G opens the peer window");
		capture.close?.();
		await opened;
		assert.equal(typeof command.handler, "function");
	} finally {
		if (previous === undefined) delete process.env.PI_AGENT_SESSIONS_DIR;
		else process.env.PI_AGENT_SESSIONS_DIR = previous;
		rmSync(root, { recursive: true, force: true });
	}
});

it("does nothing for shortcut calls without a terminal UI", async () => {
	let opens = 0;
	const ctx = context({ opens: 0 });
	const ui = { ...ctx.ui, custom: async () => { opens++; throw new Error("no UI"); } } as unknown as ExtensionCommandContext["ui"];
	const modes = ["print", "json", "rpc", "tui"] as const;
	const command = createAgentCommand([], source, { primary });
	for (const mode of modes) await command.openDashboard({ ...ctx, mode, hasUI: false, ui } as unknown as ExtensionContext);
	await command.openDashboard({ ...ctx, mode: "rpc", hasUI: true, ui } as unknown as ExtensionContext);
	assert.equal(opens, 0, "no window opens without a terminal UI");
	await tick();
});
