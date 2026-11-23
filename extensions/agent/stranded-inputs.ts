/** Recover queued user inputs through native passive writes, without extending a failed run. */
import { copyJson } from "@earendil-works/chord/json";
import type { Context } from "@earendil-works/chord/context";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import {
	InboxDoc,
	LiveDoc,
	type Conversation,
	type ConversationId,
	type Harness,
	type EntryDraft,
	type Tx,
	type SubmissionId,
	type JsonObject,
} from "@earendil-works/pi-durable";
import { isStopped } from "./conversation-stop.ts";
import { onStoredCommit } from "./commit-observation.ts";

/** Retain passive context without providing the boundary that would place a stranded user input. */
export async function admitPassiveWrite(
	tx: Tx,
	conversation: Conversation,
	requestId: string,
	entry: EntryDraft,
): Promise<SubmissionId> {
	const existing = await tx.submissionByRequest(conversation.id, requestId);
	if (existing) return existing.id;
	const inbox = await tx.doc(InboxDoc, conversation.id);
	if (!(await tx.doc(LiveDoc, conversation.id)).run && inbox.items.some((item) => item.mode !== "write")) {
		const retained = await tx.createSubmission({
			type: "write",
			status: "queued",
			requestId,
			conversationId: conversation.id,
		});
		inbox.items.push({ id: retained.id, mode: "write", entry: copyJson(entry) as JsonObject });
		return retained.id;
	}
	return conversation.submit(tx, { type: "write", requestId, entry });
}

/** One failed generation identifies one replay-safe boundary write. */
export async function recoverStrandedInputs(conversation: Conversation, context: Context): Promise<void> {
	await conversation.commit(async (tx) => {
		const live = await tx.doc(LiveDoc, conversation.id);
		const inbox = await tx.doc(InboxDoc, conversation.id);
		if (live.run || !inbox.items.some((item) => item.mode !== "write")) return undefined;
		const failure = live.runFailure;
		if (failure?.reason !== "model_error" || (await isStopped(tx, conversation.id))) return undefined;
		await conversation.submit(tx, {
			type: "write",
			requestId: `agent-recovery:${conversation.id}:${failure.taskId}`,
			entry: {
				kind: "agent.recovery",
				model: [
					{
						role: "system",
						content: `The previous run ended with a model error: ${JSON.stringify(failure.detail ?? "model error")}. Queued inputs follow. This is a host status notice, not an operator instruction.`,
						timestamp: Date.now(),
					},
				],
			},
		});
	}, context);
}

/** Place a write-only inbox at an idle boundary without starting a run. */
export async function placeLeftoverWrites(conversation: Conversation, context: Context): Promise<number> {
	const boundary = await conversation.commit(async (tx) => {
		const live = await tx.doc(LiveDoc, conversation.id);
		const inbox = await tx.doc(InboxDoc, conversation.id);
		if (live.run || inbox.items.length === 0 || inbox.items.some((item) => item.mode !== "write")) return undefined;
		const newest = { id: inbox.items[inbox.items.length - 1].id, count: inbox.items.length };
		const submitted = await conversation.submit(tx, {
			type: "write",
			requestId: `agent-inbox-boundary:${conversation.id}:${newest.id}`,
			entry: { kind: "agent.inbox-boundary", edits: [] },
		});
		return { submitted, count: newest.count };
	}, context);
	if (!boundary) return 0;
	return conversation.commit(
		async (tx) => ((await tx.submission(boundary.submitted))?.status === "done" ? boundary.count : 0),
		context,
	);
}

/** Commit-driven recovery; opening checks existing queued inputs once. */
export class StrandedInputRecovery {
	private readonly pending = new Map<ConversationId, Promise<void>>();
	private readonly lifecycle = new AbortController();
	private readonly unsubscribe: () => void;
	private readonly context: Context;

	private readonly harness: Harness;
	private readonly onError: (error: unknown) => void;

	constructor(harness: Harness, onError: (error: unknown) => void) {
		this.harness = harness;
		this.onError = onError;
		this.context = withAbortSignal(this.lifecycle.signal, BACKGROUND_CONTEXT);
		this.unsubscribe = onStoredCommit(harness, (publication) => {
			const ended = new Set(
				publication.changes.flatMap((change) =>
					change.type === "submission" && change.value.status === "unanswered" ? [change.value.conversationId] : [],
				),
			);
			for (const id of ended) void this.recover(id);
		});
	}

	private recover(id: ConversationId): Promise<void> {
		const previous = this.pending.get(id) ?? Promise.resolve();
		const next = previous
			.then(async () => {
				if (this.lifecycle.signal.aborted) return;
				const conversation = await this.harness.conversation(id, this.context);
				if (conversation) {
					await recoverStrandedInputs(conversation, this.context);
					await placeLeftoverWrites(conversation, this.context);
				}
			})
			.catch((error: unknown) => {
				if (!this.lifecycle.signal.aborted) this.onError(error);
			});
		this.pending.set(id, next);
		void next.then(() => {
			if (this.pending.get(id) === next) this.pending.delete(id);
		});
		return next;
	}

	async open(context: Context): Promise<void> {
		const inspection = await this.harness.inspect(context);
		const ids = new Set(
			inspection.submissions
				.filter((submission) => submission.status === "queued")
				.map((submission) => submission.conversationId),
		);
		await Promise.all([...ids].map((id) => this.recover(id)));
	}

	async close(): Promise<void> {
		this.unsubscribe();
		this.lifecycle.abort();
		await Promise.all(this.pending.values());
	}
}
