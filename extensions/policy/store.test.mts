import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";
import type { PolicyRecord } from "./record.ts";
import { appendRecord, localDate, MAX_QUEUED_RECORDS, PolicyWriter, resolvePolicyDir } from "./store.ts";

const record = (at: string): PolicyRecord => ({
	session: "s1",
	mode: "tui",
	cwd: "/work",
	projectContext: false,
	at,
	tool: "bash",
	callId: "c1",
	durationMs: 12,
	outputBytes: 34,
	truncated: false,
	error: false,
	errorKind: null,
	tokens: null,
	classes: ["routing.cat-read"],
	command: "cat a",
});

describe("resolvePolicyDir", () => {
	it("prefers the documented override", () => {
		assert.equal(resolvePolicyDir({ PI_POLICY_DIR: "/custom/policy" } as NodeJS.ProcessEnv), "/custom/policy");
	});

	it("resolves a relative override", () => {
		assert.equal(resolvePolicyDir({ PI_POLICY_DIR: "records" } as NodeJS.ProcessEnv), resolve("records"));
	});

	it("defaults under the agent directory", () => {
		assert.equal(resolvePolicyDir({} as NodeJS.ProcessEnv, "/agent"), join("/agent", "policy"));
	});
});

describe("localDate", () => {
	it("pads month and day", () => {
		assert.equal(localDate(new Date(2026, 8, 3, 12)), "2026-09-03");
	});
});

describe("appendRecord", () => {
	it("writes one private JSONL line per record", async () => {
		const dir = join(await mkdtemp(join(tmpdir(), "policy-store-")), "store");
		const entry = record(new Date(2026, 8, 3, 12).toISOString());
		assert.equal(await appendRecord(dir, entry), null);
		assert.equal(await appendRecord(dir, entry), null);

		const path = join(dir, "2026-09-03.jsonl");
		const lines = (await readFile(path, "utf8")).trim().split("\n");
		assert.equal(lines.length, 2);
		assert.deepEqual(JSON.parse(lines[0]), entry);
		assert.equal((await stat(path)).mode & 0o777, 0o600);
		assert.equal((await stat(dir)).mode & 0o777, 0o700);
	});

	it("keeps concurrent record appends as complete JSONL lines", async () => {
		const dir = join(await mkdtemp(join(tmpdir(), "policy-store-")), "store");
		const at = new Date(2026, 8, 3, 12).toISOString();
		const entries = Array.from({ length: 64 }, (_, index) => ({ ...record(at), callId: `c${index}` }));
		assert.deepEqual(await Promise.all(entries.map((entry) => appendRecord(dir, entry))), entries.map(() => null));
		const lines = (await readFile(join(dir, "2026-09-03.jsonl"), "utf8")).trim().split("\n");
		assert.equal(lines.length, entries.length);
		assert.deepEqual(new Set(lines.map((line) => JSON.parse(line).callId)), new Set(entries.map((entry) => entry.callId)));
	});

	it("returns the failure instead of throwing when the store is not a directory", async () => {
		const base = await mkdtemp(join(tmpdir(), "policy-store-"));
		const path = join(base, "blocked");
		await writeFile(path, "not a directory", "utf8");
		const failure = await appendRecord(path, record(new Date().toISOString()));
		assert.ok(failure, "expected a failure message");
	});

	it("refuses a symbolic-link directory", async () => {
		const base = await mkdtemp(join(tmpdir(), "policy-store-"));
		const target = join(base, "target");
		const path = join(base, "link");
		await mkdir(target, { mode: 0o700 });
		await symlink(target, path);
		assert.match((await appendRecord(path, record(new Date().toISOString()))) ?? "", /not a regular directory/);
	});

	it("refuses broad existing permissions instead of changing them", async () => {
		const base = await mkdtemp(join(tmpdir(), "policy-store-"));
		const path = join(base, "shared");
		await mkdir(path, { mode: 0o755 });
		await chmod(path, 0o755);
		assert.match((await appendRecord(path, record(new Date().toISOString()))) ?? "", /permissions are not private/);
		assert.equal((await stat(path)).mode & 0o777, 0o755);
	});

	it("rejects an invalid record timestamp", async () => {
		const path = join(await mkdtemp(join(tmpdir(), "policy-store-")), "store");
		assert.match((await appendRecord(path, record("not-a-date"))) ?? "", /invalid policy timestamp/);
	});
});

describe("PolicyWriter", () => {
	it("returns from enqueue before a write and closes after accepted work", async () => {
		let release = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let started = false;
		const writer = new PolicyWriter("/unused", assert.fail, async () => {
			started = true;
			await gate;
			return null;
		});
		writer.enqueue(record(new Date().toISOString()));
		await Promise.resolve();
		assert.equal(started, true);
		let flushed = false;
		const flushing = writer.close().then(() => {
			flushed = true;
		});
		await Promise.resolve();
		assert.equal(flushed, false);
		release();
		await flushing;
		assert.equal(flushed, true);
	});

	it("stops accepting at the queue bound and preserves accepted writes", async () => {
		const failures: string[] = [];
		let writes = 0;
		const writer = new PolicyWriter("/unused", (reason) => failures.push(reason), async () => {
			writes++;
			return null;
		});
		const entry = record(new Date().toISOString());
		for (let index = 0; index <= MAX_QUEUED_RECORDS; index++) writer.enqueue(entry);
		await writer.close();
		assert.equal(failures.length, 1);
		assert.match(failures[0], /queue reached/);
		assert.equal(writes, MAX_QUEUED_RECORDS);
	});

	it("rejects new records after close admission", async () => {
		let writes = 0;
		const writer = new PolicyWriter("/unused", assert.fail, async () => {
			writes++;
			return null;
		});
		const entry = record(new Date().toISOString());
		writer.enqueue(entry);
		const closing = writer.close();
		writer.enqueue(entry);
		await closing;
		assert.equal(writes, 1);
	});

	it("discards queued records after a store failure", async () => {
		const failures: string[] = [];
		let writes = 0;
		const writer = new PolicyWriter("/unused", (reason) => failures.push(reason), async () => {
			writes++;
			return "store failed";
		});
		const entry = record(new Date().toISOString());
		writer.enqueue(entry);
		writer.enqueue(entry);
		writer.enqueue(entry);
		await writer.close();
		assert.equal(writes, 1);
		assert.deepEqual(failures, ["store failed"]);
	});

	it("contains write and failure-callback errors", async () => {
		const writer = new PolicyWriter(
			"/unused",
			() => {
				throw new Error("callback failed");
			},
			async () => "write failed",
		);
		writer.enqueue(record(new Date().toISOString()));
		await writer.close();
	});
});
