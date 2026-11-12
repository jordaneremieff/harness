import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, it } from "node:test";
import { fileURLToPath } from "node:url";
import type { JsonValue } from "@earendil-works/chord/json";
import { connectTransport, createTransportServer, type TransportClient } from "../../transport/index.ts";
import { HOST_SOCKET_PATH_LIMIT_BYTES, HostError, hostPaths } from "./host-protocol.ts";
import { acquireHost, connectHost, HostBusyEndpointUnavailableError, HostReadinessUnavailableError, observeOwnedHostExit, snapshotHost, waitForHostRelease, type HostConnection, type HostLaunchOptions, type HostObservationScope } from "./host-client.ts";
import { fixtureMetadata, readFixtureState, eventLog, waitForFixtureState, waitForConnectionClose } from "./host-fixture.mts";
import type { ConversationFrame } from "./live-frames.ts";
import { HOST_CONTRACT, type RuntimeContract } from "./version-contract.ts";
import { fixtureTeardown, markerFixture, waitForProcessGone } from "./durable-runtime-fixture.mts";
import { runHost } from "./host-process.ts";
import { tryNativeWriterLease } from "./native-lease.ts";

const fixturePath = fileURLToPath(new URL("./host-fixture.mts", import.meta.url));

function launch(extra: Partial<HostLaunchOptions> = {}): HostLaunchOptions {
	return { runner: fixturePath, ...extra };
}

const fixtureRoots = new Set<string>();
after(() => { for (const root of fixtureRoots) rmSync(root, { recursive: true, force: true }); });

function fixtureRoot(_t: { after(fn: () => void): void }): string {
	const root = mkdtempSync(join(tmpdir(), "host-client-"));
	fixtureRoots.add(root);
	return root;
}

function track(t: { after(fn: () => void | Promise<void>): void }, pid: number): void {
	t.after(async () => {
		try {
			process.kill(pid, "SIGKILL");
		} catch {
			// The host already exited.
		}
		assert.equal(await waitForProcessGone(pid), true, "the owned host exited before fixture root removal");
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

/** A transport fixture with independently declared operation contracts. */
async function openVersionedHost(root: string, contract: RuntimeContract | undefined, status?: JsonValue, hello?: { value: unknown }): Promise<{ readonly metadata: ReturnType<typeof fixtureMetadata>; calls: string[]; close(): Promise<void> }> {
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
	const writerId = randomUUID();
	const server = createTransportServer({
		serverId: paths.serverId, path: paths.socket,
		request: async (request) => {
			calls.push(request.method);
			if (contract && request.method === "runtime-contract") return hello ? hello.value : { format: "pi.agent.host-hello/1", writerId, contract };
			if (status !== undefined && request.method === "status") return status;
			if (request.method === "close") return {};
			throw new Error(`unknown durable host method ${request.method}`);
		},
	});
	await server.start();
	return { metadata, calls, close: async () => { await server.close().catch(() => undefined); } };
}

it("refuses a peer without the current negotiation contract before dispatch", async (t) => {
 const root = fixtureRoot(t);
 const peer = await openVersionedHost(root, undefined);
 t.after(() => peer.close());
 await assert.rejects(connectHost(peer.metadata, launch()), /current operation contract.*Restart/u);
 assert.deepEqual(peer.calls, ["runtime-contract"]);
});

for (const value of [HOST_CONTRACT, { format: "pi.agent.host-hello/1", contract: HOST_CONTRACT }, { format: "pi.agent.host-hello/1", writerId: "", contract: HOST_CONTRACT }]) it("refuses a peer without the required current writer hello before dispatch", { timeout: 10000 }, async (t) => {
	const root = fixtureRoot(t);
	const peer = await openVersionedHost(root, HOST_CONTRACT, undefined, { value });
	t.after(() => peer.close());
	await assert.rejects(connectHost(peer.metadata), /current operation contract.*Restart/u);
	assert.deepEqual(peer.calls, ["runtime-contract"]);
});

it("admits unchanged operations across releases and refuses only changed contracts", async (t) => {
 const root = fixtureRoot(t);
 const contract = structuredClone(HOST_CONTRACT);
 const altered: RuntimeContract = { ...contract, release: "9.0.0", operations: { ...contract.operations, submit: { request: "submit/2.0.0", response: "submit/2.0.0" } } };
 const status: JsonValue = { conversation: { conversationId: 1 } };
 const peer = await openVersionedHost(root, altered, status);
 t.after(() => peer.close());
 const client = await connectHost(peer.metadata, { retryAttempts: 0 });
 t.after(() => client.close());
 assert.deepEqual(await client.request("status"), status);
 await assert.rejects(client.request("submit", { message: "task" }), /submit request contract.*Restart/u);
 assert.equal(peer.calls.includes("submit"), false);
 assert.equal(client.closed, false);
});

it("refuses a changed observation contract before its payload reaches a schema parser", async (t) => {
 const root = fixtureRoot(t);
 const contract: RuntimeContract = { ...HOST_CONTRACT, operations: { ...HOST_CONTRACT.operations, status: { ...HOST_CONTRACT.operations.status, response: "different-shape" } } };
 const peer = await openVersionedHost(root, contract, { different: true });
 t.after(() => peer.close());
 const client = await connectHost(peer.metadata);
 t.after(() => client.close());
 await assert.rejects(client.request("status"), /status response contract.*Restart/u);
 assert.equal(peer.calls.includes("status"), false);
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
	const raw = await connectTransport({ serverId: paths.serverId, path: paths.socket });
	t.after(() => raw.dispose());
	await raw.request({ method: "status", requestId: randomUUID(), contract: HOST_CONTRACT.operations.status });
	assert.equal(attached, false, "a listening socket does not replace the held readiness frame");
	release();
	const [first, second] = await Promise.all([started, attaching]);
	assert.equal(first.pid, second.pid);
});

it("refuses a retired changes operation without a feed fallback", { timeout: 10000 }, async t => {
	const root = fixtureRoot(t);
	const altered = { ...HOST_CONTRACT, operations: { ...HOST_CONTRACT.operations, changes: { request: "changes/1.0.0", response: "changes/1.0.0" } } };
	const peer = await openVersionedHost(root, altered);
	t.after(() => peer.close());
	const client = await connectHost(peer.metadata);
	t.after(() => client.close());
	assert.ok(client.subscribeChanges);
	await assert.rejects(client.subscribeChanges(() => {}), /changes.*contract/u);
	assert.equal(client.ownerEvidence?.kind, "unknown");
	assert.deepEqual(peer.calls, ["runtime-contract"]);
});

it("an unrelated live PID is diagnostic, not native ownership or release evidence", async (t) => {
	const root = fixtureRoot(t);
	const config = fixtureMetadata(root);
	const paths = hostPaths(config);
	mkdirSync(dirname(paths.claim), { recursive: true });
	writeFileSync(paths.claim, JSON.stringify({ token: randomUUID(), pid: process.pid, host: hostname(), sessionId: config.storageId, cwd: config.cwd, createdAt: new Date().toISOString() }), { mode: 0o600 });
	const inode = lstatSync(paths.claim).ino;
	const claim = JSON.parse(readFileSync(paths.claim, "utf8"));
	writeFileSync(paths.claim, JSON.stringify({ ...claim, endedAt: claim.createdAt }));
	await assert.rejects(connectHost(config), /No verified native host endpoint/u);
	await assert.rejects(waitForHostRelease(config), /No owned child-exit or owner close-completion event/u);
	const client = await acquireHost(config, launch());
	track(t, client.pid);
	assert.equal(lstatSync(paths.claim).ino, inode);
	await client.request("close").catch(() => undefined);
	assert.ok(client.ownedExit);
	assert.equal((await client.ownedExit).failed, false);
	await client.close();
});

it("launches a host, echoes, and attaches to the live claim", { timeout: 30000 }, async (t) => {
	const root = fixtureRoot(t);
	const statePath = join(root, "state.json");
	const config = fixtureMetadata(root);
	const first = await openHost(t, root);
	assert.ok(first.pid > 0);
	assert.equal(first.closed, false);
	assert.deepEqual(await first.request("timer-list", { hello: "world" }), { hello: "world" });
	const second = await connectHost(config, launch());
	track(t, second.pid);
	assert.equal(second.pid, first.pid);
	assert.deepEqual(await second.request("timer-list", { from: "second" }), { from: "second" });
	assert.equal(readFixtureState(statePath).starts, 1);
	await second.close();
	await first.close();
});

it("refuses to connect when no host is live", { timeout: 30000 }, async (t) => {
	const root = fixtureRoot(t);
	await assert.rejects(connectHost(fixtureMetadata(root), launch()), /No verified native host endpoint/u);
});

it("reacquires after an owned process exit without losing the retained submission", { timeout: 30000 }, async (t) => {
	const root = fixtureRoot(t);
	const statePath = join(root, "state.json");
	const config = fixtureMetadata(root);
	const first = await openHost(t, root);
	const initial = await first.request("submit", { prompt: "task" }, { requestId: "stable-1" });
	assert.deepEqual(initial, { submissionId: 101, requestId: "stable-1", params: { prompt: "task" } });
	const firstPid = first.pid;
	process.kill(firstPid, "SIGKILL");
	await waitForConnectionClose(first);
	assert.ok(first.ownedExit);
	await first.ownedExit;
	const next = await acquireHost(config, launch());
	track(t, next.pid);
	assert.notEqual(next.pid, firstPid);
	assert.deepEqual(await next.request("submit", { prompt: "task" }, { requestId: "stable-1" }), initial);
	assert.equal(Object.keys(readFixtureState(statePath).submitted ?? {}).length, 1);
	assert.equal(readFixtureState(statePath).starts, 2);
	await next.close();
	await first.close();
});

it("retries a safe call only after an exact owned failed exit", { timeout: 30000 }, async (t) => {
	const root = fixtureRoot(t);
	const statePath = join(root, "state.json");
	const connection = await openHost(t, root);
	const pending = connection.request("receipts", { fixtureGate: true }, { requestId: "receipts-1" });
	await waitForFixtureState(connection, statePath, (state) => (state.waitsStarted ?? 0) >= 1);
	const firstPid = connection.pid;
	process.kill(firstPid, "SIGKILL");
	await connection.request("timer-list", { recovered: true });
	track(t, connection.pid);
	assert.notEqual(connection.pid, firstPid);
	assert.equal(readFixtureState(statePath).starts, 2);
	await connection.request("timer-cancel");
	await pending;
	assert.equal(connection.closed, false);
	await connection.close();
});

it("rejects an unsafe call instead of resending it", { timeout: 30000 }, async (t) => {
	const root = fixtureRoot(t);
	const statePath = join(root, "state.json");
	const config = fixtureMetadata(root);
	const connection = await openHost(t, root);
	const pending = connection.request("abort");
	await waitForFixtureState(connection, statePath, (state) => (state.hangsStarted ?? 0) >= 1);
	process.kill(connection.pid, "SIGKILL");
	await assert.rejects(pending, /connection was lost|disconnected|closed|peer ended/iu);
	await waitForConnectionClose(connection);
	await connection.close();
	assert.ok(connection.ownedExit);
	await connection.ownedExit;
	const next = await acquireHost(config, launch());
	track(t, next.pid);
	assert.equal(readFixtureState(statePath).starts, 2);
	assert.equal(readFixtureState(statePath).hangsStarted, 1, "unsafe work was not replayed");
	await next.close();
});

it("aborting a private gated read leaves host work running", { timeout: 30000 }, async (t) => {
	const root = fixtureRoot(t);
	const statePath = join(root, "state.json");
	const connection = await openHost(t, root);
	const controller = new AbortController();
	const pending = connection.request("receipts", { fixtureGate: true }, { signal: controller.signal });
	await waitForFixtureState(connection, statePath, (state) => (state.waitsStarted ?? 0) >= 1);
	controller.abort();
	await assert.rejects(pending, (error: unknown) => error instanceof Error && error.name === "AbortError");
	await connection.request("timer-cancel");
	await waitForFixtureState(connection, statePath, (state) => (state.waitCompleted ?? 0) >= 1);
	assert.equal(readFixtureState(statePath).waitsCancelled ?? 0, 0, "no cancel was sent for a plain read");
	assert.deepEqual(await connection.request("timer-list", { alive: true }), { alive: true });
	await connection.close();
});

it("aborting an unsafe call never cancels host work", { timeout: 30000 }, async (t) => {
	const root = fixtureRoot(t);
	const statePath = join(root, "state.json");
	const connection = await openHost(t, root);
	const controller = new AbortController();
	const pending = connection.request("abort", {}, { signal: controller.signal });
	await waitForFixtureState(connection, statePath, (state) => (state.hangsStarted ?? 0) >= 1);
	controller.abort();
	await assert.rejects(pending, (error: unknown) => error instanceof Error && error.name === "AbortError");
	assert.equal(readFixtureState(statePath).hangsSignaled, undefined, "unsafe work receives no cancel signal");
	assert.deepEqual(await connection.request("timer-list", { alive: true }), { alive: true });
	assert.equal(connection.closed, false);
	await connection.close();
});

it("reports initial and changed state and stops on cancel", { timeout: 30000 }, async (t) => {
	const root = fixtureRoot(t);
	const connection = await openHost(t, root);
	const changes = eventLog<number>();
	const unsubscribe = await subscribeChanges(connection, () => changes.push(changes.length));
	await changes.waitForCount(1);
	await connection.request("report");
	await changes.waitForCount(2);
	unsubscribe();
	const settled = changes.length;
	await connection.request("report");
	await connection.request("timer-list", { barrier: true });
	assert.equal(changes.length, settled, "cancelled subscription stopped");
	assert.deepEqual(await connection.request("timer-list", { alive: true }), { alive: true });
	await connection.close();
});

it("rebinds change subscriptions after an owned failed exit with retryable work", { timeout: 30000 }, async (t) => {
	const root = fixtureRoot(t);
	const statePath = join(root, "state.json");
	const connection = await openHost(t, root, launch({ env: { HOST_FIXTURE_PUBLICATION: "1" } }));
	const changes = eventLog<number>();
	const unsubscribe = await subscribeChanges(connection, () => changes.push(changes.length));
	await changes.waitForCount(1);
	assert.equal(connection.ownerEvidence?.kind, "verified");
	const writerId = connection.writerId;
	const pending = connection.request("receipts", { requestId: "changes-resume", fixtureGate: true });
	await waitForFixtureState(connection, statePath, (state) => (state.waitsStarted ?? 0) >= 1);
	const firstPid = connection.pid;
	process.kill(firstPid, "SIGKILL");
	await connection.request("timer-list", { recovered: true });
	track(t, connection.pid);
	assert.notEqual(connection.pid, firstPid);
	assert.equal(connection.closed, false);
	await connection.request("timer-cancel");
	await pending;
	await changes.waitForCount(2);
	assert.notEqual(connection.writerId, writerId);
	assert.equal(connection.ownerEvidence?.kind, "verified", "the rebound initial publication belongs to the new hello");
	if (connection.ownerEvidence?.kind === "verified") assert.equal(connection.ownerEvidence.view?.storageId, connection.storageId);
	unsubscribe();
	assert.equal(connection.ownerEvidence?.kind, "unknown", "the last publication subscription ended");
	const stopped = changes.length;
	await connection.request("report");
	await connection.request("timer-list", { barrier: true });
	assert.equal(changes.length, stopped, "disposed subscriptions produce no later notification");
	await connection.close();
});

for (const close of ["local", "owner"] as const) it(`invalidates current-host publication on ${close} close`, { timeout: 10000 }, async t => {
	const root = fixtureRoot(t), metadata = fixtureMetadata(root);
	const listeners = new Set<() => void>();
	const view = { storageId: metadata.storageId, updatedAt: "2026-01-01T00:00:00.000Z", rows: [], coverage: { complete: true, omitted: 0 } };
	const host = await runHost(() => ({ publishedView: view, request: async () => ({}), close: async () => {}, isIdle: () => false, onChange: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; } }), { metadata, idleMs: 0, announceReady() {} });
	t.after(() => host.close());
	const client = await connectHost(metadata);
	t.after(() => client.close());
	const changes = eventLog<void>();
	assert.ok(client.subscribeChanges);
	await client.subscribeChanges(() => changes.push(undefined));
	await changes.waitForCount(1);
	const kind = () => client.ownerEvidence?.kind;
	assert.equal(kind(), "verified");
	if (client.ownerEvidence?.kind === "verified") assert.deepEqual(client.ownerEvidence.view, view);
	if (close === "owner") await client.request("close"); else await client.close();
	assert.equal(kind(), "unavailable");
	const count = changes.length;
	for (const notify of listeners) notify();
	await new Promise<void>(resolve => setImmediate(resolve));
	assert.equal(changes.length, count, "old callbacks do not restore a closed owner's publication");
	assert.equal(kind(), "unavailable");
});

it("a busy runner causes one endpoint negotiation without a native runtime open", { timeout: 10000 }, async t => {
	const root = fixtureRoot(t), metadata = fixtureMetadata(root);
	const evidence = join(root, "busy-peer.json");
	const source = `
		import { writeFileSync } from 'node:fs';
		import { randomUUID } from 'node:crypto';
		import { createTransportServer } from ${JSON.stringify(new URL("../../transport/index.ts", import.meta.url).href)};
		import { hostPaths, formatHostBusy } from ${JSON.stringify(new URL("./host-protocol.ts", import.meta.url).href)};
		import { HOST_CONTRACT } from ${JSON.stringify(new URL("./version-contract.ts", import.meta.url).href)};
		const metadata = JSON.parse(process.argv[1]);
		const paths = hostPaths(metadata), writerId = randomUUID(); let calls = 0;
		const save = () => writeFileSync(${JSON.stringify(evidence)}, JSON.stringify({pid:process.pid,calls}));
		save();
		const server = createTransportServer({serverId:paths.serverId,path:paths.socket,request:async request => {calls++;save();return {format:'pi.agent.host-hello/1',writerId,contract:HOST_CONTRACT};}});
		await server.start(); save(); process.stdout.write(formatHostBusy({storageId:metadata.storageId,socketPath:paths.socket}));`;
	t.after(async () => {
		try { const saved = JSON.parse(readFileSync(evidence, "utf8")); process.kill(saved.pid, "SIGKILL"); } catch {}
		await observeOwnedHostExit(metadata);
	});
	const client = await acquireHost(metadata, { runner: "--input-type=module", runnerArgs: ["--eval", source], launchTimeoutMs: 5000 });
	t.after(() => client.close());
	assert.equal(JSON.parse(readFileSync(evidence, "utf8")).calls, 1);
	assert.equal(client.ownedExit, undefined, "busy supplies no owned writer identity");
});

it("reports a real BUSY lease without a verified endpoint as distinct unavailable evidence", { timeout: 10000 }, async t => {
	const root = fixtureRoot(t), metadata = fixtureMetadata(root), paths = hostPaths(metadata);
	mkdirSync(dirname(paths.claim), { recursive: true, mode: 0o700 });
	const held = tryNativeWriterLease(paths.claim);
	assert.equal(held.kind, "held");
	if (held.kind !== "held") throw new Error("The private fixture lease was not acquired");
	t.after(() => held.lease.release());
	const attempted = acquireHost(metadata, launch({ launchTimeoutMs: 3000 }));
	t.after(async () => {
		const client = await attempted.catch(() => undefined);
		if (client) {
			await client.request("close").catch(() => undefined);
			await client.close();
		}
		await observeOwnedHostExit(metadata);
	});
	await assert.rejects(attempted, error => {
		assert.ok(error instanceof HostBusyEndpointUnavailableError);
		assert.equal(error instanceof HostReadinessUnavailableError, false);
		assert.match(error.message, /runner reported BUSY.*no native host endpoint was verified/u);
		assert.doesNotMatch(error.message, /owned runner remains unconfirmed|live owner|will succeed/u);
		return true;
	});
	const exited = observeOwnedHostExit(metadata);
	assert.ok(exited);
	await exited;
	assert.doesNotThrow(() => held.lease.assertNamed(), "the original held descriptor remains valid");
});

it("closing the connection with admitted work does not cancel it", { timeout: 30000 }, async (t) => {
	const root = fixtureRoot(t);
	const statePath = join(root, "state.json");
	const config = fixtureMetadata(root);
	const connection = await openHost(t, root);
	const pending = connection.request("abort");
	await waitForFixtureState(connection, statePath, (state) => (state.hangsStarted ?? 0) >= 1);
	await connection.close();
	await assert.rejects(pending);
	const again = await acquireHost(config, launch());
	track(t, again.pid);
	assert.equal(readFixtureState(statePath).hangsSignaled, undefined, "admitted work received no cancel signal");
	assert.deepEqual(await again.request("timer-list", { alive: true }), { alive: true });
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

it("does not infer a native writer from a diagnostic hostname", { timeout: 30000 }, async (t) => {
	const root = fixtureRoot(t);
	const config = fixtureMetadata(root);
	const paths = hostPaths(config);
	mkdirSync(dirname(paths.claim), { recursive: true });
	writeFileSync(paths.claim, JSON.stringify({ token: "other", pid: process.pid, host: "another-machine", sessionId: config.storageId, cwd: config.cwd, createdAt: new Date().toISOString() }), { mode: 0o600 });
	const original = lstatSync(paths.claim).ino;
	const connection = await acquireHost(config, launch());
	track(t, connection.pid);
	assert.equal(lstatSync(paths.claim).ino, original);
	await connection.request("close").catch(() => undefined);
	assert.ok(connection.ownedExit);
	assert.equal((await connection.ownedExit).failed, false);
	await connection.close();
});

it("keeps a deep agent directory working with a short socket path", { timeout: 30000 }, async (t) => {
	const root = fixtureRoot(t);
	const deepRoot = join(root, "d".repeat(140));
	mkdirSync(deepRoot, { recursive: true });
	const config = fixtureMetadata(deepRoot);
	const connection = await acquireHost(config, launch());
	track(t, connection.pid);
	try {
		assert.ok(Buffer.byteLength(connection.socketPath, "utf8") <= HOST_SOCKET_PATH_LIMIT_BYTES);
		assert.deepEqual(await connection.request("timer-list", "deep"), "deep");
	} finally {
		await connection.request("close").catch(() => undefined);
		await connection.close();
		await connection.ownedExit;
	}
	assert.equal(existsSync(connection.socketPath), false, "owner close removes this fixture's fallback socket");
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
	await waitForConnectionClose(connection);
	const unavailable = events.filter((event) => event.state === "unavailable");
	assert.equal(unavailable.length, 1, "one unavailable signal per listener");
	assert.equal(unavailable[0]?.fresh, false);
	assert.equal(connection.pid, firstPid, "an observation loss never relaunches the host");
	assert.equal(connection.closed, true, "the connection closes for the manager's bounded recovery");
});

it("keeps a task observation live after an owned failed exit and reconnect", { timeout: 10000 }, async (t) => {
	const root = fixtureRoot(t), markers = markerFixture(t, root), config = fixtureMetadata(root);
	const connection = await acquireHost(config, observationLaunch({ env: { DURABLE_TEST_NOTIFY: markers.notifyPath } }));
	track(t, connection.pid); t.after(() => connection.close());
	const observation = await observeFrames(connection, { scope: "tasks", sessionId: config.storageId });
	const firstPid = connection.pid, frames = eventLog<{ fresh: boolean; state?: string }>();
	observation.onFrame((_frame, fresh, state) => frames.push({ fresh, state }));
	const pending = connection.request("snapshot", { sessionId: config.storageId, fixtureHold: true });
	await markers.marker("snapshot-gated");
	process.kill(firstPid, "SIGKILL");
	await pending;
	track(t, connection.pid);
	await frames.waitFor((items) => connection.pid !== firstPid && items.filter((item) => item.fresh && item.state === "live").length >= 2);
	assert.equal(connection.closed, false);
	const baseline = observation.frame.revision;
	const changed = eventLog<number>();
	observation.onFrame((frame, fresh, state) => { if (state === "live" && !fresh && frame?.scope === "tasks") changed.push(frame.revision); });
	await connection.request("submit", { sessionId: config.storageId, message: "after reconnect", requestId: "tasks-reconnected" });
	await changed.waitFor((items) => items.some((revision) => revision > baseline));
	await observation.close();
});

it("marks a refused observation reopen unavailable without closing the recovered connection", { timeout: 10000 }, async (t) => {
	const root = fixtureRoot(t), markers = markerFixture(t, root), config = fixtureMetadata(root);
	const connection = await acquireHost(config, observationLaunch({ env: { DURABLE_TEST_OBSERVATION_REOPEN: "fail", DURABLE_TEST_NOTIFY: markers.notifyPath } }));
	track(t, connection.pid); t.after(() => connection.close());
	const observation = await observeFrames(connection, { scope: "conversation", sessionId: config.storageId });
	const firstPid = connection.pid, states = eventLog<string | undefined>();
	observation.onFrame((_frame, _fresh, state) => states.push(state));
	const pending = connection.request("snapshot", { sessionId: config.storageId, fixtureHold: true });
	await markers.marker("snapshot-gated");
	process.kill(firstPid, "SIGKILL");
	await pending;
	track(t, connection.pid);
	await markers.marker("observation-reopen-refused");
	await states.waitFor((items) => items.includes("unavailable"));
	assert.notEqual(connection.pid, firstPid);
	assert.equal(connection.closed, false);
	const late: Array<string | undefined> = [];
	observation.onFrame((_frame, _fresh, state) => late.push(state));
	assert.deepEqual(late, ["unavailable"]);
	assert.equal(states.filter((state) => state === "unavailable").length, 1);
	await connection.request("status", { sessionId: config.storageId });
	await observation.close();
});

for (const scope of ["tasks", "conversation"] as const) it(`attach-only ${scope} observation never launches after host loss`,  { timeout: 10000 }, async (t) => {
	const root = fixtureRoot(t);
	const markers = markerFixture(t, root);
	const config = fixtureMetadata(root);
	const owner = await acquireHost(config, observationLaunch({ env: { DURABLE_TEST_NOTIFY: markers.notifyPath } }));
	t.after(() => owner.close());
	const connection = await connectHost(config, observationLaunch());
	track(t, connection.pid);
	t.after(() => connection.close());
	const observation = await observeFrames(connection, { scope, sessionId: config.storageId });
	const firstPid = connection.pid;
	let unavailable!: () => void;
	const lost = new Promise<void>((resolve) => { unavailable = resolve; });
	let failures = 0;
	observation.onFrame((frame, fresh, state) => {
		if (state !== "unavailable") return;
		failures += 1;
		assert.equal(frame?.scope, scope);
		assert.equal(fresh, false);
		unavailable();
	});
	const pending = connection.request("snapshot", { sessionId: config.storageId, fixtureHold: true });
	const refused = assert.rejects(pending, /unavailable|closed|connect|disconnected/iu);
	await markers.marker("snapshot-gated");
	process.kill(firstPid, "SIGKILL");
	await refused;
	await lost;
	assert.equal(connection.pid, firstPid);
	assert.equal(connection.closed, true);
	const late: Array<string | undefined> = [];
	observation.onFrame((_frame, _fresh, state) => late.push(state));
	assert.deepEqual(late, ["unavailable"], "a late listener never receives a stale live baseline");
	await assert.rejects(connection.request("status", { sessionId: config.storageId }), /closed/u);
	await observation.close();
	await connection.close();
	assert.equal(failures, 1, "the failed observation receives one unavailable event");
});

it("a successful owner close differs from local transport disposal", async (t) => {
	const peer = await openVersionedHost(fixtureRoot(t), HOST_CONTRACT, {});
	t.after(() => peer.close());
	const local = await connectHost(peer.metadata);
	await local.close();
	assert.equal(local.ownerReleased, false);
	assert.equal(peer.calls.includes("close"), false);
	const owner = await connectHost(peer.metadata);
	await owner.request("close");
	assert.equal(owner.ownerReleased, true);
	await owner.close();
});

it("close during a held observation rebind prevents every late live callback", { timeout: 15000 }, async (t) => {
	const root = fixtureRoot(t), markers = markerFixture(t, root), metadata = fixtureMetadata(root);
	const release = markers.hold("observation-reopen-held");
	t.after(release);
	const connection = await acquireHost(metadata, observationLaunch({ env: { DURABLE_TEST_OBSERVATION_REOPEN: "hold", DURABLE_TEST_NOTIFY: markers.notifyPath } }));
	track(t, connection.pid);
	t.after(() => connection.close());
	const observation = await observeFrames(connection, { scope: "conversation", sessionId: metadata.storageId });
	const states: Array<string | undefined> = [];
	observation.onFrame((_frame, _fresh, state) => states.push(state));
	const pending = connection.request("snapshot", { sessionId: metadata.storageId, fixtureHold: true });
	await markers.marker("snapshot-gated");
	process.kill(connection.pid, "SIGKILL");
	await markers.marker("observation-reopen-held");
	await pending;
	track(t, connection.pid);
	await connection.close();
	const settled = states.slice();
	assert.equal(settled.filter((state) => state === "unavailable").length, 1);
	release();
	await markers.marker("observation-reopen-finished");
	const independent = await connectHost(metadata);
	t.after(() => independent.close());
	await independent.request("status", { sessionId: metadata.storageId });
	assert.deepEqual(states, settled);
	assert.equal(connection.closed, true);
	await observation.close();
	await independent.request("close").catch(() => undefined);
});

function lifecycleRunner(mode: string): string {
	return `
		import { readFileSync, writeFileSync, renameSync } from "node:fs";
		import { join } from "node:path";
		import { runHost } from ${JSON.stringify(new URL("./host-process.ts", import.meta.url).href)};
		import { formatHostReady } from ${JSON.stringify(new URL("./host-protocol.ts", import.meta.url).href)};
		import { publishFixtureMarker } from ${JSON.stringify(new URL("./testdata/durable-runtime/signal.ts", import.meta.url).href)};
		const metadata = JSON.parse(process.argv.at(-1));
		const path = join(metadata.cwd, "lifecycle-state.json");
		let starts = 0; try { starts = JSON.parse(readFileSync(path, "utf8")).starts; } catch {}
		let ready, finish;
		const host = await runHost(() => {
			writeFileSync(path, JSON.stringify({ starts: ++starts }));
			return {
				request: async (method, params) => {
					if (method === "receipts" && params?.fixtureGate === true) {
						await publishFixtureMarker(process.env.DURABLE_TEST_NOTIFY, "waiting");
						return new Promise(resolve => { finish = resolve; });
					}
					if (method === "timer-cancel") finish?.({ done: true });
					return { starts, alive: true };
				}, close: async () => { finish?.({ done: true }); }, isIdle: () => false
			};
		}, { metadata, idleMs: 0, announceReady: value => { ready = value; } });
		if (${JSON.stringify(mode)} !== "recovery" || starts > 1) await publishFixtureMarker(process.env.DURABLE_TEST_NOTIFY, "ready");
		if (${JSON.stringify(mode)} === "connect-failure") renameSync(ready.socketPath, ready.socketPath + ".held");
		if (${JSON.stringify(mode)} === "invalid") process.stdout.write("PI_AGENT_HOST_READY not-json\\n");
		else process.stdout.write(formatHostReady(${JSON.stringify(mode)} === "wrong-path" ? { ...ready, socketPath: ready.socketPath + ".wrong" } : ready));
		if (${JSON.stringify(mode)} === "connect-failure") {
			await publishFixtureMarker(process.env.DURABLE_TEST_NOTIFY, "restore");
			renameSync(ready.socketPath + ".held", ready.socketPath);
			await publishFixtureMarker(process.env.DURABLE_TEST_NOTIFY, "restored");
		}
		if (${JSON.stringify(mode)} === "retire-held") {
			await publishFixtureMarker(process.env.DURABLE_TEST_NOTIFY, "retire");
			await host.close();
			await publishFixtureMarker(process.env.DURABLE_TEST_NOTIFY, "writer-released");
			process.exit(1);
		}
		await host.done;
	`;
}

it("a foreign writer never inherits a retired child's failed-exit evidence", { timeout: 10000 }, async (t) => {
	const root = fixtureRoot(t), markers = markerFixture(t, root), metadata = fixtureMetadata(root);
	const releaseRetire = markers.hold("retire"), releaseExit = markers.hold("writer-released");
	t.after(releaseRetire); t.after(releaseExit);
	const owner = await acquireHost(metadata, { runner: "--input-type=module", runnerArgs: ["--eval", lifecycleRunner("retire-held")], env: { DURABLE_TEST_NOTIFY: markers.notifyPath } });
	const exited = owner.ownedExit;
	assert.ok(exited);
	t.after(async () => { releaseRetire(); releaseExit(); await owner.close(); await exited; });
	await owner.close();
	assert.equal(owner.ownerReleased, false, "local disposal does not report writer release");
	await markers.marker("retire");
	releaseRetire();
	await markers.marker("writer-released");
	const foreign = await runHost(() => ({ request: async () => ({ writer: "foreign" }), close: async () => {}, isIdle: () => false }), { metadata, idleMs: 0, announceReady() {} });
	t.after(() => foreign.close());
	const attached = await acquireHost(metadata, launch());
	t.after(() => attached.close());
	const inherited = attached.ownedExit;
	assert.deepEqual(await attached.request("status"), { writer: "foreign" });
	releaseExit();
	assert.equal((await exited).failed, true, "the retired child exits with failure while the foreign writer remains usable");
	assert.deepEqual(await attached.request("status"), { writer: "foreign" });
	assert.equal(inherited, undefined, "the current foreign endpoint has no owned-child exit source");
});

it("wrong-path readiness never establishes an owned-exit source for attachment", { timeout: 10000 }, async (t) => {
	const root = fixtureRoot(t), markers = markerFixture(t, root), metadata = fixtureMetadata(root);
	const release = markers.hold("ready");
	t.after(release);
	const pending = acquireHost(metadata, { runner: "--input-type=module", runnerArgs: ["--eval", lifecycleRunner("wrong-path")], env: { DURABLE_TEST_NOTIFY: markers.notifyPath } });
	const refused = assert.rejects(pending, /owned runner remains unconfirmed/u);
	await markers.marker("ready");
	release();
	await refused;
	const exited = observeOwnedHostExit(metadata);
	const attached = await connectHost(metadata);
	t.after(async () => { await attached.request("close").catch(() => undefined); await attached.close(); await exited; });
	assert.deepEqual(await attached.request("timer-list"), { starts: 1, alive: true });
	assert.equal(attached.ownedExit, undefined, "a rejected readiness identity is not owned-writer evidence");
});

for (const mode of ["invalid", "wrong-path", "connect-failure", "deadline", "cancel"] as const) it(`${mode} startup observation never kills a resumed runtime`, { timeout: 15000 }, async (t) => {
	const root = fixtureRoot(t), metadata = fixtureMetadata(root), createdAt = Date.now();
	t.after(async () => {
		await fixtureTeardown(root, metadata.agentDir, createdAt, t);
		await observeOwnedHostExit(metadata);
	});
	const markers = markerFixture(t, root);
	const release = markers.hold("ready");
	t.after(release);
	const restore = markers.hold("restore");
	t.after(restore);
	const controller = new AbortController();
	const pending = acquireHost(metadata, { runner: "--input-type=module", runnerArgs: ["--eval", lifecycleRunner(mode)], launchTimeoutMs: mode === "deadline" ? 3000 : 10000, signal: controller.signal, env: { DURABLE_TEST_NOTIFY: markers.notifyPath } });
	const rejected = assert.rejects(pending);
	await markers.marker("ready");
	if (mode === "cancel") controller.abort(new Error("withdrawn"));
	if (mode === "invalid" || mode === "wrong-path" || mode === "connect-failure") release();
	await rejected;
	release();
	if (mode === "connect-failure") { restore(); await markers.marker("restored"); }
	const surviving = await connectHost(metadata);
	track(t, surviving.pid);
	t.after(() => surviving.close());
	assert.deepEqual(await surviving.request("timer-list"), { starts: 1, alive: true });
	await surviving.request("close").catch(() => undefined);
});

it("settles every pending call when the replacement link closes during old-link disposal", { timeout: 10000 }, async t => {
	const metadata = fixtureMetadata(fixtureRoot(t));
	const requests = eventLog<string>();
	let releaseRequests = () => {}, releaseDisposal = () => {}, enteredDisposal = () => {};
	const heldRequests = new Promise<void>(resolve => { releaseRequests = resolve; });
	const heldDisposal = new Promise<void>(resolve => { releaseDisposal = resolve; });
	const disposalEntered = new Promise<void>(resolve => { enteredDisposal = resolve; });
	const host = await runHost(() => ({
		request: async method => { requests.push(method); await heldRequests; return {}; },
		close: async () => {}, isIdle: () => false,
	}), { metadata, idleMs: 0, announceReady() {} });
	const connection = await connectHost(metadata);
	// Hold only cleanup of the original transport, not connection recovery itself.
	const transport = () => (connection as unknown as { client: TransportClient }).client;
	const first = transport(), disposeFirst = first.dispose.bind(first);
	first.dispose = async () => { enteredDisposal(); await heldDisposal; await disposeFirst(); };
	let closed = 0;
	connection.onClose(() => { closed++; });
	const unavailable = (error: unknown): boolean => error instanceof HostError && error.code === "unavailable";
	try {
		const safe = assert.rejects(connection.request("status", {}, { signal: AbortSignal.timeout(2000) }), unavailable);
		const unsafe = assert.rejects(connection.request("configure", {}, { signal: AbortSignal.timeout(2000) }));
		await requests.waitFor(values => values.includes("status") && values.includes("configure"));
		const disconnected = disposeFirst();
		await disposalEntered;
		const replacement = transport();
		assert.notEqual(replacement, first, "recovery installs the replacement before old-link disposal finishes");
		await replacement.dispose();
		releaseDisposal();
		await Promise.all([safe, unsafe, disconnected]);
		assert.equal(connection.closed, true);
		assert.equal(closed, 1, "the manager receives final connection loss once");
		assert.equal(requests.filter(method => method === "configure").length, 1, "the unsafe mutation is never replayed");
	} finally {
		releaseDisposal(); releaseRequests();
		await connection.close();
		await host.close();
	}
});

it("close during held recovery never installs a late link or stops its independent host", { timeout: 15000 }, async (t) => {
	const root = fixtureRoot(t), markers = markerFixture(t, root), metadata = fixtureMetadata(root);
	const release = markers.hold("ready");
	t.after(release);
	const connection = await acquireHost(metadata, { runner: "--input-type=module", runnerArgs: ["--eval", lifecycleRunner("recovery")], launchTimeoutMs: 10000, env: { DURABLE_TEST_NOTIFY: markers.notifyPath } });
	track(t, connection.pid);
	t.after(() => connection.close());
	const pending = connection.request("receipts", { fixtureGate: true });
	const rejected = assert.rejects(pending);
	await markers.marker("waiting");
	process.kill(connection.pid, "SIGKILL");
	await markers.marker("ready");
	await connection.close();
	await rejected;
	release();
	const independent = await connectHost(metadata);
	track(t, independent.pid);
	t.after(() => independent.close());
	assert.deepEqual(await independent.request("timer-list"), { starts: 2, alive: true });
	assert.equal(connection.closed, true);
	await assert.rejects(connection.request("status"), /closed/u);
	await independent.request("close").catch(() => undefined);
});

it("a clean owned exit does not automatically resume a pending read", { timeout: 10000 }, async (t) => {
	const root = fixtureRoot(t), markers = markerFixture(t, root), metadata = fixtureMetadata(root);
	const connection = await acquireHost(metadata, observationLaunch({ env: { DURABLE_TEST_RETIRE: "clean", DURABLE_TEST_NOTIFY: markers.notifyPath } }));
	track(t, connection.pid);
	t.after(() => connection.close());
	const firstPid = connection.pid;
	const pending = connection.request("snapshot", { sessionId: metadata.storageId, fixtureHold: true });
	const rejected = assert.rejects(pending);
	await markers.marker("snapshot-gated");
	await rejected;
	await new Promise<void>((resolve) => { connection.onClose(resolve); });
	assert.equal(connection.closed, true);
	assert.equal(connection.pid, firstPid);
	assert.ok(connection.ownedExit);
	assert.equal((await connection.ownedExit).failed, false);
});
