import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ProjectTrustStore } from "@earendil-works/pi-coding-agent";
import { AgentManager } from "./index.ts";
import { fixture } from "./native-fixture.mts";
import { testModel } from "./test-runtime.mts";
import { AgentWorkerSession } from "./worker.ts";

const managerFor = async (f: Awaited<ReturnType<typeof fixture>>): Promise<AgentManager> =>
	new AgentManager(f.store, f.runtime, new ProjectTrustStore(f.agentDir), undefined, f.agentDir);

const openedWorker = (manager: AgentManager, sessionId: string): AgentWorkerSession | undefined =>
	(manager as unknown as { sessions: Map<string, AgentWorkerSession> }).sessions.get(sessionId);

const storedTarget = async (options: Parameters<typeof AgentWorkerSession.create>[0]): Promise<string> => {
	const worker = await AgentWorkerSession.create(options);
	const sessionId = worker.sessionId();
	await worker.close();
	return sessionId;
};

describe("session summaries and descriptions", () => {
	it("carries the stored name, first message, live model, and provenance", { timeout: 20000 }, async () => {
		const f = await fixture();
		const manager = await managerFor(f);
		try {
			const created = await manager.spawn({ cwd: f.cwd, name: "alpha" }, { cwd: f.cwd, model: testModel });
			await manager.send(created.sessionId, "first task");
			const worker = openedWorker(manager, created.sessionId);
			assert.ok(worker);
			await worker.waitForIdle();
			const row = (await manager.sessionSummaries()).find((candidate) => candidate.sessionId === created.sessionId);
			assert.ok(row);
			assert.equal(row.name, "alpha");
			assert.equal(row.provenance, "live");
			assert.equal(row.model?.provider, testModel.provider);
			assert.equal(row.model?.modelId, testModel.id);
			assert.match(row.firstMessage ?? "", /first task/u);
		} finally { await manager.closeAll(); await f.close(); }
	});

	it("describes a stored session without reopening it", { timeout: 20000 }, async () => {
		const f = await fixture();
		const targetId = await storedTarget(f.options);
		const manager = await managerFor(f);
		try {
			const description = await manager.describe(targetId);
			assert.equal(description.provenance, "stored");
			assert.deepEqual(description.parentSessionIds, []);
			assert.equal(openedWorker(manager, targetId), undefined);
		} finally { await manager.closeAll(); await f.close(); }
	});

	it("returns readable previews in inspection pages", { timeout: 20000 }, async () => {
		const f = await fixture();
		const manager = await managerFor(f);
		try {
			const created = await manager.spawn({ cwd: f.cwd }, { cwd: f.cwd, model: testModel });
			await manager.send(created.sessionId, "inspectable request");
			const worker = openedWorker(manager, created.sessionId);
			assert.ok(worker);
			await worker.waitForIdle();
			const inspection = await manager.inspect(created.sessionId, { limit: 12 });
			const entries = (inspection as { entries?: { preview?: { text: string; truncated: boolean } }[] }).entries ?? [];
			const previews = entries.flatMap((entry) => entry.preview ? [entry.preview] : []);
			assert.ok(previews.some((preview) => /inspectable request/u.test(preview.text)), "a page preview carries the request text");
		} finally { await manager.closeAll(); await f.close(); }
	});
});
