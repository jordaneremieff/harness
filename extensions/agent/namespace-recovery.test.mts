import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createHostManager, forkDriver } from "@earendil-works/chord/node";
import { AgentCatalog } from "./catalog.ts";
import { AgentManager } from "./manager.ts";
import { DurableHost } from "./durable-host.ts";
import { fixtureRegistry, fixtureStorageId, gateTool, hostOptions, scriptedRuntime, toolCallMessage, answerMessage } from "./durable-host-fixture.mts";
import type { HostConnection } from "./host-client.ts";
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
