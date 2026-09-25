import assert from "node:assert/strict";
import { appendFileSync } from "node:fs";
import {
	appendFile,
	chmod,
	mkdir,
	mkdtemp,
	open,
	readFile,
	rename,
	rm,
	stat,
	symlink,
	truncate,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { SEARCH_LIMITS, searchEntries, type SearchPage } from "./search.ts";
import { makeEntry, readEntries } from "./store.ts";

let root: string;
before(async () => {
	root = await mkdtemp(join(tmpdir(), "clipboard-search-test-"));
});
after(async () => {
	await rm(root, { recursive: true, force: true });
});

async function fixture(name: string, records: unknown[], date = "2026-09-01"): Promise<string> {
	const dir = join(root, name);
	await mkdir(dir, { recursive: true });
	await writeFile(join(dir, `${date}.jsonl`), records.map((record) => JSON.stringify(record)).join("\n"));
	return dir;
}
function record(id: string, content = id, label?: string) {
	return makeEntry(content, label, new Date("2026-09-01T12:00:00Z"), id);
}
async function pages(
	dir: string,
	query: string,
	options: { date?: string; limit?: number } = {},
): Promise<SearchPage[]> {
	const result: SearchPage[] = [];
	let cursor: string | undefined;
	for (let requests = 0; requests < 100; requests++) {
		const page = await searchEntries(dir, { query, ...options, cursor });
		assert.ok(page.scan.bytes <= SEARCH_LIMITS.bytes);
		assert.ok(page.scan.records <= SEARCH_LIMITS.records);
		assert.ok(page.scan.files <= SEARCH_LIMITS.files);
		assert.ok(page.scan.directoryEntries <= SEARCH_LIMITS.directoryEntries);
		assert.ok(Buffer.byteLength(JSON.stringify(page.matches)) <= SEARCH_LIMITS.matchBytes + 100);
		result.push(page);
		if (!page.nextCursor) return result;
		assert.equal(page.hasMore, true);
		assert.notEqual(cursor, page.nextCursor, "each incomplete page must advance");
		cursor = page.nextCursor;
	}
	assert.fail("query did not finish within fixture's page bound");
}

interface TestCursor {
	position: { offset: number; file: string };
	extra?: number;
}
function alter(cursor: string, change: (value: TestCursor) => void): string {
	const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
	change(value);
	return Buffer.from(JSON.stringify(value)).toString("base64url");
}

describe("clipboard literal discovery", () => {
	it("recovers unknown-date rollback text beyond recent lists, browser prefixes, and a bounded empty page", async () => {
		const body = `${"context ".repeat(5000)}rollback instructions: restore the saved revision`;
		const dir = await fixture("rollback", [record("rollback-draft", body)], "2026-01-02");
		await writeFile(
			join(dir, "2026-09-01.jsonl"),
			Array.from({ length: 1100 }, (_, i) => JSON.stringify(record(`recent-${i}`))).join("\n"),
		);
		assert.equal(
			(await readEntries(dir, { limit: 50, contentChars: 0 })).some((entry) => entry.id === "rollback-draft"),
			false,
		);
		assert.equal(
			(await readEntries(dir, { limit: 200 })).some((entry) => entry.id === "rollback-draft"),
			false,
		);
		const found = await pages(dir, "rollback instructions");
		assert.deepEqual(found[0].matches, []);
		assert.equal(found[0].stop, "records");
		assert.ok(found[0].nextCursor);
		const hits = found.flatMap((page) => page.matches);
		assert.equal(hits.length, 1);
		assert.equal(hits[0].id, "rollback-draft");
		assert.equal(hits[0].date, "2026-01-02", "archive filename, not the UTC timestamp date");
		assert.equal(hits[0].match.field, "content");
		assert.equal(hits[0].match.offset, 40000);
		assert.match(hits[0].match.excerpt, /rollback instructions/);
		assert.equal((await readEntries(dir, { id: hits[0].id, date: hits[0].date }))[0].content, body);
	});

	it("uses exact case-sensitive literals across raw content and labels, without normalization or regex", async () => {
		const dir = await fixture("literals", [
			record("body", "x\n🙂 rollback [a.*] é\x1b"),
			record("label", "other", "rollback [a.*]"),
			record("case", "Rollback [a.*]"),
			record("decomposed", "e\u0301"),
		]);
		assert.deepEqual(
			(await pages(dir, "rollback [a.*]")).flatMap((page) => page.matches.map((hit) => hit.id)),
			["label", "body"],
		);
		assert.equal((await pages(dir, "a.*")).flatMap((page) => page.matches).length, 3);
		assert.equal((await pages(dir, "é")).flatMap((page) => page.matches).length, 1);
		assert.equal((await pages(dir, "\\x1b")).flatMap((page) => page.matches).length, 0);
		const hit = (await pages(dir, "🙂 rollback")).flatMap((page) => page.matches)[0];
		assert.equal(hit.match.offset, 2);
		assert.equal(
			(await pages(dir, "rollback [a.*]")).flatMap((page) => page.matches).find((match) => match.id === "body")?.match
				.offset,
			4,
		);
		assert.ok(!hit.match.excerpt.includes("�"));
		assert.match(hit.match.excerpt, /\\x1b/);
	});

	it("keeps filename and physical ordering, scopes by date, and does not invent empty-archive matches", async () => {
		const dir = await fixture("order", [
			record("last", "phrase"),
			{ ...record("first", "phrase"), timestamp: "2001-01-01T00:00:00Z" },
		]);
		await writeFile(
			join(dir, "2026-01-01.jsonl"),
			JSON.stringify({ ...record("old-file", "phrase"), timestamp: "2099-01-01T00:00:00Z" }),
		);
		assert.deepEqual(
			(await pages(dir, "phrase", { limit: 1 })).flatMap((page) => page.matches.map((hit) => hit.id)),
			["first", "last", "old-file"],
		);
		assert.deepEqual(
			(await pages(dir, "phrase", { date: "2026-01-01" })).flatMap((page) => page.matches.map((hit) => hit.id)),
			["old-file"],
		);
		for (const scope of [{ date: "2025-01-01" }, {}]) {
			const page = await searchEntries(dir, { query: "absent", ...scope });
			assert.deepEqual(page.matches, []);
			assert.equal(page.stop, "end");
			assert.equal(page.nextCursor, null);
		}
		assert.equal((await searchEntries(join(root, "missing"), { query: "phrase" })).hasMore, false);
	});

	it("rejects stale matching duplicates across pages and files while malformed duplicates do not mask valid data", async () => {
		const dir = await fixture("duplicates", [
			record("same", "rollback obsolete"),
			...Array.from({ length: 1050 }, (_, i) => record(`gap-${i}`)),
			record("same", "replacement without the remembered text"),
		]);
		await writeFile(
			join(dir, "2026-01-01.jsonl"),
			[record("same", "rollback ancient"), record("valid", "rollback valid")]
				.map((entry) => JSON.stringify(entry))
				.join("\n"),
		);
		await appendFile(
			join(dir, "2026-09-01.jsonl"),
			`\n${JSON.stringify({ id: "valid", content: "not valid without timestamp" })}\n{"torn"`,
		);
		const hits = (await pages(dir, "rollback")).flatMap((page) => page.matches);
		assert.deepEqual(
			hits.map((hit) => hit.id),
			["valid"],
		);
		assert.match((await readEntries(dir, { id: hits[0].id }))[0].content, /rollback/);
		assert.deepEqual(
			(await pages(dir, "rollback", { date: "2026-01-01" })).flatMap((page) => page.matches.map((hit) => hit.id)),
			["valid", "same"],
		);
	});

	it("returns a matching duplicate id once and preserves the full match on an output-boundary page", async () => {
		const entries = Array.from({ length: 40 }, (_, i) =>
			record(`entry-${i}`, `find ${"\x1b".repeat(1000)}`, "\u202e".repeat(200)),
		);
		const dir = await fixture("output", [record("entry-39", "find old"), ...entries]);
		const result = await pages(dir, "find", { limit: 50 });
		assert.ok(result.some((page) => page.stop === "output"));
		const hits = result.flatMap((page) => page.matches);
		assert.equal(hits.length, 40);
		assert.equal(new Set(hits.map((hit) => hit.id)).size, 40);
		assert.ok(!JSON.stringify(hits).includes("\x1b"));
		assert.match(hits[0].match.excerpt, /\\x1b/);
	});

	it("counts blank and malformed records toward the record budget", async () => {
		const dir = await fixture("damaged", [record("valid", "target")]);
		await appendFile(
			join(dir, "2026-09-01.jsonl"),
			`\n${"\n".repeat(1001)}{broken\n${JSON.stringify({ content: "target", timestamp: "2026-01-01", id: "../bad" })}`,
		);
		const result = await pages(dir, "target");
		assert.equal(result[0].scan.records, SEARCH_LIMITS.records);
		assert.equal(result[0].matches.length, 0);
		assert.ok(result[0].hasMore);
		assert.equal(result.flatMap((page) => page.matches)[0].id, "valid");
		assert.ok(result[0].scan.malformed >= 2);
	});

	it("bounds empty-file visits and continues through older archives", async () => {
		const dir = await fixture("files", [record("old", "phrase")], "2025-01-01");
		for (let day = 1; day <= 40; day++) {
			const date = new Date(Date.UTC(2026, 0, day)).toISOString().slice(0, 10);
			await writeFile(join(dir, `${date}.jsonl`), "");
		}
		const result = await pages(dir, "phrase");
		assert.equal(result[0].stop, "files");
		assert.equal(result[0].scan.files, SEARCH_LIMITS.files);
		assert.equal(result[0].matches.length, 0);
		assert.deepEqual(
			result.flatMap((page) => page.matches.map((hit) => hit.id)),
			["old"],
		);
	});

	it("bounds byte reads and oversized-record memory with progress across a huge damaged record", async () => {
		const dir = await fixture("oversized", [record("old", "phrase")]);
		const path = join(dir, "2026-09-01.jsonl");
		const prefix = await readFile(path);
		const handle = await open(path, "r+");
		try {
			await handle.write(Buffer.from("\n"), 0, 1, prefix.length);
			await handle.truncate(SEARCH_LIMITS.bytes + 1024 * 1024);
		} finally {
			await handle.close();
		}
		const result = await pages(dir, "phrase");
		assert.equal(result[0].stop, "bytes");
		assert.equal(result[0].scan.bytes, SEARCH_LIMITS.bytes);
		assert.equal(result[0].scan.oversized, 1);
		assert.equal(result[0].matches.length, 0);
		assert.equal(result.flatMap((page) => page.matches)[0].id, "old");
	});

	it("retries an eligible record cut by the byte budget instead of losing its match", async () => {
		const content = `${"x".repeat(2 * 1024 * 1024)}phrase`;
		const dir = await fixture("partial-record", [record("old", content)]);
		const path = join(dir, "2026-09-01.jsonl");
		const prefix = await readFile(path);
		await appendFile(path, "\n");
		await truncate(path, SEARCH_LIMITS.bytes + 1024 * 1024);
		const result = await pages(dir, "phrase");
		const cursor = result[0].nextCursor;
		assert.ok(cursor);
		const position = (
			JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as {
				position: { offset: number; discard: boolean };
			}
		).position;
		assert.equal(position.discard, false);
		assert.equal(position.offset, prefix.length);
		assert.equal(result.flatMap((page) => page.matches)[0].id, "old");
	});

	it("matches an eligible record much larger than the read chunk", async () => {
		const content = `${"🙂".repeat(100000)}needle beyond the prefix`;
		const dir = await fixture("large", [record("large", content)]);
		const hit = (await pages(dir, "needle beyond")).flatMap((page) => page.matches)[0];
		assert.equal(hit.match.offset, 100000);
		assert.match(hit.match.excerpt, /needle beyond/);
	});

	it("refuses directory overflow instead of materializing an unbounded listing; exact dates bypass discovery", async () => {
		const dir = await fixture("directory", [record("one", "phrase")]);
		for (let i = 0; i < SEARCH_LIMITS.directoryEntries; i++) await writeFile(join(dir, `irrelevant-${i}`), "");
		await assert.rejects(searchEntries(dir, { query: "phrase" }), /exceeds 4096 entries; pass date/);
		const page = await searchEntries(dir, { query: "phrase", date: "2026-09-01" });
		assert.equal(page.matches[0].id, "one");
		assert.equal(page.scan.directoryEntries, 1);
	});

	it("rejects a symlinked store, ignores symlinked archives, and re-enforces private modes", async () => {
		const dir = await fixture("private", [record("private", "phrase")]);
		const alias = join(root, "alias");
		await symlink(dir, alias);
		await assert.rejects(searchEntries(alias, { query: "phrase" }), /regular directory/);
		await symlink(join(dir, "2026-09-01.jsonl"), join(dir, "2026-09-02.jsonl"));
		assert.equal((await pages(dir, "phrase")).flatMap((page) => page.matches).length, 1);
		await chmod(dir, 0o755);
		await chmod(join(dir, "2026-09-01.jsonl"), 0o644);
		await searchEntries(dir, { query: "phrase" });
		assert.equal((await stat(dir)).mode & 0o777, 0o700);
		assert.equal((await stat(join(dir, "2026-09-01.jsonl"))).mode & 0o777, 0o600);
	});

	it("rejects invalid query, date, limit and cursor without filesystem reads", async () => {
		for (const query of ["", " \n\t", "x".repeat(257), "\ud800"])
			await assert.rejects(searchEntries("not-accessed", { query }), /query/);
		for (const date of ["../2026-01-01", "2026-02-30", "nonsense"])
			await assert.rejects(searchEntries("not-accessed", { query: "x", date }), /date/);
		for (const limit of [0, 51, 1.5, NaN])
			await assert.rejects(searchEntries("not-accessed", { query: "x", limit }), /limit/);
		for (const cursor of ["", "a!", "x".repeat(1025), Buffer.from("null").toString("base64url")])
			await assert.rejects(searchEntries("not-accessed", { query: "x", cursor }), /cursor/);
		const dir = await fixture("cursor", [record("a", "phrase"), record("b", "phrase")]);
		const cursor = (await searchEntries(dir, { query: "phrase", limit: 1 })).nextCursor;
		assert.ok(cursor);
		await assert.rejects(searchEntries(dir, { query: "other", cursor }), /cursor/);
		await assert.rejects(searchEntries(dir, { query: "phrase", date: "2026-09-01", cursor }), /cursor/);
		for (const change of [
			(value: TestCursor) => {
				value.position.offset = -1;
			},
			(value: TestCursor) => {
				value.position.file = "../../escape";
			},
			(value: TestCursor) => {
				value.position.offset = Number.MAX_SAFE_INTEGER;
			},
			(value: TestCursor) => {
				value.position.offset = 1;
			},
			(value: TestCursor) => {
				value.extra = 1;
			},
		])
			await assert.rejects(searchEntries(dir, { query: "phrase", cursor: alter(cursor, change) }), /cursor/);
	});

	it("refuses changed, appended, replaced or deleted archives and new daily files on continuation", async () => {
		const mutations: Record<string, (dir: string, path: string) => Promise<unknown>> = {
			append: (_dir, path) => appendFile(path, `\n${JSON.stringify(record("c", "phrase"))}`),
			rewrite: (_dir, path) => truncate(path, 1),
			replace: async (_dir, path) => {
				await rename(path, `${path}.old`);
				await writeFile(path, JSON.stringify(record("new", "phrase")));
			},
			delete: (_dir, path) => rm(path),
			"new-day": (dir) => writeFile(join(dir, "2026-09-02.jsonl"), ""),
			"delete-store": (dir) => rm(dir, { recursive: true }),
		};
		for (const [mutation, apply] of Object.entries(mutations)) {
			const dir = await fixture(`mutation-${mutation}`, [record("a", "phrase"), record("b", "phrase")]);
			const cursor = (await searchEntries(dir, { query: "phrase", limit: 1 })).nextCursor;
			assert.ok(cursor);
			await apply(dir, join(dir, "2026-09-01.jsonl"));
			await assert.rejects(searchEntries(dir, { query: "phrase", cursor }), /archives changed.*restart/i);
		}
	});

	it("rejects a file append during the active scan instead of returning mixed observations", async () => {
		const dir = await fixture("active-mutation", [record("one", "phrase")]);
		const path = join(dir, "2026-09-01.jsonl");
		const signal = new AbortController().signal;
		let checks = 0;
		Object.defineProperty(signal, "throwIfAborted", {
			value() {
				if (++checks === 12) appendFileSync(path, `\n${JSON.stringify(record("new", "phrase"))}`);
			},
		});
		await assert.rejects(searchEntries(dir, { query: "phrase", signal }), /archives changed/i);
		assert.equal((await searchEntries(dir, { query: "phrase" })).matches[0].id, "new");
	});

	it("retains long ids in bounded verification cursors", async () => {
		const id = "z".repeat(200);
		const dir = await fixture("long-id", [
			record(id, "phrase"),
			...Array.from({ length: 1050 }, (_, i) => record(`recent-${i}`)),
		]);
		const result = await pages(dir, "phrase");
		for (const page of result) assert.ok((page.nextCursor?.length ?? 0) <= SEARCH_LIMITS.cursorChars);
		assert.deepEqual(
			result.flatMap((page) => page.matches.map((hit) => hit.id)),
			[id],
		);
	});

	it("cancels before access and during work, and leaves bytes intact for a fresh query", async () => {
		const dir = await fixture("cancel", [record("a", "phrase")]);
		const path = join(dir, "2026-09-01.jsonl");
		const before = await readFile(path);
		const controller = new AbortController();
		controller.abort();
		await assert.rejects(searchEntries(dir, { query: "phrase", signal: controller.signal }), { name: "AbortError" });
		for (const after of [3, 8, 14]) {
			const active = new AbortController();
			let checks = 0;
			Object.defineProperty(active.signal, "throwIfAborted", {
				value() {
					if (++checks === after) active.abort();
					AbortSignal.prototype.throwIfAborted.call(active.signal);
				},
			});
			await assert.rejects(searchEntries(dir, { query: "phrase", signal: active.signal }), { name: "AbortError" });
		}
		assert.deepEqual(await readFile(path), before);
		assert.equal((await searchEntries(dir, { query: "phrase" })).matches[0].id, "a");
	});
});
