/** Durable owner check-ins for unanswered tool admissions. */
import type { Context } from "@earendil-works/chord/context";
import { admissionSource } from "./firing-timer.ts";
import { checkInMinutes } from "./check-in-options.ts";
import { inputEntry, sentInputClass } from "./input-entry.ts";
import {
	defineDocFamily,
	defineSignal,
	defineTask,
	LiveDoc,
	UsageDoc,
	type ConversationId,
	type Tx,
	type TaskId,
	type TaskRuntime,
	type UsageState,
	type ToolSlot,
	type LiveState,
	type EntryId,
	type EntryRecord,
	type NextTaskState,
} from "@earendil-works/pi-durable";
import { obj } from "@earendil-works/pi-schema";
import { placementMode, type DeliveryOrigin, type DeliveryMessage, type DeliveryReport } from "./durable-controls.ts";
import { currentCheckInReport, retainedReport, storeDeliveryRow } from "./delivery-store.ts";
import { producerRetryFact, retryFactLines } from "./await-facts.ts";
import { resolveSessionConversationId } from "./durable-observation.ts";
import { openWorkCheckInLines, requestHasOpenWork } from "./open-work.ts";
import { recoveryAwaitsReceipt } from "./delegated-recovery.ts";
import { CapturedStopTaskDoc } from "./conversation-stop.ts";

export type CheckInInput = {
	conversationId: number;
	requestId: string;
	ownerId: string;
	requester?: string;
	senderIdentity: string;
	message: DeliveryMessage;
	whenBusy: "steer" | "followUp" | "reject";
	origin: DeliveryOrigin;
	admittedAt: number;
	intervalMs: number;
	/** The first interval a re-armed watch waits for; a new watch starts at the first. */
	next?: number;
};
type CheckInState = { phase: "watch"; next: number };
type DeadlineInput = Omit<CheckInInput, "next"> & { next: number };

/**
 * A watch that stopped because its one outstanding notice parked: the owner could not take it. The paused input
 * re-arms one deadline when that owner accepts the notice while the watched request is still open.
 */
type PausedWatch = { readonly input: DeadlineInput; readonly pausedAt: number };
/**
 * The pause state of one watched request, while its watch lives. `watcher` names the check-in task that a re-arm
 * created; any other check-in task of the request is superseded and creates no deadline. A watch that no re-arm
 * replaced has none.
 */
type PauseState = { watch: PausedWatch | null; watcher: number | null };
export const CheckInPauseDoc = defineDocFamily<PauseState, null>({
	kind: "agent.check-in-pause",
	version: 1,
	scope: "session",
	family: true,
	initial: () => ({ watch: null, watcher: null }),
	checkpointWhen: () => true,
});
export function checkInPauseKey(owner: string, conversationId: number, requestId: string): string {
	return JSON.stringify([owner, conversationId, requestId]);
}

/**
 * The delivery watcher parked a check-in notice; the key is the notice's source ID. The deadline task that wrote the
 * notice sleeps on it, so the watch pauses when the notice parks rather than at its next interval.
 */
export const CheckInParkedSignal = defineSignal({ name: "agent.check-in-parked", version: 1, schema: obj({}) });
export const CHECK_IN_DEADLINE_TASK = "agent.check-in-deadline";

function parked(report: DeliveryReport | undefined): boolean {
	return report !== undefined && !report.acknowledged && report.delivery?.state === "parked";
}

/** True while the watched input runs, or its declared or recovered work stays open. */
async function watchedOpen(tx: Tx, conversationId: number, requestId: string): Promise<boolean> {
	const id = conversationId as ConversationId;
	const retained = await tx.submissionByRequest(id, requestId);
	if (retained?.status !== "done" && retained?.status !== "unanswered") return true;
	return (await requestHasOpenWork(tx, id, requestId)) || (await recoveryAwaitsReceipt(tx, retained));
}

/** The pause state of a watch that this check-in task still owns, or undefined when a re-arm superseded it. */
async function ownPause(tx: Tx, input: CheckInInput, task: TaskId): Promise<PauseState | undefined> {
	const doc = await tx.doc(
		CheckInPauseDoc,
		checkInPauseKey(input.ownerId, input.conversationId, input.requestId),
		null,
	);
	return doc.watcher === null || doc.watcher === task ? doc : undefined;
}
/**
 * A closed request keeps no pause state: call in the commit that established that it is closed. Retirement reads no
 * table and creates no document.
 */
export async function clearCheckInPause(
	tx: Tx,
	owner: string,
	checkIn: { conversationId: number; requestId: string },
): Promise<void> {
	await tx.retireDoc(CheckInPauseDoc, checkInPauseKey(owner, checkIn.conversationId, checkIn.requestId));
}

/**
 * The owner accepted a check-in notice. Read in the acknowledging commit before any table write; the returned step,
 * run in the same commit, re-arms a paused watch of a request that is still open at the next future interval of the
 * existing admission and records the new check-in task as the only watcher, so a paused watch that a restart resumes
 * later creates no second deadline. A closed request keeps no pause state. The watch finds the admitted input by its
 * request ID, so nothing is submitted again, and no missed interval produces a notice.
 */
export async function pausedCheckInResume(
	tx: Tx,
	owner: string,
	checkIn: { conversationId: number; requestId: string },
	now: number,
): Promise<(() => Promise<void>) | undefined> {
	const admitted = await tx.submissionByRequest(checkIn.conversationId as ConversationId, checkIn.requestId);
	if (admitted === undefined) return undefined;
	if (!(await watchedOpen(tx, checkIn.conversationId, checkIn.requestId))) {
		await clearCheckInPause(tx, owner, checkIn);
		return undefined;
	}
	const doc = await tx.doc(CheckInPauseDoc, checkInPauseKey(owner, checkIn.conversationId, checkIn.requestId), null);
	const watch = doc.watch;
	if (watch === null) return undefined;
	doc.watch = null;
	const { input } = watch;
	const next = Math.max(input.next, Math.floor((now - input.admittedAt) / input.intervalMs) + 1);
	return async () => {
		doc.watcher = await tx.createTask(
			CheckInTask,
			{ ...input, next },
			{
				ownership: { kind: "conversation" },
				conversationId: checkIn.conversationId as ConversationId,
				background: true,
			},
		);
	};
}

/** Acknowledgement of one check-in notice and its re-arm, in one commit. */
export async function resumePausedCheckIn(
	tx: Tx,
	owner: string,
	checkIn: { conversationId: number; requestId: string },
	now: number,
): Promise<void> {
	await (await pausedCheckInResume(tx, owner, checkIn, now))?.();
}

function textOf(model: unknown): string {
	if (!Array.isArray(model)) return "";
	return model
		.flatMap((message) =>
			typeof message.content === "string"
				? [message.content]
				: Array.isArray(message.content)
					? message.content.flatMap((part: { type?: string; text?: string }) =>
							part.type === "text" && typeof part.text === "string" ? [part.text] : [],
						)
					: [],
		)
		.join("\n");
}
function bounded(text: string, limit: number): string {
	const marker = "… [truncated]";
	return text.length > limit ? `${text.slice(0, limit - marker.length)}${marker}` : text;
}

function retainedCost(usage: UsageState): number | null {
	const costs = [...Object.values(usage.models), ...Object.values(usage.tools)].map((bucket) => bucket.cost?.total);
	return costs.every((value) => typeof value === "number" && Number.isFinite(value))
		? costs.reduce((sum, value) => sum + (value ?? 0), 0)
		: null;
}

function assistantCalls(model: NonNullable<EntryRecord["model"]>): { id: string; timestamp: number }[] {
	return model.flatMap((message) =>
		message.role === "assistant" && Array.isArray(message.content)
			? message.content.flatMap((part) =>
					part.type === "toolCall" ? [{ id: part.id, timestamp: message.timestamp }] : [],
				)
			: [],
	);
}

async function recentActivity(
	tx: Tx,
	conversationId: ConversationId,
	minEntryId: EntryId | undefined,
): Promise<{ calls: number; latest: string; issuedAt: Map<string, number>; truncated: boolean }> {
	const issuedAt = new Map<string, number>();
	// Queued inputs have no transcript boundary and no task activity yet.
	if (minEntryId === undefined) return { calls: 0, latest: "", issuedAt, truncated: false };
	const page = await tx.scanEntries({ conversationId, minEntryId }, 64);
	let calls = 0;
	let latest = "";
	for (const entry of page.items) {
		if (entry.kind !== "pi.assistant" || !Array.isArray(entry.model)) continue;
		if (latest === "") latest = textOf(entry.model);
		for (const call of assistantCalls(entry.model)) {
			calls += 1;
			if (!issuedAt.has(call.id)) issuedAt.set(call.id, call.timestamp);
		}
	}
	return { calls, latest, issuedAt, truncated: page.next !== undefined };
}

function runningToolLines(tool: ToolSlot, issuedAt: number | undefined, now: number): string[] {
	const age =
		issuedAt === undefined
			? "call age unknown"
			: `call issued ${Math.max(0, Math.round((now - issuedAt) / 1000))}s ago`;
	const lines = [`Current tool: ${bounded(tool.name, 80)}; ${age} (not exact runtime).`];
	if (tool.output) lines.push(`Last tool lines:\n${bounded(tool.output.split("\n").slice(-3).join("\n"), 800)}`);
	return lines;
}

function runningTools(live: LiveState): ToolSlot[] {
	return [...(live.tools ?? []), ...(live.nestedTools ?? [])].filter((tool) => tool.status === "running").slice(0, 4);
}

/** One bounded native snapshot; cost is retained conversation spend, not an estimate of an in-flight request. */
async function digest(
	tx: Tx,
	input: CheckInInput,
	inputEntry: EntryId | undefined,
	now: number,
	maxAttempts: number,
): Promise<{ cost: number | null; digest: string }> {
	const id = input.conversationId as ConversationId;
	const live = await tx.doc(LiveDoc, id);
	const usage = await tx.doc(UsageDoc, id);
	const watched = await tx.submissionByRequest(id, input.requestId);
	const recent = await recentActivity(tx, id, inputEntry);
	// Native input placement follows the prior tool round and clears its live tools.
	const running = inputEntry === undefined ? [] : runningTools(live);
	const generation = inputEntry === undefined ? undefined : live.generation;
	const retry =
		watched === undefined
			? undefined
			: await producerRetryFact(
					tx,
					id,
					[{ sessionId: input.senderIdentity, submissionId: watched.id, requestId: input.requestId }],
					maxAttempts,
				);
	const lines = [
		...(retry === undefined ? [] : retryFactLines(retry)),
		recent.truncated
			? `Tool calls: at least ${recent.calls} (bounded retained entries for watched task).`
			: `Tool calls: ${recent.calls} (watched task).`,
	];
	lines.unshift(...(await openWorkCheckInLines(tx, input.senderIdentity.split(":")[0], id, input.requestId)));
	for (const tool of running) lines.push(...runningToolLines(tool, recent.issuedAt.get(tool.callId), now));
	if (running.length === 0)
		lines.push(generation ? "Current step: model request." : "Current step: queued or between steps.");
	const latest = textOf(generation?.message === undefined ? [] : [generation.message]) || recent.latest;
	lines.push(`Latest reply excerpt (not a result): ${latest === "" ? "No reply text yet." : bounded(latest, 600)}`);
	return { cost: retainedCost(usage), digest: bounded(lines.join("\n"), 2400) };
}

const COMPLETED = { status: "terminal", outcome: { status: "completed", result: null } } as const;

/** Write the notice of interval `k`; it replaces the owner's earlier unaccepted notice of the same watch. */
async function writeNotice(
	tx: Tx,
	input: DeadlineInput,
	previous: DeliveryReport | undefined,
	k: number,
	now: number,
	maxAttempts: number,
): Promise<string> {
	const id = input.conversationId as ConversationId;
	const sourceId = `check-in:${id}:${input.requestId}:${k}`;
	if (await retainedReport(tx, input.ownerId, sourceId)) return sourceId;
	if (previous && !previous.acknowledged) await storeDeliveryRow(tx, "report", { ...previous, acknowledged: true });
	const retained = await tx.submissionByRequest(id, input.requestId);
	const snapshot = await digest(tx, input, retained?.entry, now, maxAttempts);
	await storeDeliveryRow(
		tx,
		"report",
		{
			sourceId,
			requestId: sourceId,
			ownerId: input.ownerId,
			senderIdentity: input.senderIdentity,
			message: snapshot.digest,
			replyTo: null,
			acknowledged: false,
			createdAt: now,
			checkIn: {
				origin: input.origin,
				elapsedMs: Math.max(0, now - input.admittedAt),
				cost: snapshot.cost,
				conversationId: input.conversationId,
				requestId: input.requestId,
			},
		},
		true,
	);
	return sourceId;
}

/**
 * One wake of a deadline task. A settled request ends the watch. One notice stays outstanding for an owner that cannot
 * take it: when that notice parked, the watch pauses instead of adding more. Before its deadline the task sleeps again,
 * also on the park signal of its outstanding notice unless that signal already woke it (`waitOn`).
 */
async function deadlineStep(
	tx: Tx,
	input: DeadlineInput,
	checkpoint: CheckInState,
	now: number,
	maxAttempts: number,
	waitOn: string | undefined,
): Promise<NextTaskState<CheckInState, null>> {
	if (!(await watchedOpen(tx, input.conversationId, input.requestId))) {
		await clearCheckInPause(tx, input.ownerId, input);
		return COMPLETED;
	}
	const previous = await currentCheckInReport(tx, input.ownerId, input.conversationId, input.requestId);
	if (parked(previous)) {
		(await tx.doc(CheckInPauseDoc, checkInPauseKey(input.ownerId, input.conversationId, input.requestId), null)).watch =
			{
				input: { ...input, next: checkpoint.next },
				pausedAt: now,
			};
		return COMPLETED;
	}
	const deadline = input.admittedAt + checkpoint.next * input.intervalMs;
	if (deadline > now) {
		const waits = previous !== undefined && !previous.acknowledged && previous.sourceId === waitOn;
		return {
			status: "sleeping",
			until: deadline,
			checkpoint,
			...(waits ? { signals: [CheckInParkedSignal.key(previous.sourceId)] } : {}),
		};
	}
	// Collapse overdue boundaries into one current notice, then return to the admission's fixed cadence.
	const k = Math.max(checkpoint.next, Math.floor((now - input.admittedAt) / input.intervalMs));
	const sourceId = await writeNotice(tx, input, previous, k, now, maxAttempts);
	return {
		status: "sleeping",
		until: input.admittedAt + (k + 1) * input.intervalMs,
		checkpoint: { phase: "watch", next: k + 1 },
		signals: [CheckInParkedSignal.key(sourceId)],
	};
}

export const CheckInDeadlineTask = defineTask<DeadlineInput, CheckInState, null>({
	name: CHECK_IN_DEADLINE_TASK,
	version: 1,
	initial: (input) => ({ phase: "watch", next: input.next }),
	phases: {
		watch: async (task, runtime, context) => {
			const input = task.input;
			const now = runtime.now();
			const maxAttempts = runtime.settings.retry.enabled ? runtime.settings.retry.maxRetries + 1 : 1;
			let outstanding: string | undefined;
			await runtime.commit(async (tx) => {
				outstanding = (await currentCheckInReport(tx, input.ownerId, input.conversationId, input.requestId))?.sourceId;
				return undefined;
			}, context);
			const waitOn =
				outstanding !== undefined && (await runtime.readSignal(CheckInParkedSignal, outstanding, context)) === undefined
					? outstanding
					: undefined;
			await runtime.commit((tx) => deadlineStep(tx, input, task.state.checkpoint, now, maxAttempts, waitOn), context);
		},
	},
	abort: (_task, runtime, context) =>
		runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
});

/**
 * Admit the watched input by its request ID; for a re-armed watch, or after a restart, that ID finds the input
 * already admitted and submits nothing.
 */
async function submitWatched(
	conversation: NonNullable<Awaited<ReturnType<TaskRuntime<CheckInInput, CheckInState, null, object>["conversation"]>>>,
	input: CheckInInput,
	context: Context,
) {
	const message =
		typeof input.message === "string"
			? input.message
			: input.message.map((part) =>
					part.type === "image"
						? { type: "image" as const, data: part.data, mimeType: part.mimeType }
						: { type: "text" as const, text: part.text },
				);
	return conversation.submit(
		{
			type: "input",
			content: message,
			requestId: input.requestId,
			whenBusy: placementMode(input.whenBusy),
			entry: inputEntry(input.origin, input.requester, {
				class: sentInputClass(input.origin, input.whenBusy),
				...(input.requester === undefined ? {} : { sender: input.requester }),
				requestId: input.requestId,
			}),
		},
		context,
	);
}

/**
 * Wait until the watched input settles or the deadline task ends. The deadline task ends first only when the watch
 * paused; the watched admission keeps running either way.
 */
async function settledOrPaused(
	runtime: Pick<TaskRuntime<CheckInInput, CheckInState, null, object>, "waitForTask">,
	submission: { wait(context: Context): Promise<unknown> },
	deadline: TaskId | undefined,
	context: Context,
): Promise<void> {
	if (deadline === undefined) return;
	const settled = submission.wait(context).then(
		() => undefined,
		() => undefined,
	);
	const ended = runtime.waitForTask(deadline, context).then(
		() => undefined,
		() => undefined,
	);
	await Promise.race([settled, ended]);
}

/** Leave a refused request alone and let a firing timer admit its input before the watcher reacquires it. */
async function watchableAdmission(
	runtime: Pick<TaskRuntime<CheckInInput, CheckInState, null, object>, "commit" | "waitForTask">,
	input: CheckInInput,
	context: Context,
) {
	let timer: TaskId | undefined,
		refused = false;
	await runtime.commit(async (tx) => {
		const source = await admissionSource(tx, input);
		timer = source.timerId;
		refused = source.submissionId === undefined && input.whenBusy === "reject";
		return refused ? { status: "terminal", outcome: { status: "completed", result: null } } : undefined;
	}, context);
	if (timer !== undefined && (await runtime.waitForTask(timer, context)).state.outcome.status !== "completed")
		throw new Error("Firing timer did not complete the watched admission");
	return !refused;
}

const COMPLETED_WATCH = { status: "terminal", outcome: { status: "completed", result: null } } as const;

/**
 * The deadline of one check-in task. A paused watch creates no deadline; its owner's acceptance of the outstanding
 * notice re-arms one in a new check-in task, which supersedes this one, also when a restart resumes this task after
 * the re-arm. A superseded task completes in the commit that finds it superseded.
 */
function deadlineWatch(
	runtime: Pick<TaskRuntime<CheckInInput, CheckInState, null, object>, "commit">,
	task: { readonly id: TaskId; readonly input: CheckInInput; readonly state: { readonly checkpoint: CheckInState } },
	context: Context,
	existing: TaskId | undefined,
) {
	const input = task.input;
	const watch = {
		deadline: existing,
		superseded: false,
		/** The live deadline, created unless the watch is paused or superseded. */
		ensure: async (): Promise<TaskId | undefined> => {
			if (watch.deadline !== undefined) return watch.deadline;
			await runtime.commit(async (tx) => {
				const pause = await ownPause(tx, input, task.id);
				watch.superseded = pause === undefined;
				if (pause === undefined) return COMPLETED_WATCH;
				if (pause.watch !== null) return undefined;
				watch.deadline = await tx.createTask(
					CheckInDeadlineTask,
					{ ...input, next: task.state.checkpoint.next },
					{ ownership: { kind: "task", taskId: task.id } },
				);
				return undefined;
			}, context);
			return watch.deadline;
		},
		/** Whether the watched request is open and the watch paused. */
		state: async (): Promise<{ open: boolean; paused: boolean }> => {
			let open = false;
			let paused = false;
			await runtime.commit(async (tx) => {
				open = await watchedOpen(tx, input.conversationId, input.requestId);
				const pause = await ownPause(tx, input, task.id);
				watch.superseded = pause === undefined;
				paused = pause !== undefined && pause.watch !== null;
				return watch.superseded ? COMPLETED_WATCH : undefined;
			}, context);
			return { open, paused };
		},
	};
	return watch;
}

/**
 * After the watched input settled or the watch paused. A request with open declared work keeps its check-in: the
 * deadline task ends itself once the item closes. The receipt of a failed input can still open recovered work for
 * its request; that work counts here. A closed request stops the deadline and keeps no pause.
 */
async function closeWatch(
	runtime: Pick<TaskRuntime<CheckInInput, CheckInState, null, object>, "commit" | "waitForTask" | "abortOwned">,
	input: CheckInInput,
	context: Context,
	watch: ReturnType<typeof deadlineWatch>,
	deadlines: readonly { readonly id: TaskId }[],
): Promise<void> {
	const { open, paused } = await watch.state();
	if (watch.superseded) return;
	if (open) {
		const watching = paused ? undefined : await watch.ensure();
		if (watch.superseded) return;
		if (watching !== undefined) await runtime.waitForTask(watching, context);
	} else
		for (const child of new Set([
			...deadlines.map((item) => item.id),
			...(watch.deadline === undefined ? [] : [watch.deadline]),
		]))
			await runtime.abortOwned(child, context);
	await runtime.commit(async (tx) => {
		if (!(await watchedOpen(tx, input.conversationId, input.requestId)))
			await clearCheckInPause(tx, input.ownerId, input);
		return COMPLETED_WATCH;
	}, context);
}

/**
 * An aborted watch. A stop closes the watched request and aborts every check-in task of it, and a closed request
 * needs no pause state, so either retires the pause document. A watch aborted while its request stays open keeps the
 * document and stays the request's watcher, so an earlier watch task of the request still creates no deadline.
 */
async function endAbortedWatch(tx: Tx, input: CheckInInput, task: TaskId, stopped: boolean): Promise<void> {
	if (stopped || !(await watchedOpen(tx, input.conversationId, input.requestId))) {
		await clearCheckInPause(tx, input.ownerId, input);
		return;
	}
	const pause = await ownPause(tx, input, task);
	if (pause !== undefined) pause.watcher = task;
}

/** The submission wait owns the deadline task, so settlement without open declared work stops it without waiting for its deadline. */
export const CheckInTask = defineTask<CheckInInput, CheckInState, null>({
	name: "agent.check-in",
	version: 1,
	initial: (input) => ({ phase: "watch", next: input.next ?? 1 }),
	phases: {
		watch: async (task, runtime, context) => {
			const input = task.input;
			const conversation = await runtime.conversation(input.conversationId as ConversationId, context);
			if (conversation === undefined) throw new Error("check-in conversation is absent");
			if (!(await watchableAdmission(runtime, input, context))) return;
			const submission = await submitWatched(conversation, input, context);
			const status = await submission.status(context);
			const deadlines = (await runtime.ownedTasks(context)).filter(
				(child) => child.kind === CheckInDeadlineTask.definition.name,
			);
			const settled = status.status === "done" || status.status === "unanswered";
			const watch = deadlineWatch(runtime, task, context, deadlines[0]?.id);
			if (!settled) await settledOrPaused(runtime, submission, await watch.ensure(), context);
			if (watch.superseded) return;
			await closeWatch(runtime, input, context, watch, deadlines);
		},
	},
	abort: async (task, runtime, context) => {
		const stopped = (await runtime.snapshot(CapturedStopTaskDoc, task.id, context))?.captured === true;
		await runtime.commit(async (tx) => {
			await endAbortedWatch(tx, task.input, task.id, stopped);
			return { status: "terminal", outcome: { status: "aborted" } };
		}, context);
	},
});

/** Resolve the owner against the producer's storage, including alternate root spellings. */
function ownerIsProducer(input: Omit<CheckInInput, "intervalMs">): boolean {
	const storageId = input.senderIdentity.split(":")[0];
	try {
		return resolveSessionConversationId(storageId, input.ownerId, undefined) === input.conversationId;
	} catch {
		return false;
	}
}

/** Create with the admission intent or local reporter, never with output deliveries. */
export async function createCheckIn(tx: Tx, input: Omit<CheckInInput, "intervalMs">, minutes: number): Promise<void> {
	checkInMinutes(minutes, input.origin);
	if (minutes === 0 || ownerIsProducer(input)) return;
	await tx.createTask(
		CheckInTask,
		{ ...input, intervalMs: Math.max(1, Math.round(minutes * 60000)) },
		{ ownership: { kind: "conversation" }, conversationId: input.conversationId as ConversationId, background: true },
	);
}
