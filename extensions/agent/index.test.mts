import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SessionManager, type ExtensionAPI, type ExtensionContext, type ExtensionToolContext, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import register from "./index.ts";
import { AgentManager } from "./manager.ts";
import type { HostConnection } from "./host-client.ts";
import { SENT_WORK_ENTRY } from "./session-work.ts";
import { HOST_CONTRACT } from "./version-contract.ts";

test("session start restores sent-work figures in a fresh manager and admissions persist without footer history scans", async (t) => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "agent-footer-reload-")));
	const saved = new Map(["PI_AGENT_SESSIONS_DIR", "PI_CODING_AGENT_DIR", "PI_AGENT_DIR", "PI_HARNESS_FILE"].map((key) => [key, process.env[key]]));
	process.env.PI_AGENT_SESSIONS_DIR = root;
	process.env.PI_CODING_AGENT_DIR = root;
	process.env.PI_AGENT_DIR = root;
	process.env.PI_HARNESS_FILE = join(root, "harness.json");
	writeFileSync(join(root, "harness.json"), "{}");
	const owners = (globalThis as unknown as Record<symbol, { managers: Map<string, AgentManager> }>)[Symbol.for("pi.extension.agent.owners")];
	t.after(() => {
		owners.managers.get(root)?.close();
		owners.managers.delete(root);
		for (const [key, value] of saved) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
		rmSync(root, { recursive: true, force: true });
	});
	const createManager = () => new AgentManager({
		root, agentDir: root, packageDir: root,
		createPrimary: async (options) => ({
			id: options.id, socketPath: "unused",
			info: () => ({ id: options.id, cwd: root, hostname: "fixture", pid: process.pid, socketPath: "unused", startedAt: new Date().toISOString() }),
			update() {}, publishIntent() {}, touch() {}, setObservedPurpose() {}, close: async () => {},
		}),
		observe: async () => { throw new Error("footer must not observe native storage"); },
		connect: async () => { throw new Error("footer must not connect"); },
		acquire: async (metadata) => ({
			metadata, storageId: metadata.storageId, closed: false, runtimeContract: HOST_CONTRACT,
			request: async (method: string, params: Record<string, unknown>) => {
				assert.equal(method, "task-submit");
				return { submissionId: 1, identity: params.sessionId, requestId: params.requestId };
			},
			onClose: () => () => {}, subscribeChanges: async () => () => {}, close: async () => {},
		}) as unknown as HostConnection,
	});
	let manager = createManager();
	owners.managers.set(root, manager);
	let session = SessionManager.create(root, join(root, "sessions"));
	const user = session.appendMessage({ role: "user", content: "Review the patch", timestamp: 1 });
	const target = manager.catalog.create({ cwd: root, agentDir: root, packageDir: root, ownerId: "other-primary", model: { provider: "test", modelId: "model" }, thinkingLevel: "off" }).storageId;
	manager.catalog.updateView(target, { updatedAt: new Date().toISOString(), coverage: { complete: true, omitted: 0 }, rows: [target, `${target}:2`, `${target}:3`].map((id) => ({ id, storageId: target, cwd: root, owner: "unknown", state: "idle", modifiedAt: 1, cost: 100, partial: false })) });
	session.appendMessage({ role: "toolResult", toolName: "agent_send", toolCallId: "prior", content: [], details: { result: { sessionId: `${target}:2`, submissionId: 9 } }, isError: false, timestamp: 2 });
	session.branch(user);
	const start = async () => {
		let reads = 0;
		const getEntries = session.getEntries.bind(session);
		session.getEntries = () => { reads++; return getEntries(); };
		const events = new Map<string, (event: unknown, ctx: ExtensionContext) => Promise<void>>();
		const tools = new Map<string, ToolDefinition>();
		const statuses: Array<string | undefined> = [];
		register({
			events: { emit() {}, on: () => () => {} },
			on: (name: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<void>) => { events.set(name, handler); return () => {}; },
			registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
			registerCommand() {}, registerShortcut() {}, registerMessageRenderer() {}, registerToolRenderer() {},
			getThinkingLevel: () => "off", appendEntry: (kind: string, data: unknown) => session.appendCustomEntry(kind, data),
		} as unknown as ExtensionAPI);
		const ctx = { cwd: root, sessionManager: session, ui: { setStatus: (_key: string, value: string | undefined) => statuses.push(value) }, modelRegistry: { getAll: () => [], find: () => undefined } } as unknown as ExtensionContext;
		await events.get("session_start")?.({ reason: "resume" }, ctx);
		assert.equal(reads, 1, "all session entries are scanned once at start");
		assert.equal(statuses.at(-1), "agents: 0/1 active");
		const page = await manager.dashboardPage();
		manager.catalog.page = async () => { throw new Error("figures must reuse the supplied page"); };
		assert.equal(await manager.sessionFigures(session.getSessionId(), page), "agents: 0/1 active");
		const send = tools.get("agent_send");
		assert.ok(send);
		await send.execute("nested-work", { sessionId: `${target}:3`, message: "Task", replyTo: "another-primary" }, new AbortController().signal, undefined, ctx as ExtensionToolContext);
		session.appendMessage({ role: "toolResult", toolName: "codemode", toolCallId: "script", content: [], isError: false, timestamp: 3,
			nestedCalls: { complete: true, calls: [{ id: "nested-work", name: "agent_send", arguments: { sessionId: `${target}:3`, message: "Task" }, status: "ok" }] },
		});
		assert.equal(reads, 1, "incremental work does not rescan history");
		assert.equal(statuses.at(-1), "agents: 0/2 active", "admission reuses already observed rows without scanning the catalog");
		assert.equal(await manager.sessionFigures(session.getSessionId(), page), "agents: 0/2 active");
		assert.ok(getEntries().some((entry) => entry.type === "custom" && entry.customType === SENT_WORK_ENTRY));
	};
	await start();
	const path = session.getSessionFile();
	assert.ok(path);
	manager.close();
	manager = createManager();
	owners.managers.set(root, manager);
	session = SessionManager.open(path, join(root, "sessions"));
	let startHandler: ((event: unknown, ctx: ExtensionContext) => Promise<void>) | undefined;
	const statuses: Array<string | undefined> = [];
	register({
		events: { emit() {}, on: () => () => {} }, on: (name: string, handler: typeof startHandler) => { if (name === "session_start") startHandler = handler; return () => {}; },
		registerTool() {}, registerCommand() {}, registerShortcut() {}, registerMessageRenderer() {}, registerToolRenderer() {}, getThinkingLevel: () => "off",
		appendEntry: (kind: string, data: unknown) => session.appendCustomEntry(kind, data),
	} as unknown as ExtensionAPI);
	await startHandler?.({ reason: "resume" }, { cwd: root, sessionManager: session, ui: { setStatus: (_key: string, value: string | undefined) => statuses.push(value) }, modelRegistry: { getAll: () => [] } } as unknown as ExtensionContext);
	assert.equal(statuses.at(-1), "agents: 0/2 active", "a fresh manager restores historical top-level work and a forward nested send through its marker");
});
