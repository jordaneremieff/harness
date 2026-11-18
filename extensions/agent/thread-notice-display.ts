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

/** What one thread event did, as a verb phrase whose object is the thread. */
const EVENT_PHRASES: Readonly<Record<string, string>> = {
	contribution: "posted in",
	"carried-authority": "relayed operator direction in",
	join: "joined",
	leave: "left",
	close: "closed",
	revise: "revised the frame of",
	create: "created",
};

/** The verb phrase of a known event kind; an absent or unknown kind has none. */
export function threadEventPhrase(kind: string | undefined): string | undefined {
	return kind === undefined ? undefined : EVENT_PHRASES[kind];
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
	try { frame = JSON.parse(message); }
	catch { return message; }
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
export function threadNoticeDisplayText(event: Pick<CollaborationEvent, "kind" | "message" | "source">, passive: boolean): string {
	const text = threadEventDisplayText(event);
	if (!passive) return text;
	const excerpt = threadExcerpt(text, THREAD_NOTICE_DISPLAY_UNITS);
	return excerpt.cut ? `${excerpt.text}…` : excerpt.text;
}

/**
 * One line that says what happened in a thread: who, what, which thread and event, and the start of the
 * text. It names the sender by retained name or exact identity, because no roster is in reach here.
 */
export function threadNoticeSummary(value: NoticeCommunication): string {
	const sender = value.sender.name?.trim() || value.sender.identity;
	const title = value.metadata.title?.trim();
	const thread = title ? `thread “${title}”` : `thread ${value.metadata.threadId}`;
	const event = value.metadata.event === undefined ? "" : ` (#${value.metadata.event})`;
	const phrase = threadEventPhrase(value.metadata.eventKind);
	const lead = phrase ? `${sender} ${phrase} ${thread}${event}` : `Thread notice from ${sender} in ${thread}${event}`;
	const text = value.body.text.replace(/\s+/gu, " ").trim();
	return text ? `${lead}: ${text}` : lead;
}
