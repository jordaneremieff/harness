/**
 * Real ordinary primary AgentSession coverage for the `agent.peer` notice
 * path: the registered primary channel receives a delivery, the extension calls
 * `pi.sendMessage`, and Pi decides whether that message starts a turn.
 *
 * A wake-false notice appends to the session without a provider request when
 * idle and waits for the turn boundary while streaming. A wake-true notice
 * starts exactly one turn. The fixture uses an isolated agent store and a faux
 * provider; it never touches a real session store.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { it } from "node:test";
import { createAssistantMessageEventStream, type AssistantMessage, type TranscriptContext } from "@earendil-works/pi-ai";
import { DefaultResourceLoader, SessionManager, SettingsManager, createAgentSession, type AgentSession, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { eventLog, type EventLog } from "./host-fixture.mts";
import { AgentManager } from "./manager.ts";
import { connectPrimaryChannel } from "./primary-channel.ts";
import { createTestRuntime, testModel } from "./test-runtime.mts";
import registerAgentExtension from "./index.ts";

const INDEX_PATH = fileURLToPath(new URL("./index.ts", import.meta.url));
const WRAPPER = `import register from ${JSON.stringify(INDEX_PATH)};\nexport default function (pi) {\n\tregister(pi);\n}\n`;
const MESSAGE_LIMIT_MS = 10_000;
/** The extension's process-local manager registry; `bindExtensions` starts it and no public teardown exists. */
function closeAgentManagers(): void {
	const owners = (globalThis as Record<PropertyKey, unknown>)[Symbol.for("pi.extension.agent.owners")] as { managers?: Map<string, { close(): void }> } | undefined;
	for (const manager of owners?.managers?.values() ?? []) manager.close();
	owners?.managers?.clear();
}

interface NoticeFixture {
	readonly session: AgentSession;
	readonly sessionManager: SessionManager;
	readonly sessionsRoot: string;
	readonly requests: EventLog<TranscriptContext>;
	/** Hold the provider before its request event. */
	holdRequest(): { held: Promise<void>; release(): void };
	/** Hold the next provider response open so the session stays streaming. */
	armGate(): void;
	release(): void;
	deliver(sourceId: string, text: string, wake: boolean): Promise<void>;
	customEntries(): Array<{ customType?: string; content?: unknown; details?: unknown }>;
}

function assistantMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		api: testModel.api,
		provider: testModel.provider,
		model: testModel.id,
		content: [{ type: "text", text }],
		stopReason: "stop",
		timestamp: Date.now(),
		usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
	};
}

async function noticeFixture(t: { after(fn: () => void): void }): Promise<NoticeFixture> {
	const root = mkdtempSync(join(tmpdir(), "primary-notice-"));
	const cwd = join(root, "work");
	const agentDir = join(root, "agent");
	const sessionsRoot = join(root, "sessions");
	mkdirSync(cwd);
	mkdirSync(agentDir);
	mkdirSync(sessionsRoot);
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ cacheWarming: { mode: "off" }, retry: { enabled: false } }));
	writeFileSync(join(root, "notice.ts"), WRAPPER);

	const previousAgentDir = process.env.PI_AGENT_DIR;
	const previousSessionsDir = process.env.PI_AGENT_SESSIONS_DIR;
	process.env.PI_AGENT_DIR = agentDir;
	process.env.PI_AGENT_SESSIONS_DIR = sessionsRoot;
	let session: AgentSession | undefined;
	let sessionManager: SessionManager | undefined;
	const requests = eventLog<TranscriptContext>();
	let requestGate: Promise<void> | undefined;
	let requestHeld: (() => void) | undefined;
	let releaseRequest: (() => void) | undefined;
	let gate: Promise<void> | undefined;
	let releaseGate: (() => void) | undefined;
	t.after(() => {
		releaseRequest?.();
		releaseGate?.();
		try {
			// The manager closes registered channels through the live extension ctx, so close it before dispose.
			closeAgentManagers();
		} finally {
			try {
				session?.dispose();
			} finally {
				if (previousAgentDir === undefined) delete process.env.PI_AGENT_DIR;
				else process.env.PI_AGENT_DIR = previousAgentDir;
				if (previousSessionsDir === undefined) delete process.env.PI_AGENT_SESSIONS_DIR;
				else process.env.PI_AGENT_SESSIONS_DIR = previousSessionsDir;
				rmSync(root, { recursive: true, force: true });
			}
		}
	});

	sessionManager = SessionManager.create(cwd, sessionsRoot);
	const runtime = await createTestRuntime();
	const stream = (_model: unknown, context: TranscriptContext) => {
		const message = assistantMessage("DELIVERY_COMPLETE");
		const events = createAssistantMessageEventStream();
		const emit = () => {
			events.push({ type: "start", partial: message });
			events.push({ type: "done", reason: "stop", message });
			events.end(message);
		};
		const begin = () => {
			requests.push(structuredClone(context));
			if (gate === undefined) emit();
			else void gate.then(emit);
		};
		if (requestGate === undefined) begin();
		else { requestHeld?.(); void requestGate.then(begin); }
		return events;
	};
	runtime.registerNativeProvider({
		id: testModel.provider,
		name: "Primary notice fixture",
		getModels: () => [testModel],
		auth: { apiKey: { name: "Test", check: async () => ({ type: "api_key" }), resolve: async () => ({ auth: {} }) } },
		stream,
		streamSimple: stream,
	});
	const settingsManager = SettingsManager.create(cwd, agentDir);
	const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, additionalExtensionPaths: [join(root, "notice.ts")] });
	await loader.reload();
	session = (await createAgentSession({ cwd, agentDir, modelRuntime: runtime, settingsManager, sessionManager, model: testModel, resourceLoader: loader })).session;
	await session.bindExtensions({});
	const id = sessionManager.getSessionId();
	assert.equal(existsSync(join(sessionsRoot, ".primaries", `${id}.json`)), true, "bindExtensions awaits primary registration");

	const deliver = async (sourceId: string, text: string, wake: boolean): Promise<void> => {
		const connection = await connectPrimaryChannel({ id, sessionsRoot });
		try {
			await connection.deliver({ sourceId, text, details: { sourceId, wake, identity: "storage-a", label: "poem task", status: "done", provider: "test-provider", modelId: "test-model", thinkingLevel: "high" } });
		} finally {
			await connection.close().catch(() => undefined);
		}
	};
	return {
		session,
		sessionManager,
		sessionsRoot,
		requests,
		holdRequest: () => {
			const held = eventLog<void>();
			requestGate = new Promise<void>((resolve) => { releaseRequest = resolve; });
			requestHeld = () => { held.push(undefined); };
			return {
				held: held.waitForCount(1, MESSAGE_LIMIT_MS),
				release: () => { releaseRequest?.(); requestGate = undefined; requestHeld = undefined; },
			};
		},
		armGate: () => {
			gate = new Promise<void>((resolve) => {
				releaseGate = resolve;
			});
		},
		release: () => {
			const release = releaseGate;
			gate = undefined;
			releaseGate = undefined;
			release?.();
		},
		deliver,
		customEntries: () => sessionManager?.getEntries().filter((entry) => entry.type === "custom_message") ?? [],
	};
}

it("retains a full wake-false notice and its source details without a primary model turn", { timeout: 30000 }, async (t) => {
	const fixture = await noticeFixture(t);
	const body = `operator notice body\n${"Retained result line.\n".repeat(1800)}FINAL_RESULT`;
	await fixture.deliver("operator:1", body, false);
	await fixture.session.waitForIdle();
	const entries = fixture.customEntries();
	assert.equal(entries.length, 1, "the notice is retained in the session");
	assert.equal(entries[0]?.customType, "agent.peer");
	assert.equal(entries[0]?.content, body);
	assert.deepEqual(entries[0]?.details, { sourceId: "operator:1", wake: false, identity: "storage-a", label: "poem task", status: "done", provider: "test-provider", modelId: "test-model", thinkingLevel: "high" });
	assert.equal(fixture.requests.length, 0, "a wake-false notice starts no provider request");
});

it("keeps a provider request consumer pending until the provider leaves its gate", { timeout: 30000 }, async (t) => {
	const fixture = await noticeFixture(t);
	const gate = fixture.holdRequest();
	let requested = false;
	const pending = fixture.requests.waitForCount(1, MESSAGE_LIMIT_MS).then(() => { requested = true; });
	await fixture.deliver("model:held", "held notice", true);
	await gate.held;
	assert.equal(requested, false);
	assert.equal(fixture.requests.length, 0);
	gate.release();
	await pending;
	await fixture.session.waitForIdle();
	assert.equal(requested, true);
	assert.equal(fixture.requests.length, 1);
});

it("starts exactly one primary model turn for a wake-true notice when idle", { timeout: 30000 }, async (t) => {
	const fixture = await noticeFixture(t);
	await fixture.deliver("model:1", "model notice body", true);
	await fixture.requests.waitForCount(1, MESSAGE_LIMIT_MS);
	await fixture.session.waitForIdle();
	assert.equal(fixture.requests.length, 1, "one notice starts one turn");
	assert.equal(fixture.customEntries().length, 1);
});

it("defers a wake-false notice to the turn boundary while the primary streams", { timeout: 30000 }, async (t) => {
	const fixture = await noticeFixture(t);
	fixture.armGate();
	const run = fixture.session.prompt("start the task");
	await fixture.requests.waitForCount(1, MESSAGE_LIMIT_MS);
	assert.equal(fixture.session.isStreaming, true, "the held provider request occurs during the active turn");
	await fixture.deliver("operator:stream", "streamed operator notice", false);
	assert.equal(fixture.customEntries().length, 0, "the notice waits for the turn boundary instead of steering the running turn");
	assert.equal(fixture.requests.length, 1, "the deferred notice starts no second provider request while streaming");
	fixture.release();
	await run;
	await fixture.session.waitForIdle();
	assert.equal(fixture.requests.length, 1, "the deferred notice adds no provider request after the turn");
	const entries = fixture.customEntries();
	assert.equal(entries.length, 1);
	assert.equal(entries[0]?.content, "streamed operator notice");
});

it("refreshes the registered primary identity on model, thinking, and name changes", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "primary-refresh-"));
	const previousSessionsDir = process.env.PI_AGENT_SESSIONS_DIR;
	process.env.PI_AGENT_SESSIONS_DIR = root;
	const calls: Array<[string, unknown]> = [];
	const original = AgentManager.prototype.updatePrimary;
	AgentManager.prototype.updatePrimary = (ownerId: string, info: unknown) => {
		calls.push([ownerId, info]);
	};
	t.after(() => {
		AgentManager.prototype.updatePrimary = original;
		closeAgentManagers();
		if (previousSessionsDir === undefined) delete process.env.PI_AGENT_SESSIONS_DIR;
		else process.env.PI_AGENT_SESSIONS_DIR = previousSessionsDir;
		rmSync(root, { recursive: true, force: true });
	});
	const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
	registerAgentExtension({
		events: { emit() {} },
		registerTool() {},
		registerMessageRenderer() {},
		registerShortcut() {},
		registerCommand() {},
		on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
			handlers.set(event, handler);
			return () => {};
		},
		getThinkingLevel: () => "off",
	} as unknown as ExtensionAPI);
	const ctx = { sessionManager: { getSessionId: () => "primary-1" } };
	await handlers.get("model_select")?.({ model: { provider: "anthropic", id: "claude-opus-5-5" } }, ctx);
	await handlers.get("thinking_level_select")?.({ level: "xhigh" }, ctx);
	await handlers.get("session_info_changed")?.({ name: "primary review" }, ctx);
	assert.deepEqual(calls, [
		["primary-1", { model: { provider: "anthropic", modelId: "claude-opus-5-5" } }],
		["primary-1", { thinkingLevel: "xhigh" }],
		["primary-1", { name: "primary review" }],
	]);
});
