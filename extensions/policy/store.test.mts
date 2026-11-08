import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readdir, readFile, rename, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, type TestContext } from "node:test";
import type { PolicyRecord } from "./record.ts";
import { appendRecord, PolicyWriter } from "./store.ts";
import {
	appendSerializedTelemetryRecords,
	localDate,
	serializeTelemetryRecord,
	TelemetryLockBusyError,
	TELEMETRY_BATCH_BYTES,
	TELEMETRY_BATCH_RECORDS,
	TELEMETRY_QUEUE_BYTES,
	TELEMETRY_QUEUE_RECORDS,
} from "./telemetry-files.ts";
import { readTelemetry } from "./telemetry.ts";

const record = (at: string): PolicyRecord => ({
	session: "s1",
	mode: "tui",
	cwd: "/work",
	model: "xai/grok-4.6",
	thinkingLevel: "high",
	projectContext: false,
	ruleStoreDegraded: false,
	at,
	tool: "bash",
	callId: "c1",
	durationMs: 12,
	outputBytes: 34,
	policyMode: "observe",
	truncated: false,
	error: false,
	errorKind: null,
	tokens: null,
	classes: ["routing.cat-read"],
	captured: "cat a",
});

async function policyDir(t: TestContext): Promise<string> {
	const base = await mkdtemp(join(tmpdir(), "policy-store-"));
	t.after(() => rm(base, { recursive: true, force: true }));
	return join(base, "policy");
}

async function segmentLines(dir: string, day: string): Promise<string[]> {
	const segments = join(dir, "telemetry");
	const names = (await readdir(segments)).filter((name) => name.startsWith(`${day}.`)).sort();
	const lines: string[] = [];
	for (const name of names) lines.push(...(await readFile(join(segments, name), "utf8")).split("\n").filter(Boolean));
	return lines;
}

describe("localDate", () => {
	it("pads month and day", () => {
		assert.equal(localDate(new Date(2026, 8, 3, 12)), "2026-09-03");
	});
});

describe("appendRecord", () => {
	it("writes one private JSONL line per record into the telemetry directory", async (t) => {
		const dir = await policyDir(t);
		const entry = record(new Date(2026, 8, 3, 12).toISOString());
		assert.equal(await appendRecord(dir, entry), null);
		assert.equal(await appendRecord(dir, entry), null);

		const path = join(dir, "telemetry", "2026-09-03.000001.jsonl");
		const lines = (await readFile(path, "utf8")).split("\n").filter(Boolean);
		assert.equal(lines.length, 2);
		assert.deepEqual(JSON.parse(lines[0]), entry);
		assert.equal((await stat(path)).mode & 0o777, 0o600);
		assert.equal((await stat(join(dir, "telemetry"))).mode & 0o777, 0o700);
		assert.equal((await stat(dir)).mode & 0o777, 0o700);
		assert.deepEqual(await readdir(join(dir, "telemetry")), ["2026-09-03.000001.jsonl"], "the lock is released");
		const summary = await readTelemetry(dir, "2026-09-03", "2026-09-03");
		assert.equal(summary.records, 2);
		assert.equal(summary.coverage.malformedLines, 0);
		assert.equal(summary.coverage.completeLines, 2);
		assert.equal(summary.coverage.days[0].status, "complete");
		assert.equal(summary.coverage.status, "partial", "records without outcome evidence do not establish complete telemetry");
		assert.equal(summary.coverage.days[0].unprocessedBytes, 0);
	});

	it("never creates or touches root-level day files", async (t) => {
		const dir = await policyDir(t);
		await mkdir(dir, { mode: 0o700 });
		await writeFile(join(dir, "2026-09-03.jsonl"), "root\n", { mode: 0o600 });
		assert.equal(await appendRecord(dir, record(new Date(2026, 8, 3, 12).toISOString())), null);
		assert.deepEqual((await readdir(dir)).sort(), ["2026-09-03.jsonl", "telemetry"]);
		assert.equal(await readTelemetry(dir, "2026-09-03", "2026-09-03").then((summary) => summary.records), 1);
	});

	it("delimits a valid record after a torn tail without losing the valid prefix", async (t) => {
		const dir = await policyDir(t);
		await mkdir(join(dir, "telemetry"), { recursive: true, mode: 0o700 });
		const entry = record(new Date(2026, 8, 3, 12).toISOString());
		const path = join(dir, "telemetry", "2026-09-03.000001.jsonl");
		const prefix = `${JSON.stringify({ ...entry, callId: "prefix" })}\n{"torn":`;
		await writeFile(path, prefix, { mode: 0o600 });
		assert.equal(await appendRecord(dir, entry), null);
		assert.equal(await readFile(path, "utf8"), `${prefix}\n${JSON.stringify(entry)}\n`);
		const summary = await readTelemetry(dir, "2026-09-03", "2026-09-03");
		assert.equal(summary.records, 2);
		assert.equal(summary.coverage.malformedLines, 1);
	});

	it("counts both separators at the exact serialized byte limit", async (t) => {
		const dir = await policyDir(t);
		const entry = { ...record(new Date(2026, 8, 3, 12).toISOString()), captured: "" };
		entry.captured = "x".repeat(256 * 1024 - Buffer.byteLength(`\n${JSON.stringify(entry)}\n`));
		assert.equal(await appendRecord(dir, entry), null);
		const path = join(dir, "telemetry", "2026-09-03.000001.jsonl");
		const before = await readFile(path);
		assert.equal(before.length, 256 * 1024);
		assert.match(await appendRecord(dir, { ...entry, captured: `${entry.captured}x` }) ?? "", /exceeds/u);
		assert.deepEqual(await readFile(path), before);
	});

	it("keeps concurrent record appends as complete JSONL lines", async (t) => {
		const dir = await policyDir(t);
		const at = new Date(2026, 8, 3, 12).toISOString();
		const entries = Array.from({ length: 16 }, (_, index) => ({ ...record(at), callId: `c${index}` }));
		assert.deepEqual(
			await Promise.all(entries.map((entry) => appendRecord(dir, entry))),
			entries.map(() => null),
		);
		const lines = await segmentLines(dir, "2026-09-03");
		assert.equal(lines.length, entries.length);
		assert.deepEqual(
			new Set(lines.map((line) => JSON.parse(line).callId)),
			new Set(entries.map((entry) => entry.callId)),
		);
	});

	it("returns the failure instead of throwing when the store is not a directory", async (t) => {
		const dir = await policyDir(t);
		await mkdir(join(dir, ".."), { recursive: true });
		const path = join(dir, "..", "blocked");
		await writeFile(path, "not a directory", "utf8");
		const failure = await appendRecord(path, record(new Date().toISOString()));
		assert.ok(failure, "expected a failure message");
	});

	it("refuses a symbolic-link policy directory and a symbolic-link telemetry directory", async (t) => {
		const dir = await policyDir(t);
		const base = join(dir, "..");
		const target = join(base, "target");
		await mkdir(target, { mode: 0o700 });
		const linked = join(base, "link");
		await symlink(target, linked);
		assert.match((await appendRecord(linked, record(new Date().toISOString()))) ?? "", /not a regular directory/);
		const policy = join(base, "real");
		await mkdir(policy, { mode: 0o700 });
		await symlink(target, join(policy, "telemetry"));
		assert.match((await appendRecord(policy, record(new Date().toISOString()))) ?? "", /not a regular directory/);
		assert.deepEqual(await readdir(target), []);
	});

	it("refuses broad existing permissions instead of changing them", async (t) => {
		const dir = await policyDir(t);
		await mkdir(dir, { mode: 0o755 });
		await chmod(dir, 0o755);
		assert.match((await appendRecord(dir, record(new Date().toISOString()))) ?? "", /permissions are not private/);
		assert.equal((await stat(dir)).mode & 0o777, 0o755);
	});

	it("rejects an invalid record timestamp", async (t) => {
		const dir = await policyDir(t);
		assert.match((await appendRecord(dir, record("not-a-date"))) ?? "", /invalid policy timestamp/);
	});
});

describe("PolicyWriter", () => {
	const entry = () => record(new Date().toISOString());

	it("returns from enqueue before a write and closes after accepted work", async () => {
		let release = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let started = false;
		const writer = new PolicyWriter("/unused", (health) => assert.fail(health.reason ?? health.state), async () => {
			started = true;
			await gate;
		});
		writer.enqueue(entry());
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(started, true);
		let flushed = false;
		const flushing = writer.close().then(() => {
			flushed = true;
		});
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(flushed, false);
		release();
		await flushing;
		assert.equal(flushed, true);
	});

	it("refuses and counts excess records, reports state changes, and resumes admission after drain", async () => {
		const states: string[] = [];
		let written = 0;
		const writer = new PolicyWriter("/unused", (health) => states.push(health.state), async (_dir, batch) => {
			written += batch.length;
		});
		const row = entry();
		for (let index = 0; index < TELEMETRY_QUEUE_RECORDS; index++) assert.equal(writer.enqueue(row), true);
		assert.equal(writer.enqueue(row), false);
		assert.equal(writer.enqueue(row), false);
		assert.deepEqual(writer.health(), { state: "pressure", lostRecords: 2, lostBytes: serializeTelemetryRecord(row).bytes * 2 });
		assert.deepEqual(states, ["pressure"]);
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(writer.enqueue(row), true);
		await writer.close();
		assert.deepEqual(states, ["pressure", "ok"]);
		assert.equal(writer.health().lostRecords, 2);
		assert.equal(written, TELEMETRY_QUEUE_RECORDS + 1);
	});

	it("charges in-flight serialized bytes to the cap without closing admission", async () => {
		let release = () => {};
		const gate = new Promise<void>((resolve) => { release = resolve; });
		let writtenBytes = 0;
		const writer = new PolicyWriter("/unused", () => {}, async (_dir, batch) => {
			await gate;
			for (const item of batch) writtenBytes += item.bytes;
		});
		const large = { ...entry(), captured: "x".repeat(200 * 1024) };
		const bytes = serializeTelemetryRecord(large).bytes;
		assert.equal(writer.enqueue(large), true);
		await new Promise((resolve) => setImmediate(resolve));
		let accepted = 1;
		while (writer.enqueue(large)) accepted++;
		assert.equal(accepted, Math.floor(TELEMETRY_QUEUE_BYTES / bytes));
		assert.deepEqual(writer.health(), { state: "pressure", lostRecords: 1, lostBytes: bytes });
		release();
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(writer.enqueue(large), true);
		await writer.close();
		assert.equal(writtenBytes, (accepted + 1) * bytes);
		assert.equal(writer.health().state, "ok");
	});

	it("groups queued records into bounded batches and runs an oversized permitted record alone", async () => {
		const batches: string[][] = [];
		const writer = new PolicyWriter("/unused", (health) => assert.fail(health.reason ?? health.state), async (_dir, batch) => {
			batches.push(batch.map((item) => item.json));
		});
		for (let index = 0; index < TELEMETRY_BATCH_RECORDS * 2 + 5; index++) writer.enqueue(entry());
		const big = { ...entry(), captured: "x".repeat(TELEMETRY_BATCH_BYTES) };
		writer.enqueue(entry());
		writer.enqueue(big);
		writer.enqueue(entry());
		await writer.close();
		assert.ok(batches.every((batch) => batch.length <= TELEMETRY_BATCH_RECORDS));
		const bigBatch = batches.find((batch) => batch.includes(JSON.stringify(big)));
		assert.deepEqual(bigBatch, [JSON.stringify(big)]);
		assert.equal(batches.reduce((total, batch) => total + batch.length, 0), TELEMETRY_BATCH_RECORDS * 2 + 8);
	});

	it("queues an owned snapshot serialised once and appends those exact bytes", async () => {
		const original = JSON.stringify;
		const seen: Array<{ day: string; json: string; bytes: number }> = [];
		const writer = new PolicyWriter("/unused", (health) => assert.fail(health.reason ?? health.state), async (_dir, batch) => {
			seen.push(...batch);
		});
		const mutable = { ...entry(), captured: "before" };
		const snapshot = original(mutable);
		let calls = 0;
		JSON.stringify = ((...args: Parameters<typeof JSON.stringify>) => {
			if (args[0] === mutable) calls++;
			return original(...args);
		}) as typeof JSON.stringify;
		try {
			assert.equal(writer.enqueue(mutable), true);
		} finally {
			JSON.stringify = original;
		}
		mutable.captured = "after-admission-and-much-longer";
		await writer.close();
		assert.equal(calls, 1, "the record is serialised once");
		assert.equal(seen.length, 1);
		assert.equal(seen[0].json, snapshot);
		assert.equal(seen[0].bytes, Buffer.byteLength(snapshot, "utf8") + 2);
	});

	it("keeps queue accounting equal to the admitted bytes after the caller mutates the record", async () => {
		let release = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const sizes: number[] = [];
		const writer = new PolicyWriter("/unused", (health) => assert.fail(health.reason ?? health.state), async (_dir, batch) => {
			for (const item of batch) sizes.push(item.bytes, Buffer.byteLength(item.json, "utf8") + 2);
			await gate;
		});
		const mutable = entry();
		writer.enqueue(mutable);
		mutable.captured = "x".repeat(1000);
		release();
		await writer.close();
		assert.equal(sizes[0], sizes[1]);
	});

	it("rejects new records after close admission", async () => {
		let written = 0;
		const writer = new PolicyWriter("/unused", (health) => assert.fail(health.reason ?? health.state), async (_dir, batch) => {
			written += batch.length;
		});
		assert.equal(writer.enqueue(entry()), true);
		const closing = writer.close();
		assert.equal(writer.enqueue(entry()), false);
		await closing;
		assert.equal(written, 1);
	});

	it("reports a failed write once and discards queued records", async () => {
		const failures: string[] = [];
		let calls = 0;
		const writer = new PolicyWriter(
			"/unused",
			(health) => failures.push(health.reason ?? health.state),
			async () => {
				calls++;
				throw new Error("store failed");
			},
		);
		writer.enqueue(entry());
		writer.enqueue(entry());
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(writer.enqueue(entry()), false);
		await writer.close();
		assert.equal(calls, 1);
		assert.deepEqual(failures, ["store failed"]);
	});

	it("rejects an oversized or undated record without writing and stops admission", async () => {
		const failures: string[] = [];
		let calls = 0;
		const writer = new PolicyWriter(
			"/unused",
			(health) => failures.push(health.reason ?? health.state),
			async () => {
				calls++;
			},
		);
		assert.equal(writer.enqueue({ ...entry(), captured: "x".repeat(256 * 1024) }), false);
		assert.equal(writer.enqueue(entry()), false);
		await writer.close();
		assert.equal(calls, 0);
		assert.equal(failures.length, 1);
		assert.match(failures[0], /exceeds/);
		const undated = new PolicyWriter("/unused", (health) => failures.push(health.reason ?? health.state), async () => {});
		assert.equal(undated.enqueue(record("not-a-date")), false);
		assert.match(failures[1], /invalid policy timestamp/);
	});

	it("contains write and failure-callback errors", async () => {
		const writer = new PolicyWriter(
			"/unused",
			() => {
				throw new Error("callback failed");
			},
			async () => {
				throw new Error("write failed");
			},
		);
		writer.enqueue(entry());
		await writer.close();
	});

	it("writes through the default file store under the telemetry directory", async (t) => {
		const dir = await policyDir(t);
		const writer = new PolicyWriter(dir, (health) => assert.fail(health.reason ?? health.state));
		const at = new Date(2026, 8, 3, 12).toISOString();
		for (let index = 0; index < 5; index++) writer.enqueue({ ...record(at), callId: `c${index}` });
		await writer.close();
		assert.equal((await segmentLines(dir, "2026-09-03")).length, 5);
	});

	it("retries exact admitted bytes when a lock clears after the first acquisition wait", async (t) => {
		const dir = await policyDir(t);
		await mkdir(join(dir, "telemetry"), { recursive: true, mode: 0o700 });
		const lock = join(dir, "telemetry", ".telemetry-lock");
		await writeFile(lock, "", { mode: 0o600 });
		const states: string[] = [];
		const seen: unknown[] = [];
		let written = () => {};
		const persisted = new Promise<void>((resolve) => { written = resolve; });
		const writer = new PolicyWriter(dir, (health) => states.push(health.state), async (...args) => {
			seen.push(args[1]);
			assert.ok((args[3]?.acquireUntil ?? 0) - performance.now() <= 2000);
			await appendSerializedTelemetryRecords(...args);
			written();
		});
		const row = entry();
		const snapshot = JSON.stringify(row);
		assert.equal(writer.enqueue(row), true);
		row.captured = "mutated after admission";
		const started = performance.now();
		await delay(700);
		await unlink(lock);
		await persisted;
		await new Promise((resolve) => setImmediate(resolve));
		assert.deepEqual(await segmentLines(dir, localDate(new Date(row.at))), [snapshot]);
		assert.ok(performance.now() - started < 2000);
		assert.ok(seen.length >= 2);
		assert.equal(seen[0], seen[1], "retry retains the same serialised batch");
		assert.deepEqual(states, ["pressure", "ok"]);
		assert.equal(writer.enqueue(entry()), true);
		await writer.close();
		assert.deepEqual(writer.health(), { state: "ok", lostRecords: 0, lostBytes: 0 });
	});

	it("counts preparation expiry without an append and admits a later batch", async (t) => {
		const dir = await policyDir(t);
		let now = 0;
		t.mock.method(performance, "now", () => now);
		let prepared = () => {};
		const preparing = new Promise<void>((resolve) => { prepared = resolve; });
		let release = () => {};
		const gate = new Promise<void>((resolve) => { release = resolve; });
		let dropped = () => {};
		const lost = new Promise<void>((resolve) => { dropped = resolve; });
		const states: string[] = [];
		let attempts = 0;
		const writer = new PolicyWriter(dir, (health) => {
			states.push(health.state);
			if (health.state === "pressure") dropped();
		}, async (path, batch, retention, options) => {
			attempts++;
			await appendSerializedTelemetryRecords(path, batch, retention, { ...options, hooks: {
				afterDirectoryPreparation: async () => {
					if (attempts === 1) { prepared(); await gate; }
				},
			} });
		});
		const row = entry();
		assert.equal(writer.enqueue(row), true);
		await preparing;
		assert.deepEqual(await readdir(join(dir, "telemetry")), []);
		now = 2100;
		release();
		await lost;
		await new Promise((resolve) => setImmediate(resolve));
		const loss = { lostRecords: 1, lostBytes: serializeTelemetryRecord(row).bytes };
		assert.deepEqual(writer.health(), { state: "pressure", ...loss });
		assert.equal(attempts, 1, "expiry is not retried as lock contention");
		assert.deepEqual(await readdir(join(dir, "telemetry")), []);
		const later = { ...entry(), callId: "later-admission" };
		assert.equal(writer.enqueue(later), true);
		await writer.close();
		assert.equal(attempts, 2);
		assert.deepEqual(await segmentLines(dir, localDate(new Date(later.at))), [JSON.stringify(later)]);
		assert.deepEqual(writer.health(), { state: "ok", ...loss });
		assert.deepEqual(states, ["pressure", "ok"]);
	});

	it("drops only an expired batch and writes later batches after lock release", async (t) => {
		const dir = await policyDir(t);
		await mkdir(join(dir, "telemetry"), { recursive: true, mode: 0o700 });
		const lock = join(dir, "telemetry", ".telemetry-lock");
		await writeFile(lock, "", { mode: 0o600 });
		const writer = new PolicyWriter(dir, () => {});
		const row = entry();
		assert.equal(writer.enqueue(row), true);
		await new Promise((resolve) => setImmediate(resolve));
		const kept = { ...entry(), callId: "retained-next-batch" };
		assert.equal(writer.enqueue(kept), true);
		await delay(2150);
		assert.deepEqual(writer.health(), { state: "pressure", lostRecords: 1, lostBytes: serializeTelemetryRecord(row).bytes });
		await unlink(lock);
		const later = { ...entry(), callId: "later" };
		assert.equal(writer.enqueue(later), true);
		await writer.close();
		assert.deepEqual(await segmentLines(dir, localDate(new Date(row.at))), [JSON.stringify(kept), JSON.stringify(later)]);
		assert.deepEqual(writer.health(), { state: "ok", lostRecords: 1, lostBytes: serializeTelemetryRecord(row).bytes });
	});

	it("charges an in-flight retry batch to the record cap and recovers from queue pressure", async (t) => {
		const dir = await policyDir(t);
		await mkdir(join(dir, "telemetry"), { recursive: true, mode: 0o700 });
		const lock = join(dir, "telemetry", ".telemetry-lock");
		await writeFile(lock, "", { mode: 0o600 });
		const states: string[] = [];
		let written = () => {};
		const persisted = new Promise<void>((resolve) => { written = resolve; });
		const writer = new PolicyWriter(dir, (health) => states.push(health.state), async (...args) => {
			await appendSerializedTelemetryRecords(...args);
			written();
		});
		const row = entry();
		assert.equal(writer.enqueue(row), true);
		await delay(550);
		for (let index = 1; index < TELEMETRY_QUEUE_RECORDS; index++) assert.equal(writer.enqueue(row), true);
		assert.equal(writer.enqueue(row), false, "in-flight record occupies the last slot");
		assert.equal(writer.enqueue(row), false);
		assert.deepEqual(states, ["pressure"]);
		await unlink(lock);
		await persisted;
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(writer.enqueue(row), true);
		await writer.close();
		assert.deepEqual(writer.health(), { state: "ok", lostRecords: 2, lostBytes: serializeTelemetryRecord(row).bytes * 2 });
		assert.equal((await segmentLines(dir, localDate(new Date(row.at)))).length, TELEMETRY_QUEUE_RECORDS + 1);
	});

	it("never retries a partial append failure", async (t) => {
		const dir = await policyDir(t);
		let attempts = 0;
		let writes = 0;
		const writer = new PolicyWriter(dir, () => {}, async (path, batch, retention, options) => {
			attempts++;
			await appendSerializedTelemetryRecords(path, batch, retention, { ...options, hooks: {
				writeChunk: async (handle, bytes) => {
					if (writes++ === 0) return (await handle.write(bytes.subarray(0, 10))).bytesWritten;
					throw new Error("partial append failed");
				},
			} });
		});
		writer.enqueue(entry());
		await writer.close();
		assert.equal(attempts, 1);
		assert.equal(writes, 2);
		assert.equal(writer.health().state, "failed");
		assert.match(writer.health().reason ?? "", /partial append failed/);
		assert.equal(writer.enqueue(entry()), false);
		const files = await readdir(join(dir, "telemetry"));
		assert.equal(files.length, 1);
		assert.equal((await stat(join(dir, "telemetry", files[0]))).size, 10);
	});

	it("never retries an unlock identity failure after append", async (t) => {
		const dir = await policyDir(t);
		let attempts = 0;
		const writer = new PolicyWriter(dir, () => {}, async (path, batch, retention, options) => {
			attempts++;
			await appendSerializedTelemetryRecords(path, batch, retention, { ...options, hooks: {
				afterInventory: async () => {
					const lock = join(dir, "telemetry", ".telemetry-lock");
					await rename(lock, join(dir, "telemetry", "retained-lock"));
					await writeFile(lock, "replacement", { mode: 0o600 });
				},
			} });
		});
		const row = entry();
		writer.enqueue(row);
		await writer.close();
		assert.equal(attempts, 1);
		assert.equal(writer.health().state, "failed");
		assert.match(writer.health().reason ?? "", /lock changed/);
		assert.equal(writer.enqueue(entry()), false);
		assert.deepEqual(await segmentLines(dir, localDate(new Date(row.at))), [JSON.stringify(row)]);
	});

	it("retries after bounded jitter and leaves no idle retry work after recovery", async (t) => {
		t.mock.method(Math, "random", () => 0.5);
		const attempted: number[] = [];
		let complete = () => {};
		const recovered = new Promise<void>((resolve) => { complete = resolve; });
		const writer = new PolicyWriter("/unused", () => {}, async () => {
			attempted.push(performance.now());
			if (attempted.length === 1) throw new TelemetryLockBusyError("held");
			complete();
		});
		writer.enqueue(entry());
		await recovered;
		await new Promise((resolve) => setImmediate(resolve));
		const elapsed = attempted[1] - attempted[0];
		assert.ok(elapsed >= 70 && elapsed < 300, `75 ms jitter resumed after ${elapsed} ms`);
		assert.deepEqual(writer.health(), { state: "ok", lostRecords: 0, lostBytes: 0 });
		await delay(120);
		assert.equal(attempted.length, 2);
		await writer.close();
	});

	it("cancels retry backoff when invalid admission fails the writer", async (t) => {
		t.mock.method(Math, "random", () => 0.999);
		let attempts = 0;
		const writer = new PolicyWriter("/unused", () => {}, async () => {
			attempts++;
			throw new TelemetryLockBusyError("held");
		});
		writer.enqueue(entry());
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(writer.health().state, "pressure");
		const started = performance.now();
		assert.equal(writer.enqueue(record("invalid")), false);
		await writer.close();
		assert.ok(performance.now() - started < 50, "close cancels the pending 100 ms backoff");
		assert.equal(attempts, 1);
		assert.equal(writer.health().state, "failed");
		assert.equal(writer.health().lostRecords, 2);
	});

	it("does not retry an untyped error with the busy error message", async () => {
		let attempts = 0;
		const writer = new PolicyWriter("/unused", () => {}, async () => {
			attempts++;
			throw new Error(new TelemetryLockBusyError("/unused").message);
		});
		writer.enqueue(entry());
		await writer.close();
		assert.equal(attempts, 1);
		assert.equal(writer.health().state, "failed");
	});

	it("never extends one batch's deadline when close starts near expiry", async (t) => {
		let now = 0;
		t.mock.method(performance, "now", () => now);
		let attempted = () => {};
		const attempting = new Promise<void>((resolve) => { attempted = resolve; });
		let release = () => {};
		const gate = new Promise<void>((resolve) => { release = resolve; });
		const deadlines: number[] = [];
		const writer = new PolicyWriter("/unused", () => {}, async (_dir, _batch, _retention, options) => {
			assert.ok(options?.acquireUntil !== undefined);
			deadlines.push(options.acquireUntil);
			if (deadlines.length === 1) { attempted(); await gate; }
			else now = options.acquireUntil;
			throw new TelemetryLockBusyError("held");
		});
		const row = entry();
		assert.equal(writer.enqueue(row), true);
		await attempting;
		assert.deepEqual(deadlines, [2000]);
		now = 1900;
		const closing = writer.close();
		assert.equal(writer.enqueue(row), false);
		now = 2000;
		release();
		await closing;
		assert.deepEqual(deadlines, [2000], "close does not grant another acquisition after the original deadline");
		assert.equal(now, 2000);
		assert.deepEqual(writer.health(), { state: "pressure", lostRecords: 1, lostBytes: serializeTelemetryRecord(row).bytes });
	});

	it("bounds all shutdown acquisitions by one deadline and leaves no retry after close", async (t) => {
		const dir = await policyDir(t);
		await mkdir(join(dir, "telemetry"), { recursive: true, mode: 0o700 });
		const lock = join(dir, "telemetry", ".telemetry-lock");
		await writeFile(lock, "", { mode: 0o600 });
		let calls = 0;
		const states: string[] = [];
		const writer = new PolicyWriter(dir, (health) => states.push(health.state), async (...args) => {
			calls++;
			await appendSerializedTelemetryRecords(...args);
		});
		const row = entry();
		for (let index = 0; index < 100; index++) writer.enqueue(row);
		await delay(600);
		const started = performance.now();
		await writer.close();
		const elapsed = performance.now() - started;
		assert.ok(elapsed >= 1900 && elapsed < 2800, `close took ${elapsed} ms`);
		assert.deepEqual(writer.health(), { state: "pressure", lostRecords: 100, lostBytes: serializeTelemetryRecord(row).bytes * 100 });
		assert.deepEqual(states, ["pressure"]);
		const stopped = calls;
		await unlink(lock);
		await delay(120);
		assert.equal(calls, stopped, "no retry timer survives close");
		assert.equal(writer.enqueue(row), false);
		assert.deepEqual(await readdir(join(dir, "telemetry")), []);
	});
});
