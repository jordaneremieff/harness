import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it, type TestContext } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import { GenerationTask, LiveDoc, ROOT_CONVERSATION_ID, defineExtension, hook, type EntryRecord } from "@earendil-works/pi-durable";
import { AgentCatalog } from "./catalog.ts";
import { mutateCollaboration, readCollaboration } from "./collaboration.ts";
import { onStoredCommit } from "./commit-observation.ts";
import { startDurableDelivery } from "./durable-delivery.ts";
import { DurableHost, type DurableHostOptions } from "./durable-host.ts";
import { answerMessage, completed, fixtureModelId, fixtureProvider, fixtureRegistry, hostOptions } from "./durable-host-fixture.mts";
import { resetConversation } from "./durable-reset.ts";
import { parseHostMetadata } from "./host-protocol.ts";
import { createTestRuntime, testModel } from "./test-runtime.mts";
import { THREAD_NOTICE_ENTRY_KIND, THREAD_NOTICE_READ_BYTES } from "./thread-notice-request.ts";

const STORAGE_ID = "55555555-5555-4555-8555-555555555555";
const frame = { title: "Parser contract", purpose: "Agree on the parser boundary", authority: "Operator task", source: "Current request", restrictions: "No publication", acceptance: "Review the boundary" };
const NOTE = /^Host-held continuity facts from the Agent extension for context head entry \d+\./u;
const RAW_PASSIVE = /Passive event fact; no reply or wake is requested\./u;

/** One storage path with a provider that records the hook chain's final messages; hosts open with the runtime's hook order. */
async function fixture(t: TestContext, replies: AssistantMessage[] = [], options: Partial<DurableHostOptions> = {}) {
	const root = mkdtempSync(join(tmpdir(), "thread-notice-request-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const storagePath = join(root, "host.sqlite");
	const chain: Message[][] = [];
	const queue = [...replies];
	const models = await createTestRuntime();
	models.registerNativeProvider({
		id: testModel.provider, name: "Thread notice fixture", getModels: () => [testModel],
		auth: { apiKey: { name: "Test", check: async () => ({ type: "api_key" }), resolve: async () => ({ auth: {} }) } },
		stream: () => { throw new Error("Unexpected stream"); },
		streamSimple: () => completed(queue.shift() ?? answerMessage("final answer")),
	});
	const open = async () => {
		const registry = fixtureRegistry();
		const host = await DurableHost.open({ ...hostOptions(storagePath, models, registry), storageId: STORAGE_ID, ...options, resume: false }, context);
		t.after(() => host.close().catch(() => undefined));
		registry.install(defineExtension({ name: "agent.continuity", hooks: [hook(GenerationTask, host.threadNoticeHooks()), hook(GenerationTask, host.continuityHooks())] }));
		registry.install(defineExtension({ name: "fixture-capture", hooks: [hook(GenerationTask, { beforeRequest(request) { chain.push(structuredClone([...request.messages])); return undefined; } })] }));
		const errors: Error[] = [];
		const watcher = startDurableDelivery({
			host,
			metadata: parseHostMetadata({ storageId: STORAGE_ID, cwd: root, agentDir: join(root, "agent"), packageDir: join(root, "package"), storagePath, model: { provider: fixtureProvider, modelId: fixtureModelId }, thinkingLevel: "off" }),
			catalog: new AgentCatalog(root),
			sessionsRoot: join(root, "sessions"),
			signal: new AbortController().signal,
			onError: (error) => { errors.push(error); },
		});
		t.after(() => watcher.close());
		await host.resume(context);
		return { host, watcher, errors };
	};
	return { chain, open };
}

/** Resolves on the stored commit that makes the condition true; no polling. */
function until(host: DurableHost, label: string, condition: () => Promise<boolean>): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		const timer = setTimeout(() => { unsubscribe(); reject(new Error(`not reached: ${label}`)); }, 10000);
		const check = (): void => {
			void condition().then((reached) => { if (reached) { clearTimeout(timer); unsubscribe(); resolve(); } }, reject);
		};
		const unsubscribe = onStoredCommit(host.harness, check);
		check();
	});
}
async function noticeEntries(host: DurableHost): Promise<EntryRecord[]> {
	const page = await host.root().entries({ order: "ascending" }, 200, undefined, context);
	return page.items.filter((entry) => entry.kind === THREAD_NOTICE_ENTRY_KIND);
}
function notices(host: DurableHost, count: number): Promise<void> {
	return until(host, `${count} thread notices`, async () => (await noticeEntries(host)).length === count);
}
function text(message: Message | undefined): string {
	if (message === undefined) return "";
	return typeof message.content === "string" ? message.content : JSON.stringify(message.content);
}
function ranges(messages: readonly Message[]): string[] {
	return messages.map(text).filter((value) => /passive event range/u.test(value));
}
function rawPassive(messages: readonly Message[]): number {
	return messages.filter((message) => RAW_PASSIVE.test(text(message))).length;
}
async function ask(host: DurableHost, message: string, requestId: string): Promise<void> {
	const submitted = await host.submit({ message, requestId });
	assert.equal((await host.wait(submitted.submissionId)).status, "done");
}

/** The root creates a thread and a second conversation of the storage joins it, so the root receives that peer's events. */
async function thread(host: DurableHost) {
	const other = await host.harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: { provider: fixtureProvider, modelId: fixtureModelId } } }, context);
	const peer = host.identity(other.id);
	const act = (action: string, requestId: string, fields: Record<string, unknown> = {}) => mutateCollaboration(host.harness, host.storageId, { action, requestId, senderIdentity: peer, origin: "model", ...fields }, context);
	const created = await mutateCollaboration(host.harness, host.storageId, { action: "create", requestId: "create", senderIdentity: host.storageId, origin: "model", ...frame }, context);
	const threadId = created.threadId;
	await act("join", "join", { threadId });
	return { threadId, post: (requestId: string, message: string, notify?: string[]) => act("post", requestId, { threadId, message, ...(notify === undefined ? {} : { notify }) }) };
}

it("sends three passive thread events as one frozen range after the continuity note and keeps that prefix when later events arrive", { timeout: 30000 }, async (t) => {
	const f = await fixture(t);
	const opened = await f.open();
	const { host, errors } = opened;
	assert.equal((await resetConversation(host.root(), { requestId: "reset", handoff: "Handoff before the thread." }, context)).status, "placed");
	const peer = await thread(host);
	await peer.post("post-1", "first contribution");
	await peer.post("post-2", "second contribution");
	await notices(host, 3);

	await ask(host, "first input", "input-1");
	const first = f.chain[0];
	assert.equal(first[0].role, "system");
	assert.match(text(first[1]), /Handoff before the thread\./u);
	assert.match(text(first[2]), NOTE, "the continuity note keeps its place directly after the head message");
	assert.equal(rawPassive(first), 0);
	assert.deepEqual(ranges(first).length, 1);
	const range = text(first[3]);
	assert.ok(range.startsWith(`Collaboration thread ${peer.threadId}, passive event range 2..4, frame revisions `), range);
	assert.match(range, new RegExp(`recipient ${STORAGE_ID}\\. Kinds: contribution, join; omitted kinds: 0\\. Coverage: complete\\.`, "u"));
	assert.ok(range.endsWith(`Read: agent_collaborate(${JSON.stringify({ action: "read", threadId: peer.threadId, before: 5, limit: 1 })}); follow nextBefore through event 2.`), range);
	assert.doesNotMatch(range, /agent_inspect/u);
	assert.equal(text(first[4]), "first input");
	const recovered = await readCollaboration(host.harness, { threadId: peer.threadId, before: 5, limit: 1 }, context);
	assert.deepEqual(recovered.events.map((event) => [event.sequence, event.message]), [[4, "second contribution"]], "the emitted read selects the retained newest event of the range");

	const stored = await noticeEntries(host);
	assert.equal(stored.length, 3);
	for (const entry of stored) assert.match(text(entry.model?.[0]), RAW_PASSIVE, "stored notices keep their own text");

	await peer.post("post-3", "third contribution");
	await notices(host, 4);
	await ask(host, "second input", "input-2");
	const second = f.chain[1];
	assert.deepEqual(second.slice(0, first.length), first, "the earlier range and every message before it keep their exact bytes and places");
	assert.equal(rawPassive(second), 0);
	assert.deepEqual(ranges(second).map((value) => /passive event range (\d+\.\.\d+)/u.exec(value)?.[1]), ["2..4", "5..5"], "an event after the freeze forms a later range");

	// A passive write without typed thread data has no source facts: it stays as its own message.
	await host.request("passive-submit", { message: "Plain passive text without thread data", requestId: "plain" });
	await ask(host, "third input", "input-3");
	const third = f.chain[2];
	assert.deepEqual(third.slice(0, second.length), second);
	assert.equal(third.filter((message) => text(message) === "Plain passive text without thread data").length, 1);

	// An addressed event stays an active input with its bounded body.
	const before = f.chain.length;
	await peer.post("post-4", "please review the boundary", [host.storageId]);
	await until(host, "the addressed event's run", async () => f.chain.length > before && (await host.harness.snapshot(LiveDoc, ROOT_CONVERSATION_ID, context))?.run === undefined);
	const fourth = f.chain.at(-1) ?? [];
	assert.deepEqual(fourth.slice(0, third.length), third);
	const active = fourth.filter((message) => /Your attention was requested\./u.test(text(message)));
	assert.equal(active.length, 1);
	assert.match(text(active[0]), /please review the boundary$/u);
	assert.doesNotMatch(text(active[0]), /agent_inspect|\[cut\]/u);
	assert.deepEqual(errors, []);
});

it("keeps a frozen range through a retry on a restarted host whose own bounded read is partial", { timeout: 30000 }, async (t) => {
	let now = Date.now();
	const error: AssistantMessage = { ...answerMessage(), content: [], stopReason: "error", errorMessage: "429 rate limit: too many requests" };
	const f = await fixture(t, [answerMessage("large answer"), answerMessage("small answer"), error, answerMessage("recovered")], { now: () => now, settings: { retry: { enabled: true, maxRetries: 20, baseDelayMs: 300000, maxAgentDelayMs: 300000 } }, retryMaxAttempts: 21 });
	const { host, watcher } = await f.open();
	// One stored input above the read's byte bound: a process that starts after it cannot examine the whole history.
	await ask(host, "x".repeat(THREAD_NOTICE_READ_BYTES + 1), "large");
	await ask(host, "small input", "small");
	const peer = await thread(host);
	await peer.post("post-1", "first contribution");
	await peer.post("post-2", "second contribution");
	await notices(host, 3);
	const submitted = await host.submit({ message: "task", requestId: "retried" });
	await until(host, "the retry wait", async () => (await host.harness.snapshot(LiveDoc, ROOT_CONVERSATION_ID, context))?.generation?.retry !== undefined);
	const first = f.chain.at(-1) ?? [];
	assert.deepEqual(ranges(first).length, 1);
	assert.match(ranges(first)[0], /passive event range 2\.\.4, .* Coverage: complete\./u, "this process examined every entry since its start");
	await watcher.close();
	await host.close();

	// The new process holds no frozen ranges; the task memo supplies the range of the first attempt.
	now += 600000;
	const attempts = f.chain.length;
	const reopened = await f.open();
	assert.equal((await reopened.host.wait(submitted.submissionId)).status, "done");
	assert.equal(f.chain.length, attempts + 1);
	assert.deepEqual(f.chain.at(-1), first, "the retry sends the first attempt's messages unchanged");
	await ask(reopened.host, "after the retry", "after");
	assert.deepEqual(ranges(f.chain.at(-1) ?? []), ranges(first), "the process keeps the range it took from the memo");
	await reopened.watcher.close();
	await reopened.host.close();

	// Without a memo or a retained range, a new process freezes the range again from its own bounded read.
	const later = await f.open();
	await ask(later.host, "on a later process", "later");
	const rebuilt = ranges(f.chain.at(-1) ?? []);
	assert.deepEqual(rebuilt.length, 1);
	assert.match(rebuilt[0], /passive event range 2\.\.4, .* Coverage: partial\./u);
	assert.equal(rawPassive(f.chain.at(-1) ?? []), 0);
});
