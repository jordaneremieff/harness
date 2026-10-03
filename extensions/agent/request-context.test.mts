import assert from "node:assert/strict";
import { it, type TestContext } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { CompactionEntry, Harness, LiveDoc, MemoryStorage, UserEntry, createRegistry, defineExtension, type ConversationId, type SubmissionId, type TaskId, type Tx } from "@earendil-works/pi-durable";
import { answerMessage, completed, fixtureRegistry, fixtureRuntime, gateTool, toolCallMessage } from "./durable-host-fixture.mts";
import { AgentDeliveryDoc, recordDeliveryIntent, settleDeliveries } from "./durable-controls.ts";
import { createTestRuntime, testModel } from "./test-runtime.mts";
import { CheckInTask } from "./durable-checkins.ts";
import { cleanupRequestContexts, projectRequestContexts, readRequestContexts, recordRequestContext, requestContextSection, requestEnvelope, RequestContextDoc, REQUEST_CONTEXT_LIMIT, REQUEST_CONTEXT_PROJECTION_LIMIT, type RequestContext } from "./request-context.ts";

const route = (requestId = "task-a"): RequestContext => ({ requestId, requester: "requester-b", replyTo: "recipient-c", origin: "model" });
async function fixture(t: TestContext) {
	const harness = await Harness.open(new MemoryStorage(), { models: await fixtureRuntime("answer"), registry: fixtureRegistry() }, context);
	t.after(() => harness.close(context));
	const conversation = await harness.root(context, { agent: { model: { provider: testModel.provider, modelId: testModel.id } } });
	return { harness, conversation };
}
async function placed(tx: Tx, conversationId: ConversationId, request: RequestContext): Promise<SubmissionId> {
	const entry = await tx.appendEntry(UserEntry, conversationId, { model: [{ role: "user", content: requestEnvelope("Task", request), timestamp: 1 }] });
	return (await tx.createSubmission({ conversationId, requestId: request.requestId, type: "input", status: "placed", entry: entry.id })).id;
}

it("prepends host routing evidence and preserves task images", () => {
	const request = route();
	const image = { type: "image" as const, data: "aGVsbG8=", mimeType: "image/png" };
	const input = [{ type: "text" as const, text: "Task" }, image];
	const wrapped = requestEnvelope(input, request);
	assert.ok(Array.isArray(wrapped));
	assert.equal(wrapped[2], image);
	assert.deepEqual(wrapped.slice(1), input);
	assert.match(JSON.stringify(wrapped[0]), /requester-b.*recipient-c/u);
	assert.match(requestEnvelope("Task", request) as string, /Task content:\nTask$/u);
});

it("projects native run inputs, excludes queued arrivals, and prunes native terminal routes", async (t) => {
	const { harness, conversation } = await fixture(t);
	const a = route("a"), b = { ...route("b"), requester: "later-requester" };
	await harness.commit(async (tx) => {
		await recordRequestContext(tx, conversation.id, a);
		await recordRequestContext(tx, conversation.id, b);
		const id = await placed(tx, conversation.id, a);
		await tx.createSubmission({ conversationId: conversation.id, requestId: b.requestId, type: "input", status: "queued" });
		(await tx.doc(LiveDoc, conversation.id)).run = { taskId: 123 as TaskId, inputs: [id] };
	}, context);
	const projection = await harness.commit((tx) => projectRequestContexts(tx, conversation.id), context);
	assert.deepEqual(projection, { requests: [{ ...a, status: "placed" }], unknown: 0, omitted: 0 });
	assert.deepEqual((await readRequestContexts(harness, conversation.id, context)).map((request) => request.status), ["placed", "queued"]);
	await harness.commit(async (tx) => {
		const request = await tx.submissionByRequest(conversation.id, a.requestId);
		assert.ok(request);
		tx.settleSubmission(request.id, { status: "unanswered", reason: "aborted" });
		delete (await tx.doc(LiveDoc, conversation.id)).run;
	}, context);
	await harness.commit((tx) => cleanupRequestContexts(tx, conversation.id), context);
	assert.deepEqual(await readRequestContexts(harness, conversation.id, context), [{ ...b, status: "queued" }]);
});

it("keeps request routes independent of compaction and fork history", async (t) => {
	const { harness, conversation } = await fixture(t);
	const request = route();
	await harness.commit(async (tx) => {
		await recordRequestContext(tx, conversation.id, request);
		const submissionId = await placed(tx, conversation.id, request);
		(await tx.doc(LiveDoc, conversation.id)).run = { taskId: 123 as TaskId, inputs: [submissionId] };
	}, context);
	const head = await harness.commit(async (tx) => {
		const prior = await tx.appendEntry(UserEntry, conversation.id, { model: [{ role: "user", content: "newer retained context", timestamp: 2 }] });
		return tx.appendEntry(CompactionEntry, conversation.id, { head: prior.id, data: { reason: "manual" }, model: [{ role: "user", content: "Summary without requester evidence", timestamp: 3 }] });
	}, context);
	assert.deepEqual((await harness.commit((tx) => projectRequestContexts(tx, conversation.id), context)).requests, [{ ...request, status: "placed" }]);
	const fork = await conversation.fork(head.id, { ownership: { kind: "ownerless" } }, context);
	assert.deepEqual(await readRequestContexts(harness, fork.id, context), []);
});

it("refuses route changes and bounds retained admissions and prompt projection without silent loss", async (t) => {
	const { harness, conversation } = await fixture(t);
	await harness.commit((tx) => recordRequestContext(tx, conversation.id, route()), context);
	await assert.rejects(harness.commit((tx) => recordRequestContext(tx, conversation.id, { ...route(), replyTo: "other" }), context), /different request route/u);
	await harness.commit(async (tx) => {
		for (let index = 1; index < REQUEST_CONTEXT_LIMIT; index++) await recordRequestContext(tx, conversation.id, route(`r-${index}`));
		const ids: SubmissionId[] = [];
		for (let index = 1; index <= REQUEST_CONTEXT_PROJECTION_LIMIT + 1; index++) ids.push(await placed(tx, conversation.id, route(`r-${index}`)));
		(await tx.doc(LiveDoc, conversation.id)).run = { taskId: 123 as TaskId, inputs: [...ids, 99999 as SubmissionId] };
	}, context);
	await assert.rejects(harness.commit((tx) => recordRequestContext(tx, conversation.id, route("overflow")), context), /unfinished request routes/u);
	const projection = await harness.commit((tx) => projectRequestContexts(tx, conversation.id), context);
	assert.equal(projection.requests.length, REQUEST_CONTEXT_PROJECTION_LIMIT);
	assert.equal(projection.omitted, 1);
	assert.equal(projection.unknown, 1);
	assert.equal((await readRequestContexts(harness, conversation.id, context)).length, REQUEST_CONTEXT_LIMIT);
});

it("replaces stale prompt routes with an unavailable notice if native lookup fails", async (t) => {
	const { harness, conversation } = await fixture(t);
	const agent = await conversation.agent(context);
	t.mock.method(harness, "commit", async () => { throw new Error("Native read unavailable"); });
	const rendered = await requestContextSection(harness).render({ conversationId: conversation.id, agent, env: undefined, read: harness, shown: { "agent-request-context": "Stale requester" } }, context);
	assert.match(rendered ?? "", /routes are unavailable/u);
	assert.doesNotMatch(rendered ?? "", /Stale requester/u);
});

it("renders the first provider request before the delivery link exists and restores routes after native compaction", { timeout: 10000 }, async (t) => {
	const requests: string[] = [];
	const runtime = await createTestRuntime();
	let release!: () => void, started!: () => void;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	const began = new Promise<void>((resolve) => { started = resolve; });
	let call = 0;
	runtime.registerNativeProvider({
		id: testModel.provider, name: "Request context fixture", getModels: () => [testModel],
		auth: { apiKey: { name: "Test", check: async () => ({ type: "api_key" }), resolve: async () => ({ auth: {} }) } },
		stream: () => { throw new Error("Unexpected stream"); },
		streamSimple: (_model, input) => {
			requests.push(JSON.stringify(input));
			return completed(call++ === 0 ? toolCallMessage("gate") : answerMessage("Summary or final answer without routing text"));
		},
	});
	const registry = createRegistry();
	let harness!: Harness;
	registry.install(defineExtension({ name: "request-fixture", tools: [gateTool(gate, started)], tasks: [CheckInTask], sections: [requestContextSection(() => harness)] }));
	harness = await Harness.open(new MemoryStorage(), { models: runtime, registry, settings: { compaction: { keepRecentTokens: 1 } } }, context);
	t.after(() => harness.close(context));
	const conversation = await harness.root(context, { agent: { model: { provider: testModel.provider, modelId: testModel.id } } });
	const request = route();
	await harness.commit((tx) => recordDeliveryIntent(tx, conversation.id, { message: "Do work", requestId: request.requestId, ownerId: request.replyTo, origin: request.origin, requestContext: request, checkInMinutes: 1 }), context);
	harness.resume();
	await began;
	const submitted = await conversation.submit({ type: "input", content: requestEnvelope("Do work", request), requestId: request.requestId }, context);
	await began;
	assert.equal((await harness.snapshot(AgentDeliveryDoc, context))?.intents[0]?.submissionId, null, "the provider observes routes before linkDeliveryIntent");
	assert.match(requests[0], /agent-request-context/u);
	assert.match(requests[0], /requester-b/u);
	const compaction = await conversation.compact("Summarize without requester identifiers", context);
	const compacted = await harness.waitForTask(compaction, context);
	assert.equal(compacted.state.outcome.status, "completed");
	if (compacted.state.outcome.status === "completed") assert.ok(compacted.state.outcome.result.submissionId, "native compaction submits its summary");
	release();
	await submitted.wait(context);
	assert.ok(requests.length >= 3, "the provider handles generation, compaction, then continued generation");
	assert.match(requests.at(-1) ?? "", /agent-request-context.*requester-b/u, "the post-compaction provider request retains routing");
	assert.doesNotMatch(requests.at(-1) ?? "", /Do work/u, "the compacted input envelope is no longer in active context");
	await settleDeliveries(harness, context);
	assert.deepEqual((await harness.snapshot(RequestContextDoc, conversation.id, context))?.requests, []);
});
