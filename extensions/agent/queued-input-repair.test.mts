import assert from "node:assert/strict";
import { it } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { Harness, MemoryStorage, type Conversation } from "@earendil-works/pi-durable";
import { linkDeliveryIntent, readOutcome, recordDeliveryIntent, submitConversation } from "./durable-controls.ts";
import { migrateDeliveryStore } from "./delivery-store.ts";
import { inputEntry } from "./input-entry.ts";
import { readUnplacedSummary, UnplacedInputsDoc } from "./unplaced-inputs.ts";
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
