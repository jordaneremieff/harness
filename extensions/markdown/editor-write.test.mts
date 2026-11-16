import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { editorWrite, parseEditorRequest, type EditorSave, type EditorWriteOptions } from "./editor-write.ts";
import { runEditorHelper } from "./editor-helper.ts";
import { digest, MarkdownStore, type WriteInput } from "./store.ts";

const emptyInspection: EditorWriteOptions = { inspect: async () => ({ inspection: { version: 1, images: [], links: [], truncated: false } }) };
async function fixture(t: TestContext) {
	const root = await mkdtemp(join(tmpdir(), "markdown-editor-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const store = new MarkdownStore(join(root, "store"));
	const { storeId } = await store.initialise();
	const request: EditorSave = { version: 1, operation: "save", storeRoot: store.root, storeId, invocationId: "save-1", generation: 1, title: "Untitled", source: "" };
	return { root, store, request };
}
const toolInput = (source: string): WriteInput => ({ title: "Published", source, contentOrigin: { kind: "tool", capturedAt: "2026-01-01T00:00:00Z" } });

test("blank scratchpads commit exact source without impersonating a response", async (t) => {
	const f = await fixture(t);
	const result = await editorWrite(f.request, emptyInspection);
	assert.ok(result.ok && result.status === "saved");
	assert.equal(result.generation, 1);
	assert.equal(result.storeId, f.request.storeId);
	const saved = await f.store.get(result.document);
	assert.equal(saved.source, "");
	assert.equal(saved.document.kind, "published");
	assert.equal(saved.revision.contentOrigin.kind, "editor");
	assert.equal(saved.revision.contentOrigin.model, undefined);
});

test("lost response reconciliation and retries return the original generation and revision", async (t) => {
	const f = await fixture(t);
	const request = { ...f.request, source: "captured save\n" };
	const first = await editorWrite(request, emptyInspection);
	assert.ok(first.ok && first.status === "saved");
	await f.store.update(first.document, 1, toolInput("a later publisher\n"));
	const reconcile = await editorWrite({ ...request, operation: "reconcile" }, { inspect: async () => { throw Error("Reconcile must not parse or capture images"); } });
	assert.ok(reconcile.ok && reconcile.status === "saved");
	assert.equal(reconcile.generation, request.generation);
	assert.equal(reconcile.revision, 1);
	assert.equal(reconcile.digest, digest(request.source));
	assert.equal(reconcile.replayed, true);
	const replay = await editorWrite(request, emptyInspection);
	assert.ok(replay.ok && replay.status === "saved");
	assert.equal(replay.revision, 1);
	assert.equal((await f.store.get(first.document)).document.revision, 2);
	const changed = await editorWrite({ ...request, source: "newer typing", generation: 2 }, emptyInspection);
	assert.ok(!changed.ok);
	assert.equal(changed.error.code, "replay-conflict");
	assert.equal(changed.generation, 2);
});

test("reconcile without a visible commit reports an observation, not a safe new save", async (t) => {
	const f = await fixture(t);
	const result = await editorWrite({ ...f.request, operation: "reconcile" }, emptyInspection);
	assert.deepEqual(result, { version: 1, ok: true, status: "unconfirmed", invocationId: "save-1", generation: 1, storeId: f.request.storeId, recorded: false });
	assert.equal((await f.store.list()).documents.length, 0);
});

test("a failed pointer response reconciles the durable publication without a duplicate", async (t) => {
	const f = await fixture(t);
	let fail = true;
	const interrupted = new MarkdownStore(f.store.root, (step) => { if (step === "pointer" && fail) { fail = false; throw Error("lost response"); } });
	const first = await editorWrite(f.request, { ...emptyInspection, store: interrupted });
	assert.ok(!first.ok);
	assert.equal(first.outcome, "unknown");
	assert.equal(first.invocationId, f.request.invocationId);
	const reconciled = await editorWrite({ ...f.request, operation: "reconcile" }, emptyInspection);
	assert.ok(reconciled.ok && reconciled.status === "saved");
	assert.equal(reconciled.revision, 1);
	assert.equal((await f.store.list()).documents.length, 1);
});

test("two stale editors never advance a base to overwrite the winner", async (t) => {
	const f = await fixture(t);
	const original = await f.store.create(toolInput("base"));
	const base = { document: original.document.id, revision: 1, digest: original.revision.digest };
	const results = await Promise.all(["first", "second"].map((source) => editorWrite({ ...f.request, invocationId: source, source, base }, emptyInspection)));
	const successes = results.filter((result) => result.ok && result.status === "saved");
	const failures = results.filter((result) => !result.ok);
	assert.equal(successes.length, 1);
	assert.equal(failures.length, 1);
	assert.equal(failures[0]?.error.code, "conflict");
	assert.equal(failures[0]?.outcome, "not-committed");
	assert.equal(failures[0]?.error.currentRevision, 2);
	assert.equal((await f.store.get(original.document.id)).document.revision, 2);
});

test("captured and historical content requires a truthful new copy", async (t) => {
	const f = await fixture(t);
	const snapshot = await f.store.snapshot("response-key", "response", { ...toolInput("exact response"), contentOrigin: { kind: "ordinary-response", capturedAt: "2026-01-01T00:00:00Z", model: "source-model" } });
	const base = { document: snapshot.document.id, revision: 1, digest: snapshot.revision.digest };
	const refusal = await editorWrite({ ...f.request, base, source: "human change" }, emptyInspection);
	assert.ok(!refusal.ok);
	assert.equal(refusal.error.code, "invalid");
	const copy = await editorWrite({ ...f.request, derivation: base, source: "human change" }, emptyInspection);
	assert.ok(copy.ok && copy.status === "saved");
	const result = await f.store.get(copy.document);
	assert.notEqual(copy.document, base.document);
	assert.deepEqual(result.revision.contentOrigin.derivedFrom, { storeId: f.request.storeId, ...base });
	assert.equal(result.revision.contentOrigin.kind, "editor");
	assert.equal(result.revision.contentOrigin.model, undefined);
	const update = await editorWrite({ ...f.request, invocationId: "copy-update", source: "later human edit", base: { document: copy.document, revision: 1, digest: copy.digest } }, emptyInspection);
	assert.ok(update.ok && update.status === "saved");
	assert.deepEqual((await f.store.get(copy.document)).revision.contentOrigin.derivedFrom, { storeId: f.request.storeId, ...base });
	assert.equal((await f.store.get(base.document)).source, "exact response");
	const wrongDigest = await editorWrite({ ...f.request, invocationId: "wrong-base", base: { document: copy.document, revision: 1, digest: digest("not the base") } }, emptyInspection);
	assert.ok(!wrongDigest.ok);
	assert.equal(wrongDigest.error.code, "conflict");
});

test("text edits and derived copies retain checked image bytes without a working directory", async (t) => {
	const f = await fixture(t);
	const bytes = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><text>Diagram</text></svg>');
	const imageDigest = digest(bytes);
	const reference = "diagrams/kept.svg";
	const record = { kind: "image" as const, reference, state: "retained" as const, file: `assets/${imageDigest.slice(7)}.svg`, digest: imageDigest, bytes: bytes.length, mediaType: "image/svg+xml" };
	const original = await f.store.create({ ...toolInput("![diagram](diagrams/kept.svg)"), references: { state: "inspected", truncated: false, omitted: 0, items: [record] }, assets: [{ record, data: bytes }] });
	const base = { document: original.document.id, revision: 1, digest: original.revision.digest };
	const inspect: EditorWriteOptions = { inspect: async () => ({ inspection: { version: 1, images: [reference], links: [], truncated: false } }) };
	for (const mode of ["base", "derivation"] as const) {
		const result = await editorWrite({ ...f.request, invocationId: mode, [mode]: base, source: `updated\n${original.source}` }, inspect);
		assert.ok(result.ok && result.status === "saved");
		assert.equal(result.references.items[0]?.state, "retained");
		assert.deepEqual(Buffer.from(await f.store.retainedAsset(result.document, result.revision, record)), bytes);
	}
});

test("only admitted draft images are captured, with checked identity", async (t) => {
	const f = await fixture(t);
	const bytes = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>');
	const assetDigest = digest(bytes);
	const assetRoot = join(f.root, "draft");
	const relativePath = `assets/${assetDigest.slice(7)}.svg`;
	await mkdir(join(assetRoot, "assets"), { recursive: true });
	await writeFile(join(assetRoot, relativePath), bytes);
	await writeFile(join(assetRoot, "unadmitted.svg"), bytes);
	const inspect: EditorWriteOptions = { inspect: async () => ({ inspection: { version: 1, images: ["inserted.svg", "unadmitted.svg", "https://example.invalid/image.svg"], links: [], truncated: false } }) };
	const request = { ...f.request, assetRoot, stagedAssets: [{ reference: "inserted.svg", relativePath, digest: assetDigest, bytes: bytes.length }], source: "![new](inserted.svg)\n![other](unadmitted.svg)" };
	const result = await editorWrite(request, inspect);
	assert.ok(result.ok && result.status === "saved");
	assert.deepEqual(result.references.items.map((item) => item.state), ["retained", "unavailable", "external"]);
	await writeFile(join(assetRoot, relativePath), "changed");
	const refusal = await editorWrite({ ...request, invocationId: "changed-image" }, inspect);
	assert.ok(!refusal.ok);
	assert.equal(refusal.error.code, "file-unreadable");
	assert.equal((await f.store.list()).documents.length, 1);
	assert.deepEqual(await readFile(join(assetRoot, "unadmitted.svg")), bytes);
});

test("store identity is checked by the helper and again within the writer lock", async (t) => {
	const f = await fixture(t);
	const request = { ...f.request, storeId: "0".repeat(32) };
	const result = await editorWrite(request, emptyInspection);
	assert.ok(!result.ok);
	assert.equal(result.error.code, "store-failure");
	await assert.rejects(f.store.create(toolInput("wrong store"), { expectedStoreId: request.storeId }), /store identity changed/);
	assert.equal((await f.store.list()).documents.length, 0);
});

test("malformed requests, oversized source and content-supplied executables are refused", async (t) => {
	const f = await fixture(t);
	for (const change of [{ version: 2 }, { operation: "shell" }, { executable: "/bin/sh" }, { source: "\ud800" }, { storeRoot: "relative" }, { stagedAssets: [{ reference: "x", relativePath: "../../secret", digest: digest("x"), bytes: 1 }] }]) {
		assert.throws(() => parseEditorRequest({ ...f.request, ...change }));
	}
	const tooLarge = await editorWrite({ ...f.request, source: "x".repeat(2 * 1024 * 1024 + 1) }, emptyInspection);
	assert.ok(!tooLarge.ok);
	const malformed = await runEditorHelper((async function* () { yield Buffer.from([0xff]); })(), f.root);
	assert.ok(!malformed.ok);
	assert.equal(malformed.error.code, "invalid");
	const parserFailure = await editorWrite(f.request, { inspect: async () => ({ failure: "tool-failed" }) });
	assert.ok(!parserFailure.ok);
	assert.equal((await f.store.list()).documents.length, 0);
});
