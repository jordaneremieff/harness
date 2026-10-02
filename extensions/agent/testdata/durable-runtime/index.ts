/**
 * testdata/durable-runtime: faux provider and unsafe effect tool for the
 * durable-runtime SIGKILL tests. This module loads inside the production host
 * process, so it uses only public extension APIs. The test process controls it
 * through the environment:
 *
 * - `DURABLE_TEST_DIR`: directory for readiness markers and the effect file.
 * - `DURABLE_TEST_MODE`:
 *   - `request`: answer every model request with a pending stream and mark
 *     `requested`. The test kills the host while the request is outstanding.
 *   - `effect`: request `fixture-effect`, which appends the effect file and
 *     then blocks. The test kills the host after the effect.
 *   - `answer`: answer every model request with final text and mark `answered`.
 *   - `spawn`: the owner calls `agent_spawn` for `DURABLE_TEST_CHILD_CWD`, the
 *     child answers `CHILD_RESULT`, and the owner marks `delivered` when the
 *     routed follow-up arrives.
 *
 * The provider is a native registration through the public `pi.registerProvider`
 * API, so no real provider is contacted. The effect tool declares `replay:
 * "unsafe"`, so an interrupted execution is reported as interrupted and never
 * rerun.
 */
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type * as Durable from "@earendil-works/pi-durable";
import { createAssistantMessageEventStream, type AssistantMessage, type Model, type TranscriptContext } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const providerId = "durable-runtime-fixture";
const modelId = "fixture-model";
const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

const fixtureModel: Model<"openai-completions"> = {
	provider: providerId,
	id: modelId,
	name: "Durable runtime fixture model",
	api: "openai-completions",
	baseUrl: "https://invalid.test",
	reasoning: false,
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
	writeFileSync(join(controlDir(), name), `${process.pid}\n`);
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

/** A request that never completes; the test kills the host while it is in flight. */
function pending() {
	mark("requested");
	const events = createAssistantMessageEventStream();
	events.push({ type: "start", partial: message([], "stop") });
	return events;
}

function answer(): ReturnType<typeof completed> {
	mark("answered");
	return completed([{ type: "text", text: "durable runtime answer" }], "stop");
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

function stream(_model: unknown, context: TranscriptContext) {
	const mode = process.env.DURABLE_TEST_MODE ?? "answer";
	if (mode === "request") return pending();
	if (mode === "spawn") return spawn(context);
	if (mode === "effect" && !context.messages.some((item) => item.role === "toolResult")) {
		mark("tool-called");
		return completed([{ type: "toolCall", id: "fixture-effect-call", name: "fixture-effect", arguments: { tag: "one" } }], "toolUse");
	}
	return answer();
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
		create(host: { readonly durable: typeof Durable }): Durable.Extension {
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
