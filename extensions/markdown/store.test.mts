import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { digest, LIMITS, MarkdownStore, planPublication, StoreError, type WriteInput } from "./store.ts";
const scratch = tmpdir();
function input(source = "# Exact 🦘\né\n"): WriteInput { return { title: "Unicode 🦘", source, contentOrigin: { kind: "tool", capturedAt: "2026-01-02T00:00:00Z" } }; }
async function fixture(run: (store: MarkdownStore, root: string) => Promise<void>) { const root = await mkdtemp(join(scratch, "markdown-store-")); try { await run(new MarkdownStore(root), root); } finally { await rm(root, { recursive: true, force: true }); } }
const code = (value: string) => (error: unknown) => error instanceof StoreError && error.code === value;
test("identity reads do not create a store or take the writer lock", () => fixture(async (store, root) => {
	const absent = new MarkdownStore(join(root, "absent")); assert.equal(await absent.identity(), undefined); await assert.rejects(stat(absent.root), { code: "ENOENT" });
	const identity = await store.initialise(); await mkdir(join(root, ".lock"));
	assert.deepEqual(await store.identity(), identity); await rm(join(root, ".lock"), { recursive: true });
	await writeFile(join(root, "store.json"), "not json"); await assert.rejects(store.identity(), code("store-failure"));
	await writeFile(join(root, "store.json"), JSON.stringify({ version: 1, storeId: "wrong" })); await assert.rejects(store.identity(), code("store-failure"));
}));
test("create, snapshots, updates, old revisions, distinct creates and reuse", () => fixture(async (store) => {
	const first = await store.create(input());
	assert.equal(first.source, input().source); assert.equal(first.document.revision, 1);
	assert.notEqual((await store.create(input())).document.id, first.document.id);
	const plan = planPublication(input());
	const keyed = await store.create(input(), { plan });
	assert.equal((await store.create(input(), { plan })).document.id, keyed.document.id);
	await assert.rejects(store.create(input("other"), { plan }), code("replay-conflict"));
	const reused = await store.create(input(), { reuseKey: "explicit" });
	assert.equal(reused.created, true); assert.equal(reused.replayed, false);
	const returned = await store.create(input(), { reuseKey: "explicit" });
	assert.equal(returned.document.id, reused.document.id); assert.equal(returned.replayed, true);
	await assert.rejects(store.create(input("other"), { reuseKey: "explicit" }), code("replay-conflict"));
	await store.update(first.document.id, 1, input("second"));
	assert.equal((await store.get(first.document.id, 1)).source, input().source);
	await assert.rejects(store.update(first.document.id, 1, input("stale")), code("conflict"));
	const snap = await store.snapshot("response\0a\0b\0c", "response", input());
	assert.equal((await store.snapshot("response\0a\0b\0c", "response", input())).document.id, snap.document.id);
	assert.equal((await store.snapshot("response\0a\0b\0c", "response", input("changed"))).revision.revision, 2);
}));
for (const checkpoint of ["revision", "pointer"] as const) test(`SIGKILL at ${checkpoint} preserves complete reads and the original receipt`, { timeout: 10000 }, () => fixture(async (store, root) => {
	const first = await store.create(input()); const id = first.document.id;
	const update = { ...input("# Original update 🦘\r\n"), invocationDigest: digest("fixed update invocation") }; const plan = planPublication(update, id, 1);
	const killed = await worker(root, `const s=new MarkdownStore(root,step=>{if(step===${JSON.stringify(checkpoint)}){process.stdout.write(step,()=>process.kill(process.pid,'SIGKILL'));return new Promise(()=>{});}});await s.update(${JSON.stringify(id)},1,${JSON.stringify(update)},{plan:${JSON.stringify(plan)}});throw new Error('Checkpoint was not reached');`, "SIGKILL");
	assert.equal(killed, checkpoint);
	const visible = await store.get(id); assert.equal(visible.document.revision, checkpoint === "revision" ? 1 : 2);
	assert.equal(visible.source, checkpoint === "revision" ? first.source : update.source); assert.equal(visible.document.digest, digest(visible.source)); assert.equal(visible.document.bytes, Buffer.byteLength(visible.source));
	assert.equal((await stat(join(root, ".lock"))).isDirectory(), true);
	// Only the dead writer's lock is aged; acquisition still exercises proper-lockfile's stale-lock removal.
	await utimes(join(root, ".lock"), 0, 0);
	const retried = await store.update(id, 1, { ...update, source: "changed after process loss" }, { plan });
	assert.equal(retried.revision.revision, 2); assert.equal(retried.revision.publication, plan.publicationId); assert.equal(retried.source, update.source); assert.equal(retried.revision.digest, digest(update.source));
	await store.update(id, 2, input("third"));
	const replay = await store.update(id, 1, update, { plan });
	assert.equal(replay.revision.revision, 2); assert.equal(replay.source, update.source); assert.equal(replay.replayed, true);
	assert.equal((await store.get(id)).source, "third"); assert.equal((await store.get(id, 1)).source, first.source);
}));
test("foreign orphan is replaced and its stale producer conflicts", () => fixture(async (store, root) => {
	const first = await store.create(input()); const id = first.document.id;
	const old = input("orphan"); const plan = planPublication(old, id, 1);
	await assert.rejects(new MarkdownStore(root, (step) => { if (step === "revision") throw new Error("crash"); }).update(id, 1, old, { plan }));
	await store.update(id, 1, input("winner"));
	await assert.rejects(store.update(id, 1, old, { plan }), code("conflict"));
	assert.equal((await store.get(id)).source, "winner");
}));
test("intent crash, bounds, modes, prefix, open request and portable assets", () => fixture(async (store, root) => {
	await assert.rejects(new MarkdownStore(root, (step) => { if (step === "intent") throw new Error("crash"); }).create(input(), { reuseKey: "intent" }));
	const asset = Buffer.from("synthetic"); const assetDigest = digest(asset);
	const record = { kind: "image" as const, reference: "a.png", state: "retained" as const, file: `assets/${assetDigest.slice(7)}.png`, mediaType: "image/png", bytes: asset.length, digest: assetDigest };
	const withAsset = { ...input(), assets: [{ record, data: asset }], references: { state: "inspected" as const, truncated: false, omitted: 0, items: [record] } };
	const saved = await store.create(withAsset);
	assert.equal((await store.create(input(), { reuseKey: "intent" })).revision.revision, 1);
	assert.equal((await store.resolve(saved.document.id.slice(0, 9))), saved.document.id);
	assert.equal((await store.list({ limit: 1 })).bounded, false);
	assert.equal((await stat(root)).mode & 0o777, 0o700);
	const request = await store.writeOpenRequest(saved.document.id, 1, null);
	assert.equal((await stat(request)).mode & 0o777, 0o600);
	const requestData = JSON.parse(await readFile(request, "utf8"));
	assert.equal(requestData.document, saved.document.id); assert.equal(requestData.revision, 1); assert.equal(requestData.digest, saved.revision.digest); assert.equal(requestData.storeId, (await store.initialise()).storeId);
	await assert.rejects(store.writeOpenRequest(saved.document.id, 99), code("not-found"));
	const other = await mkdtemp(join(scratch, "markdown-copy-"));
	try { await mkdir(join(other, "documents")); await cp(join(root, "documents", saved.document.id), join(other, "documents", saved.document.id), { recursive: true }); assert.deepEqual(await new MarkdownStore(other).get(saved.document.id), { document: saved.document, revision: saved.revision, source: saved.source }); assert.deepEqual(await readFile(join(other, "documents", saved.document.id, "revisions/1", `assets/${assetDigest.slice(7)}.png`)), asset); } finally { await rm(other, { recursive: true, force: true }); }
	await store.create(input("a".repeat(LIMITS.sourceBytes)));
	await assert.rejects(store.create(input("a".repeat(LIMITS.sourceBytes + 1))), code("too-large"));
	const source = join(root, "documents", saved.document.id, "revisions/1/source.md");
	assert.equal((await stat(source)).mode & 0o777, 0o600);
	const ambiguous = `${saved.document.id.slice(0, 6)}${"f".repeat(17)}`;
	if (ambiguous !== saved.document.id) { const dir = join(root, "documents", ambiguous); await mkdir(dir); await writeFile(join(dir, "document.json"), JSON.stringify({ ...saved.document, id: ambiguous })); await assert.rejects(store.resolve(saved.document.id.slice(0, 6)), code("invalid")); }
}));
test("snapshot source hints survive a missing directory and a crash before document creation", () => fixture(async (store, root) => {
	const first = await store.snapshot("file-source", "file", input());
	await rm(join(root, "snapshots", first.document.id), { recursive: true });
	const repaired = await store.snapshot("file-source", "file", input("restored")); assert.equal(repaired.document.id, first.document.id); assert.equal(repaired.source, "restored");
	const crashing = new MarkdownStore(root, (step) => { if (step === "source-index") throw new Error("crash"); });
	await assert.rejects(crashing.snapshot("reserved", "response", input()));
	const index = JSON.parse(await readFile(join(root, "sources", `${digest("reserved").slice(7)}.json`), "utf8"));
	const recovered = await store.snapshot("reserved", "response", input()); assert.equal(recovered.document.id, index.documentId); assert.equal((await store.list({ kind: "response" })).documents.length, 1);
}));
test("adopted orphan supplies the pointer metadata when source bytes changed", () => fixture(async (store, root) => {
	const first = await store.create(input()); const original = { ...input("original orphan"), invocationDigest: digest("canonical file invocation") };
	const plan = planPublication(original, first.document.id, 1);
	await assert.rejects(new MarkdownStore(root, (step) => { if (step === "revision") throw new Error("crash"); }).update(first.document.id, 1, original, { plan }));
	const result = await store.update(first.document.id, 1, { ...original, title: "Changed file", source: "other bytes" }, { plan });
	assert.equal(result.source, "original orphan"); assert.equal(result.document.digest, result.revision.digest); assert.equal(result.document.bytes, result.revision.bytes); assert.equal(result.document.title, result.revision.title);
}));
test("the writer lock stays inside the root and UTF-8 byte order marks remain exact", () => fixture(async (store, root) => {
	let lockSeen = false; const checked = new MarkdownStore(root, async (step) => { if (step === "pointer") { assert.equal((await stat(join(root, ".lock"))).mode & 0o777, 0o700); lockSeen = true; } });
	const source = "\ufeff# Exact BOM\r\n"; const saved = await checked.create(input(source)); assert.equal(saved.source, source); assert.equal(lockSeen, true);
	await assert.rejects(stat(`${root}.lock`), { code: "ENOENT" });
	assert.equal((await store.get(saved.document.id)).source, source);
}));
test("collections isolate snapshots and recent listing applies its result limit after sorting", () => fixture(async (store, root) => {
	const first = await store.create(input("first")); const second = await store.create(input("second")); const third = await store.create(input("third"));
	for (const [saved, updatedAt] of [[first, "2026-01-03"], [second, "2026-01-01"], [third, "2026-01-02"]] as const) await writeFile(join(root, "documents", saved.document.id, "document.json"), JSON.stringify({ ...saved.document, updatedAt }));
	const recent = await store.list({ limit: 1 }); assert.equal(recent.documents[0]?.id, first.document.id); assert.equal(recent.bounded, false); assert.equal(recent.scanned, 3);
	const snapshot = await store.snapshot("response", "response", input());
	assert.equal((await store.get(snapshot.document.id)).document.kind, "response");
	assert.equal((await store.list()).documents.length, 3); assert.equal((await store.list({ kind: "response" })).documents.length, 1);
	assert.equal(await store.resolve(snapshot.document.id.slice(0, 12)), snapshot.document.id);
	const snapshotPath = join(root, "snapshots", snapshot.document.id, "document.json");
	await writeFile(snapshotPath, JSON.stringify({ ...snapshot.document, kind: "published" }));
	await assert.rejects(store.get(snapshot.document.id), code("store-failure"));
	const namesOnly = "md-eeeeeeeeeeeeeeeeeeee"; await mkdir(join(root, "snapshots", namesOnly)); assert.equal(await store.resolve("md-eeeeee"), namesOnly);
	await assert.rejects(store.list({ limit: Number.NaN }), code("invalid"));
}));
test("a revision record larger than the reader's record limit is refused before any staging", () => fixture(async (store, root) => {
	const items = Array.from({ length: 256 }, (_, i) => ({ kind: "image" as const, reference: `https://example.invalid/${i}/${"a".repeat(1100)}`, state: "external" as const }));
	await assert.rejects(store.create({ ...input(), references: { state: "inspected", truncated: false, omitted: 0, items } }), code("too-large"));
	assert.deepEqual(await readdir(join(root, "documents")), []);
}));
function worker(root: string, expression: string, expectedSignal?: NodeJS.Signals): Promise<string> {
	const module = fileURLToPath(new URL("./store.ts", import.meta.url));
	const script = `import {MarkdownStore} from ${JSON.stringify(module)}; import {writeFileSync} from 'node:fs'; import {join} from 'node:path'; const root=${JSON.stringify(root)}; const i=${JSON.stringify(input())}; ${expression}`;
	return new Promise((resolve, reject) => { const child = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: ["ignore", "pipe", "pipe"], timeout: 10000, killSignal: "SIGKILL" }); let output = ""; let error = ""; child.stdout.on("data", (chunk) => { output = `${output}${chunk}`.slice(-4096); }); child.stderr.on("data", (chunk) => { error = `${error}${chunk}`.slice(-4096); }); child.on("error", reject); child.on("close", (status, signal) => (expectedSignal ? signal === expectedSignal : status === 0) ? resolve(output.trim()) : reject(new Error(`exit ${status}, signal ${signal}: ${error}`))); });
}
test("same-key process races preserve one reuse receipt and one source snapshot", { timeout: 15000 }, () => fixture(async (store, root) => {
	const receipt = `console.log(JSON.stringify({id:r.document.id,revision:r.revision.revision,digest:r.revision.digest}));`;
	const create = `const s=new MarkdownStore(root); const r=await s.create(i,{reuseKey:'same'}); ${receipt}`;
	const same = await Promise.all([worker(root, create), worker(root, create)]); assert.equal(same[0], same[1]);
	const different = (source: string) => `const s=new MarkdownStore(root); try {const r=await s.create({...i,source:${JSON.stringify(source)}},{reuseKey:'different'}); ${receipt}} catch(e){ console.log(e.code); }`;
	const conflict = await Promise.all([worker(root, different("one")), worker(root, different("two"))]); assert.equal(conflict.filter((value) => value === "replay-conflict").length, 1);
	const snapshot = `const s=new MarkdownStore(root); const r=await s.snapshot('file\\0same','file',i); ${receipt}`;
	const snapshots = await Promise.all([worker(root, snapshot), worker(root, snapshot)]); assert.equal(snapshots[0], snapshots[1]);
	assert.equal((await store.list()).documents.length, 2); assert.equal((await store.list({ kind: "file" })).documents.length, 1);
}));
test("a crashed writer leaves only an ignored temporary reuse record", { timeout: 25000 }, () => fixture(async (store, root) => {
	await assert.rejects(worker(root, `const s=new MarkdownStore(root,(step)=>{if(step==='reuse-temp'){writeFileSync(join(root,'reuse','incomplete.json.tmp-crashed'),'{');process.exit(23);}});await s.create(i,{reuseKey:'crashed'});`), /exit 23/);
	const result = await store.create(input(), { reuseKey: "crashed" });
	assert.equal(result.revision.revision, 1); assert.equal((await store.list()).documents.length, 1);
}));
test("a reader sees the old revision while a writer pauses before pointer replacement", { timeout: 5000 }, () => fixture(async (store, root) => {
	const first = await store.create(input()); let published!: () => void; let release!: () => void;
	const reached = new Promise<void>((resolve) => { published = resolve; }); const released = new Promise<void>((resolve) => { release = resolve; });
	const writer = new MarkdownStore(root, async (step) => { if (step === "revision") { published(); await released; } });
	const writing = writer.update(first.document.id, 1, input("second")); let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		await Promise.race([reached, writing.then(() => { throw new Error("Writer did not pause"); })]);
		const old = await Promise.race([store.get(first.document.id), new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("Reader waited for the writer lock")), 2000); })]);
		assert.equal(old.document.revision, 1); assert.equal(old.source, first.source); assert.equal(old.document.digest, first.revision.digest);
	} finally { clearTimeout(timer); release(); await writing; }
	const current = await store.get(first.document.id); assert.equal(current.document.revision, 2); assert.equal(current.source, "second"); assert.equal(current.document.digest, digest("second"));
	assert.equal((await store.get(first.document.id, 1)).source, first.source);
}));
function child(root: string, id?: string): Promise<string> {
	const module = fileURLToPath(new URL("./store.ts", import.meta.url));
	const script = `import {MarkdownStore} from ${JSON.stringify(module)}; const s=new MarkdownStore(${JSON.stringify(root)}); const i=${JSON.stringify(input())}; try {const r=await ${id ? `s.update(${JSON.stringify(id)},1,i)` : "s.create(i)"}; console.log(r.document.id);} catch(e) {if(e.code==='conflict') console.log('conflict'); else throw e;}`;
	return new Promise((resolve, reject) => { const process = spawn(globalThis.process.execPath, ["--input-type=module", "-e", script], { stdio: ["ignore", "pipe", "pipe"] }); let output = ""; let error = ""; process.stdout.on("data", (chunk) => { output += chunk; }); process.stderr.on("data", (chunk) => { error += chunk; }); process.on("error", reject); process.on("exit", (status) => status === 0 ? resolve(output.trim()) : reject(new Error(error))); });
}
test("independent Node processes create distinct documents and exactly one update wins", { timeout: 20000 }, () => fixture(async (store, root) => {
	const ids = await Promise.all(Array.from({ length: 4 }, () => child(root)));
	assert.equal(new Set(ids).size, 4);
	const id = ids[0]; assert.ok(id);
	const results = await Promise.all(Array.from({ length: 4 }, () => child(root, id)));
	assert.equal(results.filter((value) => value !== "conflict").length, 1);
	assert.equal((await store.get(id)).document.revision, 2);
	assert.equal((await store.get(id, 1)).source, input().source);
}));
