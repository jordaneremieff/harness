import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { it } from "node:test";
import { isChordError } from "@earendil-works/chord";
import { connectTransport, type TransportClient, type TransportRequest } from "../../transport/index.ts";
import { observeClaim } from "./claims.ts";
import { HostError, hostPaths, parseHostMetadata, type HostMetadata } from "./host-protocol.ts";
import { HostClaimRefusedError, resolveIdleMs, runHost, type HostProcess, type HostRuntime } from "./host-process.ts";
import { HOST_CONTRACT } from "./version-contract.ts";
import { eventLog } from "./host-fixture.mts";

function noop(): void {}

function fixtureRoot(t: { after(fn: () => void): void }): string {
	const root = mkdtempSync(join(tmpdir(), "host-process-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	return root;
}

function metadata(root: string): HostMetadata {
	return parseHostMetadata({
		storageId: randomUUID(),
		cwd: root,
		agentDir: join(root, "agent"),
		packageDir: join(root, "package"),
		storagePath: join(root, "storage.sqlite"),
		model: { provider: "fixture", modelId: "model" },
		thinkingLevel: "off",
	});
}

function echoRuntime(): HostRuntime {
	return {
		request: async (method, params) => {
			if (method === "configure") throw new HostError("not allowed", "invalid");
			return { method, params };
		},
		close: async () => {},
		isIdle: () => true,
	};
}

async function connectClient(config: HostMetadata): Promise<TransportClient> {
	return connectTransport({ serverId: hostPaths(config).serverId, path: hostPaths(config).socket });
}

function transportRequest(method: string, params?: unknown, requestId = randomUUID()): TransportRequest {
	return { method, ...(params === undefined ? {} : { params }), requestId, contract: HOST_CONTRACT.operations[method] };
}

function call(client: TransportClient, _config: HostMetadata, method: string, params?: unknown, signal?: AbortSignal): Promise<unknown> {
	return client.request(transportRequest(method, params), signal);
}

async function startHost(root: string, idleMs = 0, runtime: () => HostRuntime = echoRuntime): Promise<{ host: HostProcess; metadata: HostMetadata }> {
	const config = metadata(root);
	const host = await runHost(runtime, { metadata: config, idleMs, announceReady: noop });
	return { host, metadata: config };
}

async function deadPid(): Promise<number> {
	const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
	const pid = child.pid;
	assert.ok(pid, "the probe process has a pid");
	await once(child, "exit");
	return pid;
}

it("cancels a refused release without closing observations and resumes idle retirement", { timeout: 15000 }, async (t) => {
	const root = fixtureRoot(t), checked = eventLog<void>(), checks = eventLog<() => void>();
	let releaseListener: ((requested: boolean) => void) | undefined;
	let attempts = 0, closedTokens = 0;
	const runtime: HostRuntime = {
		request: async method => {
			if (method === "observe-open") return { token: randomUUID() };
			if (method === "observe-close") { closedTokens++; return {}; }
			releaseListener?.(true); return { retiring: true, blockers: [] };
		},
		isIdle: () => true, close: async () => {},
		onReleaseRequested: listener => { releaseListener = listener; return () => { releaseListener = undefined; }; },
		tryRetire: async seal => { attempts++; if (attempts === 1) { checked.push(undefined); return false; } return seal(); },
	};
	const config = metadata(root);
	const host = await runHost(() => runtime, { metadata: config, idleMs: 3600000, announceReady: noop, scheduleIdleCheck: check => { checks.push(check); return () => {}; } });
	t.after(() => host.close());
	const client = await connectClient(config); t.after(() => client.dispose());
	const first = await call(client, config, "observe-open") as { token: string };
	assert.deepEqual(await call(client, config, "status"), { retiring: true, blockers: [] });
	await checked.waitForCount(1, 5000);
	await new Promise<void>(setImmediate);
	assert.equal(closedTokens, 0, "a refused seal preserves existing observations");
	const second = await call(client, config, "observe-open") as { token: string };
	await call(client, config, "observe-close", { token: first.token });
	await call(client, config, "observe-close", { token: second.token });
	checks[checks.length - 1]();
	await host.done;
	assert.equal(attempts, 2);
});

it("serves a request and rejects a client with the wrong serverId", { timeout: 15000 }, async (t) => {
	const root = fixtureRoot(t);
	const { host, metadata: config } = await startHost(root);
	t.after(() => host.close().catch(() => {}));
	const client = await connectClient(config);
	assert.deepEqual(await call(client, config, "timer-list", { value: 1 }), { method: "timer-list", params: { value: 1 } });
	await client.dispose();
	await assert.rejects(connectTransport({ serverId: randomUUID(), path: hostPaths(config).socket }));
});

it("refuses absent or mismatched caller contracts before any runtime effect", async (t) => {
	const root = fixtureRoot(t);
	let effects = 0;
	const { host, metadata: config } = await startHost(root, 0, () => ({ request: async () => { effects++; return {}; }, close: async () => {}, isIdle: () => true }));
	t.after(() => host.close());
	const client = await connectClient(config);
	t.after(() => client.dispose());
	for (const contract of [null, { ...HOST_CONTRACT.operations.submit, request: "submit/2.0.0" }, { ...HOST_CONTRACT.operations.submit, response: "changed" }]) {
		await assert.rejects(client.request({ method: "submit", params: { message: "task" }, requestId: randomUUID(), contract }), /no operation was admitted/u);
	}
	assert.equal(effects, 0);
	await call(client, config, "submit", { message: "safe" });
	assert.equal(effects, 1);
});

it("preserves a runtime error message", { timeout: 15000 }, async (t) => {
	const root = fixtureRoot(t);
	const { host, metadata: config } = await startHost(root);
	t.after(() => host.close().catch(() => {}));
	const client = await connectClient(config);
	await assert.rejects(call(client, config, "configure"), (error: unknown) => isChordError(error, "invalid") && error.message === "invalid/invalid: not allowed");
	await client.dispose();
});

it("returns a failed runtime response before shared shutdown releases the claim", { timeout: 15000 }, async (t) => {
	const root = fixtureRoot(t);
	const config = metadata(root);
	let failed = false;
	let closed = 0;
	const host = await runHost(() => ({
		request: async (method, params) => {
			if (method !== "command") return { method, params };
			failed = true;
			throw new Error("reload failed");
		},
		get shutdownRequired() { return failed; },
		isIdle: () => false,
		close: async () => { closed++; },
	}), { metadata: config, idleMs: 0, announceReady: noop });
	t.after(() => host.close().catch(() => {}));
	const client = await connectClient(config);
	try {
		await assert.rejects(call(client, config, "command", { name: "reload" }), /reload failed/u);
		await host.done;
		await host.close();
		assert.equal(closed, 1, "fatal and explicit close share one shutdown");
		assert.equal(observeClaim(hostPaths(config).claim, hostPaths(config).identity).kind, "absent");
	} finally { await client.dispose().catch(() => {}); }
	const replacement = await runHost(echoRuntime, { metadata: config, idleMs: 0, announceReady: noop });
	const next = await connectClient(config);
	try { assert.deepEqual(await call(next, config, "status", {}), { method: "status", params: {} }); }
	finally { await next.dispose().catch(() => {}); await replacement.close(); }
});

it("refuses a second host while the claim is live without creating its runtime", { timeout: 15000 }, async (t) => {
	const root = fixtureRoot(t);
	const { host, metadata: config } = await startHost(root);
	let created = false;
	await assert.rejects(
		runHost(() => {
			created = true;
			return echoRuntime();
		}, { metadata: config, idleMs: 0, announceReady: noop }),
		(error: unknown) => error instanceof HostClaimRefusedError && error.observation === "live",
	);
	assert.equal(created, false, "the losing factory never ran");
	await host.close();
});

it("replaces a dead claim and records the new owner", { timeout: 15000 }, async (t) => {
	const root = fixtureRoot(t);
	const config = metadata(root);
	const paths = hostPaths(config);
	mkdirSync(dirname(paths.claim), { recursive: true, mode: 0o700 });
	writeFileSync(paths.claim, JSON.stringify({ token: "stale", pid: await deadPid(), host: hostname(), sessionId: config.storageId, cwd: config.cwd, createdAt: new Date().toISOString() }), { mode: 0o600 });
	const host = await runHost(echoRuntime, { metadata: config, idleMs: 0, announceReady: noop });
	const owner = JSON.parse(readFileSync(paths.claim, "utf8")) as { token: string };
	assert.notEqual(owner.token, "stale");
	assert.equal(observeClaim(paths.claim, paths.identity).kind, "live");
	await host.close();
});

it("retires after the idle window and releases the claim", { timeout: 15000 }, async (t) => {
	const root = fixtureRoot(t);
	const { host, metadata: config } = await startHost(root, 50);
	await host.done;
	assert.equal(observeClaim(hostPaths(config).claim, hostPaths(config).identity).kind, "absent");
});

it("waits for runtime idle before retiring", { timeout: 15000 }, async (t) => {
	const root = fixtureRoot(t);
	const config = metadata(root);
	let idle = false;
	const runtime: HostRuntime = { request: async () => ({}), close: async () => {}, isIdle: () => idle };
	const checks = eventLog<() => void>();
	const host = await runHost(() => runtime, { metadata: config, idleMs: 40, announceReady: noop, scheduleIdleCheck: (check) => { checks.push(check); return noop; } });
	t.after(() => host.close());
	await checks.waitForCount(1);
	checks[0]();
	assert.equal(observeClaim(hostPaths(config).claim, hostPaths(config).identity).kind, "live", "busy host stays");
	await checks.waitForCount(2);
	idle = true;
	checks[1]();
	await host.done;
	assert.equal(observeClaim(hostPaths(config).claim, hostPaths(config).identity).kind, "absent");
});

it("cancels a wait on caller abort and on client disconnect", { timeout: 15000 }, async (t) => {
	const root = fixtureRoot(t);
	let started = 0;
	let aborted = 0;
	const starts = eventLog<number>();
	const aborts = eventLog<number>();
	const runtime: HostRuntime = {
		request: async (method, _params, _requestId, signal) => {
			if (method !== "receipts") return { method };
			started += 1;
			starts.push(started);
			return new Promise((_resolve, reject) => {
				signal?.addEventListener("abort", () => {
					aborted += 1;
					aborts.push(aborted);
					reject(signal.reason ?? new Error("aborted"));
				}, { once: true });
			});
		},
		close: async () => {},
		isIdle: () => true,
	};
	const { host, metadata: config } = await startHost(root, 0, () => runtime);
	t.after(() => host.close().catch(() => {}));

	const first = await connectClient(config);
	const controller = new AbortController();
	const pending = call(first, config, "receipts", { wait: true }, controller.signal);
	await starts.waitForCount(1);
	assert.equal(aborted, 0, "the producer stays pending until cancellation");
	controller.abort();
	await assert.rejects(pending, (error: unknown) => error instanceof Error);
	await aborts.waitForCount(1);
	await first.dispose();

	const second = await connectClient(config);
	const pendingDisconnect = call(second, config, "receipts", { wait: true });
	await starts.waitForCount(2);
	assert.equal(aborted, 1, "the second producer stays pending until disconnect");
	await second.dispose();
	await assert.rejects(pendingDisconnect, (error: unknown) => error instanceof Error);
	await aborts.waitForCount(2);
});

it("publishes changed state to a public subscription", { timeout: 15000 }, async (t) => {
	const root = fixtureRoot(t);
	const listeners = new Set<() => void>();
	const runtime: HostRuntime = {
		request: async (method) => {
			if (method === "report") {
				for (const listener of [...listeners]) listener();
				return { touched: true };
			}
			return { method };
		},
		close: async () => {},
		isIdle: () => true,
		onChange: (listener) => {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
	};
	const { host, metadata: config } = await startHost(root, 0, () => runtime);
	t.after(() => host.close().catch(() => {}));
	const client = await connectClient(config);
	const updates = eventLog<unknown>();
	const subscription = await client.subscribe("changes", undefined, (update) => {
		updates.push(update);
	});
	const initial = subscription.value as { revision: number };
	assert.equal(typeof initial.revision, "number");
	await call(client, config, "report");
	await updates.waitFor((values) => values.some((value) => (value as { revision: number }).revision > initial.revision));
	await subscription.dispose();
	await client.dispose();
});

it("publishes live observation deltas without a catalog change", { timeout: 15000 }, async (t) => {
	const listeners = new Set<() => void>();
	let revision = 1;
	let changeReads = 0;
	const root = fixtureRoot(t);
	const frame = () => ({scope: "conversation", storageId: config.storageId, conversationId: 1, revision,
		entries: [], live: [{text: "partial reasoning"}], status: {busy: true}});
	const runtime: HostRuntime = {
		request: async (method) => method === "observe-open" ? {token: "live-token", frame: frame()} : method === "observe-frame" ? frame() : {closed: true},
		close: async () => {}, isIdle: () => true,
		onChange: () => { changeReads++; return () => {}; },
		onObservationChange: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
	};
	const {host, metadata: config} = await startHost(root, 0, () => runtime);
	t.after(() => host.close().catch(() => {}));
	const client = await connectClient(config);
	t.after(() => client.dispose());
	await call(client, config, "observe-open", {token: "live-token", scope: "conversation", sessionId: config.storageId});
	const updates = eventLog<unknown>();
	const subscription = await client.subscribe("observation", "live-token", update => { updates.push(update); });
	assert.equal((subscription.value as {revision: number}).revision, 1);
	revision = 2;
	for (const listener of listeners) listener();
	await updates.waitFor(values => values.some(value => (value as {revision: number}).revision === 2));
	assert.equal(changeReads, 1, "only idle activity uses the catalog-change fallback");
	await subscription.dispose();
	await host.close();
	assert.equal(listeners.size, 0, "closing the host releases the native observation listener");
});

it("parses the idle window with the configured bounds", (t) => {
	const directory = fixtureRoot(t);
	assert.equal(resolveIdleMs(undefined, {}, directory), 5 * 60_000);
	assert.equal(resolveIdleMs(undefined, { PI_AGENT_IDLE_MINUTES: "0.5" }, directory), 30_000);
	assert.equal(resolveIdleMs(undefined, { PI_AGENT_IDLE_MINUTES: "0" }, directory), 0);
	assert.equal(resolveIdleMs(1234, { PI_AGENT_IDLE_MINUTES: "1" }, directory), 1234);
	for (const value of ["", "abc", "-1", "40000", "NaN"]) {
		assert.equal(resolveIdleMs(undefined, { PI_AGENT_IDLE_MINUTES: value }, directory), 5 * 60_000, value);
	}
	assert.throws(() => resolveIdleMs(-1, {}), /idleMs/u);
	assert.throws(() => resolveIdleMs(Number.POSITIVE_INFINITY, {}), /idleMs/u);
});

it("keeps a deep agent directory working with a short socket path", { timeout: 15000 }, async (t) => {
	const root = fixtureRoot(t);
	const deepRoot = join(root, "d".repeat(160));
	const config = parseHostMetadata({ ...metadata(root), agentDir: join(deepRoot, "agent") });
	const host = await runHost(echoRuntime, { metadata: config, idleMs: 0, announceReady: noop });
	t.after(() => host.close().catch(() => {}));
	assert.ok(Buffer.byteLength(host.socketPath, "utf8") <= 100);
	const client = await connectClient(config);
	assert.deepEqual(await call(client, config, "timer-list", "deep"), { method: "timer-list", params: "deep" });
	await client.dispose();
});
