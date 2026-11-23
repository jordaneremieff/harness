import type { ConversationId, Cursor, TaskId, Tx, SubmissionId } from "@earendil-works/pi-durable";
import type { DeliveryIntent } from "./durable-controls.ts";

export const TIMER_TASK_NAME = "agent.timer";

type Admission = Pick<DeliveryIntent, "requestId" | "ownerId" | "origin" | "message" | "whenBusy"> & {
	conversationId: number;
};
type AdmissionSource = { submissionId?: SubmissionId; timerId?: TaskId };

/** A firing timer owns its unadmitted input. Other timers, including ones still asleep, do not delay ordinary admissions. */
export async function admissionSource(tx: Tx, request: Admission): Promise<AdmissionSource> {
	const conversationId = request.conversationId as ConversationId;
	const retained = await tx.submissionByRequest(conversationId, request.requestId);
	if (retained) return { submissionId: retained.id };
	if (request.whenBusy === "reject" || typeof request.message !== "string") return {};
	for (const status of ["pending", "running"] as const) {
		let cursor: Cursor | undefined;
		do {
			const page = await tx.scanTasks({ conversationId, kind: TIMER_TASK_NAME, status }, 64, cursor);
			for (const task of page.items) {
				const input = task.input,
					checkpoint = task.state.checkpoint;
				if (
					input &&
					typeof input === "object" &&
					!Array.isArray(input) &&
					checkpoint &&
					typeof checkpoint === "object" &&
					!Array.isArray(checkpoint) &&
					checkpoint.firing === true &&
					input.requestId === request.requestId &&
					input.ownerId === request.ownerId &&
					input.origin === request.origin &&
					input.mode === request.whenBusy &&
					input.message === request.message
				)
					return { timerId: task.id };
			}
			cursor = page.next;
		} while (cursor);
	}
	return {};
}
