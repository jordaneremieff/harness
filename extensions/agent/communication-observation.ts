import type { Context } from "@earendil-works/chord";
import { isInputKind } from "./input-entry.ts";
import type { Conversation, EntryId, EntryRecord, Harness, SubmissionId } from "@earendil-works/pi-durable";
import { boundCommunicationViews, COMMUNICATION_PAGE_ENTRIES, parseCommunicationCompanion, parseCommunicationLink, parseCommunicationPassive, parseCommunicationView, type CommunicationInputLink, type CommunicationView } from "./communication.ts";
import { CommunicationIndexDoc, communicationIndexKey, communicationNativeEntryId, type CommunicationIndex } from "./communication-retention.ts";
import { boundTaskSenders, parseTaskSenderRecord, TASK_SENDER_ENTRY_KIND, TASK_SENDER_PAGE_ENTRIES, type TaskInputSender, type TaskSenders } from "./task-senders.ts";

const unresolved: CommunicationView = { state: "unresolved" };
const invalid: CommunicationView = { state: "unavailable", reason: "invalid" };
const limited: CommunicationView = { state: "unavailable", reason: "limit" };

/** One immutable view cutoff, independent of the older-page display boundary. */
export interface CapturedCommunicationReader {
	readonly tail: EntryId | undefined;
	views(entries: readonly EntryRecord[]): Promise<readonly CommunicationView[]>;
	taskSenders(entries: readonly EntryRecord[]): Promise<TaskSenders | undefined>;
}
function emptyIndex(index: CommunicationIndex | undefined): boolean {
	return index === undefined || (index.target === undefined && index.recordEntryId === undefined && index.invalid === undefined);
}
function targetMatches(target: CommunicationInputLink, entry: EntryRecord, storageId: string): boolean {
	return target.storageId === storageId && target.conversationId === entry.conversationId && target.entryId === String(entry.id);
}
function sameSubmission(a: CommunicationInputLink, b: CommunicationInputLink): boolean {
	return a.submissionId === b.submissionId && a.requestId === b.requestId;
}
function modelLessCompanion(record: EntryRecord, origin: number, kind = "agent.communication"): boolean {
	return record.kind === kind && record.conversationId === origin && record.model === undefined && record.head === undefined && record.edits === undefined;
}

/** Public fork-aware exact reads, never global-entry existence or a nearby-text search. */
export async function captureCommunicationReader(harness: Harness, storageId: string, conversation: Conversation, context: Context): Promise<CapturedCommunicationReader> {
	let tail: EntryId | undefined;
	try { tail = (await conversation.entries({}, 1, undefined, context)).items[0]?.id; }
	catch { return { tail: undefined, views: async (entries) => boundCommunicationViews(entries.map(() => unresolved)), taskSenders: async () => undefined }; }
	async function exact(id: EntryId): Promise<EntryRecord | undefined> {
		if (tail === undefined || id > tail) return undefined;
		const page = await conversation.entries({ minEntryId: id, maxEntryId: id }, 1, undefined, context);
		return page.items.find((entry) => entry.id === id);
	}
	async function passiveView(entry: EntryRecord): Promise<CommunicationView> {
		if (entry.data === undefined) return unresolved;
		const visible = await exact(entry.id);
		if (visible === undefined) return unresolved;
		if (visible.kind !== entry.kind || visible.conversationId !== entry.conversationId) return invalid;
		const value = parseCommunicationPassive(visible.data);
		if (value === undefined) return invalid;
		return parseCommunicationView({ state: "ready", recordEntryId: String(visible.id), target: { mode: "passive", storageId, conversationId: visible.conversationId, entryId: String(visible.id), requestId: value.requestId }, value: value.value }) ?? invalid;
	}
	async function nativeTargetMatches(target: CommunicationInputLink, visible: EntryRecord): Promise<boolean> {
		if (!isInputKind(visible.kind) || visible.conversationId !== target.conversationId) return false;
		const submission = await harness.submission(target.submissionId as SubmissionId, context);
		const native = await submission?.status(context);
		return native?.type === "input" && native.id === target.submissionId && native.entry === visible.id && native.conversationId === target.conversationId && native.requestId === target.requestId;
	}
	function companionRecordView(record: EntryRecord, target: CommunicationInputLink, visible: EntryRecord): CommunicationView {
		if (!modelLessCompanion(record, visible.conversationId)) return invalid;
		const companion = parseCommunicationCompanion(record.data);
		if (companion === undefined) return invalid;
		if (!targetMatches(companion.target, visible, storageId) || !sameSubmission(companion.target, target)) return invalid;
		return parseCommunicationView({ state: "ready", recordEntryId: String(record.id), target: companion.target, value: companion.value }) ?? invalid;
	}
	async function companionView(index: CommunicationIndex, target: CommunicationInputLink, visible: EntryRecord): Promise<CommunicationView> {
		if (index.invalid === true) return invalid;
		if (index.recordEntryId === undefined) return unresolved;
		const recordId = communicationNativeEntryId(index.recordEntryId);
		if (recordId === undefined) return invalid;
		const record = await exact(recordId);
		return record === undefined ? unresolved : companionRecordView(record, target, visible);
	}
	async function inputView(entry: EntryRecord): Promise<CommunicationView> {
		const index = await harness.snapshot(CommunicationIndexDoc, communicationIndexKey(storageId, entry.conversationId, String(entry.id)), context);
		if (emptyIndex(index)) return unresolved;
		const target = parseCommunicationLink(index?.target);
		if (target?.mode !== "input" || !targetMatches(target, entry, storageId)) return invalid;
		const visible = await exact(entry.id);
		if (visible === undefined) return unresolved;
		if (!await nativeTargetMatches(target, visible)) return invalid;
		return companionView(index as CommunicationIndex, target, visible);
	}
	async function resolve(entry: EntryRecord): Promise<CommunicationView> {
		if (tail === undefined || entry.id > tail) return unresolved;
		if (entry.kind === "agent.thread-notice") return passiveView(entry);
		return isInputKind(entry.kind) ? inputView(entry) : unresolved;
	}
	function taskSenderRecordView(record: EntryRecord, target: CommunicationInputLink, visible: EntryRecord): TaskInputSender | undefined {
		if (!modelLessCompanion(record, visible.conversationId, TASK_SENDER_ENTRY_KIND)) return undefined;
		const captured = parseTaskSenderRecord(record.data);
		return captured !== undefined && targetMatches(captured.target, visible, storageId) && sameSubmission(captured.target, target) ? captured.sender : undefined;
	}
	async function taskSender(entry: EntryRecord): Promise<TaskInputSender | undefined> {
		if (!isInputKind(entry.kind) || tail === undefined || entry.id > tail) return undefined;
		const index = await harness.snapshot(CommunicationIndexDoc, communicationIndexKey(storageId, entry.conversationId, String(entry.id)), context);
		const target = parseCommunicationLink(index?.target);
		const recordId = index?.taskSenderEntryId === undefined ? undefined : communicationNativeEntryId(index.taskSenderEntryId);
		if (target?.mode !== "input" || !targetMatches(target, entry, storageId) || recordId === undefined) return undefined;
		const visible = await exact(entry.id);
		if (visible === undefined || !await nativeTargetMatches(target, visible)) return undefined;
		const record = await exact(recordId);
		return record === undefined ? undefined : taskSenderRecordView(record, target, visible);
	}
	return {
		tail,
		async taskSenders(entries) {
			const values: [string, TaskInputSender][] = [];
			for (const entry of entries.slice(0, TASK_SENDER_PAGE_ENTRIES)) {
				try {
					const sender = await taskSender(entry);
					if (sender !== undefined) values.push([String(entry.id), sender]);
				} catch { /* Missing or invalid hints remain unknown. */ }
			}
			return boundTaskSenders(values);
		},
		async views(entries) {
			const values: CommunicationView[] = [];
			for (let index = 0; index < entries.length; index++) {
				if (index >= COMMUNICATION_PAGE_ENTRIES) { values.push(limited); continue; }
				try { values.push(await resolve(entries[index] as EntryRecord)); }
				catch { values.push(invalid); }
			}
			return boundCommunicationViews(values);
		},
	};
}
