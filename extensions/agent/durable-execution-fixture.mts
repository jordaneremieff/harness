/**
 * Fixture support for durable-execution tests: a native contribution with controlled
 * tools and one `ToolTask` policy hook, a scripted faux model, and the crash fixture
 * process that runs a codemode script to one durable checkpoint.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createAssistantMessageEventStream, getCurrentTools, type AssistantMessage, type ToolResultMessage, type TranscriptContext } from "@earendil-works/pi-ai";
import { Harness, MemoryStorage, type Conversation } from "@earendil-works/pi-durable";
import { createDurableServices, type DurableServices } from "./durable-services.ts";
import { reconcileDeliveries } from "./durable-controls.ts";
import { createDurableExecution, type DurableExecution } from "./durable-execution.ts";
import { DurableHost } from "./durable-host.ts";
import { createTestRuntime, testModel } from "./test-runtime.mts";

export const fixtureProvider = testModel.provider;
export const fixtureModelId = testModel.id;
export const fixtureServerPath = fileURLToPath(new URL("./testdata/mcp-server/server.mts", import.meta.url));

const USAGE = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

/**
 * The fixture contribution: `guarded` records an effect unless the policy hook blocks it,
 * `structured` returns `details.structuredContent` with a declared output schema, and
 * `slow-effect` records an effect and optionally blocks until the process dies.
 */
export function executionExtensionSource(): string {
	return `import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";

export default function (pi) {
	pi.events.emit("durable:contribution", {
		name: "fixture.execution",
		source: fileURLToPath(import.meta.url),
		create(host) {
			const { durable } = host;
			const state = () => globalThis.__execFixture ?? {};
			const guarded = durable.defineTool({
				name: "guarded",
				description: "Record an external effect that policy may block.",
				parameters: Type.Object({ marker: Type.Optional(Type.String()) }),
				replay: "unsafe",
				async execute(args) {
					if (typeof state().guardedPath === "string") appendFileSync(state().guardedPath, \`\${args.marker ?? "effect"}\\n\`);
					return { content: [{ type: "text", text: "guarded ran" }] };
				},
			});
			const structured = {
				...durable.defineTool({
					name: "structured",
					description: "Return one structured answer.",
					parameters: Type.Object({}),
					replay: "safe",
					async execute() {
						return { details: { structuredContent: { answer: "42" } } };
					},
				}),
				outputSchema: Type.Object({ answer: Type.String() }),
			};
			const slow = durable.defineTool({
				name: "slow-effect",
				description: "Record an external effect, then wait for the process to end.",
				parameters: Type.Object({}),
				replay: "unsafe",
				async execute() {
					const current = state();
					if (typeof current.effectPath === "string") appendFileSync(current.effectPath, "effect\\n");
					if (typeof current.rerunPath === "string") appendFileSync(current.rerunPath, "rerun\\n");
					if (current.hang === true) {
						process.stdout.write("READY\\n");
						await new Promise(() => {});
					}
					return { content: [{ type: "text", text: "slow-effect ran" }] };
				},
			});
			const hanging = durable.defineTool({
				name: "hanging",
				description: "Wait until the call is aborted.",
				parameters: Type.Object({}),
				replay: "unsafe",
				async execute(_args, _api, context) {
					const current = state();
					if (typeof current.onEnter === "function") current.onEnter();
					await new Promise((_resolve, reject) => {
						if (context.abortSignal?.aborted) return reject(new Error("aborted"));
						context.abortSignal?.addEventListener("abort", () => {
							current.aborted = true;
							reject(new Error("aborted"));
						}, { once: true });
					});
					return { content: [{ type: "text", text: "hanging ran" }] };
				},
			});
			const policy = durable.hook(durable.ToolTask, {
				beforeTool(call) {
					if (call.name === "guarded") return { block: "denied by policy" };
					return undefined;
				},
				afterTool(call, result) {
					if (call.name === "structured" && state().rewriteStructured === true) {
						return { content: [{ type: "text", text: "rewritten by afterTool" }], details: { structuredContent: { answer: "rewritten" } } };
					}
					return result;
				},
			});
			return durable.defineExtension({ name: "fixture.execution", tools: [guarded, structured, slow, hanging], hooks: [policy] });
		},
	});
}
`;
}

/** Write the fixture contribution into `dir` and return its absolute path. */
export function writeExecutionExtension(dir: string): string {
	mkdirSync(dir, { recursive: true });
	const path = join(dir, "execution-extension.ts");
	writeFileSync(path, executionExtensionSource());
	return path;
}

export function answerMessage(text = "durable answer"): AssistantMessage {
	return { role: "assistant", content: [{ type: "text", text }], api: "openai-completions", provider: fixtureProvider, model: fixtureModelId, usage: USAGE, stopReason: "stop", timestamp: Date.now() };
}

function completed(message: AssistantMessage) {
	const events = createAssistantMessageEventStream();
	events.push({ type: "start", partial: message });
	events.push({ type: "done", reason: "stop", message });
	events.end(message);
	return events;
}

function codemodeCall(code: string, id = "codemode-call"): AssistantMessage {
	return { role: "assistant", content: [{ type: "toolCall", id, name: "codemode", arguments: { code } }], api: "openai-completions", provider: fixtureProvider, model: fixtureModelId, usage: USAGE, stopReason: "toolUse", timestamp: Date.now() };
}

function toolSearchCall(query: string, id = "tool-search-call"): AssistantMessage {
	return { role: "assistant", content: [{ type: "toolCall", id, name: "tool_search", arguments: { query } }], api: "openai-completions", provider: fixtureProvider, model: fixtureModelId, usage: USAGE, stopReason: "toolUse", timestamp: Date.now() };
}

/** A stream function keyed by the request history. */
export type FixtureStream = (context: TranscriptContext, requests: readonly TranscriptContext[]) => AssistantMessage;

/** The default stream: one codemode call, then an answer after any tool result. */
export function codemodeStream(code: string): FixtureStream {
	return (context) => (context.messages.some((message) => message.role === "toolResult") ? answerMessage() : codemodeCall(code));
}

/** A stream that calls `tool_search` first, then answers. */
export function toolSearchStream(query: string): FixtureStream {
	return (context) => (context.messages.some((message) => message.role === "toolResult") ? answerMessage() : toolSearchCall(query));
}

/** A stream that lists MCP resources once, then answers. */
export function resourceListStream(): FixtureStream {
	return (context) =>
		context.messages.some((message) => message.role === "toolResult")
			? answerMessage()
			: {
					role: "assistant",
					content: [{ type: "toolCall", id: "resource-list-call", name: "list_mcp_resources", arguments: {} }],
					api: "openai-completions",
					provider: fixtureProvider,
					model: fixtureModelId,
					usage: USAGE,
					stopReason: "toolUse",
					timestamp: Date.now(),
				};
}

/** A runtime driven by one `FixtureStream`. */
export async function streamRuntime(stream: FixtureStream, requests: TranscriptContext[] = []): Promise<{ runtime: Awaited<ReturnType<typeof createTestRuntime>>; requests: TranscriptContext[] }> {
	const runtime = await createTestRuntime();
	const providerStream = (_model: unknown, context: TranscriptContext) => {
		requests.push(structuredClone(context));
		return completed(stream(context, requests));
	};
	runtime.registerNativeProvider({ id: fixtureProvider, name: "Durable execution fixture", getModels: () => [testModel], auth: { apiKey: { name: "Test", check: async () => ({ type: "api_key" }), resolve: async () => ({ auth: {} }) } }, stream: providerStream, streamSimple: providerStream });
	return { runtime, requests };
}

/** A runtime whose first request issues one codemode call, then answers after any tool result. */
export async function scriptRuntime(code: string, requests: TranscriptContext[] = []): Promise<{ runtime: Awaited<ReturnType<typeof createTestRuntime>>; requests: TranscriptContext[] }> {
	return await streamRuntime(codemodeStream(code), requests);
}

/** A runtime that only answers, for a resumed run. */
export async function answerRuntime(): Promise<Awaited<ReturnType<typeof createTestRuntime>>> {
	const runtime = await createTestRuntime();
	const stream = () => completed(answerMessage());
	runtime.registerNativeProvider({ id: fixtureProvider, name: "Durable execution answer fixture", getModels: () => [testModel], auth: { apiKey: { name: "Test", check: async () => ({ type: "api_key" }), resolve: async () => ({ auth: {} }) } }, stream, streamSimple: stream });
	return runtime;
}

export interface FixtureSettings {
	readonly defaultTools?: readonly string[];
	readonly extensions?: readonly string[];
	readonly autoEnableCodemode?: boolean;
	readonly codemode?: { readonly mode?: "on" | "only" };
}

export interface ExecutionFixtureOptions {
	readonly code?: string;
	readonly stream?: FixtureStream;
	readonly settings?: FixtureSettings;
	readonly mcpServers?: Record<string, unknown>;
	readonly projectMcpServers?: Record<string, unknown>;
	readonly trusted?: boolean;
	readonly mcpAuth?: Record<string, unknown>;
	readonly autoEnableCodemode?: boolean;
	readonly readyTimeoutMs?: number;
	/** Await the execution's bounded `ready` before resuming the Harness. */
	readonly awaitReady?: boolean;
}

export interface ExecutionFixture {
	readonly root: string;
	readonly cwd: string;
	readonly agentDir: string;
	readonly extensionPath: string;
	readonly services: DurableServices;
	readonly harness: Harness;
	readonly requests: TranscriptContext[];
	readonly errors: unknown[];
	readonly conversation: Conversation;
	readonly execution: DurableExecution;
	/** Milliseconds the fixture waited in `ready`, when `awaitReady` was set. */
	readonly readyElapsedMs: number | undefined;
	submit(content: string): Promise<{ answer: string; toolResults: readonly ToolResultMessage[]; messages: readonly TranscriptContext["messages"][number][] }>;
	close(): Promise<void>;
}

/** Isolated services, registry, and Harness with the fixture contribution installed. */
export async function executionFixture(t: { after(fn: () => void | Promise<void>): void }, options: ExecutionFixtureOptions): Promise<ExecutionFixture> {
	const root = mkdtempSync(join(tmpdir(), "durable-execution-"));
	const cwd = join(root, "work");
	const agentDir = join(root, "agent");
	mkdirSync(cwd);
	mkdirSync(agentDir);
	writeFileSync(
		join(agentDir, "settings.json"),
		JSON.stringify({
			cacheWarming: { mode: "off" },
			retry: { enabled: false },
			defaultTools: options.settings?.defaultTools ?? ["+codemode", "+tool_search"],
			...(options.settings?.extensions === undefined ? {} : { extensions: options.settings.extensions }),
			...(options.settings?.codemode === undefined ? {} : { codemode: options.settings.codemode }),
		}),
	);
	if (options.mcpServers !== undefined) {
		writeFileSync(join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: options.mcpServers, ...(options.autoEnableCodemode === undefined ? {} : { autoEnableCodemode: options.autoEnableCodemode }) }));
	}
	if (options.projectMcpServers !== undefined) {
		mkdirSync(join(cwd, ".pi"));
		writeFileSync(join(cwd, ".pi", "mcp.json"), JSON.stringify({ mcpServers: options.projectMcpServers }));
	}
	if (options.mcpAuth !== undefined) writeFileSync(join(agentDir, "mcp-auth.json"), JSON.stringify(options.mcpAuth, null, 2));
	const extensionPath = writeExecutionExtension(join(root, "extension"));
	const errors: unknown[] = [];
	const { runtime, requests } = await streamRuntime(options.stream ?? codemodeStream(options.code ?? 'return "ok";'));
	let execution: DurableExecution | undefined;
	const services = await createDurableServices({
		cwd,
		agentDir,
		storageId: "fixture-execution",
		extensionPaths: [extensionPath],
		trusted: options.trusted ?? true,
		buildBuiltin: (host) => {
			execution = createDurableExecution(host, options.readyTimeoutMs === undefined ? undefined : { readyTimeoutMs: options.readyTimeoutMs });
			return execution;
		},
		modelRuntime: runtime,
		onReport: (error) => errors.push(error),
	});
	const harness = await Harness.open(new MemoryStorage(), { models: runtime, registry: services.registry, settings: services.settings, env: services.env }, BACKGROUND_CONTEXT);
	const close = async () => {
		await services.close().catch(() => undefined);
		await harness.close(BACKGROUND_CONTEXT).catch(() => undefined);
		rmSync(root, { recursive: true, force: true });
	};
	t.after(close);
	await services.install(harness);
	let readyElapsedMs: number | undefined;
	if (options.awaitReady === true && execution !== undefined) {
		const started = performance.now();
		await execution.ready;
		readyElapsedMs = performance.now() - started;
	}
	harness.resume();
	const conversation = await harness.root(BACKGROUND_CONTEXT, { agent: { model: { provider: fixtureProvider, modelId: fixtureModelId } } });
	return {
		root,
		cwd,
		agentDir,
		extensionPath,
		services,
		harness,
		requests,
		errors,
		conversation,
		execution: execution as DurableExecution,
		readyElapsedMs,
		async submit(content: string) {
			const settled = await (await conversation.submit({ type: "input", content }, BACKGROUND_CONTEXT)).wait(BACKGROUND_CONTEXT);
			if (settled.status !== "done") throw new Error(`submission did not settle: ${settled.status}`);
			const view = await conversation.context(BACKGROUND_CONTEXT);
			const toolResults = view.messages.filter((message): message is ToolResultMessage => message.role === "toolResult");
			return { answer: messageText(view.messages.at(-1)), toolResults, messages: [...view.messages] };
		},
		close,
	};
}

/** All text of one model message. */
export function messageText(message: unknown): string {
	if (message === undefined || message === null) return "";
	const content = (message as { content?: unknown }).content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.flatMap((part) => (part !== null && typeof part === "object" && (part as { type?: unknown }).type === "text" && typeof (part as { text?: unknown }).text === "string" ? [(part as { text: string }).text] : [])).join("\n");
}

/** Text of one tool result message. */
export function toolResultText(result: unknown): string {
	return messageText(result);
}

/** The last text item of one tool result: the script's returned value after the header. */
export function toolResultBody(result: unknown): string {
	const content = (result as { content?: unknown }).content;
	if (!Array.isArray(content)) return "";
	const texts = content.flatMap((part) => (part !== null && typeof part === "object" && (part as { type?: unknown }).type === "text" && typeof (part as { text?: unknown }).text === "string" ? [(part as { text: string }).text] : []));
	return texts.at(-1) ?? "";
}

export function declaredTools(request: TranscriptContext): string[] {
	return getCurrentTools(request.messages).map((tool) => tool.name);
}

/** One declared tool of the request, with the description the model saw. */
export function declaredTool(request: TranscriptContext, name: string) {
	return getCurrentTools(request.messages).find((tool) => tool.name === name);
}

/** A loopback MCP server over streamable HTTP that requires one bearer token and offers tools and resources. */
export interface HttpMcpFixture {
	readonly url: string;
	close(): Promise<void>;
}

export async function httpMcpServer(token: string, options: { beforeResponse?: (method: string) => Promise<void>; silent?: boolean } = {}): Promise<HttpMcpFixture> {
	const server = createServer((request, response) => handleHttpMcp(request, response, token, options));
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (address === null || typeof address === "string") throw new Error("HTTP MCP fixture did not bind a port");
	return {
		url: `http://127.0.0.1:${address.port}/mcp`,
		close: () =>
			new Promise<void>((resolve) => {
				server.closeAllConnections();
				server.close(() => resolve());
			}),
	};
}

function handleHttpMcp(request: IncomingMessage, response: ServerResponse, token: string, options: { beforeResponse?: (method: string) => Promise<void>; silent?: boolean }): void {
	if (request.headers.authorization !== `Bearer ${token}`) {
		response.writeHead(401, { "content-type": "application/json", "www-authenticate": 'Bearer realm="mcp"' });
		response.end(JSON.stringify({ error: "unauthorized" }));
		return;
	}
	if (options.silent === true) return;
	if (request.method !== "POST") {
		response.writeHead(405, { allow: "POST" });
		response.end();
		return;
	}
	let body = "";
	request.setEncoding("utf8");
	request.on("data", (chunk: string) => {
		body += chunk;
	});
	request.on("end", () => {
		const message = JSON.parse(body) as { id?: number; method?: string; params?: Record<string, unknown> };
		if (message.id === undefined) {
			response.writeHead(202);
			response.end();
			return;
		}
		const respond = () => {
			response.writeHead(200, { "content-type": "application/json" });
			response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: httpMcpResult(message) }));
		};
		if (options.beforeResponse) void options.beforeResponse(message.method ?? "").then(respond, (error: unknown) => response.destroy(error instanceof Error ? error : new Error(String(error))));
		else respond();
	});
}

function httpMcpResult(message: { method?: string; params?: Record<string, unknown> }): unknown {
	switch (message.method) {
		case "initialize":
			return { protocolVersion: "2025-06-18", capabilities: { tools: {}, resources: {} }, serverInfo: { name: "durable-http-fixture", version: "1.0.0" }, instructions: "HTTP fixture server." };
		case "ping":
			return {};
		case "tools/list":
			return { tools: [{ name: "echo", description: "Echo one value", inputSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"] } }] };
		case "tools/call":
			return { content: [{ type: "text", text: `echo ${String((message.params?.arguments as Record<string, unknown> | undefined)?.value ?? "")}` }] };
		case "resources/list":
			return { resources: [{ uri: "docs://readme", name: "readme", mimeType: "text/plain" }] };
		case "resources/templates/list":
			return { resourceTemplates: [] };
		case "resources/read":
			return { contents: [{ uri: String(message.params?.uri ?? "docs://readme"), mimeType: "text/plain", text: "hello resource" }] };
		default:
			return {};
	}
}

/** The storage id and root the crash fixture uses. */
export const CRASH_STORAGE_ID = "durable-execution-crash";

/**
 * Child fixture: run one codemode script that calls `slow-effect` to a durable checkpoint,
 * then block until the test kills the process.
 */
export async function crashFixtureMain(argv: readonly string[]): Promise<number> {
	const [storagePath, runId, prompt] = argv;
	if (storagePath === undefined || runId === undefined) throw new Error("crash fixture requires storagePath and runId");
	const root = dirname(storagePath);
	const agentDir = join(root, "agent");
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ cacheWarming: { mode: "off" }, retry: { enabled: false }, defaultTools: ["+codemode"] }));
	(globalThis as Record<string, unknown>).__execFixture = { effectPath: join(root, "effect.txt"), hang: true };
	const extensionPath = writeExecutionExtension(join(root, "child-extension"));
	const { runtime } = await scriptRuntime(`const value = await tools["slow-effect"]({});\nreturn value;`);
	const services = await createDurableServices({
		cwd: root,
		agentDir,
		storageId: CRASH_STORAGE_ID,
		extensionPaths: [extensionPath],
		trusted: true,
		buildBuiltin: createDurableExecution,
		modelRuntime: runtime,
		onReport: (error) => process.stderr.write(`fixture: ${String(error)}\n`),
	});
	const host = await DurableHost.open({
		storagePath,
		storageId: CRASH_STORAGE_ID,
		cwd: root,
		models: runtime,
		registry: services.registry,
		settings: services.settings,
		env: services.env,
		agent: { model: { provider: fixtureProvider, modelId: fixtureModelId } },
		resume: false,
	});
	await services.install(host.harness);
	host.harness.resume();
	await reconcileDeliveries(host.harness, BACKGROUND_CONTEXT);
	const submission = await host.submit({ message: prompt ?? "do the task", requestId: runId });
	process.stdout.write(`SUBMISSION ${String(submission.submissionId)}\n`);
	await new Promise(() => {});
	return 0;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
	process.exitCode = await crashFixtureMain(process.argv.slice(2));
}
