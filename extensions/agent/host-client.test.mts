import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { it } from "node:test";
import { fileURLToPath } from "node:url";
import type { ServiceCall } from "@earendil-works/chord";
import { ServerError, type ServerHost } from "@earendil-works/pi-server";
import { createUnixServer } from "@earendil-works/pi-server/unix";
import { HOST_SOCKET_PATH_LIMIT_BYTES, hostPaths } from "./host-protocol.ts";
import { acquireHost, connectHost, snapshotHost, type HostConnection, type HostLaunchOptions, type HostObservationScope } from "./host-client.ts";
import { fixtureMetadata, readFixtureState, waitUntil, writeFixtureState } from "./host-fixture.mts";
import type { ConversationFrame } from "./live-frames.ts";

const fixturePath = fileURLToPath(new URL("./host-fixture.mts", import.meta.url));

function launch(extra: Partial<HostLaunchOptions> = {}): HostLaunchOptions {
	return { runner: fixturePath, ...extra };
}

function fixtureRoot(t: { after(fn: () => void): void }): string {
	const root = mkdtempSync(join(tmpdir(), "host-client-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	return root;
}

function track(t: { after(fn: () => void): void }, pid: number): void {
	t.after(() => {
		try {
			process.kill(pid, "SIGKILL");
		} catch {
			// The host already exited.
		}
	});
}

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function openHost(t: { after(fn: () => void): void }, root: string, options: HostLaunchOptions = launch()): Promise<HostConnection> {
	const connection = await acquireHost(fixtureMetadata(root), options);
	track(t, connection.pid);
	return connection;
}

async function subscribeChanges(connection: HostConnection, listener: () => void): Promise<() => void> {
	if (!connection.subscribeChanges) throw new Error("host connection does not publish change notifications");
	return connection.subscribeChanges(listener);
}

async function observeFrames(connection: HostConnection, scope: HostObservationScope) {
	if (!connection.observe) throw new Error("host connection does not publish live frames");
	return connection.observe(scope);
}

/** One live host surface that predates the runtime-version member and rejects every method as an old runtime does. */
async function openOlderHost(root: string): Promise<{ readonly metadata: ReturnType<typeof fixtureMetadata>; close(): Promise<void> }> {
	const metadata = fixtureMetadata(root);
	const paths = hostPaths(metadata);
	mkdirSync(paths.directory, { recursive: true, mode: 0o700 });
	mkdirSync(dirname(paths.claim), { recursive: true, mode: 0o700 });
	writeFileSync(
		paths.claim,
		JSON.stringify({ token: randomUUID(), pid: process.pid, host: hostname(), sessionId: metadata.storageId, cwd: metadata.cwd, createdAt: new Date().toISOString() }),
		{ mode: 0o600 },
	);
	const host: ServerHost = {
		serverServices: {
			attachClient: () => ({
				invokeService: async (call: ServiceCall) => {
					throw new ServerError("service_invalid_value", `unknown durable host method ${call.member}`);
				},
				release: () => {},
			}),
		},
		resolveSession: async () => { throw new ServerError("session_not_found", "this older host routes no sessions"); },
		openSession: async () => { throw new ServerError("session_not_found", "this older host routes no sessions"); },
	};
	const server = createUnixServer(host, { serverId: paths.serverId, path: paths.socket, mode: 0o600 });
	await server.start();
	return { metadata, close: async () => { await server.close().catch(() => undefined); } };
}

it("detects an older host and refuses its new-only methods with the update reason", { timeout: 30000 }, async (t) => {
	const root = fixtureRoot(t);
	const older = await openOlderHost(root);
	t.after(() => older.close());
	const connection = await connectHost(older.metadata, launch());
	t.after(() => connection.close().catch(() => {}));
	assert.equal(connection.runtimeVersion, 0, "a host without the version member reads as older");
	await assert.rejects(
		connection.request("timer-schedule", {}),
		(error: unknown) => error instanceof Error && /older code and does not support timer-schedule; it updates when idle/u.test(error.message),
	);
	const observe = connection.observe?.bind(connection);
	assert.ok(observe, "an attached connection exposes observations");
	await assert.rejects(
		observe({ scope: "conversation", sessionId: older.metadata.storageId }),
		(error: unknown) => error instanceof Error && /older code and does not support observe-open; it updates when idle/u.test(error.message),
	);
	// An older host still serves the methods all versions share; its own error passes through.
	await assert.rejects(connection.request("status", {}), /unknown durable host method status/u);
	await connection.close();
});

it("launches a host, echoes, and attaches to the live claim", { timeout: 30000 }, async (t) => {
	const root = fixtureRoot(t);
	const statePath = join(root, "state.json");
	const config = fixtureMetadata(root);
	const first = await openHost(t, root);
	assert.ok(first.pid > 0);
	assert.equal(first.closed, false);
	assert.deepEqual(await first.request("echo", { hello: "world" }), { hello: "world" });
	const second = await connectHost(config, launch());
	track(t, second.pid);
	assert.equal(second.pid, first.pid);
	assert.deepEqual(await second.request("echo", { from: "second" }), { from: "second" });
	assert.equal(readFixtureState(statePath).starts, 1);
	await second.close();
	await first.close();
});

it("refuses to connect when no host is live", { timeout: 30000 }, async (t) => {
	const root = fixtureRoot(t);
	await assert.rejects(connectHost(fixtureMetadata(root), launch()), /no live durable host/u);
});

it("relaunches a dead host and reuses one durable submission", { timeout: 30000 }, async (t) => {
	const root = fixtureRoot(t);
	const statePath = join(root, "state.json");
	const config = fixtureMetadata(root);
	const first = await openHost(t, root);
	const initial = await first.request("submit", { prompt: "task" }, { requestId: "stable-1" });
	assert.deepEqual(initial, { submissionId: 101, requestId: "stable-1", params: { prompt: "task" } });
	const firstPid = first.pid;
	process.kill(firstPid, "SIGKILL");
	const second = await acquireHost(config, launch());
	track(t, second.pid);
	assert.notEqual(second.pid, firstPid);
	const repeated = await second.request("submit", { prompt: "task" }, { requestId: "stable-1" });
	assert.deepEqual(repeated, initial, "the resend reuses the retained submission");
	assert.equal(Object.keys(readFixtureState(statePath).submitted ?? {}).length, 1);
	assert.equal(readFixtureState(statePath).starts, 2);
	await second.close();
});

it("resends a retry-safe call after a killed host", { timeout: 30000 }, async (t) => {
	const root = fixtureRoot(t);
	const statePath = join(root, "state.json");
	const connection = await openHost(t, root);
	const pending = connection.request("receipts", {}, { requestId: "receipts-1" });
	await waitUntil(() => (readFixtureState(statePath).waitsStarted ?? 0) >= 1);
	const firstPid = connection.pid;
	process.kill(firstPid, "SIGKILL");
	writeFixtureState(statePath, { release: true });
	assert.deepEqual(await pending, { released: true });
	assert.notEqual(connection.pid, firstPid);
	track(t, connection.pid);
	assert.ok((readFixtureState(statePath).waitCompleted ?? 0) >= 1);
	assert.equal(connection.closed, false);
	await connection.close();
});

it("rejects an unsafe call instead of resending it", { timeout: 30000 }, async (t) => {
	const root = fixtureRoot(t);
	const statePath = join(root, "state.json");
	const config = fixtureMetadata(root);
	const connection = await openHost(t, root);
	const pending = connection.request("hang");
	await waitUntil(() => (readFixtureState(statePath).hangsStarted ?? 0) >= 1);
	process.kill(connection.pid, "SIGKILL");
	await assert.rejects(pending, /connection was lost|disconnected|closed/iu);
	await waitUntil(() => connection.closed);
	await connection.close();
	const again = await acquireHost(config, launch());
	track(t, again.pid);
	assert.deepEqual(await again.request("echo", 1), 1);
	assert.equal(readFixtureState(statePath).starts, 2);
	await again.close();
});

it("aborting a wait cancels the host-side wait without harming the host", { timeout: 30000 }, async (t) => {
	const root = fixtureRoot(t);
	const statePath = join(root, "state.json");
	const connection = await openHost(t, root);
	const controller = new AbortController();
	const pending = connection.request("receipts", { wait: true }, { signal: controller.signal });
	await waitUntil(() => (readFixtureState(statePath).waitsStarted ?? 0) >= 1);
	controller.abort();
	await assert.rejects(pending, (error: unknown) => error instanceof Error && error.name === "AbortError");
	await waitUntil(() => (readFixtureState(statePath).waitsCancelled ?? 0) >= 1);
	assert.equal(readFixtureState(statePath).waitCompleted ?? 0, 0, "the cancelled wait did not complete");
	assert.deepEqual(await connection.request("echo", { alive: true }), { alive: true });
	assert.equal(connection.closed, false);
	await connection.close();
});

it("aborting without the wait flag leaves the host-side wait running", { timeout: 30000 }, async (t) => {
	const root = fixtureRoot(t);
	const statePath = join(root, "state.json");
	const connection = await openHost(t, root);
	const controller = new AbortController();
	const pending = connection.request("receipts", {}, { signal: controller.signal });
	await waitUntil(() => (readFixtureState(statePath).waitsStarted ?? 0) >= 1);
	controller.abort();
	await assert.rejects(pending, (error: unknown) => error instanceof Error && error.name === "AbortError");
	writeFixtureState(statePath, { release: true });
	await waitUntil(() => (readFixtureState(statePath).waitCompleted ?? 0) >= 1);
	assert.equal(readFixtureState(statePath).waitsCancelled ?? 0, 0, "no cancel was sent for a plain read");
	assert.deepEqual(await connection.request("echo", { alive: true }), { alive: true });
	await connection.close();
});

it("aborting an unsafe call never cancels host work", { timeout: 30000 }, async (t) => {
	const root = fixtureRoot(t);
	const statePath = join(root, "state.json");
	const connection = await openHost(t, root);
	const controller = new AbortController();
	const pending = connection.request("hang", {}, { signal: controller.signal });
	await waitUntil(() => (readFixtureState(statePath).hangsStarted ?? 0) >= 1);
	controller.abort();
	await assert.rejects(pending, (error: unknown) => error instanceof Error && error.name === "AbortError");
	assert.equal(readFixtureState(statePath).hangsSignaled, undefined, "unsafe work receives no cancel signal");
	assert.deepEqual(await connection.request("echo", { alive: true }), { alive: true });
	assert.equal(connection.closed, false);
	await connection.close();
});

it("reports initial and changed state and stops on cancel", { timeout: 30000 }, async (t) => {
	const root = fixtureRoot(t);
	const connection = await openHost(t, root);
	const changes: number[] = [];
	const unsubscribe = await subscribeChanges(connection, () => changes.push(changes.length));
	await waitUntil(() => changes.length >= 1);
	await connection.request("touch");
	await waitUntil(() => changes.length >= 2);
	unsubscribe();
	const settled = changes.length;
	await connection.request("touch");
	await new Promise((resolve) => setTimeout(resolve, 50));
	assert.equal(changes.length, settled, "cancelled subscription stopped");
	assert.deepEqual(await connection.request("echo", { alive: true }), { alive: true });
	await connection.close();
});

it("re-subscribes after a host kill while a safe call is pending", { timeout: 30000 }, async (t) => {
	const root = fixtureRoot(t);
	const statePath = join(root, "state.json");
	const connection = await openHost(t, root);
	const changes: number[] = [];
	const unsubscribe = await subscribeChanges(connection, () => changes.push(changes.length));
	await waitUntil(() => changes.length >= 1);
	const pending = connection.request("receipts", { requestId: "changes-resume" });
	await waitUntil(() => (readFixtureState(statePath).waitsStarted ?? 0) >= 1);
	const firstPid = connection.pid;
	process.kill(firstPid, "SIGKILL");
	writeFixtureState(statePath, { release: true });
	await waitUntil(() => connection.pid !== firstPid && changes.length >= 2, 15000);
	track(t, connection.pid);
	assert.deepEqual(await pending, { released: true });
	await unsubscribe();
	await connection.close();
});

it("closing the connection with admitted work does not cancel it", { timeout: 30000 }, async (t) => {
	const root = fixtureRoot(t);
	const statePath = join(root, "state.json");
	const config = fixtureMetadata(root);
	const connection = await openHost(t, root);
	const pending = connection.request("hang");
	await waitUntil(() => (readFixtureState(statePath).hangsStarted ?? 0) >= 1);
	await connection.close();
	await assert.rejects(pending);
	const again = await acquireHost(config, launch());
	track(t, again.pid);
	assert.equal(readFixtureState(statePath).hangsSignaled, undefined, "admitted work received no cancel signal");
	assert.deepEqual(await again.request("echo", { alive: true }), { alive: true });
	await again.close();
});

it("retires an idle host and relaunches it on the next access", { timeout: 30000 }, async (t) => {
	const root = fixtureRoot(t);
	const statePath = join(root, "state.json");
	const config = fixtureMetadata(root);
	const connection = await acquireHost(config, launch({ env: { PI_AGENT_IDLE_MINUTES: "0.01" } }));
	const firstPid = connection.pid;
	await connection.close();
	await waitUntil(() => (readFixtureState(statePath).closed ?? 0) >= 1);
	await waitUntil(() => !alive(firstPid), 10000);
	const second = await acquireHost(config, launch());
	track(t, second.pid);
	assert.notEqual(second.pid, firstPid);
	assert.equal(readFixtureState(statePath).starts, 2);
	await second.close();
});

it("reads a cold snapshot through the helper", { timeout: 30000 }, async (t) => {
	const root = fixtureRoot(t);
	const statePath = join(root, "state.json");
	const snapshot = await snapshotHost(fixtureMetadata(root), { view: "list" }, launch());
	assert.equal((snapshot as { starts?: number }).starts, 1);
	assert.equal(readFixtureState(statePath).starts, 1);
});

it("refuses to replace a claim owned by another host", { timeout: 30000 }, async (t) => {
	const root = fixtureRoot(t);
	const config = fixtureMetadata(root);
	const paths = hostPaths(config);
	mkdirSync(dirname(paths.claim), { recursive: true });
	writeFileSync(paths.claim, JSON.stringify({ token: "other", pid: process.pid, host: "another-machine", sessionId: config.storageId, cwd: config.cwd, createdAt: new Date().toISOString() }), { mode: 0o600 });
	await assert.rejects(acquireHost(config, launch()), /cannot be replaced/u);
});

it("keeps a deep agent directory working with a short socket path", { timeout: 30000 }, async (t) => {
	const root = fixtureRoot(t);
	const deepRoot = join(root, "d".repeat(140));
	mkdirSync(deepRoot, { recursive: true });
	const config = fixtureMetadata(deepRoot);
	const connection = await acquireHost(config, launch());
	track(t, connection.pid);
	assert.ok(Buffer.byteLength(connection.socketPath, "utf8") <= HOST_SOCKET_PATH_LIMIT_BYTES);
	assert.deepEqual(await connection.request("echo", "deep"), "deep");
	await connection.close();
});

it("reports terminal closure through onClose after a kill", { timeout: 30000 }, async (t) => {
	const root = fixtureRoot(t);
	const connection = await openHost(t, root);
	let closed = false;
	const unsubscribe = connection.onClose(() => {
		closed = true;
	});
	process.kill(connection.pid, "SIGKILL");
	await waitUntil(() => closed, 10000);
	unsubscribe();
	assert.equal(connection.closed, true);
	await connection.close();
});

const observationFixturePath = fileURLToPath(new URL("./live-observation-fixture.mts", import.meta.url));

/** Launch options for the real DurableHost fixture; idle retirement is disabled by its pinned host. */
function observationLaunch(extra: Partial<HostLaunchOptions> = {}): HostLaunchOptions {
	return { runner: observationFixturePath, ...extra };
}

/** Poll an async condition without a fixed sleep. */
async function untilAsync(check: () => Promise<boolean> | boolean, timeoutMs = 20000, label = "condition"): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		if (await check()) return;
		if (Date.now() >= deadline) throw new Error(`${label} was not reached before its deadline`);
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

it("pushes live conversation frames and stops on observation close", { timeout: 60000 }, async (t) => {
	const root = fixtureRoot(t);
	const config = fixtureMetadata(root);
	const connection = await acquireHost(config, observationLaunch());
	track(t, connection.pid);
	t.after(() => connection.close().catch(() => {}));
	const frames: ConversationFrame[] = [];
	const observation = await observeFrames(connection, { scope: "conversation", sessionId: config.storageId });
	observation.onFrame((frame) => {
		if (frame?.scope === "conversation") frames.push(frame);
	});
	const attached: Array<{ fresh: boolean; state?: string }> = [];
	observation.onFrame((_frame, isFresh, state) => attached.push({ fresh: isFresh, state }));
	assert.deepEqual(attached, [{ fresh: true, state: "live" }], "the current frame arrives for a late listener");
	const base = observation.frame;
	assert.equal(base.scope, "conversation");
	if (base.scope !== "conversation") assert.fail("expected a conversation frame");
	assert.equal(base.conversationId, 1);
	await connection.request("submit", { sessionId: config.storageId, message: "transport prompt", requestId: "observation-1" });
	await untilAsync(() => frames.some((frame) => frame.entries.some((entry) => entry.kind === "pi.assistant")), 30000, "live answer frame");
	const answered = frames[frames.length - 1];
	assert.ok(answered !== undefined && answered.scope === "conversation");
	assert.ok(answered.revision > base.revision, "the published frame advances the revision");
	assert.equal(answered.status.lastTextRole, "assistant");
	const revisions = frames.map((frame) => frame.revision);
	assert.equal(new Set(revisions).size, revisions.length, "a coalesced publisher never repeats a revision");
	assert.ok(revisions.every((revision, index) => index === 0 || revision > (revisions[index - 1] ?? 0)), "published revisions strictly increase");

	await observation.close();
	const settled = frames.length;
	await connection.request("submit", { sessionId: config.storageId, message: "after close", requestId: "observation-2" });
	await untilAsync(async () => {
		const snapshot = (await connection.request("snapshot", { sessionId: config.storageId })) as { entries: readonly { kind: string }[] };
		return snapshot.entries.filter((entry) => entry.kind === "pi.user").length >= 2;
	}, 30000, "second answer placed");
	await new Promise((resolve) => setTimeout(resolve, 200));
	assert.equal(frames.length, settled, "a closed observation receives no further frames");
});

it("signals unavailable without relaunching after a host kill while observing", { timeout: 60000 }, async (t) => {
	const root = fixtureRoot(t);
	const config = fixtureMetadata(root);
	const connection = await acquireHost(config, observationLaunch({ launchTimeoutMs: 5000 }));
	track(t, connection.pid);
	t.after(() => connection.close().catch(() => {}));
	const observation = await observeFrames(connection, { scope: "conversation", sessionId: config.storageId });
	const events: Array<{ fresh: boolean; state?: string }> = [];
	observation.onFrame((_frame, isFresh, state) => events.push({ fresh: isFresh, state }));
	assert.deepEqual(events, [{ fresh: true, state: "live" }], "the baseline arrives with the live state");
	const firstPid = connection.pid;
	process.kill(firstPid, "SIGKILL");
	await untilAsync(() => events.some((event) => event.state === "unavailable"), 40000, "unavailable signal");
	const unavailable = events.filter((event) => event.state === "unavailable");
	assert.equal(unavailable.length, 1, "one unavailable signal per listener");
	assert.equal(unavailable[0]?.fresh, false);
	assert.equal(connection.pid, firstPid, "an observation loss never relaunches the host");
	assert.equal(connection.closed, true, "the connection closes for the manager's bounded recovery");
});

it("keeps the task-graph observation live across a host recovery", { timeout: 60000 }, async (t) => {
	const root = fixtureRoot(t);
	const config = fixtureMetadata(root);
	const connection = await acquireHost(config, observationLaunch({ launchTimeoutMs: 20000 }));
	track(t, connection.pid);
	t.after(() => connection.close().catch(() => {}));
	const observation = await observeFrames(connection, { scope: "tasks", sessionId: config.storageId });
	assert.equal(observation.frame.scope, "tasks");
	await observation.close();
	await connection.close();
});
