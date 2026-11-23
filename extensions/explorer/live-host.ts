import { BACKGROUND_CONTEXT, type Context, withAbortSignal } from "@earendil-works/chord/context";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type * as Durable from "@earendil-works/pi-durable";
import type { ExplorerHost } from "./durable.ts";
import { explorerApplicationRoutes } from "./application-messages.ts";
import { LiveBridges, type LivePublisher } from "./live-bridge.ts";
import type { LiveConfig, LiveState } from "./live-protocol.ts";

function assistantText(message: { role: string; content: unknown }): string {
	if (message.role !== "assistant" || !Array.isArray(message.content)) return "";
	return message.content
		.flatMap((part: unknown) =>
			typeof part === "object" &&
			part !== null &&
			"type" in part &&
			part.type === "text" &&
			"text" in part &&
			typeof part.text === "string"
				? [part.text]
				: [],
		)
		.join("\n\n");
}
function messageStatus(stop: string): LiveState["status"] {
	if (stop === "error" || stop === "aborted") return "error";
	return stop === "toolUse" ? "working" : "answer";
}
async function settledAnswer(
	conversation: Durable.Conversation,
	settled: Durable.SettledSubmissionRecord,
	context: Context,
): Promise<{ status: LiveState["status"]; text: string }> {
	if (settled.status === "unanswered") return { status: "error", text: settled.reason };
	if (settled.answer === undefined) return { status: "error", text: "The request ended without an assistant answer." };
	const page = await conversation.entries(
		{ minEntryId: settled.answer, maxEntryId: settled.answer },
		1,
		undefined,
		context,
	);
	const answer = page.items[0]?.model?.[0];
	return answer?.role === "assistant"
		? { status: messageStatus(answer.stopReason), text: assistantText(answer) }
		: { status: "error", text: "The request's exact answer is unavailable." };
}
export function ordinaryLive(pi: ExtensionAPI, lifecycle: () => AbortSignal) {
	const route = explorerApplicationRoutes(pi);
	let bridges = new LiveBridges();
	const invalidate = () => {
		bridges.close();
		bridges = new LiveBridges();
	};
	pi.on("session_before_switch", invalidate);
	pi.on("session_before_fork", invalidate);
	pi.on("session_before_tree", invalidate);
	pi.on("session_shutdown", () => bridges.close());
	return {
		find: (ctx: ExtensionContext) => bridges.find(ctx.sessionManager.getSessionId()),
		async connection(ctx: ExtensionContext): Promise<LiveConfig> {
			const source = ctx.sessionManager;
			const id = source.getSessionId();
			const signal = lifecycle();
			const check = () => {
				signal.throwIfAborted();
				if (source.getSessionId() !== id) throw new Error("The invoking Explorer conversation changed.");
			};
			check();
			const bridge = await bridges.get(id, () => route(ctx, check));
			check();
			return bridge.start();
		},
	};
}
interface HostLive {
	bridges: LiveBridges;
	signal: AbortSignal;
}
const nativeHosts = new WeakMap<Durable.Harness, HostLive>();
export function nativeLive(host: ExplorerHost): HostLive {
	let state = nativeHosts.get(host.harness);
	if (!state) {
		const controller = new AbortController();
		const bridges = new LiveBridges();
		state = { bridges, signal: controller.signal };
		nativeHosts.set(host.harness, state);
		host.onClose(() => {
			controller.abort();
			bridges.close();
		});
	}
	return state;
}
export async function nativeConversationConnection(
	host: ExplorerHost,
	conversation: Durable.Conversation,
): Promise<LiveConfig> {
	const { bridges, signal } = nativeLive(host);
	const context = withAbortSignal(signal, BACKGROUND_CONTEXT);
	const bridge = await bridges.get(String(conversation.id), () => {
		const inputs = new Map<Durable.SubmissionId, string>();
		let publish: LivePublisher = () => {};
		let latest: Durable.ConversationView | undefined;
		const show = (value: Durable.ConversationView) => {
			latest = value;
			const live = value.docs["pi.live"] as Durable.LiveState | undefined;
			if (!live?.run) return;
			for (const [id, operationId] of inputs)
				if (live.run.inputs.includes(id))
					publish("working", live.generation?.message ? assistantText(live.generation.message) : "", operationId);
		};
		const finish = async (submission: Durable.Submission, operationId: string) => {
			try {
				const result = await settledAnswer(conversation, await submission.wait(context), context);
				publish(result.status, result.text, operationId);
			} catch {
				if (!signal.aborted)
					publish("error", "The exact document request ended without a confirmed answer.", operationId);
			} finally {
				inputs.delete(submission.id);
			}
		};
		return {
			label: "this agent conversation",
			retryFailedSubmission: true,
			submit: async ({ text, requestId: operationId }) => {
				signal.throwIfAborted();
				const content = `This question (${operationId}) comes from the live Explorer pane. Answer in your final message; the pane shows it under this question.\n\n${text}`;
				const submission = await conversation.submit(
					{ type: "input", content, whenBusy: "followUp", requestId: `explorer:${operationId}` },
					context,
				);
				inputs.set(submission.id, operationId);
				if (latest) show(latest);
				void finish(submission, operationId);
				return { status: "admitted", submissionId: String(submission.id) };
			},
			observe: async (emit) => {
				publish = emit;
				const observation = await host.harness.observeConversation(
					conversation.id,
					{
						advance: (update) => {
							if (update.kind === "value") show(update.value);
						},
						end: () => {
							for (const operationId of inputs.values())
								publish("error", "The exact Pi conversation connection closed.", operationId);
						},
					},
					context,
					{ min: 8, max: 16 },
				);
				show(observation.value);
				return () => observation.detach();
			},
		};
	});
	signal.throwIfAborted();
	return bridge.start();
}
