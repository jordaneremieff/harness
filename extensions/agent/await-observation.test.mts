import assert from "node:assert/strict";
import { it } from "node:test";
import { AgentDoc, InboxDoc, LiveDoc, type Tx, type ConversationId, type TaskId } from "@earendil-works/pi-durable";
import { Value } from "typebox/value";
import { AwaitDoc, commitAwaitOutcome, type AwaitState } from "./awaited-results.ts";
import { AwaitFactSchema, awaitFactLines, type OwnAwaitFact } from "./await-facts.ts";
import { producerRetryFact, readAwaitFact, recordProducerAwait, releaseAwait } from "./await-observation.ts";

function fixture() {
	const results = Array.from({ length: 16 }, (_, index) => ({ sessionId: `peer-${index}`, submissionId: index + 10, requestId: "😀".repeat(512) }));
	const state: AwaitState = { declarations: [{ taskId: 3, callId: "await", conversationId: 1, runId: 2, cohort: [3], inputs: [4], results, outcomes: [], decision: "awaiting" }], provenance: [] };
	const inbox = { items: [{ id: 5, mode: "followUp" }, { id: 6, mode: "write" }, { id: 7, mode: "followUp" }] }; let terminal = false;
	const tx = { doc: async (token: unknown) => token === AwaitDoc ? state : token === InboxDoc ? inbox : token === LiveDoc ? { run: { taskId: 2 } } : undefined, task: async () => ({ abortRequested: false, state: { status: terminal ? "terminal" : "ready" } }) } as unknown as Tx;
	return { state, tx, results, end: () => { terminal = true; } };
}
const conversation = 1 as ConversationId;

it("correlates retries with current run inputs and clears on exit, settlement, or abort", async () => {
	const result = { sessionId: "producer", submissionId: 10, requestId: "active" };
	const live: { run?: { taskId: number; inputs: number[] }; generation?: { attempt: number; retry: { at: number; error: string } } } = { run: { taskId: 9, inputs: [10] }, generation: { attempt: 18, retry: { at: 1791200000000, error: `429 Weekly/Monthly Limit Exhausted\napi_key=sk-abcdefghijklmnopqrstuv\u001b[31m ${"x".repeat(2000)}` } } };
	let abortRequested = false; let terminal = false;
	const tx = { doc: async (token: unknown) => token === LiveDoc ? live : token === AgentDoc ? { model: { provider: "synthetic", modelId: "model" } } : undefined,
		task: async () => ({ abortRequested, state: { status: terminal ? "terminal" : "ready" } }),
		submissionByRequest: async (_id: unknown, requestId: string) => ({ id: requestId === "active" ? 10 : 20, status: "placed" }) } as unknown as Tx;
	const retry = await producerRetryFact(tx, conversation, [result, { ...result, submissionId: 20 }], 21); assert.ok(retry);
	assert.deepEqual(retry.results, [result]); assert.equal(retry.attempt, 18); assert.equal(retry.maxAttempts, 21);
	assert.equal(retry.errorTruncated, true); assert.ok(Buffer.byteLength(retry.error) <= 512);
	assert.doesNotMatch(retry.error, /sk-abcdefghijkl|[\p{Cc}\p{Cf}]/u); assert.match(retry.error, /credential omitted/u);
	assert.equal(await producerRetryFact(tx, conversation, [{ ...result, requestId: "wrong" }]), undefined);
	assert.equal((await producerRetryFact(tx, conversation, [result]))?.maxAttempts, undefined);
	abortRequested = true; assert.equal(await producerRetryFact(tx, conversation, [result]), undefined); abortRequested = false;
	terminal = true; assert.equal(await producerRetryFact(tx, conversation, [result]), undefined); terminal = false;
	delete live.generation; assert.equal(await producerRetryFact(tx, conversation, [result]), undefined);
	delete live.run; assert.equal(await producerRetryFact(tx, conversation, [result]), undefined);
});

it("prioritizes retry text and drops its execution fact when the exact reference settles", async () => {
	const f = fixture(); f.state.declarations[0].results = f.results.map((result) => ({ ...result, requestId: "request" }));
	const result = f.state.declarations[0].results.at(-1); assert.ok(result);
	const execution = { state: "provider-retry" as const, runId: 9, results: [result], attempt: 18, nextRetryAt: 1791200000000, error: "429 Weekly/Monthly Limit Exhausted", errorTruncated: false };
	for (const ref of f.state.declarations[0].results) await recordProducerAwait(f.tx, 3 as TaskId, { sessionId: ref.sessionId, observedAt: 1, source: "producer await-state" });
	await recordProducerAwait(f.tx, 3 as TaskId, { sessionId: result.sessionId, observedAt: 2, source: "producer await-state", execution });
	const fact = await readAwaitFact(f.tx, "consumer", conversation); assert.ok(fact);
	assert.equal(fact.producers[0].sessionId, result.sessionId); assert.match(awaitFactLines(fact)[0], /submission 25.*pending.*provider retry.*attempt 18/u);
	await commitAwaitOutcome(f.tx, 3 as TaskId, { result, status: "done", answer: "finished", answerEntryId: 100 });
	assert.ok((await readAwaitFact(f.tx, "consumer", conversation))?.producers.every((producer) => producer.execution === undefined));
});

it("keeps a blocked reference ahead of generic facts under both byte bounds", async () => {
	const f = fixture(); const result = f.results[15];
	await recordProducerAwait(f.tx, 3 as TaskId, { sessionId: result.sessionId, observedAt: 1, source: "producer await-state", execution: { state: "provider-retry", runId: 9, results: [result], attempt: 18, nextRetryAt: 1791200000000, error: "429 Weekly/Monthly Limit Exhausted", errorTruncated: false } });
	const fact = await readAwaitFact(f.tx, "consumer", conversation); assert.ok(fact);
	assert.deepEqual(fact.results[0].result, result); assert.ok(fact.omitted.results > 0);
	assert.deepEqual(fact.producers[0].execution?.results, [result]); assert.equal(Value.Check(AwaitFactSchema, fact), true);
});

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
