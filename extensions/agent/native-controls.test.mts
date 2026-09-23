import assert from "node:assert/strict";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { ModelRegistry, ModelRuntime, ProjectTrustStore } from "@earendil-works/pi-coding-agent";
import { AgentManager, inheritProviders } from "./index.ts";
import { fixture } from "./native-fixture.mts";
import { createTestRuntime, testModel } from "./test-runtime.mts";
import { AgentWorkerSession } from "./worker.ts";
import { randomUUID } from "node:crypto";
import { createDetachedControlServer, withDetachedControl } from "./detached-control.ts";
import { DetachedRuns } from "./detached.ts";
import { defined } from "./test-assertions.mts";

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => { resolve = done; });
	return { promise, resolve };
}

test("abort during native preflight blocks provider work and concurrent peer admission", async () => {
	const f = await fixture();
	const entered = deferred(), release = deferred();
	const key = `agentPreflight${Date.now()}`;
	const globals = globalThis as unknown as Record<string, unknown>;
	globals[key] = async () => { entered.resolve(); await release.promise; };
	try {
		writeFileSync(f.path, `export default pi => pi.on("before_agent_start", () => globalThis[${JSON.stringify(key)}]());`);
		await f.worker.reload();
		const start = f.worker.start("cancel before request");
		const rejected = assert.rejects(start, /aborted during preflight/u);
		await entered.promise;
		await assert.rejects(f.worker.start("second"), /active work/u);
		await assert.rejects(f.worker.deliverCustomMessage({ customType: "peer", content: "parallel", display: true }, { triggerTurn: true }), /preflight/u);
		const abort = f.worker.abort();
		release.resolve();
		await rejected;
		assert.equal(await abort, true);
		assert.equal(f.requests.length, 0);
		assert.equal((await f.worker.status()).operation, null);
		const outcome = f.worker.sessionManager().getEntries().findLast((entry) => entry.type === "custom" && entry.customType === "agent.result");
		assert.ok(outcome?.type === "custom");
		assert.equal((outcome.data as { status: string }).status, "aborted");
	} finally { release.resolve(); delete globals[key]; await f.close(); }
});

test("preflight rejection reaches the caller and produces one failed result", async (t) => {
	const f = await fixture();
	try {
		t.mock.method(ModelRuntime.prototype, "hasConfiguredAuth", () => false);
		t.mock.method(ModelRuntime.prototype, "checkAuth", async () => undefined);
		await assert.rejects(f.worker.start("unavailable auth"), /Authentication|API key/u);
		await f.worker.waitForIdle();
		assert.equal(f.requests.length, 0);
		const results = f.worker.sessionManager().getEntries().filter((entry) => entry.type === "custom" && entry.customType === "agent.result");
		assert.equal(results.length, 1);
		assert.equal((results[0] as { data: { status: string } }).data.status, "failed");
	} finally { await f.close(); }
});

test("native setup model selection and preloaded context persist through reopen", async () => {
	const f = await fixture();
	try {
		await f.worker.close();
		const provider = defined(f.runtime.getRegisteredNativeProvider(testModel.provider));
		f.runtime.registerNativeProvider({ ...provider, getModels: () => [testModel, { ...testModel, id: "setup-model" }] });
		const worker = await AgentWorkerSession.create({ ...f.options, setup: async (manager) => {
			manager.appendMessage({ role: "user", content: "setup context", timestamp: 1 });
			manager.appendModelChange(testModel.provider, "setup-model");
		} });
		const metadata = worker.sessionMetadata();
		assert.equal((await worker.status()).model.modelId, "setup-model");
		await worker.close();
		const reopened = await AgentWorkerSession.open(metadata, { ...f.options, model: undefined });
		assert.equal((await reopened.status()).model.modelId, "setup-model");
		assert.equal(f.requests.length, 0);
		await reopened.close();
	} finally { await f.close(); }
});

test("native tool declarations retain an empty loadout on reopen", async () => {
	const f = await fixture();
	try {
		await f.worker.setActiveToolsAction([]);
		await f.worker.start("declare empty tools");
		await f.worker.waitForIdle();
		const metadata = f.worker.sessionMetadata();
		await f.worker.close();
		const reopened = await AgentWorkerSession.open(metadata, { ...f.options, model: undefined });
		assert.deepEqual((await reopened.status()).activeTools, []);
		await reopened.close();
	} finally { await f.close(); }
});

test("public primary registry registrations retain native provider functions", async () => {
	const f = await fixture();
	try {
		const target = await createTestRuntime();
		inheritProviders(target, new ModelRegistry(f.runtime));
		assert.equal(target.getRegisteredNativeProvider(testModel.provider), f.runtime.getRegisteredNativeProvider(testModel.provider));
		const worker = await AgentWorkerSession.create({ ...f.options, modelRuntime: target });
		await worker.start("copied provider"); await worker.waitForIdle();
		assert.equal(f.requests.length, 1);
		await worker.close();
	} finally { await f.close(); }
});

test("model repair refuses an admitted active host without changing its model", { timeout: 5000 }, async () => {
	const key = `agentRepair${Date.now()}`;
	const f = await fixture(`export default pi => pi.on("before_agent_start", () => globalThis[${JSON.stringify(key)}]());`);
	const entered = deferred(), release = deferred();
	const globals = globalThis as unknown as Record<string, unknown>;
	globals[key] = async () => { entered.resolve(); await release.promise; };
	const manager = new AgentManager(f.store, f.runtime, new ProjectTrustStore(f.agentDir), undefined, f.agentDir);
	try {
		await f.worker.close();
		const created = await manager.spawn({ cwd: f.cwd }, { cwd: f.cwd, model: testModel }, undefined, { extensionPaths: [f.path] });
		const run = manager.send(created.sessionId, "task");
		await entered.promise;
		// Repair waits for admitted controls, then refuses the still-active run.
		release.resolve(); await run;
		const held = defined((manager as unknown as { sessions: Map<string, AgentWorkerSession> }).sessions.get(created.sessionId));
		const original = held.status.bind(held);
		const old = await original();
		held.status = async () => ({ ...old, operation: "active" });
		await assert.rejects(manager.attach(created.sessionId, undefined, undefined, `${testModel.provider}/${testModel.id}`), /idle session/u);
		held.status = original;
		await held.waitForIdle();
	} finally { release.resolve(); delete globals[key]; await manager.closeAll(); await f.close(); }
});

test("failed native replacement releases both claims and leaves the host closed", async () => {
	const f = await fixture(`export default pi => pi.registerCommand("replace", { handler: async (_args, ctx) => ctx.newSession({ setup: async () => { throw new Error("replacement setup failed"); } }) });`);
	try {
		const old = f.worker.sessionMetadata();
		await assert.rejects(f.worker.runCommand("replace", ""), /replacement setup failed/u);
		await assert.rejects(f.worker.status(), /host is closed/u);
		assert.deepEqual(readdirSync(join(f.store.nativeRoot, ".claims")), []);
		assert.ok(readFileSync(old.path, "utf8").includes(old.id));
	} finally { await f.close(); }
});

test("current header checks reject malformed, oversized, and retired headers without changing files", async () => {
	const f = await fixture();
	try {
		const metadata = f.worker.sessionMetadata();
		await f.worker.close();
		for (const body of ["null\n", `${"x".repeat(20000)}\n`, `${JSON.stringify({ type: "session", version: 2, id: metadata.id, cwd: f.cwd, timestamp: new Date().toISOString() })}\n`]) {
			writeFileSync(metadata.path, body);
			await assert.rejects(f.store.open(metadata));
			assert.equal(readFileSync(metadata.path, "utf8"), body);
			assert.deepEqual(await f.store.list(), []);
			assert.equal(readFileSync(metadata.path, "utf8"), body);
		}
	} finally { await f.close(); }
});

test("real owner transport follows native replacement through both route and current IDs", async (t) => {
	const f = await fixture(`export default pi => pi.registerCommand("replace", { handler: async (_args, ctx) => ctx.newSession() });`);
	const runs = new DetachedRuns(f.store.root);
	const route = f.worker.sessionId();
	const runId = randomUUID();
	const request = { runId, sessionId: route, sessionsRoot: f.store.root, agentDir: f.agentDir, cwd: f.cwd, prompt: "work", logFile: runs.logFile(runId), startedAt: new Date().toISOString(), pid: process.pid, launchState: "started" as const };
	runs.writeRequest(request);
	f.worker.setOnUpdate((update) => {
		if (update.kind === "replaced") runs.writeProgress({ runId, currentSessionId: update.sessionId, entryCount: 0, updatedAt: new Date().toISOString() });
	});
	const server = await createDetachedControlServer({ request, metadata: f.worker.sessionMetadata(), worker: f.worker, canSteer: () => true, requestAbort: () => f.worker.abort() });
	const manager = new AgentManager(f.store, f.runtime, new ProjectTrustStore(f.agentDir), undefined, f.agentDir);
	try {
		const open = t.mock.method(f.store, "open", async () => { throw new Error("second writer forbidden"); });
		const replaced = await withDetachedControl(request, (control) => control.command("replace", ""));
		assert.ok(replaced.sessionId && replaced.sessionId !== route);
		assert.equal((await withDetachedControl(request, (control) => control.inspect())).sessionId, replaced.sessionId);
		assert.equal((await withDetachedControl(request, (control) => control.status())).sessionId, replaced.sessionId);
		assert.match(await manager.status(replaced.sessionId), new RegExp(replaced.sessionId));
		assert.match(await manager.status(route), new RegExp(replaced.sessionId));
		assert.equal(open.mock.callCount(), 0);
		assert.equal(readdirSync(join(f.store.nativeRoot, ".claims")).length, 1);
	} finally { await server.close(); await manager.closeAll(); await f.close(); }
});

test("cwd provider registrations stay isolated and resolve before model selection", async () => {
	const f = await fixture();
	const manager = new AgentManager(f.store, f.runtime, new ProjectTrustStore(f.agentDir), undefined, f.agentDir);
	try {
		await f.worker.close();
		const ids: string[] = [];
		for (const label of ["first", "second"]) {
			const cwd = join(f.root, label); mkdirSync(join(cwd, ".pi", "extensions"), { recursive: true });
			writeFileSync(join(cwd, ".pi", "extensions", "provider.ts"), `export default pi => pi.registerProvider("cwd-provider", {
				baseUrl: "https://example.invalid", apiKey: "synthetic", api: "openai-completions",
				models: [{ id: "model", name: "Test", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 4096, maxTokens: 128 }],
				streamSimple: () => { throw new Error(${JSON.stringify(`${label}-provider`)}); }
			});`);
			ids.push((await manager.spawn({ cwd, model: "cwd-provider/model", trust: true }, { cwd, model: null })).sessionId);
		}
		for (const [index, id] of ids.entries()) {
			const worker = defined((manager as unknown as { sessions: Map<string, AgentWorkerSession> }).sessions.get(id));
			const operation = await worker.start("provider isolation"); await worker.waitForIdle();
			assert.match((await worker.operationResult(defined(operation)))?.error?.message ?? "", new RegExp(index === 0 ? "first-provider" : "second-provider"));
		}
		assert.equal(f.runtime.getModel("cwd-provider", "model"), undefined);
	} finally { await manager.closeAll(); await f.close(); }
});

test("command-started native preflight remains owned through close", { timeout: 5000 }, async () => {
	const key = `agentCommand${Date.now()}`;
	const entered = deferred(), release = deferred();
	const globals = globalThis as unknown as Record<string, unknown>;
	globals[key] = async () => { entered.resolve(); await release.promise; };
	const f = await fixture(`export default pi => {
		pi.on("before_agent_start", () => globalThis[${JSON.stringify(key)}]());
		pi.registerCommand("launch", { handler: () => { pi.sendUserMessage("native task"); } });
	}`);
	try {
		await f.worker.runCommand("launch", ""); await entered.promise;
		assert.equal(f.worker.hasPendingHostWork(), true);
		await assert.rejects(f.worker.start("competing task"), /active work/u);
		const closed = f.worker.close(); release.resolve(); await closed;
		assert.equal(f.requests.length, 0);
		assert.deepEqual(readdirSync(join(f.store.nativeRoot, ".claims")), []);
	} finally { release.resolve(); delete globals[key]; await f.close(); }
});

test("manager shutdown retains a failed owner's writer claim", async (t) => {
	const f = await fixture();
	const manager = new AgentManager(f.store, f.runtime, new ProjectTrustStore(f.agentDir), undefined, f.agentDir);
	let worker: AgentWorkerSession | undefined;
	let close: (() => Promise<void>) | undefined;
	try {
		await f.worker.close();
		manager.registerPrimary("primary", f.cwd, () => undefined);
		const created = await manager.spawn({ cwd: f.cwd }, { cwd: f.cwd, model: testModel });
		worker = defined((manager as unknown as { sessions: Map<string, AgentWorkerSession> }).sessions.get(created.sessionId));
		close = worker.close.bind(worker);
		t.mock.method(worker, "close", async () => { throw new Error("abort cleanup failed"); });
		await assert.rejects(manager.unregisterPrimary("primary"), /cleanup failed/u);
		await assert.rejects(f.store.open(worker.sessionMetadata()), /exclusive writer claim/u);
	} finally { await close?.(); await f.close(); }
});

test("completion notification failure preserves the native stored outcome", async () => {
	const f = await fixture();
	try {
		f.worker.setOnUpdate((update) => { if (update.kind === "settled") throw new Error("notification failed"); });
		const id = defined(await f.worker.start("task")); await f.worker.waitForIdle();
		assert.equal((await f.worker.operationResult(id))?.status, "completed");
		assert.match(f.worker.lastErrorMessage() ?? "", /notification failed/u);
	} finally { await f.close(); }
});

test("primary runtime authentication resolves afresh without a credential snapshot", async () => {
	const f = await fixture();
	try {
		const provider = defined(f.runtime.getRegisteredNativeProvider(testModel.provider));
		f.runtime.registerNativeProvider({ ...provider, auth: { apiKey: { name: "Synthetic", check: async ({ credential }) => credential?.key ? { type: "api_key" } : undefined, resolve: async ({ credential }) => credential?.key ? { auth: { apiKey: credential.key } } : undefined } } });
		await f.runtime.setRuntimeApiKey(testModel.provider, "synthetic-first");
		const target = await createTestRuntime();
		inheritProviders(target, new ModelRegistry(f.runtime), testModel.provider);
		assert.equal((await target.getAuth(testModel.provider))?.auth.apiKey, "synthetic-first");
		await f.runtime.setRuntimeApiKey(testModel.provider, "synthetic-second");
		assert.equal((await target.getAuth(testModel.provider))?.auth.apiKey, "synthetic-second");
		assert.doesNotMatch(readFileSync(f.worker.sessionMetadata().path, "utf8"), /synthetic-first|synthetic-second/u);
	} finally { await f.close(); }
});
