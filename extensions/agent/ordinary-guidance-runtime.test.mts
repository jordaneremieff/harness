import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { it, type TestContext } from "node:test";
import { createAssistantMessageEventStream, getCurrentSystemMessage, getCurrentSystemPrompt, type AssistantMessage, type TranscriptContext } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager, type AgentSession, type BeforeAgentStartEvent } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import register from "./index.ts";
import type { AgentManager } from "./manager.ts";
import { connectPrimaryChannel } from "./primary-channel.ts";
import { machineConfig } from "./settings-fixture.mts";
import { createTestRuntime, testModel } from "./test-runtime.mts";

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => { resolve = done; });
	return { promise, resolve };
}

async function guidanceFixture(t: TestContext, holdStartup = false) {
	// Keep the primary socket below the platform pathname limit.
	const root = realpathSync(mkdtempSync("/tmp/pi-og-"));
	const cwd = join(root, "work");
	const agentDir = join(root, "agent");
	const sessionsRoot = join(root, "sessions");
	mkdirSync(cwd); mkdirSync(agentDir); mkdirSync(sessionsRoot);
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ cacheWarming: { mode: "off" }, retry: { enabled: false }, compaction: { enabled: false } }));
	const harnessFile = join(agentDir, "harness.json");
	writeFileSync(harnessFile, JSON.stringify(machineConfig({ presets: {}, preferences: { reportingNotes: "PEER_RUN_GUIDANCE" } })));
	const saved = new Map(["PI_AGENT_DIR", "PI_CODING_AGENT_DIR", "PI_AGENT_SESSIONS_DIR", "PI_HARNESS_FILE"].map((key) => [key, process.env[key]]));
	process.env.PI_AGENT_DIR = agentDir;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	process.env.PI_AGENT_SESSIONS_DIR = sessionsRoot;
	process.env.PI_HARNESS_FILE = harnessFile;
	const entered = deferred();
	const gate = deferred();
	let session: AgentSession | undefined;
	const owners = (globalThis as unknown as Record<symbol, { managers: Map<string, AgentManager> }>)[Symbol.for("pi.extension.agent.owners")];
	t.after(async () => {
		gate.resolve();
		try {
			try { await session?.abort(); }
			finally {
				owners.managers.get(sessionsRoot)?.close();
				owners.managers.delete(sessionsRoot);
				session?.dispose();
			}
		} finally {
			for (const [key, value] of saved) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
			rmSync(root, { recursive: true, force: true });
		}
	});
	const starts: BeforeAgentStartEvent[] = [];
	const requests: TranscriptContext[] = [];
	let toolCalls = 0;
	const runtime = await createTestRuntime();
	const stream = (_model: unknown, context: TranscriptContext) => {
		requests.push(structuredClone(context));
		const first = requests.length === 1;
		const reason = first ? "toolUse" : "stop";
		const message: AssistantMessage = {
			role: "assistant", api: testModel.api, provider: testModel.provider, model: testModel.id,
			content: first ? [{ type: "toolCall", id: "peer-evidence", name: "guidance_evidence", arguments: {} }] : [{ type: "text", text: "PEER_RESULT_COMPLETE" }],
			stopReason: reason, timestamp: Date.now(),
			usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		};
		const events = createAssistantMessageEventStream();
		events.push({ type: "start", partial: message });
		events.push({ type: "done", reason, message });
		events.end(message);
		return events;
	};
	runtime.registerNativeProvider({
		id: testModel.provider, name: "Ordinary guidance test provider", getModels: () => [testModel],
		auth: { apiKey: { name: "Test", check: async () => ({ type: "api_key" }), resolve: async () => ({ auth: {} }) } },
		stream, streamSimple: stream,
	});
	const settingsManager = SettingsManager.create(cwd, agentDir);
	const sessionManager = SessionManager.create(cwd, sessionsRoot);
	const loader = new DefaultResourceLoader({
		cwd, agentDir, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
		extensionFactories: [(pi) => {
			register(pi);
			pi.registerTool({
				name: "guidance_evidence", label: "Guidance evidence", description: "Return evidence for the peer result", parameters: Type.Object({}),
				async execute() { toolCalls++; return { content: [{ type: "text", text: "PEER_TOOL_EVIDENCE" }], details: {} }; },
			});
			pi.on("before_agent_start", async (event) => {
				starts.push(event);
				if (holdStartup && starts.length === 1) { entered.resolve(); await gate.promise; }
			});
		}],
	});
	await loader.reload();
	assert.deepEqual(loader.getExtensions().errors, []);
	session = (await createAgentSession({ cwd, agentDir, modelRuntime: runtime, settingsManager, sessionManager, model: testModel, resourceLoader: loader, tools: ["guidance_evidence"] })).session;
	await session.bindExtensions({});
	const primary = session;
	return {
		session: primary, sessionManager, starts, requests, entered: entered.promise, release: gate.resolve, toolCalls: () => toolCalls,
		async deliver(sourceId: string, text: string) {
			const connection = await connectPrimaryChannel({ id: sessionManager.getSessionId(), sessionsRoot });
			try { await connection.deliver({ sourceId, text, details: { sourceId, wake: true } }); }
			finally { await connection.close(); }
		},
	};
}

function assertRunGuidance(requests: TranscriptContext[]) {
	assert.equal(requests.length, 2, "the tool result causes one subsequent provider request");
	for (const context of requests) {
		const sections = getCurrentSystemMessage(context.messages)?.sections;
		assert.match(sections?.["agent-preferences"] ?? "", /PEER_RUN_GUIDANCE/u);
		assert.match(sections?.["agent-efforts"] ?? "", /No other live efforts or active thread hints in the covered sources/u);
		assert.match(getCurrentSystemPrompt(context.messages) ?? "", /PEER_RUN_GUIDANCE/u);
	}
	assert.equal(getCurrentSystemMessage(requests[1].messages)?.sections?.["agent-preferences"], getCurrentSystemMessage(requests[0].messages)?.sections?.["agent-preferences"]);
	assert.equal(getCurrentSystemMessage(requests[1].messages)?.sections?.["agent-efforts"], getCurrentSystemMessage(requests[0].messages)?.sections?.["agent-efforts"]);
	assert.ok(requests[1].messages.some((message) => message.role === "toolResult" && message.toolCallId === "peer-evidence" && JSON.stringify(message.content).includes("PEER_TOOL_EVIDENCE")));
}

it("ordinary peer-result runs supply agent guidance on the first request and after a tool result", { timeout: 20000 }, async (t) => {
	const fixture = await guidanceFixture(t);
	await fixture.deliver("peer:result", "PEER_ASYNC_RESULT");
	await fixture.session.waitForIdle();
	assert.equal(fixture.starts.length, 1);
	const start = fixture.starts[0];
	assert.equal(start.messageType, "custom");
	if (start.messageType !== "custom") assert.fail("peer delivery must start a custom-message run");
	assert.equal(start.message.customType, "agent.peer");
	assert.equal(start.message.content, "PEER_ASYNC_RESULT");
	assert.deepEqual(start.message.details, { sourceId: "peer:result", wake: true });
	assert.equal(fixture.toolCalls(), 1);
	assertRunGuidance(fixture.requests);
	assert.ok(fixture.requests[0].messages.some((message) => message.role === "user" && Array.isArray(message.content) && message.content.some((part) => part.type === "text" && part.text === "PEER_ASYNC_RESULT")));
	assert.ok(fixture.sessionManager.getEntries().some((entry) => entry.type === "message" && entry.message.role === "assistant" && JSON.stringify(entry.message.content).includes("PEER_RESULT_COMPLETE")));
});

it("ordinary peer-result startup stays busy and honors abort before the first provider request", { timeout: 20000 }, async (t) => {
	const fixture = await guidanceFixture(t, true);
	await fixture.deliver("peer:first", "FIRST_PEER_RESULT");
	await fixture.entered;
	assert.equal(fixture.session.isStreaming, true, "before_agent_start is part of the active run");
	assert.equal(fixture.session.isIdle, false);
	assert.equal(fixture.requests.length, 0);
	await fixture.deliver("peer:second", "QUEUED_PEER_RESULT");
	assert.equal(fixture.starts.length, 1, "a peer result during startup steers the existing run");
	let aborted = false;
	const abort = fixture.session.abort().then(() => { aborted = true; });
	await Promise.resolve();
	assert.equal(aborted, false, "abort waits for startup to leave its controlled hook");
	fixture.release();
	await abort;
	assert.equal(fixture.session.isIdle, true);
	assert.equal(fixture.requests.length, 0, "startup abort prevents provider access");
	assert.equal(fixture.toolCalls(), 0);
	await fixture.deliver("peer:resume", "RESUMED_PEER_RESULT");
	await fixture.session.waitForIdle();
	assert.equal(fixture.starts.length, 2, "a later peer result starts a fresh run");
	assert.equal(fixture.toolCalls(), 1);
	assertRunGuidance(fixture.requests);
});
