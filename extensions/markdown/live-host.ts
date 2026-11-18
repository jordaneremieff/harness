import { BACKGROUND_CONTEXT, withAbortSignal, type Context } from "@earendil-works/chord/context";
import type { AssistantMessage, UserMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type * as Durable from "@earendil-works/pi-durable";
import { LiveBridges, type LivePublisher, type LiveRoute } from "./live-bridge.ts";
import type { LiveConfig, LiveState } from "./live-protocol.ts";
import type { MarkdownCommandCall, MarkdownHost } from "./durable.ts";

function assistantText(message: { role: string; content: unknown }): string {
	if (message.role !== "assistant" || !Array.isArray(message.content)) return "";
	return message.content.flatMap((part: unknown) => typeof part === "object" && part !== null && "type" in part && part.type === "text" && "text" in part && typeof part.text === "string" ? [part.text] : []).join("\n\n");
}
function messageStatus(stop: string): LiveState["status"] {
	if (stop === "error" || stop === "aborted") return "error";
	return stop === "toolUse" ? "working" : "answer";
}
async function settledAnswer(conversation: Durable.Conversation, settled: Durable.SettledSubmissionRecord, context: Context): Promise<{ status: LiveState["status"]; text: string }> {
	if (settled.status === "unanswered") return { status: "error", text: settled.reason };
	if (settled.answer === undefined) return { status: "error", text: "The request ended without an assistant answer." };
	const page = await conversation.entries({ minEntryId: settled.answer, maxEntryId: settled.answer }, 1, undefined, context);
	const answer = page.items[0]?.model?.[0];
	return answer?.role === "assistant" ? { status: messageStatus(answer.stopReason), text: assistantText(answer) } : { status: "error", text: "The request's exact answer is unavailable." };
}
const noReply = "The agent stopped without a text reply. You can ask a follow-up here.";
const sharedTurn = "Pi took this question with another message. The shared reply belongs in chat, not under either question.";
function submittedText(content: UserMessage["content"]): string {
	if (typeof content === "string") return content;
	return content.length === 1 && content[0].type === "text" ? content[0].text : "";
}
function ordinaryReplies(pi: ExtensionAPI, active: () => boolean, pending: Map<string, string>, publish: LivePublisher) {
	let hasInput = false, request: string | undefined;
	const reset = () => { hasInput = false; request = undefined; };
	function takeInput(content: UserMessage["content"]) {
		const text = submittedText(content), delivered = pending.get(text);
		pending.delete(text);
		if (hasInput) {
			for (const id of [request, delivered]) if (id) publish("error", sharedTurn, id);
			request = undefined;
			return;
		}
		hasInput = true;
		request = delivered;
		if (request) publish("working", "", request);
	}
	function finish(message: AssistantMessage) {
		// Pi can retry an error or take another turn after tools without a new user message.
		if (["toolUse", "error", "aborted"].includes(message.stopReason) || message.content.some((part) => part.type === "toolCall")) return;
		if (request) {
			const text = assistantText(message);
			if (text.trim()) publish("answer", text, request);
			else publish("error", noReply, request);
		}
		reset();
	}
	const off = [
		pi.on("message_start", ({ message }) => { if (active() && message.role === "user") takeInput(message.content); }),
		pi.on("message_end", ({ message }) => { if (active() && message.role === "assistant") finish(message); }),
		pi.on("agent_settled", () => { if (active() && request) publish("error", noReply, request); reset(); }),
	];
	return () => { for (const remove of off) remove(); pending.clear(); };
}
function ordinaryRoute(pi: ExtensionAPI, check: () => void, active: () => boolean): LiveRoute {
	const pending = new Map<string, string>();
	return {
		submit: async (text, operationId) => {
			check();
			pending.set(text, operationId);
			pi.sendUserMessage(text, { deliverAs: "followUp", expandPromptTemplates: false });
			return { status: "requested" };
		},
		observe: async (publish) => ordinaryReplies(pi, active, pending, publish),
	};
}
export function ordinaryLive(pi: ExtensionAPI, lifecycle: () => AbortSignal) {
	let bridges = new LiveBridges();
	const invalidate = () => { bridges.close(); bridges = new LiveBridges(); };
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
			const check = () => { signal.throwIfAborted(); if (source.getSessionId() !== id) throw new Error("The invoking Markdown conversation changed."); };
			check();
			const bridge = await bridges.get(id, () => ordinaryRoute(pi, check, () => !signal.aborted && source.getSessionId() === id));
			check();
			return bridge.start();
		},
	};
}
interface HostLive { bridges: LiveBridges; signal: AbortSignal }
const nativeHosts = new WeakMap<Durable.Harness, HostLive>();
export function nativeLive(host: MarkdownHost): HostLive {
	let state = nativeHosts.get(host.harness);
	if (!state) {
		const controller = new AbortController();
		const bridges = new LiveBridges();
		state = { bridges, signal: controller.signal };
		nativeHosts.set(host.harness, state);
		host.onClose(() => { controller.abort(); bridges.close(); });
	}
	return state;
}
export async function nativeConnection(call: MarkdownCommandCall): Promise<LiveConfig> {
	if (call.origin !== "operator") throw new Error("Only a local operator view acquires a live Markdown connection.");
	return nativeConversationConnection(call.host, call.conversation);
}
export async function nativeConversationConnection(host: MarkdownHost, conversation: Durable.Conversation): Promise<LiveConfig> {
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
			for (const [id, operationId] of inputs) if (live.run.inputs.includes(id)) publish("working", live.generation?.message ? assistantText(live.generation.message) : "", operationId);
		};
		const finish = async (submission: Durable.Submission, operationId: string) => {
			try {
				const result = await settledAnswer(conversation, await submission.wait(context), context);
				publish(result.status, result.text, operationId);
			} catch { if (!signal.aborted) publish("error", "The exact document request ended without a confirmed answer.", operationId); }
			finally { inputs.delete(submission.id); }
		};
		return {
			retryFailedSubmission: true,
			submit: async (text, operationId) => {
				signal.throwIfAborted();
				const submission = await conversation.submit({ type: "input", content: text, whenBusy: "followUp", requestId: `markdown:${operationId}` }, context);
				inputs.set(submission.id, operationId);
				if (latest) show(latest);
				void finish(submission, operationId);
				return { status: "admitted", submissionId: String(submission.id) };
			},
			observe: async (emit) => {
				publish = emit;
				const observation = await host.harness.observeConversation(conversation.id, { advance: (update) => { if (update.kind === "value") show(update.value); }, end: () => { for (const operationId of inputs.values()) publish("error", "The exact Pi conversation connection closed.", operationId); } }, context, { min: 8, max: 16 });
				show(observation.value);
				return () => observation.detach();
			},
		};
	});
	signal.throwIfAborted();
	return bridge.start();
}
