import { createTestRuntime } from "./test-runtime.mts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/pi-agent-core";
import { AgentWorkerSession } from "./worker.ts";
import { AgentStore } from "./store.ts";

const moduleUrl = new URL("./store.ts", import.meta.url).href;
const childSource = `
import { AgentStore } from ${JSON.stringify(moduleUrl)};
import { BACKGROUND_CONTEXT } from '@earendil-works/pi-agent-core';
const [root, raw, mode] = process.argv.slice(1);
const metadata = JSON.parse(raw);
const store = new AgentStore({sessionsRoot:root});
let opened = false, error;
try { await store.open(metadata, BACKGROUND_CONTEXT); opened = true; } catch (failure) { error = failure.message; }
if (mode === 'crash') {
  process.stdout.write(JSON.stringify({opened,error}));
  process.exit(0);
}
const other = await store.create(metadata.cwd, BACKGROUND_CONTEXT);
await other.close(BACKGROUND_CONTEXT);
await store.close(BACKGROUND_CONTEXT);
process.stdout.write(JSON.stringify({opened,error,otherId:other.metadata.id}));
`;

function fixture() {
	const base = mkdtempSync(join(tmpdir(), "agent-ownership-"));
	const cwd = join(base, "work");
	mkdirSync(cwd);
	const root = join(base, "sessions");
	return { base, cwd, root, store: new AgentStore({ sessionsRoot: root }) };
}

function child(root: string, metadata: unknown, mode = "normal") {
	const result = spawnSync(process.execPath, ["--input-type=module", "-e", childSource, root, JSON.stringify(metadata), mode], { encoding: "utf8", timeout: 10000, maxBuffer: 20000 });
	assert.equal(result.status, 0, result.stderr);
	return JSON.parse(result.stdout) as { opened: boolean; error?: string; otherId?: string };
}

describe("exclusive session ownership", () => {
	it("excludes another real process from one session while allowing a different session", async () => {
		const test = fixture();
		try {
			const session = await test.store.create(test.cwd, BACKGROUND_CONTEXT);
			const denied = child(test.root, session.metadata);
			assert.equal(denied.opened, false);
			assert.match(denied.error!, /exclusive writer claim/u);
			assert.notEqual(denied.otherId, session.metadata.id);
			await session.close(BACKGROUND_CONTEXT);
			assert.equal(child(test.root, session.metadata).opened, true);
		} finally { await test.store.close(BACKGROUND_CONTEXT); rmSync(test.base, { recursive: true, force: true }); }
	});

	it("refuses duplicate creation without replacing the original claim", async () => {
		const test = fixture();
		const other = new AgentStore({ sessionsRoot: test.root });
		try {
			const session = await test.store.create(test.cwd, BACKGROUND_CONTEXT, "chosen-id");
			const claimPath = join(test.root, ".claims", readdirSync(join(test.root, ".claims"))[0]);
			const original = readFileSync(claimPath, "utf8");
			await assert.rejects(other.create(test.cwd, BACKGROUND_CONTEXT, "chosen-id"), /exclusive writer claim/u);
			assert.equal(readFileSync(claimPath, "utf8"), original);
			await session.close(BACKGROUND_CONTEXT);
			assert.equal(readdirSync(join(test.root, ".claims")).length, 0);
		} finally { await test.store.close(BACKGROUND_CONTEXT); await other.close(BACKGROUND_CONTEXT); rmSync(test.base, { recursive: true, force: true }); }
	});

	it("retains a dead process claim and requires manual recovery", async () => {
		const test = fixture();
		try {
			const session = await test.store.create(test.cwd, BACKGROUND_CONTEXT);
			await session.close(BACKGROUND_CONTEXT);
			assert.equal(child(test.root, session.metadata, "crash").opened, true);
			await assert.rejects(test.store.open(session.metadata, BACKGROUND_CONTEXT), /never removed automatically/u);
			const files = readdirSync(join(test.root, ".claims"));
			assert.equal(files.length, 1);
			const record = JSON.parse(readFileSync(join(test.root, ".claims", files[0]), "utf8"));
			assert.equal(record.sessionId, session.metadata.id);
			assert.ok(record.pid > 0);
			assert.equal(typeof record.host, "string");
			assert.equal(typeof record.token, "string");
		} finally { await test.store.close(BACKGROUND_CONTEXT); rmSync(test.base, { recursive: true, force: true }); }
	});

	it("keeps the claim until the underlying session close completes", async (t) => {
		const test = fixture();
		try {
			const repo = (test.store as unknown as { repo: { create: (...args: unknown[]) => Promise<{ close: (...args: unknown[]) => Promise<void> }> } }).repo;
			const create = repo.create.bind(repo);
			let finish!: () => void;
			const barrier = new Promise<void>((resolve) => { finish = resolve; });
			t.mock.method(repo, "create", async (...args: unknown[]) => {
				const session = await create(...args);
				const close = session.close.bind(session);
				t.mock.method(session, "close", async (...closeArgs: unknown[]) => { await barrier; await close(...closeArgs); });
				return session;
			});
			const session = await test.store.create(test.cwd, BACKGROUND_CONTEXT);
			const closing = session.close(BACKGROUND_CONTEXT);
			assert.equal(child(test.root, session.metadata).opened, false);
			finish();
			await closing;
			assert.equal(child(test.root, session.metadata).opened, true);
		} finally { await test.store.close(BACKGROUND_CONTEXT); rmSync(test.base, { recursive: true, force: true }); }
	});

	it("releases failed acquisition claims and retains claims after close failure", async (t) => {
		const test = fixture();
		try {
			const session = await test.store.create(test.cwd, BACKGROUND_CONTEXT);
			const metadata = session.metadata;
			await session.close(BACKGROUND_CONTEXT);
			await assert.rejects(test.store.open({ ...metadata, path: join(test.base, "absent") }, BACKGROUND_CONTEXT), /does not exist/u);
			assert.equal(child(test.root, metadata).opened, true);
			const repo = (test.store as unknown as { repo: { open: (...args: unknown[]) => Promise<{ close: (...args: unknown[]) => Promise<void> }> } }).repo;
			const open = repo.open.bind(repo);
			t.mock.method(repo, "open", async (...args: unknown[]) => {
				const handle = await open(...args);
				t.mock.method(handle, "close", async () => { throw new Error("close failed"); });
				return handle;
			});
			const failed = await test.store.open(metadata, BACKGROUND_CONTEXT);
			await assert.rejects(failed.close(BACKGROUND_CONTEXT), /close failed/u);
			assert.equal(child(test.root, metadata).opened, false);
			await assert.rejects(test.store.close(BACKGROUND_CONTEXT), /writer claims retained/u);
		} finally { rmSync(test.base, { recursive: true, force: true }); }
	});

	it("claims fork destinations and excludes foreign source owners", async () => {
		const test = fixture();
		const other = new AgentStore({ sessionsRoot: test.root });
		try {
			const source = await AgentWorkerSession.create({ cwd: test.cwd, agentDir: test.base, store: test.store, rootContext: BACKGROUND_CONTEXT, modelRuntime: await createTestRuntime({ refreshOnCreate: false }), model: { provider: "agent-test", modelId: "model" } });
			const metadata = (await test.store.list(BACKGROUND_CONTEXT))[0];
			await assert.rejects(other.fork(metadata, "main", BACKGROUND_CONTEXT), /exclusive writer claim/u);
			const fork = await test.store.fork(metadata, "main", BACKGROUND_CONTEXT);
			assert.equal(child(test.root, fork.metadata).opened, false);
			await fork.close(BACKGROUND_CONTEXT);
			assert.equal(child(test.root, fork.metadata).opened, true);
			await source.close();
		} finally { await test.store.close(BACKGROUND_CONTEXT); await other.close(BACKGROUND_CONTEXT); rmSync(test.base, { recursive: true, force: true }); }
	});
});
