import assert from "node:assert/strict";
import { it, type TestContext } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { AgentMetaDoc, readOutcome, recordDeliveryIntent, richSubmitConversation, settleDeliveries, submitConversation } from "./durable-controls.ts";
import { deliveryState } from "./delivery-store.ts";
import { readRequestContexts, RequestContextDoc } from "./request-context.ts";
import { answerMessage, fixtureModelId, fixtureProvider, fixtureRegistry, fixtureRuntime, gateTool, scriptedRuntime, toolCallMessage } from "./durable-host-fixture.mts";

function signal() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => { resolve = done; });
	return { promise, resolve };
}

async function fixture(t: TestContext, held = false) {
	const gate = signal(), entered = signal();
	const models = held ? await scriptedRuntime([toolCallMessage("gate"), answerMessage("Original answer")]) : await fixtureRuntime("answer");
	const harness = await Harness.open(new MemoryStorage(), { models, registry: fixtureRegistry(held ? [gateTool(gate.promise, entered.resolve)] : []) }, context);
	t.after(async () => { gate.resolve(); await harness.close(context); });
	const conversation = await harness.root(context, { agent: { model: { provider: fixtureProvider, modelId: fixtureModelId } }, init: async (tx, id) => {
		(await tx.doc(AgentMetaDoc, id)).owner = "creating-owner";
	} });
	let admissions = 0;
	conversation.submit = new Proxy(conversation.submit, { apply(target, receiver, args) { admissions++; return Reflect.apply(target, receiver, args); } });
	return { harness, conversation, gate, entered, admissions: () => admissions };
}

const original = { message: "Original task", requestId: "exact-request", requester: "original-requester", replyTo: "original-recipient", origin: "model" as const };

it("returns the settled original input, recipient and deduplication fact without a new route or native admission", { timeout: 10000 }, async (t) => {
	const { harness, conversation, admissions } = await fixture(t);
	const first = await richSubmitConversation(conversation, original, context);
	const outcome = await readOutcome(harness, first.submissionId, context);
	await conversation.waitForIdle(context);
	await settleDeliveries(harness, context);
	assert.deepEqual(await readRequestContexts(harness, conversation.id, context), []);
	const before = await harness.inspect(context);
	const retained = await deliveryState(harness, context, true);
	const replay = await richSubmitConversation(conversation, { ...original, message: "Different replay text" }, context);
	assert.deepEqual(replay, { submissionId: first.submissionId, conversationId: conversation.id, deduped: true, recipient: original.replyTo, placement: "placed" });
	assert.equal(admissions(), 1, "settled replay never calls the native submit surface");
	assert.deepEqual(await readOutcome(harness, replay.submissionId, context), outcome);
	assert.deepEqual((await harness.inspect(context)).submissions, before.submissions);
	assert.deepEqual(await deliveryState(harness, context, true), retained);
	assert.deepEqual((await harness.snapshot(RequestContextDoc, conversation.id, context))?.requests, []);
});

it("refuses a changed retained recipient before native admission after settlement", { timeout: 10000 }, async (t) => {
	const { harness, conversation, admissions } = await fixture(t);
	const first = await richSubmitConversation(conversation, original, context);
	await readOutcome(harness, first.submissionId, context);
	await conversation.waitForIdle(context);
	assert.deepEqual(await readRequestContexts(harness, conversation.id, context), []);
	const before = await harness.inspect(context);
	await assert.rejects(richSubmitConversation(conversation, { ...original, replyTo: "another-recipient" }, context), /another delivery recipient or origin/u);
	assert.equal(admissions(), 1);
	assert.deepEqual((await harness.inspect(context)).submissions, before.submissions);
	assert.deepEqual((await harness.snapshot(RequestContextDoc, conversation.id, context))?.requests, []);
	assert.equal((await deliveryState(harness, context, true)).intents[0]?.ownerId, original.replyTo);
});

for (const admitted of [false, true]) it(`refuses a changed known requester while its route remains unfinished with admitted=${admitted}`, { timeout: 10000 }, async (t) => {
	const { harness, conversation, gate, entered, admissions } = await fixture(t, true);
	if (admitted) {
		await richSubmitConversation(conversation, original, context);
		await entered.promise;
	} else {
		await harness.commit((tx) => recordDeliveryIntent(tx, conversation.id, { message: original.message, requestId: original.requestId, ownerId: original.replyTo, origin: original.origin, requestContext: original }), context);
	}
	const before = await harness.inspect(context);
	const routes = await readRequestContexts(harness, conversation.id, context);
	assert.equal(routes[0]?.requester, original.requester);
	await assert.rejects(richSubmitConversation(conversation, { ...original, requester: "different-requester" }, context), /different request route/u);
	assert.equal(admissions(), admitted ? 1 : 0);
	assert.deepEqual((await harness.inspect(context)).submissions, before.submissions);
	assert.deepEqual(await readRequestContexts(harness, conversation.id, context), routes);
	gate.resolve();
});

it("leaves an absent historical requester unknown instead of substituting the creating owner", { timeout: 10000 }, async (t) => {
	const { harness, conversation, admissions } = await fixture(t);
	const first = await submitConversation(conversation, { message: original.message, requestId: original.requestId, ownerId: original.replyTo, origin: original.origin }, context);
	const outcome = await readOutcome(harness, first.submissionId, context);
	await conversation.waitForIdle(context);
	const entryId = outcome.entryId;
	assert.ok(entryId);
	const input = (await conversation.entries({}, 20, undefined, context)).items.find((entry) => entry.id === entryId);
	assert.deepEqual(input?.data, { author: { role: "agent" }, class: "followUp", requestId: original.requestId });
	assert.deepEqual(await readRequestContexts(harness, conversation.id, context), []);
	const replay = await richSubmitConversation(conversation, { ...original, requester: "replay-requester" }, context);
	assert.equal(replay.submissionId, first.submissionId);
	assert.equal(replay.deduped, true);
	assert.equal(replay.recipient, original.replyTo);
	assert.equal(admissions(), 1);
	assert.deepEqual((await conversation.entries({}, 20, undefined, context)).items.find((entry) => entry.id === entryId), input);
	assert.deepEqual(await readRequestContexts(harness, conversation.id, context), []);
	assert.equal((await harness.snapshot(AgentMetaDoc, conversation.id, context))?.owner, "creating-owner");
});
