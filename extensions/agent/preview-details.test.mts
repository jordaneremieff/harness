import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, it } from "node:test";
import { type ExtensionAPI, ProjectTrustStore } from "@earendil-works/pi-coding-agent";
import registerAgentExtension, { AgentManager, type SessionPreview } from "./index.ts";
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

describe("tool preview metadata", () => {
	it("reports the spawned session's own model and phase", { timeout: 20000 }, async () => {
		const f = await fixture();
		const manager = await managerFor(f);
		try {
			const created = await manager.spawn({ cwd: f.cwd }, { cwd: f.cwd, model: testModel });
			const preview = await manager.preview(created.sessionId, "session snapshot");
			assert.equal(preview.sessionId, created.sessionId);
			assert.equal(preview.phase, "session snapshot");
			assert.equal(preview.model?.provider, testModel.provider);
			assert.equal(preview.model?.modelId, testModel.id);
			assert.equal(typeof preview.model?.thinkingLevel, "string");
			assert.equal("runId" in preview, false);
			assert.equal("name" in preview, false);
		} finally { await manager.closeAll(); await f.close(); }
	});

	it("leaves model unknown for a stored session that was not reopened", { timeout: 20000 }, async () => {
		const f = await fixture();
		const targetId = await storedTarget(f.options);
		const manager = await managerFor(f);
		try {
			const preview = await manager.preview(targetId, "session snapshot");
			assert.equal(preview.sessionId, targetId);
			assert.equal(preview.phase, "session snapshot");
			assert.equal("model" in preview, false);
			assert.equal(openedWorker(manager, targetId), undefined);
		} finally { await manager.closeAll(); await f.close(); }
	});

	it("labels the detach snapshot before transfer", { timeout: 20000 }, async () => {
		const f = await fixture();
		const targetId = await storedTarget(f.options);
		const manager = await managerFor(f);
		const runs = (manager as unknown as { detachedRuns: { start: (request: { runId: string }) => Promise<{ runId: string; pid: number; logFile: string }> } }).detachedRuns;
		runs.start = async (request) => ({ runId: request.runId, pid: process.pid, logFile: join(f.root, "run.log") });
		const captured: SessionPreview[] = [];
		try {
			await manager.detach({ sessionId: targetId, prompt: "work" }, { cwd: f.cwd, model: testModel }, undefined, (preview) => { captured.push(preview); });
			assert.equal(captured.length, 1);
			assert.equal(captured[0].phase, "selected before transfer");
			assert.equal(captured[0].sessionId, targetId);
			assert.equal(captured[0].model?.provider, testModel.provider);
			assert.equal(captured[0].model?.modelId, testModel.id);
			assert.equal(openedWorker(manager, targetId), undefined, "the transfer released the held worker");
		} finally { await manager.closeAll(); await f.close(); }
	});

	it("returns the preview in the status tool details", { timeout: 20000 }, async () => {
		const f = await fixture();
		const targetId = await storedTarget(f.options);
		const previousSessions = process.env.PI_AGENT_SESSIONS_DIR;
		const previousAgent = process.env.PI_AGENT_DIR;
		process.env.PI_AGENT_SESSIONS_DIR = f.store.root;
		process.env.PI_AGENT_DIR = f.agentDir;
		interface Owners { managers: Map<string, AgentManager> }
		const owners = (globalThis as Record<symbol, unknown>)[Symbol.for("pi.extension.agent.owners")] as Owners;
		const before = new Set(owners.managers.keys());
		try {
			const tools = new Map<string, { execute: (...args: unknown[]) => Promise<unknown> }>();
			registerAgentExtension({
				registerTool: (tool: { name: string; execute: (...args: unknown[]) => Promise<unknown> }) => tools.set(tool.name, tool),
				registerMessageRenderer() {},
				registerCommand() {},
				on() {},
				getThinkingLevel: () => "medium",
			} as unknown as ExtensionAPI);
			const tool = tools.get("agent_status");
			assert.ok(tool);
			const result = (await tool.execute(null, { sessionId: targetId }, null, null, { sessionManager: { getSessionId: () => "preview-probe" } })) as { details?: { preview?: SessionPreview } };
			assert.equal(result.details?.preview?.sessionId, targetId);
			assert.equal(result.details?.preview?.phase, "session snapshot");
		} finally {
			for (const [key, manager] of owners.managers) {
				if (before.has(key)) continue;
				owners.managers.delete(key);
				await manager.closeAll();
			}
			if (previousSessions === undefined) delete process.env.PI_AGENT_SESSIONS_DIR;
			else process.env.PI_AGENT_SESSIONS_DIR = previousSessions;
			if (previousAgent === undefined) delete process.env.PI_AGENT_DIR;
			else process.env.PI_AGENT_DIR = previousAgent;
			await f.close();
		}
	});
});
