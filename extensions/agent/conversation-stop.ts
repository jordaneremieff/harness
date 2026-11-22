/**
 * Stopping conversations and quiet inputs. An abort commits the abort marks of its whole scope at once and answers
 * within a bound, so a task that ignores its signal cannot hold the caller. A stopped conversation then stays quiet:
 * until an explicit input arrives, an input that expects no answer and that arrives without the recipient's request
 * (a result, report, check-in, thread notice or timer) is kept as context and starts no run. A delivery that carries
 * only state notes is kept the same way on any conversation.
 */
import { setTimeout as delay } from "node:timers/promises";
import type { Context } from "@earendil-works/chord/context";
import {
	defineDoc,
	type ConversationHandle,
	type ConversationId,
	type Tx,
	type UserInput,
} from "@earendil-works/pi-durable";
import type { InputClass } from "./input-entry.ts";

/** How long an abort request waits for the tasks it marked before it answers. */
export const ABORT_ANSWER_MS = 15_000;
/** Stop marks kept per storage; the oldest leaves first, and its conversation is quiet no longer. */
export const STOPPED_LIMIT = 512;
/** Unended task IDs that one abort answer names. */
const PENDING_TASKS_LIMIT = 64;
/** Entry kind of an input kept as context without a run: on a stopped conversation, or a state note. */
export const QUIET_INPUT_ENTRY_KIND = "agent.quiet-input";

type StoppedState = { conversations: Array<{ conversationId: number; stoppedAt: number }> };

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

export async function isStopped(tx: Tx, conversationId: ConversationId): Promise<boolean> {
	return (await tx.doc(StoppedDoc)).conversations.some((mark) => mark.conversationId === conversationId);
}

/** An explicit input ends the stop of its conversation. The document changes only when a mark exists. */
export async function clearStopped(tx: Tx, conversationId: ConversationId): Promise<void> {
	const state = await tx.doc(StoppedDoc);
	const index = state.conversations.findIndex((mark) => mark.conversationId === conversationId);
	if (index >= 0) state.conversations.splice(index, 1);
}

const QUIET_CLASSES: ReadonlySet<InputClass> = new Set(["result", "report", "check-in", "thread-notice", "timer"]);

/**
 * True for an input that a stopped conversation keeps without a run. An input whose sender waits for its answer
 * always runs, so that no request stays open on a quiet conversation; an explicit class (operator input, steer,
 * follow-up) always runs and ends the stop.
 */
export function quietWhileStopped(inputClass: InputClass, expectsAnswer: boolean): boolean {
	return !expectsAnswer && QUIET_CLASSES.has(inputClass);
}

/** Why an input was kept as context without a run. */
export type QuietReason = "stopped" | "state-note";

/**
 * The quiet decision of one new admission, read in its commit so that an abort cannot fall between the decision and
 * the input. Explicit input ends the stop of its conversation.
 */
export async function admissionQuietness(
	tx: Tx,
	conversationId: ConversationId,
	input: { readonly inputClass: InputClass; readonly expectsAnswer: boolean; readonly stateNotesOnly: boolean },
): Promise<QuietReason | undefined> {
	if (input.stateNotesOnly && input.inputClass === "result" && !input.expectsAnswer) return "state-note";
	if (!quietWhileStopped(input.inputClass, input.expectsAnswer)) {
		await clearStopped(tx, conversationId);
		return undefined;
	}
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
	/** Receives a failure of the wait that continues after the answer. */
	readonly report: (error: unknown) => void;
}

/**
 * Mark the scope stopped, then abort the target. The abort marks and the withdrawal of queued inputs commit at once;
 * this answers when the scope is idle or when the bound passes, whichever comes first. A wait past the bound continues
 * in the background, and a task that ends later still settles through its committed mark.
 */
export async function stopScope(
	store: { commit<T>(change: (tx: Tx) => T | Promise<T>, context: Context): Promise<T> },
	conversation: Pick<ConversationHandle, "id" | "abort">,
	scope: readonly ConversationId[],
	background: boolean,
	context: Context,
	options: StopOptions,
): Promise<StopOutcome> {
	await store.commit((tx) => markStopped(tx, scope, options.now), context);
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
	if (settled) return { settled: true };
	abort.catch(options.report);
	const pendingTasks = await store.commit(async (tx) => {
		const ids: number[] = [];
		for (const conversationId of scope) {
			const page = await tx.scanTasks({ conversationId, abortRequested: true }, PENDING_TASKS_LIMIT);
			for (const task of page.items) if (task.state.status !== "terminal") ids.push(task.id as number);
			if (ids.length >= PENDING_TASKS_LIMIT) break;
		}
		return ids.slice(0, PENDING_TASKS_LIMIT);
	}, context);
	return { settled: false, pendingTasks };
}
