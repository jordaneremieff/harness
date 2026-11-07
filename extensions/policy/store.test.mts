import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, type TestContext } from "node:test";
import type { PolicyRecord } from "./record.ts";
import { appendRecord, PolicyWriter } from "./store.ts";
import {
	localDate,
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
		const writer = new PolicyWriter("/unused", assert.fail, async () => {
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

	it("stops accepting at the record bound, reports once, and drains accepted work", async () => {
		const failures: string[] = [];
		let written = 0;
		const writer = new PolicyWriter(
			"/unused",
			(reason) => failures.push(reason),
			async (_dir, batch) => {
				written += batch.length;
			},
		);
		let accepted = true;
		for (let index = 0; index <= TELEMETRY_QUEUE_RECORDS; index++) accepted = writer.enqueue(entry());
		assert.equal(accepted, false, "the record past the bound is not accepted");
		assert.equal(writer.enqueue(entry()), false);
		await writer.close();
		assert.equal(failures.length, 1);
		assert.match(failures[0], /queue reached 512 records/);
		assert.equal(written, TELEMETRY_QUEUE_RECORDS);
	});

	it("stops accepting at the serialized byte bound and drains accepted work", async () => {
		const failures: string[] = [];
		let written = 0;
		let writtenBytes = 0;
		const writer = new PolicyWriter(
			"/unused",
			(reason) => failures.push(reason),
			async (_dir, batch) => {
				written += batch.length;
				for (const item of batch) writtenBytes += item.bytes;
			},
		);
		const large = { ...entry(), captured: "x".repeat(200 * 1024) };
		let accepted = 0;
		while (writer.enqueue(large)) accepted++;
		assert.ok(accepted > 0 && accepted < TELEMETRY_QUEUE_RECORDS);
		await writer.close();
		assert.equal(failures.length, 1);
		assert.match(failures[0], /queue reached 4194304 bytes/);
		assert.equal(written, accepted);
		assert.ok(writtenBytes <= TELEMETRY_QUEUE_BYTES);
	});

	it("groups queued records into bounded batches and runs an oversized permitted record alone", async () => {
		const batches: string[][] = [];
		const writer = new PolicyWriter("/unused", assert.fail, async (_dir, batch) => {
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
		const writer = new PolicyWriter("/unused", assert.fail, async (_dir, batch) => {
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
		const writer = new PolicyWriter("/unused", assert.fail, async (_dir, batch) => {
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
		const writer = new PolicyWriter("/unused", assert.fail, async (_dir, batch) => {
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
			(reason) => failures.push(reason),
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
			(reason) => failures.push(reason),
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
		const undated = new PolicyWriter("/unused", (reason) => failures.push(reason), async () => {});
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
		const writer = new PolicyWriter(dir, assert.fail);
		const at = new Date(2026, 8, 3, 12).toISOString();
		for (let index = 0; index < 5; index++) writer.enqueue({ ...record(at), callId: `c${index}` });
		await writer.close();
		assert.equal((await segmentLines(dir, "2026-09-03")).length, 5);
	});

	it("reports a held lock as a persistence failure after the bounded wait", async (t) => {
		const dir = await policyDir(t);
		await mkdir(join(dir, "telemetry"), { recursive: true, mode: 0o700 });
		await writeFile(join(dir, "telemetry", ".telemetry-lock"), "", { mode: 0o600 });
		const failures: string[] = [];
		const writer = new PolicyWriter(dir, (reason) => failures.push(reason));
		const started = Date.now();
		writer.enqueue(entry());
		await writer.close();
		assert.ok(Date.now() - started >= 400);
		assert.match(failures[0], /lock remains held/);
		await stat(join(dir, "telemetry", ".telemetry-lock"));
	});
});
