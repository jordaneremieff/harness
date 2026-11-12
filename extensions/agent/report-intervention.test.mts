import assert from "node:assert/strict";
import { it } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { Harness, LiveDoc, MemoryStorage } from "@earendil-works/pi-durable";
import { recordReport, submitConversation } from "./durable-controls.ts";
import { interventionMatches, parseReportIntervention } from "./report-intervention.ts";
import { answerMessage, fixtureModelId, fixtureProvider, fixtureRegistry, gateTool, scriptedRuntime, toolCallMessage } from "./durable-host-fixture.mts";
const storageId = "10000000-0000-4000-8000-000000000001";
const recipient = "20000000-0000-4000-8000-000000000002";

it("matches exact intervention inputs, not other work from the same sender", () => {
	const result = { sessionId: storageId, submissionId: 4, requestId: "work" };
	const intervention = parseReportIntervention({ producerRunId: 3, producerResults: [result] });
	assert.equal(interventionMatches(intervention, [result]), true);
	assert.equal(interventionMatches(intervention, [{ ...result, submissionId: 2 }]), false);
	assert.equal(interventionMatches(intervention, [{ ...result, requestId: "other" }]), false);
	assert.throws(() => parseReportIntervention({ ...intervention, producerResults: [result, { ...result, requestId: "other" }] }), /repeats/);
	assert.throws(() => parseReportIntervention({ ...intervention, extra: true }), /exact native/);
});

it("retains one validated report and replays it after its producer run ends", { timeout: 15000 }, async (t) => {
	let entered!: () => void, release!: () => void;
	const started = new Promise<void>((resolve) => { entered = resolve; });
	const gate = new Promise<void>((resolve) => { release = resolve; });
	const harness = await Harness.open(new MemoryStorage(), { models: await scriptedRuntime([toolCallMessage("gate"), answerMessage("finished")]), registry: fixtureRegistry([gateTool(gate, entered)]) }, context);
	t.after(async () => { release(); await harness.close(context); });
	const root = await harness.root(context, { agent: { model: { provider: fixtureProvider, modelId: fixtureModelId } } });
	const admission = await submitConversation(root, { message: "work", requestId: "work", ownerId: recipient, origin: "model", requestContext: { requestId: "work", requester: storageId, replyTo: recipient, origin: "model" } }, context);
	await started;
	const live = await harness.snapshot(LiveDoc, root.id, context);
	assert.ok(live?.run);
	const intervention = { producerRunId: live.run.taskId, producerResults: [{ sessionId: storageId, submissionId: admission.submissionId, requestId: "work" }] };
	const params = { storageId, ownerId: recipient, senderIdentity: storageId, requestId: "warning", message: "observed capacity", intervention };
	await assert.rejects(recordReport(harness, { ...params, passive: true }, context), /remain active/);
	await assert.rejects(recordReport(harness, { ...params, ownerId: storageId }, context), /another run, recipient or input/);
	const recorded = await recordReport(harness, params, context);
	assert.deepEqual(recorded.intervention, intervention);
	release();
	await harness.waitForIdle(context);
	assert.deepEqual(await recordReport(harness, params, context), recorded);
	await assert.rejects(recordReport(harness, { ...params, intervention: { ...intervention, producerRunId: intervention.producerRunId + 1 } }, context), /another intervention association/);
});
