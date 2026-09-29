import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { ProjectTrustStore, SessionManager, type AgentSessionRuntime } from "@earendil-works/pi-coding-agent";
import { ASSOCIATION_ENTRY, associatedSessions } from "./associations.ts";
import { DetachedRuns } from "./detached.ts";
import { AgentManager } from "./index.ts";
import { fixture } from "./native-fixture.mts";
import type { AgentWorkerSession } from "./worker.ts";

function deferred() { let resolve!: () => void; const promise = new Promise<void>((done) => { resolve = done; }); return { promise, resolve }; }
function held(manager: AgentManager, id: string) {
	const worker = (manager as unknown as { sessions: Map<string, AgentWorkerSession> }).sessions.get(id);
	assert.ok(worker);
	return worker;
}
function native(worker: AgentWorkerSession) { return (worker as unknown as { runtime: AgentSessionRuntime }).runtime; }
async function managed(t: TestContext, minutes?: string) {
	const f = await fixture();
	const id = f.worker.sessionId();
	await f.worker.close();
	const previous = process.env.PI_AGENT_IDLE_MINUTES;
	if (minutes === undefined) delete process.env.PI_AGENT_IDLE_MINUTES; else process.env.PI_AGENT_IDLE_MINUTES = minutes;
	let manager: AgentManager;
	try { manager = new AgentManager(f.store, f.runtime, new ProjectTrustStore(f.agentDir), undefined, f.agentDir); }
	finally { if (previous === undefined) delete process.env.PI_AGENT_IDLE_MINUTES; else process.env.PI_AGENT_IDLE_MINUTES = previous; }
	t.mock.timers.enable({ apis: ["setTimeout"] });
	t.after(async () => { await manager.closeAll(); t.mock.timers.reset(); await f.close(); });
	return { ...f, id, manager };
}
function expire(t: TestContext, worker: AgentWorkerSession) {
	t.mock.timers.tick(300_000);
	assert.equal(worker.unavailableState(), "stopping", "the idle timer starts cleanup synchronously");
	return worker.close();
}

test("idle release preserves saved history, ownership, and exactly-once footer spend on send reopen", { timeout: 10000 }, async (t) => {
	const f = await managed(t);
	const parent = SessionManager.create(f.cwd, f.store.nativeRoot);
	const parentId = parent.getSessionId();
	const statuses: Array<string | undefined> = [];
	f.manager.registerPrimary(parentId, f.cwd, () => {}, (text) => statuses.push(text));
	f.manager.bindAssociationParent({ sessionId: parentId, entries: () => parent.getEntries(), append: (entry) => { parent.appendCustomEntry(ASSOCIATION_ENTRY, entry); } });
	await f.manager.withAssociationParent(parentId, () => f.manager.attach(f.id));
	const first = held(f.manager, f.id);
	await f.manager.send(f.id, "retain this first task");
	await first.waitForIdle();
	const saved = first.sessionManager();
	const historyIds = saved.getEntries().map((entry) => entry.id);
	saved.appendUsage("test", "agent-test", "model", { input: 1, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 1, cost: { input: 0.25, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.25 } });
	const claim = join(f.store.nativeRoot, ".claims", readdirSync(join(f.store.nativeRoot, ".claims"))[0]);
	assert.equal(existsSync(claim), true);
	t.mock.timers.tick(299_999);
	assert.equal(first.unavailableState(), undefined);
	t.mock.timers.tick(1);
	assert.equal(first.unavailableState(), "stopping");
	await first.close();
	assert.equal(first.isTerminal(), true);
	assert.equal(existsSync(claim), false);
	const savedFile = saved.getSessionFile();
	assert.ok(savedFile);
	assert.equal(existsSync(savedFile), true);
	assert.equal(associatedSessions(parent.getEntries(), parentId, f.store.root).has(f.id), true);
	assert.equal(statuses.at(-1), "agents 0 · $0.25");
	assert.match(await f.manager.status(f.id), /read-only capture/u);
	await f.manager.withAssociationParent(parentId, () => f.manager.send(f.id, "continue retained history"));
	const reopened = held(f.manager, f.id);
	assert.notEqual(reopened, first);
	await reopened.waitForIdle();
	assert.deepEqual(reopened.sessionManager().getEntries().slice(0, historyIds.length).map((entry) => entry.id), historyIds);
	assert.equal(associatedSessions(parent.getEntries(), parentId, f.store.root).has(f.id), true);
	assert.equal(statuses.at(-1), "agents 0 · $0.25");
	await expire(t, reopened);
	await reopened.close();
	assert.equal(statuses.at(-1), "agents 0 · $0.25");
	assert.deepEqual(f.manager.restartState().busy, []);
	assert.deepEqual(f.manager.restartState().unsaved, []);
});

test("active work and queued native input postpone idle release for a full new window", { timeout: 10000 }, async (t) => {
	const f = await managed(t);
	await f.manager.attach(f.id);
	const worker = held(f.manager, f.id);
	const entered = deferred(), release = deferred();
	const runner = native(worker).session.extensionRunner;
	const beforeStart = runner.emitBeforeAgentStart.bind(runner);
	const auth = t.mock.method(runner, "emitBeforeAgentStart", async (...args: Parameters<typeof beforeStart>) => { entered.resolve(); await release.promise; return beforeStart(...args); });
	const start = f.manager.send(f.id, "active input preparation");
	try {
		await entered.promise;
		t.mock.timers.tick(600_000);
		assert.equal(worker.unavailableState(), undefined);
		assert.equal(worker.hasActiveWork(), true);
	} finally { release.resolve(); await start; auth.mock.restore(); }
	await worker.waitForIdle();
	await worker.steer("queued input");
	t.mock.timers.tick(600_000);
	assert.equal(worker.unavailableState(), undefined);
	assert.equal(worker.observation().pending, 1);
	native(worker).session.clearQueue();
	t.mock.timers.tick(299_999);
	assert.equal(worker.unavailableState(), undefined);
	t.mock.timers.tick(1);
	assert.equal(worker.unavailableState(), "stopping");
	await worker.close();
});

test("pending owner notices retain an idle host until native message admission succeeds", { timeout: 10000 }, async (t) => {
	const f = await managed(t);
	await f.manager.attach(f.id);
	const owner = held(f.manager, f.id);
	const notices = (f.manager as unknown as { ownerNotices: Map<string, Map<string, unknown>> }).ownerNotices;
	const delivery = t.mock.method(owner, "deliverCustomMessage", async () => { throw new Error("admission unavailable"); });
	const child = await f.manager.withAssociationParent(f.id, () => f.manager.spawn({ cwd: f.cwd }, { cwd: f.cwd, model: { provider: "agent-test", id: "model" } }));
	const childWorker = held(f.manager, child.sessionId);
	await f.manager.send(child.sessionId, "child result");
	await childWorker.waitForIdle();
	assert.equal(notices.get(f.id)?.size, 1);
	t.mock.timers.tick(600_000);
	assert.equal(owner.unavailableState(), undefined);
	assert.equal(notices.get(f.id)?.size, 1);
	delivery.mock.restore();
	// A native queue event retries the held notice through the manager's normal update path.
	const admitted = deferred();
	owner.observe((event) => { if (event.type === "agent_settled") admitted.resolve(); });
	native(owner).session.clearQueue();
	await admitted.promise;
	await owner.waitForIdle();
	assert.equal(notices.has(f.id), false);
	await expire(t, owner);
});

test("owned child hosts retain idle parents and release before the parent window starts", { timeout: 10000 }, async (t) => {
	const f = await managed(t);
	const notices: string[] = [];
	f.manager.registerPrimary("primary", f.cwd, (content) => notices.push(content));
	await f.manager.attach(f.id);
	const parent = held(f.manager, f.id);
	const child = await f.manager.withAssociationParent(f.id, () => f.manager.spawn({ cwd: f.cwd }, { cwd: f.cwd, model: { provider: "agent-test", id: "model" } }));
	const worker = held(f.manager, child.sessionId);
	const entered = deferred(), release = deferred(), parentSettled = deferred();
	parent.observe((event) => { if (event.type === "agent_settled") parentSettled.resolve(); });
	const runner = native(worker).session.extensionRunner;
	const beforeStart = runner.emitBeforeAgentStart.bind(runner);
	const hook = t.mock.method(runner, "emitBeforeAgentStart", async (...args: Parameters<typeof beforeStart>) => { entered.resolve(); await release.promise; return beforeStart(...args); });
	const start = f.manager.send(child.sessionId, "child work");
	try {
		await entered.promise;
		t.mock.timers.tick(600_000);
		assert.equal(parent.unavailableState(), undefined);
		assert.equal(worker.unavailableState(), undefined);
	} finally { release.resolve(); await start; hook.mock.restore(); }
	await worker.waitForIdle();
	await parentSettled.promise;
	await parent.waitForIdle();
	assert.equal(notices.some((content) => content.startsWith(`Agent session ${child.sessionId} `)), false, "the child result reached its managed owner");
	notices.length = 0;
	await expire(t, worker);
	assert.equal(parent.unavailableState(), undefined, "an open idle child also retains its parent");
	t.mock.timers.tick(299_999);
	assert.equal(parent.unavailableState(), undefined);
	t.mock.timers.tick(1);
	assert.equal(parent.unavailableState(), "stopping");
	await parent.close();
	await f.manager.send(child.sessionId, "explicit work after owner release");
	await held(f.manager, child.sessionId).waitForIdle();
	assert.equal(notices.length, 1);
	assert.match(notices[0], /no live owning session/iu);
});

test("pending control and open configuration exclude idle release", { timeout: 10000 }, async (t) => {
	const f = await managed(t);
	await f.manager.attach(f.id);
	const worker = held(f.manager, f.id);
	const entered = deferred(), release = deferred();
	const check = native(worker).services.modelRuntime.checkAuth.bind(native(worker).services.modelRuntime);
	t.mock.method(native(worker).services.modelRuntime, "checkAuth", async (provider: string) => { entered.resolve(); await release.promise; return check(provider); });
	const configuration = f.manager.configure(f.id, { model: "agent-test/model" });
	try {
		await entered.promise;
		t.mock.timers.tick(600_000);
		assert.equal(worker.unavailableState(), undefined);
		assert.ok(f.manager.restartState().busy.includes(f.id));
	} finally { release.resolve(); await configuration; }
	await expire(t, worker);
});

test("zero disables idle release", { timeout: 10000 }, async (t) => {
	const f = await managed(t, "0");
	await f.manager.attach(f.id);
	const worker = held(f.manager, f.id);
	t.mock.timers.tick(10_000_000);
	assert.equal(worker.unavailableState(), undefined);
	assert.equal(readdirSync(join(f.store.nativeRoot, ".claims")).length, 1);
});

test("a detached owner stays open while idle under the default window", { timeout: 10000 }, async (t) => {
	const f = await managed(t);
	const runs = new DetachedRuns(f.store.root);
	const runId = "idle-detached-owner";
	runs.writeRequest({ runId, sessionId: f.id, sessionsRoot: f.store.root, agentDir: f.agentDir, cwd: f.cwd, prompt: "detached task", logFile: runs.logFile(runId), startedAt: new Date().toISOString(), pid: process.pid, launchState: "started" });
	const worker = await f.manager.openDetachedRun(runId, f.id);
	t.mock.timers.tick(600_000);
	assert.equal(worker.unavailableState(), undefined);
});

test("stored steer refuses after idle release while attach and place reopen without work", { timeout: 10000 }, async (t) => {
	const f = await managed(t);
	await f.manager.place(f.cwd, {}, undefined, { model: { provider: "agent-test", id: "model" } });
	const id = (await f.manager.listSessions()).find((candidate) => candidate !== f.id);
	assert.ok(id);
	await expire(t, held(f.manager, id));
	await assert.rejects(f.manager.steer(id, "no hidden task"), /use agent send/u);
	assert.match(await f.manager.status(id), /read-only capture/u);
	await f.manager.attach(id);
	assert.equal(held(f.manager, id).hasActiveWork(), false);
	await expire(t, held(f.manager, id));
	assert.match(await f.manager.place(f.cwd), new RegExp(id));
	assert.equal(held(f.manager, id).hasActiveWork(), false);
});

test("native Bash activity resets the idle window without a model operation", { timeout: 10000 }, async (t) => {
	const f = await managed(t);
	await f.manager.attach(f.id);
	const worker = held(f.manager, f.id);
	t.mock.timers.tick(299_999);
	const release = deferred();
	const task = native(worker).session.executeBash("controlled command", undefined, { operations: { exec: async () => { await release.promise; return { exitCode: 0 }; } } });
	t.mock.timers.tick(600_000);
	assert.equal(worker.unavailableState(), undefined);
	assert.equal(worker.hasActiveWork(), true);
	release.resolve(); await task;
	t.mock.timers.tick(299_999);
	assert.equal(worker.unavailableState(), undefined);
	t.mock.timers.tick(1);
	assert.equal(worker.unavailableState(), "stopping");
	await worker.close();
});
