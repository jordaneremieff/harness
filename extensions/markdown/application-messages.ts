import type {
	AgentBeforeSettleEvent,
	ExtensionAPI,
	ExtensionContext,
	TurnEndEvent,
} from "@earendil-works/pi-coding-agent";
import { applicationKey, makeAskMessage, projectAskContext } from "./application-message-content.ts";
import type { LivePrompt, PromptReply } from "./live-bridge.ts";
import type { LivePromptReceipt } from "./live-protocol.ts";

interface OpenAsk {
	message: ReturnType<typeof makeAskMessage>;
	reply: PromptReply;
	phase: "starting" | "queued" | "restored" | "working";
}

function cardAnswer(id: string, text: string, others: number): string {
	if (others <= 0) return text;
	const ref = id.slice(0, 8).toLowerCase();
	return `Shared reply for #${ref} and ${others} other ${others === 1 ? "message" : "messages"}:\n\n${text}`;
}

function retainedInputsAfter(manager: ExtensionContext["sessionManager"], leaf: string | null) {
	const added = new Set<string>();
	for (
		let entry = manager.getLeafEntry();
		entry && entry.id !== leaf;
		entry = entry.parentId ? manager.getEntry(entry.parentId) : undefined
	) {
		if (
			(entry.type === "custom_message" && applicationKey(entry, true)) ||
			(entry.type === "message" && entry.message.role === "user")
		)
			added.add(entry.id);
	}
	if (!added.size) return [];
	return manager
		.buildSessionProjection()
		.entries.filter(({ sourceEntry }) => added.has(sourceEntry.id))
		.flatMap(({ messages }) => messages.slice(0, 1));
}

export function markdownMessages(pi: ExtensionAPI) {
	const open = new Map<string, OpenAsk>();
	const applications = new Set<string>();
	let users = 0;
	let boundaryLeaf: string | null | undefined;

	function work(key: string) {
		applications.add(key);
		const ask = open.get(key);
		if (ask && ask.phase !== "working") {
			ask.phase = "working";
			ask.reply("working", "");
		}
	}
	function finish(reason: string, answer?: Extract<TurnEndEvent["message"], { role: "assistant" }>) {
		const others = users + applications.size - 1;
		users = 0;
		applications.clear();
		if (!open.size) return;
		const text = answer?.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n") ?? "";
		const hasText = !!text.trim();
		for (const [key, ask] of open) {
			if (ask.phase !== "working") continue;
			open.delete(key);
			if (hasText) ask.reply("answer", cardAnswer(ask.message.details.id, text, others));
			else ask.reply("error", reason);
		}
	}
	function rememberLeaf(ctx: ExtensionContext) {
		if (boundaryLeaf === undefined) boundaryLeaf = ctx.sessionManager.getLeafId();
	}
	function boundary(event: TurnEndEvent | AgentBeforeSettleEvent, ctx: ExtensionContext) {
		rememberLeaf(ctx);
		if (event.type === "turn_end") {
			const m = event.message;
			if (
				m.role === "assistant" &&
				(m.stopReason === "stop" || m.stopReason === "length") &&
				!m.content.some((part) => part.type === "toolCall")
			) {
				finish("Pi ended its answer without text.", m);
			}
		}
		if (event.context.pendingMessages.length) return;
		const queued = [...open.values()].filter((ask) => ask.phase === "queued");
		if (!queued.length) return;
		return {
			entries: [
				...event.entries,
				...queued.map((ask) => {
					ask.phase = "restored";
					return { type: "custom_message" as const, ...ask.message };
				}),
			],
			continue: true,
		};
	}
	pi.on("turn_end", boundary);
	pi.on("agent_before_settle", boundary);
	pi.on("context", ({ messages }) => projectAskContext(messages));
	pi.on("before_agent_start", (event) => {
		// isIdle() is also false during manual compaction, even when the Ask itself starts the run.
		if (event.messageType !== "custom") return;
		const key = applicationKey(event.message, true);
		const ask = key && open.get(key);
		if (ask && ask.phase === "queued") ask.phase = "starting";
	});
	pi.on("message_start", ({ message }, ctx) => {
		if (message.role === "user") {
			if (ctx.signal?.aborted) rememberLeaf(ctx);
			else users++;
			return;
		}
		if (message.role !== "custom") return;
		const key = applicationKey(message, true);
		if (!key) return;
		if (ctx.signal?.aborted) {
			// Pi can place input on the stopped turn after an interrupted tool batch. It is no longer queued.
			rememberLeaf(ctx);
			const ask = open.get(key);
			if (ask && ask.phase !== "working") ask.phase = "restored";
		} else work(key);
	});
	function takeRetained(message: TurnEndEvent["message"]) {
		if (message.role === "user") users++;
		if (message.role !== "custom") return;
		const key = applicationKey(message, true);
		if (!key) return;
		const ask = open.get(key);
		if (!ask || message.content === ask.message.content) work(key);
	}
	pi.on("turn_start", (_event, ctx) => {
		if (ctx.signal?.aborted || boundaryLeaf === undefined) return;
		// Pi commits boundary drafts without message_start. Other handlers can add or replace them after ours returns.
		const inputs = retainedInputsAfter(ctx.sessionManager, boundaryLeaf);
		boundaryLeaf = undefined;
		for (const message of inputs) takeRetained(message);
		for (const [key, ask] of open) {
			if (ask.phase !== "restored") continue;
			open.delete(key);
			ask.reply("error", "Pi did not keep this request in the context for the next turn.");
		}
	});
	pi.on("agent_settled", ({ aborted }) =>
		finish(
			aborted ? "Pi stopped before it answered this request." : "Pi ended the run without an answer to this request.",
		),
	);
	return {
		send(prompt: LivePrompt, reply: PromptReply, idle: boolean): LivePromptReceipt {
			const message = makeAskMessage(prompt);
			const key = `${message.details.source}:${message.details.id.toLowerCase()}`;
			open.set(key, { message, reply, phase: idle ? "starting" : "queued" });
			try {
				pi.sendMessage(message, { triggerTurn: true, deliverAs: "followUp" });
			} catch {
				open.delete(key);
				return { status: "rejected", message: "Pi refused the application message." };
			}
			return { status: "requested" };
		},
		end(reason: string) {
			for (const ask of open.values()) ask.reply("error", reason);
			open.clear();
			applications.clear();
			users = 0;
			boundaryLeaf = undefined;
		},
	};
}
