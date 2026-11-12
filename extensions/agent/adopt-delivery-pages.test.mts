import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cpSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { it } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { Harness, type StorageWrite } from "@earendil-works/pi-durable";
import { openNodeSqliteDatabase } from "@earendil-works/chord/sqlite/node";
import { applySqliteMigrations, SQLITE_MIGRATIONS } from "@earendil-works/pi-durable/storage/sqlite";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { classifyStorage, runAdoption } from "./adopt-delivery-pages.ts";
import { AgentCatalog, type CatalogRecord } from "./catalog.ts";
import { recordReport, submitConversation } from "./durable-controls.ts";
import { deliveryState, migrateDeliveryStore, receiptForRequest } from "./delivery-store.ts";
import { hostPaths } from "./host-protocol.ts";
import { tryNativeWriterLease } from "./native-lease.ts";
import { fixtureModelId, fixtureProvider, fixtureRegistry, fixtureRuntime } from "./durable-host-fixture.mts";

/**
 * Storage commits of the earlier release's page code; see delivery-page-adoption.test.mts. `retainedWork` adds, after
 * the commit that creates conversation 1, a task of a kind that no registry declares retained as `running` with two
 * restarts and a requested abort, and a `pending` task that it owns and that carries no abort mark yet.
 */
const fixture = JSON.parse(readFileSync(new URL("./testdata/delivery-page-v1-store.json", import.meta.url), "utf8")) as { drained: number; batches: StorageWrite[][][]; retainedWork: StorageWrite[][][] };
const conversationCommit = fixture.batches.findIndex((batches) => batches[0]?.[0]?.type === "conversation");

async function replay(path: string, drained: boolean): Promise<void> {
	const storage = await openNodeSqliteStorage(path);
	for (const batches of fixture.batches.slice(0, drained ? fixture.drained : undefined)) await storage.commit(batches, () => {}, context);
	await storage.close(context);
}

/** A drained version 1 storage whose conversation retains the fixture's running task and the task it owns. */
async function retainedWorkStore(path: string, ...more: StorageWrite[][][]): Promise<void> {
	const storage = await openNodeSqliteStorage(path);
	for (const batches of [...fixture.batches.slice(0, fixture.drained), fixture.batches[conversationCommit], ...fixture.retainedWork, ...more]) await storage.commit(batches, () => {}, context);
	await storage.close(context);
}

/** Every stored task row, record included, from a read-only connection. */
async function taskRows(path: string): Promise<string> {
	const location = lstatSync(`${path}-wal`, { throwIfNoEntry: false }) === undefined ? `${pathToFileURL(path).href}?immutable=1` : path;
	const database = await openNodeSqliteDatabase(location, { mode: "read-only" });
	try { return JSON.stringify(await database.all("SELECT * FROM tasks ORDER BY id")); }
	finally { await database.close(); }
}

async function currentStore(path: string, withReport: boolean): Promise<void> {
	const harness = await Harness.open(await openNodeSqliteStorage(path), { models: await fixtureRuntime("answer"), registry: fixtureRegistry() }, context);
	await migrateDeliveryStore(harness, context);
	if (withReport) await recordReport(harness, { ownerId: "owner", senderIdentity: "sender", requestId: "current", message: "current report" }, context);
	await harness.close(context);
}

/** A storage at the first Durable SQLite schema, as Pi releases before that schema's successor wrote it. */
async function olderSchemaStore(path: string): Promise<void> {
	const database = await openNodeSqliteDatabase(path);
	await applySqliteMigrations(database, SQLITE_MIGRATIONS.slice(0, 1));
	await database.close();
}

/** Digest, size and modification time of a storage file and its WAL; an absent file reads as absent. */
function fileState(path: string): string {
	return JSON.stringify([path, `${path}-wal`].map((file) => {
		const stat = lstatSync(file, { throwIfNoEntry: false });
		return stat === undefined ? null : [stat.size, stat.mtimeMs, createHash("sha256").update(readFileSync(file)).digest("hex")];
	}));
}

async function schemaOf(path: string): Promise<number | undefined> {
	const database = await openNodeSqliteDatabase(`${pathToFileURL(path).href}?immutable=1`, { mode: "read-only" });
	try { return (await database.get<{ version: number }>("SELECT version FROM durable_schema WHERE singleton = 1"))?.version; }
	finally { await database.close(); }
}

it("counts storages in a dry run without writing, adopts version 1 storages under their writer lease, and changes nothing on a repeat", { timeout: 60000 }, async (t) => {
	const agentDir = mkdtempSync(join(tmpdir(), "adopt-delivery-pages-"));
	t.after(() => rmSync(agentDir, { recursive: true, force: true }));
	const catalog = new AgentCatalog(join(agentDir, "agent-sessions"));
	const create = (): CatalogRecord => catalog.create({ cwd: agentDir, agentDir, packageDir: agentDir, model: { provider: fixtureProvider, modelId: fixtureModelId }, thinkingLevel: "off" });
	const drained = [create(), create()], active = create(), current = create(), empty = create(), busy = create(), broken = create(), unopened = create(), older = create(), walled = create();
	for (const record of [...drained, busy]) await replay(record.storagePath, true);
	await replay(active.storagePath, false);
	await currentStore(current.storagePath, true);
	await currentStore(empty.storagePath, false);
	writeFileSync(broken.storagePath, "not a storage");
	await olderSchemaStore(older.storagePath);
	// A writer connection left open keeps committed version 1 pages in the WAL, as a stopped host can.
	const walWriter = await openNodeSqliteStorage(walled.storagePath);
	let walOpen = true;
	t.after(() => walOpen ? walWriter.close(context) : undefined);
	for (const batches of fixture.batches.slice(0, fixture.drained)) await walWriter.commit(batches, () => {}, context);
	assert.ok((lstatSync(`${walled.storagePath}-wal`, { throwIfNoEntry: false })?.size ?? 0) > 0);
	const busyClaim = hostPaths(busy).claim;
	mkdirSync(dirname(busyClaim), { recursive: true });
	const held = tryNativeWriterLease(busyClaim);
	assert.equal(held.kind, "held");
	const lines: string[] = [];
	const options = { agentDir, env: {}, write: (line: string) => lines.push(line) };

	const files = [...drained, active, older, walled].map((record) => record.storagePath);
	const before = files.map(fileState);
	const dry = await runAdoption({ ...options, apply: false });
	assert.deepEqual(files.map(fileState), before);
	assert.deepEqual([dry["version 1"], dry["version 1 with active task"], dry["version 2 only"], dry["no pages"], dry["older storage schema"], dry["writer busy"], dry.unreadable], [3, 1, 1, 1, 1, 1, 1]);
	assert.ok(lines.includes("storage schema 1: 1"));
	assert.ok(lines.includes(`storage ${drained[0].storageId}: version 1; storage ${drained[0].storagePath}; agent directory ${agentDir}`));
	assert.ok(lines.every((line) => !line.includes(current.storageId) && !line.includes(unopened.storageId)));
	assert.ok(lines.every((line) => !line.includes("old work") && !line.includes("old report")));
	const again = await runAdoption({ ...options, apply: false });
	assert.deepEqual(again, dry);

	await walWriter.close(context);
	walOpen = false;
	const olderBefore = fileState(older.storagePath);
	const applied = await runAdoption({ ...options, apply: true });
	assert.deepEqual([applied["adopted storages"], applied["version 1 with active task"], applied["older storage schema"], applied["writer busy"], applied.unreadable], [3, 1, 1, 1, 1]);
	assert.equal(fileState(older.storagePath), olderBefore);
	assert.equal(await schemaOf(older.storagePath), 1);
	assert.ok(lines.includes(`skipped ${older.storageId}: older storage schema; storage ${older.storagePath}; agent directory ${agentDir}`));
	assert.ok(applied["adopted pages"] > 2);
	assert.ok(lines.includes(`skipped ${active.storageId}: version 1 with active task; storage ${active.storagePath}; agent directory ${agentDir}`));
	assert.ok(lines.includes(`skipped ${busy.storageId}: writer busy; storage ${busy.storagePath}; agent directory ${agentDir}`));

	const repeat = await runAdoption({ ...options, apply: true });
	assert.deepEqual([repeat["adopted storages"], repeat["version 2 only"]], [0, 4]);

	if (held.kind === "held") held.lease.release();
	const named = await runAdoption({ ...options, apply: true, storage: busy.storageId });
	assert.deepEqual([named["adopted storages"], named["version 2 only"] + named["version 1"]], [1, 1]);

	const harness = await Harness.open(await openNodeSqliteStorage(drained[0].storagePath), { models: await fixtureRuntime("answer"), registry: fixtureRegistry() }, context);
	t.after(() => harness.close(context));
	const root = await harness.root(context, { agent: { model: { provider: fixtureProvider, modelId: fixtureModelId } } });
	const admitted = await submitConversation(root, { message: "new work", requestId: "after-adoption", ownerId: "owner", origin: "model" }, context);
	assert.equal(admitted.deduped, false);
});

it("adopts pages through the command without recovering an unrelated retained task, and a refused adoption leaves it unchanged", { timeout: 60000 }, async (t) => {
	const agentDir = mkdtempSync(join(tmpdir(), "adopt-delivery-pages-"));
	t.after(() => rmSync(agentDir, { recursive: true, force: true }));
	const catalog = new AgentCatalog(join(agentDir, "agent-sessions"));
	const create = (): CatalogRecord => catalog.create({ cwd: agentDir, agentDir, packageDir: agentDir, model: { provider: fixtureProvider, modelId: fixtureModelId }, thinkingLevel: "off" });
	const work = create(), broken = create();
	await retainedWorkStore(work.storagePath);
	// Page 7 heads a delivery list; with it retired, that list names an absent page and the adoption refuses.
	await retainedWorkStore(broken.storagePath, [[{ type: "document.retire", id: 7 } as StorageWrite]]);
	const tasks = await taskRows(work.storagePath);
	assert.deepEqual(JSON.parse(tasks).map((row: { status: string; record: string }) => [row.status, JSON.parse(row.record).restarts]), [["running", 2], ["pending", undefined]]);
	assert.equal(await taskRows(broken.storagePath), tasks);
	const lines: string[] = [];
	const options = { agentDir, env: {}, write: (line: string) => lines.push(line) };

	const dry = await runAdoption({ ...options, apply: false, storage: work.storageId });
	assert.equal(dry["version 1"], 1);
	assert.equal(await taskRows(work.storagePath), tasks);

	await assert.rejects(runAdoption({ ...options, apply: true, storage: broken.storageId }), new RegExp(`${broken.storageId}.*names an absent page`, "u"));
	assert.equal(await taskRows(broken.storagePath), tasks);
	assert.equal((await classifyStorage(broken.storagePath)).state, "version 1");

	const applied = await runAdoption({ ...options, apply: true, storage: work.storageId });
	assert.equal(applied["adopted storages"], 1);
	assert.ok(applied["adopted pages"] > 1);
	assert.equal(await taskRows(work.storagePath), tasks);
	assert.equal((await classifyStorage(work.storagePath)).state, "version 2 only");
	const target = `storage ${work.storagePath}; agent directory ${agentDir}`;
	assert.deepEqual(lines.slice(0, 2), [`dry run of catalogue ${catalog.root}`, `storage ${work.storageId}: version 1; ${target}`]);
	assert.equal(lines.filter((line) => line === `apply to catalogue ${catalog.root}`).length, 2);
	assert.ok(lines.includes(`adopted ${work.storageId}: ${applied["adopted pages"]} pages; ${target}`));
	assert.ok(lines.every((line) => !line.includes("old work") && !line.includes("old report")));

	const harness = await Harness.open(await openNodeSqliteStorage(work.storagePath), { models: await fixtureRuntime("answer"), registry: fixtureRegistry() }, context);
	t.after(() => harness.close(context));
	const recovered = (await harness.inspect(context)).tasks.find((task) => task.record.id === 110);
	assert.equal(recovered?.record.restarts, 3);
	assert.equal((await receiptForRequest(harness, 1 as never, "old-4", context))?.answer, "old answer 4");
	assert.deepEqual((await deliveryState(harness, context, true)).intents.length, 10);
	const root = await harness.root(context, { agent: { model: { provider: fixtureProvider, modelId: fixtureModelId } } });
	const admitted = await submitConversation(root, { message: "new work", requestId: "after-adoption", ownerId: "owner", origin: "model" }, context);
	assert.equal(admitted.deduped, false);
});

it("changes only the targets that catalogue records name: a copied catalogue needs its records rebound to its own storages and agent directory", { timeout: 60000 }, async (t) => {
	const original = mkdtempSync(join(tmpdir(), "adopt-delivery-pages-original-"));
	const copy = mkdtempSync(join(tmpdir(), "adopt-delivery-pages-copy-"));
	t.after(() => { rmSync(original, { recursive: true, force: true }); rmSync(copy, { recursive: true, force: true }); });
	const record = new AgentCatalog(join(original, "agent-sessions")).create({ cwd: original, agentDir: original, packageDir: original, model: { provider: fixtureProvider, modelId: fixtureModelId }, thinkingLevel: "off" });
	await replay(record.storagePath, true);
	const before = fileState(record.storagePath);
	const copied = join(copy, "agent-sessions");
	cpSync(join(original, "agent-sessions"), copied, { recursive: true });
	const copiedStorage = join(copied, "durable", `${record.storageId}.sqlite`);
	const copiedRecord = join(copied, "durable", `${record.storageId}.json`);
	const value = JSON.parse(readFileSync(copiedRecord, "utf8")) as CatalogRecord;
	const lines: string[] = [];
	const options = { agentDir: copy, env: {}, apply: true, write: (line: string) => lines.push(line) };
	const leases = join(original, "durable-hosts");

	// The unmodified copied record names the original storage file, outside the copied catalogue, so the catalogue refuses it.
	await assert.rejects(runAdoption(options), /Agent metadata is invalid/u);
	assert.equal(fileState(record.storagePath), before);
	assert.equal(lstatSync(leases, { throwIfNoEntry: false }), undefined);

	// Rebinding the storage file alone leaves the writer lease in the original agent directory; the output names it.
	writeFileSync(copiedRecord, JSON.stringify({ ...value, storagePath: copiedStorage }));
	await runAdoption({ ...options, apply: false });
	assert.ok(lines.includes(`storage ${record.storageId}: version 1; storage ${copiedStorage}; agent directory ${original}`));
	assert.ok(lstatSync(leases, { throwIfNoEntry: false })?.isDirectory());
	rmSync(leases, { recursive: true });

	writeFileSync(copiedRecord, JSON.stringify({ ...value, storagePath: copiedStorage, agentDir: copy }));
	const applied = await runAdoption(options);
	assert.equal(applied["adopted storages"], 1);
	assert.ok(lines.includes(`adopted ${record.storageId}: ${applied["adopted pages"]} pages; storage ${copiedStorage}; agent directory ${copy}`));
	assert.equal((await classifyStorage(copiedStorage)).state, "version 2 only");
	assert.equal(fileState(record.storagePath), before);
	assert.equal((await classifyStorage(record.storagePath)).state, "version 1");
	assert.equal(lstatSync(leases, { throwIfNoEntry: false }), undefined);
});
