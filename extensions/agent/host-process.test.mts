import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { hostname, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { it } from "node:test";
import { observeClaim } from "./claims.ts";
import {
	HOST_PROTOCOL_VERSION,
	HostError,
	HostFrameDecoder,
	encodeHostFrame,
	hostPaths,
	parseHostMetadata,
	parseHostServerMessage,
	type HostClientMessage,
	type HostMetadata,
	type HostServerMessage,
} from "./host-protocol.ts";
import { HostClaimRefusedError, resolveIdleMs, runHost, type HostProcess, type HostRuntime } from "./host-process.ts";

function noop(): void {}

function fixtureRoot(t: { after(fn: () => void): void }): string {
	const root = mkdtempSync(join(tmpdir(), "host-process-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	return root;
}

function metadata(root: string): HostMetadata {
	return parseHostMetadata({
		storageId: "storage-1",
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
		request: async (method, params) => ({ method, params }),
		close: async () => {},
		isIdle: () => true,
	};
}

class RawClient {
	private readonly decoder = new HostFrameDecoder();
	private readonly messages: HostServerMessage[] = [];
	private readonly waiters: Array<{ resolve: (message: HostServerMessage) => void; reject: (error: Error) => void }> = [];
	private failure: Error | undefined;
	readonly socket: Socket;

	constructor(socket: Socket) {
		this.socket = socket;
		socket.on("data", (chunk: Buffer) => {
			let parsed: HostServerMessage[];
			try {
				parsed = this.decoder.push(chunk).map((raw) => parseHostServerMessage(raw));
			} catch (error) {
				this.fail(error instanceof Error ? error : new Error(String(error)));
				return;
			}
			for (const message of parsed) {
				const waiter = this.waiters.shift();
				if (waiter) waiter.resolve(message);
				else this.messages.push(message);
			}
		});
		socket.on("error", () => {});
		socket.on("close", () => this.fail(new Error("durable host closed the connection")));
	}

	static connect(path: string): Promise<RawClient> {
		return new Promise((resolveConnect, rejectConnect) => {
			const socket = connect(path);
			const client = new RawClient(socket);
			socket.once("connect", () => resolveConnect(client));
			socket.once("error", rejectConnect);
		});
	}

	send(message: HostClientMessage): void {
		this.socket.write(encodeHostFrame(message));
	}

	next(): Promise<HostServerMessage> {
		const message = this.messages.shift();
		if (message) return Promise.resolve(message);
		if (this.failure) return Promise.reject(this.failure);
		return new Promise((resolveNext, rejectNext) => this.waiters.push({ resolve: resolveNext, reject: rejectNext }));
	}

	destroy(): void {
		this.socket.destroy();
	}

	private fail(error: Error): void {
		if (this.failure) return;
		this.failure = error;
		for (const waiter of this.waiters.splice(0)) waiter.reject(error);
	}
}

async function deadPid(): Promise<number> {
	const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
	const pid = child.pid;
	assert.ok(pid, "the probe process has a pid");
	await once(child, "exit");
	return pid;
}

/** Wait for a test condition without a fixed sleep. */
async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error("test condition was not reached before its deadline");
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

async function startHost(root: string, idleMs = 0): Promise<{ host: HostProcess; metadata: HostMetadata }> {
	const config = metadata(root);
	const host = await runHost(echoRuntime, { metadata: config, idleMs, announceReady: noop });
	return { host, metadata: config };
}

it("serves an authenticated request and closes cleanly", { timeout: 15000 }, async (t) => {
	const root = fixtureRoot(t);
	const { host, metadata: config } = await startHost(root);
	const paths = hostPaths(config);
	const endpoint = JSON.parse(readFileSync(paths.endpoint, "utf8")) as { token: string };

	const rejected = await RawClient.connect(paths.socket);
	rejected.send({ kind: "hello", version: HOST_PROTOCOL_VERSION, token: "wrong-token", metadata: config });
	await assert.rejects(rejected.next());

	const client = await RawClient.connect(paths.socket);
	client.send({ kind: "hello", version: HOST_PROTOCOL_VERSION, token: endpoint.token, metadata: config });
	assert.equal((await client.next()).kind, "welcome");
	client.send({ kind: "request", id: "a", method: "echo", params: { value: 1 } });
	assert.deepEqual(await client.next(), { kind: "response", id: "a", ok: true, result: { method: "echo", params: { value: 1 } } });
	client.destroy();

	await host.close();
	await host.done;
	assert.equal(existsSync(paths.claim), false, "claim released");
	assert.equal(existsSync(paths.socket), false, "socket removed");
	assert.equal(existsSync(paths.endpoint), false, "endpoint removed");
});

it("closes with an attached client without waiting for it", { timeout: 15000 }, async (t) => {
	const root = fixtureRoot(t);
	const { host, metadata: config } = await startHost(root);
	const paths = hostPaths(config);
	const token = (JSON.parse(readFileSync(paths.endpoint, "utf8")) as { token: string }).token;
	const client = await RawClient.connect(paths.socket);
	client.send({ kind: "hello", version: HOST_PROTOCOL_VERSION, token, metadata: config });
	assert.equal((await client.next()).kind, "welcome");
	await host.close();
	await host.done;
	await assert.rejects(client.next());
	assert.equal(existsSync(paths.claim), false);
});

it("serves concurrent requests and forwards runtime error codes", { timeout: 15000 }, async (t) => {
	const root = fixtureRoot(t);
	const config = metadata(root);
	const runtime: HostRuntime = {
		request: async (method, params) => {
			if (method === "fail") throw new HostError("not allowed", "invalid");
			await new Promise((resolve) => setTimeout(resolve, 20));
			return { method, params };
		},
		close: async () => {},
		isIdle: () => true,
	};
	const host = await runHost(() => runtime, { metadata: config, idleMs: 0, announceReady: noop });
	const paths = hostPaths(config);
	const token = (JSON.parse(readFileSync(paths.endpoint, "utf8")) as { token: string }).token;
	const client = await RawClient.connect(paths.socket);
	client.send({ kind: "hello", version: HOST_PROTOCOL_VERSION, token, metadata: config });
	await client.next();
	client.send({ kind: "request", id: "first", method: "echo", params: 1 });
	client.send({ kind: "request", id: "second", method: "echo", params: 2 });
	client.send({ kind: "request", id: "third", method: "fail" });
	const responses = [await client.next(), await client.next(), await client.next()];
	assert.deepEqual(responses.map((response) => response.kind === "response" ? response.id : "").sort(), ["first", "second", "third"]);
	const failure = responses.find((response) => response.kind === "response" && response.id === "third");
	assert.equal(failure?.kind === "response" && failure.ok === false ? failure.error.code : undefined, "invalid");
	client.destroy();
	await host.close();
});

it("cancels a wait on a cancel frame or disconnect and leaves other requests alone", { timeout: 15000 }, async (t) => {
	const root = fixtureRoot(t);
	const config = metadata(root);
	const seen: Array<{ method: string; signal?: AbortSignal }> = [];
	let cancelled = 0;
	const runtime: HostRuntime = {
		request: async (method, params, _requestId, signal) => {
			seen.push({ method, ...(signal === undefined ? {} : { signal }) });
			if (method === "receipts" && (params as { wait?: boolean } | undefined)?.wait === true) {
				return new Promise((_resolve, reject) => {
					signal?.addEventListener("abort", () => {
						cancelled += 1;
						reject(new Error("cancelled"));
					}, { once: true });
				});
			}
			return { method };
		},
		close: async () => {},
		isIdle: () => true,
	};
	const host = await runHost(() => runtime, { metadata: config, idleMs: 0, announceReady: noop });
	const paths = hostPaths(config);
	const token = (JSON.parse(readFileSync(paths.endpoint, "utf8")) as { token: string }).token;

	const cancelling = await RawClient.connect(paths.socket);
	cancelling.send({ kind: "hello", version: HOST_PROTOCOL_VERSION, token, metadata: config });
	await cancelling.next();
	cancelling.send({ kind: "request", id: "w1", method: "receipts", params: { wait: true } });
	await waitFor(() => seen.filter((entry) => entry.method === "receipts").length === 1);
	cancelling.send({ kind: "cancel", id: "w1" });
	const cancelledResponse = await cancelling.next();
	assert.equal(cancelledResponse.kind === "response" ? cancelledResponse.id : "", "w1");
	assert.equal(cancelledResponse.kind === "response" && cancelledResponse.ok, false);
	cancelling.send({ kind: "request", id: "e1", method: "echo" });
	assert.equal((await cancelling.next()).kind, "response");
	cancelling.destroy();

	const disconnecting = await RawClient.connect(paths.socket);
	disconnecting.send({ kind: "hello", version: HOST_PROTOCOL_VERSION, token, metadata: config });
	await disconnecting.next();
	disconnecting.send({ kind: "request", id: "w2", method: "receipts", params: { wait: true } });
	await waitFor(() => seen.filter((entry) => entry.method === "receipts").length === 2);
	disconnecting.destroy();
	await waitFor(() => cancelled === 2);
	for (const entry of seen) {
		if (entry.method === "receipts") assert.ok(entry.signal !== undefined, "waits receive a cancelable signal");
		if (entry.method === "echo") assert.equal(entry.signal, undefined, "other requests receive no signal");
	}
	await host.close();
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
	const host = await runHost(() => runtime, { metadata: config, idleMs: 40, announceReady: noop });
	await new Promise((resolve) => setTimeout(resolve, 160));
	assert.equal(observeClaim(hostPaths(config).claim, hostPaths(config).identity).kind, "live", "busy host stays");
	idle = true;
	await host.done;
	assert.equal(observeClaim(hostPaths(config).claim, hostPaths(config).identity).kind, "absent");
});

it("holds the claim before the runtime factory and releases it on failure", { timeout: 15000 }, async (t) => {
	const root = fixtureRoot(t);
	const config = metadata(root);
	const paths = hostPaths(config);
	let sawClaim = false;
	await assert.rejects(
		runHost(() => {
			sawClaim = observeClaim(paths.claim, paths.identity).kind === "live";
			throw new Error("factory boom");
		}, { metadata: config, idleMs: 0, announceReady: noop }),
		/factory boom/u,
	);
	assert.equal(sawClaim, true, "the claim is on disk before the factory runs");
	assert.equal(observeClaim(paths.claim, paths.identity).kind, "absent", "failed startup releases the claim");
});

it("parses the idle window with the configured bounds", () => {
	assert.equal(resolveIdleMs(undefined, {}), 5 * 60_000);
	assert.equal(resolveIdleMs(undefined, { PI_AGENT_IDLE_MINUTES: "0.5" }), 30_000);
	assert.equal(resolveIdleMs(undefined, { PI_AGENT_IDLE_MINUTES: "0" }), 0);
	assert.equal(resolveIdleMs(1234, { PI_AGENT_IDLE_MINUTES: "1" }), 1234);
	for (const value of ["", "abc", "-1", "40000", "NaN"]) {
		assert.throws(() => resolveIdleMs(undefined, { PI_AGENT_IDLE_MINUTES: value }), /PI_AGENT_IDLE_MINUTES/u, value);
	}
	assert.throws(() => resolveIdleMs(-1, {}), /idleMs/u);
	assert.throws(() => resolveIdleMs(Number.POSITIVE_INFINITY, {}), /idleMs/u);
});
