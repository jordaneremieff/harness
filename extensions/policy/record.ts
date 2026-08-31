/**
 * Record shape and derivation.
 *
 * The shape is tool-agnostic: every field except `classes` and `command`
 * describes a call and its outcome, whatever tool ran. Outcome facts are
 * measured or read; `errorKind` is inferred from error text, because no event
 * carries an exit code or a timeout flag.
 */

import { classify, INPUT_CAPTURE } from "./rules.ts";
import { redactCommand } from "./redact.ts";

/** Upper bound on unresolved calls held in memory. */
export const MAX_PENDING = 512;

export interface SessionFacts {
	session: string;
	mode: string;
	cwd: string;
	/** The effective system prompt carries project context files. */
	projectContext: boolean;
}

export interface PolicyRecord extends SessionFacts {
	/** ISO 8601 UTC timestamp of the call. */
	at: string;
	tool: string;
	callId: string;
	/** Milliseconds between the call and its result, measured by this slice. */
	durationMs: number;
	outputBytes: number;
	truncated: boolean;
	error: boolean;
	/** Inferred from error text; null when the call did not fail. */
	errorKind: "timeout" | "aborted" | "other" | null;
	/** Tokens the tool itself reported, when it reported any. */
	tokens: number | null;
	/** Matched rule ids, empty when the call matched no rule. */
	classes: string[];
	/** Redacted input, present only for a tool whose rules declare a capture. */
	command?: string;
}

export interface PendingCall {
	tool: string;
	callId: string;
	at: string;
	startedAt: number;
	classes: string[];
	command?: string;
}

export interface ContentLike {
	type: string;
	text?: string;
}

export interface ResultFacts {
	content?: ContentLike[];
	isError?: boolean;
	truncated?: boolean;
	tokens?: number | null;
}

const TIMEOUT = /\b(timed out|timeout|etimedout)\b/i;
const ABORTED = /\b(abort|aborted|cancell?ed|sigint|sigterm)\b/i;

/** Build the pending half of a record from a tool call. */
export function startCall(
	tool: string,
	callId: string,
	input: Record<string, unknown>,
	now: Date = new Date(),
	monotonic: number = Date.now(),
): PendingCall {
	const pending: PendingCall = {
		tool,
		callId,
		at: now.toISOString(),
		startedAt: monotonic,
		classes: classify(tool, input),
	};
	const captured = INPUT_CAPTURE[tool]?.(input);
	if (captured !== undefined) pending.command = redactCommand(captured);
	return pending;
}

function outputBytes(content: ContentLike[] | undefined): number {
	if (!content) return 0;
	let total = 0;
	for (const part of content) {
		if (typeof part.text === "string") total += Buffer.byteLength(part.text, "utf8");
	}
	return total;
}

function errorKind(content: ContentLike[] | undefined, isError: boolean): PolicyRecord["errorKind"] {
	if (!isError) return null;
	const text = (content ?? []).map((part) => part.text ?? "").join(" ");
	if (TIMEOUT.test(text)) return "timeout";
	if (ABORTED.test(text)) return "aborted";
	return "other";
}

/** Complete a record from its pending half and the call's outcome. */
export function finishCall(
	pending: PendingCall,
	facts: ResultFacts,
	session: SessionFacts,
	monotonic: number = Date.now(),
): PolicyRecord {
	const isError = facts.isError === true;
	const record: PolicyRecord = {
		...session,
		at: pending.at,
		tool: pending.tool,
		callId: pending.callId,
		durationMs: Math.max(0, monotonic - pending.startedAt),
		outputBytes: outputBytes(facts.content),
		truncated: facts.truncated === true,
		error: isError,
		errorKind: errorKind(facts.content, isError),
		tokens: facts.tokens ?? null,
		classes: pending.classes,
	};
	if (pending.command !== undefined) record.command = pending.command;
	return record;
}

/**
 * Insert one pending call, evicting the oldest when the map is full.
 * A call whose result never arrives, because the run was aborted, would
 * otherwise hold memory for the life of the session.
 */
export function trackPending(pending: Map<string, PendingCall>, call: PendingCall): void {
	if (pending.size >= MAX_PENDING) {
		const oldest = pending.keys().next();
		if (!oldest.done) pending.delete(oldest.value);
	}
	pending.set(call.callId, call);
}
