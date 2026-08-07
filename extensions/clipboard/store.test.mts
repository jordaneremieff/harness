import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import {
	appendEntry,
	fileMode,
	localDate,
	makeEntry,
	makePreview,
	readEntries,
	resolveClipboardDir,
} from "./store.ts";

let dir: string;

before(async () => {
	dir = await mkdtemp(join(tmpdir(), "clipboard-store-test-"));
});

after(async () => {
	await rm(dir, { recursive: true, force: true });
});

describe("makeEntry / makePreview", () => {
	it("counts lines and chars and collapses preview newlines", () => {
		const e = makeEntry("one\ntwo\nthree", "test", new Date("2026-07-24T10:00:00Z"));
		assert.equal(e.lines, 3);
		assert.equal(e.chars, 13);
		assert.equal(e.preview, "one↵two↵three");
		assert.equal(e.label, "test");
		assert.match(e.id, /^[0-9a-f-]{36}$/);
	});
	it("caps the preview at 100 Unicode characters without splitting a surrogate pair", () => {
		const content = "🙂".repeat(101);
		const preview = makePreview(content);
		assert.equal(Array.from(preview).length, 100);
		assert.equal(makeEntry(content).chars, 101);
		assert.ok(!preview.includes("�"));
	});
});

describe("localDate", () => {
	it("formats YYYY-MM-DD without UTC slicing", () => {
		assert.match(localDate(new Date()), /^\d{4}-\d{2}-\d{2}$/);
	});
});

describe("resolveClipboardDir", () => {
	it("prefers PI_CLIPBOARD_DIR, then agentDir", () => {
		assert.equal(resolveClipboardDir({ PI_CLIPBOARD_DIR: "/x" } as NodeJS.ProcessEnv, "/agent"), "/x");
		assert.equal(resolveClipboardDir({} as NodeJS.ProcessEnv, "/agent"), "/agent/clipboard");
	});
});

describe("appendEntry + readEntries", () => {
	it("round-trips entries newest-first with private directory and file permissions", async () => {
		const err1 = await appendEntry(dir, makeEntry("first", undefined, new Date("2026-07-24T10:00:00Z")));
		const err2 = await appendEntry(dir, makeEntry("second", "b", new Date("2026-07-24T11:00:00Z")));
		assert.equal(err1, null);
		assert.equal(err2, null);
		const entries = await readEntries(dir);
		assert.equal(entries.length, 2);
		assert.equal(entries[0].content, "second");
		assert.equal(entries[1].content, "first");
		assert.equal((await stat(dir)).mode & 0o777, 0o700);
		const mode = await fileMode(dir, localDate(new Date("2026-07-24T10:00:00Z")));
		assert.equal(mode, 0o600);
	});

	it("respects limit and skips syntactically or structurally malformed records", async () => {
		const path = join(dir, `${localDate(new Date("2026-07-24T10:00:00Z"))}.jsonl`);
		await writeFile(path, '{"broken"\n{"timestamp":42,"content":false}\n', { flag: "a" });
		const entries = await readEntries(dir);
		assert.equal(entries.length, 2); // malformed records skipped, valid ones survive
		assert.equal((await readEntries(dir, { limit: 1 })).length, 1);
	});

	it("normalizes legacy records without ids to stable source ids", async () => {
		const legacyDate = "2026-07-23";
		const legacy = { timestamp: "2026-07-23T10:00:00.000Z", label: "old", content: "legacy" };
		await writeFile(join(dir, `${legacyDate}.jsonl`), `${JSON.stringify(legacy)}\n`, { mode: 0o644 });
		const first = await readEntries(dir, { date: legacyDate });
		const second = await readEntries(dir, { date: legacyDate });
		assert.equal(first.length, 1);
		assert.equal(first[0].id, second[0].id);
		assert.match(first[0].id, /^legacy-2026-07-23-1$/);
		assert.equal(first[0].chars, 6);
		assert.equal(first[0].preview, "legacy");
		assert.equal(await fileMode(dir, legacyDate), 0o600);
	});

	it("resolves a listed entry by stable id even after a newer append shifts indexes", async () => {
		const listed = await readEntries(dir);
		const target = listed[0];
		assert.equal(await appendEntry(dir, makeEntry("new arrival", undefined, new Date("2026-07-24T12:00:00Z"))), null);
		const shifted = await readEntries(dir);
		assert.notEqual(shifted[0].id, target.id);
		const resolved = await readEntries(dir, { id: target.id });
		assert.deepEqual(resolved.map((entry) => entry.id), [target.id]);
		assert.equal(resolved[0].content, target.content);
	});

	it("assigns deterministic fallback ids to older duplicate ids", async () => {
		const duplicateDir = join(dir, "duplicate-id-store");
		const duplicateId = "11111111-1111-4111-8111-111111111111";
		assert.equal(await appendEntry(duplicateDir, makeEntry("older", undefined, new Date("2026-07-21T10:00:00Z"), duplicateId)), null);
		assert.equal(await appendEntry(duplicateDir, makeEntry("newer", undefined, new Date("2026-07-21T11:00:00Z"), duplicateId)), null);
		const entries = await readEntries(duplicateDir);
		assert.deepEqual(entries.map((entry) => entry.id), [duplicateId, "legacy-2026-07-21-1"]);
		assert.equal((await readEntries(duplicateDir, { id: "legacy-2026-07-21-1" }))[0]?.content, "older");
	});

	it("rehardens an existing archive directory", async () => {
		await chmod(dir, 0o755);
		await readEntries(dir);
		assert.equal((await stat(dir)).mode & 0o777, 0o700);
	});

	it("reads records that span multiple reverse-scan chunks", async () => {
		const largeDir = join(dir, "large-record-store");
		const content = "🙂".repeat(40_000);
		const entry = makeEntry(content, "large", new Date("2026-07-22T10:00:00Z"));
		assert.equal(await appendEntry(largeDir, entry), null);
		const summary = await readEntries(largeDir, { limit: 1, contentChars: 10 });
		assert.equal(summary[0]?.content, "🙂".repeat(10));
		assert.equal(summary[0]?.contentTruncated, true);
		const found = await readEntries(largeDir, { id: entry.id });
		assert.equal(found[0]?.content, content);
		assert.equal(found[0]?.contentTruncated, undefined);
	});

	it("rejects a symlinked archive directory", async () => {
		const linked = join(dir, "linked-store");
		await symlink(dir, linked);
		await assert.rejects(readEntries(linked), /not a regular directory/);
	});

	it("scopes to a single date and reports empties", async () => {
		assert.equal((await readEntries(dir, { date: "1999-01-01" })).length, 0);
		assert.deepEqual(await readEntries(join(dir, "missing")), []);
	});
});
