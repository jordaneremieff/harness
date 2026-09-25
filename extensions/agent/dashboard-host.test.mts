import assert from "node:assert/strict";
import { it } from "node:test";
import type { ExtensionCommandContext, KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { KeybindingsManager as Keys, TUI_KEYBINDINGS, type Component, type TUI } from "@earendil-works/pi-tui";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createAgentCommand } from "./command.ts";
import { type AgentDashboard, showAgentDashboard, type AgentObservationSources } from "./dashboard.ts";
import { defined } from "./test-assertions.mts";
import { projectInspection } from "./worker.ts";

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const keys = new Keys(TUI_KEYBINDINGS) as KeybindingsManager;
const theme = { fg: (_color: string, text: string) => text, bg: (_color: string, text: string) => text } as Theme;
type Factory = (tui: TUI, theme: Theme, keys: KeybindingsManager, done: (request: unknown) => void) => Component;

it("closes and disposes each native overlay before dialogs, then restores selection and the reader", async () => {
	const manager = SessionManager.inMemory();
	manager.appendCustomEntry("sample.result", { value: "source result sentinel" });
	const sources: AgentObservationSources = {
		sessions: async () => [{ sessionId: "native-id", cwd: "/work", modifiedAt: 1, live: false }],
		runs: async () => [], inspect: async (id, options) => projectInspection(manager, id, options),
	};
	let overlays = 0; let active: AgentDashboard | undefined; let inOverlay = false; let actions = 0;
	const screens: string[] = [];
	const ctx = { mode: "tui", hasUI: true, ui: {
		custom: async (factory: Factory, options: unknown) => {
			assert.deepEqual(options, { overlay: true, overlayOptions: { width: "100%", maxHeight: "100%", margin: { top: 1, bottom: 1 } } });
			assert.equal(inOverlay, false); inOverlay = true; overlays++;
			let resolve!: (value: unknown) => void;
			const result = new Promise((done) => { resolve = done; });
			active = factory({ terminal: { rows: 24 }, requestRender() {} } as unknown as TUI, theme, keys, (request) => { defined(active).dispose(); inOverlay = false; resolve(request); }) as AgentDashboard;
			await tick();
			if (overlays === 1) { active.handleInput("\r"); await tick(); screens.push(active.render(100).join("\n")); active.handleInput("a"); }
			else { screens.push(active.render(100).join("\n")); active.handleInput("b"); screens.push(active.render(100).join("\n")); active.handleInput("\x1b"); active.handleInput("\x1b"); }
			return result;
		},
		select: async () => { assert.equal(inOverlay, false); return "status: Read owner"; },
		notify: () => assert.fail("dashboard actions return to their reader, not notifications"),
	} } as unknown as ExtensionCommandContext;
	const command = createAgentCommand([{ name: "status", description: "Read owner", args: [{ name: "session", complete: "session-control" }], run: async (args) => { assert.equal(inOverlay, false); assert.deepEqual(args, ["native-id"]); actions++; return "owner status sentinel"; } }], sources);
	await command.handler("", ctx);
	assert.equal(overlays, 2); assert.equal(actions, 1); assert.equal(inOverlay, false);
	assert.match(screens[0], /Live owner state unavailable/);
	assert.match(screens[1], /owner status sentinel/);
	assert.match(screens[2], /Live owner state unavailable/);
	assert.equal(defined(active).state.selected.sessions, "native-id");
});

it("returns cancelled dialogs to the exact prior reader and shows uncaught action refusals", async () => {
	let count = 0; let closed = true; const views: string[] = [];
	const sources: AgentObservationSources = { sessions: async () => [], runs: async () => [], inspect: async () => { throw new Error("not requested"); } };
	const ctx = { mode: "tui", hasUI: true, ui: { custom: async (factory: Factory) => {
		let resolve!: (value: unknown) => void; const promise = new Promise((done) => { resolve = done; });
		closed = false;
		const panel = factory({ terminal: { rows: 8 }, requestRender() {} } as unknown as TUI, theme, keys, (value) => { closed = true; resolve(value); }) as AgentDashboard;
		await tick(); views.push(panel.render(80).join("\n"));
		if (++count < 3) panel.handleInput("a");
		else { panel.handleInput("\x1b"); panel.handleInput("\x1b"); }
		return promise;
	} } } as unknown as ExtensionCommandContext;
	let actions = 0;
	await showAgentDashboard(sources, ctx, { run: async () => { assert.equal(closed, true); if (++actions === 1) return undefined; throw new Error("exact refusal sentinel"); } });
	assert.match(views[1], /None found/);
	assert.match(views[2], /exact refusal sentinel/);
	assert.equal(closed, true);
});
