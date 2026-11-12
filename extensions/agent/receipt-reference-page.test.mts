import assert from "node:assert/strict";
import { it } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { Harness, MemoryStorage, type ConversationId, type EntryId, type SubmissionId } from "@earendil-works/pi-durable";
import { receiptDeliveryRequestId, receiptReferencePage, receiptSourceIdentity, storeDeliveryRow } from "./delivery-store.ts";
import type { DeliveryReceipt } from "./durable-controls.ts";
import { fixtureRegistry, fixtureRuntime } from "./durable-host-fixture.mts";

const storageId = "10000000-0000-4000-8000-000000000001";
const recipient = "20000000-0000-4000-8000-000000000002";
function cursor(page: { next: string | null }): string { assert.ok(page.next); return page.next; }
function receipt(index: number, ownerId = recipient, answer = 77): DeliveryReceipt {
	return { submissionId: index as SubmissionId, requestId: `input-${index}`, ownerId, conversationId: 1 as ConversationId, operationId: null, origin: "model", status: "done", entryId: index as EntryId, answerEntryId: answer as EntryId, answer: "answer", reason: null, acknowledged: false };
}

it("pages one recipient across empty filtered pages and a captured append-only tail", { timeout: 15000 }, async (t) => {
	const harness = await Harness.open(new MemoryStorage(), { models: await fixtureRuntime("answer"), registry: fixtureRegistry() }, context);
	t.after(() => harness.close(context));
	const selected = receipt(65);
	await harness.commit(async (tx) => {
		for (let index = 1; index <= 81; index++) await storeDeliveryRow(tx, "receipt", receipt(index, index <= 64 ? "other" : recipient), true);
	}, context);
	const first = await harness.commit((tx) => receiptReferencePage(tx, storageId, selected), context);
	assert.deepEqual(first.results, []);
	assert.equal(first.complete, false);
	assert.ok(first.next);
	await harness.commit((tx) => storeDeliveryRow(tx, "receipt", receipt(82), true), context);
	const second = await harness.commit((tx) => receiptReferencePage(tx, storageId, selected, cursor(first)), context);
	assert.equal(second.results.length, 16);
	assert.deepEqual(second.results.map((item) => item.submissionId), Array.from({ length: 16 }, (_, index) => 65 + index));
	assert.ok(second.next);
	const third = await harness.commit((tx) => receiptReferencePage(tx, storageId, selected, cursor(second)), context);
	assert.deepEqual(third.results.map((item) => item.submissionId), [81]);
	assert.equal(third.complete, true);
	assert.equal(third.next, null);
	const fresh = await harness.commit((tx) => receiptReferencePage(tx, storageId, selected), context);
	const refreshed = await harness.commit((tx) => receiptReferencePage(tx, storageId, selected, cursor(fresh)), context);
	const refreshedEnd = await harness.commit((tx) => receiptReferencePage(tx, storageId, selected, cursor(refreshed)), context);
	assert.deepEqual(refreshedEnd.results.map((item) => item.submissionId), [81, 82]);
});

it("refuses changed identity, recipient, offsets and cursor encodings", { timeout: 15000 }, async (t) => {
	const harness = await Harness.open(new MemoryStorage(), { models: await fixtureRuntime("answer"), registry: fixtureRegistry() }, context);
	t.after(() => harness.close(context));
	await harness.commit(async (tx) => { for (let index = 1; index <= 17; index++) await storeDeliveryRow(tx, "receipt", receipt(index), true); }, context);
	const selected = receipt(1);
	const first = await harness.commit((tx) => receiptReferencePage(tx, storageId, selected), context);
	assert.equal(first.results.length, 16);
	assert.ok(first.next);
	const value = JSON.parse(Buffer.from(first.next, "base64url").toString("utf8"));
	for (const patch of [{ recipient: "other" }, { storageId: "other" }, { answerEntryId: 78 }, { selectedSubmissionId: 2 }, { offset: -1 }, { offset: 64 }, { endOffset: 64 }, { pageId: "0" }, { pageId: "1" }, { endPageId: "1" }, { extra: true }]) {
		const cursor = Buffer.from(JSON.stringify({ ...value, ...patch })).toString("base64url");
		await assert.rejects(harness.commit((tx) => receiptReferencePage(tx, storageId, selected, cursor), context), /cursor|owner-list/iu);
	}
	for (const cursor of ["!", `${first.next}=`, "a".repeat(2049)]) await assert.rejects(harness.commit((tx) => receiptReferencePage(tx, storageId, selected, cursor), context), /cursor/iu);
	const alternate = receipt(1, "other");
	assert.notEqual(receiptSourceIdentity(storageId, selected), receiptSourceIdentity(storageId, alternate));
	assert.equal(receiptDeliveryRequestId(storageId, selected), `deliver:${receiptSourceIdentity(storageId, selected)}`);
	assert.equal(receiptDeliveryRequestId(storageId, selected), receiptDeliveryRequestId(storageId, receipt(2)));
});
