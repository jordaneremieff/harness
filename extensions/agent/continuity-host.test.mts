import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it, type TestContext } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import { GenerationTask, ROOT_CONVERSATION_ID, defineExtension, hook, type ConversationId, type GenerationHooks, type Report, type SubmissionId } from "@earendil-works/pi-durable";
import { AgentCatalog } from "./catalog.ts";
import { onStoredCommit } from "./commit-observation.ts";
import type { ContinuityFact } from "./continuity-facts.ts";
import { ContinuityDoc, recordContinuityFact } from "./continuity-native.ts";
import { NATIVE_COMPACTION_SEED } from "./control-guidance.ts";
import { deliveryState } from "./delivery-store.ts";
import { compactConversation } from "./durable-controls.ts";
import { startDurableDelivery } from "./durable-delivery.ts";
import { DurableHost, type DurableHostOptions, type RequestParams } from "./durable-host.ts";
import type { HostConnection } from "./host-client.ts";
import { HOST_CONTRACT } from "./version-contract.ts";
import { answerMessage, completed, fixtureModelId, fixtureProvider, fixtureRegistry, hostOptions, toolCallMessage } from "./durable-host-fixture.mts";
import { PLANNING_BUDGET_NOTICE_KIND } from "./capacity-reports.ts";
import { resetConversation } from "./durable-reset.ts";
import { TimerTask } from "./durable-timers.ts";
import { parseHostMetadata, type HostMetadata } from "./host-protocol.ts";
import { TASK_HOOK_REPORT_KIND } from "./task-hook-reports.ts";
import { createTestRuntime, testModel } from "./test-runtime.mts";

const HEADER = /^Host-held continuity facts from the Agent extension for context head entry (\d+)\./u;

function fixtureRoot(t: TestContext): string {
	const root = mkdtempSync(join(tmpdir(), "continuity-host-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	return root;
}

/** Provider requests and the hook chain's final messages, shared by every host a test opens. */
async function recorder(replies: AssistantMessage[] = []) {
	const provider: string[] = [];
	const chain: Message[][] = [];
	const queue = [...replies];
	const models = await createTestRuntime();
	models.registerNativeProvider({
		id: testModel.provider, name: "Continuity host fixture", getModels: () => [testModel],
		auth: { apiKey: { name: "Test", check: async () => ({ type: "api_key" }), resolve: async () => ({ auth: {} }) } },
		stream: () => { throw new Error("Unexpected stream"); },
		streamSimple: (_model, input) => {
			provider.push(JSON.stringify(input));
			return completed(queue.shift() ?? answerMessage("final answer"));
		},
	});
	return { models, provider, chain };
}

type OpenOptions = {
	readonly storageId?: string;
	readonly resume?: boolean;
	readonly hooks?: Partial<GenerationHooks>;
	readonly settings?: DurableHostOptions["settings"];
	readonly onReport?: (report: Report) => void;
	readonly planningBudget?: DurableHostOptions["planningBudget"];
};

/** Opens the host without scheduling, installs the hooks as the runtime does, then resumes unless told otherwise. */
async function openHost(t: TestContext, storagePath: string, recorded: Awaited<ReturnType<typeof recorder>>, options: OpenOptions = {}): Promise<DurableHost> {
	const registry = fixtureRegistry();
	if (options.hooks !== undefined) registry.install(defineExtension({ name: "fixture-hooks", hooks: [hook(GenerationTask, options.hooks)] }));
	const host = await DurableHost.open({
		...hostOptions(storagePath, recorded.models, registry),
		...(options.storageId === undefined ? {} : { storageId: options.storageId }),
		...(options.settings === undefined ? {} : { settings: options.settings }),
		...(options.onReport === undefined ? {} : { onReport: options.onReport }),
		...(options.planningBudget === undefined ? {} : { planningBudget: options.planningBudget }),
		resume: false,
	}, context);
	t.after(() => host.close().catch(() => undefined));
	registry.install(defineExtension({ name: "agent.continuity", hooks: [hook(GenerationTask, host.continuityHooks())] }));
	registry.install(defineExtension({ name: "fixture-capture", hooks: [hook(GenerationTask, { beforeRequest(request) { recorded.chain.push(structuredClone([...request.messages])); return undefined; } })] }));
	if (options.resume !== false) await host.resume(context);
	return host;
}

function text(message: Message | undefined): string {
	if (message === undefined) return "";
	return typeof message.content === "string" ? message.content : JSON.stringify(message.content);
}
function leadingSystems(messages: readonly Message[]): number { return messages[0]?.role === "system" ? 1 : 0; }
function noteIndexes(messages: readonly Message[]): number[] {
	return messages.flatMap((message, index) => message.role === "user" && HEADER.test(text(message)) ? [index] : []);
}
function noteHead(message: Message | undefined): number { return Number(HEADER.exec(text(message))?.[1]); }
async function ask(host: DurableHost, message: string, requestId: string): Promise<void> {
	const submitted = await host.submit({ message, requestId });
	assert.equal((await host.wait(submitted.submissionId)).status, "done");
}
function admitted(host: DurableHost, requestId: string, submissionId: number, conversationId: ConversationId = ROOT_CONVERSATION_ID): Promise<void> {
	const fact: ContinuityFact = { phase: "admitted", sessionId: "peer-storage", requestId, replyTo: host.identity(conversationId), submissionId };
	return host.harness.commit((tx) => recordContinuityFact(tx, conversationId, fact), context);
}
async function phases(host: DurableHost, conversationId: ConversationId = ROOT_CONVERSATION_ID): Promise<Map<string, string[]>> {
	const state = await host.harness.snapshot(ContinuityDoc, conversationId, context);
	const found = new Map<string, string[]>();
	for (const event of state?.events ?? []) found.set(event.requestId, [...found.get(event.requestId) ?? [], event.phase]);
	return found;
}

/** Resolves on the stored commit that acknowledges the receipt; no polling. */
function acknowledged(host: DurableHost, submissionId: SubmissionId): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		const timer = setTimeout(() => { unsubscribe(); reject(new Error("the receipt was not acknowledged")); }, 10000);
		const check = (): void => {
			void deliveryState(host.harness, context, true).then((state) => {
				if (state?.receipts[String(submissionId)]?.acknowledged !== true) return;
				clearTimeout(timer); unsubscribe(); resolve();
			}, reject);
		};
		const unsubscribe = onStoredCommit(host.harness, check);
		check();
	});
}

it("keeps one head's note bytes across a host restart and gives a new head a new note", { timeout: 30000 }, async (t) => {
	const storagePath = join(fixtureRoot(t), "restart.sqlite");
	const recorded = await recorder();
	const first = await openHost(t, storagePath, recorded);
	await admitted(first, "before-restart", 7);
	assert.equal((await resetConversation(first.root(), { requestId: "reset-1", handoff: "Handoff before the restart." }, context)).status, "placed");
	await ask(first, "first input", "input-1");
	const before = recorded.chain[0];
	const s = leadingSystems(before);
	assert.equal(s, 1);
	assert.deepEqual(noteIndexes(before), [s + 1]);
	assert.match(text(before[s + 1]), /"requestId":"before-restart"/u);
	assert.ok(recorded.provider[0].includes("Host-held continuity facts from the Agent extension"), "the provider request carries the note");
	await admitted(first, "after-head", 8);
	await first.close();

	// The first generation after the restart starts from a submission admitted before scheduling resumes.
	const second = await openHost(t, storagePath, recorded, { resume: false });
	const queued = await second.submit({ message: "input after restart", requestId: "input-2" });
	await second.resume(context);
	assert.equal((await second.wait(queued.submissionId)).status, "done");
	const after = recorded.chain[1];
	assert.deepEqual(after.slice(0, before.length), before, "the restarted host sends the same prefix, note included");
	assert.deepEqual(noteIndexes(after), [s + 1]);

	assert.equal((await resetConversation(second.root(), { requestId: "reset-2" }, context)).status, "placed");
	await ask(second, "input on the new head", "input-3");
	const renewed = recorded.chain[2];
	assert.deepEqual(noteIndexes(renewed), [leadingSystems(renewed)]);
	assert.ok(noteHead(renewed[leadingSystems(renewed)]) > noteHead(before[s + 1]));
	assert.match(text(renewed[leadingSystems(renewed)]), /"requestId":"after-head"/u);
});

it("places the note directly after the host's baseline system message when a reset has no handoff", { timeout: 30000 }, async (t) => {
	const recorded = await recorder();
	const host = await openHost(t, join(fixtureRoot(t), "empty-reset.sqlite"), recorded);
	assert.equal((await resetConversation(host.root(), { requestId: "reset" }, context)).status, "placed");
	await ask(host, "only input", "input");
	const request = recorded.chain[0];
	assert.equal(leadingSystems(request), 1, "the host context leads with its baseline system message without any extension section");
	assert.deepEqual(noteIndexes(request), [1]);
	assert.equal(text(request[2]), "only input");
	assert.equal(request.length, 3);
});

for (const resume of [false, true]) {
	it(`refuses to open on malformed retained continuity facts and sends no provider request (resume ${resume})`, { timeout: 30000 }, async (t) => {
		const storagePath = join(fixtureRoot(t), "malformed.sqlite");
		const recorded = await recorder();
		const seeded = await openHost(t, storagePath, recorded, { resume: false });
		await seeded.submit({ message: "pending work", requestId: "pending" });
		await seeded.harness.commit(async (tx) => {
			(await tx.doc(ContinuityDoc, ROOT_CONVERSATION_ID)).events.push({ phase: "requested", sessionId: "peer", requestId: "bad", replyTo: seeded.storageId, afterHead: -1 });
		}, context);
		await seeded.close();
		await assert.rejects(DurableHost.open({ ...hostOptions(storagePath, recorded.models, fixtureRegistry()), ...(resume ? {} : { resume: false }) }, context), /Invalid continuity head position/u);
		assert.equal(recorded.provider.length, 0);
		assert.equal(recorded.chain.length, 0);
	});
}

it("completes delivered facts for every tuple of a large group, also when the body admission is a replay", { timeout: 30000 }, async (t) => {
	const recorded = await recorder();
	const host = await openHost(t, join(fixtureRoot(t), "delivered.sqlite"), recorded);
	const tuples = Array.from({ length: 20 }, (_unused, index) => ({ sessionId: "peer-storage", requestId: `request-${index}`, submissionId: index + 1 }));
	for (const tuple of tuples) await admitted(host, tuple.requestId, tuple.submissionId);
	const body = { sessionId: host.storageId, message: "Agent result from peer-storage:1.", requestId: "delivery-1", provenance: { classification: "automatic" }, whenBusy: "followUp" };

	await assert.rejects(host.request("submit", { ...body, requestId: "delivery-invalid", deliveredResults: [{ sessionId: "peer-storage", requestId: "request-0", submissionId: 0 }] }), /Invalid continuity submission/u);
	assert.equal(await host.harness.commit((tx) => tx.submissionByRequest(ROOT_CONVERSATION_ID, "delivery-invalid"), context), undefined, "an invalid carrier admits no body");

	const first = await host.request("submit", { ...body, deliveredResults: tuples.slice(0, 10) }) as { submissionId: SubmissionId; deduped: boolean };
	assert.equal(first.deduped, false);
	assert.equal((await host.wait(first.submissionId)).status, "done");
	const partial = await phases(host);
	assert.deepEqual(tuples.map((tuple) => partial.get(tuple.requestId)?.includes("delivered")), [...Array<boolean>(10).fill(true), ...Array<boolean>(10).fill(false)]);

	const replay = await host.request("submit", { ...body, deliveredResults: tuples }) as { submissionId: SubmissionId; deduped: boolean };
	assert.equal(replay.submissionId, first.submissionId);
	assert.equal(replay.deduped, true);
	const complete = await phases(host);
	assert.ok(tuples.every((tuple) => complete.get(tuple.requestId)?.includes("delivered")), "the replay completes all twenty tuples");

	assert.equal((await resetConversation(host.root(), { requestId: "reset" }, context)).status, "placed");
	await ask(host, "after delivery", "input");
	const request = recorded.chain.at(-1) ?? [];
	const note = text(request[noteIndexes(request)[0] ?? -1]);
	assert.match(note, /with no delivered result here: none/u);
	assert.doesNotMatch(note, /request-\d+/u);
});

it("delivers a same-storage result with the child's observed context and completes the owner's delivered fact", { timeout: 30000 }, async (t) => {
	const root = fixtureRoot(t);
	const storagePath = join(root, "source.sqlite");
	const storageId = "11111111-1111-4111-8111-111111111111";
	const recorded = await recorder();
	const host = await openHost(t, storagePath, recorded, { storageId });
	const owner = await host.harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: { provider: fixtureProvider, modelId: fixtureModelId } } }, context);
	const produced = await host.request("submit", { sessionId: host.storageId, message: "do the task", requestId: "owned-request", ownerId: host.identity(owner.id), origin: "model" }) as { submissionId: SubmissionId };
	await host.harness.commit((tx) => recordContinuityFact(tx, owner.id, { phase: "admitted", sessionId: host.storageId, requestId: "owned-request", replyTo: host.identity(owner.id), submissionId: produced.submissionId }), context);
	await host.wait(produced.submissionId);
	const errors: Error[] = [];
	const watcher = startDurableDelivery({
		host,
		metadata: parseHostMetadata({ storageId, cwd: root, agentDir: join(root, "agent"), packageDir: join(root, "package"), storagePath, model: { provider: fixtureProvider, modelId: fixtureModelId }, thinkingLevel: "off" }),
		catalog: new AgentCatalog(root),
		sessionsRoot: join(root, "sessions"),
		signal: new AbortController().signal,
		onError: (error) => { errors.push(error); },
	});
	t.after(() => watcher.close());
	await acknowledged(host, produced.submissionId);
	const entries = await owner.entries({}, 20, undefined, context);
	const delivered = JSON.stringify(entries.items);
	assert.match(delivered, /Agent result from/u);
	assert.match(delivered, /Child context use: 12 of 128000 tokens \(0%, newest assistant usage\)\./u);
	assert.doesNotMatch(delivered, /The child returned no usable answer/u);
	assert.deepEqual((await phases(host, owner.id)).get("owned-request"), ["admitted", "delivered"]);
	assert.deepEqual(errors, []);
});

it("sends every result tuple to an owner in another storage, whose host completes its delivered fact", { timeout: 30000 }, async (t) => {
	const root = fixtureRoot(t);
	const sourcePath = join(root, "source.sqlite");
	const sourceId = "22222222-2222-4222-8222-222222222222";
	const record = new AgentCatalog(join(root, "catalog")).create({ cwd: root, agentDir: join(root, "target-agent"), packageDir: join(root, "target-package"), model: { provider: fixtureProvider, modelId: fixtureModelId }, thinkingLevel: "off", trust: true });
	const recorded = await recorder();
	const source = await openHost(t, sourcePath, recorded, { storageId: sourceId });
	const target = await openHost(t, join(root, "target.sqlite"), recorded, { storageId: record.storageId });
	const produced = await source.request("submit", { sessionId: sourceId, message: "do the task", requestId: "cross-request", ownerId: record.storageId, origin: "model" }) as { submissionId: SubmissionId };
	await target.harness.commit((tx) => recordContinuityFact(tx, ROOT_CONVERSATION_ID, { phase: "admitted", sessionId: sourceId, requestId: "cross-request", replyTo: record.storageId, submissionId: produced.submissionId }), context);
	await source.wait(produced.submissionId);
	const submits: Record<string, unknown>[] = [];
	const listeners = new Set<() => void>();
	let closed = false;
	const link: HostConnection = {
		pid: 7001, socketPath: join(root, "target.sock"), storageId: record.storageId, metadata: { storageId: record.storageId } as HostMetadata, runtimeContract: HOST_CONTRACT,
		get closed() { return closed; },
		async request(method, params) {
			if (method === "submit") submits.push(params as Record<string, unknown>);
			return target.request(method, params as RequestParams, context);
		},
		onClose(callback) { listeners.add(callback); return () => { listeners.delete(callback); }; },
		async close() { closed = true; for (const listener of [...listeners]) listener(); },
	};
	const errors: Error[] = [];
	const watcher = startDurableDelivery({
		host: source,
		metadata: parseHostMetadata({ storageId: sourceId, cwd: root, agentDir: join(root, "agent"), packageDir: join(root, "package"), storagePath: sourcePath, model: { provider: fixtureProvider, modelId: fixtureModelId }, thinkingLevel: "off" }),
		catalog: new AgentCatalog(join(root, "other-catalog")),
		signal: new AbortController().signal,
		readTarget: () => record,
		connectTarget: async () => link,
		onError: (error) => { errors.push(error); },
	});
	t.after(() => watcher.close());
	await acknowledged(source, produced.submissionId);
	assert.equal(submits.length, 1);
	assert.deepEqual(submits[0].deliveredResults, [{ sessionId: sourceId, submissionId: produced.submissionId, requestId: "cross-request" }]);
	assert.match(String(submits[0].message), /Child context use: 12 of 128000 tokens/u);
	assert.deepEqual((await phases(target)).get("cross-request"), ["admitted", "delivered"]);
	assert.deepEqual(errors, []);
});

function withUsage(message: AssistantMessage, tokens: number): AssistantMessage {
	return { ...message, usage: { ...message.usage, input: tokens, output: 0, totalTokens: tokens } };
}

it("records one active window report and one budget report for a model-origin owner, and one own-budget notice", { timeout: 30000 }, async (t) => {
	const recorded = await recorder([
		withUsage(toolCallMessage("missing"), 50),
		withUsage(toolCallMessage("missing"), 120000),
		withUsage(toolCallMessage("missing"), 121000),
		withUsage(answerMessage("done"), 121500),
	]);
	const storagePath = join(fixtureRoot(t), "capacity.sqlite");
	const storageId = "44444444-4444-4444-8444-444444444444";
	const failures: Report[] = [];
	const host = await openHost(t, storagePath, recorded, { storageId, onReport: (report) => { failures.push(report); }, planningBudget: (provider, modelId) => provider === fixtureProvider && modelId === fixtureModelId ? 1000 : undefined });
	const owner = "33333333-3333-4333-8333-333333333333";
	const produced = await host.request("submit", { sessionId: host.storageId, message: "long task", requestId: "capacity-request", ownerId: owner, origin: "model" }) as { submissionId: SubmissionId };
	assert.equal((await host.wait(produced.submissionId)).status, "done");
	await host.root().waitForIdle(context);
	// An orderly close drains the observer; the reopened host then reads what it retained.
	await host.close();
	const reader = await openHost(t, storagePath, recorded, { storageId, resume: false });
	assert.deepEqual(failures, []);
	const reports = (await deliveryState(reader.harness, context, true))?.reports ?? [];
	const window = reports.filter((report) => report.requestId.startsWith("child-capacity:"));
	const budget = reports.filter((report) => report.requestId.startsWith("child-budget:"));
	assert.equal(window.length, 1);
	assert.equal(budget.length, 1);
	for (const report of [...window, ...budget]) {
		assert.equal(report.ownerId, owner);
		assert.notEqual(report.passive, true);
		assert.deepEqual(report.intervention?.producerResults, [{ sessionId: host.storageId, submissionId: produced.submissionId, requestId: "capacity-request" }]);
		assert.doesNotMatch(report.message, /done|Stash/u);
	}
	assert.match(window[0].message, /reported context use of 93% \(120000 of 128000 tokens, newest assistant usage\)/u);
	assert.match(budget[0].message, /at or above its planning budget of 1000/u);
	const entries = await reader.root().entries({}, 60, undefined, context);
	const notices = entries.items.filter((entry) => entry.kind === PLANNING_BUDGET_NOTICE_KIND);
	assert.equal(notices.length, 1);
	assert.match(JSON.stringify(notices[0].model), /at or above the planning budget of 1000/u);
});

it("retains a real task hook failure without changing the conversation's observed state", { timeout: 30000 }, async (t) => {
	const recorded = await recorder();
	const reports: Report[] = [];
	const host = await openHost(t, join(fixtureRoot(t), "hook-report.sqlite"), recorded, {
		hooks: { afterRun() { throw new Error("afterRun hook failed"); } },
		onReport: (report) => { reports.push(report); },
	});
	await ask(host, "work", "input");
	await host.root().waitForIdle(context);
	// The sink admitted its write when the scheduler reported; this commit follows it on the line.
	await host.harness.commit(() => undefined, context);
	const entries = await host.root().entries({}, 40, undefined, context);
	const retained = entries.items.filter((entry) => entry.kind === TASK_HOOK_REPORT_KIND);
	assert.equal(retained.length, 1);
	assert.equal(retained[0].model, undefined);
	assert.match(JSON.stringify(retained[0].data), /afterRun hook failed/u);
	assert.ok(retained[0].id > (entries.items.find((entry) => entry.kind === "pi.assistant")?.id ?? Number.MAX_SAFE_INTEGER), "the report follows the final answer");
	assert.ok(reports.some((report) => report.kind === "extension_error" && report.task !== undefined), "the caller's callback still receives the original report");
	const dashboard = await host.request("dashboard") as readonly { state: string }[];
	assert.equal(dashboard[0]?.state, "done");
	const history = await host.request("inspect", { sessionId: host.storageId, view: "history" });
	assert.match(JSON.stringify(history), /agent\.host-report/u);
});

it("seeds a native compaction with the continuity items before the caller's instructions", { timeout: 30000 }, async (t) => {
	const recorded = await recorder();
	const host = await openHost(t, join(fixtureRoot(t), "seed.sqlite"), recorded, { settings: { compaction: { keepRecentTokens: 1 } } });
	const escaped = (value: string): string => JSON.stringify(value).slice(1, -1);
	await ask(host, "work before compaction", "input-1");
	const withInstructions = await compactConversation(host.harness, host.root(), "Keep the file list.", true, context);
	assert.equal(withInstructions.status, "completed");
	assert.ok(recorded.provider.at(-1)?.includes(escaped(`Additional focus: ${NATIVE_COMPACTION_SEED}\n\nKeep the file list.`)));
	await ask(host, "more work", "input-2");
	const bare = await compactConversation(host.harness, host.root(), undefined, true, context);
	assert.equal(bare.status, "completed");
	assert.ok(recorded.provider.at(-1)?.includes(escaped(`Additional focus: ${NATIVE_COMPACTION_SEED}`)));
	assert.ok(!recorded.provider.at(-1)?.includes("Keep the file list."), "without caller instructions the seed stands alone");
});

it("names the same resolved identity in a timer's schedule receipt and its cancel receipt", { timeout: 30000 }, async (t) => {
	const recorded = await recorder();
	const registry = fixtureRegistry();
	registry.install(defineExtension({ name: "fixture-timers", tasks: [TimerTask] }));
	const host = await DurableHost.open({ ...hostOptions(join(fixtureRoot(t), "timers.sqlite"), recorded.models, registry), storageId: "66666666-6666-4666-8666-666666666666" }, context);
	t.after(() => host.close().catch(() => undefined));
	const other = await host.harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: { provider: fixtureProvider, modelId: fixtureModelId } } }, context);
	for (const sessionId of [host.storageId, host.identity(other.id)]) {
		const scheduled = await host.request("timer-schedule", { sessionId, message: "later", deliverAt: Date.now() + 3_600_000, mode: "followUp", origin: "model", ownerId: host.storageId, scheduleId: `schedule:${sessionId}`, requestId: `schedule:${sessionId}:delivery` }) as { timerId: number; identity: string };
		assert.equal(scheduled.identity, sessionId);
		const cancelled = await host.request("timer-cancel", { sessionId, timerId: scheduled.timerId }) as { status: string; identity: string };
		assert.equal(cancelled.status, "cancelled");
		assert.equal(cancelled.identity, scheduled.identity);
	}
});
