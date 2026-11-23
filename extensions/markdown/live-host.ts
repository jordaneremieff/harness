import { BACKGROUND_CONTEXT, type Context, withAbortSignal } from "@earendil-works/chord/context";
import type { AssistantMessage, UserMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type * as Durable from "@earendil-works/pi-durable";
import type { MarkdownCommandCall, MarkdownHost } from "./durable.ts";
import {
	discardLiveHandoff,
	type LiveBridgeHandoff,
	LiveBridges,
	type LivePublisher,
	type LiveRoute,
	type PaneClosure,
} from "./live-bridge.ts";
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
const noReply = "The agent stopped without a text reply. You can ask a follow-up here.";
const sharedTurn =
	"Pi took this question with another message. The shared reply belongs in chat, not under either question.";
function submittedText(content: UserMessage["content"]): string {
	if (typeof content === "string") return content;
	return content.length === 1 && content[0].type === "text" ? content[0].text : "";
}
interface ReplyState {
	pending: Map<string, string>;
	hasInput: boolean;
	request?: string;
}
function ordinaryReplies(pi: ExtensionAPI, active: () => boolean, replies: ReplyState, publish: LivePublisher) {
	const { pending } = replies;
	const reset = () => {
		replies.hasInput = false;
		replies.request = undefined;
	};
	function takeInput(content: UserMessage["content"]) {
		const text = submittedText(content),
			delivered = pending.get(text);
		pending.delete(text);
		if (replies.hasInput) {
			for (const id of [replies.request, delivered]) if (id) publish("error", sharedTurn, id);
			replies.request = undefined;
			return;
		}
		replies.hasInput = true;
		replies.request = delivered;
		if (replies.request) publish("working", "", replies.request);
	}
	function finish(message: AssistantMessage) {
		// Pi can retry an error or take another turn after tools without a new user message.
		if (
			["toolUse", "error", "aborted"].includes(message.stopReason) ||
			message.content.some((part) => part.type === "toolCall")
		)
			return;
		if (replies.request) {
			const text = assistantText(message);
			if (text.trim()) publish("answer", text, replies.request);
			else publish("error", noReply, replies.request);
		}
		reset();
	}
	const off = [
		pi.on("message_start", ({ message }) => {
			if (active() && message.role === "user") takeInput(message.content);
		}),
		pi.on("message_end", ({ message }) => {
			if (active() && message.role === "assistant") finish(message);
		}),
		pi.on("agent_settled", () => {
			if (active() && replies.request) publish("error", noReply, replies.request);
			reset();
		}),
	];
	return () => {
		for (const remove of off) remove();
		pending.clear();
	};
}
export const PANE_NOTICE_TYPE = "markdown-pane-closed";
/** A departed connection supplies its last view, not proof of process exit or of a later save reaching a reader. */
export function paneClosedNotice({ closed, connected, panes }: PaneClosure): string {
	const event =
		closed === 1
			? "A reader pane disconnected from this conversation."
			: `${closed} reader panes disconnected from this conversation.`;
	const state =
		connected === 0
			? "No reader pane remained connected at that time."
			: `${connected} reader ${connected === 1 ? "pane" : "panes"} remained connected at that time.`;
	const departed = panes.map(({ handle, view }) => {
		const title = JSON.stringify(view.title.replace(/[\p{Cc}\p{Cf}]/gu, " ").slice(0, 180));
		const revision =
			view.revision === undefined
				? ""
				: ` ${view.dirty || view.conflict ? "base revision" : "revision"} ${view.revision}`;
		const state = [view.mode, ...(view.dirty ? ["unsaved"] : []), ...(view.conflict ? ["autosave conflict"] : [])];
		return `${handle} last reported ${view.kind} ${title}${view.documentId ? ` (${view.documentId}${revision})` : ""}: ${state.join(", ")}.`;
	});
	return `[markdown] ${event} ${departed.join(" ")} ${state} This notice needs no reply.`;
}
function ordinaryRoute(pi: ExtensionAPI, active: () => boolean, replies: ReplyState): LiveRoute {
	const checkAdmission = () => {
		if (!active()) throw new Error("The invoking Markdown conversation changed.");
	};
	return {
		checkAdmission,
		submit: async (text, operationId) => {
			checkAdmission();
			replies.pending.set(text, operationId);
			pi.sendUserMessage(text, { deliverAs: "followUp", expandPromptTemplates: false });
			return { status: "requested" };
		},
		observe: async (publish) => ordinaryReplies(pi, active, replies, publish),
		panesClosed: (closure) => {
			if (!active()) return;
			pi.sendMessage(
				{ customType: PANE_NOTICE_TYPE, content: paneClosedNotice(closure), display: false, details: closure },
				{ triggerTurn: false },
			);
		},
	};
}
type Manager = ExtensionContext["sessionManager"];
interface ReloadRecord {
	id: string;
	handoff: LiveBridgeHandoff;
	pending: [string, string][];
	hasInput: boolean;
	request?: string;
	expires: number;
	timer: NodeJS.Timeout;
}
// Resource reload imports a fresh extension. The manager object survives; a session ID alone is not a route.
const reloadSlot = Symbol.for("pi.markdown.ordinary.handoff.v3");
const processScope = globalThis as typeof globalThis & { [reloadSlot]?: WeakMap<Manager, ReloadRecord> };
processScope[reloadSlot] ??= new WeakMap();
const reloads = processScope[reloadSlot];
const reclaimMs = 30_000;
function takeReload(manager: Manager) {
	const record = reloads.get(manager);
	if (record) {
		reloads.delete(manager);
		clearTimeout(record.timer);
	}
	return record;
}
export function ordinaryLive(pi: ExtensionAPI, paneGraceMs?: number) {
	let bridges = new LiveBridges(paneGraceMs);
	let current: { manager: Manager; id: string; replies: ReplyState } | undefined;
	let stopped = false;
	const open = async (manager: Manager, record?: ReloadRecord) => {
		const id = manager.getSessionId();
		if (stopped || (current && (current.manager !== manager || current.id !== id)))
			throw new Error("The invoking Markdown conversation changed.");
		current ??= {
			manager,
			id,
			replies: { pending: new Map(record?.pending), hasInput: record?.hasInput ?? false, request: record?.request },
		};
		const bound = current;
		const active = () => !stopped && current === bound && manager.getSessionId() === id;
		const bridge = await bridges.get(
			id,
			() => ordinaryRoute(pi, active, bound.replies),
			`ordinary:${id}`,
			record?.handoff,
		);
		if (!active()) throw new Error("The invoking Markdown conversation changed.");
		return bridge.start();
	};
	pi.on("session_tree", () => {
		current = undefined;
		bridges.close();
		bridges = new LiveBridges(paneGraceMs);
	});
	pi.on("session_shutdown", async (event) => {
		stopped = true;
		const bound = current;
		current = undefined;
		try {
			if (event.reason !== "reload" || !bound || bound.manager.getSessionId() !== bound.id) return;
			const { manager, id, replies } = bound;
			const { hasInput, request } = replies;
			const pending = [...replies.pending];
			const handoff = await bridges.release(id);
			if (!handoff) return;
			const prior = takeReload(manager);
			if (prior) discardLiveHandoff(prior.handoff);
			const timer = setTimeout(() => {
				reloads.delete(manager);
				discardLiveHandoff(handoff);
			}, reclaimMs).unref();
			reloads.set(manager, { id, handoff, pending, hasInput, request, expires: Date.now() + reclaimMs, timer });
		} finally {
			bridges.close();
		}
	});
	pi.on("session_start", async (event, ctx) => {
		const manager = ctx.sessionManager;
		const record = takeReload(manager);
		if (!record) return;
		if (event.reason !== "reload" || manager.getSessionId() !== record.id || Date.now() >= record.expires) {
			discardLiveHandoff(record.handoff);
			return;
		}
		await open(manager, record);
	});
	return {
		find: async (ctx: ExtensionContext) =>
			current?.manager === ctx.sessionManager && current.id === current.manager.getSessionId()
				? bridges.find(current.id)
				: undefined,
		connection: (ctx: ExtensionContext): Promise<LiveConfig> => open(ctx.sessionManager),
	};
}
interface HostLive {
	bridges: LiveBridges;
	signal: AbortSignal;
}
const nativeHosts = new WeakMap<Durable.Harness, HostLive>();
export function nativeLive(host: MarkdownHost): HostLive {
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
export async function nativeConnection(call: MarkdownCommandCall): Promise<LiveConfig> {
	if (call.origin !== "operator") throw new Error("Only a local operator view acquires a live Markdown connection.");
	return nativeConversationConnection(call.host, call.conversation);
}
export async function nativeConversationConnection(
	host: MarkdownHost,
	conversation: Durable.Conversation,
): Promise<LiveConfig> {
	const { bridges, signal } = nativeLive(host);
	signal.throwIfAborted();
	const key = String(conversation.id);
	const bridge = await bridges.get(
		key,
		() => {
			const observing = new AbortController();
			const lifetime = AbortSignal.any([signal, observing.signal]);
			const context = withAbortSignal(lifetime, BACKGROUND_CONTEXT);
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
					if (!lifetime.aborted)
						publish("error", "The exact document request ended without a confirmed answer.", operationId);
				} finally {
					inputs.delete(submission.id);
				}
			};
			return {
				retryFailedSubmission: true,
				checkAdmission: () => lifetime.throwIfAborted(),
				submit: async (text, operationId) => {
					lifetime.throwIfAborted();
					const submission = await conversation.submit(
						{ type: "input", content: text, whenBusy: "followUp", requestId: `markdown:${operationId}` },
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
								observing.abort();
								for (const operationId of inputs.values())
									publish("error", "The exact Pi conversation connection closed.", operationId);
								bridges.delete(key);
							},
						},
						context,
						{ min: 8, max: 16 },
					);
					show(observation.value);
					return () => {
						observing.abort();
						observation.detach();
					};
				},
			};
		},
		`durable:${host.storageId}:${conversation.id}`,
	);
	signal.throwIfAborted();
	return bridge.start();
}
