import assert from "node:assert/strict";
import { it, type TestContext } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { Harness, MemoryStorage, type EntryId } from "@earendil-works/pi-durable";
import { fixtureRegistry, fixtureRuntime } from "./durable-host-fixture.mts";
import { nativeContinuityText, type ContinuityFact } from "./continuity-facts.ts";
import { ContinuityDoc, recordContinuityDelivered, recordContinuityFact } from "./continuity-native.ts";

const requested = (requestId = "request-a", replyTo = "owner"): ContinuityFact => ({ phase: "requested", sessionId: "worker:2", requestId, replyTo });
const admitted = (requestId = "request-a", submissionId = 1): ContinuityFact => ({ ...requested(requestId), phase: "admitted", submissionId });
async function fixture(t: TestContext) {
	const harness = await Harness.open(new MemoryStorage(), { models: await fixtureRuntime("answer"), registry: fixtureRegistry() }, context);
	t.after(() => harness.close(context));
	const conversation = await harness.root(context);
	return { harness, conversation };
}

it("records the head in the admission transaction and completes an entire replayed delivery group", async (t) => {
	const { harness, conversation } = await fixture(t);
	await harness.commit(async (tx) => {
		for (let index = 0; index < 20; index++) {
			await recordContinuityFact(tx, conversation.id, requested(`group-${index}`));
			await recordContinuityFact(tx, conversation.id, admitted(`group-${index}`, index + 1));
		}
	}, context);
	const head = await harness.commit((tx) => tx.appendEntry(conversation.id, { kind: "pi.reset", head: "self" }), context);
	const references = Array.from({ length: 20 }, (_, index) => ({ sessionId: "worker:2", requestId: `group-${index}`, submissionId: index + 1 }));
	await harness.commit((tx) => recordContinuityDelivered(tx, conversation.id, references), context);
	const first = await harness.snapshot(ContinuityDoc, conversation.id, context);
	assert.ok(first);
	assert.equal(first.events.filter((fact) => fact.phase === "delivered").length, 20);
	assert.ok(first.events.filter((fact) => fact.phase === "delivered").every((fact) => fact.afterHead === head.id));
	await harness.commit((tx) => recordContinuityDelivered(tx, conversation.id, references), context);
	assert.deepEqual(await harness.snapshot(ContinuityDoc, conversation.id, context), first);
	assert.equal((nativeContinuityText("owner", head.id, first.events).match(/"submissionId":/gu) ?? []).length, 20);
	assert.doesNotMatch(nativeContinuityText("owner", (head.id + 1) as EntryId, first.events), /"submissionId":/u);
});

it("does not publish facts from a failed storage transaction", async (t) => {
	const { harness, conversation } = await fixture(t);
	await assert.rejects(harness.commit(async (tx) => { await recordContinuityFact(tx, conversation.id, requested()); throw new Error("failure"); }, context), /failure/u);
	assert.equal((await harness.snapshot(ContinuityDoc, conversation.id, context))?.events.length ?? 0, 0);
});
