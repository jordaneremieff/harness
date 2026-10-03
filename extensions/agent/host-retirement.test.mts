import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { Client } from "@earendil-works/pi-client";
import { createUnixTransportFactory } from "@earendil-works/pi-client/unix";
import { connectHost, type HostConnection } from "./host-client.ts";
import { eventLog, fixtureMetadata } from "./host-fixture.mts";
import { HOST_CHANGE_SERVICE_ID, HOST_SERVICE_ID, hostPaths } from "./host-protocol.ts";
import { runHost, type HostRuntime } from "./host-process.ts";
import { HOST_CONTRACT } from "./version-contract.ts";
import type { JsonValue } from "@earendil-works/chord";

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => { resolve = done; });
	return { promise, resolve };
}

async function fixture(t: { after(fn: () => void | Promise<void>): void }, runtime: HostRuntime, idleMs = 10) {
	const root = mkdtempSync(join(tmpdir(), "host-retirement-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const metadata = fixtureMetadata(root);
	const checks = eventLog<{ fire(): void; cancelled: boolean }>();
	const host = await runHost(() => runtime, { metadata, idleMs, announceReady: () => {}, scheduleIdleCheck: (fire) => {
		const entry = { fire, cancelled: false };
		checks.push(entry);
		return () => { entry.cancelled = true; };
	} });
	t.after(() => host.close().catch(() => {}));
	return { metadata, host, checks };
}

it("retires with passive clients and change subscriptions without cancelling their idle window", { timeout: 3000 }, async (t) => {
	const f = await fixture(t, { request: async () => ({}), isIdle: () => true, close: async () => {} });
	const clients = await Promise.all([connectHost(f.metadata, { retryAttempts: 0 }), connectHost(f.metadata, { retryAttempts: 0 })]);
	for (const client of clients) t.after(() => client.close());
	await Promise.all(clients.map((client) => { assert.ok(client.subscribeChanges); return client.subscribeChanges(() => {}); }));
	assert.equal(f.checks[0].cancelled, false, "passive attachment does not reset the idle interval");
	const lost = clients.map((client) => new Promise<void>((resolve) => client.onClose(resolve)));
	f.checks[f.checks.length - 1].fire();
	await f.host.done;
	await Promise.all(lost);
	assert.equal(existsSync(hostPaths(f.metadata).claim), false);
	assert.equal(existsSync(hostPaths(f.metadata).socket), false);
	assert.ok(clients.every((client) => client.closed));
});

it("retires both hosts in a passive peer connection cycle", { timeout: 3000 }, async (t) => {
	let toFirst: HostConnection | undefined;
	let toSecond: HostConnection | undefined;
	const first = await fixture(t, { request: async () => ({}), isIdle: () => true, close: async () => { await toSecond?.close(); } });
	const second = await fixture(t, { request: async () => ({}), isIdle: () => true, close: async () => { await toFirst?.close(); } });
	toFirst = await connectHost(first.metadata, { retryAttempts: 0 });
	toSecond = await connectHost(second.metadata, { retryAttempts: 0 });
	t.after(() => toFirst?.close());
	t.after(() => toSecond?.close());
	const lost = [toFirst, toSecond].map((client) => new Promise<void>((resolve) => client.onClose(resolve)));
	first.checks[first.checks.length - 1].fire();
	second.checks[second.checks.length - 1].fire();
	await Promise.all([first.host.done, second.host.done, ...lost]);
	assert.ok(toFirst.closed && toSecond.closed);
});

it("keeps an in-flight read across an idle check and starts a full interval after it", { timeout: 3000 }, async (t) => {
	const started = deferred();
	const release = deferred();
	t.after(release.resolve);
	let closed = false;
	const f = await fixture(t, { request: async () => { started.resolve(); await release.promise; return { read: true }; }, isIdle: () => true, close: async () => { closed = true; } });
	const client = await connectHost(f.metadata, { retryAttempts: 0 });
	t.after(() => client.close());
	const reading = client.request("status");
	await started.promise;
	f.checks[f.checks.length - 1].fire();
	assert.equal(closed, false);
	release.resolve();
	assert.deepEqual(await reading, { read: true });
	f.checks[f.checks.length - 1].fire();
	await f.host.done;
});

it("protects open observation tokens before subscription and releases them on explicit close or disconnect", { timeout: 3000 }, async (t) => {
	let counter = 0;
	const tokens = new Set<string>();
	const f = await fixture(t, { request: async (method, params) => {
		if (method === "observe-open") { const token = `token-${++counter}`; tokens.add(token); return { token }; }
		if (method === "observe-close") tokens.delete((params as { token: string }).token);
		return {};
	}, isIdle: () => true, close: async () => { assert.equal(tokens.size, 0); } });
	const client = await connectHost(f.metadata, { retryAttempts: 0 });
	t.after(() => client.close());
	const first = await client.request("observe-open", { scope: "tasks" }) as { token: string };
	await client.request("observe-open", { scope: "tasks" });
	f.checks[f.checks.length - 1].fire();
	assert.equal(existsSync(hostPaths(f.metadata).claim), true);
	await client.request("observe-close", first);
	f.checks[f.checks.length - 1].fire();
	assert.equal(existsSync(hostPaths(f.metadata).claim), true, "one remaining token pins the host");
	const scheduled = f.checks.length;
	await client.close();
	await f.checks.waitForCount(scheduled + 1);
	f.checks[f.checks.length - 1].fire();
	await f.host.done;
});

it("releases a token after observation subscription setup fails", { timeout: 3000 }, async (t) => {
	const f = await fixture(t, { request: async (method) => method === "observe-open" ? { token: "bad-frame" } : {}, isIdle: () => true, close: async () => {} });
	const paths = hostPaths(f.metadata);
	const client = await Client.connect({ serverId: paths.serverId, transportFactory: createUnixTransportFactory({ path: paths.socket }) });
	t.after(() => client.dispose());
	await client.request({ serverId: paths.serverId }, { serviceId: HOST_SERVICE_ID, member: "observe-open", args: [{ scope: "tasks" }, "open", HOST_CONTRACT.operations["observe-open"] as unknown as JsonValue] });
	await assert.rejects(client.subscribeService({ serverId: paths.serverId }, "pi.agent.host.observe:bad-frame", "singleton", () => {}));
	// A normal change subscription is not a conversation or task observation.
	await client.subscribeService({ serverId: paths.serverId }, HOST_CHANGE_SERVICE_ID, "singleton", () => {});
	f.checks[f.checks.length - 1].fire();
	await f.host.done;
});

it("revalidates completed requests across an asynchronous idle check", { timeout: 3000 }, async (t) => {
	const checking = deferred();
	const release = deferred();
	t.after(release.resolve);
	let closed = false;
	const f = await fixture(t, { request: async () => ({}), isIdle: () => true,
		tryRetire: async (seal) => { checking.resolve(); await release.promise; return seal(); },
		close: async () => { closed = true; } });
	const client = await connectHost(f.metadata, { retryAttempts: 0 });
	t.after(() => client.close());
	f.checks[f.checks.length - 1].fire();
	await checking.promise;
	await client.request("status");
	const count = f.checks.length;
	release.resolve();
	await f.checks.waitForCount(count + 1);
	assert.equal(closed, false, "a completed request still invalidates the old idle generation");
	f.checks[f.checks.length - 1].fire();
	await f.host.done;
});

it("cleans an observation opened after its attachment disconnects", { timeout: 3000 }, async (t) => {
	const opening = deferred();
	const release = deferred();
	t.after(release.resolve);
	let released = false;
	const f = await fixture(t, { request: async (method) => {
		if (method === "observe-open") { opening.resolve(); await release.promise; return { token: "late-token" }; }
		if (method === "observe-close") released = true;
		return {};
	}, isIdle: () => true, close: async () => { assert.equal(released, true); } });
	const client = await connectHost(f.metadata, { retryAttempts: 0 });
	const pending = client.request("observe-open", { scope: "tasks" });
	const failed = assert.rejects(pending);
	await opening.promise;
	await client.close();
	await failed;
	const count = f.checks.length;
	release.resolve();
	await f.checks.waitForCount(count + 1);
	f.checks[f.checks.length - 1].fire();
	await f.host.done;
});

for (const boundary of ["observe-open", "observe-frame"] as const) it(`releases an observation aborted during ${boundary} setup`, { timeout: 3000 }, async (t) => {
	const entered = deferred();
	const release = deferred();
	t.after(release.resolve);
	const tokens = new Set<string>();
	const frame = { scope: "tasks", storageId: "fixture", revision: 1, observedAt: new Date().toISOString(), tasks: [], labels: [], coverage: { complete: true, live: true } };
	const f = await fixture(t, { request: async (method, params) => {
		const token = (params as { token?: string } | undefined)?.token;
		if (method === "observe-open" && token) tokens.add(token);
		if (method === boundary) { entered.resolve(); await release.promise; }
		if (method === "observe-close" && token) tokens.delete(token);
		if (method === "observe-frame") return frame;
		return { token, frame };
	}, isIdle: () => true, close: async () => { assert.equal(tokens.size, 0); } });
	const client = await connectHost(f.metadata, { retryAttempts: 0 });
	t.after(() => client.close());
	assert.ok(client.observe);
	const controller = new AbortController();
	const opening = client.observe({ scope: "tasks", sessionId: f.metadata.storageId }, { signal: controller.signal });
	await entered.promise;
	const count = f.checks.length;
	controller.abort();
	release.resolve();
	await assert.rejects(opening, /abort/u);
	await f.checks.waitForCount(count + 1);
	f.checks[f.checks.length - 1].fire();
	await f.host.done;
});

it("marks a failed live frame unavailable and releases its token without closing the client", { timeout: 3000 }, async (t) => {
	let fail = false;
	const listeners = new Set<() => void>();
	const frame = { scope: "tasks", storageId: "fixture", revision: 1, observedAt: new Date().toISOString(), tasks: [], labels: [], coverage: { complete: true, live: true } };
	const f = await fixture(t, { request: async (method, params) => {
		if (method === "observe-frame" && fail) throw new Error("observation source closed");
		if (method === "observe-frame") return frame;
		if (method === "observe-open") return { token: (params as { token: string }).token, frame };
		return {};
	}, onChange: (listener) => { listeners.add(listener); return () => listeners.delete(listener); }, isIdle: () => true, close: async () => {} });
	const client = await connectHost(f.metadata, { retryAttempts: 0 });
	t.after(() => client.close());
	assert.ok(client.observe);
	const observation = await client.observe({ scope: "tasks", sessionId: f.metadata.storageId });
	const unavailable = deferred();
	observation.onFrame((_frame, _fresh, state) => { if (state === "unavailable") unavailable.resolve(); });
	fail = true;
	for (const listener of listeners) listener();
	await unavailable.promise;
	assert.equal(client.closed, false);
	await client.request("status");
	f.checks[f.checks.length - 1].fire();
	await f.host.done;
});

it("leaves retirement disabled at zero even with passive clients", async (t) => {
	const f = await fixture(t, { request: async () => ({}), isIdle: () => true, close: async () => {} }, 0);
	const client = await connectHost(f.metadata, { retryAttempts: 0 });
	t.after(() => client.close());
	await client.request("status");
	assert.equal(f.checks.length, 0);
});
