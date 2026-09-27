import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { test } from "node:test";
import { ProjectTrustStore, SessionManager, type AgentSessionRuntime, type ExtensionAPI, type ExtensionCommandContext, type RegisteredCommand } from "@earendil-works/pi-coding-agent";
import registerAgentExtension, { AgentManager } from "./index.ts";
import { ASSOCIATION_ENTRY } from "./associations.ts";
import { configurationDialog } from "./configuration-dialog.ts";
import type { ConfigurationResult } from "./configuration.ts";
import { DetachedRuns } from "./detached.ts";
import { fixture } from "./native-fixture.mts";
import { AgentStore } from "./store.ts";
import { testModel } from "./test-runtime.mts";
import type { AgentWorkerSession } from "./worker.ts";

function deferred() { let resolve!: () => void; const promise = new Promise<void>((done) => { resolve = done; }); return { promise, resolve }; }
const globals = globalThis as unknown as Record<string, unknown>;
async function managed(extension?: string) {
	const f = await fixture(extension);
	const id = f.worker.sessionId();
	await f.worker.close();
	const manager = new AgentManager(f.store, f.runtime, new ProjectTrustStore(f.agentDir), undefined, f.agentDir);
	await manager.attach(id);
	const worker = (manager as unknown as { sessions: Map<string, AgentWorkerSession> }).sessions.get(id);
	assert.ok(worker);
	const runtime = (worker as unknown as { runtime: AgentSessionRuntime }).runtime;
	return { ...f, id, manager, worker, native: runtime, close: async () => { await manager.closeAll(); await f.close(); } };
}

test("configuration reserves its owner synchronously and refuses competing controls and transfer", { timeout: 5000 }, async (t) => {
	const f = await managed();
	const entered = deferred(), release = deferred();
	const check = f.native.services.modelRuntime.checkAuth.bind(f.native.services.modelRuntime);
	t.mock.method(f.native.services.modelRuntime, "checkAuth", async (provider: string) => { entered.resolve(); await release.promise; return check(provider); });
	const pending = f.manager.configure(f.id, { model: `${testModel.provider}/${testModel.id}` });
	try {
		await assert.rejects(f.native.session.prompt("input after manager reservation"), /configuration/u);
		await assert.rejects(f.manager.configure(f.id, { name: "parallel" }), /idle owner/u);
		await entered.promise;
		for (const control of [() => f.manager.send(f.id, "hidden"), () => f.manager.attach(f.id), () => f.manager.attach(f.id, undefined, undefined, `${testModel.provider}/${testModel.id}`), () => f.manager.compact(f.id), () => f.manager.detach({ sessionId: f.id, prompt: "hidden" }, { cwd: f.cwd, model: testModel })]) {
			await assert.rejects(control(), /configuration/u);
		}
		release.resolve();
		assert.equal((await pending).outcome, "applied");
		assert.equal(f.requests.length, 0);
	} finally { release.resolve(); await pending; await f.close(); }
});

test("pending control, model repair, queued input, and shutdown refuse configuration without draining", { timeout: 5000 }, async (t) => {
	const entered = deferred(), release = deferred();
	const key = `configuration${randomUUID()}`;
	globals[key] = async () => { entered.resolve(); await release.promise; };
	const f = await managed(`export default pi => pi.registerCommand("hold", {handler: () => globalThis[${JSON.stringify(key)}]()});`);
	try {
		const control = f.manager.runCommand(f.id, "hold", "");
		await entered.promise;
		await assert.rejects(f.manager.configure(f.id, { name: "refused" }), /pending control/u);
		release.resolve(); await control;
		const authEntered = deferred(), authRelease = deferred();
		const check = f.native.services.modelRuntime.checkAuth.bind(f.native.services.modelRuntime);
		const auth = t.mock.method(f.native.services.modelRuntime, "checkAuth", async (provider: string) => { authEntered.resolve(); await authRelease.promise; return check(provider); });
		const repair = f.manager.attach(f.id, undefined, undefined, `${testModel.provider}/${testModel.id}`);
		try {
			await authEntered.promise;
			await assert.rejects(f.manager.configure(f.id, { name: "refused" }), /transfer/u);
		} finally { authRelease.resolve(); await repair; auth.mock.restore(); }
		await f.worker.steer("queued");
		await assert.rejects(f.manager.configure(f.id, { name: "refused" }), /idle session/u);
		assert.equal(f.worker.observation().pending, 1);
		await f.manager.closeAll();
		await assert.rejects(f.manager.configure(f.id, { name: "refused" }), /manager is closed/u);
		assert.equal(f.requests.length, 0);
	} finally { release.resolve(); delete globals[key]; await f.close(); }
});

test("configuration refuses self, primary, detached, and another local owner", async () => {
	const f = await managed();
	const otherStore = new AgentStore({ sessionsRoot: join(f.root, "other-sessions") });
	const other = new AgentManager(otherStore, f.runtime, new ProjectTrustStore(f.agentDir), undefined, f.agentDir);
	try {
		await assert.rejects(f.manager.configure(f.id, { name: "refused" }, undefined, undefined, f.id), /calling session/u);
		f.manager.registerPrimary("primary-target", f.cwd, () => undefined);
		await assert.rejects(f.manager.configure("primary-target", { name: "refused" }), /primary session/u);
		await assert.rejects(other.configure(f.id, { name: "refused" }), /session's owner/u);
		const runs = new DetachedRuns(f.store.root);
		const runId = randomUUID();
		runs.writeRequest({ runId, sessionId: f.id, sessionsRoot: f.store.root, agentDir: f.agentDir, cwd: f.cwd, prompt: "synthetic retained request", logFile: runs.logFile(runId), startedAt: new Date().toISOString(), pid: process.pid, launchState: "started" });
		await assert.rejects(f.manager.configure(f.id, { name: "refused" }), /detached sessions/u);
		assert.equal((await f.worker.status()).name, undefined);
		assert.equal(f.requests.length, 0);
	} finally { await other.closeAll(); await otherStore.close(); await f.close(); }
});

test("tool and slash configuration use native state and tool partial failures retain isError and details", async (t) => {
	const f = await managed();
	const previousSessions = process.env.PI_AGENT_SESSIONS_DIR, previousAgent = process.env.PI_AGENT_DIR;
	process.env.PI_AGENT_SESSIONS_DIR = f.store.root; process.env.PI_AGENT_DIR = f.agentDir;
	try {
		const tools = new Map<string, { execute: (...args: unknown[]) => Promise<unknown> }>();
		let command: Omit<RegisteredCommand, "name" | "sourceInfo"> | undefined;
		registerAgentExtension({
			registerTool: (tool: { name: string; execute: (...args: unknown[]) => Promise<unknown> }) => tools.set(tool.name, tool),
			registerMessageRenderer() {}, registerShortcut() {}, on() {},
			registerCommand: (name: string, value: typeof command) => { if (name === "agent") command = value; },
		} as unknown as ExtensionAPI);
		const tool = tools.get("agent_configure"); assert.ok(tool); assert.ok(command);
		const notices: string[] = [];
		const parent = SessionManager.inMemory(f.cwd);
		f.manager.bindAssociationParent({ sessionId: parent.getSessionId(), entries: () => parent.getEntries(), append: (entry) => { parent.appendCustomEntry(ASSOCIATION_ENTRY, entry); } });
		const ctx = { cwd: f.cwd, mode: "print", hasUI: false, sessionManager: parent, ui: { notify: (text: string) => notices.push(text) } } as unknown as ExtensionCommandContext;
		interface Result { isError?: boolean; content: Array<{ type: string; text: string }>; details: { configuration: ConfigurationResult } }
		const result = await tool.execute("configure", { sessionId: f.id, name: "Tool name" }, undefined, undefined, ctx) as Result;
		assert.equal(result.details.configuration.outcome, "applied");
		assert.equal(result.isError, undefined);
		assert.equal(result.details.configuration.after.name, "Tool name");
		await command.handler(`configure ${f.id} thinking high`, ctx);
		assert.equal((JSON.parse(notices.at(-1) ?? "") as ConfigurationResult).after.thinkingLevel, "high");
		await command.handler(`configure ${f.id} name`, ctx);
		assert.equal((JSON.parse(notices.at(-1) ?? "") as ConfigurationResult).after.name, "");
		const append = f.worker.sessionManager().appendModelChange.bind(f.worker.sessionManager());
		const fault = t.mock.method(f.worker.sessionManager(), "appendModelChange", (provider: string, model: string) => { append(provider, model); throw new Error("synthetic private diagnostic"); });
		const failed = await tool.execute("failure", { sessionId: f.id, name: "not reached", model: `${testModel.provider}/${testModel.id}`, thinkingLevel: "low" }, undefined, undefined, ctx) as Result;
		assert.equal(failed.isError, true);
		assert.equal(failed.details.configuration.outcome, "failed");
		assert.equal(failed.details.configuration.persistence.nativeWrites, "uncertain");
		assert.equal(failed.details.configuration.after.name, "");
		assert.deepEqual(JSON.parse(failed.content[0].text), failed.details.configuration);
		fault.mock.restore();
		assert.equal(f.requests.length, 0);
	} finally {
		if (previousSessions === undefined) delete process.env.PI_AGENT_SESSIONS_DIR; else process.env.PI_AGENT_SESSIONS_DIR = previousSessions;
		if (previousAgent === undefined) delete process.env.PI_AGENT_DIR; else process.env.PI_AGENT_DIR = previousAgent;
		await f.close();
	}
});

test("native configuration dialogs keep drafts local, validate fields, and preserve Apply and Cancel", async () => {
	const f = await managed();
	try {
		const snapshot = (await f.manager.sessionSummaries()).find((row) => row.sessionId === f.id); assert.ok(snapshot);
		const selections = ["Apply", "Model", "Name", "Reasoning", "high", "Apply"];
		const inputs = ["not-exact", "Dialog name"];
		const notices: string[] = [];
		const ctx = { ui: { select: async () => selections.shift(), input: async () => inputs.shift(), notify: (text: string) => notices.push(text) } } as unknown as ExtensionCommandContext;
		const before = f.worker.sessionManager().getEntries();
		const patch = await configurationDialog(snapshot, ctx);
		assert.deepEqual(patch, { name: "Dialog name", thinkingLevel: "high" });
		assert.deepEqual(f.worker.sessionManager().getEntries(), before);
		assert.equal(notices.length, 2);
		assert.ok(patch);
		const result = await f.manager.configure(f.id, patch);
		assert.equal(result.after.name, "Dialog name");
		assert.equal(result.after.thinkingLevel, "high");
		selections.push("Name", "Cancel"); inputs.push("Discarded name");
		assert.equal(await configurationDialog(snapshot, ctx), undefined);
		assert.equal((await f.worker.status()).name, "Dialog name");
		assert.equal(f.requests.length, 0);
	} finally { await f.close(); }
});
