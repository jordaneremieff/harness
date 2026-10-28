import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { it, type TestContext } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Harness, InboxDoc } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { AgentCatalog } from "./catalog.ts";
import { acquireHost, waitForHostRelease } from "./host-client.ts";
import { runtimeFixture, trackHost, waitForProcessGone } from "./durable-runtime-fixture.mts";
import { fixtureRegistry } from "./durable-host-fixture.mts";
import { createTestRuntime } from "./test-runtime.mts";
import { AgentManager } from "./manager.ts";

async function launch(t: TestContext, mode: "request" | "answer") {
	const f = runtimeFixture(t, { withAgentExtension: true });
	const host = await acquireHost(f.metadata, { env: { ...f.env(mode), PI_AGENT_DIR: f.agentDir, PI_AGENT_SESSIONS_DIR: f.root, PI_AGENT_IDLE_MINUTES: "0" }, retryAttempts: 0 });
	trackHost(t, host.pid);
	t.after(() => host.close());
	return { f, host };
}

it("aborts a run with a queued notice and retires without recovery", { timeout: 30000 }, async (t) => {
	const { f, host } = await launch(t, "request");
	await host.request("submit", { message: "hold the run", requestId: "held", origin: "operator" });
	await f.marker("requested");
	await host.request("passive-submit", { message: "thread notice", requestId: "notice" });
	const result = await host.request("release", { sessionId: f.metadata.storageId }) as { retiring: boolean; writesPlaced: number; blockers: string[] };
	assert.equal(result.retiring, true, JSON.stringify(result));
	assert.ok(Number.isSafeInteger(result.writesPlaced) && result.writesPlaced >= 0, JSON.stringify(result));
	await waitForHostRelease(f.metadata, { signal: AbortSignal.timeout(10000) });
	assert.equal(await waitForProcessGone(host.pid), true);
	assert.equal(new AgentCatalog(f.root).read(f.metadata.storageId).recoveryDue, false);
	const modelRequests = readFileSync(join(f.testDir, "session-options.jsonl"), "utf8").trim().split("\n");
	assert.equal(modelRequests.length, 1, "release starts no additional model run");
	const runtime = await createTestRuntime();
	const harness = await Harness.open(await openNodeSqliteStorage(f.storagePath), { models: runtime, registry: fixtureRegistry(), settings: { retry: { enabled: false } } }, BACKGROUND_CONTEXT);
	try {
		const root = await harness.root(BACKGROUND_CONTEXT);
		assert.equal((await harness.snapshot(InboxDoc, root.id, BACKGROUND_CONTEXT))?.items.length, 0);
		assert.equal((await harness.inspect(BACKGROUND_CONTEXT)).submissions.length, 0);
		const entries = await root.entries({}, 100, undefined, BACKGROUND_CONTEXT);
		assert.ok(entries.items.some((entry) => entry.kind === "agent.thread-notice" && JSON.stringify(entry.model).includes("thread notice")));
	} finally { await harness.close(BACKGROUND_CONTEXT); }
	let acquisitions = 0;
	const manager = new AgentManager({ root: f.root, agentDir: f.agentDir, packageDir: f.metadata.packageDir, acquire: async () => { acquisitions++; throw new Error("unexpected host launch"); } });
	try {
		await manager.registerPrimary(f.ownerId, { cwd: f.cwd, signal: new AbortController().signal, send: () => {} });
		await (manager as unknown as { recoveryQueue: Promise<void> }).recoveryQueue;
		assert.equal(acquisitions, 0);
	} finally { await manager.close(); }
});

for (const background of [false, true]) it(`preserves a pending timer on release with background=${background}`, { timeout: 30000 }, async (t) => {
	const { f, host } = await launch(t, "answer");
	const timer = await host.request("timer-schedule", { message: "later", deliverAt: Date.now() + 3600000, origin: "operator", ownerId: f.ownerId }) as { timerId: number };
	if (background) {
		await assert.rejects(host.request("release", { sessionId: f.metadata.storageId, background: true }), /release cannot be combined with background; abort with background first, then release/u);
	} else {
		const result = await host.request("release", { sessionId: f.metadata.storageId }) as { retiring: boolean; blockers: string[] };
		assert.equal(result.retiring, false);
		assert.ok(result.blockers.some((blocker) => blocker.includes("timer")), JSON.stringify(result));
	}
	const page = await host.request("timer-list", { sessionId: f.metadata.storageId }) as { timers: Array<{ timerId: number; status: string }> };
	assert.equal(page.timers.find((row) => row.timerId === timer.timerId)?.status, "pending");
	process.kill(host.pid, 0);
	await host.request("timer-cancel", { timerId: timer.timerId });
});
