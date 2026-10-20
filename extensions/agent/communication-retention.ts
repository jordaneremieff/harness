import { createHash } from "node:crypto";
import type { Context } from "@earendil-works/chord";
import { defineDocFamily, UserEntry, type ConversationId, type EntryId, type Session, type SubmissionRecord, type Tx } from "@earendil-works/pi-durable";
import { AwaitDoc } from "./awaited-results.ts";
import { communicationFingerprint, parseCommunication, parseCommunicationCompanion, type Communication, type CommunicationInputLink } from "./communication.ts";
import { parseTaskSenderRecord, retainTaskInputSender, TASK_SENDER_ENTRY_KIND, type RetainedTaskSender, type TaskInputSender } from "./task-senders.ts";

/** Part of the existing admitted-input retention, never a second delivery queue. */
export type RetainedCommunicationIntent = {
	storageId?: string;
	value?: Communication;
	fingerprint?: string;
	diagnostic?: "invalid" | "conflict";
	noEnvelope?: true;
	linkedEntryId?: string;
	recordEntryId?: string;
	taskSender?: RetainedTaskSender;
};
export type CommunicationIndex = { target?: CommunicationInputLink; recordEntryId?: string; invalid?: boolean; noEnvelope?: true; taskSenderEntryId?: string };
/** A point lookup is only a hint; immutable visible records remain the authority. */
export const CommunicationIndexDoc = defineDocFamily<CommunicationIndex, null>({ kind: "agent.communication-index", version: 1, scope: "session", family: true, initial: () => ({}) });
export function communicationIndexKey(storageId: string, conversationId: number, entryId: string): string {
	return `${storageId}/${conversationId}/${entryId}`;
}
export function retainCommunicationIntent(value: unknown, now: () => number): RetainedCommunicationIntent {
	try {
		const parsed = parseCommunication(value);
		if (parsed === undefined) return { diagnostic: "invalid" };
		const recordedAt = now();
		if (!Number.isSafeInteger(recordedAt) || recordedAt < 0) return { diagnostic: "invalid" };
		return { value: { ...parsed, recordedAt }, fingerprint: createHash("sha256").update(communicationFingerprint(parsed)).digest("hex") };
	} catch { return { diagnostic: "invalid" }; }
}
/** A repeated request never replaces the first retained value or re-admits input. */
export function mergeCommunicationIntent(prior: RetainedCommunicationIntent | undefined, incoming: RetainedCommunicationIntent | undefined): RetainedCommunicationIntent | undefined {
	if (prior === undefined) return undefined;
	if (prior.noEnvelope === true) return prior;
	if (incoming === undefined || prior.fingerprint !== incoming.fingerprint || (prior.value === undefined) !== (incoming.value === undefined)) return { ...prior, diagnostic: prior.value === undefined ? "invalid" : "conflict" };
	return prior;
}

async function reconcileOne(tx: Tx, storageId: string, conversationId: ConversationId, requestId: string): Promise<void> {
	const state = await tx.doc(AwaitDoc);
	const intent = state.provenance.find((item) => item.conversationId === conversationId && item.requestId === requestId)?.communicationIntent;
	if (intent !== undefined) await (await prepareCommunication(tx, storageId, conversationId, requestId, intent))();
}

/** Prepare every native read before applying any companion table write. */
export async function prepareCommunication(tx: Tx, storageId: string, conversationId: ConversationId, requestId: string, intent: RetainedCommunicationIntent, knownSubmission?: SubmissionRecord): Promise<() => Promise<void>> {
	const nothing = async (): Promise<void> => {};
	if (intent.linkedEntryId !== undefined) return nothing;
	const submission = knownSubmission ?? await tx.submissionByRequest(conversationId, requestId);
	if (submission?.type !== "input" || submission.entry === undefined) return nothing;
	const input = await tx.entry(UserEntry, submission.entry);
	if (input === undefined || input.conversationId !== conversationId) return async () => { intent.diagnostic = "invalid"; };
	const target: CommunicationInputLink = { mode: "input", storageId, conversationId, entryId: String(input.id), submissionId: submission.id, requestId };
	const key = communicationIndexKey(storageId, conversationId, target.entryId);
	const index = await tx.doc(CommunicationIndexDoc, key, null);
	if (index.target !== undefined) return async () => {
		if (communicationFingerprintTarget(index.target as CommunicationInputLink) !== communicationFingerprintTarget(target)) { intent.diagnostic = "invalid"; return; }
		intent.linkedEntryId = target.entryId;
		if (index.recordEntryId !== undefined) intent.recordEntryId = index.recordEntryId;
	};
	const value = parseCommunication(intent.value);
	const companion = value === undefined ? undefined : parseCommunicationCompanion({ format: "agent.communication-link/1", target, value });
	const sender = intent.taskSender === undefined ? undefined : parseTaskSenderRecord({ format: "agent.task-sender/1", target, ...intent.taskSender });
	return async () => {
		if (sender !== undefined) {
			const record = await tx.appendEntry(conversationId, { kind: TASK_SENDER_ENTRY_KIND, data: sender });
			index.taskSenderEntryId = String(record.id);
		}
		if (intent.noEnvelope === true) {
			index.target = target;
			index.noEnvelope = true;
			intent.linkedEntryId = target.entryId;
			return;
		}
		if (companion === undefined) {
			index.target = target;
			index.invalid = true;
			intent.diagnostic = "invalid";
			intent.linkedEntryId = target.entryId;
			return;
		}
		const record = await tx.appendEntry(conversationId, { kind: "agent.communication", data: companion });
		index.target = target;
		index.recordEntryId = String(record.id);
		intent.linkedEntryId = target.entryId;
		intent.recordEntryId = String(record.id);
	};
}

/** The existing post-admission classification commit owns the first durable capture. */
export async function prepareAdmittedCapture(tx: Tx, storageId: string, conversationId: ConversationId, requestId: string, submissionId: number, value: unknown, now: () => number, deduped: boolean, taskSender?: TaskInputSender): Promise<() => Promise<void>> {
	const state = await tx.doc(AwaitDoc);
	const prior = state.provenance.find((item) => item.conversationId === conversationId && item.requestId === requestId);
	const submission = await tx.submissionByRequest(conversationId, requestId);
	if (submission?.type !== "input" || submission.id !== submissionId) return async () => { state.communicationDiagnostic = "unavailable"; };
	const index = submission.entry === undefined ? undefined : await tx.doc(CommunicationIndexDoc, communicationIndexKey(storageId, conversationId, String(submission.entry)), null);
	const sender = taskSender === undefined ? undefined : retainTaskInputSender(taskSender, now());
	const incoming: RetainedCommunicationIntent = { ...(value === undefined ? { storageId, noEnvelope: true as const } : { ...retainCommunicationIntent(value, now), storageId }), ...(sender === undefined ? {} : { taskSender: sender }) };
	const intent = index?.noEnvelope === true ? { storageId, noEnvelope: true as const } : prior?.communicationIntent === undefined
		? deduped || prior?.submissionId !== undefined || index?.target !== undefined ? undefined : incoming
		: mergeCommunicationIntent(prior.communicationIntent, incoming);
	const materialize = intent === undefined ? undefined : await prepareCommunication(tx, storageId, conversationId, requestId, intent, submission);
	return async () => {
		const provenance = state.provenance.find((item) => item.conversationId === conversationId && item.requestId === requestId);
		if (provenance === undefined) { state.communicationDiagnostic = "unavailable"; return; }
		await materialize?.();
		if (intent !== undefined) provenance.communicationIntent = intent;
		provenance.submissionId = submissionId;
	};
}
function communicationFingerprintTarget(value: CommunicationInputLink): string {
	return JSON.stringify([value.mode, value.storageId, value.conversationId, value.entryId, value.submissionId, value.requestId]);
}
/** Existing retained input records provide the bounded reopen/reconciliation set. */
export async function reconcileInputCommunications(session: Session, storageId: string, context: Context): Promise<void> {
	const state = await session.snapshot(AwaitDoc, context);
	for (const provenance of state?.provenance ?? []) {
		if (provenance.communicationIntent === undefined || provenance.communicationIntent.linkedEntryId !== undefined) continue;
		await session.commit((tx) => reconcileOne(tx, storageId, provenance.conversationId as ConversationId, provenance.requestId), context);
	}
}
export async function reconcilePlacedCommunication(tx: Tx, storageId: string, conversationId: ConversationId, requestId: string): Promise<void> {
	await reconcileOne(tx, storageId, conversationId, requestId);
}
/** Typed conversion is kept at the immutable record boundary, not in native admission. */
export function communicationNativeEntryId(value: string): EntryId | undefined {
	const id = Number(value);
	return Number.isSafeInteger(id) && id > 0 && String(id) === value ? id as EntryId : undefined;
}
