import type {
	AgentBeforeSettleEvent,
	BoundaryResult,
	CustomMessageEntryDraft,
	ExtensionAPI,
	ExtensionContext,
	SessionEntry,
	TurnEndEvent,
} from "@earendil-works/pi-coding-agent";
import {
	APPLICATION_MESSAGE_TYPE,
	applicationReference,
	formatApplicationMessage,
	validateApplicationMessage,
	type ApplicationMessage,
} from "./application-message-content.ts";

const REQUEST = "harness:application-messages:request";
const RECEIVER = "harness:application-messages:receiver";
const REPLY = "harness:application-messages:reply";
const MAX_PENDING = 64;

type Receipt = { status: "requested"; reference: string } | { status: "rejected"; message: string };
type Phase = "starting" | "queued" | "restored" | "working";
type Pending = { input: ApplicationMessage; message: ReturnType<typeof formatApplicationMessage>; phase: Phase };
type Boundary = AgentBeforeSettleEvent | TurnEndEvent;

type Mark = { extension: string; id: string; explanation?: unknown; guidance?: unknown };
function mark(details: unknown): details is Mark {
	return (
		details !== null &&
		typeof details === "object" &&
		"extension" in details &&
		typeof details.extension === "string" &&
		"id" in details &&
		typeof details.id === "string"
	);
}
function key(mark: Mark): string {
	return `${mark.extension}:${mark.id.toLowerCase()}`;
}
function application(entry: SessionEntry): Mark | undefined {
	return entry.type === "custom_message" && entry.customType === APPLICATION_MESSAGE_TYPE && mark(entry.details)
		? entry.details
		: undefined;
}

/** Only the entries that carried the actual standing text establish its presence. */
function standing() {
	let explanation = false;
	const guidance = new Set<string>();
	function include(fields: Mark | undefined) {
		if (fields?.explanation === true) explanation = true;
		if (fields?.guidance === true) guidance.add(fields.extension);
	}
	return {
		include,
		format(input: ApplicationMessage) {
			const message = formatApplicationMessage(input, !explanation, !guidance.has(input.extension));
			include(message.details);
			return message;
		},
	};
}

class ApplicationInbox {
	private readonly pi: ExtensionAPI;
	private readonly ctx: ExtensionContext;
	private readonly sessionId: string;
	private readonly pending = new Map<string, Pending>();
	// Most receipts are the session's own entries. Only a delivery that ended before Pi recorded it needs a separate key.
	private readonly unrecorded = new Set<string>();
	private users = 0;

	constructor(pi: ExtensionAPI, ctx: ExtensionContext) {
		this.pi = pi;
		this.ctx = ctx;
		this.sessionId = ctx.sessionManager.getSessionId();
	}

	/** A repeated request keeps its receipt even if compaction or navigation hid its entry. */
	private recordedPending(id: string): Set<string> | "repeat" {
		if (this.pending.has(id) || this.unrecorded.has(id)) return "repeat";
		const recorded = new Set<string>();
		for (const entry of this.ctx.sessionManager.getEntries()) {
			const fields = application(entry);
			if (!fields) continue;
			const seen = key(fields);
			if (seen === id) return "repeat";
			this.unrecorded.delete(seen);
			if (this.pending.has(seen)) recorded.add(seen);
		}
		return recorded;
	}

	deliver(value: unknown): Receipt {
		const input = validateApplicationMessage(value, this.sessionId);
		if (typeof input === "string") return { status: "rejected", message: input };
		const id = key(input);
		const receipt = { status: "requested" as const, reference: applicationReference(input.id) };
		const recorded = this.recordedPending(id);
		if (recorded === "repeat") return receipt;
		if (this.pending.size + this.unrecorded.size >= MAX_PENDING)
			return {
				status: "rejected",
				message: "This conversation has reached its application message limit. No message was sent.",
			};

		const window = standing();
		for (const entry of this.ctx.sessionManager.buildContextEntries()) window.include(application(entry));
		// message_start precedes persistence; a reply listener can deliver another request in that interval.
		for (const [pendingId, row] of this.pending) if (!recorded.has(pendingId)) window.include(row.message.details);
		const message = window.format(input);
		this.pending.set(id, { input, message, phase: this.ctx.isIdle() ? "starting" : "queued" });
		try {
			this.pi.sendMessage(message, { triggerTurn: true, deliverAs: "followUp" });
		} catch {
			this.pending.delete(id);
			return { status: "rejected", message: "Pi refused the application message." };
		}
		return receipt;
	}

	private reply({ input }: Pending, status: "working" | "answer" | "unanswered", text: string, shared?: number): void {
		if (input.reply !== "final") return;
		this.pi.events.emit(REPLY, {
			version: 1,
			extension: input.extension,
			id: input.id,
			status,
			text,
			...(shared === undefined ? {} : { shared }),
		});
	}

	private work(row: Pending): void {
		row.phase = "working";
		this.reply(row, "working", "");
	}

	startMessage(message: TurnEndEvent["message"]): void {
		if (message.role === "user") this.users++;
		if (message.role !== "custom" || message.customType !== APPLICATION_MESSAGE_TYPE || !mark(message.details)) return;
		const row = this.pending.get(key(message.details));
		if (row && (row.phase === "starting" || row.phase === "queued")) this.work(row);
	}

	startTurn(): void {
		const restored = [...this.pending].filter(([, row]) => row.phase === "restored");
		if (!restored.length) return;
		// A later boundary handler can replace a draft. Route only entries that Pi actually kept for this turn.
		const visible = new Set<string>();
		for (const entry of this.ctx.sessionManager.buildContextEntries()) {
			const fields = application(entry);
			if (fields) visible.add(key(fields));
		}
		for (const [id, row] of restored) {
			if (visible.has(id)) this.work(row);
			else {
				this.pending.delete(id);
				this.unrecorded.add(id);
				this.reply(row, "unanswered", "Pi did not keep this request in the context for the next turn.");
			}
		}
	}

	private finishTurn(event: TurnEndEvent): void {
		const message = event.message;
		if (
			message.role !== "assistant" ||
			(message.stopReason !== "stop" && message.stopReason !== "length") ||
			message.content.some((part) => part.type === "toolCall")
		)
			return;
		const answers = this.takeWorking();
		const others = this.users + answers.length - 1;
		this.users = 0;
		if (!answers.length) return;
		const text = message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
		for (const row of answers) {
			if (text.trim() === "") this.reply(row, "unanswered", "Pi ended its answer without text.");
			else this.reply(row, "answer", text, others > 0 ? others : undefined);
		}
	}

	boundary(event: Boundary): BoundaryResult | undefined {
		// The preview predates any request delivered synchronously by a final-answer listener below.
		let drafts: CustomMessageEntryDraft[] | undefined;
		if (this.pending.size && event.context.pendingMessages.length === 0) {
			const queued = [...this.pending.values()].filter((row) => row.phase === "queued");
			if (queued.length) {
				const window = standing();
				for (const entry of event.context.contextEntries) window.include(application(entry.sourceEntry));
				drafts = queued.map((row) => {
					row.message = window.format(row.input);
					row.phase = "restored";
					return { type: "custom_message", ...row.message };
				});
			}
		}
		if (event.type === "turn_end") this.finishTurn(event);
		return drafts ? { entries: [...event.entries, ...drafts] } : undefined;
	}

	private takeWorking(): Pending[] {
		const answers: Pending[] = [];
		for (const [id, row] of this.pending) {
			if (row.phase !== "working") continue;
			this.pending.delete(id);
			if (row.input.reply === "final") answers.push(row);
		}
		return answers;
	}

	settled(aborted: boolean): void {
		this.users = 0;
		for (const row of this.takeWorking()) {
			this.reply(
				row,
				"unanswered",
				aborted ? "Pi stopped before it answered this request." : "Pi ended the run without an answer to this request.",
			);
		}
	}

	end(reason: string, keepReceipts = false): void {
		const rows = [...this.pending];
		this.pending.clear();
		this.users = 0;
		if (keepReceipts) for (const [id] of rows) this.unrecorded.add(id);
		for (const [, row] of rows) this.reply(row, "unanswered", reason);
	}
}

/** The ordinary factory composes the returned drafts with its existing Pi boundary handlers. */
export function registerApplicationMessages(pi: ExtensionAPI): (event: Boundary) => BoundaryResult | undefined {
	let inbox: ApplicationInbox | undefined;
	const receiver = {
		version: 1,
		deliver: (value: unknown): Receipt =>
			inbox?.deliver(value) ?? {
				status: "rejected",
				message: "This application message receiver has no open session.",
			},
	};
	pi.on("session_start", (_event, ctx) => {
		inbox = new ApplicationInbox(pi, ctx);
	});
	pi.on("session_shutdown", (event) => {
		const previous = inbox;
		inbox = undefined;
		previous?.end(
			event.reason === "reload"
				? "Pi reloaded. Read any later answer in the conversation."
				: "The session closed before Pi answered this request.",
		);
	});
	pi.on("session_tree", () => inbox?.end("The conversation changed branches before Pi answered this request.", true));
	pi.on("turn_start", () => inbox?.startTurn());
	pi.on("message_start", (event) => inbox?.startMessage(event.message));
	pi.on("agent_settled", (event) => inbox?.settled(event.aborted));

	pi.events.on(REQUEST, (request) => {
		if (request !== null && typeof request === "object" && "version" in request && request.version === 1)
			pi.events.emit(RECEIVER, receiver);
	});
	pi.events.emit(RECEIVER, receiver);
	return (event) => inbox?.boundary(event);
}
