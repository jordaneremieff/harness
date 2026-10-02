/**
 * agent/durable-timers: host-owned one-shot scheduled inputs.
 *
 * A timer is a conversation-owned background task that sleeps on the Harness
 * clock until an absolute deadline, then admits one input with a request ID
 * fixed at schedule time. The task input retains the deadline, target,
 * message, busy mode, admission origin, and request identity, so a crashed or
 * restarted host resumes the same deadline and Durable request deduplication
 * admits the input at most once. The task itself is the durable clock: no OS
 * alarm, launchd, or cron is involved, and a timer fires only while its
 * storage host runs.
 *
 * `AgentTimerDoc` mirrors each timer for listing. The task updates its record
 * in the same commit that settles it, so a fired or cancelled record matches
 * the task outcome. The document keeps every pending record and prunes older
 * settled records.
 *
 * The task value is structural: a registered definition of the same name and
 * version runs it, so the host creates tasks from this module while the agent
 * contribution registers the definition in the registry.
 */
import type { Context } from "@earendil-works/chord";
import { defineDoc, defineTask, type ConversationId, type Harness, type SubmissionRecord, type TaskId, type Tx } from "@earendil-works/pi-durable";
import { linkDeliveryIntent, recordDeliveryIntent, type DeliveryIntentState, type DeliveryOrigin } from "./durable-controls.ts";

/** Registered task kind of one scheduled input. */
export const TIMER_TASK_NAME = "agent.timer";
/** Stored preview length of one scheduled message. The task input keeps the full text. */
export const TIMER_MESSAGE_PREVIEW_LIMIT = 512;
/** Settled records kept for listing after pruning; pending records are always kept. */
export const TIMER_SETTLED_RECORD_LIMIT = 32;

/** Busy mode one scheduled input admits with. Follow-up is the default. */
export type TimerMode = "followUp" | "steer";

/** Durable state of one timer as recorded beside its task. */
export type TimerStatus = "pending" | "fired" | "cancelled";

/** Original task input of one scheduled input. */
export type TimerInput = {
	/** Caller-supplied schedule key; a retried schedule reuses the pending record. */
	readonly scheduleId: string;
	/** Absolute deadline in epoch milliseconds. */
	readonly deadline: number;
	readonly conversationId: number;
	/** External identity of the target conversation, for display. */
	readonly identity: string;
	readonly message: string;
	readonly mode: TimerMode;
	readonly origin: DeliveryOrigin;
	/** Delivery recipient of the fired input's answer. */
	readonly ownerId: string;
	/** Submission request ID used at fire time. */
	readonly requestId: string;
	readonly createdAt: number;
};

/** Checkpoint of the timer task. The deadline lives in the input, never in the checkpoint. */
export type TimerState = {
	readonly phase: "wait";
};

/** Terminal result of a fired timer. */
export type TimerResult = {
	readonly deadline: number;
	readonly firedAt: number;
	/** Milliseconds between the deadline and the actual admission; zero on time. */
	readonly overdueMs: number;
	readonly conversationId: number;
	readonly submissionId: number;
	readonly requestId: string;
	readonly mode: TimerMode;
	readonly origin: DeliveryOrigin;
	/** True when the same request already existed, for example after a crash replay. */
	readonly deduped: boolean;
};

/** One timer record mirrored beside its task. */
export type TimerRecord = {
	readonly timerId: number;
	readonly scheduleId: string;
	readonly conversationId: number;
	readonly identity: string;
	readonly messagePreview: string;
	readonly deadline: number;
	readonly mode: TimerMode;
	readonly origin: DeliveryOrigin;
	readonly ownerId: string;
	readonly requestId: string;
	readonly createdAt: number;
	readonly status: TimerStatus;
	readonly firedAt: number | null;
	readonly overdueMs: number | null;
	readonly submissionId: number | null;
	readonly settledAt: number | null;
};

/** Session-scoped timer mirror used by the list control; the task is authoritative. */
export type AgentTimerState = {
	timers: TimerRecord[];
};

export const AgentTimerDoc = defineDoc<AgentTimerState>({
	kind: "agent.timers",
	version: 1,
	scope: "session",
	initial: () => ({ timers: [] }),
	checkpointWhen: () => true,
});

/** Parse one requested deadline: epoch milliseconds or an ISO 8601 date-time string. */
export function parseDeliverAt(value: unknown): number {
	const parsed =
		typeof value === "number"
			? value
			: typeof value === "string" && value.trim() !== ""
				? Date.parse(value)
				: Number.NaN;
	if (!Number.isFinite(parsed) || !Number.isSafeInteger(parsed) || parsed <= 0) {
		throw new Error("deliverAt must be an epoch-millisecond time or an ISO 8601 date-time string");
	}
	return parsed;
}

/** Message preview retained for listing. */
export function timerPreview(message: string): string {
	return message.length > TIMER_MESSAGE_PREVIEW_LIMIT ? message.slice(0, TIMER_MESSAGE_PREVIEW_LIMIT) : message;
}

/** Keep every pending record and the newest settled records. */
function pruneTimerRecords(state: AgentTimerState): void {
	const pending = state.timers.filter((record) => record.status === "pending");
	const settled = state.timers.filter((record) => record.status !== "pending");
	if (settled.length <= TIMER_SETTLED_RECORD_LIMIT) return;
	const kept = settled.slice(settled.length - TIMER_SETTLED_RECORD_LIMIT);
	state.timers.splice(0, state.timers.length, ...pending, ...kept);
}

interface TimerSettlement {
	readonly status: TimerStatus;
	readonly firedAt: number | null;
	readonly overdueMs: number | null;
	readonly submissionId: number | null;
	readonly settledAt: number;
}

/** Update the mirror in the same commit that settles the task. */
async function markTimerSettled(tx: Tx, timerId: number, settlement: TimerSettlement): Promise<void> {
	const state = await tx.doc(AgentTimerDoc);
	const index = state.timers.findIndex((record) => record.timerId === timerId);
	const current = state.timers[index];
	if (current === undefined) return;
	state.timers[index] = { ...current, ...settlement };
	pruneTimerRecords(state);
}

/**
 * One scheduled input. The phase sleeps on the absolute input deadline, admits
 * the stored message through the delivery ledger, and settles in the commit
 * that records the fired result. A replay reads the same input, so the
 * deadline is never recomputed and the request ID admits at most one input.
 */
export const TimerTask = defineTask<TimerInput, TimerState, TimerResult>({
	name: TIMER_TASK_NAME,
	version: 1,
	initial: () => ({ phase: "wait" }),
	phases: {
		wait: async (task, runtime, context) => {
			await runtime.sleep(task.input.deadline, context);
			const conversationId = task.input.conversationId as ConversationId;
			const conversation = await runtime.conversation(conversationId, context);
			if (conversation === undefined) throw new Error(`scheduled input target ${task.input.identity} is not retained`);
			let retained: SubmissionRecord | undefined;
			await runtime.commit(async (tx) => {
				retained = await tx.submissionByRequest(conversationId, task.input.requestId);
				return undefined;
			}, context);
			let intent: DeliveryIntentState | undefined;
			await runtime.commit(async (tx) => {
				intent = await recordDeliveryIntent(tx, conversationId, {
					requestId: task.input.requestId,
					ownerId: task.input.ownerId,
					message: task.input.message,
					whenBusy: task.input.mode,
					origin: task.input.origin,
				});
				return undefined;
			}, context);
			const submission = await conversation.submit(
				{ type: "input", content: task.input.message, requestId: task.input.requestId, whenBusy: task.input.mode },
				context,
			);
			const firedAt = runtime.now();
			const result: TimerResult = {
				deadline: task.input.deadline,
				firedAt,
				overdueMs: Math.max(0, firedAt - task.input.deadline),
				conversationId: task.input.conversationId,
				submissionId: submission.id,
				requestId: task.input.requestId,
				mode: task.input.mode,
				origin: task.input.origin,
				deduped: retained !== undefined || intent?.kind === "linked",
			};
			await runtime.commit(
				async (tx) => {
					await linkDeliveryIntent(tx, conversationId, task.input.requestId, submission.id);
					await markTimerSettled(tx, Number(task.id), {
						status: "fired",
						firedAt,
						overdueMs: result.overdueMs,
						submissionId: submission.id,
						settledAt: firedAt,
					});
					return { status: "terminal", outcome: { status: "completed", result } };
				},
				context,
			);
		},
	},
	abort: async (task, runtime, context) =>
		runtime.commit(
			async (tx) => {
				const settledAt = runtime.now();
				await markTimerSettled(tx, Number(task.id), { status: "cancelled", firedAt: null, overdueMs: null, submissionId: null, settledAt });
				return { status: "terminal", outcome: { status: "aborted" } };
			},
			context,
		),
});

export interface ScheduleTimerParams {
	/** Caller-supplied schedule key; a retried schedule reuses the pending record. */
	readonly scheduleId: string;
	readonly deadline: number;
	readonly conversationId: ConversationId;
	readonly identity: string;
	readonly message: string;
	readonly mode: TimerMode;
	readonly origin: DeliveryOrigin;
	readonly ownerId: string;
	/** Submission request ID used at fire time. */
	readonly requestId: string;
	readonly createdAt: number;
}

export interface ScheduleTimerResult {
	readonly timerId: number;
	readonly conversationId: number;
	readonly identity: string;
	readonly deadline: number;
	readonly mode: TimerMode;
	readonly origin: DeliveryOrigin;
	readonly scheduleId: string;
	readonly deduped: boolean;
}

/**
 * Create one timer task and its mirror record in a single commit. A pending
 * record with the same schedule key returns the retained timer, so a retried
 * schedule call does not create a second timer.
 */
export async function scheduleTimer(harness: Harness, params: ScheduleTimerParams, context: Context): Promise<ScheduleTimerResult> {
	parseDeliverAt(params.deadline);
	return harness.commit(async (tx) => {
		const state = await tx.doc(AgentTimerDoc);
		const existing = state.timers.find((record) => record.scheduleId === params.scheduleId && record.status === "pending");
		if (existing !== undefined) {
			return {
				timerId: existing.timerId,
				conversationId: existing.conversationId,
				identity: existing.identity,
				deadline: existing.deadline,
				mode: existing.mode,
				origin: existing.origin,
				scheduleId: existing.scheduleId,
				deduped: true,
			};
		}
		const input: TimerInput = {
			scheduleId: params.scheduleId,
			deadline: params.deadline,
			conversationId: params.conversationId,
			identity: params.identity,
			message: params.message,
			mode: params.mode,
			origin: params.origin,
			ownerId: params.ownerId,
			requestId: params.requestId,
			createdAt: params.createdAt,
		};
		const timerId = await tx.createTask(TimerTask, input, {
			ownership: { kind: "conversation" },
			conversationId: params.conversationId,
			background: true,
		});
		const record: TimerRecord = {
			timerId: Number(timerId),
			scheduleId: params.scheduleId,
			conversationId: params.conversationId,
			identity: params.identity,
			messagePreview: timerPreview(params.message),
			deadline: params.deadline,
			mode: params.mode,
			origin: params.origin,
			ownerId: params.ownerId,
			requestId: params.requestId,
			createdAt: params.createdAt,
			status: "pending",
			firedAt: null,
			overdueMs: null,
			submissionId: null,
			settledAt: null,
		};
		state.timers.push(record);
		pruneTimerRecords(state);
		return {
			timerId: record.timerId,
			conversationId: record.conversationId,
			identity: record.identity,
			deadline: record.deadline,
			mode: record.mode,
			origin: record.origin,
			scheduleId: record.scheduleId,
			deduped: false,
		};
	}, context);
}

/** One listed timer: its stored record plus whether a live task still owns it. */
export type TimerListRow = Omit<TimerRecord, "status"> & {
	readonly status: TimerStatus | "unsettled";
	readonly live: boolean;
};

/** Largest number of pending timers one status reading reports. */
export const TIMER_STATUS_LIMIT = 20;

/** One pending scheduled input in a status reading, ordered by deadline. */
export type TimerStatusRow = {
	/** Native task ID; `agent_abort` accepts it to cancel only this input. */
	readonly id: number;
	/** External identity of the target conversation. */
	readonly target: string;
	readonly deadline: number;
	readonly mode: TimerMode;
	/** `unsettled` means no live task owns the record, so it may not fire. */
	readonly status: "pending" | "unsettled";
	/** True when the deadline already passed. */
	readonly overdue: boolean;
};

/**
 * Bounded pending-timer projection for one conversation, nearest deadline
 * first. `liveTaskIds` lets a caller that already read `harness.inspect()`
 * skip a second inspection; absent, this function reads it.
 */
export async function timerStatusRows(harness: Harness, conversationId: ConversationId, context: Context, liveTaskIds?: ReadonlySet<number>): Promise<TimerStatusRow[]> {
	const state = await harness.snapshot(AgentTimerDoc, context);
	if (state === undefined) return [];
	let live = liveTaskIds;
	if (live === undefined) {
		const inspection = await harness.inspect(context);
		live = new Set(inspection.tasks.map((task) => Number(task.record.id)));
	}
	const now = Date.now();
	return state.timers
		.filter((record) => record.conversationId === conversationId && record.status === "pending")
		.sort((left, right) => left.deadline - right.deadline)
		.slice(0, TIMER_STATUS_LIMIT)
		.map((record) => ({
			id: record.timerId,
			target: record.identity,
			deadline: record.deadline,
			mode: record.mode,
			status: live.has(record.timerId) ? "pending" : "unsettled",
			overdue: record.deadline < now,
		}));
}

export interface TimerListResult {
	readonly timers: TimerListRow[];
}

/**
 * List the storage's timers. A record that says pending with no live task is
 * reported as `unsettled`: its task settled without a record update, which the
 * task code does only for an unregistered definition or an unexpected fault.
 */
export async function listTimers(harness: Harness, context: Context): Promise<TimerListResult> {
	const state = await harness.snapshot(AgentTimerDoc, context);
	const inspection = await harness.inspect(context);
	const live = new Set<number>();
	for (const task of inspection.tasks) {
		if (task.record.kind === TIMER_TASK_NAME) live.add(Number(task.record.id));
	}
	const timers: TimerListRow[] = (state?.timers ?? []).map((record) => {
		const alive = live.has(record.timerId);
		return {
			...record,
			live: alive,
			status: record.status === "pending" && !alive ? "unsettled" : record.status,
		};
	});
	return { timers };
}

export type CancelTimerStatus = TimerStatus | "faulted" | "orphaned";

export interface CancelTimerResult {
	readonly timerId: number;
	/** `marked` when this call committed the abort, `terminal` when the task had already settled. */
	readonly outcome: "marked" | "terminal";
	readonly status: CancelTimerStatus;
}

/**
 * Cancel one pending timer and wait for its task to settle. A task that fires
 * before the abort mark wins the race; the returned status then reports
 * `fired` instead of claiming a cancellation.
 */
export async function cancelTimer(harness: Harness, timerId: number, context: Context): Promise<CancelTimerResult> {
	const record = (await harness.snapshot(AgentTimerDoc, context))?.timers.find((row) => row.timerId === timerId);
	if (record === undefined) throw new Error(`timer ${timerId} is not retained in this storage`);
	const id = timerId as TaskId<never>;
	const outcome = await harness.abortTask(id, context);
	const settled = await harness.waitForTask(id, context);
	const state = settled.state.outcome.status;
	return { timerId, outcome, status: state === "completed" ? "fired" : state === "aborted" ? "cancelled" : state === "failed" || state === "faulted" ? "faulted" : "orphaned" };
}
