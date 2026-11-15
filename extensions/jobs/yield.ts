/**
 * `jobs_yield`: an ordinary session ends its turn while only its own background jobs remain. Each job's
 * completion message starts the next turn, so the session writes no chat line meanwhile. The call's card in
 * the transcript shows the note and the jobs; nothing outside the transcript keeps them.
 *
 * Print and JSON runs answer with their last text message and have no operator view, so they do not offer the
 * tool. A job completion that arrives there after the run already answered gets one request for the complete
 * answer before the run settles, because text print mode prints only the final message.
 */
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { arr, int, obj, opt, str, type Schema, type Static } from "@earendil-works/pi-schema";
import { JOB_COMPLETION_MESSAGE } from "./completion.ts";

export const YIELD_TOOL = "jobs_yield";
export const YIELD_NOTE_CHARS = 1200;
/** Jobs that one result lists, at most; the count of the rest stays in `omitted`. */
export const YIELD_ROWS = 8;

const StringEnum = <const T extends readonly string[]>(values: T): Schema<T[number]> => ({ type: "string", enum: [...values] });

export const YieldParams = obj({
	note: str({ minLength: 1, maxLength: YIELD_NOTE_CHARS, description: "The state for the operator in plain words: what still runs and what happens next. One or two short sentences." }),
}, { open: false });

/** `running`: the command runs. `settled`: the command ended and its completion message is still to arrive in the conversation. */
export type YieldJobState = "running" | "settled";
const YieldRowSchema = obj({
	id: str(),
	commandPreview: opt(str()),
	state: StringEnum(["running", "settled"]),
});
export type YieldRow = Static<typeof YieldRowSchema>;

export const YieldOutputSchema = obj({
	note: str(),
	at: int({ minimum: 0 }),
	jobs: arr(YieldRowSchema, { maxItems: YIELD_ROWS }),
	omitted: opt(int({ minimum: 1 })),
});
export type YieldDetails = Static<typeof YieldOutputSchema>;

export const YIELD_DESCRIPTION = "End the turn while background jobs of this session still run and no other work of yours is ready, with one short state note for the operator. Each job's completion arrives as a jobs.completion message and starts the next turn, so do not poll. The call shows the note as one card in the transcript, with the jobs that remain. Write the note in plain words, in one or two short sentences: what still runs and what happens next. The card shows that the turn ended, so the note does not say that the operator has nothing to do. Pi ends the turn only when every call in the last tool batch ends the turn: make this call in the last batch, alone or with other calls that also end the turn, and write no chat text with it. The note and the card cover only this session's jobs: when other work of this session is also open and has its own tool that ends the turn, call that tool in the same batch, so that each kind of open work has its own card. When no job of this session is still to deliver a completion, the call fails; give the answer as a text message then.";

export const YIELD_SNIPPET = "End the turn while this session's background jobs run, with one state note and no chat text";

export const YIELD_GUIDELINE = "When background jobs of this session still run and no other work of yours is ready, call jobs_yield with a short note instead of writing a chat message; each job's completion starts the next turn.";

export const YIELD_ENDED_TEXT = "The turn ends here: write no chat text. Each job completion starts the next turn.";

export const YIELD_REFUSED = "No job completion is coming: this session has no running job and no completion still to arrive. Give your answer as a text message.";

/** Custom message type of the request to state the complete answer again after a later job completion. */
export const COMPLETE_ANSWER_TYPE = "jobs-complete-answer";

export const COMPLETE_ANSWER = "This run prints only its last text message, and a job completion arrived after your answer. End the run with one text message, with no tool call, that states your complete final answer, including the results that you wrote before that completion.";

const machineMode = (mode: unknown) => mode === "print" || mode === "json";

type Delivered = { role?: unknown; customType?: unknown; content?: unknown; stopReason?: unknown };

function hasText(content: unknown): boolean {
	return Array.isArray(content) && content.some((part: { type?: unknown; text?: unknown }) => part?.type === "text" && typeof part.text === "string" && part.text.trim().length > 0);
}

/** The answer state of one print or JSON run, kept from the messages that the agent loop delivers. */
export class LateCompletion {
	private answered = false;
	private late = false;

	delivered(message: Delivered): void {
		if (message.role === "user") {
			this.answered = false;
			this.late = false;
		} else if (message.role === "custom" && message.customType === JOB_COMPLETION_MESSAGE) {
			if (this.answered) this.late = true;
		} else if (message.role === "assistant" && message.stopReason !== "error" && message.stopReason !== "aborted" && hasText(message.content)) {
			this.answered = true;
		}
	}

	/** True once after a job completion that arrived when the run had already answered. */
	due(): boolean {
		const due = this.late;
		this.late = false;
		return due;
	}
}

export interface YieldOptions {
	/** This session's jobs whose completion is still to arrive in the conversation, oldest first. */
	readonly open: () => readonly YieldRow[];
	readonly now?: () => number;
	readonly renderCall?: ToolDefinition["renderCall"];
	readonly renderResult?: ToolDefinition["renderResult"];
	readonly renderShell?: ToolDefinition["renderShell"];
}

/** Register `jobs_yield` and the print and JSON handling of a late job completion. */
export function registerYield(pi: Pick<ExtensionAPI, "registerTool" | "on">, options: YieldOptions): void {
	let answer = new LateCompletion();
	pi.on("session_start", () => { answer = new LateCompletion(); });
	// The answer state belongs to one run: a completion that starts a later run follows no answer of that run.
	pi.on("agent_settled", () => { answer = new LateCompletion(); });
	pi.on("before_agent_start", (event, ctx) => {
		if (!machineMode(ctx.mode)) return;
		const selected = event.systemPromptOptions.selectedTools;
		const index = selected?.indexOf(YIELD_TOOL) ?? -1;
		if (selected && index >= 0) selected.splice(index, 1);
	});
	pi.on("message_end", (event, ctx) => { if (machineMode(ctx.mode)) answer.delivered(event.message as Delivered); });
	pi.on("agent_before_settle", (event, ctx) => {
		if (!machineMode(ctx.mode) || !answer.due()) return undefined;
		return { entries: [...event.entries, { type: "custom_message", customType: COMPLETE_ANSWER_TYPE, content: COMPLETE_ANSWER, display: false }], continue: true };
	});
	pi.registerTool({
		name: YIELD_TOOL,
		label: "Jobs yield",
		description: YIELD_DESCRIPTION,
		promptSnippet: YIELD_SNIPPET,
		promptGuidelines: [YIELD_GUIDELINE],
		parameters: YieldParams,
		outputSchema: YieldOutputSchema,
		async execute(_callId, input: Static<typeof YieldParams>, signal, _update, _ctx: ExtensionContext) {
			signal?.throwIfAborted();
			if (typeof input?.note !== "string" || input.note.trim().length === 0 || input.note.length > YIELD_NOTE_CHARS) throw new Error(`${YIELD_TOOL} takes a note of 1 to ${YIELD_NOTE_CHARS} characters.`);
			const open = options.open();
			if (open.length === 0) throw new Error(YIELD_REFUSED);
			const details: YieldDetails = {
				note: input.note,
				at: (options.now ?? Date.now)(),
				jobs: open.slice(0, YIELD_ROWS),
				...(open.length > YIELD_ROWS ? { omitted: open.length - YIELD_ROWS } : {}),
			};
			return { content: [{ type: "text", text: YIELD_ENDED_TEXT }], details, structuredContent: details, terminate: true };
		},
		...(options.renderCall ? { renderCall: options.renderCall } : {}),
		...(options.renderResult ? { renderResult: options.renderResult } : {}),
		...(options.renderShell ? { renderShell: options.renderShell } : {}),
	});
}
