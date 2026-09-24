import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/pi-agent-core";
import { type ExtensionAPI, ProjectTrustStore } from "@earendil-works/pi-coding-agent";
import registerAgentExtension, { AgentManager } from "./index.ts";
import { AgentStore } from "./store.ts";
import { createTestRuntime } from "./test-runtime.mts";

interface SharedOwners {
	managers: Map<string, AgentManager>;
	creating: Map<string, Promise<AgentManager>>;
}

const sharedOwners = (): SharedOwners =>
	(globalThis as Record<symbol, unknown>)[Symbol.for("pi.extension.agent.owners")] as SharedOwners;

interface Captured {
	tools: Map<string, { execute: (...args: unknown[]) => Promise<unknown> }>;
	handlers: Map<string, (event: { reason: string }, ctx: unknown) => Promise<void>>;
}

const captureExtension = (): Captured => {
	const tools = new Map<string, { execute: (...args: unknown[]) => Promise<unknown> }>();
	const handlers = new Map<string, (event: { reason: string }, ctx: unknown) => Promise<void>>();
	registerAgentExtension({
		registerTool: (tool: { name: string; execute: (...args: unknown[]) => Promise<unknown> }) => tools.set(tool.name, tool),
		registerMessageRenderer() {},
		registerCommand() {},
		on: (name: string, handler: (event: { reason: string }, ctx: unknown) => Promise<void>) => handlers.set(name, handler),
	} as unknown as ExtensionAPI);
	return { tools, handlers };
};

const listTool = (): { execute: (...args: unknown[]) => Promise<unknown> } => {
	const tool = captureExtension().tools.get("agent_list");
	assert.ok(tool);
	return tool;
};

const shutdownHandler = (): (event: { reason: string }, ctx: unknown) => Promise<void> => {
	const handler = captureExtension().handlers.get("session_shutdown");
	assert.ok(handler);
	return handler;
};

const shutdownContext = { sessionManager: { getSessionId: () => "manager-cache-probe" } };

const probeContext = { sessionManager: { getSessionId: () => "manager-cache-probe" } };

const staleManager = (): AgentManager => ({ managerProtocol: undefined }) as unknown as AgentManager;

interface Scratch {
	root: string;
	sessions: string;
	key: string;
	restoreEnv(): void;
	cleanup(): void;
}

const scratch = (prefix: string): Scratch => {
	const root = mkdtempSync(join(tmpdir(), `agent-manager-cache-${prefix}-`));
	const sessions = join(root, "sessions");
	mkdirSync(sessions, { recursive: true });
	const key = realpathSync(sessions);
	const previous = process.env.PI_AGENT_SESSIONS_DIR;
	process.env.PI_AGENT_SESSIONS_DIR = sessions;
	return {
		root,
		sessions,
		key,
		restoreEnv: () => {
			if (previous === undefined) delete process.env.PI_AGENT_SESSIONS_DIR;
			else process.env.PI_AGENT_SESSIONS_DIR = previous;
		},
		cleanup: () => rmSync(root, { recursive: true, force: true }),
	};
};

describe("process-global manager cache", () => {
	it("refuses a cached manager from a different extension copy with a named error", async () => {
		const area = scratch("stale-cached");
		const stale = staleManager();
		sharedOwners().managers.set(area.key, stale);
		try {
			await assert.rejects(
				listTool().execute(null, null, null, null, probeContext),
				/different agent extension copy \(manager protocol undefined != 1\)/u,
			);
			assert.equal(sharedOwners().managers.get(area.key), stale);
		} finally {
			sharedOwners().managers.delete(area.key);
			area.restoreEnv();
			area.cleanup();
		}
	});

	it("reuses a compatible cached manager across extension copies", async () => {
		const area = scratch("compatible");
		const agentDir = join(area.root, "agent");
		mkdirSync(agentDir, { recursive: true });
		const store = new AgentStore({ sessionsRoot: area.sessions });
		const modelRuntime = await createTestRuntime({ refreshOnCreate: false });
		const manager = new AgentManager(store, modelRuntime, new ProjectTrustStore(agentDir), new AbortController(), agentDir);
		try {
			const result = await listTool().execute(null, null, null, null, probeContext);
			assert.ok(result);
			assert.equal(sharedOwners().managers.get(area.key), manager);
		} finally {
			await manager.closeAll();
			await store.close(withAbortSignal(new AbortController().signal, BACKGROUND_CONTEXT));
			area.restoreEnv();
			area.cleanup();
		}
	});

	it("refuses a creation promise that resolves to a manager from a different extension copy", async () => {
		const area = scratch("stale-pending");
		sharedOwners().creating.set(area.key, Promise.resolve(staleManager()));
		try {
			await assert.rejects(
				listTool().execute(null, null, null, null, probeContext),
				/different agent extension copy \(manager protocol undefined != 1\)/u,
			);
			assert.equal(sharedOwners().creating.has(area.key), false);
			assert.equal(sharedOwners().managers.has(area.key), false);
		} finally {
			sharedOwners().creating.delete(area.key);
			sharedOwners().managers.delete(area.key);
			area.restoreEnv();
			area.cleanup();
		}
	});

	it("session shutdown skips an incompatible cached manager instead of failing", async () => {
		const area = scratch("stale-shutdown");
		const stale = staleManager();
		sharedOwners().managers.set(area.key, stale);
		try {
			await assert.doesNotReject(shutdownHandler()({ reason: "close" }, shutdownContext));
			assert.equal(sharedOwners().managers.get(area.key), stale);
		} finally {
			sharedOwners().managers.delete(area.key);
			area.restoreEnv();
			area.cleanup();
		}
	});

	it("session shutdown unregisters a primary held by a compatible cached manager", async () => {
		const area = scratch("shutdown-owner");
		const agentDir = join(area.root, "agent");
		mkdirSync(agentDir, { recursive: true });
		const store = new AgentStore({ sessionsRoot: area.sessions });
		const modelRuntime = await createTestRuntime({ refreshOnCreate: false });
		const manager = new AgentManager(store, modelRuntime, new ProjectTrustStore(agentDir), new AbortController(), agentDir);
		try {
			manager.registerPrimary("cache-probe-primary", area.root, () => {});
			assert.equal(manager.hasPrimary("cache-probe-primary"), true);
			await shutdownHandler()({ reason: "close" }, { sessionManager: { getSessionId: () => "cache-probe-primary" } });
			assert.equal(manager.hasPrimary("cache-probe-primary"), false);
		} finally {
			await manager.closeAll();
			await store.close(withAbortSignal(new AbortController().signal, BACKGROUND_CONTEXT));
			area.restoreEnv();
			area.cleanup();
		}
	});
});
