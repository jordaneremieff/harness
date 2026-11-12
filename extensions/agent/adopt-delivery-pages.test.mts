import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { it } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { Harness, type StorageWrite } from "@earendil-works/pi-durable";
import { openNodeSqliteDatabase } from "@earendil-works/chord/sqlite/node";
import { applySqliteMigrations, SQLITE_MIGRATIONS } from "@earendil-works/pi-durable/storage/sqlite";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { runAdoption } from "./adopt-delivery-pages.ts";
import { AgentCatalog, type CatalogRecord } from "./catalog.ts";
import { recordReport, submitConversation } from "./durable-controls.ts";
import { migrateDeliveryStore } from "./delivery-store.ts";
import { hostPaths } from "./host-protocol.ts";
import { tryNativeWriterLease } from "./native-lease.ts";
import { fixtureModelId, fixtureProvider, fixtureRegistry, fixtureRuntime } from "./durable-host-fixture.mts";

/** Storage commits of the earlier release's page code; see delivery-page-adoption.test.mts. */
const fixture = JSON.parse(readFileSync(new URL("./testdata/delivery-page-v1-store.json", import.meta.url), "utf8")) as { drained: number; batches: StorageWrite[][][] };

async function replay(path: string, drained: boolean): Promise<void> {
	const storage = await openNodeSqliteStorage(path);
	for (const batches of fixture.batches.slice(0, drained ? fixture.drained : undefined)) await storage.commit(batches, () => {}, context);
	await storage.close(context);
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
	void unopened;
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
	assert.ok(lines.includes(`skipped ${older.storageId}: older storage schema`));
	assert.ok(applied["adopted pages"] > 2);
	assert.ok(lines.includes(`skipped ${active.storageId}: version 1 with active task`));
	assert.ok(lines.includes(`skipped ${busy.storageId}: writer busy`));

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
