/**
 * Native request-boundary projection of passive thread notices into frozen range markers.
 *
 * Stored entries stay unchanged. A notice becomes a source only through its stored entry: the
 * entry kind, its one complete model message, and its typed passive data. Message text is never
 * classified. A notice that the bounded read does not reach, or whose stored message is not
 * unique in the request, stays in the request as its own unchanged message.
 */
import type { Context } from "@earendil-works/chord/context";
import type { JsonValue } from "@earendil-works/chord/json";
import type { Message } from "@earendil-works/pi-ai";
import type { ConversationId, EntryId, EntryRecord, GenerationHooks, HookApi } from "@earendil-works/pi-durable";
import { associateThreadNotices, projectThreadNotices, type ThreadNoticeSource, type ThreadRangeSnapshot } from "./thread-notice-projection.ts";

export const THREAD_NOTICE_ENTRY_KIND = "agent.thread-notice";
/** Bounds of one history read at a request boundary. */
export const THREAD_NOTICE_READ_RECORDS = 128;
export const THREAD_NOTICE_READ_BYTES = 256 * 1024;
const READ_PAGE = 32;
/** One association pass accepts this many sources. */
const SOURCE_LIMIT = 128;
const RANGE_MEMO = "agent:thread-ranges";
const RANGE_MEMO_BYTES = 32 * 1024;

export interface ThreadNoticeScope {
	readonly storageId: string;
	/** Canonical external identity of one conversation, the actual recipient of its notices. */
	identity(conversationId: ConversationId): string;
}

interface RetainedSource {
	readonly entryId: number;
	readonly source: ThreadNoticeSource<Message>;
}
interface ConversationState {
	/** Newest entry that a read examined. */
	through: number;
	/** Boundary that precedes the next unread entry; undefined after a read that left a gap. */
	boundary: string | undefined;
	/** False when the newest read left entries unexamined or a source left at the association bound; a range frozen then states partial coverage. */
	complete: boolean;
	sources: RetainedSource[];
	snapshots: ThreadRangeSnapshot[];
}

function hasAssistant(entry: EntryRecord): boolean {
	return entry.model?.some((message) => message.role === "assistant") === true;
}

/** Newest entries first, down to the last examined entry, the record bound, or the byte bound. */
async function unreadEntries(api: HookApi, after: number | undefined, context: Context): Promise<{ entries: EntryRecord[]; exhausted: boolean }> {
	const entries: EntryRecord[] = [];
	let bytes = 0;
	let cursor: Parameters<HookApi["entries"]>[2];
	for (;;) {
		const page = await api.entries({ order: "descending", ...(after === undefined ? {} : { minEntryId: (after + 1) as EntryId }) }, Math.min(READ_PAGE, THREAD_NOTICE_READ_RECORDS - entries.length), cursor, context);
		for (const entry of page.items) {
			bytes += Buffer.byteLength(JSON.stringify(entry));
			if (bytes > THREAD_NOTICE_READ_BYTES) return { entries, exhausted: false };
			entries.push(entry);
		}
		if (page.next === undefined) return { entries, exhausted: true };
		if (entries.length >= THREAD_NOTICE_READ_RECORDS) return { entries, exhausted: false };
		cursor = page.next;
	}
}

/** Advance one conversation's state over the entries stored since its last read. */
async function readSources(api: HookApi, state: ConversationState | undefined, recipient: string, context: Context): Promise<ConversationState> {
	const read = await unreadEntries(api, state?.through, context);
	const next: ConversationState = state === undefined
		? { through: 0, boundary: read.exhausted ? "initial" : undefined, complete: read.exhausted, sources: [], snapshots: [] }
		: { ...state, sources: [...state.sources], complete: read.exhausted, ...(read.exhausted ? {} : { boundary: undefined }) };
	for (const entry of read.entries.reverse()) {
		next.through = Math.max(next.through, entry.id);
		if (hasAssistant(entry)) { next.boundary = `assistant:${entry.id}`; continue; }
		if (entry.kind !== THREAD_NOTICE_ENTRY_KIND || entry.model?.length !== 1) continue;
		// A notice without a known preceding boundary cannot join a range.
		if (next.boundary === undefined) continue;
		next.sources.push({ entryId: entry.id, source: { sourceId: `entry:${entry.id}`, recipient, epoch: next.boundary, message: entry.model[0], passive: entry.data } });
	}
	return next;
}

/**
 * A source takes part when its stored message occurs in the request. A source newer than every
 * present one can belong to a later context view, so it stays retained. At the association bound
 * absent sources leave first, then the newest present ones: older ranges are already frozen.
 */
function presentSources(state: ConversationState, messages: readonly Message[]): RetainedSource[] {
	if (state.sources.length === 0) return [];
	const tuples = new Set(messages.map((message) => JSON.stringify(message)));
	const present = new Set(state.sources.filter((item) => tuples.has(JSON.stringify(item.source.message))).map((item) => item.entryId));
	const newestPresent = state.sources.reduce((newest, item) => present.has(item.entryId) ? Math.max(newest, item.entryId) : newest, 0);
	let retained = state.sources.filter((item) => present.has(item.entryId) || item.entryId > newestPresent);
	if (retained.length > SOURCE_LIMIT) {
		const absent = retained.filter((item) => !present.has(item.entryId)).slice(0, retained.length - SOURCE_LIMIT);
		const dropped = new Set(absent.map((item) => item.entryId));
		retained = retained.filter((item) => !dropped.has(item.entryId)).slice(0, SOURCE_LIMIT);
		state.complete = false;
	}
	state.sources = retained;
	return retained.filter((item) => present.has(item.entryId));
}

function marker(original: Message, text: string): Message {
	if (original.role !== "user") return original;
	return { ...original, content: typeof original.content === "string" ? text : [{ type: "text", text }] };
}

function mergeSnapshots(saved: readonly ThreadRangeSnapshot[], retained: readonly ThreadRangeSnapshot[]): ThreadRangeSnapshot[] {
	const covered = new Set(saved.flatMap((snapshot) => snapshot.sources));
	return [...saved, ...retained.filter((snapshot) => !snapshot.sources.some((id) => covered.has(id)))];
}

/** The newest ranges are the ones a later read could regroup, so they keep their place in a bounded memo. */
function memoSnapshots(snapshots: readonly ThreadRangeSnapshot[]): ThreadRangeSnapshot[] {
	const kept: ThreadRangeSnapshot[] = [];
	let bytes = 2;
	for (const snapshot of [...snapshots].reverse()) {
		bytes += Buffer.byteLength(JSON.stringify(snapshot)) + 1;
		if (bytes > RANGE_MEMO_BYTES) break;
		kept.unshift(snapshot);
	}
	return kept;
}

/**
 * Frozen ranges live in the task memo for retries and recovery of one generation, and in process
 * memory while their source messages remain in the request. A failure propagates: Durable reports
 * it against the hook and sends the request with its unchanged messages.
 */
export function threadNoticeRequestHooks(scope: ThreadNoticeScope): Partial<GenerationHooks> {
	const states = new Map<ConversationId, ConversationState>();
	return {
		async beforeRequest(request, api, context) {
			const state = await readSources(api, states.get(api.conversationId), scope.identity(api.conversationId), context);
			states.set(api.conversationId, state);
			const sources = presentSources(state, request.messages);
			if (sources.length === 0) { state.snapshots = []; return undefined; }
			const associations = associateThreadNotices(request.messages, sources.map((item) => item.source), state.complete);
			if (associations.items.length === 0) { state.snapshots = []; return undefined; }
			const saved = await api.memo<JsonValue>(RANGE_MEMO, context) as ThreadRangeSnapshot[] | undefined;
			const projection = projectThreadNotices({
				scope: `${scope.storageId}:${api.conversationId}`,
				messages: request.messages,
				associations,
				snapshots: mergeSnapshots(saved ?? [], state.snapshots),
				marker,
			});
			if (saved === undefined) await api.memo(RANGE_MEMO, memoSnapshots(projection.snapshots) as unknown as JsonValue, context);
			state.snapshots = projection.snapshots;
			return { messages: projection.messages };
		},
	};
}
