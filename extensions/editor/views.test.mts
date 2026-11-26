import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test, type TestContext } from "node:test";
import { initViews, viewHeaders, views } from "./views.ts";

const author = "Reader";
const scratch = `scratch:${randomUUID()}`;
const blocks = [
	{ kind: "text", text: "Start at the entry point, then follow the draft below. 📖" },
	{ kind: "code", text: 'const example = "<h1>literal</h1>";\n\treturn example;' },
	{ kind: "location", text: "Entry point", doc: "src/reading map.ts", line: 18 },
	{ kind: "location", text: "Read the scratch notes", doc: scratch, line: 2 },
];

function memoryStore(t: TestContext): DatabaseSync {
	const db = new DatabaseSync(":memory:");
	t.after(() => db.close());
	initViews(db);
	return db;
}

test("a reading map keeps its ID and only the exact revision can replace it", (t) => {
	const dir = mkdtempSync(join(tmpdir(), "editor-views-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const path = join(dir, "workspace.db");
	const db = new DatabaseSync(path);
	let saved: Record<string, unknown>;
	try {
		initViews(db);
		const created = views(db, { op: "compose", title: "Reading map", blocks }, author);
		assert.match(created.id as string, /^[a-f\d-]{36}$/u);
		assert.equal(created.rev, 1);
		assert.deepEqual(viewHeaders(db), [created]);
		assert.deepEqual(views(db, { op: "view", id: created.id }, author), { ...created, author, blocks });

		const reader = new DatabaseSync(path);
		try {
			const revise = {
				op: "compose",
				id: created.id,
				rev: created.rev,
				title: "Reading map: draft first",
				blocks: blocks.toReversed(),
			};
			const updated = views(reader, revise, "Reviewer");
			assert.deepEqual(updated, { id: created.id, title: revise.title, rev: 2 });
			assert.throws(() => views(db, { ...revise, title: "Stale map", blocks: [] }, author), { code: "conflict" });
			assert.deepEqual(viewHeaders(db), [updated]);
			saved = { ...updated, author: "Reviewer", blocks: revise.blocks };
		} finally {
			reader.close();
		}
	} finally {
		db.close();
	}
	const reopened = new DatabaseSync(path);
	try {
		initViews(reopened);
		assert.deepEqual(views(reopened, { op: "view", id: saved.id }, author), saved);
	} finally {
		reopened.close();
	}
});

test("compose rejects malformed blocks and locations without a write", (t) => {
	const db = memoryStore(t);
	const base = { op: "compose", title: "Reading map", blocks: [] };
	const place = { kind: "location", text: "Read this", doc: "README.md", line: 1 };
	for (const value of [
		null,
		[],
		{ kind: "script", text: "alert(1)" },
		{ kind: "code", text: 7 },
		{ kind: "text", text: "text", doc: "README.md" },
		{ kind: "text", text: "\ud800" },
		{ ...place, doc: "../README.md" },
		{ ...place, doc: "/README.md" },
		{ ...place, doc: "./README.md" },
		{ ...place, doc: "repo/.GIT/config" },
		{ ...place, doc: "scratch:unknown" },
		{ ...place, line: 0 },
		{ ...place, line: "1" },
		{ ...place, line: 1.5 },
		{ ...place, line: Number.POSITIVE_INFINITY },
	]) {
		assert.throws(() => views(db, { ...base, blocks: [value] }, author), { code: "invalid" });
	}
	for (const fields of [
		{ title: " " },
		{ blocks: {} },
		{ id: randomUUID() },
		{ rev: 1 },
		{ blocks: [place], extra: 3 },
	]) {
		assert.throws(() => views(db, { ...base, ...fields }, author), { code: "invalid" });
	}
	assert.throws(() => views(db, { ...base, id: randomUUID(), rev: 1 }, author), { code: "not_found" });
	assert.deepEqual(viewHeaders(db), []);
});

test("compose limits UTF-8 bytes, aggregate JSON bytes and counts", (t) => {
	const db = memoryStore(t);
	const base = { op: "compose", title: "é".repeat(80), blocks: [] };
	const block = { kind: "text", text: "雪".repeat(10_922) };
	for (const fields of [
		{ title: "é".repeat(81) },
		{ blocks: [{ ...block, text: `${block.text}雪` }] },
		{ blocks: Array(4).fill(block) },
		{ blocks: Array(97).fill({ kind: "text", text: "" }) },
		{ blocks: [{ kind: "location", text: "", doc: "x".repeat(4097), line: 1 }] },
	]) {
		assert.throws(() => views(db, { ...base, ...fields }, author), { code: "limit" });
	}
	const one = views(db, { ...base, blocks: [block] }, author);
	for (let i = 1; i < 64; i++) views(db, base, author);
	assert.throws(() => views(db, base, author), { code: "limit" });
	assert.equal(viewHeaders(db).length, 64);
	assert.equal(views(db, { ...base, id: one.id, rev: one.rev }, author).rev, 2);
});
