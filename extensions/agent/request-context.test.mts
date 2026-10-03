import assert from "node:assert/strict";
import { it, type TestContext } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { CompactionEntry, Harness, LiveDoc, MemoryStorage, UserEntry, createRegistry, defineExtension, type ConversationId, type SubmissionId, type TaskId, type Tx } from "@earendil-works/pi-durable";
import { answerMessage, completed, fixtureRegistry, fixtureRuntime, gateTool, toolCallMessage } from "./durable-host-fixture.mts";
import { AgentDeliveryDoc, recordDeliveryIntent, settleDeliveries } from "./durable-controls.ts";
import { createTestRuntime, testModel } from "./test-runtime.mts";
import { CheckInTask } from "./durable-checkins.ts";
import { cleanupRequestContexts, projectRequestContexts, readRequestContexts, readRequestContextPage, recordRequestContext, requestContextSection, validateRequestContext, RequestContextDoc, REQUEST_CONTEXT_LIMIT, REQUEST_CONTEXT_PROJECTION_LIMIT, type RequestContext } from "./request-context.ts";

const route = (requestId = "task-a"): RequestContext => ({ requestId, requester: "requester-b", replyTo: "recipient-c", origin: "model" });
async function fixture(t: TestContext) {
	const harness = await Harness.open(new MemoryStorage(), { models: await fixtureRuntime("answer"), registry: fixtureRegistry() }, context);
	t.after(() => harness.close(context));
	const conversation = await harness.root(context, { agent: { model: { provider: testModel.provider, modelId: testModel.id } } });
	return { harness, conversation };
}
async function placed(tx: Tx, conversationId: ConversationId, request: RequestContext, text = "Task"): Promise<SubmissionId> {
	const entry = await tx.appendEntry(UserEntry, conversationId, { model: [{ role: "user", content: text, timestamp: 1 }] });
	return (await tx.createSubmission({ conversationId, requestId: request.requestId, type: "input", status: "placed", entry: entry.id })).id;
}

it("validates structured routes without parsing task text", () => {
	assert.doesNotThrow(() => validateRequestContext(route()));
	assert.throws(() => validateRequestContext({ ...route(), requester: "" }), /requester/u);
	assert.throws(() => validateRequestContext({ ...route(), replyTo: "bad\nroute" }), /replyTo/u);
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

it("derives default routes for already placed base submissions but not settled inputs", async (t) => {
	const { harness, conversation } = await fixture(t);
	const request = { requestId: "base-retained", requester: "old-owner", replyTo: "old-owner", origin: "operator" as const };
	const id = await harness.commit(async (tx) => {
		const submissionId = await placed(tx, conversation.id, request);
		(await tx.doc(AgentDeliveryDoc)).intents.push({ requestId: request.requestId, ownerId: request.replyTo, origin: request.origin, conversationId: conversation.id, message: "Task", whenBusy: null, operationId: null, submissionId });
		return submissionId;
	}, context);
	assert.deepEqual(await readRequestContexts(harness, conversation.id, context), [{ ...request, status: "placed" }]);
	assert.deepEqual((await harness.snapshot(RequestContextDoc, conversation.id, context))?.requests, []);
	await harness.commit((tx) => tx.settleSubmission(id, { status: "unanswered", reason: "aborted" }), context);
	await harness.commit((tx) => cleanupRequestContexts(tx, conversation.id), context);
	assert.deepEqual(await readRequestContexts(harness, conversation.id, context), []);
});

it("associates each prompt route with its bounded original task in native input order", async (t) => {
	const { harness, conversation } = await fixture(t);
	const a = route("a"), b = { ...route("b"), requester: "requester-d" };
	await harness.commit(async (tx) => {
		await recordRequestContext(tx, conversation.id, a);
		await recordRequestContext(tx, conversation.id, b);
		const first = await placed(tx, conversation.id, a, "First task");
		const second = await placed(tx, conversation.id, b, "😀".repeat(513));
		(await tx.doc(LiveDoc, conversation.id)).run = { taskId: 123 as TaskId, inputs: [second, first] };
	}, context);
	const rendered = await requestContextSection(harness).render({ conversationId: conversation.id, agent: await conversation.agent(context), env: undefined, read: harness, shown: {} }, context);
	assert.ok(rendered);
	const lines = rendered.split("\n").slice(1).map((line) => JSON.parse(line));
	assert.deepEqual(lines.map((line) => line.requestId), ["b", "a"]);
	assert.equal(lines[0].requester, "requester-d");
	assert.deepEqual(lines[0].task, { preview: "😀".repeat(512), truncated: true });
	assert.deepEqual(lines[1].task, { preview: "First task", truncated: false });
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

it("refuses route changes and bounds new admissions and prompt projection without silent loss", async (t) => {
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

it("derives oversized base queues without route writes and projects active inputs beyond the profile page", async (t) => {
	const { harness, conversation } = await fixture(t);
	const count = REQUEST_CONTEXT_LIMIT + 1;
	await harness.commit(async (tx) => {
		const delivery = await tx.doc(AgentDeliveryDoc);
		for (let index = 0; index < count; index++) {
			const request = { requestId: `base-${index}`, requester: "owner", replyTo: "owner", origin: "operator" as const };
			const submissionId = await placed(tx, conversation.id, request);
			delivery.intents.push({ requestId: request.requestId, conversationId: conversation.id, ownerId: request.requester, origin: request.origin, message: "Retained", whenBusy: "followUp", operationId: null, submissionId });
			if (index === count - 1) (await tx.doc(LiveDoc, conversation.id)).run = { taskId: 123 as TaskId, inputs: [submissionId] };
		}
	}, context);
	const page = await readRequestContextPage(harness, conversation.id, context);
	assert.equal(page.requests.length, REQUEST_CONTEXT_LIMIT);
	assert.equal(page.omitted, 1);
	assert.deepEqual((await harness.snapshot(RequestContextDoc, conversation.id, context))?.requests, [], "base evidence is not materialized into admission-limited metadata");
	assert.equal((await harness.snapshot(AgentDeliveryDoc, context))?.intents.length, count);
	const projection = await harness.commit((tx) => projectRequestContexts(tx, conversation.id), context);
	assert.deepEqual(projection, { requests: [{ requestId: `base-${count - 1}`, requester: "owner", replyTo: "owner", origin: "operator", status: "placed" }], omitted: 0, unknown: 0 });
});

it("omits oversized retained route fields from projections without changing native evidence", async (t) => {
	const { harness, conversation } = await fixture(t);
	const request = { requestId: "r".repeat(1025), requester: "owner", replyTo: "owner", origin: "operator" as const };
	await harness.commit(async (tx) => {
		const delivery = await tx.doc(AgentDeliveryDoc);
		const live = await tx.doc(LiveDoc, conversation.id);
		const submissionId = await placed(tx, conversation.id, request);
		delivery.intents.push({ requestId: request.requestId, conversationId: conversation.id, ownerId: request.requester, origin: request.origin, message: "Retained", whenBusy: "followUp", operationId: null, submissionId });
		live.run = { taskId: 123 as TaskId, inputs: [submissionId] };
	}, context);
	assert.deepEqual(await readRequestContextPage(harness, conversation.id, context), { requests: [], omitted: 1 });
	assert.deepEqual(await harness.commit((tx) => projectRequestContexts(tx, conversation.id), context), { requests: [], omitted: 1, unknown: 0 });
	const rendered = await requestContextSection(harness).render({ conversationId: conversation.id, agent: await conversation.agent(context), env: undefined, read: harness, shown: {} }, context);
	assert.match(rendered ?? "", /1 further routes omitted/u);
	assert.doesNotMatch(rendered ?? "", /rrrrr/u);
	assert.equal((await harness.snapshot(AgentDeliveryDoc, context))?.intents[0]?.requestId, request.requestId);
	assert.equal((await readRequestContexts(harness, conversation.id, context))[0]?.requestId, request.requestId);
});

it("preserves accepted task and native submission routes beyond the new-admission bound", async (t) => {
	const { harness, conversation } = await fixture(t);
	await harness.commit(async (tx) => {
		for (let index = 0; index < REQUEST_CONTEXT_LIMIT; index++) await recordRequestContext(tx, conversation.id, route(`existing-${index}`));
	}, context);
	await assert.rejects(harness.commit((tx) => recordRequestContext(tx, conversation.id, route("not-accepted")), context), /unfinished request routes/u);
	await harness.commit(async (tx) => {
		await recordRequestContext(tx, conversation.id, route("accepted-task"), "retained");
		await placed(tx, conversation.id, route("accepted-input"));
	}, context);
	await harness.commit((tx) => recordRequestContext(tx, conversation.id, route("accepted-input")), context);
	const routes = await readRequestContexts(harness, conversation.id, context);
	assert.equal(routes.length, REQUEST_CONTEXT_LIMIT + 2);
	assert.equal(routes.at(-2)?.requestId, "accepted-task");
	assert.equal(routes.at(-1)?.requestId, "accepted-input");
	assert.equal((await readRequestContextPage(harness, conversation.id, context)).omitted, 2);
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
	const submitted = await conversation.submit({ type: "input", content: "Do work", requestId: request.requestId }, context);
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
	const finalRequest = requests.at(-1);
	assert.ok(finalRequest);
	const final = JSON.parse(finalRequest);
	assert.ok(!final.messages.some((message: { role: string; content: unknown }) => message.role === "user" && JSON.stringify(message.content).includes("Do work")), "compaction removes the original user input");
	assert.match(requests.at(-1) ?? "", /preview.*Do work/u, "the route retains a bounded association with its original task");
	await settleDeliveries(harness, context);
	assert.deepEqual((await harness.snapshot(RequestContextDoc, conversation.id, context))?.requests, []);
});
