import type { CollaborationEvent } from "./collaboration-contract.ts";
import type { Communication } from "./communication.ts";
import { threadExcerpt } from "./thread-notice-projection.ts";

/**
 * UTF-16 code units of event text that the display copy of a passive notice keeps. The model text of a
 * passive notice carries no event text; this copy reaches only cards and status lines, and the full event
 * stays in the thread.
 */
export const THREAD_NOTICE_DISPLAY_UNITS = 280;

type NoticeCommunication = Extract<Communication, { kind: "notice" }>;

/** What one thread event is, in lower case, as the title of a card about it. */
const EVENT_TITLES: Readonly<Record<string, string>> = {
	contribution: "thread post",
	"carried-authority": "operator direction",
	join: "member joined",
	leave: "member left",
	close: "thread closed",
	revise: "frame revised",
	create: "thread created",
};

/** The card title of an event kind; an absent or unknown kind is a plain thread notice. */
export function threadEventTitle(kind: string | undefined): string {
	return (kind === undefined ? undefined : EVENT_TITLES[kind]) ?? "thread notice";
}

/** Frame fields of a create or revise event, with the labels of the Threads view's details. */
const FRAME_FIELDS = [
	["purpose", "Purpose"],
	["authority", "Operator direction (as carried)"],
	["source", "Source"],
	["restrictions", "Restrictions"],
	["acceptance", "Acceptance"],
] as const;

/** Texts the thread records for a join or leave without a statement; the card header already says it. */
const STATEMENT_DEFAULTS: Readonly<Record<string, string>> = { join: "Joined the thread.", leave: "Left the thread." };

function frameText(message: string): string {
	let frame: unknown;
	try {
		frame = JSON.parse(message);
	} catch {
		return message;
	}
	if (frame === null || typeof frame !== "object" || Array.isArray(frame)) return message;
	const fields = frame as Record<string, unknown>;
	return FRAME_FIELDS.flatMap(([key, label]) => {
		const value = fields[key];
		return typeof value === "string" && value.trim() !== "" ? [`**${label}:** ${value.trim()}`] : [];
	}).join("\n\n");
}

/**
 * What the event says, for a person: a post, a join or leave statement or the conclusion of a close, each
 * with its source, or the labelled fields of a created or revised frame instead of its stored JSON.
 */
export function threadEventDisplayText(event: Pick<CollaborationEvent, "kind" | "message" | "source">): string {
	if (event.kind === "create" || event.kind === "revise") return frameText(event.message);
	const message = STATEMENT_DEFAULTS[event.kind] === event.message ? "" : event.message.trim();
	const source = event.source.trim() === "" ? "" : `Source: ${event.source.trim()}`;
	return [message, source].filter(Boolean).join("\n\n");
}

/** The display copy of one notice: the whole event text for a notified recipient, an excerpt for a passive one. */
export function threadNoticeDisplayText(
	event: Pick<CollaborationEvent, "kind" | "message" | "source">,
	passive: boolean,
): string {
	const text = threadEventDisplayText(event);
	if (!passive) return text;
	const excerpt = threadExcerpt(text, THREAD_NOTICE_DISPLAY_UNITS);
	return excerpt.cut ? `${excerpt.text}…` : excerpt.text;
}

/**
 * One line that leads with what happened: the event, its number and thread, then the start of the text.
 * A retained sender name joins it; a bare identity stays out, because it tells a reader nothing that the
 * thread does not show.
 */
export function threadNoticeSummary(value: NoticeCommunication): string {
	const title = threadEventTitle(value.metadata.eventKind);
	const event = value.metadata.event === undefined ? "" : ` #${value.metadata.event}`;
	const thread = value.metadata.title?.trim() ? `“${value.metadata.title.trim()}”` : value.metadata.threadId;
	const sender = value.sender.name?.trim() ? ` from ${value.sender.name.trim()}` : "";
	const lead = `${title.charAt(0).toUpperCase()}${title.slice(1)}${event} in ${thread}${sender}`;
	const text = value.body.text.replace(/\s+/gu, " ").trim();
	return text ? `${lead}: ${text}` : lead;
}
