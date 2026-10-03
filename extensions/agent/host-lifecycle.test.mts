import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { it } from "node:test";
import { fileURLToPath } from "node:url";
import { ServerError, type ServerHost } from "@earendil-works/pi-server";
import { createUnixServer } from "@earendil-works/pi-server/unix";
import { acquireHost, connectHost } from "./host-client.ts";
import * as hostClient from "./host-client.ts";
import { fixtureMetadata } from "./host-fixture.mts";
import { hostPaths, HOST_READY_PREFIX } from "./host-protocol.ts";
import { runHost } from "./host-process.ts";
import { runtimeFixture } from "./durable-runtime-fixture.mts";

function deferred(): { promise: Promise<void>; resolve(): void } {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => { resolve = done; });
	return { promise, resolve };
}

function root(t: { after(fn: () => void): void }): string {
	const path = mkdtempSync(join(tmpdir(), "host-lifecycle-"));
	t.after(() => rmSync(path, { recursive: true, force: true }));
	return path;
}

it("rejects a local protocol validation error without recovering the host", { timeout: 15000 }, async (t) => {
	const metadata = fixtureMetadata(root(t));
	let requests = 0;
	const host = await runHost(() => ({
		request: async () => ({ requests: ++requests }),
		isIdle: () => true,
		close: async () => {},
	}), { metadata, idleMs: 0, announceReady: () => {} });
	t.after(() => host.close());
	const client = await connectHost(metadata, { retryAttempts: 0 });
	t.after(() => client.close());
	await assert.rejects(client.request("list", { limit: 5, cursor: undefined }), /Invalid client protocol message/u);
	assert.equal(client.closed, false, "a local encoding error leaves the transport healthy");
	assert.equal(requests, 0, "invalid parameters never reached the server");
	assert.deepEqual(await client.request("list", { limit: 5 }), { requests: 1 });
});

async function rejectingVersionHost(t: { after(fn: () => void | Promise<void>): void }, path: string, malformed = false) {
	const metadata = fixtureMetadata(path);
	const paths = hostPaths(metadata);
	mkdirSync(paths.directory, { recursive: true, mode: 0o700 });
	mkdirSync(dirname(paths.claim), { recursive: true, mode: 0o700 });
	writeFileSync(paths.claim, JSON.stringify({ token: randomUUID(), pid: process.pid, host: hostname(), sessionId: metadata.storageId, cwd: path, createdAt: new Date().toISOString() }));
	const released = deferred();
	let count = 0;
	const routed: ServerHost = {
		serverServices: { attachClient: () => ({
			invokeService: async () => { if (malformed) return { format: "pi.agent.contract/1", release: "invalid" }; throw new ServerError("service_invalid_value", "durable host is closed"); },
			release: () => { released.resolve(); },
		}) },
		resolveSession: async () => { throw new Error("no session"); },
		openSession: async () => { throw new Error("no session"); },
	};
	const server = createUnixServer(routed, { serverId: paths.serverId, path: paths.socket, onConnectionCountChanged: (value) => { count = value; } });
	await server.start();
	t.after(() => server.close());
	return { metadata, released: released.promise, count: () => count };
}

it("disposes a client when its runtime contract request fails", { timeout: 15000 }, async (t) => {
	const fixture = await rejectingVersionHost(t, root(t));
	await assert.rejects(connectHost(fixture.metadata), /durable host is closed/u);
	await fixture.released;
	assert.equal(fixture.count(), 0);
});

it("does not launch after an application error from a live writer", { timeout: 15000 }, async (t) => {
	const path = root(t);
	const fixture = await rejectingVersionHost(t, path);
	const marker = join(path, "launched");
	await assert.rejects(acquireHost(fixture.metadata, {
		runner: "--eval",
		runnerArgs: [`require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'launched'); process.exitCode = 1;`],
	}), /durable host is closed/u);
	assert.equal(existsSync(marker), false, "a live writer's application failure grants no launch authority");
	await fixture.released;
	assert.equal(fixture.count(), 0);
});

it("preserves a malformed contract error without waiting for a live writer to die", { timeout: 15000 }, async (t) => {
	const fixture = await rejectingVersionHost(t, root(t), true);
	await assert.rejects(acquireHost(fixture.metadata), /runtime contract is missing or malformed/u);
	await fixture.released;
	assert.equal(fixture.count(), 0);
});

it("a wire close exits the durable process and releases its writer claim", { timeout: 15000 }, async (t) => {
	const fixture = runtimeFixture(t);
	const child = spawn(process.execPath, [fileURLToPath(new URL("./durable-runner.ts", import.meta.url)), JSON.stringify(fixture.metadata)], {
		cwd: fixture.cwd,
		env: { ...process.env, ...fixture.env("answer"), PI_AGENT_SESSIONS_DIR: fixture.root },
		stdio: ["ignore", "pipe", "pipe"],
	});
	const exited = once(child, "exit");
	t.after(async () => {
		if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
		await exited;
	});
	let stderr = "";
	child.stderr.on("data", (chunk: Buffer) => { stderr = `${stderr}${chunk.toString()}`.slice(-8192); });
	await new Promise<void>((resolve, reject) => {
		let output = "";
		child.stdout.on("data", (chunk: Buffer) => { output = `${output}${chunk.toString()}`.slice(-8192); if (output.includes(HOST_READY_PREFIX)) resolve(); });
		child.once("error", reject);
		child.once("exit", () => reject(new Error(`host exited before readiness: ${stderr}`)));
	});
	const client = await connectHost(fixture.metadata, { retryAttempts: 0 });
	t.after(() => client.close());
	await client.request("close").catch(() => undefined);
	const [code, signal] = await exited;
	assert.equal(code, 0, stderr);
	assert.equal(signal, null);
	assert.equal(existsSync(hostPaths(fixture.metadata).claim), false);
});

for (const ownedExit of [false, true]) it(`preserves the busy writer claim with ${ownedExit ? "an explicit" : "no"} process exit owner`, async (t) => {
	const metadata = fixtureMetadata(root(t));
	let exits = 0;
	const exit = (): never => { exits++; assert.equal(existsSync(hostPaths(metadata).claim), true); throw new Error("fixture process exit"); };
	const host = await runHost(() => ({ request: async () => ({}), isIdle: () => false, close: async () => "process-exit" as const }), {
		metadata, idleMs: 0, announceReady: () => {}, ...(ownedExit ? { exit } : {}),
	});
	await assert.rejects(host.close(), ownedExit ? /fixture process exit/u : /dedicated process owner/u);
	assert.equal(exits, ownedExit ? 1 : 0);
	assert.equal(existsSync(hostPaths(metadata).claim), true, "a callback or refusal is not proof of writer death");
});

it("quiesces observational waits before runtime shutdown without closing transport early", { timeout: 15000 }, async (t) => {
	const metadata = fixtureMetadata(root(t));
	const started = deferred();
	let cancelled = false;
	const host = await runHost(() => ({
		request: async (_method, _params, _id, signal) => new Promise((_resolve, reject) => {
			signal?.addEventListener("abort", () => { cancelled = true; reject(signal.reason); }, { once: true });
			started.resolve();
		}),
		isIdle: () => true,
		close: async () => { assert.equal(cancelled, true); },
	}), { metadata, idleMs: 0, announceReady: () => {} });
	t.after(() => host.close());
	const client = await connectHost(metadata, { retryAttempts: 0 });
	t.after(() => client.close());
	const waiting = client.request("receipts", { wait: true });
	const rejected = assert.rejects(waiting);
	await started.promise;
	assert.equal(cancelled, false);
	await client.request("close").catch(() => undefined);
	await rejected;
	await host.done;
	assert.equal(existsSync(hostPaths(metadata).claim), false);
});

it("disconnects only after runtime shutdown and writer release", { timeout: 15000 }, async (t) => {
	const metadata = fixtureMetadata(root(t));
	const closing = deferred();
	const release = deferred();
	let dispatched = 0;
	const host = await runHost(() => ({
		request: async () => { dispatched++; return {}; },
		isIdle: () => true,
		close: async () => { closing.resolve(); await release.promise; },
	}), { metadata, idleMs: 0, announceReady: () => {} });
	t.after(async () => { release.resolve(); await host.close(); });
	const client = await connectHost(metadata, { retryAttempts: 0 });
	t.after(() => client.close());
	const closed = client.request("close").catch(() => undefined);
	await closing.promise;
	assert.equal(client.closed, false, "disconnect must not precede runtime cleanup");
	assert.equal(existsSync(hostPaths(metadata).claim), true);
	await assert.rejects(client.request("submit", { message: "too late" }), /shutting down/u);
	assert.equal(dispatched, 0);
	release.resolve();
	await closed;
	assert.equal(existsSync(hostPaths(metadata).claim), false, "the protocol completion proves release without a filesystem event");
	await host.done;
});

it("waits for writer release through close completion", { timeout: 15000 }, async (t) => {
	const metadata = fixtureMetadata(root(t));
	const host = await runHost(() => ({ request: async () => ({}), isIdle: () => true, close: async () => {} }), { metadata, idleMs: 0, announceReady: () => {} });
	t.after(() => host.close());
	let settled = false;
	const released = hostClient.waitForHostRelease(metadata, { after: host.done }).then(() => { settled = true; });
	const client = await connectHost(metadata, { retryAttempts: 0 });
	t.after(() => client.close());
	await client.request("status");
	assert.equal(settled, false, "an existing live writer is not released");
	await host.close();
	await released;
	assert.equal(existsSync(hostPaths(metadata).claim), false);
});

it("wire close and local close share one complete shutdown", { timeout: 15000 }, async (t) => {
	const metadata = fixtureMetadata(root(t));
	const closing = deferred();
	let closes = 0;
	let dispatched = 0;
	const host = await runHost(() => ({
		request: async () => { dispatched++; return {}; },
		isIdle: () => true,
		close: async () => { closes++; closing.resolve(); },
	}), { metadata, idleMs: 0, announceReady: () => {} });
	t.after(() => host.close());
	const client = await connectHost(metadata, { retryAttempts: 0 });
	t.after(() => client.close());
	await client.request("close").catch(() => undefined);
	assert.equal(dispatched, 0, "process close must not dispatch into the storage runtime");
	await closing.promise;
	await Promise.all([host.done, host.close(), host.close()]);
	assert.equal(closes, 1);
	assert.equal(existsSync(hostPaths(metadata).claim), false);
});
