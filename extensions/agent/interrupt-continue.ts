/** Interrupt one exact generation and place only the explicitly selected queued cohort. */
import { awaitWithContext, withAbortSignal, type Context } from "@earendil-works/chord/context";
import { arr, int, obj, str, type Static } from "@earendil-works/pi-schema";
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

export const InterruptSelection = obj(
	{
		taskId: int({ minimum: 1 }),
		queuedInputs: arr(int({ minimum: 1 }), { minItems: 1, maxItems: 200, uniqueItems: true }),
		intentId: str({ minLength: 1, maxLength: 256 }),
	},
	{},
);
type Selection = Static<typeof InterruptSelection>;
type Outcome = { state: "protected" | "pending" | "continued"; submissionId?: number };
export function interruptConflict(input: {
	interrupt?: Selection;
	timerId?: number;
	release?: boolean;
	background?: boolean;
}): boolean {
	return !!input.interrupt && (!!input.release || !!input.background || input.timerId !== undefined);
}
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
async function begin(conversation: Conversation, selection: Selection, context: Context): Promise<Outcome | undefined> {
	return conversation.commit(async (tx) => {
		const intent = await tx.doc(Intent, conversation.id, selection.intentId, null);
		if (intent.taskId !== undefined) {
			if (
				intent.taskId !== selection.taskId ||
				JSON.stringify(intent.inputs) !== JSON.stringify(selection.queuedInputs)
			)
				throw new Error("Intent already selects a different interrupt");
			return intent.outcome ? { ...intent.outcome } : undefined;
		}
		const live = await tx.doc(LiveDoc, conversation.id);
		intent.taskId = selection.taskId;
		intent.inputs = selection.queuedInputs;
		if (live.run?.taskId !== selection.taskId || !(await matchesQueue(tx, conversation.id, selection.queuedInputs)))
			return retain(intent, { state: "protected" });
		return undefined;
	}, context);
}
export async function interruptContinue(
	harness: Harness,
	conversation: Conversation,
	selection: Selection,
	context: Context,
): Promise<Outcome> {
	const retained = await begin(conversation, selection, context);
	if (retained) return retained;
	const deadline = AbortSignal.timeout(15_000);
	const bounded = withAbortSignal(
		context.abortSignal ? AbortSignal.any([context.abortSignal, deadline]) : deadline,
		context,
	);
	const taskId = selection.taskId as TaskId;
	try {
		await awaitWithContext(harness.abortTask(taskId, bounded), bounded);
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
