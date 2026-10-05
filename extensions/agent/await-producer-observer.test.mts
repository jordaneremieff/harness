import assert from "node:assert/strict";
import { it } from "node:test";
import { BACKGROUND_CONTEXT, withCancel } from "@earendil-works/chord/context";
import { observeProducerAwait } from "./await-producer-observer.ts";
import type { OwnAwaitFact, ProducerAwaitFact } from "./await-facts.ts";

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((yes) => { resolve = yes; }); return { promise, resolve }; }
const waiting: OwnAwaitFact = { runId: 1, heldInputs: [2], results: [{ result: { sessionId: "consumer", submissionId: 3 }, status: "pending" }], queuedInputCount: 0, queueSnapshot: "committed InboxDoc", omitted: { heldInputs: 0, results: 0 } };

it("subscribes before reading and refreshes only its producer's own bounded wait", { timeout: 1000 }, async () => {
	const owned = withCancel(BACKGROUND_CONTEXT); const first = deferred<void>(); const next = deferred<void>();
	const facts: ProducerAwaitFact[] = []; let subscribed = false; let stopped = 0; let changed!: () => void; let current: OwnAwaitFact | undefined = waiting;
	const job = observeProducerAwait("producer", async () => { assert.equal(subscribed, true); return { awaiting: current }; }, async (listener) => { subscribed = true; changed = listener; return () => { stopped++; }; }, async (fact) => { facts.push(fact); if (fact.awaiting === undefined) next.resolve(); else first.resolve(); }, owned.context);
	await first.promise; current = undefined; changed(); await next.promise; owned.cancel(); await job;
	assert.equal(stopped, 1); assert.equal(facts[0].sessionId, "producer"); assert.deepEqual(facts[0].awaiting, waiting); assert.equal(facts.at(-1)?.awaiting, undefined);
	assert.equal("producers" in (facts[0].awaiting ?? {}), false);
});

it("records bounded source unavailability without a dependency outcome", { timeout: 1000 }, async () => {
	const owned = withCancel(BACKGROUND_CONTEXT); const seen = deferred<ProducerAwaitFact>(); let stopped = 0;
	const job = observeProducerAwait("producer", async () => { throw Error("x".repeat(2000)); }, async () => () => { stopped++; }, async (fact) => { seen.resolve(fact); }, owned.context);
	const fact = await seen.promise; owned.cancel(); await job;
	assert.equal(fact.unavailable?.length, 512); assert.equal(fact.awaiting, undefined); assert.equal(stopped, 1);
});

it("ends on permanent connection close and removes both subscriptions", { timeout: 1000 }, async () => {
	const seen = deferred<void>(); const facts: ProducerAwaitFact[] = []; let close!: () => void; let changesStopped = 0; let closeStopped = 0;
	const job = observeProducerAwait("producer", async () => ({ awaiting: waiting }), async () => () => { changesStopped++; }, async (fact) => { facts.push(fact); seen.resolve(); }, BACKGROUND_CONTEXT, (listener) => { close = listener; return () => { closeStopped++; }; });
	await seen.promise; close(); await job;
	assert.equal(facts.at(-1)?.unavailable, "Producer host connection closed"); assert.equal(changesStopped, 1); assert.equal(closeStopped, 1);
});

it("releases a subscription that finishes setup after cancellation", { timeout: 1000 }, async () => {
	const owned = withCancel(BACKGROUND_CONTEXT); const setup = deferred<() => void>(); let stopped = 0; let reads = 0;
	const job = observeProducerAwait("producer", async () => { reads++; return {}; }, async () => setup.promise, async () => {}, owned.context);
	owned.cancel(); setup.resolve(() => { stopped++; }); await job;
	assert.equal(stopped, 1); assert.equal(reads, 0);
});

it("cleans up when a publisher rejects", { timeout: 1000 }, async () => {
	let stopped = 0;
	await assert.rejects(observeProducerAwait("producer", async () => ({}), async () => () => { stopped++; }, async () => { throw Error("commit failed"); }, BACKGROUND_CONTEXT), /commit failed/u);
	assert.equal(stopped, 1);
});
