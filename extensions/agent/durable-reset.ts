/**
 * agent/durable-reset: reset one conversation's active context with an optional handoff.
 *
 * `Conversation.reset()` is the native operation; it submits a `pi.reset` write
 * and retains no caller submission identity. This module composes the same
 * public write entry through `Conversation.submit()` with a caller request ID,
 * so a repeated reset request is deduplicated and the caller can track its
 * queued-until-placed state. The write places immediately on an idle
 * conversation and at the next boundary while one is busy; it starts no model
 * turn. History, identity, files, and settings are not removed, and a reset
 * never cancels background timers.
 */
import type { Context } from "@earendil-works/chord";
import { ResetEntry, type Conversation, type ConversationId, type EntryId, type SubmissionId, type SubmissionRecord } from "@earendil-works/pi-durable";

export interface ResetRequest {
	/** Operator-authored handoff text; absent starts the new context without a message. */
	readonly handoff?: string;
	/** Stable request ID: a repeated request returns the retained reset. */
	readonly requestId: string;
}

export type ResetStatus = "queued" | "placed" | "unanswered";

export interface ResetResult {
	readonly conversationId: ConversationId;
	readonly requestId: string;
	readonly submissionId: SubmissionId;
	/** `placed` means the write is committed to the transcript. */
	readonly status: ResetStatus;
	/** Committed reset entry when placed. */
	readonly entryId: EntryId | null;
	/** Why an unanswered write could not be placed. */
	readonly reason: string | null;
	/** True when this request ID already had a submission. */
	readonly deduped: boolean;
}

function resetStatus(record: Extract<SubmissionRecord, { readonly type: "write" }>): ResetStatus {
	if (record.status === "done") return "placed";
	if (record.status === "queued") return "queued";
	return "unanswered";
}

function resetResult(conversationId: ConversationId, requestId: string, record: Extract<SubmissionRecord, { readonly type: "write" }>, deduped: boolean): ResetResult {
	const status = resetStatus(record);
	return {
		conversationId,
		requestId,
		submissionId: record.id,
		status,
		entryId: record.status === "done" ? record.entry : null,
		reason: record.status === "unanswered" ? record.reason : null,
		deduped,
	};
}

/**
 * Admit one reset write. An idle conversation places it in the admission
 * commit; a busy conversation queues it until the next boundary. The caller
 * request ID is the deduplication key, so a crash-retried control reports the
 * same submission instead of writing a second reset.
 */
export async function resetConversation(conversation: Conversation, params: ResetRequest, context: Context): Promise<ResetResult> {
	const handoff = params.handoff !== undefined && params.handoff.trim() !== "" ? params.handoff : undefined;
	const existing = await conversation.commit((tx) => tx.submissionByRequest(conversation.id, params.requestId), context);
	if (existing !== undefined) {
		if (existing.type !== "write") throw new Error(`request ${params.requestId} already identifies a non-write submission`);
		return resetResult(conversation.id, params.requestId, existing, true);
	}
	const entry = {
		kind: ResetEntry.kind,
		head: "self" as const,
		...(handoff === undefined ? {} : { model: [{ role: "user" as const, content: handoff, timestamp: Date.now() }] }),
	};
	const admitted = await conversation.submit({ type: "write", entry, requestId: params.requestId }, context);
	const record = await admitted.status(context);
	if (record.type !== "write") throw new Error(`request ${params.requestId} was admitted as a non-write submission`);
	return resetResult(conversation.id, params.requestId, record, false);
}

