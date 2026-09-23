import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/pi-agent-core";
import { AgentStore } from "./store.ts";

const source = `import { AgentStore } from ${JSON.stringify(new URL("./store.ts", import.meta.url).href)};
const [root, raw, crash] = process.argv.slice(1); const store = new AgentStore({sessionsRoot:root});
let opened=false,error; try { await store.open(JSON.parse(raw)); opened=true; } catch(e) { error=e.message; }
if (!crash) await store.close(); process.stdout.write(JSON.stringify({opened,error}));`;
function child(root: string, metadata: unknown, crash = false) {
	const result = spawnSync(process.execPath, ["--input-type=module", "-e", source, root, JSON.stringify(metadata), ...(crash ? ["crash"] : [])], { encoding: "utf8", timeout: 10000, maxBuffer: 20000 });
	assert.equal(result.status, 0, result.stderr); return JSON.parse(result.stdout);
}
function fixture() {
	const root = mkdtempSync(join(tmpdir(), "agent-owner-")); const cwd = join(root, "work"); mkdirSync(cwd);
	const store = new AgentStore({ sessionsRoot: join(root, "sessions") });
	return { root, cwd, store, close: async () => { await store.close(); rmSync(root, { recursive: true, force: true }); } };
}
test("writer claims exclude a second process until native owner cleanup", async () => {
	const f = fixture();
	try {
		const session = await f.store.create(f.cwd);
		assert.match(child(f.store.root, session.metadata).error, /exclusive writer claim/u);
		await session.close(); assert.equal(child(f.store.root, session.metadata).opened, true);
	} finally { await f.close(); }
});
test("a crashed writer retains its claim and requires explicit recovery", async () => {
	const f = fixture();
	try {
		const session = await f.store.create(f.cwd); await session.close();
		assert.equal(child(f.store.root, session.metadata, true).opened, true);
		await assert.rejects(f.store.open(session.metadata), /never removed automatically/u);
		assert.equal(readdirSync(join(f.store.nativeRoot, ".claims")).length, 1);
	} finally { await f.close(); }
});
test("native storage never opens or deletes durable-format files", async () => {
	const f = fixture();
	try {
		const old = join(f.store.root, "old.jsonl"); const content = '{"storageVersion":4,"id":"old"}\n'; writeFileSync(old, content);
		assert.deepEqual(await f.store.list(), []);
		await assert.rejects(f.store.open({ id: "old", cwd: f.cwd, path: old, createdAt: 0, modifiedAt: 0 }), /not a native/u);
		assert.equal(readFileSync(old, "utf8"), content);
	} finally { await f.close(); }
});
test("fork claims exclude foreign source owners and preserve ordinary entry IDs", async () => {
	const f = fixture(); const other = new AgentStore({ sessionsRoot: f.store.root });
	try {
		const session = await f.store.create(f.cwd); const id = session.manager.appendCustomEntry("source", {});
		await assert.rejects(other.fork(session.metadata, BACKGROUND_CONTEXT), /exclusive writer claim/u);
		const fork = await f.store.fork(session.metadata, BACKGROUND_CONTEXT);
		assert.notEqual(fork.metadata.id, session.metadata.id); assert.ok(fork.manager.getEntry(id));
		assert.match(child(f.store.root, fork.metadata).error, /exclusive writer claim/u);
		await fork.close(); await session.close();
	} finally { await other.close(); await f.close(); }
});
