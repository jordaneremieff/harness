import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { Harness, MemoryStorage, type Seq, type StorageWrite } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { acknowledgeReports, readOutcome, recordReport, settleDeliveries, submitConversation, ThreadDeliveryDoc, type DeliveryReport } from "./durable-controls.ts";
import { automaticDeliveryPage, deliveryPendingCount, deliveryState, DeliveryArchiveDoc, DeliveryRowDoc, DeliveryStoreDoc, latestReceipt, migrateDeliveryStore, operationReceipts, pendingDeliveryPage, receiptAtInput, receiptForRequest, reportKey, retainedReport, snapshotIntent, snapshotReceipt, storeDeliveryRow, terminalDeliveryState } from "./delivery-store.ts";
import { readDashboard } from "./durable-observation.ts";
import { answerMessage, fixtureProvider, fixtureModelId, fixtureRegistry, fixtureRuntime, gateTool, scriptedRuntime, toolCallMessage } from "./durable-host-fixture.mts";

function report(index: number): DeliveryReport {
	return { sourceId: `report:r-${index}`, requestId: `r-${index}`, ownerId: "owner", senderIdentity: "sender", message: "x".repeat(1024), replyTo: null, acknowledged: index % 3 === 0, createdAt: index, ...(index % 5 === 0 ? { delivery: { state: "terminal" as const, reason: "malformed recipient identity" } } : {}) };
}
class CountedStorage extends MemoryStorage {
	bytes = 0;
	writes = 0;
	operations = 0;
	override async commit(writes: readonly StorageWrite[], ctx: typeof context): Promise<Seq> {
		for (const write of writes) {
			if (write.type.startsWith("document.")) this.operations += 1;
			if ((write.type === "document.create" || write.type === "document.change") && write.content.kind === "base") {
				this.bytes += Buffer.byteLength(JSON.stringify(write.content.value)); this.writes += 1;
			}
		}
		return super.commit(writes, ctx);
	}
}

it("bounds equal add/ack work independently of acknowledged history and preserves dedupe", { timeout: 60000 }, async (t) => {
	const storage = new CountedStorage();
	const harness = await Harness.open(storage, { models: await fixtureRuntime("answer"), registry: fixtureRegistry() }, context);
	t.after(() => harness.close(context));
	await migrateDeliveryStore(harness, context);
	const samples: Array<{ history: number; logicalBaseBytes: number; baseWrites: number; documentOperations: number }> = [];
	let count = 0;
	for (const history of [100, 1000, 10000]) {
		while (count < history) {
			const id = `seed-${count++}`;
			const row = await recordReport(harness, { ownerId: "owner", senderIdentity: "sender", requestId: id, message: "x".repeat(1024) }, context);
			await acknowledgeReports(harness, "owner", [row.sourceId], context);
		}
		storage.bytes = 0; storage.writes = 0; storage.operations = 0;
		const row = await recordReport(harness, { ownerId: "owner", senderIdentity: "sender", requestId: `measured-${history}`, message: "x".repeat(1024) }, context);
		await acknowledgeReports(harness, "owner", [row.sourceId], context);
		samples.push({ history, logicalBaseBytes: storage.bytes, baseWrites: storage.writes, documentOperations: storage.operations });
		const duplicate = await recordReport(harness, { ownerId: "owner", senderIdentity: "sender", requestId: `measured-${history}`, message: "not the retained message" }, context);
		assert.equal(duplicate.acknowledged, true);
		assert.equal(duplicate.message, "x".repeat(1024));
		assert.deepEqual((await pendingDeliveryPage(harness, context)).state.reports, []);
	}
	assert.ok(samples.every((sample) => sample.logicalBaseBytes < 20000 && sample.baseWrites < 20 && sample.documentOperations < 25));
	assert.ok(Math.max(...samples.map((sample) => sample.logicalBaseBytes)) < Math.min(...samples.map((sample) => sample.logicalBaseBytes)) * 4);
	t.diagnostic(JSON.stringify({ units: "serialized UTF-8 base payload bytes, base writes, and all document operations including retirements; not disk/WAL/RSS", samples }));
});

it("resumes an interrupted SQLite migration and retires the original only after validation", { timeout: 30000 }, async (t) => {
	const root = mkdtempSync(join(tmpdir(), "delivery-transition-")), path = join(root, "storage.sqlite");
	const models = await fixtureRuntime("answer"), registry = fixtureRegistry();
	const migrationReports = Array.from({ length: 193 }, (_, index) => ({ ...report(index), checkIn: { conversationId: 1, requestId: `watched-${index}`, origin: "model" as const, elapsedMs: 60000, cost: null } }));
	let harness: Harness | undefined;
	try {
		harness = await Harness.open(await openNodeSqliteStorage(path), { models, registry }, context);
		await harness.commit(async (tx) => { (await tx.doc(DeliveryArchiveDoc)).reports.push(...migrationReports); }, context);
		await harness.close(context);
		harness = await Harness.open(await openNodeSqliteStorage(path), { models, registry }, context);
		let batches = 0, enumerations = 0;
		let receiptIndex = (await harness.snapshot(DeliveryArchiveDoc, context))?.receipts;
		const values = Object.values;
		t.mock.method(Object, "values", (value: object) => { if (value === receiptIndex) enumerations += 1; return values(value); });
		await assert.rejects(migrateDeliveryStore(harness, context, () => { if (++batches === 2) throw new Error("interrupted"); }), /interrupted/u);
		assert.equal(enumerations, 1, "the immutable receipt references are enumerated once before bounded batches");
		assert.equal((await harness.snapshot(DeliveryStoreDoc, context))?.ready, false);
		assert.equal((await harness.snapshot(DeliveryArchiveDoc, context))?.reports.length, 193);
		await harness.close(context);
		harness = await Harness.open(await openNodeSqliteStorage(path), { models, registry }, context);
		receiptIndex = (await harness.snapshot(DeliveryArchiveDoc, context))?.receipts;
		await migrateDeliveryStore(harness, context);
		await migrateDeliveryStore(harness, context);
		assert.equal(enumerations, 2, "reopen enumerates once and a completed transition needs none");
		assert.equal((await harness.snapshot(DeliveryStoreDoc, context))?.ready, true);
		assert.equal(await harness.snapshot(DeliveryArchiveDoc, context), undefined);
		assert.deepEqual((await deliveryState(harness, context, true)).reports, migrationReports);
		let cursor: string | undefined, pending = 0;
		do {
			const page = await pendingDeliveryPage(harness, context, cursor);
			assert.ok(page.state.reports.length <= 64);
			pending += page.state.reports.length; cursor = page.next ?? undefined;
		} while (cursor !== undefined);
		const expected = migrationReports;
		let automaticCursor: string | undefined, automatic = 0;
		do {
			const page = await automaticDeliveryPage(harness, context, automaticCursor);
			assert.ok(page.reports.length <= 64);
			automatic += page.reports.length; automaticCursor = page.next ?? undefined;
		} while (automaticCursor !== undefined);
		assert.equal(automatic, expected.filter((row) => !row.acknowledged).length, "migration preserves automatic completion work across routing dispositions");
		assert.equal(pending, expected.filter((row) => !row.acknowledged && row.delivery?.state !== "terminal").length);
		assert.equal(await deliveryPendingCount(harness, context), expected.filter((row) => !row.acknowledged).length);
		assert.equal((await terminalDeliveryState(harness, context)).reports[0]?.sourceId, "report:r-5");
		const retained = await harness.commit((tx) => retainedReport(tx, "owner", "report:r-0"), context);
		assert.equal(retained?.acknowledged, true);
	} finally { await harness?.close(context); rmSync(root, { recursive: true, force: true }); }
});

it("materialises a native answer group across reference pages in one delivery commit", { timeout: 30000 }, async (t) => {
	let release = () => {}, entered = () => {};
	const gate = new Promise<void>((resolve) => { release = resolve; });
	const started = new Promise<void>((resolve) => { entered = resolve; });
	const harness = await Harness.open(new MemoryStorage(), { settings: { steeringMode: "all" }, models: await scriptedRuntime([toolCallMessage("gate"), answerMessage("one answer")]), registry: fixtureRegistry([gateTool(gate, entered)]) }, context);
	t.after(async () => { release(); await harness.close(context); });
	await migrateDeliveryStore(harness, context);
	const root = await harness.root(context, { agent: { model: { provider: fixtureProvider, modelId: fixtureModelId } } });
	const first = await submitConversation(root, { message: "first", requestId: "first", ownerId: "owner", origin: "model" }, context);
	await started;
	const inputs = [first.submissionId];
	for (let index = 1; index <= 64; index++) {
		const admission = await submitConversation(root, { message: `input ${index}`, requestId: `input-${index}`, ownerId: "owner", origin: "model", whenBusy: "steer" }, context);
		inputs.push(admission.submissionId);
	}
	release();
	for (const id of inputs) await readOutcome(harness, id, context);
	const publications: number[][] = [];
	const unsubscribe = harness.subscribeCommits((publication) => {
		const ids: number[] = [];
		for (const change of publication.changes) {
			if (change.type !== "document" || change.record.kind !== "agent.delivery-row" || change.value?.kind !== "receipt") continue;
			const receipt = change.value.value;
			assert.ok(receipt !== null && typeof receipt === "object" && !Array.isArray(receipt));
			const id = receipt.submissionId;
			assert.ok(typeof id === "number");
			ids.push(id);
		}
		if (ids.length) publications.push(ids);
	});
	try { await settleDeliveries(harness, context); } finally { unsubscribe(); }
	assert.deepEqual(publications.map((ids) => ids.sort((a, b) => a - b)), [[...inputs].sort((a, b) => a - b)]);
	const receipts = Object.values((await deliveryState(harness, context, true)).receipts);
	assert.equal(receipts.length, inputs.length);
	assert.equal(new Set(receipts.map((receipt) => receipt.answerEntryId)).size, 1);
	assert.notEqual(receipts[0].answerEntryId, null);
});

it("couples thread acknowledgement, the retained row and pending removal atomically", async (t) => {
	const harness = await Harness.open(new MemoryStorage(), { models: await fixtureRuntime("answer"), registry: fixtureRegistry() }, context);
	t.after(() => harness.close(context));
	await migrateDeliveryStore(harness, context);
	const row = { ...report(1), threadId: "thread" };
	await harness.commit(async (tx) => { await storeDeliveryRow(tx, "report", row, true); await tx.doc(ThreadDeliveryDoc, "thread", null); }, context);
	await assert.rejects(acknowledgeReports(harness, "owner", [row.sourceId], context), /inconsistent/u);
	assert.equal((await harness.snapshot(DeliveryRowDoc, reportKey("owner", row.sourceId), context))?.value && (await harness.commit((tx) => retainedReport(tx, "owner", row.sourceId), context))?.acknowledged, false);
	assert.equal((await pendingDeliveryPage(harness, context)).state.reports.length, 1);
	await harness.commit(async (tx) => { (await tx.doc(ThreadDeliveryDoc, "thread", null)).pending = 1; }, context);
	const commits: Array<Set<string>> = [];
	const unsubscribe = harness.subscribeCommits((publication) => commits.push(new Set(publication.changes.filter((change) => change.type === "document").map((change) => change.record.kind))));
	try { assert.deepEqual(await acknowledgeReports(harness, "owner", [row.sourceId], context), [row.sourceId]); }
	finally { unsubscribe(); }
	assert.ok(commits.some((kinds) => kinds.has("agent.thread-delivery") && kinds.has("agent.delivery-row") && kinds.has("agent.delivery-list")));
	assert.equal((await harness.snapshot(ThreadDeliveryDoc, "thread", context))?.pending, 0);
	assert.equal((await pendingDeliveryPage(harness, context)).state.reports.length, 0);
});

it("does not create retained documents for absent observation or acknowledgement keys", async (t) => {
	const storage = new CountedStorage();
	const harness = await Harness.open(storage, { models: await fixtureRuntime("answer"), registry: fixtureRegistry() }, context);
	t.after(() => harness.close(context));
	await migrateDeliveryStore(harness, context);
	await harness.root(context, { agent: { model: { provider: fixtureProvider, modelId: fixtureModelId } } });
	storage.operations = 0;
	await readDashboard(harness, "11111111-1111-4111-8111-111111111111", {}, {}, context);
	for (let index = 1; index <= 100; index++) {
		assert.equal(await latestReceipt(harness, index, context), undefined);
		assert.equal(await receiptAtInput(harness, index, index, context), undefined);
		assert.equal(await snapshotReceipt(harness, index, context), undefined);
		assert.equal(await snapshotIntent(harness, index, `unknown-${index}`, context), undefined);
		assert.equal(await receiptForRequest(harness, index, `unknown-${index}`, context), undefined);
		assert.deepEqual(await operationReceipts(harness, `unknown-${index}`, context), []);
	}
	assert.deepEqual(await acknowledgeReports(harness, "owner", Array.from({ length: 100 }, (_, index) => `unknown-${index}`), context), []);
	assert.equal(storage.operations, 0, "distinct absent keys produce no retained document writes");
});

it("retains terminal diagnostics and owner acknowledgement without active traversal", async (t) => {
	const harness = await Harness.open(new MemoryStorage(), { models: await fixtureRuntime("answer"), registry: fixtureRegistry() }, context);
	t.after(() => harness.close(context));
	await migrateDeliveryStore(harness, context);
	for (let index = 0; index < 193; index++) await harness.commit((tx) => storeDeliveryRow(tx, "report", { ...report(index), acknowledged: false, delivery: { state: "terminal", reason: "corrupt admission origin" } }, true), context);
	assert.deepEqual((await pendingDeliveryPage(harness, context)).state.reports, []);
	assert.equal(await deliveryPendingCount(harness, context), 193);
	assert.equal((await terminalDeliveryState(harness, context)).reports.length, 1);
	assert.equal((await deliveryState(harness, context)).reports.length, 193, "an explicit owner query retains every unacknowledged terminal row");
	await settleDeliveries(harness, context);
	assert.deepEqual((await pendingDeliveryPage(harness, context)).state.reports, []);
	assert.deepEqual(await acknowledgeReports(harness, "owner", ["report:r-0"], context), ["report:r-0"]);
	assert.equal(await deliveryPendingCount(harness, context), 192);
	assert.equal((await terminalDeliveryState(harness, context)).reports[0]?.sourceId, "report:r-1");
	assert.equal((await deliveryState(harness, context, true)).reports.length, 193);
});

it("deduplicates report request identities independently of source acknowledgement identities", async (t) => {
	const harness = await Harness.open(new MemoryStorage(), { models: await fixtureRuntime("answer"), registry: fixtureRegistry() }, context);
	t.after(() => harness.close(context));
	await migrateDeliveryStore(harness, context);
	const row = { ...report(1), sourceId: "check-in:1:task:1", requestId: "check-in:1:task:1", checkIn: { conversationId: 1, requestId: "task", origin: "model" as const, elapsedMs: 60000, cost: null } };
	await harness.commit((tx) => storeDeliveryRow(tx, "report", row, true), context);
	const retry = () => recordReport(harness, { ownerId: row.ownerId, senderIdentity: "other", requestId: row.requestId, message: "replacement" }, context);
	assert.deepEqual(await retry(), row);
	assert.deepEqual(await acknowledgeReports(harness, row.ownerId, [row.sourceId], context), [row.sourceId]);
	assert.deepEqual(await retry(), { ...row, acknowledged: true });
	assert.equal((await deliveryState(harness, context, true)).reports.length, 1);
});
