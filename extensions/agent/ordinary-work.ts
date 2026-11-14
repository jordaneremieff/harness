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
 * Print and JSON runs answer with their last text message, and no person reads the card there. A turn that
 * ended in the tool call would leave that answer empty, for example after a follow-up message that arrived
 * once the answer was written, so the turn continues to a text answer instead.
 */
export const ORDINARY_TEXT_ANSWER = "This run has no operator view, and its output is its last text message. Write no state note: end the turn with a text message that states your complete final answer, including any result that you already wrote before this turn.";

/** Register the ordinary `agent_work`. The caller owns `card`, so the registered renderers are the same references that it publishes for display. */
export function registerOrdinaryWork(pi: Pick<ExtensionAPI, "registerTool">, card: AgentToolCard): void {
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
			if (ctx.mode === "print" || ctx.mode === "json") return { content: [{ type: "text", text: ORDINARY_TEXT_ANSWER }], details, structuredContent: details };
			return { content: [{ type: "text", text: ORDINARY_CONTINUE_TEXT }], details, structuredContent: details, terminate: true };
		},
		renderCall: card.renderCall,
		renderResult: card.renderResult,
	});
}
