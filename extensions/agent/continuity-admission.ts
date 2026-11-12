/**
 * Admission facts of outgoing answer-bearing work, written in the requesting conversation's storage.
 *
 * A request is keyed by its target identity and request ID. The key written before dispatch is
 * provisional: the target can still be a handle, and the receipt names the canonical identity. A
 * fact that the retained document refuses is skipped, never an admission failure.
 */
import type { ConversationId, Tx } from "@earendil-works/pi-durable";
import { validateContinuityFact, type ContinuityFact } from "./continuity-facts.ts";
import { ContinuityDoc, recordContinuityFact } from "./continuity-native.ts";
import type { ResultReference } from "./result-schema.ts";

export interface OutgoingRequest {
	readonly sessionId: string;
	readonly requestId: string;
	/** Identity that receives the answer; another identity than the requester counts as routed elsewhere. */
	readonly replyTo: string;
}

function representable(fact: ContinuityFact): boolean {
	try { validateContinuityFact(fact); return true; }
	catch { return false; }
}

/** Write before dispatch. Returns false for a target that is not a canonical identity; its admission still records. */
export async function recordRequested(tx: Tx, conversationId: ConversationId, request: OutgoingRequest): Promise<boolean> {
	const fact: ContinuityFact = { phase: "requested", ...request };
	if (!representable(fact)) return false;
	await recordContinuityFact(tx, conversationId, fact);
	return true;
}

/**
 * Write after the target's receipt. Without a result reference the dispatch has no answer-bearing
 * admission, so only the provisional record closes. A provisional key that differs from the
 * admitted identity closes too, so one request never stays listed under two keys.
 */
export async function recordAdmitted(tx: Tx, conversationId: ConversationId, request: OutgoingRequest, result: ResultReference | undefined): Promise<void> {
	const admitted: ContinuityFact | undefined = result?.requestId === undefined ? undefined
		: { phase: "admitted", sessionId: result.sessionId, requestId: result.requestId, replyTo: request.replyTo, submissionId: result.submissionId };
	if (admitted === undefined || admitted.sessionId !== request.sessionId || admitted.requestId !== request.requestId) await recordRefused(tx, conversationId, request);
	if (admitted !== undefined && representable(admitted)) await recordContinuityFact(tx, conversationId, admitted);
}

/** Write only for a proven refusal before admission; an uncertain failure leaves the request listed as unconfirmed. */
export async function recordRefused(tx: Tx, conversationId: ConversationId, request: OutgoingRequest): Promise<void> {
	const fact: ContinuityFact = { phase: "refused", ...request };
	if (representable(fact)) await recordContinuityFact(tx, conversationId, fact);
}

/** A scheduled input stays listed with its timer until its result is delivered or its timer is cancelled before firing. */
export async function recordScheduled(tx: Tx, conversationId: ConversationId, request: OutgoingRequest, timerId: number): Promise<void> {
	const fact: ContinuityFact = { phase: "requested", ...request, timerId };
	if (representable(fact)) await recordContinuityFact(tx, conversationId, fact);
}

/**
 * Call only when the timer's owner reports a cancellation before firing; a fired timer keeps its
 * request. Timer IDs are local to the target's storage, so `sessionId` is the identity that the
 * cancelling host resolved, in the form its schedule receipt gave. A request listed under another
 * identity stays listed.
 */
export async function recordTimerCancelled(tx: Tx, conversationId: ConversationId, sessionId: string, timerId: number): Promise<void> {
	const state = await tx.doc(ContinuityDoc, conversationId);
	const scheduled = state.events.filter((event) => event.phase === "requested" && event.timerId === timerId && event.sessionId === sessionId);
	for (const { requestId, replyTo } of scheduled) await recordRefused(tx, conversationId, { sessionId, requestId, replyTo });
}
