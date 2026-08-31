import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { PolicyRecord } from "./record.ts";
import { appendRecord, localDate, resolvePolicyDir } from "./store.ts";

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

	it("returns the failure instead of throwing when the store is not a directory", async () => {
		const base = await mkdtemp(join(tmpdir(), "policy-store-"));
		const path = join(base, "blocked");
		await writeFile(path, "not a directory", "utf8");
		const failure = await appendRecord(path, record(new Date().toISOString()));
		assert.ok(failure, "expected a failure message");
	});
});
