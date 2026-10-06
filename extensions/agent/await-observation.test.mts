import assert from "node:assert/strict";
import { it } from "node:test";
import { AgentDoc, InboxDoc, LiveDoc, type Tx, type ConversationId, type TaskId, type SubmissionId } from "@earendil-works/pi-durable";
import { Value } from "typebox/value";
import { BACKGROUND_CONTEXT, withCancel } from "@earendil-works/chord/context";
import { CheckInTask } from "./durable-checkins.ts";
import { observeProducerAwait } from "./await-producer-observer.ts";
import { scheduleFixture } from "./durable-schedule-fixture.mts";
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

function parallelFixture() {
	const f = fixture();
	const first = { sessionId: "producer", submissionId: 10, requestId: "first" };
	const second = { sessionId: "producer", submissionId: 11, requestId: "second" };
	const declaration = f.state.declarations[0]; declaration.results = [first]; declaration.cohort = [3, 4];
	f.state.declarations.push({ ...declaration, taskId: 4, callId: "parallel-await", results: [second], outcomes: [] });
	const retry = (results: typeof first[], attempt = 18, runId = 9) => ({ state: "provider-retry" as const, runId, results, attempt, maxAttempts: 21, nextRetryAt: 1791200000000, error: "429 Weekly/Monthly Limit Exhausted", errorTruncated: false });
	return { ...f, first, second, retry };
}

for (const reverse of [false, true]) it(`preserves one producer's retry across parallel active and queued inputs with declaration order ${reverse ? "reversed" : "forward"}`, async () => {
	const f = parallelFixture();
	await recordProducerAwait(f.tx, 3 as TaskId, { sessionId: "producer", observedAt: 1, source: "producer await-state", execution: f.retry([f.first]) });
	await recordProducerAwait(f.tx, 4 as TaskId, { sessionId: "producer", observedAt: 2, source: "producer await-state" });
	if (reverse) f.state.declarations.reverse();
	const fact = await readAwaitFact(f.tx, "consumer", conversation); assert.ok(fact);
	assert.deepEqual(fact.producers[0].execution?.results, [f.first]); assert.equal(fact.producers[0].observedAt, 1);
	assert.deepEqual(fact.results.map((item) => item.status), ["pending", "pending"]);
	assert.match(awaitFactLines(fact)[0], /submission 10.*provider retry/u);
	assert.equal(Value.Check(AwaitFactSchema, fact), true);
});

it("merges parallel inputs in the same producer run and clears only matching settled or newer observations", async () => {
	const f = parallelFixture();
	await recordProducerAwait(f.tx, 3 as TaskId, { sessionId: "producer", observedAt: 1, source: "producer await-state", execution: f.retry([f.first]) });
	await recordProducerAwait(f.tx, 4 as TaskId, { sessionId: "producer", observedAt: 2, source: "producer await-state", execution: f.retry([f.second], 19) });
	let fact = await readAwaitFact(f.tx, "consumer", conversation); assert.ok(fact);
	assert.deepEqual(fact.producers[0].execution?.results, [f.first, f.second]); assert.equal(fact.producers[0].execution?.attempt, 19); assert.equal(fact.producers[0].observedAt, 1);
	await commitAwaitOutcome(f.tx, 3 as TaskId, { result: f.first, status: "done", answer: "finished", answerEntryId: 100 });
	fact = await readAwaitFact(f.tx, "consumer", conversation); assert.deepEqual(fact?.producers[0].execution?.results, [f.second]);
	await recordProducerAwait(f.tx, 4 as TaskId, { sessionId: "producer", observedAt: 3, source: "producer await-state" });
	assert.equal((await readAwaitFact(f.tx, "consumer", conversation))?.producers[0].execution, undefined);
});

it("uses exact-reference freshness for repeated empty reads without notification feedback", async () => {
	const f = parallelFixture(); f.state.declarations[1].results = [f.first];
	const empty = { sessionId: "producer", observedAt: 1, source: "producer await-state" as const };
	await recordProducerAwait(f.tx, 4 as TaskId, empty);
	await recordProducerAwait(f.tx, 3 as TaskId, { ...empty, observedAt: 2, execution: f.retry([f.first]) });
	assert.ok((await readAwaitFact(f.tx, "consumer", conversation))?.producers[0].execution);
	await recordProducerAwait(f.tx, 4 as TaskId, { ...empty, observedAt: 3 });
	assert.equal((await readAwaitFact(f.tx, "consumer", conversation))?.producers[0].execution, undefined);
	const settled = JSON.stringify(f.state);
	await recordProducerAwait(f.tx, 4 as TaskId, { ...empty, observedAt: 4 }); assert.equal(JSON.stringify(f.state), settled);
});

it("does not merge older retry runs or retain retries after all producer observations are lost", async () => {
	const f = parallelFixture();
	await recordProducerAwait(f.tx, 3 as TaskId, { sessionId: "producer", observedAt: 1, source: "producer await-state", execution: f.retry([f.first]) });
	await recordProducerAwait(f.tx, 4 as TaskId, { sessionId: "producer", observedAt: 2, source: "producer await-state", execution: f.retry([f.second], 1, 10) });
	assert.deepEqual((await readAwaitFact(f.tx, "consumer", conversation))?.producers[0].execution?.results, [f.second]);
	await recordProducerAwait(f.tx, 4 as TaskId, { sessionId: "producer", observedAt: 3, source: "producer await-state", unavailable: "connection closed" });
	await recordProducerAwait(f.tx, 3 as TaskId, { sessionId: "producer", observedAt: 4, source: "producer await-state", unavailable: "connection closed" });
	const fact = await readAwaitFact(f.tx, "consumer", conversation); assert.equal(fact?.producers[0].execution, undefined); assert.equal(fact?.producers[0].unavailable, "connection closed");
});

it("deduplicates overlapping reference sets through the real local commit feed with an advancing clock", { timeout: 10000 }, async (t) => {
	const f = await scheduleFixture(t, { resume: false }); const root = await f.conversation();
	const a = { sessionId: "producer", submissionId: 10, requestId: "A" }; const b = { ...a, submissionId: 11, requestId: "B" };
	const ids = await f.host.harness.commit(async (tx) => {
		const input = { conversationId: root.id, requestId: "holding", ownerId: "owner", senderIdentity: "consumer", message: "held", whenBusy: "followUp" as const, origin: "operator" as const, admittedAt: Date.now(), intervalMs: 300000 };
		const owner = await tx.createTask(CheckInTask, input, { ownership: { kind: "conversation" }, conversationId: root.id, background: true });
		const first = await tx.createTask(CheckInTask, { ...input, requestId: "first" }, { ownership: { kind: "conversation" }, conversationId: root.id, background: true });
		const second = await tx.createTask(CheckInTask, { ...input, requestId: "second" }, { ownership: { kind: "conversation" }, conversationId: root.id, background: true });
		(await tx.doc(LiveDoc, root.id)).run = { taskId: owner, inputs: [5 as SubmissionId] };
		const scopes: [TaskId, typeof a[]][] = [[first, [a]], [second, [a, b]]];
		(await tx.doc(AwaitDoc)).declarations = scopes.map(([taskId, results]) => ({ taskId, callId: `await-${taskId}`, conversationId: root.id, runId: owner, cohort: [first, second], inputs: [5], results, outcomes: [], decision: "awaiting" }));
		return [first, second];
	}, BACKGROUND_CONTEXT);
	let clock = Date.now(); t.mock.method(Date, "now", () => ++clock);
	const owned = ids.map(() => withCancel(BACKGROUND_CONTEXT)); const stop = () => { for (const job of owned) job.cancel(); };
	const stable = new Set<number>(); let writes = 0; let reads = 0; let closed = 0;
	const jobs = ids.map((taskId, index) => observeProducerAwait("producer", async () => {
		reads++;
		return { execution: { state: "provider-retry" as const, runId: 9, results: index === 0 ? [a] : [a, b], attempt: 18, maxAttempts: 21, nextRetryAt: 1791200300000, error: "429 Weekly/Monthly Limit Exhausted", errorTruncated: false } };
	}, async (changed) => {
		const off = f.host.harness.subscribeCommits((publication) => { if (publication.changes.length) changed(); });
		return () => { closed++; off(); };
	}, async (fact) => {
		const changed = await f.host.harness.commit(async (tx) => { const before = JSON.stringify(await tx.doc(AwaitDoc)); await recordProducerAwait(tx, taskId, fact); return before !== JSON.stringify(await tx.doc(AwaitDoc)); }, BACKGROUND_CONTEXT);
		if (changed) { writes++; if (writes > 2) { stop(); throw new Error("Unchanged overlapping observations wrote feedback"); } }
		else { stable.add(index); if (stable.size === 2) stop(); }
	}, owned[index].context));
	try {
		await Promise.all(jobs);
		assert.equal(writes, 2); assert.deepEqual([...stable].sort(), [0, 1]); assert.ok(reads >= 4); assert.equal(closed, 2); assert.equal(f.modelRequestCount(), 0);
		const fact = await f.host.harness.commit((tx) => readAwaitFact(tx, f.storageId, root.id), BACKGROUND_CONTEXT);
		assert.deepEqual(fact?.producers[0].execution?.results, [a, b]); assert.equal(Value.Check(AwaitFactSchema, fact), true);
	} finally { stop(); await Promise.allSettled(jobs); t.mock.restoreAll(); }
});

for (const overlap of [false, true]) for (const retry of [false, true]) it(`retains successful ${retry ? "retry and wait" : "wait"} facts after ${overlap ? "an overlapping" : "a disjoint"} subscription loses its connection`, async () => {
	const f = parallelFixture(); if (overlap) f.state.declarations[1].results = [f.first, f.second];
	const base = { sessionId: "producer", source: "producer await-state" as const };
	const ownWait: OwnAwaitFact = { runId: 9, heldInputs: [10], results: [{ result: { sessionId: "consumer", submissionId: 4 }, status: "pending" }], queuedInputCount: 0, queueSnapshot: "committed InboxDoc", omitted: { results: 0, heldInputs: 0 } };
	const first = { ...base, awaiting: ownWait, ...(retry ? { execution: f.retry([f.first]) } : {}) };
	await recordProducerAwait(f.tx, 3 as TaskId, { ...first, observedAt: 1 });
	await recordProducerAwait(f.tx, 4 as TaskId, { ...base, awaiting: ownWait, observedAt: 2, ...(retry ? { execution: f.retry(overlap ? [f.first, f.second] : [f.second]) } : {}) });
	await recordProducerAwait(f.tx, 4 as TaskId, { ...base, observedAt: 3, unavailable: "Producer host connection closed" });
	await recordProducerAwait(f.tx, 3 as TaskId, { ...first, observedAt: 4 });
	const fact = await readAwaitFact(f.tx, "consumer", conversation); assert.ok(fact);
	if (retry) { assert.deepEqual(fact.producers[0].execution?.results, [f.first]); assert.equal(fact.producers[0].execution?.attempt, 18); }
	else assert.equal(fact.producers[0].execution, undefined);
	assert.deepEqual(fact.producers[0].awaiting, ownWait);
	assert.equal(fact.producers[0].observedAt, overlap ? 4 : 1); assert.match(fact.producers[0].unavailable ?? "", /Partial observation loss.*submission 11 request second at 3: Producer host connection closed/u);
	assert.doesNotMatch(fact.producers[0].unavailable ?? "", /submission 10/u); assert.equal(Value.Check(AwaitFactSchema, fact), true);
	assert.match(awaitFactLines(fact).join("\n"), /awaits consumer\/4.*Partial observation loss/u);
	const retained = JSON.stringify(f.state); await recordProducerAwait(f.tx, 3 as TaskId, { ...first, observedAt: 5 }); assert.equal(JSON.stringify(f.state), retained);
	await recordProducerAwait(f.tx, 4 as TaskId, { ...base, awaiting: ownWait, observedAt: 6, ...(retry ? { execution: f.retry(overlap ? [f.first, f.second] : [f.second]) } : {}) });
	const restored = await readAwaitFact(f.tx, "consumer", conversation);
	if (retry) assert.deepEqual(restored?.producers[0].execution?.results, [f.first, f.second]);
	else assert.equal(restored?.producers[0].execution, undefined);
	assert.deepEqual(restored?.producers[0].awaiting, ownWait); assert.equal(restored?.producers[0].unavailable, undefined);
});

it("keeps a multi-reference retry producer before generic result detail within the byte limit", async () => {
	const f = fixture();
	const refs = Array.from({ length: 16 }, (_, index) => ({ sessionId: "producer", submissionId: 10 + index, requestId: `request-${index}-${"x".repeat(338)}` }));
	f.state.declarations[0].results = refs;
	await recordProducerAwait(f.tx, 3 as TaskId, { sessionId: "producer", observedAt: 1, source: "producer await-state", execution: { state: "provider-retry", runId: 9, results: refs, model: { provider: "synthetic", modelId: "model" }, attempt: 18, maxAttempts: 21, nextRetryAt: 1791200000000, error: "429 Weekly/Monthly Limit Exhausted", errorTruncated: false } });
	const before = JSON.stringify(f.state);
	const fact = await readAwaitFact(f.tx, "consumer", conversation); assert.ok(fact);
	assert.equal(fact.producers.length, 1); assert.equal(fact.omittedProducers, 0); assert.ok(fact.omitted.results > 0);
	assert.equal(fact.results.length + fact.omitted.results, 16);
	assert.deepEqual(fact.producers[0].execution?.results, fact.results.map((item) => item.result));
	assert.match(awaitFactLines(fact)[0], /submission 10.*provider retry.*attempt 18\/21/u);
	assert.ok(Buffer.byteLength(JSON.stringify(fact)) <= 12000); assert.equal(Value.Check(AwaitFactSchema, fact), true);
	assert.equal(JSON.stringify(f.state), before, "the projection does not mutate native observations");
});

it("ranks the current retry ahead of stale parallel observations before the own-fact bound", async () => {
	const f = fixture(); const refs = f.results.map((result) => ({ ...result, sessionId: "producer" }));
	f.state.declarations[0].results = refs; f.state.declarations[0].cohort = [3, 4];
	f.state.declarations.push({ ...f.state.declarations[0], taskId: 4, callId: "parallel-await", results: refs.slice(0, 15), outcomes: [] });
	await recordProducerAwait(f.tx, 3 as TaskId, { sessionId: "producer", observedAt: 1, source: "producer await-state", execution: { state: "provider-retry", runId: 9, results: refs, attempt: 18, nextRetryAt: 1791200000000, error: "429 Weekly/Monthly Limit Exhausted", errorTruncated: false } });
	await recordProducerAwait(f.tx, 4 as TaskId, { sessionId: "producer", observedAt: 2, source: "producer await-state" });
	const fact = await readAwaitFact(f.tx, "consumer", conversation); assert.ok(fact);
	assert.deepEqual(fact.results[0].result, refs[15]); assert.deepEqual(fact.producers[0].execution?.results, [refs[15]]);
	assert.equal(fact.results.length + fact.omitted.results, 16); assert.ok(fact.omitted.results > 0);
	assert.equal(Value.Check(AwaitFactSchema, fact), true);
});

it("trims a retry producer's generic own-wait detail with accurate counts without mutating observations", async () => {
	const f = fixture(); const refs = f.results.map((result) => ({ ...result, sessionId: "producer", requestId: "x".repeat(350) }));
	f.state.declarations[0].results = refs;
	const awaiting: OwnAwaitFact = { runId: 9, heldInputs: [30], results: refs.map((result) => ({ result: { ...result, sessionId: "upstream" }, status: "pending" })), queuedInputCount: 0, queueSnapshot: "committed InboxDoc", omitted: { heldInputs: 0, results: 0 } };
	await recordProducerAwait(f.tx, 3 as TaskId, { sessionId: "producer", observedAt: 1, source: "producer await-state", awaiting, execution: { state: "provider-retry", runId: 9, results: refs, attempt: 18, nextRetryAt: 1791200000000, error: "429 Weekly/Monthly Limit Exhausted", errorTruncated: false } });
	const before = JSON.stringify(f.state); const fact = await readAwaitFact(f.tx, "consumer", conversation); assert.ok(fact);
	assert.equal(fact.producers.length, 1); assert.equal(fact.omittedProducers, 0); assert.ok(fact.producers[0].execution);
	const detail = fact.producers[0].awaiting; assert.ok(detail); assert.ok(detail.omitted.results > 0); assert.equal(detail.results.length + detail.omitted.results, 16);
	assert.equal(fact.results.length + fact.omitted.results, 16); assert.ok(Buffer.byteLength(JSON.stringify(fact)) <= 12000);
	assert.match(awaitFactLines(fact).join("\n"), new RegExp(`omitted ${detail.omitted.results} results, 0 held requests`, "u"));
	assert.equal(Value.Check(AwaitFactSchema, fact), true); assert.equal(JSON.stringify(f.state), before);
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

it("checks watched membership against full held inputs before their display bound", async () => {
	const f = fixture(); f.state.declarations[0].inputs = Array.from({ length: 17 }, (_, index) => index + 1);
	const fact = await readAwaitFact(f.tx, "consumer", conversation, 17 as SubmissionId); assert.ok(fact);
	assert.equal(fact.heldInputs.length, 16); assert.equal(fact.omitted.heldInputs, 1);
	assert.equal(await readAwaitFact(f.tx, "consumer", conversation, 99 as SubmissionId), undefined);
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
