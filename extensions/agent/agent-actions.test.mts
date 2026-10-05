/**
 * The `/agent send` and `/agent steer` actions share one submit call shape
 * except for the busy disposition: send waits for the current answer, steer
 * redirects the running work.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import type { ExtensionAPI, ExtensionCommandContext, RegisteredCommand } from "@earendil-works/pi-coding-agent";
import registerAgentExtension from "./index.ts";
import { AgentManager } from "./manager.ts";

it("admits /agent send as a follow-up and /agent steer as steering", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "agent-actions-"));
	const previousSessionsDir = process.env.PI_AGENT_SESSIONS_DIR;
	process.env.PI_AGENT_SESSIONS_DIR = root;
	const calls: Array<{ method: string; input: Record<string, unknown> }> = [];
	const originalControl = AgentManager.prototype.control;
	const originalStatus = AgentManager.prototype.status;
	AgentManager.prototype.control = async (method: string, input: Record<string, unknown>) => {
		calls.push({ method, input });
		return method === "await-release" ? { released: true } : {};
	};
	AgentManager.prototype.status = async () => ({ conversation: { name: "poem task" } });
	t.after(() => {
		AgentManager.prototype.control = originalControl;
		AgentManager.prototype.status = originalStatus;
		if (previousSessionsDir === undefined) delete process.env.PI_AGENT_SESSIONS_DIR;
		else process.env.PI_AGENT_SESSIONS_DIR = previousSessionsDir;
		rmSync(root, { recursive: true, force: true });
	});
	const commands = new Map<string, Omit<RegisteredCommand, "name" | "sourceInfo">>();
	registerAgentExtension({
		events: { emit() {}, on: () => () => {} },
		on: () => () => {},
		registerTool() {},
		registerShortcut() {},
		registerMessageRenderer() {}, registerToolRenderer() {},
		getThinkingLevel: () => "off",
		registerCommand: (name: string, command: Omit<RegisteredCommand, "name" | "sourceInfo">) => {
			commands.set(name, command);
		},
	} as unknown as ExtensionAPI);
	const notices: string[] = [];
	const ctx = {
		cwd: root,
		sessionManager: { getSessionId: () => "primary", getSessionName: () => "Primary" },
		ui: { notify: (text: string) => notices.push(text) },
	} as unknown as ExtensionCommandContext;
	const command = commands.get("agent");
	assert.ok(command);
	await command.handler("send target-session keep going", ctx);
	await command.handler("steer target-session change course", ctx);
	await command.handler("await-release target-session 42", ctx);
	assert.deepEqual(calls, [
		{
			method: "submit",
			input: { sessionId: "target-session", message: "keep going", whenBusy: "followUp", origin: "operator" },
		},
		{
			method: "submit",
			input: { sessionId: "target-session", message: "change course", whenBusy: "steer", origin: "operator" },
		},
		{ method: "await-release", input: { sessionId: "target-session", expectedRunId: 42 } },
	]);
	assert.equal(notices.length, 3);
});
