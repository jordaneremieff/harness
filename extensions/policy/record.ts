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

/** Public events do not distinguish every preflight refusal. */
export type CallOutcome =
	| "success"
	| "execution-error"
	| "denied"
	| "invalid"
	| "aborted"
	| "unexecuted"
	| "incomplete";

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
	/** Observed final execution outcome, not inferred from the error flag alone. */
	outcome?: CallOutcome;
	/** An abort was requested at observation time; this does not establish the result's cause. */
	abortRequested?: boolean;
	/** False when correlation or an event boundary leaves observations unavailable. */
	observationComplete?: boolean;
	/** Rule identities and metadata only; never new-domain inputs or result bodies. */
	policy?: Record<string, unknown>;
}

/** What a mechanism did to one call. */
export interface CallEffects {
	notified?: boolean;
	annotationBytes?: number;
	blocked?: boolean;
	outcome?: CallOutcome;
	abortRequested?: boolean;
	observationComplete?: boolean;
	policy?: Record<string, unknown>;
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

/** UTF-8 bytes of text fields only; images and other nontext payloads contribute zero. */
export function textContentBytes(content: ContentLike[] | undefined): number {
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
		outputBytes: textContentBytes(facts.content),
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
	if (effects.outcome) record.outcome = effects.outcome;
	if (effects.abortRequested !== undefined) record.abortRequested = effects.abortRequested;
	if (effects.observationComplete !== undefined) record.observationComplete = effects.observationComplete;
	if (effects.policy) record.policy = effects.policy;
	return record;
}

/** Refuse new correlation at capacity; the caller reports incomplete observations. Live calls never expire. */
export function trackPending<T extends PendingCall>(pending: Map<string, T>, call: T): boolean {
	if (pending.has(call.callId) || pending.size >= MAX_PENDING) return false;
	pending.set(call.callId, call);
	return true;
}
