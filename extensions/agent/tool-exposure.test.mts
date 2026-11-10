/**
 * Agent tool exposure tests: default declarations, public discovery, and the
 * model-only boundary for ordinary sessions.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { it, type TestContext } from "node:test";
import {
	createAssistantMessageEventStream,
	getCurrentSystemPrompt,
	getCurrentTools,
	type AssistantMessage,
	type JsonObject,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import {
	createAgentSession,
	createToolSearchExtension,
	DefaultResourceLoader,
	SessionManager,
	SettingsManager,
	type AgentSession,
} from "@earendil-works/pi-coding-agent";
import register from "./index.ts";
import type { AgentManager } from "./manager.ts";
import { createTestRuntime, testModel } from "./test-runtime.mts";

const USAGE = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

function streamed(message: AssistantMessage) {
	const events = createAssistantMessageEventStream();
	events.push({ type: "start", partial: message });
	events.push({ type: "done", reason: message.stopReason === "toolUse" ? "toolUse" : "stop", message });
	events.end(message);
	return events;
}

function toolCall(name: string, args: JsonObject, id: string): AssistantMessage {
	return { role: "assistant", api: testModel.api, provider: testModel.provider, model: testModel.id, content: [{ type: "toolCall", id, name, arguments: args }], stopReason: "toolUse", timestamp: Date.now(), usage: USAGE };
}

function answer(text: string): AssistantMessage {
	return { role: "assistant", api: testModel.api, provider: testModel.provider, model: testModel.id, content: [{ type: "text", text }], stopReason: "stop", timestamp: Date.now(), usage: USAGE };
}

async function ordinaryFixture(t: TestContext) {
	const root = realpathSync(mkdtempSync("/tmp/pi-exposure-"));
	const cwd = join(root, "work");
	const agentDir = join(root, "agent");
	const sessionsRoot = join(root, "sessions");
	mkdirSync(cwd);
	mkdirSync(agentDir);
	mkdirSync(sessionsRoot);
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({
		cacheWarming: "off",
		retry: { enabled: false },
		compaction: { enabled: false },
		defaultTools: ["+codemode", "+tool_search"],
	}));
	writeFileSync(join(agentDir, "harness.json"), "{}");
	const saved = new Map(["PI_AGENT_DIR", "PI_CODING_AGENT_DIR", "PI_AGENT_SESSIONS_DIR", "PI_HARNESS_FILE"].map((key) => [key, process.env[key]]));
	process.env.PI_AGENT_DIR = agentDir;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	process.env.PI_AGENT_SESSIONS_DIR = sessionsRoot;
	process.env.PI_HARNESS_FILE = join(agentDir, "harness.json");
	const owners = (globalThis as unknown as Record<symbol, { managers: Map<string, AgentManager> }>)[Symbol.for("pi.extension.agent.owners")];
	let session: AgentSession | undefined;
	t.after(async () => {
		try {
			session?.dispose();
			owners.managers.get(sessionsRoot)?.close();
			owners.managers.delete(sessionsRoot);
		} finally {
			for (const [key, value] of saved) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
			rmSync(root, { recursive: true, force: true });
		}
	});
	const requests: TranscriptContext[] = [];
	const runtime = await createTestRuntime();
	const stream = (_model: unknown, context: TranscriptContext) => {
		requests.push(structuredClone(context));
		const results = context.messages.filter((message) => message.role === "toolResult");
		if (!results.some((result) => result.toolName === "tool_search")) return streamed(toolCall("tool_search", { query: "list retained agent sessions" }, "search-agents"));
		if (!results.some((result) => result.toolName === "agent_list")) return streamed(toolCall("agent_list", {}, "list-agents"));
		return streamed(answer("EXPOSURE_RESULT_COMPLETE"));
	};
	runtime.registerNativeProvider({
		id: testModel.provider,
		name: "Agent exposure test provider",
		getModels: () => [testModel],
		auth: { apiKey: { name: "Test", check: async () => ({ type: "api_key" }), resolve: async () => ({ auth: {} }) } },
		stream,
		streamSimple: stream,
	});
	const settingsManager = SettingsManager.create(cwd, agentDir);
	const sessionManager = SessionManager.create(cwd, sessionsRoot);
	const loader = new DefaultResourceLoader({
		cwd,
		agentDir,
		settingsManager,
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		extensionFactories: [async (pi) => { await register(pi); }, createToolSearchExtension()],
	});
	await loader.reload();
	assert.deepEqual(loader.getExtensions().errors, []);
	session = (await createAgentSession({
		cwd,
		agentDir,
		modelRuntime: runtime,
		settingsManager,
		sessionManager,
		model: testModel,
		resourceLoader: loader,
	})).session;
	await session.bindExtensions({});
	return { session, settingsManager, requests };
}

it("offers tool_search by configuration while deferred controls stay undeclared until discovery", { timeout: 30000 }, async (t) => {
	const { session, settingsManager, requests } = await ordinaryFixture(t);
	assert.ok(settingsManager.getDefaultTools()?.includes("tool_search"), "the real SettingsManager resolves the recommended selection");
	assert.ok(settingsManager.getDefaultTools()?.includes("codemode"));
	const exposure = new Map(session.getAllTools().map((tool) => [tool.name, tool.exposure]));
	assert.equal(exposure.get("agent_spawn"), "direct");
	assert.equal(exposure.get("agent_compact"), "model-only");
	for (const name of ["agent_inspect", "agent_list", "agent_attach", "agent_place", "agent_fork", "agent_rewind", "agent_reset", "agent_configure", "agent_profile", "agent_command"])
		assert.equal(exposure.get(name), "deferred", name);
	assert.ok(session.getActiveToolNames().includes("tool_search"));
	for (const name of ["agent_inspect", "agent_list", "agent_profile"]) assert.ok(!session.getActiveToolNames().includes(name), `${name} starts undeclared`);
	assert.ok(session.getCallableToolNames().includes("agent_list"), "a deferred control remains callable from tools");
	assert.ok(!session.getCallableToolNames().includes("agent_compact"), "a model-only control is never callable from tools");

	await session.prompt("Find the retained agent tools and use them");
	await session.waitForIdle();
	assert.equal(requests.length, 3, "tool discovery and the loaded control each cause one request");
	assert.ok(!getCurrentTools(requests[0].messages).some((tool) => tool.name === "agent_list"), "the deferred control is not declared first");
	assert.ok(!getCurrentSystemPrompt(requests[0].messages).includes("Find retained agent sessions"), "deferred guidance is absent while the control is undeclared");
	assert.ok(getCurrentTools(requests[1].messages).some((tool) => tool.name === "agent_list"), "tool_search declares the loaded control");
	assert.ok(getCurrentSystemPrompt(requests[1].messages).includes("Find retained agent sessions"), "the loaded control carries its guidance");
	assert.ok(session.getActiveToolNames().includes("agent_list"));
	const listed = session.messages.find((message) => message.role === "toolResult" && message.toolName === "agent_list");
	if (listed?.role !== "toolResult") assert.fail("the loaded control executes");
	assert.equal(listed.isError, false);
});
