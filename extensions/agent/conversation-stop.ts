/**
 * Stopping conversations and quiet inputs. An abort commits the abort marks of its whole scope at once and waits at
 * most a bound for the scope to settle, so a task that ignores its signal cannot hold the caller. A stopped
 * conversation then stays quiet: until an explicit input that the stop did not end arrives, an input that expects no
 * answer and that arrives without the recipient's request (a result, report, check-in, thread notice or timer) is kept
 * as context and starts no run. A delivery that carries only state notes is kept the same way on any conversation.
 */
import { taskPathCrossesBackground } from "./abort-scope.ts";
import { discardDispatches } from "./delegated-recovery.ts";
import { copyJson } from "@earendil-works/chord/json";
import { setTimeout as delay } from "node:timers/promises";
import { withAbortSignal, type Context } from "@earendil-works/chord/context";
import {
	defineDoc,
	InboxDoc,
	type Cursor,
	type ConversationHandle,
	type ConversationId,
	type Harness,
	type HarnessInspection,
	type JsonObject,
	type SubmissionId,
	type TaskId,
	type TaskQuery,
	type TaskState,
	type Tx,
	type UserInput,
} from "@earendil-works/pi-durable";
import { inputLabel, type InputClass } from "./input-entry.ts";

/** How long an abort request waits for the scope it marked to settle before it answers. */
export const ABORT_ANSWER_MS = 15_000;
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
type StopMark = { stoppedAt: number | null; explicit: number | null };
export const StoppedDoc = defineDoc<StopMark>({
	kind: "agent.conversation-stop",
	version: 1,
	scope: "conversation",
	fork: "initial",
	history: "latest",
	initial: () => ({ stoppedAt: null, explicit: null }),
	checkpointWhen: () => false,
});
export async function markStopped(tx: Tx, conversations: readonly ConversationId[], at: number): Promise<void> {
	for (const id of conversations) {
		const mark = await tx.doc(StoppedDoc, id);
		await discardDispatches(tx, id);
		mark.stoppedAt = at;
		mark.explicit = null;
	}
}
export async function noteExplicitInput(
	tx: Tx,
	conversationId: ConversationId,
	submissionId: SubmissionId,
): Promise<void> {
	const mark = await tx.doc(StoppedDoc, conversationId);
	if (mark.stoppedAt !== null) mark.explicit = submissionId;
}
export async function isStopped(tx: Tx, conversationId: ConversationId): Promise<boolean> {
	const mark = await tx.doc(StoppedDoc, conversationId);
	if (mark.stoppedAt === null) return false;
	if (mark.explicit === null) return true;
	const record = await tx.submission(mark.explicit as SubmissionId);
	if (record?.status === "unanswered" && record.reason === "aborted") return true;
	if (record?.status !== "queued" && record?.status !== "placed") await tx.retireDoc(StoppedDoc, conversationId);
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

/** Why an input was kept in the transcript without a run. */
export type QuietReason = "stopped" | "state-note" | "thread-storage";

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
	"thread-storage": (inputClass) =>
		`This ${inputClass} was admitted into this thread storage by an earlier host. A thread storage holds threads and runs no agent work: the host withdrew it, and it started no run.`,
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
	/** Close settled work in the stop commit. Return requests whose closure still depends on input settlement. */
	readonly captureWork: (
		tx: Tx,
		conversationId: ConversationId,
		scope: readonly ConversationId[],
	) => Promise<readonly string[]>;
	/** Receives a failure of the wait that continues after the answer. */
	readonly report: (error: unknown) => void;
}

/** Open declared work at the stop boundary, by conversation: only these items close as stopped. */
export type StoppedWork = ReadonlyMap<ConversationId, readonly string[]>;

/** Withdraw the captured queue. Preserve selected automatic messages as passive writes in their original positions. */
async function withdrawStoppedInputs(tx: Tx, scope: readonly ConversationId[], now: number): Promise<void> {
	const queues = await Promise.all(scope.map(async (id) => ({ id, inbox: await tx.doc(InboxDoc, id) })));
	for (const { id, inbox } of queues) {
		for (let index = 0; index < inbox.items.length; index++) {
			const item = inbox.items[index];
			if (item.mode === "write" || item.onAbort === "keep") continue;
			const data = item.entry?.data;
			const label =
				item.entry &&
				typeof data === "object" &&
				data !== null &&
				"preserveOnStop" in data &&
				data.preserveOnStop === true
					? inputLabel(item.entry, "")
					: undefined;
			tx.settleSubmission(item.id, { status: "unanswered", reason: "aborted" });
			if (!label) {
				inbox.items.splice(index--, 1);
				continue;
			}
			const copy = await tx.createSubmission({ conversationId: id, type: "write", status: "queued" });
			const entry = quietInputEntry(item.content, label, "stopped", now);
			inbox.items.splice(index, 1, { id: copy.id, mode: "write", entry: copyJson(entry) as JsonObject });
		}
	}
}

/** The stop commit selects this exact task. Its document retires when the task ends. */
export const CapturedStopTaskDoc = defineDoc<{ captured: boolean }>({
	kind: "agent.captured-stop-task",
	version: 1,
	scope: "task",
	initial: () => ({ captured: false }),
	checkpointWhen: () => false,
});

// These reads and observations return no handle that can resume scheduling. Register observers on the real writer.
const SETUP_READS = new Set<PropertyKey>([
	"closed",
	"getTask",
	"inspect",
	"observeCommits",
	"observeConversation",
	"observeDoc",
	"observeTaskGraph",
	"snapshot",
	"snapshotAsOf",
	"subscribeClose",
	"usage",
	"wake",
	"watchDoc",
	"watchTaskGraph",
] satisfies (keyof Harness)[]);

/** A factory may retain its Harness or a method for use after installation. Refuse an early act rather than deadlock it. */
function recoverySetupHarness(harness: Harness, ready: () => boolean): Harness {
	return new Proxy(harness, {
		get(target, key) {
			const value: unknown = Reflect.get(target, key, target);
			if (ready() || SETUP_READS.has(key)) return typeof value === "function" ? value.bind(target) : value;
			if (typeof value !== "function") return undefined;
			return (...args: unknown[]) => {
				if (!ready()) throw new Error(`Harness.${String(key)} is unavailable during stop recovery setup`);
				return Reflect.apply(value, target, args);
			};
		},
	});
}

/** Even an already marked task needs its definition installed before any scheduling call can orphan it. */
export async function recoverStoppedTasks(
	harness: Harness,
	context: Context,
	inspection: HarnessInspection,
	install?: (setup: Harness) => Promise<void>,
): Promise<void> {
	const captured = [];
	for (const { record } of inspection.tasks) {
		if ((await harness.snapshot(CapturedStopTaskDoc, record.id, context))?.captured) captured.push(record);
	}
	if (!captured.length) {
		await install?.(harness);
		return;
	}
	if (inspection.scheduling !== "paused") throw new Error("Stop recovery requires a paused scheduler");
	let ready = false;
	await install?.(recoverySetupHarness(harness, () => ready));
	for (const task of captured) {
		if (!task.abortRequested || task.abortReason !== undefined) await harness.abortTask(task.id, context);
	}
	ready = true;
}

export async function captureStoppedWork(
	tx: Tx,
	scope: readonly ConversationId[],
	background: boolean,
	options: Pick<StopOptions, "now" | "captureWork">,
): Promise<{ work: StoppedWork; tasks: TaskId[] }> {
	const tasks: TaskId[] = [];
	for await (const id of scopedTasks(tx, scope, background, false)) tasks.push(id);
	for (const id of tasks) (await tx.doc(CapturedStopTaskDoc, id)).captured = true;
	const open = new Map<ConversationId, readonly string[]>();
	for (const id of scope) {
		const requests = await options.captureWork(tx, id, scope);
		if (requests.length > 0) open.set(id, requests);
	}
	await markStopped(tx, scope, options.now);
	await withdrawStoppedInputs(tx, scope, options.now);
	return { work: open, tasks };
}

type Store = { commit<T>(change: (tx: Tx) => T | Promise<T>, context: Context): Promise<T> };

/**
 * Mark the scope stopped, withdraw its queued inputs and capture its work in one commit. Native abort marks tasks
 * in the immediately following commit; this waits at most `answerWithinMs` for the scope to settle. A wait
 * past the bound continues in the background, and a task that ends later still settles through its committed mark.
 */
export async function stopScope(
	store: Store,
	conversation: Pick<ConversationHandle, "id" | "abort">,
	selectScope: (tx: Tx) => Promise<readonly ConversationId[]>,
	background: boolean,
	context: Context,
	options: StopOptions,
): Promise<StopOutcome & { readonly work: StoppedWork; readonly scope: readonly ConversationId[] }> {
	// Both calls enqueue on the native session line before this turn yields. No fork or admission can enter between them.
	const veto = new AbortController();
	const write = store.commit(async (tx) => {
		try {
			const scope = await selectScope(tx);
			const { work } = await captureStoppedWork(tx, scope, background, options);
			return { scope, work };
		} catch (error) {
			veto.abort(error);
			throw error;
		}
	}, context);
	const abort = conversation.abort(
		withAbortSignal(context.abortSignal ? AbortSignal.any([context.abortSignal, veto.signal]) : veto.signal, context),
		background ? { background: true } : undefined,
	);
	void abort.catch(() => {});
	const { scope, work } = await write;
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
	if (settled) return { settled: true, work, scope };
	abort.catch(options.report);
	return { settled: false, pendingTasks: await pendingTasks(store, scope, background, context), work, scope };
}

/** Every task that has not ended, by status so that ended tasks never fill a page. */
export async function* liveTasks(tx: Tx, query: TaskQuery) {
	for (const status of LIVE_STATUSES) {
		let cursor: Cursor | undefined;
		do {
			const page = await tx.scanTasks({ ...query, status }, PENDING_TASKS_LIMIT, cursor);
			yield* page.items;
			cursor = page.next;
		} while (cursor);
	}
}

async function foregroundPath(tx: Tx, owner: TaskId | undefined): Promise<boolean> {
	if (owner === undefined) return true;
	const crosses = await taskPathCrossesBackground(tx, owner);
	if (crosses === undefined) throw new Error("A retained task has an incomplete ownership chain");
	return !crosses;
}

async function* scopedTasks(tx: Tx, scope: readonly ConversationId[], background: boolean, markedOnly: boolean) {
	const filter = { ...(markedOnly ? { abortRequested: true } : {}), ...(background ? {} : { background: false }) };
	for (const conversationId of scope) {
		for await (const task of liveTasks(tx, { ...filter, conversationId })) {
			if (background || (await foregroundPath(tx, task.owner))) yield task.id;
		}
	}
}

/** Live abort-marked tasks of the scope, by status so that ended tasks never fill the bound. */
async function pendingTasks(
	store: Store,
	scope: readonly ConversationId[],
	background: boolean,
	context: Context,
): Promise<number[]> {
	return store.commit(async (tx) => {
		const ids: number[] = [];
		for await (const id of scopedTasks(tx, scope, background, true)) {
			ids.push(id);
			if (ids.length === PENDING_TASKS_LIMIT) break;
		}
		return ids;
	}, context);
}
