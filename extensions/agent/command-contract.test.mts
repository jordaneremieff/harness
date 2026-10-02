import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { it } from "node:test";
import type { ExtensionAPI, ExtensionCommandContext, RegisteredCommand } from "@earendil-works/pi-coding-agent";
import register from "./index.ts";
import { AgentManager } from "./manager.ts";
import { PlaceBook } from "./places.ts";

it("preserves optional command inputs and resolves directory commands at the primary cwd", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "agent-command-contract-"));
	const beforeRoot = process.env.PI_AGENT_SESSIONS_DIR;
	process.env.PI_AGENT_SESSIONS_DIR = root;
	const methods = { control: AgentManager.prototype.control, place: AgentManager.prototype.place, unbind: PlaceBook.prototype.unbind };
	t.after(() => {
		Object.assign(AgentManager.prototype, { control: methods.control, place: methods.place });
		PlaceBook.prototype.unbind = methods.unbind;
		if (beforeRoot === undefined) delete process.env.PI_AGENT_SESSIONS_DIR;
		else process.env.PI_AGENT_SESSIONS_DIR = beforeRoot;
		rmSync(root, { recursive: true, force: true });
	});
	const calls: Array<{ method: string; input: unknown }> = [];
	AgentManager.prototype.control = async (method, input) => { calls.push({ method, input }); return {}; };
	AgentManager.prototype.place = async (input) => { calls.push({ method: "place", input }); return {}; };
	PlaceBook.prototype.unbind = (area) => { calls.push({ method: "unbind", input: area }); return undefined; };
	const commands = new Map<string, Omit<RegisteredCommand, "name" | "sourceInfo">>();
	register({
		events: { emit() {} }, on: () => () => {}, registerTool() {},
		registerCommand: (name: string, command: Omit<RegisteredCommand, "name" | "sourceInfo">) => commands.set(name, command),
		registerShortcut() {}, registerMessageRenderer() {}, getThinkingLevel: () => "off",
	} as unknown as ExtensionAPI);
	const notices: string[] = [];
	const ctx = { cwd: join(root, "work"), sessionManager: { getSessionId: () => "primary" }, ui: { notify: (text: string) => notices.push(text) } } as unknown as ExtensionCommandContext;
	const command = commands.get("agent");
	assert.ok(command);
	for (const input of ["compact target preserve exact source links", "attach target fixture/model", "fork target 7", "place ../project next task", "unbind ./bound"]) await command.handler(input, ctx);
	assert.deepEqual(calls, [
		{ method: "compact", input: { sessionId: "target", instructions: "preserve exact source links" } },
		{ method: "attach", input: { sessionId: "target", model: "fixture/model" } },
		{ method: "fork", input: { sessionId: "target", entryId: "7" } },
		{ method: "place", input: { area: resolve(ctx.cwd, "../project"), prompt: "next task", origin: "operator" } },
		{ method: "unbind", input: resolve(ctx.cwd, "./bound") },
	]);
	assert.equal(notices.length, 5);
});
