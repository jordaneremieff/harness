import assert from "node:assert/strict";
import { fork, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createHostManager, forkDriver } from "@earendil-works/chord/node";
import { AgentCatalog, hostMetadata } from "./catalog.ts";
import { readClaimFile } from "./claims.ts";
import { markerFixture } from "./durable-runtime-fixture.mts";
import { AgentManager } from "./manager.ts";
import { DurableHost } from "./durable-host.ts";
import { fixtureRegistry, fixtureStorageId, gateTool, hostOptions, scriptedRuntime, toolCallMessage, answerMessage } from "./durable-host-fixture.mts";
import { connectHost, type HostConnection } from "./host-client.ts";
import { hostPaths } from "./host-protocol.ts";
import { HOST_CONTRACT } from "./version-contract.ts";
import { parseNamespaceRecovery } from "./namespace-recovery.ts";

const packageDir = dirname(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))));

test("namespace recovery resumes a retained unanswered native input after every isolated host closes, without a primary or new input", { timeout: 10000 }, async t => {
	const root = mkdtempSync(join(tmpdir(), "agent-namespace-recovery-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const managedRoot = join(root, "managed"), ordinaryRoot = join(root, "ordinary");
	const catalog = new AgentCatalog(managedRoot);
	const record = catalog.create({ cwd: root, agentDir: root, packageDir, model: { provider: "durable-host-fixture", modelId: "fixture" }, thinkingLevel: "off", ownerId: "operator" });
	let started!: () => void;
	const active = new Promise<void>(resolve => { started = resolve; });
	const options = hostOptions(record.storagePath, await scriptedRuntime([toolCallMessage("gate")]), fixtureRegistry([gateTool(new Promise(() => {}), started)]));
	const first = await DurableHost.open({ ...options, storageId: record.storageId }, BACKGROUND_CONTEXT);
	const input = await first.submit({ message: "retained work", requestId: "retained" });
	await active;
	catalog.markRecoveryDue(record.storageId, true);
	await first.close();
	let recovered: DurableHost | undefined;
	const manager = new AgentManager({ root: managedRoot, agentDir: root, packageDir,
		connect: async () => { throw new Error("Every isolated host is gone"); },
		acquire: async metadata => {
			assert.equal(metadata.packageDir, packageDir);
			recovered = await DurableHost.open({ ...hostOptions(metadata.storagePath, await scriptedRuntime([answerMessage("resumed")]), fixtureRegistry([gateTool(Promise.resolve())])), storageId: metadata.storageId }, BACKGROUND_CONTEXT);
			const active = recovered;
			let closed = false;
			return { pid: process.pid, socketPath: join(root, "unused.sock"), storageId: metadata.storageId, metadata, runtimeContract: HOST_CONTRACT,
				get closed() { return closed; },
				request: async (method, params) => method === "recovery-state" ? { workPending: true, deliveriesActive: false } : active.request(method, params as Record<string, unknown>),
				onClose: () => () => {}, subscribeChanges: async () => () => {}, close: async () => { closed = true; },
			} as HostConnection;
		},
	});
	const controller = new AbortController();
	t.after(async () => { controller.abort(); manager.close(); await recovered?.close(); });
	const report = await manager.recoverNamespace(controller.signal);
	assert.equal(report.attempted, 1);
	assert.deepEqual(report.failures, []);
	assert.ok(recovered);
	assert.equal((await recovered.wait(input.submissionId)).status, "done");
	assert.equal((await new AgentCatalog(ordinaryRoot).page({ limit: 20 })).records.length, 0);
	assert.notEqual(record.storageId, fixtureStorageId);
});

for (const expired of [false, true]) test(expired
	? "recovery reports a persistently unavailable live endpoint until a successful connection"
	: "recovery stays silent during a foreign host startup race and attaches after readiness", { timeout: 15000 }, async t => {
	const root = mkdtempSync(join(tmpdir(), "agent-competing-recovery-"));
	const markers = markerFixture(t, root);
	const release = markers.hold("claimed");
	const catalog = new AgentCatalog(root);
	const record = catalog.create({ cwd: root, agentDir: root, packageDir, model: { provider: "fixture", modelId: "fixture" }, thinkingLevel: "off", ownerId: "operator", trust: true });
	catalog.markRecoveryDue(record.storageId, true);
	const code = `
		import { runHost } from ${JSON.stringify(new URL("./host-process.ts", import.meta.url).href)};
		import { publishFixtureMarker } from ${JSON.stringify(new URL("./testdata/durable-runtime/signal.ts", import.meta.url).href)};
		const host = await runHost(async () => {
			await publishFixtureMarker(process.env.DURABLE_TEST_NOTIFY, "claimed");
			return { request: async () => ({ workPending: true, deliveriesActive: false }), close: async () => {}, isIdle: () => false };
		}, { metadata: JSON.parse(process.argv.at(-1)), idleMs: 0, announceReady: () => {} });
		await publishFixtureMarker(process.env.DURABLE_TEST_NOTIFY, "ready");
		await host.done;
	`;
	const controller = new AbortController();
	let manager: AgentManager | undefined;
	const child = spawn(process.execPath, ["--input-type=module", "--eval", code, JSON.stringify(hostMetadata(record))], {
		stdio: "ignore", env: { ...process.env, PI_AGENT_DIR: root, PI_AGENT_SESSIONS_DIR: root, DURABLE_TEST_NOTIFY: markers.notifyPath },
	});
	const exited = once(child, "exit");
	t.after(async () => { controller.abort(); manager?.close(); release(); if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); await exited; rmSync(root, { recursive: true, force: true }); });
	await markers.marker("claimed");
	const claim = readClaimFile(hostPaths(record).claim).claim as { pid: number; createdAt: string };
	assert.equal(claim.pid, child.pid);
	// DEFAULT_LAUNCH_TIMEOUT_MS in host-client.ts bounds a foreign startup at 30 seconds.
	t.mock.method(Date, "now", () => Date.parse(claim.createdAt) + (expired ? 30_000 : 1));
	let connections = 0;
	manager = new AgentManager({ root, agentDir: root, packageDir,
		connect: async metadata => { connections++; return connectHost(metadata); },
		acquire: async () => { throw new Error("A competing live writer must not be replaced"); },
	});
	const report = await manager.recoverNamespace(controller.signal);
	assert.equal(report.attempted, 1);
	assert.equal(connections, 1);
	if (expired) {
		assert.equal(report.failures.length, 1);
		assert.equal(report.failures[0].storageId, record.storageId);
		assert.match(report.failures[0].error, /live host endpoint is unavailable outside the startup readiness window/u);
		assert.deepEqual((await manager.recoverNamespace(controller.signal)).failures, report.failures);
	} else assert.deepEqual(report.failures, []);
	release();
	await markers.marker("ready");
	assert.deepEqual((await manager.recoverNamespace(controller.signal)).failures, []);
});

test("the namespace recovery child supports Chord readiness and shutdown without provider configuration", { timeout: 10000 }, async t => {
	const root = mkdtempSync(join(tmpdir(), "agent-recovery-owner-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const input = { protocol: 1, root, agentDir: root, packageDir, cwd: root };
	const host = createHostManager({ driver: forkDriver({ entry: fileURLToPath(new URL("./namespace-recovery.ts", import.meta.url)), args: [JSON.stringify(input)], lock: `agent.recovery:${root}` }), readyTimeout: 5000 });
	t.after(() => host.stop());
	await host.start();
	assert.equal(host.status, "running");
	await host.stop();
	assert.equal(host.status, "stopped");
	assert.throws(() => parseNamespaceRecovery({ ...input, sourceRoot: root }));
	assert.throws(() => parseNamespaceRecovery({ ...input, packageDir: "relative" }));
});

test("a namespace recovery owner exits when its management parent disconnects", { timeout: 10000 }, async t => {
	const root = mkdtempSync(join(tmpdir(), "agent-recovery-disconnect-"));
	const child = fork(fileURLToPath(new URL("./namespace-recovery.ts", import.meta.url)), [JSON.stringify({ protocol: 1, root, agentDir: root, packageDir, cwd: root })], { execArgv: [], stdio: ["ignore", "ignore", "ignore", "ipc"] });
	t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill(); rmSync(root, { recursive: true, force: true }); });
	await new Promise<void>((resolve, reject) => { child.on("message", message => { if ((message as { chord2control?: { type?: string } }).chord2control?.type === "ready") resolve(); }); child.once("error", reject); });
	const exited = once(child, "exit");
	child.disconnect();
	const [code] = await exited;
	assert.equal(code, 0);
});
