import assert from "node:assert/strict";
import { it } from "node:test";
import { initTheme, type ExtensionContext, type KeybindingsManager, type Theme } from "@earendil-works/pi-coding-agent";
import { KeybindingsManager as Keys, TUI_KEYBINDINGS, type Component, type TUI } from "@earendil-works/pi-tui";
import { createAgentCommand } from "./command.ts";
import { AgentDashboard, showAgentDashboard } from "./dashboard.ts";
import { AgentActionPicker } from "./dashboard-actions.ts";
import type { AgentConversationEntry, AgentConversationSummary, AgentObservationSources } from "./dashboard-types.ts";

initTheme("dark");
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const keys = new Keys(TUI_KEYBINDINGS) as KeybindingsManager;
const theme = { fg: (_: string, text: string) => text, bg: (_: string, text: string) => text, bold: (text: string) => text } as Theme;
type Factory = (tui: TUI, theme: Theme, keys: KeybindingsManager, done: (request: unknown) => void) => Component;
const row: AgentConversationSummary = { id: "native-id", storageId: "storage", name: "Native session", cwd: "/work", owner: "here", modifiedAt: 2, state: "new", cost: 0, partial: false, latestReply: "", toolCalls: 0 };
const userEntry = (id: string, content: string, timestamp = 1): AgentConversationEntry => ({ id, kind: "pi.user", model: [{ role: "user", content, timestamp }] });
const page = (items: readonly AgentConversationSummary[]) => ({ rows: items, coverage: { complete: true, storagesVisited: 1, skipped: 0, omitted: 0, nextCursor: null }, observedAt: new Date().toISOString() });
const sources = (entries: AgentConversationEntry[] = []): AgentObservationSources => ({ list: async () => page([row]), snapshot: async () => ({ entries: [...entries], partial: false, revision: "1" }) });

it("opens native action dialogs over the board and restores selection and conversation afterward", async () => {
	let boards = 0; let actions = 0;
	const hidden: boolean[] = [];
	const screens: string[] = [];
	const ctx = { mode: "tui", hasUI: true, ui: {
		custom: async (factory: Factory, options: { overlay?: boolean; overlayOptions?: unknown; onHandle?: (handle: { setHidden(value: boolean): void }) => void }) => {
			assert.equal(options.overlay, true);
			assert.deepEqual(options.overlayOptions, { width: "100%", maxHeight: "100%", margin: { top: 1, bottom: 1 } });
			options.onHandle?.({ setHidden: (value) => hidden.push(value) });
			let resolve!: (value: unknown) => void;
			const result = new Promise((done) => { resolve = done; });
			const component = factory({ terminal: { rows: 24 }, requestRender() {} } as unknown as TUI, theme, keys, (request) => { if (component instanceof AgentDashboard) component.dispose(); resolve(request); });
			await tick();
			if (component instanceof AgentActionPicker) { component.render(100); component.handleInput("\r"); return result; }
			assert.ok(component instanceof AgentDashboard); const panel = component; boards++;
			panel.handleInput("a");
			await tick();
			screens.push(panel.render(100).join("\n"));
			panel.handleInput("\x1b");
			screens.push(panel.render(100).join("\n"));
			assert.equal(panel.state.selected, "native-id");
			assert.equal(panel.state.focus, "sessions");
			panel.handleInput("\x1b");
			return result;
		},
		select: async () => "status: Read owner",
		notify: () => assert.fail("actions return inside the board"),
	} } as unknown as ExtensionContext;
	const command = createAgentCommand([{ name: "status", description: "Read owner", args: [{ name: "session", complete: "session-control" }], run: async (args) => { assert.deepEqual(args, ["native-id"]); actions++; return "owner status sentinel"; } }], sources());
	await command.openDashboard(ctx);
	assert.equal(boards, 1, "the board stays mounted through the action");
	assert.equal(actions, 1);
	assert.deepEqual(hidden, [], "an action without a native dialog keeps the board visible");
	assert.match(screens[0], /owner status sentinel/);
	assert.match(screens[1], /Sessions · ↑↓ select/);
});

it("keeps the board through a canceled action and exposes a refused action in its result", async () => {
	let panel!: AgentDashboard; let finish!: () => void; let actions = 0;
	const ctx = { mode: "tui", hasUI: true, ui: { custom: async (factory: Factory) => {
		const result = new Promise<void>((resolve) => { finish = resolve; });
		panel = factory({ terminal: { rows: 12 }, requestRender() {} } as unknown as TUI, theme, keys, () => { panel.dispose(); finish(); }) as AgentDashboard;
		return result;
	} } } as unknown as ExtensionContext;
	const open = showAgentDashboard(sources(), ctx, { run: async () => { if (++actions === 1) return undefined; throw new Error("exact refusal sentinel"); } });
	await tick();
	panel.handleInput("a"); await tick();
	assert.equal(actions, 1);
	assert.equal(panel.state.actionResult, undefined, "a canceled action leaves the board unchanged");
	assert.match(panel.render(80).join("\n"), /Native session/);
	panel.handleInput("a"); await tick();
	assert.match(panel.render(80).join("\n"), /exact refusal sentinel/);
	panel.handleInput("\x1b"); await tick();
	assert.equal(panel.state.actionResult, undefined);
	assert.match(panel.render(80).join("\n"), /Native session/);
	panel.handleInput("\x1b"); await open;
});

it("keeps passage and draft state through a native action dialog", async () => {
	const entries: AgentConversationEntry[] = [];
	for (let index = 0; index < 100; index++) entries.push(userEntry(`p${index}`, `native passage ${index}`, index));
	const observed: AgentObservationSources = { list: async () => page([row]), snapshot: async () => ({ entries: [...entries], partial: false, revision: "1" }) };
	let panel!: AgentDashboard; let finish!: () => void; let actions = 0;
	const ctx = { mode: "tui", hasUI: true, ui: { custom: async (factory: Factory) => {
		const result = new Promise<void>((resolve) => { finish = resolve; });
		panel = factory({ terminal: { rows: 36 }, requestRender() {} } as unknown as TUI, theme, keys, () => { panel.dispose(); finish(); }) as AgentDashboard;
		return result;
	} } } as unknown as ExtensionContext;
	const open = showAgentDashboard(observed, ctx, { run: async () => { actions++; return undefined; }, compose: async () => "Admitted" });
	await tick(); panel.state.focus = "conversation"; panel.render(120);
	panel.handleInput("o"); panel.render(120); panel.handleInput("\x1b[H"); panel.handleInput("j"); panel.handleInput("j"); panel.handleInput("x"); panel.render(120);
	panel.handleInput("m"); panel.handleInput("native draft"); panel.handleInput("\x1b");
	const before = structuredClone(panel.state.views.get("native-id")); panel.handleInput("a");
	await tick();
	assert.equal(actions, 1);
	assert.deepEqual(panel.state.views.get("native-id"), before);
	assert.equal(panel.state.drafts.get("native-id"), "native draft");
	assert.match(panel.render(120).join("\n"), /BROWSE/);
	panel.handleInput("\x1b"); await open;
});

it("the composer calls the same native command action and leaves the overlay open", async () => {
	const calls: string[][] = []; let panel!: AgentDashboard; let finish!: () => void;
	const command = createAgentCommand([{ name: "send", description: "Send", args: [{ name: "session", complete: "session" }, { name: "message", rest: true }], run: async (args) => { calls.push(args); return "Admitted"; } }], sources());
	const ctx = { mode: "tui", hasUI: true, ui: { custom: async (factory: Factory) => {
		const result = new Promise<void>((resolve) => { finish = resolve; });
		panel = factory({ terminal: { rows: 24 }, requestRender() {} } as unknown as TUI, theme, keys, () => { panel.dispose(); finish(); }) as AgentDashboard;
		return result;
	} } } as unknown as ExtensionContext;
	const open = command.openDashboard(ctx); await tick();
	panel.handleInput("\r"); assert.equal(panel.state.focus, "conversation"); panel.handleInput("\r"); panel.handleInput("Message with spaces"); panel.handleInput("\n"); panel.handleInput("café 世界");
	assert.deepEqual(calls, [], "Ctrl+J inserts a newline instead of submitting");
	panel.handleInput("\r"); await tick();
	assert.deepEqual(calls, [["native-id", "Message with spaces\ncafé 世界"]]); assert.match(panel.render(80).join("\n"), /Admitted/);
	panel.handleInput("\x1b"); await open;
});
