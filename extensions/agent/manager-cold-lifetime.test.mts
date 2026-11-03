import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { AgentManager } from "./manager.ts";
import { DurableHost } from "./durable-host.ts";
import { DurableObservation } from "./durable-observation.ts";
import { fixtureRegistry, fixtureRuntime, hostOptions } from "./durable-host-fixture.mts";
import { deferred } from "./dashboard-test-fixture.mts";
import { TerminalController } from "./terminal-client.ts";

async function fixture(t: TestContext) {
	const base = realpathSync(mkdtempSync(join(tmpdir(), "cl-")));
	const root = join(base, "store"), scratch = join(base, "t");
	mkdirSync(root); mkdirSync(scratch);
	const previousTmp = process.env.TMPDIR;
	process.env.TMPDIR = scratch;
	const options = { root, agentDir: root, packageDir: root,
		connect: async () => { throw new Error("No live host"); },
		acquire: async () => { throw new Error("Observation must not acquire a host"); },
	};
	const manager = new AgentManager(options), other = new AgentManager(options);
	t.after(async () => {
		await Promise.all([manager.close(), other.close()]);
		if (previousTmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previousTmp;
		rmSync(base, { recursive: true, force: true });
	});
	const record = manager.catalog.create({ cwd: root, agentDir: root, packageDir: root, model: { provider: "fixture", modelId: "fixture" }, thinkingLevel: "off" });
	const source = await DurableHost.open({ ...hostOptions(record.storagePath, await fixtureRuntime("answer"), fixtureRegistry()), storageId: record.storageId });
	try {
		const input = await source.submit({ message: "retained cold history", requestId: "history", origin: "operator" });
		await source.wait(input.submissionId);
	} finally { await source.close(); }
	return { manager, other, record, root, copies: () => readdirSync(scratch).filter((name) => name.startsWith("pi-durable-snapshot-")) };
}

test("namespace and roster owners share retention and release only after the final owner ends", { timeout: 15000 }, async (t) => {
	const { manager, record, copies } = await fixture(t);
	const first = new AbortController(), replacement = new AbortController();
	await manager.recoverNamespace(first.signal);
	const off = manager.subscribeRoster(() => {});
	await manager.snapshot(record.storageId);
	const retained = copies();
	assert.equal(retained.length, 1);
	off();
	await manager.snapshot(record.storageId);
	assert.deepEqual(copies(), retained, "the namespace retains the roster's snapshot");
	await manager.recoverNamespace(replacement.signal);
	first.abort();
	await manager.snapshot(record.storageId);
	assert.deepEqual(copies(), retained, "an old namespace cannot release its replacement");
	const offRoster = manager.subscribeRoster(() => {});
	replacement.abort();
	await manager.snapshot(record.storageId);
	assert.deepEqual(copies(), retained, "the roster retains the namespace's snapshot");
	const active = new AbortController();
	await manager.recoverNamespace(active.signal);
	offRoster();
	const closed = deferred();
	const original = DurableObservation.prototype.close;
	t.mock.method(DurableObservation.prototype, "close", async function (this: DurableObservation) {
		await original.call(this); closed.resolve();
	});
	active.abort();
	await closed.promise;
	assert.deepEqual(copies(), [], "namespace abort disposes the final owner's private copy");
	await assert.rejects(manager.snapshot(record.storageId), /cache is closed/);
	const later = new AbortController();
	await manager.recoverNamespace(later.signal);
	assert.match(JSON.stringify(await manager.snapshot(record.storageId)), /retained cold history/);
	await manager.close();
	assert.deepEqual(copies(), [], "manager shutdown overrides an active namespace owner");
});

test("terminal closure awaits roster disposal after borrowed reads and leaves another manager intact", { timeout: 15000 }, async (t) => {
	const readEntered = deferred(), releaseRead = deferred(), closeEntered = deferred(), releaseClose = deferred();
	t.after(() => { releaseRead.resolve(); releaseClose.resolve(); });
	const { manager, other, record, root, copies } = await fixture(t);
	const controller = new TerminalController({ manager, caller: { id: "terminal", cwd: root } });
	const off = controller.source.subscribeRoster(() => {});
	other.subscribeRoster(() => {});
	await manager.snapshot(record.storageId);
	await other.snapshot(record.storageId);
	assert.equal(copies().length, 2);
	let borrow = true;
	const request = DurableObservation.prototype.request;
	t.mock.method(DurableObservation.prototype, "request", async function (this: DurableObservation, ...args: Parameters<typeof request>) {
		if (borrow) { borrow = false; readEntered.resolve(); await releaseRead.promise; }
		return request.apply(this, args);
	});
	let disposals = 0;
	const close = DurableObservation.prototype.close;
	t.mock.method(DurableObservation.prototype, "close", async function (this: DurableObservation) {
		disposals++; closeEntered.resolve(); await releaseClose.promise; await close.call(this);
	});
	const borrowed = manager.snapshot(record.storageId, { limit: 1 });
	await readEntered.promise;
	off(); off();
	let settled = false;
	const closing = controller.close().then(() => { settled = true; });
	assert.equal(manager.close(), manager.close(), "manager close is idempotent while disposal is pending");
	assert.equal(disposals, 0, "a borrowed copy stays open");
	assert.equal(settled, false);
	releaseRead.resolve();
	assert.equal((await borrowed).entries.length, 1);
	await closeEntered.promise;
	assert.equal(settled, false, "terminal teardown awaits the roster's asynchronous disposal");
	assert.equal(copies().length, 2);
	releaseClose.resolve();
	await closing;
	assert.equal(disposals, 1);
	assert.equal(copies().length, 1);
	assert.match(JSON.stringify(await other.snapshot(record.storageId)), /retained cold history/);
	assert.equal(copies().length, 1, "the other manager reuses its own copy");
	await other.close();
	assert.deepEqual(copies(), []);
});
