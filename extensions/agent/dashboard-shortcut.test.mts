import assert from "node:assert/strict";
import { it } from "node:test";
import type { ExtensionAPI, ExtensionCommandContext, RegisteredCommand } from "@earendil-works/pi-coding-agent";
import { createAgentCommand } from "./command.ts";
import register from "./index.ts";
import { AgentDashboard } from "./dashboard.ts";
import { source, theme, keys, turn } from "./dashboard-test-fixture.mts";
import type { TUI } from "@earendil-works/pi-tui";
it("/agent mounts one dashboard, not a primary projection, and releases the open guard", async () => {
	const command = createAgentCommand([], source(), {
		timers: async () => [],
		schedule: async () => ({ text: "scheduled" }),
	});
	let ui!: AgentDashboard;
	let opens = 0;
	let done!: () => void;
	const ctx = {
		mode: "tui",
		hasUI: true,
		cwd: "/work",
		sessionManager: { getSessionId: () => "shortcut-primary" },
		ui: {
			custom: async (factory: (...args: unknown[]) => AgentDashboard) => {
				opens++;
				await new Promise<void>((resolve) => {
					done = resolve;
					ui = factory(
						{ terminal: { rows: 24, columns: 80 }, requestRender() {} } as unknown as TUI,
						theme,
						keys,
						resolve,
					);
				});
				ui.dispose();
			},
			setEditorText: () => {
				throw new Error("primary editor mutation");
			},
			notify() {},
		},
	} as unknown as ExtensionCommandContext;
	const opened = command.handler("", ctx);
	await turn();
	assert.ok(ui instanceof AgentDashboard);
	assert.equal(ui.navigation.screen, "roster");
	await command.openDashboard(ctx);
	assert.equal(opens, 1);
	done();
	await opened;
	const reopened = command.openDashboard(ctx);
	assert.equal(opens, 2);
	ui.handleInput("\x1b");
	await reopened;
});
it("the sole entry shortcut names the dashboard and registers no primary observers", () => {
	const shortcuts: Array<{ key: string; description: string }> = [];
	const events: string[] = [];
	register({
		events: { emit() {} },
		registerTool() {},
		registerMessageRenderer() {}, registerToolRenderer() {},
		registerCommand(_name: string, _value: RegisteredCommand) {},
		registerShortcut: (key: string, value: { description: string }) =>
			shortcuts.push({ key, description: value.description }),
		on: (event: string) => {
			events.push(event);
		},
		getThinkingLevel: () => "high",
	} as unknown as ExtensionAPI);
	assert.deepEqual(shortcuts, [{ key: "ctrl+alt+g", description: "Open the agent dashboard" }]);
	assert.ok(!events.includes("message_update"));
	assert.ok(!events.includes("tool_execution_update"));
});
