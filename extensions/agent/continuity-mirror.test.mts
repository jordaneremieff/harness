import assert from "node:assert/strict";
import { it, type TestContext } from "node:test";
import { BACKGROUND_CONTEXT as context, withAbortSignal } from "@earendil-works/chord/context";
import { Harness, MemoryStorage, type ConversationId } from "@earendil-works/pi-durable";
import { fixtureRegistry, fixtureRuntime } from "./durable-host-fixture.mts";
import { ContinuityDoc, recordContinuityDelivered, recordContinuityFact } from "./continuity-native.ts";
import { onStoredCommit } from "./commit-observation.ts";
import { ContinuityMirror } from "./continuity-mirror.ts";
import { OpenWorkDoc, type OpenWorkItem } from "./open-work.ts";

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

function openItem(requestId: string, submissionId: number, results: OpenWorkItem["results"] = []): OpenWorkItem {
	return { requestId, submissionId, requester: "owner", replyTo: "owner", origin: "model", results, note: "state note that stays out of the continuity note", declaredAt: 1, updatedAt: 1 };
}
function declare(harness: Harness, conversationId: ConversationId, ...items: OpenWorkItem[]): Promise<void> {
	return harness.commit(async (tx) => { (await tx.doc(OpenWorkDoc, conversationId)).items.push(...items); }, context);
}

it("reads declared open work once for a head, retains it, and keeps the note through later changes and a reload", async (t) => {
	const { harness, conversation } = await fixture(t);
	const mirror = new ContinuityMirror(harness, "owner");
	t.after(() => mirror.close());
	await mirror.initialize(context);
	await declare(harness, conversation.id, openItem("request-a", 41, [{ sessionId: "worker:2", submissionId: 7, requestId: "task-a" }]), { ...openItem("request-closed", 42), close: { status: "done", at: 2, message: "finished", reportRequestId: "final:1" } });
	const head = await harness.commit((tx) => tx.appendEntry(conversation.id, { kind: "pi.reset", head: "self" }), context);
	assert.match(mirror.current(conversation.id)?.text ?? "", /Declared open work of this session: not read for this context head/u, "before the read the note names the missing read");

	// An item declared between the head and its first request is open at that request.
	await declare(harness, conversation.id, openItem("request-b", 43));
	await mirror.prepare(conversation.id, context);
	const frozen = mirror.current(conversation.id);
	assert.ok(frozen);
	assert.match(frozen.text, /first request after this context head; each item owes one final report to its replyTo: \n\{"requestId":"request-a","replyTo":"owner","dependsOn":\[\{"sessionId":"worker:2","submissionId":7,"requestId":"task-a"\}\]\}\n\{"requestId":"request-b","replyTo":"owner","dependsOn":\[\]\}\nAn arrived result closes no item/u);
	assert.doesNotMatch(frozen.text, /request-closed|state note that stays out/u);
	assert.deepEqual((await harness.snapshot(ContinuityDoc, conversation.id, context))?.work, { headId: head.id, items: [
		{ requestId: "request-a", replyTo: "owner", results: [{ sessionId: "worker:2", submissionId: 7, requestId: "task-a" }] },
		{ requestId: "request-b", replyTo: "owner", results: [] },
	] });

	// Later open-work changes and later continuity facts never change the note of this head.
	await harness.commit(async (tx) => {
		const state = await tx.doc(OpenWorkDoc, conversation.id);
		state.items[0].close = { status: "done", at: 3, message: "finished", reportRequestId: "final:2" };
		state.items.push(openItem("request-c", 44));
	}, context);
	await harness.commit((tx) => recordContinuityFact(tx, conversation.id, { phase: "admitted", sessionId: "worker:2", requestId: "later", replyTo: "owner", submissionId: 8 }), context);
	const commits: number[] = [];
	const stop = onStoredCommit(harness, (publication) => { commits.push(publication.changes.length); });
	await mirror.prepare(conversation.id, context);
	stop();
	assert.deepEqual(commits, [], "a settled head needs no further storage access");
	assert.deepEqual(mirror.current(conversation.id), frozen);
	assert.equal((await harness.snapshot(ContinuityDoc, conversation.id, context))?.work?.headId, head.id, "a fact write keeps the retained read");

	mirror.close();
	const reopened = new ContinuityMirror(harness, "owner");
	t.after(() => reopened.close());
	await reopened.initialize(context);
	await reopened.prepare(conversation.id, context);
	assert.deepEqual(reopened.current(conversation.id), frozen, "a new process states the retained items, not the current ones");

	const second = await harness.commit((tx) => tx.appendEntry(conversation.id, { kind: "pi.reset", head: "self" }), context);
	await reopened.prepare(conversation.id, context);
	const next = reopened.current(conversation.id);
	assert.equal(next?.head.id, second.id);
	assert.match(next?.text ?? "", /replyTo: \n\{"requestId":"request-b","replyTo":"owner","dependsOn":\[\]\}\n\{"requestId":"request-c","replyTo":"owner","dependsOn":\[\]\}\nAn arrived result/u, "a new head reads the open items of its own first request");
});

it("states a failed open-work read in the note of that head and does not repeat the read", async (t) => {
	const { harness, conversation } = await fixture(t);
	const mirror = new ContinuityMirror(harness, "owner");
	t.after(() => mirror.close());
	await mirror.initialize(context);
	await declare(harness, conversation.id, { ...openItem("request-a", 41), replyTo: "not a valid identity" });
	await harness.commit((tx) => tx.appendEntry(conversation.id, { kind: "pi.reset", head: "self" }), context);
	await mirror.prepare(conversation.id, context);
	const unread = mirror.current(conversation.id);
	assert.match(unread?.text ?? "", /Declared open work of this session: not read for this context head\. Read it with agent_status\(\{"sessionId":"owner"\}\)\.$/u);
	assert.equal((await harness.snapshot(ContinuityDoc, conversation.id, context))?.work, undefined, "a refused read retains nothing");
	await harness.commit(async (tx) => { (await tx.doc(OpenWorkDoc, conversation.id)).items[0].replyTo = "owner"; }, context);
	await mirror.prepare(conversation.id, context);
	assert.deepEqual(mirror.current(conversation.id), unread, "the note of the head stays as first sent");

	const aborted = new AbortController();
	aborted.abort();
	await harness.commit((tx) => tx.appendEntry(conversation.id, { kind: "pi.reset", head: "self" }), context);
	await assert.rejects(mirror.prepare(conversation.id, withAbortSignal(aborted.signal, context)));
	await mirror.prepare(conversation.id, context);
	assert.match(mirror.current(conversation.id)?.text ?? "", /\{"requestId":"request-a","replyTo":"owner","dependsOn":\[\]\}/u, "a cancelled read is not a failed read");
});
