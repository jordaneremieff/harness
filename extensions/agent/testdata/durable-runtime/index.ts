/**
 * testdata/durable-runtime: faux provider and unsafe effect tool for the
 * durable-runtime SIGKILL tests. This module loads inside the production host
 * process, so it uses only public extension APIs. The test process controls it
 * through the environment:
 *
 * - `DURABLE_TEST_DIR`: directory for the effect file and provider request evidence.
 * - `DURABLE_TEST_ANSWER`: optional final answer text for bounded catalog coverage tests.
 * - `DURABLE_TEST_NOTIFY`: Unix socket that receives each marker name. The
 *   test accepts on it before the host starts.
 * - `DURABLE_TEST_MODE`:
 *   - `request`: answer every model request with a pending stream and mark
 *     `requested`. The test kills the host while the request is outstanding.
 *   - `effect`: request `fixture-effect`, which appends the effect file and
 *     then blocks. The test kills the host after the effect.
 *   - `answer`: answer every model request with final text and mark `answered`.
 *   - `tool-round`: read the fixture input before the final answer on each turn.
 *   - `spawn`: the owner calls `agent_spawn` for `DURABLE_TEST_CHILD_CWD`, the
 *     child answers `CHILD_RESULT`, and the owner marks `delivered` when the
 *     routed follow-up arrives.
 *
 * The provider is a native registration through the public `pi.registerProvider`
 * API, so no real provider is contacted. The effect tool declares `replay:
 * "unsafe"`, so an interrupted execution is reported as interrupted and never
 * rerun.
 */
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { publishFixtureMarker } from "./signal.ts";
import type * as Durable from "@earendil-works/pi-durable";
import { createAssistantMessageEventStream, type AssistantMessage, type Model, type TranscriptContext } from "@earendil-works/pi-ai";
import { getPackageDir, ModelRuntime, VERSION, type AgentSessionServices, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const providerId = "durable-runtime-fixture";
const modelId = "fixture-model";
const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0.0625, output: 0.0625, cacheRead: 0, cacheWrite: 0, total: 0.125 } };

const fixtureModel: Model<"openai-completions"> = {
	provider: providerId,
	id: modelId,
	name: "Durable runtime fixture model",
	api: "openai-completions",
	baseUrl: "https://invalid.test",
	reasoning: true,
	input: ["text"],
	contextWindow: 128000,
	maxTokens: 4096,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

function controlDir(): string {
	const value = process.env.DURABLE_TEST_DIR;
	if (!value) throw new Error("DURABLE_TEST_DIR is required for the durable runtime fixture");
	return value;
}

function mark(name: string): void {
	const socketPath = process.env.DURABLE_TEST_NOTIFY;
	if (!socketPath) throw new Error("DURABLE_TEST_NOTIFY is required for the durable runtime fixture");
	void publishFixtureMarker(socketPath, name).catch((error: unknown) => {
		process.stderr.write(`Fixture marker ${name}: ${String(error)}\n`);
	});
}

interface RequestOptions {
	readonly sessionId?: string;
	readonly transport?: string;
	readonly reasoning?: unknown;
	readonly signal?: AbortSignal;
}

/** Record provider-boundary options without credentials or abort signals. */
function recordSessionOptions(options: RequestOptions | undefined): void {
	appendFileSync(join(controlDir(), "session-options.jsonl"), `${JSON.stringify({ sessionId: options?.sessionId ?? null, transport: options?.transport ?? null, reasoning: options?.reasoning })}\n`);
}

function message(content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"]): AssistantMessage {
	return { role: "assistant", content, api: "openai-completions", provider: providerId, model: modelId, usage, stopReason, timestamp: Date.now() };
}

function completed(content: AssistantMessage["content"], stopReason: "stop" | "toolUse") {
	const value = message(content, stopReason);
	const events = createAssistantMessageEventStream();
	events.push({ type: "start", partial: value });
	events.push({ type: "done", reason: stopReason, message: value });
	events.end(value);
	return events;
}

/** A pending request that ends only on caller cancellation or process death. */
function pending(signal?: AbortSignal) {
	mark("requested");
	const events = createAssistantMessageEventStream();
	events.push({ type: "start", partial: message([], "stop") });
	const abort = (): void => {
		const error = { ...message([], "aborted"), errorMessage: "Fixture request aborted" };
		events.push({ type: "error", reason: "aborted", error });
		events.end(error);
	};
	if (signal?.aborted) abort();
	else signal?.addEventListener("abort", abort, { once: true });
	return events;
}

function answer(): ReturnType<typeof completed> {
	mark("answered");
	return completed([{ type: "text", text: process.env.DURABLE_TEST_ANSWER ?? "durable runtime answer" }], "stop");
}

/** Plain user text of one request context. */
function userText(context: TranscriptContext): string {
	return context.messages
		.filter((item) => item.role === "user")
		.map((item) => typeof item.content === "string" ? item.content : item.content.map((part) => part.type === "text" ? part.text : "").join(""))
		.join("\n");
}

/** Cross-cwd spawn: the owner calls agent_spawn once, the child answers, and the delivered result is marked. */
function spawn(context: TranscriptContext) {
	const text = userText(context);
	if (text.includes("Agent result from")) {
		mark("delivered");
		return completed([{ type: "text", text: "PRIMARY_DONE" }], "stop");
	}
	if (text.includes("CHILD_TASK")) return completed([{ type: "text", text: "CHILD_RESULT" }], "stop");
	if (text.includes("SPAWN_CHILD") && !context.messages.some((item) => item.role === "toolResult")) {
		const childCwd = process.env.DURABLE_TEST_CHILD_CWD;
		if (!childCwd) throw new Error("DURABLE_TEST_CHILD_CWD is required for spawn mode");
		return completed([{ type: "toolCall", id: "spawn-child", name: "agent_spawn", arguments: { cwd: childCwd, prompt: "CHILD_TASK", name: "child" } }], "toolUse");
	}
	return completed([{ type: "text", text: "PRIMARY_DONE" }], "stop");
}

/** Native result waits use real controls; only provider answers are deterministic. */
function awaited(context: TranscriptContext, mode: string, signal?: AbortSignal) {
	const minAttempt = process.env.DURABLE_TEST_AWAIT_MIN_ATTEMPT;
	const release: Record<string, { minAttempt: number }> = minAttempt === undefined ? {} : { releaseOnProviderRetry: { minAttempt: Number(minAttempt) } };
	const last = context.messages.findLast((item) => item.role === "toolResult");
	const latestCall = context.messages.findLast((item) => item.role === "assistant" && item.content.some((part) => part.type === "toolCall"));
	const toolName = latestCall?.role === "assistant" ? latestCall.content.find((part) => part.type === "toolCall")?.name : undefined;
	const text = userText(context);
	if (text.includes("HELD_AWAIT_SOURCE")) return process.env.DURABLE_TEST_RETRY === "1" ? retryError() : pending(signal);
	if (last?.role === "toolResult" && toolName === "agent_await") {
		writeFileSync(join(controlDir(), "await-return.json"), JSON.stringify({ at: Date.now(), result: last }));
		mark("await-return");
		return completed([{ type: "text", text: "AWAIT_FINISHED" }], "stop");
	}
	if (last?.role === "toolResult" && toolName === "agent_spawn") {
		const body = typeof last.content === "string" ? last.content : last.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("\n");
		const result = JSON.parse(body.split("\nResult: ")[1].split("\n")[0]);
		return completed([{ type: "toolCall", id: "await-local-result", name: "agent_await", arguments: { results: [result], ...release } }], "toolUse");
	}
	if (mode === "await-local") return completed([{ type: "toolCall", id: "spawn-await-source", name: "agent_spawn", arguments: { prompt: "HELD_AWAIT_SOURCE", name: "await source", checkInMinutes: 0 } }], "toolUse");
	const result = JSON.parse(text.split("AWAIT_REFERENCE:")[1]);
	return completed([{ type: "toolCall", id: "await-foreign-result", name: "agent_await", arguments: { results: [result], ...release } }], "toolUse");
}

/** Marker acknowledgment controls exposure; the native retry scheduler owns the retry delay. */
function retryError() {
	const socketPath = process.env.DURABLE_TEST_NOTIFY;
	if (!socketPath) throw new Error("DURABLE_TEST_NOTIFY is required for the durable runtime fixture");
	const error = { ...message([], "error"), errorMessage: '429 {"code":"temporary_overload","message":"Temporary request throttling; retry this request"}' };
	const events = createAssistantMessageEventStream();
	void publishFixtureMarker(socketPath, "retry-requested").then(() => {
		events.push({ type: "error", reason: "error", error });
		events.end(error);
	}, (cause: unknown) => {
		const failed = { ...error, errorMessage: `Fixture retry marker failed: ${String(cause)}` };
		events.push({ type: "error", reason: "error", error: failed });
		events.end(failed);
	});
	return events;
}

function stream(_model: unknown, context: TranscriptContext, options?: RequestOptions) {
	recordSessionOptions(options);
	const mode = process.env.DURABLE_TEST_MODE ?? "answer";
	if (mode === "request") return pending(options?.signal);
	if (mode === "retry") return retryError();
	if (mode === "spawn") return spawn(context);
	if (mode === "await-local" || mode === "await-reference") return awaited(context, mode, options?.signal);
	if (mode === "tool-round" && context.messages.at(-1)?.role !== "toolResult") {
		return completed([{ type: "toolCall", id: `read-${context.messages.length}`, name: "read", arguments: { path: join(controlDir(), "input.txt") } }], "toolUse");
	}
	if (mode === "effect" && !context.messages.some((item) => item.role === "toolResult")) {
		mark("tool-called");
		return completed([{ type: "toolCall", id: "fixture-effect-call", name: "fixture-effect", arguments: { tag: "one" } }], "toolUse");
	}
	return answer();
}

/** Relevant public commit publications, recorded without another storage reader. */
function nativeCheckpoint(change: Durable.CommitChange): object | undefined {
	if (change.type === "submission") {
		if (change.value.status !== "done" && change.value.status !== "unanswered") return undefined;
		return { type: "terminal", submission: change.value };
	}
	if (change.type === "entry" && change.value.kind === "pi.assistant") return { type: "assistant", entry: change.value };
	if (change.type !== "document" || change.record.kind !== "pi.live" || change.value === null) return undefined;
	const generation = change.value.generation as { attempt?: number; retry?: { at: number; error: string } } | undefined;
	if (generation?.retry === undefined) return undefined;
	return { type: "retry", conversationId: change.conversationId, generation };
}
function recordNativeCommit(publication: Durable.CommitPublication): void {
	for (const change of publication.changes) {
		const checkpoint = nativeCheckpoint(change);
		if (checkpoint !== undefined) appendFileSync(join(controlDir(), "native-checkpoints.jsonl"), `${JSON.stringify({ at: Date.now(), seq: publication.seq, ...checkpoint })}\n`);
	}
}

export default function registerDurableRuntimeFixture(pi: ExtensionAPI): void {
	pi.registerProvider({
		id: providerId,
		name: "Durable runtime fixture",
		getModels: () => [fixtureModel],
		auth: { apiKey: { name: "Fixture", check: async () => ({ type: "api_key" }), resolve: async () => ({ auth: {} }) } },
		stream,
		streamSimple: stream,
	});
	pi.events.emit("durable:contribution", {
		name: "fixture.effect",
		source: fileURLToPath(import.meta.url),
		create(host: { readonly durable: typeof Durable; readonly services: AgentSessionServices; readonly harness: Durable.Harness; onClose(dispose: () => void): void }): Durable.Extension {
			if (process.env.DURABLE_TEST_HTTP === "1") {
				const version = (entry: string): string => JSON.parse(readFileSync(join(dirname(dirname(entry)), "package.json"), "utf8")).version;
				const aiEntry = fileURLToPath(import.meta.resolve("@earendil-works/pi-ai"));
				const durableEntry = fileURLToPath(import.meta.resolve("@earendil-works/pi-durable"));
				writeFileSync(join(controlDir(), `load-proof-${process.pid}.json`), JSON.stringify({ codingAgent: VERSION, packageDir: getPackageDir(), piAi: version(aiEntry), piAiEntry: aiEntry, durable: version(durableEntry), durableEntry, modelRuntime: host.services.modelRuntime instanceof ModelRuntime, providerRetry: host.services.settingsManager.getProviderRetrySettings(), httpIdleTimeoutMs: host.services.settingsManager.getHttpIdleTimeoutMs() }));
				mark("load-proof");
				host.onClose(host.harness.subscribeCommits(recordNativeCommit));
				const runtime = host.services.modelRuntime;
				const upstream = runtime.streamSimple.bind(runtime);
				runtime.streamSimple = (...args) => {
					if (args[0].provider === "durable-runtime-http") {
						appendFileSync(join(controlDir(), "http-options.jsonl"), `${JSON.stringify({ transport: args[2]?.transport ?? null, maxRetries: args[2]?.maxRetries ?? null, timeoutMs: args[2]?.timeoutMs ?? null, maxRetryDelayMs: args[2]?.maxRetryDelayMs ?? null })}\n`);
					}
					const stream = upstream(...args);
					const observed = createAssistantMessageEventStream();
					void (async () => {
						for await (const event of stream) {
							if (event.type === "error") {
								appendFileSync(join(controlDir(), "exposed-errors.jsonl"), `${JSON.stringify({ at: Date.now(), error: event.error.errorMessage, provider: args[0].provider })}\n`);
								mark("error-exposed");
							}
							observed.push(event);
						}
						observed.end(await stream.result());
					})().catch((error: unknown) => {
						const failed = { ...message([], "error"), errorMessage: String(error) };
						observed.push({ type: "error", reason: "error", error: failed });
						observed.end(failed);
					});
					return observed;
				};
			}
			const marker = process.env.DURABLE_TEST_CREATE_MARKER;
			if (marker) appendFileSync(marker, `${process.pid}\n`);
			return host.durable.defineExtension({
				name: "fixture.effect",
				tools: [
					host.durable.defineTool({
						name: "fixture-effect",
						description: "Append one external effect, then block until the process dies.",
						parameters: Type.Object({ tag: Type.String() }),
						replay: "unsafe",
						execute: async (args) => {
							appendFileSync(join(controlDir(), "effect.txt"), `${args.tag}\n`);
							mark("effect");
							await new Promise(() => {});
							return {};
						},
					}),
				],
			});
		},
	});
}
