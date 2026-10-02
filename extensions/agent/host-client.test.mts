import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { it } from "node:test";
import { fileURLToPath } from "node:url";
import { HOST_SOCKET_PATH_LIMIT_BYTES, hostPaths } from "./host-protocol.ts";
import { acquireHost, connectHost, snapshotHost, type HostConnection, type HostLaunchOptions } from "./host-client.ts";
import { fixtureMetadata, readFixtureState, waitUntil, writeFixtureState } from "./host-fixture.mts";

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
