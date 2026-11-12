import { onStoredCommit } from "./commit-observation.ts";
import { parseCommunication } from "./communication.ts";
import { receiptSourceIdentity, deliveryState as readRetainedDelivery, deliveryPendingCount, pendingDeliveryPage } from "./delivery-store.ts";
import { editDeliveryFixture } from "./delivery-store-fixture.mts";
import { DELIVERY_PAGE_SIZE, DeliveryRowDoc, storeDeliveryRow } from "./delivery-store.ts";
import { DELIVERY_WAKE_RECIPIENT_LIMIT, nativeRecipientAvailability } from "./delivery-wake.ts";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { it, type TestContext } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { LiveDoc, defineTool, type ConversationId, type EntryId, type SubmissionId, type ToolRegistration } from "@earendil-works/pi-durable";
import { obj } from "@earendil-works/pi-schema";
import { AgentCatalog } from "./catalog.ts";
import { ThreadDeliveryDoc, type AgentDeliveryState, recordReport, richSubmitConversation, settleDeliveries, undeliveredReports } from "./durable-controls.ts";
import { observeDeliveryEligibility, startDurableDelivery } from "./durable-delivery.ts";
import { mutateCollaboration } from "./collaboration.ts";
import { DurableHost, type RequestParams } from "./durable-host.ts";
import { retainProviderRetryNotices } from "./provider-notices.ts";
import { completeOpenWork, declareOpenWork, executeAgentWork } from "./open-work.ts";
import { readableControlText } from "./control-result.ts";
import { matchesSchema } from "./schema-check.ts";
import { answerMessage, fixtureModelId, fixtureProvider, fixtureRegistry, fixtureRuntime, gateTool, hostOptions, scriptedRuntime, toolCallMessage } from "./durable-host-fixture.mts";
import type { HostConnection } from "./host-client.ts";
import { eventLog, waitForProcessExit } from "./host-fixture.mts";
import { InspectOutputSchema, StatusOutputSchema, structuredObservation } from "./observation-schema.ts";
import type { HostMetadata } from "./host-protocol.ts";
import { parseHostMetadata } from "./host-protocol.ts";
import { HOST_CONTRACT } from "./version-contract.ts";
import { createPrimaryChannel, primaryEndpointPath, readPrimaryEndpointDescriptor, type PrimaryDelivery } from "./primary-channel.ts";

function fixtureRoot(t: { after(fn: () => void | Promise<void>): void }): string {
	const root = mkdtempSync(join(tmpdir(), "durable-delivery-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	return root;
}

async function openHost(storagePath: string, storageId: string, cwd: string): Promise<DurableHost> {
	return DurableHost.open(
		{
			storagePath,
			storageId,
			cwd,
			models: await fixtureRuntime("answer"),
			registry: fixtureRegistry(),
			agent: { model: { provider: fixtureProvider, modelId: fixtureModelId } },
		},
		BACKGROUND_CONTEXT,
	);
}

function sourceMetadata(root: string, storageId: string, storagePath: string): HostMetadata {
	return parseHostMetadata({
		storageId,
		cwd: root,
		agentDir: join(root, "agent"),
		packageDir: join(root, "package"),
		storagePath,
		model: { provider: fixtureProvider, modelId: fixtureModelId },
		thinkingLevel: "off",
	});
}

it("delivers one failure summary and native receipt when a delayed primary route returns", { timeout: 15000 }, async (t) => {
	const root = fixtureRoot(t); const sessionsRoot = join(root, "sessions"); const owner = randomUUID(); const sourceId = randomUUID(); const storagePath = join(root, "retry-retirement.sqlite");
	let now = Date.now();
	const models = await scriptedRuntime([{ ...answerMessage(), stopReason: "error", errorMessage: "429 too many requests" }, { ...answerMessage(), stopReason: "error", errorMessage: "fatal invalid request" }]);
	const options = { ...hostOptions(storagePath, models, fixtureRegistry()), storageId: sourceId, cwd: root, now: () => now, settings: { retry: { enabled: true, maxRetries: 3, baseDelayMs: 100000, maxAgentDelayMs: 100000 } } };
	let source = await DurableHost.open(options); t.after(() => source.close());
	const observed = eventLog<void>();
	const unsubscribe = onStoredCommit(source.harness, (publication) => { if (publication.changes.some((change) => change.type === "document" && change.kind === "change" && change.record.kind === "agent.provider-retry-burst" && change.value.active !== undefined)) observed.push(undefined); });
	const admitted = await source.submit({ message: "delayed route work", requestId: "delayed-retry", ownerId: owner, origin: "model" });
	await observed.waitForCount(1); unsubscribe();
	assert.equal((await deliveryState(source))?.reports.length, 0);
	const live = await source.harness.snapshot(LiveDoc, 1 as ConversationId, BACKGROUND_CONTEXT); assert.ok(live?.generation?.retry);
	now = live.generation.retry.at + 1;
	await source.close(); source = await DurableHost.open(options);
	assert.equal((await source.wait(admitted.submissionId)).status, "unanswered");
	await source.harness.commit((tx) => retainProviderRetryNotices(tx, sourceId, 1 as ConversationId, 4, now), BACKGROUND_CONTEXT);
	await settleDeliveries(source.harness, BACKGROUND_CONTEXT);
	const retained = (await deliveryState(source))?.reports[0]; assert.ok(retained); assert.equal(retained.acknowledged, false); assert.equal(retained.providerRetry, undefined); assert.match(retained.message, /End state: failed/u);
	const passes = eventLog<void>();
	const unavailable = startDurableDelivery({ host: source, metadata: sourceMetadata(root, sourceId, storagePath), catalog: new AgentCatalog(root), sessionsRoot, signal: new AbortController().signal, onIdle: () => passes.push(undefined) });
	try { await passes.waitForCount(1); assert.equal((await deliveryState(source))?.reports[0].acknowledged, false); }
	finally { await unavailable.close(); }
	const received = eventLog<PrimaryDelivery>();
	const channel = await createPrimaryChannel({ id: owner, cwd: root, sessionsRoot, deliver: async (message) => { received.push(message); }, promptTrust: async () => undefined }); t.after(() => channel.close());
	const restored = startDurableDelivery({ host: source, metadata: sourceMetadata(root, sourceId, storagePath), catalog: new AgentCatalog(root), sessionsRoot, signal: new AbortController().signal });
	try {
		await received.waitForCount(2);
		await waitForDelivery(source, async () => {
			const state = await deliveryState(source);
			return state?.receipts[String(admitted.submissionId)]?.acknowledged === true && state.reports.find((report) => report.sourceId === retained.sourceId)?.acknowledged === true;
		});
		assert.equal(received.length, 2);
		assert.deepEqual(received.map((message) => (message.details as Record<string, unknown>).kind).sort(), ["receipt", "report"]);
		assert.equal((await deliveryState(source))?.reports.filter((report) => report.sourceId === retained.sourceId).length, 1, "the burst identity remains retained for deduplication");
	} finally { await restored.close(); }
});

it("does not restart a delivery pass from its own empty commit", { timeout: 3000 }, async (t) => {
	const root = fixtureRoot(t);
	const storageId = randomUUID();
	const storagePath = join(root, "empty-commit.sqlite");
	const native = await openHost(storagePath, storageId, root);
	t.after(() => native.close());
	await settleDeliveries(native.harness, BACKGROUND_CONTEXT);
	const commits = t.mock.method(native.harness, "commit");
	const completed = eventLog<void>();
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const delivery = startDurableDelivery({ host: native, metadata: sourceMetadata(root, storageId, storagePath), catalog: new AgentCatalog(root), signal: new AbortController().signal, onIdle: () => completed.push(undefined) });
	try {
		t.mock.timers.tick(0);
		await completed.waitForCount(1);
		const count = commits.mock.callCount();
		t.mock.timers.tick(0);
		assert.equal(commits.mock.callCount(), count, "an empty settlement does not schedule another pass or reset host idle");
	} finally { await delivery.close(); }
});

interface SubmitRecord {
	params: Record<string, unknown>;
	requestId?: string;
	result: unknown;
}

/** A target link that forwards to a real Harness, optionally gated before admission. */
function fakeTarget(target: DurableHost, calls: SubmitRecord[], gate?: Promise<void>): HostConnection {
	let closed = false;
	const listeners = new Set<() => void>();
	return {
		pid: 7001,
		socketPath: "/tmp/fake-target.sock",
		storageId: target.storageId,
		metadata: { storageId: target.storageId } as HostMetadata,
		runtimeContract: HOST_CONTRACT,
		get closed() {
			return closed;
		},
		async request(method, params, options) {
			const record = params as Record<string, unknown>;
			const index =
				method === "submit"
					? calls.push({
							params: record,
							...(options?.requestId === undefined ? {} : { requestId: options.requestId }),
							result: undefined,
						}) - 1
					: -1;
			if (gate) await gate;
			const result = await target.request(method, params as RequestParams, BACKGROUND_CONTEXT);
			if (index >= 0)
				calls[index] = {
					params: record,
					...(options?.requestId === undefined ? {} : { requestId: options.requestId }),
					result,
				};
			return result;
		},
		onClose(callback) {
			listeners.add(callback);
			return () => {
				listeners.delete(callback);
			};
		},
		async close() {
			closed = true;
			for (const listener of [...listeners]) listener();
		},
	};
}

async function deliveryState(host: DurableHost) {
	return readRetainedDelivery(host.harness, BACKGROUND_CONTEXT, true);
}

/** A readable endpoint advertises an incompatible current delivery contract. */
function writeIncompatibleEndpoint(sessionsRoot: string, id: string, pid = process.pid): void {
	mkdirSync(join(sessionsRoot, ".primaries"), { recursive: true, mode: 0o700 });
	writeFileSync(
		primaryEndpointPath(sessionsRoot, id),
		JSON.stringify({
			version: "primary-delivery/9.0.0",
			id,
			serverId: randomUUID(),
			cwd: "/older/work",
			hostname: hostname(),
			pid,
			socketPath: join(sessionsRoot, ".primaries", "older.sock"),
			startedAt: new Date().toISOString(),
		}),
	);
}

function informationalSource(sourceId: string, recipient: string): string { return `${sourceId}:informational:${createHash("sha256").update(recipient).digest("hex")}`; }
async function receiptSourceId(host: DurableHost, submissionId: SubmissionId, informationalRecipient?: string): Promise<string> {
	await settleDeliveries(host.harness, BACKGROUND_CONTEXT);
	const receipt = (await deliveryState(host))?.receipts[String(submissionId)];
	assert.ok(receipt);
	const sourceId = receiptSourceIdentity(host.storageId, receipt);
	return informationalRecipient === undefined ? sourceId : informationalSource(sourceId, informationalRecipient);
}

/** Recheck delivery state only after native commit publications. */
async function waitForDelivery(host: DurableHost, predicate: () => Promise<boolean>, timeoutMs = 5000): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		let settled = false;
		let checking = false;
		let dirty = false;
		const finish = (error?: Error): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			unsubscribe();
			if (error) reject(error);
			else resolve();
		};
		const evaluate = async (): Promise<void> => {
			while (dirty && !settled) {
				dirty = false;
				if (await predicate()) finish();
			}
		};
		const resume = (): void => {
			checking = false;
			if (dirty && !settled) check();
		};
		const failed = (error: unknown): void => finish(error instanceof Error ? error : new Error(String(error)));
		const check = (): void => {
			dirty = true;
			if (checking || settled) return;
			checking = true;
			void evaluate().catch(failed).finally(resume);
		};
		const timer = setTimeout(() => finish(new Error("delivery commit did not reach the expected state")), timeoutMs);
		const unsubscribe = onStoredCommit(host.harness, check);
		check();
	});
}

async function addReceipt(source: DurableHost, ownerId: string, requestId = "source-receipt"): Promise<SubmissionId> {
	const admitted = (await source.request(
		"submit",
		{ sessionId: source.storageId, message: "do the task", requestId, ownerId, origin: "model" },
		BACKGROUND_CONTEXT,
	)) as { submissionId: SubmissionId };
	await source.wait(admitted.submissionId, BACKGROUND_CONTEXT);
	return admitted.submissionId;
}

it("uses the retained native target reader and connection before ordinary fallback, then closes their owner", { timeout: 10000 }, async t => {
	const root = fixtureRoot(t), sourceId = randomUUID();
	const targetCatalog = new AgentCatalog(join(root, "earlier-root"));
	const record = targetCatalog.create({ cwd: root, agentDir: join(root, "target-agent"), packageDir: join(root, "target-package"), model: { provider: fixtureProvider, modelId: fixtureModelId }, thinkingLevel: "off", trust: true });
	const source = await openHost(join(root, "source.sqlite"), sourceId, root);
	const target = await openHost(join(root, "target.sqlite"), record.storageId, root);
	t.after(async () => { await source.close(); await target.close(); });
	const calls: SubmitRecord[] = [], closed: boolean[] = [];
	const link = fakeTarget(target, calls);
	const reported = await recordReport(source.harness, { ownerId: record.storageId, senderIdentity: sourceId, message: "retained target report", requestId: "retained-source" }, BACKGROUND_CONTEXT);
	const delivery = startDurableDelivery({ host: source, metadata: sourceMetadata(root, sourceId, join(root, "source.sqlite")), catalog: new AgentCatalog(join(root, "new-root")), signal: new AbortController().signal,
		readTarget: identity => { assert.equal(identity, record.storageId); return record; },
		connectTarget: async value => { assert.equal(value, record); return link; },
		onClose: () => { closed.push(link.closed); },
	});
	try {
		await waitForDelivery(source, async () => (await deliveryState(source))?.reports.some(report => report.sourceId === reported.sourceId && report.acknowledged) === true);
		assert.equal(calls.length, 1);
		assert.equal(calls[0].params.sessionId, record.storageId);
		assert.deepEqual(calls[0].params.provenance, { classification: "report", sender: sourceId });
		assert.equal(calls[0].params.ownerId, undefined);
	} finally { await delivery.close(); }
	assert.deepEqual(closed, [true]);
});

it("does not broadcast an unresolved native delivery to ordinary primaries", { timeout: 10000 }, async t => {
	const root = fixtureRoot(t), sourceId = randomUUID(), missing = randomUUID(), sessionsRoot = join(root, "sessions");
	const source = await openHost(join(root, "unresolved.sqlite"), sourceId, root);
	t.after(() => source.close());
	const received: PrimaryDelivery[] = [];
	const ordinary = await createPrimaryChannel({ id: randomUUID(), cwd: root, sessionsRoot, deliver: message => { received.push(message); }, promptTrust: async () => undefined });
	t.after(() => ordinary.close());
	await recordReport(source.harness, { ownerId: missing, senderIdentity: sourceId, message: "native report", requestId: "unknown-native" }, BACKGROUND_CONTEXT);
	const errors = eventLog<Error>();
	const delivery = startDurableDelivery({ host: source, metadata: sourceMetadata(root, sourceId, join(root, "unresolved.sqlite")), catalog: new AgentCatalog(root), sessionsRoot, signal: new AbortController().signal,
		readTarget: () => { throw Object.assign(new Error("The exact native target is not retained"), { code: "ENOENT" }); }, onError: error => errors.push(error),
	});
	try {
		await errors.waitForCount(1);
		assert.match(errors[0].message, /exact native target is not retained/u);
		assert.deepEqual(received, []);
		assert.equal((await deliveryState(source))?.reports[0].acknowledged, false);
	} finally { await delivery.close(); }
});

function expectedRecipientGroup(recipients: string, original: number, steer: number) {
	return recipients === "same"
		? { ids: [original, steer], requests: ["original", "steer"], operations: ["first-operation", "steer-operation"], origins: ["operator", "model"] }
		: { ids: [original], requests: ["original"], operations: ["first-operation"], origins: ["operator"] };
}
for (const recipients of ["same", "overlap", "distinct"]) it(`groups a live steer with its answer for ${recipients} recipients`, { timeout: 30000 }, async (t) => {
	const root = fixtureRoot(t);
	const sessionsRoot = join(root, "sessions");
	const owner = randomUUID();
	const steerOwner = recipients === "same" ? owner : randomUUID();
	const received = eventLog<PrimaryDelivery>();
	let releaseTool = () => {};
	let releaseDelivery = () => {};
	const toolGate = new Promise<void>((resolve) => { releaseTool = resolve; });
	const deliveryGate = new Promise<void>((resolve) => { releaseDelivery = resolve; });
	t.after(() => { releaseTool(); releaseDelivery(); });
	// With an absent steering owner, fallback and direct delivery overlap at this recipient.
	const channel = await createPrimaryChannel({ id: owner, cwd: root, sessionsRoot,
		deliver: async (message) => { received.push(message); await deliveryGate; }, promptTrust: async () => undefined });
	t.after(() => channel.close());
	if (recipients === "distinct") {
		const other = await createPrimaryChannel({ id: steerOwner, cwd: root, sessionsRoot,
			deliver: (message) => { received.push(message); }, promptTrust: async () => undefined });
		t.after(() => other.close());
	}
	const started = eventLog<void>();
	const sourcePath = join(root, "source.sqlite");
	const source = await DurableHost.open({ storagePath: sourcePath, storageId: "11111111-1111-4111-8111-111111111111", cwd: root,
		models: await scriptedRuntime([toolCallMessage("gate"), answerMessage(), answerMessage()]),
		registry: fixtureRegistry([gateTool(toolGate, () => { started.push(undefined); })]),
		agent: { model: { provider: fixtureProvider, modelId: fixtureModelId } } }, BACKGROUND_CONTEXT);
	t.after(() => source.close());
	const revisions: AgentDeliveryState[] = [];
	const unsubscribe = onStoredCommit(source.harness, (publication) => {
		const receipts = { ...revisions.at(-1)?.receipts };
		let changed = false;
		for (const change of publication.changes) {
			if (change.type !== "document" || change.kind !== "change" || change.record.kind !== "agent.delivery-row" || change.value.kind !== "receipt" || change.value.value == null) continue;
			const receipt = JSON.parse(JSON.stringify(change.value.value)) as AgentDeliveryState["receipts"][string];
			receipts[String(receipt.submissionId)] = receipt;
			changed = true;
		}
		if (changed) revisions.push({ intents: [], receipts, reports: [] });
	});
	t.after(unsubscribe);
	const errors = eventLog<Error>();
	const watcher = startDurableDelivery({ host: source, metadata: sourceMetadata(root, source.storageId, sourcePath),
		catalog: new AgentCatalog(root), sessionsRoot, signal: new AbortController().signal, onError: (error) => errors.push(error) });
	t.after(() => watcher.close());
	const original = await source.request("submit", { message: "run", requestId: "original", operationId: "first-operation", ownerId: owner, origin: "operator" }, BACKGROUND_CONTEXT) as { submissionId: SubmissionId };
	await started.waitForCount(1);
	const steer = await source.request("submit", { message: "correct", requestId: "steer", operationId: "steer-operation", ownerId: steerOwner, whenBusy: "steer", origin: "model" }, BACKGROUND_CONTEXT) as { submissionId: SubmissionId };
	const ids = [original.submissionId, steer.submissionId];
	await source.harness.commit(async (tx) => editDeliveryFixture(tx, async (deliveryFixtureState) => {
		const state = deliveryFixtureState;
		const index = state.intents.findIndex((intent) => intent.requestId === "steer");
		const intent = state.intents[index];
		assert.ok(intent);
		state.intents[index] = { ...intent, submissionId: null };
	}), BACKGROUND_CONTEXT);
	releaseTool();
	await received.waitForCount(1);
	const pending = await deliveryState(source);
	assert.ok(ids.every((id) => pending?.receipts[String(id)]?.acknowledged === false));
	assert.equal(pending?.receipts[String(original.submissionId)]?.answerEntryId, pending?.receipts[String(steer.submissionId)]?.answerEntryId);
	const details = received[0]?.details as { deliveryRecipient: string; submissions: { submissionId: SubmissionId; requestId: string; operationId: string; ownerId: string; origin?: string }[]; wake?: unknown };
	const expected = expectedRecipientGroup(recipients, original.submissionId, steer.submissionId);
	assert.deepEqual(details.submissions.map((member) => member.submissionId), expected.ids);
	assert.deepEqual(details.submissions.map((member) => member.requestId), expected.requests);
	assert.deepEqual(details.submissions.map((member) => member.operationId), expected.operations);
	assert.deepEqual(details.submissions.map((member) => member.origin), expected.origins);
	const own = details.submissions.filter((member) => member.ownerId === details.deliveryRecipient);
	assert.equal(details.wake, own.some((member) => member.origin === "model"), "wake follows the recipient's own admissions");
	assert.match(received[0]?.text ?? "", /^Agent “11111111-1111-4111-8111-111111111111” completed native input\./u);
	assert.doesNotMatch(received[0]?.text ?? "", /submissions/u);
	releaseDelivery();
	if (recipients === "overlap") await received.waitForCount(2);
	await waitForDelivery(source, async () => ids.every((id) => revisions.at(-1)?.receipts[String(id)]?.acknowledged === (recipients !== "overlap" || id === original.submissionId)));
	assert.equal(received.length, recipients === "same" ? 1 : 2, "each recipient has an independent normal source; an informational source does not consume it");
	for (const delivery of received) {
		const messageDetails = delivery.details as { deliveryRecipient: string; submissions: Array<{ ownerId: string; origin?: string }>; wake?: unknown };
		const recipientOwn = messageDetails.submissions.filter((member) => member.ownerId === messageDetails.deliveryRecipient);
		assert.equal(messageDetails.wake, recipientOwn.some((member) => member.origin === "model"), `recipient ${messageDetails.deliveryRecipient} wakes only for its own model admissions`);
	}
	for (const revision of revisions) {
		const members = ids.flatMap((id) => revision.receipts[String(id)] ?? []);
		assert.ok(members.length === 0 || members.length === 2, "receipt materialization is atomic");
		if (recipients === "same") assert.ok(members.every((member) => member.acknowledged) || members.every((member) => !member.acknowledged), "one recipient's visited rows share their acknowledgement commit");
	}
	const later = await addReceipt(source, owner, "later-answer");
	await waitForDelivery(source, async () => (await deliveryState(source))?.receipts[String(later)]?.acknowledged === true);
	assert.equal(received.length, recipients === "same" ? 2 : 3, "equal text from a distinct answer entry remains a separate notice");
	assert.notEqual(received[0]?.sourceId, received.at(-1)?.sourceId);
	if (recipients !== "overlap") assert.deepEqual(errors, []);
});

for (const route of ["operator", "model", "fallback"] as const) it(`delivers a ${route} check-in through the report primary route`, { timeout: 30000 }, async (t) => {
	const root = fixtureRoot(t);
	const sessionsRoot = join(root, "sessions");
	const primary = randomUUID();
	const owner = route === "fallback" ? randomUUID() : primary;
	const received = eventLog<PrimaryDelivery>();
	let release!: () => void;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	const channel = await createPrimaryChannel({ id: primary, cwd: root, sessionsRoot,
		deliver: async (message) => { received.push(message); await gate; }, promptTrust: async () => undefined });
	t.after(() => channel.close());
	const sourcePath = join(root, "source.sqlite");
	const source = await openHost(sourcePath, "11111111-1111-4111-8111-111111111111", root);
	t.after(() => source.close());
	const checkIn = { conversationId: 1, requestId: "task", origin: route === "operator" ? "operator" as const : "model" as const, elapsedMs: 11_100_000, cost: 0.125 };
	const digest = "Tool calls: 4. Current tool: bash, 8 minutes since tool-call entry. Latest reply: tests in progress.";
	await source.harness.commit(async (tx) => editDeliveryFixture(tx, async (deliveryFixtureState) => {
		const state = deliveryFixtureState;
		const report = { sourceId: "checkin:task:1", requestId: "task", ownerId: owner, senderIdentity: source.storageId,
			message: digest, replyTo: null, acknowledged: false, createdAt: 1, checkIn };
		state.reports.push(report);
	}), BACKGROUND_CONTEXT);
	const watcher = startDurableDelivery({ host: source, metadata: sourceMetadata(root, source.storageId, sourcePath),
		catalog: new AgentCatalog(root), sessionsRoot, signal: new AbortController().signal });
	t.after(() => watcher.close());
	t.after(() => release());
	await received.waitForCount(1);
	assert.equal((await deliveryState(source))?.reports[0]?.acknowledged, false, "admission precedes acknowledgement");
	assert.equal((await deliveryState(source))?.reports[0]?.checkIn?.fallbackBroadcast, undefined, "an unaccepted broadcast records no flag");
	release();
	await waitForDelivery(source, async () => route === "fallback" ? (await deliveryState(source))?.reports[0]?.checkIn?.fallbackBroadcast === true : (await deliveryState(source))?.reports[0]?.acknowledged === true);
	const message = received[0];
	assert.equal(message.sourceId, route === "fallback" ? informationalSource("11111111-1111-4111-8111-111111111111:checkin:task:1", primary) : "11111111-1111-4111-8111-111111111111:checkin:task:1");
	const details = message.details as Record<string, unknown>;
	assert.equal(details.kind, "report");
	assert.equal(details.reportSourceId, "checkin:task:1");
	assert.equal(details.wake, route === "model");
	assert.deepEqual(details.checkIn, checkIn);
	assert.equal(details.originalOwnerId, owner);
	assert.equal(details.fallback, route === "fallback" ? true : undefined);
	const retained = (await deliveryState(source))?.reports[0];
	assert.equal(retained?.checkIn?.fallbackBroadcast, route === "fallback" ? true : undefined);
	assert.match(message.text, /still working.*not finished/u);
	assert.match(message.text, /3h05m.*\$0\.125 conversation total/u);
	assert.match(message.text, /\(check-in from 11111111-1111-4111-8111-111111111111; source checkin:task:1\)/u);
	assert.match(message.text, /Assess.*report progress.*let.*run.*steer.*abort/u);
	assert.match(message.text, /Steering cannot interrupt a running tool/u);
	assert.match(message.text, /Tool calls: 4/u);
	assert.doesNotMatch(message.text, /sent a report| finished\./u);
});

it("retains one accepted check-in fallback broadcast per watched task and owner", { timeout: 30000 }, async (t) => {
	const root = fixtureRoot(t);
	const sessionsRoot = join(root, "sessions");
	const primary = randomUUID();
	const owner = randomUUID();
	const received = eventLog<PrimaryDelivery>();
	let releaseFirst!: () => void;
	const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
	const channel = await createPrimaryChannel({ id: primary, cwd: root, sessionsRoot,
		deliver: async (message) => { received.push(message); if (received.length === 1) await firstGate; }, promptTrust: async () => undefined });
	t.after(async () => { releaseFirst(); await channel.close(); });
	const sourcePath = join(root, "source.sqlite");
	let source = await openHost(sourcePath, "11111111-1111-4111-8111-111111111111", root);
	let watcher: ReturnType<typeof startDurableDelivery> | undefined;
	t.after(async () => { await watcher?.close(); await source.close(); });
	const add = async (sourceId: string, requestId = "task", conversationId = 1, ownerId = owner): Promise<void> => {
		await source.harness.commit(async (tx) => editDeliveryFixture(tx, async (deliveryFixtureState) => {
			const state = deliveryFixtureState;
			const fallbackBroadcast = state.reports.some((report) => report.ownerId === ownerId && report.checkIn?.conversationId === conversationId && report.checkIn.requestId === requestId && report.checkIn.fallbackBroadcast === true);
			const checkIn = { ...(fallbackBroadcast ? { fallbackBroadcast: true } : {}), conversationId, requestId, origin: "model" as const, elapsedMs: 1_800_000, cost: null };
			state.reports.push({ sourceId, requestId: sourceId, ownerId, senderIdentity: source.storageId,
				message: "Task is active.", replyTo: null, acknowledged: false, createdAt: 1, checkIn });
		}), BACKGROUND_CONTEXT);
	};
	const start = () => startDurableDelivery({ host: source, metadata: sourceMetadata(root, source.storageId, sourcePath),
		catalog: new AgentCatalog(root), sessionsRoot, signal: new AbortController().signal });
	await add("checkin:task:1");
	watcher = start();
	await received.waitForCount(1);
	await source.harness.commit(async (tx) => editDeliveryFixture(tx, async (deliveryFixtureState) => {
		const state = deliveryFixtureState;
		state.reports.splice(0, 1);
	}), BACKGROUND_CONTEXT);
	await add("checkin:task:coalesced");
	releaseFirst();
	await waitForDelivery(source, async () => (await deliveryState(source))?.reports.find((report) => report.sourceId === "checkin:task:coalesced")?.checkIn?.fallbackBroadcast === true);
	const accepted = (await deliveryState(source))?.reports.find((report) => report.sourceId === "checkin:task:coalesced");
	assert.equal(accepted?.acknowledged, false);
	assert.equal(accepted?.checkIn?.fallbackBroadcast, true, "accepted delivery survives replacement of its pending row");
	assert.equal(received.length, 1, "the coalesced row uses the accepted broadcast instead of another notice");
	await watcher.close();
	await source.close();
	source = await openHost(sourcePath, "11111111-1111-4111-8111-111111111111", root);
	await add("checkin:task:2");
	watcher = start();
	await waitForDelivery(source, async () => (await deliveryState(source))?.reports.find((report) => report.sourceId === "checkin:task:2")?.checkIn?.fallbackBroadcast === true);
	assert.equal(received.length, 1, "a retained broadcast suppresses the next fallback after reopen");
	for (const [sourceId, requestId, conversationId, ownerId] of [
		["checkin:other-task:1", "other-task", 1, owner],
		["checkin:other-conversation:1", "task", 2, owner],
		["checkin:other-owner:1", "task", 1, randomUUID()],
	] as const) {
		await add(sourceId, requestId, conversationId, ownerId);
		await waitForDelivery(source, async () => (await deliveryState(source))?.reports.find((report) => report.sourceId === sourceId)?.checkIn?.fallbackBroadcast === true);
	}
	assert.equal(received.length, 4, "different watched tasks, conversations and owners each retain their own fallback");
	const direct = eventLog<PrimaryDelivery>();
	const ownerChannel = await createPrimaryChannel({ id: owner, cwd: root, sessionsRoot,
		deliver: (message) => { direct.push(message); }, promptTrust: async () => undefined });
	t.after(() => ownerChannel.close());
	await add("checkin:task:3");
	await direct.waitForCount(1);
	await waitForDelivery(source, async () => (await deliveryState(source))?.reports.find((report) => report.sourceId === "checkin:task:3")?.acknowledged === true);
	assert.equal((direct[0].details as { wake?: boolean }).wake, true, "the restored owning primary still receives live check-ins");
	assert.equal(received.length, 4, "the restored owner does not use fallback");
});

for (const route of ["catalog", "primary", "fallback"] as const) it(`drops a check-in that settles during ${route} route preparation`, { timeout: 30000 }, async (t) => {
	const root = fixtureRoot(t);
	const sessionsRoot = join(root, "sessions");
	const catalog = new AgentCatalog(root);
	const record = catalog.create({ cwd: root, agentDir: join(root, "agent"), packageDir: join(root, "package"),
		model: { provider: fixtureProvider, modelId: fixtureModelId }, thinkingLevel: "off", ownerId: "owner" });
	const primary = randomUUID();
	const owner = route === "catalog" ? `${record.storageId}:1` : route === "fallback" ? randomUUID() : primary;
	const received = eventLog<PrimaryDelivery>();
	const channel = await createPrimaryChannel({ id: primary, cwd: root, sessionsRoot,
		deliver: (message) => { received.push(message); }, promptTrust: async () => undefined });
	t.after(() => channel.close());
	let releaseTool!: () => void;
	const toolGate = new Promise<void>((resolve) => { releaseTool = resolve; });
	const started = eventLog<void>();
	const sourcePath = join(root, "source.sqlite");
	const source = await DurableHost.open({ storagePath: sourcePath, storageId: "11111111-1111-4111-8111-111111111111", cwd: root,
		models: await scriptedRuntime([toolCallMessage("gate"), answerMessage()]),
		registry: fixtureRegistry([gateTool(toolGate, () => started.push(undefined))]),
		agent: { model: { provider: fixtureProvider, modelId: fixtureModelId } } }, BACKGROUND_CONTEXT);
	const target = await openHost(record.storagePath, record.storageId, root);
	t.after(async () => { releaseTool(); await source.close(); await target.close(); });
	const admitted = await source.request("submit", { sessionId: source.storageId, message: "task", requestId: "watched-task" }, BACKGROUND_CONTEXT) as { submissionId: SubmissionId };
	await started.waitForCount(1);
	const checkIn = { conversationId: 1, requestId: "watched-task", origin: "model" as const, elapsedMs: 1_800_000, cost: 0.125 };
	await source.harness.commit(async (tx) => editDeliveryFixture(tx, async (deliveryFixtureState) => {
		const state = deliveryFixtureState;
		const report = { sourceId: "checkin:watched-task:1", requestId: "checkin:watched-task:1", ownerId: owner,
			senderIdentity: source.storageId, message: "Task is active.", replyTo: null, acknowledged: false, createdAt: 1, checkIn };
		state.reports.push(report);
	}), BACKGROUND_CONTEXT);
	const preparing = eventLog<void>();
	let releaseRoute!: () => void;
	const routeGate = new Promise<void>((resolve) => { releaseRoute = resolve; });
	const request = source.request.bind(source);
	if (route === "primary") source.request = async (method, params, context) => {
		if (method === "status") { preparing.push(undefined); await routeGate; }
		return request(method, params, context);
	};
	const calls = eventLog<SubmitRecord>();
	const passes = eventLog<Error | undefined>();
	const reportError = source.reportDeliveryError.bind(source);
	source.reportDeliveryError = (error) => { reportError(error); passes.push(error); };
	const watcher = startDurableDelivery({ host: source, metadata: sourceMetadata(root, source.storageId, sourcePath), catalog, sessionsRoot,
		signal: new AbortController().signal,
		acquire: async () => { preparing.push(undefined); await routeGate; return fakeTarget(target, calls); },
		listPrimaryChannels: async () => { preparing.push(undefined); await routeGate; return { ids: [primary], complete: true, visited: 1 }; } });
	t.after(async () => { releaseRoute(); await watcher.close(); });
	await preparing.waitForCount(1);
	releaseTool();
	await source.wait(admitted.submissionId, BACKGROUND_CONTEXT);
	releaseRoute();
	await waitForDelivery(source, async () => (await deliveryState(source))?.reports.some((report) => report.sourceId === "checkin:watched-task:1" && report.acknowledged) === true);
	assert.equal(calls.length, 0, "a settled check-in never admits a target follow-up");
	assert.equal(received.length, 0, "a settled check-in never reaches a primary");
	await passes.waitForCount(1);
	assert.equal(passes[0], undefined, "suppression ends the route without a delivery error");
	const retired = (await deliveryState(source))?.reports.find((report) => report.sourceId === "checkin:watched-task:1");
	assert.equal(retired?.acknowledged, true, "suppression retains its dedupe outcome without pending delivery");
	assert.equal(retired?.checkIn?.fallbackBroadcast, undefined, "suppression never records accepted fallback evidence");
	await watcher.close();
});

for (const origin of [undefined, "unknown"]) it(`holds a check-in with invalid stored origin ${origin} while other reports move`, { timeout: 30000 }, async (t) => {
	const root = fixtureRoot(t);
	const sessionsRoot = join(root, "sessions");
	const owner = randomUUID();
	const received = eventLog<PrimaryDelivery>();
	const channel = await createPrimaryChannel({ id: owner, cwd: root, sessionsRoot,
		deliver: (message) => { received.push(message); }, promptTrust: async () => undefined });
	t.after(() => channel.close());
	const sourcePath = join(root, "source.sqlite");
	const source = await openHost(sourcePath, "11111111-1111-4111-8111-111111111111", root);
	t.after(() => source.close());
	await source.harness.commit(async (tx) => editDeliveryFixture(tx, async (deliveryFixtureState) => {
		const state = deliveryFixtureState;
		const checkIn = { conversationId: 1, requestId: "task", elapsedMs: 1_800_000, cost: null,
			...(origin === undefined ? {} : { origin }) };
		state.reports.push({ sourceId: "checkin:task:1", requestId: "task", ownerId: owner, senderIdentity: source.storageId,
			message: "Task is active.", replyTo: null, acknowledged: false, createdAt: 1, checkIn } as unknown as AgentDeliveryState["reports"][number]);
		state.reports.push({ sourceId: "report:valid", requestId: "valid", ownerId: owner, senderIdentity: source.storageId,
			message: "Valid report.", replyTo: null, acknowledged: false, createdAt: 1 });
	}), BACKGROUND_CONTEXT);
	const errors = eventLog<Error>();
	const watcher = startDurableDelivery({ host: source, metadata: sourceMetadata(root, source.storageId, sourcePath),
		catalog: new AgentCatalog(root), sessionsRoot, signal: new AbortController().signal, onError: (error) => errors.push(error) });
	t.after(() => watcher.close());
	await received.waitForCount(1);
	await waitForDelivery(source, async () => (await deliveryState(source))?.reports.find((report) => report.sourceId === "report:valid")?.acknowledged === true);
	await watcher.close();
	assert.equal(received.length, 1, "a malformed check-in neither delivers nor chooses a wake default");
	assert.equal(received[0].sourceId, "11111111-1111-4111-8111-111111111111:report:valid");
	assert.equal((received[0].details as { wake?: boolean }).wake, true, "ordinary reports remain unaffected");
	assert.equal((await deliveryState(source))?.reports.find((report) => report.sourceId === "checkin:task:1")?.acknowledged, false);
	assert.ok(errors.length > 0);
	assert.ok(errors.every((error) => /checkin:task:1.*terminal: corrupt admission origin/u.test(error.message)));
});

for (const route of ["primary", "same-storage", "catalog"] as const) it(`delivers an exact long-answer continuation through the ${route} route`, { timeout: 10000 }, async (t) => {
	const root = fixtureRoot(t);
	const sessionsRoot = join(root, "sessions");
	const sourcePath = join(root, "source.sqlite");
	const answer = `${"x".repeat(17000)}EXACT-END`;
	const source = await DurableHost.open({ storagePath: sourcePath, storageId: "11111111-1111-4111-8111-111111111111", cwd: root,
		models: await scriptedRuntime([answerMessage(answer), answerMessage("RECEIVED")]), registry: fixtureRegistry(),
		agent: { model: { provider: fixtureProvider, modelId: fixtureModelId } } }, BACKGROUND_CONTEXT);
	t.after(() => source.close());
	const catalog = new AgentCatalog(root);
	const received = eventLog<PrimaryDelivery>();
	const nativeReceived = eventLog<RequestParams>();
	let owner = source.storageId;
	if (route === "primary") {
		owner = randomUUID();
		const channel = await createPrimaryChannel({ id: owner, cwd: root, sessionsRoot,
			deliver: (message) => { received.push(message); }, promptTrust: async () => undefined });
		t.after(() => channel.close());
	} else if (route === "catalog") {
		owner = catalog.create({ cwd: root, agentDir: join(root, "agent"), packageDir: join(root, "package"),
			model: { provider: fixtureProvider, modelId: fixtureModelId }, thinkingLevel: "off", ownerId: "requester" }).storageId;
	}
	const producer = await source.harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: { provider: fixtureProvider, modelId: fixtureModelId } } }, BACKGROUND_CONTEXT);
	if (route === "same-storage") {
		const request = source.request.bind(source);
		t.mock.method(source, "request", async (method: string, params?: RequestParams, context?: import("@earendil-works/chord/context").Context) => {
			if (method === "submit" && params?.sessionId === owner) nativeReceived.push(params);
			return request(method, params, context);
		});
	}
	const acquire = route === "catalog" ? async () => ({ closed: false, close: async () => {}, request: async (_method: string, params: RequestParams) => { nativeReceived.push(params); return { submissionId: 1, requestId: params.requestId, status: "queued" }; } }) as unknown as HostConnection : undefined;
	const submitted = await source.request("submit", { sessionId: `${source.storageId}:${producer.id}`, message: "Long result", requestId: "long-result", ownerId: owner, origin: "model" }, BACKGROUND_CONTEXT) as { submissionId: SubmissionId };
	const watcher = startDurableDelivery({ host: source, metadata: sourceMetadata(root, source.storageId, sourcePath), catalog, sessionsRoot,
		signal: new AbortController().signal, ...(acquire === undefined ? {} : { acquire }) });
	t.after(() => watcher.close());
	if (route === "primary") await received.waitForCount(1); else await nativeReceived.waitForCount(1);
	await waitForDelivery(source, async () => (await deliveryState(source))?.receipts[String(submitted.submissionId)]?.acknowledged === true);
	const receipt = (await deliveryState(source))?.receipts[String(submitted.submissionId)]; assert.ok(receipt);
	assert.equal(receipt.answer?.length, 1200);
	const continuation = { tool: "agent_inspect", sessionId: `${source.storageId}:${producer.id}`, view: "exact", entryId: receipt.answerEntryId, offset: 0 };
	const text = route === "primary" ? received[0].text : String(nativeReceived[0].message);
	assert.ok(text.includes(JSON.stringify(continuation))); assert.doesNotMatch(text, /EXACT-END/u);
	if (route === "primary") assert.deepEqual((received[0].details as { continuation: unknown }).continuation, continuation);
	let offset = 0; let retained = ""; let done = false;
	for (let page = 0; page < 8; page++) {
		const exact = await source.request("inspect", { sessionId: continuation.sessionId, view: "exact", entryId: continuation.entryId, offset }, BACKGROUND_CONTEXT) as { text: string; nextOffset: number | null };
		retained += exact.text;
		if (exact.nextOffset === null) { done = true; break; }
		offset = exact.nextOffset;
	}
	assert.equal(done, true); assert.ok(retained.includes(answer));
});

it("bounds a check-in digest while retaining the full source", { timeout: 30000 }, async (t) => {
	const root = fixtureRoot(t);
	const sessionsRoot = join(root, "sessions");
	const owner = randomUUID();
	const received = eventLog<PrimaryDelivery>();
	const channel = await createPrimaryChannel({ id: owner, cwd: root, sessionsRoot,
		deliver: (message) => { received.push(message); }, promptTrust: async () => undefined });
	t.after(() => channel.close());
	const sourcePath = join(root, "source.sqlite");
	const source = await openHost(sourcePath, "11111111-1111-4111-8111-111111111111", root);
	t.after(() => source.close());
	const digest = `${"x".repeat(15_999)}😀OMITTED`;
	const checkIn = { conversationId: 1, requestId: "task", origin: "model" as const, elapsedMs: 1_800_000, cost: null };
	await source.harness.commit(async (tx) => editDeliveryFixture(tx, async (deliveryFixtureState) => {
		const state = deliveryFixtureState;
		const report = { sourceId: "checkin:task:1", requestId: "task", ownerId: owner, senderIdentity: source.storageId,
			message: digest, replyTo: null, acknowledged: false, createdAt: 1, checkIn };
		state.reports.push(report);
	}), BACKGROUND_CONTEXT);
	const watcher = startDurableDelivery({ host: source, metadata: sourceMetadata(root, source.storageId, sourcePath),
		catalog: new AgentCatalog(root), sessionsRoot, signal: new AbortController().signal });
	t.after(() => watcher.close());
	await received.waitForCount(1);
	await waitForDelivery(source, async () => (await deliveryState(source))?.reports[0]?.acknowledged === true);
	const message = received[0];
	const details = message.details as { textTruncated?: boolean; message: string; checkIn: Record<string, unknown> };
	assert.equal(details.textTruncated, true);
	assert.equal(Object.hasOwn(details.checkIn, "digest"), false);
	assert.ok(details.message.length < 16_100);
	for (const text of [message.text, details.message]) {
		assert.match(text, /text truncated/u);
		assert.doesNotMatch(text, /OMITTED|[\uD800-\uDFFF]/u);
	}
	assert.equal((await deliveryState(source))?.reports[0]?.message, digest);
});

for (const route of ["catalog", "same-storage"] as const) it(`routes a check-in as a report to a ${route} owner`, { timeout: 30000 }, async (t) => {
	const root = fixtureRoot(t);
	const catalog = new AgentCatalog(root);
	const record = catalog.create({ cwd: root, agentDir: join(root, "agent"), packageDir: join(root, "package"),
		model: { provider: fixtureProvider, modelId: fixtureModelId }, thinkingLevel: "off", ownerId: "owner" });
	const sourcePath = join(root, "source.sqlite");
	const source = await openHost(sourcePath, "11111111-1111-4111-8111-111111111111", root);
	const target = route === "same-storage" ? source : await openHost(record.storagePath, record.storageId, root);
	const owner = route === "same-storage" ? source.storageId : `${record.storageId}:1`;
	t.after(async () => { await source.close(); if (target !== source) await target.close(); });
	const checkIn = { conversationId: 1, requestId: "task", origin: "model" as const, elapsedMs: 1_800_000, cost: null };
	await source.harness.commit(async (tx) => editDeliveryFixture(tx, async (deliveryFixtureState) => {
		const state = deliveryFixtureState;
		const report = { sourceId: "checkin:task:2", requestId: "task", ownerId: owner, senderIdentity: source.storageId,
			message: "Task is active.", replyTo: null, acknowledged: false, createdAt: 1, checkIn };
		state.reports.push(report);
	}), BACKGROUND_CONTEXT);
	const calls = eventLog<SubmitRecord>();
	let release!: () => void;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	const request = source.request.bind(source);
	if (route === "same-storage") source.request = async (method, params, context) => {
		if (method === "submit") { calls.push({ params: params as Record<string, unknown>, result: undefined }); await gate; }
		return request(method, params, context);
	};
	const watcher = startDurableDelivery({ host: source, metadata: sourceMetadata(root, source.storageId, sourcePath), catalog,
		signal: new AbortController().signal, acquire: async () => fakeTarget(target, calls, gate),
		listPrimaryChannels: async () => { assert.fail("a report owner in a storage never uses fallback"); } });
	t.after(() => watcher.close());
	t.after(() => release());
	await calls.waitForCount(1);
	assert.equal((await deliveryState(source))?.reports[0]?.acknowledged, false);
	release();
	await waitForDelivery(source, async () => (await deliveryState(source))?.reports[0]?.acknowledged === true);
	const call = calls[0];
	assert.equal(call.params.sessionId, owner);
	assert.equal(call.params.whenBusy, "followUp");
	assert.equal(call.params.ownerId, undefined);
	assert.equal(call.params.requestId, `deliver:11111111-1111-4111-8111-111111111111:report:${createHash("sha256").update("checkin:task:2").digest("hex").slice(0, 32)}`);
	assert.match(String(call.params.message), /Check-in from 11111111-1111-4111-8111-111111111111.*source checkin:task:2/u);
	assert.match(String(call.params.message), /still working.*not finished.*30m/u);
	assert.doesNotMatch(String(call.params.message), /conversation total unavailable/u);
	assert.match(String(call.params.message), /Task is active/u);
	assert.match(String(call.params.message), /Assess.*report progress.*let.*run.*steer.*abort/u);
});

it("routes a receipt and a report only after the target admits them", { timeout: 30000 }, async (t) => {
	const root = fixtureRoot(t);
	const packageDir = join(root, "source-installation");
	const catalog = new AgentCatalog(root);
	const record = catalog.create({
		cwd: root,
		agentDir: join(root, "agent"),
		packageDir: join(root, "package"),
		model: { provider: fixtureProvider, modelId: fixtureModelId },
		thinkingLevel: "off",
		ownerId: "owner-1",
	});
	const owner = `${record.storageId}:1`;
	const sourcePath = join(root, "source.sqlite");
	const source = await openHost(sourcePath, "11111111-1111-4111-8111-111111111111", root);
	const target = await openHost(record.storagePath, record.storageId, root);
	t.after(async () => {
		await source.close().catch(() => undefined);
		await target.close().catch(() => undefined);
	});
	const submissionId = await addReceipt(source, owner);
	await source.request(
		"report",
		{ ownerId: owner, senderIdentity: `${source.storageId}:1`, requestId: "source-report", message: "report text" },
		BACKGROUND_CONTEXT,
	);

	const calls = eventLog<SubmitRecord>();
	let release: (() => void) | undefined;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const errors = eventLog<Error>();
	const passes = eventLog<Error | undefined>();
	const report = source.reportDeliveryError.bind(source);
	source.reportDeliveryError = (error) => { report(error); passes.push(error); };
	const watcher = startDurableDelivery({
		host: source,
		metadata: { ...sourceMetadata(root, source.storageId, sourcePath), packageDir },
		catalog,
		signal: new AbortController().signal,
		acquire: async (metadata) => {
			assert.equal(metadata.packageDir, packageDir, "delivery uses the source host installation, not the target record");
			return fakeTarget(target, calls, gate);
		},
		onError: (error) => errors.push(error),
	});
	await calls.waitForCount(1);
	const blocked = await deliveryState(source);
	assert.equal(blocked?.receipts[String(submissionId)]?.acknowledged, false, "no acknowledgement before admission");
	assert.equal(blocked?.reports[0]?.acknowledged, false, "no report acknowledgement before admission");
	let acknowledged = false;
	const snapshots = eventLog<void>();
	const completion = waitForDelivery(source, async () => {
		const state = await deliveryState(source);
		snapshots.push(undefined);
		return state?.receipts[String(submissionId)]?.acknowledged === true && state.reports[0]?.acknowledged === true;
	}).then(() => { acknowledged = true; });
	await snapshots.waitForCount(1);
	assert.equal(acknowledged, false, "the commit consumer stays pending while admission is held");
	release?.();
	await completion;
	assert.equal(calls.length, 2, "one submission per delivered row");
	const receiptCall = calls.find(
		(call) => typeof call.params.requestId === "string" && (call.params.requestId as string).includes(":result:"),
	) as SubmitRecord;
	const reportCall = calls.find(
		(call) => typeof call.params.requestId === "string" && (call.params.requestId as string).includes(":report:"),
	) as SubmitRecord;
	const expectedReceipt = `deliver:${await receiptSourceId(source, submissionId)}`;
	const expectedReport = `deliver:11111111-1111-4111-8111-111111111111:report:${createHash("sha256").update("report:source-report").digest("hex").slice(0, 32)}`;
	assert.equal(receiptCall.requestId, expectedReceipt);
	assert.equal(receiptCall.params.requestId, expectedReceipt);
	assert.equal(reportCall.requestId, expectedReport);
	assert.equal(reportCall.params.requestId, expectedReport);
	for (const call of [receiptCall, reportCall]) {
		assert.equal(call.params.sessionId, owner, "the follow-up targets the owning conversation");
		assert.equal(call.params.whenBusy, "followUp");
		assert.equal(call.params.ownerId, undefined, "the target submission records no owner intent");
		assert.match(String(call.params.message), /original scope; agent claims remain claims/u);
	}
	assert.match(String(receiptCall.params.message), new RegExp(`submissions ${submissionId}`, "u"));
	assert.match(String(reportCall.params.message), /source report:source-report/u);
	assert.equal((await readRetainedDelivery(target.harness, BACKGROUND_CONTEXT, true))?.intents.length ?? 0, 0, "delivered reports and answers create no reply-owner loop");
	assert.equal((await target.harness.inspect(BACKGROUND_CONTEXT)).tasks.some((task) => task.record.kind === "agent.check-in"), false);
	assert.deepEqual(errors, []);
	await passes.waitFor((events) => events.filter((error) => error === undefined).length >= 2);
	assert.equal(calls.length, 2, "acknowledgement commits do not route duplicates in a completed follow-up pass");
	await watcher.close();
});

it("identifies an absent peer report without blocking a catalog owner's result", { timeout: 30000 }, async (t) => {
	const root = fixtureRoot(t);
	const catalog = new AgentCatalog(root);
	const record = catalog.create({
		cwd: root, agentDir: join(root, "agent"), packageDir: join(root, "package"),
		model: { provider: fixtureProvider, modelId: fixtureModelId }, thinkingLevel: "off", ownerId: "fixture-owner",
	}, "native-owner");
	assert.equal(record.storageId, "df9df4ea-5dc7-236d-fbf2-d087b48aadfb", "a native storage identity need not be a canonical primary UUID");
	const missingPeer = "11111111-2222-f333-7444-555555555555";
	const sourcePath = join(root, "source.sqlite");
	const source = await openHost(sourcePath, "11111111-1111-4111-8111-111111111111", root);
	const target = await openHost(record.storagePath, record.storageId, root);
	t.after(async () => { await source.close(); await target.close(); });
	const report = await recordReport(source.harness, {
		ownerId: missingPeer, senderIdentity: source.storageId, requestId: "absent-peer", message: "peer report",
	}, BACKGROUND_CONTEXT);
	const submissionId = await addReceipt(source, record.storageId);
	const calls = eventLog<SubmitRecord>();
	const errors = eventLog<Error>();
	let acquired = 0;
	const watcher = startDurableDelivery({
		host: source, metadata: sourceMetadata(root, source.storageId, sourcePath), catalog,
		signal: new AbortController().signal,
		acquire: async (metadata) => {
			acquired += 1;
			assert.equal(metadata.storageId, record.storageId);
			return fakeTarget(target, calls);
		},
		listPrimaryChannels: async () => { assert.fail("an absent native peer must not broadcast to primary sessions"); },
		onError: (error) => errors.push(error),
	});
	t.after(() => watcher.close());
	await errors.waitForCount(1);
	await watcher.close();
	const state = await deliveryState(source);
	assert.equal(state?.receipts[String(submissionId)]?.acknowledged, true, "the valid result reaches its catalog owner");
	assert.equal(state?.reports.find((row) => row.sourceId === report.sourceId)?.acknowledged, false, "the absent peer report stays pending");
	assert.equal(acquired, 1);
	assert.equal(calls.length, 1);
	assert.equal(calls[0]?.params.sessionId, record.storageId);
	assert.equal(calls[0]?.params.ownerId, undefined, "the result does not create another ownership intent");
	assert.match(String(calls[0]?.params.message), /Agent result from 11111111-1111-4111-8111-111111111111:1/u);
	assert.match(String(calls[0]?.params.message), /\nRequest \S+ \(submission \d+\): native input completed; no declared work\. This answer is its result: dependency arrived\.\n/u, "the native follow-up names the state of each request");
	assert.match(errors[0]?.message ?? "", /parked: native recipient has no catalog record/u);
	const status = await source.request("status", {}, BACKGROUND_CONTEXT) as { deliveryError?: string };
	assert.equal(status.deliveryError, errors[0]?.message, "status identifies the failed report, not the delivered result");
});

it("resumes after reopen and native dedup keeps one submission", { timeout: 30000 }, async (t) => {
	const root = fixtureRoot(t);
	const catalog = new AgentCatalog(root);
	const record = catalog.create({
		cwd: root,
		agentDir: join(root, "agent"),
		packageDir: join(root, "package"),
		model: { provider: fixtureProvider, modelId: fixtureModelId },
		thinkingLevel: "off",
		ownerId: "owner-1",
	});
	const owner = `${record.storageId}:1`;
	const sourcePath = join(root, "source.sqlite");
	const first = await openHost(sourcePath, "11111111-1111-4111-8111-111111111111", root);
	const submissionId = await addReceipt(first, owner);
	const expected = `deliver:${await receiptSourceId(first, submissionId)}`;
	await first.close();
	const target = await openHost(record.storagePath, record.storageId, root);
	t.after(async () => {
		await target.close().catch(() => undefined);
	});
	const preAdmission = (await target.request(
		"submit",
		{ sessionId: owner, message: "already admitted", requestId: expected, whenBusy: "followUp", origin: "model", provenance: { classification: "automatic" } },
		BACKGROUND_CONTEXT,
	)) as { submissionId: number };

	const reopened = await openHost(sourcePath, "11111111-1111-4111-8111-111111111111", root);
	t.after(async () => {
		await reopened.close().catch(() => undefined);
	});
	const calls = eventLog<SubmitRecord>();
	const errors = eventLog<Error>();
	const watcher = startDurableDelivery({
		host: reopened,
		metadata: sourceMetadata(root, reopened.storageId, sourcePath),
		catalog,
		signal: new AbortController().signal,
		acquire: async () => fakeTarget(target, calls),
		onError: (error) => errors.push(error),
	});
	await waitForDelivery(reopened, async () => (await deliveryState(reopened))?.receipts[String(submissionId)]?.acknowledged === true);
	assert.equal(calls.length, 1, "one routed submission after reopen");
	const routed = calls[0];
	assert.ok(routed, "the routed submission is recorded");
	assert.equal(routed.requestId, expected, "the reopened watcher reuses the derived request ID");
	assert.equal(
		(await target.harness.commit((tx) => tx.submissionByRequest(1 as import("@earendil-works/pi-durable").ConversationId, expected), BACKGROUND_CONTEXT))?.id,
		preAdmission.submissionId,
		"the target deduplicates the resent request",
	);
	assert.deepEqual(errors, []);
	await watcher.close();
});

it("delivers a noncatalog owner to its registered primary channel with source metadata", {
	timeout: 30000,
}, async (t) => {
	const root = fixtureRoot(t);
	const sessionsRoot = join(root, "sessions");
	const owner = "018f4a3c-1d2e-7a4b-9c3d-4e5f60718293";
	const received = eventLog<PrimaryDelivery>();
	const channel = await createPrimaryChannel({
		id: owner,
		cwd: root,
		sessionsRoot,
		deliver: (message) => {
			received.push(message);
		},
		promptTrust: async () => undefined,
	});
	t.after(async () => {
		await channel.close().catch(() => undefined);
	});
	const sourcePath = join(root, "source.sqlite");
	const source = await openHost(sourcePath, "11111111-1111-4111-8111-111111111111", root);
	t.after(async () => {
		await source.close().catch(() => undefined);
	});
	const submissionId = await addReceipt(source, owner);
	const errors = eventLog<Error>();
	const watcher = startDurableDelivery({
		host: source,
		metadata: sourceMetadata(root, source.storageId, sourcePath),
		catalog: new AgentCatalog(root),
		sessionsRoot,
		signal: new AbortController().signal,
		onError: (error) => errors.push(error),
	});
	await received.waitForCount(1);
	await waitForDelivery(source, async () => (await deliveryState(source))?.receipts[String(submissionId)]?.acknowledged === true);
	const message = received[0];
	const details = message.details as Record<string, unknown>;
	assert.equal(message.sourceId, await receiptSourceId(source, submissionId));
	assert.equal(details.originalOwnerId, owner);
	assert.equal(details.storageId, "11111111-1111-4111-8111-111111111111");
	assert.equal(details.saved, true);
	assert.equal(details.provider, fixtureProvider);
	assert.equal(details.modelId, fixtureModelId);
	assert.equal(details.identity, "11111111-1111-4111-8111-111111111111");
	assert.equal(details.liveOwner, true);
	assert.equal(details.deliveryRecipient, owner);
	assert.equal(details.metadataUnknown, undefined);
	assert.equal(details.textTruncated, undefined, "a short body carries no truncation flag");
	assert.equal(typeof details.thinkingLevel, "string");
	assert.equal(details.label, "11111111-1111-4111-8111-111111111111");
	assert.equal(details.wake, true, "a model-origin admission wakes its owner");
	assert.match(message.text, /^Agent “11111111-1111-4111-8111-111111111111” completed native input\./u);
	assert.match(message.text, /Results do not establish task acceptance/u);
	assert.doesNotMatch(message.text, /no live owning session/u);
	assert.doesNotMatch(message.text, /submissions/u);
	const state = await deliveryState(source);
	assert.equal(state?.receipts[String(submissionId)]?.acknowledged, true);
	assert.deepEqual(errors, []);
	await watcher.close();
});

it("delivers an operator-only answer group without waking the primary", { timeout: 30000 }, async (t) => {
	const root = fixtureRoot(t);
	const sessionsRoot = join(root, "sessions");
	const owner = randomUUID();
	const received = eventLog<PrimaryDelivery>();
	const channel = await createPrimaryChannel({
		id: owner,
		cwd: root,
		sessionsRoot,
		deliver: (message) => {
			received.push(message);
		},
		promptTrust: async () => undefined,
	});
	t.after(async () => {
		await channel.close().catch(() => undefined);
	});
	const sourcePath = join(root, "source.sqlite");
	const source = await openHost(sourcePath, "11111111-1111-4111-8111-111111111111", root);
	t.after(async () => {
		await source.close().catch(() => undefined);
	});
	const admitted = (await source.request(
		"submit",
		{ sessionId: source.storageId, message: "board task", requestId: "operator-only", ownerId: owner, origin: "operator" },
		BACKGROUND_CONTEXT,
	)) as { submissionId: SubmissionId };
	await source.wait(admitted.submissionId, BACKGROUND_CONTEXT);
	const errors = eventLog<Error>();
	const watcher = startDurableDelivery({
		host: source,
		metadata: sourceMetadata(root, source.storageId, sourcePath),
		catalog: new AgentCatalog(root),
		sessionsRoot,
		signal: new AbortController().signal,
		onError: (error) => errors.push(error),
	});
	await received.waitForCount(1);
	const details = received[0]?.details as { wake?: unknown; submissions?: Array<{ origin?: string }> };
	assert.equal(details.wake, false, "an operator-only answer group does not start a primary turn");
	assert.deepEqual(details.submissions?.map((member) => member.origin), ["operator"]);
	assert.match(received[0]?.text ?? "", /^Agent “11111111-1111-4111-8111-111111111111” completed native input\./u);
	assert.doesNotMatch(received[0]?.text ?? "", /submissions/u);
	await watcher.close();
	assert.deepEqual(errors, [], "delivery completes without errors");
});

it("keeps a stored admission origin across a host reopen before delivery", { timeout: 30000 }, async (t) => {
	const root = fixtureRoot(t);
	const sessionsRoot = join(root, "sessions");
	const owner = randomUUID();
	const received = eventLog<PrimaryDelivery>();
	const channel = await createPrimaryChannel({
		id: owner,
		cwd: root,
		sessionsRoot,
		deliver: (message) => {
			received.push(message);
		},
		promptTrust: async () => undefined,
	});
	t.after(async () => {
		await channel.close().catch(() => undefined);
	});
	const sourcePath = join(root, "source.sqlite");
	const first = await openHost(sourcePath, "11111111-1111-4111-8111-111111111111", root);
	const admitted = await first.request(
		"submit",
		{ sessionId: first.storageId, message: "restart task", requestId: "survives-restart", ownerId: owner, origin: "operator" },
		BACKGROUND_CONTEXT,
	) as { submissionId: SubmissionId };
	await first.wait(admitted.submissionId, BACKGROUND_CONTEXT);
	await first.close();
	const reopened = await openHost(sourcePath, "11111111-1111-4111-8111-111111111111", root);
	t.after(async () => {
		await reopened.close().catch(() => undefined);
	});
	const errors = eventLog<Error>();
	const watcher = startDurableDelivery({
		host: reopened,
		metadata: sourceMetadata(root, reopened.storageId, sourcePath),
		catalog: new AgentCatalog(root),
		sessionsRoot,
		signal: new AbortController().signal,
		onError: (error) => errors.push(error),
	});
	await received.waitForCount(1);
	const details = received[0]?.details as { wake?: unknown; submissions?: Array<{ origin?: string }> };
	assert.deepEqual(details.submissions?.map((member) => member.origin), ["operator"], "the intent origin survives the reopen");
	assert.equal(details.wake, false, "the reopened watcher keeps the operator-only delivery quiet");
	await watcher.close();
	assert.deepEqual(errors, []);
});

for (const origin of ["operator", "model"] as const) for (const target of ["root", "root-alias", "sibling"] as const) {
	it(`acknowledges ${origin} self-owned answered receipts in ${target} without follow-up input`, { timeout: 10000 }, async (t) => {
		const root = fixtureRoot(t);
		const path = join(root, "source.sqlite");
		const source = await openHost(path, "11111111-1111-4111-8111-111111111111", root);
		t.after(() => source.close());
		const sibling = target === "sibling" ? await source.harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: { provider: fixtureProvider, modelId: fixtureModelId } } }, BACKGROUND_CONTEXT) : undefined;
		const identity = sibling ? source.identity(sibling.id) : source.storageId;
		const ownerId = target === "root-alias" ? `${source.storageId}:1` : identity;
		const admitted = await source.request("submit", { sessionId: identity, message: "task", requestId: "self-owned", ownerId, origin }) as { submissionId: SubmissionId };
		await source.wait(admitted.submissionId, BACKGROUND_CONTEXT);
		const calls = t.mock.method(source, "request");
		const errors = eventLog<Error>();
		const watcher = startDurableDelivery({ host: source, metadata: sourceMetadata(root, source.storageId, path), catalog: new AgentCatalog(root), signal: new AbortController().signal, onError: (error) => errors.push(error) });
		try {
			await waitForDelivery(source, async () => (await deliveryState(source))?.receipts[String(admitted.submissionId)]?.acknowledged === true);
			assert.equal(calls.mock.calls.filter((call) => call.arguments[0] === "submit").length, 0);
			assert.deepEqual(errors, []);
		} finally { await watcher.close(); }
	});
}

it("acknowledges an aborted self-owned receipt without follow-up input", { timeout: 10000 }, async (t) => {
	const root = fixtureRoot(t);
	const path = join(root, "source.sqlite");
	const started = eventLog<void>();
	let release!: () => void;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	const source = await DurableHost.open({ storagePath: path, storageId: "11111111-1111-4111-8111-111111111111", cwd: root,
		models: await scriptedRuntime([toolCallMessage("gate"), answerMessage()]), registry: fixtureRegistry([gateTool(gate, () => started.push(undefined))]),
		agent: { model: { provider: fixtureProvider, modelId: fixtureModelId } } }, BACKGROUND_CONTEXT);
	t.after(() => source.close());
	t.after(release);
	const admitted = await source.request("submit", { message: "task", requestId: "stopped", ownerId: source.storageId, origin: "operator" }) as { submissionId: SubmissionId };
	await started.waitForCount(1);
	const aborting = source.request("abort", {});
	release();
	await aborting;
	const settled = await source.wait(admitted.submissionId, BACKGROUND_CONTEXT);
	assert.equal(settled.status, "unanswered");
	const calls = t.mock.method(source, "request");
	const watcher = startDurableDelivery({ host: source, metadata: sourceMetadata(root, source.storageId, path), catalog: new AgentCatalog(root), signal: new AbortController().signal });
	try {
		await waitForDelivery(source, async () => (await deliveryState(source))?.receipts[String(admitted.submissionId)]?.acknowledged === true);
		assert.equal(calls.mock.calls.filter((call) => call.arguments[0] === "submit").length, 0);
	} finally { await watcher.close(); }
});

it("delivers only the recipient's submissions from a shared answer without self follow-up", { timeout: 10000 }, async (t) => {
	const root = fixtureRoot(t);
	const path = join(root, "source.sqlite");
	const sessionsRoot = join(root, "sessions");
	const owner = randomUUID();
	const received = eventLog<PrimaryDelivery>();
	const channel = await createPrimaryChannel({ id: owner, cwd: root, sessionsRoot, deliver: (message) => { received.push(message); }, promptTrust: async () => undefined });
	t.after(() => channel.close());
	const started = eventLog<void>();
	let release!: () => void;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	const source = await DurableHost.open({ storagePath: path, storageId: "11111111-1111-4111-8111-111111111111", cwd: root,
		models: await scriptedRuntime([toolCallMessage("gate"), answerMessage(), answerMessage()]), registry: fixtureRegistry([gateTool(gate, () => started.push(undefined))]),
		agent: { model: { provider: fixtureProvider, modelId: fixtureModelId } } }, BACKGROUND_CONTEXT);
	t.after(() => source.close());
	t.after(release);
	const original = await source.request("submit", { message: "task", requestId: "self", ownerId: source.storageId, origin: "operator" }) as { submissionId: SubmissionId };
	await started.waitForCount(1);
	const steer = await source.request("submit", { message: "correction", requestId: "other", ownerId: owner, origin: "model", whenBusy: "steer" }) as { submissionId: SubmissionId };
	release();
	await source.wait(original.submissionId, BACKGROUND_CONTEXT);
	await source.wait(steer.submissionId, BACKGROUND_CONTEXT);
	const calls = t.mock.method(source, "request");
	const watcher = startDurableDelivery({ host: source, metadata: sourceMetadata(root, source.storageId, path), catalog: new AgentCatalog(root), sessionsRoot, signal: new AbortController().signal });
	try {
		const ids = [original.submissionId, steer.submissionId];
		await waitForDelivery(source, async () => {
			const state = await deliveryState(source);
			return ids.every((id) => state?.receipts[String(id)]?.acknowledged === true);
		});
		const state = await deliveryState(source);
		assert.equal(state?.receipts[String(original.submissionId)]?.answerEntryId, state?.receipts[String(steer.submissionId)]?.answerEntryId);
		assert.equal(received.length, 1);
		const details = received[0]?.details as { submissions: Array<{ submissionId: number }>; wake: boolean };
		assert.deepEqual(details.submissions.map((member) => member.submissionId), [steer.submissionId]);
		assert.equal(details.wake, true);
		assert.equal(calls.mock.calls.filter((call) => call.arguments[0] === "submit").length, 0);
	} finally { await watcher.close(); }
});

it("names the work state of each request of a shared answer and continues a cut final report exactly", { timeout: 15000 }, async (t) => {
	const root = fixtureRoot(t);
	const path = join(root, "source.sqlite");
	const sessionsRoot = join(root, "sessions");
	const owner = randomUUID();
	const received = eventLog<PrimaryDelivery>();
	const channel = await createPrimaryChannel({ id: owner, cwd: root, sessionsRoot, deliver: (message) => { received.push(message); }, promptTrust: async () => undefined });
	t.after(() => channel.close());
	const started = eventLog<void>();
	let release!: () => void;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	const storageId = "11111111-1111-4111-8111-111111111111";
	const source = await DurableHost.open({ storagePath: path, storageId, cwd: root,
		models: await scriptedRuntime([toolCallMessage("gate"), answerMessage(), answerMessage()]), registry: fixtureRegistry([gateTool(gate, () => started.push(undefined))]),
		agent: { model: { provider: fixtureProvider, modelId: fixtureModelId } } }, BACKGROUND_CONTEXT);
	t.after(() => source.close());
	t.after(release);
	const declared = await source.request("task-submit", { message: "survey", requestId: "task-a", requester: owner, origin: "model" }) as { submissionId: SubmissionId };
	await started.waitForCount(1);
	const plain = await source.request("task-submit", { message: "quick question", requestId: "task-b", requester: owner, origin: "model", whenBusy: "steer" }) as { submissionId: SubmissionId };
	const declaration = await source.harness.commit((tx) => declareOpenWork(tx, storageId, 1 as ConversationId, { request: "task-a", results: [], note: "survey continues" }, 1), BACKGROUND_CONTEXT);
	assert.ok(!("error" in declaration), JSON.stringify(declaration));
	release();
	await source.wait(declared.submissionId, BACKGROUND_CONTEXT);
	await source.wait(plain.submissionId, BACKGROUND_CONTEXT);
	const watcher = startDurableDelivery({ host: source, metadata: sourceMetadata(root, storageId, path), catalog: new AgentCatalog(root), sessionsRoot, signal: new AbortController().signal });
	try {
		await received.waitForCount(1);
		const text = received[0]?.text ?? "";
		assert.match(text, /^Agent “[^”]+” completed native input\.\n/u);
		assert.doesNotMatch(text, /finished/u, "native input completion never reads as finished work");
		assert.match(text, new RegExp(`Request task-a \\(submission ${declared.submissionId}\\): native input completed; declared work remains open\\. This answer is a state note, not the final result`, "u"));
		assert.match(text, new RegExp(`Request task-b \\(submission ${plain.submissionId}\\): native input completed; no declared work\\. This answer is its result: dependency arrived\\.`, "u"));

		const message = `${"r".repeat(15_000)}😀${"s".repeat(5_000)}`;
		const completed = await source.harness.commit((tx) => completeOpenWork(tx, storageId, 1 as ConversationId, { request: "task-a", status: "done", message }, 2), BACKGROUND_CONTEXT);
		assert.ok(!("error" in completed) && completed.report !== undefined);
		await received.waitForCount(2);
		const report = received[1]?.text ?? "";
		assert.match(report, /^Agent “[^”]+” sent a final work report\. Work completed with a final report \(done\) for request task-a \(report work-final:1:task-a\)\. This report is the result of that request: dependency arrived\./u);
		const call = /Final report continues: agent_inspect\((\{.*\})\)/u.exec(report);
		assert.ok(call, "a cut final report names its exact continuation");
		const exact = completed.report.message;
		const head = report.slice(report.indexOf("\n\n") + 2, report.indexOf("\n\n[text truncated]"));
		assert.equal(exact.startsWith(head), true, "the delivered part is the start of the retained report");
		let next: Record<string, unknown> | undefined = JSON.parse(call[1]) as Record<string, unknown>;
		assert.equal(next.offset, head.length);
		let rest = "";
		while (next !== undefined) {
			const { tool: _tool, ...params } = next;
			const page = await source.request("inspect", params) as { finalReport: { text: string }; finalReportContinuation?: Record<string, unknown> };
			rest += page.finalReport.text;
			next = page.finalReportContinuation;
		}
		assert.equal(head + rest, exact, "the continuation reads the rest of the report exactly");
	} finally { await watcher.close(); }
});

/** The production `agent_work` execution, bound to the calling task as the native tool binds it. */
function workTool(storageId: string): ToolRegistration {
	return defineTool({
		name: "agent_work",
		description: "Declare background work for a request, or complete it.",
		parameters: obj({}, { open: true }),
		execute: async (args, api, context) => executeAgentWork(args, { harness: api, storageId, conversationId: api.conversationId, now: api.now() }, context),
	});
}
function toolCall(id: string, name: string, args: Record<string, string | string[]> = {}) {
	const message = toolCallMessage(name, args);
	return { ...message, content: message.content.map((part) => part.type === "toolCall" ? { ...part, id } : part) };
}

it("reads the final report of a run that completed its work and then ended without an answer", { timeout: 20000 }, async (t) => {
	const root = fixtureRoot(t);
	const path = join(root, "source.sqlite");
	const sessionsRoot = join(root, "sessions");
	const owner = randomUUID();
	const received = eventLog<PrimaryDelivery>();
	const channel = await createPrimaryChannel({ id: owner, cwd: root, sessionsRoot, deliver: (message) => { received.push(message); }, promptTrust: async () => undefined });
	t.after(() => channel.close());
	const started = eventLog<void>();
	const storageId = "11111111-1111-4111-8111-111111111111";
	// A report of three pages with a surrogate pair across the first page boundary.
	const label = "Final work result (done) for request task-a\n\n";
	const message = `${"r".repeat(4095 - label.length)}😀${"s".repeat(6000)}`;
	const source = await DurableHost.open({ storagePath: path, storageId, cwd: root,
		models: await scriptedRuntime([
			toolCall("declare-a", "agent_work", { action: "continue", request: "task-a", results: [], note: "the survey continues" }),
			toolCall("complete-a", "agent_work", { action: "complete", request: "task-a", status: "done", message }),
			toolCall("hold-a", "gate"),
			toolCall("declare-b", "agent_work", { action: "continue", request: "task-b", results: [], note: "this work never completes" }),
			toolCall("hold-b", "gate"),
		]), registry: fixtureRegistry([workTool(storageId), gateTool(new Promise<void>(() => {}), () => started.push(undefined))]),
		agent: { model: { provider: fixtureProvider, modelId: fixtureModelId } } }, BACKGROUND_CONTEXT);
	t.after(() => source.close());
	type Page = { status: string; answer?: string; reason?: string; work?: { state: string; answer?: string; label?: string; finalReport?: { requestId: string; ownerId: string; status?: string; read: Record<string, unknown> } }; finalReport: { text: string; length: number }; finalReportContinuation?: Record<string, unknown> };
	const inspect = (params: Record<string, unknown>) => source.request("inspect", params) as Promise<Page>;
	const readAll = async (first: Record<string, unknown>, status: string): Promise<string> => {
		let text = "";
		let pages = 0;
		let next: Record<string, unknown> | undefined = first;
		while (next !== undefined) {
			const { tool: _tool, ...params } = next;
			const page = await inspect(params);
			assert.ok(matchesSchema(InspectOutputSchema, page), "the page matches the published response schema");
			assert.deepEqual([page.status, page.answer, page.finalReport.length], [status, undefined, label.length + message.length], "the page keeps the status of the input and carries no answer");
			text += page.finalReport.text;
			pages += 1;
			next = page.finalReportContinuation;
		}
		assert.equal(pages, 3);
		return text;
	};

	const completed = await source.request("task-submit", { message: "survey", requestId: "task-a", requester: owner, origin: "model" }) as { submissionId: SubmissionId };
	await started.waitForCount(1);
	const read = { tool: "agent_inspect", view: "result", sessionId: storageId, submissionId: completed.submissionId, finalReport: true, offset: 0 };
	const fact = { requestId: "work-final:1:task-a", ownerId: owner, status: "done", delivery: "active", read };
	assert.equal(await readAll(read, "placed"), label + message, "the report is complete while its input is still placed");
	const running = await inspect({ view: "result", submissionId: completed.submissionId });
	assert.deepEqual([running.status, running.answer, running.work], ["placed", undefined, { state: "closed", finalReport: fact }], "a placed input has no answer, so its work names no state note");

	await source.request("abort", {});
	assert.equal((await source.wait(completed.submissionId, BACKGROUND_CONTEXT)).status, "unanswered");
	const stopped = await inspect({ view: "result", submissionId: completed.submissionId });
	assert.deepEqual([stopped.status, stopped.answer, stopped.work], ["unanswered", undefined, { state: "closed", finalReport: fact }], "the input keeps its unanswered outcome beside the final report");
	assert.ok(typeof stopped.reason === "string" && stopped.reason.length > 0);
	assert.match(readableControlText(stopped), /Declared work: closed\.\n\nFinal report: .*\n\nRead the final report: agent_inspect\(/u);
	assert.doesNotMatch(readableControlText(stopped), /State note/u);
	assert.equal(await readAll(read, "unanswered"), label + message, "the report is complete after its input ended unanswered");
	const status = await source.request("status", { sessionId: storageId }) as { conversation: { openWork?: Array<{ requestId: string; state: string; close?: { status: string; read: unknown } }> } };
	assert.deepEqual(status.conversation.openWork?.map((item) => [item.requestId, item.state, item.close?.status, item.close?.read]), [["task-a", "closed", "done", read]], "the abort leaves the closed item and its read call");

	const watcher = startDurableDelivery({ host: source, metadata: sourceMetadata(root, storageId, path), catalog: new AgentCatalog(root), sessionsRoot, signal: new AbortController().signal });
	try {
		const kind = (delivery: PrimaryDelivery) => (delivery.details as { kind?: string }).kind;
		await received.waitForCount(2);
		assert.deepEqual(received.map(kind).sort(), ["receipt", "report"]);
		const receipt = received.find((delivery) => kind(delivery) === "receipt");
		const line = new RegExp(`Request task-a \\(submission ${completed.submissionId}\\): native input stopped without an answer; declared work completed \\(done\\) with final report work-final:1:task-a\\. The final report is the result of this request\\. Read the final report: agent_inspect\\((\\{.*\\})\\)`, "u").exec(receipt?.text ?? "");
		assert.ok(line, receipt?.text);
		assert.doesNotMatch(receipt?.text ?? "", /no result arrived|state note/u);
		const details = receipt?.details as { status?: string; work?: string; workLabel?: string } | undefined;
		assert.deepEqual([details?.status, details?.work, details?.workLabel], ["unanswered", "closed", undefined]);
		assert.equal(await readAll({ tool: "agent_inspect", ...JSON.parse(line[1]) as Record<string, unknown> }, "unanswered"), label + message, "the call of the delivered receipt reads the complete report");

		// A declaration that its run never completes is void when that run ends unanswered.
		const unfinished = await source.request("task-submit", { message: "second survey", requestId: "task-b", requester: owner, origin: "model" }) as { submissionId: SubmissionId };
		await started.waitForCount(2);
		assert.equal((await inspect({ view: "result", submissionId: unfinished.submissionId })).work?.state, "open");
		await source.request("abort", {});
		assert.equal((await source.wait(unfinished.submissionId, BACKGROUND_CONTEXT)).status, "unanswered");
		const voided = await inspect({ view: "result", submissionId: unfinished.submissionId });
		assert.deepEqual([voided.status, voided.work], ["unanswered", undefined]);
		await assert.rejects(inspect({ view: "result", submissionId: unfinished.submissionId, finalReport: true }), /no closed declared work/u);
		await received.waitForCount(3);
		assert.match(received[2]?.text ?? "", new RegExp(`Request task-b \\(submission ${unfinished.submissionId}\\): native input stopped without an answer; no result arrived\\.`, "u"));
		assert.equal((await deliveryState(source))?.reports.some((report) => report.requestId === "work-final:1:task-b"), false, "a void declaration leaves no final report");
	} finally { await watcher.close(); }
});

for (const origin of [undefined, "invalid"] as const) it(`keeps a self-owned receipt with ${origin} origin pending and reported`, { timeout: 10000 }, async (t) => {
	const root = fixtureRoot(t);
	const path = join(root, "source.sqlite");
	const source = await openHost(path, "11111111-1111-4111-8111-111111111111", root);
	t.after(() => source.close());
	const id = await addReceipt(source, source.storageId);
	await settleDeliveries(source.harness, BACKGROUND_CONTEXT);
	await source.harness.commit(async (tx) => editDeliveryFixture(tx, async (deliveryFixtureState) => {
		const state = deliveryFixtureState;
		const receipt = state.receipts[String(id)];
		assert.ok(receipt);
		const { origin: _removed, ...rest } = receipt;
		state.receipts[String(id)] = { ...rest, ...(origin === undefined ? {} : { origin }) } as typeof receipt;
	}), BACKGROUND_CONTEXT);
	const errors = eventLog<Error>();
	const calls = t.mock.method(source, "request");
	const watcher = startDurableDelivery({ host: source, metadata: sourceMetadata(root, source.storageId, path), catalog: new AgentCatalog(root), signal: new AbortController().signal, onError: (error) => errors.push(error) });
	try {
		await errors.waitForCount(1);
		assert.equal((await deliveryState(source))?.receipts[String(id)]?.acknowledged, false);
		assert.equal(calls.mock.calls.filter((call) => call.arguments[0] === "submit").length, 0);
		assert.match(errors[0]?.message ?? "", /terminal: corrupt admission origin/u);
		assert.match(((await source.request("status", {})) as { deliveryError?: string }).deliveryError ?? "", /terminal: corrupt admission origin/u);
	} finally { await watcher.close(); }
});

it("reports a same-storage owner inside its storage instead of falling back", { timeout: 30000 }, async (t) => {
	const root = fixtureRoot(t);
	const sessionsRoot = join(root, "sessions");
	const primary = randomUUID();
	const received = eventLog<PrimaryDelivery>();
	const channel = await createPrimaryChannel({
		id: primary,
		cwd: root,
		sessionsRoot,
		deliver: (message) => {
			received.push(message);
		},
		promptTrust: async () => undefined,
	});
	t.after(async () => {
		await channel.close().catch(() => undefined);
	});
	const sourcePath = join(root, "source.sqlite");
	const source = await openHost(sourcePath, "11111111-1111-4111-8111-111111111111", root);
	t.after(async () => {
		await source.close().catch(() => undefined);
	});
	const sibling = await source.harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: { provider: fixtureProvider, modelId: fixtureModelId } } }, BACKGROUND_CONTEXT);
	const owner = source.identity(sibling.id);
	const admitted = (await source.request(
		"submit",
		{ sessionId: source.storageId, message: "scheduled task", requestId: "same-storage-owner", ownerId: owner, origin: "model" },
		BACKGROUND_CONTEXT,
	)) as { submissionId: SubmissionId };
	await source.wait(admitted.submissionId, BACKGROUND_CONTEXT);
	const errors = eventLog<Error>();
	const watcher = startDurableDelivery({
		host: source,
		metadata: sourceMetadata(root, source.storageId, sourcePath),
		catalog: new AgentCatalog(root),
		sessionsRoot,
		signal: new AbortController().signal,
		onError: (error) => errors.push(error),
	});
	t.after(() => watcher.close());
	await waitForDelivery(source, async () => (await deliveryState(source))?.receipts[String(admitted.submissionId)]?.acknowledged === true);
	assert.equal(received.length, 0, "a same-storage owner never routes through a primary");
	const entries = await sibling.entries({}, 20, undefined, BACKGROUND_CONTEXT);
	assert.equal(entries.items.filter((entry) => entry.kind === "agent.input").length, 1);
	assert.match(JSON.stringify(entries.items), /Agent result from/u);
	const sourceEntries = await source.root().entries({}, 20, undefined, BACKGROUND_CONTEXT);
	assert.doesNotMatch(JSON.stringify(sourceEntries.items), /Agent result from/u);
	assert.deepEqual(errors, []);
});

it("reports a malformed admission origin without crash-looping and keeps other rows moving", { timeout: 30000 }, async (t) => {
	const root = fixtureRoot(t);
	const sessionsRoot = join(root, "sessions");
	const corruptOwner = randomUUID();
	const goodOwner = randomUUID();
	const received = eventLog<PrimaryDelivery>();
	const channel = await createPrimaryChannel({
		id: goodOwner,
		cwd: root,
		sessionsRoot,
		deliver: (message) => {
			received.push(message);
		},
		promptTrust: async () => undefined,
	});
	t.after(async () => {
		await channel.close().catch(() => undefined);
	});
	const sourcePath = join(root, "source.sqlite");
	const source = await openHost(sourcePath, "11111111-1111-4111-8111-111111111111", root);
	t.after(async () => {
		await source.close().catch(() => undefined);
	});
	const corruptId = await addReceipt(source, corruptOwner, "corrupt-origin");
	const goodId = await addReceipt(source, goodOwner, "good-origin");
	// Remove the origin to exercise containment of a malformed current receipt.
	await settleDeliveries(source.harness, BACKGROUND_CONTEXT);
	await source.harness.commit(async (tx) => editDeliveryFixture(tx, async (deliveryFixtureState) => {
		const state = deliveryFixtureState;
		const receipt = state.receipts[String(corruptId)];
		if (receipt !== undefined) {
			const { origin: _removed, ...rest } = receipt;
			state.receipts[String(corruptId)] = rest;
		}
	}), BACKGROUND_CONTEXT);
	const errors = eventLog<Error>();
	const watcher = startDurableDelivery({
		host: source,
		metadata: sourceMetadata(root, source.storageId, sourcePath),
		catalog: new AgentCatalog(root),
		sessionsRoot,
		signal: new AbortController().signal,
		onError: (error) => errors.push(error),
	});
	t.after(() => watcher.close());
	await received.waitForCount(1);
	await waitForDelivery(source, async () => (await deliveryState(source))?.receipts[String(goodId)]?.acknowledged === true);
	assert.equal((await deliveryState(source))?.receipts[String(corruptId)]?.acknowledged, false, "the malformed row stays pending");
	await errors.waitForCount(1);
	assert.match(errors[0]?.message ?? "", /terminal: corrupt admission origin/u);
	const status = (await source.request("status", {})) as { deliveryError?: string };
	assert.match(status.deliveryError ?? "", /terminal: corrupt admission origin/u, "the corruption stays visible in host status");
	assert.ok(errors.every((error) => /terminal: corrupt admission origin/u.test(error.message)), "every report names the corruption");
});

it("clears the delivery error after a malformed receipt is corrected", { timeout: 5000 }, async (t) => {
	const root = fixtureRoot(t);
	const sessionsRoot = join(root, "sessions");
	const owner = randomUUID();
	const channel = await createPrimaryChannel({ id: owner, cwd: root, sessionsRoot, deliver() {}, promptTrust: async () => undefined });
	t.after(() => channel.close());
	const path = join(root, "source.sqlite");
	const source = await openHost(path, "11111111-1111-4111-8111-111111111111", root);
	t.after(() => source.close());
	const id = await addReceipt(source, owner, "corrected-origin");
	await settleDeliveries(source.harness, BACKGROUND_CONTEXT);
	await source.harness.commit(async (tx) => editDeliveryFixture(tx, async (deliveryFixtureState) => {
		const state = deliveryFixtureState;
		const receipt = state.receipts[String(id)];
		assert.ok(receipt);
		const { origin: _removed, ...rest } = receipt;
		state.receipts[String(id)] = rest;
	}), BACKGROUND_CONTEXT);
	let reported!: () => void;
	const corruption = new Promise<void>((resolve) => { reported = resolve; });
	let cleared!: () => void;
	const clearance = new Promise<void>((resolve) => { cleared = resolve; });
	let corrected = false;
	const report = source.reportDeliveryError.bind(source);
	source.reportDeliveryError = (error) => {
		report(error);
		if (corrected && error === undefined) cleared();
	};
	const watcher = startDurableDelivery({ host: source, metadata: sourceMetadata(root, source.storageId, path),
		catalog: new AgentCatalog(root), sessionsRoot, signal: new AbortController().signal, onError: () => reported() });
	t.after(() => watcher.close());
	await corruption;
	assert.match(((await source.request("status", {})) as { deliveryError?: string }).deliveryError ?? "", /terminal: corrupt admission origin/u);
	corrected = true;
	await source.harness.commit(async (tx) => editDeliveryFixture(tx, async (deliveryFixtureState) => {
		const state = deliveryFixtureState;
		const receipt = state.receipts[String(id)];
		assert.ok(receipt);
		const { delivery: _terminal, ...repaired } = receipt;
		state.receipts[String(id)] = { ...repaired, origin: "operator" };
	}), BACKGROUND_CONTEXT);
	await clearance;
	assert.equal(((await source.request("status", {})) as { deliveryError?: string }).deliveryError, undefined);
	assert.equal((await deliveryState(source))?.receipts[String(id)]?.acknowledged, true);
});

it("holds a quiet notice for an older owner, then delivers after that owner restarts", { timeout: 30000 }, async (t) => {
	const root = fixtureRoot(t);
	const sessionsRoot = join(root, "sessions");
	const owner = randomUUID();
	const received = eventLog<PrimaryDelivery>();
	const ownerProcess = spawn(process.execPath, ["-e", "process.stdin.resume()"], { stdio: ["pipe", "ignore", "ignore"] });
	assert.ok(ownerProcess.pid);
	const exited = waitForProcessExit(ownerProcess, 30000);
	void exited.catch(() => undefined);
	t.after(async () => { ownerProcess.kill("SIGTERM"); await exited; });
	writeIncompatibleEndpoint(sessionsRoot, owner, ownerProcess.pid);
	const sourcePath = join(root, "source.sqlite");
	const source = await openHost(sourcePath, "11111111-1111-4111-8111-111111111111", root);
	t.after(async () => {
		await source.close().catch(() => undefined);
	});
	const admitted = (await source.request(
		"submit",
		{ sessionId: source.storageId, message: "board task", requestId: "older-owner", ownerId: owner, origin: "operator" },
		BACKGROUND_CONTEXT,
	)) as { submissionId: SubmissionId };
	await source.wait(admitted.submissionId, BACKGROUND_CONTEXT);
	const reported = eventLog<Error | undefined>();
	const report = source.reportDeliveryError.bind(source);
	source.reportDeliveryError = (error) => { report(error); reported.push(error); };
	const errors = eventLog<Error>();
	const watcher = startDurableDelivery({
		host: source,
		metadata: sourceMetadata(root, source.storageId, sourcePath),
		catalog: new AgentCatalog(root),
		sessionsRoot,
		signal: new AbortController().signal,
		onError: (error) => errors.push(error),
	});
	t.after(() => watcher.close());
	await errors.waitForCount(1);
	assert.ok(errors[0]?.message.includes("primary-delivery/9.0.0"));
	assert.match(errors[0]?.message ?? "", /Restart that Pi/u);
	assert.equal(received.length, 0, "an older owner never receives the quiet notice");
	const pending = await deliveryState(source);
	assert.equal(pending?.receipts[String(admitted.submissionId)]?.acknowledged, false, "the row stays pending");
	const status = (await source.request("status", {})) as { deliveryError?: string };
	assert.match(status.deliveryError ?? "", /Restart that Pi/u, "the host status names the restart");
	structuredObservation(StatusOutputSchema, { ...status, inventory: { contributions: [], ordinaryOnly: [] }, pid: 4, storageId: source.storageId });

	// Replacement follows the recorded owner's real exit, never a failed connection.
	ownerProcess.kill("SIGTERM");
	await exited;
	const channel = await createPrimaryChannel({
		id: owner,
		cwd: root,
		sessionsRoot,
		deliver: (message) => {
			received.push(message);
		},
		promptTrust: async () => undefined,
	});
	t.after(async () => {
		await channel.close().catch(() => undefined);
	});
	watcher.refresh();
	await received.waitForCount(1);
	await waitForDelivery(source, async () => (await deliveryState(source))?.receipts[String(admitted.submissionId)]?.acknowledged === true);
	const notice = received[0]?.details as { wake?: unknown } | undefined;
	assert.equal(notice?.wake, false, "the delivered notice stays quiet");
	await reported.waitFor((events) => events.includes(undefined));
	const cleared = (await source.request("status", {})) as { deliveryError?: string };
	assert.equal(cleared.deliveryError, undefined, "a successful pass clears the reported delivery error");
});

it("holds a fallback when a registered primary runs an older endpoint", { timeout: 30000 }, async (t) => {
	const root = fixtureRoot(t);
	const sessionsRoot = join(root, "sessions");
	const absentOwner = randomUUID();
	const older = randomUUID();
	const compatible = randomUUID();
	const received = eventLog<PrimaryDelivery>();
	const channel = await createPrimaryChannel({
		id: compatible,
		cwd: root,
		sessionsRoot,
		deliver: (message) => {
			received.push(message);
		},
		promptTrust: async () => undefined,
	});
	t.after(async () => {
		await channel.close().catch(() => undefined);
	});
	writeIncompatibleEndpoint(sessionsRoot, older);
	const sourcePath = join(root, "source.sqlite");
	const source = await openHost(sourcePath, "11111111-1111-4111-8111-111111111111", root);
	t.after(async () => {
		await source.close().catch(() => undefined);
	});
	const submissionId = await addReceipt(source, absentOwner, "older-candidate");
	const errors = eventLog<Error>();
	const watcher = startDurableDelivery({
		host: source,
		metadata: sourceMetadata(root, source.storageId, sourcePath),
		catalog: new AgentCatalog(root),
		sessionsRoot,
		signal: new AbortController().signal,
		onError: (error) => errors.push(error),
	});
	t.after(() => watcher.close());
	await errors.waitForCount(1);
	assert.ok(errors[0]?.message.includes("primary-delivery/9.0.0"));
	assert.match(errors[0]?.message ?? "", /stays unacknowledged/u);
	assert.equal(received.length, 0, "no registered primary receives while an older primary is registered");
	const state = await deliveryState(source);
	assert.equal(state?.receipts[String(submissionId)]?.acknowledged, false, "the fallback row stays pending");
});

it("falls back to one registered live primary when the owning endpoint is absent", { timeout: 30000 }, async (t) => {
	const root = fixtureRoot(t);
	const sessionsRoot = join(root, "sessions");
	const absentOwner = randomUUID();
	const fallbackOwner = randomUUID();
	const received = eventLog<PrimaryDelivery>();
	const channel = await createPrimaryChannel({
		id: fallbackOwner,
		cwd: root,
		sessionsRoot,
		deliver: (message) => {
			received.push(message);
		},
		promptTrust: async () => undefined,
	});
	t.after(async () => {
		await channel.close().catch(() => undefined);
	});
	const sourcePath = join(root, "source.sqlite");
	const source = await openHost(sourcePath, "11111111-1111-4111-8111-111111111111", root);
	t.after(async () => {
		await source.close().catch(() => undefined);
	});
	const submissionId = await addReceipt(source, absentOwner);
	const errors = eventLog<Error>();
	const watcher = startDurableDelivery({
		host: source,
		metadata: sourceMetadata(root, source.storageId, sourcePath),
		catalog: new AgentCatalog(root),
		sessionsRoot,
		signal: new AbortController().signal,
		onError: (error) => errors.push(error),
	});
	await received.waitForCount(1);
	await waitForDelivery(source, async () => (await deliveryState(source))?.receipts[String(submissionId)]?.fallbackRecipients?.length === 1);
	const message = received[0];
	const details = message.details as Record<string, unknown>;
	assert.equal(details.fallback, true);
	assert.equal(details.fallbackLabel, "no live owning session");
	assert.equal(details.label, "11111111-1111-4111-8111-111111111111");
	assert.equal(details.wake, false, "a fallback broadcast never wakes a primary model");
	assert.equal(details.originalOwnerId, absentOwner);
	assert.equal(details.liveOwner, false);
	assert.equal(details.deliveryRecipient, fallbackOwner);
	assert.equal(details.identity, "11111111-1111-4111-8111-111111111111");
	assert.match(message.text, /no live owning session/u);
	assert.ok(message.text.includes(absentOwner));
	const state = await deliveryState(source);
	assert.equal(state?.receipts[String(submissionId)]?.acknowledged, false);
	assert.deepEqual(errors, []);
	await watcher.close();
});

it("refuses fallback when the live owning endpoint is unreachable", { timeout: 30000 }, async (t) => {
	const root = fixtureRoot(t);
	const sessionsRoot = join(root, "sessions");
	const owner = randomUUID();
	const other = randomUUID();
	const ownerDeliveries: PrimaryDelivery[] = [];
	const otherDeliveries: PrimaryDelivery[] = [];
	const ownerChannel = await createPrimaryChannel({
		id: owner,
		cwd: root,
		sessionsRoot,
		deliver: (message) => {
			ownerDeliveries.push(message);
		},
		promptTrust: async () => undefined,
	});
	const otherChannel = await createPrimaryChannel({
		id: other,
		cwd: root,
		sessionsRoot,
		deliver: (message) => {
			otherDeliveries.push(message);
		},
		promptTrust: async () => undefined,
	});
	t.after(async () => {
		await ownerChannel.close().catch(() => undefined);
		await otherChannel.close().catch(() => undefined);
	});
	unlinkSync(ownerChannel.socketPath);
	const sourcePath = join(root, "source.sqlite");
	const source = await openHost(sourcePath, "11111111-1111-4111-8111-111111111111", root);
	t.after(async () => {
		await source.close().catch(() => undefined);
	});
	const submissionId = await addReceipt(source, owner);
	const errors = eventLog<Error>();
	const watcher = startDurableDelivery({
		host: source,
		metadata: sourceMetadata(root, source.storageId, sourcePath),
		catalog: new AgentCatalog(root),
		sessionsRoot,
		retryDelayMs: 5,
		signal: new AbortController().signal,
		onError: (error) => errors.push(error),
	});
	await errors.waitForCount(1);
	assert.equal(ownerDeliveries.length, 0);
	assert.equal(otherDeliveries.length, 0, "a live but unreachable owner refuses fallback");
	const state = await deliveryState(source);
	assert.equal(state?.receipts[String(submissionId)]?.acknowledged, false);
	await watcher.close();
});

it("refuses primary-channel routing for a malformed catalog record", { timeout: 30000 }, async (t) => {
	const root = fixtureRoot(t);
	const sessionsRoot = join(root, "sessions");
	const owner = randomUUID();
	const received = eventLog<PrimaryDelivery>();
	const channel = await createPrimaryChannel({
		id: owner,
		cwd: root,
		sessionsRoot,
		deliver: (message) => {
			received.push(message);
		},
		promptTrust: async () => undefined,
	});
	t.after(async () => {
		await channel.close().catch(() => undefined);
	});
	mkdirSync(join(root, "durable"), { recursive: true });
	writeFileSync(join(root, "durable", `${owner}.json`), JSON.stringify({ storageId: owner }), { mode: 0o600 });
	const sourcePath = join(root, "source.sqlite");
	const source = await openHost(sourcePath, "11111111-1111-4111-8111-111111111111", root);
	t.after(async () => {
		await source.close().catch(() => undefined);
	});
	const submissionId = await addReceipt(source, owner);
	const errors = eventLog<Error>();
	const watcher = startDurableDelivery({
		host: source,
		metadata: sourceMetadata(root, source.storageId, sourcePath),
		catalog: new AgentCatalog(root),
		sessionsRoot,
		retryDelayMs: 5,
		signal: new AbortController().signal,
		onError: (error) => errors.push(error),
	});
	await errors.waitForCount(1);
	assert.equal(received.length, 0, "a malformed catalog record must not route to a primary channel");
	const state = await deliveryState(source);
	assert.equal(state?.receipts[String(submissionId)]?.acknowledged, false);
	await watcher.close();
});

it("acknowledges a primary-channel row only after the channel accepts it", { timeout: 30000 }, async (t) => {
	const root = fixtureRoot(t);
	const sessionsRoot = join(root, "sessions");
	const owner = randomUUID();
	const received = eventLog<PrimaryDelivery>();
	let attempts = 0;
	let enteredSecondAttempt: (() => void) | undefined;
	const entered = new Promise<void>((resolve) => {
		enteredSecondAttempt = resolve;
	});
	let release: (() => void) | undefined;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const channel = await createPrimaryChannel({
		id: owner,
		cwd: root,
		sessionsRoot,
		deliver: async (message) => {
			attempts += 1;
			if (attempts === 1) throw new Error("display unavailable");
			enteredSecondAttempt?.();
			await gate;
			received.push(message);
		},
		promptTrust: async () => undefined,
	});
	t.after(async () => {
		await channel.close().catch(() => undefined);
	});
	const sourcePath = join(root, "source.sqlite");
	const source = await openHost(sourcePath, "11111111-1111-4111-8111-111111111111", root);
	t.after(async () => {
		await source.close().catch(() => undefined);
	});
	const submissionId = await addReceipt(source, owner);
	const errors = eventLog<Error>();
	const watcher = startDurableDelivery({
		host: source,
		metadata: sourceMetadata(root, source.storageId, sourcePath),
		catalog: new AgentCatalog(root),
		sessionsRoot,
		retryDelayMs: 5,
		signal: new AbortController().signal,
		onError: (error) => errors.push(error),
	});
	await entered;
	const pending = await deliveryState(source);
	assert.equal(
		pending?.receipts[String(submissionId)]?.acknowledged,
		false,
		"no acknowledgement before the channel accepts",
	);
	release?.();
	await waitForDelivery(source, async () => (await deliveryState(source))?.receipts[String(submissionId)]?.acknowledged === true);
	assert.ok(attempts >= 2, `the failed delivery was retried, received ${attempts}`);
	assert.equal(received.length, 1, "the accepted delivery is displayed once");
	await watcher.close();
});

async function retryFixture(t: TestContext, gate?: Promise<void>) {
	const root = fixtureRoot(t);
	const catalog = new AgentCatalog(root);
	const record = catalog.create({ cwd: root, agentDir: join(root, "agent"), packageDir: join(root, "package"),
		model: { provider: fixtureProvider, modelId: fixtureModelId }, thinkingLevel: "off" });
	const path = join(root, "source.sqlite");
	const source = await openHost(path, "11111111-1111-4111-8111-111111111111", root);
	t.after(() => source.close());
	const id = await addReceipt(source, record.storageId);
	await settleDeliveries(source.harness, BACKGROUND_CONTEXT);
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const commits = t.mock.method(source.harness, "commit");
	const entered = eventLog<void>();
	const idle = eventLog<void>();
	const errors = eventLog<Error>();
	const watcher = startDurableDelivery({ host: source, metadata: sourceMetadata(root, source.storageId, path), catalog,
		signal: new AbortController().signal, retryDelayMs: 500,
		acquire: async () => ({ ...fakeTarget(source, []), request: async () => { entered.push(undefined); if (gate) await gate; throw new Error("transient"); } }),
		onError: (error) => errors.push(error), onIdle: () => idle.push(undefined) });
	t.after(() => watcher.close());
	const publish = () => source.harness.commit(async (tx) => editDeliveryFixture(tx, async (deliveryFixtureState) => {
		const state = deliveryFixtureState;
		const receipt = state.receipts[String(id)];
		assert.ok(receipt);
		state.receipts[String(id)] = { ...receipt, answer: randomUUID() };
	}), BACKGROUND_CONTEXT);
	return { source, commits, entered, idle, errors, watcher, publish };
}

it("completes terminal automatic notices beyond a no-write page without routing activity", { timeout: 30000 }, async (t) => {
	const root = fixtureRoot(t), path = join(root, "source.sqlite"), owner = "22222222-2222-4222-8222-222222222222";
	let release = () => {};
	const gate = new Promise<void>((resolve) => { release = resolve; });
	const started = eventLog<void>();
	const source = await DurableHost.open({ storagePath: path, storageId: "11111111-1111-4111-8111-111111111111", cwd: root,
		models: await scriptedRuntime([toolCallMessage("gate"), answerMessage("finished")]), registry: fixtureRegistry([gateTool(gate, () => { started.push(undefined); })]),
		agent: { model: { provider: fixtureProvider, modelId: fixtureModelId } } }, BACKGROUND_CONTEXT);
	t.after(async () => { release(); await source.close(); });
	const watched = await source.root().submit({ type: "input", content: "finish later", requestId: "finishing" }, BACKGROUND_CONTEXT);
	await started.waitForCount(1);
	const live = await source.harness.snapshot(LiveDoc, 1 as ConversationId, BACKGROUND_CONTEXT);
	assert.ok(live?.run);
	const runId = live.run.taskId;
	await settleDeliveries(source.harness, BACKGROUND_CONTEXT);
	const terminalNotice = (sourceId: string, requestId: string) => ({ sourceId, requestId: sourceId, ownerId: owner, senderIdentity: source.storageId, message: "check-in", replyTo: null, acknowledged: false, createdAt: 0,
		delivery: { state: "terminal" as const, reason: "corrupt admission origin" }, checkIn: { conversationId: 1, requestId, origin: "model" as const, elapsedMs: 60000, cost: null } });
	await source.harness.commit(async (tx) => {
		for (let index = 0; index < 64; index++) await storeDeliveryRow(tx, "report", terminalNotice(`check-in:1:unresolved-${index}:1`, `unresolved-${index}`), true);
		await storeDeliveryRow(tx, "report", terminalNotice("check-in:1:finishing:1", "finishing"), true);
		await storeDeliveryRow(tx, "report", { sourceId: "report:retry-terminal", requestId: "retry-terminal", ownerId: owner, senderIdentity: source.storageId, message: "retry summary", replyTo: null, acknowledged: false, createdAt: 0,
			delivery: { state: "terminal", reason: "corrupt admission origin" }, providerRetry: { fact: { sessionId: source.storageId, observedAt: 0, source: "producer await-state", execution: { state: "provider-retry", runId,
				results: [{ sessionId: source.storageId, submissionId: watched.id, requestId: "finishing" }], attempt: 1, nextRetryAt: 0, error: "fixture retry", errorTruncated: false } } } }, true);
	}, BACKGROUND_CONTEXT);
	assert.deepEqual((await pendingDeliveryPage(source.harness, BACKGROUND_CONTEXT)).state.reports, []);
	assert.equal(await deliveryPendingCount(source.harness, BACKGROUND_CONTEXT), 66);
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const idle = eventLog<void>();
	let publications = 0;
	const unsubscribe = onStoredCommit(source.harness, () => { publications += 1; });
	t.after(unsubscribe);
	const watcher = startDurableDelivery({ host: source, metadata: sourceMetadata(root, source.storageId, path), catalog: new AgentCatalog(root), signal: new AbortController().signal, onIdle: () => idle.push(undefined) });
	t.after(() => watcher.close());
	t.mock.timers.tick(0); await idle.waitForCount(1);
	assert.equal(publications, 0, "the first automatic page changes no records");
	t.mock.timers.tick(0); await idle.waitForCount(2);
	assert.equal(publications, 0, "continuation visits unsettled notices without a commit wake");
	release(); await source.wait(watched.id, BACKGROUND_CONTEXT);
	const beforeCompletion = idle.length;
	t.mock.timers.tick(0); await idle.waitForCount(beforeCompletion + 1);
	t.mock.timers.tick(0); await idle.waitForCount(beforeCompletion + 2);
	const retained = await deliveryState(source);
	assert.equal(retained.reports.find((row) => row.sourceId === "check-in:1:finishing:1")?.acknowledged, true);
	assert.equal(retained.reports.find((row) => row.sourceId === "report:retry-terminal")?.acknowledged, true);
	assert.equal(await deliveryPendingCount(source.harness, BACKGROUND_CONTEXT), 64);
	await watcher.close();
	await source.harness.commit((tx) => storeDeliveryRow(tx, "report", terminalNotice("check-in:1:finishing:2", "finishing"), true), BACKGROUND_CONTEXT);
	assert.equal((await undeliveredReports(source.harness, owner, BACKGROUND_CONTEXT)).length, 64, "an explicit owner query retires its settled terminal candidate without a watcher");
	assert.equal(await deliveryPendingCount(source.harness, BACKGROUND_CONTEXT), 64);
});

for (const completed of ["routing", "automatic"] as const) it(`preserves committed activity after ${completed} traversal completion`, { timeout: 30000 }, async (t) => {
	const root = fixtureRoot(t), path = join(root, "source.sqlite"), catalog = new AgentCatalog(root), owner = "22222222-2222-4222-8222-222222222222";
	const recipient = catalog.create({ cwd: root, agentDir: join(root, "agent"), packageDir: join(root, "package"), model: { provider: fixtureProvider, modelId: fixtureModelId }, thinkingLevel: "off" });
	let release = () => {};
	const gate = new Promise<void>((resolve) => { release = resolve; }), started = eventLog<void>();
	const source = await DurableHost.open({ storagePath: path, storageId: "11111111-1111-4111-8111-111111111111", cwd: root,
		models: await scriptedRuntime([toolCallMessage("gate"), answerMessage("finished")]), registry: fixtureRegistry([gateTool(gate, () => { started.push(undefined); })]),
		agent: { model: { provider: fixtureProvider, modelId: fixtureModelId } } }, BACKGROUND_CONTEXT);
	t.after(async () => { release(); await source.close(); });
	const watched = await source.root().submit({ type: "input", content: "finish later", requestId: "finishing" }, BACKGROUND_CONTEXT);
	await started.waitForCount(1);
	await settleDeliveries(source.harness, BACKGROUND_CONTEXT);
	await source.harness.commit(async (tx) => {
		for (let index = 0; index < 65; index++) await storeDeliveryRow(tx, "report", {
			sourceId: `report:existing-${index}`, requestId: `existing-${index}`, ownerId: owner, senderIdentity: source.storageId, message: "current", replyTo: null, acknowledged: false, createdAt: index, direct: true,
			delivery: completed === "routing" ? { state: "terminal", reason: "corrupt admission origin" } : { state: "parked", reason: "primary endpoint is absent" },
			...(completed === "routing" ? { checkIn: { conversationId: 1, requestId: `unresolved-${index}`, origin: "model" as const, elapsedMs: 60000, cost: null } } : {}),
		}, true);
		if (completed === "automatic") await storeDeliveryRow(tx, "report", { sourceId: "check-in:1:finishing:1", requestId: "check-in:1:finishing:1", ownerId: owner, senderIdentity: source.storageId,
			message: "watched", replyTo: null, acknowledged: false, createdAt: 0, delivery: { state: "terminal", reason: "corrupt admission origin" },
			checkIn: { conversationId: 1, requestId: "finishing", origin: "model", elapsedMs: 60000, cost: null } }, true);
	}, BACKGROUND_CONTEXT);
	const idle = eventLog<void>();
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const watcher = startDurableDelivery({ host: source, metadata: sourceMetadata(root, source.storageId, path), catalog, signal: new AbortController().signal,
		acquire: async () => ({ ...fakeTarget(source, []), request: async () => ({}) }), onIdle: () => idle.push(undefined) });
	t.after(() => watcher.close());
	t.mock.timers.tick(0); await idle.waitForCount(1);
	if (completed === "routing") await recordReport(source.harness, { ownerId: recipient.storageId, senderIdentity: source.storageId, message: "fresh", requestId: "fresh" }, BACKGROUND_CONTEXT);
	else { release(); await source.wait(watched.id, BACKGROUND_CONTEXT); }
	t.mock.timers.tick(0); await idle.waitForCount(2);
	t.mock.timers.tick(0); await idle.waitForCount(3);
	const sourceId = completed === "routing" ? "report:fresh" : "check-in:1:finishing:1";
	assert.equal((await deliveryState(source)).reports.find((row) => row.sourceId === sourceId)?.acknowledged, true, "committed work refreshes a completed traversal before quiescence");
	assert.equal(await deliveryPendingCount(source.harness, BACKGROUND_CONTEXT), 65);
	await watcher.close();
});

for (const phase of ["before", "during"] as const) it(`keeps no-write page traversals finite with an unrelated settlement ${phase} the watcher pass`, { timeout: 15000 }, async (t) => {
	const root = fixtureRoot(t), path = join(root, "source.sqlite");
	const source = await openHost(path, "11111111-1111-4111-8111-111111111111", root);
	t.after(() => source.close());
	// Existing settlement metadata makes the observed traversal genuinely no-write.
	await settleDeliveries(source.harness, BACKGROUND_CONTEXT);
	await source.harness.commit(async (tx) => {
		for (let index = 0; index < 65; index++) await storeDeliveryRow(tx, "report", {
			sourceId: `check-in:1:offset-${index}:1`, requestId: `check-in:1:offset-${index}:1`, ownerId: "22222222-2222-4222-8222-222222222222", senderIdentity: source.storageId,
			message: "current", replyTo: null, acknowledged: false, createdAt: index, direct: true,
			delivery: { state: "parked", reason: "primary endpoint is absent" },
			checkIn: { conversationId: 1, requestId: `unresolved-${index}`, origin: "model", elapsedMs: 60000, cost: null },
		}, true);
	}, BACKGROUND_CONTEXT);
	if (phase === "before") await settleDeliveries(source.harness, BACKGROUND_CONTEXT);
	let publications = 0;
	const unsubscribe = onStoredCommit(source.harness, () => { publications += 1; });
	t.after(unsubscribe);
	const commits = t.mock.method(source.harness, "commit"), idle = eventLog<void>();
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const watcher = startDurableDelivery({ host: source, metadata: sourceMetadata(root, source.storageId, path), catalog: new AgentCatalog(root), signal: new AbortController().signal, onIdle: () => idle.push(undefined) });
	t.after(() => watcher.close());
	t.mock.timers.tick(0); await idle.waitForCount(1);
	if (phase === "during") await settleDeliveries(source.harness, BACKGROUND_CONTEXT);
	t.mock.timers.tick(0); await idle.waitForCount(2);
	const completedCalls = commits.mock.callCount();
	t.mock.timers.tick(300000); await new Promise<void>(setImmediate);
	assert.equal(publications, 0);
	assert.equal(idle.length, 2, "both traversals complete instead of alternately restarting");
	assert.equal(commits.mock.callCount(), completedCalls, "a completed traversal does not start a no-write pass");
	assert.equal(watcher.busy, false);
	await watcher.close();
});

it("retries an early-page route failure after a final already-parked page", { timeout: 15000 }, async (t) => {
	const root = fixtureRoot(t), catalog = new AgentCatalog(root);
	const recipient = catalog.create({ cwd: root, agentDir: join(root, "agent"), packageDir: join(root, "package"), model: { provider: fixtureProvider, modelId: fixtureModelId }, thinkingLevel: "off" });
	const path = join(root, "source.sqlite"), source = await openHost(path, "11111111-1111-4111-8111-111111111111", root);
	t.after(() => source.close());
	await source.harness.commit(async (tx) => {
		for (let index = 0; index < 65; index++) await storeDeliveryRow(tx, "report", {
			sourceId: `report:page-${index}`, requestId: `page-${index}`, ownerId: index === 0 ? recipient.storageId : "22222222-2222-4222-8222-222222222222", senderIdentity: source.storageId,
			message: "retained", replyTo: null, acknowledged: false, createdAt: index, direct: true,
			...(index === 0 ? {} : { delivery: { state: "parked" as const, reason: "primary endpoint is absent" } }),
		}, true);
	}, BACKGROUND_CONTEXT);
	t.mock.timers.enable({ apis: ["setTimeout"] });
	let attempts = 0, publications = 0;
	const unsubscribe = onStoredCommit(source.harness, () => { publications += 1; });
	t.after(unsubscribe);
	const idle = eventLog<void>();
	const watcher = startDurableDelivery({ host: source, metadata: sourceMetadata(root, source.storageId, path), catalog, signal: new AbortController().signal, retryDelayMs: 500,
		acquire: async () => ({ ...fakeTarget(source, []), request: async () => { attempts += 1; if (attempts === 1) throw new Error("transient"); return {}; } }), onIdle: () => idle.push(undefined) });
	t.after(() => watcher.close());
	t.mock.timers.tick(0); await idle.waitForCount(1);
	const beforeLastPage = publications;
	t.mock.timers.tick(0); await idle.waitForCount(2);
	assert.equal(publications, beforeLastPage, "the final already-parked page makes no writes");
	assert.equal(attempts, 1);
	t.mock.timers.tick(499); assert.equal(attempts, 1);
	t.mock.timers.tick(1); await idle.waitForCount(3);
	assert.equal(attempts, 2, "the failed early-page route retains its backoff obligation");
	assert.equal((await deliveryState(source)).reports.find((row) => row.sourceId === "report:page-0")?.acknowledged, true);
	await watcher.close();
});

it("does not park an acknowledged row when its recipient disappears after acceptance", { timeout: 15000 }, async (t) => {
	const root = fixtureRoot(t), catalog = new AgentCatalog(root);
	const recipient = catalog.create({ cwd: root, agentDir: join(root, "agent"), packageDir: join(root, "package"), model: { provider: fixtureProvider, modelId: fixtureModelId }, thinkingLevel: "off" });
	const path = join(root, "source.sqlite"), source = await openHost(path, "11111111-1111-4111-8111-111111111111", root);
	t.after(() => source.close());
	await recordReport(source.harness, { ownerId: recipient.storageId, senderIdentity: source.storageId, message: "one report", requestId: "accepted" }, BACKGROUND_CONTEXT);
	let present = true;
	const idle = eventLog<void>(), errors = eventLog<Error>();
	const watcher = startDurableDelivery({ host: source, metadata: sourceMetadata(root, source.storageId, path), catalog, signal: new AbortController().signal,
		readTarget: () => present ? recipient : undefined,
		acquire: async () => ({ ...fakeTarget(source, []), request: async () => { present = false; return {}; } }), onIdle: () => idle.push(undefined), onError: (error) => errors.push(error) });
	t.after(() => watcher.close());
	await idle.waitForCount(1);
	const row = (await deliveryState(source)).reports.find((item) => item.sourceId === "report:accepted");
	assert.equal(row?.acknowledged, true);
	assert.equal(row?.delivery, undefined, "the post-route diagnosis uses current visited rows");
	assert.deepEqual(errors, []);
	await watcher.close();
});

it("waits for each doubled delivery retry delay through the cap and cancels on close", { timeout: 10000 }, async (t) => {
	const f = await retryFixture(t);
	t.mock.timers.tick(0);
	await f.idle.waitForCount(1);
	assert.equal(f.watcher.busy, false, "a retry timer alone is not an in-flight effect");
	for (const delay of [500, 1000, 2000, 4000, 8000, 16000, 30000, 30000]) {
		const attempts = f.errors.length;
		const commits = f.commits.mock.callCount();
		t.mock.timers.tick(delay - 1);
		assert.equal(f.commits.mock.callCount(), commits, `no delivery pass before ${delay} ms`);
		t.mock.timers.tick(1);
		await f.idle.waitForCount(attempts + 1);
		assert.equal(f.errors.length, attempts + 1, "one retry at the deadline");
	}
	await f.watcher.close();
	const commits = f.commits.mock.callCount();
	t.mock.timers.tick(30000);
	assert.equal(f.commits.mock.callCount(), commits, "close cancels the pending retry");
});

for (const trigger of ["commit", "refresh"] as const) it(`starts a delivery pass immediately after ${trigger} during backoff`, { timeout: 10000 }, async (t) => {
	const f = await retryFixture(t);
	t.mock.timers.tick(0);
	await f.idle.waitForCount(1);
	const commits = f.commits.mock.callCount();
	t.mock.timers.tick(100);
	assert.equal(f.commits.mock.callCount(), commits, "the watcher is still in backoff");
	if (trigger === "commit") await f.publish();
	else f.watcher.refresh();
	t.mock.timers.tick(0);
	await f.idle.waitForCount(2);
	assert.equal(f.errors.length, 2, "new activity does not wait for the retry deadline");
	const after = f.commits.mock.callCount();
	t.mock.timers.tick(400);
	assert.equal(f.commits.mock.callCount(), after, "the replaced deadline does not start another pass");
});

it("coalesces commits during a failed delivery pass into one immediate follow-up", { timeout: 10000 }, async (t) => {
	let release!: () => void;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	t.after(release);
	const f = await retryFixture(t, gate);
	t.mock.timers.tick(0);
	await f.entered.waitForCount(1);
	assert.equal(f.watcher.busy, true);
	await f.publish();
	await f.publish();
	release();
	await f.idle.waitForCount(1);
	t.mock.timers.tick(0);
	await f.idle.waitForCount(2);
	assert.equal(f.errors.length, 2);
	const commits = f.commits.mock.callCount();
	t.mock.timers.tick(0);
	assert.equal(f.commits.mock.callCount(), commits, "the coalesced follow-up resumes normal backoff");
});

it("preserves the live owner's wake when an absent owner shares its answer", { timeout: 15000 }, async (t) => {
	const root = fixtureRoot(t);
	const sessionsRoot = join(root, "sessions");
	const absent = randomUUID();
	const live = randomUUID();
	const received = eventLog<PrimaryDelivery>();
	const channel = await createPrimaryChannel({ id: live, cwd: root, sessionsRoot, deliver: (message) => { received.push(message); }, promptTrust: async () => undefined });
	t.after(() => channel.close());
	const sourcePath = join(root, "source.sqlite");
	const source = await openHost(sourcePath, "11111111-1111-4111-8111-111111111111", root);
	t.after(() => source.close());
	const submissionId = await addReceipt(source, absent);
	await settleDeliveries(source.harness, BACKGROUND_CONTEXT);
	await source.harness.commit(async (tx) => editDeliveryFixture(tx, async (deliveryFixtureState) => {
		const state = deliveryFixtureState;
		state.receipts["999"] = { ...state.receipts[String(submissionId)], submissionId: 999 as SubmissionId, ownerId: live, origin: "model" };
	}), BACKGROUND_CONTEXT);
	const idle = eventLog<void>();
	const watcher = startDurableDelivery({ host: source, metadata: sourceMetadata(root, source.storageId, sourcePath), catalog: new AgentCatalog(root), sessionsRoot, signal: new AbortController().signal, onIdle: () => idle.push(undefined) });
	t.after(() => watcher.close());
	await received.waitForCount(1);
	await idle.waitForCount(1);
	const normal = received.find((message) => (message.details as { liveOwner: boolean }).liveOwner);
	assert.ok(normal, "a fallback never substitutes for the live owner's delivery");
	assert.equal((normal.details as { wake: boolean }).wake, true);
	assert.equal((await deliveryState(source))?.receipts[String(submissionId)]?.acknowledged, false);
	assert.equal((await deliveryState(source))?.receipts["999"]?.acknowledged, true);
});

for (const kind of ["receipt", "report"] as const) it(`keeps a dead owner's ${kind} pending across fallback and source reopen`, { timeout: 30000 }, async (t) => {
	const root = fixtureRoot(t);
	const sessionsRoot = join(root, "sessions");
	const owner = randomUUID();
	const other = randomUUID();
	const dead = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
	await waitForProcessExit(dead, 5000);
	assert.ok(dead.pid);
	writeIncompatibleEndpoint(sessionsRoot, owner, dead.pid);
	const fallback = eventLog<PrimaryDelivery>();
	let channel = await createPrimaryChannel({ id: other, cwd: root, sessionsRoot, deliver: (message) => { fallback.push(message); }, promptTrust: async () => undefined });
	const sourcePath = join(root, "source.sqlite");
	let source = await openHost(sourcePath, "11111111-1111-4111-8111-111111111111", root);
	let watcher: ReturnType<typeof startDurableDelivery> | undefined;
	t.after(async () => { await watcher?.close(); await channel.close(); await source.close(); });
	const submissionId = kind === "receipt" ? await addReceipt(source, owner) : undefined;
	if (kind === "report") await recordReport(source.harness, { ownerId: owner, senderIdentity: source.storageId, message: "result", requestId: "offline-report" }, BACKGROUND_CONTEXT);
	const row = async () => {
		const state = await deliveryState(source);
		return kind === "receipt" ? state?.receipts[String(submissionId)] : state?.reports[0];
	};
	const idle = eventLog<void>();
	const start = () => startDurableDelivery({ host: source, metadata: sourceMetadata(root, source.storageId, sourcePath), catalog: new AgentCatalog(root), sessionsRoot, signal: new AbortController().signal, onIdle: () => idle.push(undefined) });
	watcher = start();
	await fallback.waitForCount(1);
	await idle.waitForCount(1);
	assert.equal((await row())?.acknowledged, false, "fallback is informational, not owner acceptance");
	assert.deepEqual((await row() as { fallbackRecipients?: string[] })?.fallbackRecipients, [other]);
	assert.equal((fallback[0].details as { wake: boolean }).wake, false);
	assert.match(fallback[0].text, /no live owning session/u);
	await watcher.close();
	await source.close();
	await channel.close();
	channel = await createPrimaryChannel({ id: other, cwd: root, sessionsRoot, deliver: (message) => { fallback.push(message); }, promptTrust: async () => undefined });
	source = await openHost(sourcePath, "11111111-1111-4111-8111-111111111111", root);
	const passes = idle.length;
	watcher = start();
	await idle.waitForCount(passes + 1);
	assert.equal(fallback.length, 1, "retained recipient state survives both source and receiver reopen");
	const direct = eventLog<PrimaryDelivery>();
	const ownerChannel = await createPrimaryChannel({ id: owner, cwd: root, sessionsRoot, deliver: (message) => { direct.push(message); }, promptTrust: async () => undefined });
	t.after(() => ownerChannel.close());
	await watcher.close();
	watcher = start();
	await direct.waitForCount(1);
	await waitForDelivery(source, async () => (await row())?.acknowledged === true);
	await watcher.close();
	watcher = start();
	await idle.waitForCount(idle.length + 1);
	assert.equal(direct.length, 1, "one normal owner delivery per registration");
	assert.equal(fallback.length, 1);
});

it("broadcasts a fallback to every registered live primary exactly once", { timeout: 30000 }, async (t) => {
	const root = fixtureRoot(t);
	const sessionsRoot = join(root, "sessions");
	const absentOwner = randomUUID();
	const first = randomUUID();
	const second = randomUUID();
	const firstReceived = eventLog<PrimaryDelivery>();
	const secondReceived = eventLog<PrimaryDelivery>();
	const firstChannel = await createPrimaryChannel({
		id: first,
		cwd: root,
		sessionsRoot,
		deliver: (message) => {
			firstReceived.push(message);
		},
		promptTrust: async () => undefined,
	});
	const secondChannel = await createPrimaryChannel({
		id: second,
		cwd: root,
		sessionsRoot,
		deliver: (message) => {
			secondReceived.push(message);
		},
		promptTrust: async () => undefined,
	});
	t.after(async () => {
		await firstChannel.close().catch(() => undefined);
		await secondChannel.close().catch(() => undefined);
	});
	const sourcePath = join(root, "source.sqlite");
	const source = await openHost(sourcePath, "11111111-1111-4111-8111-111111111111", root);
	t.after(async () => {
		await source.close().catch(() => undefined);
	});
	const submissionId = await addReceipt(source, absentOwner);
	const errors = eventLog<Error>();
	const idle = eventLog<void>();
	const watcher = startDurableDelivery({
		host: source,
		metadata: sourceMetadata(root, source.storageId, sourcePath),
		catalog: new AgentCatalog(root),
		sessionsRoot,
		signal: new AbortController().signal,
		onError: (error) => errors.push(error),
		onIdle: () => idle.push(undefined),
	});
	try {
		await Promise.all([firstReceived.waitForCount(1), secondReceived.waitForCount(1)]);
		await waitForDelivery(source, async () => (await deliveryState(source))?.receipts[String(submissionId)]?.fallbackRecipients?.length === 2);
		await idle.waitFor((passes) => passes.length > 0 && !watcher.busy);
		assert.equal(firstReceived.length, 1, "the first registered primary receives exactly one");
		assert.equal(secondReceived.length, 1, "the second registered primary receives exactly one");
		for (const [id, received] of [
			[first, firstReceived],
			[second, secondReceived],
		] as const) {
			const details = received[0]?.details as Record<string, unknown>;
			assert.equal(received[0]?.sourceId, await receiptSourceId(source, submissionId, id));
			assert.equal(details.fallback, true);
			assert.equal(details.fallbackLabel, "no live owning session");
			assert.equal(details.wake, false, "a fallback broadcast never wakes a primary model");
			assert.equal(details.originalOwnerId, absentOwner);
			assert.equal(details.deliveryRecipient, id);
		}
		const state = await deliveryState(source);
		assert.equal(
			state?.receipts[String(submissionId)]?.acknowledged,
			false,
			"the row waits for its owner after every fallback recipient accepts",
		);
	} finally {
		await watcher.close();
	}
	assert.ok(errors.length > 0, "the absent owner remains parked after informational fallback");
	for (const error of errors) {
		assert.equal(error.message, `Delivery receipt:${submissionId} to ${absentOwner}: parked: primary endpoint is absent`);
	}
});

it("retries a failed broadcast without duplicating a successful receiver", { timeout: 30000 }, async (t) => {
	const root = fixtureRoot(t);
	const sessionsRoot = join(root, "sessions");
	const absentOwner = randomUUID();
	const stable = randomUUID();
	const failing = randomUUID();
	const stableKeys: string[] = [];
	const failingKeys: string[] = [];
	let failingAttempts = 0;
	const stableChannel = await createPrimaryChannel({
		id: stable,
		cwd: root,
		sessionsRoot,
		deliver: (message) => {
			stableKeys.push(message.sourceId);
		},
		promptTrust: async () => undefined,
	});
	const failingChannel = await createPrimaryChannel({
		id: failing,
		cwd: root,
		sessionsRoot,
		deliver: (message) => {
			failingAttempts += 1;
			if (failingAttempts === 1) throw new Error("display unavailable");
			failingKeys.push(message.sourceId);
		},
		promptTrust: async () => undefined,
	});
	t.after(async () => {
		await stableChannel.close().catch(() => undefined);
		await failingChannel.close().catch(() => undefined);
	});
	const sourcePath = join(root, "source.sqlite");
	const source = await openHost(sourcePath, "11111111-1111-4111-8111-111111111111", root);
	t.after(async () => {
		await source.close().catch(() => undefined);
	});
	const submissionId = await addReceipt(source, absentOwner);
	const errors = eventLog<Error>();
	const watcher = startDurableDelivery({
		host: source,
		metadata: sourceMetadata(root, source.storageId, sourcePath),
		catalog: new AgentCatalog(root),
		sessionsRoot,
		retryDelayMs: 5,
		signal: new AbortController().signal,
		onError: (error) => errors.push(error),
	});
	await waitForDelivery(source,
		async () => (await deliveryState(source))?.receipts[String(submissionId)]?.fallbackRecipients?.length === 2,
		15000,
	);
	assert.ok(failingAttempts >= 2, `the failed candidate was retried, attempts ${failingAttempts}`);
	const expected = await receiptSourceId(source, submissionId, stable);
	const failingExpected = await receiptSourceId(source, submissionId, failing);
	assert.equal(stableKeys.length, 1, "retained state suppresses retry copies to the stable receiver");
	assert.equal(new Set(stableKeys).size, 1, "the retry preserves one source key for receiver dedup");
	for (const key of stableKeys) assert.equal(key, expected);
	assert.deepEqual(new Set(failingKeys), new Set([failingExpected]));
	assert.ok(errors.length >= 1, "the failed candidate was reported");
	await watcher.close();
});

it("refuses acknowledgement when candidate discovery is incomplete", { timeout: 30000 }, async (t) => {
	const root = fixtureRoot(t);
	const sourcePath = join(root, "source.sqlite");
	const source = await openHost(sourcePath, "11111111-1111-4111-8111-111111111111", root);
	t.after(async () => {
		await source.close().catch(() => undefined);
	});
	const submissionId = await addReceipt(source, randomUUID());
	const errors = eventLog<Error>();
	const watcher = startDurableDelivery({
		host: source,
		metadata: sourceMetadata(root, source.storageId, sourcePath),
		catalog: new AgentCatalog(root),
		sessionsRoot: join(root, "sessions"),
		retryDelayMs: 5,
		signal: new AbortController().signal,
		listPrimaryChannels: async () => ({ ids: [randomUUID()], complete: false, visited: 256 }),
		onError: (error) => errors.push(error),
	});
	await errors.waitForCount(1);
	assert.match(errors[0]?.message ?? "", /discovery is incomplete/u);
	const state = await deliveryState(source);
	assert.equal(state?.receipts[String(submissionId)]?.acknowledged, false);
	await watcher.close();
});

it("leaves a fallback row pending when no registered primary can receive it", { timeout: 30000 }, async (t) => {
	const root = fixtureRoot(t);
	const sourcePath = join(root, "source.sqlite");
	const source = await openHost(sourcePath, "11111111-1111-4111-8111-111111111111", root);
	t.after(async () => {
		await source.close().catch(() => undefined);
	});
	const submissionId = await addReceipt(source, randomUUID());
	const errors = eventLog<Error>();
	const watcher = startDurableDelivery({
		host: source,
		metadata: sourceMetadata(root, source.storageId, sourcePath),
		catalog: new AgentCatalog(root),
		sessionsRoot: join(root, "sessions"),
		retryDelayMs: 5,
		signal: new AbortController().signal,
		listPrimaryChannels: async () => ({ ids: [], complete: true, visited: 0 }),
		onError: (error) => errors.push(error),
	});
	await errors.waitForCount(1);
	assert.match(errors[0]?.message ?? "", /no live owning session/u);
	const state = await deliveryState(source);
	assert.equal(state?.receipts[String(submissionId)]?.acknowledged, false);
	await watcher.close();
});

it("leaves the broadcast pending when a registered live candidate is unreachable", { timeout: 30000 }, async (t) => {
	const root = fixtureRoot(t);
	const sessionsRoot = join(root, "sessions");
	const absentOwner = randomUUID();
	const reachable = randomUUID();
	const unreachable = randomUUID();
	const received = eventLog<PrimaryDelivery>();
	const reachableChannel = await createPrimaryChannel({
		id: reachable,
		cwd: root,
		sessionsRoot,
		deliver: (message) => {
			received.push(message);
		},
		promptTrust: async () => undefined,
	});
	const unreachableChannel = await createPrimaryChannel({
		id: unreachable,
		cwd: root,
		sessionsRoot,
		deliver: () => undefined,
		promptTrust: async () => undefined,
	});
	t.after(async () => {
		await reachableChannel.close().catch(() => undefined);
		await unreachableChannel.close().catch(() => undefined);
	});
	unlinkSync(unreachableChannel.socketPath);
	const sourcePath = join(root, "source.sqlite");
	const source = await openHost(sourcePath, "11111111-1111-4111-8111-111111111111", root);
	t.after(async () => {
		await source.close().catch(() => undefined);
	});
	const submissionId = await addReceipt(source, absentOwner);
	const errors = eventLog<Error>();
	const watcher = startDurableDelivery({
		host: source,
		metadata: sourceMetadata(root, source.storageId, sourcePath),
		catalog: new AgentCatalog(root),
		sessionsRoot,
		retryDelayMs: 5,
		signal: new AbortController().signal,
		onError: (error) => errors.push(error),
	});
	await Promise.all([received.waitForCount(1, 15000), errors.waitForCount(1, 15000)]);
	const expected = await receiptSourceId(source, submissionId, reachable);
	assert.equal(received[0]?.sourceId, expected);
	const details = received[0]?.details as Record<string, unknown>;
	assert.equal(details.fallback, true);
	assert.equal(details.deliveryRecipient, reachable);
	assert.match(errors[0]?.message ?? "", new RegExp(unreachable, "u"), "the unavailable candidate is named");
	await errors.waitForCount(2, 15000);
	assert.equal(received.length, 1, "retained state suppresses duplicate fallback attempts");
	assert.equal(
		new Set(received.map((message) => message.sourceId)).size,
		1,
		"retries preserve the stable receiver key",
	);
	const state = await deliveryState(source);
	assert.equal(state?.receipts[String(submissionId)]?.acknowledged, false, "the row stays pending");
	await watcher.close();
});

it("bounds the default primary discovery and refuses an incomplete scan", { timeout: 30000 }, async (t) => {
	const root = fixtureRoot(t);
	const sessionsRoot = join(root, "sessions");
	const directory = join(sessionsRoot, ".primaries");
	mkdirSync(directory, { recursive: true });
	for (let index = 0; index < 21; index += 1) writeFileSync(join(directory, `${randomUUID()}.json`), "{}");
	const sourcePath = join(root, "source.sqlite");
	const source = await openHost(sourcePath, "11111111-1111-4111-8111-111111111111", root);
	t.after(async () => {
		await source.close().catch(() => undefined);
	});
	const submissionId = await addReceipt(source, randomUUID());
	const errors = eventLog<Error>();
	const watcher = startDurableDelivery({
		host: source,
		metadata: sourceMetadata(root, source.storageId, sourcePath),
		catalog: new AgentCatalog(root),
		sessionsRoot,
		retryDelayMs: 5,
		signal: new AbortController().signal,
		onError: (error) => errors.push(error),
	});
	await errors.waitForCount(1);
	assert.match(errors[0]?.message ?? "", /discovery is incomplete/u);
	const state = await deliveryState(source);
	assert.equal(state?.receipts[String(submissionId)]?.acknowledged, false);
	await watcher.close();
});

it("bounds long peer bodies without mutating the retained originals", { timeout: 30000 }, async (t) => {
	const root = fixtureRoot(t);
	const sessionsRoot = join(root, "sessions");
	const owner = randomUUID();
	const received = eventLog<PrimaryDelivery>();
	const channel = await createPrimaryChannel({
		id: owner,
		cwd: root,
		sessionsRoot,
		deliver: (message) => {
			received.push(message);
		},
		promptTrust: async () => undefined,
	});
	t.after(async () => {
		await channel.close().catch(() => undefined);
	});
	const sourcePath = join(root, "source.sqlite");
	const source = await openHost(sourcePath, "11111111-1111-4111-8111-111111111111", root);
	t.after(async () => {
		await source.close().catch(() => undefined);
	});
	const submissionId = await addReceipt(source, owner);
	const longAnswer = "A".repeat(20_000);
	await settleDeliveries(source.harness, BACKGROUND_CONTEXT);
	await source.harness.commit(async (tx) => editDeliveryFixture(tx, async (deliveryFixtureState) => {
		const doc = deliveryFixtureState;
		const current = doc.receipts[String(submissionId)];
		if (current === undefined) throw new Error("seeded receipt is missing");
		doc.receipts[String(submissionId)] = { ...current, answer: longAnswer };
	}), BACKGROUND_CONTEXT);
	const longReport = "B".repeat(20_000);
	await source.request(
		"report",
		{ ownerId: owner, senderIdentity: `${source.storageId}:1`, requestId: "long-report", message: longReport },
		BACKGROUND_CONTEXT,
	);
	const errors = eventLog<Error>();
	const watcher = startDurableDelivery({
		host: source,
		metadata: sourceMetadata(root, source.storageId, sourcePath),
		catalog: new AgentCatalog(root),
		sessionsRoot,
		signal: new AbortController().signal,
		onError: (error) => errors.push(error),
	});
	t.after(async () => {
		await watcher.close().catch(() => undefined);
	});
	await waitForDelivery(source, async () => {
		const state = await deliveryState(source);
		return state?.receipts[String(submissionId)]?.acknowledged === true && state.reports[0]?.acknowledged === true;
	});
	const bySource = new Map(received.map((message) => [message.sourceId, message]));
	const receiptMessage = bySource.get(await receiptSourceId(source, submissionId));
	const reportMessage = bySource.get("11111111-1111-4111-8111-111111111111:report:long-report");
	assert.ok(receiptMessage, "the long answer was delivered");
	assert.ok(reportMessage, "the long report was delivered");
	for (const message of [receiptMessage, reportMessage]) {
		assert.ok(message.text.length <= 16_000 + 1000, "the peer text stays near the bound with its header");
		assert.match(message.text, /\[text truncated; use agent_inspect for retained full text\]/u);
		const details = message.details as Record<string, unknown>;
		assert.equal(details.textTruncated, true);
		assert.equal(details.originalOwnerId, owner);
	}
	const receiptDetails = receiptMessage.details as Record<string, unknown>;
	assert.equal((receiptDetails.submissions as { submissionId: number }[])[0]?.submissionId, submissionId);
	assert.ok(String(receiptDetails.answer).length <= 16_000 + 200);
	const reportDetails = reportMessage.details as Record<string, unknown>;
	assert.equal(reportDetails.reportSourceId, "report:long-report");
	assert.equal(reportDetails.wake, true, "ordinary reports keep their primary wake behavior");
	assert.equal(reportDetails.checkIn, undefined, "ordinary reports keep their detail shape");
	assert.ok(String(reportDetails.message).length <= 16_000 + 200);
	const retained = await deliveryState(source);
	assert.equal(retained?.receipts[String(submissionId)]?.answer, longAnswer, "the retained answer stays full");
	assert.equal(retained?.reports[0]?.message, longReport, "the retained report stays full");
	assert.deepEqual(errors, []);
	await watcher.close();
});

it("delivers explicit passive reports as native writes without fabricated thread metadata", { timeout: 10000 }, async (t) => {
	const root = fixtureRoot(t);
	const catalog = new AgentCatalog(root);
	const record = catalog.create({ cwd: root, agentDir: join(root, "agent"), packageDir: join(root, "package"), model: { provider: fixtureProvider, modelId: fixtureModelId }, thinkingLevel: "off" });
	const sourcePath = join(root, "thread-source.sqlite");
	const source = await openHost(sourcePath, randomUUID(), root);
	const target = await openHost(record.storagePath, record.storageId, root);
	t.after(async () => { await source.close(); await target.close(); });
	await source.harness.commit(async (tx) => editDeliveryFixture(tx, async (deliveryFixtureState) => {
		const state = deliveryFixtureState;
		state.reports.push({ sourceId: "report:thread-notice", requestId: "thread-notice", ownerId: record.storageId, senderIdentity: source.storageId, message: "A joined thread has a new event. No reply is requested.", replyTo: null, acknowledged: false, createdAt: Date.now(), direct: true, passive: true, steer: false });
	}), BACKGROUND_CONTEXT);
	const requests: string[] = [];
	const errors = eventLog<Error>();
	const watcher = startDurableDelivery({ host: source, metadata: sourceMetadata(root, source.storageId, sourcePath), catalog, signal: new AbortController().signal, acquire: async () => {
		const client = fakeTarget(target, []);
		return { ...client, request: async (method, params, options) => { requests.push(method); return client.request(method, params, options); } };
	}, onError: (error) => errors.push(error) });
	t.after(() => watcher.close());
	await waitForDelivery(source, async () => (await deliveryState(source))?.reports[0]?.acknowledged === true);
	assert.ok(requests.includes("passive-submit"));
	assert.equal(requests.includes("submit"), false);
	const observation = await target.request("inspect", { view: "history" }) as { entries?: unknown[]; rows?: unknown[] };
	assert.match(JSON.stringify(observation), /agent.passive-report/u);
	assert.equal((await target.harness.inspect(BACKGROUND_CONTEXT)).tasks.length, 0);
	assert.equal((await readRetainedDelivery(target.harness, BACKGROUND_CONTEXT, true))?.intents.length ?? 0, 0);
	assert.deepEqual(errors, []);
});

it("keeps a direct thread notice pending rather than broadcasting to another primary", { timeout: 10000 }, async (t) => {
	const root = fixtureRoot(t);
	const sourcePath = join(root, "thread-direct.sqlite");
	const source = await openHost(sourcePath, randomUUID(), root);
	t.after(() => source.close());
	await source.harness.commit(async (tx) => editDeliveryFixture(tx, async (deliveryFixtureState) => {
		const state = deliveryFixtureState;
		state.reports.push({ sourceId: "report:direct", requestId: "direct", ownerId: randomUUID(), senderIdentity: source.storageId, message: "Private thread attention", replyTo: null, acknowledged: false, createdAt: Date.now(), direct: true });
	}), BACKGROUND_CONTEXT);
	const errors = eventLog<Error>();
	let discoveries = 0;
	const watcher = startDurableDelivery({ host: source, metadata: sourceMetadata(root, source.storageId, sourcePath), catalog: new AgentCatalog(root), signal: new AbortController().signal, sessionsRoot: root, listPrimaryChannels: async () => { discoveries++; return { ids: [], visited: 0, complete: true }; }, onError: (error) => errors.push(error) });
	t.after(() => watcher.close());
	await errors.waitForCount(1);
	assert.match(errors[0].message, /parked: primary endpoint is absent/u);
	assert.equal(discoveries, 0);
	assert.equal((await deliveryState(source))?.reports[0].acknowledged, false);
});

it("bounds the native catalog follow-up body", { timeout: 30000 }, async (t) => {
	const root = fixtureRoot(t);
	const catalog = new AgentCatalog(root);
	const record = catalog.create({
		cwd: root,
		agentDir: join(root, "agent"),
		packageDir: join(root, "package"),
		model: { provider: fixtureProvider, modelId: fixtureModelId },
		thinkingLevel: "off",
		ownerId: "owner-1",
	});
	const owner = `${record.storageId}:1`;
	const sourcePath = join(root, "source.sqlite");
	const source = await openHost(sourcePath, "11111111-1111-4111-8111-111111111111", root);
	const target = await openHost(record.storagePath, record.storageId, root);
	t.after(async () => {
		await source.close().catch(() => undefined);
		await target.close().catch(() => undefined);
	});
	const submissionId = await addReceipt(source, owner);
	const longAnswer = "C".repeat(20_000);
	await settleDeliveries(source.harness, BACKGROUND_CONTEXT);
	await source.harness.commit(async (tx) => editDeliveryFixture(tx, async (deliveryFixtureState) => {
		const doc = deliveryFixtureState;
		const current = doc.receipts[String(submissionId)];
		if (current === undefined) throw new Error("seeded receipt is missing");
		doc.receipts[String(submissionId)] = { ...current, answer: longAnswer };
	}), BACKGROUND_CONTEXT);
	const calls = eventLog<SubmitRecord>();
	const errors = eventLog<Error>();
	const watcher = startDurableDelivery({
		host: source,
		metadata: sourceMetadata(root, source.storageId, sourcePath),
		catalog,
		signal: new AbortController().signal,
		acquire: async () => fakeTarget(target, calls),
		onError: (error) => errors.push(error),
	});
	t.after(async () => {
		await watcher.close().catch(() => undefined);
	});
	await waitForDelivery(source, async () => (await deliveryState(source))?.receipts[String(submissionId)]?.acknowledged === true);
	const message = String(calls[0]?.params.message ?? "");
	assert.ok(message.length <= 16_000 + 1000, "the native follow-up stays near the bound with its header");
	assert.match(message, /\[text truncated; use agent_inspect for retained full text\]/u);
	const retained = await deliveryState(source);
	assert.equal(retained?.receipts[String(submissionId)]?.answer, longAnswer, "the retained answer stays full");
	assert.deepEqual(errors, []);
	await watcher.close();
});

for (const evidence of ["handle", "name", "missing", "unresolved"] as const) it(`labels a foreign thread sender from ${evidence} evidence without host acquisition`, { timeout: 10000 }, async (t) => {
	const root = fixtureRoot(t);
	const sessionsRoot = join(root, "sessions");
	const catalog = new AgentCatalog(root);
	const record = catalog.create({ cwd: root, agentDir: join(root, "agent"), packageDir: join(root, "package"), model: { provider: "bootstrap", modelId: "not-current" }, thinkingLevel: "off" });
	const senderIdentity = `${evidence === "unresolved" ? randomUUID() : record.storageId}:7`;
	const known = evidence === "handle" || evidence === "name";
	const publishedAt = "2026-01-01T00:00:00.000Z";
	catalog.updateView(record.storageId, {
		updatedAt: publishedAt, storageId: record.storageId, coverage: { complete: true, omitted: 0 },
		rows: [{ id: known ? senderIdentity : record.storageId, storageId: record.storageId, cwd: root, modifiedAt: 1, owner: "unknown", state: "idle", cost: 0, partial: false, name: "Actual sender", model: { provider: fixtureProvider, modelId: fixtureModelId, thinkingLevel: "high" } }],
		...(evidence === "handle" ? { profiles: { rows: [{ identity: senderIdentity, handle: "@expert", role: "Research", revision: "a".repeat(64), hasExpertise: false, updatedAt: 1 }], coverage: { complete: true, omitted: 0 } } } : {}),
	});
	const owner = randomUUID();
	const received = eventLog<PrimaryDelivery>();
	const channel = await createPrimaryChannel({ id: owner, cwd: root, sessionsRoot, deliver: (message) => { received.push(message); }, promptTrust: async () => undefined });
	t.after(() => channel.close());
	const sourcePath = join(root, "thread-owner.sqlite");
	const source = await openHost(sourcePath, randomUUID(), root);
	t.after(() => source.close());
	const report = await recordReport(source.harness, { ownerId: owner, senderIdentity, message: "A peer contributed evidence", requestId: "thread-event" }, BACKGROUND_CONTEXT);
	await source.harness.commit(async (tx) => editDeliveryFixture(tx, async (deliveryFixtureState) => {
		const state = deliveryFixtureState;
		state.reports[0] = { ...report, threadId: "purpose-thread", threadTitle: "Shared review", operatorMessage: "A peer contributed evidence", direct: true, passive: true };
		(await tx.doc(ThreadDeliveryDoc, "purpose-thread", null)).pending = 1;
	}), BACKGROUND_CONTEXT);
	const status = t.mock.method(source, "request", source.request.bind(source));
	const errors = eventLog<Error>();
	const watcher = startDurableDelivery({ host: source, metadata: sourceMetadata(root, source.storageId, sourcePath), catalog, sessionsRoot, signal: new AbortController().signal, acquire: async () => { throw new Error("Source labels must not acquire a host"); }, onError: (error) => errors.push(error) });
	t.after(() => watcher.close());
	await received.waitForCount(1);
	await waitForDelivery(source, async () => (await deliveryState(source))?.reports[0]?.acknowledged === true);
	const message = received[0];
	const details = message.details as Record<string, unknown>;
	assert.equal(details.identity, senderIdentity);
	assert.equal(details.label, evidence === "handle" ? "@expert" : evidence === "name" ? "Actual sender" : senderIdentity);
	assert.equal(details.threadId, "purpose-thread");
	assert.equal(details.threadTitle, "Shared review");
	assert.equal(details.operatorMessage, "A peer contributed evidence");
	assert.equal(details.senderKind, known ? "agent" : undefined);
	assert.equal(Object.hasOwn(details, "senderKind"), known, "unresolved reports carry no inferred sender kind");
	assert.equal(details.wake, false);
	assert.match(message.text, /^Thread notice from agent/u);
	assert.doesNotMatch(message.text, /sent a report/u);
	assert.equal(details.metadataSource, known ? "retained-catalog" : undefined);
	assert.equal(details.metadataObservedAt, known ? publishedAt : undefined);
	assert.equal(details.sourceOwner, undefined, "catalog ownership visibility is not a creator identity");
	assert.equal(details.modelId, known ? fixtureModelId : undefined);
	assert.equal(details.metadataUnknown, known ? undefined : true);
	assert.equal(status.mock.calls.some((call) => call.arguments[0] === "status" && call.arguments[1]?.sessionId === senderIdentity), false);
	assert.deepEqual(errors, []);
});

for (const evidence of ["name", "purpose", "identity", "dead"] as const) it(`carries a primary thread sender's ${evidence} from its exact published endpoint`, { timeout: 10000 }, async (t) => {
	const root = fixtureRoot(t), sessionsRoot = join(root, "sessions");
	const senderIdentity = randomUUID(), owner = randomUUID();
	const named = evidence === "name" || evidence === "dead";
	const sender = await createPrimaryChannel({ id: senderIdentity, cwd: root, sessionsRoot,
		...(named ? { name: "Parser session", model: { provider: fixtureProvider, modelId: fixtureModelId }, thinkingLevel: "high" } : {}),
		...(evidence === "purpose" ? { observedPurpose: { source: "interactive-input" as const, text: "Review the parser" } } : {}),
		deliver: () => { assert.fail("source metadata reads never deliver to the sender"); }, promptTrust: async () => undefined });
	t.after(() => sender.close());
	if (evidence === "dead") {
		const exited = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
		await waitForProcessExit(exited, 5000);
		assert.ok(exited.pid);
		const path = primaryEndpointPath(sessionsRoot, senderIdentity);
		const descriptor = JSON.parse(readFileSync(path, "utf8"));
		writeFileSync(path, JSON.stringify({ ...descriptor, pid: exited.pid }));
		assert.equal(readPrimaryEndpointDescriptor(sessionsRoot, senderIdentity).state, "dead");
	}
	const received = eventLog<PrimaryDelivery>();
	const recipient = await createPrimaryChannel({ id: owner, cwd: root, sessionsRoot, deliver: (message) => { received.push(message); }, promptTrust: async () => undefined });
	t.after(() => recipient.close());
	const sourcePath = join(root, "thread.sqlite");
	const source = await openHost(sourcePath, randomUUID(), root);
	t.after(() => source.close());
	const catalog = new AgentCatalog(root);
	const thread = await mutateCollaboration(source.harness, source.storageId, { action: "create", requestId: "primary-frame", senderIdentity, origin: "operator", title: "Parser contract", purpose: "Agree on the parser boundary", authority: "Operator task", source: "Current request", restrictions: "No publication", acceptance: "Review the boundary", notify: [owner] }, BACKGROUND_CONTEXT);
	const calls = t.mock.method(source, "request", source.request.bind(source));
	const errors = eventLog<Error>();
	const watcher = startDurableDelivery({ host: source, metadata: sourceMetadata(root, source.storageId, sourcePath), catalog, sessionsRoot, signal: new AbortController().signal,
		acquire: async () => { assert.fail("source metadata reads never acquire a host"); },
		listPrimaryChannels: async () => { assert.fail("a direct thread notice never discovers primary channels"); }, onError: (error) => errors.push(error) });
	t.after(() => watcher.close());
	await received.waitForCount(1);
	await waitForDelivery(source, async () => (await deliveryState(source))?.reports[0]?.acknowledged === true);
	const details = received[0]?.details as Record<string, unknown>;
	assert.equal(details.identity, senderIdentity);
	assert.equal(details.senderIdentity, senderIdentity);
	assert.equal(details.label, named ? "Parser session" : evidence === "purpose" ? "Review the parser" : senderIdentity);
	assert.equal(details.senderKind, "session");
	assert.equal(details.metadataSource, "primary-endpoint");
	assert.equal(details.threadId, thread.threadId);
	assert.equal(details.threadTitle, "Parser contract");
	assert.match(String(details.operatorMessage), /"restrictions":"No publication"/u);
	assert.equal(details.wake, true);
	assert.equal(details.provider, named ? fixtureProvider : undefined);
	assert.equal(details.modelId, named ? fixtureModelId : undefined);
	assert.equal(details.thinkingLevel, named ? "high" : undefined);
	assert.equal(calls.mock.calls.some((call) => call.arguments[0] === "status" && call.arguments[1]?.sessionId === senderIdentity), false);
	assert.deepEqual(errors, []);
});

for (const count of [130, DELIVERY_WAKE_RECIPIENT_LIMIT + 1]) it(`aggregates parked recipients across bounded pages with ${count} rows`, { timeout: 15000 }, async t => {
	const root = fixtureRoot(t), path = join(root, "summary.sqlite"), source = await openHost(path, randomUUID(), root);
	t.after(() => source.close());
	await settleDeliveries(source.harness, BACKGROUND_CONTEXT);
	const recipients = Array.from({ length: count }, (_, index) => `${randomUUID()}:${index + 2}`);
	await source.harness.commit(async tx => {
		for (const [index, ownerId] of recipients.entries()) {
			const delivery = { state: "parked" as const, reason: "native recipient has no catalog record" };
			if (count > DELIVERY_WAKE_RECIPIENT_LIMIT && index >= count - 2) {
				await storeDeliveryRow(tx, "receipt", { submissionId: index as SubmissionId, requestId: `summary-${index}`, ownerId, conversationId: 1 as ConversationId,
					operationId: null, origin: "model", status: "done", entryId: null, answerEntryId: 1 as EntryId, answer: "shared answer", reason: null, acknowledged: false, delivery }, true);
			} else await storeDeliveryRow(tx, "report", {
				sourceId: `report:summary-${index}`, requestId: `summary-${index}`, ownerId, senderIdentity: source.storageId,
				message: "parked payload", replyTo: null, acknowledged: false, createdAt: 0, delivery,
			}, true);
		}
	}, BACKGROUND_CONTEXT);
	const snapshots = t.mock.method(source.harness, "snapshot");
	let recipientReads = 0;
	const idle = eventLog<void>();
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const watcher = startDurableDelivery({ host: source, metadata: sourceMetadata(root, source.storageId, path), catalog: new AgentCatalog(root),
		signal: new AbortController().signal, readTarget: () => { recipientReads++; return undefined; }, onIdle: () => idle.push(undefined) });
	t.after(() => watcher.close());
	assert.equal(watcher.summary().fresh, false, "a scheduled pass does not prove eligibility");
	t.mock.timers.tick(0); await idle.waitForCount(1);
	assert.equal(snapshots.mock.calls.filter(call => Object.is(call.arguments[0], DeliveryRowDoc)).length, DELIVERY_PAGE_SIZE * 2);
	assert.equal(recipientReads, DELIVERY_PAGE_SIZE * 2);
	assert.equal(watcher.busy, false);
	assert.equal(watcher.summary().complete, false);
	assert.equal(watcher.summary().fresh, false);
	const pages = Math.ceil(count / DELIVERY_PAGE_SIZE);
	for (let page = 2; page <= pages; page++) { t.mock.timers.tick(0); await idle.waitForCount(page); }
	const summary = watcher.summary();
	assert.equal(summary.complete, true);
	assert.equal(summary.fresh, true);
	assert.equal(summary.pendingCount, count);
	assert.deepEqual([...summary.parkedRecipients].sort(), recipients.slice(0, DELIVERY_WAKE_RECIPIENT_LIMIT).sort());
	assert.equal(summary.parkedOmitted, Math.max(0, count - DELIVERY_WAKE_RECIPIENT_LIMIT));
	const before = recipientReads;
	watcher.summary(); watcher.summary();
	assert.equal(recipientReads, before, "cached summary reads do not recheck recipients");
	watcher.summary(true);
	assert.equal(watcher.summary().fresh, true, "unchanged recipient facts preserve complete evidence");
	watcher.refresh();
	assert.equal(watcher.summary().fresh, false);
	assert.deepEqual(watcher.summary().parkedRecipients, summary.parkedRecipients, "invalidation preserves completed wake dependencies");
	t.mock.timers.tick(0); await idle.waitForCount(pages + 1);
	assert.deepEqual(watcher.summary().parkedRecipients, summary.parkedRecipients, "partial traversal preserves completed wake dependencies");
});

it("invalidates parked eligibility when the recipient appears during retention", { timeout: 15000 }, async t => {
	const root = fixtureRoot(t), path = join(root, "revision.sqlite"), source = await openHost(path, randomUUID(), root);
	t.after(() => source.close());
	await settleDeliveries(source.harness, BACKGROUND_CONTEXT);
	const catalog = new AgentCatalog(root), metadata = sourceMetadata(root, source.storageId, path);
	const target = catalog.create({ cwd: root, agentDir: metadata.agentDir, packageDir: metadata.packageDir, model: metadata.model, thinkingLevel: "off" });
	const ownerId = `${target.storageId}:2`;
	await source.harness.commit(tx => storeDeliveryRow(tx, "report", { sourceId: "report:revision", requestId: "revision", ownerId, senderIdentity: source.storageId,
		message: "parked", replyTo: null, acknowledged: false, createdAt: 0, delivery: { state: "parked", reason: "native recipient has no catalog record" } }, true), BACKGROUND_CONTEXT);
	let available = false;
	const commit = source.harness.commit.bind(source.harness);
	t.mock.method(source.harness, "commit", (callback: Parameters<typeof commit>[0], ...args: [Parameters<typeof commit>[1]]) => commit(async tx => {
		const doc = tx.doc.bind(tx);
		t.mock.method(tx, "doc", (...args: Parameters<typeof doc>) => {
			if (Object.is(args[0], DeliveryRowDoc)) available = true;
			return doc(...args);
		});
		return callback(tx);
	}, ...args));
	const readTarget = () => available ? target : undefined;
	const idle = eventLog<void>();
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const watcher = startDurableDelivery({ host: source, metadata, catalog, signal: new AbortController().signal, readTarget, onIdle: () => idle.push(undefined) });
	t.after(() => watcher.close());
	t.mock.timers.tick(0); await idle.waitForCount(1);
	assert.equal(available, true, "retention crosses the recipient availability change");
	assert.equal(watcher.summary(true).fresh, false, "a newer revision must not certify an older parked classification");
	const current = await observeDeliveryEligibility(source.harness, { catalog, sessionsRoot: root, readTarget });
	assert.equal(current[0]?.eligibility.state, "active");
	assert.equal(current[0]?.eligibility.reason, "native recipient is available");
});

for (const count of [2, DELIVERY_PAGE_SIZE + 1]) it(`rejects conflicting recipient observations across ${count} parked rows`, { timeout: 15000 }, async t => {
	const root = fixtureRoot(t), path = join(root, "conflict.sqlite"), source = await openHost(path, randomUUID(), root);
	t.after(() => source.close());
	await settleDeliveries(source.harness, BACKGROUND_CONTEXT);
	const catalog = new AgentCatalog(root), metadata = sourceMetadata(root, source.storageId, path);
	const target = catalog.create({ cwd: root, agentDir: metadata.agentDir, packageDir: metadata.packageDir, model: metadata.model, thinkingLevel: "off" });
	const ownerId = `${target.storageId}:2`, reason = "recipient unavailable";
	await source.harness.commit(async tx => {
		for (let index = 0; index < count; index++) await storeDeliveryRow(tx, "report", { sourceId: `report:conflict-${index}`, requestId: `conflict-${index}`, ownerId, senderIdentity: source.storageId,
			message: "parked", replyTo: null, acknowledged: false, createdAt: 0, delivery: { state: "parked", reason } }, true);
	}, BACKGROUND_CONTEXT);
	let reads = 0;
	const idle = eventLog<void>();
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const watcher = startDurableDelivery({ host: source, metadata, catalog, signal: new AbortController().signal,
		unavailableTargets: new Map([[target.storageId, { availability: nativeRecipientAvailability(target, metadata.packageDir), reason }]]),
		readTarget: () => { if (++reads === count * 2) return target; throw new Error(reason); }, onIdle: () => idle.push(undefined) });
	t.after(() => watcher.close());
	const pages = Math.ceil(count / DELIVERY_PAGE_SIZE);
	for (let page = 1; page <= pages; page++) { t.mock.timers.tick(0); await idle.waitForCount(page); }
	assert.equal(watcher.summary(true).fresh, false, "conflicting samples invalidate the pass even when final validation matches the first sample");
	for (let page = 1; page <= pages; page++) { t.mock.timers.tick(0); await idle.waitForCount(pages + page); }
	assert.equal(watcher.summary(true).fresh, true, "a consistent follow-up pass completes");
	assert.equal(watcher.summary().parkedRows[ownerId], count);
});

it("preserves wake dependencies after a delivery observation failure", { timeout: 15000 }, async t => {
	const root = fixtureRoot(t), path = join(root, "failed-summary.sqlite"), source = await openHost(path, randomUUID(), root);
	t.after(() => source.close());
	await settleDeliveries(source.harness, BACKGROUND_CONTEXT);
	const ownerId = `${randomUUID()}:2`;
	await source.harness.commit(tx => storeDeliveryRow(tx, "report", { sourceId: "report:failure", requestId: "failure", ownerId, senderIdentity: source.storageId,
		message: "parked", replyTo: null, acknowledged: false, createdAt: 0, delivery: { state: "parked", reason: "native recipient has no catalog record" } }, true), BACKGROUND_CONTEXT);
	const idle = eventLog<void>();
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const watcher = startDurableDelivery({ host: source, metadata: sourceMetadata(root, source.storageId, path), catalog: new AgentCatalog(root), signal: new AbortController().signal, onIdle: () => idle.push(undefined) });
	t.after(() => watcher.close());
	t.mock.timers.tick(0); await idle.waitForCount(1);
	assert.equal(watcher.summary().fresh, true);
	const snapshot = source.harness.snapshot.bind(source.harness);
	t.mock.method(source.harness, "snapshot", (...args: Parameters<typeof snapshot>) => {
		if (Object.is(args[0], DeliveryRowDoc)) throw new Error("row read refused");
		return snapshot(...args);
	});
	watcher.refresh();
	t.mock.timers.tick(0); await idle.waitForCount(2);
	assert.equal(watcher.summary().fresh, false);
	assert.match(watcher.summary().blocker ?? "", /row read refused/u);
	assert.deepEqual(watcher.summary().parkedRecipients, [ownerId]);
});

it("delivers a reused agent's report and final answer to its explicit recipient, not its creator", { timeout: 10000 }, async (t) => {
	const root = fixtureRoot(t), sessionsRoot = join(root, "sessions");
	const creator = randomUUID(), requester = randomUUID(), recipient = randomUUID();
	const creatorMessages = eventLog<PrimaryDelivery>(), recipientMessages = eventLog<PrimaryDelivery>();
	const creatorChannel = await createPrimaryChannel({ id: creator, cwd: root, sessionsRoot, deliver: (message) => { creatorMessages.push(message); }, promptTrust: async () => undefined });
	const recipientChannel = await createPrimaryChannel({ id: recipient, cwd: root, sessionsRoot, deliver: (message) => { recipientMessages.push(message); }, promptTrust: async () => undefined });
	t.after(async () => { await creatorChannel.close(); await recipientChannel.close(); });
	const sourcePath = join(root, "reused.sqlite");
	const source = await openHost(sourcePath, randomUUID(), root);
	t.after(() => source.close());
	const submitted = await richSubmitConversation(source.root(), { message: "Second request", requestId: "second-request", requester, replyTo: recipient, origin: "model" }, BACKGROUND_CONTEXT);
	const nativeSubmission = await source.harness.submission(submitted.submissionId, BACKGROUND_CONTEXT);
	assert.ok(nativeSubmission);
	await nativeSubmission.wait(BACKGROUND_CONTEXT);
	await recordReport(source.harness, { ownerId: recipient, senderIdentity: source.storageId, message: "Interim report", requestId: "interim" }, BACKGROUND_CONTEXT);
	const errors = eventLog<Error>();
	const watcher = startDurableDelivery({ host: source, metadata: { ...sourceMetadata(root, source.storageId, sourcePath), ownerId: creator }, catalog: new AgentCatalog(root), sessionsRoot, signal: new AbortController().signal, onError: (error) => errors.push(error) });
	t.after(() => watcher.close());
	await recipientMessages.waitForCount(2);
	await waitForDelivery(source, async () => {
		const state = await deliveryState(source);
		return state?.receipts[String(submitted.submissionId)]?.acknowledged === true && state.reports[0]?.acknowledged === true;
	});
	assert.equal(creatorMessages.length, 0);
	assert.deepEqual(recipientMessages.map((message) => (message.details as Record<string, unknown>).kind).sort(), ["receipt", "report"]);
	assert.deepEqual(errors, []);
});

function assertRefusalNotice(text: string, reason: unknown): void {
	assert.match(text, /content_refusal:/u);
	assert.match(text, /The provider refused this content\./u);
	assert.match(text, /No automatic substitution or host retry\./u);
	assert.doesNotMatch(text, /abcdefghijklmnopqrstuv/u);
	assert.equal(typeof reason, "string");
	assert.ok(Buffer.byteLength(String(reason)) <= 1024);
	assert.match(String(reason), /\[credential redacted\]/u);
	assert.match(String(reason), /\[truncated\]/u);
}
for (const route of ["primary", "catalog"] as const) it(`delivers exact bounded refusal evidence through the ${route} receipt route`, { timeout: 15000 }, async (t) => {
	const root = fixtureRoot(t), sessionsRoot = join(root, "sessions"), catalog = new AgentCatalog(root);
	const received = eventLog<PrimaryDelivery>(), calls: SubmitRecord[] = [];
	let target: DurableHost | undefined;
	let ownerId: string = randomUUID();
	if (route === "primary") {
		const channel = await createPrimaryChannel({ id: ownerId, cwd: root, sessionsRoot, deliver: (message) => { received.push(message); }, promptTrust: async () => undefined });
		t.after(() => channel.close());
	} else {
		const record = catalog.create({ cwd: root, agentDir: join(root, "agent"), packageDir: join(root, "package"), model: { provider: fixtureProvider, modelId: fixtureModelId }, thinkingLevel: "off" });
		ownerId = record.storageId;
		target = await openHost(record.storagePath, record.storageId, root);
		t.after(() => target?.close());
	}
	const raw = `This content was flagged for possible cybersecurity risk; api_key=sk-abcdefghijklmnopqrstuv; ${"界".repeat(2500)}`;
	const models = await scriptedRuntime([{ ...answerMessage(""), stopReason: "error", errorMessage: raw }]);
	const provider = t.mock.method(models, "streamSimple");
	const path = join(root, "source.sqlite"), source = await DurableHost.open({ ...hostOptions(path, models, fixtureRegistry()), storageId: randomUUID(), cwd: root, settings: { retry: { enabled: true, maxRetries: 3 } } }, BACKGROUND_CONTEXT);
	t.after(() => source.close());
	const admitted = await source.request("submit", { message: "refused work", requestId: "refused-work", ownerId, origin: "model" }, BACKGROUND_CONTEXT) as { submissionId: SubmissionId };
	const input = await source.harness.submission(admitted.submissionId, BACKGROUND_CONTEXT);
	assert.ok(input);
	const original = await input.wait(BACKGROUND_CONTEXT);
	assert.equal(original.status, "unanswered");
	const watcher = startDurableDelivery({ host: source, metadata: sourceMetadata(root, source.storageId, path), catalog, sessionsRoot, signal: new AbortController().signal, acquire: async () => {
		if (target === undefined) throw new Error("No native target belongs to this fixture");
		return fakeTarget(target, calls);
	} });
	t.after(() => watcher.close());
	await waitForDelivery(source, async () => (await deliveryState(source))?.receipts[String(admitted.submissionId)]?.acknowledged === true);
	if (route === "primary") assertRefusalNotice(received[0].text, (received[0].details as Record<string, unknown>).reason);
	else {
		const communication = parseCommunication(calls[0].params.communication);
		assert.ok(communication?.kind === "result");
		assertRefusalNotice(String(calls[0].params.message), communication.metadata.reason);
	}
	const retained = await input.status(BACKGROUND_CONTEXT);
	assert.ok(retained.type === "input" && retained.status === "unanswered");
	assert.equal(retained.reason, "model_error");
	assert.equal(retained.detail, raw);
	assert.equal((await deliveryState(source))?.receipts[String(admitted.submissionId)]?.reason, "model_error");
	assert.equal(provider.mock.callCount(), 1);
});
