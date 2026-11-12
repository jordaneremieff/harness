import assert from "node:assert/strict";
import { it, type TestContext } from "node:test";
import { BACKGROUND_CONTEXT as context, withAbortSignal } from "@earendil-works/chord/context";
import { Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { fixtureRegistry, fixtureRuntime } from "./durable-host-fixture.mts";
import { ContinuityDoc, recordContinuityDelivered, recordContinuityFact } from "./continuity-native.ts";
import { ContinuityMirror } from "./continuity-mirror.ts";

async function fixture(t: TestContext) {
	const harness = await Harness.open(new MemoryStorage(), { models: await fixtureRuntime("answer"), registry: fixtureRegistry() }, context);
	t.after(() => harness.close(context));
	const conversation = await harness.root(context);
	return { harness, conversation };
}

it("observes stored heads before commit waiters and freezes facts across later delivery and reload", async (t) => {
	const { harness, conversation } = await fixture(t);
	const mirror = new ContinuityMirror(harness, "owner");
	t.after(() => mirror.close());
	await mirror.initialize(context);
	assert.equal(mirror.current(conversation.id), undefined);
	await harness.commit((tx) => recordContinuityFact(tx, conversation.id, { phase: "admitted", sessionId: "worker:2", requestId: "a", replyTo: "owner", submissionId: 1 }), context);
	const head = await harness.commit((tx) => tx.appendEntry(conversation.id, { kind: "pi.reset", head: "self" }), context);
	const frozen = mirror.current(conversation.id);
	assert.ok(frozen);
	assert.equal(frozen.head.id, head.id);
	assert.match(frozen.text, /"submissionId":1/u);
	await harness.commit((tx) => recordContinuityDelivered(tx, conversation.id, [{ sessionId: "worker:2", requestId: "a", submissionId: 1 }]), context);
	assert.deepEqual(mirror.current(conversation.id), frozen);
	mirror.close();
	const reopened = new ContinuityMirror(harness, "owner");
	t.after(() => reopened.close());
	await reopened.initialize(context);
	assert.deepEqual(reopened.current(conversation.id), frozen);
	const second = await harness.commit((tx) => tx.appendEntry(conversation.id, { kind: "pi.reset", head: "self" }), context);
	assert.equal(reopened.current(conversation.id)?.head.id, second.id);
	assert.doesNotMatch(reopened.current(conversation.id)?.text ?? "", /"submissionId":1/u);
});

it("does not advance the mirror for a rolled-back head", async (t) => {
	const { harness, conversation } = await fixture(t);
	const mirror = new ContinuityMirror(harness, "owner");
	t.after(() => mirror.close());
	await mirror.initialize(context);
	await assert.rejects(harness.commit(async (tx) => { await tx.appendEntry(conversation.id, { kind: "pi.reset", head: "self" }); throw new Error("rolled back"); }, context), /rolled back/u);
	assert.equal(mirror.current(conversation.id), undefined);
});

it("rejects malformed retained facts during startup instead of scheduling with invented facts", async (t) => {
	const { harness, conversation } = await fixture(t);
	await harness.commit(async (tx) => { (await tx.doc(ContinuityDoc, conversation.id)).events.push({ phase: "requested", sessionId: "worker", requestId: "bad", replyTo: "owner", afterHead: -1 }); }, context);
	const mirror = new ContinuityMirror(harness, "owner");
	t.after(() => mirror.close());
	await assert.rejects(mirror.initialize(context), /Invalid continuity head/u);
});

it("honours parent cancellation of the one startup-load deadline", async (t) => {
	const { harness } = await fixture(t);
	const mirror = new ContinuityMirror(harness, "owner");
	t.after(() => mirror.close());
	await assert.rejects(mirror.initialize(withAbortSignal(AbortSignal.abort(new Error("cancelled")), context)));
});
