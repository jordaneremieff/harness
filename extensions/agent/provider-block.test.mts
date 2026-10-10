import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { Value } from "typebox/value";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { ProviderDoc, type ConversationId, type SubmissionId } from "@earendil-works/pi-durable";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { DurableHost } from "./durable-host.ts";
import { answerMessage, fixtureRegistry, hostOptions, scriptedRuntime, fixtureProvider, fixtureModelId } from "./durable-host-fixture.mts";
import { ProviderModels } from "./provider-models.ts";
import { PROVIDER_BLOCK_ERROR, STALE_PROVIDER_ERROR, isProviderExhaustion, ProviderBlockFactSchema, captureProviderAttempt, retainProviderBlock, readProviderBlock, ProviderControlDoc, retainDeferredAttempt, readDeferredAttempt } from "./provider-block.ts";
import { safeProviderError } from "./primary-observation.ts";
import { ProviderRetryNoticeSchema, providerNoticeRequestId, retainProviderRetryNotices } from "./provider-notices.ts";
import { AgentDeliveryDoc, submitConversation, providerRetryReportSettled } from "./durable-controls.ts";
import { RequestContextDoc } from "./request-context.ts";
import { LiveDoc } from "@earendil-works/pi-durable";

it("classifies account exhaustion across providers without treating throttle or context rejection as exhaustion", () => {
	for (const error of ["429 Weekly/Monthly Limit Exhausted", "usage limit reached", "insufficient_quota", "insufficient balance", "credit balance depleted", "billing_hard_limit_reached", "billing limit exhausted", "GoUsageLimitError", "FreeUsageLimitError", "subscription_sharing_usage_limit_exceeded", '{"error":{"code":"1308","message":"weekly usage limit reached"}}', '{"error":{"code":"1310","message":"insufficient balance"}}']) assert.equal(isProviderExhaustion(error), true, error);
	for (const error of ["429 too many requests", "Quota exceeded: requests per minute; retry in 2 seconds", "token limit exceeded", "maximum context length exceeded", "context window quota exceeded", "billing infrastructure transient error", '{"error":{"code":"1308","message":"internal error"}}', '{"error":{"code":"1310","message":"internal error"}}']) assert.equal(isProviderExhaustion(error), false, error);
	assert.equal(isProviderExhaustion('{"code":"1308"}', "zai"), true);
	assert.equal(isProviderExhaustion('{"code":"1308"}', "another-provider"), false);
});

it("recognizes explicit exhaustion inside rate-limit envelopes while preserving concrete throttle negatives", () => {
	for (const text of ['RateLimitError: {"error":{"code":"insufficient_quota","message":"check your plan"}}', 'Rate limit: weekly usage limit exhausted', 'RateLimitError: billing_hard_limit_reached']) assert.equal(isProviderExhaustion(text), true, text);
	assert.equal(isProviderExhaustion('RateLimitError: {"code":"1308"}', "zai"), true);
	assert.equal(isProviderExhaustion('RateLimitError: {"code":"1310"}', "zai"), true);
	for (const text of ['RateLimitError: quota exceeded; requests per minute', 'Rate limit exceeded: TPM', 'RateLimitError: maximum context length exceeded', 'RateLimitError: too many requests']) assert.equal(isProviderExhaustion(text), false, text);
});

it("retains bounded redacted provider evidence without assigning a timezone to reset claims", () => {
	const error = safeProviderError("usage limit reached; reset 2026-10-11 00:00; api_key=sk-abcdefghijklmnopqrstuv");
	assert.match(error.text, /reset 2026-10-11 00:00/u); assert.equal(error.redacted, true); assert.equal(error.truncated, false);
	assert.doesNotMatch(error.text, /abcdefghijkl/u);
	assert.equal(safeProviderError("x".repeat(5000), 4096).truncated, true);
	assert.equal(safeProviderError("x".repeat(40000)).text, "[text unavailable: scan budget exceeded]");
});

async function fixture(t: { after(fn: () => Promise<void>): void }, messages = [answerMessage()]) {
	const root = await mkdtemp(join(tmpdir(), "provider-block-"));
	const models = await scriptedRuntime(messages);
	const host = await DurableHost.open({ ...hostOptions(join(root, "storage.sqlite"), models, fixtureRegistry()), resume: false });
	t.after(async () => { await host.close(); await rm(root, { recursive: true, force: true }); });
	const adapter = new ProviderModels(models, () => host.harness, host.storageId); adapter.bind(); t.after(async () => adapter.close());
	const model = adapter.models.getModel(fixtureProvider, fixtureModelId); assert.ok(model);
	const provider = await host.harness.snapshot(ProviderDoc, 1 as ConversationId, BACKGROUND_CONTEXT);
	assert.ok(provider);
	return { host, models, adapter, model, storagePath: join(root, "storage.sqlite"), sessionId: provider.sessionId };
}

it("replaces terminal raw text, keeps stream/result agreement and partial usage, and makes zero calls while blocked", async (t) => {
	const { host, models, adapter, model, sessionId } = await fixture(t);
	const raw = "Weekly usage limit reached: token limit exceeded; reset 2026-10-11 00:00; api_key=sk-abcdefghijklmnopqrstuv";
	let calls = 0;
	const original = { ...answerMessage("partial progress"), stopReason: "error" as const, errorMessage: raw };
	models.streamSimple = (_model, _context, options) => {
		calls++; assert.equal(options?.maxRetries, 7);
		const stream = createAssistantMessageEventStream(); stream.push({ type: "error", reason: "error", error: original }); stream.end(); return stream;
	};
	const stream = adapter.models.streamSimple(model, { messages: [] }, { sessionId, maxRetries: 7 });
	const events = []; for await (const event of stream) events.push(event);
	const result = await stream.result();
	assert.equal(result.errorMessage, PROVIDER_BLOCK_ERROR); assert.equal(events.at(-1)?.type, "error");
	const terminal = events.at(-1); assert.deepEqual(terminal?.type === "error" ? terminal.error : undefined, result);
	assert.deepEqual(result.content, original.content); assert.deepEqual(result.usage, original.usage); assert.equal(original.errorMessage, raw);
	const block = await host.harness.commit((tx) => readProviderBlock(tx, 1 as ConversationId), BACKGROUND_CONTEXT);
	assert.ok(block); assert.equal(Value.Check(ProviderBlockFactSchema, block), true); assert.equal(block.errorRedacted, true); assert.match(block.error, /reset 2026-10-11 00:00/u);
	assert.equal((await adapter.models.completeSimple(model, { messages: [] }, { sessionId })).errorMessage, PROVIDER_BLOCK_ERROR);
	assert.equal(calls, 1);
});

it("explicit same-model recovery invalidates pinned dispatch and old-epoch failures", async (t) => {
	const { host, models, adapter, model, sessionId } = await fixture(t);
	const old = await host.harness.commit((tx) => captureProviderAttempt(tx, sessionId, { provider: model.provider, modelId: model.id }), BACKGROUND_CONTEXT);
	await host.harness.commit((tx) => retainProviderBlock(tx, old, "usage limit reached", host.storageId, Date.now()), BACKGROUND_CONTEXT);
	const reasoning = await host.request("configure", { thinkingLevel: "off" }) as { outcome: string };
	assert.equal(reasoning.outcome, "applied"); assert.ok(await host.harness.commit((tx) => readProviderBlock(tx, 1 as ConversationId), BACKGROUND_CONTEXT));
	const failed = await host.request("configure", { model: { provider: "missing", modelId: "model" } }) as { outcome: string }; assert.equal(failed.outcome, "failed");
	assert.ok(await host.harness.commit((tx) => readProviderBlock(tx, 1 as ConversationId), BACKGROUND_CONTEXT));
	const configured = await host.request("configure", { model: { provider: model.provider, modelId: model.id } }) as { outcome: string }; assert.equal(configured.outcome, "applied");
	assert.equal(await host.harness.commit((tx) => readProviderBlock(tx, 1 as ConversationId), BACKGROUND_CONTEXT), undefined);
	assert.equal(await host.harness.commit((tx) => retainProviderBlock(tx, old, "usage limit reached", host.storageId, Date.now()), BACKGROUND_CONTEXT), undefined);
	assert.equal((await adapter.models.completeSimple(model, { messages: [] }, { sessionId })).errorMessage, STALE_PROVIDER_ERROR);
	const fresh = adapter.models.getModel(model.provider, model.id); assert.ok(fresh);
	assert.equal((await adapter.models.completeSimple(fresh, { messages: [] }, { sessionId })).stopReason, "stop");
	assert.equal((await host.harness.snapshot(ProviderControlDoc, sessionId, BACKGROUND_CONTEXT))?.epoch, 1);
	assert.ok(models);
});

it("notice IDs ignore observation time, include immutable result IDs and retain one report for a revision", async (t) => {
	const { host } = await fixture(t);
	const admitted = await host.submit({ message: "retained task", requestId: "provider-work", ownerId: "actual-recipient", origin: "model", requestContext: { requester: "requester", replyTo: "actual-recipient", requestId: "provider-work", origin: "model" } });
	await host.harness.commit(async (tx) => {
		const live = await tx.doc(LiveDoc, 1 as ConversationId);
		assert.ok(live.run); live.generation = { attempt: 1, retry: { at: Date.now() + 100000, error: "429 too many requests" } };
		await retainProviderRetryNotices(tx, host.storageId, 1 as ConversationId, 21, Date.now());
	}, BACKGROUND_CONTEXT);
	const first = (await host.harness.snapshot(AgentDeliveryDoc, BACKGROUND_CONTEXT))?.reports.filter((report) => report.providerRetry !== undefined) ?? [];
	assert.equal(first.length, 1); assert.equal(first[0].ownerId, "actual-recipient"); assert.equal(first[0].providerRetry?.fact.execution?.results[0].submissionId, admitted.submissionId);
	const notice = first[0].providerRetry; assert.ok(notice); assert.equal(Value.Check(ProviderRetryNoticeSchema, notice), true);
	assert.equal(providerNoticeRequestId(first[0].ownerId, notice), providerNoticeRequestId(first[0].ownerId, { fact: { ...notice.fact, observedAt: notice.fact.observedAt + 5000 } }));
	await host.harness.commit((tx) => retainProviderRetryNotices(tx, host.storageId, 1 as ConversationId, 21, Date.now() + 5000), BACKGROUND_CONTEXT);
	assert.equal((await host.harness.snapshot(AgentDeliveryDoc, BACKGROUND_CONTEXT))?.reports.filter((report) => report.providerRetry).length, 1);
	assert.equal((await host.harness.snapshot(RequestContextDoc, 1 as ConversationId, BACKGROUND_CONTEXT))?.requests[0].replyTo, "actual-recipient");
	const execution = notice.fact.execution; assert.ok(execution);
	const missing = { ...first[0], providerRetry: { fact: { ...notice.fact, execution: { ...execution, results: [{ ...execution.results[0], requestId: "missing-input" }] } } } };
	assert.equal(await host.harness.commit((tx) => providerRetryReportSettled(tx, missing), BACKGROUND_CONTEXT), false, "a missing native input is not terminal evidence");
});

it("rejects pending as a terminal provider result with a fixed host error", async (t) => {
	const { models, adapter, model, sessionId } = await fixture(t);
	models.streamSimple = () => { const stream = createAssistantMessageEventStream(); stream.push({ type: "done", reason: "stop", message: { ...answerMessage("partial progress"), stopReason: "pending" } }); stream.end(); return stream; };
	const stream = adapter.models.streamSimple(model, { messages: [] }, { sessionId });
	const events = []; for await (const event of stream) events.push(event);
	assert.equal(events.at(-1)?.type, "error"); assert.equal((await stream.result()).errorMessage, "Agent host: provider state failure; inspect retained state.");
});

it("normalizes thrown provider exhaustion and retains evidence before returning", async (t) => {
	const { host, models, adapter, model, sessionId } = await fixture(t);
	models.streamSimple = () => { throw new Error("weekly usage limit reached: token limit exceeded"); };
	const result = await adapter.models.completeSimple(model, { messages: [] }, { sessionId });
	assert.equal(result.errorMessage, PROVIDER_BLOCK_ERROR);
	assert.match((await host.harness.commit((tx) => readProviderBlock(tx, 1 as ConversationId), BACKGROUND_CONTEXT))?.error ?? "", /token limit exceeded/u);
});

it("keeps a one-shot terminal storage timeout outside provider error classification", async (t) => {
	const { host, models, adapter, model, sessionId } = await fixture(t);
	models.streamSimple = () => { const stream = createAssistantMessageEventStream(); stream.push({ type: "error", reason: "error", error: { ...answerMessage(), stopReason: "error", errorMessage: "usage limit reached" } }); stream.end(); return stream; };
	const commit = host.harness.commit.bind(host.harness); let commits = 0;
	host.harness.commit = async (callback, context) => { if (++commits === 3) throw new Error("timeout while retaining provider state"); return commit(callback, context); };
	const result = await adapter.models.completeSimple(model, { messages: [] }, { sessionId });
	host.harness.commit = commit;
	assert.equal(result.errorMessage, "Agent host: provider state failure; inspect retained state."); assert.equal(commits, 3);
	assert.equal(await host.harness.commit((tx) => readProviderBlock(tx, 1 as ConversationId), BACKGROUND_CONTEXT), undefined);
});

it("retains deferred identity across reopen and guards polls without a sessionId", async (t) => {
	const { host, models, adapter, model, sessionId, storagePath } = await fixture(t);
	const handle = { provider: model.provider, modelId: model.id, api: model.api, id: "deferred-one" };
	models.streamSimple = () => { const stream = createAssistantMessageEventStream(); const message = { ...answerMessage(), stopReason: "deferred" as const, deferred: handle }; stream.push({ type: "done", reason: "deferred", message }); stream.end(); return stream; };
	assert.equal((await adapter.models.completeSimple(model, { messages: [] }, { sessionId })).stopReason, "deferred");
	let calls = 0; models.fetchDeferred = async () => { calls++; return { ...answerMessage(), stopReason: "error", errorMessage: "insufficient credit balance" }; };
	await host.close();
	const reopened = await DurableHost.open({ ...hostOptions(storagePath, models, fixtureRegistry()), resume: false });
	try {
		const fresh = new ProviderModels(models, () => reopened.harness, reopened.storageId); fresh.bind();
		try {
			assert.equal((await fresh.models.fetchDeferred(model, handle)).errorMessage, PROVIDER_BLOCK_ERROR);
			assert.equal((await fresh.models.fetchDeferred(model, handle)).errorMessage, PROVIDER_BLOCK_ERROR); assert.equal(calls, 1);
			assert.equal((await fresh.models.fetchDeferred(model, { ...handle, provider: "wrong" })).errorMessage, "Agent host: provider state failure; inspect retained state."); assert.equal(calls, 1);
			await reopened.request("configure", { model: { provider: model.provider, modelId: model.id } });
			assert.equal((await fresh.models.fetchDeferred(model, handle)).errorMessage, STALE_PROVIDER_ERROR); assert.equal(calls, 1);
		} finally { fresh.close(); }
	} finally { await reopened.close(); }
});

it("replays an authorized notice after native admission failure without a duplicate wake", async (t) => {
	const { host } = await fixture(t);
	await host.submit({ message: "original held request", requestId: "held-request" });
	const notice = { fact: { sessionId: "producer", observedAt: Date.now(), source: "producer await-state" as const, execution: { state: "provider-retry" as const, runId: 77, attempt: 1, nextRetryAt: Date.now() + 100000, error: "429 too many requests", errorTruncated: false, results: [{ sessionId: "producer", submissionId: 55, requestId: "producer-request" }] } } };
	const conversation = await host.harness.conversation(1 as ConversationId, BACKGROUND_CONTEXT); assert.ok(conversation);
	const params = { message: "nonterminal provider retry", requestId: providerNoticeRequestId(host.storageId, notice), providerRetry: notice, whenBusy: "followUp" as const, provenance: { classification: "report" as const, sender: "producer" } };
	const submit = conversation.submit.bind(conversation); conversation.submit = async () => { throw new Error("injected native admission failure"); };
	await assert.rejects(submitConversation(conversation, params, BACKGROUND_CONTEXT), /injected native admission failure/u);
	conversation.submit = submit;
	const admitted = await submitConversation(conversation, params, BACKGROUND_CONTEXT);
	const replay = await submitConversation(conversation, params, BACKGROUND_CONTEXT);
	assert.equal(admitted.submissionId, replay.submissionId); assert.equal(replay.deduped, true);
	assert.equal((await host.harness.inspect(BACKGROUND_CONTEXT)).submissions.filter((submission) => submission.requestId === params.requestId).length, 1);
});

it("keeps deferred blocks isolated between conversations on the same model after reopen", async (t) => {
	const { host, models, adapter, model, sessionId, storagePath } = await fixture(t);
	const second = await host.harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: { provider: model.provider, modelId: model.id } } }, BACKGROUND_CONTEXT);
	const secondProvider = await host.harness.snapshot(ProviderDoc, second.id, BACKGROUND_CONTEXT); assert.ok(secondProvider); assert.notEqual(secondProvider.sessionId, sessionId);
	const blockedHandle = { provider: model.provider, modelId: model.id, api: model.api, id: "blocked-conversation" };
	const healthyHandle = { ...blockedHandle, id: "healthy-conversation" };
	models.streamSimple = (_model, _context, options) => { const stream = createAssistantMessageEventStream(); const message = { ...answerMessage(), stopReason: "deferred" as const, deferred: options?.sessionId === sessionId ? blockedHandle : healthyHandle }; stream.push({ type: "done", reason: "deferred", message }); stream.end(); return stream; };
	await adapter.models.completeSimple(model, { messages: [] }, { sessionId });
	await adapter.models.completeSimple(model, { messages: [] }, { sessionId: secondProvider.sessionId });
	await host.harness.commit(async (tx) => { const attempt = await captureProviderAttempt(tx, sessionId, { provider: model.provider, modelId: model.id }); await retainProviderBlock(tx, attempt, "weekly usage limit exhausted", host.storageId, Date.now()); }, BACKGROUND_CONTEXT);
	let polls = 0; models.fetchDeferred = async (_model, handle) => { polls++; assert.equal(handle.id, healthyHandle.id); return answerMessage("healthy deferred answer"); };
	await host.close();
	const reopened = await DurableHost.open({ ...hostOptions(storagePath, models, fixtureRegistry()), resume: false });
	try {
		const fresh = new ProviderModels(models, () => reopened.harness, reopened.storageId); fresh.bind();
		try {
			assert.equal((await fresh.models.fetchDeferred(model, blockedHandle)).errorMessage, PROVIDER_BLOCK_ERROR); assert.equal(polls, 0);
			assert.equal((await fresh.models.fetchDeferred(model, healthyHandle)).stopReason, "stop"); assert.equal(polls, 1);
			assert.ok(await reopened.harness.commit((tx) => readProviderBlock(tx, 1 as ConversationId), BACKGROUND_CONTEXT));
			assert.equal(await reopened.harness.commit((tx) => readProviderBlock(tx, second.id), BACKGROUND_CONTEXT), undefined);
		} finally { fresh.close(); }
	} finally { await reopened.close(); }
});

it("rejects conflicting deferred identity bindings while exact replay remains idempotent", async (t) => {
	const { host, model, sessionId } = await fixture(t);
	const handle = { provider: model.provider, modelId: model.id, api: model.api, id: "exact-handle" };
	const attempt = await host.harness.commit((tx) => captureProviderAttempt(tx, sessionId, { provider: model.provider, modelId: model.id }), BACKGROUND_CONTEXT);
	await host.harness.commit((tx) => retainDeferredAttempt(tx, attempt, handle), BACKGROUND_CONTEXT);
	await host.harness.commit((tx) => retainDeferredAttempt(tx, { ...attempt }, { ...handle }), BACKGROUND_CONTEXT);
	for (const conflict of [{ ...attempt, epoch: attempt.epoch + 1 }, { ...attempt, inputs: [123 as SubmissionId] }, { ...attempt, providerSessionId: "other-session" }, { ...attempt, conversationId: 2 as ConversationId }]) await assert.rejects(host.harness.commit((tx) => retainDeferredAttempt(tx, conflict, handle), BACKGROUND_CONTEXT), /conflicting native request identities/u);
	await assert.rejects(host.harness.commit((tx) => retainDeferredAttempt(tx, attempt, { ...handle, provider: "other-provider" }), BACKGROUND_CONTEXT), /does not match/u);
	await assert.rejects(host.harness.commit((tx) => readDeferredAttempt(tx, model, { ...handle, modelId: "other-model" }), BACKGROUND_CONTEXT), /does not match/u);
	await assert.rejects(host.harness.commit((tx) => readDeferredAttempt(tx, model, { ...handle, api: "anthropic-messages" }), BACKGROUND_CONTEXT), /no retained native request identity/u);
	assert.deepEqual(await host.harness.commit((tx) => readDeferredAttempt(tx, model, handle), BACKGROUND_CONTEXT), attempt);
});

it("preserves an original blocked outcome on request replay and links only a new recovery admission", async (t) => {
	const { host, models, model } = await fixture(t);
	let calls = 0;
	models.streamSimple = () => { const stream = createAssistantMessageEventStream(); const message = ++calls === 1 ? { ...answerMessage(), stopReason: "error" as const, errorMessage: "insufficient_quota" } : answerMessage("new recovery work"); stream.push({ type: "done", reason: "stop", message }); stream.end(); return stream; };
	const original = await host.submit({ message: "original work", requestId: "immutable-original" });
	const before = await host.wait(original.submissionId); assert.equal(before.status, "unanswered"); assert.equal(before.reason, "model_error"); assert.equal(before.recoveryOf, undefined); assert.ok(before.providerBlock);
	await host.request("configure", { model: { provider: model.provider, modelId: model.id } });
	const replay = await host.submit({ message: "original work", requestId: "immutable-original" });
	assert.equal(replay.submissionId, original.submissionId); assert.equal(replay.deduped, true); assert.deepEqual(await host.wait(replay.submissionId), before); assert.equal(calls, 1);
	const recovery = await host.submit({ message: "new recovery work", requestId: "new-recovery" });
	const result = await host.wait(recovery.submissionId); assert.equal(result.status, "done"); assert.equal(result.recoveryOf, before.providerBlock.blockId); assert.notEqual(recovery.submissionId, original.submissionId);
	assert.equal((await host.wait(original.submissionId)).recoveryOf, undefined);
});
