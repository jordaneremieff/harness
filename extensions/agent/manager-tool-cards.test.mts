import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionToolContext, RegisteredCommand, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import type { AgentDashboard } from "./dashboard.ts";
import { page, keys, theme } from "./dashboard-test-fixture.mts";
import registerAgentExtension from "./index.ts";
import { AgentManager } from "./manager.ts";
import { MANAGER_CONTRACT } from "./version-contract.ts";

it("serves only roster facts already observed by a footer refresh without lookup I/O", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "agent-card-lookup-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const manager = new AgentManager({
		root, agentDir: join(root, "agent"), packageDir: join(root, "package"),
		acquire: async () => { throw new Error("no host launch"); },
		connect: async () => { throw new Error("no live host"); },
		observe: async () => { throw new Error("no Durable observation"); },
		createPrimary: async (options) => ({
			id: options.id, socketPath: join(root, "primary.sock"),
			info: () => ({ id: options.id, cwd: root, hostname: "test-host", pid: process.pid, socketPath: join(root, "primary.sock"), startedAt: new Date().toISOString() }),
			update: () => {}, publishIntent: () => {}, touch: () => {}, setObservedPurpose: () => {}, close: async () => {},
		}),
	});
	t.after(() => manager.close());
	assert.deepEqual(manager.observedToolCardRows(), []);
	const record = manager.catalog.create({ cwd: root, agentDir: join(root, "agent"), packageDir: join(root, "package"), model: { provider: "fixture", modelId: "model" }, thinkingLevel: "high", ownerId: "owner" });
	manager.catalog.updateView(record.storageId, {
		updatedAt: new Date().toISOString(),
		rows: [{ id: record.storageId, storageId: record.storageId, name: "Parser review", cwd: root, model: { provider: "fixture", modelId: "model", thinkingLevel: "high" }, modifiedAt: 1, owner: "unknown", state: "idle", cost: 0, partial: false }],
		coverage: { complete: true, omitted: 0 },
	});
	assert.deepEqual(manager.observedToolCardRows(), [], "unobserved catalog data stays out of the lookup");
	await manager.registerPrimary("owner", { send: () => {}, status: () => {}, signal: new AbortController().signal, cwd: root });
	const rows = manager.observedToolCardRows();
	assert.equal(rows[0]?.name, "Parser review");
	assert.equal(rows[0]?.model?.provider, "fixture");
	manager.catalog.read = () => { throw new Error("lookup must not read catalog records"); };
	assert.equal(manager.observedToolCardRows(), rows);
	assert.equal(manager.observedToolCardRows(), rows);
});

it("reload refuses a retained manager without dashboard task targets before any lookup", async (t) => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "agent-dashboard-reload-")));
	const saved = new Map(["PI_AGENT_SESSIONS_DIR", "PI_AGENT_DIR", "PI_HARNESS_FILE"].map((name) => [name, process.env[name]]));
	process.env.PI_AGENT_SESSIONS_DIR = root;
	process.env.PI_AGENT_DIR = root;
	process.env.PI_HARNESS_FILE = join(root, "absent.json");
	const calls: string[] = [];
	const retained = {
		managerProtocol: "manager/4.0.0",
		subscribeRoster() { calls.push("subscribeRoster"); return () => {}; },
		async dashboardPage() { calls.push("dashboardPage"); return page([]); },
	};
	const owners = (globalThis as unknown as Record<symbol, { managers: Map<string, AgentManager> }>)[Symbol.for("pi.extension.agent.owners")];
	owners.managers.set(root, retained as unknown as AgentManager);
	t.after(() => {
		owners.managers.delete(root);
		for (const [name, value] of saved) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
		rmSync(root, { recursive: true, force: true });
	});
	const commands = new Map<string, Omit<RegisteredCommand, "name" | "sourceInfo">>();
	const pi = { events: { emit() {}, on: () => () => {} }, on: () => () => {}, registerTool() {},
		registerCommand: (name: string, command: Omit<RegisteredCommand, "name" | "sourceInfo">) => { commands.set(name, command); },
		registerShortcut() {}, registerMessageRenderer() {}, registerToolRenderer() {}, getSettings: () => ({}),
	} as unknown as ExtensionAPI;
	registerAgentExtension(pi);
	const notices: string[] = [];
	const ctx = { mode: "tui", hasUI: true, cwd: root, sessionManager: { getSessionId: () => "reloaded-primary" },
		ui: { notify: (text: string) => { notices.push(text); },
			custom: async (factory: (tui: TUI, paint: typeof theme, currentKeys: typeof keys, done: () => void) => AgentDashboard) => {
				const dashboard = factory({ terminal: { rows: 24, columns: 80 }, requestRender() {} } as unknown as TUI, theme, keys, () => {});
				dashboard.dispose();
			},
		},
	} as unknown as ExtensionCommandContext;
	const command = commands.get("agent");
	assert.ok(command);
	assert.notEqual(MANAGER_CONTRACT, retained.managerProtocol);
	assert.equal("dashboardTaskTargets" in retained, false);
	await command.handler("", ctx);
	assert.equal(notices.length, 1);
	assert.match(notices[0] ?? "", /retained agent manager uses manager\/4\.0\.0.*Restart Pi before agent controls/u);
	assert.equal(notices[0]?.includes(`requires ${MANAGER_CONTRACT}`), true);
	assert.deepEqual(calls, []);
});

for (const retained of ["manager/0.0.0", "manager/999.0.0"]) it(`refuses a retained manager with a different interface (${retained}) before any control executes`, async (t) => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "agent-card-reload-")));
	const previousRoot = process.env.PI_AGENT_SESSIONS_DIR;
	process.env.PI_AGENT_SESSIONS_DIR = root;
	const owners = (globalThis as unknown as Record<symbol, { managers: Map<string, AgentManager> }>)[Symbol.for("pi.extension.agent.owners")];
	owners.managers.set(root, { managerProtocol: retained } as unknown as AgentManager);
	t.after(() => {
		owners.managers.delete(root);
		if (previousRoot === undefined) delete process.env.PI_AGENT_SESSIONS_DIR;
		else process.env.PI_AGENT_SESSIONS_DIR = previousRoot;
		rmSync(root, { recursive: true, force: true });
	});
	const tools = new Map<string, ToolDefinition>();
	const pi = { events: { emit: () => {}, on: () => () => {} }, on: () => {}, registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool), registerCommand: () => {}, registerShortcut: () => {}, registerMessageRenderer: () => {}, registerToolRenderer: () => {} } as unknown as ExtensionAPI;
	registerAgentExtension(pi);
	const status = tools.get("agent_status");
	assert.ok(status);
	assert.notEqual(MANAGER_CONTRACT, retained);
	await assert.rejects(status.execute("call", {}, new AbortController().signal, undefined, {} as ExtensionToolContext), (error: Error) => error.message.includes(retained) && error.message.includes(MANAGER_CONTRACT) && error.message.includes("Restart Pi before agent controls"));
});
