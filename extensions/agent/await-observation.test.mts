import assert from "node:assert/strict";
import { it } from "node:test";
import { InboxDoc, LiveDoc, type Tx, type ConversationId, type TaskId } from "@earendil-works/pi-durable";
import { Value } from "typebox/value";
import { AwaitDoc, commitAwaitOutcome, type AwaitState } from "./awaited-results.ts";
import { AwaitFactSchema, type OwnAwaitFact } from "./await-facts.ts";
import { readAwaitFact, recordProducerAwait, releaseAwait } from "./await-observation.ts";

function fixture() {
	const results = Array.from({ length: 16 }, (_, index) => ({ sessionId: `peer-${index}`, submissionId: index + 10, requestId: "😀".repeat(512) }));
	const state: AwaitState = { declarations: [{ taskId: 3, callId: "await", conversationId: 1, runId: 2, cohort: [3], inputs: [4], results, outcomes: [], decision: "awaiting" }], provenance: [] };
	const inbox = { items: [{ id: 5, mode: "followUp" }, { id: 6, mode: "write" }, { id: 7, mode: "followUp" }] }; let terminal = false;
	const tx = { doc: async (token: unknown) => token === AwaitDoc ? state : token === InboxDoc ? inbox : token === LiveDoc ? { run: { taskId: 2 } } : undefined, task: async () => ({ abortRequested: false, state: { status: terminal ? "terminal" : "ready" } }) } as unknown as Tx;
	return { state, tx, results, end: () => { terminal = true; } };
}
const conversation = 1 as ConversationId;

it("bounds Unicode result and producer facts by bytes with exact omission counts", async () => {
	const f = fixture(); const own = await readAwaitFact(f.tx, "consumer", conversation); assert.ok(own);
	assert.equal(own.results.length + own.omitted.results, 16); assert.ok(own.omitted.results > 0);
	const producer: OwnAwaitFact = { runId: 9, heldInputs: [10], results: own.results, queuedInputCount: 0, queueSnapshot: "committed InboxDoc", omitted: { heldInputs: 0, results: own.omitted.results } };
	for (const result of f.results) await recordProducerAwait(f.tx, 3 as TaskId, { sessionId: result.sessionId, observedAt: 1, source: "producer await-state", awaiting: producer });
	const fact = await readAwaitFact(f.tx, "consumer", conversation); assert.ok(fact);
	assert.equal(fact.producers.length + fact.omittedProducers, 16); assert.ok(fact.omittedProducers > 0);
	assert.ok(Buffer.byteLength(JSON.stringify(fact), "utf8") <= 12000); assert.equal(Value.Check(AwaitFactSchema, fact), true);
	assert.deepEqual(fact.likelyCycle, []); assert.equal(fact.coverage, "one hop; remote graph incomplete");
});

it("counts ordinary inputs but excludes passive writes and suppressed named check-ins", async () => {
	const f = fixture(); f.state.provenance.push({ conversationId: 1, requestId: "check", submissionId: 7, classification: "automatic", automaticKind: "checkIn", sender: f.results[0].sessionId, producerRequestId: f.results[0].requestId });
	assert.equal((await readAwaitFact(f.tx, "consumer", conversation))?.queuedInputCount, 1);
	f.state.provenance[0].producerRequestId = "another-request";
	assert.equal((await readAwaitFact(f.tx, "consumer", conversation))?.queuedInputCount, 2);
});

it("skips unchanged semantic facts instead of writing notification feedback", async () => {
	const f = fixture(); const fact = { sessionId: f.results[0].sessionId, observedAt: 1, source: "producer await-state" as const };
	await recordProducerAwait(f.tx, 3 as TaskId, fact); const before = JSON.stringify(f.state);
	await recordProducerAwait(f.tx, 3 as TaskId, { ...fact, observedAt: 2 }); assert.equal(JSON.stringify(f.state), before);
	await recordProducerAwait(f.tx, 3 as TaskId, { ...fact, observedAt: 3, unavailable: "connection closed" }); assert.notEqual(JSON.stringify(f.state), before);
});

it("requires unresolved forward edges for a retained producer reverse wait after partial settlement", async () => {
	const f = fixture(); f.state.declarations[0].results = f.results.slice(0, 2);
	const producer: OwnAwaitFact = { runId: 9, heldInputs: [10], results: [{ result: { sessionId: "consumer", submissionId: 4 }, status: "pending" }], queuedInputCount: 0, queueSnapshot: "committed InboxDoc", omitted: { heldInputs: 0, results: 0 } };
	await recordProducerAwait(f.tx, 3 as TaskId, { sessionId: f.results[0].sessionId, observedAt: 1, source: "producer await-state", awaiting: producer });
	assert.deepEqual((await readAwaitFact(f.tx, "consumer", conversation))?.likelyCycle, [f.results[0].sessionId]);
	await commitAwaitOutcome(f.tx, 3 as TaskId, { result: f.results[0], status: "done", answer: "B finished", answerEntryId: 100 });
	await recordProducerAwait(f.tx, 3 as TaskId, { sessionId: f.results[0].sessionId, observedAt: 2, source: "producer await-state", awaiting: { ...producer, runId: 11 } });
	const fact = await readAwaitFact(f.tx, "consumer", conversation); assert.ok(fact);
	assert.deepEqual(fact.results.map((item) => item.status), ["done", "pending"]); assert.equal(fact.producers[0]?.awaiting?.runId, 11);
	assert.deepEqual(fact.likelyCycle, []); assert.equal(f.state.declarations[0].decision, "awaiting");
});

it("omits terminal native owners and refuses stale selected-run release", async () => {
	const f = fixture(); assert.deepEqual(await releaseAwait(f.tx, "consumer", conversation, 99), { released: false });
	f.end(); assert.equal(await readAwaitFact(f.tx, "consumer", conversation), undefined);
	assert.deepEqual(await releaseAwait(f.tx, "consumer", conversation, 2), { released: false });
});
