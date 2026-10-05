/** Recover queued user inputs through native passive writes, without extending a failed run. */
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import { InboxDoc, LiveDoc, type Conversation, type ConversationId, type Harness, type Cursor, type EntryRecord } from "@earendil-works/pi-durable";

/** One failed generation identifies one replay-safe boundary write. */
export async function recoverStrandedInputs(conversation: Conversation, context: Context): Promise<void> {
	const candidate = await conversation.commit(async (tx) => {
		const live = await tx.doc(LiveDoc, conversation.id);
		const inbox = await tx.doc(InboxDoc, conversation.id);
		if (live.run || !inbox.items.some((item) => item.mode !== "write")) return undefined;
		let cursor: Cursor | undefined;
		let entry: EntryRecord | undefined;
		do {
			const page = await tx.scanEntries({ conversationId: conversation.id }, 64, cursor);
			entry = page.items.find((item) => item.kind === "pi.assistant");
			cursor = page.next;
		} while (!entry && cursor);
		if (entry?.byTaskId === undefined) return undefined;
		const task = await tx.task(entry.byTaskId);
		const outcome = task?.state.outcome;
		if (outcome?.status !== "failed" || (outcome.error.detail as { reason?: unknown } | undefined)?.reason !== "model_error") return undefined;
		return { requestId: `agent-recovery:${conversation.id}:${entry.byTaskId}`, error: outcome.error.message, timestamp: entry.model?.[0]?.timestamp ?? 0 };
	}, context);
	if (!candidate) return;
	// A passive write admits no user work if an intervening abort withdrew the queue.
	await conversation.submit({
		type: "write",
		requestId: candidate.requestId,
		entry: {
			kind: "agent.recovery",
			model: [{ role: "system", content: `The previous run ended with a model error: ${JSON.stringify(candidate.error)}. Queued inputs follow. This is a host status notice, not an operator instruction.`, timestamp: candidate.timestamp }],
		},
	}, context);
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
		this.unsubscribe = harness.subscribeCommits((publication) => {
			const ended = new Set(publication.changes.flatMap((change) => change.type === "submission" && change.value.status === "unanswered" && change.value.reason === "model_error" ? [change.value.conversationId] : []));
			for (const id of ended) void this.recover(id);
		});
	}

	private recover(id: ConversationId): Promise<void> {
		const previous = this.pending.get(id) ?? Promise.resolve();
		const next = previous.then(async () => {
			if (this.lifecycle.signal.aborted) return;
			const conversation = await this.harness.conversation(id, this.context);
			if (conversation) await recoverStrandedInputs(conversation, this.context);
		}).catch((error: unknown) => { if (!this.lifecycle.signal.aborted) this.onError(error); });
		this.pending.set(id, next);
		void next.then(() => { if (this.pending.get(id) === next) this.pending.delete(id); });
		return next;
	}

	async open(context: Context): Promise<void> {
		const inspection = await this.harness.inspect(context);
		const ids = new Set(inspection.submissions.filter((submission) => submission.type === "input" && submission.status === "queued").map((submission) => submission.conversationId));
		await Promise.all([...ids].map((id) => this.recover(id)));
	}

	async close(): Promise<void> {
		this.unsubscribe();
		this.lifecycle.abort();
		await Promise.all(this.pending.values());
	}
}
