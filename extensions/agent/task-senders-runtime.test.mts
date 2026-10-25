import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it, type TestContext } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import * as Durable from "@earendil-works/pi-durable";
import { Value } from "typebox/value";
import { DurableHost } from "./durable-host.ts";
import { createAgentContribution } from "./durable-agents.ts";
import { AgentMetaDoc, readOutcome } from "./durable-controls.ts";
import { answerMessage, completed, fixtureModelId, fixtureProvider, fixtureRegistry, fixtureRuntime, pending, toolCallMessage } from "./durable-host-fixture.mts";
import { CommunicationIndexDoc, communicationIndexKey, reconcileInputCommunications } from "./communication-retention.ts";
import { captureCommunicationReader } from "./communication-observation.ts";
import { readConversationSnapshotPage, readDashboard, readInspection } from "./durable-observation.ts";
import { InspectOutputSchema } from "./observation-schema.ts";
import type { ConversationFrame } from "./live-frames.ts";
import { TASK_SENDER_ENTRY_KIND } from "./task-senders.ts";
import { AwaitDoc, AWAIT_PROVENANCE_LIMIT, recordInputProvenance } from "./awaited-results.ts";
import { createTestRuntime, testModel } from "./test-runtime.mts";

const context = BACKGROUND_CONTEXT;
const ROOT = Durable.ROOT_CONVERSATION_ID;
async function fixture(t: TestContext, models?: Awaited<ReturnType<typeof fixtureRuntime>>) {
	const root = mkdtempSync(join(tmpdir(), "task-senders-"));
	const storageId = randomUUID();
	const host = await DurableHost.open({ storagePath: join(root, "storage.sqlite"), storageId, cwd: root, models: models ?? await fixtureRuntime("answer"), registry: fixtureRegistry(), agent: { model: { provider: fixtureProvider, modelId: fixtureModelId } }, resume: true, now: () => 17 });
	t.after(async () => { await host.close(); rmSync(root, { recursive: true, force: true }); });
	return { host, root, storageId };
}
async function task(host: DurableHost, requester: string, requestId = "task", replyTo = requester) {
	const admitted = await host.request("task-submit", { requestId, message: "Original task bytes", requester, replyTo, origin: "model", checkInMinutes: 0 }) as { submissionId: number };
	const outcome = await readOutcome(host.harness, admitted.submissionId as Durable.SubmissionId, context);
	assert.ok(outcome.entryId);
	await reconcileInputCommunications(host.harness, host.storageId, context);
	return { admitted, entryId: outcome.entryId };
}
it("publishes task requester hints outside entries and communication while preserving native bytes", async (t) => {
	const { host, storageId } = await fixture(t);
	await host.harness.commit(async (tx) => { (await tx.doc(AgentMetaDoc, ROOT)).name = "Checked sender"; }, context);
	const { entryId } = await task(host, storageId, "named-task", "00000000-0000-4000-8000-000000000099");
	await host.harness.commit(async (tx) => { (await tx.doc(AgentMetaDoc, ROOT)).name = "Later name"; }, context);
	await task(host, storageId, "named-task", "00000000-0000-4000-8000-000000000099");
	const page = await readConversationSnapshotPage(host.harness, ROOT, {}, context, storageId);
	assert.deepEqual(page.taskSenders, { [entryId]: { identity: storageId, name: "Checked sender" } });
	const row = page.entries.find((entry) => entry.id === String(entryId));
	assert.deepEqual(row?.communication, { state: "unresolved" });
	assert.equal(row?.model?.[0]?.content, "Original task bytes");
	assert.equal(page.entries.some((entry) => entry.kind === TASK_SENDER_ENTRY_KIND), false);
	const conversation = await host.harness.conversation(ROOT, context);
	assert.ok(conversation);
	const history = await readInspection(host.harness, storageId, conversation, { view: "history" }, context) as { entries: { kind: string }[] };
	assert.equal(Value.Check(InspectOutputSchema, history), true);
	assert.equal(history.entries.some((entry) => entry.kind === TASK_SENDER_ENTRY_KIND), false);
	assert.equal("taskSenders" in history, false);
	const opened = await host.request("observe-open", { token: "senders", scope: "conversation" }) as { frame: ConversationFrame };
	assert.deepEqual(opened.frame.taskSenders, page.taskSenders);
	await host.request("observe-close", { token: "senders" });
	const before = await readConversationSnapshotPage(host.harness, ROOT, { before: entryId }, context, storageId);
	assert.equal(before.taskSenders, undefined);
});
it("keeps foreign names absent and refuses sender backfill for an existing plain input", async (t) => {
	const { host, storageId } = await fixture(t);
	const foreign = "00000000-0000-4000-8000-000000000002";
	const known = await task(host, foreign, "foreign-task");
	const plain = await host.request("submit", { requestId: "plain-task", message: "Plain task", provenance: { classification: "explicit", sender: foreign } }) as { submissionId: number };
	const outcome = await readOutcome(host.harness, plain.submissionId as Durable.SubmissionId, context);
	await task(host, foreign, "plain-task");
	const conversation = await host.harness.conversation(ROOT, context);
	assert.ok(conversation);
	const uncaptured = await conversation.submit({ type: "input", requestId: "uncaptured-task", content: "Admission without owner capture" }, context);
	const uncapturedOutcome = await readOutcome(host.harness, uncaptured.id, context);
	await task(host, foreign, "uncaptured-task");
	const page = await readConversationSnapshotPage(host.harness, ROOT, {}, context, storageId);
	assert.deepEqual(page.taskSenders?.[String(known.entryId)], { identity: foreign });
	assert.equal(page.taskSenders?.[String(outcome.entryId)], undefined);
	assert.equal(page.taskSenders?.[String(uncapturedOutcome.entryId)], undefined);
});
it("checks sender record visibility at the captured tail and across a fork", async (t) => {
	const { host, storageId } = await fixture(t);
	const { entryId } = await task(host, storageId);
	const index = await host.harness.snapshot(CommunicationIndexDoc, communicationIndexKey(storageId, ROOT, String(entryId)), context);
	assert.ok(index?.taskSenderEntryId);
	const early = await host.request("fork", { requestId: "early", entryId }) as { conversationId: Durable.ConversationId };
	assert.equal((await readConversationSnapshotPage(host.harness, early.conversationId, {}, context, storageId)).taskSenders, undefined);
	const late = await host.request("fork", { requestId: "late", entryId: Number(index.taskSenderEntryId) }) as { conversationId: Durable.ConversationId };
	assert.deepEqual((await readConversationSnapshotPage(host.harness, late.conversationId, {}, context, storageId)).taskSenders?.[String(entryId)], { identity: storageId });
	const conversation = await host.harness.conversation(ROOT, context);
	assert.ok(conversation);
	const originalEntries = conversation.entries.bind(conversation);
	let capture = true;
	t.mock.method(conversation, "entries", async (...args: Parameters<typeof originalEntries>) => {
		if (capture) { capture = false; return originalEntries({ minEntryId: entryId, maxEntryId: entryId }, 1, undefined, context); }
		return originalEntries(...args);
	});
	const reader = await captureCommunicationReader(host.harness, storageId, conversation, context);
	const visible = (await originalEntries({ minEntryId: entryId, maxEntryId: entryId }, 1, undefined, context)).items;
	assert.equal(await reader.taskSenders(visible), undefined);
});
it("rejects an index whose native submission does not identify the original input", async (t) => {
	const { host, storageId } = await fixture(t);
	const first = await task(host, storageId, "first");
	const second = await task(host, storageId, "second");
	await host.harness.commit(async (tx) => {
		const index = await tx.doc(CommunicationIndexDoc, communicationIndexKey(storageId, ROOT, String(first.entryId)), null);
		assert.ok(index.target);
		index.target = { ...index.target, submissionId: second.admitted.submissionId };
	}, context);
	const page = await readConversationSnapshotPage(host.harness, ROOT, {}, context, storageId);
	assert.equal(page.taskSenders?.[String(first.entryId)], undefined);
	assert.deepEqual(page.taskSenders?.[String(second.entryId)], { identity: storageId });
});
it("retains queued requester capture through placement and input-provenance eviction", { timeout: 15_000 }, async (t) => {
	const models = await createTestRuntime();
	const answer = answerMessage();
	const held = pending(answer);
	let first = true;
	let start!: () => void;
	const started = new Promise<void>((resolve) => { start = resolve; });
	const stream = () => { if (first) { first = false; start(); return held; } return completed(answerMessage()); };
	models.registerNativeProvider({ id: fixtureProvider, name: "Queued sender fixture", getModels: () => [testModel], auth: { apiKey: { name: "Test", check: async () => ({ type: "api_key" }), resolve: async () => ({ auth: {} }) } }, stream, streamSimple: stream });
	const { host, storageId } = await fixture(t, models);
	const initial = await host.request("submit", { requestId: "held", message: "Hold first input" }) as { submissionId: number };
	await started;
	const queued = await host.request("task-submit", { requestId: "queued-sender", message: "Queued task", requester: storageId, origin: "model", whenBusy: "followUp", checkInMinutes: 0 }) as { submissionId: number };
	const submission = await host.harness.submission(queued.submissionId as Durable.SubmissionId, context);
	assert.equal((await submission?.status(context))?.status, "queued");
	held.push({ type: "done", reason: "stop", message: answer }); held.end(answer);
	await readOutcome(host.harness, initial.submissionId as Durable.SubmissionId, context);
	const outcome = await readOutcome(host.harness, queued.submissionId as Durable.SubmissionId, context);
	assert.ok(outcome.entryId);
	await host.harness.commit(async (tx) => {
		const state = await tx.doc(AwaitDoc);
		for (let index = state.provenance.length; index < AWAIT_PROVENANCE_LIMIT; index++) state.provenance.push({ conversationId: ROOT, requestId: `absent-${index}`, classification: "explicit" });
		await recordInputProvenance(tx, { conversationId: ROOT, requestId: "evict-terminal", classification: "explicit" });
	}, context);
	const page = await readConversationSnapshotPage(host.harness, ROOT, {}, context, storageId);
	assert.deepEqual(page.taskSenders?.[String(outcome.entryId)], { identity: storageId });
});
it("keeps settled dashboard state and timing independent of later sender bookkeeping", async (t) => {
	const { host, storageId } = await fixture(t);
	const submitted = await host.request("submit", { requestId: "summary-tail", message: "A completed turn" }) as { submissionId: number };
	await readOutcome(host.harness, submitted.submissionId as Durable.SubmissionId, context);
	const baseline = (await readDashboard(host.harness, storageId, { conversationId: ROOT }, { live: true }, context))[0];
	assert.ok(baseline);
	assert.equal(baseline.state, "done");
	assert.equal(typeof baseline.durationMs, "number");
	for (const kind of ["agent.communication", TASK_SENDER_ENTRY_KIND]) {
		await host.harness.commit(async (tx) => { await tx.appendEntry(ROOT, { kind, data: { fixture: true } }); }, context);
		const current = (await readDashboard(host.harness, storageId, { conversationId: ROOT }, { live: true }, context))[0];
		assert.equal(current?.state, baseline.state);
		assert.equal(current?.durationMs, baseline.durationMs);
		assert.equal(current?.modifiedAt, baseline.modifiedAt);
		assert.equal(current?.latestReply, baseline.latestReply);
	}
});
it("captures the same-storage requester for a native local send", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "local-task-senders-"));
	const storageId = randomUUID();
	const models = await createTestRuntime();
	let target = "", dispatched = false;
	const stream = () => {
		if (!dispatched) { dispatched = true; return completed(toolCallMessage("agent_send", { sessionId: target, message: "Local task bytes", checkInMinutes: 0 })); }
		return completed(answerMessage());
	};
	models.registerNativeProvider({ id: fixtureProvider, name: "Local sender fixture", getModels: () => [testModel], auth: { apiKey: { name: "Test", check: async () => ({ type: "api_key" }), resolve: async () => ({ auth: {} }) } }, stream, streamSimple: stream });
	const registry = fixtureRegistry();
	registry.install(createAgentContribution({ source: import.meta.filename, configureSettings: () => {}, dispatch: async () => { throw new Error("Unexpected foreign dispatch"); } }).create({ durable: Durable, storageId, cwd: root, agentDir: root, onClose() {}, services: { modelRuntime: { getModel: () => testModel, getModels: () => [testModel] } } }));
	const host = await DurableHost.open({ storagePath: join(root, "storage.sqlite"), storageId, cwd: root, models, registry, agent: { model: { provider: fixtureProvider, modelId: fixtureModelId } }, resume: true });
	t.after(async () => { await host.close(); rmSync(root, { recursive: true, force: true }); });
	const child = await host.harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: { provider: fixtureProvider, modelId: fixtureModelId } } }, context);
	target = `${storageId}:${child.id}`;
	await host.harness.commit(async (tx) => { (await tx.doc(AgentMetaDoc, ROOT)).name = "Local sender"; }, context);
	const admitted = await host.request("submit", { requestId: "dispatch-local", message: "Dispatch local task" }) as { submissionId: number };
	await readOutcome(host.harness, admitted.submissionId as Durable.SubmissionId, context);
	await reconcileInputCommunications(host.harness, storageId, context);
	const page = await readConversationSnapshotPage(host.harness, child.id, {}, context, storageId);
	const input = page.entries.find((entry) => entry.kind === "agent.input");
	assert.ok(input);
	assert.deepEqual(input.data, { author: { role: "agent", identity: storageId } });
	assert.deepEqual(page.taskSenders?.[input.id], { identity: storageId, name: "Local sender" });
	assert.deepEqual(input.communication, { state: "unresolved" });
});
