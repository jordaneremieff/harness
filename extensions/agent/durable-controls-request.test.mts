import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it, type TestContext } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { AgentDoc, Harness, MemoryStorage, createRegistry, defineExtension, type CommitPublication, type SubmissionId } from "@earendil-works/pi-durable";
import { AgentDeliveryDoc, AgentMetaDoc, forkConversation, rewindConversation, readOutcome, recordDeliveryIntent, recordReport, reconcileDeliveries, richSubmitConversation, settleDeliveries, submitConversation, writeConversationName } from "./durable-controls.ts";
import { fixtureRegistry, fixtureRuntime } from "./durable-host-fixture.mts";
import { DurableHost } from "./durable-host.ts";
import { initializeProfile, ProfileDoc } from "./profile.ts";
import { readRequestContexts } from "./request-context.ts";
import { CheckInTask } from "./durable-checkins.ts";
import { scheduleTimer, TimerTask } from "./durable-timers.ts";
import { testModel } from "./test-runtime.mts";

async function fixture(t: TestContext, timers = false) {
	const registry = timers ? createRegistry() : fixtureRegistry();
	if (timers) registry.install(defineExtension({ name: "request-timers", tasks: [TimerTask, CheckInTask] }));
	const storageId = randomUUID();
	const harness = await Harness.open(new MemoryStorage(), { models: await fixtureRuntime("answer"), registry, now: () => 1000, conversationCreated: (tx, record) => initializeProfile(tx, record.id, storageId) }, context);
	t.after(() => harness.close(context));
	const conversation = await harness.root(context, { agent: { model: { provider: testModel.provider, modelId: testModel.id } }, init: async (tx, id) => {
		const meta = await tx.doc(AgentMetaDoc, id);
		meta.owner = "creator-a";
		meta.name = "Initial name";
		await initializeProfile(tx, id, storageId);
	} });
	return { harness, conversation };
}

it("routes later rich requests to their requester or explicit reply recipient without changing the creator", { timeout: 10000 }, async (t) => {
	const { harness, conversation } = await fixture(t);
	const first = await richSubmitConversation(conversation, { message: "First task", requestId: "first", requester: "requester-a", origin: "model" }, context);
	await readOutcome(harness, first.submissionId, context);
	const second = await richSubmitConversation(conversation, { message: "Second task", requestId: "second", requester: "requester-b", replyTo: "recipient-c", origin: "operator" }, context);
	await readOutcome(harness, second.submissionId, context);
	await settleDeliveries(harness, context);
	const state = await harness.snapshot(AgentDeliveryDoc, context);
	assert.equal(state?.receipts[String(first.submissionId)]?.ownerId, "requester-a");
	assert.equal(state?.receipts[String(second.submissionId)]?.ownerId, "recipient-c");
	assert.equal(state?.receipts[String(second.submissionId)]?.origin, "operator");
	assert.equal((await harness.snapshot(AgentMetaDoc, conversation.id, context))?.owner, "creator-a");
	assert.equal((await harness.snapshot(AgentMetaDoc, conversation.id, context))?.firstMessage, "First task");
	assert.deepEqual(await readRequestContexts(harness, conversation.id, context), []);
	const retry = await richSubmitConversation(conversation, { message: "Second task", requestId: "second", requester: "requester-b", replyTo: "recipient-c", origin: "operator" }, context);
	assert.equal(retry.submissionId, second.submissionId);
	assert.equal(retry.deduped, true);
	assert.deepEqual(await readRequestContexts(harness, conversation.id, context), []);
});

it("requires a rich host admission origin and preserves the caller operation ID", { timeout: 10000 }, async (t) => {
	const root = mkdtempSync(join(tmpdir(), "rich-host-request-"));
	let host: DurableHost | undefined;
	t.after(async () => { await host?.close(); rmSync(root, { recursive: true, force: true }); });
	host = await DurableHost.open({ storagePath: join(root, "agent.sqlite"), storageId: randomUUID(), cwd: root, models: await fixtureRuntime("answer"), registry: fixtureRegistry(), agent: { model: { provider: testModel.provider, modelId: testModel.id } } }, context);
	const params = { sessionId: host.storageId, message: "Task", requestId: "rich-host", requester: "requester-b", replyTo: "recipient-c", operationId: "caller-operation" };
	await assert.rejects(host.request("task-submit", params, context), /origin/iu);
	assert.equal((await host.harness.inspect(context)).submissions.length, 0, "missing origin refuses before native admission");
	const admitted = await host.request("task-submit", { ...params, origin: "operator" }, context) as { submissionId: SubmissionId };
	await readOutcome(host.harness, admitted.submissionId, context);
	await settleDeliveries(host.harness, context);
	const receipt = (await host.harness.snapshot(AgentDeliveryDoc, context))?.receipts[String(admitted.submissionId)];
	assert.equal(receipt?.operationId, "caller-operation");
	assert.equal(receipt?.ownerId, "recipient-c");
	assert.equal(receipt?.origin, "operator");
});

it("keeps plain native submissions usable without invented requester evidence", { timeout: 10000 }, async (t) => {
	const { harness, conversation } = await fixture(t);
	const submitted = await submitConversation(conversation, { message: "Plain task", requestId: "plain" }, context);
	assert.equal((await readOutcome(harness, submitted.submissionId, context)).status, "done");
	assert.deepEqual(await readRequestContexts(harness, conversation.id, context), []);
	assert.equal((await harness.snapshot(AgentDeliveryDoc, context))?.intents.length ?? 0, 0);
});

it("replays a rich delivery intent after an admission gap with its original requester and recipient", { timeout: 10000 }, async (t) => {
	const { harness, conversation } = await fixture(t);
	await harness.commit((tx) => recordDeliveryIntent(tx, conversation.id, { message: "Recovered task", requestId: "recover", ownerId: "recipient-c", origin: "model", requestContext: { requestId: "recover", requester: "requester-b", replyTo: "recipient-c", origin: "model" } }), context);
	assert.equal((await readRequestContexts(harness, conversation.id, context))[0]?.status, "admitting");
	await reconcileDeliveries(harness, context);
	const submission = await harness.commit((tx) => tx.submissionByRequest(conversation.id, "recover"), context);
	assert.ok(submission);
	await readOutcome(harness, submission.id, context);
	await settleDeliveries(harness, context);
	const state = await harness.snapshot(AgentDeliveryDoc, context);
	assert.match(String(state?.intents[0]?.message), /requester-b.*recipient-c/u);
	assert.equal(state?.receipts[String(submission.id)]?.ownerId, "recipient-c");
});

it("records explicit reports without an input, answer owner, or check-in task", async (t) => {
	const { harness } = await fixture(t, true);
	const before = await harness.inspect(context);
	const report = await recordReport(harness, { ownerId: "requester-b", senderIdentity: "worker", message: "Progress", requestId: "progress" }, context);
	assert.deepEqual(await recordReport(harness, { ownerId: "requester-b", senderIdentity: "worker", message: "Progress", requestId: "progress" }, context), report);
	const after = await harness.inspect(context);
	assert.equal(after.submissions.length, before.submissions.length);
	assert.equal(after.tasks.length, before.tasks.length);
	assert.equal((await harness.snapshot(AgentDeliveryDoc, context))?.reports.length, 1);
});

it("commits a display name and its managed instructions together", async (t) => {
	const { harness, conversation } = await fixture(t);
	const publications: CommitPublication[] = [];
	const unsubscribe = harness.subscribeCommits((publication) => publications.push(publication));
	t.after(unsubscribe);
	await writeConversationName(conversation, "New name", context);
	const changes = publications.filter((publication) => publication.changes.some((change) => change.type === "document" && change.record.kind === AgentMetaDoc.definition.kind));
	assert.equal(changes.length, 1);
	assert.ok(changes[0].changes.some((change) => change.type === "document" && change.record.kind === AgentDoc.definition.kind));
	assert.equal((await harness.snapshot(AgentMetaDoc, conversation.id, context))?.name, "New name");
	assert.match((await conversation.agent(context)).instructions ?? "", /New name/u);
	await writeConversationName(conversation, "", context);
	assert.doesNotMatch((await conversation.agent(context)).instructions ?? "", /New name/u);
	assert.notEqual((await harness.snapshot(ProfileDoc, conversation.id, context))?.identity, null);
});

it("refreshes fork and rewind instructions after their final name and owner metadata", { timeout: 10000 }, async (t) => {
	const { harness, conversation } = await fixture(t);
	const submitted = await submitConversation(conversation, { message: "Source task", requestId: "source" }, context);
	const outcome = await readOutcome(harness, submitted.submissionId, context);
	assert.ok(outcome.answerEntryId);
	const fork = await forkConversation(harness, conversation, outcome.answerEntryId, { name: "Fork name", owner: "fork-owner" }, context);
	const forkAgent = await fork.conversation.agent(context);
	assert.match(forkAgent.instructions ?? "", /Fork name/u);
	assert.match(forkAgent.instructions ?? "", /fork-owner/u);
	assert.doesNotMatch(forkAgent.instructions ?? "", /Initial name/u);
	const rewind = await rewindConversation(harness, conversation, { entryId: outcome.answerEntryId, correction: "Corrected task", name: "Rewind name", owner: "rewind-owner" }, context);
	await readOutcome(harness, rewind.submissionId, context);
	const rewindAgent = await rewind.conversation.agent(context);
	assert.match(rewindAgent.instructions ?? "", /Rewind name/u);
	assert.match(rewindAgent.instructions ?? "", /rewind-owner/u);
});

it("preserves scheduled requester metadata until native deadline admission", { timeout: 10000 }, async (t) => {
	const { harness, conversation } = await fixture(t, true);
	const request = { requestId: "scheduled", requester: "requester-b", replyTo: "recipient-c", origin: "model" as const };
	const timer = await scheduleTimer(harness, { conversationId: conversation.id, identity: "worker", message: "Later task", scheduleId: "schedule", deadline: 900, createdAt: 800, mode: "followUp", ownerId: request.replyTo, origin: request.origin, requestId: request.requestId, requestContext: request }, context);
	assert.deepEqual(await readRequestContexts(harness, conversation.id, context), []);
	const task = (await harness.inspect(context)).tasks.find((task) => Number(task.record.id) === timer.timerId);
	assert.ok(task);
	harness.resume();
	await harness.waitForTask(task.record.id, context);
	const submitted = await harness.commit((tx) => tx.submissionByRequest(conversation.id, request.requestId), context);
	assert.ok(submitted);
	await readOutcome(harness, submitted.id, context);
	await settleDeliveries(harness, context);
	const state = await harness.snapshot(AgentDeliveryDoc, context);
	assert.equal(state?.receipts[String(submitted.id)]?.ownerId, "recipient-c");
	assert.match(String(state?.intents[0]?.message), /requester-b.*recipient-c/u);
	assert.equal((String(state?.intents[0]?.message).match(/Host request context:/gu) ?? []).length, 1);
});
