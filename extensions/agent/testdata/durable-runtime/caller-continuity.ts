/** Synthetic ordinary callers and a releasable native effect for process continuity. */
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createAssistantMessageEventStream, type AssistantMessage, type ToolCall, type TranscriptContext } from "@earendil-works/pi-ai";
import { getPackageDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type * as Durable from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { publishFixtureMarker } from "./signal.ts";

const model = { provider: "durable-runtime-fixture", id: "fixture-model", name: "Continuity fixture", api: "openai-completions" as const, baseUrl: "https://invalid.test", reasoning: false, input: ["text" as const], contextWindow: 128000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
function record(kind: string, details: Record<string, unknown> = {}) {
	const directory = process.env.DURABLE_TEST_DIR;
	if (!directory) throw new Error("DURABLE_TEST_DIR is required");
	appendFileSync(join(directory, "continuity.jsonl"), `${JSON.stringify({ kind, pid: process.pid, packageDir: getPackageDir(), ...details })}\n`);
}
function completed(content: AssistantMessage["content"], stopReason: "stop" | "toolUse") {
	const message: AssistantMessage = { role: "assistant", content, api: model.api, provider: model.provider, model: model.id, usage, stopReason, timestamp: Date.now() };
	const events = createAssistantMessageEventStream();
	events.push({ type: "start", partial: message }); events.push({ type: "done", reason: stopReason, message }); events.end(message);
	return events;
}
const answer = (text: string) => completed([{ type: "text", text }], "stop");
const call = (name: string, args: ToolCall["arguments"]) => completed([{ type: "toolCall", id: `continuity-${name}`, name, arguments: args }], "toolUse");
function childCwd(): string {
	const cwd = process.env.DURABLE_TEST_CHILD_CWD;
	if (!cwd) throw new Error("DURABLE_TEST_CHILD_CWD is required");
	return cwd;
}
function stream(_model: unknown, context: TranscriptContext, options?: { sessionId?: string }) {
	const index = context.messages.findLastIndex((message) => message.role === "user");
	const last = context.messages[index];
	const text = last?.role === "user" ? typeof last.content === "string" ? last.content : last.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("") : "";
	const hasResult = context.messages.slice(index + 1).some((message) => message.role === "toolResult");
	record("request", { sessionId: options?.sessionId, text });
	if (hasResult) return answer(text.includes("CONTINUITY_CHILD") ? "RETAINED_X" : "CALLER_DONE");
	if (text.startsWith("CONTINUITY_SPAWN")) return call("agent_spawn", { cwd: childCwd(), prompt: "CONTINUITY_CHILD", trust: true, checkInMinutes: 0 });
	if (text.startsWith("CONTINUITY_INSPECT:")) return call("agent_inspect", { ...JSON.parse(text.slice("CONTINUITY_INSPECT:".length)), view: "result" });
	if (text.startsWith("CONTINUITY_SEND:")) return call("agent_send", { sessionId: text.slice("CONTINUITY_SEND:".length), message: "CONTINUITY_FOLLOWUP", checkInMinutes: 0 });
	if (text.includes("CONTINUITY_CHILD")) return call("continuity-gate", {});
	if (text.includes("CONTINUITY_FOLLOWUP")) return answer("FOLLOWUP_X");
	return answer("CALLER_DONE");
}
export default function register(pi: ExtensionAPI) {
	record("extension-binding");
	pi.registerProvider({ id: model.provider, name: model.name, getModels: () => [model], auth: { apiKey: { name: "Fixture", check: async () => ({ type: "api_key" }), resolve: async () => ({ auth: {} }) } }, stream, streamSimple: stream });
	pi.on("session_start", (_event, context) => { record("ordinary-binding", { sessionId: context.sessionManager.getSessionId() }); });
	pi.events.emit("durable:contribution", {
		name: "fixture.continuity", source: fileURLToPath(import.meta.url),
		create(host: { durable: typeof Durable; storageId: string }): Durable.Extension {
			record("host-binding", { storageId: host.storageId });
			return host.durable.defineExtension({ name: "fixture.continuity", tools: [host.durable.defineTool({
				name: "continuity-gate", description: "Wait for a socket acknowledgment.", parameters: Type.Object({}), replay: "unsafe",
				async execute(_args, api, context) {
					record("tool-enter", { taskId: api.taskId, conversationId: api.conversationId });
					const abort = () => record("tool-abort"); context.abortSignal?.addEventListener("abort", abort, { once: true });
					try { await publishFixtureMarker(process.env.DURABLE_TEST_NOTIFY ?? "", "continuity-blocked"); }
					finally { context.abortSignal?.removeEventListener("abort", abort); }
					record("tool-release"); return { content: [{ type: "text", text: "RELEASED_X" }] };
				},
			})] });
		},
	});
}
