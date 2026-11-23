/** Interrupt one exact generation and place only the explicitly selected queued cohort. */
import { awaitWithContext, withAbortSignal, type Context } from "@earendil-works/chord/context";
import type { Selection } from "./interrupt-schema.ts";
import {
	defineDocFamily,
	GenerationTask,
	InboxDoc,
	LiveDoc,
	type Tx,
	type Conversation,
	type Harness,
	type TaskId,
	type ConversationId,
} from "@earendil-works/pi-durable";

type Outcome = { state: "protected" | "pending" | "continued"; submissionId?: number };
function retain(intent: { outcome?: Outcome }, outcome: Outcome) {
	intent.outcome = outcome;
	return outcome;
}
const Intent = defineDocFamily<{ taskId?: number; inputs?: number[]; outcome?: Outcome }, null>({
	kind: "agent.interrupt-intent",
	version: 1,
	family: true,
	scope: "conversation",
	fork: "initial",
	history: "latest",
	initial: () => ({}),
	checkpointWhen: () => false,
});
async function matchesQueue(tx: Tx, id: ConversationId, inputs: number[]): Promise<boolean> {
	const { items } = await tx.doc(InboxDoc, id);
	return items.length === inputs.length && items.every((item, i) => item.mode !== "write" && item.id === inputs[i]);
}
async function selectMark(tx: Tx, id: ConversationId, selection: Selection): Promise<Outcome | "mark" | "observe"> {
	const intent = await tx.doc(Intent, id, selection.intentId, null);
	const replay = intent.taskId !== undefined;
	if (replay) {
		if (intent.taskId !== selection.taskId || JSON.stringify(intent.inputs) !== JSON.stringify(selection.queuedInputs))
			throw new Error("Intent already selects a different interrupt");
		if (intent.outcome) return { ...intent.outcome };
	} else {
		intent.taskId = selection.taskId;
		intent.inputs = selection.queuedInputs;
	}
	const live = await tx.doc(LiveDoc, id);
	if (replay && !live.run) return "observe";
	if (live.run?.taskId !== selection.taskId || !(await matchesQueue(tx, id, selection.queuedInputs)))
		return retain(intent, { state: "protected" });
	return "mark";
}
export async function interruptContinue(
	harness: Harness,
	conversation: Conversation,
	selection: Selection,
	context: Context,
): Promise<Outcome> {
	// Place the selection and conditional native mark adjacently on the session line. A queue change cannot enter between them.
	const veto = new AbortController();
	const decision = conversation.commit(async (tx) => {
		try {
			const selected = await selectMark(tx, conversation.id, selection);
			if (selected !== "mark") veto.abort();
			return selected;
		} catch (error) {
			veto.abort(error);
			throw error;
		}
	}, context);
	const deadline = AbortSignal.timeout(15_000);
	const signal = context.abortSignal ? AbortSignal.any([context.abortSignal, deadline]) : deadline;
	const bounded = withAbortSignal(signal, context);
	const taskId = selection.taskId as TaskId;
	const marking = withAbortSignal(AbortSignal.any([veto.signal, signal]), bounded);
	const marked = harness.abortTask(taskId, marking);
	void marked.catch(() => {});
	const selected = await decision;
	if (typeof selected !== "string") return selected;
	try {
		if (selected === "mark") await awaitWithContext(marked, bounded);
		await awaitWithContext(harness.waitForTask(taskId, bounded), bounded);
	} catch (error) {
		context.abortSignal?.throwIfAborted();
		if (deadline.aborted) return { state: "pending" };
		throw error;
	}
	return conversation.commit(async (tx) => {
		const intent = await tx.doc(Intent, conversation.id, selection.intentId, null);
		if (intent.outcome) return { ...intent.outcome };
		const live = await tx.doc(LiveDoc, conversation.id);
		const latest = (
			await tx.scanTasks(
				{ kind: GenerationTask.definition.name, conversationId: conversation.id, order: "descending" },
				1,
			)
		).items[0];
		if (
			live.run ||
			latest?.id !== taskId ||
			latest.state.outcome?.status !== "aborted" ||
			!(await matchesQueue(tx, conversation.id, selection.queuedInputs))
		)
			return retain(intent, { state: "protected" });
		const submissionId = await conversation.submit(tx, { type: "continue" });
		return retain(intent, { state: "continued", submissionId });
	}, context);
}
