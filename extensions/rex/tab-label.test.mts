import assert from "node:assert/strict";
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, unlink, utimes, writeFile, type FileHandle } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createTabLabelProjector, sanitizeTabLabel, type TabLabelProjector } from "./tab-label.ts";
import type { CliCall, CliResult, RexTransport, TransportOutcome } from "./transport.ts";

const WINDOW_ID = "window:00000000c5f1edd9";
const DEFAULT_LABEL = "Window c5f1edd9";
const SETTINGS = { executable: "rex", maxOutputBytes: 32768, maxWaitMs: 1000 };

interface Deferred {
	promise: Promise<void>;
	resolve: () => void;
}

function deferred(): Deferred {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => { resolve = done; });
	return { promise, resolve };
}

interface TabState {
	label: string;
}

interface SetterPlan {
	outcome: TransportOutcome;
	started: boolean;
	exitCode?: number | null;
	apply: boolean;
}

function response(value: unknown): CliResult {
	return { outcome: "exited", exitCode: 0, signal: null, stdout: JSON.stringify(value), stderr: "", bytes: 0, truncated: false, started: true };
}

class FakeTransport implements RexTransport {
	readonly calls: Array<{ method: string; args: readonly string[]; signal?: AbortSignal }> = [];
	readonly tab: TabState;
	processPid = 4242;
	extraBlocks = 0;
	failWhoami = false;
	disposals = 0;
	onMethod: ((method: string) => void | Promise<void>) | undefined;
	readonly env: NodeJS.ProcessEnv;
	private readonly setPlans: SetterPlan[] = [];

	constructor(env: NodeJS.ProcessEnv, tab: TabState = { label: DEFAULT_LABEL }) {
		this.env = env;
		this.tab = tab;
	}

	get label(): string { return this.tab.label; }
	set label(value: string) { this.tab.label = value; }

	queueSet(plan: SetterPlan): void { this.setPlans.push(plan); }

	async run(args: readonly string[], call: CliCall): Promise<CliResult> {
		const method = args.includes("whoami") ? "whoami" : args.at(-2) ?? "";
		this.calls.push({ method, args, signal: call.signal });
		await this.onMethod?.(method);
		if (call.signal?.aborted) return { ...response({}), outcome: "cancelled", exitCode: null };
		if (method === "whoami") return this.whoami();
		if (method === "com.superlogical.terminal.process") return response({ foreground: { pid: this.processPid }, last_exit: null });
		if (method === "session.view") return this.view();
		if (method === "session.set_window_label") return this.setLabel(args);
		throw new Error(`Unexpected Rex method: ${method}`);
	}

	private whoami(): CliResult {
		if (this.failWhoami) return { ...response({}), exitCode: 1, stderr: "unavailable" };
		return response({ host_id: "host", instance_id: "instance" });
	}

	private view(): CliResult {
		const blocks = [
			{ block_id: this.env.REX_BLOCK },
			...Array.from({ length: this.extraBlocks }, (_, index) => ({ block_id: `block:extra-${index}` })),
		];
		return response({ revision: 1, session_id: this.env.REX_SESSION, windows: [{ window_id: WINDOW_ID, label: this.tab.label, layers: [{ blocks }] }] });
	}

	private setLabel(args: readonly string[]): CliResult {
		const input = JSON.parse(args.at(-1) ?? "{}") as { label: string };
		const plan = this.setPlans.shift();
		if (plan?.apply !== false) this.tab.label = input.label;
		if (!plan) return response({ revision: 2 });
		return {
			...response({}),
			outcome: plan.outcome,
			exitCode: plan.exitCode ?? null,
			stdout: "",
			stderr: plan.outcome === "exited" ? "" : "setter did not complete",
			started: plan.started,
		};
	}

	dispose(): void { this.disposals++; }

	get writes(): string[] {
		return this.calls.filter((call) => call.method === "session.set_window_label").map((call) => (JSON.parse(call.args.at(-1) ?? "{}") as { label: string }).label);
	}
}

function context(mode: ExtensionContext["mode"] = "tui", notify: (message: string) => void = () => {}): ExtensionContext {
	return { mode, cwd: "/work/fallback", ui: { notify } } as unknown as ExtensionContext;
}

async function fixture(t: TestContext, options: { mode?: ExtensionContext["mode"]; block?: boolean; maxRecords?: number; now?: () => Date; tab?: TabState } = {}) {
	const agentDir = await mkdtemp(join(tmpdir(), "rex-tab-label-"));
	const env: NodeJS.ProcessEnv = {
		REX_SERVER: "unix:///launch",
		REX_SESSION: "session:test",
		...(options.block === false ? {} : { REX_BLOCK: "block:test" }),
	};
	const transport = new FakeTransport(env, options.tab);
	const notices: string[] = [];
	const ctx = context(options.mode ?? "tui", (message: string) => { notices.push(message); });
	const state = { name: undefined as string | undefined };
	const projector = createTabLabelProjector({
		agentDir,
		settings: SETTINGS,
		env,
		pid: 4242,
		maxRecords: options.maxRecords,
		now: options.now,
		getSessionName: () => state.name,
		createTransport: () => transport,
	});
	t.after(async () => {
		await projector.shutdown();
		await rm(agentDir, { recursive: true, force: true });
	});
	return { agentDir, env, transport, notices, ctx, state, projector };
}

async function recordFiles(agentDir: string): Promise<StoredForTest[]> {
	const directory = join(agentDir, "rex", "tab-labels");
	let names: string[];
	try { names = await readdir(directory); }
	catch { return []; }
	return Promise.all(names.filter((name) => name.endsWith(".json")).map(async (name) => JSON.parse(await readFile(join(directory, name), "utf8")) as StoredForTest));
}

async function lockFiles(agentDir: string): Promise<string[]> {
	const directory = join(agentDir, "rex", "tab-labels");
	try { return (await readdir(directory)).filter((name) => name.endsWith(".lock")); }
	catch { return []; }
}

interface StoredForTest {
	version: number;
	label?: string;
	pending?: string;
	attempt?: string;
	hostId: string;
	instanceId: string;
	sessionId: string;
	windowId: string;
	blockId: string;
	updatedAt: string;
}

function projectorFor(agentDir: string, env: NodeJS.ProcessEnv, transport: RexTransport, name: () => string | undefined): TabLabelProjector {
	return createTabLabelProjector({
		agentDir,
		settings: SETTINGS,
		env,
		pid: 4242,
		getSessionName: name,
		createTransport: () => transport,
	});
}

const MUTABLE_PROMISES = fs.promises as unknown as {
	open: typeof import("node:fs/promises").open;
	mkdir: (path: string, options?: { recursive?: boolean; mode?: number }) => Promise<string | undefined>;
	rename: typeof import("node:fs/promises").rename;
};

// macOS open(2) flag: take a flock-style exclusive lock atomically with the open.
const O_EXLOCK = 0x20;

interface Fault {
	armed: boolean;
	restore(): void;
}

/** Pauses the close of the next record snapshot read, so the record lock stays held there. */
function pauseNextRecordRead(entered: () => void, release: Promise<void>): Fault {
	const fault: Fault = { armed: false, restore: () => {} };
	const original = MUTABLE_PROMISES.open;
	const patched: typeof original = async (...args) => {
		const handle = await original(...args);
		if (!fault.armed || !String(args[0]).endsWith(".json")) return handle;
		fault.armed = false;
		const close = handle.close.bind(handle);
		handle.close = async () => {
			entered();
			await release;
			await close();
		};
		return handle;
	};
	MUTABLE_PROMISES.open = patched;
	syncBuiltinESMExports();
	fault.restore = () => { MUTABLE_PROMISES.open = original; syncBuiltinESMExports(); };
	return fault;
}

/**
 * Replaces the lock path with a successor's locked file right after an acquirer opens it.
 * The successor's handle stays open, so later attempts meet its lock.
 */
function stealNextLock(held: { handle?: FileHandle }): Fault {
	const fault: Fault = { armed: false, restore: () => {} };
	const original = MUTABLE_PROMISES.open;
	const patched: typeof original = async (...args) => {
		const handle = await original(...args);
		if (fault.armed && String(args[0]).endsWith(".lock")) {
			fault.armed = false;
			const lockPath = String(args[0]);
			await unlink(lockPath);
			held.handle = await original(lockPath, fs.constants.O_RDWR | fs.constants.O_CREAT | O_EXLOCK | fs.constants.O_NONBLOCK, 0o600);
		}
		return handle;
	};
	MUTABLE_PROMISES.open = patched;
	syncBuiltinESMExports();
	fault.restore = () => { MUTABLE_PROMISES.open = original; syncBuiltinESMExports(); };
	return fault;
}

/** Pauses the next store directory creation, before a step acquires its record lock. */
function pauseNextDirectoryCreate(directory: string, entered: () => void, release: Promise<void>): Fault {
	const fault: Fault = { armed: false, restore: () => {} };
	const original = MUTABLE_PROMISES.mkdir;
	const patched: typeof original = async (...args) => {
		if (fault.armed && String(args[0]) === directory) {
			fault.armed = false;
			entered();
			await release;
		}
		return original(...args);
	};
	MUTABLE_PROMISES.mkdir = patched;
	syncBuiltinESMExports();
	fault.restore = () => { MUTABLE_PROMISES.mkdir = original; syncBuiltinESMExports(); };
	return fault;
}

/** Runs a callback after the next record rename, with the claim already persisted. */
function afterNextRecordRename(directory: string, done: () => void): () => void {
	const original = MUTABLE_PROMISES.rename;
	let fired = false;
	const patched: typeof original = async (...args) => {
		await original(...args);
		if (!fired && String(args[1]).startsWith(directory)) {
			fired = true;
			done();
		}
	};
	MUTABLE_PROMISES.rename = patched;
	syncBuiltinESMExports();
	return () => { MUTABLE_PROMISES.rename = original; syncBuiltinESMExports(); };
}

interface ChildLines {
	next(expected: string): Promise<void>;
}

function childLines(stream: NodeJS.ReadableStream): ChildLines {
	let text = "";
	const lines: string[] = [];
	const waiters: Array<{ expected: string; resolve: () => void; reject: (error: Error) => void }> = [];
	const settle = () => {
		while (waiters.length > 0 && lines.length > 0) {
			const waiter = waiters.shift();
			const line = lines.shift();
			if (!waiter || line === undefined) return;
			if (line === waiter.expected) waiter.resolve();
			else waiter.reject(new Error(`Expected child line ${waiter.expected}, received ${line}`));
		}
	};
	stream.on("data", (chunk: Buffer) => {
		text += chunk.toString("utf8");
		for (;;) {
			const index = text.indexOf("\n");
			if (index < 0) break;
			lines.push(text.slice(0, index));
			text = text.slice(index + 1);
		}
		settle();
	});
	stream.once("close", () => {
		for (const waiter of waiters.splice(0)) waiter.reject(new Error(`Child ended before ${waiter.expected}`));
	});
	return {
		next(expected: string): Promise<void> {
			return new Promise<void>((resolve, reject) => {
				waiters.push({ expected, resolve, reject });
				settle();
			});
		},
	};
}

test("sanitizes control and format characters and bounds code points", () => {
	assert.equal(sanitizeTabLabel("  A\u200b\u202e\n\t B  "), "A B");
	assert.equal(sanitizeTabLabel("😀".repeat(129)), "😀".repeat(128));
	assert.equal(sanitizeTabLabel("\u200b\u202e\n"), "");
});

test("a label cut at whitespace ends without a trailing space", () => {
	assert.equal(sanitizeTabLabel(`${"a".repeat(127)} rest`), "a".repeat(127));
	assert.equal(sanitizeTabLabel(`${"a".repeat(127)}  `), "a".repeat(127));
	assert.equal(sanitizeTabLabel(` ${"😀".repeat(127)} tail`), "😀".repeat(127));
});

test("sanitising a label twice returns the first result", () => {
	for (const input of [`${"a".repeat(127)} rest`, "x\u200b\u202e\ty", "😀".repeat(129), "  A   B  ", "\u0000\u007f"]) {
		const once = sanitizeTabLabel(input);
		assert.equal(sanitizeTabLabel(once), once);
	}
});

test("default and recorded automatic labels accept updates and repeated input observes without writing", async (t) => {
	const f = await fixture(t);
	f.projector.start(f.ctx);
	await f.projector.idle();
	assert.deepEqual(f.transport.writes, ["fallback"]);
	assert.deepEqual(f.transport.calls[0]?.args.slice(0, 6), ["--autostart=false", "--color=never", "--timeout=10s", "--server", "unix:///launch", "whoami"]);

	const settledCalls = f.transport.calls.length;
	f.projector.input(f.ctx);
	await f.projector.idle();
	assert.deepEqual(f.transport.calls.slice(settledCalls).map((call) => call.method), ["whoami", "com.superlogical.terminal.process", "session.view"]);
	assert.deepEqual(f.transport.writes, ["fallback"]);

	f.state.name = "Named";
	f.projector.refresh(f.ctx);
	await f.projector.idle();
	assert.deepEqual(f.transport.writes, ["fallback", "Named"]);
	const [record] = await recordFiles(f.agentDir);
	assert.equal(record?.label, "Named");
	assert.equal(record?.pending, undefined);
	assert.equal(record?.attempt, undefined);
	assert.equal(record?.hostId, "host");
	assert.equal(record?.instanceId, "instance");
	assert.equal(record?.sessionId, "session:test");
	assert.equal(record?.windowId, WINDOW_ID);
	assert.equal(record?.blockId, "block:test");

	f.state.name = "Latest";
	f.projector.input(f.ctx);
	await f.projector.idle();
	assert.deepEqual(f.transport.writes, ["fallback", "Named", "Latest"]);
});

const CHECKS = ["whoami", "com.superlogical.terminal.process", "session.view"];

test("an unchanged name event launches no process and every input keeps three fresh checks", async (t) => {
	const f = await fixture(t);
	f.projector.start(f.ctx);
	await f.projector.idle();
	assert.deepEqual(f.transport.calls.map((call) => call.method), [...CHECKS, "session.set_window_label"]);

	const settled = f.transport.calls.length;
	f.projector.refresh(f.ctx);
	f.projector.refresh(f.ctx);
	await f.projector.idle();
	assert.equal(f.transport.calls.length, settled);

	for (let index = 1; index <= 2; index++) {
		f.projector.input(f.ctx);
		await f.projector.idle();
		assert.deepEqual(f.transport.calls.slice(settled + (index - 1) * CHECKS.length, settled + index * CHECKS.length).map((call) => call.method), CHECKS);
	}
	assert.equal(f.transport.calls.length, settled + 2 * CHECKS.length);
	assert.deepEqual(f.transport.writes, ["fallback"]);
});

test("coincident start and input share one observation pass", async (t) => {
	const f = await fixture(t);
	f.projector.start(f.ctx);
	f.projector.input(f.ctx);
	await f.projector.idle();
	assert.deepEqual(f.transport.calls.map((call) => call.method), [...CHECKS, "session.set_window_label"]);
	assert.deepEqual(f.transport.writes, ["fallback"]);
});

test("an unchanged name event during an observation pass adds no pass", async (t) => {
	const f = await fixture(t);
	const entered = deferred();
	const release = deferred();
	f.transport.onMethod = async (method) => {
		if (method === "session.view") {
			entered.resolve();
			await release.promise;
		}
	};
	f.projector.start(f.ctx);
	await entered.promise;
	f.projector.refresh(f.ctx);
	release.resolve();
	await f.projector.idle();
	assert.deepEqual(f.transport.calls.map((call) => call.method), [...CHECKS, "session.set_window_label"]);
	assert.deepEqual(f.transport.writes, ["fallback"]);
});

test("an input during an observation pass receives its own fresh pass", async (t) => {
	const f = await fixture(t);
	const entered = deferred();
	const release = deferred();
	let blocked = false;
	f.transport.onMethod = async (method) => {
		if (method === "session.view" && !blocked) {
			blocked = true;
			entered.resolve();
			await release.promise;
		}
	};
	f.projector.start(f.ctx);
	await entered.promise;
	f.projector.input(f.ctx);
	release.resolve();
	await f.projector.idle();
	assert.deepEqual(f.transport.calls.map((call) => call.method), [...CHECKS, "session.set_window_label", ...CHECKS]);
	assert.deepEqual(f.transport.writes, ["fallback"]);
});

test("manual divergence removes provenance and the restored default resumes management", async (t) => {
	const f = await fixture(t);
	f.projector.start(f.ctx);
	await f.projector.idle();
	f.transport.label = "Manual";
	f.projector.input(f.ctx);
	await f.projector.idle();
	assert.deepEqual(f.transport.writes, ["fallback"]);
	assert.deepEqual(await recordFiles(f.agentDir), []);

	f.transport.label = DEFAULT_LABEL;
	f.projector.input(f.ctx);
	await f.projector.idle();
	assert.deepEqual(f.transport.writes, ["fallback", "fallback"]);
	assert.equal(f.transport.label, "fallback");
});

test("an arbitrary label equal to the desired name is not adopted", async (t) => {
	const f = await fixture(t);
	f.transport.label = "fallback";
	f.projector.start(f.ctx);
	await f.projector.idle();
	assert.deepEqual(f.transport.writes, []);
	assert.deepEqual(await recordFiles(f.agentDir), []);
});

test("split windows and foreground mismatches never write", async (t) => {
	const f = await fixture(t);
	f.transport.extraBlocks = 1;
	f.projector.start(f.ctx);
	await f.projector.idle();
	assert.deepEqual(f.transport.writes, []);
	assert.equal(f.transport.calls.at(-1)?.method, "session.view");

	f.transport.extraBlocks = 0;
	f.transport.processPid = 999;
	f.projector.input(f.ctx);
	await f.projector.idle();
	assert.deepEqual(f.transport.writes, []);
	assert.equal(f.transport.calls.at(-1)?.method, "com.superlogical.terminal.process");
});

test("noninteractive modes and a missing inherited block make no CLI calls", async (t) => {
	const rpc = await fixture(t, { mode: "rpc" });
	rpc.projector.start(rpc.ctx);
	await rpc.projector.idle();
	assert.equal(rpc.transport.calls.length, 0);
	rpc.ctx.mode = "print";
	rpc.projector.refresh(rpc.ctx);
	await rpc.projector.idle();
	assert.equal(rpc.transport.calls.length, 0);

	const missing = await fixture(t, { block: false });
	missing.projector.start(missing.ctx);
	await missing.projector.idle();
	assert.equal(missing.transport.calls.length, 0);
});

test("an uncertain write reconciles from pending without a repeated effect", async (t) => {
	const f = await fixture(t);
	f.transport.queueSet({ outcome: "timeout", started: true, apply: true });
	f.projector.start(f.ctx);
	await f.projector.idle();
	assert.deepEqual(f.transport.writes, ["fallback"]);
	assert.equal(f.notices.length, 1);
	const [pending] = await recordFiles(f.agentDir);
	assert.equal(pending?.pending, "fallback");
	assert.equal(pending?.label, undefined);
	assert.ok(pending?.attempt);

	f.projector.input(f.ctx);
	await f.projector.idle();
	assert.deepEqual(f.transport.writes, ["fallback"]);
	const [confirmed] = await recordFiles(f.agentDir);
	assert.equal(confirmed?.label, "fallback");
	assert.equal(confirmed?.pending, undefined);
	assert.equal(confirmed?.attempt, undefined);
});

test("a setter that never started does not grant management of a manual label", async (t) => {
	const f = await fixture(t);
	f.state.name = "Attempted name";
	f.transport.queueSet({ outcome: "spawn_error", started: false, apply: false });
	f.projector.start(f.ctx);
	await f.projector.idle();
	assert.deepEqual(f.transport.writes, ["Attempted name"]);
	assert.equal(f.transport.label, DEFAULT_LABEL);
	assert.deepEqual(await recordFiles(f.agentDir), []);
	assert.equal(f.notices.length, 1);

	f.transport.label = "Attempted name";
	f.state.name = "New Pi name";
	f.projector.input(f.ctx);
	await f.projector.idle();
	assert.deepEqual(f.transport.writes, ["Attempted name"]);
	assert.equal(f.transport.label, "Attempted name");
	assert.deepEqual(await recordFiles(f.agentDir), []);
});

test("a never-started setter keeps the earlier confirmed projection", async (t) => {
	const f = await fixture(t);
	f.projector.start(f.ctx);
	await f.projector.idle();
	assert.deepEqual(f.transport.writes, ["fallback"]);

	f.state.name = "Attempted name";
	f.transport.queueSet({ outcome: "cancelled", started: false, apply: false });
	f.projector.refresh(f.ctx);
	await f.projector.idle();
	assert.deepEqual(f.transport.writes, ["fallback", "Attempted name"]);
	const [record] = await recordFiles(f.agentDir);
	assert.equal(record?.label, "fallback");
	assert.equal(record?.pending, undefined);
	assert.equal(record?.attempt, undefined);

	f.state.name = "Next name";
	f.projector.input(f.ctx);
	await f.projector.idle();
	assert.deepEqual(f.transport.writes, ["fallback", "Attempted name", "Next name"]);
	assert.equal(f.transport.label, "Next name");
	const [confirmed] = await recordFiles(f.agentDir);
	assert.equal(confirmed?.label, "Next name");
});

test("a claim write that fails after persistence withdraws the claim before dispatch", async (t) => {
	const f = await fixture(t, { maxRecords: 1 });
	const directory = join(f.agentDir, "rex", "tab-labels");
	// An older entry that cannot be unlinked makes pruning fail after the claim's atomic rename.
	const blocker = join(directory, `${"0".repeat(64)}.json`);
	await mkdir(blocker, { recursive: true });
	await utimes(blocker, new Date(1000), new Date(1000));
	f.state.name = "Attempted name";
	f.projector.start(f.ctx);
	await f.projector.idle();
	assert.deepEqual(f.transport.writes, []);
	assert.equal(f.transport.label, DEFAULT_LABEL);
	assert.deepEqual((await readdir(directory)).filter((name) => join(directory, name) !== blocker), []);
	assert.equal(f.notices.length, 1);

	f.transport.label = "Attempted name";
	f.state.name = "New Pi name";
	f.projector.input(f.ctx);
	await f.projector.idle();
	assert.deepEqual(f.transport.writes, []);
	assert.equal(f.transport.label, "Attempted name");
});

test("a run cancelled after its claim is persisted withdraws the claim before dispatch", async (t) => {
	const f = await fixture(t);
	const projector = f.projector;
	const restore = afterNextRecordRename(join(f.agentDir, "rex", "tab-labels"), () => { void projector.shutdown(); });
	t.after(restore);
	f.state.name = "Attempted name";
	f.projector.start(f.ctx);
	await f.projector.idle();
	assert.deepEqual(f.transport.writes, []);
	assert.equal(f.transport.label, DEFAULT_LABEL);
	assert.deepEqual(await recordFiles(f.agentDir), []);
	assert.deepEqual(f.notices, []);

	f.transport.label = "Attempted name";
	f.state.name = "New Pi name";
	f.projector.start(f.ctx);
	await f.projector.idle();
	assert.deepEqual(f.transport.writes, []);
	assert.equal(f.transport.label, "Attempted name");
	assert.deepEqual(await recordFiles(f.agentDir), []);
});

test("a delayed no-effect cleanup leaves a newer valid claim intact", async (t) => {
	const tab: TabState = { label: DEFAULT_LABEL };
	const f = await fixture(t, { tab });
	const secondTransport = new FakeTransport(f.env, tab);
	const secondState = { name: "Shared name" };
	const second = createTabLabelProjector({
		agentDir: f.agentDir,
		settings: SETTINGS,
		env: f.env,
		pid: 4242,
		getSessionName: () => secondState.name,
		createTransport: () => secondTransport,
	});
	t.after(() => second.shutdown());

	const entered = deferred();
	const release = deferred();
	let firstSetter = true;
	f.transport.onMethod = async (method) => {
		if (method === "session.set_window_label" && firstSetter) {
			firstSetter = false;
			entered.resolve();
			await release.promise;
		}
	};
	f.state.name = "Shared name";
	f.transport.queueSet({ outcome: "spawn_error", started: false, apply: false });
	f.projector.start(f.ctx);
	await entered.promise;

	secondTransport.queueSet({ outcome: "timeout", started: true, apply: true });
	second.start(f.ctx);
	await second.idle();
	const [newer] = await recordFiles(f.agentDir);
	assert.equal(newer?.pending, "Shared name");
	assert.ok(newer?.attempt);
	assert.equal(tab.label, "Shared name");

	release.resolve();
	await f.projector.idle();
	const [retained] = await recordFiles(f.agentDir);
	assert.deepEqual(retained, newer);

	second.input(f.ctx);
	await second.idle();
	const [reconciled] = await recordFiles(f.agentDir);
	assert.equal(reconciled?.label, "Shared name");
	assert.equal(reconciled?.pending, undefined);

	secondState.name = "Later name";
	second.input(f.ctx);
	await second.idle();
	assert.deepEqual(secondTransport.writes, ["Shared name", "Later name"]);
	assert.equal(tab.label, "Later name");
	await second.shutdown();
});

test("a name cut at whitespace keeps a valid record and later management", async (t) => {
	const f = await fixture(t);
	const truncated = "a".repeat(127);
	f.state.name = `${truncated} rest`;
	f.projector.start(f.ctx);
	await f.projector.idle();
	assert.deepEqual(f.transport.writes, [truncated]);
	const [record] = await recordFiles(f.agentDir);
	assert.equal(record?.label, truncated);
	assert.equal(record?.pending, undefined);

	f.state.name = "Next name";
	f.projector.input(f.ctx);
	await f.projector.idle();
	assert.deepEqual(f.transport.writes, [truncated, "Next name"]);

	const secondTransport = new FakeTransport(f.env);
	secondTransport.label = f.transport.label;
	const second = createTabLabelProjector({
		agentDir: f.agentDir,
		settings: SETTINGS,
		env: f.env,
		pid: 4242,
		getSessionName: () => "Later name",
		createTransport: () => secondTransport,
	});
	second.start(f.ctx);
	await second.idle();
	assert.deepEqual(secondTransport.writes, ["Later name"]);
	await second.shutdown();
});

test("an interactive input restores the default label after an external reset", async (t) => {
	const f = await fixture(t);
	f.state.name = "Named";
	f.projector.start(f.ctx);
	await f.projector.idle();
	assert.deepEqual(f.transport.writes, ["Named"]);

	f.transport.label = DEFAULT_LABEL;
	f.projector.input(f.ctx);
	await f.projector.idle();
	assert.deepEqual(f.transport.writes, ["Named", "Named"]);
	assert.equal(f.transport.label, "Named");
	const [record] = await recordFiles(f.agentDir);
	assert.equal(record?.label, "Named");
});

test("an interactive input leaves a manual label in place", async (t) => {
	const f = await fixture(t);
	f.state.name = "Named";
	f.projector.start(f.ctx);
	await f.projector.idle();
	assert.deepEqual(f.transport.writes, ["Named"]);

	f.transport.label = "Manual";
	f.projector.input(f.ctx);
	await f.projector.idle();
	assert.deepEqual(f.transport.writes, ["Named"]);
	assert.equal(f.transport.label, "Manual");
	assert.deepEqual(await recordFiles(f.agentDir), []);
});

test("a name change during an in-flight fallback write finishes with the new name", async (t) => {
	const f = await fixture(t);
	const entered = deferred();
	const release = deferred();
	f.transport.onMethod = async (method) => {
		if (method === "session.set_window_label" && f.transport.writes.length === 1) {
			entered.resolve();
			await release.promise;
		}
	};
	f.projector.start(f.ctx);
	await entered.promise;
	f.state.name = "New name";
	f.projector.refresh(f.ctx);
	release.resolve();
	await f.projector.idle();
	assert.deepEqual(f.transport.writes, ["fallback", "New name"]);
	assert.equal(f.transport.label, "New name");
	assert.deepEqual(f.transport.calls.map((call) => call.method), [...CHECKS, "session.set_window_label", ...CHECKS, "session.set_window_label"]);
});

test("a delayed startup read uses the latest session name at write time", async (t) => {
	const f = await fixture(t);
	const entered = deferred();
	const release = deferred();
	f.transport.onMethod = async (method) => {
		if (method === "session.view") {
			entered.resolve();
			await release.promise;
		}
	};
	f.projector.start(f.ctx);
	await entered.promise;
	f.state.name = "New name";
	f.projector.refresh(f.ctx);
	release.resolve();
	await f.projector.idle();
	assert.deepEqual(f.transport.writes, ["New name"]);
	assert.deepEqual(f.transport.calls.map((call) => call.method), [...CHECKS, "session.set_window_label"]);
});

test("shutdown and a new session invalidate an obsolete run before its write", async (t) => {
	const f = await fixture(t);
	const entered = deferred();
	const release = deferred();
	let blockFirstView = true;
	f.transport.onMethod = async (method) => {
		if (method === "session.view" && blockFirstView) {
			blockFirstView = false;
			entered.resolve();
			await release.promise;
		}
	};
	f.projector.start(f.ctx);
	await entered.promise;
	const stopped = f.projector.shutdown();
	f.state.name = "New session";
	f.projector.start(f.ctx);
	release.resolve();
	await stopped;
	await f.projector.idle();
	assert.deepEqual(f.transport.writes, ["New session"]);
	assert.equal(f.transport.disposals, 1);
});

test("real errors produce one bounded warning per runtime", async (t) => {
	const f = await fixture(t);
	f.transport.failWhoami = true;
	f.projector.start(f.ctx);
	await f.projector.idle();
	f.projector.input(f.ctx);
	await f.projector.idle();
	f.projector.start(f.ctx);
	await f.projector.idle();
	assert.equal(f.notices.length, 1);
	assert.match(f.notices[0] ?? "", /^Rex tab label update failed: /);
	assert.ok((f.notices[0]?.length ?? 0) < 300);
});

test("a fresh factory in the same pane updates the recorded label", async (t) => {
	const first = await fixture(t);
	first.projector.start(first.ctx);
	await first.projector.idle();
	await first.projector.shutdown();

	const secondTransport = new FakeTransport(first.env);
	secondTransport.label = first.transport.label;
	const second = createTabLabelProjector({
		agentDir: first.agentDir,
		settings: SETTINGS,
		env: first.env,
		pid: 4242,
		getSessionName: () => "Second",
		createTransport: () => secondTransport,
	});
	second.start(first.ctx);
	await second.idle();
	assert.deepEqual(secondTransport.writes, ["Second"]);
	await second.shutdown();
});

test("record pruning retains the configured bound", async (t) => {
	const first = await fixture(t, { maxRecords: 3 });
	for (let index = 0; index < 5; index++) {
		const env: NodeJS.ProcessEnv = { REX_SESSION: "session:test", REX_BLOCK: `block:${index}` };
		const transport = new FakeTransport(env);
		const projector = createTabLabelProjector({
			agentDir: first.agentDir,
			settings: SETTINGS,
			env,
			pid: 4242,
			maxRecords: 3,
			getSessionName: () => `Name ${index}`,
			createTransport: () => transport,
		});
		projector.start(first.ctx);
		await projector.idle();
		await projector.shutdown();
	}
	const records = await recordFiles(first.agentDir);
	assert.equal(records.length, 3);
	assert.equal(records.some((record) => record.label === "Name 4"), true);
});

async function delayedWithdrawalAfterReload(t: TestContext, prior: string | undefined): Promise<void> {
	const tab: TabState = { label: DEFAULT_LABEL };
	const first = await fixture(t, { tab });
	const secondTransport = new FakeTransport(first.env, tab);
	const secondNotices: string[] = [];
	const secondCtx = context("tui", (message: string) => { secondNotices.push(message); });
	const secondState = { name: "New name" };
	const second = projectorFor(first.agentDir, first.env, secondTransport, () => secondState.name);
	t.after(() => second.shutdown());

	if (prior !== undefined) {
		first.state.name = prior;
		first.projector.start(first.ctx);
		await first.projector.idle();
		assert.deepEqual(first.transport.writes, [prior]);
	}

	const entered = deferred();
	const release = deferred();
	t.after(release.resolve);
	const pause = pauseNextRecordRead(entered.resolve, release.promise);
	t.after(pause.restore);
	first.transport.onMethod = async (method) => {
		if (method === "session.set_window_label") pause.armed = true;
	};
	first.state.name = "Failed name";
	first.transport.queueSet({ outcome: "spawn_error", started: false, apply: false });
	if (prior === undefined) first.projector.start(first.ctx);
	else first.projector.refresh(first.ctx);
	await entered.promise;

	const [claim] = await recordFiles(first.agentDir);
	assert.ok(claim);
	assert.equal(claim.pending, "Failed name");
	assert.ok(claim.attempt);
	assert.equal(claim.label, prior);

	await first.projector.shutdown();
	second.start(secondCtx);
	await second.idle();
	assert.deepEqual(secondTransport.writes, []);
	assert.deepEqual(await recordFiles(first.agentDir), [claim]);
	assert.equal(secondNotices.length, 1);

	release.resolve();
	await first.projector.idle();
	const cleaned = await recordFiles(first.agentDir);
	if (prior === undefined) {
		assert.deepEqual(cleaned, []);
	} else {
		assert.equal(cleaned.length, 1);
		assert.equal(cleaned[0]?.label, prior);
		assert.equal(cleaned[0]?.pending, undefined);
		assert.equal(cleaned[0]?.attempt, undefined);
	}
	assert.deepEqual(first.notices, []);

	secondState.name = "New name";
	second.input(secondCtx);
	await second.idle();
	assert.deepEqual(secondTransport.writes, ["New name"]);
	assert.equal(tab.label, "New name");
	const [confirmed] = await recordFiles(first.agentDir);
	assert.equal(confirmed?.label, "New name");
	assert.equal(confirmed?.pending, undefined);
	assert.equal(confirmed?.attempt, undefined);

	secondState.name = "Later name";
	second.input(secondCtx);
	await second.idle();
	assert.deepEqual(secondTransport.writes, ["New name", "Later name"]);
	assert.equal(tab.label, "Later name");
	await second.shutdown();
}

test("a delayed withdrawal after reload cannot remove a replacement record", async (t) => {
	await delayedWithdrawalAfterReload(t, undefined);
});

test("a delayed withdrawal after reload cannot replace a replacement record", async (t) => {
	await delayedWithdrawalAfterReload(t, "Earlier label");
});

interface ChildProjector {
	agentDir: string;
	env: NodeJS.ProcessEnv;
	child: ChildProcessWithoutNullStreams;
	exited: Promise<[number | null, NodeJS.Signals | null]>;
	lines: ChildLines;
}

/** Starts a real projector in a child process and stops it when the test ends. */
async function startChildProjector(t: TestContext, prefix: string, name: string): Promise<ChildProjector> {
	const agentDir = await mkdtemp(join(tmpdir(), prefix));
	const env: NodeJS.ProcessEnv = { REX_SERVER: "unix:///launch", REX_SESSION: "session:test", REX_BLOCK: "block:test" };
	const child = spawn(process.execPath, [join(import.meta.dirname, "tab-label-process-fixture.mts"), agentDir, name], {
		env: { ...process.env, ...env },
		stdio: ["pipe", "pipe", "pipe"],
	}) as ChildProcessWithoutNullStreams;
	const exited = once(child, "exit") as Promise<[number | null, NodeJS.Signals | null]>;
	const lines = childLines(child.stdout);
	const killed = setTimeout(() => child.kill("SIGKILL"), 60_000);
	t.after(async () => {
		clearTimeout(killed);
		child.kill("SIGKILL");
		await rm(agentDir, { recursive: true, force: true });
	});
	return { agentDir, env, child, exited, lines };
}

/** A second projector on the same store, driven by the test and never started before it is ready. */
function replacementProjector(agentDir: string, env: NodeJS.ProcessEnv, tab: TabState, notices: string[], state: { name: string }) {
	const transport = new FakeTransport(env, tab);
	const ctx = context("tui", (message: string) => { notices.push(message); });
	const projector = createTabLabelProjector({
		agentDir,
		settings: SETTINGS,
		env,
		pid: 4242,
		getSessionName: () => state.name,
		createTransport: () => transport,
	});
	return { transport, ctx, projector };
}

test("a suspended holder keeps its record lock and every replacement update is refused", async (t) => {
	const child = await startChildProjector(t, "rex-tab-label-suspended-", "Failed name");
	await child.lines.next("paused");
	const [claim] = await recordFiles(child.agentDir);
	assert.ok(claim);
	assert.equal(claim.pending, "Failed name");
	assert.ok(claim.attempt);

	child.child.kill("SIGSTOP");
	const stoppedAt = Date.now();

	const tab: TabState = { label: DEFAULT_LABEL };
	const notices: string[] = [];
	const state = { name: "New name" };
	const { transport, ctx, projector } = replacementProjector(child.agentDir, child.env, tab, notices, state);
	t.after(() => projector.shutdown());

	// Each refused acquisition takes the bounded acquisition time, which advances the clock.
	projector.start(ctx);
	do {
		projector.input(ctx);
		await projector.idle();
		assert.deepEqual(transport.writes, []);
		assert.deepEqual(await recordFiles(child.agentDir), [claim]);
	} while (Date.now() - stoppedAt <= 11_000);
	assert.ok(Date.now() - stoppedAt > 11_000);

	child.child.kill("SIGCONT");
	child.child.stdin.write("go\n");
	await child.lines.next("done");
	const [code] = await child.exited;
	assert.equal(code, 0);
	assert.deepEqual(await recordFiles(child.agentDir), []);

	projector.input(ctx);
	await projector.idle();
	assert.deepEqual(transport.writes, ["New name"]);
	const [confirmed] = await recordFiles(child.agentDir);
	assert.equal(confirmed?.label, "New name");
	assert.equal(confirmed?.pending, undefined);

	state.name = "Later name";
	projector.input(ctx);
	await projector.idle();
	assert.deepEqual(transport.writes, ["New name", "Later name"]);
	assert.equal(tab.label, "Later name");
	await projector.shutdown();
});

test("a killed holder releases its record lock at once", async (t) => {
	const child = await startChildProjector(t, "rex-tab-label-killed-", "Failed name");
	await child.lines.next("paused");
	const [claim] = await recordFiles(child.agentDir);
	assert.ok(claim);
	assert.equal(claim.pending, "Failed name");

	child.child.kill("SIGKILL");
	const [code, signal] = await child.exited;
	assert.equal(code, null);
	assert.equal(signal, "SIGKILL");

	const tab: TabState = { label: DEFAULT_LABEL };
	const notices: string[] = [];
	const state = { name: "New name" };
	const { transport, ctx, projector } = replacementProjector(child.agentDir, child.env, tab, notices, state);
	t.after(() => projector.shutdown());

	projector.start(ctx);
	await projector.idle();
	assert.deepEqual(transport.writes, ["New name"]);
	assert.deepEqual(notices, []);
	const [confirmed] = await recordFiles(child.agentDir);
	assert.equal(confirmed?.label, "New name");
	assert.equal(confirmed?.pending, undefined);
	assert.deepEqual(await lockFiles(child.agentDir), []);

	state.name = "Later name";
	projector.input(ctx);
	await projector.idle();
	assert.deepEqual(transport.writes, ["New name", "Later name"]);
	assert.equal(tab.label, "Later name");
	await projector.shutdown();
});

test("a cancelled update waiting for a record lock makes no change", async (t) => {
	const tab: TabState = { label: DEFAULT_LABEL };
	const first = await fixture(t, { tab });
	const directory = join(first.agentDir, "rex", "tab-labels");
	const holderTransport = new FakeTransport(first.env, tab);
	const waiterTransport = new FakeTransport(first.env, tab);
	const holderState = { name: "Holder name" };
	const waiterState = { name: "Waiter name" };
	const holderNotices: string[] = [];
	const waiterNotices: string[] = [];
	const holderCtx = context("tui", (message: string) => { holderNotices.push(message); });
	const waiterCtx = context("tui", (message: string) => { waiterNotices.push(message); });
	const holder = projectorFor(first.agentDir, first.env, holderTransport, () => holderState.name);
	const waiter = projectorFor(first.agentDir, first.env, waiterTransport, () => waiterState.name);
	t.after(() => waiter.shutdown());

	holder.start(holderCtx);
	await holder.idle();
	assert.deepEqual(holderTransport.writes, ["Holder name"]);

	const readEntered = deferred();
	const readRelease = deferred();
	t.after(readRelease.resolve);
	const readPause = pauseNextRecordRead(readEntered.resolve, readRelease.promise);
	t.after(readPause.restore);
	readPause.armed = true;
	holder.input(holderCtx);
	await readEntered.promise;
	assert.equal((await lockFiles(first.agentDir)).length, 1);

	const createEntered = deferred();
	const createRelease = deferred();
	t.after(createRelease.resolve);
	const createPause = pauseNextDirectoryCreate(directory, createEntered.resolve, createRelease.promise);
	t.after(createPause.restore);
	createPause.armed = true;

	const viewed = deferred();
	waiterTransport.onMethod = async (method) => {
		if (method === "session.view") viewed.resolve();
	};
	waiter.start(waiterCtx);
	await viewed.promise;
	await createEntered.promise;

	const stopped = waiter.shutdown();
	readRelease.resolve();
	await holder.idle();
	createRelease.resolve();
	await stopped;
	await waiter.idle();

	assert.deepEqual(waiterTransport.writes, []);
	assert.equal(tab.label, "Holder name");
	const [record] = await recordFiles(first.agentDir);
	assert.equal(record?.label, "Holder name");
	assert.equal(record?.pending, undefined);
	assert.deepEqual(waiterNotices, []);
	assert.deepEqual(holderNotices, []);
	assert.deepEqual(await lockFiles(first.agentDir), []);
});

/** Uses the store's record name to derive the path of its lock file. */
function lockPathOf(directory: string, recordName: string): string {
	return join(directory, `${recordName.slice(0, -".json".length)}.lock`);
}

test("an acquisition that finds its lock path replaced refuses without a mutation", async (t) => {
	const f = await fixture(t);
	const directory = join(f.agentDir, "rex", "tab-labels");
	const held: { handle?: FileHandle } = {};
	const fault = stealNextLock(held);
	t.after(fault.restore);
	t.after(async () => { await held.handle?.close(); });
	fault.armed = true;

	f.state.name = "New name";
	f.projector.start(f.ctx);
	await f.projector.idle();

	assert.deepEqual(f.transport.writes, []);
	assert.deepEqual(await recordFiles(f.agentDir), []);
	assert.equal(f.notices.length, 1);
	assert.match(f.notices[0] ?? "", /held by another update/);
	const [lockName] = await lockFiles(f.agentDir);
	assert.ok(lockName);
	assert.ok(held.handle);
	assert.equal((await stat(join(directory, lockName))).ino, (await held.handle.stat()).ino);
});

test("a directory at the lock path refuses the update without changing the record", async (t) => {
	const f = await fixture(t);
	f.state.name = "First";
	f.projector.start(f.ctx);
	await f.projector.idle();
	await f.projector.shutdown();

	const directory = join(f.agentDir, "rex", "tab-labels");
	const recordName = (await readdir(directory)).find((name) => name.endsWith(".json"));
	assert.ok(recordName);
	const lockPath = lockPathOf(directory, recordName);
	await mkdir(lockPath);
	const before = await readFile(join(directory, recordName), "utf8");

	f.state.name = "Second";
	f.projector.start(f.ctx);
	await f.projector.idle();

	assert.deepEqual(f.transport.writes, ["First"]);
	assert.equal(f.notices.length, 1);
	assert.equal(await readFile(join(directory, recordName), "utf8"), before);
	assert.equal((await stat(lockPath)).isDirectory(), true);
});

test("an unlocked lock file left by a dead holder does not block an update", async (t) => {
	const f = await fixture(t);
	f.state.name = "First";
	f.projector.start(f.ctx);
	await f.projector.idle();
	await f.projector.shutdown();

	const directory = join(f.agentDir, "rex", "tab-labels");
	const recordName = (await readdir(directory)).find((name) => name.endsWith(".json"));
	assert.ok(recordName);
	await writeFile(lockPathOf(directory, recordName), "");

	f.state.name = "Second";
	f.projector.start(f.ctx);
	await f.projector.idle();

	assert.deepEqual(f.transport.writes, ["First", "Second"]);
	const [record] = await recordFiles(f.agentDir);
	assert.equal(record?.label, "Second");
	assert.deepEqual(await lockFiles(f.agentDir), []);
});
