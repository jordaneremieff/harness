import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createTabLabelProjector, sanitizeTabLabel } from "./tab-label.ts";
import type { CliCall, CliResult, RexTransport } from "./transport.ts";

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

function response(value: unknown): CliResult {
	return { outcome: "exited", exitCode: 0, signal: null, stdout: JSON.stringify(value), stderr: "", bytes: 0, truncated: false, started: true };
}

class FakeTransport implements RexTransport {
	readonly calls: Array<{ method: string; args: readonly string[]; signal?: AbortSignal }> = [];
	label = DEFAULT_LABEL;
	processPid = 4242;
	extraBlocks = 0;
	failWhoami = false;
	failNextSet = false;
	disposals = 0;
	onMethod: ((method: string) => void | Promise<void>) | undefined;
	readonly env: NodeJS.ProcessEnv;

	constructor(env: NodeJS.ProcessEnv) { this.env = env; }

	async run(args: readonly string[], call: CliCall): Promise<CliResult> {
		const method = args.includes("whoami") ? "whoami" : args.at(-2) ?? "";
		this.calls.push({ method, args, signal: call.signal });
		await this.onMethod?.(method);
		if (call.signal?.aborted) return { ...response({}), outcome: "cancelled", exitCode: null };
		if (method === "whoami") {
			if (this.failWhoami) return { ...response({}), exitCode: 1, stderr: "unavailable" };
			return response({ host_id: "host", instance_id: "instance" });
		}
		if (method === "com.superlogical.terminal.process") return response({ foreground: { pid: this.processPid }, last_exit: null });
		if (method === "session.view") {
			const blocks = [
				{ block_id: this.env.REX_BLOCK },
				...Array.from({ length: this.extraBlocks }, (_, index) => ({ block_id: `block:extra-${index}` })),
			];
			return response({ revision: 1, session_id: this.env.REX_SESSION, windows: [{ window_id: WINDOW_ID, label: this.label, layers: [{ blocks }] }] });
		}
		if (method === "session.set_window_label") {
			const input = JSON.parse(args.at(-1) ?? "{}") as { label: string };
			this.label = input.label;
			if (this.failNextSet) {
				this.failNextSet = false;
				return { ...response({}), outcome: "timeout", exitCode: null, stderr: "uncertain" };
			}
			return response({ revision: 2 });
		}
		throw new Error(`Unexpected Rex method: ${method}`);
	}

	dispose(): void { this.disposals++; }

	get writes(): string[] {
		return this.calls.filter((call) => call.method === "session.set_window_label").map((call) => (JSON.parse(call.args.at(-1) ?? "{}") as { label: string }).label);
	}
}

async function fixture(t: TestContext, options: { mode?: ExtensionContext["mode"]; block?: boolean; maxRecords?: number } = {}) {
	const agentDir = await mkdtemp(join(tmpdir(), "rex-tab-label-"));
	const env: NodeJS.ProcessEnv = {
		REX_SERVER: "unix:///launch",
		REX_SESSION: "session:test",
		...(options.block === false ? {} : { REX_BLOCK: "block:test" }),
	};
	const transport = new FakeTransport(env);
	const notices: string[] = [];
	const ctx = {
		mode: options.mode ?? "tui",
		cwd: "/work/fallback",
		ui: { notify: (message: string) => { notices.push(message); } },
	} as ExtensionContext;
	const state = { name: undefined as string | undefined };
	const projector = createTabLabelProjector({
		agentDir,
		settings: SETTINGS,
		env,
		pid: 4242,
		maxRecords: options.maxRecords,
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
	return Promise.all(names.map(async (name) => JSON.parse(await readFile(join(directory, name), "utf8")) as StoredForTest));
}

interface StoredForTest {
	version: number;
	label?: string;
	pending?: string;
	hostId: string;
	instanceId: string;
	sessionId: string;
	windowId: string;
	blockId: string;
	updatedAt: string;
}

test("sanitizes control and format characters and bounds code points", () => {
	assert.equal(sanitizeTabLabel("  A\u200b\u202e\n\t B  "), "A B");
	assert.equal(sanitizeTabLabel("😀".repeat(129)), "😀".repeat(128));
	assert.equal(sanitizeTabLabel("\u200b\u202e\n"), "");
});

test("default and recorded automatic labels accept updates while confirmed input stays idle", async (t) => {
	const f = await fixture(t);
	f.projector.start(f.ctx);
	await f.projector.idle();
	assert.deepEqual(f.transport.writes, ["fallback"]);
	assert.deepEqual(f.transport.calls[0]?.args.slice(0, 6), ["--autostart=false", "--color=never", "--timeout=10s", "--server", "unix:///launch", "whoami"]);

	const settledCalls = f.transport.calls.length;
	f.projector.input(f.ctx);
	await f.projector.idle();
	assert.equal(f.transport.calls.length, settledCalls);

	f.state.name = "Named";
	f.projector.refresh(f.ctx);
	await f.projector.idle();
	assert.deepEqual(f.transport.writes, ["fallback", "Named"]);
	const [record] = await recordFiles(f.agentDir);
	assert.equal(record?.label, "Named");
	assert.equal(record?.pending, undefined);
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

test("manual divergence removes provenance and the restored default resumes management", async (t) => {
	const f = await fixture(t);
	f.projector.start(f.ctx);
	await f.projector.idle();
	f.transport.label = "Manual";
	f.projector.refresh(f.ctx);
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
	f.projector.refresh(f.ctx);
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
	f.transport.failNextSet = true;
	f.projector.start(f.ctx);
	await f.projector.idle();
	assert.deepEqual(f.transport.writes, ["fallback"]);
	assert.equal(f.notices.length, 1);
	const [pending] = await recordFiles(f.agentDir);
	assert.equal(pending?.pending, "fallback");
	assert.equal(pending?.label, undefined);

	f.projector.refresh(f.ctx);
	await f.projector.idle();
	assert.deepEqual(f.transport.writes, ["fallback"]);
	const [confirmed] = await recordFiles(f.agentDir);
	assert.equal(confirmed?.label, "fallback");
	assert.equal(confirmed?.pending, undefined);
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
	f.projector.refresh(f.ctx);
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
