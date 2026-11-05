import assert from "node:assert/strict";
import { it } from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDashboardState, agentState, dashboardSessionState } from "./dashboard-state.ts";
it("selection and drafts stay local to the primary identity across reopen", () => {
	const state = dashboardSessionState("primary-a");
	state.selected = "one";
	agentState(state, "one").draft = "kept";
	assert.equal(dashboardSessionState("primary-a"), state);
	assert.notEqual(dashboardSessionState("primary-b"), state);
});

it("new reading states start collapsed and keep an explicit per-agent choice", () => {
	for (const setting of [undefined, false, true]) {
		const state = createDashboardState(); state.hideThinkingBlock = setting;
		const existing = agentState(state, "existing").view;
		assert.equal(existing.showThinking, false);
		assert.equal(existing.expanded, false);
		existing.showThinking = true;
		assert.equal(agentState(state, "existing").view.showThinking, true);
		assert.equal(agentState(state, "new").view.showThinking, false);
	}
});
it("tool expansion choices survive process-local dashboard close and reopen", () => {
	const state = dashboardSessionState("expansion-primary");
	const reading = agentState(state, "one").view;
	reading.toolExpanded.set("call", true);
	reading.showThinking = false;
	const reopened = dashboardSessionState("expansion-primary");
	assert.equal(agentState(reopened, "one").view, reading);
	assert.deepEqual([...reading.toolExpanded], [["call", true]]);
	assert.equal(reading.showThinking, false);
	assert.equal(agentState(reopened, "other").view.toolExpanded.size, 0);
});

it("dashboard open reads the primary callback and never writes settings", () => {
	const root = mkdtempSync(join(tmpdir(), "dashboard-settings-"));
	try {
		const code = 'import assert from "node:assert/strict"; import { mock } from "node:test";' +
			'const { agentState } = await import(' + JSON.stringify(new URL("./dashboard-state.ts", import.meta.url).href) + '); let opened; mock.module(' + JSON.stringify(new URL("./dashboard.ts", import.meta.url).href) + ', { namedExports: { showAgentDashboard: async ({ state }) => { opened = state; } } });' +
			'const { createAgentCommand } = await import(' + JSON.stringify(new URL("./command.ts", import.meta.url).href) + ');' +
			'for (const setting of [undefined, false, true]) { let reads = 0; const api = { getSettings: () => { reads++; return { hideThinkingBlock: setting }; }, setSettings: () => { throw new Error("settings write"); } }; const ctx = { hasUI: true, sessionManager: { getSessionId: () => "settings-" + String(setting) } }; const command = createAgentCommand([], {}, {}, undefined, undefined, undefined, undefined, () => api.getSettings().hideThinkingBlock ?? false); await command.openDashboard(ctx); const reading = agentState(opened, "one").view; assert.equal(reading.showThinking, false); reading.showThinking = true; await command.openDashboard(ctx); assert.equal(agentState(opened, "one").view.showThinking, true); assert.equal(reads, 2); }';
		const child = spawnSync(process.execPath, ["--experimental-test-module-mocks", "--input-type=module", "-e", code], { encoding: "utf8", timeout: 30000, env: { ...process.env, PI_AGENT_DIR: join(root, "agent"), PI_AGENT_SESSIONS_DIR: join(root, "sessions") } });
		assert.equal(child.status, 0, child.stderr || String(child.error));
	} finally { rmSync(root, { recursive: true, force: true }); }
});
