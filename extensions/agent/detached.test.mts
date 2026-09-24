import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, watch, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/pi-agent-core";
import { ModelRuntime, ProjectTrustStore, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { AgentManager } from "./index.ts";
import { AgentStore } from "./store.ts";
import { DetachedRuns, detachedRunEntry, formatRun, isProcessAlive, MAX_SUMMARY_CHARS, type DetachedRunProgress, type SpawnLike } from "./detached.ts";
import { createProgressWriter, executeDetachedRun, progressRecord } from "./detached-run.ts";
import { withDetachedControl, type DetachedControlServerOptions } from "./detached-control.ts";
import { defined } from "./test-assertions.mts";
import type { AgentWorkerSession, WorkerObservation } from "./worker.ts";

const unusedControls = {
	sessionMetadata: () => ({ id: "session", createdAt: 0, storageVersion: 1, cwd: "/test", path: "/test/session.jsonl", modifiedAt: 0 }),
	status: async () => { throw new Error("unexpected status read"); },
	inspect: async () => { throw new Error("unexpected inspect read"); },
	steer: async () => { throw new Error("unexpected steer"); },
	compact: async () => { throw new Error("unexpected compact"); },
	runCommand: async () => { throw new Error("unexpected command"); },
};
const noControlServer = async () => ({ sealAndDrain: async () => undefined, close: async () => undefined });

function operationOutcome(status: "completed" | "failed" | "aborted" | "missing"): Awaited<ReturnType<AgentWorkerSession["operationResult"]>> {
	if (status === "missing") return undefined;
	return { operationId: "operation", status,
		...(status === "failed" ? { error: { message: "deterministic model failure" } } : {}),
		...(status === "aborted" ? { error: { message: "" } } : {}) };
}

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => { resolve = done; });
	return { promise, resolve };
}

function base(): string {
	return mkdtempSync(join(tmpdir(), "agent-detached-"));
}

function waitForFile(path: string, directory: string): Promise<void> {
	if (existsSync(path)) return Promise.resolve();
	return new Promise((resolve, reject) => {
		const watcher = watch(directory, () => { if (existsSync(path)) finish(); });
		const timer = setTimeout(() => finish(new Error(`fixture did not publish ${path}`)), 15000);
		const finish = (error?: Error) => {
			clearTimeout(timer);
			watcher.close();
			if (error) reject(error); else resolve();
		};
		watcher.on("error", finish);
		if (existsSync(path)) finish();
	});
}

function request(runs: DetachedRuns, root: string, overrides: { runId: string; sessionId: string; pid: number }) {
	return {
		sessionsRoot: root,
		agentDir: join(root, "agent"),
		cwd: root,
		prompt: "do the work",
		logFile: runs.logFile(overrides.runId),
		startedAt: new Date().toISOString(),
		launchState: "started" as const,
		...overrides,
	};
}

describe("detached run records", () => {
	it("reads a started run as running while its process answers", () => {
		const root = base();
		try {
			const runs = new DetachedRuns(root);
			runs.writeRequest(request(runs, root, { runId: "run-1", sessionId: "session-1", pid: process.pid }));
			assert.equal(runs.get("run-1")?.state, "running");
			assert.equal(runs.liveFor("session-1")?.runId, "run-1");
			assert.equal(runs.liveFor("session-2"), undefined);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("reads a started run without a result and without a process as abandoned", () => {
		const root = base();
		try {
			const runs = new DetachedRuns(root);
			runs.writeRequest(request(runs, root, { runId: "run-2", sessionId: "session-2", pid: 2 ** 30 }));
			const view = runs.get("run-2");
			assert.equal(view?.state, "abandoned");
			assert.equal(runs.liveFor("session-2"), undefined, "an abandoned run does not hold its session");
			assert.ok(view);
			assert.match(formatRun(view), /abandoned {2}session=session-2/u);
			assert.match(formatRun(view), /completed work remains; a retained writer claim blocks reopening/u);
			assert.doesNotMatch(formatRun(view), /session is reopenable/u);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("prefers the published result over process liveness", () => {
		const root = base();
		try {
			const runs = new DetachedRuns(root);
			runs.writeRequest(request(runs, root, { runId: "run-3", sessionId: "session-3", pid: process.pid }));
			runs.writeResult({ runId: "run-3", state: "finished", finishedAt: "2026-01-01T00:00:00.000Z", summary: "the port is renamed" });
			const view = runs.get("run-3");
			assert.equal(view?.state, "finished");
			assert.equal(view?.summary, "the port is renamed");
			assert.equal(runs.liveFor("session-3"), undefined);
			assert.match(formatRun(defined(view)), /finished {2}session=session-3.*the port is renamed/su);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("lists runs newest first and ignores unrelated files", () => {
		const root = base();
		try {
			const runs = new DetachedRuns(root);
			runs.writeRequest({ ...request(runs, root, { runId: "old", sessionId: "s", pid: 2 ** 30 }), startedAt: "2026-01-01T00:00:00.000Z" });
			runs.writeRequest({ ...request(runs, root, { runId: "new", sessionId: "s", pid: 2 ** 30 }), startedAt: "2026-02-01T00:00:00.000Z" });
			writeFileSync(join(runs.root, "notes.txt"), "ignored", "utf8");
			writeFileSync(join(runs.root, "broken.json"), "{ not json", "utf8");
			assert.deepEqual(
				runs.list().map((run) => run.runId),
				["new", "old"],
			);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("writes the request before the child starts and records the child's process id", async () => {
		const root = base();
		try {
			const runs = new DetachedRuns(root);
			const observed: Array<{ command: string; args: string[]; detached: boolean; cwd: string }> = [];
			let requestAtSpawn: string | undefined;
			const fakeSpawn: SpawnLike = (command, args, options) => {
				observed.push({ command, args, detached: options.detached, cwd: options.cwd });
				requestAtSpawn = readFileSync(args[1], "utf8");
				const child = Object.assign(new EventEmitter(), { pid: 4321, unref: () => undefined, stdin: { end: () => undefined, on: () => undefined }, kill: () => false });
				process.nextTick(() => child.emit("spawn"));
				return child;
			};
			const started = await runs.start({
				runId: "run-4",
				sessionId: "session-4",
				sessionsRoot: root,
				agentDir: join(root, "agent"),
				cwd: root,
				prompt: "rename the port",
				trusted: true,
				spawn: fakeSpawn,
			});
			assert.equal(observed.length, 1);
			assert.equal(observed[0].command, process.execPath);
			assert.equal(observed[0].args[0], detachedRunEntry());
			assert.equal(observed[0].args[1], runs.requestFile("run-4"));
			assert.equal(observed[0].detached, true);
			assert.equal(observed[0].cwd, root);
			assert.equal(JSON.parse(defined(requestAtSpawn)).prompt, "rename the port", "the child's only input exists before it starts");
			assert.equal(started.pid, 4321);
			assert.equal(runs.get("run-4")?.pid, 4321);
			assert.equal(runs.get("run-4")?.trusted, true);
			assert.ok(existsSync(started.logFile));
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("round-trips progress, ignores progress files in lists, and formats live and finished runs", () => {
		const root = base();
		try {
			const runs = new DetachedRuns(root);
			runs.writeRequest(request(runs, root, { runId: "progress", sessionId: "session", pid: process.pid }));
			const progress: DetachedRunProgress = {
				runId: "progress", updatedAt: "2026-01-01T00:00:00.000Z", entryCount: 12,
				currentTool: "read", lastText: "read: source text", error: "tool warning",
			};
			runs.writeProgress(progress);
			assert.deepEqual(runs.get("progress")?.progress, progress);
			// A progress-suffixed file with a request shape must still be ignored.
			writeFileSync(runs.progressFile("orphan"), JSON.stringify(request(runs, root, { runId: "orphan", sessionId: "session", pid: process.pid })));
			assert.deepEqual(runs.list().map((run) => run.runId), ["progress"]);
			const live = formatRun(defined(runs.get("progress")));
			assert.match(live, /entries=12 {2}tool=read {2}updated=2026-01-01T00:00:00.000Z/u);
			assert.match(live, /read: source text/u);
			runs.writeResult({ runId: "progress", state: "finished", finishedAt: "2026-01-01T00:00:01.000Z", summary: "The source is correct." });
			const finished = formatRun(defined(runs.get("progress")));
			assert.match(finished, /The source is correct\./u);
			assert.doesNotMatch(finished, /entries=|tool=|read: source text/u);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("publishes request replacements without truncating an already open reader", () => {
		const root = base();
		try {
			const runs = new DetachedRuns(root);
			const before = request(runs, root, { runId: "atomic", sessionId: "session", pid: 0 });
			runs.writeRequest(before);
			const fd = openSync(runs.requestFile("atomic"), "r");
			try {
				runs.writeRequest({ ...before, pid: process.pid });
				assert.equal(JSON.parse(readFileSync(fd, "utf8")).pid, 0);
				assert.equal(runs.get("atomic")?.pid, process.pid);
			} finally { closeSync(fd); }
		} finally { rmSync(root, { recursive: true, force: true }); }
	});

	it("confines every run path and rejects invalid record shapes and identities", () => {
		const root = base();
		try {
			const runs = new DetachedRuns(root);
			for (const id of ["../escape", "x/y", "x\\y", ".", "", "x".repeat(129)]) {
				for (const path of [runs.requestFile, runs.resultFile, runs.progressFile, runs.seenFile, runs.logFile]) {
					assert.throws(() => path.call(runs, id), /invalid detached run id/u);
				}
				assert.throws(() => runs.get(id), /invalid detached run id/u);
			}
			const good = request(runs, root, { runId: "valid", sessionId: "session", pid: process.pid });
			runs.writeRequest(good);
			for (const bad of [{ ...good, runId: "different" }, { ...good, pid: "123" }, { ...good, trusted: "yes" }, { ...good, cwd: [] }, { ...good, extra: true }, []]) {
				writeFileSync(runs.requestFile("valid"), JSON.stringify(bad));
				assert.equal(runs.get("valid"), undefined);
			}
			runs.writeRequest(good);
			const progress = { runId: "valid", updatedAt: good.startedAt, entryCount: 1 };
			for (const bad of [{ ...progress, runId: "different" }, { ...progress, entryCount: -1 }, { ...progress, currentTool: {} }, { ...progress, lastText: "x".repeat(601) }, { ...progress, updatedAt: "yesterday" }]) {
				writeFileSync(runs.progressFile("valid"), JSON.stringify(bad));
				assert.equal(runs.get("valid")?.progress, undefined);
			}
			const result = { runId: "valid", state: "finished", finishedAt: good.startedAt };
			for (const bad of [{ ...result, runId: "different" }, { ...result, state: "running" }, { ...result, finishedAt: null }, { ...result, error: "contradiction" }, { ...result, state: "failed" }, { ...result, summary: {} }]) {
				writeFileSync(runs.resultFile("valid"), JSON.stringify(bad));
				assert.equal(runs.get("valid")?.state, "running");
			}
			writeFileSync(runs.progressFile("valid"), " ".repeat(17000));
			assert.equal(runs.get("valid")?.progress, undefined);
			writeFileSync(runs.requestFile("valid"), " ".repeat(1024 * 1024 + 1));
			assert.equal(runs.get("valid"), undefined);
		} finally { rmSync(root, { recursive: true, force: true }); }
	});

	it("persists launch failures for thrown errors, error events, and absent pids", async () => {
		const root = base();
		try {
			const runs = new DetachedRuns(root);
			for (const kind of ["throw", "event", "pid"] as const) {
				const fakeSpawn: SpawnLike = () => {
					if (kind === "throw") throw new Error("spawn refused");
					const child = Object.assign(new EventEmitter(), { unref: () => assert.fail("failure must not unref"), stdin: null, kill: () => false });
					process.nextTick(() => kind === "event" ? child.emit("error", new Error("spawn refused")) : child.emit("spawn"));
					return child;
				};
				await assert.rejects(runs.start({ runId: kind, sessionId: "session", sessionsRoot: root, agentDir: root, cwd: root, prompt: "test", spawn: fakeSpawn }), /spawn refused|no valid pid/u);
				assert.equal(runs.get(kind)?.state, "failed");
				assert.match(runs.get(kind)?.error ?? "", /^launch failed:/u);
			}
			await assert.rejects(runs.start({ runId: "enoent", sessionId: "session", sessionsRoot: root, agentDir: root, cwd: join(root, "missing"), prompt: "test" }), /ENOENT/u);
			assert.equal(runs.get("enoent")?.state, "failed");
		} finally { rmSync(root, { recursive: true, force: true }); }
	});

	it("keeps a deferred spawn visible as launching until publication releases the child", async () => {
		const root = base();
		try {
			const runs = new DetachedRuns(root);
			let released = false;
			const child = Object.assign(new EventEmitter(), { pid: 4321, unref: () => undefined, kill: () => false,
				stdin: { on: () => undefined, end: () => {
					assert.equal(runs.get("deferred")?.launchState, "started");
					assert.equal(runs.get("deferred")?.pid, 4321);
					released = true;
				} },
			});
			const launch = runs.start({ runId: "deferred", sessionId: "session", sessionsRoot: root, agentDir: root, cwd: root, prompt: "test", spawn: () => child });
			assert.equal(runs.get("deferred")?.state, "launching");
			assert.equal(runs.liveFor("session")?.runId, "deferred");
			assert.equal(released, false);
			child.emit("spawn");
			await launch;
			assert.equal(released, true);
			child.emit("error", new Error("late process error"));
		} finally { rmSync(root, { recursive: true, force: true }); }
	});

	it("does not infer thinking from an absent tool", () => {
		const root = base();
		try {
			const runs = new DetachedRuns(root);
			const source = request(runs, root, { runId: "no-tool", sessionId: "session", pid: process.pid });
			const display = formatRun({ ...source, state: "running", progress: { runId: source.runId, updatedAt: source.startedAt, entryCount: 2 } });
			assert.match(display, /entries=2 {2}updated=/u);
			assert.doesNotMatch(display, /thinking|tool=/u);
		} finally { rmSync(root, { recursive: true, force: true }); }
	});

	it("reports process liveness for the current process and refuses impossible ids", () => {
		assert.equal(isProcessAlive(process.pid), true);
		assert.equal(isProcessAlive(0), false);
		assert.equal(isProcessAlive(-1), false);
	});
});

describe("detached progress publication", () => {
	it("bounds durable text and reports only tools with execution evidence", () => {
		const entries = [{
			type: "message", id: "assistant", parentId: null, timestamp: "2026-01-01T00:00:00.000Z",
			message: { role: "assistant", content: [{ type: "text", text: "x".repeat(800) }, { type: "toolCall", id: "call", name: "read", arguments: {} }] },
		}] as SessionEntry[];
		const idle = progressRecord("run", entries, null, "reported error");
		assert.equal(idle.entryCount, 1);
		assert.equal(idle.lastText, "x".repeat(MAX_SUMMARY_CHARS));
		assert.equal(idle.error, "reported error");
		assert.equal("currentTool" in idle, false);
		const operation: WorkerObservation = { pending: 0, currentTool: "read", lastText: "read" };
		assert.equal(progressRecord("run", entries, operation).currentTool, "read");
		assert.equal(progressRecord("run", entries, operation).lastText, "read");
		operation.lastText = "read: partial output";
		assert.equal(progressRecord("run", entries, operation).lastText, "read: partial output");
		operation.currentTool = undefined;
		assert.equal("currentTool" in progressRecord("run", entries, operation), false);
		entries.push({ type: "message", id: "result", parentId: "assistant", timestamp: "2026-01-01T00:00:01.000Z", message: { role: "toolResult", toolCallId: "call", toolName: "read", content: [{ type: "text", text: "file text" }], isError: false, timestamp: 1 } });
		assert.equal(progressRecord("run", entries, null).lastText, "read: file text");
		operation.lastText = "live text";
		assert.equal(progressRecord("run", entries, operation).lastText, "live text");
		assert.equal("currentTool" in progressRecord("run", entries, operation), false);
	});

	it("coalesces writes within 500 ms, publishes the latest update, and flushes once at settlement", (context) => {
		context.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1000 });
		const writes: DetachedRunProgress[] = [];
		let entryCount = 1;
		const publish = createProgressWriter(() => ({ runId: "run", entryCount }), (progress) => writes.push(progress));
		publish();
		entryCount = 2;
		publish();
		context.mock.timers.tick(499);
		assert.equal(writes.length, 1);
		entryCount = 3;
		publish();
		context.mock.timers.tick(1);
		assert.equal(writes.length, 2);
		assert.equal(writes[1].entryCount, 3);
		assert.equal(writes[1].updatedAt, new Date(1500).toISOString());
		entryCount = 4;
		publish();
		publish(true);
		assert.equal(writes.length, 3);
		assert.equal(writes[2].entryCount, 4);
		context.mock.timers.tick(1000);
		publish();
		publish(true);
		assert.equal(writes.length, 3, "settlement cancels the timer and closes publication");
	});
});

function controlFixture() {
	const root = base();
	const runs = new DetachedRuns(root);
	const source = request(runs, root, { runId: "control", sessionId: "session", pid: process.pid });
	runs.writeRequest(source);
	const calls: string[] = [];
	const entries: SessionEntry[] = [];
	const snapshot: WorkerObservation = { pending: 0 };
	const worker = {
		...unusedControls,
		sessionManager: () => ({ getEntries: () => entries }),
		setOnUpdate: (_callback: unknown) => undefined,
		observe: (_listener: unknown) => () => { calls.push("unsubscribe"); },
		observation: () => snapshot,
		start: async () => { calls.push("start"); return "initial"; },
		waitForIdle: async () => { calls.push("idle"); },
		lastErrorMessage: (): string | undefined => undefined,
		operationResult: async (operationId: string) => {
			calls.push(`result:${operationId}`);
			return { operationId, kind: "run" as const, status: "completed" as const, fromTipId: null, tipId: null, startedAt: 0, endedAt: 1 };
		},
		abort: async () => { calls.push("abort"); return true; },
	};
	const options = {
		createHost: async () => ({ open: async () => worker, close: async () => { calls.push("host-close"); } }),
		createControlServer: async (_options: DetachedControlServerOptions) => {
			calls.push("listen");
			return { sealAndDrain: async () => { calls.push("seal"); }, close: async () => { calls.push("control-close"); } };
		},
	};
	return { root, runs, source, calls, entries, snapshot, worker, options, close: () => rmSync(root, { recursive: true, force: true }) };
}

describe("detached control lifecycle", () => {
	it("starts controls before admission and seals before final snapshot and cleanup", async () => {
		const test = controlFixture();
		try {
			assert.equal(await executeDetachedRun(test.source, test.options), 0);
			assert.deepEqual(test.calls, ["listen", "start", "idle", "seal", "idle", "result:initial", "unsubscribe", "control-close", "host-close"]);
			assert.equal(test.runs.get(test.source.runId)?.state, "finished");
		} finally { test.close(); }
	});

	it("reports hosted sessions with active or queued work at shutdown", async () => {
		const test = controlFixture();
		try {
			const code = await executeDetachedRun(test.source, {
				...test.options,
				createHost: async () => ({ open: async () => test.worker, close: async () => { test.calls.push("host-close"); }, activeHostedSessionIds: () => ["peer-session"] }),
			});
			assert.equal(code, 1);
			assert.equal(test.runs.get(test.source.runId)?.state, "failed");
			assert.match(test.runs.get(test.source.runId)?.error ?? "", /peer-session/u);
			assert.match(test.runs.get(test.source.runId)?.error ?? "", /active or queued work at shutdown/u);
			assert.doesNotMatch(test.runs.get(test.source.runId)?.error ?? "", /in-flight turns are aborted/u);
		} finally { test.close(); }
	});

	it("keeps hosted evidence in the durable error after a long prior failure", async (t) => {
		const test = controlFixture();
		t.mock.method(test.worker, "operationResult", async () => ({ ...defined(operationOutcome("failed")), error: { message: "prior-error ".repeat(220) } }));
		try {
			const code = await executeDetachedRun(test.source, {
				...test.options,
				createHost: async () => ({ open: async () => test.worker, close: async () => { test.calls.push("host-close"); }, activeHostedSessionIds: () => ["affected-peer"] }),
			});
			assert.equal(code, 1);
			const error = test.runs.get(test.source.runId)?.error ?? "";
			assert.match(error, /prior-error/u);
			assert.match(error, /affected-peer/u);
			assert.ok(error.length <= 2000, `durable error length ${error.length}`);
		} finally { test.close(); }
	});

	it("keeps the hosted report when host cleanup fails", async () => {
		const test = controlFixture();
		try {
			const code = await executeDetachedRun(test.source, {
				...test.options,
				createHost: async () => ({ open: async () => test.worker, close: async () => { test.calls.push("host-close"); throw new Error("host close failed"); }, activeHostedSessionIds: () => ["cleanup-peer"] }),
			});
			assert.equal(code, 1);
			const error = test.runs.get(test.source.runId)?.error ?? "";
			assert.match(error, /cleanup failed/u);
			assert.match(error, /cleanup-peer/u);
		} finally { test.close(); }
	});

	it("cleans up startup failures without admitting input", async () => {
		const test = controlFixture();
		try {
			const code = await executeDetachedRun(test.source, { ...test.options, createControlServer: async () => { throw new Error("listener failed"); } });
			assert.equal(code, 1);
			assert.deepEqual(test.calls, ["unsubscribe", "host-close"]);
			assert.equal(test.runs.get(test.source.runId)?.error, "listener failed");
		} finally { test.close(); }
	});

	it("replays remote abort after delayed admission and rejects early steer", async (t) => {
		const test = controlFixture();
		try {
			const entered = deferred();
			const admission = deferred();
			let control!: DetachedControlServerOptions;
			t.mock.method(test.worker, "start", async () => { entered.resolve(); await admission.promise; return "initial"; });
			const execution = executeDetachedRun(test.source, { ...test.options, createControlServer: async (options) => {
				control = options;
				assert.equal(control.canSteer(), false);
				return test.options.createControlServer(options);
			} });
			await entered.promise;
			assert.equal(control.canSteer(), false);
			await control.requestAbort();
			await control.requestAbort();
			assert.equal(test.calls.filter((call) => call === "abort").length, 1);
			admission.resolve();
			assert.equal(await execution, 1);
			assert.equal(test.calls.filter((call) => call === "abort").length, 2);
			assert.equal(control.canSteer(), false);
			assert.equal(test.runs.get(test.source.runId)?.error, "run stopped by remote abort");
		} finally { test.close(); }
	});

	it("drains a delayed control and retains unconsumed queues after the second idle", async () => {
		const test = controlFixture();
		try {
			const sealing = deferred();
			const drained = deferred();
			let control!: DetachedControlServerOptions;
			const execution = executeDetachedRun(test.source, { ...test.options, createControlServer: async (options) => {
				control = options;
				return {
					sealAndDrain: async () => { test.calls.push("seal"); sealing.resolve(); await drained.promise; },
					close: async () => { test.calls.push("control-close"); },
				};
			} });
			await sealing.promise;
			assert.equal(control.canSteer(), false);
			assert.equal(test.calls.filter((call) => call === "idle").length, 1);
			assert.equal(existsSync(test.runs.resultFile(test.source.runId)), false);
			test.snapshot.pending = 1;
			drained.resolve();
			assert.equal(await execution, 1);
			assert.equal(test.calls.filter((call) => call === "idle").length, 2);
			assert.equal(test.snapshot.pending, 1);
			assert.match(test.runs.get(test.source.runId)?.error ?? "", /1 queued messages remain unconsumed; ordinary queues do not survive process exit/u);
		} finally { test.close(); }
	});

	it("checks terminal status while retaining the first failure without reading a later error", async (t) => {
		const test = controlFixture();
		let statusReads = 0;
		t.mock.method(test.worker, "setOnUpdate", (callback: Parameters<AgentWorkerSession["setOnUpdate"]>[0]) => {
			callback?.({ kind: "error", message: "first failure" });
		});
		t.mock.method(test.worker, "operationResult", async () => ({
			...defined(operationOutcome("failed")),
			get status() { statusReads += 1; return "failed" as const; },
			get error() { return assert.fail("An earlier failure prevents error fallback evaluation"); },
		}));
		try {
			assert.equal(await executeDetachedRun(test.source, test.options), 1);
			assert.equal(statusReads, 1);
			assert.equal(test.runs.get(test.source.runId)?.error, "first failure");
		} finally { test.close(); }
	});

	it("preserves failure and current-run summary when endpoint cleanup fails", async (t) => {
		const test = controlFixture();
		try {
			t.mock.method(test.worker, "start", async () => {
				test.entries.push({ id: "current", type: "message", message: { role: "assistant", content: [{ type: "text", text: "Current reply" }] } } as SessionEntry);
				return "initial";
			});
			t.mock.method(test.worker, "lastErrorMessage", () => "execution failed");
			const code = await executeDetachedRun(test.source, { ...test.options, createControlServer: async () => ({
				sealAndDrain: async () => undefined,
				close: async () => { assert.equal(existsSync(test.runs.resultFile(test.source.runId)), false); throw new Error("socket close failed"); },
			}) });
			assert.equal(code, 1);
			assert.equal(test.calls.at(-1), "host-close");
			assert.equal(test.runs.get(test.source.runId)?.error, "execution failed; control cleanup failed: socket close failed");
			assert.equal(test.runs.get(test.source.runId)?.summary, "Current reply");
		} finally { test.close(); }
	});

	it("waits for endpoint cleanup before worker cleanup and result publication", async () => {
		const test = controlFixture();
		try {
			const closing = deferred();
			const closed = deferred();
			const execution = executeDetachedRun(test.source, { ...test.options, createControlServer: async () => ({
				sealAndDrain: async () => undefined,
				close: async () => { closing.resolve(); await closed.promise; },
			}) });
			await closing.promise;
			assert.equal(test.calls.includes("host-close"), false);
			assert.equal(existsSync(test.runs.resultFile(test.source.runId)), false);
			closed.resolve();
			assert.equal(await execution, 0);
			assert.equal(test.calls.at(-1), "host-close");
		} finally { test.close(); }
	});
});

describe("detached run process", () => {
	it("waits for active cancellation and host cleanup before terminal publication", async () => {
		const root = base();
		try {
			const runs = new DetachedRuns(root);
			const source = request(runs, root, { runId: "cancel", sessionId: "session", pid: process.pid });
			runs.writeRequest(source);
			const abort = new AbortController();
			const started = deferred();
			const idle = deferred();
			const closing = deferred();
			const cleaned = deferred();
			let aborts = 0;
			const snapshot: WorkerObservation = { pending: 0 };
			const result = executeDetachedRun(source, { signal: abort.signal, createControlServer: noControlServer, createHost: async () => ({
				open: async () => ({
					...unusedControls,
					sessionManager: () => ({ getEntries: () => [] }),
					setOnUpdate: () => undefined,
					observe: () => () => undefined, observation: () => snapshot,
					start: async () => { started.resolve(); return "operation"; },
					waitForIdle: () => idle.promise,
					lastErrorMessage: () => undefined,
					operationResult: async () => ({ operationId: "operation", kind: "run", status: "aborted", fromTipId: null, tipId: null, startedAt: 0, endedAt: 1 }),
					abort: async () => { aborts += 1; await idle.promise; return true; },
				}),
				close: async () => { closing.resolve(); await cleaned.promise; },
			}) });
			await started.promise;
			abort.abort(new Error("run stopped by SIGTERM"));
			assert.equal(existsSync(runs.resultFile(source.runId)), false);
			idle.resolve();
			await closing.promise;
			assert.ok(aborts >= 1);
			assert.equal(existsSync(runs.resultFile(source.runId)), false, "tool cleanup and host shutdown precede the result");
			cleaned.resolve();
			assert.equal(await result, 1);
			assert.equal(runs.get(source.runId)?.state, "failed");
			assert.match(runs.get(source.runId)?.error ?? "", /SIGTERM/u);
		} finally { rmSync(root, { recursive: true, force: true }); }
	});

	it("uses authoritative outcomes even when observer delivery omits the terminal error", async () => {
		const root = base();
		try {
			const runs = new DetachedRuns(root);
			for (const status of ["completed", "failed", "aborted", "missing"] as const) {
				const source = request(runs, root, { runId: status, sessionId: "session", pid: process.pid });
				runs.writeRequest(source);
				const snapshot: WorkerObservation = { pending: 0 };
				const code = await executeDetachedRun(source, { createControlServer: noControlServer, createHost: async () => ({
					open: async () => ({
						...unusedControls,
						sessionManager: () => ({ getEntries: () => [] }), setOnUpdate: () => undefined,
						observe: () => () => undefined, observation: () => snapshot,
						start: async () => "operation", waitForIdle: async () => undefined,
						lastErrorMessage: () => undefined, abort: async () => false,
						operationResult: async () => operationOutcome(status),
					}), close: async () => undefined,
				}) });
				assert.equal(code, status === "completed" ? 0 : 1);
				assert.equal(runs.get(status)?.state, status === "completed" ? "finished" : "failed");
				if (status === "failed") assert.equal(runs.get(status)?.error, "deterministic model failure");
				if (status === "aborted") assert.equal(runs.get(status)?.error, "operation aborted");
			}
		} finally { rmSync(root, { recursive: true, force: true }); }
	});

	it("summarizes only the current run, not historical replies after handled or failed input", async () => {
		const root = base();
		try {
			const runs = new DetachedRuns(root);
			for (const outcome of ["handled", "failed", "completed"] as const) {
				const source = request(runs, root, { runId: outcome, sessionId: "session", pid: process.pid });
				runs.writeRequest(source);
				const reply = (id: string, text: string) => ({ id, type: "message", message: { role: "assistant", content: [{ type: "text", text }] } }) as SessionEntry;
				const entries = [reply("prior", "This belongs to an earlier run")];
				const snapshot: WorkerObservation = { pending: 0 };
				const code = await executeDetachedRun(source, { createControlServer: noControlServer, createHost: async () => ({
					open: async () => ({
						...unusedControls,
						sessionManager: () => ({ getEntries: () => entries }), setOnUpdate: () => undefined,
						observe: () => () => undefined, observation: () => snapshot,
						start: async () => {
							if (outcome === "completed") entries.push(reply("current", "Current result"));
							return outcome === "handled" ? undefined : "operation";
						},
						waitForIdle: async () => undefined, lastErrorMessage: () => undefined, abort: async () => false,
						operationResult: async () => ({ operationId: "operation", kind: "run", status: outcome === "failed" ? "failed" : "completed", fromTipId: "prior", tipId: "current", startedAt: 0, endedAt: 1 }),
					}), close: async () => undefined,
				}) });
				assert.equal(code, outcome === "failed" ? 1 : 0);
				assert.equal(runs.get(outcome)?.summary, outcome === "completed" ? "Current result" : undefined);
				assert.equal(entries[0].id, "prior", "historical content remains intact");
			}
		} finally { rmSync(root, { recursive: true, force: true }); }
	});

	it("closes a partial host and records cleanup errors before its result", async () => {
		const root = base();
		try {
			const runs = new DetachedRuns(root);
			const source = request(runs, root, { runId: "partial", sessionId: "session", pid: process.pid });
			runs.writeRequest(source);
			let closed = false;
			assert.equal(await executeDetachedRun(source, { createHost: async () => ({
				open: async () => { throw new Error("open failed"); },
				close: async () => {
					assert.equal(existsSync(runs.resultFile(source.runId)), false);
					closed = true;
					throw new Error("resource close failed");
				},
			}) }), 1);
			assert.equal(closed, true);
			assert.match(runs.get(source.runId)?.error ?? "", /open failed; cleanup failed: resource close failed/u);
		} finally { rmSync(root, { recursive: true, force: true }); }
	});

	it("loads the ordinary extension host and preserves a deterministic provider failure in the child", { timeout: 60000 }, async () => {
		const root = base();
		const sessionsRoot = join(root, "sessions");
		const agentDir = join(root, "agent");
		mkdirSync(agentDir, { recursive: true });
		const fixture = join(root, "provider-fixture.ts");
		writeFileSync(fixture, `export default function(pi) {
			pi.registerProvider("detached-fixture", {
				baseUrl: "https://example.invalid", apiKey: "synthetic", api: "openai-completions",
				models: [{ id: "fixture", name: "Fixture", reasoning: false, input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 4096, maxTokens: 128 }],
				streamSimple: () => { throw new Error("deterministic provider failure"); }
			});
			pi.on("session_start", () => pi.appendEntry("fixture.start", { loaded: true }));
			pi.on("session_shutdown", () => pi.appendEntry("fixture.stop", { closed: true }));
		}`);
		const store = new AgentStore({ sessionsRoot });
		const manager = new AgentManager(store, await ModelRuntime.create({ refreshOnCreate: false }), new ProjectTrustStore(agentDir), undefined, agentDir);
		try {
			const created = await manager.spawn({ cwd: root, model: "detached-fixture/fixture", trust: true }, { cwd: root, model: null }, undefined, { extensionPaths: [fixture] });
			await manager.closeAll();
			await store.close(BACKGROUND_CONTEXT);
			const runs = new DetachedRuns(sessionsRoot);
			let completion: Promise<number> | undefined;
			await runs.start({ runId: "model-failure", sessionId: created.sessionId, sessionsRoot, agentDir, cwd: root, prompt: "test", trusted: true,
				spawn: (command, args, options) => {
					const child = spawn(command, args, options);
					completion = new Promise((resolve, reject) => {
						child.on("error", reject);
						child.on("exit", (status) => resolve(status ?? -1));
					});
					return child;
				},
			});
			assert.equal(await completion, 1);
			assert.equal(runs.get("model-failure")?.state, "failed");
			assert.match(runs.get("model-failure")?.error ?? "", /deterministic provider failure/u);
			const reopenedStore = new AgentStore({ sessionsRoot });
			try {
				const metadata = defined((await reopenedStore.list(BACKGROUND_CONTEXT)).find((entry) => entry.id === created.sessionId));
				const session = await reopenedStore.open(metadata, BACKGROUND_CONTEXT);
				try {
					const entries = session.manager.getEntries();
					assert.equal(entries.filter((entry) => entry.type === "custom" && entry.customType === "fixture.start").length, 2);
					assert.equal(entries.filter((entry) => entry.type === "custom" && entry.customType === "fixture.stop").length, 2);
				} finally { await session.close(BACKGROUND_CONTEXT); }
			} finally { await reopenedStore.close(BACKGROUND_CONTEXT); }
		} finally {
			await manager.closeAll();
			await store.close(BACKGROUND_CONTEXT);
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("keeps a child active after client disconnect and waits for abort cleanup", { timeout: 60000 }, async (t) => {
		const root = base();
		const sessionsRoot = join(root, "sessions");
		const agentDir = join(root, "agent");
		mkdirSync(agentDir);
		const ready = join(root, "provider-ready");
		const aborting = join(root, "provider-aborting");
		const release = join(root, "provider-release");
		const fixture = join(root, "control-provider.ts");
		writeFileSync(fixture, `import { createAssistantMessageEventStream } from ${JSON.stringify(import.meta.resolve("@earendil-works/pi-ai"))};
import { existsSync, unwatchFile, watchFile, writeFileSync } from "node:fs";
export default function(pi) {
	pi.registerProvider("control-fixture", {
		baseUrl: "https://example.invalid", apiKey: "synthetic", api: "openai-completions",
		models: [{ id: "fixture", name: "Fixture", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 4096, maxTokens: 128 }],
		streamSimple: (_model, _context, options) => {
			const stream = createAssistantMessageEventStream();
			const response = { role: "assistant", content: [], api: "openai-completions", provider: "control-fixture", model: "fixture", timestamp: 0, stopReason: "aborted", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
			stream.push({ type: "start", partial: response });
			writeFileSync(${JSON.stringify(ready)}, "ready");
			const stop = () => {
				writeFileSync(${JSON.stringify(aborting)}, "aborting");
				let finished = false;
				const finish = () => {
					if (finished || !existsSync(${JSON.stringify(release)})) return;
					finished = true;
					unwatchFile(${JSON.stringify(release)}, finish);
					stream.push({ type: "error", reason: "aborted", error: response }); stream.end(response);
				};
				// Cleanup follows the release file's state, not a lossy directory notification.
				watchFile(${JSON.stringify(release)}, { interval: 10 }, finish);
				finish();
			};
			if (options?.signal?.aborted) stop(); else options?.signal?.addEventListener("abort", stop, { once: true });
			return stream;
		},
	});
}`);
		const store = new AgentStore({ sessionsRoot });
		const manager = new AgentManager(store, await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, modelsStorePath: join(root, "models-cache"), refreshOnCreate: false }), new ProjectTrustStore(agentDir), undefined, agentDir);
		let child: ReturnType<typeof spawn> | undefined;
		let completion: Promise<number> | undefined;
		// A test timeout does not unwind an unresolved await in the test body.
		t.after(async () => {
			if (child && child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await completion; }
		});
		try {
			const created = await manager.spawn({ cwd: root, model: "control-fixture/fixture", trust: true }, { cwd: root, model: null }, undefined, { extensionPaths: [fixture] });
			const metadata = defined((await store.list(BACKGROUND_CONTEXT)).find((entry) => entry.id === created.sessionId));
			await manager.closeAll();
			await store.close(BACKGROUND_CONTEXT);
			const runs = new DetachedRuns(sessionsRoot);
			const started = await runs.start({ runId: "process-control", sessionId: created.sessionId, sessionsRoot, agentDir, cwd: root, prompt: "test", trusted: true,
				spawn: (command, args, options) => {
					const launched = spawn(command, args, { ...options, env: { PATH: process.env.PATH, HOME: root, PI_AGENT_DIR: agentDir, PI_AGENT_SESSIONS_DIR: sessionsRoot } });
					child = launched;
					completion = new Promise((resolve, reject) => {
						launched.on("error", reject);
						launched.on("exit", (code) => resolve(code ?? -1));
					});
					return launched;
				},
			});
			await waitForFile(ready, root);
			const status = await withDetachedControl(started, (control) => control.status());
			assert.ok(status.operation);
			const afterDisconnect = await withDetachedControl(started, (control) => control.status());
			assert.equal(afterDisconnect.operation, status.operation);
			const competing = new AgentStore({ sessionsRoot });
			try { await assert.rejects(competing.open(metadata, BACKGROUND_CONTEXT), /exclusive writer claim/u); }
			finally { await competing.close(BACKGROUND_CONTEXT); }
			assert.equal(await withDetachedControl(started, (control) => control.abort()), true);
			await waitForFile(aborting, root);
			assert.equal(existsSync(runs.resultFile(started.runId)), false, "provider cleanup precedes the terminal result");
			assert.equal(defined(child).exitCode, null);
			writeFileSync(release, "release");
			assert.equal(await completion, 1);
			assert.match(runs.get(started.runId)?.error ?? "", /run stopped by remote abort/u);
			assert.equal(existsSync(`${runs.requestFile(started.runId)}.control.json`), false);
			const reopened = new AgentStore({ sessionsRoot });
			try { const session = await reopened.open(metadata, BACKGROUND_CONTEXT); await session.close(BACKGROUND_CONTEXT); }
			finally { await reopened.close(BACKGROUND_CONTEXT); }
		} finally {
			if (child && child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await completion; }
			await manager.closeAll();
			await store.close(BACKGROUND_CONTEXT);
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("publishes a failed result when the session is missing, without a provider", { timeout: 60000 }, async () => {
		const root = base();
		try {
			const sessionsRoot = join(root, "sessions");
			mkdirSync(sessionsRoot, { recursive: true });
			const runs = new DetachedRuns(sessionsRoot);
			let completion: Promise<number> | undefined;
			await runs.start({ runId: "run-live", sessionId: "session-absent", sessionsRoot, agentDir: join(root, "agent"), cwd: root, prompt: "test",
				spawn: (command, args, options) => {
					const child = spawn(command, args, options);
					completion = new Promise((resolve, reject) => {
						child.on("error", reject);
						child.on("exit", (status) => resolve(status ?? -1));
					});
					return child;
				},
			});
			const code = await completion;
			assert.equal(code, 1);
			const view = runs.get("run-live");
			assert.equal(view?.state, "failed");
			assert.match(view?.error ?? "", /no agent session session-absent/u);
			assert.equal(view?.progress?.runId, "run-live");
			assert.equal(view?.progress?.entryCount, 0);
			assert.equal(view?.progress?.error, view?.error);
			assert.equal(view?.progress?.currentTool, undefined);
			const finishedView = defined(view);
			assert.ok(Date.parse(defined(finishedView.progress).updatedAt) <= Date.parse(defined(finishedView.finishedAt)));
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
