/**
 * The state note of an ordinary session: `agent_work` for a session that a person types into.
 *
 * `continue` keeps one note as the current state of the session, shows it in a widget above the input, and
 * ends the turn in the tool call, so a turn that needs nothing from the operator leaves no chat line.
 * `complete` clears the note and the widget. An ordinary session has no routed request: the note names no
 * reply route and no dependency, and nothing here calls a host.
 */
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { bool, int, lit, obj, opt, str, union, type Schema, type Static } from "@earendil-works/pi-schema";
import { truncateToWidth, wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";
import { matchesSchema } from "./schema-check.ts";
import { displayText, ordinaryWorkCard } from "./tool-cards.ts";

/** Session entry that keeps the note across a reload; `note: null` records that it was cleared. */
export const ORDINARY_WORK_ENTRY = "agent.state-note";
export const ORDINARY_WORK_WIDGET = "agent-work";
export const ORDINARY_NOTE_CHARS = 1200;
const WIDGET_NOTE_LINES = 3;

export type OrdinaryWorkNote = { readonly note: string; readonly at: number };

export const ORDINARY_WORK_DESCRIPTION = "Keep one state note for this session, or clear it. continue stores the note as the current state of the session, shows it in a widget above the input, and ends the turn: no model request follows when it is the only call of its tool batch, so write no chat text with it. Use it when an agent event needs no decision or act of the operator, no blocker report and no result. A repeated continue replaces the note. complete clears the note and the widget and does not end the turn. The note has no reply route and no dependency.";

const StringEnum = <const T extends readonly string[]>(values: T): Schema<T[number]> => ({ type: "string", enum: [...values] });
const noteText = str({ minLength: 1, maxLength: ORDINARY_NOTE_CHARS });

/** One object root for every provider; the action-specific shapes apply at execution. */
export const OrdinaryWorkParams = obj({
	action: StringEnum(["continue", "complete"]),
	note: opt(str({ minLength: 1, maxLength: ORDINARY_NOTE_CHARS, description: "continue only, required: the current state of the session, for the operator." })),
});
const ContinueParams = obj({ action: lit("continue"), note: noteText });
const CompleteParams = obj({ action: lit("complete") });

export const OrdinaryWorkOutputSchema = obj({
	action: union([lit("continue"), lit("complete")]),
	note: opt(str()),
	/** Time of the note, in milliseconds. */
	at: opt(int({ minimum: 0 })),
	/** complete: whether a note was there to clear. */
	cleared: opt(bool()),
});
export type OrdinaryWorkDetails = Static<typeof OrdinaryWorkOutputSchema>;

export const ORDINARY_CONTINUE_TEXT = "The state note is stored and shown to the operator. The turn ends here: write no chat text.";
const COMPLETE_TEXT = "The state note is cleared.";

/** The widget: a title with the local time of the note, then the note on at most three lines. */
export function ordinaryWorkWidget(state: OrdinaryWorkNote, theme: Pick<Theme, "fg">): Component {
	const time = new Date(state.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
	return {
		invalidate() {},
		render(width: number): string[] {
			const lines = wrapTextWithAnsi(displayText(state.note).replace(/\s+/gu, " ").trim(), Math.max(1, width));
			const shown = lines.slice(0, WIDGET_NOTE_LINES);
			if (lines.length > WIDGET_NOTE_LINES) shown[WIDGET_NOTE_LINES - 1] = truncateToWidth(`${shown[WIDGET_NOTE_LINES - 1]} ${lines[WIDGET_NOTE_LINES]}`, Math.max(1, width), "…");
			return [truncateToWidth(theme.fg("muted", `agent state · ${time}`), Math.max(1, width), "…"), ...shown.map((line) => theme.fg("text", line))];
		},
	};
}

type WorkUi = Pick<ExtensionContext, "hasUI"> & { readonly ui: Pick<ExtensionContext["ui"], "setWidget"> };

function show(ctx: WorkUi, state: OrdinaryWorkNote | undefined): void {
	if (!ctx.hasUI) return;
	if (state === undefined) ctx.ui.setWidget(ORDINARY_WORK_WIDGET, undefined);
	else ctx.ui.setWidget(ORDINARY_WORK_WIDGET, (_tui, theme) => ordinaryWorkWidget(state, theme));
}

/** The note that the newest entry of the current branch keeps; undefined when it was cleared or never set. */
function retainedNote(ctx: Pick<ExtensionContext, "sessionManager">): OrdinaryWorkNote | undefined {
	const entry = ctx.sessionManager.getBranch().findLast((candidate) => candidate.type === "custom" && candidate.customType === ORDINARY_WORK_ENTRY);
	const data = entry?.type === "custom" ? entry.data as { note?: unknown; at?: unknown } | undefined : undefined;
	return typeof data?.note === "string" && typeof data.at === "number" ? { note: data.note, at: data.at } : undefined;
}

/** Register the ordinary `agent_work` and restore its note and widget when a session starts. */
export function registerOrdinaryWork(pi: Pick<ExtensionAPI, "registerTool" | "appendEntry" | "on">, now: () => number = Date.now): void {
	let current: OrdinaryWorkNote | undefined;
	const card = ordinaryWorkCard();
	pi.on("session_start", (_event, ctx) => {
		current = retainedNote(ctx);
		show(ctx, current);
	});
	pi.registerTool({
		name: "agent_work",
		label: "Agent work",
		description: ORDINARY_WORK_DESCRIPTION,
		promptSnippet: "Keep or clear the state note of this session; continue ends the turn without chat text",
		parameters: OrdinaryWorkParams,
		outputSchema: OrdinaryWorkOutputSchema,
		async execute(_callId, input: Static<typeof OrdinaryWorkParams>, _signal, _update, ctx) {
			if (matchesSchema(ContinueParams, input)) {
				current = { note: input.note, at: now() };
				pi.appendEntry(ORDINARY_WORK_ENTRY, current);
				show(ctx, current);
				const details: OrdinaryWorkDetails = { action: "continue", note: current.note, at: current.at };
				return { content: [{ type: "text", text: ORDINARY_CONTINUE_TEXT }], details, structuredContent: details, terminate: true };
			}
			if (!matchesSchema(CompleteParams, input)) throw new Error("continue requires note; complete takes only action");
			const cleared = current !== undefined;
			current = undefined;
			if (cleared) pi.appendEntry(ORDINARY_WORK_ENTRY, { note: null, at: now() });
			show(ctx, undefined);
			const details: OrdinaryWorkDetails = { action: "complete", cleared };
			return { content: [{ type: "text", text: COMPLETE_TEXT }], details, structuredContent: details };
		},
		renderCall: card.renderCall,
		renderResult: card.renderResult,
	});
}
