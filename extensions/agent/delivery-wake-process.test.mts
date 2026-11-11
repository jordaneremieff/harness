import { editDeliveryFixture } from "./delivery-store-fixture.mts";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { it, beforeEach, afterEach, type TestContext } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { hostMetadata } from "./catalog.ts";
import { hostPaths } from "./host-protocol.ts";

import { deliveryWakePath, readDeliveryWake } from "./delivery-wake.ts";
import { DurableHost } from "./durable-host.ts";
import { fixtureRegistry, fixtureRuntime } from "./durable-host-fixture.mts";
import { runtimeFixture, trackHost } from "./durable-runtime-fixture.mts";
import { eventLog, waitForProcessExit } from "./host-fixture.mts";
import { acquireHost, waitForHostRelease, type HostConnection } from "./host-client.ts";
import { AgentManager } from "./manager.ts";
import { handleStorageId } from "./identity.ts";
import { createPrimaryChannel } from "./primary-channel.ts";
import { createColdObservationCache } from "./cold-observation.ts";
let cold: ReturnType<typeof createColdObservationCache>;
beforeEach(() => { cold = createColdObservationCache(); });
afterEach(async () => { await cold.close(); });
const observeDurableStorage: ReturnType<typeof createColdObservationCache>["observe"] = (...args) => cold.observe(...args);

/** Keep recovery ownership separate from the recipient endpoints under test. */
const observerChannel: typeof createPrimaryChannel = async options => ({
	id: options.id, socketPath: "",
	info: () => ({ id: options.id, cwd: options.cwd, pid: process.pid, hostname: "fixture", socketPath: "", startedAt: new Date().toISOString() }),
	update: () => {}, publishIntent: () => {}, touch: () => {}, setObservedPurpose: () => {}, close: async () => {},
});

function fixture(t: TestContext, idleMinutes = "60") {
	const cleanup: Array<() => void | Promise<void>> = [];
	t.after(async () => { for (const close of cleanup.reverse()) await close(); });
	const f = runtimeFixture(t), connections = eventLog<HostConnection>();
	const paths = hostPaths(f.metadata);
	assert.ok(paths.socket.startsWith(`${f.agentDir}/`), "fixture host socket must remain in its private root");
	t.diagnostic(`Private host socket: ${paths.socket}; claim: ${paths.claim}`);
	const env = { ...f.env("answer"), PI_AGENT_IDLE_MINUTES: idleMinutes, PI_AGENT_DIR: f.agentDir, PI_AGENT_SESSIONS_DIR: f.root };
	const manager = new AgentManager({ root: f.root, agentDir: f.agentDir, packageDir: f.metadata.packageDir, createPrimary: observerChannel, acquire: async (metadata, options) => {
		const client = await acquireHost(metadata, { ...options, env });
		trackHost(t, client.pid); connections.push(client); return client;
	} });
	cleanup.push(() => manager.close());
	return { ...f, manager, connections, cleanup: (close: () => void | Promise<void>) => cleanup.unshift(close) };
}

async function seed(f: ReturnType<typeof fixture>, recipient: string): Promise<void> {
	const populate = async () => {
		const host = await DurableHost.open({ storageId: f.metadata.storageId, storagePath: f.metadata.storagePath, cwd: f.cwd, models: await fixtureRuntime("answer"), registry: fixtureRegistry(), agent: { model: f.metadata.model }, resume: false }, context);
		try {
			await host.harness.commit(async tx => editDeliveryFixture(tx, async (deliveryFixtureState) => {
				(deliveryFixtureState).reports.push({ sourceId: "report:parked-result", requestId: "parked-result", ownerId: recipient, senderIdentity: f.metadata.storageId, message: "retained parked result", replyTo: null, acknowledged: false, createdAt: Date.now() });
			}), context);
		} finally { await host.close(); }
	};
	await populate();
}

async function open(f: ReturnType<typeof fixture>): Promise<HostConnection> {
	const controller = new AbortController();
	await f.manager.registerPrimary(randomUUID(), { cwd: f.cwd, signal: controller.signal, send: () => {} });
	await f.manager.control("attach", { sessionId: f.metadata.storageId }, { id: randomUUID(), cwd: f.cwd });
	await f.connections.waitForCount(1);
	const source = f.connections[0]; assert.ok(source);
	await source.request("recovery-state");
	return source;
}

for (const kind of ["parked", "terminal"] as const) for (const signal of ["SIGTERM", "SIGKILL"] as const) it(`keeps a ${kind}-only host down after ${signal} with a live manager`, { timeout: 20000 }, async t => {
	const f = fixture(t), owner = kind === "parked" ? randomUUID() : "12345678";
	await seed(f, owner);
	const source = await open(f);
	assert.equal(f.manager.catalog.read(f.metadata.storageId).recoveryDue, false);
	assert.equal(existsSync(deliveryWakePath(f.root, f.metadata.storageId)), kind === "parked");
	process.kill(source.pid, signal);
	await waitForHostRelease(f.metadata, { signal: AbortSignal.timeout(5000) });
	await f.manager.registerPrimary(randomUUID(), { cwd: f.cwd, signal: new AbortController().signal, send: () => { assert.fail("an unavailable owner has no unrelated delivery"); } });
	assert.equal(f.connections.length, 1);
	assert.equal(f.manager.catalog.read(f.metadata.storageId).recoveryDue, false);
});

for (const kind of ["parked", "terminal"] as const) it(`retires a ${kind}-only process at its idle interval and leaves it cold at registration`, { timeout: 20000 }, async t => {
	const f = fixture(t, "0.01"), owner = kind === "parked" ? randomUUID() : "12345678";
	await seed(f, owner);
	await open(f);
	assert.equal(f.manager.catalog.read(f.metadata.storageId).recoveryDue, false);
	await waitForHostRelease(f.metadata, { signal: AbortSignal.timeout(5000) });
	await f.manager.registerPrimary(randomUUID(), { cwd: f.cwd, signal: new AbortController().signal, send: () => { assert.fail("a cold unavailable row does not deliver"); } });
	assert.equal(f.connections.length, 1);
	assert.equal(f.manager.catalog.read(f.metadata.storageId).recoveryDue, false);
});

it("resumes retained active delivery after an owned failed exit on the same inode", { timeout: 20000 }, async t => {
	const f = fixture(t, "60"), owner = randomUUID();
	const channelOptions = { id: owner, cwd: f.cwd, sessionsRoot: f.root, deliver: () => { throw new Error("temporary receiver failure"); }, promptTrust: async () => undefined };
	assert.ok(Buffer.byteLength(`${f.root}/.primaries/${owner}.sock`) <= 100, "fixture primary socket must remain in its private root");
	const channel = await createPrimaryChannel(channelOptions);
	assert.ok(channel.socketPath.startsWith(`${f.root}/`));
	f.cleanup(() => channel.close());
	await seed(f, owner);
	const source = await open(f);
	assert.equal(f.manager.catalog.read(f.metadata.storageId).recoveryDue, true);
	const inode = statSync(hostPaths(f.metadata).claim).ino;
	const originalPid = source.pid;
	const ownedExit = source.ownedExit;
	assert.ok(ownedExit);
	const duplicate = await acquireHost(f.metadata, { retryAttempts: 0, env: f.env("answer") });
	f.cleanup(() => duplicate.close());
	assert.equal(duplicate.pid, originalPid);
	f.connections.push(duplicate);
	const beforeKill = f.connections.length;
	process.kill(originalPid, "SIGKILL");
	assert.equal((await ownedExit).failed, true);
	await f.connections.waitFor(events => events.slice(beforeKill).some(client => client.pid > 0 && client.pid !== originalPid), 10000);
	assert.equal(statSync(hostPaths(f.metadata).claim).ino, inode);
	const retained = await observeDurableStorage(f.metadata, "receipts", { ownerId: owner }) as { reports: Array<{ requestId: string }> };
	assert.equal(retained.reports.filter(row => row.requestId === "parked-result").length, 1);
	assert.equal(f.manager.catalog.read(f.metadata.storageId).recoveryDue, true);
	await channel.close();
});

it("wakes a retired source after its native recipient becomes available", { timeout: 30000 }, async t => {
	const f = fixture(t, "0.01"), targetId = handleStorageId("wake-recipient", f.manager.catalog.root);
	await seed(f, targetId);
	await open(f);
	await waitForHostRelease(f.metadata, { signal: AbortSignal.timeout(5000) });
	assert.deepEqual(readDeliveryWake(f.root, f.metadata.storageId)?.recipients, [targetId]);
	const target = f.manager.catalog.createHandled({ cwd: f.cwd, agentDir: f.agentDir, packageDir: f.metadata.packageDir, model: f.metadata.model, thinkingLevel: "off", trust: true }, "wake-recipient", "Receive a retained result").record;
	assert.equal(target.storageId, targetId);
	await f.connections.waitForCount(2, 10000);
	await waitForHostRelease(f.metadata, { signal: AbortSignal.timeout(10000) });
	assert.equal(readDeliveryWake(f.root, f.metadata.storageId), undefined);
	const targetClient = await acquireHost(hostMetadata(target), { env: { ...f.env("answer"), PI_AGENT_DIR: f.agentDir, PI_AGENT_SESSIONS_DIR: f.root } }); trackHost(t, targetClient.pid); f.cleanup(() => targetClient.close());
	const history = await targetClient.request("inspect", { view: "search", query: "retained parked result", source: "user" }) as { matches: unknown[] };
	assert.equal(history.matches.length, 1);
});

it("retains wake metadata before a crash between sidecar publication and marker clearance", { timeout: 30000 }, async t => {
	const f = fixture(t, "60"), owner = randomUUID();
	await seed(f, owner);
	f.manager.catalog.markRecoveryDue(f.metadata.storageId, true);
	const runner = fileURLToPath(new URL("./delivery-wake-crash-fixture.mts", import.meta.url));
	const child = spawn(process.execPath, [runner, JSON.stringify(f.metadata)], { env: { ...process.env, ...f.env("answer") }, stdio: ["ignore", "pipe", "pipe"] });
	f.cleanup(async () => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); await waitForProcessExit(child); });
	const checkpoint = eventLog<void>();
	let output = "";
	child.stdout?.on("data", chunk => { output = `${output}${String(chunk)}`.slice(-32768); if (output.includes("WAKE_BEFORE_MARKER_CLEAR\n")) checkpoint.push(undefined); });
	await checkpoint.waitForCount(1, 10000);
	assert.deepEqual(readDeliveryWake(f.root, f.metadata.storageId)?.recipients, [owner]);
	assert.equal(f.manager.catalog.read(f.metadata.storageId).recoveryDue, true);
	child.kill("SIGKILL"); await waitForProcessExit(child);
	const manager = new AgentManager({ root: f.root, agentDir: f.agentDir, packageDir: f.metadata.packageDir,
		acquire: async (metadata, options) => { const client = await acquireHost(metadata, { ...options, env: f.env("answer") }); trackHost(t, client.pid); return client; },
	});
	f.cleanup(() => manager.close());
	const delivered = eventLog<string>();
	await manager.registerPrimary(owner, { cwd: f.cwd, signal: new AbortController().signal, send: text => delivered.push(text) });
	await delivered.waitForCount(1, 10000);
	assert.equal(delivered.length, 1);
	assert.match(delivered[0] ?? "", /retained parked result/u);
	await waitForHostRelease(f.metadata, { signal: AbortSignal.timeout(10000) });
});
