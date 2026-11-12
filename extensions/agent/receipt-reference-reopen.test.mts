import assert from "node:assert/strict";
import { it } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { Harness, defineDocFamily, type ConversationId, type EntryId, type SubmissionId } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { DeliveryStoreDoc, snapshotReceipt, receiptKey, receiptReferencePage, storeDeliveryRow } from "./delivery-store.ts";
import type { DeliveryReceipt } from "./durable-controls.ts";
import { fixtureRegistry, fixtureRuntime } from "./durable-host-fixture.mts";
const storageId = "10000000-0000-4000-8000-000000000001";
function receipt(index: number): DeliveryReceipt { return { submissionId: index as SubmissionId, requestId: `input-${index}`, ownerId: "20000000-0000-4000-8000-000000000002", conversationId: 1 as ConversationId, operationId: null, origin: "model", status: "done", entryId: index as EntryId, answerEntryId: 77 as EntryId, answer: "answer", reason: null, acknowledged: false }; }
it("preserves exact recipient cursor identity across SQLite reopen", { timeout: 15000 }, async () => {
	const root = mkdtempSync(join(tmpdir(), "receipt-page-"));
	let harness: Harness | undefined;
	try {
		const path = join(root, "source.sqlite");
		const options = { models: await fixtureRuntime("answer"), registry: fixtureRegistry() };
		harness = await Harness.open(await openNodeSqliteStorage(path), options, context);
		await harness.commit(async (tx) => { for (let index = 1; index <= 17; index++) await storeDeliveryRow(tx, "receipt", receipt(index), true); }, context);
		const first = await harness.commit((tx) => receiptReferencePage(tx, storageId, receipt(1)), context);
		const continuation = first.next;
		assert.ok(continuation);
		await harness.commit(async (tx) => { for (let index = 18; index <= 80; index++) await storeDeliveryRow(tx, "receipt", receipt(index), true); }, context);
		await harness.close(context);
		harness = await Harness.open(await openNodeSqliteStorage(path), options, context);
		const last = await harness.commit((tx) => receiptReferencePage(tx, storageId, receipt(1), continuation), context);
		assert.deepEqual(last.results.map((item) => item.submissionId), [17]);
		assert.equal(last.complete, true);
		assert.equal(last.next, null);
	} finally { await harness?.close(context); rmSync(root, { recursive: true, force: true }); }
});
it("refuses an old ownerless page without normalisation or a version migration", { timeout: 15000 }, async () => {
	const root = mkdtempSync(join(tmpdir(), "receipt-old-"));
	let harness: Harness | undefined;
	const OldPage = defineDocFamily<{ refs: string[]; previous: string | null; next: string | null }, null>({ kind: "agent.delivery-page", version: 1, scope: "session", family: true, initial: () => ({ refs: [], previous: null, next: null }), checkpointWhen: () => true });
	const List = defineDocFamily<{ head: string | null; tail: string | null; count: number }, null>({ kind: "agent.delivery-list", version: 1, scope: "session", family: true, initial: () => ({ head: null, tail: null, count: 0 }), checkpointWhen: () => true });
	try {
		const path = join(root, "source.sqlite"), options = { models: await fixtureRuntime("answer"), registry: fixtureRegistry() };
		harness = await Harness.open(await openNodeSqliteStorage(path), options, context);
		await harness.commit(async (tx) => {
			(await tx.doc(OldPage, "1", null)).refs.push(receiptKey(1));
			(await tx.doc(OldPage, "2", null)).refs.push(receiptKey(1));
			Object.assign(await tx.doc(List, "answer:77", null), { head: "1", tail: "1", count: 1 });
			Object.assign(await tx.doc(List, "all:receipt", null), { head: "2", tail: "2", count: 1 });
			Object.assign(await tx.doc(DeliveryStoreDoc), { ready: true, nextPage: 2 });
		}, context);
		await harness.close(context);
		harness = await Harness.open(await openNodeSqliteStorage(path), options, context);
		await assert.rejects(harness.commit((tx) => receiptReferencePage(tx, storageId, receipt(1)), context), /version|owner-list|migration/iu);
		await assert.rejects(harness.commit((tx) => storeDeliveryRow(tx, "receipt", receipt(2), true), context), /requires migration from version 1/iu);
		assert.equal(await snapshotReceipt(harness, 2, context), undefined);
		assert.deepEqual(await harness.snapshot(OldPage, "1", context), { refs: [receiptKey(1)], previous: null, next: null });
		assert.deepEqual(await harness.snapshot(OldPage, "2", context), { refs: [receiptKey(1)], previous: null, next: null });
	} finally { await harness?.close(context); rmSync(root, { recursive: true, force: true }); }
});
