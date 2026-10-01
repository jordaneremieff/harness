import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { mock, test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/pi-agent-core";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { claimPath } from "./claims.ts";
import { AgentStore, type AgentSessionMetadata } from "./store.ts";

const DEAD_PID = 2147483647;
function writeClaim(store: AgentStore, metadata: AgentSessionMetadata, content: string | object): string {
	const path = claimPath(store.nativeRoot, { sessionId: metadata.id, cwd: metadata.cwd });
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, typeof content === "string" ? content : JSON.stringify({ token: "stale", pid: DEAD_PID, host: hostname(), sessionId: metadata.id, cwd: metadata.cwd, createdAt: new Date(0).toISOString(), ...content }));
	return path;
}
function ownerPid(path: string): number { return (JSON.parse(readFileSync(path, "utf8")) as { pid: number }).pid; }

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
test("a later open replaces the claim of a writer process that exited without release", async () => {
	const f = fixture();
	try {
		const session = await f.store.create(f.cwd); await session.close();
		assert.equal(child(f.store.root, session.metadata, true).opened, true);
		const path = claimPath(f.store.nativeRoot, { sessionId: session.metadata.id, cwd: session.metadata.cwd });
		assert.notEqual(ownerPid(path), process.pid);
		const reopened = await f.store.open(session.metadata);
		assert.equal(ownerPid(path), process.pid);
		assert.equal(readdirSync(join(f.store.nativeRoot, ".claims")).length, 1);
		assert.match(child(f.store.root, session.metadata).error, /exclusive writer claim/u);
		await reopened.close();
		assert.deepEqual(readdirSync(join(f.store.nativeRoot, ".claims")), []);
	} finally { await f.close(); }
});
test("open and adopt replace a dead same-host claim; live, foreign-host, and invalid claims refuse", async (t) => {
	const f = fixture();
	const nativeKill = process.kill;
	const spy = mock.method(process, "kill", (pid: number, signal?: string | number) => {
		if (pid === DEAD_PID) throw Object.assign(new Error("gone"), { code: "ESRCH" });
		return nativeKill(pid, signal);
	});
	t.after(() => spy.mock.restore());
	try {
		const session = await f.store.create(f.cwd); await session.close();
		const metadata = session.metadata;
		const path = writeClaim(f.store, metadata, {});
		const opened = await f.store.open(metadata);
		assert.equal(ownerPid(path), process.pid); await opened.close();
		writeClaim(f.store, metadata, {});
		const adopted = f.store.adopt(SessionManager.open(metadata.path, f.store.nativeRoot));
		assert.equal(ownerPid(path), process.pid); await adopted.close();
		const refusals: Array<[string, string | object]> = [["foreign", { host: "foreign.example" }], ["invalid", "{"], ["identity", { sessionId: "different" }]];
		for (const [name, content] of refusals) {
			writeClaim(f.store, metadata, content);
			const before = readFileSync(path, "utf8");
			await assert.rejects(f.store.open(metadata), /exclusive writer claim/u, name);
			assert.equal(readFileSync(path, "utf8"), before, name);
		}
		spy.mock.mockImplementation(() => { throw Object.assign(new Error("denied"), { code: "EPERM" }); });
		writeClaim(f.store, metadata, {});
		const before = readFileSync(path, "utf8");
		await assert.rejects(f.store.open(metadata), /exclusive writer claim.*is live/u);
		assert.equal(readFileSync(path, "utf8"), before);
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
