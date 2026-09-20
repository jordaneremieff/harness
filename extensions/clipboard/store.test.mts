import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { closeSync, constants, openSync } from "node:fs";
import { chmod, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { appendEntry, fileMode, localDate, makeEntry, makePreview, readEntries, resolveClipboardDir } from "./store.ts";

let dir: string;

function runStoreProbe(source: string): { error: string | null } {
	const module = JSON.stringify(new URL("./store.ts", import.meta.url).href);
	const child = spawnSync(
		process.execPath,
		["--input-type=module", "--eval", `import { appendEntry, makeEntry, readEntries } from ${module}; ${source}`],
		{ encoding: "utf8", timeout: 2000, maxBuffer: 8192 },
	);
	assert.ifError(child.error);
	assert.equal(child.status, 0, child.stderr);
	return JSON.parse(child.stdout) as { error: string | null };
}

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

	it("preserves complete records during concurrent large appends", async () => {
		const concurrentDir = join(dir, "concurrent-store");
		const entries = ["a", "b", "c"].map((char) => makeEntry(char.repeat(1024 * 1024)));
		assert.deepEqual(await Promise.all(entries.map((entry) => appendEntry(concurrentDir, entry))), [null, null, null]);
		const found = await readEntries(concurrentDir, { contentChars: Number.POSITIVE_INFINITY });
		assert.equal(found.length, entries.length);
		for (const entry of entries)
			assert.deepEqual(
				found.find((candidate) => candidate.id === entry.id),
				entry,
			);
	});

	it("preserves a valid append after a torn record without rewriting existing bytes", async () => {
		const tornDir = await mkdtemp(join(dir, "torn-record-"));
		const entry = makeEntry("complete record");
		const path = join(tornDir, `${localDate(new Date(entry.timestamp))}.jsonl`);
		const torn = '{"id":"torn"';
		await writeFile(path, torn);
		assert.equal(await appendEntry(tornDir, entry), null);
		assert.ok((await readFile(path, "utf8")).startsWith(torn));
		assert.deepEqual(await readEntries(tornDir), [entry]);
	});

	for (const connected of [false, true]) {
		it(`refuses an archive pipe with ${connected ? "a connected" : "no"} reader`, async () => {
			const pipeDir = await mkdtemp(join(dir, "archive-pipe-"));
			const pipe = join(pipeDir, `${localDate(new Date())}.jsonl`);
			const created = spawnSync("mkfifo", [pipe], { encoding: "utf8", timeout: 2000, maxBuffer: 8192 });
			assert.ifError(created.error);
			assert.equal(created.status, 0, created.stderr);
			const mode = (await stat(pipe)).mode;
			const reader = connected ? openSync(pipe, constants.O_RDONLY | constants.O_NONBLOCK) : undefined;
			try {
				const result = runStoreProbe(`
					const error = await appendEntry(${JSON.stringify(pipeDir)}, makeEntry("not written"));
					process.stdout.write(JSON.stringify({ error }));
				`);
				assert.equal(typeof result.error, "string");
				assert.equal((await stat(pipe)).mode, mode, "refusal leaves the pipe permissions unchanged");
			} finally {
				if (reader !== undefined) closeSync(reader);
			}
		});
	}

	it("refuses an archive replaced by a pipe after directory discovery", async () => {
		const raceDir = await mkdtemp(join(dir, "archive-read-race-"));
		const entry = makeEntry("original");
		assert.equal(await appendEntry(raceDir, entry), null);
		const path = join(raceDir, `${localDate(new Date(entry.timestamp))}.jsonl`);
		const result = runStoreProbe(`
			const { unlinkSync } = await import("node:fs");
			const { execFileSync } = await import("node:child_process");
			const signal = new AbortController().signal;
			let checks = 0;
			Object.defineProperty(signal, "throwIfAborted", { value() {
				if (++checks === 2) {
					unlinkSync(${JSON.stringify(path)});
					execFileSync("mkfifo", [${JSON.stringify(path)}], { timeout: 1000, maxBuffer: 8192 });
				}
			}});
			let error = null;
			try { await readEntries(${JSON.stringify(raceDir)}, { signal }); }
			catch (failure) { error = failure.message; }
			process.stdout.write(JSON.stringify({ error }));
		`);
		assert.match(result.error ?? "", /not a regular archive file/);
	});

	it("respects limit and skips syntactically or structurally malformed records", async () => {
		const path = join(dir, `${localDate(new Date("2026-07-24T10:00:00Z"))}.jsonl`);
		await writeFile(path, '{"broken"\n{"timestamp":42,"content":false}\n', { flag: "a" });
		const entries = await readEntries(dir);
		assert.equal(entries.length, 2); // malformed records skipped, valid ones survive
		assert.equal((await readEntries(dir, { limit: 1 })).length, 1);
	});

	it("skips records without valid ids instead of synthesizing identity", async () => {
		const date = "2026-07-23";
		const record = { timestamp: "2026-07-23T10:00:00.000Z", content: "unaddressable" };
		await writeFile(
			join(dir, `${date}.jsonl`),
			`${JSON.stringify(record)}\n${JSON.stringify({ ...record, id: "invalid/id" })}\n`,
			{ mode: 0o600 },
		);
		assert.deepEqual(await readEntries(dir, { date }), []);
	});

	it("resolves a listed entry by stable id even after a newer append shifts indexes", async () => {
		const listed = await readEntries(dir);
		const target = listed[0];
		assert.equal(await appendEntry(dir, makeEntry("new arrival", undefined, new Date("2026-07-24T12:00:00Z"))), null);
		const shifted = await readEntries(dir);
		assert.notEqual(shifted[0].id, target.id);
		const resolved = await readEntries(dir, { id: target.id });
		assert.deepEqual(
			resolved.map((entry) => entry.id),
			[target.id],
		);
		assert.equal(resolved[0].content, target.content);
	});

	it("keeps only the newest record for a duplicate id", async () => {
		const duplicateDir = join(dir, "duplicate-id-store");
		const duplicateId = "11111111-1111-4111-8111-111111111111";
		assert.equal(
			await appendEntry(duplicateDir, makeEntry("older", undefined, new Date("2026-07-21T10:00:00Z"), duplicateId)),
			null,
		);
		assert.equal(
			await appendEntry(duplicateDir, makeEntry("newer", undefined, new Date("2026-07-21T11:00:00Z"), duplicateId)),
			null,
		);
		const entries = await readEntries(duplicateDir);
		assert.deepEqual(
			entries.map((entry) => entry.id),
			[duplicateId],
		);
		assert.equal((await readEntries(duplicateDir, { id: duplicateId }))[0]?.content, "newer");
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

	it("rejects cancellation before access and during chunk traversal", async () => {
		const cancelled = new AbortController();
		cancelled.abort();
		await assert.rejects(readEntries(dir, { signal: cancelled.signal }), { name: "AbortError" });

		const controller = new AbortController();
		let checks = 0;
		Object.defineProperty(controller.signal, "throwIfAborted", {
			value() {
				if (++checks === 5) controller.abort();
				AbortSignal.prototype.throwIfAborted.call(controller.signal);
			},
		});
		await assert.rejects(readEntries(dir, { signal: controller.signal }), { name: "AbortError" });
		assert.equal(checks, 5);
		assert.ok((await readEntries(dir)).length > 0, "cancellation leaves archive data intact");
	});

	it("scopes to a single date and reports empties", async () => {
		assert.equal((await readEntries(dir, { date: "1999-01-01" })).length, 0);
		assert.deepEqual(await readEntries(join(dir, "missing")), []);
	});
});
