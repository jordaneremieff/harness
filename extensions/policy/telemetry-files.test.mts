import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, type TestContext } from "node:test";
import { promisify } from "node:util";
import type { PolicyRecord } from "./record.ts";
import {
	appendSerializedTelemetryRecords,
	appendTelemetryRecords,
	serializeTelemetryRecord,
	readTelemetryInventory,
	TELEMETRY_INVENTORY_ENTRIES,
	TelemetryLockBusyError,
	TELEMETRY_SEGMENT_BYTES,
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

const names = async (dir: string) => (await readdir(join(dir, "telemetry"))).sort();

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
		assert.equal((await readdir(join(dir, "telemetry"))).length, TELEMETRY_INVENTORY_ENTRIES + 1);
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
	it("fails within the acquisition limit on a held lock and never removes it", async (t) => {
		const dir = await policyDir(t);
		const lock = join(dir, "telemetry", ".telemetry-lock");
		await writeFile(lock, "other-owner", { mode: 0o600 });
		const identity = await stat(lock);
		const started = Date.now();
		await assert.rejects(appendTelemetryRecords(dir, [record("a")], RETENTION), TelemetryLockBusyError);
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

	it("refuses to remove a lock whose identity changed while it was held", async (t) => {
		const dir = await policyDir(t);
		const lock = join(dir, "telemetry", ".telemetry-lock");
		await assert.rejects(
			appendTelemetryRecords(dir, [record("a")], RETENTION, {
				afterInventory: async () => {
					await rm(lock);
					await writeFile(lock, "intruder");
				},
			}),
			/lock changed; refusing to remove/,
		);
		assert.equal(await readFile(lock, "utf8"), "intruder");
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
