/**
 * Record shape and derivation.
 *
 * The shape is tool-agnostic: every field except `classes` and `captured`
 * describes a call and its outcome, whatever tool ran. Outcome facts are
 * measured or read; `errorKind` is inferred from error text, because no event
 * carries an exit code or a timeout flag.
 */

import { captureFor, redactFor } from "./classify.ts";
import type { PolicyMode } from "./mode.ts";

/** Upper bound on unresolved calls held in memory. */
export const MAX_PENDING = 512;

/** Age after which an unresolved call is dropped. */
export const MAX_PENDING_AGE_MS = 10 * 60 * 1000;

export interface SessionFacts {
	session: string;
	mode: string;
	cwd: string;
	/** Provider and model id active for the call. */
	model: string | null;
	/** Thinking level active for the call. */
	thinkingLevel: string | null;
	/** The effective system prompt carries project context files. */
	projectContext: boolean;
	/** Operator-approved rule state was unreadable, so mechanisms are capped at notice. */
	ruleStoreDegraded: boolean;
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
	/** Mechanism active for this call. */
	policyMode: PolicyMode;
	/** Matched rule ids, empty when the call matched no rule. */
	classes: string[];
	/** Redacted input text, present only when a domain declared a capture. */
	captured?: string;
	/** The operator saw a notice for this call. */
	notified?: true;
	/** Guidance was appended to this call's result. */
	annotated?: true;
	/** Bytes of guidance appended to this call's result. */
	annotationBytes?: number;
	/** The call was blocked at the tool boundary. */
	blocked?: true;
}

/** What a mechanism did to one call. */
export interface CallEffects {
	notified?: boolean;
	annotationBytes?: number;
	blocked?: boolean;
}

export interface PendingCall {
	tool: string;
	callId: string;
	at: string;
	startedAt: number;
	classes: string[];
	/** Raw domain text retained only until the result, so all classifiers see the same capture. */
	sourceText?: string;
	captured?: string;
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

/** Capture the pending half of a record after the rule snapshot has loaded. */
export function startCall(
	tool: string,
	callId: string,
	input: Record<string, unknown>,
	now: Date = new Date(),
	monotonic: number = performance.now(),
	/** null means the caller already captured this input and found no domain text. */
	captured: string | null | undefined = undefined,
): PendingCall {
	// A caller that matches rules first passes the same captured value here, so
	// matching and recorded text cannot disagree on an accessor's later read.
	const text = captured === undefined ? captureFor(tool, input) : captured === null ? undefined : captured;
	const pending: PendingCall = {
		tool,
		callId,
		at: now.toISOString(),
		startedAt: monotonic,
		classes: [],
	};
	if (text !== undefined) {
		pending.sourceText = text;
		pending.captured = redactFor(tool, text);
	}
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
	mode: PolicyMode,
	effects: CallEffects = {},
	monotonic: number = performance.now(),
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
		policyMode: mode,
		classes: pending.classes,
	};
	if (pending.captured !== undefined) record.captured = pending.captured;
	if (effects.notified === true) record.notified = true;
	if (effects.annotationBytes !== undefined && effects.annotationBytes > 0) {
		record.annotated = true;
		record.annotationBytes = effects.annotationBytes;
	}
	if (effects.blocked === true) record.blocked = true;
	return record;
}

/**
 * Insert one pending call, first dropping stale entries and then the oldest
 * entry when the map is still full.
 *
 * Not every call produces a result: another extension can block a call before
 * it runs, and an aborted run ends without one. Insertion order is
 * chronological, so the scan stops at the first entry still inside the age
 * bound. Without both bounds, unresolved calls would hold memory for the life
 * of the session and could evict entries that are still live.
 */
export function trackPending<T extends PendingCall>(
	pending: Map<string, T>,
	call: T,
	monotonic: number = performance.now(),
): void {
	for (const [id, entry] of pending) {
		if (monotonic - entry.startedAt < MAX_PENDING_AGE_MS) break;
		pending.delete(id);
	}
	if (pending.size >= MAX_PENDING) {
		const oldest = pending.keys().next();
		if (!oldest.done) pending.delete(oldest.value);
	}
	pending.set(call.callId, call);
}
