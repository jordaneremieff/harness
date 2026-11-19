import { createConnection } from "node:net";
import {
	createAssistantMessageEventStream,
	type AssistantMessage,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const provider = "jobs-print-fixture";
const model = "scripted";

/**
 * A provider whose every request goes to the test over a local socket (`JOBS_PRINT_TEST_PORT`); the test
 * answers with one assistant message. A closed socket without an answer fails the request.
 */
export default function register(pi: ExtensionAPI): void {
	const stream = (_model: unknown, context: TranscriptContext, options?: { signal?: AbortSignal }) => {
		const events = createAssistantMessageEventStream();
		const socket = createConnection({ host: "127.0.0.1", port: Number(process.env.JOBS_PRINT_TEST_PORT) });
		let done = false;
		let buffer = "";
		const finish = (
			content: AssistantMessage["content"],
			stopReason: "stop" | "toolUse" | "error" | "aborted",
			errorMessage?: string,
		): void => {
			if (done) return;
			done = true;
			options?.signal?.removeEventListener("abort", abort);
			const message: AssistantMessage = {
				role: "assistant",
				content,
				stopReason,
				provider,
				model,
				api: "openai-completions",
				timestamp: Date.now(),
				usage: {
					input: 1,
					output: 1,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 2,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				...(errorMessage ? { errorMessage } : {}),
			};
			events.push({ type: "start", partial: message });
			if (stopReason === "error" || stopReason === "aborted")
				events.push({ type: "error", reason: stopReason, error: message });
			else events.push({ type: "done", reason: stopReason, message });
			events.end(message);
			socket.end();
		};
		const abort = (): void => {
			finish([], "aborted", "Fixture request aborted");
			socket.destroy();
		};
		socket.setEncoding("utf8");
		socket.once("connect", () => socket.write(`${JSON.stringify({ context })}\n`));
		socket.on("data", (chunk: string) => {
			buffer += chunk;
			if (!buffer.includes("\n")) return;
			try {
				const reply = JSON.parse(buffer.slice(0, buffer.indexOf("\n"))) as {
					content: AssistantMessage["content"];
					stopReason: "stop" | "toolUse";
				};
				finish(reply.content, reply.stopReason);
			} catch (error) {
				finish([], "error", String(error));
			}
		});
		socket.once("error", (error) => finish([], "error", error.message));
		socket.once("close", () => finish([], "error", "The test closed the request without an answer"));
		if (options?.signal?.aborted) abort();
		else options?.signal?.addEventListener("abort", abort, { once: true });
		return events;
	};
	pi.registerProvider({
		id: provider,
		name: "Jobs print fixture",
		getModels: () => [
			{
				provider,
				id: model,
				name: "Scripted",
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
