import { stripVTControlCharacters } from "node:util";
import type { CollaborationList, CollaborationPage } from "./collaboration-contract.ts";

/** One call to the collaboration owner, through the host's agent_collaborate route. */
export type Collaborate = (input: Record<string, unknown>) => Promise<unknown>;
/** One discovery page: thread summaries plus the storages that hold more. */
export type ThreadDiscovery = CollaborationList & { sources?: Array<{ sessionId: string; omitted: number; unavailable: boolean }> };

/** A draft post to one thread. It stays until the owner retains it. */
export interface ThreadDraft {
	text: string;
	revision: number;
	notify: string[];
	pending: boolean;
	replyTo?: number;
	/** The request ID of an uncertain post; a retry of the same content reuses it. */
	request?: { id: string; content: string };
}

/** Thread drafts and the selected thread, kept for the session while the dashboard closes and opens. */
export interface ThreadsState {
	selected?: string;
	drafts: Map<string, ThreadDraft>;
}

export function createThreadsState(): ThreadsState {
	return { drafts: new Map() };
}

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object";
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === "string");
const number = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

function summary(value: unknown): boolean {
	return (
		object(value) &&
		["id", "title", "purpose"].every((key) => typeof value[key] === "string") &&
		number(value.updatedAt) &&
		typeof value.closed === "boolean" &&
		number(value.members)
	);
}

/** A discovery page in the owner's shape; anything else is refused, never adapted. */
export function threadDiscovery(value: unknown): value is ThreadDiscovery {
	return (
		object(value) &&
		Array.isArray(value.items) &&
		value.items.every(summary) &&
		(value.nextCursor === null || typeof value.nextCursor === "string") &&
		object(value.coverage) &&
		typeof value.coverage.complete === "boolean" &&
		number(value.coverage.visited) &&
		number(value.coverage.omitted) &&
		(value.coverage.unavailable === undefined || number(value.coverage.unavailable)) &&
		(value.sources === undefined ||
			(Array.isArray(value.sources) &&
				value.sources.every((item) => object(item) && typeof item.sessionId === "string" && number(item.omitted) && typeof item.unavailable === "boolean")))
	);
}

/** A thread page in the owner's shape; anything else is refused, never adapted. */
export function threadPage(value: unknown): value is CollaborationPage {
	if (!object(value) || !object(value.thread) || !Array.isArray(value.events) || value.events.length > 20 || !object(value.coverage)) return false;
	const thread = value.thread;
	return (
		["id", "title", "purpose", "authority", "source", "restrictions", "acceptance", "integrator", "creator"].every(
			(key) => typeof thread[key] === "string" && thread[key].length <= 4000,
		) &&
		["revision", "sequence", "createdAt", "updatedAt"].every((key) => number(thread[key])) &&
		typeof thread.closed === "boolean" &&
		Array.isArray(thread.members) &&
		thread.members.length <= 64 &&
		thread.members.every(
			(item) =>
				object(item) &&
				typeof item.identity === "string" &&
				item.identity.length <= 256 &&
				typeof item.contribution === "string" &&
				item.contribution.length <= 256 &&
				number(item.joinedAt),
		) &&
		value.events.every(
			(event) =>
				object(event) &&
				["threadId", "sender", "kind", "message", "source"].every((key) => typeof event[key] === "string" && event[key].length <= 48 * 1024) &&
				(event.origin === "operator" || event.origin === "model") &&
				["sequence", "at", "revision"].every((key) => number(event[key])) &&
				(event.replyTo === null || number(event.replyTo)) &&
				Array.isArray(event.notify) &&
				event.notify.length <= 16 &&
				strings(event.notify),
		) &&
		(value.nextBefore === null || number(value.nextBefore)) &&
		number(value.pending) &&
		typeof value.coverage.complete === "boolean" &&
		number(value.coverage.bytes)
	);
}

/** The sequence a post receipt names for this thread; any other receipt is uncertain. */
export function receiptSequence(value: unknown, threadId: string): number {
	if (!object(value) || value.threadId !== threadId || !number(value.sequence) || typeof value.deduped !== "boolean")
		throw new Error("The host returned an invalid post receipt. Read the thread before you post again.");
	return value.sequence;
}

/** Thread text is text: terminal sequences go, and controls other than newlines become spaces. */
export function plainThreadText(value: string): string {
	return stripVTControlCharacters(value).replace(/[\p{Cc}\p{Cf}]/gu, (char) => (char === "\n" ? char : " "));
}

/** Member declarations as attributed claims. Membership dates do not date contribution changes. */
export function memberDeclarationLines(thread: CollaborationPage["thread"], nameFor: (id: string) => string): string[] {
	const visible = thread.members.slice(0, 16);
	return [
		"Member declarations, not agreement",
		...visible.map(
			(member) =>
				`${plainThreadText(nameFor(member.identity).slice(0, 512)).replace(/\s+/g, " ")} [${plainThreadText(member.identity)}]: ${plainThreadText(member.contribution).replace(/\s+/g, " ").trim() || "No contribution declared"}`,
		),
		...(thread.members.length > visible.length ? [`${thread.members.length - visible.length} member declarations omitted by display bound. Read the thread with agent_collaborate.`] : []),
		...(visible.length ? [] : ["No member declarations in this read"]),
	];
}
