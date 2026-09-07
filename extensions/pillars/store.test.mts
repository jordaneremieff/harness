import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { writeSync } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, open, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { dayNumber, emptyShard, LIMITS, overflowCell, slotFor, zero, type Batch } from "./capacity.ts";
import { PillarsStore } from "./store.ts";

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
	const directory = await mkdtemp(join(process.cwd(), ".pillars-store-test-"));
	const root = join(directory, "store");
	return { directory, root, store: new PillarsStore(root), async [Symbol.asyncDispose]() { await rm(directory, { recursive: true, force: true }); } };
}
async function holdLock(root: string, mtime?: Date): Promise<string> {
	const path = join(root, "store.lock");
	const handle = await open(path, "wx", 0o600);
	await handle.close();
	if (mtime) await utimes(path, mtime, mtime);
	return path;
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
	assert.deepEqual(await readdir(f.root), [slotFor(TODAY)]);
	assert.equal((await lstat(join(f.root, slotFor(TODAY)))).mode & 0o777, 0o600);
	assert.equal(await f.store.commit(batch(1, 3), TODAY), "sequence_gap");
	assert.equal(await f.store.commit(batch(1, 2), TODAY), "committed");
	assert.equal((await f.store.capture(TODAY)).shards[TODAY].cells[0].counters.readRequests, 2);
});

test("an active lock excludes a concurrent writer and stale locks are broken", { timeout: 15000 }, async () => {
	await using f = await fixture();
	assert.equal(await f.store.commit(batch(), TODAY), "committed");
	const lock = await holdLock(f.root);
	const start = performance.now();
	await assert.rejects(f.store.commit(batch(1, 2), TODAY), /store_unreadable/);
	const waited = performance.now() - start;
	assert.ok(waited >= LIMITS.lockMilliseconds / 2, `the writer waited ${waited}ms for the lock`);
	assert.ok(waited < 3000, `the wait stays bounded at ${waited}ms`);
	// A reader never takes the lock, so an active writer does not block capture.
	assert.equal((await f.store.capture(TODAY)).shards[TODAY].revision, 1);
	await rm(lock);
	assert.equal(await f.store.commit(batch(1, 2), TODAY), "committed");
	await holdLock(f.root, STALE);
	assert.equal(await f.store.commit(batch(1, 3), TODAY), "committed");
	assert.deepEqual(await readdir(f.root), [slotFor(TODAY)]);
	assert.equal((await f.store.capture(TODAY)).shards[TODAY].cells[0].counters.readRequests, 3);
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

test("a crash leftover lock and temporary file are reconciled by the next writer", async () => {
	await using f = await fixture();
	await f.store.commit(batch(), TODAY);
	await writeFile(join(f.root, "pending.tmp"), "incomplete", { mode: 0o600 });
	await holdLock(f.root, STALE);
	await assert.rejects(f.store.capture(TODAY), /store_unreadable/);
	assert.equal(await f.store.commit(batch(), TODAY), "duplicate");
	await assert.rejects(lstat(join(f.root, "pending.tmp")), { code: "ENOENT" });
	assert.deepEqual(await readdir(f.root), [slotFor(TODAY)]);
	assert.equal((await f.store.capture(TODAY)).shards[TODAY].receipts[0].seq, 1);
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
	await writeFile(join(f.root, "store.lock"), "unexpected control", { mode: 0o600 });
	await assert.rejects(f.store.capture(TODAY), /store_unreadable/);
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

test("a cancelled transaction rejects and leaves no lock behind", async () => {
	await using f = await fixture();
	await f.store.commit(batch(), TODAY);
	const cancelled = new AbortController(); cancelled.abort();
	await assert.rejects(f.store.capture(TODAY, cancelled.signal), { name: "AbortError" });
	await assert.rejects(f.store.commit(batch(1, 2), TODAY, cancelled.signal), { name: "AbortError" });
	assert.deepEqual(await readdir(f.root), [slotFor(TODAY)]);
	assert.equal(await f.store.commit(batch(1, 2), TODAY), "committed");
	assert.equal((await f.store.capture(TODAY)).shards[TODAY].receipts[0].seq, 2);
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
