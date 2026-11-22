/**
 * Stopping conversations and quiet inputs. An abort commits the abort marks of its whole scope at once and waits at
 * most a bound for the scope to settle, so a task that ignores its signal cannot hold the caller. A stopped
 * conversation then stays quiet: until an explicit input that the stop did not end arrives, an input that expects no
 * answer and that arrives without the recipient's request (a result, report, check-in, thread notice or timer) is kept
 * as context and starts no run. A delivery that carries only state notes is kept the same way on any conversation.
 */
import { setTimeout as delay } from "node:timers/promises";
import type { Context } from "@earendil-works/chord/context";
import {
	defineDoc,
	type ConversationHandle,
	type ConversationId,
	type SubmissionId,
	type TaskState,
	type Tx,
	type UserInput,
} from "@earendil-works/pi-durable";
import type { InputClass } from "./input-entry.ts";

/** How long an abort request waits for the scope it marked to settle before it answers. */
export const ABORT_ANSWER_MS = 15_000;
/** Stop marks kept per storage; the oldest leaves first, and its conversation is quiet no longer. */
export const STOPPED_LIMIT = 512;
/** Unended task IDs that one abort answer names. */
export const PENDING_TASKS_LIMIT = 64;
const LIVE_STATUSES: readonly TaskState<unknown, unknown>["status"][] = [
	"pending",
	"running",
	"waiting",
	"sleeping",
	"completing",
];
/** Entry kind of an input kept as context without a run: on a stopped conversation, or a state note. */
export const QUIET_INPUT_ENTRY_KIND = "agent.quiet-input";

/**
 * A stop mark. `explicit` is the latest explicit input admitted after the mark: it ends the stop unless the stop itself
 * ended it, which a native abort does for an input admitted before its marks commit.
 */
type StopMark = { conversationId: number; stoppedAt: number; explicit?: number };
type StoppedState = { conversations: StopMark[] };

/** One session document, so that an admission reads the marks without creating a document per conversation. */
export const StoppedDoc = defineDoc<StoppedState>({
	kind: "agent.stopped",
	version: 1,
	scope: "session",
	initial: () => ({ conversations: [] }),
	checkpointWhen: () => false,
});

export async function markStopped(tx: Tx, conversations: readonly ConversationId[], at: number): Promise<void> {
	if (conversations.length === 0) return;
	const state = await tx.doc(StoppedDoc);
	const marked = new Set<number>(conversations);
	const kept = state.conversations.filter((mark) => !marked.has(mark.conversationId));
	const added = conversations.map((conversationId) => ({ conversationId: conversationId as number, stoppedAt: at }));
	state.conversations = [...kept, ...added].slice(-STOPPED_LIMIT);
}

/** Record an explicit input admitted to a stopped conversation; the next quiet decision reads how it ended. */
export async function noteExplicitInput(
	tx: Tx,
	conversationId: ConversationId,
	submissionId: SubmissionId,
): Promise<void> {
	const state = await tx.doc(StoppedDoc);
	const mark = state.conversations.find((candidate) => candidate.conversationId === conversationId);
	if (mark !== undefined) mark.explicit = submissionId as number;
}

/**
 * True while the conversation stays stopped. An explicit input recorded after the mark ends the stop unless it ended
 * `aborted`, as an input does that the same abort withdrew or whose run it stopped. Keep the mark until the input
 * settles so a quiet decision during the input cannot conceal a later withdrawal.
 */
export async function isStopped(tx: Tx, conversationId: ConversationId): Promise<boolean> {
	const state = await tx.doc(StoppedDoc);
	const index = state.conversations.findIndex((mark) => mark.conversationId === conversationId);
	if (index < 0) return false;
	const explicit = state.conversations[index].explicit;
	if (explicit === undefined) return true;
	const record = await tx.submission(explicit as SubmissionId);
	if (record?.status === "unanswered" && record.reason === "aborted") return true;
	if (record?.status === "queued" || record?.status === "placed") return false;
	state.conversations.splice(index, 1);
	return false;
}

const QUIET_CLASSES: ReadonlySet<InputClass> = new Set(["result", "report", "check-in", "thread-notice", "timer"]);

/**
 * True for an input that a stopped conversation keeps without a run. An input whose sender waits for its answer
 * always runs, so that no request stays open on a quiet conversation; an explicit class (operator input, steer,
 * follow-up) always runs.
 */
export function quietWhileStopped(inputClass: InputClass, expectsAnswer: boolean): boolean {
	return !expectsAnswer && QUIET_CLASSES.has(inputClass);
}

/** Why an input was kept as context without a run. */
export type QuietReason = "stopped" | "state-note";

/**
 * The quiet decision of one new admission, read in its commit so that an abort cannot fall between the decision and
 * the input. The caller records an explicit input with `noteExplicitInput` once it has its submission.
 */
export async function admissionQuietness(
	tx: Tx,
	conversationId: ConversationId,
	input: { readonly inputClass: InputClass; readonly expectsAnswer: boolean; readonly stateNotesOnly: boolean },
): Promise<QuietReason | undefined> {
	if (input.stateNotesOnly && input.inputClass === "result" && !input.expectsAnswer) return "state-note";
	if (!quietWhileStopped(input.inputClass, input.expectsAnswer)) return undefined;
	return (await isStopped(tx, conversationId)) ? "stopped" : undefined;
}

const QUIET_NOTICES: Readonly<Record<QuietReason, (inputClass: InputClass) => string>> = {
	stopped: (inputClass) =>
		`This ${inputClass} arrived while this conversation was stopped. It started no run; read it with the next input.`,
	"state-note": () =>
		"This state note arrived while the producer's declared work continues. It started no run; the final report arrives as a separate report.",
};

/** The passive entry that keeps one quiet input as context for the next run. */
export function quietInputEntry(
	message: UserInput,
	label: { readonly class: InputClass; readonly sender?: string; readonly requestId: string },
	reason: QuietReason,
	timestamp: number,
) {
	const notice = QUIET_NOTICES[reason](label.class);
	const content: UserInput =
		typeof message === "string" ? `${notice}\n\n${message}` : [{ type: "text", text: notice }, ...message];
	return {
		kind: QUIET_INPUT_ENTRY_KIND,
		model: [{ role: "user" as const, content, timestamp }],
		data: {
			reason,
			class: label.class,
			requestId: label.requestId,
			...(label.sender === undefined ? {} : { sender: label.sender }),
		},
	};
}

export type StopOutcome =
	| { readonly settled: true }
	| {
			readonly settled: false;
			/** Live tasks of the scope that had not ended when the request answered; their abort marks stay committed. */
			readonly pendingTasks: number[];
	  };

export interface StopOptions {
	readonly now: number;
	readonly answerWithinMs?: number;
	/** Request IDs of a conversation's open declared work, read in the stop commit. */
	readonly openRequests: (tx: Tx, conversationId: ConversationId) => Promise<readonly string[]>;
	/** Receives a failure of the wait that continues after the answer. */
	readonly report: (error: unknown) => void;
}

/** Open declared work at the stop boundary, by conversation: only these items close as stopped. */
export type StoppedWork = ReadonlyMap<ConversationId, readonly string[]>;

export async function captureStoppedWork(
	tx: Tx,
	scope: readonly ConversationId[],
	options: Pick<StopOptions, "now" | "openRequests">,
): Promise<StoppedWork> {
	const open = new Map<ConversationId, readonly string[]>();
	for (const id of scope) {
		const requests = await options.openRequests(tx, id);
		if (requests.length > 0) open.set(id, requests);
	}
	await markStopped(tx, scope, options.now);
	return open;
}

type Store = { commit<T>(change: (tx: Tx) => T | Promise<T>, context: Context): Promise<T> };

/**
 * Mark the scope stopped and capture its open declared work in one commit, then abort the target. The abort marks and
 * the withdrawal of queued inputs commit at once; this waits at most `answerWithinMs` for the scope to settle. A wait
 * past the bound continues in the background, and a task that ends later still settles through its committed mark.
 */
export async function stopScope(
	store: Store,
	conversation: Pick<ConversationHandle, "id" | "abort">,
	scope: readonly ConversationId[],
	background: boolean,
	context: Context,
	options: StopOptions,
): Promise<StopOutcome & { readonly work: StoppedWork }> {
	const work = await store.commit((tx) => captureStoppedWork(tx, scope, options), context);
	const abort = conversation.abort(context, background ? { background: true } : undefined);
	const bound = new AbortController();
	let settled: boolean;
	try {
		settled = await Promise.race([
			abort.then(() => true),
			delay(options.answerWithinMs ?? ABORT_ANSWER_MS, false, { signal: bound.signal }).catch(() => false),
		]);
	} finally {
		bound.abort();
	}
	if (settled) return { settled: true, work };
	abort.catch(options.report);
	return { settled: false, pendingTasks: await pendingTasks(store, scope, context), work };
}

/** Live abort-marked tasks of the scope, by status so that ended tasks never fill the bound. */
async function pendingTasks(store: Store, scope: readonly ConversationId[], context: Context): Promise<number[]> {
	return store.commit(async (tx) => {
		const ids: number[] = [];
		for (const conversationId of scope)
			for (const status of LIVE_STATUSES) {
				const page = await tx.scanTasks({ conversationId, abortRequested: true, status }, PENDING_TASKS_LIMIT);
				for (const task of page.items) ids.push(task.id as number);
				if (ids.length >= PENDING_TASKS_LIMIT) return ids.slice(0, PENDING_TASKS_LIMIT);
			}
		return ids;
	}, context);
}
