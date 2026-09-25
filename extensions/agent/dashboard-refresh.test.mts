import assert from "node:assert/strict";
import { it } from "node:test";
import type { ExtensionCommandContext, KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { KeybindingsManager as Keys, TUI_KEYBINDINGS, type TUI } from "@earendil-works/pi-tui";
import { showAgentDashboard, type AgentDashboard, type AgentObservationSources } from "./dashboard.ts";

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const keys = new Keys(TUI_KEYBINDINGS) as KeybindingsManager;
const theme = { fg: (_: string, text: string) => text, bg: (_: string, text: string) => text } as Theme;
type Factory = Parameters<ExtensionCommandContext["ui"]["custom"]>[0];

it("preserves selected-only model filtering after an action remount", async () => {
	let opens = 0; let descriptions = 0;
	const sources: AgentObservationSources = {
		sessions: async () => [{ sessionId: "stored", name: "Stored work", cwd: "/work", modifiedAt: 1, live: false }], runs: async () => [],
		inspect: async () => { throw new Error("No transcript"); },
		describe: async () => { descriptions++; return { provenance: "stored", parentSessionIds: [], model: { provider: "sample", modelId: "selected-model", thinkingLevel: "low" } }; },
	};
	const ctx = { mode: "tui", hasUI: true, ui: { custom: async (factory: Factory) => {
		let request: unknown;
		const panel = await factory({ terminal: { rows: 24 }, requestRender() {} } as unknown as TUI, theme, keys, (value) => { request = value; }) as AgentDashboard; await tick();
		if (opens++ === 0) {
			panel.handleInput("/"); panel.handleInput("selected-model"); panel.handleInput("\r"); panel.handleInput("a");
		} else {
			assert.equal(panel.state.filter, "selected-model"); assert.equal(panel.state.selected.sessions, "stored");
			assert.match(panel.render(120).join("\n"), /1 matching/); assert.equal(descriptions, 2); panel.handleInput("\x1b");
		}
		panel.dispose(); return request;
	} } } as unknown as ExtensionCommandContext;
	await showAgentDashboard(sources, ctx, { run: async () => undefined }); assert.equal(opens, 2);
});

for (const failure of ["none", "action", "refresh"] as const) {
	it(`refreshes inventory after an action with ${failure} failure and preserves the filter and identity`, async () => {
		let reads = 0; let opens = 0; let acted = false;
		const sources: AgentObservationSources = {
			sessions: async () => {
				reads++;
				if (acted && failure === "refresh") throw new Error("inventory unavailable sentinel");
				return [{ sessionId: "selected", name: "Selected work", cwd: "/work", modifiedAt: 1, live: true, operation: acted ? null : "operation" }];
			}, runs: async () => [], inspect: async () => { throw new Error("No transcript"); },
		};
		const ctx = { mode: "tui", hasUI: true, ui: { custom: async (factory: Factory) => {
			let request: unknown;
			const panel = await factory({ terminal: { rows: 24 }, requestRender() {} } as unknown as TUI, theme, keys, (value) => { request = value; }) as AgentDashboard;
			await tick();
			if (opens++ === 0) {
				panel.handleInput("/"); panel.handleInput("Selected"); panel.handleInput("\r");
				assert.match(panel.render(80).join("\n"), /Active/);
				panel.handleInput("a");
			} else {
				assert.equal(reads, 2);
				assert.equal(panel.state.filter, "Selected");
				if (failure === "action") assert.match(panel.render(80).join("\n"), /action failed sentinel/);
				panel.handleInput("\x1b");
				const screen = panel.render(80).join("\n");
				assert.equal(panel.state.selected.sessions, "selected");
				assert.doesNotMatch(screen, /Active/);
				if (failure === "refresh") {
					assert.match(screen, /Source unavailable/);
					panel.handleInput("\r");
					assert.match(panel.render(80).join("\n"), /inventory unavailable sentinel/);
					panel.handleInput("\x1b");
				} else assert.match(screen, /Open here/);
				panel.handleInput("\x1b");
			}
			panel.dispose(); return request;
		} } } as unknown as ExtensionCommandContext;
		await showAgentDashboard(sources, ctx, { run: async () => { acted = true; if (failure === "action") throw new Error("action failed sentinel"); return "Action complete"; } });
		assert.equal(reads, 2); assert.equal(opens, 2);
	});
}
