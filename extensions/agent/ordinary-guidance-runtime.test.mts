import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { AgentCatalog } from "./catalog.ts";
import { AgentDeliveryDoc } from "./durable-controls.ts";
import { DurableHost } from "./durable-host.ts";
import { fixtureRegistry, fixtureRuntime } from "./durable-host-fixture.mts";
import { startDurableDelivery } from "./durable-delivery.ts";
import type { HostMetadata } from "./host-protocol.ts";
import { eventLog, waitForProcessExit } from "./host-fixture.mts";
import { join } from "node:path";
import { it, type TestContext } from "node:test";
import { createAssistantMessageEventStream, getCurrentSystemMessage, getCurrentSystemPrompt, type AssistantMessage, type TranscriptContext } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager, getPackageDir, type AgentSession, type BeforeAgentStartEvent } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import register from "./index.ts";
import { AgentManager } from "./manager.ts";
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
	let sessionManager = SessionManager.create(cwd, sessionsRoot);
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
		get session() { return session ?? primary; }, get sessionManager() { return sessionManager; }, cwd, agentDir, sessionsRoot, starts, requests, entered: entered.promise, release: gate.resolve, toolCalls: () => toolCalls,
		async restart(retainedPath?: string) {
			const path = retainedPath ?? sessionManager.getSessionFile(); assert.ok(path);
			gate.resolve(); await session?.abort(); session?.dispose();
			owners.managers.get(sessionsRoot)?.close(); owners.managers.delete(sessionsRoot);
			sessionManager = SessionManager.open(path, sessionsRoot);
			await loader.reload();
			session = (await createAgentSession({ cwd, agentDir, modelRuntime: runtime, settingsManager, sessionManager, model: testModel, resourceLoader: loader, tools: ["guidance_evidence"] })).session;
			await session.bindExtensions({});
		},
		async direct(method: "submit" | "report", sourceId: string, origin: "operator" | "model" = "model") {
			const manager = new AgentManager({ root: sessionsRoot, agentDir, packageDir: getPackageDir() });
			try { return await manager.control(method, { sessionId: sessionManager.getSessionId(), message: "DIRECT_NOTICE", requestId: sourceId, origin }, { id: "00000000-0000-4000-8000-000000000001", cwd }) as { admitted: boolean; boundary: string }; }
			finally { manager.close(); }
		},
		async deliver(sourceId: string, text: string, wake = true) {
			const connection = await connectPrimaryChannel({ id: sessionManager.getSessionId(), sessionsRoot });
			try { await connection.deliver({ sourceId, text, details: { sourceId, wake } }); return true; }
			catch (error) { if (/Primary delivery awaits/u.test(String(error))) return false; throw error; }
			finally { await connection.close(); }
		},
		retained(sourceId: string) {
			const path = sessionManager.getSessionFile();
			if (!path || !existsSync(path)) return [];
			return readFileSync(path, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as { type: string; customType?: string; details?: { sourceId?: string } }).filter((entry) => entry.type === "custom_message" && entry.customType === "agent.peer" && entry.details?.sourceId === sourceId);
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

it("refuses busy volatile delivery, retries once after same-ID reopen, and confirms disk before acceptance", { timeout: 20000 }, async (t) => {
	const fixture = await guidanceFixture(t);
	const child = spawn(process.execPath, [fileURLToPath(new URL("./primary-retention-fixture.mts", import.meta.url)), fixture.cwd, fixture.agentDir, fixture.sessionsRoot], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
	let stderr = ""; child.stderr?.on("data", (bytes: Buffer) => { stderr = (stderr + bytes.toString()).slice(-4096); });
	t.after(async () => { if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await waitForProcessExit(child); } });
	const [value] = await once(child, "message", { signal: AbortSignal.timeout(10000) });
	const ready = value as { metadata: HostMetadata; ownerId: string; sessionFile: string; sourceId: string; acknowledged: boolean; independentAcknowledged: boolean; queued: number };
	assert.equal(ready.acknowledged, false, `busy queue alone is not acknowledgment: ${stderr}`);
	assert.equal(ready.queued, 1);
	assert.equal(ready.independentAcknowledged, true, "a pending primary does not block another owner");
	const connection = await connectPrimaryChannel({ id: ready.ownerId, sessionsRoot: fixture.sessionsRoot });
	try { await assert.rejects(connection.deliver({ sourceId: ready.sourceId, text: "VOLATILE_NOTICE", details: { wake: true } }), /Primary delivery awaits/u); }
	finally { await connection.close(); }
	child.kill("SIGKILL"); await waitForProcessExit(child);
	await fixture.restart(ready.sessionFile);
	assert.equal(fixture.sessionManager.getSessionId(), ready.ownerId);
	assert.equal(fixture.retained(ready.sourceId).length, 0);
	const source = await DurableHost.open({ storagePath: ready.metadata.storagePath, storageId: ready.metadata.storageId, cwd: fixture.cwd, models: await fixtureRuntime("answer"), registry: fixtureRegistry(), agent: { model: ready.metadata.model } });
	const passes = eventLog<void>();
	const watcher = startDurableDelivery({ host: source, metadata: ready.metadata, catalog: new AgentCatalog(fixture.sessionsRoot), sessionsRoot: fixture.sessionsRoot, signal: new AbortController().signal, retryDelayMs: 60_000, onIdle: () => passes.push(undefined) });
	t.after(async () => { await watcher.close(); await source.close(); });
	await passes.waitForCount(1); await fixture.session.waitForIdle();
	watcher.refresh(); await passes.waitForCount(passes.length + 1);
	assert.equal((await source.harness.snapshot(AgentDeliveryDoc, BACKGROUND_CONTEXT))?.reports[0]?.acknowledged, true);
	assert.equal(fixture.retained(ready.sourceId).length, 1);
	await fixture.restart();
	assert.equal(await fixture.deliver(ready.sourceId, "VOLATILE_NOTICE"), true, "retained retry does not enqueue another notice");
	assert.equal(fixture.retained(ready.sourceId).length, 1);
	assert.equal(fixture.session.isIdle, true);
});

it("keeps custom-only passive delivery pending until Pi flushes its first conversation", { timeout: 20000 }, async (t) => {
	const fixture = await guidanceFixture(t);
	assert.equal(await fixture.deliver("peer:passive", "PASSIVE_NOTICE", false), false);
	assert.equal(fixture.sessionManager.getEntries().filter((entry) => entry.type === "custom_message").length, 1);
	assert.equal(fixture.retained("peer:passive").length, 0);
	assert.equal(await fixture.deliver("peer:passive", "PASSIVE_NOTICE", false), false);
	assert.equal(fixture.sessionManager.getEntries().filter((entry) => entry.type === "custom_message").length, 1);
	await fixture.session.prompt("Flush the first conversation");
	assert.equal(await fixture.deliver("peer:passive", "PASSIVE_NOTICE", false), true);
	assert.equal(fixture.retained("peer:passive").length, 1);
	assert.equal(await fixture.deliver("peer:idle-passive", "IDLE_PASSIVE", false), true);
	assert.equal(fixture.retained("peer:idle-passive").length, 1);
});

it("preserves one retained notice when startup aborts before provider work", { timeout: 20000 }, async (t) => {
	const fixture = await guidanceFixture(t, true);
	const work = fixture.session.prompt("Hold startup"); await fixture.entered;
	assert.equal(await fixture.deliver("peer:aborted", "ABORTED_NOTICE"), false);
	const abort = fixture.session.abort(); fixture.release(); await abort; await work;
	await fixture.deliver("peer:aborted", "ABORTED_NOTICE"); await fixture.session.waitForIdle();
	assert.equal(await fixture.deliver("peer:aborted", "ABORTED_NOTICE"), true);
	assert.equal(fixture.retained("peer:aborted").length, 1);
});

for (const method of ["submit", "report"] as const) for (const busy of [false, true]) it(`admits direct ordinary ${method} to a ${busy ? "busy" : "idle"} SDK primary without a source ledger`, { timeout: 20000 }, async (t) => {
	const fixture = await guidanceFixture(t, busy);
	const work = busy ? fixture.session.prompt("Hold startup") : Promise.resolve();
	if (busy) await fixture.entered;
	const result = await fixture.direct(method, `direct:${method}`);
	assert.equal(result.admitted, true);
	assert.match(result.boundary, /Queued admission.*retention/u);
	if (busy) {
		assert.equal(fixture.retained(`direct:${method}`).length, 0);
		assert.equal(fixture.session.agent.peekQueuedMessages().length, 1);
		assert.equal((await fixture.direct(method, `direct:${method}`)).admitted, true);
		assert.equal(await fixture.deliver(`direct:${method}`, "DIRECT_NOTICE"), false, "queued dedup is not retained acceptance");
		assert.equal(fixture.session.agent.peekQueuedMessages().length, 1, "an upgraded retention request reuses the admitted attempt");
	}
	fixture.release(); await work; await fixture.session.waitForIdle();
	assert.equal(fixture.retained(`direct:${method}`).length, 1);
	assert.equal(await fixture.deliver(`direct:${method}`, "DIRECT_NOTICE"), true);
});

it("admits a passive direct message to a custom-only primary without claiming retention", { timeout: 20000 }, async (t) => {
	const fixture = await guidanceFixture(t);
	assert.equal((await fixture.direct("submit", "direct:passive", "operator")).admitted, true);
	assert.equal(fixture.retained("direct:passive").length, 0);
	assert.equal(await fixture.deliver("direct:passive", "DIRECT_NOTICE", false), false);
	assert.equal(fixture.sessionManager.getEntries().filter((entry) => entry.type === "custom_message").length, 1);
	await fixture.session.prompt("Flush first conversation");
	assert.equal(await fixture.deliver("direct:passive", "DIRECT_NOTICE", false), true);
	assert.equal(fixture.retained("direct:passive").length, 1);
});

it("refuses an append-before-persist failure and retries after the write becomes available", { timeout: 20000 }, async (t) => {
	const fixture = await guidanceFixture(t);
	fixture.sessionManager.appendMessage({ role: "user", content: "Retained seed", timestamp: Date.now() });
	const path = fixture.sessionManager.getSessionFile(); assert.ok(path);
	const backup = `${path}.saved`, append = fixture.sessionManager.appendCustomMessageEntry.bind(fixture.sessionManager);
	const failure = t.mock.method(fixture.sessionManager, "appendCustomMessageEntry", (...args: Parameters<typeof append>) => {
		renameSync(path, backup); mkdirSync(path);
		try { return append(...args); }
		finally { rmSync(path, { recursive: true, force: true }); renameSync(backup, path); }
	});
	assert.equal(await fixture.deliver("peer:write-failure", "RETRY_WRITE", false), false);
	assert.equal(fixture.sessionManager.getEntries().filter((entry) => entry.type === "custom_message").length, 1, "Pi keeps the failed append in memory");
	assert.equal(fixture.retained("peer:write-failure").length, 0, "memory is not write confirmation");
	failure.mock.restore();
	assert.equal(await fixture.deliver("peer:write-failure", "RETRY_WRITE", false), true);
	assert.equal(await fixture.deliver("peer:write-failure", "RETRY_WRITE", false), true);
	assert.equal(fixture.retained("peer:write-failure").length, 1);
});
