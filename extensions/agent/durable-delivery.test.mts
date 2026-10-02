import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { SubmissionId } from "@earendil-works/pi-durable";
import { AgentCatalog } from "./catalog.ts";
import { AgentDeliveryDoc } from "./durable-controls.ts";
import { startDurableDelivery } from "./durable-delivery.ts";
import { DurableHost, type RequestParams } from "./durable-host.ts";
import { fixtureModelId, fixtureProvider, fixtureRegistry, fixtureRuntime } from "./durable-host-fixture.mts";
import { waitUntil } from "./host-fixture.mts";
import type { HostConnection } from "./host-client.ts";
import type { HostMetadata } from "./host-protocol.ts";
import { parseHostMetadata } from "./host-protocol.ts";

function fixtureRoot(t: { after(fn: () => void | Promise<void>): void }): string {
	const root = mkdtempSync(join(tmpdir(), "durable-delivery-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	return root;
}

async function openHost(storagePath: string, storageId: string, cwd: string): Promise<DurableHost> {
	return DurableHost.open({
		storagePath,
		storageId,
		cwd,
		models: await fixtureRuntime("answer"),
		registry: fixtureRegistry(),
		agent: { model: { provider: fixtureProvider, modelId: fixtureModelId } },
	}, BACKGROUND_CONTEXT);
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
			const index = method === "submit" ? calls.push({ params: record, ...(options?.requestId === undefined ? {} : { requestId: options.requestId }), result: undefined }) - 1 : -1;
			if (gate) await gate;
			const result = await target.request(method, params as RequestParams, BACKGROUND_CONTEXT);
			if (index >= 0) calls[index] = { params: record, ...(options?.requestId === undefined ? {} : { requestId: options.requestId }), result };
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

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 5000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!(await predicate())) {
		if (Date.now() >= deadline) throw new Error("condition was not reached before its deadline");
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

async function addReceipt(source: DurableHost, ownerId: string, requestId = "source-receipt"): Promise<SubmissionId> {
	const admitted = await source.request("submit", { sessionId: source.storageId, message: "do the task", requestId, ownerId }, BACKGROUND_CONTEXT) as { submissionId: SubmissionId };
	await source.wait(admitted.submissionId, BACKGROUND_CONTEXT);
	return admitted.submissionId;
}

it("routes a receipt and a report only after the target admits them", { timeout: 30000 }, async (t) => {
	const root = fixtureRoot(t);
	const catalog = new AgentCatalog(root);
	const record = catalog.create({ cwd: root, agentDir: join(root, "agent"), packageDir: join(root, "package"), model: { provider: fixtureProvider, modelId: fixtureModelId }, thinkingLevel: "off", ownerId: "owner-1" });
	const owner = `${record.storageId}:1`;
	const sourcePath = join(root, "source.sqlite");
	const source = await openHost(sourcePath, "source-storage", root);
	const target = await openHost(record.storagePath, record.storageId, root);
	t.after(async () => {
		await source.close().catch(() => undefined);
		await target.close().catch(() => undefined);
	});
	const submissionId = await addReceipt(source, owner);
	await source.request("report", { ownerId: owner, senderIdentity: `${source.storageId}:1`, requestId: "source-report", message: "report text" }, BACKGROUND_CONTEXT);

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
	const receiptCall = calls.find((call) => typeof call.params.requestId === "string" && (call.params.requestId as string).includes(":submission:")) as SubmitRecord;
	const reportCall = calls.find((call) => typeof call.params.requestId === "string" && (call.params.requestId as string).includes(":report:")) as SubmitRecord;
	const expectedReceipt = `deliver:source-storage:submission:${submissionId}`;
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
	assert.match(String(receiptCall.params.message), new RegExp(`submission ${submissionId}`, "u"));
	assert.match(String(reportCall.params.message), /source report:source-report/u);
	assert.deepEqual(errors, []);
	await new Promise((resolve) => setTimeout(resolve, 100));
	assert.equal(calls.length, 2, "acknowledgement commits do not route duplicates");
	await watcher.close();
});

it("resumes after reopen and native dedup keeps one submission", { timeout: 30000 }, async (t) => {
	const root = fixtureRoot(t);
	const catalog = new AgentCatalog(root);
	const record = catalog.create({ cwd: root, agentDir: join(root, "agent"), packageDir: join(root, "package"), model: { provider: fixtureProvider, modelId: fixtureModelId }, thinkingLevel: "off", ownerId: "owner-1" });
	const owner = `${record.storageId}:1`;
	const sourcePath = join(root, "source.sqlite");
	const first = await openHost(sourcePath, "source-storage", root);
	const submissionId = await addReceipt(first, owner);
	await first.close();
	const target = await openHost(record.storagePath, record.storageId, root);
	t.after(async () => {
		await target.close().catch(() => undefined);
	});
	const expected = `deliver:source-storage:submission:${submissionId}`;
	const preAdmission = await target.request("submit", { sessionId: owner, message: "already admitted", requestId: expected, whenBusy: "followUp" }, BACKGROUND_CONTEXT) as { submissionId: number };

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
	assert.equal((routed.result as { submissionId: number }).submissionId, preAdmission.submissionId, "the target deduplicates the resent request");
	assert.deepEqual(errors, []);
	await watcher.close();
});

it("leaves an ordinary owner without a catalog record for primary delivery", { timeout: 30000 }, async (t) => {
	const root = fixtureRoot(t);
	const catalog = new AgentCatalog(root);
	const ordinary = "00000000-0000-4000-8000-000000000000";
	const sourcePath = join(root, "source.sqlite");
	const source = await openHost(sourcePath, "source-storage", root);
	t.after(async () => {
		await source.close().catch(() => undefined);
	});
	const submissionId = await addReceipt(source, ordinary);
	let acquires = 0;
	const errors: Error[] = [];
	const watcher = startDurableDelivery({
		host: source,
		metadata: sourceMetadata(root, source.storageId, sourcePath),
		catalog,
		signal: new AbortController().signal,
		acquire: async () => {
			acquires += 1;
			throw new Error("an ordinary owner must not route");
		},
		onError: (error) => errors.push(error),
	});
	await new Promise((resolve) => setTimeout(resolve, 100));
	assert.equal(acquires, 0);
	assert.deepEqual(errors, []);
	const state = await deliveryState(source);
	assert.equal(state?.receipts[String(submissionId)]?.acknowledged, false, "the row stays for the primary manager");
	await watcher.close();
});

it("backs off on failure and close cancels the retry", { timeout: 30000 }, async (t) => {
	const root = fixtureRoot(t);
	const catalog = new AgentCatalog(root);
	const record = catalog.create({ cwd: root, agentDir: join(root, "agent"), packageDir: join(root, "package"), model: { provider: fixtureProvider, modelId: fixtureModelId }, thinkingLevel: "off", ownerId: "owner-1" });
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
