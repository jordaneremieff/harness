import assert from "node:assert/strict";
import { it } from "node:test";
import type { ExtensionContext, KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { KeybindingsManager as Keys, TUI_KEYBINDINGS, type Component, type TUI } from "@earendil-works/pi-tui";
import { createAgentCommand } from "./command.ts";
import { type AgentDashboard, showAgentDashboard, type AgentObservationSources } from "./dashboard.ts";
import type { SessionDigest } from "./dashboard-data.ts";

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const keys = new Keys(TUI_KEYBINDINGS) as KeybindingsManager;
const theme = { fg: (_: string, text: string) => text, bg: (_: string, text: string) => text, bold: (text: string) => text } as Theme;
type Factory = (tui: TUI, theme: Theme, keys: KeybindingsManager, done: (request: unknown) => void) => Component;
const row: SessionDigest = { sessionId: "native-id", name: "Native session", cwd: "/work", path: "/store/native.jsonl", live: false, createdAt: 1, modifiedAt: 2, state: "new", cost: 0, partial: false, latestReply: "", toolCalls: 0 };
const sources: AgentObservationSources = { sessions: async () => [row], runs: async () => [], board: async () => [row], conversation: async () => ({ entries: [], partial: false, revision: "1" }) };

it("closes each overlay before native dialogs and restores selection and conversation afterward", async () => {
	let overlays = 0; let inOverlay = false; let actions = 0;
	const screens: string[] = [];
	const ctx = { mode: "tui", hasUI: true, ui: {
		custom: async (factory: Factory, options: unknown) => {
			assert.deepEqual(options, { overlay: true, overlayOptions: { width: "100%", maxHeight: "100%", margin: { top: 1, bottom: 1 } } });
			assert.equal(inOverlay, false); inOverlay = true; overlays++;
			let resolve!: (value: unknown) => void;
			const result = new Promise((done) => { resolve = done; });
			const panel = factory({ terminal: { rows: 24 }, requestRender() {} } as unknown as TUI, theme, keys, (request) => { panel.dispose(); inOverlay = false; resolve(request); }) as AgentDashboard;
			await tick();
			if (overlays === 1) { panel.handleInput("\r"); await tick(); panel.handleInput("a"); }
			else { screens.push(panel.render(100).join("\n")); panel.handleInput("\x1b"); screens.push(panel.render(100).join("\n")); assert.equal(panel.state.selected, "native-id"); panel.handleInput("\x1b"); panel.handleInput("\x1b"); }
			return result;
		},
		select: async () => { assert.equal(inOverlay, false); return "status: Read owner"; },
		notify: () => assert.fail("actions return inside the board"),
	} } as unknown as ExtensionContext;
	const command = createAgentCommand([{ name: "status", description: "Read owner", args: [{ name: "session", complete: "session-control" }], run: async (args) => { assert.equal(inOverlay, false); assert.deepEqual(args, ["native-id"]); actions++; return "owner status sentinel"; } }], sources);
	await command.openDashboard(ctx);
	assert.equal(overlays, 2); assert.equal(actions, 1); assert.equal(inOverlay, false);
	assert.match(screens[0], /owner status sentinel/); assert.match(screens[1], /TAIL/);
});

it("restores the board after canceled dialogs and exposes action errors in a scrollable result", async () => {
	let count = 0; let closed = true; const views: string[] = [];
	const ctx = { mode: "tui", hasUI: true, ui: { custom: async (factory: Factory) => {
		let resolve!: (value: unknown) => void; const promise = new Promise((done) => { resolve = done; });
		closed = false;
		const panel = factory({ terminal: { rows: 12 }, requestRender() {} } as unknown as TUI, theme, keys, (value) => { panel.dispose(); closed = true; resolve(value); }) as AgentDashboard;
		await tick(); views.push(panel.render(80).join("\n"));
		if (++count < 3) panel.handleInput("a");
		else { panel.handleInput("\x1b"); panel.handleInput("\x1b"); }
		return promise;
	} } } as unknown as ExtensionContext;
	let actions = 0;
	await showAgentDashboard(sources, ctx, { run: async () => { assert.equal(closed, true); if (++actions === 1) return undefined; throw new Error("exact refusal sentinel"); } });
	assert.match(views[1], /Native session/); assert.match(views[2], /exact refusal sentinel/); assert.equal(closed, true);
});

it("the composer calls the same native command action and leaves the overlay open", async () => {
	const calls: string[][] = []; let panel!: AgentDashboard; let finish!: () => void;
	const command = createAgentCommand([{ name: "send", description: "Send", args: [{ name: "session", complete: "session" }, { name: "message", rest: true }], run: async (args) => { calls.push(args); return "Admitted"; } }], sources);
	const ctx = { mode: "tui", hasUI: true, ui: { custom: async (factory: Factory) => {
		const result = new Promise<void>((resolve) => { finish = resolve; });
		panel = factory({ terminal: { rows: 24 }, requestRender() {} } as unknown as TUI, theme, keys, () => { panel.dispose(); finish(); }) as AgentDashboard;
		return result;
	} } } as unknown as ExtensionContext;
	const open = command.openDashboard(ctx); await tick();
	panel.handleInput("m"); panel.handleInput("Message with spaces"); panel.handleInput("\r"); await tick();
	assert.deepEqual(calls, [["native-id", "Message with spaces"]]); assert.match(panel.render(80).join("\n"), /Admitted/);
	panel.handleInput("\x1b"); await open;
});
