import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it, type TestContext } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { Harness, type Storage, type StorageWrite } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { recordReport, submitConversation } from "./durable-controls.ts";
import { adoptDeliveryPages, deliveryPendingCount, deliveryState, receiptForRequest } from "./delivery-store.ts";
import { fixtureModelId, fixtureProvider, fixtureRegistry, fixtureRuntime } from "./durable-host-fixture.mts";

/**
 * Storage commits of a store written by the release before owner-checked reference pages (page size 4, so lists
 * span several pages). The first `drained` batches leave every intent linked, every receipt and report
 * acknowledged, and only historical pages; the rest add one unlinked intent, one unacknowledged report and a live
 * version 1 Reporter task.
 */
const fixture = JSON.parse(readFileSync(new URL("./testdata/delivery-page-v1-store.json", import.meta.url), "utf8")) as { drained: number; batches: StorageWrite[][][] };

async function openOldStore(t: TestContext, drained: boolean): Promise<{ harness: Harness; storage: Storage }> {
	const directory = mkdtempSync(join(tmpdir(), "delivery-page-adoption-"));
	const path = join(directory, "storage.sqlite");
	const writer = await openNodeSqliteStorage(path);
	for (const batches of fixture.batches.slice(0, drained ? fixture.drained : undefined)) await writer.commit(batches, () => {}, context);
	await writer.close(context);
	const storage = await openNodeSqliteStorage(path);
	const harness = await Harness.open(storage, { models: await fixtureRuntime("answer"), registry: fixtureRegistry() }, context);
	t.after(async () => { await harness.close(context); rmSync(directory, { recursive: true, force: true }); });
	await harness.root(context, { agent: { model: { provider: fixtureProvider, modelId: fixtureModelId } } });
	return { harness, storage };
}

it("adopts a drained earlier store so owned admissions and report appends work, keeping its history readable", { timeout: 30000 }, async (t) => {
	const { harness, storage } = await openOldStore(t, true);
	const root = await harness.root(context);
	await assert.rejects(submitConversation(root, { message: "new work", requestId: "refused", ownerId: "owner", origin: "model" }, context), /requires migration from version 1/u);
	await assert.rejects(recordReport(harness, { ownerId: "owner", senderIdentity: "sender", requestId: "refused-report", message: "new report" }, context), /requires migration from version 1/u);
	const first = await adoptDeliveryPages(harness, storage, context);
	assert.ok(first.adopted > 1);
	assert.deepEqual([first.current, first.unreached, first.activeReporterTasks], [0, [], []]);
	const history = await deliveryState(harness, context, true);
	assert.deepEqual([history.intents.length, Object.keys(history.receipts).length, history.reports.length], [10, 10, 3]);
	assert.equal((await receiptForRequest(harness, 1 as never, "old-4", context))?.answer, "old answer 4");
	assert.equal(await deliveryPendingCount(harness, context), 0);
	const admitted = await submitConversation(root, { message: "new work", requestId: "after-adoption", ownerId: "owner", origin: "model" }, context);
	assert.equal(admitted.deduped, false);
	await recordReport(harness, { ownerId: "owner", senderIdentity: "sender", requestId: "new-report", message: "new report" }, context);
	const after = await deliveryState(harness, context, true);
	assert.deepEqual([after.intents.length, after.reports.length], [11, 4]);
	const second = await adoptDeliveryPages(harness, storage, context);
	assert.equal(second.adopted, 0);
	assert.ok(second.current >= first.adopted);
});

it("reports a live earlier Reporter task without changing it, keeps old active work pending, and resumes after an interruption", { timeout: 30000 }, async (t) => {
	const { harness, storage } = await openOldStore(t, false);
	await assert.rejects(adoptDeliveryPages(harness, storage, context, () => { throw new Error("interrupted"); }), /interrupted/u);
	const resumed = await adoptDeliveryPages(harness, storage, context);
	assert.equal(resumed.adopted, 0);
	assert.equal(resumed.activeReporterTasks.length, 1);
	const task = (await harness.inspect(context)).tasks.find((item) => item.record.id === resumed.activeReporterTasks[0]);
	assert.deepEqual([task?.record.kind, task?.record.version], ["agent.reporter", 1]);
	const pending = await deliveryState(harness, context);
	assert.deepEqual(pending.intents.map((intent) => intent.requestId), ["old-active"]);
	assert.deepEqual(pending.reports.map((report) => report.sourceId), ["old-report-active"]);
	const history = await deliveryState(harness, context, true);
	assert.deepEqual([history.intents.length, history.reports.length], [11, 4]);
});
