import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { it, type TestContext } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ConversationId, EntryId, SubmissionId } from "@earendil-works/pi-durable";
import { AgentCatalog } from "./catalog.ts";
import { AgentDeliveryDoc, AgentMetaDoc } from "./durable-controls.ts";
import type { TimerTask } from "./durable-timers.ts";
import type { ConversationFrame, TasksFrame } from "./live-frames.ts";
import { DurableHost } from "./durable-host.ts";
import { createDurableRuntime } from "./durable-runtime.ts";
import { runtimeFixture } from "./durable-runtime-fixture.mts";
import { resolveAgentControlDispatch } from "./durable-agents.ts";
import { eventLog, waitForProcessExit } from "./host-fixture.mts";
import { createPrimaryChannel, primaryEndpointPath } from "./primary-channel.ts";
import { PRIMARY_DELIVERY_CONTRACT } from "./version-contract.ts";
import { connectHost } from "./host-client.ts";
import { hostPaths, parseHostReadyLine } from "./host-protocol.ts";
import { runHost } from "./host-process.ts";
import { AgentManager } from "./manager.ts";

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => { resolve = done; });
	return { promise, resolve };
}

async function fixture(t: TestContext) {
	let runtime: Awaited<ReturnType<typeof createDurableRuntime>> | undefined;
	t.after(() => runtime?.close().catch(() => {}));
	const f = runtimeFixture(t, { withAgentExtension: true });
	const env = f.env("answer");
	for (const [key, value] of Object.entries(env)) {
		const old = process.env[key];
		process.env[key] = value;
		t.after(() => { if (old === undefined) delete process.env[key]; else process.env[key] = old; });
	}
	const open = DurableHost.open.bind(DurableHost);
	let native!: DurableHost;
	let registry!: Parameters<typeof open>[0]["registry"];
	t.mock.method(DurableHost, "open", async (...args: Parameters<typeof open>) => { registry = args[0].registry; native = await open(...args); return native; });
	const ownerId = randomUUID();
	const metadata = { ...f.metadata, ownerId };
	const catalog = new AgentCatalog(f.root);
	const record = catalog.read(metadata.storageId);
	writeFileSync(catalog.path(metadata.storageId), JSON.stringify({ ...record, ownerId }), { mode: 0o600 });
	runtime = await createDurableRuntime(metadata);
	assert.equal(typeof runtime.tryRetire, "function");
	return { ...f, metadata, ownerId, runtime, native, registry, catalog };
}

async function eligible(runtime: Awaited<ReturnType<typeof createDurableRuntime>>): Promise<boolean> {
	let eligible = false;
	assert.ok(runtime.tryRetire);
	assert.equal(await runtime.tryRetire(() => { eligible = true; return false; }), false);
	return eligible;
}

function markerChanges(t: TestContext, f: Awaited<ReturnType<typeof fixture>>) {
	const changed = eventLog<boolean>();
	const mark = AgentCatalog.prototype.markRecoveryDue;
	t.mock.method(AgentCatalog.prototype, "markRecoveryDue", function (this: AgentCatalog, identity: string, due: boolean) {
		const prior = this.read(identity).recoveryDue;
		const result = mark.call(this, identity, due);
		if (identity === f.metadata.storageId && prior !== due) changed.push(due);
		return result;
	});
	return changed;
}

it("clears recovery due after completion before the idle retirement interval", { timeout: 15000 }, async (t) => {
	const f = await fixture(t), changes = markerChanges(t, f);
	const admitted = await f.runtime.request("submit", { message: "finish before retirement", requestId: "finish-marker", ownerId: f.ownerId, origin: "operator" }, "finish-marker") as { submissionId: SubmissionId };
	await f.native.wait(admitted.submissionId, BACKGROUND_CONTEXT);
	await changes.waitForCount(2);
	assert.deepEqual([...changes], [true, false]);
	assert.equal(f.catalog.read(f.metadata.storageId).recoveryDue, false);
	assert.equal(f.native.sessionEnded, false, "the marker clears while the native storage remains open");
});

it("sets recovery due before the native input exists and preserves the admission gap", { timeout: 15000 }, async (t) => {
	const f = await fixture(t), entered = deferred(), release = deferred();
	const request = f.native.request.bind(f.native);
	t.mock.method(f.native, "request", async (...args: Parameters<typeof request>) => {
		if (args[0] === "submit") { entered.resolve(); await release.promise; }
		return request(...args);
	});
	const admitting = f.runtime.request("submit", { message: "admission gap", requestId: "gap-marker", ownerId: f.ownerId, origin: "operator" }, "gap-marker") as Promise<{ submissionId: SubmissionId }>;
	await entered.promise;
	try {
		assert.equal((await f.native.harness.inspect(BACKGROUND_CONTEXT)).submissions.length, 0);
		assert.equal(f.catalog.read(f.metadata.storageId).recoveryDue, true);
		await f.runtime.request("status", {}, "gap-read");
		await new Promise<void>(setImmediate);
		assert.equal(f.catalog.read(f.metadata.storageId).recoveryDue, true, "marker reconciliation cannot clear an admission that still owns the gap");
	} finally { release.resolve(); }
	const admitted = await admitting; await f.native.wait(admitted.submissionId, BACKGROUND_CONTEXT);
});

for (const recipient of ["absent", "malformed"] as const) it(`keeps recovery due false with only ${recipient} delivery`, { timeout: 15000 }, async (t) => {
	const f = await fixture(t), errors = eventLog<Error>();
	const report = f.native.reportDeliveryError.bind(f.native);
	t.mock.method(f.native, "reportDeliveryError", (error?: Error) => { report(error); if (error) errors.push(error); });
	await f.native.harness.commit(async tx => {
		(await tx.doc(AgentDeliveryDoc)).reports.push({ sourceId: "report:cold", requestId: "cold", ownerId: recipient === "absent" ? f.ownerId : "12345678", senderIdentity: f.metadata.storageId, message: "retained", replyTo: null, acknowledged: false, createdAt: Date.now() });
	}, BACKGROUND_CONTEXT);
	await errors.waitForCount(1);
	await new Promise<void>(setImmediate);
	assert.equal(f.catalog.read(f.metadata.storageId).recoveryDue, false);
	assert.equal((await f.native.harness.snapshot(AgentDeliveryDoc, BACKGROUND_CONTEXT))?.reports[0]?.delivery?.state, recipient === "absent" ? "parked" : "terminal");
});

it("keeps an active transient delivery due and blocks both retirement and release", { timeout: 15000 }, async (t) => {
	const f = await fixture(t), errors = eventLog<Error>();
	const channel = await createPrimaryChannel({ id: f.ownerId, cwd: f.cwd, sessionsRoot: f.root, deliver: () => { throw new Error("transient receiver failure"); }, promptTrust: async () => undefined });
	t.after(() => channel.close());
	const report = f.native.reportDeliveryError.bind(f.native);
	t.mock.method(f.native, "reportDeliveryError", (error?: Error) => { report(error); if (error) errors.push(error); });
	await f.runtime.request("report", { ownerId: f.ownerId, senderIdentity: f.metadata.storageId, message: "active delivery", requestId: "active-marker" }, "active-marker");
	await errors.waitForCount(1);
	const state = await f.runtime.request("recovery-state", {}, "active-state") as { deliveriesActive: boolean };
	assert.equal(state.deliveriesActive, true);
	assert.equal(f.catalog.read(f.metadata.storageId).recoveryDue, true);
	assert.equal(await eligible(f.runtime), false);
	assert.ok(f.runtime.requestRelease);
	const release = await f.runtime.requestRelease();
	assert.equal(release.retiring, false);
	assert.ok(release.blockers.some(text => text.includes(`Active delivery to ${f.ownerId}`)));
});

for (const checkIn of [false, true]) it(`reports native work in another conversation as a release blocker, check-in=${checkIn}`, { timeout: 15000 }, async (t) => {
	const f = await fixture(t);
	const seed = await f.native.submit({ message: "seed the parent", requestId: "release-parent" });
	await f.native.wait(seed.submissionId, BACKGROUND_CONTEXT);
	const fork = await f.native.request("fork", { requestId: "release-child" }) as { conversationId: ConversationId };
	process.env.DURABLE_TEST_MODE = "request";
	const admitted = await f.native.submit({ conversationId: fork.conversationId, message: "hold release", requestId: "release-held", ownerId: f.ownerId, origin: "model", ...(checkIn ? { checkInMinutes: 60 } : {}) });
	await f.marker("requested");
	assert.ok(f.runtime.requestRelease);
	try {
		const result = await f.runtime.requestRelease();
		assert.equal(result.retiring, false);
		assert.ok(result.blockers.some(text => text.includes(`Native work in conversation ${f.metadata.storageId}:${fork.conversationId}`)));
		if (checkIn) assert.ok(result.blockers.some(text => text.includes("waiting check-in task")));
	} finally {
		await f.native.request("abort", { sessionId: `${f.metadata.storageId}:${fork.conversationId}`, background: true });
		await f.native.wait(admitted.submissionId, BACKGROUND_CONTEXT);
		await f.native.harness.waitForIdle(BACKGROUND_CONTEXT);
	}
});

it("reports a waiting timer as a release blocker without cancelling it", { timeout: 15000 }, async (t) => {
	const f = await fixture(t);
	const timer = await f.runtime.request("timer-schedule", { message: "later", deliverAt: Date.now() + 3600000, origin: "operator", ownerId: f.ownerId }, "release-timer") as { timerId: number };
	assert.ok(f.runtime.requestRelease);
	try {
		const result = await f.runtime.requestRelease();
		assert.equal(result.retiring, false);
		assert.ok(result.blockers.some(text => text.includes("waiting timer")));
		const rows = await f.runtime.request("timer-list", {}, "release-timers") as { timers: Array<{ timerId: number; status: string }> };
		assert.equal(rows.timers.find(row => row.timerId === timer.timerId)?.status, "pending");
	} finally { await f.runtime.request("timer-cancel", { timerId: timer.timerId }, "cancel-release-timer"); }
});

it("reports another active request as a release blocker", { timeout: 15000 }, async (t) => {
	const f = await fixture(t), entered = deferred(), release = deferred();
	const request = f.native.request.bind(f.native);
	t.mock.method(f.native, "request", async (...args: Parameters<typeof request>) => {
		if (args[0] === "status") { entered.resolve(); await release.promise; }
		if (args[0] === "release") {
			assert.ok(f.runtime.requestRelease);
			return f.runtime.requestRelease();
		}
		return request(...args);
	});
	const pending = f.runtime.request("status", {}, "held-control");
	await entered.promise;
	assert.ok(f.runtime.requestRelease);
	try {
		const result = await f.runtime.requestRelease();
		assert.equal(result.retiring, false);
		assert.ok(result.blockers.some(text => text.includes("Another active request")));
	} finally { release.resolve(); await pending; }
	assert.deepEqual(await f.runtime.request("release", {}, "own-release"), { retiring: true, blockers: [] });
});

it("releases an idle storage after its response and closes open observations", { timeout: 15000 }, async (t) => {
	const f = await fixture(t), request = f.runtime.request.bind(f.runtime);
	assert.ok(f.runtime.requestRelease);
	const release = f.runtime.requestRelease.bind(f.runtime);
	const host = await runHost(() => ({ ...f.runtime, request: async (method, params, requestId, signal) => method === "status" && (params as { releaseFixture?: boolean })?.releaseFixture ? release() : request(method, params, requestId, signal) }), { metadata: f.metadata, idleMs: 3600000, announceReady: () => {} });
	t.after(() => host.close());
	const client = await connectHost(f.metadata, { retryAttempts: 0 });
	t.after(() => client.close());
	assert.ok(client.observe);
	await client.observe({ scope: "conversation", sessionId: f.metadata.storageId });
	assert.equal(f.native.observationCount, 1);
	assert.deepEqual(await client.request("status", { releaseFixture: true }), { retiring: true, blockers: [] });
	await host.done;
	assert.equal(f.native.observationCount, 0);
	assert.deepEqual(await release(), { retiring: false, blockers: ["The runtime is closed or reload is in progress"] });
	assert.equal(existsSync(hostPaths(f.metadata).claim), false);
	assert.equal(f.catalog.read(f.metadata.storageId).recoveryDue, false);
});

it("cancels release when a second client admits work during the response grace", { timeout: 15000 }, async t => {
	const f = await fixture(t), entered = deferred(), admit = deferred();
	assert.ok(f.runtime.requestRelease);
	const release = f.runtime.requestRelease.bind(f.runtime);
	const request = f.runtime.request.bind(f.runtime), nativeRequest = f.native.request.bind(f.native);
	const held = t.mock.method(f.native, "request", async (...args: Parameters<typeof nativeRequest>) => {
		if (args[0] === "submit") { entered.resolve(); await admit.promise; }
		return nativeRequest(...args);
	});
	const host = await runHost(() => ({ ...f.runtime, request: (method, params, requestId, signal) => method === "status" && (params as { releaseFixture?: boolean })?.releaseFixture ? release() : request(method, params, requestId, signal) }), { metadata: f.metadata, idleMs: 500, announceReady: () => {} });
	t.after(() => host.close());
	const first = await connectHost(f.metadata, { retryAttempts: 0 }), second = await connectHost(f.metadata, { retryAttempts: 0 });
	t.after(() => first.close()); t.after(() => second.close());
	assert.deepEqual(await first.request("status", { releaseFixture: true }), { retiring: true, blockers: [] });
	const admitted = second.request("submit", { message: "finish after release cancellation", requestId: "release-new-work", ownerId: f.metadata.storageId, origin: "operator" });
	try {
		await entered.promise;
		assert.ok(second.observe);
		const observation = await second.observe({ scope: "conversation", sessionId: f.metadata.storageId });
		assert.equal(f.runtime.releaseRequested, false);
		assert.equal(f.native.observationCount, 1);
		admit.resolve();
		const submission = await admitted as { submissionId: SubmissionId };
		await f.native.wait(submission.submissionId, BACKGROUND_CONTEXT);
		assert.equal(f.native.observationCount, 1, "cancelled release preserves the new client's observation");
		await observation.close();
		await host.done;
		assert.equal(existsSync(hostPaths(f.metadata).claim), false);
	} finally { admit.resolve(); await admitted.catch(() => undefined); held.mock.restore(); }
});

it("cancels release when a generation change refuses the retirement seal", { timeout: 15000 }, async t => {
	const f = await fixture(t);
	assert.ok(f.runtime.requestRelease);
	assert.ok(f.runtime.tryRetire);
	assert.equal((await f.runtime.requestRelease()).retiring, true);
	const refresh = f.native.refreshIdle.bind(f.native);
	let changed = false;
	const gate = t.mock.method(f.native, "refreshIdle", async () => {
		const idle = await refresh();
		if (!changed) { changed = true; await f.runtime.request("status", {}, "change-release-generation"); }
		return idle;
	});
	try {
		assert.equal(await f.runtime.tryRetire(() => { assert.fail("changed generation must not seal"); }), false);
		assert.equal(f.runtime.releaseRequested, false);
	} finally { gate.mock.restore(); }
});

it("exits its dedicated process after an idle release response with recovery due false", { timeout: 20000 }, async (t) => {
	const f = runtimeFixture(t, { withAgentExtension: true });
	const child = spawn(process.execPath, [fileURLToPath(new URL("./runtime-release-fixture.mts", import.meta.url)), JSON.stringify(f.metadata)], { env: { ...process.env, ...f.env("answer"), PI_AGENT_DIR: f.agentDir, PI_AGENT_SESSIONS_DIR: f.root }, stdio: ["ignore", "pipe", "pipe"] });
	t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); await waitForProcessExit(child); });
	const ready = eventLog<void>();
	let output = "";
	child.stdout?.on("data", chunk => { output = `${output}${String(chunk)}`.slice(-32768); if (output.split("\n").some(line => parseHostReadyLine(line) !== undefined)) ready.push(undefined); });
	await ready.waitForCount(1, 10000);
	const client = await connectHost(f.metadata, { retryAttempts: 0 });
	t.after(() => client.close());
	assert.deepEqual(await client.request("status", { releaseFixture: true }), { retiring: true, blockers: [] });
	await waitForProcessExit(child);
	assert.equal(child.exitCode, 0);
	assert.equal(new AgentCatalog(f.root).read(f.metadata.storageId).recoveryDue, false);
});

it("does not report delivery retries as host activity", { timeout: 15000 }, async (t) => {
	const f = await fixture(t);
	const sessionsRoot = dirname(dirname(f.metadata.storagePath));
	const path = primaryEndpointPath(sessionsRoot, f.ownerId);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, JSON.stringify({ version: PRIMARY_DELIVERY_CONTRACT, id: f.ownerId, serverId: randomUUID(), startedAt: new Date().toISOString(), pid: process.pid, hostname: hostname(), socketPath: join(f.root, "unavailable.sock"), cwd: f.cwd }));
	const errors = eventLog<Error>();
	const reportError = f.native.reportDeliveryError.bind(f.native);
	t.mock.method(f.native, "reportDeliveryError", (error?: Error) => { reportError(error); if (error) errors.push(error); });
	await f.runtime.request("report", { ownerId: f.ownerId, senderIdentity: f.metadata.storageId, message: "pending", requestId: "retry" }, "retry");
	await errors.waitForCount(1);
	await new Promise<void>((resolve) => setImmediate(resolve));
	let activity = 0;
	const unsubscribe = f.runtime.onActivity?.(() => { activity++; });
	try {
		await errors.waitForCount(2, 5000);
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.equal(activity, 0);
	} finally { unsubscribe?.(); }
});

it("refuses malformed recipients before creating report and intent rows", { timeout: 15000 }, async (t) => {
	const f = await fixture(t);
	await assert.rejects(f.runtime.request("report", { ownerId: "12345678", senderIdentity: f.metadata.storageId, message: "invalid", requestId: "invalid-report" }, "invalid-report"), /Delivery recipient must be an exact/u);
	await assert.rejects(f.runtime.request("submit", { message: "invalid", requestId: "invalid-intent", ownerId: "12345678", origin: "operator" }, "invalid-intent"), /Delivery recipient must be an exact/u);
	await assert.rejects(f.runtime.request("task-submit", { message: "invalid", requestId: "invalid-task", requester: f.ownerId, replyTo: "12345678", origin: "operator" }, "invalid-task"), /Delivery recipient must be an exact/u);
	await assert.rejects(f.runtime.request("timer-schedule", { message: "invalid", deliverAt: Date.now() + 60000, ownerId: "12345678" }, "invalid-timer"), /Delivery recipient must be an exact/u);
	const state = await f.native.harness.snapshot(AgentDeliveryDoc, BACKGROUND_CONTEXT);
	assert.equal(state?.reports.some((report) => report.ownerId === "12345678") ?? false, false);
	assert.equal(state?.intents.some((intent) => intent.ownerId === "12345678") ?? false, false);
});

it("keeps a native future timer alive even when the root has no submission", { timeout: 15000 }, async (t) => {
	const f = await fixture(t);
	const timer = await f.runtime.request("timer-schedule", { message: "later", deliverAt: Date.now() + 3600000, origin: "operator", ownerId: f.ownerId }, "timer") as { timerId: number };
	assert.equal(await eligible(f.runtime), false);
	await f.runtime.request("timer-cancel", { timerId: timer.timerId }, "cancel");
	assert.equal(await eligible(f.runtime), true);
});

it("keeps another conversation's native work and owner check-in task alive", { timeout: 15000 }, async (t) => {
	const f = await fixture(t);
	const first = await f.native.submit({ message: "finish root", requestId: "finished-root" });
	await f.native.wait(first.submissionId, BACKGROUND_CONTEXT);
	const fork = await f.native.request("fork", { requestId: "work-fork" }) as { conversationId: ConversationId };
	process.env.DURABLE_TEST_MODE = "request";
	const active = await f.native.submit({ message: "hold child", requestId: "active-child", conversationId: fork.conversationId, ownerId: f.ownerId, origin: "model", checkInMinutes: 60 });
	await f.marker("requested");
	const graph = await f.native.harness.taskGraph(BACKGROUND_CONTEXT);
	try { assert.ok(Object.values(graph.value.tasks).some((task) => task.kind === "agent.check-in")); }
	finally { graph.dispose(); }
	assert.equal(await eligible(f.runtime), false);
	await f.native.request("abort", { sessionId: `${f.metadata.storageId}:${fork.conversationId}`, background: true });
	await f.native.wait(active.submissionId, BACKGROUND_CONTEXT);
	await f.native.harness.waitForIdle(BACKGROUND_CONTEXT);
	await f.runtime.request("acknowledge", { ownerId: f.ownerId, submissionIds: [active.submissionId] }, "ack-child");
	assert.equal(await eligible(f.runtime), true);
});

for (const kind of ["intent", "missing-receipt", "receipt", "report"] as const) it(`retains delivery-only ${kind} with its expected retirement eligibility`, { timeout: 15000 }, async (t) => {
	const f = await fixture(t);
	const intent = { requestId: "pending", ownerId: f.ownerId, conversationId: 1 as ConversationId, message: "pending", whenBusy: null, operationId: null, submissionId: kind === "intent" ? null : 999 as SubmissionId, origin: "operator" as const };
	const receipt = { submissionId: 999 as SubmissionId, requestId: "pending", ownerId: f.ownerId, conversationId: 1 as ConversationId, operationId: null, origin: "operator" as const, status: "done" as const, entryId: null, answerEntryId: 999 as EntryId, answer: "answer", reason: null, acknowledged: false };
	await f.native.harness.commit(async (tx) => {
		const state = await tx.doc(AgentDeliveryDoc);
		if (kind === "intent" || kind === "missing-receipt") state.intents.push(intent);
		if (kind === "receipt") state.receipts["999"] = receipt;
		if (kind === "report") state.reports.push({ sourceId: "report:pending", requestId: "pending", ownerId: f.ownerId, senderIdentity: f.metadata.storageId, message: "pending", replyTo: null, acknowledged: false, createdAt: Date.now() });
	}, BACKGROUND_CONTEXT);
	assert.equal(await f.native.refreshIdle(), true, "delivery rows alone are not native tasks");
	assert.equal(await eligible(f.runtime), kind !== "intent", "only the pending unlinked admission prevents retirement");
	await f.native.harness.commit(async (tx) => {
		const state = await tx.doc(AgentDeliveryDoc);
		state.intents.splice(0);
		delete state.receipts["999"];
		state.reports.splice(0);
	}, BACKGROUND_CONTEXT);
	assert.equal(await eligible(f.runtime), true);
});

for (const kind of ["receipt", "report"] as const) it(`retires with a dead-owner ${kind} and clears the recovery marker`, { timeout: 15000 }, async (t) => {
	const f = await fixture(t);
	const dead = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
	await waitForProcessExit(dead, 5000);
	assert.ok(dead.pid);
	const sessionsRoot = dirname(dirname(f.metadata.storagePath));
	const path = primaryEndpointPath(sessionsRoot, f.ownerId);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, JSON.stringify({ version: PRIMARY_DELIVERY_CONTRACT, id: f.ownerId, serverId: randomUUID(), startedAt: new Date().toISOString(), pid: dead.pid, hostname: hostname(), socketPath: join(f.root, "dead.sock"), cwd: f.cwd }));
	await f.runtime.request("report", { ownerId: f.ownerId, senderIdentity: f.metadata.storageId, message: "pending", requestId: "dead-owner" }, "dead-owner");
	if (kind === "receipt") await f.native.harness.commit(async (tx) => {
		const state = await tx.doc(AgentDeliveryDoc);
		state.reports.splice(0);
		state.receipts["999"] = { submissionId: 999 as SubmissionId, requestId: "pending", ownerId: f.ownerId, conversationId: 1 as ConversationId, operationId: null, origin: "model", status: "done", entryId: null, answerEntryId: 999 as EntryId, answer: "answer", reason: null, acknowledged: false };
	}, BACKGROUND_CONTEXT);
	const state = await f.runtime.request("recovery-state", {}, "state") as { workPending: boolean; deliveriesPending: boolean; deliveriesActive: boolean };
	assert.deepEqual(state, { workPending: false, deliveriesPending: true, deliveriesActive: false });
	assert.equal(await eligible(f.runtime), true);
	await f.runtime.close();
	assert.equal(f.catalog.read(f.metadata.storageId).recoveryDue, false);
});

it("delivers a parked row when its owner registers before the source host retires", { timeout: 15000 }, async (t) => {
	const f = await fixture(t);
	const dead = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
	await waitForProcessExit(dead, 5000);
	assert.ok(dead.pid);
	const sessionsRoot = dirname(dirname(f.metadata.storagePath));
	const path = primaryEndpointPath(sessionsRoot, f.ownerId);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, JSON.stringify({ version: PRIMARY_DELIVERY_CONTRACT, id: f.ownerId, serverId: randomUUID(), startedAt: new Date().toISOString(), pid: dead.pid, hostname: hostname(), socketPath: join(f.root, "dead.sock"), cwd: f.cwd }));
	const errors = eventLog<Error>();
	const reportError = f.native.reportDeliveryError.bind(f.native);
	t.mock.method(f.native, "reportDeliveryError", (error?: Error) => { reportError(error); if (error) errors.push(error); });
	const host = await runHost(() => f.runtime, { metadata: f.metadata, idleMs: 0, announceReady: () => {} });
	t.after(() => host.close());
	await f.runtime.request("report", { ownerId: f.ownerId, senderIdentity: f.metadata.storageId, message: "parked", requestId: "parked-before-return" }, "report");
	await errors.waitForCount(1);
	const notices = eventLog<string>();
	const manager = new AgentManager({ root: f.root, agentDir: f.agentDir, packageDir: f.metadata.packageDir });
	t.after(() => manager.close());
	await manager.control("attach", { sessionId: f.metadata.storageId }, { id: randomUUID(), cwd: f.cwd });
	await manager.registerPrimary(f.ownerId, { cwd: f.cwd, signal: new AbortController().signal, send: (text) => notices.push(text) });
	await notices.waitForCount(1, 3000);
	assert.equal(notices.length, 1);
});

it("keeps cached dead-owner delivery cold after clean retirement and wakes at exact owner registration", { timeout: 15000 }, async (t) => {
	const f = await fixture(t);
	const dead = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
	await waitForProcessExit(dead, 5000);
	assert.ok(dead.pid);
	const path = primaryEndpointPath(f.root, f.ownerId);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, JSON.stringify({ version: PRIMARY_DELIVERY_CONTRACT, id: f.ownerId, serverId: randomUUID(), startedAt: new Date().toISOString(), pid: dead.pid, hostname: hostname(), socketPath: join(f.root, "dead.sock"), cwd: f.cwd }));
	const checks = eventLog<() => void>();
	const host = await runHost(() => f.runtime, { metadata: f.metadata, idleMs: 10, announceReady: () => {}, scheduleIdleCheck: (check) => { checks.push(check); return () => {}; } });
	t.after(() => host.close());
	let returning = false;
	let acquisitions = 0;
	let reopened: Awaited<ReturnType<typeof runHost>> | undefined;
	t.after(() => reopened?.close());
	const lost = eventLog<void>();
	const manager = new AgentManager({ root: f.root, agentDir: f.agentDir, packageDir: f.metadata.packageDir, acquire: async (metadata) => {
		acquisitions++;
		if (acquisitions > 1) {
			assert.ok(returning, "clean retirement must not acquire a recovery host");
			const runtime = await createDurableRuntime(metadata);
			reopened = await runHost(() => runtime, { metadata, idleMs: 0, announceReady: () => {} });
		}
		const client = await connectHost(metadata, { retryAttempts: 0 });
		client.onClose(() => lost.push(undefined));
		return client;
	} });
	t.after(() => manager.close());
	const other = randomUUID();
	const fallback = eventLog<string>();
	await manager.registerPrimary(other, { cwd: f.cwd, signal: new AbortController().signal, send: (text) => fallback.push(text) });
	await manager.control("attach", { sessionId: f.metadata.storageId }, { id: other, cwd: f.cwd });
	await f.runtime.request("report", { ownerId: f.ownerId, senderIdentity: f.metadata.storageId, message: "retained result", requestId: "cold-cached-owner" }, "report");
	await fallback.waitForCount(1);
	const idle = deferred();
	assert.ok(f.runtime.onActivity);
	const checkIdle = () => { void eligible(f.runtime).then((ready) => { if (ready) idle.resolve(); }); };
	const stop = f.runtime.onActivity(checkIdle);
	const stopQuiescent = f.runtime.onQuiescent?.(checkIdle);
	if (!await eligible(f.runtime)) await idle.promise;
	stop();
	stopQuiescent?.();
	checks[checks.length - 1]();
	await host.done;
	await lost.waitForCount(1);
	await (manager as unknown as { recoveryQueue: Promise<void> }).recoveryQueue;
	assert.equal(f.catalog.read(f.metadata.storageId).recoveryDue, false);
	assert.equal(acquisitions, 1);
	assert.equal((manager as unknown as { crashes: { entries: Iterable<unknown> } }).crashes.entries[Symbol.iterator]().next().done, true);
	assert.equal((manager as unknown as { clients: Map<string, unknown> }).clients.size, 0);
	returning = true;
	const delivered = eventLog<string>();
	await manager.registerPrimary(f.ownerId, { cwd: f.cwd, signal: new AbortController().signal, send: (text) => delivered.push(text) });
	await delivered.waitForCount(1);
	assert.equal(acquisitions, 2, "exact owner registration reopens only its retained row");
	assert.equal(fallback.length, 1);
	await reopened?.close();
	await lost.waitForCount(2);
	assert.equal(f.catalog.read(f.metadata.storageId).recoveryDue, false);
	assert.equal((manager as unknown as { crashes: { entries: Iterable<unknown> } }).crashes.entries[Symbol.iterator]().next().done, true);
});

it("rechecks a commit and an admission at asynchronous retirement boundaries", { timeout: 15000 }, async (t) => {
	const f = await fixture(t);
	const inspected = deferred();
	const release = deferred();
	t.after(release.resolve);
	const refresh = f.native.refreshIdle.bind(f.native);
	let gated = true;
	t.mock.method(f.native, "refreshIdle", async () => { const value = await refresh(); if (gated) { gated = false; inspected.resolve(); await release.promise; } return value; });
	const retiring = eligible(f.runtime);
	await inspected.promise;
	await f.runtime.request("timer-schedule", { message: "new work", deliverAt: Date.now() + 3600000, origin: "operator", ownerId: f.ownerId }, "raced-timer");
	release.resolve();
	assert.equal(await retiring, false, "the prior native idle snapshot does not seal a changed runtime");
	const timers = await f.runtime.request("timer-list", {}, "timers") as { timers: Array<{ timerId: number }> };
	await f.runtime.request("timer-cancel", { timerId: timers.timers[0].timerId }, "cancel-raced");
	assert.equal(await eligible(f.runtime), true);
	assert.ok(f.runtime.tryRetire);
	assert.equal(await f.runtime.tryRetire(() => true), true);
	await assert.rejects(f.runtime.request("submit", { message: "too late" }, "sealed"), /closed/u);
});

it("keeps a host-local foreign control alive across retirement", { timeout: 15000 }, async (t) => {
	const f = await fixture(t);
	const entered = deferred();
	const release = deferred();
	t.after(release.resolve);
	const request = f.native.request.bind(f.native);
	t.mock.method(f.native, "request", async (...args: Parameters<typeof request>) => {
		if (args[0] === "report") { entered.resolve(); await release.promise; }
		return request(...args);
	});
	assert.ok(f.runtime.requestRelease);
	assert.equal((await f.runtime.requestRelease()).retiring, true);
	const report = resolveAgentControlDispatch()("report", { sessionId: f.ownerId, message: "foreign control", senderIdentity: f.metadata.storageId, requestId: "foreign-report" });
	try {
		await entered.promise;
		assert.equal(f.runtime.releaseRequested, false, "foreign admission cancels the release before retirement checks");
		assert.equal(f.runtime.isIdle(), false);
		assert.equal(await eligible(f.runtime), false);
	} finally { release.resolve(); await report; }
	assert.equal(await eligible(f.runtime), true, "the report to an absent primary is parked and does not block retirement");
	await f.native.harness.commit(async (tx) => { const state = await tx.doc(AgentDeliveryDoc); state.reports.splice(0); }, BACKGROUND_CONTEXT);
	assert.equal(await eligible(f.runtime), true);
});

it("keeps an in-flight same-storage delivery alive after another caller acknowledges its row", { timeout: 15000 }, async (t) => {
	const f = await fixture(t);
	const entered = deferred();
	const release = deferred();
	let admitted!: (value: { submissionId: SubmissionId }) => void;
	const submitted = new Promise<{ submissionId: SubmissionId }>((resolve) => { admitted = resolve; });
	const request = f.native.request.bind(f.native);
	t.mock.method(f.native, "request", async (...args: Parameters<typeof request>) => {
		if (args[0] !== "submit") return request(...args);
		entered.resolve();
		await release.promise;
		const value = await request(...args) as { submissionId: SubmissionId };
		admitted(value);
		return value;
	});
	const report = await f.runtime.request("report", { ownerId: f.metadata.storageId, senderIdentity: f.metadata.storageId, message: "local delivery", requestId: "delivery-race" }, "delivery-race") as { sourceId: string };
	await entered.promise;
	try {
		await f.runtime.request("acknowledge", { ownerId: f.metadata.storageId, sourceIds: [report.sourceId] }, "ack-in-flight");
		assert.ok(f.runtime.tryRetire);
		assert.equal(await f.runtime.tryRetire(() => true), false, "the active delivery is work even after its row is acknowledged");
	} finally {
		release.resolve();
		const value = await submitted;
		await f.native.wait(value.submissionId, BACKGROUND_CONTEXT);
		await f.native.harness.waitForIdle(BACKGROUND_CONTEXT);
	}
});

for (const fault of ["catalog", "marker"] as const) it(`rejects a final ${fault} write failure without releasing the writer claim`, { timeout: 15000 }, async (t) => {
	const f = await fixture(t);
	f.catalog.markRecoveryDue(f.metadata.storageId, true);
	if (fault === "catalog") t.mock.method(AgentCatalog.prototype, "updateView", () => { throw new Error("catalog write refused"); });
	else {
		const mark = AgentCatalog.prototype.markRecoveryDue;
		t.mock.method(AgentCatalog.prototype, "markRecoveryDue", function (this: AgentCatalog, id: string, due: boolean) { if (!due) throw new Error("marker write refused"); return mark.call(this, id, due); });
	}
	const host = await runHost(() => f.runtime, { metadata: f.metadata, idleMs: 0, announceReady: () => {} });
	await assert.rejects(host.close(), /write refused/u);
	await assert.rejects(host.done, /write refused/u);
	assert.equal(existsSync(hostPaths(f.metadata).claim), true);
	assert.equal(f.catalog.read(f.metadata.storageId).recoveryDue, fault === "marker");
});

it("keeps two native observation watches until close, selection change, and abort release them", { timeout: 15000 }, async (t) => {
	const f = await fixture(t);
	const checks = eventLog<() => void>();
	const host = await runHost(() => f.runtime, { metadata: f.metadata, idleMs: 10, announceReady: () => {}, scheduleIdleCheck: (check) => { checks.push(check); return () => {}; } });
	t.after(() => host.close());
	const client = await connectHost(f.metadata, { retryAttempts: 0 });
	t.after(() => client.close());
	const controller = new AbortController();
	assert.ok(client.observe);
	const conversation = await client.observe({ scope: "conversation", sessionId: f.metadata.storageId });
	const tasks = await client.observe({ scope: "tasks", sessionId: f.metadata.storageId }, { signal: controller.signal });
	checks[checks.length - 1]();
	assert.equal(existsSync(hostPaths(f.metadata).claim), true);
	await conversation.close();
	const selected = await client.observe({ scope: "conversation", sessionId: f.metadata.storageId });
	await selected.close();
	checks[checks.length - 1]();
	assert.equal(existsSync(hostPaths(f.metadata).claim), true, "the task graph watch remains live");
	const count = checks.length;
	controller.abort();
	await tasks.close();
	await checks.waitForCount(count + 1);
	checks[checks.length - 1]();
	await host.done;
});

for (const scope of ["conversation", "tasks"] as const) it(`preserves a newer ${scope} publication while frame metadata is held`, { timeout: 15000 }, async (t) => {
	const f = await fixture(t);
	const entered = deferred();
	const release = deferred();
	const published = deferred();
	const snapshot = f.native.harness.snapshot.bind(f.native.harness);
	let gated = false;
	t.mock.method(f.native.harness, "snapshot", async (...args: Parameters<typeof snapshot>) => {
		if (Object.is(args[0], AgentMetaDoc) && gated) { gated = false; entered.resolve(); await release.promise; }
		return snapshot(...args);
	});
	const tap = <T,>(handle: import("@earendil-works/pi-durable").WatchHandle<T>) => ({ get value() { return handle.value; }, closed: handle.closed, stop: () => handle.stop(),
		start: (listener: Parameters<typeof handle.start>[0]) => handle.start(async (...args) => { await listener(...args); published.resolve(); }),
	});
	const conversation = f.native.harness.conversation.bind(f.native.harness);
	t.mock.method(f.native.harness, "conversation", async (...args: Parameters<typeof conversation>) => {
		const value = await conversation(...args);
		if (value) { const watch = value.watch.bind(value); t.mock.method(value, "watch", async (...watchArgs: Parameters<typeof watch>) => tap(await watch(...watchArgs))); }
		return value;
	});
	const tasks = f.native.harness.watchTaskGraph.bind(f.native.harness);
	t.mock.method(f.native.harness, "watchTaskGraph", async (...args: Parameters<typeof tasks>) => tap(await tasks(...args)));
	const timer = scope === "tasks" ? await f.runtime.request("timer-schedule", { message: "later", deliverAt: Date.now() + 3600000, origin: "operator", ownerId: f.ownerId }, "frame-timer") as { timerId: number } : undefined;
	gated = true;
	const opening = f.runtime.request("observe-open", { token: "gated", scope }, "gated-open") as Promise<{ frame: ConversationFrame | TasksFrame }>;
	void opening.catch(() => {});
	try {
		await entered.promise;
		if (timer) await f.native.request("timer-cancel", { timerId: timer.timerId });
		else { const submitted = await f.native.submit({ message: "new native entry", requestId: "during-frame" }); await f.native.wait(submitted.submissionId, BACKGROUND_CONTEXT); }
		await published.promise;
	} finally { release.resolve(); }
	const first = (await opening).frame;
	const second = await f.runtime.request("observe-frame", { token: "gated" }, "gated-frame") as ConversationFrame | TasksFrame;
	assert.ok(second.revision > first.revision, "the in-flight frame does not claim the newer revision");
	if (first.scope === "tasks" && second.scope === "tasks") { assert.ok(first.tasks.length > 0); assert.equal(second.tasks.length, 0); }
	if (first.scope === "conversation" && second.scope === "conversation") { assert.equal(first.entries.length, 0); assert.ok(second.entries.length > 0); }
	await f.runtime.request("observe-close", { token: "gated" }, "gated-close");
});

async function waitForSleepingTimer(host: DurableHost, timerId: number): Promise<void> {
	const graph = await host.harness.watchTaskGraph(BACKGROUND_CONTEXT);
	const sleeping = (value: typeof graph.value) => value.tasks[String(timerId)]?.state.status === "sleeping";
	try {
		if (sleeping(graph.value)) return;
		const updates = eventLog<boolean>();
		graph.start(async (value) => { updates.push(sleeping(value)); });
		await updates.waitFor((rows) => rows.includes(true), 10000);
	} finally { await graph.stop(); }
}

it("advances the task frame on a native timer sleep publication without a status read", { timeout: 15000 }, async (t) => {
	const f = await fixture(t);
	const entered = deferred();
	const release = deferred();
	t.after(release.resolve);
	const timerTask = f.registry.snapshot().task("agent.timer");
	assert.ok(timerTask);
	const phases = timerTask.definition.phases as typeof TimerTask.definition.phases;
	const wait = phases.wait;
	t.mock.method(phases, "wait", async (...args: Parameters<typeof wait>) => {
		entered.resolve();
		await release.promise;
		return wait(...args);
	});
	let stop = () => {};
	try {
		const deadline = Date.now() + 3600000;
		const timer = await f.runtime.request("timer-schedule", { message: "later", deliverAt: deadline, origin: "operator", ownerId: f.ownerId }, "sleep-timer") as { timerId: number };
		await entered.promise;
		const first = (await f.runtime.request("observe-open", { token: "sleep", scope: "tasks" }, "sleep-open") as { frame: TasksFrame }).frame;
		assert.equal(first.tasks.find((task) => task.id === timer.timerId)?.status, "running");
		const transitions: string[] = [];
		stop = f.native.harness.subscribeCommits((publication) => {
			for (const change of publication.changes) if (change.type === "task" && change.value.id === timer.timerId) transitions.push(change.value.state.status);
		});
		release.resolve();
		await waitForSleepingTimer(f.native, timer.timerId);
		const second = await f.runtime.request("observe-frame", { token: "sleep" }, "sleep-frame") as TasksFrame;
		assert.deepEqual(transitions, ["sleeping"], "the native sleep commits one real task transition");
		assert.ok(second.revision > first.revision, "a background state change invalidates the task frame without a read");
		const asleep = second.tasks.find((task) => task.id === timer.timerId);
		assert.equal(asleep?.status, "sleeping");
		assert.equal(asleep?.until, deadline);
		const cancelled = await f.runtime.request("timer-cancel", { timerId: timer.timerId }, "sleep-cancel") as { status: string };
		assert.equal(cancelled.status, "cancelled");
		const final = await f.runtime.request("observe-frame", { token: "sleep" }, "cancelled-frame") as TasksFrame;
		assert.ok(final.revision > second.revision, "cancellation also invalidates the task frame");
		assert.equal(final.tasks.some((task) => task.id === timer.timerId), false);
	} finally {
		stop();
		release.resolve();
		await f.runtime.request("observe-close", { token: "sleep" }, "sleep-close");
	}
});

for (const scope of ["conversation", "tasks"] as const) it(`invalidates ${scope} metadata on real changes but not status reads`, { timeout: 15000 }, async (t) => {
	const f = await fixture(t);
	const timer = scope === "tasks" ? await f.runtime.request("timer-schedule", { message: "later", deliverAt: Date.now() + 3600000, origin: "operator", ownerId: f.ownerId }, "label-timer") as { timerId: number } : undefined;
	// The timer's independent sleep commit precedes the read-only assertion.
	if (timer) await waitForSleepingTimer(f.native, timer.timerId);
	const first = (await f.runtime.request("observe-open", { token: "metadata", scope }, "meta-open") as { frame: ConversationFrame | TasksFrame }).frame;
	await f.native.harness.commit(async (tx) => { const state = await tx.doc(AgentMetaDoc, 1 as ConversationId); state.name = "metadata only"; }, BACKGROUND_CONTEXT);
	const second = await f.runtime.request("observe-frame", { token: "metadata" }, "meta-frame") as ConversationFrame | TasksFrame;
	assert.ok(second.revision > first.revision);
	if (second.scope === "conversation") assert.equal(second.status.name, "metadata only");
	else assert.equal(second.labels.find((label) => label.conversationId === 1)?.name, "metadata only");
	const writes: string[] = [];
	const stop = f.native.harness.subscribeCommits((publication) => { writes.push(...publication.changes.map((change) => change.type)); });
	try {
		await f.runtime.request("status", undefined, "empty-read");
		const unchanged = await f.runtime.request("observe-frame", { token: "metadata" }, "unchanged-frame") as ConversationFrame | TasksFrame;
		assert.deepEqual(writes, [], "status and frame reads commit no state changes");
		assert.equal(unchanged.revision, second.revision, "an empty read publication does not invalidate the cache");
	} finally { stop(); }
	await f.runtime.request("observe-close", { token: "metadata" }, "meta-close");
	if (timer) await f.runtime.request("timer-cancel", { timerId: timer.timerId }, "label-cancel");
});

it("releases only the logical observer whose established native frame fails", { timeout: 15000 }, async (t) => {
	const f = await fixture(t);
	let fail = false;
	const conversation = f.native.harness.conversation.bind(f.native.harness);
	t.mock.method(f.native.harness, "conversation", async (...args: Parameters<typeof conversation>) => {
		const value = await conversation(...args);
		if (value) {
			const watch = value.watch.bind(value);
			t.mock.method(value, "watch", async (...watchArgs: Parameters<typeof watch>) => {
				const handle = await watch(...watchArgs);
				return { get value() { if (fail) { fail = false; throw new Error("native frame source unavailable"); } return handle.value; }, closed: handle.closed, start: (listener: Parameters<typeof handle.start>[0]) => handle.start(listener), stop: () => handle.stop() };
			});
		}
		return value;
	});
	const checks = eventLog<() => void>();
	const host = await runHost(() => f.runtime, { metadata: f.metadata, idleMs: 10, announceReady: () => {}, scheduleIdleCheck: (check) => { checks.push(check); return () => {}; } });
	t.after(() => host.close());
	const client = await connectHost(f.metadata, { retryAttempts: 0 });
	t.after(() => client.close());
	assert.ok(client.observe);
	const failed = await client.observe({ scope: "conversation", sessionId: f.metadata.storageId });
	const healthy = await client.observe({ scope: "conversation", sessionId: f.metadata.storageId });
	const unavailable = deferred();
	const fresh = deferred();
	let healthyAvailable = true;
	failed.onFrame((_frame, _fresh, state) => { if (state === "unavailable") unavailable.resolve(); });
	healthy.onFrame((frame, _fresh, state) => { healthyAvailable = state === "live"; if (state === "live" && frame?.scope === "conversation" && frame.status.name === "after source failure") fresh.resolve(); });
	fail = true;
	await client.request("configure", { name: "after source failure" });
	await unavailable.promise;
	await fresh.promise;
	await client.request("status");
	assert.equal(client.closed, false);
	assert.equal(healthyAvailable, true);
	assert.equal(f.native.observationCount, 1, "only the healthy logical token remains");
	checks[checks.length - 1]();
	assert.equal(existsSync(hostPaths(f.metadata).claim), true);
	await healthy.close();
	await failed.close();
	await client.request("status");
	assert.equal(f.native.observationCount, 0);
	checks[checks.length - 1]();
	await host.done;
});

it("refuses reload without teardown while a live observer remains, then reloads and retires after release", { timeout: 15000 }, async (t) => {
	const f = await fixture(t);
	const checks = eventLog<() => void>();
	const host = await runHost(() => f.runtime, { metadata: f.metadata, idleMs: 10, announceReady: () => {}, scheduleIdleCheck: (check) => { checks.push(check); return () => {}; } });
	t.after(() => host.close());
	const client = await connectHost(f.metadata, { retryAttempts: 0 });
	t.after(() => client.close());
	assert.ok(client.observe);
	const observation = await client.observe({ scope: "conversation", sessionId: f.metadata.storageId });
	await client.request("status");
	await assert.rejects(client.request("command", { name: "reload" }), /Reload requires closed live observations/u);
	const fresh = deferred();
	observation.onFrame((frame, _fresh, state) => { if (state === "live" && frame?.scope === "conversation" && frame.status.name === "after refused reload") fresh.resolve(); });
	await client.request("configure", { name: "after refused reload" });
	await fresh.promise;
	await observation.close();
	await client.request("status");
	await client.request("command", { name: "reload" });
	assert.equal(f.runtime.shutdownRequired, false);
	await client.request("status");
	checks[checks.length - 1]();
	await host.done;
});

it("retains final costs, drops manager caches without recovery, serves cold reads, and admits later work", { timeout: 20000 }, async (t) => {
	const f = await fixture(t);
	const checks = eventLog<() => void>();
	const host = await runHost(() => f.runtime, { metadata: f.metadata, idleMs: 10, announceReady: () => {}, scheduleIdleCheck: (check) => { checks.push(check); return () => {}; } });
	t.after(() => host.close());
	let acquisitions = 0;
	const lost = eventLog<void>();
	const notices = eventLog<string>();
	const footers = eventLog<string>();
	const manager = new AgentManager({ root: f.root, agentDir: f.agentDir, packageDir: f.metadata.packageDir, acquire: async (metadata) => {
		acquisitions++;
		const client = await connectHost(metadata, { retryAttempts: 0 });
		client.onClose(() => lost.push(undefined));
		return client;
	} });
	t.after(() => manager.close());
	const observer = f.ownerId;
	await manager.registerPrimary(observer, { signal: new AbortController().signal, cwd: f.cwd, send: (text) => notices.push(text), status: (text) => { if (text) footers.push(text); } });
	await manager.control("attach", { sessionId: f.metadata.storageId }, { id: observer, cwd: f.cwd });
	const oldAnswer = process.env.DURABLE_TEST_ANSWER;
	process.env.DURABLE_TEST_ANSWER = "retained costly answer ".repeat(200);
	t.after(() => { if (oldAnswer === undefined) delete process.env.DURABLE_TEST_ANSWER; else process.env.DURABLE_TEST_ANSWER = oldAnswer; });
	const first = await f.native.submit({ message: "first costly answer", requestId: "cost-first" });
	await f.native.wait(first.submissionId, BACKGROUND_CONTEXT);
	delete process.env.DURABLE_TEST_ANSWER;
	const fork = await f.native.request("fork", { name: "independent fork", requestId: "fork" }) as { conversationId: ConversationId };
	const submitted = await f.native.submit({ message: "second answer", requestId: "cost-second", conversationId: fork.conversationId });
	await f.native.wait(submitted.submissionId, BACKGROUND_CONTEXT);
	await f.native.harness.waitForIdle(BACKGROUND_CONTEXT);
	assert.equal(await eligible(f.runtime), true);
	const rows = await f.native.request("dashboard", {}) as Array<{ cost: number }>;
	const total = rows.reduce((sum, row) => sum + row.cost, 0);
	assert.ok(total > 0, "the fixture supplies a nonzero final usage increment");
	const remaining = deferred();
	assert.ok(f.runtime.onChange);
	const change = f.runtime.onChange(remaining.resolve);
	checks[checks.length - 1]();
	await host.done;
	await lost.waitForCount(1);
	change();
	await remaining.promise;
	const clients = (manager as unknown as { clients: Map<string, unknown> }).clients;
	// The transport close reaches managers after final publication and writer release.
	const client = await connectHost(f.metadata).catch(() => undefined);
	assert.equal(client, undefined);
	await manager.status(f.metadata.storageId);
	assert.equal(clients.size, 0);
	assert.equal(acquisitions, 1, "clean retirement starts no recovery host");
	assert.equal((manager as unknown as { crashes: { entries: Iterable<unknown> } }).crashes.entries[Symbol.iterator]().next().done, true);
	assert.equal(f.catalog.read(f.metadata.storageId).recoveryDue, false);
	const before = await manager.dashboardPage();
	assert.equal(before.rows.reduce((sum, row) => sum + row.cost, 0), total);
	assert.equal(f.catalog.read(f.metadata.storageId).view?.coverage.complete, false, "the trimmed final reply retains explicit partial coverage");
	assert.equal(before.coverage.skipped, 1);
	await footers.waitFor((items) => items.some((text) => text.endsWith(` · ~$${total.toFixed(2)}`)));
	const cold = await manager.control("inspect", { sessionId: f.metadata.storageId, view: "history" }, { id: observer, cwd: f.cwd }) as { entries: unknown[] };
	assert.ok(cold.entries.length > 0);
	assert.equal(existsSync(hostPaths(f.metadata).claim), false);
	const reopenedRuntime = await createDurableRuntime(f.metadata);
	const reopened = await runHost(() => reopenedRuntime, { metadata: f.metadata, idleMs: 0, announceReady: () => {} });
	t.after(() => reopened.close());
	const later = await manager.control("submit", { sessionId: f.metadata.storageId, message: "later work", requestId: "later", origin: "operator" }, { id: observer, cwd: f.cwd }) as { submissionId: number };
	assert.equal(acquisitions, 2);
	await notices.waitForCount(1);
	// Delivery acknowledgement commits after the primary accepts the notice.
	await reopenedRuntime.request("acknowledge", { ownerId: observer, submissionIds: [later.submissionId] }, "later-ack");
	await reopened.close();
	const after = await manager.dashboardPage();
	assert.ok(after.rows.reduce((sum, row) => sum + row.cost, 0) > total);
});
