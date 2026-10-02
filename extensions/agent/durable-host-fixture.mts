/**
 * Synthetic fixture for durable-host tests.
 *
 * Imported by the tests for its model, tool, and runtime builders. Run as the
 * child process, it admits one submission with an owner receipt, prints
 * SUBMISSION, and blocks until the test kills it.
 */
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createAssistantMessageEventStream, type AssistantMessage, type Models } from "@earendil-works/pi-ai";
import { createRegistry, defineExtension, defineTool, type JsonObject, type Registry, type ToolRegistration } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { createTestRuntime, testModel } from "./test-runtime.mts";
import { DurableHost, type DurableHostOptions } from "./durable-host.ts";

export const fixtureProvider = testModel.provider;
export const fixtureModelId = testModel.id;
export const fixtureStorageId = "fixture-agent";

const usage = { input: 5, output: 7, cacheRead: 0, cacheWrite: 0, totalTokens: 12, cost: { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.03 } };

export function answerMessage(text = "durable answer"): AssistantMessage {
	return { role: "assistant", content: [{ type: "text", text }], api: "openai-completions", provider: fixtureProvider, model: fixtureModelId, usage, stopReason: "stop", timestamp: Date.now() };
}

/** An answer that carries opaque provider fields and redacted thinking for omission tests. */
export function redactedAnswerMessage(text = "durable answer"): AssistantMessage {
	return {
		role: "assistant",
		content: [
			{ type: "thinking", thinking: "private reasoning", thinkingSignature: "opaque-thinking-signature" },
			{ type: "thinking", thinking: "safety filtered", thinkingSignature: "opaque-redacted-payload", redacted: true },
			{ type: "text", text, textSignature: "opaque-text-signature" },
			{ type: "toolCall", id: "redacted-call", name: "noop", arguments: {}, thoughtSignature: "opaque-tool-signature" },
		],
		api: "openai-completions",
		provider: fixtureProvider,
		model: fixtureModelId,
		usage,
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

export function toolCallMessage(name = "slow-effect", args: JsonObject = {}): AssistantMessage {
	return { role: "assistant", content: [{ type: "toolCall", id: `fixture-call-${name}`, name, arguments: args }], api: "openai-completions", provider: fixtureProvider, model: fixtureModelId, usage, stopReason: "toolUse", timestamp: Date.now() };
}

export function completed(message: AssistantMessage) {
	const events = createAssistantMessageEventStream();
	events.push({ type: "start", partial: message });
	events.push({ type: "done", reason: "stop", message });
	events.end(message);
	return events;
}

/** A request that never completes; the process dies while it is in flight. */
export function pending(message: AssistantMessage) {
	const events = createAssistantMessageEventStream();
	events.push({ type: "start", partial: message });
	return events;
}

export function signalReady(): void {
	process.stdout.write("READY\n");
}

/** Records one external effect, signals the checkpoint, and blocks. */
export function slowEffectTool(sideEffectPath: string, rerunPath?: string, hang = true): ToolRegistration {
	return defineTool({
		name: "slow-effect",
		description: "Record one external effect, then block.",
		parameters: Type.Object({}),
		execute: async () => {
			appendFileSync(sideEffectPath, "effect\n");
			if (rerunPath !== undefined) appendFileSync(rerunPath, "rerun\n");
			signalReady();
			if (hang) await new Promise(() => {});
			return {};
		},
	});
}

/** A gate tool that resolves when the test releases it or the call is aborted. */
export function gateTool(release: Promise<void>, onStarted?: () => void): ToolRegistration {
	return defineTool({
		name: "gate",
		description: "Wait for the test to release the gate.",
		parameters: Type.Object({}),
		execute: async (_args, _api, context) => {
			onStarted?.();
			await new Promise<void>((resolve) => {
				release.then(() => resolve());
				if (context.abortSignal?.aborted) resolve();
				else context.abortSignal?.addEventListener("abort", () => resolve(), { once: true });
			});
			return {};
		},
	});
}

/** A tool that never returns; the run stays busy until aborted. */
export function hangingTool(onStarted?: () => void): ToolRegistration {
	return defineTool({
		name: "hang",
		description: "Block until aborted.",
		parameters: Type.Object({}),
		execute: async () => {
			onStarted?.();
			await new Promise<void>(() => {});
			return {};
		},
	});
}

export function fixtureRegistry(tools: ToolRegistration[] = [], name = "durable-host-fixture"): Registry {
	const registry = createRegistry();
	registry.install(defineExtension({ name, tools }));
	return registry;
}

export type FixtureMode = "request" | "effect" | "answer";

export async function fixtureRuntime(mode: FixtureMode): Promise<Models> {
	const runtime = await createTestRuntime();
	const streamSimple = () => {
		if (mode === "request") {
			signalReady();
			return pending(answerMessage("in flight"));
		}
		if (mode === "effect") return completed(toolCallMessage());
		return completed(answerMessage());
	};
	runtime.registerNativeProvider({
		id: fixtureProvider,
		name: "Durable host fixture",
		getModels: () => [testModel],
		auth: { apiKey: { name: "Test", check: async () => ({ type: "api_key" }), resolve: async () => ({ auth: {} }) } },
		stream: streamSimple,
		streamSimple,
	});
	return runtime;
}

/** A runtime that answers each request with the next scripted message. */
export async function scriptedRuntime(messages: readonly AssistantMessage[]): Promise<Models> {
	const queue = [...messages];
	const runtime = await createTestRuntime();
	const streamSimple = () => {
		const next = queue.shift();
		if (next === undefined) throw new Error("scripted runtime has no response left");
		return completed(next);
	};
	runtime.registerNativeProvider({
		id: fixtureProvider,
		name: "Durable host fixture",
		getModels: () => [testModel],
		auth: { apiKey: { name: "Test", check: async () => ({ type: "api_key" }), resolve: async () => ({ auth: {} }) } },
		stream: streamSimple,
		streamSimple,
	});
	return runtime;
}

/** A runtime holding the reasoning fixture model and a non-reasoning variant. */
export async function reasoningRuntime(): Promise<Models> {
	const runtime = await createTestRuntime();
	const streamSimple = () => completed(answerMessage());
	runtime.registerNativeProvider({
		id: fixtureProvider,
		name: "Durable host reasoning fixture",
		getModels: () => [testModel, { ...testModel, id: "plain", name: "Plain model", reasoning: false }],
		auth: { apiKey: { name: "Test", check: async () => ({ type: "api_key" }), resolve: async () => ({ auth: {} }) } },
		stream: streamSimple,
		streamSimple,
	});
	return runtime;
}

export function hostOptions(storagePath: string, models: Models, registry: Registry, cwd?: string): DurableHostOptions {
	return {
		storagePath,
		storageId: fixtureStorageId,
		...(cwd === undefined ? {} : { cwd }),
		models,
		registry,
		agent: { model: { provider: fixtureProvider, modelId: fixtureModelId } },
	};
}

async function main(): Promise<number> {
	const [storagePath, mode, effectPath, , prompt, runId] = process.argv.slice(2);
	const tools = mode === "effect" ? [slowEffectTool(effectPath)] : [];
	const host = await DurableHost.open(hostOptions(storagePath, await fixtureRuntime(mode as FixtureMode), fixtureRegistry(tools)), BACKGROUND_CONTEXT);
	const submission = await host.submit({ message: prompt, requestId: runId, ownerId: "fixture-owner" });
	process.stdout.write(`SUBMISSION ${String(submission.submissionId)}\n`);
	const keepAlive = setInterval(() => {}, 1 << 30);
	await new Promise(() => {});
	clearInterval(keepAlive);
	return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main();
