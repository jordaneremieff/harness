/**
 * The state note of an ordinary session: `agent_yield` for a session that a person types into.
 *
 * The call ends the turn while work that the session sent to agents is still open, so the turn leaves no chat
 * line; an agent result, a message or the operator's input starts the next turn. Its note is text for the
 * operator, and the card of the call in the transcript is its only display. The note is true when the session
 * writes it and is history when the session works again, so nothing outside the transcript keeps or shows it.
 * An ordinary session has no routed request: the note names no reply route and no dependency, and nothing here
 * calls a host. A native agent's `agent_work`, which
 * declares and closes background work, is a different tool.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { arr, int, obj, opt, str, type Schema, type Static } from "@earendil-works/pi-schema";
import type { ContinuityFact } from "./continuity-facts.ts";
import { matchesSchema } from "./schema-check.ts";
import type { AgentToolCard } from "./tool-cards.ts";

/** The name of the ordinary session's tool. */
export const ORDINARY_YIELD_TOOL = "agent_yield";

export const ORDINARY_NOTE_CHARS = 1200;

export const ORDINARY_WORK_DESCRIPTION = "End the turn while work that this session sent to agents is still open and no other work of yours is ready, with one state note for the operator. The call shows the note as one card in the transcript. It returns no result of an agent: agent results, messages and operator input arrive as events and start the next turn. Write the note for the operator in plain words, in one or two short sentences: what still runs and what happens next. The card shows that the turn ended, so the note does not say that the operator has nothing to do. Describe each agent and each piece of work by what it does. Put no internal identifier in the note (no session, submission or request ID): the receipts of your spawn and send calls keep the result references of the open requests. Pi ends the turn only when every call in the last tool batch ends the turn: make this call in the last batch, alone or with other calls that also end the turn, and write no chat text with it. The note and the card cover only work sent to agents: when other work of this session also runs and has its own tool that ends the turn, call that tool in the same batch, so that each kind of open work has its own card. The note is not stored as session state: when the session works again, the card is history, and a later turn that ends the same way makes a new agent_yield call. The note has no reply route and no dependency.";

const StringEnum = <const T extends readonly string[]>(values: T): Schema<T[number]> => ({ type: "string", enum: [...values] });

export const OrdinaryWorkParams = obj({
	note: str({ minLength: 1, maxLength: ORDINARY_NOTE_CHARS, description: "The state for the operator in plain words: what still runs and what happens next. One or two short sentences, no session, submission or request ID." }),
});

/** Open requests that a card lists, at most; the count of the rest stays in `waitingOmitted`. */
export const ORDINARY_WAITING_ROWS = 16;

const WaitingRowSchema = obj({
	sessionId: str(),
	state: StringEnum(["admitted", "unconfirmed", "scheduled"]),
});

/**
 * The note, and in a session with an operator view also the time the turn ended and the requests that this
 * session routed to itself and that had no delivered result then. The card shows them; the model does not
 * receive them.
 */
export const OrdinaryWorkOutputSchema = obj({
	note: str(),
	at: opt(int({ minimum: 0 })),
	waiting: opt(arr(WaitingRowSchema, { maxItems: ORDINARY_WAITING_ROWS })),
	waitingOmitted: opt(int({ minimum: 1 })),
});
export type OrdinaryWorkDetails = Static<typeof OrdinaryWorkOutputSchema>;
export type OrdinaryWaitingRow = Static<typeof WaitingRowSchema>;

export interface OrdinaryWorkOptions {
	/** The open requests of one session, as the continuity facts of this session hold them. */
	readonly waiting?: (sessionId: string) => readonly ContinuityFact[];
	readonly now?: () => number;
}

function waitingRow(fact: ContinuityFact): OrdinaryWaitingRow {
	return { sessionId: fact.sessionId, state: fact.timerId !== undefined ? "scheduled" : fact.phase === "admitted" ? "admitted" : "unconfirmed" };
}

export const ORDINARY_CONTINUE_TEXT = "The state note is shown to the operator. The turn ends here: write no chat text.";

/**
 * Print and JSON runs answer with their last message, and no person reads the card there. Text print mode
 * prints only a final assistant message, so a turn that ended in the tool call would print nothing, even
 * when the message that holds the call carries text. In those modes the call never ends the turn: its
 * result asks for the answer as one text message instead.
 */
export const ORDINARY_TEXT_ANSWER = "This run has no operator view and prints only its last text message. Do not call agent_yield: end the turn with one text message, with no tool call, that states your complete final answer, including results that you already wrote earlier in this run.";

/** Requests for a text answer that one input admits before a further call stops the run. */
export const ORDINARY_TEXT_REQUESTS = 2;

export const ORDINARY_TEXT_REFUSED = `agent_yield was called again after ${ORDINARY_TEXT_REQUESTS} requests for a text answer, so this run stops without an answer.`;

/** Custom message type of the request to state the complete answer again after a later message from an agent. */
export const ORDINARY_COMPLETE_ANSWER_TYPE = "agent-yield-complete-answer";

/** Custom message type of the messages that this extension delivers from other sessions. */
const AGENT_PEER_MESSAGE = "agent.peer";

export const ORDINARY_COMPLETE_ANSWER = "This run prints only its last text message, and a message arrived after your answer. End the run with one text message, with no tool call, that states your complete final answer, including the results that you wrote before that message.";

type Delivered = { role?: unknown; customType?: unknown; content?: unknown; stopReason?: unknown };

function hasText(content: unknown): boolean {
	return Array.isArray(content) && content.some((part: { type?: unknown; text?: unknown }) => part?.type === "text" && typeof part.text === "string" && part.text.trim().length > 0);
}

/**
 * The answer state of a print or JSON run, kept from the messages that the agent loop delivers. A user message
 * or a delivered custom message is an input and starts a new reminder count. Pi appends context-only messages,
 * such as notes that tools leave for the model, without the loop, so they are not inputs. Only a message that
 * this extension delivers from another session asks for the complete answer again after the run answered.
 */
export class PrintAnswer {
	private reminders = 0;
	private answered = false;
	private laterInput = false;

	delivered(message: Delivered): void {
		if (message.role === "user") {
			this.reminders = 0;
			this.answered = false;
			this.laterInput = false;
		} else if (message.role === "custom" && message.customType !== ORDINARY_COMPLETE_ANSWER_TYPE) {
			this.reminders = 0;
			if (this.answered && message.customType === AGENT_PEER_MESSAGE) this.laterInput = true;
		} else if (message.role === "assistant" && message.stopReason !== "error" && message.stopReason !== "aborted" && hasText(message.content)) {
			this.answered = true;
		}
	}

	/** Counts one reminder of the current input; false when the input has had all its reminders. */
	remind(): boolean {
		if (this.reminders >= ORDINARY_TEXT_REQUESTS) return false;
		this.reminders += 1;
		// The reminder itself asks for the complete answer, including earlier results.
		this.laterInput = false;
		return true;
	}

	/** True once after a message from another session that arrived when the run had already answered, so the printed answer can be partial. */
	restate(): boolean {
		const due = this.laterInput;
		this.laterInput = false;
		return due;
	}
}

const machineMode = (mode: unknown) => mode === "print" || mode === "json";

/** Register the ordinary `agent_yield`. The caller owns `card`, so the registered renderers are the same references that it publishes for display. */
export function registerOrdinaryWork(pi: Pick<ExtensionAPI, "registerTool" | "on">, card: AgentToolCard, options: OrdinaryWorkOptions = {}): void {
	let answer = new PrintAnswer();
	pi.on("session_start", () => { answer = new PrintAnswer(); });
	// The answer state belongs to one run. An input that starts a later run follows no answer of that run.
	pi.on("agent_settled", () => { answer = new PrintAnswer(); });
	pi.on("message_end", (event, ctx) => { if (machineMode(ctx.mode)) answer.delivered(event.message as Delivered); });
	// A message from another session after the answer gets a reply that print mode would print alone; the run
	// states its complete answer once more before it settles.
	pi.on("agent_before_settle", (event, ctx) => {
		if (!machineMode(ctx.mode) || !answer.restate()) return undefined;
		return { entries: [...event.entries, { type: "custom_message", customType: ORDINARY_COMPLETE_ANSWER_TYPE, content: ORDINARY_COMPLETE_ANSWER, display: false }], continue: true };
	});
	pi.registerTool({
		name: ORDINARY_YIELD_TOOL,
		label: "Agent yield",
		description: ORDINARY_WORK_DESCRIPTION,
		promptSnippet: "End the turn while work sent to agents is still open, with one state note and no chat text",
		parameters: OrdinaryWorkParams,
		outputSchema: OrdinaryWorkOutputSchema,
		async execute(_callId, input: Static<typeof OrdinaryWorkParams>, _signal, _update, ctx) {
			if (!matchesSchema(OrdinaryWorkParams, input)) throw new Error(`${ORDINARY_YIELD_TOOL} takes a note`);
			const details: OrdinaryWorkDetails = { note: input.note };
			if (machineMode(ctx.mode)) {
				if (!answer.remind()) {
					// The aborted run ends in an aborted assistant message, which text print mode reports on stderr with exit code 1.
					if (ctx.mode === "print") process.stderr.write(`${ORDINARY_TEXT_REFUSED}\n`);
					ctx.abort();
					throw new Error(ORDINARY_TEXT_REFUSED);
				}
				return { content: [{ type: "text", text: ORDINARY_TEXT_ANSWER }], details, structuredContent: details };
			}
			const open = options.waiting?.(ctx.sessionManager.getSessionId()).map(waitingRow) ?? [];
			const shown: OrdinaryWorkDetails = {
				...details,
				at: (options.now ?? Date.now)(),
				waiting: open.slice(0, ORDINARY_WAITING_ROWS),
				...(open.length > ORDINARY_WAITING_ROWS ? { waitingOmitted: open.length - ORDINARY_WAITING_ROWS } : {}),
			};
			return { content: [{ type: "text", text: ORDINARY_CONTINUE_TEXT }], details: shown, structuredContent: shown, terminate: true };
		},
		renderCall: card.renderCall,
		renderResult: card.renderResult,
		...(card.renderShell === undefined ? {} : { renderShell: card.renderShell }),
	});
}
