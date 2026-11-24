/**
 * Questions that a Durable conversation asked ordinary primary sessions. One small document per asking
 * conversation holds its open questions and the IDs it closed most recently; only asking, a reply or
 * notice arrival, and a continuity read touch it.
 */
import { defineDoc, type ConversationId, type Tx } from "@earendil-works/pi-durable";
import { retainedReportRequest, storeDeliveryRow } from "./delivery-store.ts";
import { closingQuestion, MAX_OPEN_QUESTIONS, type OpenQuestion, questionExcerpt } from "./peer-questions.ts";

/** Closed IDs kept so that a replayed ask cannot reopen a question that its reply already closed. */
const MAX_CLOSED = 32;

type NativeQuestion = { id: string; peer: string; at: number; excerpt: string };
type NativeQuestions = { open: NativeQuestion[]; closed: string[] };
export const NativeQuestionsDoc = defineDoc<NativeQuestions>({
	kind: "agent.peer-questions",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	checkpointWhen: () => false,
	initial: () => ({ open: [], closed: [] }),
});

/** Why a Durable agent's agent_send with expectReply refuses before its target is read. */
export function nativeQuestionRefusal(args: {
	readonly mode?: string;
	readonly deliverAt?: string;
	readonly replyTo?: string;
	readonly passive?: boolean;
	readonly checkInMinutes?: number;
}): string | undefined {
	return args.mode === "report" ||
		args.deliverAt !== undefined ||
		args.replyTo !== undefined ||
		args.passive !== undefined ||
		args.checkInMinutes !== undefined
		? "expectReply asks an immediate question: omit mode report, deliverAt, replyTo, passive and checkInMinutes, and repeat the call"
		: undefined;
}

export const NATIVE_QUESTIONS_FULL = `This conversation has ${MAX_OPEN_QUESTIONS} open questions; each closes when its reply or non-reply notice arrives. Send this message without expectReply, or continue other work until an answer event arrives`;

/**
 * Reserve a question before its delivery, so a reply can never arrive before the record. A replayed ask
 * finds its own record: `open` while no reply or notice has closed it, `closed` after one did.
 */
export async function reserveNativeQuestion(
	tx: Tx,
	conversationId: ConversationId,
	question: { id: string; peer: string; message: string; at: number },
): Promise<"reserved" | "open" | "closed" | "full"> {
	const state = await tx.doc(NativeQuestionsDoc, conversationId);
	if (state.closed.includes(question.id)) return "closed";
	if (state.open.some((item) => item.id === question.id)) return "open";
	if (state.open.length >= MAX_OPEN_QUESTIONS) return "full";
	state.open.push({
		id: question.id,
		peer: question.peer,
		at: question.at,
		excerpt: questionExcerpt(question.message),
	});
	return "reserved";
}

/** Drop a reservation whose delivery failed; a closed question stays closed. */
export async function releaseNativeQuestion(tx: Tx, conversationId: ConversationId, id: string): Promise<void> {
	const state = await tx.doc(NativeQuestionsDoc, conversationId);
	const index = state.open.findIndex((item) => item.id === id);
	if (index >= 0) state.open.splice(index, 1);
}

/** Close the question that a reply or notice names when it comes from the session that was asked. */
export async function closeNativeQuestion(
	tx: Tx,
	conversationId: ConversationId,
	id: string,
	sender: string,
): Promise<boolean> {
	const state = await tx.doc(NativeQuestionsDoc, conversationId);
	const index = state.open.findIndex((item) => item.id === id && item.peer === sender);
	if (index < 0) return false;
	state.open.splice(index, 1);
	state.closed.push(id);
	if (state.closed.length > MAX_CLOSED) state.closed.splice(0, state.closed.length - MAX_CLOSED);
	return true;
}

export async function openNativeQuestions(tx: Tx, conversationId: ConversationId): Promise<OpenQuestion[]> {
	return JSON.parse(JSON.stringify((await tx.doc(NativeQuestionsDoc, conversationId)).open)) as OpenQuestion[];
}

/**
 * Close, as unanswered, each open question whose asked session has ended, and return the closed and
 * the remaining questions. `ended` runs at most once per distinct session and not at all when none is open.
 */
export async function reconcileNativeQuestions(
	tx: Tx,
	conversationId: ConversationId,
	ended: (peer: string) => boolean,
): Promise<{ open: OpenQuestion[]; ended: OpenQuestion[] }> {
	const state = await tx.doc(NativeQuestionsDoc, conversationId);
	if (state.open.length === 0) return { open: [], ended: [] };
	const checked = new Map<string, boolean>();
	const gone = (peer: string) => {
		let value = checked.get(peer);
		if (value === undefined) {
			value = ended(peer);
			checked.set(peer, value);
		}
		return value;
	};
	const items = JSON.parse(JSON.stringify(state.open)) as OpenQuestion[];
	const closed = items.filter((item) => gone(item.peer));
	if (closed.length > 0) {
		state.open = state.open.filter((item) => !closed.some((question) => question.id === item.id));
		state.closed.push(...closed.map((item) => item.id));
		if (state.closed.length > MAX_CLOSED) state.closed.splice(0, state.closed.length - MAX_CLOSED);
	}
	return { open: items.filter((item) => !closed.includes(item)), ended: closed };
}

/** The question that an admitted report input closes; a plain prefix check rejects every other input. */
export function closingInput(params: {
	requestId?: unknown;
	inputClass?: unknown;
	inputSender?: unknown;
}): { id: string; sender: string } | undefined {
	if (params.inputClass !== "report" || typeof params.inputSender !== "string") return undefined;
	const closing = closingQuestion(params.requestId);
	return closing === undefined ? undefined : { id: closing.id, sender: params.inputSender };
}

/**
 * A question that closed because its asked session ended reaches nobody: its report row, parked while that
 * session has no live endpoint, becomes terminal. Without this, a later resume of the session would deliver a
 * closed question, and its reply or notice would start a run here for nothing. A delivered row stays as it is.
 */
export async function endQuestionDeliveries(tx: Tx, ended: readonly OpenQuestion[]): Promise<void> {
	for (const question of ended) {
		const row = await retainedReportRequest(tx, question.peer, question.id);
		if (row === undefined || row.acknowledged || row.delivery?.state === "terminal") continue;
		await storeDeliveryRow(tx, "report", {
			...row,
			delivery: { state: "terminal", reason: "The asked session ended before the question reached it" },
		});
	}
}
