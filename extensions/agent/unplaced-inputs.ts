/** Admitted inputs that the recipient conversation holds in its inbox, not yet in its transcript. */
import type { Context } from "@earendil-works/chord/context";
import { defineDoc, defineTask, LiveDoc, type ConversationId, type Harness, type SubmissionId, type TaskId, type Tx } from "@earendil-works/pi-durable";
import { retainedReport, storeDeliveryRow } from "./delivery-store.ts";
import { RequestContextDoc } from "./request-context.ts";

export type InputClass = "operator" | "steer" | "followUp" | "report" | "result" | "check-in" | "timer" | "thread-notice";

export type UnplacedInput = {
	requestId: string;
	submissionId: number;
	class: InputClass;
	/** External identity of the conversation that sent the input; empty when no session sent it. */
	sender: string;
	admittedAt: number;
	/** True after the sender received the one notice about this recipient. */
	noticed: boolean;
};

export type UnplacedInputsState = {
	/** External identity of the conversation that holds these inputs, when an admission supplied it. */
	recipient?: string;
	/** The live `agent.unplaced-watch` task of the conversation. */
	watch?: number;
	inputs: UnplacedInput[];
};

export interface UnplacedAdmission {
	readonly submissionId: number;
	readonly class: InputClass;
	readonly sender: string;
	readonly admittedAt: number;
	/** External identity of the recipient conversation: the storage ID, or `storageId:conversationId`. */
	readonly recipient?: string;
}

export type Placement = "placed" | "unplaced";

export interface UnplacedSummary {
	readonly unplaced: number;
	/** Admission time of the oldest queued input; absent when none is queued. */
	readonly oldestAdmittedAt?: number;
}

export const UnplacedInputsDoc = defineDoc<UnplacedInputsState>({ kind: "agent.unplaced-inputs", version: 1, scope: "conversation", history: "latest", fork: "initial", checkpointWhen: () => false, initial: () => ({ inputs: [] }) });

async function queued(inputs: readonly UnplacedInput[], submission: (id: SubmissionId) => Promise<{ readonly status: string } | undefined>): Promise<UnplacedInput[]> {
	const retained: UnplacedInput[] = [];
	for (const input of inputs) if ((await submission(input.submissionId as SubmissionId))?.status === "queued") retained.push(input);
	return retained;
}

/** Drop every row whose submission left the inbox: placed, settled, or absent. */
export async function pruneUnplacedInputs(tx: Tx, conversationId: ConversationId): Promise<UnplacedInput[]> {
	const state = await tx.doc(UnplacedInputsDoc, conversationId);
	const retained = await queued(state.inputs, (id) => tx.submission(id));
	if (retained.length !== state.inputs.length) state.inputs.splice(0, state.inputs.length, ...retained);
	return state.inputs;
}

/**
 * Report the committed placement of one admitted submission and retain it while it is queued.
 * Call in a commit after the submit. A repeat for the same submission keeps the first admission time.
 */
export async function recordUnplacedInput(tx: Tx, conversationId: ConversationId, admission: UnplacedAdmission): Promise<Placement> {
	const inputs = await pruneUnplacedInputs(tx, conversationId);
	const submission = await tx.submission(admission.submissionId as SubmissionId);
	if (submission?.status !== "queued" || submission.conversationId !== conversationId) return "placed";
	const state = await tx.doc(UnplacedInputsDoc, conversationId);
	if (admission.recipient !== undefined) state.recipient = admission.recipient;
	if (!inputs.some((input) => input.submissionId === admission.submissionId))
		inputs.push({ requestId: submission.requestId ?? "", submissionId: admission.submissionId, class: admission.class, sender: admission.sender, admittedAt: admission.admittedAt, noticed: false });
	const watch = state.watch === undefined ? undefined : await tx.task(state.watch as TaskId);
	if (watch === undefined || watch.state.status === "terminal")
		state.watch = await tx.createTask(UnplacedWatchTask, { conversationId }, { ownership: { kind: "conversation" }, conversationId, background: true });
	return "unplaced";
}

function summary(inputs: readonly UnplacedInput[]): UnplacedSummary {
	return inputs.length === 0 ? { unplaced: 0 } : { unplaced: inputs.length, oldestAdmittedAt: Math.min(...inputs.map((input) => input.admittedAt)) };
}

/** Count and oldest admission time of the rows that are still queued, without a write. */
export async function unplacedSummary(tx: Tx, conversationId: ConversationId): Promise<UnplacedSummary> {
	return summary(await queued((await tx.doc(UnplacedInputsDoc, conversationId)).inputs, (id) => tx.submission(id)));
}

/** Committed snapshot read of `unplacedSummary()` for observation code. */
export async function readUnplacedSummary(harness: Harness, conversationId: ConversationId, context: Context): Promise<UnplacedSummary> {
	const state = await harness.snapshot(UnplacedInputsDoc, conversationId, context);
	return summary(await queued(state?.inputs ?? [], async (id) => (await harness.submission(id, context))?.status(context)));
}

/** An input that stays queued this long produces one notice to its sender. */
export const UNPLACED_NOTICE_MS = 5 * 60_000;

/** Classes that an agent or the operator sends on purpose; only these produce a notice. */
const EXPLICIT_CLASSES: ReadonlySet<InputClass> = new Set<InputClass>(["operator", "steer", "followUp", "report", "thread-notice"]);

function at(time: number | undefined): string {
	return time === undefined ? "start unknown" : `first started at ${new Date(time).toISOString()}`;
}

/**
 * What the conversation does now, from its live state and task records: each running tool with the first start of its
 * task, else a blocking compaction, else a provider retry with its attempt, else the model step.
 */
export async function currentStep(tx: Tx, conversationId: ConversationId, maxAttempts?: number): Promise<string> {
	const live = await tx.doc(LiveDoc, conversationId);
	const started = async (taskId: TaskId | undefined): Promise<number | undefined> => taskId === undefined ? undefined : (await tx.task(taskId))?.startedAt;
	const tools = [...live.tools ?? [], ...live.nestedTools ?? []].filter((tool) => tool.status === "running").slice(0, 4);
	if (tools.length > 0) {
		const lines: string[] = [];
		for (const tool of tools) lines.push(`tool ${tool.name.slice(0, 80)}, ${at(await started(tool.taskId))}`);
		return lines.join("; ");
	}
	const compaction = live.compactions?.find((status) => status.blocking);
	if (compaction !== undefined)
		return `compaction, attempt ${compaction.attempt}, ${at(await started(compaction.taskId))}${compaction.retry === undefined ? "" : `, next attempt at ${new Date(compaction.retry.at).toISOString()}`}`;
	if (live.run === undefined) return "no run";
	const run = at(await started(live.run.taskId));
	if (live.generation?.retry !== undefined)
		return `provider retry, attempt ${live.generation.attempt}${maxAttempts === undefined ? "" : ` of ${maxAttempts}`}, next attempt at ${new Date(live.generation.retry.at).toISOString()}; model step ${run}`;
	return live.generation === undefined ? `between steps; run ${run}` : `model step, ${run}`;
}

/** Reply recipients of the routed requests that the current run serves. */
async function runRequesters(tx: Tx, conversationId: ConversationId): Promise<string[]> {
	const run = (await tx.doc(LiveDoc, conversationId)).run;
	if (run === undefined) return [];
	const routes = (await tx.doc(RequestContextDoc, conversationId)).requests;
	const requesters = new Set<string>();
	for (const id of run.inputs) {
		const requestId = (await tx.submission(id))?.requestId;
		const route = requestId === undefined ? undefined : routes.find((request) => request.requestId === requestId);
		if (route !== undefined) requesters.add(route.replyTo);
	}
	return [...requesters];
}

async function writeNotice(tx: Tx, ownerId: string, senderIdentity: string, sourceId: string, message: string, passive: boolean, now: number): Promise<void> {
	if (await retainedReport(tx, ownerId, sourceId) !== undefined) return;
	await storeDeliveryRow(tx, "report", { sourceId, requestId: sourceId, ownerId, senderIdentity, message, replyTo: null, ...(passive ? { passive } : {}), acknowledged: false, createdAt: now }, true);
}

/**
 * Notify once for each sender whose explicit input stayed queued for the notice period, and once for each requester of
 * the current run that is not such a sender. Every other due row is marked without a notice.
 */
async function noticeDue(tx: Tx, conversationId: ConversationId, state: UnplacedInputsState, now: number, maxAttempts: number): Promise<void> {
	const due = state.inputs.filter((input) => !input.noticed && input.admittedAt + UNPLACED_NOTICE_MS <= now);
	if (due.length === 0) return;
	const recipient = state.recipient ?? String(conversationId);
	let step: string | undefined;
	let explicit = false;
	const oldest = Math.min(...state.inputs.map((input) => input.admittedAt));
	for (const row of due) {
		if (row.noticed) continue;
		if (!EXPLICIT_CLASSES.has(row.class)) { row.noticed = true; continue; }
		explicit = true;
		const own = state.inputs.filter((input) => input.sender === row.sender);
		const repeat = own.some((input) => input.noticed);
		for (const input of own) input.noticed = true;
		if (repeat || row.sender === "" || row.sender === recipient) continue;
		step ??= await currentStep(tx, conversationId, maxAttempts);
		await writeNotice(tx, row.sender, recipient, `unplaced:${conversationId}:${row.requestId}`,
			`Unplaced input notice: ${recipient} did not place ${own.length} admitted input${own.length === 1 ? "" : "s"} from you for more than 5 minutes (oldest admitted ${new Date(row.admittedAt).toISOString()}, request ${row.requestId}). Current step: ${step}. The input${own.length === 1 ? " stays" : "s stay"} queued and the recipient places ${own.length === 1 ? "it" : "them"} at the end of its current tool round; nothing was withdrawn.`,
			row.class === "thread-notice", now);
	}
	if (!explicit) return;
	const run = (await tx.doc(LiveDoc, conversationId)).run;
	for (const requester of await runRequesters(tx, conversationId)) {
		if (requester === recipient || state.inputs.some((input) => input.sender === requester && input.noticed)) continue;
		step ??= await currentStep(tx, conversationId, maxAttempts);
		await writeNotice(tx, requester, recipient, `unplaced:${conversationId}:run:${run?.taskId ?? 0}`,
			`Unplaced input notice: ${recipient}, which serves your request, did not place ${state.inputs.length} admitted input${state.inputs.length === 1 ? "" : "s"} for more than 5 minutes (oldest admitted ${new Date(oldest).toISOString()}). Current step: ${step}. The inputs stay queued until the end of its current tool round.`,
			false, now);
	}
}

/** One background task for each conversation; it ends when no queued row waits for its notice time. */
export const UnplacedWatchTask = defineTask<{ conversationId: number }, { phase: "watch" }, null>({
	name: "agent.unplaced-watch",
	version: 1,
	initial: () => ({ phase: "watch" }),
	phases: {
		watch: async (task, runtime, context) => {
			const id = task.input.conversationId as ConversationId;
			const now = runtime.now();
			const maxAttempts = runtime.settings.retry.enabled ? runtime.settings.retry.maxRetries + 1 : 1;
			await runtime.commit(async (tx) => {
				await pruneUnplacedInputs(tx, id);
				const state = await tx.doc(UnplacedInputsDoc, id);
				await noticeDue(tx, id, state, now, maxAttempts);
				const waiting = state.inputs.filter((input) => !input.noticed);
				if (waiting.length === 0) {
					if (state.watch === task.id) delete state.watch;
					return { status: "terminal", outcome: { status: "completed", result: null } };
				}
				return { status: "sleeping", until: Math.min(...waiting.map((input) => input.admittedAt)) + UNPLACED_NOTICE_MS, checkpoint: { phase: "watch" } };
			}, context);
		},
	},
	abort: (_task, runtime, context) => runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
});
