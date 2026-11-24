/**
 * Questions that a Durable conversation asked ordinary primary sessions. One small document per asking
 * conversation holds its open questions and the IDs it closed most recently; only asking, a reply or
 * notice arrival, and a continuity read touch it.
 */
import { defineDoc, type ConversationId, type Tx } from "@earendil-works/pi-durable";
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

export const NATIVE_QUESTIONS_FULL = `This conversation has ${MAX_OPEN_QUESTIONS} open questions; each closes when its reply or non-reply notice arrives. Send this message without expectReply, or continue other work until an answer event arrives`;

/** Reserve a question before its delivery, so a reply can never arrive before the record. */
export async function reserveNativeQuestion(
	tx: Tx,
	conversationId: ConversationId,
	question: { id: string; peer: string; message: string; at: number },
): Promise<"reserved" | "known"> {
	const state = await tx.doc(NativeQuestionsDoc, conversationId);
	if (state.closed.includes(question.id) || state.open.some((item) => item.id === question.id)) return "known";
	if (state.open.length >= MAX_OPEN_QUESTIONS) throw new Error(NATIVE_QUESTIONS_FULL);
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
