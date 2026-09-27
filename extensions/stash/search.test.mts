import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs, { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, it, mock } from "node:test";
import { redactSecrets } from "./redact.ts";
import { SEARCH_LIMITS, searchStashes, type SearchOptions, type SearchPage } from "./search.ts";
import { listStashes, MAX_STASH_BYTES, readStash } from "./store.ts";
import { sanitizeTerminalText } from "./text.ts";

let root: string;
beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "stash-search-"));
});
afterEach(async () => {
	mock.restoreAll();
	syncBuiltinESMExports();
	await rm(root, { recursive: true, force: true });
});
const artifact = (body: string, header = 'title: "ordinary"\nstate: "open"\ntags: ["tag"]') =>
	`---\n${header}\n---\n\n${body}\n`;
async function put(id: string, body: string, header?: string) {
	await writeFile(join(root, `${id}.md`), artifact(body, header));
}
async function pages(options: SearchOptions) {
	const result: SearchPage[] = [];
	let cursor: string | undefined;
	do {
		const page = await searchStashes(root, { ...options, cursor });
		assert.ok(Buffer.byteLength(JSON.stringify(page)) <= SEARCH_LIMITS.outputBytes);
		assert.ok(page.coverage.visited <= SEARCH_LIMITS.candidates);
		assert.ok(page.coverage.bytesRead <= SEARCH_LIMITS.bytes);
		assert.equal(
			page.coverage.visited,
			page.coverage.searched + page.coverage.filtered + page.skipped.length + page.coverage.deferred,
		);
		result.push(page);
		cursor = page.nextCursor ?? undefined;
		assert.ok(result.length <= 1000, "continuation must make progress");
	} while (cursor);
	return result;
}
function patchOpen(callback: (handle: Awaited<ReturnType<typeof fs.open>>, path: string) => void | Promise<void>) {
	const original = fs.open;
	mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
		const handle = await original(...args);
		await callback(handle, String(args[0]));
		return handle;
	});
	syncBuiltinESMExports();
}

it("finds a sole older body match past 32KiB, preserves bytes and permits full read", async () => {
	const body = `${"padding ".repeat(5000)}needle detail`;
	await put("000-old", body);
	await Promise.all(Array.from({ length: 240 }, (_, n) => put(`new-${String(n).padStart(4, "0")}`, "unrelated")));
	const before = await readFile(join(root, "000-old.md"));
	const results = await pages({ query: "NEEDLE DETAIL" });
	const hits = results.flatMap((page) => page.matches);
	assert.deepEqual(
		hits.map((hit) => hit.id),
		["000-old"],
	);
	assert.equal(hits[0].field, "body");
	assert.ok(hits[0].start > 32 * 1024);
	assert.ok(results.slice(0, -1).every((page) => page.nextCursor));
	assert.equal(results.at(-1)?.coverage.complete, true);
	assert.deepEqual(await readFile(join(root, "000-old.md")), before);
	const read = await readStash(root, "000-old");
	assert.equal(read.ok, true);
	if (read.ok) assert.equal(read.content, before.toString());
});

it("returns empty pages with continuation at the candidate cap", async () => {
	await put("000-old", "needle");
	await Promise.all(Array.from({ length: SEARCH_LIMITS.candidates + 1 }, (_, n) => put(`new-${n}`, "unrelated")));
	const first = await searchStashes(root, { query: "needle" });
	assert.equal(first.matches.length, 0);
	assert.equal(first.coverage.visited, SEARCH_LIMITS.candidates);
	assert.equal(first.coverage.next, SEARCH_LIMITS.candidates);
	assert.equal(first.coverage.complete, false);
	assert.ok(first.nextCursor);
	const last = await searchStashes(root, { query: "needle", cursor: first.nextCursor });
	assert.deepEqual(
		last.matches.map((v) => v.id),
		["000-old"],
	);
	assert.equal(last.coverage.complete, true);
});

it("emits each unchanged-inventory result once across result-capped pages", async () => {
	await Promise.all(Array.from({ length: 87 }, (_, n) => put(`item-${String(n).padStart(3, "0")}`, "needle")));
	const results = await pages({ query: "needle", limit: 3 });
	const ids = results.flatMap((page) => page.matches.map((hit) => hit.id));
	assert.equal(ids.length, 87);
	assert.equal(new Set(ids).size, 87);
	assert.deepEqual(ids, [...ids].sort().reverse());
	assert.equal(results.at(-1)?.coverage.next, 87);
});

it("filters before results and keeps unknown state searchable without inventing open", async () => {
	await put("a", "needle", 'state: "closed"\ntags: ["tag"]');
	await put("b", "needle", 'state: "active"\ntags: ["tag"]');
	await put("c", "needle", 'state: "odd"\ntags: ["tag"]');
	await put("d", "needle", 'state: "open"\ntags: ["other"]');
	await put("e", "needle", 'title: "no lifecycle"');
	assert.deepEqual(
		(await searchStashes(root, { query: "needle", tag: "tag", state: "closed" })).matches.map((v) => v.id),
		["a"],
	);
	const all = await searchStashes(root, { query: "needle" });
	assert.equal(all.matches.find((v) => v.id === "c")?.state, "unknown");
	assert.equal(all.matches.find((v) => v.id === "e")?.state, "unknown");
	assert.equal((await searchStashes(root, { query: "needle", state: "open" })).matches.length, 1);
});

it("defines Unicode simple folding, literal syntax, and original representation offsets", async () => {
	const body = "😀 İ kelvin K Straße e\u0301 𐐀 [a.*]";
	await put("a", body, 'title: "xyz"\nstate: "open"');
	for (const [query, expected] of [
		["k", true],
		["straße", true],
		["STRASSE", false],
		["i", true],
		["İ", true],
		["é", false],
		["e\u0301", true],
		["𐐨", true],
		["[a.*]", true],
		[".*no", false],
	] as const) {
		const page = await searchStashes(root, { query });
		assert.equal(page.matches.length > 0, expected, query);
		for (const hit of page.matches) {
			assert.equal(hit.field, "body");
			assert.equal(body.slice(hit.excerptStart, hit.excerptEnd), hit.excerpt);
			assert.ok(new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "iu").test(body.slice(hit.start, hit.end)));
			assert.ok(!/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/u.test(hit.excerpt));
		}
	}
	await put("a", "İ", 'title: "xyz"\nstate: "open"');
	assert.equal((await searchStashes(root, { query: "i" })).matches.length, 0);
});

it("redacts complete fields before excerpts and uses escaped-field UTF-16 offsets", async () => {
	const shaped = `sk-${"q".repeat(30)}`;
	const body = `😀 ${shaped} \x1b[31m needle \u202e ${"界".repeat(70)}`;
	await put("a", body);
	const page = await searchStashes(root, { query: "needle" });
	const field = sanitizeTerminalText(redactSecrets(body)).text;
	const hit = page.matches[0];
	assert.equal(hit.excerpt, field.slice(hit.excerptStart, hit.excerptEnd));
	assert.equal(field.slice(hit.start, hit.end), "needle");
	assert.ok(!JSON.stringify(page).includes(shaped));
	assert.ok(!JSON.stringify(page).includes("\x1b"));
	assert.equal((await searchStashes(root, { query: "q".repeat(15) })).matches.length, 0);
});

it("reports redacted filenames without presenting altered IDs as selectable", async () => {
	const name = `sk-${"q".repeat(30)}`;
	await put(name, "needle");
	const page = await searchStashes(root, { query: "needle" });
	assert.equal(page.matches.length, 0);
	assert.equal(page.skipped[0].id, "[REDACTED]");
	assert.equal(page.skipped[0].reason, "redacted filename");
	assert.equal(page.coverage.complete, false);
	assert.ok(!JSON.stringify(page).includes(name));
});

it("matches decoded metadata including individual tag fields", async () => {
	await put("a", "unrelated", 'title: "other"\nstate: "closed"\nproject: "project needle"\ntags: ["tag"]');
	let hit = (await searchStashes(root, { query: "NEEDLE" })).matches[0];
	assert.equal(hit.field, "project");
	assert.equal(hit.start, 8);
	await put("a", "unrelated", 'title: "other"\nstate: "open"\ntags: ["first", "tag needle"]');
	hit = (await searchStashes(root, { query: "needle" })).matches[0];
	assert.equal(hit.field, "tags[1]");
});

it("rejects blank/control/malformed Unicode queries and invalid options before filesystem work", async () => {
	for (const query of ["", " ", "x\ny", "\u202e", "\ud800", "x".repeat(257)]) {
		await assert.rejects(searchStashes(root, { query }), /query must/);
	}
	await assert.rejects(searchStashes(root, { query: "x", limit: 0 }), /invalid limit/);
	await assert.rejects(searchStashes(root, { query: "x", state: "unknown" as "open" }), /invalid state/);
});

it("binds cursors to query, filters, store and membership, including nonartifact entries", async () => {
	await put("a", "needle");
	await put("b", "needle");
	const first = await searchStashes(root, { query: "needle", tag: "tag", state: "open", limit: 1 });
	assert.ok(first.nextCursor);
	const original = { query: "needle", tag: "tag", state: "open" as const, cursor: first.nextCursor };
	for (const change of [{ query: "NEEDLE" }, { tag: undefined }, { state: undefined }])
		await assert.rejects(searchStashes(root, { ...original, ...change }), /no longer matches/);
	const other = join(root, "other");
	await mkdir(other);
	await assert.rejects(searchStashes(other, original), /no longer matches/);
	await writeFile(join(root, ".extra"), "ignored");
	await assert.rejects(searchStashes(root, original), /no longer matches/);
	await rm(join(root, ".extra"));
	await rm(other, { recursive: true });
	await rm(join(root, "a.md"));
	await assert.rejects(searchStashes(root, original), /no longer matches/);
});

it("rejects malformed cursors and corrupted position or cumulative skips", async () => {
	await put("a", "needle");
	await put("b", "needle");
	const first = await searchStashes(root, { query: "needle", limit: 1 });
	assert.ok(first.nextCursor);
	for (const cursor of ["x", "!", "a".repeat(1025), Buffer.from("{}").toString("base64url")])
		await assert.rejects(searchStashes(root, { query: "needle", cursor }), /invalid search cursor/);
	const value = JSON.parse(Buffer.from(first.nextCursor, "base64url").toString());
	for (const change of [{ position: 2 }, { skipped: 1 }, { extra: true }, { v: 2 }]) {
		const cursor = Buffer.from(JSON.stringify({ ...value, ...change })).toString("base64url");
		await assert.rejects(searchStashes(root, { query: "needle", cursor }), /invalid search cursor/);
	}
});

it("permits body edits between pages but describes per-read consistency", async () => {
	await put("a", "no match");
	await put("b", "needle");
	const first = await searchStashes(root, { query: "needle", limit: 1 });
	assert.ok(first.nextCursor);
	await put("a", "needle");
	const last = await searchStashes(root, { query: "needle", cursor: first.nextCursor });
	assert.deepEqual(
		last.matches.map((v) => v.id),
		["a"],
	);
	assert.match(last.consistency, /not a frozen snapshot/);
});

it("reports oversized, malformed, invalid UTF-8 and unclosed files as incomplete", async () => {
	await writeFile(join(root, "large.md"), "x".repeat(MAX_STASH_BYTES + 1));
	await writeFile(join(root, "bad.md"), "---\nstate: broken\n---\nneedle");
	await writeFile(join(root, "unclosed.md"), '---\nstate: "open"\nbody: "needle"');
	await writeFile(join(root, "binary.md"), Buffer.from([0xff, 0xff]));
	const page = await searchStashes(root, { query: "needle" });
	assert.equal(page.matches.length, 0);
	assert.equal(page.skipped.length, 4);
	assert.deepEqual(
		new Set(page.skipped.map((v) => v.reason)),
		new Set(["oversized", "malformed header", "invalid UTF-8", "unclosed header"]),
	);
	assert.equal(page.coverage.complete, false);
	assert.equal(page.nextCursor, null);
});

it("keeps cumulative skipped coverage on the final continuation page", async () => {
	await writeFile(join(root, "z.md"), "---\nstate: broken\n---\nneedle");
	await put("y", "needle");
	await put("a", "needle");
	const first = await searchStashes(root, { query: "needle", limit: 1 });
	assert.ok(first.nextCursor);
	const last = await searchStashes(root, { query: "needle", cursor: first.nextCursor });
	assert.equal(last.skipped.length, 0);
	assert.equal(last.coverage.skippedTotal, 1);
	assert.equal(last.coverage.complete, false);
});

it("does not recurse into checkpoints or trash and does not follow symlinks", async () => {
	const nested = join(root, ".trash");
	await mkdir(nested);
	await writeFile(join(nested, "hidden.md"), artifact("needle"));
	const checkpoints = join(root, "checkpoints");
	await mkdir(checkpoints);
	await writeFile(join(checkpoints, "checkpoint.md"), artifact("needle"));
	await symlink(join(nested, "hidden.md"), join(root, "link.md"));
	await mkdir(join(root, "directory.md"));
	const page = await searchStashes(root, { query: "needle" });
	assert.equal(page.matches.length, 0);
	assert.equal(page.coverage.candidates, 2);
	assert.equal(page.skipped.length, 2);
	await symlink(root, join(root, "store-link"));
	await assert.rejects(searchStashes(join(root, "store-link"), { query: "needle" }), /not a regular directory/);
});

it("refuses a FIFO without waiting for a writer", { skip: process.platform === "win32", timeout: 5000 }, async () => {
	assert.equal(spawnSync("mkfifo", [join(root, "pipe.md")]).status, 0);
	const page = await searchStashes(root, { query: "needle" });
	assert.equal(page.skipped[0].reason, "unreadable or nonregular");
});

it("reports vanished and unreadable files without leaking OS error paths", async () => {
	await put("a", "needle");
	await put("b", "needle");
	const original = fs.open;
	mock.method(fs, "open", async (path: Parameters<typeof fs.open>[0], ...rest: [number | string, number?]) => {
		if (String(path).endsWith("a.md")) throw Object.assign(new Error("private error"), { code: "ENOENT" });
		if (String(path).endsWith("b.md")) throw Object.assign(new Error("private error"), { code: "EACCES" });
		return original(path, ...rest);
	});
	syncBuiltinESMExports();
	const page = await searchStashes(root, { query: "needle" });
	assert.deepEqual(
		page.skipped.map((v) => v.reason),
		["unreadable", "vanished"],
	);
	assert.ok(!JSON.stringify(page).includes("private error"));
});

it("detects a same-size body change or path replacement during a read", async () => {
	await put("a", "needle");
	patchOpen((handle) => {
		const original = handle.read.bind(handle);
		let changed = false;
		mock.method(handle, "read", async (...args: Parameters<typeof handle.read>) => {
			const value = await original(...args);
			if (!changed) {
				changed = true;
				await writeFile(join(root, "a.md"), artifact("change"));
			}
			return value;
		});
	});
	const page = await searchStashes(root, { query: "needle" });
	assert.equal(page.skipped[0].reason, "changed during read");
});

it("detects a body change after descriptor stat but before path stat", async () => {
	await put("a", "needle");
	patchOpen((handle) => {
		const original = handle.stat.bind(handle);
		let stats = 0;
		mock.method(handle, "stat", async () => {
			const result = await original();
			stats++;
			// openRegular, post-chmod baseline, then the post-read descriptor stat.
			if (stats === 3) await writeFile(join(root, "a.md"), artifact("changed longer"));
			return result;
		});
	});
	const page = await searchStashes(root, { query: "needle" });
	assert.equal(page.matches.length, 0);
	assert.equal(page.skipped[0].reason, "changed during read");
});

it("hardens opened files but leaves the ordinary whole-store sweep pending", async () => {
	await put("a", "needle");
	await put("b", "needle");
	await chmod(root, 0o755);
	await chmod(join(root, "a.md"), 0o644);
	await chmod(join(root, "b.md"), 0o644);
	const first = await searchStashes(root, { query: "needle", limit: 1 });
	assert.equal(first.matches[0].id, "b");
	assert.equal((await stat(root)).mode & 0o777, 0o700);
	assert.equal((await stat(join(root, "b.md"))).mode & 0o777, 0o600);
	assert.equal((await stat(join(root, "a.md"))).mode & 0o777, 0o644);
	await listStashes(root, { limit: 1 });
	assert.equal((await stat(join(root, "a.md"))).mode & 0o777, 0o600);
});

it("bounds actual directory production to the cap and one overflow sentinel", async () => {
	let reads = 0;
	let closed = false;
	mock.method(fs, "opendir", async (_path: unknown, options: { bufferSize: number }) => {
		assert.equal(options.bufferSize, 1);
		return {
			read: async () => {
				reads++;
				return { name: `item-${reads}`, isFile: () => true, isSymbolicLink: () => false, isDirectory: () => false };
			},
			close: async () => {
				closed = true;
			},
		};
	});
	syncBuiltinESMExports();
	await assert.rejects(searchStashes(root, { query: "needle" }), /exceeds 10000/);
	assert.equal(reads, SEARCH_LIMITS.directoryEntries + 1);
	assert.equal(closed, true);
});

it("bounds actual file reads and visited candidates on byte-heavy pages", async () => {
	await Promise.all(
		Array.from({ length: 20 }, (_, n) =>
			writeFile(join(root, `item-${n}.md`), artifact("x").padEnd(MAX_STASH_BYTES, "x")),
		),
	);
	let bytes = 0;
	let opens = 0;
	patchOpen((handle) => {
		opens++;
		const original = handle.read.bind(handle);
		mock.method(handle, "read", async (...args: Parameters<typeof handle.read>) => {
			const result = await original(...args);
			bytes += result.bytesRead;
			return result;
		});
	});
	const page = await searchStashes(root, { query: "absent" });
	assert.equal(page.coverage.bytesRead, bytes);
	assert.ok(bytes <= SEARCH_LIMITS.bytes);
	assert.equal(opens, page.coverage.visited);
	assert.ok(opens < 20);
	assert.ok(page.nextCursor);
});

it("bounds output with long Unicode matches followed by long skipped identifiers", async () => {
	await Promise.all(
		Array.from({ length: 8 }, (_, n) =>
			put(`z${n}${"x".repeat(196)}`, "界".repeat(350), `title: ${JSON.stringify("界".repeat(160))}\nstate: "open"`),
		),
	);
	await Promise.all(
		Array.from({ length: 30 }, (_, n) =>
			writeFile(join(root, `a${String(n).padStart(2, "0")}${"x".repeat(197)}.md`), "---\nbad\n---"),
		),
	);
	const results = await pages({ query: "界".repeat(128) });
	assert.equal(results.flatMap((p) => p.matches).length, 8);
	assert.equal(results.at(-1)?.coverage.skippedTotal, 30);
});

it("continues output-deferred matches without omissions or duplicates", async () => {
	await Promise.all(
		Array.from({ length: 20 }, (_, n) =>
			put(
				`x${String(n).padStart(2, "0")}${"x".repeat(197)}`,
				`${"語".repeat(48)}${"界".repeat(256)}${"語".repeat(48)}`,
				`title: ${JSON.stringify("漢".repeat(160))}\nstate: "open"`,
			),
		),
	);
	const results = await pages({ query: "界".repeat(256) });
	const hits = results.flatMap((p) => p.matches);
	assert.equal(hits.length, 20);
	assert.equal(new Set(hits.map((v) => v.id)).size, 20);
	assert.ok(results.some((p) => p.coverage.deferred === 1));
});

it("cancels before work, during inventory and during a body read with handle cleanup", async () => {
	const pre = new AbortController();
	pre.abort();
	await assert.rejects(searchStashes(root, { query: "needle" }, pre.signal), /cancelled/);
	await put("a", "needle");
	const active = new AbortController();
	let closed = false;
	patchOpen((handle) => {
		const read = handle.read.bind(handle);
		const close = handle.close.bind(handle);
		mock.method(handle, "read", async (...args: Parameters<typeof handle.read>) => {
			const result = await read(...args);
			active.abort();
			return result;
		});
		mock.method(handle, "close", async () => {
			closed = true;
			await close();
		});
	});
	await assert.rejects(searchStashes(root, { query: "needle" }, active.signal), /cancelled/);
	assert.equal(closed, true);
	mock.restoreAll();
	syncBuiltinESMExports();
	const scanning = new AbortController();
	let directoryClosed = false;
	mock.method(fs, "opendir", async () => ({
		read: async () => {
			scanning.abort();
			return null;
		},
		close: async () => {
			directoryClosed = true;
		},
	}));
	syncBuiltinESMExports();
	await assert.rejects(searchStashes(root, { query: "needle" }, scanning.signal), /cancelled/);
	assert.equal(directoryClosed, true);
});

it("returns a complete empty observation for a missing store and rejects a file store", async () => {
	const empty = await searchStashes(join(root, "missing"), { query: "needle" });
	assert.equal(empty.coverage.complete, true);
	await put("a", "needle");
	await assert.rejects(searchStashes(join(root, "a.md"), { query: "needle" }), /not a regular directory/);
});

it("rejects a changed directory during enumeration", async () => {
	await put("a", "needle");
	const original = fs.opendir;
	mock.method(fs, "opendir", async (...args: Parameters<typeof fs.opendir>) => {
		const directory = await original(...args);
		const read = directory.read.bind(directory);
		let changed = false;
		mock.method(directory, "read", async () => {
			if (!changed) {
				changed = true;
				await writeFile(join(root, "new"), "x");
			}
			return read();
		});
		return directory;
	});
	syncBuiltinESMExports();
	await assert.rejects(searchStashes(root, { query: "needle" }), /changed during enumeration/);
});
