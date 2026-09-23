import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/pi-agent-core";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { ModelRuntime, ProjectTrustStore } from "@earendil-works/pi-coding-agent";
import { createDetachedControlServer } from "./detached-control.ts";
import { DetachedRuns, type DetachedRunRequest } from "./detached.ts";
import { AgentManager } from "./index.ts";
import { AgentStore } from "./store.ts";
import type { AgentWorkerSession, WorkerStatus } from "./worker.ts";

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => { resolve = done; });
	return { promise, resolve };
}

async function fixture(inspect?: () => Promise<void>) {
	const root = mkdtempSync(join(tmpdir(), "agent-control-manager-"));
	const cwd = join(root, "work");
	const agentDir = join(root, "agent");
	mkdirSync(cwd); mkdirSync(agentDir);
	const store = new AgentStore({ sessionsRoot: join(root, "sessions") });
	const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, modelsStorePath: join(root, "models-store.json"), refreshOnCreate: false });
	const manager = new AgentManager(store, modelRuntime, new ProjectTrustStore(agentDir), undefined, agentDir);
	const runId = randomUUID();
	const runs = new DetachedRuns(store.root);
	const request: DetachedRunRequest = { runId, sessionId: randomUUID(), sessionsRoot: store.root, agentDir, cwd, prompt: "work", logFile: runs.logFile(runId), startedAt: new Date().toISOString(), pid: process.pid, launchState: "started" };
	runs.writeRequest(request);
	const calls: string[] = [];
	const status: WorkerStatus = { sessionId: request.sessionId, cwd, tipId: "tip", model: { provider: "synthetic", modelId: "test", thinkingLevel: "off" }, operation: "operation", tools: ["read"], activeTools: ["read"], extensions: [], entryCount: 3 };
	const worker = {
		status: async () => { calls.push("status"); return status; },
		inspect: async (options: Parameters<AgentWorkerSession["inspect"]>[0]) => {
			calls.push("inspect"); await inspect?.();
			return { sessionId: request.sessionId, entries: [], nextCursor: null, options } as unknown as Awaited<ReturnType<AgentWorkerSession["inspect"]>>;
		},
		steer: async (text: string) => { calls.push(`steer:${text}`); },
		compact: async () => { calls.push("compact"); return { summary: "native", firstKeptEntryId: "tip", tokensBefore: 10 }; },
		runCommand: async () => { calls.push("command"); return { text: "done", sessionId: "replacement" }; },
	};
	const server = await createDetachedControlServer({ request, metadata: { id: request.sessionId, cwd: root, path: join(root, "session.jsonl"), createdAt: 1, modifiedAt: 1 }, worker, canSteer: () => true, requestAbort: () => { calls.push("abort"); return true; } });
	return { root, store, manager, request, runs, calls, server, close: async () => {
		await server.close(); await manager.closeAll(); await store.close(BACKGROUND_CONTEXT); rmSync(root, { recursive: true, force: true });
	} };
}

test("manager controls reach the detached owner without a second session open", { timeout: 20_000 }, async (t) => {
	const f = await fixture();
	try {
		const open = t.mock.method(f.store, "open", async () => { throw new Error("a second writer is forbidden"); });
		const list = t.mock.method(f.store, "list", async () => { throw new Error("local session discovery is forbidden"); });
		assert.match(await f.manager.status(f.request.sessionId), /detached owner status/u);
		assert.deepEqual(await f.manager.inspect(f.request.sessionId, { limit: 2 }), { sessionId: f.request.sessionId, entries: [], nextCursor: null, options: { limit: 2 } });
		assert.match(await f.manager.steer(f.request.sessionId, "new direction"), /Queue admission does not confirm delivery/u);
		assert.match(await f.manager.abort(f.request.sessionId), /abort requested/u);
		assert.match(await f.manager.compact(f.request.sessionId), /native/u);
		assert.equal((await f.manager.runCommand(f.request.sessionId, "replace", "")).sessionId, "replacement");
		assert.deepEqual(f.calls, ["status", "inspect", "steer:new direction", "abort", "compact", "command"]);
		assert.equal(open.mock.callCount(), 0); assert.equal(list.mock.callCount(), 0);
		await assert.rejects(f.manager.attach(f.request.sessionId), /running detached/u);
		await assert.rejects(f.manager.send(f.request.sessionId, "another task"), /running detached/u);
	} finally { await f.close(); }
});

test("an unavailable endpoint reports recorded status and never retries a mutation locally", { timeout: 20_000 }, async (t) => {
	const f = await fixture();
	try {
		await f.server.close();
		const open = t.mock.method(f.store, "open", async () => { throw new Error("local fallback is forbidden"); });
		const text = await f.manager.status(f.request.sessionId);
		assert.match(text, /live control unavailable/u);
		assert.match(text, /recorded observation, not live owner status/u);
		await assert.rejects(f.manager.steer(f.request.sessionId, "do not replay"));
		await assert.rejects(f.manager.abort(f.request.sessionId));
		await assert.rejects(f.manager.inspect(f.request.sessionId));
		assert.equal(open.mock.callCount(), 0);
		assert.deepEqual(f.calls, []);
	} finally { await f.close(); }
});

test("manager close drains remote calls and excludes later calls", { timeout: 20_000 }, async () => {
	const entered = deferred();
	const release = deferred();
	const f = await fixture(async () => { entered.resolve(); await release.promise; });
	try {
		const inspect = f.manager.inspect(f.request.sessionId);
		await entered.promise;
		let closed = false;
		const close = f.manager.closeAll().then(() => { closed = true; });
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.equal(closed, false);
		await assert.rejects(f.manager.steer(f.request.sessionId, "late"), /manager is closed/u);
		await assert.rejects(f.manager.status(f.request.sessionId), /manager is closed/u);
		release.resolve();
		await inspect; await close;
		assert.equal(closed, true);
	} finally { release.resolve(); await f.close(); }
});

test("caller cancellation does not request a detached run abort", { timeout: 20_000 }, async () => {
	const entered = deferred();
	const release = deferred();
	const f = await fixture(async () => { entered.resolve(); await release.promise; });
	try {
		const controller = new AbortController();
		const inspect = f.manager.inspect(f.request.sessionId, {}, controller.signal);
		await entered.promise;
		controller.abort(new Error("caller left"));
		await assert.rejects(inspect);
		assert.deepEqual(f.calls, ["inspect"]);
		release.resolve();
		assert.match(await f.manager.status(f.request.sessionId), /operation=operation/u);
	} finally { release.resolve(); await f.close(); }
});
