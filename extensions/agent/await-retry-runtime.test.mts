import { machineConfig } from "./settings-fixture.mts";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, it, type TestContext } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { getCurrentSystemPrompt, type AssistantMessage, type Message } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import * as Durable from "@earendil-works/pi-durable";
import { Value } from "typebox/value";
import { createAgentContribution, type AgentControlDispatch } from "./durable-agents.ts";
import { readOutcome } from "./durable-controls.ts";
import { observeProducerAwait } from "./await-producer-observer.ts";
import { ownAwaitFact, producerRetryFact, releaseAwait, recordProducerAwait } from "./await-observation.ts";
import { AwaitDoc, AwaitOutputSchema, type AwaitInput, type AwaitState } from "./awaited-results.ts";
import type { ProducerAwaitFact } from "./await-facts.ts";
import type { AwaitReply } from "./await-execution.ts";
import type { ResultReference } from "./result-reference.ts";

const preferenceOverride = process.env.PI_HARNESS_FILE;
delete process.env.PI_HARNESS_FILE;
after(() => { if (preferenceOverride !== undefined) process.env.PI_HARNESS_FILE = preferenceOverride; });

const context = BACKGROUND_CONTEXT;
const storageId = "retry-test";
const model = { provider: "faux", modelId: "faux-1" };
function messageText(message: Message | undefined): string {
	if (message === undefined) return "";
	return typeof message.content === "string" ? message.content : message.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("");
}
function retryError(): AssistantMessage { return fauxAssistantMessage("", { stopReason: "error", errorMessage: "429 rate limit; provider claims reset tomorrow" }); }

async function setup(t: TestContext, producerAnswer: (text: string) => AssistantMessage | Promise<AssistantMessage>, baseDelayMs = 60000) {
	const agentDir = mkdtempSync(join(tmpdir(), "retry-agent-config-"));
	t.after(() => rmSync(agentDir, { recursive: true, force: true }));
	let args: AwaitInput = { results: [{ sessionId: "unused", submissionId: 1 }] };
	let harness!: Durable.Harness;
	let callerCalls = 0;
	const prompts: string[] = [];
	const faux = fauxProvider(); const models = createModels(); models.setProvider(faux.provider);
	faux.setResponses(Array.from({ length: 100 }, () => async (request) => {
		prompts.push(getCurrentSystemPrompt(request.messages));
		const last = request.messages.findLast((message) => message.role !== "system");
		const text = messageText(last);
		if (last?.role === "user" && text.startsWith("PRODUCER")) return producerAnswer(text);
		callerCalls++;
		return last?.role === "user" ? fauxAssistantMessage([fauxToolCall("agent_await", args)], { stopReason: "toolUse" }) : fauxAssistantMessage("CALLER RECOVERED");
	}));
	const dispatch: AgentControlDispatch = async (method, params, ctx = context) => {
		if (method === "await-native") return readOutcome(harness, (params.result as ResultReference).submissionId as Durable.SubmissionId, ctx);
		if (method !== "observe-producer-await") throw new Error(`Unexpected control ${method}`);
		const sessionId = params.sessionId as string;
		const conversationId = Number(sessionId.split(":")[1]) as Durable.ConversationId;
		return observeProducerAwait(sessionId, () => harness.commit(async (tx) => {
			const awaiting = await ownAwaitFact(tx, conversationId);
			const execution = await producerRetryFact(tx, conversationId, params.results as ResultReference[], 5);
			return { ...(awaiting === undefined ? {} : { awaiting }), ...(execution === undefined ? {} : { execution }) };
		}, ctx), async (changed) => harness.subscribeCommits(changed), params.publish as (fact: ProducerAwaitFact) => Promise<void>, ctx);
	};
	const registry = Durable.createRegistry();
	registry.install(createAgentContribution({ configureSettings: () => {}, source: "extensions/agent/index.ts", dispatch }).create({ onClose() {}, durable: Durable, storageId, cwd: process.cwd(), agentDir, services: { modelRuntime: { getModel: () => undefined } } }));
	harness = await Durable.Harness.open(new Durable.MemoryStorage(), { models, registry, settings: { retry: { enabled: true, maxRetries: 4, baseDelayMs } } }, context);
	harness.resume();
	t.after(() => harness.close(context));
	const root = await harness.root(context, { agent: { model } });
	await harness.commit(async (tx) => { await tx.doc(AwaitDoc); }, context);
	const submitProducer = async (text: string) => {
		const conversation = await harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model } }, context);
		const input = await conversation.submit({ type: "input", content: text, requestId: text }, context);
		return { conversation, input, result: { sessionId: `${storageId}:${conversation.id}`, submissionId: input.id, requestId: text } };
	};
	const start = async (value: AwaitInput) => { args = value; return root.submit({ type: "input", content: "Await exact work" }, context); };
	const output = async () => {
		const entries = await harness.commit((tx) => tx.scanEntries({ conversationId: root.id }, 30), context);
		const message = entries.items.flatMap((entry) => entry.model ?? []).find((item) => item.role === "toolResult" && item.toolName === "agent_await");
		assert.ok(message?.role === "toolResult"); assert.equal(message.isError, false, messageText(message));
		const result = JSON.parse(messageText(message)) as AwaitReply;
		assert.equal(Value.Check(AwaitOutputSchema, result), true);
		return result;
	};
	return { harness, root, submitProducer, start, output, prompts, calls: () => callerCalls };
}

async function waitForState(harness: Durable.Harness, predicate: (state: AwaitState) => boolean): Promise<void> {
	const watch = await harness.watchDoc(AwaitDoc, context); assert.ok(watch);
	try {
		await new Promise<void>((resolve) => {
			const check = (state: AwaitState | null | undefined) => { if (state !== null && state !== undefined && predicate(state)) resolve(); };
			watch.start(async (state) => { check(state); });
			void harness.snapshot(AwaitDoc, context).then(check);
		});
	} finally { await watch.stop(); }
}

it("uses isolated retry preferences despite an ambient agent directory", async (t) => {
	const ambientDir = mkdtempSync(join(tmpdir(), "retry-ambient-preferences-"));
	const previous = { agentDir: process.env.PI_AGENT_DIR, preferences: process.env.PI_HARNESS_FILE };
	t.after(() => {
		if (previous.agentDir === undefined) delete process.env.PI_AGENT_DIR;
		else process.env.PI_AGENT_DIR = previous.agentDir;
		if (previous.preferences === undefined) delete process.env.PI_HARNESS_FILE;
		else process.env.PI_HARNESS_FILE = previous.preferences;
		rmSync(ambientDir, { recursive: true, force: true });
	});
	writeFileSync(join(ambientDir, "harness.json"), JSON.stringify(machineConfig({ presets: { ambient: { model: "faux/faux-1" } },
		preferences: { reportingNotes: "AMBIENT-RETRY-PREFERENCES-MARKER" },
	})));
	process.env.PI_AGENT_DIR = ambientDir;
	delete process.env.PI_HARNESS_FILE;
	const f = await setup(t, () => fauxAssistantMessage("FINISHED"));
	const producer = await f.submitProducer("PRODUCER ISOLATED");
	await producer.input.wait(context);
	const original = await f.start({ results: [producer.result] });
	await original.wait(context);
	assert.equal((await f.output()).decision, "settled");
	assert.ok(f.prompts.length > 0);
	assert.equal(f.prompts.some((prompt) => prompt.includes("AMBIENT-RETRY-PREFERENCES-MARKER")), false,
		"retry fixtures must not include ambient machine preferences in model requests");
});

it("releases an exact retry with partial long-answer continuation and leaves the producer placed", { timeout: 10000 }, async (t) => {
	let finish!: (value: AssistantMessage) => void;
	const held = new Promise<AssistantMessage>((resolve) => { finish = resolve; });
	const f = await setup(t, (text) => text === "PRODUCER PARTIAL" ? fauxAssistantMessage(`${"x".repeat(17000)}END`) : held);
	t.after(() => finish(fauxAssistantMessage("FINISHED")));
	const partial = await f.submitProducer("PRODUCER PARTIAL"); await partial.input.wait(context);
	const retry = await f.submitProducer("PRODUCER RETRY");
	const original = await f.start({ results: [partial.result, retry.result], releaseOnProviderRetry: {} });
	await waitForState(f.harness, (state) => state.declarations.some((item) => item.outcomes.length === 1));
	assert.equal((await original.status(context)).status, "placed"); assert.equal(f.calls(), 1);
	finish(retryError());
	assert.equal((await original.wait(context)).status, "done");
	const output = await f.output();
	assert.equal(output.decision, "released"); assert.equal(output.releaseReason, "provider retry");
	assert.deepEqual(output.unresolved, [retry.result]); assert.equal(output.results.length, 1);
	assert.equal(output.results[0].truncated, true);
	assert.equal(output.results[0].continuation?.sessionId, partial.result.sessionId);
	assert.equal(output.results[0].continuation?.entryId, output.results[0].answerEntryId);
	assert.equal(output.producerRetries?.[0].execution?.attempt, 1);
	assert.deepEqual(output.producerRetries?.[0].execution?.results, [retry.result]);
	assert.match(output.producerRetries?.[0].execution?.error ?? "", /provider claims/u);
	assert.equal((await retry.input.status(context)).status, "placed");
	await retry.conversation.abort(context);
});

for (const policy of [undefined, { minAttempt: 2 }]) it(`keeps a retry blocked with ${policy === undefined ? "no opt-in" : "an unmet attempt threshold"}`, { timeout: 10000 }, async (t) => {
	const f = await setup(t, () => retryError());
	const retry = await f.submitProducer("PRODUCER RETRY");
	const original = await f.start({ results: [retry.result], ...(policy === undefined ? {} : { releaseOnProviderRetry: policy }) });
	await waitForState(f.harness, (state) => state.declarations.some((item) => item.producers?.some((fact) => fact.execution !== undefined)));
	assert.equal((await original.status(context)).status, "placed"); assert.equal(f.calls(), 1);
	await retry.conversation.abort(context);
	await original.wait(context);
	assert.equal((await f.output()).decision, "failed");
});

it("releases only after the opted-in attempt threshold", { timeout: 10000 }, async (t) => {
	const f = await setup(t, () => retryError(), 1);
	const retry = await f.submitProducer("PRODUCER RETRY");
	const original = await f.start({ results: [retry.result], releaseOnProviderRetry: { minAttempt: 3 } });
	await original.wait(context);
	const output = await f.output(); assert.equal(output.decision, "released");
	assert.ok((output.producerRetries?.[0].execution?.attempt ?? 0) >= 3);
	await retry.conversation.abort(context);
});

it("does not release for the producer's different active input while the exact result is queued", { timeout: 10000 }, async (t) => {
	const f = await setup(t, () => retryError());
	const retry = await f.submitProducer("PRODUCER RETRY");
	const queued = await retry.conversation.submit({ type: "input", content: "PRODUCER QUEUED", requestId: "queued", whenBusy: "followUp" }, context);
	const result = { sessionId: retry.result.sessionId, submissionId: queued.id, requestId: "queued" };
	const original = await f.start({ results: [result], releaseOnProviderRetry: {} });
	await waitForState(f.harness, (state) => state.declarations.some((item) => (item.producers?.length ?? 0) > 0));
	assert.equal((await original.status(context)).status, "placed"); assert.equal(f.calls(), 1);
	const state = await f.harness.snapshot(AwaitDoc, context); const declaration = state?.declarations[0]; assert.ok(declaration);
	assert.equal(declaration.producers?.[0].execution, undefined);
	await f.harness.commit((tx) => releaseAwait(tx, storageId, f.root.id, declaration.runId), context);
	await original.wait(context);
	assert.equal((await f.output()).producerRetries, undefined);
	await queued.abort(context); await retry.conversation.abort(context);
});

it("ignores a delayed stale retry after a newer no-retry observation", { timeout: 10000 }, async (t) => {
	let finish!: (value: AssistantMessage) => void;
	const held = new Promise<AssistantMessage>((resolve) => { finish = resolve; });
	const f = await setup(t, () => held); t.after(() => finish(fauxAssistantMessage("FINISHED")));
	const producer = await f.submitProducer("PRODUCER HELD");
	const original = await f.start({ results: [producer.result], releaseOnProviderRetry: {} });
	await waitForState(f.harness, (state) => state.declarations.some((item) => (item.producers?.length ?? 0) > 0));
	await f.harness.commit(async (tx) => {
		const declaration = (await tx.doc(AwaitDoc)).declarations[0]; assert.ok(declaration);
		const observedAt = (declaration.producers?.[0].observedAt ?? 0) + 1;
		declaration.producers = [{ sessionId: producer.result.sessionId, source: "producer await-state", observedAt, execution: { state: "provider-retry", runId: 1, results: [producer.result], attempt: 1, nextRetryAt: Date.now(), error: "old retry", errorTruncated: false } }];
		await recordProducerAwait(tx, declaration.taskId as Durable.TaskId, { sessionId: producer.result.sessionId, source: "producer await-state", observedAt: observedAt + 1 });
		await recordProducerAwait(tx, declaration.taskId as Durable.TaskId, { sessionId: producer.result.sessionId, source: "producer await-state", observedAt, execution: { state: "provider-retry", runId: 1, results: [producer.result], attempt: 9, nextRetryAt: Date.now(), error: "old retry", errorTruncated: false } });
	}, context);
	assert.equal((await original.status(context)).status, "placed"); assert.equal(f.calls(), 1);
	finish(fauxAssistantMessage("FINISHED")); await original.wait(context);
	assert.equal((await f.output()).decision, "settled");
});
