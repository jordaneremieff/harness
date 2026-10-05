import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { Harness, InboxDoc, type Conversation } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { createAssistantMessageEventStream, type TranscriptContext } from "@earendil-works/pi-ai";
import { DurableHost } from "./durable-host.ts";
import { recoverStrandedInputs } from "./stranded-inputs.ts";
import { answerMessage, completed, fixtureRegistry, hostOptions } from "./durable-host-fixture.mts";
import { createTestRuntime, testModel } from "./test-runtime.mts";

function defer() { let resolve!: () => void; const promise = new Promise<void>((done) => { resolve = done; }); return { promise, resolve }; }
const failure = () => ({ ...answerMessage(), stopReason: "error" as const, errorMessage: "synthetic connection failure" });

async function provider(failures = 1) {
	const runtime = await createTestRuntime();
	const started = defer(), release = defer();
	const contexts: TranscriptContext[] = [];
	let calls = 0;
	const stream = (_model: unknown, transcript: TranscriptContext) => {
		contexts.push(transcript);
		const index = calls++;
		if (index !== 0) return completed(index < failures ? failure() : answerMessage());
		const events = createAssistantMessageEventStream();
		started.resolve();
		void release.promise.then(() => { const message = failure(); events.push({ type: "error", reason: "error", error: message }); events.end(message); });
		return events;
	};
	runtime.registerNativeProvider({ id: testModel.provider, name: "Recovery fixture", getModels: () => [testModel], auth: { apiKey: { name: "Synthetic", check: async () => ({ type: "api_key" }), resolve: async () => ({ auth: {} }) } }, stream, streamSimple: stream });
	return { runtime, started, release, contexts, calls: () => calls };
}

function rootPath(t: { after(fn: () => void): void }) { const root = mkdtempSync(join(tmpdir(), "queued-recovery-")); t.after(() => rmSync(root, { force: true, recursive: true })); return join(root, "storage.sqlite"); }
const settings = { retry: { enabled: false }, followUpMode: "one-at-a-time" as const };
async function queue(conversation: Conversation) {
	return Promise.all(["one", "two"].map((content) => conversation.submit({ type: "input", content, whenBusy: "followUp", requestId: content }, context)));
}
async function recoveryEntries(conversation: Conversation) { return (await conversation.entries({}, 100, undefined, context)).items.filter((entry) => entry.kind === "agent.recovery"); }

it("recovers queued follow-ups after a model error and tells the model the facts", { timeout: 10000 }, async (t) => {
	const p = await provider();
	const host = await DurableHost.open({ ...hostOptions(rootPath(t), p.runtime, fixtureRegistry()), settings });
	t.after(() => host.close());
	const original = await host.root().submit({ type: "input", content: "first", requestId: "first" }, context);
	await p.started.promise;
	const queued = await queue(host.root());
	p.release.resolve();
	assert.equal((await original.wait(context)).status, "unanswered");
	for (const input of queued) assert.equal((await input.wait(context)).status, "done");
	await host.root().waitForIdle(context);
	assert.equal((await recoveryEntries(host.root())).length, 1);
	assert.match(JSON.stringify(p.contexts[1]), /previous run ended with a model error.*synthetic connection failure/u);
	assert.equal(p.calls(), 3);
});

it("does not recover withdrawn inputs after an abort", { timeout: 10000 }, async (t) => {
	const p = await provider();
	const host = await DurableHost.open({ ...hostOptions(rootPath(t), p.runtime, fixtureRegistry()), settings });
	t.after(() => host.close());
	await host.root().submit({ type: "input", content: "first" }, context);
	await p.started.promise;
	const queued = await queue(host.root());
	const aborted = host.root().abort(context);
	p.release.resolve();
	await aborted;
	for (const input of queued) assert.equal((await input.wait(context)).reason, "aborted");
	assert.equal((await recoveryEntries(host.root())).length, 0);
	assert.equal(p.calls(), 1);
});

it("reopens a stranded native queue once and deduplicates replay", { timeout: 10000 }, async (t) => {
	const path = rootPath(t), p = await provider();
	const harness = await Harness.open(await openNodeSqliteStorage(path), { models: p.runtime, registry: fixtureRegistry(), settings }, context);
	const conversation = await harness.root(context, { agent: { model: { provider: testModel.provider, modelId: testModel.id } } });
	const original = await conversation.submit({ type: "input", content: "first" }, context);
	await p.started.promise;
	const queued = await queue(conversation);
	p.release.resolve();
	await original.wait(context);
	await conversation.waitForIdle(context);
	assert.equal((await harness.snapshot(InboxDoc, conversation.id, context))?.items.length, 2);
	const ids = queued.map((submission) => submission.id);
	await harness.close(context);
	const host = await DurableHost.open({ ...hostOptions(path, p.runtime, fixtureRegistry()), settings });
	for (const id of ids) {
		const input = await host.harness.submission(id, context);
		assert.ok(input);
		assert.equal((await input.wait(context)).status, "done");
	}
	await recoverStrandedInputs(host.root(), context);
	await host.root().waitForIdle(context);
	assert.equal((await recoveryEntries(host.root())).length, 1);
	await host.close();
	const reopened = await DurableHost.open({ ...hostOptions(path, p.runtime, fixtureRegistry()), settings });
	t.after(() => reopened.close());
	assert.equal((await recoveryEntries(reopened.root())).length, 1);
	assert.equal(p.calls(), 3);
});

it("deduplicates concurrent recovery from the same ended native generation", { timeout: 10000 }, async (t) => {
	const p = await provider();
	const harness = await Harness.open(await openNodeSqliteStorage(rootPath(t)), { models: p.runtime, registry: fixtureRegistry(), settings }, context);
	t.after(() => harness.close(context));
	const conversation = await harness.root(context, { agent: { model: { provider: testModel.provider, modelId: testModel.id } } });
	const original = await conversation.submit({ type: "input", content: "first" }, context);
	await p.started.promise;
	const queued = await queue(conversation);
	p.release.resolve();
	await original.wait(context);
	await conversation.waitForIdle(context);
	await Promise.all([recoverStrandedInputs(conversation, context), recoverStrandedInputs(conversation, context)]);
	for (const input of queued) assert.equal((await input.wait(context)).status, "done");
	await conversation.waitForIdle(context);
	assert.equal((await recoveryEntries(conversation)).length, 1);
	assert.equal(p.calls(), 3);
});

it("does not create a recovery loop when successive queued runs fail", { timeout: 10000 }, async (t) => {
	const p = await provider(3);
	const host = await DurableHost.open({ ...hostOptions(rootPath(t), p.runtime, fixtureRegistry()), settings });
	t.after(() => host.close());
	const original = await host.root().submit({ type: "input", content: "first" }, context);
	await p.started.promise;
	const queued = await queue(host.root());
	p.release.resolve();
	await original.wait(context);
	for (const input of queued) assert.equal((await input.wait(context)).reason, "model_error");
	await host.root().waitForIdle(context);
	assert.equal((await recoveryEntries(host.root())).length, 2);
	assert.equal((await host.harness.snapshot(InboxDoc, host.root().id, context))?.items.length, 0);
	assert.equal(p.calls(), 3);
});

it("an abort between detection and passive admission cannot revive withdrawn inputs", { timeout: 10000 }, async (t) => {
	const p = await provider();
	const harness = await Harness.open(await openNodeSqliteStorage(rootPath(t)), { models: p.runtime, registry: fixtureRegistry(), settings }, context);
	t.after(() => harness.close(context));
	const conversation = await harness.root(context, { agent: { model: { provider: testModel.provider, modelId: testModel.id } } });
	const original = await conversation.submit({ type: "input", content: "first" }, context);
	await p.started.promise;
	const queued = await queue(conversation);
	p.release.resolve();
	await original.wait(context);
	await conversation.waitForIdle(context);
	const wrapped = new Proxy(conversation, { get(target, property) {
		if (property === "submit") return async (...args: Parameters<Conversation["submit"]>) => { await target.abort(context); return target.submit(...args); };
		const value = Reflect.get(target, property);
		return typeof value === "function" ? value.bind(target) : value;
	} });
	await recoverStrandedInputs(wrapped, context);
	for (const input of queued) assert.equal((await input.wait(context)).reason, "aborted");
	assert.equal(p.calls(), 1);
	assert.equal((await recoveryEntries(conversation)).length, 1, "the passive notice creates no user run");
});
