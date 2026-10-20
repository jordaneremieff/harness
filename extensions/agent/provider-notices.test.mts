import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { AgentDoc, LiveDoc, type ConversationId, type LiveState, type SubmissionId, type TaskId, type Tx, type Harness, type CommitPublication } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { AgentDeliveryDoc, settleDeliveries, type AgentDeliveryState } from "./durable-controls.ts";
import { DurableHost } from "./durable-host.ts";
import { answerMessage, fixtureRegistry, hostOptions, scriptedRuntime } from "./durable-host-fixture.mts";
import { eventLog } from "./host-fixture.mts";
import { ProviderRetryBurstDoc, ProviderRetryNotices, retainProviderRetryNotices } from "./provider-notices.ts";
import { RequestContextDoc, type RequestContext } from "./request-context.ts";

function fixture() {
	const conversationId = 1 as ConversationId;
	const ledger: AgentDeliveryState = { intents: [], receipts: {}, reports: [] };
	const state: ReturnType<typeof ProviderRetryBurstDoc.definition.initial> = { completedThrough: 0 };
	const routes: { requests: RequestContext[] } = { requests: [] };
	const live: LiveState = { run: { taskId: 10 as TaskId, inputs: [] }, generation: { attempt: 1, retry: { at: 100, error: "429 too many requests" } } };
	const inputs = new Map<string, { type: "input"; id: SubmissionId; status: "placed" }>();
	let outcome: "completed" | "failed" | "aborted" | "orphaned" | undefined;
	const tx = {
		doc: async (token: unknown) => {
			if (token === LiveDoc) return live;
			if (token === ProviderRetryBurstDoc) return state;
			if (token === AgentDeliveryDoc) return ledger;
			if (token === RequestContextDoc) return routes;
			if (token === AgentDoc) return { model: { provider: "fixture", modelId: "model" } };
			throw new Error("Unexpected document");
		},
		task: async () => outcome === undefined ? { state: { status: "running" } } : { state: { status: "terminal", outcome: { status: outcome } } },
		submissionByRequest: async (_conversationId: ConversationId, requestId: string) => inputs.get(requestId),
	} as unknown as Tx;
	const add = (ownerId = "actual-recipient", origin: "model" | "operator" = "model") => {
		const id = inputs.size + 1 as SubmissionId;
		const requestId = `request-${id}`;
		inputs.set(requestId, { type: "input", id, status: "placed" });
		routes.requests.push({ requestId, requester: "requester", replyTo: ownerId, origin });
		assert.ok(live.run); live.run.inputs.push(id);
		return id;
	};
	const retain = (observations?: readonly LiveState[]) => retainProviderRetryNotices(tx, "source", conversationId, 21, 50, observations);
	const end = (status: NonNullable<typeof outcome>) => { outcome = status; delete live.run; delete live.generation; };
	return { ledger, state, live, routes, tx, add, retain, end };
}

it("retains burst facts without a report through every backoff and in-flight attempt", async () => {
	const f = fixture(); f.add();
	await f.retain();
	assert.equal(f.ledger.reports.length, 0);
	assert.equal(f.state.active?.retries, 1);
	for (const attempt of [2, 3, 4]) {
		f.live.generation = { attempt }; await f.retain();
		f.live.generation.retry = { at: attempt * 100, error: "429 too many requests" }; await f.retain();
	}
	assert.equal(f.ledger.reports.length, 0);
	assert.equal(f.state.active?.retries, 4);
	assert.equal(f.state.active?.attempts, 4);
});

it("retains one failure summary with total attempts, retry count, and original recipient after route cleanup", async () => {
	const f = fixture(); f.add(); await f.retain();
	f.live.generation = { attempt: 2, retry: { at: 200, error: "provider transport failed" } }; await f.retain();
	f.routes.requests.length = 0;
	f.end("failed"); await f.retain(); await f.retain();
	assert.equal(f.ledger.reports.length, 1);
	const failure = f.ledger.reports[0];
	assert.equal(failure.ownerId, "actual-recipient"); assert.equal(failure.providerRetry, undefined);
	assert.match(failure.message, /End state: failed/u);
	assert.match(failure.message, /Generation attempts: 3\. Native retries: 2/u);
	assert.equal(failure.acknowledged, false);
	assert.equal(f.state.active, undefined);
});

it("success, explicit abort, and orphaned abort cleanup add no end report", async () => {
	for (const status of ["completed", "aborted", "orphaned"] as const) {
		const f = fixture(); f.add(); await f.retain(); f.end(status); await f.retain();
		assert.equal(f.ledger.reports.length, 0, status);
		assert.equal(f.state.active, undefined);
	}
});

it("groups oversized result sets by actual recipient and adds recipients admitted during a burst", async () => {
	const f = fixture();
	for (let index = 0; index < 20; index++) f.add();
	f.add("operator-recipient", "operator");
	await f.retain();
	assert.equal(f.ledger.reports.length, 0, "no preterminal report bypasses a native await threshold");
	f.add("later-recipient"); f.add(); await f.retain();
	assert.equal(f.ledger.reports.length, 0);
	f.end("failed"); await f.retain();
	assert.deepEqual(f.ledger.reports.map((report) => report.ownerId), ["actual-recipient", "later-recipient"]);
	assert.match(f.ledger.reports[0].message, /Omitted result references: 5/u);
});

it("does not send a preterminal report when a recipient group grows beyond the reference display bound", async () => {
	for (const added of [1, 16]) {
		const f = fixture(); f.add(); await f.retain();
		for (let index = 0; index < added; index++) f.add();
		await f.retain();
		assert.equal(f.ledger.reports.length, 0);
		f.end("failed"); await f.retain();
		assert.equal(f.ledger.reports.length, 1);
		assert.equal(f.ledger.reports[0].providerRetry, undefined);
		assert.equal(f.ledger.reports[0].acknowledged, false);
	}
});

it("a successful tool response ends one burst and the successor generation starts another", async () => {
	const f = fixture(); f.add(); await f.retain();
	delete f.live.generation; f.live.tools = []; await f.retain();
	const completedBurst = f.state.active;
	assert.equal(completedBurst, undefined);
	assert.ok(f.live.run); f.live.run.taskId = 20 as TaskId;
	delete f.live.tools; f.live.generation = { attempt: 1, retry: { at: 300, error: "429 too many requests" } };
	await f.retain();
	assert.equal(f.ledger.reports.length, 0);
	assert.equal(f.state.active?.runId, 20);
});

it("committed retry snapshots survive observation coalescing and stale replay does not duplicate reports", async () => {
	const f = fixture(); f.add();
	const snapshots = [structuredClone(f.live)];
	f.live.generation = { attempt: 2, retry: { at: 200, error: "second retry" } }; snapshots.push(structuredClone(f.live));
	f.end("failed"); await f.retain(snapshots); await f.retain(snapshots);
	assert.equal(f.ledger.reports.length, 1);
	assert.match(f.ledger.reports[0].message, /Generation attempts: 3\. Native retries: 2/u);
});

it("redacts and bounds provider evidence in the failure report", async () => {
	const f = fixture(); f.add();
	assert.ok(f.live.generation?.retry);
	f.live.generation.retry.error = `429 api_key=sk-abcdefghijklmnopqrstuv ${"x".repeat(1000)}`;
	await f.retain(); f.end("failed"); await f.retain();
	for (const report of f.ledger.reports) {
		assert.doesNotMatch(report.message, /abcdefghijkl/u);
		assert.match(report.message, /\[truncated\]/u);
	}
});

it("coalesces partial publications while a retention commit waits without losing the first or final retry", async () => {
	const f = fixture(); f.add();
	let listener: (publication: CommitPublication) => void = () => undefined;
	let release: () => void = () => undefined;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	const harness = {
		subscribeCommits: (callback: (publication: CommitPublication) => void) => { listener = callback; return () => { listener = () => undefined; }; },
		commit: async (callback: (tx: Tx) => unknown) => { await gate; return callback(f.tx); },
	} as unknown as Harness;
	const notices = new ProviderRetryNotices(harness, "source", undefined, (error) => { throw error; }, () => 50);
	const publish = () => listener({ changes: [{ type: "document", record: { kind: "pi.live" }, conversationId: 1 as ConversationId, value: structuredClone(f.live) }] } as unknown as CommitPublication);
	listener({ changes: [{ type: "document", record: { kind: "agent.request-context" }, conversationId: 1 as ConversationId, value: structuredClone(f.routes) }] } as unknown as CommitPublication);
	publish();
	for (let attempt = 2; attempt <= 3; attempt++) {
		f.live.generation = { attempt }; for (let index = 0; index < 1000; index++) publish();
		f.live.generation.retry = { at: attempt * 100, error: `retry ${attempt}` }; publish();
	}
	f.routes.requests.length = 0;
	listener({ changes: [{ type: "document", record: { kind: "agent.request-context" }, conversationId: 1 as ConversationId, value: { requests: [] } }] } as unknown as CommitPublication);
	f.end("failed"); publish();
	release(); await notices.close();
	assert.equal(f.ledger.reports.length, 1);
	assert.match(f.ledger.reports[0].message, /Generation attempts: 4\. Native retries: 3/u);
	assert.deepEqual(f.ledger.reports.map((report) => report.ownerId), ["actual-recipient"], "captured local routes survive cleanup before the first retention commit");
});

it("retention failure stops collection with an explicit reopen diagnostic and close retries pending facts", async () => {
	const f = fixture(); f.add();
	let listener: (publication: CommitPublication) => void = () => undefined;
	let unsubscribed = false;
	let fail = true;
	const errors = eventLog<unknown>();
	const harness = {
		subscribeCommits: (callback: (publication: CommitPublication) => void) => { listener = callback; return () => { unsubscribed = true; listener = () => undefined; }; },
		commit: async (callback: (tx: Tx) => unknown) => { if (fail) throw new Error("injected retention failure"); return callback(f.tx); },
	} as unknown as Harness;
	const notices = new ProviderRetryNotices(harness, "source", undefined, (error) => errors.push(error), () => 50);
	listener({ changes: [{ type: "document", record: { kind: "pi.live" }, conversationId: 1 as ConversationId, value: structuredClone(f.live) }] } as unknown as CommitPublication);
	await errors.waitForCount(1);
	assert.equal(unsubscribed, true);
	assert.match(String(errors[0]), /Retry observation stopped.*reopen the host/u);
	assert.equal(f.ledger.reports.length, 0);
	fail = false; await notices.close();
	assert.equal(f.ledger.reports.length, 0);
	assert.equal(f.state.active?.retries, 1);
});

it("reopens an active burst and retains one failure summary plus its separate native receipt", { timeout: 15000 }, async (t) => {
	const root = await mkdtemp(join(tmpdir(), "provider-retry-burst-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	let now = Date.now();
	const models = await scriptedRuntime([
		{ ...answerMessage(), stopReason: "error", errorMessage: "429 too many requests" },
		{ ...answerMessage(), stopReason: "error", errorMessage: "fatal invalid request" },
	]);
	const options = { ...hostOptions(join(root, "storage.sqlite"), models, fixtureRegistry()), now: () => now, settings: { retry: { enabled: true, maxRetries: 3, baseDelayMs: 100000, maxAgentDelayMs: 100000 } } };
	let host = await DurableHost.open(options);
	t.after(() => host.close());
	const starts = eventLog<void>();
	const unsubscribe = host.harness.subscribeCommits((publication) => {
		for (const change of publication.changes) if (change.type === "document" && change.record.kind === "agent.provider-retry-burst" && change.value !== null && change.value.active !== undefined) starts.push(undefined);
	});
	const admitted = await host.submit({ message: "retry work", requestId: "retry-work", ownerId: "actual-recipient", origin: "model" });
	await starts.waitForCount(1); unsubscribe();
	const first = await host.harness.snapshot(AgentDeliveryDoc, BACKGROUND_CONTEXT); assert.equal(first?.reports.length, 0);
	const active = await host.harness.snapshot(ProviderRetryBurstDoc, 1 as ConversationId, BACKGROUND_CONTEXT); assert.equal(active?.active?.retries, 1);
	const live = await host.harness.snapshot(LiveDoc, 1 as ConversationId, BACKGROUND_CONTEXT); assert.ok(live?.generation?.retry);
	await host.close();
	host = await DurableHost.open({ ...options, resume: false });
	assert.equal((await host.harness.snapshot(ProviderRetryBurstDoc, 1 as ConversationId, BACKGROUND_CONTEXT))?.active?.retries, 1);
	assert.equal((await host.harness.snapshot(AgentDeliveryDoc, BACKGROUND_CONTEXT))?.reports.length, 0);
	now = live.generation.retry.at + 1;
	const failures = eventLog<void>();
	const stop = host.harness.subscribeCommits((publication) => {
		for (const change of publication.changes) if (change.type === "document" && change.record.kind === "agent.delivery" && change.value !== null && Array.isArray(change.value.reports) && change.value.reports.length === 1) failures.push(undefined);
	});
	await host.resume();
	assert.equal((await host.wait(admitted.submissionId)).status, "unanswered");
	await failures.waitForCount(1); stop();
	await settleDeliveries(host.harness, BACKGROUND_CONTEXT);
	const ended = await host.harness.snapshot(AgentDeliveryDoc, BACKGROUND_CONTEXT);
	assert.equal(ended?.reports.length, 1);
	assert.equal(ended?.receipts[String(admitted.submissionId)]?.status, "unanswered");
	assert.match(ended?.reports[0].message ?? "", /Generation attempts: 2\. Native retries: 1/u);
	assert.equal(ended?.reports[0].acknowledged, false);
	assert.equal(ended?.reports[0].providerRetry, undefined);
	await host.close(); host = await DurableHost.open({ ...options, resume: false });
	assert.equal((await host.harness.snapshot(AgentDeliveryDoc, BACKGROUND_CONTEXT))?.reports.length, 1);
	assert.equal((await host.harness.snapshot(ProviderRetryBurstDoc, 1 as ConversationId, BACKGROUND_CONTEXT))?.active, undefined);
});
