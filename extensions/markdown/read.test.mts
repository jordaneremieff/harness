import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { publish, publicationText, type PublishOutcome } from "./publish.ts";
import { createReadTool, READ_PAGE_BYTES, readStored, readText, sourcePage, type ReadOutcome } from "./read.ts";
import { MarkdownStore } from "./store.ts";

async function fixture(run: (root: string, store: MarkdownStore) => Promise<void>) {
	const root = await mkdtemp(join(tmpdir(), "markdown-read-"));
	try { await run(root, new MarkdownStore(join(root, "store"))); } finally { await rm(root, { recursive: true, force: true }); }
}
function saved(outcome: PublishOutcome) { assert.equal(outcome.ok, true, JSON.stringify(outcome)); if (!outcome.ok) throw new Error("Expected success"); return outcome; }
function found(outcome: ReadOutcome) { assert.equal(outcome.ok, true, JSON.stringify(outcome)); if (!outcome.ok || outcome.op !== "find") throw new Error("Expected a listing"); return outcome; }
function read(outcome: ReadOutcome) { assert.equal(outcome.ok, true, JSON.stringify(outcome)); if (!outcome.ok || outcome.op !== "read") throw new Error("Expected a page"); return outcome; }
function failed(outcome: ReadOutcome, code: string) { assert.equal(outcome.ok, false); if (!outcome.ok) assert.equal(outcome.error.code, code); }

test("finding lists the newest matching documents with honest coverage", () => fixture(async (root, store) => {
	assert.deepEqual(found(await readStored(store, {})), { ok: true, op: "find", kind: "published", rows: [], matched: 0, scanned: 0, unreadable: 0, bounded: false });
	const options = { cwd: root, store };
	const report = saved(await publish({ title: "Quarterly Report", text: "# Report" }, options));
	const notes = saved(await publish({ title: "Meeting notes", text: "# Notes" }, options));
	saved(await publish({ title: "Report appendix", text: "# Appendix" }, options));
	const all = found(await readStored(store, {}));
	assert.equal(all.matched, 3); assert.equal(all.rows.length, 3); assert.equal(all.rows[0]?.title, "Report appendix");
	const matching = found(await readStored(store, { query: "REPORT" }));
	assert.deepEqual(matching.rows.map((row) => row.title), ["Report appendix", "Quarterly Report"]);
	assert.deepEqual(found(await readStored(store, { query: notes.documentId.slice(0, 10) })).rows.map((row) => row.id), [notes.documentId]);
	assert.equal(found(await readStored(store, { kind: "response" })).rows.length, 0);
	await mkdir(join(store.root, "documents", "md-ffffffffffffffffffff"));
	await writeFile(join(store.root, "documents", report.documentId, "document.json"), "{");
	const damaged = found(await readStored(store, {}));
	assert.equal(damaged.unreadable, 2); assert.equal(damaged.matched, 2); assert.equal(damaged.scanned, 4);
	assert.match(readText(damaged).header, /2 document directories are unreadable and not listed\./u);
	failed(await readStored(store, { revision: 1 }), "invalid");
	failed(await readStored(store, { document: notes.documentId, query: "x" }), "invalid");
}));

test("reading returns exact pages of a named revision and the steps to correct it", () => fixture(async (root, store) => {
	const options = { cwd: root, store };
	const emoji = "\u{1F998}";
	const long = `# Long\n\n${"a".repeat(READ_PAGE_BYTES - 10)}${emoji}${"b".repeat(READ_PAGE_BYTES)}\r\nend`;
	const first = saved(await publish({ title: "Long document", text: long }, options));
	const page = read(await readStored(store, { document: first.documentId.slice(0, 9) }));
	assert.equal(page.documentId, first.documentId); assert.equal(page.revision, 1); assert.equal(page.currentRevision, 1); assert.equal(page.digest, first.digest);
	assert.ok(Buffer.byteLength(page.text) <= READ_PAGE_BYTES); assert.ok(page.nextOffset);
	assert.equal(page.text.length, READ_PAGE_BYTES - 2); assert.equal(page.nextOffset, READ_PAGE_BYTES - 2, "a page never splits a surrogate pair");
	let text = page.text; let offset: number | null = page.nextOffset;
	while (offset !== null) { const next = read(await readStored(store, { document: first.documentId, revision: 1, offset })); text += next.text; offset = next.nextOffset; }
	assert.equal(text, long);
	failed(await readStored(store, { document: first.documentId, revision: 1, offset: page.text.length + 1 }), "invalid");
	failed(await readStored(store, { document: first.documentId, offset: page.text.length }), "invalid");
	assert.match(readText(page).header, /Continue with \{"document":"md-[a-f0-9]{20}","revision":1,"offset":\d+\}\./u);

	const update = saved(await publish({ title: "Long document", text: "# Short\n", document: first.documentId, expectedRevision: 1 }, options));
	const stale = await publish({ title: "Long document", text: "# Stale\n", document: first.documentId, expectedRevision: 1 }, options);
	assert.equal(stale.ok, false);
	assert.match(publicationText(stale), /Revision 2 \(sha256:[a-f0-9]{64}\) is current\. Read it with markdown_read \(this document, revision 2\), apply your change to that text, and publish again with expectedRevision 2\./u);
	const current = read(await readStored(store, { document: first.documentId, revision: 2 }));
	assert.equal(current.text, "# Short\n"); assert.equal(current.nextOffset, null); assert.equal(current.digest, update.digest);
	assert.match(readText(current).header, /^md-[a-f0-9]{20} revision 2 of 2 · published · "Long document" · 8 bytes · sha256:[a-f0-9]{64}\. To correct it, publish with document md-[a-f0-9]{20} and expectedRevision 2\.\nReferences not inspected: the reader app is not installed; build it with node extensions\/markdown\/native\/build\.mts\.\nComplete source follows\.$/u);
	const old = read(await readStored(store, { document: first.documentId, revision: 1, offset: 0 }));
	assert.equal(old.currentRevision, 2); assert.match(readText(old).header, /Revision 2 is current\./u);
	saved(await publish({ title: "Long document", text: `${current.text}More.\n`, document: first.documentId, expectedRevision: current.currentRevision }, options));
	failed(await readStored(store, { document: first.documentId, revision: 9 }), "not-found");
	failed(await readStored(store, { document: "md-000000" }), "not-found");
}));

test("a read lists retained and unavailable images on its first page", () => fixture(async (root, store) => {
	await writeFile(join(root, "diagram.svg"), "<svg/>");
	const path = join(root, "report.md"); await writeFile(path, "![diagram](diagram.svg)\n![gone](gone.png)\n");
	const app = join(root, "Reader.app"); await mkdir(join(app, "Contents/Resources"), { recursive: true }); await writeFile(join(app, "Contents/Resources/build.json"), JSON.stringify({ contract: 1 }));
	const runner = async () => JSON.stringify({ version: 1, images: ["diagram.svg", "gone.png"], links: [], truncated: false });
	const outcome = saved(await publish({ title: "Diagram", file: path }, { cwd: root, store, app, runner }));
	const page = read(await readStored(store, { document: outcome.documentId }));
	assert.deepEqual(page.images?.map((image) => [image.reference, image.state, image.reason ?? image.mediaType]), [["diagram.svg", "retained", "image/svg+xml"], ["gone.png", "unavailable", "missing"]]);
	assert.equal(page.imagesOmitted, 0);
	assert.match(readText(page).header, /References: 1 image retained; 1 unavailable \("gone\.png": missing\)\./u);
	const tool = createReadTool({ store });
	const result = await tool.execute("call", { document: outcome.documentId }, undefined, undefined, {} as never);
	assert.equal(result.content.length, 2);
	assert.equal(result.content[1]?.type === "text" ? result.content[1].text : "", "![diagram](diagram.svg)\n![gone](gone.png)\n");
	assert.deepEqual(result.structuredContent, result.details);
}));

test("source pages count UTF-16 offsets and refuse a split pair", () => {
	const source = `x${"\u{1F998}"}y`;
	assert.deepEqual(sourcePage(source, 0, 1), { text: "x", nextOffset: 1 });
	assert.deepEqual(sourcePage(source, 1, 4), { text: "\u{1F998}", nextOffset: 3 });
	assert.throws(() => sourcePage(source, 2), /character boundary/u);
	assert.deepEqual(sourcePage(source, 4), { text: "", nextOffset: null });
});
