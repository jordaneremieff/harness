import assert from "node:assert/strict";
import { it } from "node:test";
import type { ExtensionAPI, ExtensionContext, ExtensionCommandContext, KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { Editor, KeybindingsManager as Keys, TUI_KEYBINDINGS, type TUI } from "@earendil-works/pi-tui";
import registerAgentExtension from "./index.ts";
import { createAgentCommand } from "./command.ts";
import type { AgentDashboard } from "./dashboard.ts";

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
function deferred() {
	let resolve!: () => void; let reject!: (error: Error) => void;
	const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
	return { promise, resolve, reject };
}
function registrations() {
	let command!: Parameters<ExtensionAPI["registerCommand"]>[1];
	let shortcut!: Parameters<ExtensionAPI["registerShortcut"]>[1];
	const api: Partial<ExtensionAPI> = { registerTool() {}, registerMessageRenderer() {}, on: () => () => {},
		registerCommand(name, value) { assert.equal(name, "agent"); command = value; },
		registerShortcut(key, value) { assert.equal(key, "ctrl+alt+g"); assert.equal(shortcut, undefined); shortcut = value; },
	};
	registerAgentExtension(api as ExtensionAPI);
	assert.equal(shortcut.description, "Open the agent dashboard");
	return { command, shortcut };
}
function context(custom: ExtensionContext["ui"]["custom"], notify: (text: string) => void = () => {}) {
	const ui = new Proxy({ custom, notify }, { get(target, key) { assert.ok(key in target, `Unexpected UI access: ${String(key)}`); return Reflect.get(target, key); } });
	return { mode: "tui", hasUI: true, ui } as ExtensionContext;
}
it("registers Ctrl+Alt+G and shares a guard across command and shortcut through pending UI, close, and failure", async () => {
	const { command, shortcut } = registrations();
	let pending = deferred(); let opens = 0;
	const notices: string[] = [];
	const ctx = context(async () => { opens++; await pending.promise; return undefined as never; }, (text) => notices.push(text));
	assert.equal("waitForIdle" in ctx, false);
	const first = shortcut.handler(ctx);
	await shortcut.handler(ctx); await command.handler("", ctx as ExtensionCommandContext); assert.equal(opens, 1);
	pending.resolve(); await first;
	pending = deferred(); const second = command.handler("", ctx as ExtensionCommandContext);
	await shortcut.handler(ctx); assert.equal(opens, 2); pending.resolve(); await second;
	pending = deferred(); const failed = Promise.resolve(shortcut.handler(ctx));
	const rejection = assert.rejects(failed, /UI unavailable/); pending.reject(new Error("UI unavailable")); await rejection;
	pending = deferred(); const commandFailure = command.handler("", ctx as ExtensionCommandContext);
	pending.reject(new Error("command UI unavailable")); await commandFailure; assert.deepEqual(notices, ["command UI unavailable"]);
	pending = deferred(); const restored = shortcut.handler(ctx); assert.equal(opens, 5); pending.resolve(); await restored;
});
it("does nothing for shortcut calls without a terminal UI", async () => {
	const { shortcut } = registrations();
	const ctx = context(async () => { assert.fail("No UI requested"); });
	for (const mode of ["print", "json", "rpc", "tui"] as const) await shortcut.handler({ ...ctx, mode, hasUI: false });
	await shortcut.handler({ ...ctx, mode: "rpc", hasUI: true });
});
it("keeps the native editor draft intact across a mounted dashboard and uses only the common context for actions", async () => {
	const keys = new Keys(TUI_KEYBINDINGS) as KeybindingsManager;
	const tui = { terminal: { rows: 24 }, requestRender() {} } as unknown as TUI;
	const theme = { fg: (_: string, text: string) => text, bg: (_: string, text: string) => text } as Theme;
	const editor = new Editor(tui, { borderColor: (text) => text, selectList: { selectedPrefix: (text) => text, selectedText: (text) => text, description: (text) => text, scrollInfo: (text) => text, noMatch: (text) => text } });
	editor.setText("Unsent draft\nsecond line"); const before = editor.getText();
	let panel: AgentDashboard | undefined; let close!: (value?: unknown) => void; let actions = 0; let ctx!: ExtensionContext;
	const command = createAgentCommand([{ name: "status", description: "Read status", args: [], run: async (_args, actual) => { assert.equal(actual, ctx); actions++; return "Status read"; } }], {
		sessions: async () => [], runs: async () => [], inspect: async () => { throw new Error("No selection"); },
	});
	ctx = context(async (factory) => {
		const response = new Promise((resolve) => { close = resolve; });
		panel = await factory(tui, theme, keys, (value) => close(value)) as AgentDashboard;
		try { return await response as never; } finally { panel.dispose(); }
	});
	ctx.ui = new Proxy({ ...ctx.ui, select: async () => "status: Read status" }, { get(target, key) { assert.ok(key in target, `Unexpected UI access: ${String(key)}`); return Reflect.get(target, key); } });
	const opened = command.openDashboard(ctx); await tick(); assert.ok(panel);
	await command.openDashboard(ctx); assert.match(panel.render(80).join("\n"), /SESSIONS/);
	panel.handleInput("a"); await tick(); assert.equal(actions, 1); assert.match(panel.render(80).join("\n"), /Status read/);
	panel.handleInput("\x1b"); panel.handleInput("\x1b"); await opened;
	assert.equal(editor.getText(), before);
});
