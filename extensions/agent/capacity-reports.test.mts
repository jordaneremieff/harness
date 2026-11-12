import assert from "node:assert/strict";
import { it, type TestContext } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { AssistantMessage, Model, Models } from "@earendil-works/pi-ai";
import { createRegistry, defineExtension, defineTool, GenerationTask, Harness, hook, LiveDoc, MemoryStorage, type CompactionResult, type Conversation, type ConversationId, type EntryRecord, type LiveRun, type TaskId, type ToolRegistration } from "@earendil-works/pi-durable";
import { obj } from "@earendil-works/pi-schema";
import { CHILD_CAPACITY_REPORT_PERCENT, childCapacityRequestId, childContinuityFact, ChildCapacityReports, continuityLines, PLANNING_BUDGET_NOTICE_KIND, runIdentity } from "./capacity-reports.ts";
import { planningBudgetBody, planningBudgetSelfBody, planningBudgetSelfId, planningBudgetSourceId } from "./continuity-budget.ts";
import { answerMessage, completed, fixtureRegistry } from "./durable-host-fixture.mts";
import { readOutcome, submitConversation, undeliveredReports, type DeliveryReport } from "./durable-controls.ts";
import { createTestRuntime, testModel } from "./test-runtime.mts";

const storageId = "11111111-1111-4111-8111-111111111111";
const ownerA = "22222222-2222-4222-8222-222222222222";
const ownerB = "33333333-3333-4333-8333-333333333333";
const operatorReply = "44444444-4444-4444-8444-444444444444";
const requester = "55555555-5555-4555-8555-555555555555";

const provider = "capacity-test";
function windowModel(id: string, contextWindow: number): Model<"openai-completions"> {
	return { ...testModel, provider, id, name: id, contextWindow };
}
const small = windowModel("window-128k", 128_000);
const mid = windowModel("window-500k", 500_000);
const large = windowModel("window-1m", 1_000_000);
const plain = windowModel("window-1m-no-budget", 1_000_000);
const budgets: Record<string, number> = { [`${provider}/${mid.id}`]: 250_000, [`${provider}/${large.id}`]: 300_000 };
const budgetOf = (providerId: string, modelId: string): number | undefined => budgets[`${providerId}/${modelId}`];

function usage(tokens: number): AssistantMessage["usage"] {
	return { input: tokens - 7, output: 7, cacheRead: 0, cacheWrite: 0, totalTokens: tokens, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
}
function answer(model: Model<"openai-completions">, tokens: number, text = "finished"): AssistantMessage {
	return { ...answerMessage(text), provider, model: model.id, usage: usage(tokens) };
}
let callIds = 0;
function gateCall(model: Model<"openai-completions">, tokens: number): AssistantMessage {
	callIds += 1;
	return { role: "assistant", content: [{ type: "toolCall", id: `gate-call-${callIds}`, name: "gate", arguments: {} }], api: "openai-completions", provider, model: model.id, usage: usage(tokens), stopReason: "toolUse", timestamp: Date.now() };
}

type Scripted = { models: Models; requests: () => number };
async function scripted(responses: readonly AssistantMessage[]): Promise<Scripted> {
	const runtime = await createTestRuntime();
	const queue = [...responses];
	let requests = 0;
	const stream = () => {
		requests += 1;
		const next = queue.shift();
		if (next === undefined) throw new Error("the capacity test provider has no response left");
		return completed(next);
	};
	runtime.registerNativeProvider({
		id: provider,
		name: "Capacity test provider",
		getModels: () => [small, mid, large, plain],
		auth: { apiKey: { name: "Test", check: async () => ({ type: "api_key" }), resolve: async () => ({ auth: {} }) } },
		stream,
		streamSimple: stream,
	});
	return { models: runtime, requests: () => requests };
}

type Step = { entered: Promise<void>; enter: () => void; released: Promise<void>; release: () => void };
function newStep(): Step {
	let enter = () => {};
	let release = () => {};
	const entered = new Promise<void>((resolve) => { enter = resolve; });
	const released = new Promise<void>((resolve) => { release = resolve; });
	return { entered, enter, released, release };
}
/** Each call of the tool is one step: the test sees it start and decides when it returns. */
function stepGate(): { tool: ToolRegistration; entered(index: number): Promise<void>; release(index: number): void; open(): void } {
	const steps: Step[] = [];
	const step = (index: number): Step => {
		while (steps.length <= index) steps.push(newStep());
		return steps[index];
	};
	let calls = 0;
	let open = false;
	const tool = defineTool({
		name: "gate",
		description: "Wait for the test to release this call.",
		parameters: obj({}, { open: true }),
		execute: async (_args, _api, call) => {
			const current = step(calls);
			calls += 1;
			current.enter();
			if (open) return {};
			await new Promise<void>((resolve) => {
				current.released.then(() => resolve());
				if (call.abortSignal?.aborted) resolve();
				else call.abortSignal?.addEventListener("abort", () => resolve(), { once: true });
			});
			return {};
		},
	});
	return { tool, entered: (index) => step(index).entered, release: (index) => step(index).release(), open: () => { open = true; for (const item of steps) item.release(); } };
}

type Fixture = { harness: Harness; root: Conversation; gate: ReturnType<typeof stepGate>; provider: Scripted; errors: unknown[]; reports: ChildCapacityReports; observer(): ChildCapacityReports };
type FixtureOptions = { observe?: boolean; compaction?: boolean; onYield?: () => Promise<{ continue: string } | undefined> };
async function fixture(t: TestContext, model: Model<"openai-completions">, responses: readonly AssistantMessage[], options: FixtureOptions = {}): Promise<Fixture> {
	const gate = stepGate();
	const scriptedProvider = await scripted(responses);
	const registry = createRegistry();
	const onYield = options.onYield;
	registry.install(defineExtension({ name: "capacity-test", tools: [gate.tool], ...(onYield === undefined ? {} : { hooks: [hook(GenerationTask, { onYield: () => onYield() })] }) }));
	const harness = await Harness.open(new MemoryStorage(), {
		models: scriptedProvider.models,
		registry,
		settings: { retry: { enabled: false }, steeringMode: "all", compaction: options.compaction ? { keepRecentTokens: 1 } : { enabled: false } },
	}, context);
	const errors: unknown[] = [];
	const observers: ChildCapacityReports[] = [];
	const observer = () => {
		const created = new ChildCapacityReports(harness, storageId, () => scriptedProvider.models, budgetOf, (error) => errors.push(error), () => 1_700_000_000_000);
		observers.push(created);
		return created;
	};
	t.after(async () => {
		gate.open();
		for (const item of observers) await item.close();
		await harness.close(context);
	});
	const root = await harness.root(context, { agent: { model: { provider, modelId: model.id } } });
	const result: Fixture = { harness, root, gate, provider: scriptedProvider, errors, reports: undefined as unknown as ChildCapacityReports, observer };
	if (options.observe !== false) result.reports = observer();
	return result;
}

function send(f: Fixture, requestId: string, ownerId: string, origin: "model" | "operator", whenBusy?: "steer") {
	return submitConversation(f.root, { message: `work for ${requestId}`, requestId, ownerId, origin, requestContext: { requestId, requester, replyTo: ownerId, origin }, ...(whenBusy === undefined ? {} : { whenBusy }) }, context);
}
async function liveRun(f: Fixture): Promise<LiveRun> {
	const run = (await f.harness.snapshot(LiveDoc, f.root.id, context))?.run;
	assert.ok(run, "the run is live");
	return run;
}
async function reportsFor(f: Fixture, ownerId: string, prefix: string): Promise<DeliveryReport[]> {
	return (await undeliveredReports(f.harness, ownerId, context)).filter((report) => report.requestId.startsWith(prefix));
}
async function entriesOfKind(f: Fixture, kind: string): Promise<EntryRecord[]> {
	return f.harness.commit(async (tx) => (await tx.scanEntries({ conversationId: f.root.id, order: "ascending" }, 512)).items.filter((entry) => entry.kind === kind), context);
}
function noticeText(entry: EntryRecord): string {
	const message = entry.model?.[0];
	assert.equal(message?.role, "user");
	assert.equal(typeof message.content, "string");
	return message.content as string;
}
/** One answered input; returns its submission, the first input of its run. */
async function turn(f: Fixture, requestId: string): Promise<number> {
	const admitted = await f.root.submit({ type: "input", content: `work for ${requestId}`, requestId }, context);
	await admitted.wait(context);
	await f.reports.flush();
	return admitted.id;
}
async function noticeWrite(f: Fixture, headId: number, runId: number) {
	return f.harness.commit((tx) => tx.submissionByRequest(f.root.id, planningBudgetSelfId(headId, runId)), context);
}

it("derives one report identity per recipient, producer and run", () => {
	const first = childCapacityRequestId(ownerA, storageId, 7);
	assert.equal(first, childCapacityRequestId(ownerA, storageId, 7));
	assert.match(first, /^child-capacity:[a-f0-9]{64}$/u);
	assert.notEqual(first, childCapacityRequestId(ownerA, storageId, 8));
	assert.notEqual(first, childCapacityRequestId(ownerB, storageId, 7));
	assert.notEqual(first, childCapacityRequestId(ownerA, `${storageId}:2`, 7));
	assert.equal(runIdentity({ inputs: [4, 9] }), 4, "the first input names the run");
	assert.equal(runIdentity({ inputs: [] }), undefined, "a run that answered has no inputs");
	assert.equal(CHILD_CAPACITY_REPORT_PERCENT, 90);
});

it("renders continuity lines for a done, an empty, an unanswered and an unread child result", () => {
	const known = { tokens: 100, window: 200 };
	const done = continuityLines(known);
	assert.deepEqual(done, ["Child context use: 100 of 200 tokens (50%, newest assistant usage)."]);

	const unusable = "The child returned no usable answer. The facts above are its last observed state; they do not predict the next attempt. Inspect the child (agent_inspect) before another send. If its context is near the window or a compaction failed, agent_compact with instructions or agent_reset with a handoff that names its latest handover or checkpoint can restore room.";
	assert.deepEqual(continuityLines(known, true), [...done, unusable], "an empty or unanswered result adds the fixed paragraph after the facts");
	assert.deepEqual(continuityLines({}, true), [unusable], "an unanswered result without usage states no measurement");
	assert.deepEqual(continuityLines({ ...known, compactionFailure: { trigger: "threshold", error: "summary failed" } }, true), [...done, "Last child compaction failure (threshold): summary failed", unusable]);

	assert.deepEqual(continuityLines({ unavailable: "the native continuity fact read failed" }), ["Child continuity facts are unavailable: the native continuity fact read failed."]);
	assert.deepEqual(continuityLines({ unavailable: "the native continuity fact read failed" }, true), ["Child continuity facts are unavailable: the native continuity fact read failed.", unusable]);

	assert.deepEqual(continuityLines({ tokens: 100 }), ["Child context use: 100 tokens; context window unavailable."], "an unknown window is stated, not estimated");
	assert.deepEqual(continuityLines({ window: 200 }), [], "a window without usage is no measurement");
	assert.deepEqual(continuityLines({}), []);
	assert.deepEqual(continuityLines({ tokens: 899, window: 1000 }), ["Child context use: 899 of 1000 tokens (89%, newest assistant usage)."], "the percentage never overstates the measurement");
	for (const line of [...continuityLines(known, true), ...continuityLines({ unavailable: "x" }, true)]) assert.doesNotMatch(line, /stash|threshold|will fail/iu);
});

it("reads the newest completed usage, the model window and the retained compaction failure", { timeout: 20000 }, async (t) => {
	const f = await fixture(t, small, [answer(small, 4000, "continuity answer"), { ...answer(small, 5000), model: "unlisted-model" }], { observe: false });
	const models = () => f.provider.models;
	assert.deepEqual(await childContinuityFact(f.harness, f.root.id, models, context), {}, "a context without a completed response has no measurement");

	await (await f.root.submit({ type: "input", content: "first", requestId: "first" }, context)).wait(context);
	assert.deepEqual(await childContinuityFact(f.harness, f.root.id, models, context), { tokens: 4000, window: 128_000 });
	assert.deepEqual(await childContinuityFact(f.harness, f.root.id, () => { throw new Error("catalog unavailable"); }, context), { tokens: 4000 }, "a failed window lookup leaves the window unavailable");

	await f.harness.commit(async (tx) => {
		(await tx.doc(LiveDoc, f.root.id)).compactionFailure = { taskId: 1 as TaskId<CompactionResult>, trigger: "threshold", error: "summary failed" };
	}, context);
	assert.deepEqual(await childContinuityFact(f.harness, f.root.id, models, context), { tokens: 4000, window: 128_000, compactionFailure: { trigger: "threshold", error: "summary failed" } });

	await (await f.root.submit({ type: "input", content: "second", requestId: "second" }, context)).wait(context);
	const unlisted = await childContinuityFact(f.harness, f.root.id, models, context);
	assert.equal(unlisted.tokens, 5000);
	assert.equal(unlisted.window, undefined, "a model outside the catalog has no window");
	assert.deepEqual(continuityLines(unlisted).slice(0, 1), ["Child context use: 5000 tokens; context window unavailable."]);

	assert.deepEqual(await childContinuityFact(f.harness, 999_999 as ConversationId, models, context), { unavailable: "the native conversation is not retained" });
});

it("returns an unavailable fact when the fact read fails", { timeout: 20000 }, async () => {
	const { models } = await scripted([]);
	const harness = await Harness.open(new MemoryStorage(), { models, registry: fixtureRegistry() }, context);
	const root = await harness.root(context, { agent: { model: { provider, modelId: small.id } } });
	await harness.close(context);
	const fact = await childContinuityFact(harness, root.id, () => models, context);
	assert.deepEqual(fact, { unavailable: "the native continuity fact read failed" });
	assert.deepEqual(continuityLines(fact), ["Child continuity facts are unavailable: the native continuity fact read failed."]);
});

it("records one capacity report per model-origin recipient and run, with every exact input of that recipient", { timeout: 30000 }, async (t) => {
	const f = await fixture(t, small, [gateCall(small, 60_000), gateCall(small, 120_007), gateCall(small, 121_000), answer(small, 122_000, "the secret answer text")]);
	const a1 = await send(f, "a-1", ownerA, "model");
	await f.gate.entered(0);
	const firstRound = await liveRun(f);
	await f.reports.flush();
	for (const owner of [ownerA, ownerB, operatorReply]) assert.equal((await undeliveredReports(f.harness, owner, context)).length, 0, "usage below 90% of the window records no report");

	const a2 = await send(f, "a-2", ownerA, "model", "steer");
	const b1 = await send(f, "b-1", ownerB, "model", "steer");
	const op = await send(f, "op-1", operatorReply, "operator", "steer");
	f.gate.release(0);
	await f.gate.entered(1);
	const run = await liveRun(f);
	await f.reports.flush();

	assert.notEqual(run.taskId, firstRound.taskId, "each tool round hands the run to another generation task");
	assert.equal(runIdentity(firstRound), a1.submissionId);
	assert.equal(runIdentity(run), a1.submissionId, "the first input names the run across its rounds");
	assert.deepEqual([...run.inputs].sort(), [a1.submissionId, a2.submissionId, b1.submissionId, op.submissionId].sort());
	assert.deepEqual(f.errors, []);
	const body = `Child ${storageId} reported context use of 93% (120007 of 128000 tokens, newest assistant usage) in its current run. This report does not stop or change the child. If it needs room, agent_compact with instructions or agent_reset with a handoff can provide it.`;
	const toA = await undeliveredReports(f.harness, ownerA, context);
	assert.equal(toA.length, 1, "one row for this recipient and run");
	assert.equal(toA[0].requestId, childCapacityRequestId(ownerA, storageId, a1.submissionId));
	assert.equal(toA[0].senderIdentity, storageId);
	assert.equal(toA[0].replyTo, ownerA);
	assert.equal(toA[0].message, body);
	assert.notEqual(toA[0].passive, true, "an intervention stays an active report");
	assert.deepEqual(toA[0].intervention, { producerRunId: run.taskId, producerResults: [
		{ sessionId: storageId, submissionId: a1.submissionId, requestId: "a-1" },
		{ sessionId: storageId, submissionId: a2.submissionId, requestId: "a-2" },
	] });
	const toB = await undeliveredReports(f.harness, ownerB, context);
	assert.equal(toB.length, 1, "a second recipient has its own row");
	assert.equal(toB[0].requestId, childCapacityRequestId(ownerB, storageId, a1.submissionId));
	assert.equal(toB[0].message, body);
	assert.deepEqual(toB[0].intervention, { producerRunId: run.taskId, producerResults: [{ sessionId: storageId, submissionId: b1.submissionId, requestId: "b-1" }] });
	assert.equal((await undeliveredReports(f.harness, operatorReply, context)).length, 0, "an operator-origin route gets no report");
	assert.equal((await undeliveredReports(f.harness, requester, context)).length, 0, "the requester is not the reply recipient");

	f.gate.release(1);
	await f.gate.entered(2);
	await f.reports.flush();
	assert.notEqual((await liveRun(f)).taskId, run.taskId);
	assert.equal((await undeliveredReports(f.harness, ownerA, context)).length, 1, "a later round of the same run at 94% adds no row");
	assert.equal((await undeliveredReports(f.harness, ownerB, context)).length, 1);

	f.gate.release(2);
	const outcome = await readOutcome(f.harness, a1.submissionId, context);
	assert.equal(outcome.status, "done", "the report did not stop the run");
	await f.reports.close();
	assert.deepEqual(f.errors, []);
	for (const report of [...await undeliveredReports(f.harness, ownerA, context), ...await undeliveredReports(f.harness, ownerB, context)]) {
		assert.doesNotMatch(report.message, /secret answer text/u, "the report carries no answer text");
		assert.doesNotMatch(report.message, /stash|threshold|will fail|overflow/iu, "the report names no other extension's threshold and predicts nothing");
	}
	assert.equal((await undeliveredReports(f.harness, ownerA, context)).length, 1);
});

it("reports at exactly 90% and does not repeat the retained report after the observer restarts on the same storage", { timeout: 30000 }, async (t) => {
	const f = await fixture(t, small, [gateCall(small, 115_199), gateCall(small, 115_200), gateCall(small, 121_000), answer(small, 122_000)]);
	const a1 = await send(f, "a-1", ownerA, "model");
	await f.gate.entered(0);
	await f.reports.flush();
	assert.equal((await undeliveredReports(f.harness, ownerA, context)).length, 0, "one token below 90% of the window records nothing");
	f.gate.release(0);
	await f.gate.entered(1);
	await f.reports.flush();
	const before = await undeliveredReports(f.harness, ownerA, context);
	assert.equal(before.length, 1);
	assert.match(before[0].message, /context use of 90% \(115200 of 128000 tokens, newest assistant usage\)/u);
	await f.reports.close();

	const restarted = f.observer();
	f.gate.release(1);
	await f.gate.entered(2);
	await restarted.flush();
	const after = await undeliveredReports(f.harness, ownerA, context);
	assert.deepEqual(after, before, "the retained row is unchanged and no second row exists");
	f.gate.release(2);
	assert.equal((await readOutcome(f.harness, a1.submissionId, context)).status, "done");
	await restarted.close();
	assert.deepEqual(f.errors, []);
});

it("records no report for a run that only an operator-origin request started", { timeout: 30000 }, async (t) => {
	const f = await fixture(t, small, [gateCall(small, 120_007), answer(small, 121_000)]);
	const admitted = await send(f, "op-1", operatorReply, "operator");
	await f.gate.entered(0);
	await f.reports.flush();
	assert.equal((await undeliveredReports(f.harness, operatorReply, context)).length, 0);
	assert.equal((await undeliveredReports(f.harness, requester, context)).length, 0);
	f.gate.release(0);
	assert.equal((await readOutcome(f.harness, admitted.submissionId, context)).status, "done");
	await f.reports.close();
	assert.deepEqual(f.errors, []);
});

it("records no report for usage first observed in the final answer of a run", { timeout: 30000 }, async (t) => {
	const f = await fixture(t, small, [answer(small, 125_000)]);
	const admitted = await send(f, "a-1", ownerA, "model");
	assert.equal((await readOutcome(f.harness, admitted.submissionId, context)).status, "done");
	await f.reports.close();
	assert.equal((await undeliveredReports(f.harness, ownerA, context)).length, 0, "a report names a live run; the result itself carries the continuity lines");
	assert.deepEqual(continuityLines(await childContinuityFact(f.harness, f.root.id, () => f.provider.models, context)), ["Child context use: 125000 of 128000 tokens (97%, newest assistant usage)."]);
	assert.deepEqual(f.errors, []);
});

it("records one planning-budget report at the first same-run crossing and none for a run that starts above the budget", { timeout: 30000 }, async (t) => {
	const f = await fixture(t, mid, [
		gateCall(mid, 200_000), gateCall(mid, 260_000), gateCall(mid, 270_000), answer(mid, 280_000),
		gateCall(mid, 290_000), gateCall(mid, 300_000), answer(mid, 310_000),
	]);
	const a1 = await send(f, "a-1", ownerA, "model");
	await f.gate.entered(0);
	const op = await send(f, "op-1", operatorReply, "operator", "steer");
	await f.reports.flush();
	assert.equal((await reportsFor(f, ownerA, "child-budget:")).length, 0, "a first sample below the budget is no crossing");

	f.gate.release(0);
	await f.gate.entered(1);
	const run = await liveRun(f);
	await f.reports.flush();
	const crossed = await reportsFor(f, ownerA, "child-budget:");
	assert.equal(crossed.length, 1);
	assert.equal(crossed[0].requestId, planningBudgetSourceId(ownerA, storageId, a1.submissionId));
	assert.equal(crossed[0].message, planningBudgetBody(storageId, 260_000, 250_000, `${provider}/${mid.id}`));
	assert.notEqual(crossed[0].passive, true);
	assert.deepEqual(crossed[0].intervention, { producerRunId: run.taskId, producerResults: [{ sessionId: storageId, submissionId: a1.submissionId, requestId: "a-1" }] });
	assert.ok(run.inputs.includes(op.submissionId), "the operator-origin input is in the run");
	assert.equal((await undeliveredReports(f.harness, operatorReply, context)).length, 0, "only model-origin recipients get the report");
	assert.equal((await reportsFor(f, ownerA, "child-capacity:")).length, 0, "52% of the window is below the capacity report");

	f.gate.release(1);
	await f.gate.entered(2);
	await f.reports.flush();
	assert.equal((await reportsFor(f, ownerA, "child-budget:")).length, 1, "a later sample above the budget is no second crossing");
	f.gate.release(2);
	assert.equal((await readOutcome(f.harness, a1.submissionId, context)).status, "done");

	const a2 = await send(f, "a-2", ownerA, "model");
	await f.gate.entered(3);
	await f.reports.flush();
	f.gate.release(3);
	await f.gate.entered(4);
	await f.reports.flush();
	assert.equal(runIdentity(await liveRun(f)), a2.submissionId, "the second request is another run");
	f.gate.release(4);
	assert.equal((await readOutcome(f.harness, a2.submissionId, context)).status, "done");
	await f.reports.close();
	assert.deepEqual(f.errors, []);
	assert.deepEqual(await reportsFor(f, ownerA, "child-budget:"), crossed, "a run that starts above the budget records none");
	assert.equal((await undeliveredReports(f.harness, operatorReply, context)).length, 0);
});

it("reads the sample before its start from the transcript, so a crossing that began earlier is not lost", { timeout: 30000 }, async (t) => {
	const f = await fixture(t, mid, [gateCall(mid, 200_000), gateCall(mid, 260_000), answer(mid, 270_000)], { observe: false });
	const a1 = await send(f, "a-1", ownerA, "model");
	await f.gate.entered(0);
	f.reports = f.observer();
	f.gate.release(0);
	await f.gate.entered(1);
	const run = await liveRun(f);
	await f.reports.flush();
	const crossed = await reportsFor(f, ownerA, "child-budget:");
	assert.equal(crossed.length, 1, "the unobserved sample below the budget and the observed one above it are one crossing");
	assert.equal(crossed[0].message, planningBudgetBody(storageId, 260_000, 250_000, `${provider}/${mid.id}`));
	f.gate.release(1);
	assert.equal((await readOutcome(f.harness, a1.submissionId, context)).status, "done");
	await f.reports.close();
	const notices = await entriesOfKind(f, PLANNING_BUDGET_NOTICE_KIND);
	assert.equal(notices.length, 1, "the same crossing gives the conversation its own notice");
	assert.equal(noticeText(notices[0]), planningBudgetSelfBody(260_000, 250_000, `${provider}/${mid.id}`, 1_700_000_000_000));
	assert.equal(crossed[0].requestId, planningBudgetSourceId(ownerA, storageId, a1.submissionId));
	assert.deepEqual(crossed[0].intervention, { producerRunId: run.taskId, producerResults: [{ sessionId: storageId, submissionId: a1.submissionId, requestId: "a-1" }] });
	assert.deepEqual(f.errors, []);
});

it("keeps one run identity when the first entry of the run appears after its first sample", { timeout: 30000 }, async (t) => {
	let yields = 0;
	const paused = newStep();
	const f = await fixture(t, mid, [answer(mid, 100_000), answer(mid, 200_000, "partial"), gateCall(mid, 210_000), gateCall(mid, 260_000), gateCall(mid, 270_000), answer(mid, 280_000)], {
		onYield: async () => {
			yields += 1;
			if (yields !== 2) return undefined;
			paused.enter();
			await paused.released;
			return { continue: "continue the work" };
		},
	});
	await turn(f, "earlier");
	// A continue reaches the model only when the context ends in a user message; an idle write supplies one and places no input.
	await f.root.submit({ type: "write", entry: { kind: "capacity-test.note", model: [{ role: "user", content: "a note for the next request", timestamp: 1 }] } }, context);
	const continued = await f.root.submit({ type: "continue" }, context);
	await paused.entered;
	const started = await liveRun(f);
	assert.equal(started.first, undefined, "a continue that places nothing starts a run without a first entry");
	assert.deepEqual(started.inputs, [continued.id]);
	paused.release();

	await f.gate.entered(0);
	const withFirst = await liveRun(f);
	assert.notEqual(withFirst.first, undefined, "the first tool-calling answer becomes the first entry of the run");
	assert.notEqual(withFirst.taskId, started.taskId);
	assert.equal(runIdentity(withFirst), runIdentity(started), "the run identity does not change with its first entry or its task");
	const a1 = await send(f, "a-1", ownerA, "model", "steer");
	await f.reports.flush();
	assert.equal((await undeliveredReports(f.harness, ownerA, context)).length, 0, "two samples below the budget are no crossing");
	assert.equal((await entriesOfKind(f, PLANNING_BUDGET_NOTICE_KIND)).length, 0);

	f.gate.release(0);
	await f.gate.entered(1);
	const crossing = await liveRun(f);
	await f.reports.flush();
	const crossed = await reportsFor(f, ownerA, "child-budget:");
	assert.equal(crossed.length, 1);
	assert.equal(crossed[0].requestId, planningBudgetSourceId(ownerA, storageId, continued.id));
	assert.equal(crossed[0].message, planningBudgetBody(storageId, 260_000, 250_000, `${provider}/${mid.id}`));
	assert.deepEqual(crossed[0].intervention, { producerRunId: crossing.taskId, producerResults: [{ sessionId: storageId, submissionId: a1.submissionId, requestId: "a-1" }] });
	await f.reports.close();

	const restarted = f.observer();
	f.gate.release(1);
	await f.gate.entered(2);
	await restarted.flush();
	f.gate.release(2);
	assert.equal((await continued.wait(context)).status, "done");
	await restarted.close();
	assert.deepEqual(await undeliveredReports(f.harness, ownerA, context), crossed, "a restarted observer adds no row for the same run");
	const notices = await entriesOfKind(f, PLANNING_BUDGET_NOTICE_KIND);
	assert.equal(notices.length, 1, "the same run gives one own-budget notice across the restart");
	assert.equal(noticeText(notices[0]), planningBudgetSelfBody(260_000, 250_000, `${provider}/${mid.id}`, 1_700_000_000_000));
	assert.equal((await noticeWrite(f, 0, continued.id))?.entry, notices[0].id);
	assert.equal(f.provider.requests(), 6);
	assert.deepEqual(f.errors, []);
});

it("retains one own-budget notice per context episode and starts no run for it", { timeout: 30000 }, async (t) => {
	const f = await fixture(t, large, [
		answer(large, 200_000), answer(large, 310_000), answer(large, 320_000),
		answer(large, 1_000, "summary of the earlier work"),
		answer(large, 100_000), answer(large, 305_000), answer(large, 306_000),
	], { compaction: true });
	await turn(f, "below");
	assert.equal((await entriesOfKind(f, PLANNING_BUDGET_NOTICE_KIND)).length, 0, "a first sample is no crossing");

	const firstRun = await turn(f, "crossing");
	const first = await entriesOfKind(f, PLANNING_BUDGET_NOTICE_KIND);
	assert.equal(first.length, 1);
	const firstWrite = await noticeWrite(f, 0, firstRun);
	assert.equal(firstWrite?.type, "write", "the notice is a write submission keyed by the context head and the run");
	assert.equal(firstWrite?.status, "done");
	assert.equal(firstWrite?.entry, first[0].id);
	assert.equal(noticeText(first[0]), planningBudgetSelfBody(310_000, 300_000, `${provider}/${large.id}`, 1_700_000_000_000));
	assert.equal(first[0].head, undefined);
	assert.equal(first[0].data, undefined);
	assert.equal((await f.harness.snapshot(LiveDoc, f.root.id, context))?.run, undefined, "the notice started no run");
	assert.equal(f.provider.requests(), 2, "the notice asked the model nothing");

	await turn(f, "above");
	assert.equal((await entriesOfKind(f, PLANNING_BUDGET_NOTICE_KIND)).length, 1, "later turns above the budget add no notice");
	assert.equal(f.provider.requests(), 3);
	const visible = (await f.root.context(context)).messages.filter((message) => message.role === "user" && message.content === noticeText(first[0]));
	assert.equal(visible.length, 1, "the next request carries the retained notice once");

	const compaction = await f.root.compact("keep the purpose", context);
	assert.equal((await f.harness.waitForTask(compaction, context)).state.outcome.status, "completed");
	await f.reports.flush();
	await turn(f, "after-compaction");
	assert.equal((await entriesOfKind(f, PLANNING_BUDGET_NOTICE_KIND)).length, 1, "the first sample of a new episode is no crossing");
	const secondRun = await turn(f, "second-crossing");
	const second = await entriesOfKind(f, PLANNING_BUDGET_NOTICE_KIND);
	assert.equal(second.length, 2, "a new crossing after a compaction retains another notice");
	assert.equal(noticeText(second[1]), planningBudgetSelfBody(305_000, 300_000, `${provider}/${large.id}`, 1_700_000_000_000));
	await turn(f, "above-again");
	assert.equal((await entriesOfKind(f, PLANNING_BUDGET_NOTICE_KIND)).length, 2);
	assert.equal(f.provider.requests(), 7, "six answers and one summary; no notice asked for a response");

	const head = await f.harness.commit((tx) => tx.latestHeadMarker(f.root.id), context);
	assert.ok(head, "the compaction wrote a head entry");
	const secondWrite = await noticeWrite(f, head.id, secondRun);
	assert.equal(secondWrite?.type, "write", "the second notice names the new context head");
	assert.equal(secondWrite?.entry, second[1].id);
	await f.reports.close();
	assert.deepEqual(f.errors, []);
});

it("places the own-budget notice in a busy run at its next boundary without another run", { timeout: 30000 }, async (t) => {
	const f = await fixture(t, large, [gateCall(large, 200_000), gateCall(large, 310_000), answer(large, 320_000)]);
	const admitted = await f.root.submit({ type: "input", content: "busy work", requestId: "busy" }, context);
	await f.gate.entered(0);
	f.gate.release(0);
	await f.gate.entered(1);
	await f.reports.flush();
	assert.equal((await entriesOfKind(f, PLANNING_BUDGET_NOTICE_KIND)).length, 0, "the notice waits for the boundary of the running tool round");
	f.gate.release(1);
	const settled = await admitted.wait(context);
	assert.equal(settled.status, "done");
	await f.reports.close();
	const notices = await entriesOfKind(f, PLANNING_BUDGET_NOTICE_KIND);
	assert.equal(notices.length, 1);
	assert.equal(noticeText(notices[0]), planningBudgetSelfBody(310_000, 300_000, `${provider}/${large.id}`, 1_700_000_000_000));
	const answerId = settled.status === "done" ? settled.answer : undefined;
	assert.ok(answerId !== undefined && notices[0].id < answerId, "the notice precedes the answer of the same run");
	assert.equal(f.provider.requests(), 3, "the run made its three requests and the notice added none");
	assert.equal((await f.harness.snapshot(LiveDoc, f.root.id, context))?.run, undefined);
	assert.deepEqual(f.errors, []);
});

it("retains no own-budget notice for a model without a configured planning budget", { timeout: 30000 }, async (t) => {
	const f = await fixture(t, plain, [answer(plain, 200_000), answer(plain, 310_000), gateCall(plain, 320_000), answer(plain, 330_000)]);
	await turn(f, "below");
	await turn(f, "above");
	const a1 = await send(f, "a-1", ownerA, "model");
	await f.gate.entered(0);
	await f.reports.flush();
	f.gate.release(0);
	assert.equal((await readOutcome(f.harness, a1.submissionId, context)).status, "done");
	await f.reports.close();
	assert.equal((await entriesOfKind(f, PLANNING_BUDGET_NOTICE_KIND)).length, 0);
	assert.equal((await undeliveredReports(f.harness, ownerA, context)).length, 0);
	assert.deepEqual(f.errors, []);
});

it("reports a failed retention once, stops observing, and leaves the run and its sends untouched", { timeout: 30000 }, async (t) => {
	const f = await fixture(t, small, [gateCall(small, 120_007), gateCall(small, 121_000), answer(small, 122_000)]);
	// A reply recipient that is no canonical identity makes the report association invalid at its commit.
	const invalidOwner = `${ownerA}:1`;
	const refused = await send(f, "bad-1", invalidOwner, "model");
	await f.gate.entered(0);
	await f.reports.flush();
	assert.equal(f.errors.length, 1, "the failure reaches the host callback once");
	assert.match(String((f.errors[0] as Error).message), /observation stopped after a failure/u);

	const later = await send(f, "a-1", ownerA, "model", "steer");
	f.gate.release(0);
	await f.gate.entered(1);
	await f.reports.flush();
	assert.equal((await undeliveredReports(f.harness, ownerA, context)).length, 0, "a stopped observer records nothing more");
	f.gate.release(1);
	assert.equal((await readOutcome(f.harness, refused.submissionId, context)).status, "done", "the producer was not cancelled");
	assert.equal((await readOutcome(f.harness, later.submissionId, context)).status, "done", "a later send was not refused");
	await f.reports.close();
	assert.equal(f.errors.length, 1);
});
