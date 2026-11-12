import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { Harness, MemoryStorage, type Conversation, type ConversationId } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { reconcileDeliveries, recordDeliveryIntent, submitConversation } from "./durable-controls.ts";
import { deliveryState, migrateDeliveryStore, snapshotIntent } from "./delivery-store.ts";
import { RequestContextDoc } from "./request-context.ts";
import { answerMessage, fixtureProvider, fixtureModelId, fixtureRegistry, gateTool, scriptedRuntime, toolCallMessage } from "./durable-host-fixture.mts";

type Gate = { release: () => void; started: Promise<void> };
function gate(): Gate & { promise: Promise<void>; entered: () => void } {
	let release = () => {}, entered = () => {};
	const promise = new Promise<void>((resolve) => { release = resolve; });
	const started = new Promise<void>((resolve) => { entered = resolve; });
	return { release: () => release(), started, promise, entered: () => entered() };
}

async function busyRoot(harness: Harness): Promise<Conversation> {
	await migrateDeliveryStore(harness, context);
	const root = await harness.root(context, { agent: { model: { provider: fixtureProvider, modelId: fixtureModelId } } });
	return root;
}

async function submissions(harness: Harness, conversationId: ConversationId, requestId: string) {
	return harness.commit((tx) => tx.submissionByRequest(conversationId, requestId), context);
}

async function checkIns(harness: Harness): Promise<number> {
	return (await harness.inspect(context)).tasks.filter((task) => task.record.kind === "agent.check-in").length;
}

for (const owned of [true, false]) {
	it(`leaves nothing executable after a definite ${owned ? "owned" : "unowned"} busy rejection`, { timeout: 30000 }, async (t) => {
		const directory = mkdtempSync(join(tmpdir(), "admission-rejection-"));
		const path = join(directory, "storage.sqlite");
		const held = gate();
		let harness = await Harness.open(await openNodeSqliteStorage(path), { models: await scriptedRuntime([toolCallMessage("gate"), answerMessage("first answer"), answerMessage("unexpected")]), registry: fixtureRegistry([gateTool(held.promise, held.entered)]) }, context);
		t.after(async () => { held.release(); await harness.close(context).catch(() => undefined); rmSync(directory, { recursive: true, force: true }); });
		const root = await busyRoot(harness);
		await submitConversation(root, { message: "first", requestId: "first", ownerId: "owner", origin: "model" }, context);
		await held.started;
		const requestId = "rejected";
		const request = { requestId, requester: "requester", replyTo: "owner", origin: "model" as const };
		const params = owned
			? { message: "must never run", requestId, ownerId: "owner", origin: "model" as const, whenBusy: "reject" as const, checkInMinutes: 1, requestContext: request }
			: { message: "must never run", requestId, origin: "model" as const, whenBusy: "reject" as const, requestContext: request };
		await assert.rejects(submitConversation(root, params, context), /busy/iu);
		assert.equal(await submissions(harness, root.id, requestId), undefined);
		assert.equal(await snapshotIntent(harness, root.id, requestId, context), undefined);
		assert.equal((await harness.snapshot(RequestContextDoc, root.id, context))?.requests.some((item) => item.requestId === requestId) ?? false, false);
		assert.equal(await checkIns(harness), 0);
		held.release();
		await root.waitForIdle(context);
		await reconcileDeliveries(harness, context);
		assert.equal(await submissions(harness, root.id, requestId), undefined);
		await harness.close(context);
		harness = await Harness.open(await openNodeSqliteStorage(path), { models: await scriptedRuntime([answerMessage("unexpected")]), registry: fixtureRegistry([gateTool(Promise.resolve())]) }, context);
		await reconcileDeliveries(harness, context);
		assert.equal(await submissions(harness, root.id, requestId), undefined);
	});
}

it("admits an owned input with its linked intent in one commit, so a replay finds one admission", { timeout: 30000 }, async (t) => {
	const harness = await Harness.open(new MemoryStorage(), { models: await scriptedRuntime([answerMessage("answer")]), registry: fixtureRegistry() }, context);
	t.after(() => harness.close(context));
	const root = await busyRoot(harness);
	const params = { message: "work", requestId: "uncertain", ownerId: "owner", origin: "model" as const, whenBusy: "reject" as const };
	const first = await submitConversation(root, params, context);
	const intent = await snapshotIntent(harness, root.id, "uncertain", context);
	assert.equal(intent?.submissionId, first.submissionId);
	// A caller that lost the answer replays the same request ID.
	const replay = await submitConversation(root, params, context);
	assert.equal(replay.submissionId, first.submissionId);
	assert.equal(replay.deduped, true);
	await reconcileDeliveries(harness, context);
	assert.equal((await submissions(harness, root.id, "uncertain"))?.id, first.submissionId);
});

it("never replays a retained unlinked busy-reject intent; other unlinked intents are recovered once", { timeout: 30000 }, async (t) => {
	const harness = await Harness.open(new MemoryStorage(), { models: await scriptedRuntime([answerMessage("recovered")]), registry: fixtureRegistry() }, context);
	t.after(() => harness.close(context));
	const root = await busyRoot(harness);
	await root.commit(async (tx) => {
		await recordDeliveryIntent(tx, root.id, { requestId: "legacy-reject", ownerId: "owner", origin: "model", message: "refused earlier", whenBusy: "reject", checkInMinutes: 0 });
		await recordDeliveryIntent(tx, root.id, { requestId: "legacy-follow", ownerId: "owner", origin: "model", message: "interrupted earlier", whenBusy: "followUp", checkInMinutes: 0 });
	}, context);
	await reconcileDeliveries(harness, context);
	await reconcileDeliveries(harness, context);
	assert.equal(await submissions(harness, root.id, "legacy-reject"), undefined);
	const retained = (await deliveryState(harness, context)).intents.find((intent) => intent.requestId === "legacy-reject");
	assert.equal(retained?.delivery?.state, "terminal");
	const recovered = await submissions(harness, root.id, "legacy-follow");
	assert.ok(recovered !== undefined);
	assert.equal((await snapshotIntent(harness, root.id, "legacy-follow", context))?.submissionId, recovered.id);
});
