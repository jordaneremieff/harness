import assert from "node:assert/strict";
import { it } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { Harness, MemoryStorage, type Conversation } from "@earendil-works/pi-durable";
import { linkDeliveryIntent, readOutcome, reconcileDeliveries, recordDeliveryIntent, submitConversation } from "./durable-controls.ts";
import { migrateDeliveryStore } from "./delivery-store.ts";
import { inputEntry } from "./input-entry.ts";
import { readUnplacedSummary, repairQueuedInputs, UnplacedInputsDoc } from "./unplaced-inputs.ts";
import { answerMessage, fixtureProvider, fixtureModelId, fixtureRegistry, gateTool, scriptedRuntime, toolCallMessage } from "./durable-host-fixture.mts";

async function busyHarness(t: { after(fn: () => unknown): void }): Promise<{ harness: Harness; root: Conversation; release: () => void }> {
	let release = () => {}, entered = () => {};
	const gate = new Promise<void>((resolve) => { release = resolve; });
	const started = new Promise<void>((resolve) => { entered = resolve; });
	const harness = await Harness.open(new MemoryStorage(), { models: await scriptedRuntime([toolCallMessage("gate"), answerMessage("first"), answerMessage("queued")]), registry: fixtureRegistry([gateTool(gate, entered)]) }, context);
	t.after(async () => { release(); await harness.close(context); });
	await migrateDeliveryStore(harness, context);
	const root = await harness.root(context, { agent: { model: { provider: fixtureProvider, modelId: fixtureModelId } } });
	await submitConversation(root, { message: "first", requestId: "first", ownerId: "owner", origin: "model" }, context);
	await started;
	return { harness, root, release };
}

/** Native admission and intent link without unplaced bookkeeping: the state an interruption after the link leaves. */
async function linkedWithoutRow(root: Conversation, requestId: string): Promise<number> {
	const submission = await root.submit({ type: "input", content: "correction", requestId, whenBusy: "steer", entry: inputEntry("model", "sender-session", { class: "steer", sender: "sender-session", requestId }) }, context);
	await root.commit(async (tx) => {
		await recordDeliveryIntent(tx, root.id, { requestId, ownerId: "owner", origin: "model", message: "correction", whenBusy: "steer", checkInMinutes: 0 });
		await linkDeliveryIntent(tx, root.id, requestId, submission.id);
	}, context);
	return submission.id;
}

async function watchIsLive(harness: Harness, root: Conversation): Promise<boolean> {
	const watch = (await harness.snapshot(UnplacedInputsDoc, root.id, context))?.watch;
	return watch !== undefined && (await harness.inspect(context)).tasks.some((task) => task.record.id === watch);
}

it("keeps a queued input in unplaced status when its admission commit stores it", { timeout: 30000 }, async (t) => {
	const { harness, root, release } = await busyHarness(t);
	const admitted = await submitConversation(root, { message: "steer now", requestId: "steer", ownerId: "owner", origin: "model", whenBusy: "steer", inputSender: "sender-session" }, context);
	assert.equal(admitted.placement, "unplaced");
	const row = (await harness.snapshot(UnplacedInputsDoc, root.id, context))?.inputs.find((input) => input.submissionId === admitted.submissionId);
	assert.deepEqual([row?.class, row?.sender], ["steer", "sender-session"]);
	assert.equal(await watchIsLive(harness, root), true);
	release();
	await readOutcome(harness, admitted.submissionId, context);
	assert.equal((await readUnplacedSummary(harness, root.id, context)).unplaced, 0);
});

it("repairs a linked admission without its unplaced row on exact-request replay, without a second input", { timeout: 30000 }, async (t) => {
	const { harness, root } = await busyHarness(t);
	const submissionId = await linkedWithoutRow(root, "gap");
	assert.equal((await readUnplacedSummary(harness, root.id, context)).unplaced, 0);
	const replay = await submitConversation(root, { message: "correction", requestId: "gap", ownerId: "owner", origin: "model", whenBusy: "steer" }, context);
	assert.equal(replay.submissionId, submissionId);
	assert.equal(replay.deduped, true);
	const rows = (await harness.snapshot(UnplacedInputsDoc, root.id, context))?.inputs ?? [];
	assert.deepEqual(rows.map((input) => [input.submissionId, input.class, input.sender, input.requestId]), [[submissionId, "steer", "sender-session", "gap"]]);
	assert.equal((await readUnplacedSummary(harness, root.id, context)).unplaced, 1);
	assert.equal(await watchIsLive(harness, root), true);
});

it("repairs queued inputs without rows on reopening, keeping the native entry's class and sender", { timeout: 30000 }, async (t) => {
	const { harness, root } = await busyHarness(t);
	const submissionId = await linkedWithoutRow(root, "gap");
	const at = Date.now();
	await repairQueuedInputs(harness, context, () => at, async () => "storage-identity");
	await repairQueuedInputs(harness, context, () => at + 1000, async () => "storage-identity");
	const state = await harness.snapshot(UnplacedInputsDoc, root.id, context);
	assert.equal(state?.recipient, "storage-identity");
	assert.deepEqual(state?.inputs.map((input) => [input.submissionId, input.class, input.sender, input.admittedAt]), [[submissionId, "steer", "sender-session", at]]);
	assert.equal(await watchIsLive(harness, root), true);
});

it("restores an operator input's sender from its retained request route on reopening", { timeout: 30000 }, async (t) => {
	const { harness, root } = await busyHarness(t);
	const requestId = "operator-gap";
	const request = { requestId, requester: "operator-requester", replyTo: "operator-recipient", origin: "operator" as const };
	// An operator input stores no label in its native entry.
	const submission = await root.submit({ type: "input", content: "operator correction", requestId, whenBusy: "steer", entry: inputEntry("operator", request.requester, { class: "operator", sender: request.requester, requestId }) }, context);
	await root.commit(async (tx) => {
		await recordDeliveryIntent(tx, root.id, { requestId, ownerId: request.replyTo, origin: request.origin, message: "operator correction", whenBusy: "steer", requestContext: request, checkInMinutes: 0 });
		await linkDeliveryIntent(tx, root.id, requestId, submission.id);
	}, context);
	await repairQueuedInputs(harness, context, () => Date.now(), async () => "storage-identity");
	const row = (await harness.snapshot(UnplacedInputsDoc, root.id, context))?.inputs.find((input) => input.submissionId === submission.id);
	assert.deepEqual([row?.class, row?.sender], ["operator", request.requester]);
});

it("keeps the class and sender of an already queued native input when reconciliation links its intent", { timeout: 30000 }, async (t) => {
	const { harness, root } = await busyHarness(t);
	const requestId = "result-gap";
	const request = { requestId, requester: "requester", replyTo: "recipient", origin: "model" as const };
	// An interruption after the native admission and before the intent link leaves an unlinked intent and a queued input.
	await root.commit((tx) => recordDeliveryIntent(tx, root.id, { requestId, ownerId: request.replyTo, origin: request.origin, message: "result", whenBusy: "followUp", requestContext: request, checkInMinutes: 0 }), context);
	const submission = await root.submit({ type: "input", content: "result", requestId, whenBusy: "steer", entry: inputEntry("model", "producer", { class: "result", sender: "producer", requestId }) }, context);
	await reconcileDeliveries(harness, context, () => Date.now());
	await repairQueuedInputs(harness, context, () => Date.now(), async () => "storage-identity");
	const row = (await harness.snapshot(UnplacedInputsDoc, root.id, context))?.inputs.find((input) => input.submissionId === submission.id);
	assert.deepEqual([row?.class, row?.sender], ["result", "producer"]);
});
