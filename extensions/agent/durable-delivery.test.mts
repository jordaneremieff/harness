import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { SubmissionId } from "@earendil-works/pi-durable";
import { AgentCatalog } from "./catalog.ts";
import { AgentDeliveryDoc, type AgentDeliveryState, settleDeliveries } from "./durable-controls.ts";
import { startDurableDelivery } from "./durable-delivery.ts";
import { DurableHost, type RequestParams } from "./durable-host.ts";
import { answerMessage, fixtureModelId, fixtureProvider, fixtureRegistry, fixtureRuntime, gateTool, scriptedRuntime, toolCallMessage } from "./durable-host-fixture.mts";
import type { HostConnection } from "./host-client.ts";
import { waitUntil } from "./host-fixture.mts";
import type { HostMetadata } from "./host-protocol.ts";
import { parseHostMetadata } from "./host-protocol.ts";
import { createPrimaryChannel, type PrimaryDelivery } from "./primary-channel.ts";

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
	return host.harness.snapshot(AgentDeliveryDoc, BACKGROUND_CONTEXT);
}

async function receiptSourceId(host: DurableHost, submissionId: SubmissionId): Promise<string> {
	await settleDeliveries(host.harness, BACKGROUND_CONTEXT);
	const receipt = (await deliveryState(host))?.receipts[String(submissionId)];
	assert.ok(receipt);
	return `${host.storageId}:answer:${receipt.answerEntryId}`;
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 5000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!(await predicate())) {
		if (Date.now() >= deadline) throw new Error("condition was not reached before its deadline");
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

async function addReceipt(source: DurableHost, ownerId: string, requestId = "source-receipt"): Promise<SubmissionId> {
	const admitted = (await source.request(
		"submit",
		{ sessionId: source.storageId, message: "do the task", requestId, ownerId },
		BACKGROUND_CONTEXT,
	)) as { submissionId: SubmissionId };
	await source.wait(admitted.submissionId, BACKGROUND_CONTEXT);
	return admitted.submissionId;
}

for (const recipients of ["same", "overlap", "distinct"]) it(`groups a live steer with its answer for ${recipients} recipients`, { timeout: 30000 }, async (t) => {
	const root = fixtureRoot(t);
	const sessionsRoot = join(root, "sessions");
	const owner = randomUUID();
	const steerOwner = recipients === "same" ? owner : randomUUID();
	const received: PrimaryDelivery[] = [];
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
	let started = false;
	const sourcePath = join(root, "source.sqlite");
	const source = await DurableHost.open({ storagePath: sourcePath, storageId: "source-storage", cwd: root,
		models: await scriptedRuntime([toolCallMessage("gate"), answerMessage(), answerMessage()]),
		registry: fixtureRegistry([gateTool(toolGate, () => { started = true; })]),
		agent: { model: { provider: fixtureProvider, modelId: fixtureModelId } } }, BACKGROUND_CONTEXT);
	t.after(() => source.close());
	const revisions: AgentDeliveryState[] = [];
	const unsubscribe = source.harness.subscribeCommits((publication) => {
		for (const change of publication.changes)
			if (change.type === "document" && change.record.kind === "agent.delivery" && change.value !== null)
				revisions.push(change.value as unknown as AgentDeliveryState);
	});
	t.after(unsubscribe);
	const errors: Error[] = [];
	const watcher = startDurableDelivery({ host: source, metadata: sourceMetadata(root, source.storageId, sourcePath),
		catalog: new AgentCatalog(root), sessionsRoot, signal: new AbortController().signal, onError: (error) => errors.push(error) });
	t.after(() => watcher.close());
	const original = await source.request("submit", { message: "run", requestId: "original", operationId: "first-operation", ownerId: owner }, BACKGROUND_CONTEXT) as { submissionId: SubmissionId };
	await waitUntil(() => started);
	const steer = await source.request("submit", { message: "correct", requestId: "steer", operationId: "steer-operation", ownerId: steerOwner, whenBusy: "steer" }, BACKGROUND_CONTEXT) as { submissionId: SubmissionId };
	const ids = [original.submissionId, steer.submissionId];
	await source.harness.commit(async (tx) => {
		const state = await tx.doc(AgentDeliveryDoc);
		const index = state.intents.findIndex((intent) => intent.requestId === "steer");
		const intent = state.intents[index];
		assert.ok(intent);
		state.intents[index] = { ...intent, submissionId: null };
	}, BACKGROUND_CONTEXT);
	releaseTool();
	await waitUntil(() => received.length === 1);
	const pending = await deliveryState(source);
	assert.ok(ids.every((id) => pending?.receipts[String(id)]?.acknowledged === false));
	assert.equal(pending?.receipts[String(original.submissionId)]?.answerEntryId, pending?.receipts[String(steer.submissionId)]?.answerEntryId);
	const details = received[0]?.details as { submissions: { submissionId: SubmissionId; requestId: string; operationId: string }[] };
	assert.deepEqual(details.submissions.map((member) => member.submissionId), ids);
	assert.deepEqual(details.submissions.map((member) => member.requestId), ["original", "steer"]);
	assert.deepEqual(details.submissions.map((member) => member.operationId), ["first-operation", "steer-operation"]);
	assert.match(received[0]?.text ?? "", new RegExp(`submissions ${ids.join(", ")}`, "u"));
	releaseDelivery();
	await waitFor(async () => ids.every((id) => revisions.at(-1)?.receipts[String(id)]?.acknowledged === true));
	assert.equal(received.length, recipients === "distinct" ? 2 : 1, "one answer reaches each recipient once, including overlapping owner routes");
	for (const revision of revisions) {
		const members = ids.flatMap((id) => revision.receipts[String(id)] ?? []);
		assert.ok(members.length === 0 || members.length === 2, "receipt materialization is atomic");
		assert.ok(members.every((member) => member.acknowledged) || members.every((member) => !member.acknowledged), "answer acknowledgement is atomic");
	}
	const later = await addReceipt(source, owner, "later-answer");
	await waitFor(async () => (await deliveryState(source))?.receipts[String(later)]?.acknowledged === true);
	assert.equal(received.length, recipients === "distinct" ? 3 : 2, "equal text from a distinct answer entry remains a separate notice");
	assert.notEqual(received[0]?.sourceId, received.at(-1)?.sourceId);
	assert.deepEqual(errors, []);
});

it("routes a receipt and a report only after the target admits them", { timeout: 30000 }, async (t) => {
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
	const source = await openHost(sourcePath, "source-storage", root);
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

	const calls: SubmitRecord[] = [];
	let release: (() => void) | undefined;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const errors: Error[] = [];
	const watcher = startDurableDelivery({
		host: source,
		metadata: sourceMetadata(root, source.storageId, sourcePath),
		catalog,
		signal: new AbortController().signal,
		acquire: async () => fakeTarget(target, calls, gate),
		onError: (error) => errors.push(error),
	});
	await waitUntil(() => calls.length === 1);
	const blocked = await deliveryState(source);
	assert.equal(blocked?.receipts[String(submissionId)]?.acknowledged, false, "no acknowledgement before admission");
	assert.equal(blocked?.reports[0]?.acknowledged, false, "no report acknowledgement before admission");
	release?.();
	await waitFor(async () => {
		const state = await deliveryState(source);
		return state?.receipts[String(submissionId)]?.acknowledged === true && state.reports[0]?.acknowledged === true;
	});
	assert.equal(calls.length, 2, "one submission per delivered row");
	const receiptCall = calls.find(
		(call) => typeof call.params.requestId === "string" && (call.params.requestId as string).includes(":answer:"),
	) as SubmitRecord;
	const reportCall = calls.find(
		(call) => typeof call.params.requestId === "string" && (call.params.requestId as string).includes(":report:"),
	) as SubmitRecord;
	const expectedReceipt = `deliver:${await receiptSourceId(source, submissionId)}`;
	const expectedReport = `deliver:source-storage:report:${createHash("sha256").update("report:source-report").digest("hex").slice(0, 32)}`;
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
	assert.deepEqual(errors, []);
	await new Promise((resolve) => setTimeout(resolve, 100));
	assert.equal(calls.length, 2, "acknowledgement commits do not route duplicates");
	await watcher.close();
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
	const first = await openHost(sourcePath, "source-storage", root);
	const submissionId = await addReceipt(first, owner);
	const expected = `deliver:${await receiptSourceId(first, submissionId)}`;
	await first.close();
	const target = await openHost(record.storagePath, record.storageId, root);
	t.after(async () => {
		await target.close().catch(() => undefined);
	});
	const preAdmission = (await target.request(
		"submit",
		{ sessionId: owner, message: "already admitted", requestId: expected, whenBusy: "followUp" },
		BACKGROUND_CONTEXT,
	)) as { submissionId: number };

	const reopened = await openHost(sourcePath, "source-storage", root);
	t.after(async () => {
		await reopened.close().catch(() => undefined);
	});
	const calls: SubmitRecord[] = [];
	const errors: Error[] = [];
	const watcher = startDurableDelivery({
		host: reopened,
		metadata: sourceMetadata(root, reopened.storageId, sourcePath),
		catalog,
		signal: new AbortController().signal,
		acquire: async () => fakeTarget(target, calls),
		onError: (error) => errors.push(error),
	});
	await waitFor(async () => (await deliveryState(reopened))?.receipts[String(submissionId)]?.acknowledged === true);
	assert.equal(calls.length, 1, "one routed submission after reopen");
	const routed = calls[0];
	assert.ok(routed, "the routed submission is recorded");
	assert.equal(routed.requestId, expected, "the reopened watcher reuses the derived request ID");
	assert.equal(
		(routed.result as { submissionId: number }).submissionId,
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
	const received: PrimaryDelivery[] = [];
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
	const source = await openHost(sourcePath, "source-storage", root);
	t.after(async () => {
		await source.close().catch(() => undefined);
	});
	const submissionId = await addReceipt(source, owner);
	const errors: Error[] = [];
	const watcher = startDurableDelivery({
		host: source,
		metadata: sourceMetadata(root, source.storageId, sourcePath),
		catalog: new AgentCatalog(root),
		sessionsRoot,
		signal: new AbortController().signal,
		onError: (error) => errors.push(error),
	});
	await waitUntil(() => received.length === 1);
	await waitFor(async () => (await deliveryState(source))?.receipts[String(submissionId)]?.acknowledged === true);
	const message = received[0];
	const details = message.details as Record<string, unknown>;
	assert.equal(message.sourceId, await receiptSourceId(source, submissionId));
	assert.equal(details.originalOwnerId, owner);
	assert.equal(details.storageId, "source-storage");
	assert.equal(details.saved, true);
	assert.equal(details.provider, fixtureProvider);
	assert.equal(details.modelId, fixtureModelId);
	assert.equal(details.identity, "source-storage");
	assert.equal(details.liveOwner, true);
	assert.equal(details.deliveryRecipient, owner);
	assert.equal(details.metadataUnknown, undefined);
	assert.equal(details.textTruncated, undefined, "a short body carries no truncation flag");
	assert.equal(typeof details.thinkingLevel, "string");
	assert.match(message.text, /Results do not establish task acceptance/u);
	assert.doesNotMatch(message.text, /no live owning session/u);
	const state = await deliveryState(source);
	assert.equal(state?.receipts[String(submissionId)]?.acknowledged, true);
	assert.deepEqual(errors, []);
	await watcher.close();
});

it("falls back to one registered live primary when the owning endpoint is absent", { timeout: 30000 }, async (t) => {
	const root = fixtureRoot(t);
	const sessionsRoot = join(root, "sessions");
	const absentOwner = randomUUID();
	const fallbackOwner = randomUUID();
	const received: PrimaryDelivery[] = [];
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
	const source = await openHost(sourcePath, "source-storage", root);
	t.after(async () => {
		await source.close().catch(() => undefined);
	});
	const submissionId = await addReceipt(source, absentOwner);
	const errors: Error[] = [];
	const watcher = startDurableDelivery({
		host: source,
		metadata: sourceMetadata(root, source.storageId, sourcePath),
		catalog: new AgentCatalog(root),
		sessionsRoot,
		signal: new AbortController().signal,
		onError: (error) => errors.push(error),
	});
	await waitUntil(() => received.length === 1);
	await waitFor(async () => (await deliveryState(source))?.receipts[String(submissionId)]?.acknowledged === true);
	const message = received[0];
	const details = message.details as Record<string, unknown>;
	assert.equal(details.fallback, true);
	assert.equal(details.label, "no live owning session");
	assert.equal(details.originalOwnerId, absentOwner);
	assert.equal(details.liveOwner, false);
	assert.equal(details.deliveryRecipient, fallbackOwner);
	assert.equal(details.identity, "source-storage");
	assert.match(message.text, /no live owning session/u);
	assert.ok(message.text.includes(absentOwner));
	const state = await deliveryState(source);
	assert.equal(state?.receipts[String(submissionId)]?.acknowledged, true);
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
	const source = await openHost(sourcePath, "source-storage", root);
	t.after(async () => {
		await source.close().catch(() => undefined);
	});
	const submissionId = await addReceipt(source, owner);
	const errors: Error[] = [];
	const watcher = startDurableDelivery({
		host: source,
		metadata: sourceMetadata(root, source.storageId, sourcePath),
		catalog: new AgentCatalog(root),
		sessionsRoot,
		retryDelayMs: 5,
		signal: new AbortController().signal,
		onError: (error) => errors.push(error),
	});
	await waitUntil(() => errors.length >= 1);
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
	const received: PrimaryDelivery[] = [];
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
	const source = await openHost(sourcePath, "source-storage", root);
	t.after(async () => {
		await source.close().catch(() => undefined);
	});
	const submissionId = await addReceipt(source, owner);
	const errors: Error[] = [];
	const watcher = startDurableDelivery({
		host: source,
		metadata: sourceMetadata(root, source.storageId, sourcePath),
		catalog: new AgentCatalog(root),
		sessionsRoot,
		retryDelayMs: 5,
		signal: new AbortController().signal,
		onError: (error) => errors.push(error),
	});
	await waitUntil(() => errors.length >= 1);
	assert.equal(received.length, 0, "a malformed catalog record must not route to a primary channel");
	const state = await deliveryState(source);
	assert.equal(state?.receipts[String(submissionId)]?.acknowledged, false);
	await watcher.close();
});

it("acknowledges a primary-channel row only after the channel accepts it", { timeout: 30000 }, async (t) => {
	const root = fixtureRoot(t);
	const sessionsRoot = join(root, "sessions");
	const owner = randomUUID();
	const received: PrimaryDelivery[] = [];
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
	const source = await openHost(sourcePath, "source-storage", root);
	t.after(async () => {
		await source.close().catch(() => undefined);
	});
	const submissionId = await addReceipt(source, owner);
	const errors: Error[] = [];
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
	await waitFor(async () => (await deliveryState(source))?.receipts[String(submissionId)]?.acknowledged === true);
	assert.ok(attempts >= 2, `the failed delivery was retried, received ${attempts}`);
	assert.equal(received.length, 1, "the accepted delivery is displayed once");
	await watcher.close();
});

it("backs off on failure and close cancels the retry", { timeout: 30000 }, async (t) => {
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
	const source = await openHost(sourcePath, "source-storage", root);
	t.after(async () => {
		await source.close().catch(() => undefined);
	});
	await addReceipt(source, owner);
	let acquires = 0;
	const errors: Error[] = [];
	const watcher = startDurableDelivery({
		host: source,
		metadata: sourceMetadata(root, source.storageId, sourcePath),
		catalog,
		signal: new AbortController().signal,
		retryDelayMs: 5,
		acquire: async () => {
			acquires += 1;
			throw new Error("transient");
		},
		onError: (error) => errors.push(error),
	});
	await waitUntil(() => errors.length >= 2);
	await watcher.close();
	const settled = acquires;
	await new Promise((resolve) => setTimeout(resolve, 50));
	assert.equal(acquires, settled, "close cancels the bounded retry");
	assert.ok(settled >= 2 && settled < 30, `bounded attempts, received ${settled}`);
});

it("broadcasts a fallback to every registered live primary exactly once", { timeout: 30000 }, async (t) => {
	const root = fixtureRoot(t);
	const sessionsRoot = join(root, "sessions");
	const absentOwner = randomUUID();
	const first = randomUUID();
	const second = randomUUID();
	const firstReceived: PrimaryDelivery[] = [];
	const secondReceived: PrimaryDelivery[] = [];
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
	const source = await openHost(sourcePath, "source-storage", root);
	t.after(async () => {
		await source.close().catch(() => undefined);
	});
	const submissionId = await addReceipt(source, absentOwner);
	const errors: Error[] = [];
	const watcher = startDurableDelivery({
		host: source,
		metadata: sourceMetadata(root, source.storageId, sourcePath),
		catalog: new AgentCatalog(root),
		sessionsRoot,
		signal: new AbortController().signal,
		onError: (error) => errors.push(error),
	});
	await waitFor(async () => firstReceived.length >= 1 && secondReceived.length >= 1);
	await waitFor(async () => (await deliveryState(source))?.receipts[String(submissionId)]?.acknowledged === true);
	assert.equal(firstReceived.length, 1, "the first registered primary receives exactly one");
	assert.equal(secondReceived.length, 1, "the second registered primary receives exactly one");
	for (const [id, received] of [
		[first, firstReceived],
		[second, secondReceived],
	] as const) {
		const details = received[0]?.details as Record<string, unknown>;
		assert.equal(received[0]?.sourceId, await receiptSourceId(source, submissionId));
		assert.equal(details.fallback, true);
		assert.equal(details.label, "no live owning session");
		assert.equal(details.originalOwnerId, absentOwner);
		assert.equal(details.deliveryRecipient, id);
	}
	const state = await deliveryState(source);
	assert.equal(
		state?.receipts[String(submissionId)]?.acknowledged,
		true,
		"the row is acknowledged after every live recipient accepts",
	);
	assert.deepEqual(errors, []);
	await watcher.close();
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
	const source = await openHost(sourcePath, "source-storage", root);
	t.after(async () => {
		await source.close().catch(() => undefined);
	});
	const submissionId = await addReceipt(source, absentOwner);
	const errors: Error[] = [];
	const watcher = startDurableDelivery({
		host: source,
		metadata: sourceMetadata(root, source.storageId, sourcePath),
		catalog: new AgentCatalog(root),
		sessionsRoot,
		retryDelayMs: 5,
		signal: new AbortController().signal,
		onError: (error) => errors.push(error),
	});
	await waitFor(
		async () => (await deliveryState(source))?.receipts[String(submissionId)]?.acknowledged === true,
		15000,
	);
	assert.ok(failingAttempts >= 2, `the failed candidate was retried, attempts ${failingAttempts}`);
	const expected = await receiptSourceId(source, submissionId);
	assert.ok(stableKeys.length >= 1, "the stable receiver got the row");
	assert.equal(new Set(stableKeys).size, 1, "the retry preserves one source key for receiver dedup");
	for (const key of stableKeys) assert.equal(key, expected);
	assert.deepEqual(new Set(failingKeys), new Set([expected]));
	assert.ok(errors.length >= 1, "the failed candidate was reported");
	await watcher.close();
});

it("refuses acknowledgement when candidate discovery is incomplete", { timeout: 30000 }, async (t) => {
	const root = fixtureRoot(t);
	const sourcePath = join(root, "source.sqlite");
	const source = await openHost(sourcePath, "source-storage", root);
	t.after(async () => {
		await source.close().catch(() => undefined);
	});
	const submissionId = await addReceipt(source, randomUUID());
	const errors: Error[] = [];
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
	await waitUntil(() => errors.length >= 1);
	assert.match(errors[0]?.message ?? "", /discovery is incomplete/u);
	const state = await deliveryState(source);
	assert.equal(state?.receipts[String(submissionId)]?.acknowledged, false);
	await watcher.close();
});

it("leaves a fallback row pending when no registered primary can receive it", { timeout: 30000 }, async (t) => {
	const root = fixtureRoot(t);
	const sourcePath = join(root, "source.sqlite");
	const source = await openHost(sourcePath, "source-storage", root);
	t.after(async () => {
		await source.close().catch(() => undefined);
	});
	const submissionId = await addReceipt(source, randomUUID());
	const errors: Error[] = [];
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
	await waitUntil(() => errors.length >= 1);
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
	const received: PrimaryDelivery[] = [];
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
	const source = await openHost(sourcePath, "source-storage", root);
	t.after(async () => {
		await source.close().catch(() => undefined);
	});
	const submissionId = await addReceipt(source, absentOwner);
	const errors: Error[] = [];
	const watcher = startDurableDelivery({
		host: source,
		metadata: sourceMetadata(root, source.storageId, sourcePath),
		catalog: new AgentCatalog(root),
		sessionsRoot,
		retryDelayMs: 5,
		signal: new AbortController().signal,
		onError: (error) => errors.push(error),
	});
	await waitUntil(() => received.length >= 1 && errors.length >= 1, 15000);
	const expected = await receiptSourceId(source, submissionId);
	assert.equal(received[0]?.sourceId, expected);
	const details = received[0]?.details as Record<string, unknown>;
	assert.equal(details.fallback, true);
	assert.equal(details.deliveryRecipient, reachable);
	assert.match(errors[0]?.message ?? "", new RegExp(unreachable, "u"), "the unavailable candidate is named");
	await waitUntil(() => received.length >= 2, 15000);
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
	const source = await openHost(sourcePath, "source-storage", root);
	t.after(async () => {
		await source.close().catch(() => undefined);
	});
	const submissionId = await addReceipt(source, randomUUID());
	const errors: Error[] = [];
	const watcher = startDurableDelivery({
		host: source,
		metadata: sourceMetadata(root, source.storageId, sourcePath),
		catalog: new AgentCatalog(root),
		sessionsRoot,
		retryDelayMs: 5,
		signal: new AbortController().signal,
		onError: (error) => errors.push(error),
	});
	await waitUntil(() => errors.length >= 1);
	assert.match(errors[0]?.message ?? "", /discovery is incomplete/u);
	const state = await deliveryState(source);
	assert.equal(state?.receipts[String(submissionId)]?.acknowledged, false);
	await watcher.close();
});

it("bounds long peer bodies without mutating the retained originals", { timeout: 30000 }, async (t) => {
	const root = fixtureRoot(t);
	const sessionsRoot = join(root, "sessions");
	const owner = randomUUID();
	const received: PrimaryDelivery[] = [];
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
	const source = await openHost(sourcePath, "source-storage", root);
	t.after(async () => {
		await source.close().catch(() => undefined);
	});
	const submissionId = await addReceipt(source, owner);
	const longAnswer = "A".repeat(20_000);
	await settleDeliveries(source.harness, BACKGROUND_CONTEXT);
	await source.harness.commit(async (tx) => {
		const doc = await tx.doc(AgentDeliveryDoc);
		const current = doc.receipts[String(submissionId)];
		if (current === undefined) throw new Error("seeded receipt is missing");
		current.answer = longAnswer;
	}, BACKGROUND_CONTEXT);
	const longReport = "B".repeat(20_000);
	await source.request(
		"report",
		{ ownerId: owner, senderIdentity: `${source.storageId}:1`, requestId: "long-report", message: longReport },
		BACKGROUND_CONTEXT,
	);
	const errors: Error[] = [];
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
	await waitFor(async () => {
		const state = await deliveryState(source);
		return state?.receipts[String(submissionId)]?.acknowledged === true && state.reports[0]?.acknowledged === true;
	});
	const bySource = new Map(received.map((message) => [message.sourceId, message]));
	const receiptMessage = bySource.get(await receiptSourceId(source, submissionId));
	const reportMessage = bySource.get("source-storage:report:long-report");
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
	assert.ok(String(reportDetails.message).length <= 16_000 + 200);
	const retained = await deliveryState(source);
	assert.equal(retained?.receipts[String(submissionId)]?.answer, longAnswer, "the retained answer stays full");
	assert.equal(retained?.reports[0]?.message, longReport, "the retained report stays full");
	assert.deepEqual(errors, []);
	await watcher.close();
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
	const source = await openHost(sourcePath, "source-storage", root);
	const target = await openHost(record.storagePath, record.storageId, root);
	t.after(async () => {
		await source.close().catch(() => undefined);
		await target.close().catch(() => undefined);
	});
	const submissionId = await addReceipt(source, owner);
	const longAnswer = "C".repeat(20_000);
	await settleDeliveries(source.harness, BACKGROUND_CONTEXT);
	await source.harness.commit(async (tx) => {
		const doc = await tx.doc(AgentDeliveryDoc);
		const current = doc.receipts[String(submissionId)];
		if (current === undefined) throw new Error("seeded receipt is missing");
		current.answer = longAnswer;
	}, BACKGROUND_CONTEXT);
	const calls: SubmitRecord[] = [];
	const errors: Error[] = [];
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
	await waitFor(async () => (await deliveryState(source))?.receipts[String(submissionId)]?.acknowledged === true);
	const message = String(calls[0]?.params.message ?? "");
	assert.ok(message.length <= 16_000 + 1000, "the native follow-up stays near the bound with its header");
	assert.match(message, /\[text truncated; use agent_inspect for retained full text\]/u);
	const retained = await deliveryState(source);
	assert.equal(retained?.receipts[String(submissionId)]?.answer, longAnswer, "the retained answer stays full");
	assert.deepEqual(errors, []);
	await watcher.close();
});
