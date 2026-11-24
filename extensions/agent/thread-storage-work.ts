/**
 * Agent work that a thread storage retains. A thread storage holds threads and runs no agent work, and its host
 * refuses every operation that would admit some. Work that an earlier host admitted (a scheduled input, a queued
 * input, an interrupted run) is withdrawn before the scheduler resumes: every live task is marked for its stop, and
 * every queued input and every scheduled input that has not fired leaves its queue and stays in its conversation's
 * transcript as a quiet entry that says why it started no run. Nothing retained is removed without that entry.
 */
import {
	InboxDoc,
	type ConversationId,
	type Cursor,
	type SubmissionId,
	type TaskId,
	type Tx,
} from "@earendil-works/pi-durable";
import {
	CapturedStopTaskDoc,
	liveTasks,
	markStopped,
	quietInputEntry,
	type StopOptions,
	type StoppedWork,
} from "./conversation-stop.ts";
import type { TimerInput, TimerState } from "./durable-timers.ts";
import { TIMER_TASK_NAME } from "./firing-timer.ts";
import { inputLabel } from "./input-entry.ts";

const CONVERSATION_PAGE = 50;

export interface WithdrawnStorageWork {
	readonly scope: readonly ConversationId[];
	/** Open declared work at the stop, by conversation; the caller closes it as stopped. */
	readonly work: StoppedWork;
	/** Live tasks the caller aborts; each carries its capture mark, so a later start finishes an interrupted stop. */
	readonly tasks: readonly TaskId[];
}

async function conversations(tx: Tx): Promise<ConversationId[]> {
	const ids: ConversationId[] = [];
	let cursor: Cursor | undefined;
	do {
		const page = await tx.scanConversations({}, CONVERSATION_PAGE, cursor);
		for (const record of page.items) ids.push(record.id);
		cursor = page.next;
	} while (cursor);
	return ids;
}

/** A scheduled input whose deadline had not won: its task ends as cancelled, so its message is kept here. */
async function keepScheduledInput(tx: Tx, input: TimerInput, now: number): Promise<void> {
	const label = {
		class: "timer" as const,
		sender: input.requestContext?.requester ?? input.ownerId,
		requestId: input.requestId,
	};
	const due = `Scheduled for ${new Date(input.deadline).toISOString()} with the answer routed to ${input.ownerId}.`;
	await tx.appendEntry(
		input.conversationId as ConversationId,
		quietInputEntry(`${due}\n\n${input.message}`, label, "thread-storage", now),
	);
}

/** The request IDs of the queued inputs, by submission. Queued writes are passive and stay in their queue. */
async function queuedInputs(tx: Tx, scope: readonly ConversationId[]): Promise<Map<SubmissionId, string>> {
	const requests = new Map<SubmissionId, string>();
	for (const id of scope) {
		for (const item of (await tx.doc(InboxDoc, id)).items) {
			if (item.mode !== "write") requests.set(item.id, (await tx.submission(item.id))?.requestId ?? "");
		}
	}
	return requests;
}

/** Every queued input leaves its queue unanswered and stays in the transcript. */
async function keepQueuedInputs(
	tx: Tx,
	scope: readonly ConversationId[],
	requests: ReadonlyMap<SubmissionId, string>,
	now: number,
): Promise<void> {
	for (const id of scope) {
		const inbox = await tx.doc(InboxDoc, id);
		for (let index = 0; index < inbox.items.length; index++) {
			const item = inbox.items[index];
			if (item.mode === "write") continue;
			const requestId = requests.get(item.id) ?? "";
			const label = inputLabel(item.entry ?? { kind: "pi.user" }, requestId) ?? { class: "operator", requestId };
			tx.settleSubmission(item.id, { status: "unanswered", reason: "aborted" });
			await tx.appendEntry(id, quietInputEntry(item.content, label, "thread-storage", now));
			inbox.items.splice(index--, 1);
		}
	}
}

/**
 * Withdraw the agent work of a whole storage in one commit, under a paused scheduler. Undefined, without a write,
 * when the storage retains none. A scheduled input whose deadline had already won keeps its task's own rule: the
 * abort completes that admission, and the storage's model access then ends its run without a request.
 */
export async function withdrawStorageWork(
	tx: Tx,
	options: Pick<StopOptions, "now" | "captureWork">,
): Promise<WithdrawnStorageWork | undefined> {
	// Every table read comes before the first table write of the commit.
	const scope = await conversations(tx);
	const tasks = [];
	for await (const task of liveTasks(tx, {})) {
		// A task that an earlier stop already marked ends through that mark; its input is kept already.
		const mark = await tx.doc(CapturedStopTaskDoc, task.id);
		if (mark.captured) continue;
		tasks.push({ task, mark });
	}
	const queued = await queuedInputs(tx, scope);
	if (tasks.length === 0 && queued.size === 0) return undefined;
	const work = new Map<ConversationId, readonly string[]>();
	for (const id of scope) {
		const requests = await options.captureWork(tx, id, scope);
		if (requests.length > 0) work.set(id, requests);
	}
	await markStopped(tx, scope, options.now);
	for (const { task, mark } of tasks) {
		mark.captured = true;
		if (task.kind === TIMER_TASK_NAME && !(task.state.checkpoint as TimerState | undefined)?.firing)
			await keepScheduledInput(tx, task.input as TimerInput, options.now);
	}
	await keepQueuedInputs(tx, scope, queued, options.now);
	return { scope, work, tasks: tasks.map(({ task }) => task.id) };
}
