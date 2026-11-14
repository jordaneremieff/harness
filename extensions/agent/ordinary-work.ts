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

type Entry = { type?: unknown; message?: { role?: unknown; toolName?: unknown; content?: unknown } };

/** The requests for a text answer since the latest user or custom message, which starts a new count. */
function textRequests(entries: readonly Entry[]): number {
	let count = 0;
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry?.type === "custom_message" || (entry?.type === "message" && entry.message?.role === "user")) break;
		const message = entry?.type === "message" ? entry.message : undefined;
		if (message?.role === "toolResult" && message.toolName === "agent_work" && Array.isArray(message.content) && message.content.some((part: { text?: unknown }) => part?.text === ORDINARY_TEXT_ANSWER)) count++;
	}
	return count;
}

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
			if (ctx.mode === "print" || ctx.mode === "json") {
				if (textRequests(ctx.sessionManager.getBranch() as readonly Entry[]) >= ORDINARY_TEXT_REQUESTS) {
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
