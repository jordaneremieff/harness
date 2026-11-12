/**
 * One real Pi SDK session over an isolated agent home, with the Agent extension, a scripted
 * provider that records the message array of every request, and an agent host stand-in that
 * answers admissions in process. No real provider, network, host process, or operator store.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { createAssistantMessageEventStream, type AssistantMessage, type Message, type ToolCall, type TranscriptContext } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager, getPackageDir, type AgentSession, type ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { obj } from "@earendil-works/pi-schema";
import { ORDINARY_CONTINUITY_ENTRY, type ContinuityFact } from "./continuity-facts.ts";
import type { HostConnection } from "./host-client.ts";
import type { HostMetadata } from "./host-protocol.ts";
import register from "./index.ts";
import { AgentManager } from "./manager.ts";
import { connectPrimaryChannel } from "./primary-channel.ts";
import { machineConfig } from "./settings-fixture.mts";
import { createTestRuntime, testModel } from "./test-runtime.mts";
import { HOST_CONTRACT } from "./version-contract.ts";

const NOTE = /^Host-held continuity facts from the Agent extension for context head entry ([^.\s]+)\./u;

export function messageText(message: Message | undefined): string {
	if (message === undefined) return "";
	return typeof message.content === "string" ? message.content : JSON.stringify(message.content);
}
/** Positions of continuity notes in one provider request. */
export function noteIndexes(messages: readonly Message[]): number[] {
	return messages.flatMap((message, index) => message.role === "user" && NOTE.test(messageText(message)) ? [index] : []);
}
/** The context head entry ID that a note names. */
export function noteHead(message: Message | undefined): string | undefined { return NOTE.exec(messageText(message))?.[1]; }
export function conversation(messages: readonly Message[]): Message[] { return messages.filter((message) => message.role !== "system"); }

/** One provider answer: a tool call or a final text, with the context tokens the provider reports. */
export interface ScriptStep {
	readonly tool?: readonly [string, ToolCall["arguments"]] | (() => readonly [string, ToolCall["arguments"]]);
	readonly text?: string;
	readonly tokens?: number;
}
export interface OrdinarySessionOptions {
	/** Pi's automatic threshold compaction. Manual compaction works without it. */
	readonly autoCompaction?: boolean;
	/** Planning budget of the session's exact model, in tokens. */
	readonly budget?: number;
	/** Extensions loaded before and after the Agent extension, in handler order. */
	readonly before?: readonly ExtensionFactory[];
	readonly after?: readonly ExtensionFactory[];
	/** Answers of the agent host stand-in; the default admits every task with a fresh submission. */
	readonly host?: (method: string, params: Record<string, unknown>) => unknown;
	/** Further isolated environment values, restored when the test ends. */
	readonly env?: Readonly<Record<string, string>>;
}

function hostStandIn(metadata: HostMetadata, handler: (method: string, params: Record<string, unknown>) => unknown): HostConnection {
	let closed = false;
	const listeners = new Set<() => void>();
	return {
		pid: process.pid, socketPath: join(metadata.storagePath, "stand-in.sock"), storageId: metadata.storageId, metadata, runtimeContract: HOST_CONTRACT,
		get closed() { return closed; },
		async request(method, params) { return handler(method, (params ?? {}) as Record<string, unknown>); },
		onClose(callback) { listeners.add(callback); return () => { listeners.delete(callback); }; },
		async subscribeChanges() { return () => {}; },
		async close() { if (closed) return; closed = true; for (const listener of [...listeners]) listener(); },
	} as HostConnection;
}

export async function ordinarySession(t: TestContext, options: OrdinarySessionOptions = {}) {
	// A short root keeps the primary socket below the platform pathname limit.
	const root = realpathSync(mkdtempSync("/tmp/pi-oc-"));
	const cwd = join(root, "work"), agentDir = join(root, "agent"), sessionsRoot = join(root, "sessions");
	mkdirSync(cwd); mkdirSync(agentDir); mkdirSync(sessionsRoot);
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({
		cacheWarming: "off", retry: { enabled: false },
		// A short conversation needs a cut point for every compaction.
		compaction: { enabled: options.autoCompaction === true, reserveTokens: 16000, keepRecentTokens: 1 },
	}));
	const harnessFile = join(agentDir, "harness.json");
	const preferences = options.budget === undefined ? {} : { contextBudgetTokens: { [`${testModel.provider}/${testModel.id}`]: options.budget } };
	writeFileSync(harnessFile, JSON.stringify(machineConfig({ presets: {}, preferences })));
	const env = { ...options.env, PI_AGENT_DIR: agentDir, PI_CODING_AGENT_DIR: agentDir, PI_AGENT_SESSIONS_DIR: sessionsRoot, PI_HARNESS_FILE: harnessFile };
	const saved = new Map(Object.keys(env).map((key) => [key, process.env[key]]));
	Object.assign(process.env, env);

	const owners = (globalThis as unknown as Record<symbol, { managers: Map<string, AgentManager> }>)[Symbol.for("pi.extension.agent.owners")];
	let submissions = 0;
	const admit = (method: string, params: Record<string, unknown>): unknown => {
		if (method !== "task-submit") return {};
		const submissionId = ++submissions, sessionId = String(params.sessionId);
		return { submissionId, identity: sessionId, requestId: params.requestId, result: { sessionId, submissionId, requestId: params.requestId } };
	};
	const installManager = (): AgentManager => {
		const manager = new AgentManager({ root: sessionsRoot, agentDir, packageDir: getPackageDir(), acquire: async (metadata) => hostStandIn(metadata, options.host ?? admit) });
		owners.managers.set(sessionsRoot, manager);
		return manager;
	};
	let manager = installManager();
	const target = manager.catalog.create({ cwd, agentDir, packageDir: getPackageDir(), model: { provider: testModel.provider, modelId: testModel.id }, thinkingLevel: "off", ownerId: "another-owner" }).storageId;

	const requests: TranscriptContext[] = [];
	const script: ScriptStep[] = [];
	const state = { summary: "Synthetic compaction summary", calls: 0 };
	const runtime = await createTestRuntime();
	const stream = (_model: unknown, context: TranscriptContext) => {
		requests.push(structuredClone(context));
		const step = script.shift() ?? { text: "DONE" };
		const tool = typeof step.tool === "function" ? step.tool() : step.tool;
		const reason = tool === undefined ? "stop" : "toolUse", tokens = step.tokens ?? 2;
		const message: AssistantMessage = {
			role: "assistant", api: testModel.api, provider: testModel.provider, model: testModel.id,
			content: tool === undefined ? [{ type: "text", text: step.text ?? "DONE" }] : [{ type: "toolCall", id: `call-${++state.calls}`, name: tool[0], arguments: tool[1] }],
			stopReason: reason, timestamp: Date.now(),
			usage: { input: tokens - 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: tokens, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		};
		const events = createAssistantMessageEventStream();
		events.push({ type: "start", partial: message });
		events.push({ type: "done", reason, message });
		events.end(message);
		return events;
	};
	runtime.registerNativeProvider({
		id: testModel.provider, name: "Ordinary continuity test provider", getModels: () => [testModel],
		auth: { apiKey: { name: "Test", check: async () => ({ type: "api_key" }), resolve: async () => ({ auth: {} }) } },
		stream, streamSimple: stream,
	});
	const settingsManager = SettingsManager.create(cwd, agentDir);
	let sessionManager = SessionManager.create(cwd, sessionsRoot);
	const loader = new DefaultResourceLoader({
		cwd, agentDir, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
		extensionFactories: [
			...(options.before ?? []),
			async (pi) => { await register(pi); },
			...(options.after ?? []),
			(pi) => {
				pi.registerTool({ name: "probe", label: "Probe", description: "Return one fixed line", parameters: obj({}, { open: true }), async execute() { return { content: [{ type: "text", text: "PROBE_RESULT" }], details: {} }; } });
				// Every Pi compaction path takes its summary from the test, never from a summarizer request.
				pi.on("session_before_compact", (event) => ({ compaction: { summary: state.summary, firstKeptEntryId: event.preparation.firstKeptEntryId, tokensBefore: event.preparation.tokensBefore } }));
			},
		],
	});
	const tools = ["agent_send", "agent_steer", "agent_compact", "probe"];
	const open = async (): Promise<AgentSession> => {
		await loader.reload();
		assert.deepEqual(loader.getExtensions().errors, []);
		const created = (await createAgentSession({ cwd, agentDir, modelRuntime: runtime, settingsManager, sessionManager, model: testModel, resourceLoader: loader, tools })).session;
		await created.bindExtensions({});
		return created;
	};
	let session = await open();
	const close = async (): Promise<void> => {
		try { await session.abort(); }
		finally { owners.managers.get(sessionsRoot)?.close(); owners.managers.delete(sessionsRoot); session.dispose(); }
	};
	t.after(async () => {
		try { await close(); }
		finally {
			for (const [key, value] of saved) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
			rmSync(root, { recursive: true, force: true });
		}
	});
	return {
		get session() { return session; }, get sessionManager() { return sessionManager; }, get manager() { return manager; },
		requests, script, state, target, sessionsRoot,
		/** Run one prompt to its end and return the provider requests it caused. */
		async prompt(text: string): Promise<TranscriptContext[]> {
			const from = requests.length;
			await session.prompt(text); await session.waitForIdle();
			return requests.slice(from);
		},
		/** Reopen the same session file in a fresh session with a fresh manager. */
		async restart(): Promise<void> {
			const path = sessionManager.getSessionFile(); assert.ok(path);
			await close();
			manager = installManager();
			sessionManager = SessionManager.open(path, sessionsRoot);
			session = await open();
		},
		/** Deliver one result body to the session; false while its retained entry is not confirmed. */
		async deliver(sourceId: string, text: string, details: Record<string, unknown> = {}): Promise<boolean> {
			const connection = await connectPrimaryChannel({ id: sessionManager.getSessionId(), sessionsRoot });
			try { await connection.deliver({ sourceId, text, details: { sourceId, wake: true, ...details } }); return true; }
			catch (error) { if (/Primary delivery awaits/u.test(String(error))) return false; throw error; }
			finally { await connection.close(); }
		},
		facts(): ContinuityFact[] {
			return sessionManager.getEntries().flatMap((entry) => entry.type === "custom" && entry.customType === ORDINARY_CONTINUITY_ENTRY ? [entry.data as ContinuityFact] : []);
		},
		/** Entry IDs of the session's compaction heads, oldest first. */
		heads(): string[] { return sessionManager.getEntries().flatMap((entry) => entry.type === "compaction" ? [entry.id] : []); },
	};
}
