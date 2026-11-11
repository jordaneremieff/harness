import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import syncFs, { constants, writeSync } from "node:fs";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { chmod, lstat, mkdir, mkdtemp, open, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { dayNumber, emptyShard, LIMITS, overflowCell, slotFor, zero, type Batch } from "./capacity.ts";
import { PillarsStore, StoreBusyError, StoreLockIdentityError, StorePlatformError } from "./store.ts";
import { Collector } from "./collector.ts";

const TODAY = "2026-09-07";
const STALE = new Date(Date.now() - 120_000);

function batch(owner = 1, seq = 1, day = TODAY): Batch {
	return { owner: owner.toString(16).padStart(32, "0"), seq, day, cells: [{
		day, observationStage: "tool_request", resourceClass: "entry", resourceId: "synthetic", model: "test/model",
		reasoning: "high", referenceBodyDigest: "a".repeat(64), observerVersion: "1.0.0", piVersion: "1.0.0",
		counters: { ...zero(), readRequests: 1 },
	}] };
}
async function fixture() {
	const directory = await mkdtemp(join(process.env.PI_TEST_FIXTURE_ROOT ?? process.cwd(), ".pillars-store-test-"));
	const root = join(directory, "store");
	return { directory, root, store: new PillarsStore(root), async [Symbol.asyncDispose]() { await rm(directory, { recursive: true, force: true }); } };
}
async function holdLock(root: string) {
	return open(join(root, "store.lock"), constants.O_RDWR | constants.O_CREAT | constants.O_NONBLOCK | constants.O_NOFOLLOW | 0x20, 0o600);
}

async function capacityExperiment(root: string) {
	const store = new PillarsStore(root);
	await store.commit(batch(), TODAY);
	for (let ago = 0; ago < LIMITS.days; ago++) {
		const day = new Date((dayNumber(TODAY) - ago) * 86400000).toISOString().slice(0, 10);
		const shard = emptyShard(day);
		shard.cells = Array.from({ length: LIMITS.cellsPerDay }, (_, index) => ({ ...batch(1, 1, day).cells[0],
			resourceId: `${String(index).padStart(4, "0")}${"a".repeat(60)}`, model: "m".repeat(64),
			observerVersion: "1234567890.1234567890.1234567890", piVersion: "1234567890.1234567890.1234567890" }));
		shard.cells.push(overflowCell(batch(1, 1, day).cells[0]));
		shard.cells.push({ ...overflowCell(batch(1, 1, day).cells[0]), observationStage: "tool_result", counters: {
			...zero(), readResults: 1, resultUnknown: 1, bodyUnverifiable: 1 } });
		shard.receipts = Array.from({ length: LIMITS.ownersPerDay }, (_, index) => ({ owner: batch(index + 1).owner, seq: LIMITS.maxSeq }));
		await writeFile(join(root, slotFor(day)), JSON.stringify(shard), { mode: 0o600 });
	}
	const before = process.memoryUsage();
	const snapshot = await store.capture(TODAY);
	const after = process.memoryUsage();
	return {
		cells: Object.values(snapshot.shards).reduce((sum, shard) => sum + shard.cells.length, 0),
		receipts: Object.values(snapshot.shards).reduce((sum, shard) => sum + shard.receipts.length, 0),
		platform: process.platform,
		heapDeltaBytes: after.heapUsed - before.heapUsed,
		rssDeltaBytes: after.rss - before.rss,
	};
}

// The max-capacity experiment must run without coverage instrumentation, which
// inflates RSS past the production memory guard. The child re-enters this file in
// worker mode and runs the same experiment in a plain, uninstrumented Node process.
if (process.argv.includes("--capacity-worker")) {
	const root = process.argv[process.argv.indexOf("--capacity-worker") + 1];
	if (!root) {
		writeSync(2, "capacity worker: missing store root argument\n");
		process.exit(2);
	}
	try {
		const result = await capacityExperiment(root);
		writeSync(1, `${JSON.stringify(result)}\n`);
		process.exit(0);
	} catch (error) {
		const text = error instanceof Error ? (error.stack ?? error.message) : String(error);
		writeSync(2, `${text}\n`);
		process.exit(1);
	}
}

test("absent and empty read capture leave storage unchanged", async () => {
	await using f = await fixture();
	assert.deepEqual(await f.store.capture(TODAY), { shards: {} });
	await assert.rejects(lstat(f.root), { code: "ENOENT" });
	await mkdir(f.root, { mode: 0o700 });
	assert.deepEqual(await f.store.capture(TODAY), { shards: {} });
	assert.deepEqual(await readdir(f.root), []);
});

test("atomic local publication gives coherent snapshots and idempotent receipts", async () => {
	await using f = await fixture();
	const input = batch(); input.health = { writeFailures: 2 };
	assert.equal(await f.store.commit(input, TODAY), "committed");
	assert.equal(await f.store.commit(input, TODAY), "duplicate");
	const snapshot = await f.store.capture(TODAY);
	assert.equal(snapshot.shards[TODAY].cells[0].counters.readRequests, 1);
	assert.equal(snapshot.shards[TODAY].health.writeFailures, 2);
	assert.equal(snapshot.shards[TODAY].receipts[0].seq, 1);
	assert.deepEqual((await readdir(f.root)).sort(), [slotFor(TODAY), "store.lock"].sort());
	assert.equal((await lstat(join(f.root, slotFor(TODAY)))).mode & 0o777, 0o600);
	assert.equal(await f.store.commit(batch(1, 3), TODAY), "sequence_gap");
	assert.equal(await f.store.commit(batch(1, 2), TODAY), "committed");
	assert.equal((await f.store.capture(TODAY)).shards[TODAY].cells[0].counters.readRequests, 2);
});

test("descriptor contention leaves shards intact and close releases the same inode", async () => {
	await using f = await fixture();
	await f.store.commit(batch(), TODAY);
	const path = join(f.root, "store.lock"), before = await lstat(path);
	const held = await holdLock(f.root);
	try {
		await utimes(path, STALE, STALE);
		await assert.rejects(f.store.commit(batch(1, 2), TODAY), StoreBusyError);
		assert.equal((await f.store.capture(TODAY)).shards[TODAY].revision, 1);
	} finally { await held.close(); }
	assert.equal(await f.store.commit(batch(1, 2), TODAY), "committed");
	assert.equal((await lstat(path)).ino, before.ino);
});

test("duplicate receipts retry directory sync before acknowledgement", async (t) => {
	await using f = await fixture();
	const original = fs.open;
	let attempts = 0, fail = true;
	const mocked = t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
		const handle = await original(...args);
		if (args[0] === f.root) {
			const sync = handle.sync.bind(handle);
			handle.sync = async () => { attempts += 1; if (fail) throw new Error("directory sync failed"); await sync(); };
		}
		return handle;
	});
	syncBuiltinESMExports();
	try {
		assert.equal(await f.store.commit(batch(), TODAY), "publication_failed");
		assert.equal(await new PillarsStore(f.root).commit(batch(), TODAY), "publication_failed");
		assert.equal(attempts, 2);
		fail = false;
		assert.equal(await new PillarsStore(f.root).commit(batch(), TODAY), "duplicate");
		assert.equal(attempts, 3);
		assert.equal((await f.store.capture(TODAY)).shards[TODAY].cells[0].counters.readRequests, 1);
	} finally { mocked.mock.restore(); syncBuiltinESMExports(); }
});

test("the collector retains its sealed contribution through repeated sync failure and reopened dedupe", async (t) => {
	await using f = await fixture();
	const original = fs.open;
	let fail = true;
	const mocked = t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
		const handle = await original(...args);
		if (args[0] === f.root) {
			const sync = handle.sync.bind(handle);
			handle.sync = async () => { if (fail) throw new Error("directory sync failed"); await sync(); };
		}
		return handle;
	});
	syncBuiltinESMExports();
	const collector = new Collector({ commit: (input, day, signal) => new PillarsStore(f.root).commit(input, day, signal) }, { now: () => Date.parse(TODAY) });
	try {
		collector.admit(batch().cells[0]);
		await collector.flush(true); assert.equal(collector.bufferedEvents, 1);
		await collector.flush(true); assert.equal(collector.bufferedEvents, 1);
		fail = false;
		await collector.flush(true); assert.equal(collector.bufferedEvents, 0);
		assert.equal((await f.store.capture(TODAY)).shards[TODAY].cells[0].counters.readRequests, 1);
	} finally { await collector.shutdown(); mocked.mock.restore(); syncBuiltinESMExports(); }
});

test("a paused publication keeps kernel exclusion regardless of lock age", async (t) => {
	await using f = await fixture();
	const original = fs.open;
	let release = () => {}, entered = () => {};
	const held = new Promise<void>((resolve) => { release = resolve; });
	const publishing = new Promise<void>((resolve) => { entered = resolve; });
	const mocked = t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
		const handle = await original(...args);
		if (String(args[0]).endsWith("pending.tmp")) {
			const sync = handle.sync.bind(handle);
			handle.sync = async () => { await sync(); entered(); await held; };
		}
		return handle;
	});
	syncBuiltinESMExports();
	const first = f.store.commit(batch(1), TODAY);
	try {
		await publishing;
		await utimes(join(f.root, "store.lock"), STALE, STALE);
		await assert.rejects(new PillarsStore(f.root).commit(batch(2), TODAY), StoreBusyError);
		release();
		assert.equal(await first, "committed");
		assert.equal(await new PillarsStore(f.root).commit(batch(2), TODAY), "committed");
		assert.equal((await f.store.capture(TODAY)).shards[TODAY].cells[0].counters.readRequests, 2);
	} finally { release(); await first.catch(() => {}); mocked.mock.restore(); syncBuiltinESMExports(); }
});

test("identity loss after rename preserves the published slot and replacement lock", async (t) => {
	await using f = await fixture();
	const original = syncFs.renameSync;
	const mocked = t.mock.method(syncFs, "renameSync", (...args: Parameters<typeof syncFs.renameSync>) => {
		original(...args);
		original(join(f.root, "store.lock"), join(f.directory, "held-lock"));
		syncFs.writeFileSync(join(f.root, "store.lock"), "replacement", { mode: 0o600 });
	});
	syncBuiltinESMExports();
	try {
		await assert.rejects(f.store.commit(batch(), TODAY), StoreLockIdentityError);
		assert.equal(await readFile(join(f.root, "store.lock"), "utf8"), "replacement");
		assert.equal(JSON.parse(await readFile(join(f.root, slotFor(TODAY)), "utf8")).receipts[0].seq, 1);
	} finally { mocked.mock.restore(); syncBuiltinESMExports(); }
});

test("read capture rejects unresolved temporary state; the next writer reconciles it", async () => {
	await using f = await fixture();
	await f.store.commit(batch(), TODAY);
	await writeFile(join(f.root, "pending.tmp"), "incomplete", { mode: 0o600 });
	await assert.rejects(f.store.capture(TODAY), /store_unreadable/);
	assert.equal(await readFile(join(f.root, "pending.tmp"), "utf8"), "incomplete");
	assert.equal(await f.store.commit(batch(), TODAY), "duplicate");
	await assert.rejects(lstat(join(f.root, "pending.tmp")), { code: "ENOENT" });
	assert.equal((await f.store.capture(TODAY)).shards[TODAY].cells[0].counters.readRequests, 1);
});

test("a held descriptor preserves pending bytes until its owner releases", async () => {
	await using f = await fixture();
	await f.store.commit(batch(), TODAY);
	await writeFile(join(f.root, "pending.tmp"), "incomplete", { mode: 0o600 });
	const held = await holdLock(f.root);
	try {
		await assert.rejects(f.store.capture(TODAY), /store_unreadable/);
		await assert.rejects(f.store.commit(batch(), TODAY), StoreBusyError);
		assert.equal(await readFile(join(f.root, "pending.tmp"), "utf8"), "incomplete");
	} finally { await held.close(); }
	assert.equal(await f.store.commit(batch(), TODAY), "duplicate");
});

test("retention publication removes expired slots only after a committed watermark", async () => {
	await using f = await fixture();
	const old = "2026-08-07";
	assert.equal(await f.store.commit(batch(1, 1, old), old), "committed");
	assert.deepEqual(await f.store.capture(TODAY), { shards: {} });
	assert.ok((await readdir(f.root)).includes(slotFor(old)));
	assert.equal(await f.store.commit(batch(), TODAY), "committed");
	assert.ok(!(await readdir(f.root)).includes(slotFor(old)));
	assert.equal(await f.store.commit(batch(2, 1, old), TODAY), "outside_window");
	assert.equal(await f.store.commit(batch(2, 1, "2026-09-06"), "2026-09-06"), "clock_rollback");
	await assert.rejects(f.store.capture("2026-09-06"), /clock_rollback/);
});

test("untrusted files fail the complete capture instead of a partial overview", async () => {
	await using f = await fixture();
	await f.store.commit(batch(), TODAY);
	const file = join(f.root, slotFor(TODAY));
	const valid = await readFile(file);
	for (const corrupt of ["{", '{"value":NaN}', '{"value":Infinity}', '{"value":1e999}', JSON.stringify({ ...emptyShard(TODAY), extra: true })]) {
		await writeFile(file, corrupt);
		await assert.rejects(f.store.capture(TODAY), /store_corrupt/);
	}
	await writeFile(file, valid);
	await writeFile(join(f.root, "foreign"), "", { mode: 0o600 });
	await assert.rejects(f.store.capture(TODAY), /store_unreadable/);
	await rm(join(f.root, "foreign"));
	await chmod(file, 0o644);
	await assert.rejects(f.store.capture(TODAY), /store_unreadable/);
	await chmod(file, 0o600);
	await writeFile(file, Buffer.alloc(2 * 1024 * 1024 + 1));
	await assert.rejects(f.store.capture(TODAY), /store_unreadable/);
	await writeFile(file, valid);
	await writeFile(join(f.root, "store.lock"), "bounded metadata", { mode: 0o600 });
	assert.equal((await f.store.capture(TODAY)).shards[TODAY].revision, 1);
});

test("bounded decoding rejects deep, excessive, and oversized scalar JSON before object allocation", async () => {
	await using f = await fixture();
	await f.store.commit(batch(), TODAY);
	const file = join(f.root, slotFor(TODAY));
	for (const raw of ["[".repeat(10000) + "]".repeat(10000), `[${"0,".repeat(250000)}0]`, JSON.stringify({ value: "x".repeat(1024 * 1024) }), "{\"day\":\"\\ufffd\"}"]) {
		await writeFile(file, raw);
		await assert.rejects(f.store.capture(TODAY), /store_corrupt/);
	}
	await writeFile(file, Buffer.from([0xff]));
	await assert.rejects(f.store.capture(TODAY), /store_corrupt/);
});

test("heap, RSS, and heap-reserve refusals release the transaction with a fixed error", async (t) => {
	await using f = await fixture();
	await f.store.commit(batch(), TODAY);
	for (const [field, increase] of [["heapUsed", 193 * 1024 * 1024], ["rss", 257 * 1024 * 1024], ["heapUsed", Number.MAX_SAFE_INTEGER]] as const) {
		const baseline = process.memoryUsage();
		let calls = 0;
		const mocked = t.mock.method(process, "memoryUsage", () => ({ ...baseline,
			[field]: baseline[field] + (increase === Number.MAX_SAFE_INTEGER || calls++ >= 2 ? increase : 0) }));
		try { await assert.rejects(f.store.capture(TODAY), /response_overflow/); }
		finally { mocked.mock.restore(); }
		assert.equal((await f.store.capture(TODAY)).shards[TODAY].revision, 1);
	}
});

test("a cancelled transaction rejects without acquiring another lease", async () => {
	await using f = await fixture();
	await f.store.commit(batch(), TODAY);
	const cancelled = new AbortController(); cancelled.abort();
	await using empty = await fixture();
	await assert.rejects(empty.store.commit(batch(), TODAY, cancelled.signal), { name: "AbortError" });
	await assert.rejects(lstat(empty.root), { code: "ENOENT" });
	await assert.rejects(f.store.capture(TODAY, cancelled.signal), { name: "AbortError" });
	await assert.rejects(f.store.commit(batch(1, 2), TODAY, cancelled.signal), { name: "AbortError" });
	assert.deepEqual((await readdir(f.root)).sort(), [slotFor(TODAY), "store.lock"].sort());
	assert.equal(await f.store.commit(batch(1, 2), TODAY), "committed");
	assert.equal((await f.store.capture(TODAY)).shards[TODAY].receipts[0].seq, 2);
});

test("kernel death releases exclusion without deleting the lock inode", { timeout: 10000 }, async () => {
	await using f = await fixture();
	await mkdir(f.root, { mode: 0o700 });
	const path = join(f.root, "store.lock");
	const child = spawn(process.execPath, ["-e", `const fs=require('node:fs'); const fd=fs.openSync(process.argv[1],fs.constants.O_RDWR|fs.constants.O_CREAT|fs.constants.O_NONBLOCK|fs.constants.O_NOFOLLOW|0x20,0o600);process.send('ready');process.on('message',()=>{});`, path], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
	try {
		await once(child, "message");
		const before = await lstat(path);
		await assert.rejects(f.store.commit(batch(), TODAY), StoreBusyError);
		const closed = once(child, "close");
		child.kill("SIGKILL");
		await closed;
		assert.equal(await f.store.commit(batch(), TODAY), "committed");
		assert.equal((await lstat(path)).ino, before.ino);
	} finally { child.kill("SIGKILL"); }
});

test("safe lock bodies, modes and aliases remain unchanged across acquisition", async () => {
	await using f = await fixture();
	await mkdir(f.root, { mode: 0o700 });
	const path = join(f.root, "store.lock"), alias = join(f.directory, "alias");
	await writeFile(path, "metadata", { mode: 0o600 });
	const before = await lstat(path);
	await fs.link(path, alias);
	await chmod(path, 0o700);
	assert.equal(await f.store.commit(batch(), TODAY), "committed");
	assert.equal(await readFile(path, "utf8"), "metadata");
	assert.equal((await lstat(path)).ino, before.ino);
	const held = await open(alias, constants.O_RDWR | constants.O_NONBLOCK | constants.O_NOFOLLOW | 0x20);
	try { await assert.rejects(f.store.commit(batch(1, 2), TODAY), StoreBusyError); }
	finally { await held.close(); }
	for (const mode of [0o400, 0o200, 0, 0o640, 0o644, 0o660]) {
		await chmod(path, mode);
		await assert.rejects(f.store.commit(batch(1, 2), TODAY), /store_unreadable/);
		assert.equal((await lstat(path)).ino, before.ino);
	}
	await chmod(path, 0o600);
	assert.equal(await f.store.commit(batch(1, 2), TODAY), "committed");
	assert.equal((await lstat(alias)).ino, before.ino);
});

test("Finder metadata is ignored without opening it at the managed entry limit", async () => {
	await using f = await fixture();
	for (let ago = LIMITS.days - 1; ago >= 0; ago--) {
		const day = new Date((dayNumber(TODAY) - ago) * 86400000).toISOString().slice(0, 10);
		await f.store.commit(batch(1, 1, day), day);
	}
	await mkdir(join(f.root, ".DS_Store"), { mode: 0 });
	const snapshot = await f.store.capture(TODAY);
	assert.equal(Object.keys(snapshot.shards).length, LIMITS.days);
	await writeFile(join(f.root, "pending.tmp"), "incomplete", { mode: 0o600 });
	assert.equal((await readdir(f.root)).length, LIMITS.entries + 1);
	assert.equal(await f.store.commit(batch(2), TODAY), "committed");
	assert.equal((await lstat(join(f.root, ".DS_Store"))).isDirectory(), true);
});

test("unsupported platforms refuse writes without creating storage and permit reads", async () => {
	await using f = await fixture();
	const platform = Object.getOwnPropertyDescriptor(process, "platform");
	assert.ok(platform);
	Object.defineProperty(process, "platform", { value: "linux", configurable: true });
	try {
		await assert.rejects(f.store.commit(batch(), TODAY), { name: "StorePlatformError", message: "Pillars aggregate writes require macOS." });
		assert.ok(new StorePlatformError() instanceof Error);
		assert.deepEqual(await f.store.capture(TODAY), { shards: {} });
		await assert.rejects(lstat(f.root), { code: "ENOENT" });
	} finally { Object.defineProperty(process, "platform", platform); }
});

test("identity loss before publication retains the sealed batch and successor pending state", async (t) => {
	await using f = await fixture();
	const original = fs.open;
	let intercept = true, calls = 0;
	let successor: Awaited<ReturnType<typeof lstat>> | undefined;
	const warnings: string[] = [];
	const mocked = t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
		const handle = await original(...args);
		if (String(args[0]).endsWith("pending.tmp") && intercept) {
			intercept = false;
			const sync = handle.sync.bind(handle);
			handle.sync = async () => {
				await sync();
				await rm(join(f.root, "store.lock"));
				assert.equal(await new PillarsStore(f.root).commit(batch(2), TODAY), "committed");
				successor = await lstat(join(f.root, "store.lock"));
				await writeFile(join(f.root, "pending.tmp"), "successor", { mode: 0o600 });
			};
		}
		return handle;
	});
	syncBuiltinESMExports();
	const collector = new Collector({ commit: async (input, day, signal) => { calls++; return f.store.commit(input, day, signal); } }, { now: () => Date.parse(TODAY), diagnostic: (message) => warnings.push(message) });
	try {
		collector.admit(batch().cells[0]);
		await collector.flush(true);
		assert.equal(collector.bufferedEvents, 1);
		assert.deepEqual(warnings, [new StoreLockIdentityError().message]);
		await collector.flush(true); await collector.shutdown(); await collector.shutdown();
		assert.equal(calls, 1);
		assert.equal(collector.bufferedEvents, 1);
		assert.equal(await readFile(join(f.root, "pending.tmp"), "utf8"), "successor");
		assert.ok(successor);
		const named = await lstat(join(f.root, "store.lock"));
		assert.equal(named.ino, successor.ino);
		assert.equal(named.dev, successor.dev);
		const shard = JSON.parse(await readFile(join(f.root, slotFor(TODAY)), "utf8"));
		assert.equal(shard.cells[0].counters.readRequests, 1);
		assert.deepEqual(shard.receipts, [{ owner: batch(2).owner, seq: 1 }]);
	} finally { mocked.mock.restore(); syncBuiltinESMExports(); }
});

test("missing lock identity stops publication without recreating its pathname", async (t) => {
	await using f = await fixture();
	const original = fs.open;
	const mocked = t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
		const handle = await original(...args);
		if (String(args[0]).endsWith("pending.tmp")) {
			const sync = handle.sync.bind(handle);
			handle.sync = async () => { await sync(); await rm(join(f.root, "store.lock")); };
		}
		return handle;
	});
	syncBuiltinESMExports();
	try {
		await assert.rejects(f.store.commit(batch(), TODAY), StoreLockIdentityError);
		await assert.rejects(lstat(join(f.root, "store.lock")), { code: "ENOENT" });
		await assert.rejects(lstat(join(f.root, slotFor(TODAY))), { code: "ENOENT" });
	} finally { mocked.mock.restore(); syncBuiltinESMExports(); }
});

test("identity loss after watermark publication does not remove expired slots", async (t) => {
	await using f = await fixture();
	const old = "2026-08-07";
	await f.store.commit(batch(1, 1, old), old);
	const original = syncFs.renameSync;
	const mocked = t.mock.method(syncFs, "renameSync", (...args: Parameters<typeof syncFs.renameSync>) => {
		original(...args); syncFs.unlinkSync(join(f.root, "store.lock"));
	});
	syncBuiltinESMExports();
	try {
		await assert.rejects(f.store.commit(batch(2), TODAY), StoreLockIdentityError);
		assert.ok((await lstat(join(f.root, slotFor(old)))).isFile());
		assert.ok((await lstat(join(f.root, slotFor(TODAY)))).isFile());
	} finally { mocked.mock.restore(); syncBuiltinESMExports(); }
});

test("a cancelled publication closes its lease after the protected operation", async (t) => {
	await using f = await fixture();
	const controller = new AbortController(), original = fs.open;
	const mocked = t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
		const handle = await original(...args);
		if (String(args[0]).endsWith("pending.tmp")) {
			const sync = handle.sync.bind(handle);
			handle.sync = async () => { controller.abort(); await sync(); };
		}
		return handle;
	});
	syncBuiltinESMExports();
	try {
		await assert.rejects(f.store.commit(batch(), TODAY, controller.signal), { name: "AbortError" });
		assert.equal(await new PillarsStore(f.root).commit(batch(), TODAY), "duplicate");
	} finally { mocked.mock.restore(); syncBuiltinESMExports(); }
});

test("collector contention defers twice and reports the third consecutive busy attempt once", async (t) => {
	let busy = true;
	const inputs: Batch[] = [], warnings: string[] = [];
	const collector = new Collector({ commit: async (input) => {
		inputs.push(input);
		if (busy) throw new StoreBusyError();
		return "committed";
	} }, { now: () => Date.parse(TODAY), diagnostic: (message) => warnings.push(message) });
	const incidents = t.mock.method(collector, "incident");
	collector.admit(batch().cells[0]);
	await collector.observed();
	await collector.flush(true);
	assert.equal(inputs.length, 2);
	assert.equal(inputs[0], inputs[1]);
	assert.equal(collector.bufferedEvents, 1);
	assert.deepEqual(warnings, []);
	assert.equal(incidents.mock.callCount(), 0);
	await collector.flush(true);
	assert.deepEqual(warnings, ["Pillars aggregate writer is busy. The next publication event retries. This writer never removes the lock file. Do not remove it."]);
	assert.deepEqual(incidents.mock.calls.map((call) => call.arguments), [["writeFailures"]]);
	await collector.flush(true);
	assert.equal(warnings.length, 1);
	assert.equal(incidents.mock.callCount(), 1);
	busy = false;
	await collector.flush(true);
	assert.equal(inputs[0], inputs[4]);
	assert.equal(collector.bufferedEvents, 0);
	await collector.flush(true);
	assert.equal(inputs[5].health?.writeFailures, 1);
	busy = true;
	collector.admit(batch().cells[0]);
	await collector.flush(true);
	await collector.flush(true);
	assert.equal(warnings.length, 1);
	await collector.flush(true);
	assert.equal(warnings.length, 2);
	busy = false;
	await collector.shutdown();
});

test("a busy shutdown probe reports its lost tail without another attempt", async (t) => {
	let calls = 0;
	const warnings: string[] = [];
	const collector = new Collector({ commit: async () => { calls++; throw new StoreBusyError(); } },
		{ now: () => Date.parse(TODAY), diagnostic: (message) => warnings.push(message) });
	const incidents = t.mock.method(collector, "incident");
	collector.admit(batch().cells[0]);
	await collector.shutdown();
	await collector.shutdown();
	await collector.flush(true);
	assert.equal(calls, 1);
	assert.deepEqual(incidents.mock.calls.map((call) => call.arguments), [["writeFailures"]]);
	assert.deepEqual(warnings, ["Pillars shutdown publication is busy. The unpublished delta is lost when this collector closes."]);
});

test("unsupported publication emits one diagnostic per collector", async () => {
	const warnings: string[] = [];
	const collector = new Collector({ commit: async () => { throw new StorePlatformError(); } },
		{ now: () => Date.parse(TODAY), diagnostic: (message) => warnings.push(message) });
	collector.admit(batch().cells[0]);
	await collector.flush(true);
	await collector.flush(true);
	await collector.shutdown();
	assert.deepEqual(warnings, ["Pillars aggregate writes require macOS."]);
});

test("identity loss during scan blocks collector retries without recreating the lock", async (t) => {
	await using f = await fixture();
	const original = fs.lstat;
	let removed = false, calls = 0;
	const warnings: string[] = [];
	const mocked = t.mock.method(fs, "lstat", async (...args: Parameters<typeof fs.lstat>) => {
		if (args[0] === join(f.root, "store.lock") && !removed) {
			removed = true;
			await rm(join(f.root, "store.lock"));
		}
		return original(...args);
	});
	syncBuiltinESMExports();
	const collector = new Collector({ commit: async (input, day, signal) => { calls++; return f.store.commit(input, day, signal); } }, { now: () => Date.parse(TODAY), diagnostic: (message) => warnings.push(message) });
	try {
		collector.admit(batch().cells[0]);
		await collector.flush(true);
		await collector.flush(true);
		await collector.shutdown();
		assert.equal(calls, 1);
		assert.equal(collector.bufferedEvents, 1);
		assert.deepEqual(warnings, [new StoreLockIdentityError().message]);
		await assert.rejects(lstat(join(f.root, "store.lock")), { code: "ENOENT" });
		await assert.rejects(lstat(join(f.root, slotFor(TODAY))), { code: "ENOENT" });
	} finally { mocked.mock.restore(); syncBuiltinESMExports(); }
});

test("pending recovery checks the current lock identity before removal", async (t) => {
	await using f = await fixture();
	await f.store.commit(batch(), TODAY);
	await writeFile(join(f.root, "pending.tmp"), "unpublished", { mode: 0o600 });
	const original = fs.lstat;
	let replaced = false;
	const mocked = t.mock.method(fs, "lstat", async (...args: Parameters<typeof fs.lstat>) => {
		const info = await original(...args);
		if (args[0] === join(f.root, "store.lock") && !replaced) {
			replaced = true;
			syncFs.unlinkSync(join(f.root, "store.lock"));
			syncFs.writeFileSync(join(f.root, "store.lock"), "successor", { mode: 0o600 });
		}
		return info;
	});
	syncBuiltinESMExports();
	try {
		await assert.rejects(f.store.commit(batch(1, 2), TODAY), StoreLockIdentityError);
		assert.equal(await readFile(join(f.root, "pending.tmp"), "utf8"), "unpublished");
		assert.equal(await readFile(join(f.root, "store.lock"), "utf8"), "successor");
	} finally { mocked.mock.restore(); syncBuiltinESMExports(); }
});

test("an unlink after the identity check still permits a split-inode publication", async (t) => {
	await using f = await fixture();
	const originalStat = syncFs.lstatSync, originalRename = syncFs.renameSync;
	let replacement: number | undefined, publications = 0;
	const rename = t.mock.method(syncFs, "renameSync", (...args: Parameters<typeof syncFs.renameSync>) => { publications++; originalRename(...args); });
	const stat = t.mock.method(syncFs, "lstatSync", (...args: Parameters<typeof syncFs.lstatSync>) => {
		const info = originalStat(...args);
		if (args[0] === join(f.root, "store.lock") && replacement === undefined && syncFs.existsSync(join(f.root, "pending.tmp"))) {
			syncFs.unlinkSync(join(f.root, "store.lock"));
			replacement = syncFs.openSync(join(f.root, "store.lock"), constants.O_RDWR | constants.O_CREAT | constants.O_NONBLOCK | constants.O_NOFOLLOW | 0x20, 0o600);
			const candidate = join(f.directory, "candidate");
			syncFs.writeFileSync(candidate, "successor publication", { mode: 0o600 });
			syncFs.renameSync(candidate, join(f.root, slotFor(TODAY)));
		}
		return info;
	});
	syncBuiltinESMExports();
	try {
		await assert.rejects(f.store.commit(batch(), TODAY), StoreLockIdentityError);
		assert.equal(publications, 2);
		assert.equal(JSON.parse(await readFile(join(f.root, slotFor(TODAY)), "utf8")).receipts[0].owner, batch().owner);
	} finally {
		stat.mock.restore(); rename.mock.restore(); syncBuiltinESMExports();
		if (replacement !== undefined) syncFs.closeSync(replacement);
	}
});

test("maximum retained cells and receipts pass the bounded filesystem capture", { timeout: 60000 }, async (t) => {
	await using f = await fixture();
	const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "--capacity-worker", f.root], {
		stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
	});
	let stdout = "";
	let stderr = "";
	assert.ok(child.stdout);
	assert.ok(child.stderr);
	child.stdout.on("data", (chunk) => { stdout += String(chunk); });
	child.stderr.on("data", (chunk) => { stderr += String(chunk); });
	try {
		const closed = once(child, "close");
		const timer = setTimeout(() => child.kill("SIGKILL"), 45000);
		const [code] = await closed;
		clearTimeout(timer);
		assert.equal(code, 0, `capacity worker exited ${code}: ${stderr}`);
		const result = JSON.parse(stdout);
		assert.equal(result.cells, 61500);
		assert.equal(result.receipts, 122880);
		t.diagnostic(JSON.stringify({ platform: result.platform,
			heapDeltaBytes: result.heapDeltaBytes, rssDeltaBytes: result.rssDeltaBytes }));
	} finally { child.kill("SIGKILL"); }
});
