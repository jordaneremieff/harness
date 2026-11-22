import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	createAssistantMessageEventStream,
	type AssistantMessage,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { publishFixtureMarker } from "../durable-runtime/signal.ts";

// Match the isolated runtime fixture's catalog model; no network provider is loaded.
const provider = "durable-runtime-fixture";
const model = "fixture-model";
type Call = Extract<AssistantMessage["content"][number], { type: "toolCall" }>;

function message(content: AssistantMessage["content"], stopReason: "stop" | "toolUse"): AssistantMessage {
	return {
		role: "assistant",
		api: "openai-completions",
		provider,
		model,
		content,
		stopReason,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp: Date.now(),
	};
}

export default function register(pi: ExtensionAPI): void {
	const dir = process.env.DURABLE_TEST_DIR;
	const socket = process.env.DURABLE_TEST_NOTIFY;
	if (!dir || !socket) throw new Error("The stop process fixture requires its control directory and marker socket");
	appendFileSync(join(dir, "hosts.jsonl"), `${process.pid}\n`);
	const mark = (name: string) => {
		void publishFixtureMarker(socket, name).catch((error: unknown) => {
			process.stderr.write(`Fixture marker ${name}: ${String(error)}\n`);
		});
	};
	const commandOf = (context: TranscriptContext) => {
		return (
			context.messages
				.filter((item) => item.role === "user")
				.map((item) =>
					typeof item.content === "string"
						? item.content
						: item.content.map((part) => (part.type === "text" ? part.text : "")).join(""),
				)
				.findLast((text) => text.startsWith("FIXTURE "))
				?.split(" ") ?? []
		);
	};
	const end = (calls: Call[] = []) => {
		const events = createAssistantMessageEventStream();
		const reason = calls.length === 0 ? "stop" : "toolUse";
		const answer = message(calls.length === 0 ? [{ type: "text", text: "fixture done" }] : calls, reason);
		events.push({ type: "start", partial: answer });
		events.push({ type: "done", reason, message: answer });
		events.end(answer);
		return events;
	};
	const unresponsive = (tag: string, silent: boolean) => {
		const events = createAssistantMessageEventStream();
		if (!silent) events.push({ type: "start", partial: message([], "stop") });
		mark(`${tag}-requested`);
		return events;
	};
	const spawn = (tag: string, context: TranscriptContext) => {
		const results = context.messages.filter((item) => item.role === "toolResult");
		const children = tag === "cascade" ? ["left", "right"] : ["child"];
		const replies = results.filter((item) => children.some((child) => item.toolCallId === `spawn-${child}`));
		if (replies.length === children.length) {
			writeFileSync(join(dir, `${tag}-spawns.json`), JSON.stringify(replies));
			if (tag === "cascade") {
				return unresponsive("cascade-parent", false);
			}
			return end();
		}
		return end(
			children.map((child) => ({
				type: "toolCall",
				id: `spawn-${child}`,
				name: "agent_spawn",
				arguments: { name: child, prompt: `FIXTURE HANG ${child}` },
			})),
		);
	};
	const abort = (tag: string, target: string, context: TranscriptContext) => {
		const results = context.messages.filter((item) => item.role === "toolResult");
		const id = `stop-${tag}`;
		const result = results.findLast((item) => item.toolCallId === id);
		if (result) {
			writeFileSync(join(dir, `${id}.json`), JSON.stringify(result));
			return end();
		}
		return end([
			{
				type: "toolCall",
				id,
				name: "agent_abort",
				arguments: { sessionId: target, ...(tag === "child" ? {} : { background: true }) },
			},
		]);
	};
	const stream = (_model: unknown, context: TranscriptContext, options?: { sessionId?: string }) => {
		const [, command, tag, target] = commandOf(context);
		appendFileSync(join(dir, "requests.jsonl"), `${JSON.stringify({ sessionId: options?.sessionId, command, tag })}\n`);
		switch (command) {
			case "HANG":
			case "SILENT":
				return unresponsive(tag, command === "SILENT");
			case "SPAWN":
				return spawn(tag, context);
			case "ABORT":
				return abort(tag, target, context);
			default:
				return end();
		}
	};
	pi.registerProvider({
		id: provider,
		name: "Stop process fixture",
		getModels: () => [
			{
				provider,
				id: model,
				name: "Stop process fixture model",
				api: "openai-completions",
				baseUrl: "https://invalid.test",
				reasoning: false,
				input: ["text"],
				contextWindow: 128000,
				maxTokens: 4096,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			},
		],
		auth: {
			apiKey: { name: "Fixture", check: async () => ({ type: "api_key" }), resolve: async () => ({ auth: {} }) },
		},
		stream,
		streamSimple: stream,
	});
}
