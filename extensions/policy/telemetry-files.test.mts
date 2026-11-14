import assert from "node:assert/strict";
import { execFile, execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { closeSync, constants, openSync } from "node:fs";
import { chmod, link, lstat, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import type { PolicyRecord } from "./record.ts";
import {
	appendSerializedTelemetryRecords,
	appendTelemetryRecords,
	serializeTelemetryRecord,
	readTelemetryInventory,
	TELEMETRY_INVENTORY_ENTRIES,
	TelemetryAcquisitionExpiredError,
	TELEMETRY_LEGACY_LOCK_FILE,
	TELEMETRY_LOCK_FILE,
	TelemetryLockBusyError,
	TELEMETRY_SEGMENT_BYTES,
	TelemetryUncertainAppendError,
	type TelemetryRetention,
	validateTelemetryRetention,
} from "./telemetry-files.ts";
import { readTelemetry } from "./telemetry.ts";

const execute = promisify(execFile);
const MIB = 1024 * 1024;
const DAY = "2026-09-03";
const AT = new Date(2026, 8, 3, 12).toISOString();
const RETENTION: TelemetryRetention = { maxBytes: 1024 * MIB, maxAgeDays: 30 };

const record = (callId = "c1", at = AT): PolicyRecord => ({
	session: "s1",
	mode: "tui",
	cwd: "/work",
	model: "xai/grok-4.6",
	thinkingLevel: "high",
	projectContext: false,
	ruleStoreDegraded: false,
	at,
	tool: "bash",
	callId,
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
	const base = await mkdtemp(join(tmpdir(), "policy-files-"));
	t.after(() => rm(base, { recursive: true, force: true }));
	const dir = join(base, "policy");
	await mkdir(join(dir, "telemetry"), { recursive: true, mode: 0o700 });
	return dir;
}

/** A sparse segment reports the requested size without writing its bytes. */
async function seed(dir: string, name: string, size: number): Promise<string> {
	const path = join(dir, "telemetry", name);
	await writeFile(path, "", { mode: 0o600 });
	await truncate(path, size);
	return path;
}

/** Every name except the persistent lock file, which stays after the first acquisition. */
const names = async (dir: string) =>
	(await readdir(join(dir, "telemetry"))).filter((name) => name !== TELEMETRY_LOCK_FILE).sort();
const lockPath = (dir: string) => join(dir, "telemetry", TELEMETRY_LOCK_FILE);
const legacyPath = (dir: string) => join(dir, "telemetry", TELEMETRY_LEGACY_LOCK_FILE);
/** The macOS open flag that takes the descriptor lock, as a second writer process would. */
const O_EXLOCK = 0x20;

describe("telemetry retention settings", () => {
	it("requires integers, a byte budget that holds a segment, and a positive age", () => {
		assert.deepEqual(validateTelemetryRetention({ maxBytes: TELEMETRY_SEGMENT_BYTES, maxAgeDays: 1 }), {
			maxBytes: TELEMETRY_SEGMENT_BYTES,
			maxAgeDays: 1,
		});
		for (const value of [
			{ maxBytes: TELEMETRY_SEGMENT_BYTES - 1, maxAgeDays: 30 },
			{ maxBytes: TELEMETRY_SEGMENT_BYTES + 0.5, maxAgeDays: 30 },
			{ maxBytes: Number.NaN, maxAgeDays: 30 },
			{ maxBytes: TELEMETRY_SEGMENT_BYTES, maxAgeDays: 0 },
			{ maxBytes: TELEMETRY_SEGMENT_BYTES, maxAgeDays: 1.5 },
		])
			assert.throws(() => validateTelemetryRetention(value));
	});
});

describe("telemetry inventory", () => {
	it("lists recognised segments oldest first, sums sizes, and ignores other names", async (t) => {
		const dir = await policyDir(t);
		await seed(dir, "2026-09-03.000002.jsonl", 20);
		await seed(dir, "2026-09-02.000001.jsonl", 10);
		await seed(dir, "2026-09-03.000001.jsonl", 5);
		for (const other of ["notes.txt", "2026-09-03.jsonl", "2026-09-03.1.jsonl", ".telemetry-lock"])
			await writeFile(join(dir, "telemetry", other), "x");
		const inventory = await readTelemetryInventory(dir);
		assert.equal(inventory.directory, "available");
		assert.equal(inventory.incomplete, false);
		assert.equal(inventory.totalBytes, 35);
		assert.deepEqual(
			inventory.entries.map((entry) => [entry.name, entry.size]),
			[
				["2026-09-02.000001.jsonl", 10],
				["2026-09-03.000001.jsonl", 5],
				["2026-09-03.000002.jsonl", 20],
			],
		);
	});

	it("reports a missing, symlinked, or nonregular directory without creating it", async (t) => {
		const dir = await policyDir(t);
		const base = join(dir, "..");
		assert.equal((await readTelemetryInventory(join(base, "absent"))).directory, "missing");
		await rm(join(dir, "telemetry"), { recursive: true });
		await writeFile(join(dir, "telemetry"), "file");
		assert.equal((await readTelemetryInventory(dir)).directory, "nonregular");
		await rm(join(dir, "telemetry"));
		await mkdir(join(base, "target"));
		await symlink(join(base, "target"), join(dir, "telemetry"));
		assert.equal((await readTelemetryInventory(dir)).directory, "symlink");
		await assert.rejects(lstat(join(base, "absent")), { code: "ENOENT" });
	});

	it("marks a listing beyond the entry bound and unsafe segment names incomplete", async (t) => {
		const dir = await policyDir(t);
		for (let index = 0; index < TELEMETRY_INVENTORY_ENTRIES + 1; index++)
			await writeFile(join(dir, "telemetry", `other-${index}`), "");
		assert.equal((await readTelemetryInventory(dir)).incomplete, true);
		const unsafe = await policyDir(t);
		await symlink("/nonexistent", join(unsafe, "telemetry", "2026-09-01.000001.jsonl"));
		const inventory = await readTelemetryInventory(unsafe);
		assert.equal(inventory.incomplete, true);
		assert.equal(inventory.entries[0].unsafe, "symlink");
	});
});

describe("telemetry append, rotation and retention", () => {
	it("appends a batch as complete newline-framed lines and releases the lock", async (t) => {
		const dir = await policyDir(t);
		await appendTelemetryRecords(dir, [record("a"), record("b"), record("c")], RETENTION);
		const text = await readFile(join(dir, "telemetry", `${DAY}.000001.jsonl`), "utf8");
		assert.ok(text.endsWith("\n"));
		assert.deepEqual(text.split("\n").filter(Boolean).map((line) => JSON.parse(line).callId), ["a", "b", "c"]);
		assert.deepEqual(await names(dir), [`${DAY}.000001.jsonl`]);
	});

	it("groups a batch that spans two local days into each day's segment", async (t) => {
		const dir = await policyDir(t);
		const next = new Date(2026, 8, 4, 12).toISOString();
		await appendTelemetryRecords(dir, [record("a"), record("b", next), record("c")], RETENTION);
		assert.deepEqual(await names(dir), [`${DAY}.000001.jsonl`, "2026-09-04.000001.jsonl"]);
	});

	it("rotates to the next ordinal when a batch would pass the segment size", async (t) => {
		const dir = await policyDir(t);
		const full = await seed(dir, `${DAY}.000001.jsonl`, TELEMETRY_SEGMENT_BYTES - 100);
		await appendTelemetryRecords(dir, [record("a")], RETENTION);
		assert.equal((await stat(full)).size, TELEMETRY_SEGMENT_BYTES - 100, "the full segment is not appended to");
		const rotated = JSON.parse((await readFile(join(dir, "telemetry", `${DAY}.000002.jsonl`), "utf8")).trim());
		assert.equal(rotated.callId, "a");
		await appendTelemetryRecords(dir, [record("b")], RETENTION);
		assert.equal((await readFile(join(dir, "telemetry", `${DAY}.000002.jsonl`), "utf8")).split("\n").filter(Boolean).length, 2);
		assert.deepEqual(await names(dir), [`${DAY}.000001.jsonl`, `${DAY}.000002.jsonl`]);
	});

	it("removes segments older than the age budget and keeps newer and unrecognised names", async (t) => {
		const dir = await policyDir(t);
		await seed(dir, "2026-07-01.000001.jsonl", 10);
		await seed(dir, "2026-07-02.000002.jsonl", 10);
		await seed(dir, "2026-08-10.000001.jsonl", 10);
		await writeFile(join(dir, "telemetry", "2020-01-01.jsonl"), "legacy");
		await writeFile(join(dir, "telemetry", "notes.txt"), "keep");
		await appendTelemetryRecords(dir, [record("a")], { maxBytes: 1024 * MIB, maxAgeDays: 30 });
		assert.deepEqual(await names(dir), [
			"2020-01-01.jsonl",
			"2026-08-10.000001.jsonl",
			`${DAY}.000001.jsonl`,
			"notes.txt",
		]);
	});

	it("keeps a one-day budget to the current local day", async (t) => {
		const dir = await policyDir(t);
		await seed(dir, "2026-09-02.000001.jsonl", 10);
		await appendTelemetryRecords(dir, [record("a")], { maxBytes: 1024 * MIB, maxAgeDays: 1 });
		assert.deepEqual(await names(dir), [`${DAY}.000001.jsonl`]);
	});

	it("removes the oldest segments first until the projected size fits the byte budget", async (t) => {
		const dir = await policyDir(t);
		await seed(dir, "2026-09-01.000001.jsonl", 20 * MIB);
		await seed(dir, "2026-09-02.000001.jsonl", 20 * MIB);
		await seed(dir, `${DAY}.000001.jsonl`, TELEMETRY_SEGMENT_BYTES - 10);
		await appendTelemetryRecords(dir, [record("a")], { maxBytes: 48 * MIB, maxAgeDays: 30 });
		assert.deepEqual(await names(dir), [`${DAY}.000001.jsonl`, `${DAY}.000002.jsonl`]);
		const inventory = await readTelemetryInventory(dir);
		assert.ok(inventory.totalBytes <= 48 * MIB);
	});

	it("never removes the segment it appends to, and fits a rotated segment at the smallest budget", async (t) => {
		const dir = await policyDir(t);
		await seed(dir, `${DAY}.000001.jsonl`, 1000);
		await seed(dir, "2026-09-02.000001.jsonl", 40 * MIB);
		await appendTelemetryRecords(dir, [record("a")], { maxBytes: TELEMETRY_SEGMENT_BYTES, maxAgeDays: 30 });
		assert.deepEqual(await names(dir), [`${DAY}.000001.jsonl`]);
		assert.ok((await readFile(join(dir, "telemetry", `${DAY}.000001.jsonl`), "utf8")).includes("\"callId\":\"a\""));
	});

	it("removes a full segment when the smallest budget needs the room for a rotated one", async (t) => {
		const dir = await policyDir(t);
		await seed(dir, `${DAY}.000001.jsonl`, TELEMETRY_SEGMENT_BYTES);
		await appendTelemetryRecords(dir, [record("a")], { maxBytes: TELEMETRY_SEGMENT_BYTES, maxAgeDays: 30 });
		assert.deepEqual(await names(dir), [`${DAY}.000002.jsonl`]);
	});
});

describe("telemetry safety", () => {
	it("never removes or follows symbolic links, nonregular files, or unrecognised names", async (t) => {
		const dir = await policyDir(t);
		const outside = join(dir, "..", "outside.txt");
		await writeFile(outside, "keep");
		await seed(dir, "2026-07-01.000001.jsonl", 10);
		await symlink(outside, join(dir, "telemetry", "2026-07-02.000001.jsonl"));
		const before = await names(dir);
		await assert.rejects(appendTelemetryRecords(dir, [record("a")], RETENTION), /nonregular or symbolic link/);
		assert.deepEqual(await names(dir), before);
		assert.equal(await readFile(outside, "utf8"), "keep");
	});

	it("refuses a FIFO segment without waiting for a peer", { timeout: 10_000, skip: process.platform === "win32" }, async (t) => {
		const dir = await policyDir(t);
		execFileSync("mkfifo", [join(dir, "telemetry", "2026-07-02.000001.jsonl")]);
		await assert.rejects(appendTelemetryRecords(dir, [record("a")], RETENTION), /nonregular or symbolic link/);
		assert.deepEqual(await names(dir), ["2026-07-02.000001.jsonl"]);
	});

	it("refuses an inventory beyond the entry bound without removing anything", async (t) => {
		const dir = await policyDir(t);
		await seed(dir, "2026-07-01.000001.jsonl", 10);
		for (let index = 0; index < TELEMETRY_INVENTORY_ENTRIES; index++)
			await writeFile(join(dir, "telemetry", `other-${index}`), "");
		await assert.rejects(appendTelemetryRecords(dir, [record("a")], RETENTION), /inventory is incomplete/);
		assert.equal((await names(dir)).length, TELEMETRY_INVENTORY_ENTRIES + 1);
	});

	it("refuses to remove a segment whose identity changed after inspection", async (t) => {
		const dir = await policyDir(t);
		const outside = join(dir, "..", "outside.txt");
		await writeFile(outside, "keep");
		const old = await seed(dir, "2026-07-01.000001.jsonl", 10);
		await assert.rejects(
			appendTelemetryRecords(dir, [record("a")], RETENTION, {
				afterInventory: async () => {
					await rm(old);
					await symlink(outside, old);
				},
			}),
			/changed after inspection/,
		);
		assert.equal((await lstat(old)).isSymbolicLink(), true);
		assert.equal(await readFile(outside, "utf8"), "keep");
		assert.ok(!(await names(dir)).includes(`${DAY}.000001.jsonl`));
		assert.ok(!(await names(dir)).includes(".telemetry-lock"), "the lock is released after a failure");
	});

	it("reports a failed removal, appends nothing, and releases the lock", async (t) => {
		const dir = await policyDir(t);
		await seed(dir, "2026-07-01.000001.jsonl", 10);
		await assert.rejects(
			appendTelemetryRecords(dir, [record("a")], RETENTION, {
				unlinkSegment: async () => {
					throw new Error("unlink refused");
				},
			}),
			/unlink refused/,
		);
		assert.deepEqual(await names(dir), ["2026-07-01.000001.jsonl"]);
	});

	it("reports a failed write and releases the lock", { skip: process.getuid?.() === 0 }, async (t) => {
		const dir = await policyDir(t);
		const path = await seed(dir, `${DAY}.000001.jsonl`, 0);
		await chmod(path, 0o400);
		await assert.rejects(appendTelemetryRecords(dir, [record("a")], RETENTION));
		assert.deepEqual(await names(dir), [`${DAY}.000001.jsonl`]);
		assert.equal((await readFile(path, "utf8")).length, 0);
	});

	it("rejects the whole batch when one record is invalid", async (t) => {
		const dir = await policyDir(t);
		await assert.rejects(appendTelemetryRecords(dir, [record("a"), record("b", "not-a-date")], RETENTION), /invalid policy timestamp/);
		assert.deepEqual(await names(dir), []);
	});
});

describe("telemetry lock", () => {
	it("expires after delayed directory preparation without creating a free lock or appending", async (t) => {
		const dir = await policyDir(t);
		let now = 0;
		t.mock.method(performance, "now", () => now);
		let prepared = () => {};
		const preparing = new Promise<void>((resolve) => { prepared = resolve; });
		let release = () => {};
		const gate = new Promise<void>((resolve) => { release = resolve; });
		const appending = appendSerializedTelemetryRecords(dir, [serializeTelemetryRecord(record())], RETENTION, {
			acquireUntil: 2000,
			hooks: { afterDirectoryPreparation: async () => { prepared(); await gate; } },
		});
		const expired = assert.rejects(appending, (error: unknown) => {
			assert.ok(error instanceof TelemetryAcquisitionExpiredError);
			assert.ok(!(error instanceof TelemetryLockBusyError));
			return true;
		});
		await preparing;
		assert.deepEqual(await readdir(join(dir, "telemetry")), []);
		now = 2100;
		release();
		await expired;
		assert.deepEqual(await readdir(join(dir, "telemetry")), [], "expiry opens no lock file");
	});

	it("finishes an acquired append and lock cleanup after its acquisition deadline", async (t) => {
		const dir = await policyDir(t);
		let now = 0;
		t.mock.method(performance, "now", () => now);
		const row = record();
		await appendSerializedTelemetryRecords(dir, [serializeTelemetryRecord(row)], RETENTION, {
			acquireUntil: 2000,
			hooks: { afterInventory: async () => { now = 2100; } },
		});
		assert.deepEqual(await names(dir), [`${DAY}.000001.jsonl`]);
		const lines = (await readFile(join(dir, "telemetry", `${DAY}.000001.jsonl`), "utf8")).split("\n").filter(Boolean);
		assert.deepEqual(lines, [JSON.stringify(row)]);
	});

	it("fails within the acquisition limit on a held lock and never removes it", async (t) => {
		const dir = await policyDir(t);
		const lock = join(dir, "telemetry", ".telemetry-lock");
		await writeFile(lock, "other-owner", { mode: 0o600 });
		const identity = await stat(lock);
		const started = Date.now();
		await assert.rejects(appendTelemetryRecords(dir, [record("a")], RETENTION), (error: unknown) => {
			assert.ok(error instanceof TelemetryLockBusyError);
			assert.equal(error.holder?.path, "telemetry/.telemetry-lock");
			assert.equal(error.holder?.ownership, "uncertain", "a lock file of an earlier release has no provable owner");
			return true;
		});
		const elapsed = Date.now() - started;
		assert.ok(elapsed >= 400 && elapsed < 5000, `waited ${elapsed} ms`);
		assert.equal(await readFile(lock, "utf8"), "other-owner");
		assert.equal((await stat(lock)).ino, identity.ino);
		assert.deepEqual(await names(dir), [".telemetry-lock"]);
	});

	it("caps acquisition by the caller's remaining batch budget", async (t) => {
		const dir = await policyDir(t);
		const lock = join(dir, "telemetry", ".telemetry-lock");
		await writeFile(lock, "held", { mode: 0o600 });
		const started = performance.now();
		await assert.rejects(appendSerializedTelemetryRecords(dir, [serializeTelemetryRecord(record())], RETENTION, {
			acquireUntil: started + 40,
		}), TelemetryLockBusyError);
		const elapsed = performance.now() - started;
		assert.ok(elapsed >= 35 && elapsed < 300, `acquisition took ${elapsed} ms`);
		assert.equal(await readFile(lock, "utf8"), "held");
	});

	it("refuses foreign lock ownership as a permanent error", async (t) => {
		const dir = await policyDir(t);
		const lock = join(dir, "telemetry", ".telemetry-lock");
		await writeFile(lock, "held", { mode: 0o600 });
		await assert.rejects(appendTelemetryRecords(dir, [record("a")], RETENTION, {
			foreignOwner: (path) => path === lock,
		}), (error: unknown) => {
			assert.ok(error instanceof Error && !(error instanceof TelemetryLockBusyError));
			assert.match(error.message, /not owned by this user/);
			return true;
		});
		assert.equal(await readFile(lock, "utf8"), "held");
	});

	it("refuses a lock that is a symbolic link or a directory without following it", async (t) => {
		const dir = await policyDir(t);
		const target = join(dir, "..", "target.txt");
		await writeFile(target, "keep");
		const lock = join(dir, "telemetry", ".telemetry-lock");
		await symlink(target, lock);
		await assert.rejects(appendTelemetryRecords(dir, [record("a")], RETENTION), /lock is not a regular non-symlink file/);
		assert.equal(await readFile(target, "utf8"), "keep");
		await rm(lock);
		await mkdir(lock);
		await assert.rejects(appendTelemetryRecords(dir, [record("a")], RETENTION), /lock is not a regular non-symlink file/);
	});

	it("writes nothing and removes nothing after a lock name changed while it was held", async (t) => {
		const dir = await policyDir(t);
		const lock = legacyPath(dir);
		await assert.rejects(
			appendTelemetryRecords(dir, [record("a")], RETENTION, {
				afterInventory: async () => {
					await rm(lock);
					await writeFile(lock, "intruder");
				},
			}),
			(error: unknown) => {
				assert.ok(error instanceof Error && !(error instanceof TelemetryUncertainAppendError));
				assert.match(error.message, /lock changed while held/);
				return true;
			},
		);
		assert.equal(await readFile(lock, "utf8"), "intruder");
		assert.deepEqual(await names(dir), [".telemetry-lock"], "no segment is created without the lock");
	});

	it("marks an append uncertain when it fails after the first record byte", async (t) => {
		const dir = await policyDir(t);
		let writes = 0;
		await assert.rejects(
			appendTelemetryRecords(dir, [record("a")], RETENTION, {
				writeChunk: async (handle, bytes) => {
					if (writes++ === 0) return (await handle.write(bytes.subarray(0, 10))).bytesWritten;
					throw new Error("disk refused the rest");
				},
			}),
			(error: unknown) => {
				assert.ok(error instanceof TelemetryUncertainAppendError);
				assert.match(error.message, /disk refused the rest/);
				return true;
			},
		);
		assert.equal((await stat(join(dir, "telemetry", `${DAY}.000001.jsonl`))).size, 10);
		assert.deepEqual(await names(dir), [`${DAY}.000001.jsonl`], "the legacy name is removed after the failure");
	});

	it("keeps one empty private lock file and links the legacy name only while it appends", async (t) => {
		const dir = await policyDir(t);
		let linked: number | undefined;
		await appendTelemetryRecords(dir, [record("a")], RETENTION, {
			afterInventory: async () => { linked = (await lstat(legacyPath(dir))).ino; },
		});
		const first = await lstat(lockPath(dir));
		assert.equal(linked, first.ino, "the legacy name is the lock file itself while the append runs");
		assert.equal(first.isFile(), true);
		assert.equal(first.mode & 0o777, 0o600);
		assert.equal(first.size, 0);
		assert.equal(first.nlink, 1);
		await assert.rejects(lstat(legacyPath(dir)), { code: "ENOENT" });
		await appendTelemetryRecords(dir, [record("b")], RETENTION);
		assert.equal((await lstat(lockPath(dir))).ino, first.ino, "the lock file is never replaced");
	});

	it("waits on a running writer's descriptor lock, reports it as live, and appends after its release", async (t) => {
		const dir = await policyDir(t);
		const held = openSync(lockPath(dir), constants.O_RDWR | constants.O_CREAT | constants.O_NONBLOCK | O_EXLOCK, 0o600);
		let open = true;
		t.after(() => { if (open) closeSync(held); });
		const started = Date.now();
		await assert.rejects(appendTelemetryRecords(dir, [record("a")], RETENTION), (error: unknown) => {
			assert.ok(error instanceof TelemetryLockBusyError);
			assert.deepEqual(error.holder, { path: "telemetry/.telemetry-writer.lock", ownership: "live" });
			return true;
		});
		const elapsed = Date.now() - started;
		assert.ok(elapsed >= 400 && elapsed < 5000, `waited ${elapsed} ms`);
		assert.deepEqual(await names(dir), [], "a waiting writer creates neither the legacy name nor a segment");
		closeSync(held);
		open = false;
		await appendTelemetryRecords(dir, [record("a")], RETENTION);
		assert.deepEqual(await names(dir), [`${DAY}.000001.jsonl`]);
	});

	it("refuses a lock file with group or other permissions without changing it", async (t) => {
		const dir = await policyDir(t);
		await writeFile(lockPath(dir), "", { mode: 0o600 });
		await chmod(lockPath(dir), 0o644);
		await assert.rejects(appendTelemetryRecords(dir, [record("a")], RETENTION), /lock permissions are not private/);
		assert.equal((await lstat(lockPath(dir))).mode & 0o777, 0o644);
		assert.deepEqual(await names(dir), []);
	});

	it("takes over a legacy name that carries the lock file's identity", async (t) => {
		const dir = await policyDir(t);
		await writeFile(lockPath(dir), "", { mode: 0o600 });
		await link(lockPath(dir), legacyPath(dir));
		let recovered = 0;
		const options = { onStaleLock: () => { recovered++; } };
		await appendSerializedTelemetryRecords(dir, [serializeTelemetryRecord(record("a"))], RETENTION, options);
		assert.equal(recovered, 1);
		assert.deepEqual(await names(dir), [`${DAY}.000001.jsonl`], "the taken-over name is removed on release");
		await appendSerializedTelemetryRecords(dir, [serializeTelemetryRecord(record("b"))], RETENTION, options);
		assert.equal(recovered, 1, "a clean acquisition is not a recovery");
	});

	it("recovers by itself after a writer process dies while it holds the lock", { timeout: 60_000 }, async (t) => {
		const dir = await policyDir(t);
		const script = `
			import { appendTelemetryRecords } from ${JSON.stringify(new URL("./telemetry-files.ts", import.meta.url).href)};
			const [dir, at] = process.argv.slice(1);
			const entry = {
				session: "s", mode: "tui", cwd: "/w", model: "m", thinkingLevel: "high", projectContext: false,
				ruleStoreDegraded: false, at, tool: "bash", callId: "dying", durationMs: 1, outputBytes: 1,
				policyMode: "observe", truncated: false, error: false, errorKind: null, tokens: null, classes: [], captured: "x",
			};
			await appendTelemetryRecords(dir, [entry], { maxBytes: 1024 * 1024 * 1024, maxAgeDays: 30 }, {
				afterInventory: async () => {
					process.stdout.write("held\\n");
					await new Promise(() => { setInterval(() => {}, 1000); });
				},
			});
		`;
		const child = spawn(process.execPath, ["--input-type=module", "--eval", script, dir, AT], { stdio: ["ignore", "pipe", "inherit"] });
		t.after(() => { child.kill("SIGKILL"); });
		const exited = once(child, "exit");
		await Promise.race([
			once(child.stdout, "data"),
			exited.then(() => { throw new Error("the writer process exited before it held the lock"); }),
		]);
		await assert.rejects(
			appendSerializedTelemetryRecords(dir, [serializeTelemetryRecord(record("waiting"))], RETENTION, { acquireUntil: performance.now() + 80 }),
			(error: unknown) => error instanceof TelemetryLockBusyError && error.holder?.ownership === "live",
			"a running holder is live contention, not a stale lock",
		);
		child.kill("SIGKILL");
		await exited;
		assert.equal((await lstat(legacyPath(dir))).ino, (await lstat(lockPath(dir))).ino, "the dead writer left its link under the legacy name");
		let recovered = 0;
		await appendSerializedTelemetryRecords(dir, [serializeTelemetryRecord(record("after"))], RETENTION, {
			onStaleLock: () => { recovered++; },
		});
		assert.equal(recovered, 1);
		await assert.rejects(lstat(legacyPath(dir)), { code: "ENOENT" });
		const lines = (await readFile(join(dir, "telemetry", `${DAY}.000001.jsonl`), "utf8")).split("\n").filter(Boolean);
		assert.deepEqual(lines.map((line) => JSON.parse(line).callId), ["after"]);
	});

	it("excludes a writer of an earlier release in both directions", { timeout: 60_000 }, async (t) => {
		const dir = await policyDir(t);
		const counter = join(dir, "..", "counter");
		await writeFile(counter, "0");
		// The lock steps of an earlier release: exclusive creation, work, removal. Lost counter
		// updates show two writers inside the lock together.
		const earlierWriter = `
			import { constants } from "node:fs";
			import { open, readFile, unlink, writeFile } from "node:fs/promises";
			import { setTimeout as delay } from "node:timers/promises";
			const [lock, counter, count] = process.argv.slice(1);
			for (let index = 0; index < Number(count); index++) {
				let handle;
				while (!handle) {
					try {
						handle = await open(lock, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
					} catch (error) {
						if (error.code !== "EEXIST") throw error;
						await delay(1);
					}
				}
				const value = Number(await readFile(counter, "utf8"));
				await delay(2);
				await writeFile(counter, String(value + 1));
				await unlink(lock);
				await handle.close();
			}
		`;
		const earlier = execute(process.execPath, ["--input-type=module", "--eval", earlierWriter, legacyPath(dir), counter, "120"], {
			timeout: 45_000,
			killSignal: "SIGKILL",
			maxBuffer: 65536,
		});
		while ((await readFile(counter, "utf8")) === "0") await delay(5);
		const countUnderLock = async () => {
			const value = Number(await readFile(counter, "utf8"));
			await delay(2);
			await writeFile(counter, String(value + 1));
		};
		const appendAfterContention = async (callId: string, attempt = 0): Promise<void> => {
			try {
				await appendTelemetryRecords(dir, [record(callId)], RETENTION, { afterInventory: countUnderLock });
			} catch (error) {
				if (attempt >= 40 || !(error instanceof TelemetryLockBusyError)) throw error;
				await appendAfterContention(callId, attempt + 1);
			}
		};
		for (let index = 0; index < 40; index++) await appendAfterContention(`n${index}`);
		await earlier;
		assert.equal(await readFile(counter, "utf8"), "160", "no update was lost, so no two writers held the lock together");
		assert.equal((await readTelemetry(dir, DAY, DAY)).records, 40);
		assert.deepEqual(await names(dir), [`${DAY}.000001.jsonl`]);
	});
});

describe("telemetry across processes", () => {
	it("keeps every record once, with complete lines, through concurrent appends and one rotation", { timeout: 60_000 }, async (t) => {
		const dir = await policyDir(t);
		await seed(dir, "2026-09-01.000001.jsonl", 20 * MIB);
		await seed(dir, "2026-09-02.000001.jsonl", 20 * MIB);
		await seed(dir, `${DAY}.000001.jsonl`, TELEMETRY_SEGMENT_BYTES - 200);
		const script = `
			import { appendTelemetryRecords, TelemetryLockBusyError } from ${JSON.stringify(new URL("./telemetry-files.ts", import.meta.url).href)};
			const [dir, id, count, at] = process.argv.slice(1);
			const retention = { maxBytes: 48 * 1024 * 1024, maxAgeDays: 30 };
			for (let index = 0; index < Number(count); index++) {
				const entry = {
					session: "s", mode: "tui", cwd: "/w", model: "m", thinkingLevel: "high", projectContext: false,
					ruleStoreDegraded: false, at, tool: "bash", callId: id + "-" + index, durationMs: 1, outputBytes: 1,
					policyMode: "observe", truncated: false, error: false, errorKind: null, tokens: null, classes: [], captured: "x",
				};
				for (let attempt = 0; ; attempt++) {
					try {
						await appendTelemetryRecords(dir, [entry], retention);
						break;
					} catch (error) {
						if (attempt >= 20 || !(error instanceof TelemetryLockBusyError)) throw error;
					}
				}
			}
		`;
		const children = ["p0", "p1", "p2"].map((id) =>
			execute(process.execPath, ["--input-type=module", "--eval", script, dir, id, "12", AT], {
				timeout: 45_000,
				killSignal: "SIGKILL",
				maxBuffer: 65536,
			}),
		);
		await Promise.all(children);
		const files = await names(dir);
		assert.deepEqual(files, [`${DAY}.000001.jsonl`, `${DAY}.000002.jsonl`], "retention removed the older days once");
		const text = await readFile(join(dir, "telemetry", `${DAY}.000002.jsonl`), "utf8");
		assert.ok(text.endsWith("\n"));
		const ids = text.split("\n").filter(Boolean).map((line) => JSON.parse(line).callId);
		assert.equal(ids.length, 36);
		assert.equal(new Set(ids).size, 36);
		const summary = await readTelemetry(dir, DAY, DAY);
		assert.equal(summary.records, 36);
		assert.equal(summary.coverage.malformedLines, 0);
		assert.ok((await readTelemetryInventory(dir)).totalBytes <= 48 * MIB);
	});
});

describe("telemetry segment ownership and identity", () => {
	it("marks a foreign-owned recognised segment unsafe in the inventory", async (t) => {
		const dir = await policyDir(t);
		const foreign = await seed(dir, "2026-07-01.000001.jsonl", 10);
		await seed(dir, "2026-07-02.000001.jsonl", 5);
		const inventory = await readTelemetryInventory(dir, { foreignOwner: (path) => path === foreign });
		assert.equal(inventory.incomplete, true);
		assert.equal(inventory.totalBytes, 5);
		assert.deepEqual(
			inventory.entries.map((entry) => [entry.name, entry.unsafe]),
			[
				["2026-07-01.000001.jsonl", "foreign-owner"],
				["2026-07-02.000001.jsonl", null],
			],
		);
	});

	it("fails a write without deleting a foreign-owned segment", async (t) => {
		const dir = await policyDir(t);
		const foreign = await seed(dir, "2026-07-01.000001.jsonl", 10);
		await assert.rejects(
			appendTelemetryRecords(dir, [record("a")], RETENTION, { foreignOwner: (path) => path === foreign }),
			/foreign-owned segment/,
		);
		assert.deepEqual(await names(dir), ["2026-07-01.000001.jsonl"]);
	});

	it("rechecks ownership immediately before removal", async (t) => {
		const dir = await policyDir(t);
		const old = await seed(dir, "2026-07-01.000001.jsonl", 10);
		let swapped = false;
		await assert.rejects(
			appendTelemetryRecords(dir, [record("a")], RETENTION, {
				afterInventory: async () => {
					swapped = true;
				},
				foreignOwner: (path) => swapped && path === old,
			}),
			/changed after inspection/,
		);
		assert.deepEqual(await names(dir), ["2026-07-01.000001.jsonl"]);
	});

	it("retires a segment created earlier in the same batch under a one-day age budget", async (t) => {
		const dir = await policyDir(t);
		const next = new Date(2026, 8, 4, 12).toISOString();
		await appendTelemetryRecords(dir, [record("a"), record("b", next)], { maxBytes: 1024 * MIB, maxAgeDays: 1 });
		assert.deepEqual(await names(dir), ["2026-09-04.000001.jsonl"]);
	});

	it("retires a segment created earlier in the same batch to fit the byte budget", { timeout: 60_000 }, async (t) => {
		const dir = await policyDir(t);
		const next = new Date(2026, 8, 4, 12).toISOString();
		const big = (id: string, at: string): PolicyRecord => ({ ...record(id, at), captured: "x".repeat(250_000) });
		const first = Array.from({ length: 100 }, (_, index) => big(`a${index}`, AT));
		const second = Array.from({ length: 50 }, (_, index) => big(`b${index}`, next));
		await appendTelemetryRecords(dir, [...first, ...second], { maxBytes: TELEMETRY_SEGMENT_BYTES, maxAgeDays: 30 });
		assert.deepEqual(await names(dir), ["2026-09-04.000001.jsonl"]);
		assert.ok((await readTelemetryInventory(dir)).totalBytes <= TELEMETRY_SEGMENT_BYTES);
	});
});
