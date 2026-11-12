import assert from "node:assert/strict";
import { it } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { Harness, MemoryStorage, type ConversationId, type EntryId, type SubmissionId, type Tx } from "@earendil-works/pi-durable";
import { receiptReferencePage, storeDeliveryRow } from "./delivery-store.ts";
import type { DeliveryReceipt } from "./durable-controls.ts";
import { fixtureRegistry, fixtureRuntime } from "./durable-host-fixture.mts";
const storageId = "10000000-0000-4000-8000-000000000001";
const recipient = "20000000-0000-4000-8000-000000000002";
function receipt(index: number, ownerId = recipient, answer = 77): DeliveryReceipt { return { submissionId: index as SubmissionId, requestId: `input-${index}`, ownerId, conversationId: 1 as ConversationId, operationId: null, origin: "model", status: "done", entryId: index as EntryId, answerEntryId: answer as EntryId, answer: "answer", reason: null, acknowledged: false }; }
type Reads = { pageDocuments: number; referencesRead: number; membershipRows: number };
function traced(tx: Tx, reads: Reads): Tx {
	return new Proxy(tx, { get(target, property) {
		const value = Reflect.get(target, property, target);
		if (typeof value !== "function") return value;
		if (property !== "doc") return value.bind(target);
		return async (...args: unknown[]) => {
			const result = await Reflect.apply(value, target, args);
			const token = args[0] as { definition: { kind: string } };
			if (token.definition.kind === "agent.delivery-page") { reads.pageDocuments++; reads.referencesRead += (result as { refs: readonly unknown[] }).refs.length; }
			if (token.definition.kind === "agent.delivery-row") reads.membershipRows++;
			return result;
		};
	} });
}
it("reuses one page or reads at most two whole pages while traversing one membership page", { timeout: 15000 }, async (t) => {
	const harness = await Harness.open(new MemoryStorage(), { models: await fixtureRuntime("answer"), registry: fixtureRegistry() }, context);
	t.after(() => harness.close(context));
	await harness.commit(async (tx) => {
		for (let index = 1; index <= 81; index++) await storeDeliveryRow(tx, "receipt", receipt(index, index <= 64 ? "other" : recipient), true);
		for (let index = 82; index <= 98; index++) await storeDeliveryRow(tx, "receipt", receipt(index, recipient, 88), true);
	}, context);
	const two: Reads = { pageDocuments: 0, referencesRead: 0, membershipRows: 0 };
	const first = await harness.commit((tx) => receiptReferencePage(traced(tx, two), storageId, receipt(65)), context);
	assert.deepEqual(two, { pageDocuments: 2, referencesRead: 81, membershipRows: 64 });
	assert.deepEqual(first.results, []);
	assert.equal(first.complete, false);
	const one: Reads = { pageDocuments: 0, referencesRead: 0, membershipRows: 0 };
	const small = await harness.commit((tx) => receiptReferencePage(traced(tx, one), storageId, receipt(82, recipient, 88)), context);
	assert.deepEqual(one, { pageDocuments: 1, referencesRead: 17, membershipRows: 16 });
	assert.equal(small.results.length, 16);
	assert.ok(first.next && small.next);
	const range = JSON.parse(Buffer.from(first.next, "base64url").toString("utf8"));
	const foreign = JSON.parse(Buffer.from(small.next, "base64url").toString("utf8"));
	const forged = Buffer.from(JSON.stringify({ ...range, endPageId: foreign.endPageId, endOffset: foreign.endOffset })).toString("base64url");
	const refused: Reads = { pageDocuments: 0, referencesRead: 0, membershipRows: 0 };
	await assert.rejects(harness.commit((tx) => receiptReferencePage(traced(tx, refused), storageId, receipt(65), forged), context), /another list/);
	assert.equal(refused.pageDocuments, 1);
	assert.equal(refused.membershipRows, 0, "captured terminal validation precedes membership traversal");
});
