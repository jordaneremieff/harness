import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createSession, type TaskId, type Tx } from "@earendil-works/pi-durable";
import { readDeliveryDraft } from "./delivery-store.ts";
import type { DeliveryIntent } from "./durable-controls.ts";
import { AgentTimerDoc, TimerTask, type TimerInput, type TimerRecord } from "./durable-timers.ts";
import { SNAPSHOT_BACKUP_TIMEOUT_MS, SNAPSHOT_MAX_SOURCE_BYTES } from "./durable-observation.ts";
import { recipientStorage } from "./recipient-hints.ts";
import { captureSnapshot } from "./snapshot-capture.ts";

type Witness = { ownerId: string; conversationId: number; requestId: string; timerId?: number };
function witness(row: DeliveryIntent | TimerRecord): Witness {
	return {
		ownerId: row.ownerId,
		conversationId: row.conversationId,
		requestId: row.requestId,
		...("timerId" in row ? { timerId: row.timerId } : {}),
	};
}

async function nativeInput(tx: Tx, row: DeliveryIntent): Promise<boolean> {
	const input = await tx.submissionByRequest(row.conversationId, row.requestId);
	return (
		input?.type === "input" &&
		(row.submissionId === null || row.submissionId === input.id) &&
		input.status !== "done" &&
		input.status !== "unanswered"
	);
}

async function nativeTimer(tx: Tx, timer: TimerRecord): Promise<boolean> {
	const task = await tx.task(timer.timerId as TaskId);
	const input = task?.input as TimerInput | undefined;
	return (
		task?.kind === TimerTask.definition.name &&
		task.state.status !== "terminal" &&
		task.conversationId === timer.conversationId &&
		input?.requestId === timer.requestId &&
		input.ownerId === timer.ownerId
	);
}

async function owed(
	tx: Tx,
	accepts: (owner: string) => boolean,
	expected?: string,
): Promise<Witness | "delivery" | undefined> {
	const matches = (row: Witness) => expected === undefined || JSON.stringify(row) === expected;
	const { intents, receipts, reports } = await readDeliveryDraft(tx, false, undefined, false, accepts);
	for (const row of intents) {
		const proof = witness(row);
		if (matches(proof) && (await nativeInput(tx, row))) return proof;
	}
	for (const timer of (await tx.doc(AgentTimerDoc)).timers) {
		if (timer.status !== "pending" || !accepts(timer.ownerId)) continue;
		const proof = witness(timer);
		if (matches(proof) && (await nativeTimer(tx, timer))) return proof;
	}
	return intents.length || Object.keys(receipts).length || reports.length ? "delivery" : undefined;
}

/** Check a private snapshot without opening a writer or starting a scheduler on the source. */
export async function recoveryProof(path: string, recipients: readonly string[], expected?: string) {
	const copy = await captureSnapshot(path, {
		maxSourceBytes: SNAPSHOT_MAX_SOURCE_BYTES,
		deadline: Date.now() + SNAPSHOT_BACKUP_TIMEOUT_MS,
	});
	try {
		if (copy.absent) return undefined;
		const session = createSession(copy.storage);
		try {
			return await session.commit(
				(tx) => owed(tx, (owner) => recipients.includes(recipientStorage(owner) ?? ""), expected),
				BACKGROUND_CONTEXT,
			);
		} finally {
			await session.close(BACKGROUND_CONTEXT);
		}
	} finally {
		await copy.cleanup?.();
	}
}

export async function verifyRecoverySponsor(path: string, encoded: string): Promise<void> {
	const owner = recipientStorage(JSON.parse(encoded).ownerId);
	const proof = owner && (await recoveryProof(path, [owner], encoded));
	if (!proof || proof === "delivery") throw new Error("The source no longer owes the sponsored request");
}
