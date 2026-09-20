import { createTestRuntime } from "./test-runtime.mts";
import assert from "node:assert/strict";
import { defined } from "./test-assertions.mts";
import { existsSync, mkdirSync, mkdtempSync, rmSync, type FSWatcher } from "node:fs";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, type TestContext } from "node:test";
import { BACKGROUND_CONTEXT, type Context, withAbortSignal } from "@earendil-works/pi-agent-core";
import { type ExtensionAPI, type ExtensionCommandContext, type RegisteredCommand, type ModelRuntime, ProjectTrustStore } from "@earendil-works/pi-coding-agent";
import { DetachedRuns, formatRun } from "./detached.ts";
import registerAgentExtension, { AgentManager } from "./index.ts";
import { AgentWorkerSession } from "./worker.ts";
import { PlaceBook } from "./places.ts";
import { AgentStore } from "./store.ts";

interface Harness {
	base: string;
	cwd: string;
	sessionsRoot: string;
	manager: AgentManager;
	modelRuntime: ModelRuntime;
	store: AgentStore;
	context: Context;
	close(): Promise<void>;
}

async function harness(): Promise<Harness> {
	const root = mkdtempSync(join(tmpdir(), "agent-manager-"));
	const cwd = join(root, "work");
	const agentDir = join(root, "agent");
	const sessionsRoot = join(root, "sessions");
	mkdirSync(cwd, { recursive: true });
	mkdirSync(agentDir, { recursive: true });
	const store = new AgentStore({ sessionsRoot });
	const modelRuntime = await createTestRuntime({ refreshOnCreate: false });
	const abort = new AbortController();
	const context = withAbortSignal(abort.signal, BACKGROUND_CONTEXT);
	const manager = new AgentManager(store, modelRuntime, new ProjectTrustStore(agentDir), abort, agentDir);
	return {
		base: root,
		cwd,
		sessionsRoot,
		manager,
		modelRuntime,
		store,
		context,
		close: async () => {
			await manager.closeAll();
			await store.close(context);
			rmSync(root, { recursive: true, force: true });
		},
	};
}

describe("place sessions", () => {
	it("creates one session for an area, binds it durably, and reuses it with its accumulated context", async () => {
		const test = await harness();
		try {
			const first = await test.manager.place(test.cwd, { topic: "the agent slice" }, undefined, {
				model: { provider: "agent-test", id: "model" },
			});
			assert.match(first, /created session/u);
			const bindings = new PlaceBook(test.sessionsRoot).read();
			assert.equal(bindings.length, 1);
			assert.equal(bindings[0].area, test.cwd);
			assert.equal(bindings[0].topic, "the agent slice");
			const second = await test.manager.place(test.cwd, {}, undefined, { model: { provider: "agent-test", id: "model" } });
			assert.match(second, new RegExp(`session ${bindings[0].sessionId}`, "u"));
			assert.match(second, /for the agent slice/u);
			assert.match(second, /entries of accumulated context/u);
			assert.equal((await test.manager.listSessions()).length, 1, "the area keeps one session");
		} finally {
			await test.close();
		}
	});

	it("answers for a subdirectory from the nearest bound area and lists bindings", async () => {
		const test = await harness();
		try {
			const nested = join(test.cwd, "extensions", "agent");
			mkdirSync(nested, { recursive: true });
			await test.manager.place(test.cwd, {}, undefined, { model: { provider: "agent-test", id: "model" } });
			const [rootSession] = await test.manager.listSessions();
			const inherited = await test.manager.place(nested, {}, undefined, { model: { provider: "agent-test", id: "model" } });
			assert.match(inherited, new RegExp(`session ${rootSession} \\(bound at ${test.cwd}\\)`, "u"));
			assert.equal((await test.manager.listSessions()).length, 1);
			assert.match(test.manager.listPlaces(), /agent places \(1\):/u);
			assert.match(test.manager.unbindPlace(test.cwd), /unbound session/u);
			assert.match(test.manager.listPlaces(), /agent places \(0\):/u);
		} finally {
			await test.close();
		}
	});

	it("binds a new session when the bound session is gone from the store", async () => {
		const test = await harness();
		try {
			new PlaceBook(test.sessionsRoot).bind(test.cwd, "session-that-never-existed");
			const text = await test.manager.place(test.cwd, {}, undefined, { model: { provider: "agent-test", id: "model" } });
			assert.match(text, /is gone from the store; bound a new one/u);
			assert.notEqual(new PlaceBook(test.sessionsRoot).exact(test.cwd)?.sessionId, "session-that-never-existed");
		} finally {
			await test.close();
		}
	});

	it("refuses an area that is not a directory", async () => {
		const test = await harness();
		try {
			await assert.rejects(
				test.manager.place(join(test.cwd, "absent"), {}, undefined, { model: { provider: "agent-test", id: "model" } }),
				/no directory/u,
			);
		} finally {
			await test.close();
		}
	});
});

describe("detached run ownership", () => {
	it("refuses to reopen or re-detach a session while a live run owns it", async () => {
		const test = await harness();
		try {
			await test.manager.place(test.cwd, {}, undefined, { model: { provider: "agent-test", id: "model" } });
			const [sessionId] = await test.manager.listSessions();
			await (test.manager as unknown as { release(id: string): Promise<void> }).release(sessionId);
			const runs = new DetachedRuns(test.sessionsRoot);
			runs.writeRequest({
				runId: "run-live",
				launchState: "started",
				sessionId,
				sessionsRoot: test.sessionsRoot,
				agentDir: join(test.base, "agent"),
				cwd: test.cwd,
				prompt: "keep working",
				logFile: runs.logFile("run-live"),
				startedAt: new Date().toISOString(),
				pid: process.pid,
			});
			await assert.rejects(test.manager.attach(sessionId), /is running detached as run-live/u);
			await assert.rejects(test.manager.send(sessionId, "new work"), /is running detached as run-live/u);
			await assert.rejects(test.manager.send(sessionId, "peer work", "primary"), /is running detached as run-live/u);
			await assert.rejects(
				test.manager.detach({ sessionId, prompt: "second run" }, { cwd: test.cwd, model: null }),
				/already runs detached as run-live/u,
			);
			assert.match(test.manager.runs(), /run-live {2}running {2}session=/u);
			assert.match(test.manager.runs("run-live"), /run-live {2}running/u);
			assert.equal(test.manager.runs("absent"), "no detached run absent");
			runs.writeResult({ runId: "run-live", state: "finished", finishedAt: new Date().toISOString(), summary: "done" });
			assert.match(await test.manager.attach(sessionId), /attached/u, "the session reopens once the run settles");
		} finally {
			await test.close();
		}
	});
});

function recordRun(test: Harness, runId: string, pid = process.pid): DetachedRuns {
	const runs = new DetachedRuns(test.sessionsRoot);
	runs.writeRequest({
		runId,
		launchState: "started",
		sessionId: `session-${runId}`,
		sessionsRoot: test.sessionsRoot,
		agentDir: join(test.base, "agent"),
		cwd: test.cwd,
		prompt: "work",
		logFile: runs.logFile(runId),
		startedAt: "2026-09-10T00:00:00.000Z",
		pid,
	});
	return runs;
}

describe("detached run visibility", () => {
	it("returns detached state and progress without opening the session", async (t) => {
		const test = await harness();
		try {
			const runs = recordRun(test, "live");
			t.mock.method(test.store, "list", () => { throw new Error("session store must stay closed"); });
			assert.match(await test.manager.status("session-live"), /no progress record yet/u);
			runs.writeProgress({ runId: "live", updatedAt: "2026-09-10T00:01:00.000Z", entryCount: 7, currentTool: "read", lastText: "Read the file" });
			const status = await test.manager.status("session-live");
			assert.ok(status.startsWith(formatRun(defined(runs.get("live")))));
			assert.match(status, /live control unavailable/u);
			assert.match(status, /recorded observation, not live owner status/u);
			assert.match(status, /live {2}running {2}session=session-live/u);
			assert.match(status, /entries=7 {2}tool=read/u);
			assert.match(status, /Read the file/u);
			assert.equal(test.manager.runs("live"), formatRun(defined(runs.get("live"))));
			recordRun(test, "gone", 2147483647);
			assert.match(test.manager.runs("gone"), /abandoned/u);
			assert.match(test.manager.runs("gone"), /retained writer claim blocks reopening/u);
		} finally { await test.close(); }
	});

	it("reports only settled runs, acknowledges them, and stays silent on repeat", async (t) => {
		const test = await harness();
		try {
			const runs = recordRun(test, "finished");
			recordRun(test, "failed");
			recordRun(test, "live");
			runs.writeResult({ runId: "finished", state: "finished", finishedAt: "2026-09-10T00:01:00.000Z", summary: "All work\ncomplete" });
			runs.writeResult({ runId: "failed", state: "failed", finishedAt: "2026-09-10T00:01:00.000Z", error: "Model\nfailed" });
			const messages: string[] = [];
			t.mock.method(test.store, "list", () => { throw new Error("session store must stay closed"); });
			test.manager.registerPrimary("primary", test.cwd, (content) => messages.push(content));
			test.manager.reportSettledRuns("primary");
			assert.deepEqual(messages, [
				"Detached run failed failed, session session-failed: Model failed\n" +
				"Detached run finished finished, session session-finished: All work complete",
			]);
			assert.equal(runs.get("finished")?.acknowledged, true);
			assert.equal(runs.get("failed")?.acknowledged, true);
			assert.equal(runs.get("live")?.acknowledged, undefined);
			test.manager.reportSettledRuns("primary");
			assert.equal(messages.length, 1);
		} finally { await test.close(); }
	});

	it("reports abandoned work and leaves a refused delivery unacknowledged", async () => {
		const test = await harness();
		try {
			const runs = recordRun(test, "gone", 2147483647);
			test.manager.reportSettledRuns("absent-primary");
			assert.equal(runs.get("gone")?.acknowledged, undefined);
			test.manager.registerPrimary("primary", test.cwd, () => { throw new Error("delivery refused"); });
			assert.throws(() => test.manager.reportSettledRuns("primary"), /delivery refused/u);
			assert.equal(runs.get("gone")?.acknowledged, undefined);
			const messages: string[] = [];
			test.manager.registerPrimary("primary", test.cwd, (content) => messages.push(content));
			test.manager.reportSettledRuns("primary");
			assert.deepEqual(messages, ["Detached run gone abandoned, session session-gone: the process is gone; completed work remains; a retained writer claim blocks reopening"]);
			assert.equal(runs.get("gone")?.acknowledged, true);
		} finally { await test.close(); }
	});

	it("announces a result once for a watcher event and closes the watcher on unregister", { timeout: 5000 }, async () => {
		const test = await harness();
		try {
			const runs = recordRun(test, "watched");
			const messages: string[] = [];
			test.manager.registerPrimary("primary", test.cwd, (content) => { messages.push(content); });
			const watcher = (test.manager as unknown as { runWatcher: FSWatcher }).runWatcher;
			assert.ok(watcher);
			runs.writeProgress({ runId: "watched", updatedAt: "2026-09-10T00:01:00.000Z", entryCount: 1 });
			watcher.emit("change", "rename", "watched.progress.json");
			assert.equal(messages.length, 0);
			runs.writeResult({ runId: "watched", state: "finished", finishedAt: "2026-09-10T00:02:00.000Z", summary: "Work complete" });
			watcher.emit("change", "rename", "watched.result.json");
			assert.deepEqual(messages, ["Detached run watched finished, session session-watched: Work complete"]);
			assert.equal(runs.get("watched")?.acknowledged, true);
			watcher.emit("change", "rename", "watched.result.json");
			test.manager.reportSettledRuns("primary");
			assert.equal(messages.length, 1);
			const closed = once(watcher, "close");
			await test.manager.unregisterPrimary("primary");
			await closed;
			assert.equal((test.manager as unknown as { runWatcher?: FSWatcher }).runWatcher, undefined);
		} finally { await test.close(); }
	});

	it("creates no directory for a watcher and retains startup reporting after a watch error", async () => {
		const test = await harness();
		try {
			const messages: string[] = [];
			test.manager.registerPrimary("primary", test.cwd, (content) => messages.push(content));
			const watcherState = test.manager as unknown as { runWatcher?: FSWatcher };
			assert.equal(watcherState.runWatcher, undefined);
			assert.equal(existsSync(join(test.sessionsRoot, "detached")), false);
			const runs = recordRun(test, "failed-watch");
			test.manager.registerPrimary("primary", test.cwd, (content) => messages.push(content));
			const watcher = (test.manager as unknown as { runWatcher?: FSWatcher }).runWatcher;
			assert.ok(watcher);
			watcher.emit("error", new Error("watch unavailable"));
			assert.equal(watcherState.runWatcher, undefined);
			runs.writeResult({ runId: "failed-watch", state: "finished", finishedAt: "2026-09-10T00:02:00.000Z", summary: "done" });
			test.manager.reportSettledRuns("primary");
			assert.equal(messages.length, 1);
		} finally { await test.close(); }
	});
});

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((accept, refuse) => { resolve = accept; reject = refuse; });
	return { promise, resolve, reject };
}

const defaultModel = { provider: "agent-test", id: "model" };

async function createSession(test: Harness): Promise<string> {
	return (await test.manager.spawn({}, { cwd: test.cwd, model: defaultModel })).sessionId;
}

function heldWorker(test: Harness, id: string): AgentWorkerSession {
	return defined((test.manager as unknown as { sessions: Map<string, AgentWorkerSession> }).sessions.get(id));
}

function installRunStart(test: Harness, t: TestContext) {
	const runs = (test.manager as unknown as { detachedRuns: DetachedRuns }).detachedRuns;
	return t.mock.method(runs, "start", async (input: { runId: string; sessionId: string; cwd: string; prompt: string }) => {
		const request = { ...input, sessionsRoot: test.sessionsRoot, agentDir: join(test.base, "agent"), logFile: runs.logFile(input.runId), startedAt: new Date().toISOString(), launchState: "started" as const, pid: process.pid };
		runs.writeRequest(request);
		return request;
	});
}

describe("manager ownership transitions", () => {
	it("excludes attach, send, and a second detach until deferred close completes", async (t) => {
		const test = await harness();
		try {
			const id = await createSession(test);
			const worker = heldWorker(test, id);
			const close = worker.close.bind(worker);
			const entered = deferred<void>();
			const finish = deferred<void>();
			t.mock.method(worker, "close", async (reason?: string) => { entered.resolve(); await finish.promise; await close(reason); });
			const start = installRunStart(test, t);
			const transfer = test.manager.detach({ sessionId: id, prompt: "next" }, { cwd: test.cwd, model: null });
			await entered.promise;
			assert.equal(heldWorker(test, id), worker, "local membership remains until close completes");
			await assert.rejects(test.manager.attach(id), /ownership transfer/u);
			await assert.rejects(test.manager.send(id, "work"), /ownership transfer/u);
			await assert.rejects(test.manager.detach({ sessionId: id, prompt: "duplicate" }, { cwd: test.cwd, model: null }), /ownership transfer/u);
			assert.equal(start.mock.callCount(), 0);
			finish.resolve();
			const result = await transfer;
			assert.ok(result.runId);
			assert.equal(start.mock.callCount(), 1);
			await assert.rejects(test.manager.attach(id), /running detached/u);
		} finally { await test.close(); }
	});

	it("drains admitted controls and refuses active work without closing it", async (t) => {
		const test = await harness();
		try {
			const id = await createSession(test);
			const worker = heldWorker(test, id);
			const entered = deferred<void>();
			const finish = deferred<void>();
			const baseStatus = await worker.status();
			let active = false;
			t.mock.method(worker, "start", async () => { entered.resolve(); await finish.promise; active = true; return "operation"; });
			t.mock.method(worker, "status", async () => ({ ...baseStatus, operation: active ? "operation" : null }));
			const close = t.mock.method(worker, "close");
			const send = test.manager.send(id, "work");
			await entered.promise;
			const transfer = test.manager.detach({ sessionId: id, prompt: "next" }, { cwd: test.cwd, model: null });
			finish.resolve();
			await send;
			await assert.rejects(transfer, /finish or abort existing work/u);
			assert.equal(close.mock.callCount(), 0);
		} finally { await test.close(); }
	});

	it("refuses host-owned active work even without a model operation", async (t) => {
		const test = await harness();
		try {
			const id = await createSession(test);
			const worker = heldWorker(test, id);
			assert.equal((await worker.status()).operation, null);
			t.mock.method(worker, "hasPendingHostWork", () => true);
			const close = t.mock.method(worker, "close");
			await assert.rejects(test.manager.detach({ sessionId: id, prompt: "next" }, { cwd: test.cwd, model: null }), /finish or abort existing work/u);
			assert.equal(close.mock.callCount(), 0);
		} finally { await test.close(); }
	});

	it("blocks all new opens and creations during closeAll and drains late startup", async (t) => {
		const test = await harness();
		try {
			const entered = deferred<void>();
			const finish = deferred<void>();
			const create = AgentWorkerSession.create.bind(AgentWorkerSession);
			let late: AgentWorkerSession | undefined;
			t.mock.method(AgentWorkerSession, "create", async (options: Parameters<typeof AgentWorkerSession.create>[0]) => { entered.resolve(); await finish.promise; late = await create(options); return late; });
			const creation = createSession(test);
			await entered.promise;
			const shutdown = test.manager.closeAll();
			await assert.rejects(test.manager.attach("any"), /manager is closed/u);
			await assert.rejects(createSession(test), /manager is closed/u);
			finish.resolve();
			await assert.rejects(creation, /manager is closed/u);
			await shutdown;
			const closedWorker = defined(late);
			assert.throws(() => closedWorker.sessionId(), /not attached/u);
			await assert.rejects(test.manager.attach("any"), /manager is closed/u);
		} finally { await test.close(); }
	});

	it("reads the detached inventory once for all session rows without opening workers", async (t) => {
		const test = await harness();
		try {
			const first = await test.store.create(test.cwd, test.context);
			const second = await test.store.create(test.cwd, test.context);
			await first.close(test.context); await second.close(test.context);
			const runs = (test.manager as unknown as { detachedRuns: DetachedRuns }).detachedRuns;
			const list = t.mock.method(runs, "list");
			t.mock.method(AgentWorkerSession, "open", async () => { throw new Error("must not open"); });
			assert.equal((await test.manager.sessionSummaries()).length, 2);
			assert.equal(list.mock.callCount(), 1);
		} finally { await test.close(); }
	});
});

describe("command registration", () => {
	it("completes stored metadata without opening workers or querying session status", async (t) => {
		const test = await harness();
		const previous = process.env.PI_AGENT_SESSIONS_DIR;
		process.env.PI_AGENT_SESSIONS_DIR = test.sessionsRoot;
		try {
			const stored = await test.store.create(test.cwd, test.context);
			const id = stored.metadata.id;
			await stored.close(test.context);
			const open = t.mock.method(AgentWorkerSession, "open", async () => { throw new Error("must not open"); });
			const status = t.mock.method(test.manager, "status", async () => { throw new Error("must not query"); });
			let command!: Omit<RegisteredCommand, "name" | "sourceInfo">;
			registerAgentExtension({ registerTool() {}, on() {}, registerCommand(_name: string, options: typeof command) { command = options; } } as unknown as ExtensionAPI);
			const complete = defined(command.getArgumentCompletions);
			for (const action of ["status", "attach", "fork", "send", "steer", "abort", "rewind", "detach"]) {
				const result = defined(await complete(`${action} `));
				assert.equal(result.length, 1, action);
				assert.ok(result[0].value.includes(id));
				assert.match(defined(result[0].description), /Stored session/);
			}
			assert.equal(open.mock.callCount(), 0);
			assert.equal(status.mock.callCount(), 0);
		} finally {
			if (previous === undefined) delete process.env.PI_AGENT_SESSIONS_DIR; else process.env.PI_AGENT_SESSIONS_DIR = previous;
			await test.close();
		}
	});

	it("dispatches the advertised actions through the existing manager operations", async (t) => {
		const test = await harness();
		const previous = process.env.PI_AGENT_SESSIONS_DIR;
		process.env.PI_AGENT_SESSIONS_DIR = test.sessionsRoot;
		try {
			const calls: Array<{ method: string; args: unknown[] }> = [];
			for (const method of ["spawn", "status", "attach", "fork", "abort", "rewind", "place", "listPlaces", "unbindPlace", "detach", "runs", "send", "steer"] as const) {
				t.mock.method(test.manager, method, (...args: unknown[]) => { calls.push({ method, args }); return ["spawn", "fork", "rewind", "detach"].includes(method) ? { sessionId: "created", runId: "run", text: method } : method; });
			}
			let command!: Omit<RegisteredCommand, "name" | "sourceInfo">;
			registerAgentExtension({ registerTool() {}, on() {}, getThinkingLevel: () => "high", registerCommand(_name: string, options: typeof command) { command = options; } } as unknown as ExtensionAPI);
			const notices: string[] = [];
			const ctx = { cwd: test.cwd, model: defaultModel, mode: "tui", hasUI: true, isProjectTrusted: () => true, ui: { custom: () => { throw new Error("custom UI must stay unopened"); }, notify: (text: string) => notices.push(text) } } as unknown as ExtensionCommandContext;
			for (const [input, method] of [
				["new Check the parser", "spawn"], ["list", "status"], ["status selected", "status"],
				["attach selected", "attach"], ["fork selected", "fork"], ["abort selected", "abort"],
				["rewind selected entry Use current files", "rewind"], ["place . Check the parser", "place"],
				["places", "listPlaces"], ["unbind .", "unbindPlace"], ["detach selected Next task", "detach"],
				["runs run", "runs"], ["send selected help with errors", "send"], ["steer selected Change direction", "steer"],
			]) {
				await command.handler(input, ctx);
				assert.equal(calls.at(-1)?.method, method, input);
				assert.equal(notices.at(-1), method, input);
			}
			assert.deepEqual(calls[0].args, [{ prompt: "Check the parser" }, { cwd: test.cwd, model: { provider: defaultModel.provider, id: defaultModel.id }, thinkingLevel: "high" }, undefined]);
			assert.deepEqual(defined(calls.find((call) => call.method === "attach")).args, ["selected", undefined, undefined]);
			assert.deepEqual(defined(calls.find((call) => call.method === "rewind")).args, ["selected", "entry", "Use current files", undefined, undefined]);
			assert.deepEqual(defined(calls.find((call) => call.method === "send")).args, ["selected", "help with errors"]);
			const count = calls.length;
			for (const action of ["console", "ls"]) {
				await command.handler(action, ctx);
				assert.match(defined(notices.at(-1)), /Unknown action/);
			}
			assert.equal(calls.length, count);
		} finally {
			if (previous === undefined) delete process.env.PI_AGENT_SESSIONS_DIR; else process.env.PI_AGENT_SESSIONS_DIR = previous;
			await test.close();
		}
	});

	it("uses native notifications for bare commands in every mode without opening a session", async (t) => {
		const test = await harness();
		const previous = process.env.PI_AGENT_SESSIONS_DIR;
		process.env.PI_AGENT_SESSIONS_DIR = test.sessionsRoot;
		try {
			let handler!: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
			registerAgentExtension({ registerTool() {}, on() {}, getThinkingLevel: () => "high", registerCommand(_name: string, options: { handler: typeof handler }) { handler = options.handler; } } as unknown as ExtensionAPI);
			t.mock.method(AgentWorkerSession, "open", async () => { throw new Error("must not open"); });
			t.mock.method(AgentWorkerSession, "create", async () => { throw new Error("must not create"); });
			const notices: string[] = [];
			const context = { cwd: test.cwd, model: defaultModel, isProjectTrusted: () => true, ui: { custom: async () => { throw new Error("custom UI must stay unopened"); }, notify: (text: string) => notices.push(text) } } as unknown as ExtensionCommandContext;
			for (const mode of ["tui", "rpc", "print", "json"] as const) {
				await handler("", { ...context, mode, hasUI: mode === "tui" || mode === "rpc" });
				assert.match(defined(notices.at(-1)), /\/agent manages durable sessions/u);
			}
			assert.equal(new Set(notices).size, 1);
			assert.deepEqual(await test.manager.listSessions(), []);
		} finally {
			if (previous === undefined) delete process.env.PI_AGENT_SESSIONS_DIR; else process.env.PI_AGENT_SESSIONS_DIR = previous;
			await test.close();
		}
	});

	it("rejects a rewind before the model seed", async () => {
		const test = await harness();
		try {
			const id = await createSession(test);
			const worker = heldWorker(test, id);
			const seed = worker.sessionManager().getBranch()[0];
			await assert.rejects(test.manager.rewind(id, seed.id, "correction"), /durable model entry/u);
			assert.equal((await test.manager.listSessions()).length, 1);
		} finally { await test.close(); }
	});
});

describe("rewind", () => {
	it("refuses active source work without creating a competing fork", async (t) => {
		const test = await harness();
		try {
			const id = await createSession(test);
			const worker = heldWorker(test, id);
			const status = await worker.status();
			t.mock.method(worker, "status", async () => ({ ...status, operation: "active-operation" }));
			await assert.rejects(test.manager.rewind(id, "entry", "Keep the interface"), /source has active work/u);
			assert.deepEqual(await test.manager.listSessions(), [id]);
		} finally { await test.close(); }
	});

	it("refuses an entry that is not on the session's branch", async () => {
		const test = await harness();
		try {
			await test.manager.place(test.cwd, {}, undefined, { model: { provider: "agent-test", id: "model" } });
			const [sessionId] = await test.manager.listSessions();
			await assert.rejects(test.manager.rewind(sessionId, "no-such-entry", "do it the other way"), /not on this session's current branch/u);
			assert.equal((await test.manager.listSessions()).length, 1, "a refused rewind creates no fork");
		} finally {
			await test.close();
		}
	});
});
