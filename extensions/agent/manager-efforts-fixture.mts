import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createAssistantMessageEventStream, type AssistantMessage, type JsonObject, type TranscriptContext } from "@earendil-works/pi-ai";
import { DefaultResourceLoader, SessionManager, SettingsManager, createAgentSession, type AgentSession } from "@earendil-works/pi-coding-agent";
import { createTestRuntime, testModel } from "./test-runtime.mts";
import { agentRestartHosts } from "./index.ts";

interface Command { readonly id: number; readonly type: string; readonly [key: string]: unknown }
interface FixtureMessage { readonly type: string; readonly [key: string]: unknown }
interface FixtureManager {
	awareness(ownerId: string, cwd?: string): Promise<unknown>;
	control(method: string, input: Record<string, unknown>, caller: { id: string; cwd: string }): Promise<unknown>;
}
interface FixtureServices {
	readonly session: AgentSession;
	readonly sessionManager: SessionManager;
	readonly id: string;
	readonly cwd: string;
	readonly sessionsRoot: string;
	readonly customEntries: () => Array<{ customType?: string; content?: unknown; details?: unknown }>;
	readonly totalRequests: () => number;
	readonly setAction: (action: "publish" | "clear" | undefined) => void;
}

const indexPath = fileURLToPath(new URL("./index.ts", import.meta.url));
const wrapper = `import register from ${JSON.stringify(indexPath)};\nexport default function (pi) { register(pi); }\n`;

function send(message: FixtureMessage): void {
	if (process.send) process.send(message);
}

function assistantMessage(content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"]): AssistantMessage {
	return {
		role: "assistant", api: testModel.api, provider: testModel.provider, model: testModel.id,
		content, stopReason, timestamp: Date.now(),
		usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
	};
}

function intentArguments(action: "publish" | "clear" | undefined): JsonObject | undefined {
	if (action === undefined) return undefined;
	if (action === "clear") return { action };
	return {
		action,
		purpose: "Review the shared parser",
		integration: "Send findings to the other primary before merge",
		authority: "Operator asked for an isolated effort regression",
		scope: { paths: ["src/parser"], branches: ["topic/parser"], fullGate: true },
		contactThread: "thread-parser-review",
	};
}

function effortSections(context: TranscriptContext): string[] {
	return context.messages.filter((message) => message.role === "system").flatMap((message) => {
		const section = message.sections?.["agent-efforts"];
		return typeof section === "string" ? [section] : [];
	});
}

function scriptedStream(message: AssistantMessage): ReturnType<typeof createAssistantMessageEventStream> {
	const events = createAssistantMessageEventStream();
	events.push({ type: "start", partial: message });
	events.push({ type: "done", reason: message.stopReason === "toolUse" ? "toolUse" : "stop", message });
	events.end(message);
	return events;
}

function closeManagers(): void {
	const owners = (globalThis as Record<PropertyKey, unknown>)[Symbol.for("pi.extension.agent.owners")] as { managers?: Map<string, { close(): void }> } | undefined;
	for (const manager of owners?.managers?.values() ?? []) manager.close();
	owners?.managers?.clear();
}

function processManager(sessionsRoot: string): FixtureManager {
	const owners = (globalThis as Record<PropertyKey, unknown>)[Symbol.for("pi.extension.agent.owners")] as { managers?: Map<string, FixtureManager> } | undefined;
	const manager = owners?.managers?.get(realpathSync(sessionsRoot));
	if (!manager) throw new Error("The process-local manager is not registered");
	return manager;
}

function customEntries(sessionManager: SessionManager): Array<{ customType?: string; content?: unknown; details?: unknown }> {
	return sessionManager.getEntries().filter((entry) => entry.type === "custom_message").map((entry) => ({ customType: entry.customType, content: entry.content, details: entry.details }));
}

async function main(): Promise<void> {
	const [root, agentDir, sessionsRoot, cwd] = process.argv.slice(2);
	if (!root || !agentDir || !sessionsRoot || !cwd) throw new Error("Fixture requires its isolated roots and cwd");
	agentRestartHosts();
	process.env.PI_AGENT_DIR = agentDir;
	process.env.PI_AGENT_SESSIONS_DIR = sessionsRoot;
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(sessionsRoot, { recursive: true });
	mkdirSync(cwd, { recursive: true });
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ cacheWarming: { mode: "off" }, retry: { enabled: false } }));
	const wrapperPath = join(root, `extension-${randomUUID()}.ts`);
	writeFileSync(wrapperPath, wrapper);
	const sessionManager = SessionManager.create(cwd, sessionsRoot);
	const runtime = await createTestRuntime();
	let currentAction: "publish" | "clear" | undefined;
	let totalRequests = 0;
	const stream = (_model: unknown, context: TranscriptContext) => {
		totalRequests++;
		const action = currentAction;
		const intent = context.messages.flatMap((message) => message.role === "system" ? message.toolsAdded ?? [] : []).find((tool) => tool.name === "agent_intent");
		send({ type: "provider-request", totalRequests, action: action ?? null, effortSections: effortSections(context), intentParameters: intent?.parameters });
		currentAction = undefined;
		const args = intentArguments(action);
		const toolCall = args === undefined ? undefined : { type: "toolCall" as const, id: `effort-intent-${totalRequests}`, name: "agent_intent", arguments: args };
		return scriptedStream(assistantMessage(toolCall ? [toolCall] : [{ type: "text", text: "FIXTURE_TURN_COMPLETE" }], toolCall ? "toolUse" : "stop"));
	};
	runtime.registerNativeProvider({
		id: testModel.provider, name: "Isolated effort fixture", getModels: () => [testModel],
		auth: { apiKey: { name: "Synthetic", check: async () => ({ type: "api_key" }), resolve: async () => ({ auth: {} }) } },
		stream, streamSimple: stream,
	});
	const settingsManager = SettingsManager.create(cwd, agentDir);
	const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, additionalExtensionPaths: [wrapperPath] });
	await loader.reload();
	const session = (await createAgentSession({ cwd, agentDir, modelRuntime: runtime, settingsManager, sessionManager, model: testModel, resourceLoader: loader })).session;
	const entries = () => customEntries(sessionManager);
	session.subscribe((event) => {
		if (event.type === "message_end" && event.message.role === "custom") {
			send({ type: "custom-message", customType: event.message.customType, content: event.message.content, details: event.message.details });
		}
	});
	await session.bindExtensions({});
	const services: FixtureServices = {
		session, sessionManager, id: sessionManager.getSessionId(), cwd, sessionsRoot,
		customEntries: entries, totalRequests: () => totalRequests, setAction: (action) => { currentAction = action; },
	};
	send({ type: "ready", id: services.id, pid: process.pid, cwd, sessionManagerId: session.sessionId, customEntries: entries() });
	process.on("message", (value: unknown) => {
		if (value !== null && typeof value === "object" && "id" in value && "type" in value) void handleCommand(value as Command, services);
	});
}

async function handlePrompt(command: Command, services: FixtureServices): Promise<void> {
	await services.session.prompt("Check the current effort context");
	send({ type: "command-done", id: command.id, totalRequests: services.totalRequests(), customEntries: services.customEntries() });
}

async function handleIntent(command: Command, services: FixtureServices): Promise<void> {
	const action = command.action === "clear" ? "clear" : "publish";
	services.setAction(action);
	await services.session.prompt(`Fixture ${action} intent`);
	send({ type: "command-done", id: command.id, totalRequests: services.totalRequests(), customEntries: services.customEntries() });
}

async function handleInspect(command: Command, services: FixtureServices): Promise<void> {
	const awareness = await processManager(services.sessionsRoot).awareness(services.id, services.cwd);
	send({ type: "command-done", id: command.id, totalRequests: services.totalRequests(), customEntries: services.customEntries(), awareness });
}

async function handleControl(command: Command, services: FixtureServices): Promise<void> {
	const outcome = await processManager(services.sessionsRoot).control("submit", {
		sessionId: command.sessionId, message: command.message, origin: command.origin,
	}, { id: services.id, cwd: services.cwd });
	send({ type: "command-done", id: command.id, totalRequests: services.totalRequests(), outcome, customEntries: services.customEntries() });
}

function handleSnapshot(command: Command, services: FixtureServices): void {
	send({ type: "command-done", id: command.id, totalRequests: services.totalRequests(), customEntries: services.customEntries() });
}

function handleClose(command: Command, services: FixtureServices): void {
	closeManagers();
	services.session.dispose();
	send({ type: "command-done", id: command.id, totalRequests: services.totalRequests() });
	process.disconnect();
}

async function handleCommand(command: Command, services: FixtureServices): Promise<void> {
	try {
		switch (command.type) {
			case "prompt": return await handlePrompt(command, services);
			case "prompt-intent": return await handleIntent(command, services);
			case "inspect": return await handleInspect(command, services);
			case "control": return await handleControl(command, services);
			case "snapshot": return handleSnapshot(command, services);
			case "close": return handleClose(command, services);
			default: throw new Error(`Unknown fixture command ${command.type}`);
		}
	} catch (error) {
		send({ type: "command-error", id: command.id, error: error instanceof Error ? error.stack ?? error.message : String(error) });
	}
}

main().catch((error: unknown) => {
	send({ type: "fixture-error", error: error instanceof Error ? error.stack ?? error.message : String(error) });
	process.exitCode = 1;
});
