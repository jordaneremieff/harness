/**
 * agent/durable-reset: reset one conversation's active context with an optional handoff.
 *
 * `Conversation.reset()` is the native operation; it submits a `pi.reset` write
 * and retains no caller submission identity. This module composes the same
 * public write entry through `Conversation.submit()` with a caller request ID,
 * so a repeated reset request is deduplicated and the caller can track its
 * queued-until-placed state. An empty idle inbox places it immediately. A busy
 * or stranded user inbox waits for the next independent boundary; it starts no model
 * turn. History, identity, files, and settings are not removed, and a reset
 * never cancels background timers.
 */
import type { Context } from "@earendil-works/chord/context";
import {
	ResetEntry,
	defineDoc,
	InboxDoc,
	type Harness,
	type Conversation,
	type ConversationId,
	type EntryId,
	type Tx,
	type SubmissionId,
	type SubmissionRecord,
} from "@earendil-works/pi-durable";

import { admitPassiveWrite } from "./stranded-inputs.ts";
import { discardDispatches } from "./delegated-recovery.ts";
import { closeOpenWork, OpenWorkDoc } from "./open-work.ts";

const PendingResets = defineDoc<{ ids: number[] }>({
	kind: "agent.pending-reset-closure",
	version: 1,
	scope: "session",
	initial: () => ({ ids: [] }),
	checkpointWhen: () => false,
});

async function workBefore(tx: Tx, conversationId: ConversationId, entry: EntryId): Promise<string[]> {
	const before: string[] = [];
	for (const item of (await tx.doc(OpenWorkDoc, conversationId)).items) {
		if (item.close) continue;
		const input = await tx.submission(item.submissionId as SubmissionId);
		if (input?.entry !== undefined && input.entry < entry) before.push(item.requestId);
	}
	return before;
}

/** A reset closes only requests from before its placed entry. Removing the marker and closing work share a commit. */
export async function reconcileResetClosures(
	harness: Harness,
	storageId: string,
	now: () => number,
	context: Context,
	selected?: readonly number[],
): Promise<void> {
	const pending = (await harness.snapshot(PendingResets, context))?.ids ?? [];
	for (const id of pending) {
		if (selected && !selected.includes(id)) continue;
		await harness.commit(async (tx) => {
			const state = await tx.doc(PendingResets);
			if (!state.ids.includes(id)) return;
			const record = await tx.submission(id as SubmissionId);
			if (record?.type !== "write" || record.status === "queued") return;
			if (record.status === "done" && (await tx.entry(record.entry))?.kind === ResetEntry.kind) {
				await discardDispatches(tx, record.conversationId, { before: record.entry });
				const before = await workBefore(tx, record.conversationId, record.entry);
				if (before.length) await closeOpenWork(tx, storageId, record.conversationId, "reset", now(), before);
			}
			state.ids.splice(state.ids.indexOf(id), 1);
		}, context);
	}
}

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

function resetResult(
	conversationId: ConversationId,
	requestId: string,
	record: Extract<SubmissionRecord, { readonly type: "write" }>,
	deduped: boolean,
): ResetResult {
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
 * Admit one reset write without providing a run boundary to a stranded user inbox. The caller
 * request ID is the deduplication key, so a crash-retried control reports the
 * same submission instead of writing a second reset.
 */
export async function resetConversation(
	conversation: Conversation,
	params: ResetRequest,
	context: Context,
): Promise<ResetResult> {
	const handoff = params.handoff !== undefined && params.handoff.trim() !== "" ? params.handoff : undefined;
	const entry = {
		kind: ResetEntry.kind,
		head: "self" as const,
		...(handoff === undefined ? {} : { model: [{ role: "user" as const, content: handoff, timestamp: Date.now() }] }),
	};
	const { id, deduped } = await conversation.commit(async (tx) => {
		const existing = await tx.submissionByRequest(conversation.id, params.requestId);
		const pending = await tx.doc(PendingResets);
		if (existing) {
			const kind =
				existing.status === "queued"
					? (await tx.doc(InboxDoc, conversation.id)).items.find((item) => item.id === existing.id)?.entry?.kind
					: existing.entry === undefined
						? undefined
						: (await tx.entry(existing.entry))?.kind;
			if (existing.type !== "write" || (kind !== ResetEntry.kind && !pending.ids.includes(existing.id)))
				throw new Error(`request ${params.requestId} does not identify a reset write`);
			return { id: existing.id, deduped: true };
		}
		const id = await admitPassiveWrite(tx, conversation, params.requestId, entry);
		pending.ids.push(id);
		return { id, deduped: false };
	}, context);
	const record = await conversation.commit((tx) => tx.submission(id), context);
	if (record?.type !== "write") throw new Error("Reset write not retained");
	return resetResult(conversation.id, params.requestId, record, deduped);
}
