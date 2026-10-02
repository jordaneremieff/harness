import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { it } from "node:test";
import { fileURLToPath } from "node:url";
import type { JsonValue, ServiceCall } from "@earendil-works/chord";
import { ServerError, type ServerHost } from "@earendil-works/pi-server";
import { Client } from "@earendil-works/pi-client";
import { createUnixTransportFactory } from "@earendil-works/pi-client/unix";
import { createUnixServer } from "@earendil-works/pi-server/unix";
import { HOST_RUNTIME_VERSION, HOST_SERVICE_ID, HOST_SOCKET_PATH_LIMIT_BYTES, hostPaths } from "./host-protocol.ts";
import { acquireHost, connectHost, snapshotHost, waitForHostRelease, type HostConnection, type HostLaunchOptions, type HostObservationScope } from "./host-client.ts";
import { fixtureMetadata, readFixtureState, eventLog, waitForFixtureState, waitForConnectionClose, writeFixtureState } from "./host-fixture.mts";
import type { ConversationFrame } from "./live-frames.ts";
import { markerFixture } from "./durable-runtime-fixture.mts";

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

/** One versioned service fixture; version zero predates the runtime-version member. */
async function openVersionedHost(root: string, version = 0, status?: JsonValue): Promise<{ readonly metadata: ReturnType<typeof fixtureMetadata>; calls: string[]; close(): Promise<void> }> {
	const metadata = fixtureMetadata(root);
	const paths = hostPaths(metadata);
	mkdirSync(paths.directory, { recursive: true, mode: 0o700 });
	mkdirSync(dirname(paths.claim), { recursive: true, mode: 0o700 });
	writeFileSync(
		paths.claim,
		JSON.stringify({ token: randomUUID(), pid: process.pid, host: hostname(), sessionId: metadata.storageId, cwd: metadata.cwd, createdAt: new Date().toISOString() }),
		{ mode: 0o600 },
	);
	const calls: string[] = [];
	const host: ServerHost = {
		serverServices: {
			attachClient: () => ({
				invokeService: async (call: ServiceCall) => {
					calls.push(call.member);
					if (version > 0 && call.member === "runtime-version") return { version };
					if (status !== undefined && call.member === "status") return status;
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
	return { metadata, calls, close: async () => { await server.close().catch(() => undefined); } };
}

it("detects an older host and refuses its new-only methods with the update reason", { timeout: 30000 }, async (t) => {
	const root = fixtureRoot(t);
	const older = await openVersionedHost(root);
	t.after(() => older.close());
	const connection = await connectHost(older.metadata, launch());
	t.after(() => connection.close().catch(() => {}));
	assert.equal(connection.runtimeVersion, 0, "a host without the version member reads as older");
	await assert.rejects(
		connection.request("timer-schedule", {}),
		(error: unknown) => error instanceof Error && /older code and does not support timer-schedule\. Automatic update is blocked/u.test(error.message),
	);
	const observe = connection.observe?.bind(connection);
	assert.ok(observe, "an attached connection exposes observations");
	await assert.rejects(
		observe({ scope: "conversation", sessionId: older.metadata.storageId }),
		(error: unknown) => error instanceof Error && /older code and does not support observe-open\. Automatic update is blocked/u.test(error.message),
	);
	// An older host still serves the methods all versions share; its own error passes through.
	await assert.rejects(connection.request("status", {}), /unknown durable host method status/u);
	await connection.close();
});

it("keeps compatible newer-host reads but refuses mutations and unknown newer output", async (t) => {
	const root = fixtureRoot(t);
	const status = { conversation: { conversationId: 1, identity: "fixture", busy: false, lastText: null, live: null, inbox: null, agent: { thinkingLevel: "off", extensions: [], tools: [] }, tasks: [] as JsonValue[], submissions: [] } };
	const server = await openVersionedHost(root, HOST_RUNTIME_VERSION + 1, status);
	t.after(() => server.close());
	const client = await connectHost(server.metadata, { retryAttempts: 0 });
	t.after(() => client.close());
	assert.deepEqual(await client.request("status"), status);
	await assert.rejects(client.request("close"), /This Pi runs older code.*Restart this Pi/u);
	await assert.rejects(client.request("submit", { message: "task" }), /Restart this Pi/u);
	assert.equal(server.calls.includes("close"), false);
	assert.equal(server.calls.includes("submit"), false);
	status.conversation.tasks.push({ id: 1, kind: "fixture", status: "future-state", background: false, abortRequested: false });
	await assert.rejects(client.request("status"), /unsupported status.*Restart this Pi/u);
	assert.equal(client.closed, false, "unsupported data does not authorize transport recovery");
});

it("waits for an owned launch's readiness frame instead of probing its socket", { timeout: 15000 }, async (t) => {
	const root = fixtureRoot(t);
	const config = fixtureMetadata(root);
	const markers = markerFixture(t, root);
	const release = markers.hold("ready");
	const code = `
		import { runHost } from ${JSON.stringify(new URL("./host-process.ts", import.meta.url).href)};
		import { formatHostReady } from ${JSON.stringify(new URL("./host-protocol.ts", import.meta.url).href)};
		import { publishFixtureMarker } from ${JSON.stringify(new URL("./testdata/durable-runtime/signal.ts", import.meta.url).href)};
		let ready;
		const host = await runHost(() => ({ request: async () => ({}), close: async () => {}, isIdle: () => true }), { metadata: JSON.parse(process.argv.at(-1)), idleMs: 0, announceReady: value => { ready = value; } });
		await publishFixtureMarker(process.env.DURABLE_TEST_NOTIFY, "ready");
		process.stdout.write(formatHostReady(ready));
		await host.done;
	`;
	const started = acquireHost(config, { runner: "--input-type=module", runnerArgs: ["--eval", code], launchTimeoutMs: 5000, env: { DURABLE_TEST_NOTIFY: markers.notifyPath } });
	t.after(async () => { release(); const client = await started.catch(() => undefined); if (client) { await client.request("close").catch(() => undefined); await client.close(); } });
	await markers.marker("ready");
	let attached = false;
	const attaching = connectHost(config).then((client) => { attached = true; return client; });
	t.after(async () => { await (await attaching).close(); });
	const paths = hostPaths(config);
	const raw = await Client.connect({ serverId: paths.serverId, transportFactory: createUnixTransportFactory({ path: paths.socket }) });
	t.after(() => raw.dispose());
	await raw.request({ serverId: paths.serverId }, { serviceId: HOST_SERVICE_ID, member: "status", args: [null, randomUUID()] });
	assert.equal(attached, false, "a listening socket does not replace the held readiness frame");
	release();
	const [first, second] = await Promise.all([started, attaching]);
	assert.equal(first.pid, second.pid);
});

it("reports a foreign live launch as starting elsewhere without retry polling", async (t) => {
	const root = fixtureRoot(t);
	const config = fixtureMetadata(root);
	const paths = hostPaths(config);
	mkdirSync(dirname(paths.claim), { recursive: true });
	writeFileSync(paths.claim, JSON.stringify({ token: randomUUID(), pid: process.pid, host: hostname(), sessionId: config.storageId, cwd: config.cwd, createdAt: new Date().toISOString() }));
	await assert.rejects(connectHost(config), /starting elsewhere.*no readiness event/u);
	await assert.rejects(acquireHost(config), /starting elsewhere/u);
	await assert.rejects(waitForHostRelease(config), /No process-exit or close-completion event/u);
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
	await waitForFixtureState(connection, statePath, (state) => (state.waitsStarted ?? 0) >= 1);
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
	await waitForFixtureState(connection, statePath, (state) => (state.hangsStarted ?? 0) >= 1);
	process.kill(connection.pid, "SIGKILL");
	await assert.rejects(pending, /connection was lost|disconnected|closed/iu);
	await waitForConnectionClose(connection);
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
	await waitForFixtureState(connection, statePath, (state) => (state.waitsStarted ?? 0) >= 1);
	controller.abort();
	await assert.rejects(pending, (error: unknown) => error instanceof Error && error.name === "AbortError");
	await waitForFixtureState(connection, statePath, (state) => (state.waitsCancelled ?? 0) >= 1);
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
	await waitForFixtureState(connection, statePath, (state) => (state.waitsStarted ?? 0) >= 1);
	controller.abort();
	await assert.rejects(pending, (error: unknown) => error instanceof Error && error.name === "AbortError");
	await connection.request("release-waits");
	await waitForFixtureState(connection, statePath, (state) => (state.waitCompleted ?? 0) >= 1);
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
	await waitForFixtureState(connection, statePath, (state) => (state.hangsStarted ?? 0) >= 1);
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
	const changes = eventLog<number>();
	const unsubscribe = await subscribeChanges(connection, () => changes.push(changes.length));
	await changes.waitForCount(1);
	await connection.request("touch");
	await changes.waitForCount(2);
	unsubscribe();
	const settled = changes.length;
	await connection.request("touch");
	await connection.request("echo", { barrier: true });
	assert.equal(changes.length, settled, "cancelled subscription stopped");
	assert.deepEqual(await connection.request("echo", { alive: true }), { alive: true });
	await connection.close();
});

it("re-subscribes after a host kill while a safe call is pending", { timeout: 30000 }, async (t) => {
	const root = fixtureRoot(t);
	const statePath = join(root, "state.json");
	const connection = await openHost(t, root);
	const changes = eventLog<number>();
	const unsubscribe = await subscribeChanges(connection, () => changes.push(changes.length));
	await changes.waitForCount(1);
	const pending = connection.request("receipts", { requestId: "changes-resume" });
	await waitForFixtureState(connection, statePath, (state) => (state.waitsStarted ?? 0) >= 1);
	const firstPid = connection.pid;
	process.kill(firstPid, "SIGKILL");
	writeFixtureState(statePath, { release: true });
	await changes.waitFor(() => connection.pid !== firstPid && changes.length >= 2, 15000);
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
	await waitForFixtureState(connection, statePath, (state) => (state.hangsStarted ?? 0) >= 1);
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
	await waitForHostRelease(config, { signal: AbortSignal.timeout(10000) });
	assert.ok((readFixtureState(statePath).closed ?? 0) >= 1);
	const second = await acquireHost(config, launch());
	track(t, second.pid);
	assert.notEqual(second.pid, firstPid);
	assert.equal(readFixtureState(statePath).starts, 2);
	await second.close();
});

it("reads a snapshot through a bounded helper connection", { timeout: 30000 }, async (t) => {
	const root = fixtureRoot(t);
	const statePath = join(root, "state.json");
	const snapshot = await snapshotHost(fixtureMetadata(root), { view: "list" }, launch());
	assert.equal((snapshot as { starts?: number }).starts, 1);
	assert.equal(readFixtureState(statePath).starts, 1);
	const client = await connectHost(fixtureMetadata(root));
	track(t, client.pid);
	await client.close();
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
	await waitForConnectionClose(connection);
	assert.equal(closed, true);
	unsubscribe();
	assert.equal(connection.closed, true);
	await connection.close();
});

const observationFixturePath = fileURLToPath(new URL("./live-observation-fixture.mts", import.meta.url));

/** Launch options for the real DurableHost fixture; idle retirement is disabled by its pinned host. */
function observationLaunch(extra: Partial<HostLaunchOptions> = {}): HostLaunchOptions {
	return { runner: observationFixturePath, ...extra };
}

it("pushes live conversation frames and stops on observation close", { timeout: 60000 }, async (t) => {
	const root = fixtureRoot(t);
	const config = fixtureMetadata(root);
	const connection = await acquireHost(config, observationLaunch());
	track(t, connection.pid);
	t.after(() => connection.close().catch(() => {}));
	const frames = eventLog<ConversationFrame>();
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
	await frames.waitFor((items) => items.some((frame) => frame.entries.some((entry) => entry.kind === "pi.assistant")), 30000);
	const answered = frames[frames.length - 1];
	assert.ok(answered !== undefined && answered.scope === "conversation");
	assert.ok(answered.revision > base.revision, "the published frame advances the revision");
	assert.equal(answered.status.lastTextRole, "assistant");
	const revisions = frames.map((frame) => frame.revision);
	assert.equal(new Set(revisions).size, revisions.length, "a coalesced publisher never repeats a revision");
	assert.ok(revisions.every((revision, index) => index === 0 || revision > (revisions[index - 1] ?? 0)), "published revisions strictly increase");

	await observation.close();
	const settled = frames.length;
	const witness = await observeFrames(connection, { scope: "conversation", sessionId: config.storageId });
	t.after(() => witness.close());
	const witnessed = eventLog<ConversationFrame>();
	witness.onFrame((frame) => { if (frame?.scope === "conversation") witnessed.push(frame); });
	await connection.request("submit", { sessionId: config.storageId, message: "after close", requestId: "observation-2" });
	await witnessed.waitFor((items) => items.some((frame) => frame.entries.filter((entry) => entry.kind === "pi.assistant").length >= 2), 30000);
	await witness.close();
	assert.equal(frames.length, settled, "a closed observation receives no further frames");
});

it("signals unavailable without relaunching after a host kill while observing", { timeout: 60000 }, async (t) => {
	const root = fixtureRoot(t);
	const config = fixtureMetadata(root);
	const connection = await acquireHost(config, observationLaunch({ launchTimeoutMs: 5000 }));
	track(t, connection.pid);
	t.after(() => connection.close().catch(() => {}));
	const observation = await observeFrames(connection, { scope: "conversation", sessionId: config.storageId });
	const events = eventLog<{ fresh: boolean; state?: string }>();
	observation.onFrame((_frame, isFresh, state) => events.push({ fresh: isFresh, state }));
	assert.deepEqual(events, [{ fresh: true, state: "live" }], "the baseline arrives with the live state");
	const firstPid = connection.pid;
	process.kill(firstPid, "SIGKILL");
	await events.waitFor((items) => items.some((event) => event.state === "unavailable"), 40000);
	const unavailable = events.filter((event) => event.state === "unavailable");
	assert.equal(unavailable.length, 1, "one unavailable signal per listener");
	assert.equal(unavailable[0]?.fresh, false);
	assert.equal(connection.pid, firstPid, "an observation loss never relaunches the host");
	assert.equal(connection.closed, true, "the connection closes for the manager's bounded recovery");
});

it("keeps the task-graph observation live across a host recovery", { timeout: 60000 }, async (t) => {
	const root = fixtureRoot(t);
	const markers = markerFixture(t, root);
	const config = fixtureMetadata(root);
	const connection = await acquireHost(config, observationLaunch({ env: { DURABLE_TEST_NOTIFY: markers.notifyPath } }));
	track(t, connection.pid);
	t.after(() => connection.close());
	const observation = await observeFrames(connection, { scope: "tasks", sessionId: config.storageId });
	assert.equal(observation.frame.scope, "tasks");
	const firstPid = connection.pid;
	let resumed!: () => void;
	const freshFrame = new Promise<void>((resolve) => { resumed = resolve; });
	observation.onFrame((frame, fresh, state) => {
		if (connection.pid !== firstPid && fresh && state === "live") {
			assert.equal(frame?.scope, "tasks");
			resumed();
		}
	});
	const pending = connection.request("snapshot", { sessionId: config.storageId, fixtureHold: true });
	await markers.marker("snapshot-gated");
	process.kill(firstPid, "SIGKILL");
	await pending;
	track(t, connection.pid);
	await freshFrame;
	assert.notEqual(connection.pid, firstPid, "the gated safe request recovers onto a replacement host");
	assert.equal(connection.closed, false);
	assert.equal(observation.frame.scope, "tasks");
	const baseline = observation.frame.revision;
	let changed!: () => void;
	const nextFrame = new Promise<void>((resolve) => { changed = resolve; });
	observation.onFrame((frame, fresh, state) => {
		if (state === "live" && !fresh && frame?.scope === "tasks" && frame.revision > baseline) changed();
	});
	await connection.request("submit", { sessionId: config.storageId, message: "after recovery", requestId: "tasks-after-recovery" });
	await nextFrame;
	await observation.close();
});

it("marks a failed observation reopen unavailable while the recovered connection stays usable", { timeout: 10000 }, async (t) => {
	const root = fixtureRoot(t);
	const markers = markerFixture(t, root);
	const config = fixtureMetadata(root);
	const connection = await acquireHost(config, observationLaunch({ env: { DURABLE_TEST_OBSERVATION_REOPEN: "fail", DURABLE_TEST_NOTIFY: markers.notifyPath } }));
	track(t, connection.pid);
	t.after(() => connection.close());
	const observation = await observeFrames(connection, { scope: "conversation", sessionId: config.storageId });
	const firstPid = connection.pid;
	let unavailable!: () => void;
	const lost = new Promise<void>((resolve) => { unavailable = resolve; });
	let failures = 0;
	observation.onFrame((frame, fresh, state) => {
		if (state !== "unavailable") return;
		failures += 1;
		assert.equal(frame?.scope, "conversation");
		assert.equal(fresh, false);
		unavailable();
	});
	const pending = connection.request("snapshot", { sessionId: config.storageId, fixtureHold: true });
	await markers.marker("snapshot-gated");
	process.kill(firstPid, "SIGKILL");
	await pending;
	track(t, connection.pid);
	await lost;
	assert.notEqual(connection.pid, firstPid);
	assert.equal(connection.closed, false);
	const late: Array<string | undefined> = [];
	observation.onFrame((_frame, _fresh, state) => late.push(state));
	assert.deepEqual(late, ["unavailable"], "a late listener never receives a stale live baseline");
	await connection.request("status", { sessionId: config.storageId });
	await observation.close();
	await connection.close();
	assert.equal(failures, 1, "the failed observation receives one unavailable event");
});
