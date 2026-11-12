/** Admitted inputs that the recipient conversation holds in its inbox, not yet in its transcript. */
import type { Context } from "@earendil-works/chord/context";
import { defineDoc, type ConversationId, type Harness, type SubmissionId, type Tx } from "@earendil-works/pi-durable";

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
