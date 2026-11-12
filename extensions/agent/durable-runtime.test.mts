/**
 * Durable runtime process tests.
 *
 * Dedicated host entrypoints load the fixture provider and unsafe effect tool
 * from `testdata/durable-runtime` in isolated agent homes. The tests cover
 * crash resumption, deduplication, retained effects and results, owner delivery
 * acknowledgement, and runtime reload. Writer replacement requires a released
 * kernel lease rather than a diagnostic process-liveness claim.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { hostname } from "node:os";
import { eventLog, waitForProcessExit } from "./host-fixture.mts";
import { createPrimaryChannel, primaryEndpointPath } from "./primary-channel.ts";
import { PRIMARY_DELIVERY_CONTRACT } from "./version-contract.ts";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { it, beforeEach, afterEach } from "node:test";
import { AgentCatalog, hostMetadata } from "./catalog.ts";
import type { EntryId, SubmissionId } from "@earendil-works/pi-durable";
import { observeClaim } from "./claims.ts";
import { receiptDeliveryRequestId } from "./delivery-store.ts";
import { hostPaths } from "./host-protocol.ts";
import { acquireHost, connectHost, waitForHostRelease, type HostConnection } from "./host-client.ts";
import { AgentManager } from "./manager.ts";
import { createColdObservationCache } from "./cold-observation.ts";
let cold: ReturnType<typeof createColdObservationCache>;
beforeEach(() => { cold = createColdObservationCache(); });
afterEach(async () => { await cold.close(); });
const observeDurableStorage: ReturnType<typeof createColdObservationCache>["observe"] = (...args) => cold.observe(...args);
import { childCatalogRecord, killHost, markerFixture, runtimeFixture, trackHost, waitForReceipt } from "./durable-runtime-fixture.mts";
import { publishFixtureMarker } from "./testdata/durable-runtime/signal.ts";

it("native codemode follows the own-storage status page through real runtime dispatch", { timeout: 60000 }, async t => {
	const f = runtimeFixture(t, { withAgentExtension: true, withCodemode: true });
	const client = await acquireHost(f.metadata, { env: f.env("storage-pages") });
	trackHost(t, client.pid);
	const admitted = await client.request("submit", { message: `STORAGE_PAGE:${f.metadata.storageId}`, ownerId: f.ownerId, origin: "operator", requestId: "storage-pages" }) as { submissionId: number };
	await f.marker("answered");
	await waitForReceipt(client, f.ownerId, admitted.submissionId);
	const result = JSON.parse(readFileSync(join(f.testDir, "storage-pages.json"), "utf8")) as { isError?: boolean; content: Array<{ type: string; text?: string }> };
	assert.notEqual(result.isError, true, JSON.stringify(result));
	const text = result.content.filter(part => part.type === "text").at(-1)?.text;
	assert.ok(text);
	const pages = JSON.parse(text) as { first: { conversations: Array<{ identity: string }>; coverage: { complete: boolean; next: { tool: string; storageId: string; cursor: object; limit: number } } }; last: { conversations: Array<{ identity: string }>; coverage: { complete: boolean; next: null } } };
	assert.equal(pages.first.coverage.complete, false);
	assert.equal(pages.first.coverage.next.tool, "agent_status");
	assert.equal(pages.first.coverage.next.storageId, f.metadata.storageId);
	assert.equal(pages.first.coverage.next.limit, 1);
	assert.equal(typeof pages.first.coverage.next.cursor, "object");
	assert.equal(pages.last.coverage.complete, true);
	assert.equal(pages.last.coverage.next, null);
	assert.equal(new Set([...pages.first.conversations, ...pages.last.conversations].map(row => row.identity)).size, 2);
});

interface SubmitResult {
	readonly submissionId: string | number;
	readonly deduped: boolean;
}

interface HistoryPage {
	readonly entries: readonly unknown[];
}

interface ReceiptsPage {
	readonly receipts: readonly unknown[];
}

interface AcknowledgeResult {
	readonly acknowledged: readonly unknown[];
}

interface SearchPage {
	readonly matches: readonly unknown[];
}

/** Reject when `ready` does not settle before the public deadline signal fires. */
async function within(ready: Promise<void>, timeoutMs: number, message: string): Promise<void> {
	const deadline = AbortSignal.timeout(timeoutMs);
	await new Promise<void>((resolve, reject) => {
		const onAbort = () => reject(new Error(message));
		deadline.addEventListener("abort", onAbort, { once: true });
		ready.then(
			() => {
				deadline.removeEventListener("abort", onAbort);
				resolve();
			},
			(error) => {
				deadline.removeEventListener("abort", onAbort);
				reject(error);
			},
		);
	});
}

it("reads a cold observation without bootstrapping contributions", { timeout: 180000 }, async (t) => {
	const f = runtimeFixture(t, { withAgentExtension: true });
	const primary = await acquireHost(f.metadata, { env: f.env("answer") });
	trackHost(t, primary.pid);
	try {
		const submitted = await primary.request("submit", { message: "OBSERVE_ME", requestId: "observe-owner", ownerId: f.ownerId, origin: "operator" }) as SubmitResult;
		const receipt = await waitForReceipt(primary, f.ownerId, submitted.submissionId);
		assert.equal(receipt.status, "done");
	} finally {
		await primary.close().catch(() => {});
	}
	await waitForHostRelease(f.metadata, { signal: AbortSignal.timeout(15000) });
	const marker = join(f.testDir, "observation-create.txt");
	process.env.DURABLE_TEST_CREATE_MARKER = marker;
	try {
		const observed = await observeDurableStorage(f.metadata, "status", { sessionId: f.metadata.storageId }) as { live: boolean; storageId: string; conversation?: unknown };
		assert.equal(observed.live, false);
		assert.equal(observed.storageId, f.metadata.storageId);
		assert.ok(observed.conversation, "the cold status carries the retained conversation");
	} finally {
		delete process.env.DURABLE_TEST_CREATE_MARKER;
	}
	assert.equal(existsSync(marker), false, "the cold read ran no contribution create");
});

it("spawns a cross-cwd child in an independent storage and delivers its result to the owner conversation", { timeout: 180000 }, async (t) => {
	const f = runtimeFixture(t, { withAgentExtension: true });
	const primary = await acquireHost(f.metadata, { env: f.env("spawn") });
	trackHost(t, primary.pid);
	try {
		const submitted = await primary.request("submit", { message: "SPAWN_CHILD: start the child and report back", requestId: "spawn-owner" }) as SubmitResult;
		assert.equal(submitted.deduped, false);
		await f.marker("delivered");
		const record = await childCatalogRecord(f);
		assert.notEqual(record.storageId, f.metadata.storageId, "the child lives in an independent storage");
		assert.equal(record.cwd, realpathSync(f.childCwd), "the child uses the requested working directory");
		const child = await acquireHost(hostMetadata(record));
		trackHost(t, child.pid);
		try {
			assert.notEqual(child.pid, primary.pid, "the child runs in its own host process");
			const found = await primary.request("inspect", { view: "search", query: "Agent result from", source: "user" }) as { matches: Array<{ excerpt: string }> };
			assert.equal(found.matches.length, 1, JSON.stringify(found));
			const excerpt = found.matches[0]?.excerpt ?? "";
			assert.match(excerpt, /CHILD_RESULT/u);
			const submission = /\(submissions (\d+)\)/u.exec(excerpt)?.[1];
			assert.ok(submission, excerpt);
			const result = await child.request("inspect", { view: "result", submissionId: Number(submission) }) as { answerEntryId: EntryId };
			const deliveryRequest = receiptDeliveryRequestId(record.storageId, { answerEntryId: result.answerEntryId, submissionId: Number(submission) as SubmissionId, ownerId: f.metadata.storageId });
			const repeat = await primary.request("submit", { message: "DUPLICATE_DELIVERY", requestId: deliveryRequest, provenance: { classification: "automatic" } }) as SubmitResult;
			assert.equal(repeat.deduped, true, "the delivery request ID is retained and deduplicated");
			const after = await primary.request("inspect", { view: "search", query: "DUPLICATE_DELIVERY" }) as { matches: unknown[] };
			assert.equal(after.matches.length, 0, "the deduplicated submit wrote no new entry");
		} finally {
			await child.close().catch(() => {});
		}
	} finally {
		await primary.close().catch(() => {});
	}
});

it("receives a fixture marker from the notify socket without a marker file", async (t) => {
	const f = runtimeFixture(t);
	const pending = [f.marker("requested"), f.marker("requested")];
	await Promise.all([...pending, publishFixtureMarker(f.notifyPath, "requested")]);
	assert.equal(existsSync(join(f.testDir, "requested")), false, "the wait is the socket message, not the marker file");
	await publishFixtureMarker(f.notifyPath, "early");
	await f.marker("early");
});

it("holds a fixture publisher until the test releases its marker", async (t) => {
	const f = runtimeFixture(t);
	const markers = markerFixture(t, f.testDir);
	const release = markers.hold("host-start-gated");
	let published = false;
	const publication = publishFixtureMarker(markers.notifyPath, "host-start-gated").then(() => { published = true; });
	await markers.marker("host-start-gated");
	assert.equal(published, false, "the child remains at the gate after marker receipt");
	release();
	await publication;
	assert.equal(published, true);
});

for (const present of [false, true]) it(`reports file exists=${present} when a fixture marker never arrives`, async (t) => {
	const f = runtimeFixture(t);
	if (present) writeFileSync(join(f.testDir, "unpublished"), "not a signal");
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const rejected = assert.rejects(f.marker("unpublished"), new RegExp(`fixture marker unpublished; file exists=${present}`, "u"));
	t.mock.timers.tick(30000);
	await rejected;
});

it("resumes an outstanding model request after SIGKILL without a duplicate submission", { timeout: 120000 }, async (t) => {
	const f = runtimeFixture(t, { offlineRecovery: true, crashRetry: true });
	const initial = f.offline.generation();
	const first = await initial.acquire(f.metadata, { env: f.env("request") });
	trackHost(t, first.pid);
	const submitted = await first.request("submit", { message: "complete the request", requestId: "kill-request", ownerId: f.ownerId, origin: "operator" }) as SubmitResult;
	assert.equal(submitted.deduped, false);
	await f.marker("requested");
	killHost(first.pid);
	await first.close();

	const resumed = await f.offline.recover();
	const second = await resumed.acquire(f.metadata, { env: f.env("answer") });
	trackHost(t, second.pid);
	try {
		const receipt = await waitForReceipt(second, f.ownerId, submitted.submissionId);
		assert.equal(receipt.status, "done");
		assert.match(receipt.answer ?? "", /durable runtime answer/u);
		const repeat = await second.request("submit", { message: "complete the request", requestId: "kill-request", ownerId: f.ownerId, origin: "operator" }) as SubmitResult;
		assert.equal(repeat.submissionId, submitted.submissionId, "the same request ID reuses the retained submission");
		assert.equal(repeat.deduped, true, "the repeated submit is deduplicated");
		const history = await second.request("inspect", { view: "history", source: "user", limit: 10 }) as HistoryPage;
		assert.equal(history.entries.length, 1, "recovery leaves one user entry");
		const acknowledged = await second.request("acknowledge", { ownerId: f.ownerId, submissionIds: [submitted.submissionId] }) as AcknowledgeResult;
		assert.equal(acknowledged.acknowledged.length, 1, "the owner acknowledges the receipt once");
		const after = await second.request("receipts", { ownerId: f.ownerId }) as ReceiptsPage;
		assert.equal(after.receipts.length, 0, "an acknowledged receipt is not delivered again");
		await waitForHostRelease(f.metadata, { signal: AbortSignal.timeout(10000) });
		const hooks: Array<() => unknown> = [];
		const register = t.mock.method(t, "after", (fn: Parameters<typeof t.after>[0]) => { assert.ok(fn); hooks.push(() => fn(t, () => {})); });
		const signal = t.mock.method(process, "kill", (_pid: number, kind?: NodeJS.Signals | number) => {
			if (kind === 0) throw Object.assign(new Error("gone after intercepted signal"), { code: "ESRCH" });
			return true;
		});
		try {
			trackHost(t, second.pid);
			for (const hook of hooks) await hook();
			assert.equal(hooks.length, 0, "offline contexts never install a bare-PID fallback");
			assert.equal(signal.mock.callCount(), 0, "a new process at the old PID receives no sample or signal");
		} finally { register.mock.restore(); signal.mock.restore(); }
	} finally {
		await second.close();
	}
});

it("ends a model request cut off by SIGKILL as interrupted when no retry is left, without resending it", { timeout: 120000 }, async (t) => {
	const f = runtimeFixture(t, { offlineRecovery: true });
	const first = await f.offline.generation().acquire(f.metadata, { env: f.env("request") });
	trackHost(t, first.pid);
	const submitted = await first.request("submit", { message: "complete the request", requestId: "kill-interrupted", ownerId: f.ownerId, origin: "operator" }) as SubmitResult;
	await f.marker("requested");
	killHost(first.pid);
	await first.close();
	const second = await (await f.offline.recover()).acquire(f.metadata, { env: f.env("answer") });
	trackHost(t, second.pid);
	try {
		const receipt = await waitForReceipt(second, f.ownerId, submitted.submissionId);
		assert.equal(receipt.status, "unanswered");
		assert.equal(receipt.reason, "interrupted", "the cut-off request counts as the last failed attempt");
		const history = await second.request("inspect", { view: "history", source: "user", limit: 10 }) as HistoryPage;
		assert.equal(history.entries.length, 1, "the terminal outcome is not resubmitted");
	} finally {
		await second.close();
	}
});

for (const signal of ["SIGTERM", "SIGKILL"] as const) it(`keeps the cleared recovery marker after ${signal} during the idle interval`, { timeout: 30000 }, async (t) => {
	const f = runtimeFixture(t), catalog = new AgentCatalog(f.root);
	const client = await acquireHost(f.metadata, { env: { ...f.env("answer"), PI_AGENT_IDLE_MINUTES: "60", PI_AGENT_DIR: f.agentDir, PI_AGENT_SESSIONS_DIR: f.root } });
	trackHost(t, client.pid);
	t.after(() => client.close());
	const admitted = await client.request("submit", { message: "finish before signal", requestId: "idle-signal", ownerId: f.ownerId, origin: "operator" }) as SubmitResult;
	await waitForReceipt(client, f.ownerId, admitted.submissionId);
	const cleared = eventLog<void>();
	assert.ok(client.subscribeChanges);
	const stop = await client.subscribeChanges(() => { if (catalog.read(f.metadata.storageId).recoveryDue === false) cleared.push(undefined); }, AbortSignal.timeout(10000));
	try { await cleared.waitForCount(1, 10000); } finally { stop(); }
	assert.equal(client.closed, false, "the host is still inside its idle interval");
	process.kill(client.pid, signal);
	await waitForHostRelease(f.metadata, { signal: AbortSignal.timeout(10000) });
	assert.equal(catalog.read(f.metadata.storageId).recoveryDue, false);
});

it("keeps recovery due after a crash with an active transient delivery", { timeout: 30000 }, async (t) => {
	const f = runtimeFixture(t), catalog = new AgentCatalog(f.root);
	const channel = await createPrimaryChannel({ id: f.ownerId, cwd: f.cwd, sessionsRoot: f.root, deliver: () => { throw new Error("temporary receiver failure"); }, promptTrust: async () => undefined });
	t.after(() => channel.close());
	const client = await acquireHost(f.metadata, { env: { ...f.env("answer"), PI_AGENT_IDLE_MINUTES: "60", PI_AGENT_DIR: f.agentDir, PI_AGENT_SESSIONS_DIR: f.root } });
	trackHost(t, client.pid); t.after(() => client.close());
	const admitted = await client.request("submit", { message: "keep deliverable result", requestId: "active-crash", ownerId: f.ownerId, origin: "model" }) as SubmitResult;
	await waitForReceipt(client, f.ownerId, admitted.submissionId);
	assert.equal((await client.request("recovery-state", {} as Record<string, unknown>) as { deliveriesActive: boolean }).deliveriesActive, true);
	assert.equal(catalog.read(f.metadata.storageId).recoveryDue, true);
	killHost(client.pid);
	await waitForHostRelease(f.metadata, { signal: AbortSignal.timeout(10000) });
	assert.equal(catalog.read(f.metadata.storageId).recoveryDue, true);
});

it("retires parked delivery with a clear marker and wakes only for its returning owner", { timeout: 60000 }, async (t) => {
	const f = runtimeFixture(t);
	const owner = randomUUID();
	const other = randomUUID();
	const dead = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
	await waitForProcessExit(dead, 5000);
	assert.ok(dead.pid);
	const endpoint = primaryEndpointPath(f.root, owner);
	mkdirSync(dirname(endpoint), { recursive: true });
	writeFileSync(endpoint, JSON.stringify({ version: PRIMARY_DELIVERY_CONTRACT, id: owner, serverId: randomUUID(), startedAt: new Date().toISOString(), hostname: hostname(), pid: dead.pid, socketPath: join(f.root, "dead.sock"), cwd: f.cwd }));
	const fallback = eventLog<unknown>();
	const channel = await createPrimaryChannel({ id: other, cwd: f.cwd, sessionsRoot: f.root, deliver: (message) => { fallback.push(message); }, promptTrust: async () => undefined });
	t.after(() => channel.close());
	const first = await acquireHost(f.metadata, { env: f.env("answer") });
	trackHost(t, first.pid);
	const submitted = await first.request("submit", { message: "survive owner restart", ownerId: owner, origin: "model", requestId: "offline-owner" }) as SubmitResult;
	await waitForReceipt(first, owner, submitted.submissionId);
	await fallback.waitForCount(1);
	await first.close();
	await waitForHostRelease(f.metadata, { signal: AbortSignal.timeout(10000) });
	const catalog = new AgentCatalog(f.root);
	assert.equal(catalog.read(f.metadata.storageId).recoveryDue, false);
	await channel.close();
	const acquired: number[] = [];
	const manager = new AgentManager({ root: f.root, agentDir: f.agentDir, packageDir: f.metadata.packageDir, acquire: async (metadata) => {
		const client = await acquireHost(metadata, { env: f.env("answer") });
		acquired.push(client.pid); trackHost(t, client.pid); return client;
	} });
	t.after(() => manager.close());
	await manager.registerPrimary(other, { cwd: f.cwd, signal: new AbortController().signal, send: (_text, details) => { fallback.push(details); } });
	await waitForHostRelease(f.metadata, { signal: AbortSignal.timeout(10000) });
	assert.equal(acquired.length, 0, "another primary does not reopen a parked-only storage");
	assert.equal(fallback.length, 1, "the recorded fallback never repeats at receiver re-registration");
	assert.equal(catalog.read(f.metadata.storageId).recoveryDue, false, "the retained parked row is not runnable recovery");
	const delivered = eventLog<unknown>();
	await manager.registerPrimary(owner, { cwd: f.cwd, signal: new AbortController().signal, send: (_text, details) => { delivered.push(details); } });
	await delivered.waitForCount(1);
	await waitForHostRelease(f.metadata, { signal: AbortSignal.timeout(10000) });
	assert.equal(acquired.length, 1);
	assert.equal(delivered.length, 1);
	assert.equal((delivered[0] as { liveOwner: boolean }).liveOwner, true);
	assert.equal((delivered[0] as { wake: boolean }).wake, true);
	assert.equal(catalog.read(f.metadata.storageId).recoveryDue, false);
	await manager.registerPrimary(owner, { cwd: f.cwd, signal: new AbortController().signal, send: (_text, details) => { delivered.push(details); } });
	assert.equal(acquired.length, 1, "a delivered row has no remaining wake sidecar");
	assert.equal(delivered.length, 1);
});

it("preserves a crash recovery marker through primary startup and clears it after idle retirement", { timeout: 120000 }, async (t) => {
	const f = runtimeFixture(t, { offlineRecovery: true, crashRetry: true });
	const initial = f.offline.generation();
	const catalog = new AgentCatalog(f.root);
	const ownerId = randomUUID();
	f.offline.ordinaryRecipient(ownerId);
	const first = await initial.acquire(f.metadata, { env: f.env("request") });
	trackHost(t, first.pid);
	let submitted: SubmitResult;
	try {
		submitted = await first.request("submit", { message: "recover the marked work", requestId: "marked-crash", ownerId, origin: "operator" }) as SubmitResult;
		await f.marker("requested");
		assert.equal(catalog.read(f.metadata.storageId).recoveryDue, true);
		killHost(first.pid);
		await waitForHostRelease(f.metadata, { signal: AbortSignal.timeout(10000) });
	} finally { await first.close(); }
	assert.equal(catalog.read(f.metadata.storageId).recoveryDue, true, "SIGKILL leaves the due marker on disk");
	const resumed = await f.offline.recover();

	const acquired: string[] = [];
	let recoveredPid = 0;
	const manager = new AgentManager({
		root: f.root, agentDir: f.agentDir, packageDir: f.metadata.packageDir,
		acquire: async (metadata) => {
			acquired.push(metadata.storageId);
			const connection = await resumed.acquire(metadata, { env: f.env("answer") });
			recoveredPid = connection.pid;
			trackHost(t, connection.pid);
			return connection;
		},
		connect: (metadata, options) => resumed.connect(metadata, { ...options, env: f.env("answer") }),
	});
	resumed.manager(manager);
	const controller = resumed.controller(new AbortController());
	let receipt: Record<string, unknown> | undefined;
	let resolveDelivered: () => void = () => {};
	const delivered = new Promise<void>((resolve) => { resolveDelivered = resolve; });
	try {
		await manager.registerPrimary(ownerId, {
			cwd: f.cwd, signal: controller.signal,
			send: (_text, details) => {
				const value = details as Record<string, unknown>;
				if (value.storageId !== f.metadata.storageId || !(value.submissions as { submissionId: number }[]).some((member) => String(member.submissionId) === String(submitted.submissionId))) return;
				receipt = value;
				resolveDelivered();
			},
		});
		assert.deepEqual(acquired, [f.metadata.storageId], "primary startup recovers the marked storage");
		assert.notEqual(recoveredPid, first.pid);
		await within(delivered, 10000, "the recovered submission did not reach its primary");
		assert.equal(receipt?.status, "done");
		assert.match(String(receipt?.answer), /durable runtime answer/u);
		await waitForHostRelease(f.metadata, { signal: AbortSignal.timeout(10000) });
		assert.equal(controller.signal.aborted, false, "the primary remains registered through host retirement");
		assert.equal(catalog.read(f.metadata.storageId).recoveryDue, false, "completion, delivery acknowledgement, and clean idle retirement clear the marker");
	} finally {
		controller.abort();
		manager.close();
	}
});

for (const steerDuringRun of [false, true]) it(`replaces an owned failed writer with ${steerDuringRun ? "steering" : "one input"} without replacing its inode`, { timeout: 30000 }, async (t) => {
	const f = runtimeFixture(t, { crashRetry: true });
	const ownerId = randomUUID();
	const controller = new AbortController();
	const pids: number[] = [];
	let resolveRecovered: () => void = () => {};
	const recovered = new Promise<void>((resolve) => { resolveRecovered = resolve; });
	const managerFor = (mode: "request" | "effect") => {
		const value = new AgentManager({
			root: f.root, agentDir: f.agentDir, packageDir: f.metadata.packageDir,
			acquire: async (metadata, options) => {
				assert.equal(options?.retryAttempts, 0, "the manager owns every automatic relaunch");
				const client = await acquireHost(metadata, { ...options, env: f.env(pids.length === 0 ? mode : "answer") });
				pids.push(client.pid);
				if (pids.length === 2) resolveRecovered();
				trackHost(t, client.pid);
				return client;
			},
			connect: (metadata, options) => connectHost(metadata, { ...options, env: f.env("answer") }),
		});
		return value;
	};
	const manager = managerFor(steerDuringRun ? "effect" : "request");
	const receipts: Record<string, unknown>[] = [];
	let resolveDelivered: () => void = () => {};
	const delivered = new Promise<void>((resolve) => { resolveDelivered = resolve; });
	const send = (_text: string, details: unknown) => { receipts.push(details as Record<string, unknown>); resolveDelivered(); };
	try {
		await manager.registerPrimary(ownerId, { cwd: f.cwd, signal: controller.signal, send });
		const submitted = await manager.control("submit", { sessionId: f.metadata.storageId, message: "recover without restarting the primary", requestId: "connected-crash", origin: "model" }, { id: ownerId, cwd: f.cwd }) as SubmitResult;
		await f.marker(steerDuringRun ? "effect" : "requested");
		const expectedIds = [submitted.submissionId];
		if (steerDuringRun) {
			const steered = await manager.control("submit", { sessionId: f.metadata.storageId, message: "include the correction", requestId: "crash-steer", whenBusy: "steer", origin: "model" }, { id: ownerId, cwd: f.cwd }) as SubmitResult;
			expectedIds.push(steered.submissionId);
		}
		assert.equal(manager.catalog.read(f.metadata.storageId).recoveryDue, true);
		const before = lstatSync(hostPaths(f.metadata).claim);
		killHost(pids[0] as number);
		await within(delivered, 15000, "the original primary received no recovered result");
		await within(recovered, 10000, "the replacement connection did not become ready");
		assert.equal(controller.signal.aborted, false);
		assert.equal(pids.length, 2, "owned failure launches one replacement");
		const after = lstatSync(hostPaths(f.metadata).claim);
		assert.equal(after.dev, before.dev);
		assert.equal(after.ino, before.ino);
		assert.notEqual(pids[1], pids[0]);
		const receipt = receipts[0];
		assert.ok(receipt);
		assert.equal(receipt.status, "done");
		assert.deepEqual((receipt.submissions as { submissionId: number }[]).map((member) => String(member.submissionId)), expectedIds.map(String));
		assert.match(String(receipt?.answer), /durable runtime answer/u);
		await waitForHostRelease(f.metadata, { signal: AbortSignal.timeout(10000) });
		assert.equal(receipts.length, 1, "the host retires after one notice and acknowledgement of every input");
		assert.equal(manager.catalog.read(f.metadata.storageId).recoveryDue, false);
		const history = await manager.control("inspect", { sessionId: f.metadata.storageId, view: "history", source: "user", limit: 10 }, { id: ownerId, cwd: f.cwd }) as HistoryPage;
		assert.equal(history.entries.length, expectedIds.length, "relaunch resumes retained submissions without another input");
	} finally { controller.abort(); await manager.close(); }
});

it("does not rerun an unsafe effect after SIGKILL and delivers the retained result once", { timeout: 120000 }, async (t) => {
	const f = runtimeFixture(t, { offlineRecovery: true });
	const initial = f.offline.generation();
	const first = await initial.acquire(f.metadata, { env: f.env("effect") });
	trackHost(t, first.pid);
	const submitted = await first.request("submit", { message: "run the effect", requestId: "kill-effect", ownerId: f.ownerId, origin: "operator" }) as SubmitResult;
	assert.equal(submitted.deduped, false);
	await f.marker("effect");
	killHost(first.pid);
	await first.close();

	const resumed = await f.offline.recover();
	const second = await resumed.acquire(f.metadata, { env: f.env("answer") });
	trackHost(t, second.pid);
	try {
		const receipt = await waitForReceipt(second, f.ownerId, submitted.submissionId);
		assert.equal(receipt.status, "done");
		assert.match(receipt.answer ?? "", /durable runtime answer/u);
		const effects = () => readFileSync(join(f.testDir, "effect.txt"), "utf8").trim().split("\n").filter((line) => line !== "").length;
		assert.equal(effects(), 1, "the unsafe effect ran once before the kill");
		const repeat = await second.request("submit", { message: "run the effect", requestId: "kill-effect", ownerId: f.ownerId, origin: "operator" }) as SubmitResult;
		assert.equal(repeat.submissionId, submitted.submissionId);
		assert.equal(repeat.deduped, true, "the repeated submit is deduplicated");
		assert.equal(effects(), 1, "the resumed and deduplicated request reran no effect");
		const interrupted = await second.request("inspect", { view: "search", query: "interrupted" }) as SearchPage;
		assert.ok(interrupted.matches.length >= 1, "the interrupted tool result is retained");
	} finally {
		await second.close();
	}
});

for (const stop of ["SIGTERM", "close"] as const) for (const mode of ["request", "effect"] as const) it(`retains pending ${mode} work through ${stop} process shutdown`, { timeout: 30000 }, async (t) => {
	const f = runtimeFixture(t, { offlineRecovery: true, crashRetry: true });
	const initial = f.offline.generation();
	const catalog = new AgentCatalog(f.root);
	const first = await initial.acquire(f.metadata, { env: f.env(mode) });
	trackHost(t, first.pid);
	const submitted = await first.request("submit", { message: "retain pending native work", requestId: "process-stop", ownerId: f.ownerId, origin: "operator" }) as SubmitResult;
	await f.marker(mode === "request" ? "requested" : "effect");
	assert.equal(catalog.read(f.metadata.storageId).recoveryDue, true);
	if (stop === "SIGTERM") process.kill(first.pid, "SIGTERM");
	else await first.request("close").catch(() => undefined);
	await waitForHostRelease(f.metadata, { signal: AbortSignal.timeout(10000) });
	await first.close();
	assert.equal(catalog.read(f.metadata.storageId).recoveryDue, true, "process exit retains the recovery marker");
	const resumed = await f.offline.recover();
	const second = await resumed.acquire(f.metadata, { env: f.env("answer") });
	trackHost(t, second.pid);
	try {
		assert.notEqual(second.pid, first.pid);
		const receipt = await waitForReceipt(second, f.ownerId, submitted.submissionId);
		assert.equal(receipt.status, "done");
		assert.match(receipt.answer ?? "", /durable runtime answer/u);
		if (mode === "effect") {
			assert.equal(readFileSync(join(f.testDir, "effect.txt"), "utf8").trim().split("\n").length, 1);
			const interrupted = await second.request("inspect", { view: "search", query: "interrupted" }) as SearchPage;
			assert.ok(interrupted.matches.length >= 1, "native recovery records the interrupted unsafe effect");
		}
	} finally { await second.close(); }
});

it("marks recovery due before admission and reports the recovery state", { timeout: 120000 }, async (t) => {
	const f = runtimeFixture(t);
	const catalog = new AgentCatalog(dirname(dirname(f.storagePath)));
	const primary = await acquireHost(f.metadata, { env: f.env("request") });
	trackHost(t, primary.pid);
	try {
		assert.deepEqual(await primary.request("recovery-state", {}), { workPending: false, deliveriesPending: false, deliveriesActive: false });
		const submitted = await primary.request("submit", { message: "RECOVERY_MARK", requestId: "recovery-mark" }) as SubmitResult;
		assert.ok(submitted.submissionId);
		await f.marker("requested");
		assert.equal(catalog.read(f.metadata.storageId).recoveryDue, true, "admission marks the record before the request completes");
		const busy = await primary.request("recovery-state", {}) as { workPending: boolean; deliveriesPending: boolean };
		assert.equal(busy.workPending, true);
	} finally {
		await primary.close().catch(() => {});
	}
	process.kill(primary.pid, "SIGTERM");
	await waitForHostRelease(f.metadata, { signal: AbortSignal.timeout(10000) });
	const view = catalog.read(f.metadata.storageId).view;
	assert.ok(view, "the gated host flushed a catalog view before release");
	assert.ok(view.rows.some((row) => row.storageId === f.metadata.storageId), "the view carries this storage's row");
});

it("publishes a bounded catalog view and clears recovery due on a clean close", { timeout: 120000 }, async (t) => {
	const f = runtimeFixture(t);
	const catalog = new AgentCatalog(dirname(dirname(f.storagePath)));
	const primary = await acquireHost(f.metadata, { env: f.env("answer") });
	const pid = primary.pid;
	try {
		const submitted = await primary.request("submit", { message: "VIEW_SOURCE", requestId: "view-source", ownerId: f.ownerId, origin: "operator" }) as SubmitResult;
		const receipt = await waitForReceipt(primary, f.ownerId, submitted.submissionId);
		assert.equal(receipt.status, "done");
		assert.equal(catalog.read(f.metadata.storageId).recoveryDue, true, "the admitted request marked recovery due");
		assert.ok(primary.subscribeChanges);
		const observations = eventLog<void>();
		const stop = await primary.subscribeChanges(() => observations.push(undefined));
		try {
			await primary.request("acknowledge", { ownerId: f.ownerId, submissionIds: [submitted.submissionId] });
			for (let index = 1; ; index++) {
				const state = await primary.request("recovery-state", {}) as { deliveriesActive: boolean };
				if (!state.deliveriesActive) break;
				await observations.waitForCount(index);
			}
		} finally { stop(); }
	} finally {
		await primary.close().catch(() => {});
	}
	// Clean close still flushes the final view after delivery observation completes.
	process.kill(pid, "SIGTERM");
	await waitForHostRelease(f.metadata, { signal: AbortSignal.timeout(10000) });
	const view = catalog.read(f.metadata.storageId).view;
	assert.ok(view, "the clean close flushed the final catalog view");
	assert.ok(view.rows.some((row) => row.storageId === f.metadata.storageId), "the view carries this storage's rows");
	assert.equal(view.coverage.complete, true);
	assert.equal(catalog.read(f.metadata.storageId).recoveryDue, false, "a clean idle close clears the marker");
});

it("keeps the same native process and usable controls after successful reload", { timeout: 30000 }, async (t) => {
	const f = runtimeFixture(t);
	const first = await acquireHost(f.metadata, { env: { ...f.env("answer"), PI_AGENT_IDLE_MINUTES: "0" }, retryAttempts: 0 });
	trackHost(t, first.pid);
	let attached: HostConnection | undefined;
	try {
		for (const invocationId of ["reload-first", "reload-second"]) {
			const outcome = await first.request("command", { name: "reload", invocationId }) as { reloaded: boolean };
			assert.equal(outcome.reloaded, true);
			const status = await first.request("status") as { pid: number; storageId: string };
			assert.equal(status.pid, first.pid);
			assert.equal(status.storageId, f.metadata.storageId);
		}
		attached = await acquireHost(f.metadata, { retryAttempts: 0 });
		assert.equal(attached.pid, first.pid, "reload keeps the original writer process");
		await attached.request("configure", { name: "after successful reload" });
		const status = await first.request("status", { sessionId: f.metadata.storageId }) as { conversation: { name: string } };
		assert.equal(status.conversation.name, "after successful reload");
		const submission = await attached.request("submit", { message: "answer after reload", requestId: "reload-answer", ownerId: f.ownerId, origin: "operator" }) as SubmitResult;
		const receipt = await waitForReceipt(attached, f.ownerId, submission.submissionId);
		assert.equal(receipt.status, "done");
		await attached.request("acknowledge", { ownerId: f.ownerId, submissionIds: [submission.submissionId] });
	} finally {
		await attached?.close().catch(() => {});
		await first.close().catch(() => {});
	}
});

for (const pendingDelivery of [false, true]) it(`exits after a failed reload with pending delivery=${pendingDelivery} and serves controls after acquisition`, { timeout: 120000 }, async (t) => {
	const f = runtimeFixture(t);
	const runner = fileURLToPath(new URL("./failed-reload-fixture.mts", import.meta.url));
	const first = await acquireHost(f.metadata, { runner, env: { ...f.env("answer"), PI_AGENT_IDLE_MINUTES: "0" }, retryAttempts: 0 });
	trackHost(t, first.pid);
	const paths = hostPaths(f.metadata);
	const identityBefore = lstatSync(paths.claim);
	let submission: SubmitResult | undefined;
	try {
		if (pendingDelivery) {
			submission = await first.request("submit", { message: "retain this delivery", requestId: "reload-delivery", ownerId: f.ownerId, origin: "operator" }) as SubmitResult;
			await waitForReceipt(first, f.ownerId, submission.submissionId);
			await first.request("recovery-state");
		}
		await assert.rejects(first.request("command", { name: "reload" }), /forced reload open failure/u);
		const state = JSON.parse(readFileSync(join(f.metadata.agentDir, "reload-state.json"), "utf8"));
		assert.equal(state.idle, false, "a closed native host does not retire as idle");
		assert.match(state.nextError, /closed/u, "later controls cannot use the torn-down runtime");
		assert.equal(state.shutdownRequired, true, "the failed runtime requires process shutdown instead of retaining its live claim");
		await waitForHostRelease(f.metadata, { signal: AbortSignal.timeout(10000) });
		assert.equal(observeClaim(paths.claim, paths.identity).kind, "dead", "an exited same-host PID ends only the recorded generation");
		assert.equal(new AgentCatalog(f.root).read(f.metadata.storageId).recoveryDue, true, "failure retains recovery due, including an unacknowledged delivery");
		const identityAfter = lstatSync(paths.claim);
		assert.equal(identityAfter.dev, identityBefore.dev);
		assert.equal(identityAfter.ino, identityBefore.ino);
		assert.equal(identityAfter.uid, identityBefore.uid);
	} finally { await first.close().catch(() => {}); }
	const second = await acquireHost(f.metadata, { env: f.env("answer"), retryAttempts: 0 });
	trackHost(t, second.pid);
	try {
		assert.notEqual(second.pid, first.pid);
		const replacement = lstatSync(paths.claim);
		assert.equal(replacement.dev, identityBefore.dev);
		assert.equal(replacement.ino, identityBefore.ino);
		assert.equal((await second.request("status") as { storageId: string }).storageId, f.metadata.storageId);
		await second.request("configure", { name: "after failed reload" });
		if (submission) {
			const receipt = await waitForReceipt(second, f.ownerId, submission.submissionId);
			assert.equal(receipt.status, "done");
			await second.request("acknowledge", { ownerId: f.ownerId, submissionIds: [submission.submissionId] });
		}
	} finally { await second.close().catch(() => {}); }
});

it("keeps change notifications after reload replaces the durable host", { timeout: 120000 }, async (t) => {
	const f = runtimeFixture(t);
	const primary = await acquireHost(f.metadata, { env: f.env("answer") });
	trackHost(t, primary.pid);
	let unsubscribe: (() => void) | undefined;
	try {
		let notifications = 0;
		let reloaded = false;
		let resolveVerified: () => void = () => {};
		let rejectGuard: (error: unknown) => void = () => {};
		const verified = new Promise<void>((resolve) => {
			resolveVerified = resolve;
		});
		const failed = new Promise<void>((_resolve, reject) => {
			rejectGuard = reject;
		});
		let checking = false;
		let checkAgain = false;
		/** One guarded async check per change event: reload while idle, then verify the configured name. */
		const advance = async (): Promise<void> => {
			const status = (await primary.request("status", { sessionId: f.metadata.storageId })) as { conversation?: { name?: string } };
			if (status.conversation?.name === "after reload") {
				resolveVerified();
				return;
			}
			if (reloaded) return;
			const outcome = (await primary.request("command", { name: "reload", invocationId: "reload-changes" })) as { reloaded?: boolean };
			if (outcome.reloaded !== true) return;
			reloaded = true;
			await primary.request("configure", { sessionId: f.metadata.storageId, name: "after reload" });
		};
		const runGuard = (): void => {
			if (checking) {
				checkAgain = true;
				return;
			}
			checking = true;
			void (async () => {
				try {
					for (;;) {
						await advance();
						if (!checkAgain) return;
						checkAgain = false;
					}
				} catch (error) {
					rejectGuard(error);
				} finally {
					checking = false;
				}
			})();
		};
		const subscribeChanges = primary.subscribeChanges?.bind(primary);
		assert.ok(subscribeChanges, "the acquired connection exposes change subscriptions");
		unsubscribe = await subscribeChanges(() => {
			notifications += 1;
			runGuard();
		});
		await Promise.race([within(verified, 30000, "no change notification carried the configured name after reload"), failed]);
		assert.equal(reloaded, true, "the reload completed after the guarded idle check");
		assert.ok(notifications >= 2, "the initial snapshot and a post-reload commit notified the persistent listener");
	} finally {
		unsubscribe?.();
		await primary.close().catch(() => {});
	}
});

it("repairs an unavailable retained model through attach on an idle host", { timeout: 120000 }, async (t) => {
	const f = runtimeFixture(t);
	// The runner reads the passed metadata; the on-disk catalog record is not consulted for the open.
	const unavailable = { provider: "absent", modelId: "missing-model" };
	const metadata = { ...f.metadata, model: unavailable };
	const primary = await acquireHost(metadata, { env: f.env("answer") });
	trackHost(t, primary.pid);
	try {
		const before = (await primary.request("status", { sessionId: metadata.storageId })) as { conversation?: { agent?: { model?: { provider?: string; modelId?: string } } } };
		assert.deepEqual(before.conversation?.agent?.model, unavailable, "the retained unavailable identity is reported before repair");
		const repaired = (await primary.request("attach", { sessionId: metadata.storageId, model: { provider: "durable-runtime-fixture", modelId: "fixture-model" } })) as { conversation?: { agent?: { model?: { provider?: string; modelId?: string } } } };
		assert.deepEqual(repaired.conversation?.agent?.model, { provider: "durable-runtime-fixture", modelId: "fixture-model" }, "attach repairs the stored identity with the fixture model");
	} finally {
		await primary.close().catch(() => {});
	}
});

it("preserves a conversation's provider session and request options across turns, tool rounds, and host restart", { timeout: 120000 }, async (t) => {
	const f = runtimeFixture(t, { transport: "sse" });
	writeFileSync(join(f.testDir, "input.txt"), "Provider request fixture input\n");
	const recorded = () => readFileSync(join(f.testDir, "session-options.jsonl"), "utf8").trim().split("\n")
		.map((line) => JSON.parse(line) as { sessionId: string; transport: string; reasoning?: string });
	let providerSessionId: string | undefined;
	let requestCount = 0;
	const turn = async (host: HostConnection, requestId: string, reasoning?: string): Promise<void> => {
		const submitted = await host.request("submit", { message: requestId, requestId, ownerId: f.ownerId, origin: "operator" }) as SubmitResult;
		const receipt = await waitForReceipt(host, f.ownerId, submitted.submissionId);
		assert.equal(receipt.status, "done");
		const requests = recorded();
		assert.equal(requests.length, requestCount + 2, "each turn reaches the provider before and after its tool round");
		for (const options of requests.slice(requestCount)) {
			assert.match(options.sessionId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu, "the provider session ID is a UUID");
			assert.notEqual(options.sessionId, f.metadata.storageId, "provider identity is distinct from storage identity");
			providerSessionId ??= options.sessionId;
			assert.deepEqual(options, { sessionId: providerSessionId, transport: "sse", ...(reasoning === undefined ? {} : { reasoning }) });
		}
		requestCount = requests.length;
		await host.request("acknowledge", { ownerId: f.ownerId, submissionIds: [submitted.submissionId] });
	};
	const first = await acquireHost(f.metadata, { env: f.env("tool-round") });
	trackHost(t, first.pid);
	try {
		await turn(first, "thinking-off");
		await first.request("configure", { thinkingLevel: "high" });
		await turn(first, "thinking-high", "high");
		process.kill(first.pid, "SIGTERM");
		await waitForHostRelease(f.metadata, { signal: AbortSignal.timeout(10000) });
	} finally { await first.close(); }
	const second = await acquireHost(f.metadata, { env: f.env("tool-round") });
	trackHost(t, second.pid);
	try {
		assert.notEqual(second.pid, first.pid, "the next turn uses a new host process");
		await turn(second, "thinking-high-after-restart", "high");
		await second.request("configure", { thinkingLevel: "off" });
		await turn(second, "thinking-off-after-restart");
	} finally { await second.close(); }
});
