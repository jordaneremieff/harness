/**
 * The state note of an ordinary session: `agent_work` for a session that a person types into.
 *
 * `continue` ends the turn in the tool call, so a turn that needs nothing from the operator leaves no chat
 * line. Its note is text for the operator, and the card of the call in the transcript is its only display.
 * The note is true when the session writes it and is history when the session works again, so nothing
 * outside the transcript keeps or shows it. An ordinary session has no routed request: the note names no
 * reply route and no dependency, and nothing here calls a host.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { lit, obj, str, type Schema, type Static } from "@earendil-works/pi-schema";
import { matchesSchema } from "./schema-check.ts";
import type { AgentToolCard } from "./tool-cards.ts";

export const ORDINARY_NOTE_CHARS = 1200;

export const ORDINARY_WORK_DESCRIPTION = "End a turn that needs nothing from the operator, with one state note for the operator. continue shows the note as one card in the transcript and ends the turn: no model request follows when it is the only call of its tool batch, so write no chat text with it. Use it when only delegated or background work remains, or after an agent event that needs no decision or act of the operator, no blocker report and no result. Write the note for the operator in plain words, in one or two short sentences: what is open and what happens next. Describe each agent and each piece of work by what it does. Put no internal identifier in the note (no session, submission or request ID): the receipts of your spawn and send calls keep the result references of the open requests. The note is not stored as session state: when the session works again, the card is history, and a later turn that needs nothing from the operator ends with a new continue. The note has no reply route and no dependency.";

const StringEnum = <const T extends readonly string[]>(values: T): Schema<T[number]> => ({ type: "string", enum: [...values] });

export const OrdinaryWorkParams = obj({
	action: StringEnum(["continue"]),
	note: str({ minLength: 1, maxLength: ORDINARY_NOTE_CHARS, description: "The state for the operator in plain words: what is open and what happens next. One or two short sentences, no session, submission or request ID." }),
});

export const OrdinaryWorkOutputSchema = obj({ action: lit("continue"), note: str() });
export type OrdinaryWorkDetails = Static<typeof OrdinaryWorkOutputSchema>;

export const ORDINARY_CONTINUE_TEXT = "The state note is shown to the operator. The turn ends here: write no chat text.";

/**
 * Print and JSON runs answer with their last message, and no person reads the card there. Text print mode
 * prints only a final assistant message, so a turn that ended in the tool call would print nothing, even
 * when the message that holds the call carries text. In those modes the call never ends the turn: its
 * result asks for the answer as one text message instead.
 */
export const ORDINARY_TEXT_ANSWER = "This run has no operator view and prints only its last text message. Do not call agent_work: end the turn with one text message, with no tool call, that states your complete final answer, including results that you already wrote earlier in this run.";

/** Requests for a text answer that one input admits before a further call stops the run. */
export const ORDINARY_TEXT_REQUESTS = 2;

export const ORDINARY_TEXT_REFUSED = `agent_work was called again after ${ORDINARY_TEXT_REQUESTS} requests for a text answer, so this run stops without an answer.`;

/** Custom message type of the request to state the complete answer again after a later input. */
export const ORDINARY_COMPLETE_ANSWER_TYPE = "agent-work-complete-answer";

export const ORDINARY_COMPLETE_ANSWER = "This run prints only its last text message, and a message arrived after your answer. End the run with one text message, with no tool call, that states your complete final answer, including the results that you wrote before that message.";

type Delivered = { role?: unknown; customType?: unknown; content?: unknown; stopReason?: unknown };

function hasText(content: unknown): boolean {
	return Array.isArray(content) && content.some((part: { type?: unknown; text?: unknown }) => part?.type === "text" && typeof part.text === "string" && part.text.trim().length > 0);
}

/**
 * The answer state of a print or JSON run, kept from the messages that the agent loop delivers. A user message
 * or a delivered custom message, such as a background job's completion, is an input. Pi appends context-only
 * messages, such as notes that tools leave for the model, without the loop, so they are not inputs.
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
			if (this.answered) this.laterInput = true;
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

	/** True once after an input that arrived when the run had already answered, so the printed answer can be partial. */
	restate(): boolean {
		const due = this.laterInput;
		this.laterInput = false;
		return due;
	}
}

const machineMode = (mode: unknown) => mode === "print" || mode === "json";

/** Register the ordinary `agent_work`. The caller owns `card`, so the registered renderers are the same references that it publishes for display. */
export function registerOrdinaryWork(pi: Pick<ExtensionAPI, "registerTool" | "on">, card: AgentToolCard): void {
	let answer = new PrintAnswer();
	pi.on("session_start", () => { answer = new PrintAnswer(); });
	// The answer state belongs to one run. An input that starts a later run follows no answer of that run.
	pi.on("agent_settled", () => { answer = new PrintAnswer(); });
	pi.on("message_end", (event, ctx) => { if (machineMode(ctx.mode)) answer.delivered(event.message as Delivered); });
	// An input after the answer, such as a job completion, gets a reply that print mode would print alone; the run
	// states its complete answer once more before it settles.
	pi.on("agent_before_settle", (event, ctx) => {
		if (!machineMode(ctx.mode) || !answer.restate()) return undefined;
		return { entries: [...event.entries, { type: "custom_message", customType: ORDINARY_COMPLETE_ANSWER_TYPE, content: ORDINARY_COMPLETE_ANSWER, display: false }], continue: true };
	});
	pi.registerTool({
		name: "agent_work",
		label: "Agent work",
		description: ORDINARY_WORK_DESCRIPTION,
		promptSnippet: "End a turn that needs nothing from the operator with one state note and no chat text",
		parameters: OrdinaryWorkParams,
		outputSchema: OrdinaryWorkOutputSchema,
		async execute(_callId, input: Static<typeof OrdinaryWorkParams>, _signal, _update, ctx) {
			if (!matchesSchema(OrdinaryWorkParams, input)) throw new Error("agent_work takes action continue and a note");
			const details: OrdinaryWorkDetails = { action: "continue", note: input.note };
			if (machineMode(ctx.mode)) {
				if (!answer.remind()) {
					// The aborted run ends in an aborted assistant message, which text print mode reports on stderr with exit code 1.
					if (ctx.mode === "print") process.stderr.write(`${ORDINARY_TEXT_REFUSED}\n`);
					ctx.abort();
					throw new Error(ORDINARY_TEXT_REFUSED);
				}
				return { content: [{ type: "text", text: ORDINARY_TEXT_ANSWER }], details, structuredContent: details };
			}
			return { content: [{ type: "text", text: ORDINARY_CONTINUE_TEXT }], details, structuredContent: details, terminate: true };
		},
		renderCall: card.renderCall,
		renderResult: card.renderResult,
	});
}
