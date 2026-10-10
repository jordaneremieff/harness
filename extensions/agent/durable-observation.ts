/**
 * agent/durable-observation: bounded read projections and cold snapshots over a
 * Pi Durable storage.
 *
 * The projections read public Harness and Storage surfaces: conversation entries,
 * documents, submissions, and task inspections. Entry serialization omits
 * provider signatures, image payloads, and redacted thinking with markers and
 * counts, and exposes offsets and cursors for continuation. Nothing here decodes
 * private SQL.
 *
 * `DurableObservation.open()` copies a SQLite file through `node:sqlite`'s
 * backup API and opens the copy without `resume()`, so a live writer keeps sole
 * ownership of the source. The copy is writable: harness bookkeeping stays in
 * the temporary file. Read-only viewers never schedule work.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Context } from "@earendil-works/chord";
import type { Message, Models } from "@earendil-works/pi-ai";
import type { ModelEvidenceCollector } from "./model-evidence.ts";
import { AssistantEntry, Harness, InboxDoc, LiveDoc, UsageDoc, type Conversation, type ConversationId, type ConversationRecord, type Cursor, type EntryId, type EntryRecord, type HarnessOptions, type HarnessInspection, type LiveState, type Storage, type SubmissionId, type SubmissionRecord, type TaskInspection, type UsageState } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import type { AgentConversationEntry, AgentConversationSnapshot, AgentConversationState, AgentConversationSummary, DashboardAutoRetry, DashboardCompactionFailure, DashboardHealth } from "./dashboard-types.ts";
import { AgentDeliveryDoc, AgentMetaDoc, pendingDeliveries, settleDeliveries, undeliveredForOwner, type AgentDeliveryState, type DeliveryReceipt } from "./durable-controls.ts";
import { timerStatusRows } from "./durable-timers.ts";
import { readAwaitFact } from "./await-observation.ts";
import { PROVIDER_BLOCK_ERROR, readProviderBlock, readInputProviderBlock, readInputRecovery, type ProviderBlockFact } from "./provider-block.ts";
import type { AwaitFact } from "./await-facts.ts";

/** Byte/unit bounds used by every projection in this module. */
export const ENTRY_PREVIEW_UNITS = 1200;
export const ENTRY_PAGE_UNITS = 12000;
export const HISTORY_LIMIT_DEFAULT = 12;
export const HISTORY_LIMIT_MAX = 50;
export const SEARCH_MATCH_LIMIT_DEFAULT = 10;
export const SEARCH_MATCH_LIMIT_MAX = 20;
export const SEARCH_SCAN_LIMIT_DEFAULT = 128;
export const ACTIVITY_TURN_LIMIT_DEFAULT = 4;
export const ACTIVITY_TURN_LIMIT_MAX = 12;
/** Entry and byte bounds for one activity scan page set. */
export const ACTIVITY_SCAN_ENTRIES = 200;
export const ACTIVITY_SCAN_BYTES = 64 * 1024;
/** Whole serialized activity digest bound, metadata and coverage included. */
export const ACTIVITY_DIGEST_BYTES = 8_000;
/** Selection margin covering the finalized coverage.bytes digits and flags. */
const ACTIVITY_DIGEST_SELECT_BYTES = ACTIVITY_DIGEST_BYTES - 64;
/** Running-tool row cap applied only when the full metadata does not fit. */
const ACTIVITY_METADATA_TOOL_LIMIT = 16;

export interface EntryOmissions {
	readonly providerSignatures: number;
	readonly imagePayloads: number;
	readonly redactedThinking: number;
}

export type DurableEntrySource = "user" | "assistant" | "toolResult" | "summary" | "custom";

export interface DurableEntryRow {
	readonly id: EntryId;
	readonly format?: "compact";
	readonly kind: string;
	readonly source: DurableEntrySource;
	readonly role?: string;
	readonly preview?: { readonly text: string; readonly truncated: boolean };
	readonly text: string;
	readonly truncated: boolean;
	readonly nextOffset: number | null;
	readonly omissions?: EntryOmissions;
	readonly toolCalls?: readonly { readonly callId?: string; readonly name: string; readonly arguments: string; readonly truncated: boolean }[];
	readonly toolResults?: readonly { readonly callId?: string; readonly name: string; readonly text: string; readonly isError: boolean; readonly truncated: boolean }[];
	readonly omittedParts?: number;
}

export interface DurableInspectParams {
	readonly view?: "activity" | "history" | "branch" | "search" | "exact" | "result";
	readonly conversationId?: ConversationId;
	readonly limit?: number;
	readonly cursor?: Cursor;
	readonly entryId?: EntryId;
	readonly fromId?: EntryId;
	readonly offset?: number;
	readonly query?: string;
	readonly source?: DurableEntrySource;
	readonly submissionId?: SubmissionId;
	readonly operationId?: string;
}

/** Entry kinds a conversation surface never displays. They are not part of the visible transcript. */
const HIDDEN_TRANSCRIPT_KINDS: ReadonlySet<string> = new Set(["pi.system"]);

/** True for an entry kind the transcript surface hides; hidden entries never consume transcript bounds. */
export function isHiddenTranscriptKind(kind: string): boolean {
	return HIDDEN_TRANSCRIPT_KINDS.has(kind);
}

export interface ConversationSummary {
	readonly conversationId: ConversationId;
	readonly identity: string;
	readonly name?: string;
	readonly owner?: string;
	/** First input text, so a manager query can match it without reading entries. */
	readonly firstMessage?: string;
	readonly busy: boolean;
	readonly forkSource?: { readonly conversationId: ConversationId; readonly at: EntryId };
	readonly ownerTaskId?: number;
}

/** Author role of one retained entry's text, when it has one. */
export type DurableTextRole = "user" | "assistant" | "toolResult" | "system";

export interface ConversationStatus extends ConversationSummary {
	readonly awaiting?: AwaitFact;
	readonly providerBlock?: ProviderBlockFact;
	readonly cwd?: string;
	readonly lastText: string | null;
	/** Author role of `lastText`, so a card can label the retained tail accurately. */
	readonly lastTextRole?: DurableTextRole;
	readonly live: unknown;
	readonly inbox: unknown;
	readonly usage: UsageState | undefined;
	readonly agent: {
		readonly model?: { readonly provider: string; readonly modelId: string };
		readonly thinkingLevel: string;
		readonly extensions: readonly string[];
		readonly tools: readonly string[];
		readonly cwd?: string;
		readonly instructions?: string;
	};
	readonly tasks: readonly {
		readonly id: number;
		readonly kind: string;
		readonly status: TaskInspection["state"]["kind"];
		readonly background: boolean;
		readonly owner?: number;
		readonly abortRequested: boolean;
	}[];
	readonly submissions: readonly {
		readonly id: number;
		readonly type: "input" | "write";
		readonly status: SubmissionRecord["status"];
		readonly requestId?: string;
		readonly entryId?: number;
		readonly answerEntryId?: number;
		readonly reason?: string;
	}[];
	/** Bounded pending scheduled inputs for this conversation, nearest deadline first. */
	readonly timers?: readonly {
		readonly id: number;
		readonly target: string;
		readonly deadline: number;
		readonly mode: "followUp" | "steer";
		readonly status: "pending" | "unsettled";
		readonly overdue: boolean;
	}[];
}

const SIGNATURE_MARKER = "[omitted: provider signature]";
const IMAGE_MARKER = "[omitted: image data]";
const REDACTED_MARKER = "[omitted: redacted thinking]";

/** External identity of one conversation in one storage. */
export function durableIdentity(storageId: string, conversationId: ConversationId | undefined): string {
	return conversationId === undefined ? storageId : `${storageId}:${conversationId}`;
}

/** Main database bytes plus the WAL, the logical source size a snapshot copies. */
function snapshotSourceBytes(path: string): number | undefined {
	let total: number;
	try {
		total = statSync(path).size;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
	try {
		total += statSync(`${path}-wal`).size;
	} catch {
		// A missing WAL is an empty WAL.
	}
	return total;
}

/** Readable source category of one entry kind. */
export function entrySource(kind: string): DurableEntrySource {
	switch (kind) {
		case "pi.user":
			return "user";
		case "pi.assistant":
			return "assistant";
		case "pi.tool-result":
			return "toolResult";
		case "pi.compaction":
			return "summary";
		default:
			return "custom";
	}
}

type OmissionCounts = { providerSignatures: number; imagePayloads: number; redactedThinking: number };

function redactPart(part: unknown, omissions: OmissionCounts): unknown {
	if (part === null || typeof part !== "object") return part;
	const candidate = part as Record<string, unknown>;
	switch (candidate.type) {
		case "text": {
			if (typeof candidate.textSignature !== "string") return part;
			omissions.providerSignatures++;
			return { ...candidate, textSignature: SIGNATURE_MARKER };
		}
		case "toolCall": {
			if (typeof candidate.thoughtSignature !== "string") return part;
			omissions.providerSignatures++;
			return { ...candidate, thoughtSignature: SIGNATURE_MARKER };
		}
		case "thinking": {
			let copy: Record<string, unknown> | undefined;
			if (typeof candidate.thinkingSignature === "string") {
				omissions.providerSignatures++;
				copy = { ...candidate, thinkingSignature: SIGNATURE_MARKER };
			}
			if (candidate.redacted === true) {
				omissions.redactedThinking++;
				copy = { ...(copy ?? candidate), thinking: REDACTED_MARKER };
			}
			return copy ?? part;
		}
		case "image": {
			omissions.imagePayloads++;
			return { ...candidate, data: IMAGE_MARKER };
		}
		default:
			return part;
	}
}

function redactContent(content: unknown, omissions: OmissionCounts): unknown {
	if (!Array.isArray(content)) return content;
	return content.map((part) => redactPart(part, omissions));
}

function projectMessages(model: readonly Message[] | undefined, omissions: EntryOmissions): readonly Message[] | undefined {
	if (model === undefined) return undefined;
	return model.map((message) => {
		const content = (message as { readonly content?: unknown }).content;
		const projected = redactContent(content, omissions);
		return projected === content ? message : ({ ...message, content: projected } as Message);
	});
}

/** Redacted JSON serialization of one entry, with omission counts when any apply. */
export function projectEntry(entry: EntryRecord): { readonly value: Record<string, unknown>; readonly text: string; readonly omissions?: EntryOmissions } {
	const omissions: EntryOmissions = { providerSignatures: 0, imagePayloads: 0, redactedThinking: 0 };
	const model = projectMessages(entry.model, omissions);
	const value: Record<string, unknown> = model === entry.model ? { ...entry } : { ...entry, model };
	const any = omissions.providerSignatures + omissions.imagePayloads + omissions.redactedThinking > 0;
	return { value, text: JSON.stringify(value), ...(any ? { omissions } : {}) };
}

function searchablePart(part: unknown): string | undefined {
	if (part === null || typeof part !== "object") return undefined;
	const candidate = part as Record<string, unknown>;
	if (candidate.type === "text" && typeof candidate.text === "string") return candidate.text;
	if (candidate.type === "thinking" && candidate.redacted !== true && typeof candidate.thinking === "string") return candidate.thinking;
	if (candidate.type === "toolCall" && typeof candidate.name === "string") return candidate.name;
	return undefined;
}

function searchableMessage(message: Message): string[] {
	const parts: string[] = [];
	const content = (message as { readonly content?: unknown }).content;
	if (typeof content === "string") parts.push(content);
	else if (Array.isArray(content)) {
		for (const part of content) {
			const text = searchablePart(part);
			if (text !== undefined) parts.push(text);
		}
	}
	if (message.role === "toolResult" && typeof message.toolName === "string") parts.push(message.toolName);
	return parts;
}

/** Literal searchable text: message text, visible thinking, tool names, and kind. Signatures and images stay out. */
export function searchableText(entry: EntryRecord): string {
	const parts: string[] = [entry.kind];
	for (const message of entry.model ?? []) parts.push(...searchableMessage(message));
	return parts.join("\n");
}

/** UTF-16 fragment that keeps surrogate pairs intact and returns the continuation offset. */
export function fragment(text: string, offset: number, maxUnits: number): { readonly text: string; readonly start: number; readonly nextOffset: number | null; readonly truncated: boolean } {
	let start = Math.max(0, Math.min(Number.isFinite(offset) ? Math.trunc(offset) : 0, text.length));
	const first = text.charCodeAt(start);
	const previous = text.charCodeAt(start - 1);
	if (first >= 0xdc00 && first <= 0xdfff && previous >= 0xd800 && previous <= 0xdbff) start -= 1;
	let end = Math.min(text.length, start + Math.max(0, maxUnits));
	if (end < text.length && end > start) {
		const code = text.charCodeAt(end - 1);
		if (code >= 0xd800 && code <= 0xdbff) end -= 1;
	}
	return { text: text.slice(start, end), start, nextOffset: end < text.length ? end : null, truncated: end < text.length };
}

function entryPreview(entry: EntryRecord): { readonly text: string; readonly truncated: boolean } | undefined {
	const text = (entry.model ?? []).map(textOfMessage).join("\n");
	if (text === "") return undefined;
	const cut = fragment(text, 0, ENTRY_PREVIEW_UNITS);
	return { text: cut.text, truncated: cut.truncated };
}

/** Bounded raw entry for the branch view; exact continues the same serialization. */
function rawEntryRow(entry: EntryRecord, maxUnits = ENTRY_PAGE_UNITS): DurableEntryRow {
	const projected = projectEntry(entry);
	const cut = fragment(projected.text, 0, maxUnits);
	const preview = entryPreview(entry);
	return {
		id: entry.id,
		kind: entry.kind,
		source: entrySource(entry.kind),
		...(entry.model?.[0]?.role === undefined ? {} : { role: entry.model[0].role }),
		...(preview === undefined ? {} : { preview }),
		text: cut.text,
		truncated: cut.truncated,
		nextOffset: cut.nextOffset,
		...(projected.omissions === undefined ? {} : { omissions: projected.omissions }),
	};
}

interface CompactEntryParts {
	remaining: number;
	truncated: boolean;
	text: string[];
	thoughts: string[];
	toolCalls: NonNullable<DurableEntryRow["toolCalls"]>[number][];
	toolResults: NonNullable<DurableEntryRow["toolResults"]>[number][];
	omittedParts: number;
}

function compactExcerpt(parts: CompactEntryParts, text: string, limit = parts.remaining): { text: string; truncated: boolean } {
	const budget = Math.min(parts.remaining, limit);
	const cut = fragment(text, 0, budget);
	const marker = cut.truncated && budget >= "[truncated]".length ? "[truncated]" : "";
	const value = cut.truncated ? `${fragment(text, 0, budget - marker.length).text}${marker}` : cut.text;
	parts.remaining = Math.max(0, parts.remaining - value.length);
	parts.truncated ||= cut.truncated;
	return { text: value, truncated: cut.truncated };
}

function compactName(parts: CompactEntryParts, name: string): string {
	const cut = fragment(name, 0, 128);
	parts.truncated ||= cut.truncated;
	return cut.truncated ? `${fragment(name, 0, 116).text}[truncated]` : name;
}

function compactCall(parts: CompactEntryParts, part: Record<string, unknown>): void {
	if (parts.toolCalls.length >= 8) { parts.omittedParts++; return; }
	const name = String(part.name);
	const cut = compactExcerpt(parts, JSON.stringify(part.arguments), 240);
	parts.toolCalls.push({
		...(typeof part.id === "string" ? { callId: compactName(parts, part.id) } : {}),
		name: compactName(parts, name), arguments: cut.text, truncated: cut.truncated || name.length > 128,
	});
}

function compactPart(parts: CompactEntryParts, value: unknown): void {
	if (value === null || typeof value !== "object") return;
	const part = value as Record<string, unknown>;
	switch (part.type) {
		case "text": if (typeof part.text === "string") parts.text.push(part.text); break;
		case "thinking": if (typeof part.thinking === "string") parts.thoughts.push(`Thinking: ${part.thinking}`); break;
		case "image": parts.text.push(IMAGE_MARKER); break;
		case "toolCall": compactCall(parts, part); break;
		default: parts.omittedParts++;
	}
}

function compactMessage(parts: CompactEntryParts, message: Message): void {
	if (message.role === "toolResult") {
		if (parts.toolResults.length >= 8) { parts.omittedParts++; return; }
		const cut = compactExcerpt(parts, textOfMessage(message));
		parts.toolResults.push({
			...(typeof message.toolCallId === "string" ? { callId: compactName(parts, message.toolCallId) } : {}),
			name: compactName(parts, message.toolName), text: cut.text, isError: message.isError,
			truncated: cut.truncated || message.toolName.length > 128,
		});
		return;
	}
	const content = (message as { content?: unknown }).content;
	if (typeof content === "string") parts.text.push(content);
	else if (Array.isArray(content)) for (const part of content) compactPart(parts, part);
	if (message.role === "assistant" && message.errorMessage) parts.text.push(`Error: ${message.errorMessage}`);
}

/** Readable entry digest. Exact entry reads retain the redacted source JSON. */
export function entryRow(entry: EntryRecord, maxUnits = ENTRY_PREVIEW_UNITS): DurableEntryRow {
	const omissions: EntryOmissions = { providerSignatures: 0, imagePayloads: 0, redactedThinking: 0 };
	const messages = projectMessages(entry.model, omissions) ?? [];
	const units = Math.max(32, Math.min(maxUnits, ENTRY_PREVIEW_UNITS));
	const reservedText = Math.min(Math.floor(units / 2), messages.filter((message) => message.role !== "toolResult").map(textOfMessage).join("\n").length);
	const parts: CompactEntryParts = { remaining: units - reservedText, truncated: false, text: [], thoughts: [], toolCalls: [], toolResults: [], omittedParts: 0 };
	for (const message of messages) compactMessage(parts, message);
	if (messages.length === 0 && entry.data !== undefined) parts.text.push(JSON.stringify(entry.data));
	parts.remaining += reservedText;
	const readable = compactExcerpt(parts, [...parts.text, ...parts.thoughts].join("\n"));
	const anyOmissions = omissions.providerSignatures + omissions.imagePayloads + omissions.redactedThinking > 0;
	return {
		id: entry.id, format: "compact", kind: entry.kind, source: entrySource(entry.kind),
		...(entry.model?.[0]?.role === undefined ? {} : { role: entry.model[0].role }),
		text: readable.text, truncated: parts.truncated || parts.omittedParts > 0, nextOffset: null,
		...(parts.toolCalls.length === 0 ? {} : { toolCalls: parts.toolCalls }),
		...(parts.toolResults.length === 0 ? {} : { toolResults: parts.toolResults }),
		...(parts.omittedParts === 0 ? {} : { omittedParts: parts.omittedParts }),
		...(anyOmissions ? { omissions } : {}),
	};
}

function messageTextOf(entry: EntryRecord | undefined): string | null {
	if (!entry) return null;
	const text = (entry.model ?? []).map(textOfMessage).join("\n");
	const cut = fragment(text, 0, ENTRY_PREVIEW_UNITS);
	return cut.text;
}

/** Author role of one entry's retained text: the first model message's role, else its kind. */
function textRoleOf(entry: EntryRecord | undefined): DurableTextRole | undefined {
	if (!entry) return undefined;
	const role = entry.model?.[0]?.role;
	if (role === "user" || role === "assistant" || role === "toolResult" || role === "system") return role;
	switch (entry.kind) {
		case "pi.user":
			return "user";
		case "pi.assistant":
			return "assistant";
		case "pi.tool-result":
			return "toolResult";
		case "pi.system":
			return "system";
		default:
			return undefined;
	}
}

function boundedLimit(value: number | undefined, fallback: number, max: number): number {
	if (value === undefined) return fallback;
	if (!Number.isInteger(value) || value < 1) throw new RangeError(`limit must be a positive integer, received ${String(value)}`);
	return Math.min(value, max);
}

export type RequestParams = Record<string, unknown>;

/** Shared request parsing for the live host and the cold observation. Every consumer uses these. */
export function requestString(params: RequestParams | undefined, key: string): string | undefined {
	const value = params?.[key];
	if (value === undefined) return undefined;
	if (typeof value !== "string") throw new TypeError(`${key} must be a string`);
	return value;
}

export function requestRequiredString(params: RequestParams | undefined, key: string): string {
	const value = requestString(params, key);
	if (value === undefined || value === "") throw new TypeError(`${key} is required`);
	return value;
}

export function requestBoolean(params: RequestParams | undefined, key: string): boolean | undefined {
	const value = params?.[key];
	if (value === undefined) return undefined;
	if (typeof value !== "boolean") throw new TypeError(`${key} must be a boolean`);
	return value;
}

export function requestInteger(params: RequestParams | undefined, key: string): number | undefined {
	const value = params?.[key];
	if (value === undefined) return undefined;
	if (typeof value === "number" && Number.isSafeInteger(value)) return value;
	if (typeof value === "string" && /^-?[0-9]+$/.test(value)) {
		const parsed = Number(value);
		if (Number.isSafeInteger(parsed)) return parsed;
	}
	throw new TypeError(`${key} must be an integer`);
}

/** Positive safe integer from a raw value, such as an array member. */
export function requestPositiveId(value: unknown, key: string): number | undefined {
	if (value === undefined) return undefined;
	if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return value;
	if (typeof value === "string" && /^[0-9]+$/.test(value)) {
		const parsed = Number(value);
		if (Number.isSafeInteger(parsed) && parsed > 0) return parsed;
	}
	throw new TypeError(`${key} must be a positive integer`);
}

/** A positive safe integer that must be present. */
export function requestRequiredId(value: unknown, key: string): number {
	const id = requestPositiveId(value, key);
	if (id === undefined) throw new TypeError(`${key} is required`);
	return id;
}

/** Spread one optional parameter under its key only when present. */
export function optionalParam<K extends string, V>(key: K, value: V | undefined): { [P in K]?: V } {
	return value === undefined ? {} : ({ [key]: value } as { [P in K]: V });
}

/** Resolve one conversation target by external identity or native ID; default root. */
export function resolveSessionConversationId(storageId: string, sessionId: string | undefined, conversationId: number | undefined): ConversationId {
	if (sessionId !== undefined && conversationId !== undefined) throw new TypeError("pass sessionId or conversationId, not both");
	if (conversationId !== undefined) return conversationId as ConversationId;
	if (sessionId === undefined || sessionId === storageId) return 1 as ConversationId;
	const prefix = `${storageId}:`;
	if (sessionId.startsWith(prefix)) {
		const rest = sessionId.slice(prefix.length);
		if (/^[0-9]+$/.test(rest)) {
			const parsed = Number(rest);
			if (Number.isSafeInteger(parsed) && parsed > 0) return parsed as ConversationId;
		}
	}
	throw new Error(`session ${sessionId} does not belong to storage ${storageId}`);
}

/** Parse one inspection request into its native parameters. */
export function parseInspectParams(params: RequestParams | undefined): DurableInspectParams {
	const view = requestString(params, "view");
	const source = requestString(params, "source");
	const cursor = params?.cursor;
	if (cursor !== undefined && (typeof cursor !== "object" || cursor === null || Array.isArray(cursor))) throw new TypeError("cursor must be an object");
	return {
		...optionalParam("view", view as DurableInspectParams["view"] | undefined),
		...optionalParam("limit", requestInteger(params, "limit")),
		...optionalParam("cursor", cursor as Cursor | undefined),
		...optionalParam("entryId", requestPositiveId(params?.entryId, "entryId") as EntryId | undefined),
		...optionalParam("fromId", requestPositiveId(params?.fromId, "fromId") as EntryId | undefined),
		...optionalParam("offset", requestInteger(params, "offset")),
		...optionalParam("query", requestString(params, "query")),
		...optionalParam("source", source as DurableInspectParams["source"] | undefined),
		...optionalParam("submissionId", requestPositiveId(params?.submissionId, "submissionId") as SubmissionId | undefined),
		...optionalParam("operationId", requestString(params, "operationId")),
	};
}

function parseEntryId(value: unknown): EntryId | undefined {
	if (value === undefined) return undefined;
	if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return value as EntryId;
	if (typeof value === "string" && /^[0-9]+$/.test(value)) {
		const parsed = Number(value);
		if (Number.isSafeInteger(parsed) && parsed > 0) return parsed as EntryId;
	}
	throw new TypeError(`entry ID must be a positive integer, received ${String(value)}`);
}

async function metaOf(harness: Harness, conversationId: ConversationId, context: Context): Promise<{ readonly name: string | undefined; readonly owner: string | undefined; readonly firstMessage: string | undefined; readonly updatedAt: number | undefined }> {
	const meta = await harness.snapshot(AgentMetaDoc, conversationId, context);
	return { name: meta?.name ?? undefined, owner: meta?.owner ?? undefined, firstMessage: meta?.firstMessage ?? undefined, updatedAt: meta?.updatedAt ?? undefined };
}

async function conversationSummary(harness: Harness, storageId: string, record: ConversationRecord, context: Context): Promise<ConversationSummary> {
	const meta = await metaOf(harness, record.id, context);
	const live = await harness.snapshot(LiveDoc, record.id, context);
	return {
		conversationId: record.id,
		identity: durableIdentity(storageId, record.id === 1 ? undefined : record.id),
		...(meta.name === undefined ? {} : { name: meta.name }),
		...(meta.owner === undefined ? {} : { owner: meta.owner }),
		...(meta.firstMessage === undefined ? {} : { firstMessage: meta.firstMessage }),
		busy: live?.run !== undefined,
		...(record.parent === undefined ? {} : { forkSource: { conversationId: record.parent.conversationId, at: record.parent.at } }),
		...(record.owner === undefined ? {} : { ownerTaskId: record.owner.taskId }),
	};
}

export interface DurableListParams {
	readonly limit?: number;
	readonly cursor?: Cursor;
	readonly ownerConversationId?: ConversationId;
	readonly ownerTaskId?: number;
}

export async function readConversationList(harness: Harness, storageId: string, params: DurableListParams, context: Context): Promise<{ readonly items: readonly ConversationSummary[]; readonly next: Cursor | null }> {
	const limit = boundedLimit(params.limit, 20, 50);
	const page = await harness.commit(
		(tx) =>
			tx.scanConversations(
				{
					...(params.ownerConversationId === undefined ? {} : { ownerConversationId: params.ownerConversationId }),
					...(params.ownerTaskId === undefined ? {} : { ownerTaskId: params.ownerTaskId as never }),
				},
				limit,
				params.cursor,
			),
		context,
	);
	const items: ConversationSummary[] = [];
	for (const record of page.items) items.push(await conversationSummary(harness, storageId, record, context));
	return { items, next: page.next ?? null };
}

function trimTask(task: TaskInspection): ConversationStatus["tasks"][number] {
	return {
		id: task.record.id,
		kind: task.record.kind,
		status: task.state.kind,
		background: task.record.background,
		...(task.record.owner === undefined ? {} : { owner: task.record.owner }),
		abortRequested: task.record.abortRequested,
	};
}

function trimSubmission(submission: SubmissionRecord): ConversationStatus["submissions"][number] {
	const base = {
		id: submission.id,
		type: submission.type,
		status: submission.status,
		...(submission.requestId === undefined ? {} : { requestId: submission.requestId }),
	};
	if (submission.status === "done") {
		return { ...base, entryId: submission.entry, ...(submission.type === "input" ? { answerEntryId: submission.answer } : {}) };
	}
	if (submission.status === "placed") return { ...base, entryId: submission.entry };
	if (submission.status === "unanswered") return { ...base, ...(submission.entry === undefined ? {} : { entryId: submission.entry }), reason: submission.reason };
	return base;
}

export interface DurableStatusOptions {
	readonly cwd?: string;
}

/** Provider parsing buffers are not part of the public AssistantMessage contract. */
function publicContentPart(part: NonNullable<NonNullable<LiveState["generation"]>["message"]>["content"][number]) {
	if (part.type === "text") return {
		type: part.type, text: part.text,
		...(part.textSignature === undefined ? {} : { textSignature: part.textSignature }),
	};
	if (part.type === "thinking") return {
		type: part.type, thinking: part.thinking,
		...(part.thinkingSignature === undefined ? {} : { thinkingSignature: part.thinkingSignature }),
		...(part.redacted === undefined ? {} : { redacted: part.redacted }),
	};
	return {
		type: part.type, id: part.id, name: part.name, arguments: part.arguments,
		...(part.thoughtSignature === undefined ? {} : { thoughtSignature: part.thoughtSignature }),
		...(part.namespace === undefined ? {} : { namespace: part.namespace }),
	};
}

export function publicLiveState(live: LiveState | undefined): LiveState | null {
	const generation = live?.generation;
	const message = generation?.message;
	if (!message || !generation) return live ?? null;
	return { ...live, generation: { ...generation, message: { ...message, content: message.content.map(publicContentPart) } } };
}

export async function readConversationStatus(
	harness: Harness,
	storageId: string,
	conversationId: ConversationId,
	options: DurableStatusOptions,
	context: Context,
): Promise<ConversationStatus | undefined> {
	const record = await harness.commit((tx) => tx.conversation(conversationId), context);
	if (!record) return undefined;
	const summary = await conversationSummary(harness, storageId, record, context);
	const conversation = await harness.conversation(conversationId, context);
	if (!conversation) return undefined;
	const [live, inbox, usage, agent, newest, inspection] = await Promise.all([
		// The newest entry supplies the retained tail text and its author role.
		harness.snapshot(LiveDoc, conversationId, context),
		harness.snapshot(InboxDoc, conversationId, context),
		harness.snapshot(UsageDoc, conversationId, context),
		conversation.agent(context),
		conversation.entries({}, 1, undefined, context),
		harness.inspect(context),
	]);
	const liveTaskIds = new Set(inspection.tasks.map((task) => Number(task.record.id)));
	const awaiting = await harness.commit((tx) => readAwaitFact(tx, storageId, conversationId), context);
	const providerBlock = await harness.commit((tx) => readProviderBlock(tx, conversationId), context);
	return {
		...(providerBlock === undefined ? {} : { providerBlock }),
		...(awaiting === undefined ? {} : { awaiting }),
		...summary,
		cwd: agent.cwd ?? options.cwd,
		lastText: messageTextOf(newest.items[0]),
		...(textRoleOf(newest.items[0]) === undefined ? {} : { lastTextRole: textRoleOf(newest.items[0]) }),
		live: publicLiveState(live),
		inbox: inbox ?? null,
		usage,
		agent: {
			...(agent.model === undefined ? {} : { model: { provider: agent.model.provider, modelId: agent.model.modelId } }),
			thinkingLevel: agent.thinkingLevel,
			extensions: agent.extensions.map((extension) => extension.name),
			tools: agent.tools.map((tool) => tool.name),
			...(agent.cwd === undefined ? {} : { cwd: agent.cwd }),
			...(agent.instructions === undefined ? {} : { instructions: agent.instructions }),
		},
		tasks: inspection.tasks.filter((task) => task.record.conversationId === conversationId).map(trimTask),
		submissions: inspection.submissions.filter((submission) => submission.conversationId === conversationId).map(trimSubmission),
		timers: await timerStatusRows(harness, conversationId, context, liveTaskIds),
	};
}

export async function readUsage(harness: Harness, context: Context): Promise<UsageState> {
	return harness.usage(context);
}

/** Bounds of one dashboard snapshot. */
export const SNAPSHOT_ENTRY_LIMIT = 200;
export const SNAPSHOT_BYTE_LIMIT = 64 * 1024;
/** Largest byte bound one caller may request for a transcript page. */
export const SNAPSHOT_BYTE_LIMIT_MAX = 1024 * 1024;

/** One bounded active transcript, oldest first; the page variant adds continuation. */
export async function readConversationSnapshot(harness: Harness, conversationId: ConversationId, context: Context): Promise<AgentConversationSnapshot> {
	return readConversationSnapshotPage(harness, conversationId, {}, context);
}

/**
 * Active entries without deriving model context. The view mount already holds
 * them; disposing the state keeps the last immutable revision readable.
 */
async function activeEntries(conversation: Conversation, context: Context): Promise<readonly EntryRecord[]> {
	const state = await conversation.viewState(context);
	try {
		return state.value.entries;
	} finally {
		state.dispose();
	}
}

function textOfMessage(message: Message): string {
	const content = (message as { readonly content?: unknown }).content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.flatMap((part) => (part !== null && typeof part === "object" && (part as { type?: unknown }).type === "text" && typeof (part as { text?: unknown }).text === "string" ? [(part as { text: string }).text] : []))
		.join("");
}

function assistantText(entry: EntryRecord | undefined): string | undefined {
	if (entry?.kind !== "pi.assistant") return undefined;
	const text = (entry.model ?? []).map(textOfMessage).join("");
	return text === "" ? undefined : text;
}

function countToolCalls(entries: readonly EntryRecord[]): number {
	let count = 0;
	for (const entry of entries) {
		for (const message of entry.model ?? []) {
			const content = message.content;
			if (!Array.isArray(content)) continue;
			for (const part of content) if (part.type === "toolCall") count++;
		}
	}
	return count;
}

function usageCost(usage: UsageState | undefined): { readonly cost: number; readonly partial: boolean } {
	if (usage === undefined) return { cost: 0, partial: true };
	let cost = 0;
	for (const bucket of [usage.models, usage.tools]) {
		for (const item of Object.values(bucket)) cost += item.cost.total;
	}
	return { cost, partial: false };
}

function newestTimestamp(entry: EntryRecord | undefined): number | undefined {
	if (!entry) return undefined;
	for (let index = (entry.model?.length ?? 0) - 1; index >= 0; index--) {
		const timestamp = (entry.model?.[index] as { readonly timestamp?: unknown } | undefined)?.timestamp;
		if (typeof timestamp === "number" && Number.isFinite(timestamp)) return timestamp;
	}
	return undefined;
}

/** A newer input without a delivery owner still supersedes an older owned outcome. */
function currentReceipt(delivery: AgentDeliveryState | undefined, conversationId: ConversationId, entries: readonly EntryRecord[]): DeliveryReceipt | undefined {
	if (!delivery) return undefined;
	let latest: DeliveryReceipt | undefined;
	for (const receipt of Object.values(delivery.receipts)) {
		if (receipt.conversationId !== conversationId) continue;
		if (latest === undefined || receipt.submissionId > latest.submissionId) latest = receipt;
	}
	const newestInput = [...entries].reverse().find((entry) => entry.kind === "pi.user");
	if (latest && newestInput && (latest.entryId === null || latest.entryId < newestInput.id)) return undefined;
	return latest;
}

function dashboardState(busy: boolean, entries: readonly EntryRecord[], receipt: DeliveryReceipt | undefined): AgentConversationState {
	if (busy) return "working";
	if (entries.length === 0) return "new";
	if (receipt?.status === "done") return "done";
	if (receipt?.status === "unanswered") return receipt.reason === "aborted" ? "stopped" : "failed";
	const newest = entries[entries.length - 1];
	if (newest?.kind === "pi.assistant") {
		if (newest.model?.some((message) => message.role === "assistant" && message.stopReason === "aborted")) return "stopped";
		if (newest.model?.some((message) => message.role === "assistant" && message.stopReason === "error")) return "failed";
		return "done";
	}
	if (newest?.kind === "pi.tool-result") return "interrupted";
	return "idle";
}

export interface DurableDashboardParams {
	readonly conversationId?: ConversationId;
}

export interface DurableDashboardOptions {
	/** Public record reads from the live source or the owned cold snapshot; never a wire field. */
	readonly storage?: Pick<Storage, "scanSubmissions">;
	/** In-process publication collector; never part of a host request or row. */
	readonly modelEvidence?: ModelEvidenceCollector;
	/** Working directory used when a conversation records none. */
	readonly cwd?: string;
	/** Writer ownership of this storage, as the dashboard reports it. */
	readonly owner?: "here" | "unavailable" | "unknown";
	/** Owner detail for refusal guidance, such as a live writer-claim label. */
	readonly ownerLabel?: string;
	/** Live writer: include recovery health, current tool, and turn duration. */
	readonly live?: boolean;
	/** Resolved generation retry ceiling for `autoRetry.maxAttempts`. */
	readonly retryMaxAttempts?: number;
	/** Clock override for tests. */
	readonly now?: number;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Blocked tasks of one conversation, as `harness.inspect()` reports them. */
function blockedTasks(inspection: HarnessInspection, conversationId: ConversationId): Array<{ readonly error?: string; readonly reason: string }> {
	const result: Array<{ error?: string; reason: string }> = [];
	for (const task of inspection.tasks) {
		if (task.record.conversationId !== conversationId || task.state.kind !== "blocked") continue;
		const state = task.state;
		result.push({ ...(state.error === undefined ? {} : { error: errorMessage(state.error) }), reason: state.reason });
	}
	return result;
}

/**
 * Recovery health from committed live state and blocked tasks: a scheduled
 * provider retry, a compaction waiting to retry, and the latest blocked task.
 * Absent when nothing is failing, and never computed for a cold snapshot.
 */
export function dashboardHealth(live: LiveState | undefined, blocked: readonly { readonly error?: string; readonly reason: string }[], now: number, retryMaxAttempts: number | undefined): DashboardHealth | undefined {
	const failing = live?.compactions?.find((status) => status.retry !== undefined);
	const compactionFailure: DashboardCompactionFailure | undefined = failing?.retry === undefined ? undefined : { reason: failing.reason, errorMessage: failing.retry.error, at: new Date(failing.retry.at).toISOString() };
	const retry = live?.generation?.retry;
	const autoRetry: DashboardAutoRetry | undefined = retry === undefined || retryMaxAttempts === undefined ? undefined : { attempt: live?.generation?.attempt ?? 1, maxAttempts: retryMaxAttempts, delayMs: Math.max(0, retry.at - now), errorMessage: retry.error };
	const lastError = blocked.find((task) => task.error !== undefined)?.error ?? blocked[0]?.reason;
	if (lastError === undefined && compactionFailure === undefined && autoRetry === undefined) return undefined;
	return { ...(lastError === undefined ? {} : { lastError }), ...(compactionFailure === undefined ? {} : { compactionFailure }), ...(autoRetry === undefined ? {} : { autoRetry }) };
}

function isToolCallPart(part: unknown, callId: string): part is { readonly arguments: Record<string, unknown> } {
	if (part === null || typeof part !== "object") return false;
	const candidate = part as { readonly type?: unknown; readonly id?: unknown; readonly arguments?: unknown };
	return candidate.type === "toolCall" && candidate.id === callId && candidate.arguments !== undefined && typeof candidate.arguments === "object" && candidate.arguments !== null;
}

/** Arguments of one tool call committed in the active transcript. */
function committedToolCallArguments(entries: readonly EntryRecord[], callId: string): Record<string, unknown> | undefined {
	for (const entry of entries) {
		for (const message of entry.model ?? []) {
			const content = (message as { readonly content?: unknown }).content;
			if (!Array.isArray(content)) continue;
			const found = content.find((part) => isToolCallPart(part, callId));
			if (found !== undefined && isToolCallPart(found, callId)) return found.arguments;
		}
	}
	return undefined;
}

/** Arguments of one tool call, from the live partial first and then committed entries. */
function toolCallArguments(live: LiveState | undefined, entries: readonly EntryRecord[], callId: string): Record<string, unknown> | undefined {
	for (const part of live?.generation?.message?.content ?? []) {
		if (part.type === "toolCall" && part.id === callId) return part.arguments as Record<string, unknown>;
	}
	return committedToolCallArguments(entries, callId);
}

/** First unresolved tool call of the live round, with its committed argument text. */
function currentTool(live: LiveState | undefined, entries: readonly EntryRecord[]): { readonly name: string; readonly argument: string } | undefined {
	const slot = live?.tools?.find((tool) => tool.status !== "done");
	if (slot === undefined) return undefined;
	const args = toolCallArguments(live, entries, slot.callId);
	if (args === undefined) return undefined;
	const argument = JSON.stringify(args);
	return { name: slot.name, argument: argument.length > 200 ? argument.slice(0, 200) : argument };
}

/** Observed span of the latest user turn: the live clock while working, the final message time when settled. */
function turnDuration(entries: readonly EntryRecord[], busy: boolean, now: number): number | undefined {
	let started: number | undefined;
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry?.kind !== "pi.user") continue;
		started = newestTimestamp(entry);
		break;
	}
	if (started === undefined) return undefined;
	const end = busy ? now : newestTimestamp(entries[entries.length - 1]);
	if (end === undefined) return undefined;
	const span = end - started;
	return span >= 0 ? span : undefined;
}

function firstMessageOf(meta: { readonly firstMessage: string | undefined }, entries: readonly EntryRecord[]): string | undefined {
	if (meta.firstMessage !== undefined) return meta.firstMessage;
	const firstUser = entries.find((entry) => entry.kind === "pi.user");
	if (firstUser === undefined) return undefined;
	return messageTextOf(firstUser) ?? undefined;
}

function latestReplyOf(entries: readonly EntryRecord[]): string | undefined {
	for (let index = entries.length - 1; index >= 0; index--) {
		const text = assistantText(entries[index]);
		if (text !== undefined) return text;
	}
	return undefined;
}

async function terminalError(harness: Harness, receipt: DeliveryReceipt | undefined, entries: readonly EntryRecord[], context: Context): Promise<string | undefined> {
	if (receipt) {
		const submission = await harness.submission(receipt.submissionId, context);
		const status = await submission?.status(context);
		if (status?.type === "input" && status.status === "unanswered" && typeof status.detail === "string" && status.detail.trim()) return status.detail;
	}
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry.kind === "pi.user") break;
		for (const message of [...(entry.model ?? [])].reverse()) {
			if (message.role !== "assistant") continue;
			return message.errorMessage || undefined;
		}
	}
	return receipt?.reason ?? undefined;
}

/** Exact terminal input lookup is bounded; absence and scan exhaustion remain distinct. */
async function dashboardInput(storage: Pick<Storage, "scanSubmissions"> | undefined, conversationId: ConversationId, entryId: EntryId | undefined, context: Context): Promise<{ submissionId?: SubmissionId; limited: boolean }> {
	if (storage === undefined || entryId === undefined) return { limited: false };
	let cursor: Cursor | undefined;
	for (let page = 0; page < 64; page++) {
		const records = await storage.scanSubmissions({ conversationId, status: "unanswered" }, 64, cursor, context);
		const input = records.items.find((record) => record.type === "input" && record.entry === entryId && record.reason === "model_error");
		if (input !== undefined) return { submissionId: input.id, limited: false };
		if (records.next === undefined) return { limited: false };
		cursor = records.next;
	}
	return { limited: true };
}

/** Native quota text is classification-safe; the display cause belongs to the exact failed input, even after recovery. */
async function dashboardError(harness: Harness, conversationId: ConversationId, state: AgentConversationState, receipt: DeliveryReceipt | undefined, entries: readonly EntryRecord[], storage: Pick<Storage, "scanSubmissions"> | undefined, context: Context): Promise<string | undefined> {
	if (state !== "failed" && state !== "stopped") return undefined;
	const error = await terminalError(harness, receipt, entries, context);
	if (state !== "failed" || error !== PROVIDER_BLOCK_ERROR) return error;
	const input = receipt === undefined ? await dashboardInput(storage, conversationId, [...entries].reverse().find((entry) => entry.kind === "pi.user")?.id, context) : { submissionId: receipt.submissionId, limited: false };
	const block = input.submissionId === undefined ? undefined : await harness.commit((tx) => readInputProviderBlock(tx, input.submissionId as SubmissionId), context);
	if (block === undefined) return `${error}\n[provider evidence ${input.limited ? "lookup limited" : "unavailable"}]`;
	return `${block.error}${block.errorRedacted ? "\n[provider error redacted]" : ""}${block.errorTruncated ? "\n[provider error truncated]" : ""}`;
}

/** Live-only dashboard fields: recovery health, current tool, and turn duration. */
async function dashboardLiveExtras(
	harness: Harness,
	record: ConversationRecord,
	live: LiveState | undefined,
	entries: readonly EntryRecord[],
	options: DurableDashboardOptions,
	context: Context,
): Promise<Partial<Pick<AgentConversationSummary, "health" | "currentTool" | "durationMs">>> {
	if (options.live !== true) return {};
	const now = options.now ?? Date.now();
	const health = dashboardHealth(live, blockedTasks(await harness.inspect(context), record.id), now, options.retryMaxAttempts);
	const tool = currentTool(live, entries);
	const duration = turnDuration(entries, live?.run !== undefined, now);
	return { ...(health === undefined ? {} : { health }), ...(tool === undefined ? {} : { currentTool: tool }), ...(duration === undefined ? {} : { durationMs: duration }) };
}

async function dashboardSummary(
	harness: Harness,
	storageId: string,
	record: ConversationRecord,
	delivery: AgentDeliveryState | undefined,
	options: DurableDashboardOptions,
	context: Context,
): Promise<AgentConversationSummary> {
	const [meta, live, usage, conversation] = await Promise.all([
		metaOf(harness, record.id, context),
		harness.snapshot(LiveDoc, record.id, context),
		harness.snapshot(UsageDoc, record.id, context),
		harness.conversation(record.id, context),
	]);
	const agent = conversation ? await conversation.agent(context) : undefined;
	const entries = conversation ? await activeEntries(conversation, context) : [];
	const receipt = currentReceipt(delivery, record.id, entries);
	const state = dashboardState(live?.run !== undefined, entries, receipt);
	const cost = usageCost(usage);
	const firstMessage = firstMessageOf(meta, entries);
	const replyText = latestReplyOf(entries);
	const liveExtras = await dashboardLiveExtras(harness, record, live, entries, options, context);
	const error = await dashboardError(harness, record.id, state, receipt, entries, options.storage, context);
	const awaiting = await harness.commit((tx) => readAwaitFact(tx, storageId, record.id), context);
	const row: AgentConversationSummary = {
		id: durableIdentity(storageId, record.id === 1 ? undefined : record.id),
		storageId,
		...(meta.name === undefined ? {} : { name: meta.name }),
		...(firstMessage === undefined ? {} : { firstMessage }),
		cwd: agent?.cwd ?? options.cwd ?? "",
		...(agent?.model === undefined ? {} : { model: { provider: agent.model.provider, modelId: agent.model.modelId, thinkingLevel: agent.thinkingLevel } }),
		modifiedAt: newestTimestamp(entries[entries.length - 1]) ?? meta.updatedAt ?? 0,
		owner: options.owner ?? "unavailable",
		...(options.ownerLabel === undefined ? {} : { ownerLabel: options.ownerLabel }),
		state,
		cost: cost.cost,
		partial: cost.partial,
		...(replyText === undefined ? {} : { latestReply: replyText }),
		...(error === undefined ? {} : { error }),
		...liveExtras,
		...(awaiting === undefined ? {} : { awaiting }),
		toolCalls: countToolCalls(entries),
	};
	options.modelEvidence?.observe(record.id, row, usage, entries);
	return row;
}

/** Dashboard roster for this storage: the root, native forks, and child conversations. */
export async function readDashboard(
	harness: Harness,
	storageId: string,
	params: DurableDashboardParams,
	options: DurableDashboardOptions,
	context: Context,
): Promise<readonly AgentConversationSummary[]> {
	const delivery = await harness.snapshot(AgentDeliveryDoc, context);
	const conversationId = params.conversationId;
	if (conversationId !== undefined) {
		const record = await harness.commit((tx) => tx.conversation(conversationId), context);
		return record === undefined ? [] : [await dashboardSummary(harness, storageId, record, delivery, options, context)];
	}
	const page = await harness.commit((tx) => tx.scanConversations({}, 200, undefined), context);
	if (options.modelEvidence) options.modelEvidence.value.coverage.conversationsComplete = page.next == null;
	const summaries: AgentConversationSummary[] = [];
	for (const record of page.items) summaries.push(await dashboardSummary(harness, storageId, record, delivery, options, context));
	return summaries;
}

export function snapshotEntry(entry: EntryRecord): AgentConversationEntry {
	return {
		id: String(entry.id),
		kind: entry.kind,
		...(entry.model === undefined ? {} : { model: entry.model }),
		...(entry.data === undefined ? {} : { data: entry.data }),
		...(entry.head === undefined ? {} : { head: String(entry.head) }),
	};
}

function snapshotEntryBytes(entry: EntryRecord): number {
	return Buffer.byteLength(JSON.stringify(snapshotEntry(entry)), "utf8");
}

/** Coverage of one bounded snapshot selection. */
export interface ConversationSnapshotCoverage {
	/** True when the page carries every visible entry the source returned within its scope. */
	readonly complete: boolean;
	readonly entries: number;
	readonly bytes: number;
	/** Hidden kinds met during selection; they never consume the entry or byte bounds. */
	readonly hiddenExcluded: number;
	readonly entryLimitReached: boolean;
	readonly byteLimitReached: boolean;
}

/** One bounded transcript selection over records in newest-first order. */
export interface SnapshotSelection {
	/** Selected entries, oldest first. */
	readonly entries: readonly EntryRecord[];
	readonly partial: boolean;
	/** Pass as `before` to continue strictly older than the oldest selected entry. */
	readonly nextBefore: EntryId | null;
	readonly coverage: ConversationSnapshotCoverage;
}

/**
 * Bound one newest-first record slice to a transcript page. Hidden kinds are
 * excluded before either bound applies, so a large prompt record cannot push
 * the first user input out of the page.
 */
export function selectSnapshotEntries(records: readonly EntryRecord[], limit = SNAPSHOT_ENTRY_LIMIT, maxBytes = SNAPSHOT_BYTE_LIMIT): SnapshotSelection {
	const selected: EntryRecord[] = [];
	let entries = 0;
	let bytes = 0;
	let hiddenExcluded = 0;
	let stop: { readonly index: number; readonly reason: "entry" | "byte" } | undefined;
	for (let index = 0; index < records.length; index++) {
		const entry = records[index];
		if (entry === undefined) continue;
		if (isHiddenTranscriptKind(entry.kind)) {
			hiddenExcluded++;
			continue;
		}
		const size = snapshotEntryBytes(entry);
		if (entries >= limit) {
			stop = { index, reason: "entry" };
			break;
		}
		if (entries > 0 && bytes + size > maxBytes) {
			stop = { index, reason: "byte" };
			break;
		}
		entries++;
		bytes += size;
		selected.push(entry);
	}
	// The stop entry is always visible, so a stop always drops older visible
	// entries; hidden records never consume the page.
	const partial = stop !== undefined;
	const ordered = [...selected].reverse();
	const oldest = ordered[0];
	return {
		entries: ordered,
		partial,
		nextBefore: partial && oldest !== undefined ? oldest.id : null,
		coverage: { complete: !partial, entries, bytes, hiddenExcluded, entryLimitReached: stop?.reason === "entry", byteLimitReached: stop?.reason === "byte" },
	};
}

/** Bounds of one earlier-page read; the source query walks history older than `before`. */
export const SNAPSHOT_CONTINUATION_PAGE = 64;
export const SNAPSHOT_CONTINUATION_PAGES = 8;

/** Optional bounds and anchor for one transcript page. */
export interface ConversationSnapshotParams {
	/** Return committed entries strictly older than this entry ID. */
	readonly before?: EntryId;
	readonly limit?: number;
	readonly maxBytes?: number;
}

/** One bounded transcript page with its earlier-page anchor. */
export interface ConversationSnapshotPage extends AgentConversationSnapshot {
	/** Pass as `before` to continue strictly older than the oldest entry in `entries`; null at the oldest visible entry. */
	readonly nextBefore: number | null;
	readonly coverage: ConversationSnapshotCoverage;
}

/** Parse one host snapshot request into bounded page parameters. */
export function parseConversationSnapshotParams(params: RequestParams | undefined): ConversationSnapshotParams {
	const limit = requestInteger(params, "limit");
	const maxBytes = requestInteger(params, "maxBytes");
	return {
		...(params?.before === undefined ? {} : { before: requestRequiredId(params.before, "before") as EntryId }),
		...(limit === undefined ? {} : { limit: boundedLimit(limit, SNAPSHOT_ENTRY_LIMIT, SNAPSHOT_ENTRY_LIMIT) }),
		...(maxBytes === undefined ? {} : { maxBytes: boundedLimit(maxBytes, SNAPSHOT_BYTE_LIMIT, SNAPSHOT_BYTE_LIMIT_MAX) }),
	};
}

/** A storage not yet created has no retained entries and no earlier page. */
export function emptyConversationSnapshot(): ConversationSnapshotPage {
	return snapshotPage(selectSnapshotEntries([], SNAPSHOT_ENTRY_LIMIT, SNAPSHOT_BYTE_LIMIT), undefined);
}

function snapshotPage(selection: SnapshotSelection, before: EntryId | undefined): ConversationSnapshotPage {
	const entries = selection.entries.map((entry) => snapshotEntry(entry));
	const first = entries[0];
	const last = entries[entries.length - 1];
	const revision = first === undefined || last === undefined ? `${before === undefined ? "empty" : `before-${before}`}` : `${first.id}-${last.id}-${entries.length}`;
	return { entries, partial: selection.partial, revision, nextBefore: selection.nextBefore, coverage: selection.coverage };
}

/** One earlier page from the conversation's fork-aware history, newest first at the source. */
async function readEarlierSnapshot(conversation: Conversation, before: EntryId, limit: number, maxBytes: number, context: Context): Promise<ConversationSnapshotPage> {
	const collected: EntryRecord[] = [];
	let cursor: Cursor | undefined;
	let sourceComplete = false;
	for (let page = 0; page < SNAPSHOT_CONTINUATION_PAGES; page++) {
		const result = await conversation.entries({ maxEntryId: (before - 1) as EntryId }, SNAPSHOT_CONTINUATION_PAGE, cursor, context);
		collected.push(...result.items);
		cursor = result.next;
		if (cursor === undefined) {
			sourceComplete = true;
			break;
		}
		if (selectSnapshotEntries(collected, limit, maxBytes).partial) break;
	}
	const selection = selectSnapshotEntries(collected, limit, maxBytes);
	if (!selection.partial && !sourceComplete) {
		// The source has more records, but every visible entry in the scanned
		// window fits: report the bound instead of claiming completeness.
		const oldest = selection.entries[0];
		return {
			...snapshotPage(selection, before),
			partial: true,
			nextBefore: oldest?.id ?? null,
			coverage: { ...selection.coverage, complete: false },
		};
	}
	return snapshotPage(selection, before);
}

/**
 * One bounded, oldest-first transcript page. Without `before` it reads the
 * active transcript; with `before` it continues strictly older through the
 * conversation's history. Hidden kinds are excluded before either bound.
 */
export async function readConversationSnapshotPage(
	harness: Harness,
	conversationId: ConversationId,
	params: ConversationSnapshotParams,
	context: Context,
): Promise<ConversationSnapshotPage> {
	const conversation = await harness.conversation(conversationId, context);
	if (!conversation) throw new Error(`conversation ${conversationId} does not exist`);
	if (params.before !== undefined) return readEarlierSnapshot(conversation, params.before, params.limit ?? SNAPSHOT_ENTRY_LIMIT, params.maxBytes ?? SNAPSHOT_BYTE_LIMIT, context);
	const entries = await activeEntries(conversation, context);
	const selection = selectSnapshotEntries([...entries].reverse(), params.limit ?? SNAPSHOT_ENTRY_LIMIT, params.maxBytes ?? SNAPSHOT_BYTE_LIMIT);
	return snapshotPage(selection, undefined);
}

export async function readReceipts(harness: Harness, ownerId: string | undefined, context: Context): Promise<readonly DeliveryReceipt[]> {
	await settleDeliveries(harness, context);
	const state = await harness.snapshot(AgentDeliveryDoc, context);
	if (!state) return [];
	return Object.values(state.receipts).filter((receipt) => ownerId === undefined || receipt.ownerId === ownerId);
}

interface HistoryPage {
	readonly view: "history" | "branch";
	readonly format?: "compact";
	readonly sessionId: string;
	readonly conversationId: ConversationId;
	readonly entries: readonly DurableEntryRow[];
	readonly nextCursor: Cursor | null;
	readonly order: "newestFirst";
	readonly detail: string;
}

function collectHistoryEntries(items: readonly EntryRecord[], params: DurableInspectParams, remaining: number, seen: Set<EntryId>): { readonly entries: EntryRecord[]; readonly hitLimit: boolean } {
	const entries: EntryRecord[] = [];
	for (const entry of items) {
		if (seen.has(entry.id)) continue;
		seen.add(entry.id);
		if (params.source !== undefined && entrySource(entry.kind) !== params.source) continue;
		entries.push(entry);
		if (entries.length >= remaining) return { entries, hitLimit: true };
	}
	return { entries, hitLimit: false };
}

async function scanHistory(conversation: Conversation, params: DurableInspectParams, end: EntryId | undefined, limit: number, context: Context): Promise<{ readonly entries: EntryRecord[]; readonly next: Cursor | undefined }> {
	const scanned: EntryRecord[] = [];
	const seen = new Set<EntryId>();
	let cursor = params.cursor;
	let next: Cursor | undefined;
	for (let page = 0; page < 8; page++) {
		const result = await conversation.entries(end === undefined ? {} : { maxEntryId: end }, limit - scanned.length, cursor, context);
		const collected = collectHistoryEntries(result.items, params, limit - scanned.length, seen);
		scanned.push(...collected.entries);
		next = result.next;
		if (collected.hitLimit || next === undefined) break;
		cursor = next;
	}
	return { entries: scanned.slice(0, limit), next };
}

async function readHistoryPage(
	storageId: string,
	conversation: Conversation,
	params: DurableInspectParams,
	view: "history" | "branch",
	context: Context,
): Promise<HistoryPage> {
	const limit = boundedLimit(params.limit, HISTORY_LIMIT_DEFAULT, HISTORY_LIMIT_MAX);
	const end = view === "branch" ? (parseEntryId(params.fromId ?? params.entryId) ?? await currentLeaf(conversation, context)) : parseEntryId(params.entryId);
	const scanned = await scanHistory(conversation, params, end, limit, context);
	return {
		view,
		...(view === "history" ? { format: "compact" as const } : {}),
		sessionId: durableIdentity(storageId, conversation.id === 1 ? undefined : conversation.id),
		conversationId: conversation.id,
		entries: scanned.entries.map((entry) => view === "branch" ? rawEntryRow(entry) : entryRow(entry)),
		nextCursor: scanned.next ?? null,
		order: "newestFirst",
		detail: view === "branch"
			? "Newest first. Redacted JSON; continue with nextCursor or exact entryId and nextOffset."
			: "Newest first. Compact readable entries; continue with nextCursor. Truncated text and tool parts have markers. Use exact with entryId and offset 0 for full retained redacted JSON.",
	};
}

async function currentLeaf(conversation: Conversation, context: Context): Promise<EntryId | undefined> {
	return (await conversation.entries({}, 1, undefined, context)).items[0]?.id;
}

interface ExactPage {
	readonly view: "exact";
	readonly sessionId: string;
	readonly conversationId: ConversationId;
	readonly entryId: EntryId;
	readonly offset: number;
	readonly text: string;
	readonly nextOffset: number | null;
	readonly truncated: boolean;
	readonly omissions?: EntryOmissions;
}

async function readExact(storageId: string, conversation: Conversation, params: DurableInspectParams, context: Context): Promise<ExactPage> {
	const entryId = parseEntryId(params.entryId);
	if (entryId === undefined) throw new TypeError("exact inspection requires entryId");
	const page = await conversation.entries({ minEntryId: entryId, maxEntryId: entryId }, 1, undefined, context);
	const entry = page.items[0];
	if (entry === undefined || entry.id !== entryId) throw new Error(`entry ${entryId} is not visible from conversation ${conversation.id}`);
	const projected = projectEntry(entry);
	const cut = fragment(projected.text, params.offset ?? 0, ENTRY_PAGE_UNITS);
	return {
		view: "exact",
		sessionId: durableIdentity(storageId, conversation.id === 1 ? undefined : conversation.id),
		conversationId: conversation.id,
		entryId,
		offset: cut.start,
		text: cut.text,
		nextOffset: cut.nextOffset,
		truncated: cut.truncated,
		...(projected.omissions === undefined ? {} : { omissions: projected.omissions }),
	};
}

interface SearchMatch {
	readonly entryId: EntryId;
	readonly kind: string;
	readonly source: DurableEntrySource;
	readonly matchOffset: number;
	readonly excerpt: string;
	readonly excerptText: string;
	readonly truncated: boolean;
}

interface SearchCursor {
	readonly cursor: Cursor | null;
	readonly skip: number;
	readonly scannedBytes: number;
}

interface SearchPage {
	readonly view: "search";
	readonly sessionId: string;
	readonly conversationId: ConversationId;
	readonly matches: readonly SearchMatch[];
	readonly nextCursor: SearchCursor | null;
	readonly coverage: { readonly scannedEntries: number; readonly scannedBytes: number; readonly complete: boolean };
	readonly detail: string;
}

interface SearchScan {
	readonly matches: readonly SearchMatch[];
	readonly nextCursor: SearchCursor | null;
	readonly complete: boolean;
	readonly scannedEntries: number;
	readonly scannedBytes: number;
}

function searchMatch(entry: EntryRecord, text: string, query: string): SearchMatch | undefined {
	const at = text.indexOf(query);
	if (at < 0) return undefined;
	const cut = fragment(text, at, 512);
	return { entryId: entry.id, kind: entry.kind, source: entrySource(entry.kind), matchOffset: at, excerpt: cut.text, excerptText: cut.text, truncated: cut.truncated };
}

function scanSearchEntry(entry: EntryRecord, params: DurableInspectParams, query: string): { readonly bytes: number; readonly match?: SearchMatch } {
	const text = searchableText(entry);
	const bytes = Buffer.byteLength(text, "utf8");
	if (params.source !== undefined && entrySource(entry.kind) !== params.source) return { bytes };
	const match = searchMatch(entry, text, query);
	return match === undefined ? { bytes } : { bytes, match };
}

interface SearchPageScan {
	readonly scannedEntries: number;
	readonly scannedBytes: number;
	/** Continuation inside this page after a match limit stopped the scan. */
	readonly resume: SearchCursor | null;
}

function scanSearchPage(
	items: readonly EntryRecord[],
	params: DurableInspectParams,
	query: string,
	startSkip: number,
	maxMatches: number,
	budget: number,
	matches: SearchMatch[],
	pageCursor: Cursor | undefined,
	priorBytes: number,
): SearchPageScan {
	let scannedEntries = 0;
	let scannedBytes = 0;
	for (let index = startSkip; index < items.length && scannedEntries < budget; index++) {
		const entry = items[index];
		if (entry === undefined) continue;
		scannedEntries++;
		const scan = scanSearchEntry(entry, params, query);
		scannedBytes += scan.bytes;
		if (scan.match !== undefined) matches.push(scan.match);
		if (matches.length >= maxMatches || scannedEntries >= budget) {
			return { scannedEntries, scannedBytes, resume: { cursor: pageCursor ?? null, skip: index + 1, scannedBytes: priorBytes + scannedBytes } };
		}
	}
	return { scannedEntries, scannedBytes, resume: null };
}

async function scanSearch(conversation: Conversation, params: DurableInspectParams, query: string, maxMatches: number, context: Context): Promise<SearchScan> {
	const prior = (params.cursor ?? null) as SearchCursor | null;
	let cursor: Cursor | undefined = prior?.cursor ?? undefined;
	let skip = prior?.skip ?? 0;
	let scannedBytes = 0;
	let scannedEntries = 0;
	const matches: SearchMatch[] = [];
	let complete = false;
	let resume: SearchCursor | null = null;
	while (scannedEntries < SEARCH_SCAN_LIMIT_DEFAULT && matches.length < maxMatches) {
		const pageCursor = cursor;
		const page = await conversation.entries({}, Math.min(32, SEARCH_SCAN_LIMIT_DEFAULT - scannedEntries), pageCursor, context);
		if (page.items.length === 0) {
			complete = true;
			break;
		}
		const pageScan = scanSearchPage(page.items, params, query, skip, maxMatches, SEARCH_SCAN_LIMIT_DEFAULT - scannedEntries, matches, pageCursor, scannedBytes);
		scannedEntries += pageScan.scannedEntries;
		scannedBytes += pageScan.scannedBytes;
		if (pageScan.resume !== null) {
			resume = pageScan.resume;
			break;
		}
		skip = 0;
		cursor = page.next;
		if (cursor === undefined) {
			complete = true;
			break;
		}
	}
	return { matches, nextCursor: resume ?? (complete ? null : { cursor: cursor ?? null, skip, scannedBytes }), complete, scannedEntries, scannedBytes };
}

async function readSearch(storageId: string, conversation: Conversation, params: DurableInspectParams, context: Context): Promise<SearchPage> {
	if (params.query === undefined || params.query === "") throw new TypeError("search inspection requires query");
	const maxMatches = boundedLimit(params.limit, SEARCH_MATCH_LIMIT_DEFAULT, SEARCH_MATCH_LIMIT_MAX);
	const scan = await scanSearch(conversation, params, params.query, maxMatches, context);
	return {
		view: "search",
		sessionId: durableIdentity(storageId, conversation.id === 1 ? undefined : conversation.id),
		conversationId: conversation.id,
		matches: scan.matches,
		nextCursor: scan.nextCursor,
		coverage: { scannedEntries: scan.scannedEntries, scannedBytes: scan.scannedBytes, complete: scan.complete },
		detail: "Case-sensitive literal match over entry kind, message text, visible thinking, and tool names. Signatures, images, redacted thinking, arguments, and arbitrary data are excluded. Repeat query and nextCursor to continue.",
	};
}

interface TurnRow {
	readonly entries: readonly DurableEntryRow[];
}

/** Owner metadata for the activity view; null and empty fields mean a cold snapshot. */
export interface DurableActivityMetadata {
	/** Who holds the storage writer claim: `here` for the live host, otherwise the caller's classification. */
	readonly owner: "here" | "unavailable" | "unknown";
	/** True only when this process is the live writer; false for a cold snapshot. */
	readonly live: boolean;
	readonly operation: number | null;
	readonly runningTools: readonly {
		readonly toolCallId: string;
		readonly name: string;
		/** Assistant tool-call commit time; predates execution, so it is not a start time. */
		readonly issuedAt?: string;
		readonly elapsedMs?: number;
		/** Basis of `elapsedMs` when present. */
		readonly elapsedFrom?: "tool-call-entry";
	}[];
	readonly pending: number | null;
	readonly streamedText?: string;
	readonly lastError?: string;
	readonly compactionFailure?: DashboardCompactionFailure;
	readonly autoRetry?: DashboardAutoRetry;
}

interface ActivityPage {
	readonly view: "activity";
	readonly format: "compact";
	readonly sessionId: string;
	readonly conversationId: ConversationId;
	readonly turns: readonly TurnRow[];
	readonly nextCursor: Cursor | null;
	readonly metadata: DurableActivityMetadata;
	readonly coverage: {
		readonly scannedEntries: number;
		readonly scannedBytes: number;
		readonly complete: boolean;
		readonly entryLimitReached: boolean;
		/** The scan stopped at its own byte bound. */
		readonly scanByteLimitReached: boolean;
		/** The digest byte bound dropped rows. */
		readonly byteLimitReached: boolean;
		/** Exact serialized size of this whole page, this field included. */
		readonly bytes: number;
		/** Rows dropped from the digest by the byte bound. */
		readonly omittedEntries: number;
	};
	readonly detail: string;
}

/** Options the live host adds to inspection; a cold snapshot uses the defaults. */
export interface DurableInspectionOptions {
	/** Live writer: include owner metadata derived from LiveDoc and the inbox. */
	readonly live?: boolean;
	/** Writer-claim classification for the activity metadata owner. */
	readonly owner?: "here" | "unavailable" | "unknown";
	readonly retryMaxAttempts?: number;
	readonly now?: number;
}

interface ActivityScan {
	readonly collected: readonly EntryRecord[];
	readonly complete: boolean;
	readonly scannedEntries: number;
	readonly scannedBytes: number;
}

/** Activity continuation cursor: resume strictly older than this entry. */
function activityAfter(cursor: Cursor | undefined): EntryId | undefined {
	const value = cursor?.after;
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? (value as EntryId) : undefined;
}

async function scanActivity(conversation: Conversation, params: DurableInspectParams, turnLimit: number, context: Context): Promise<ActivityScan> {
	const collected: EntryRecord[] = [];
	const after = activityAfter(params.cursor);
	let cursor: Cursor | undefined = after === undefined ? params.cursor : undefined;
	let complete = false;
	let scannedEntries = 0;
	let scannedBytes = 0;
	// Collect newest-first until one more than the requested turn count or either bound.
	while (scannedEntries < ACTIVITY_SCAN_ENTRIES && scannedBytes < ACTIVITY_SCAN_BYTES) {
		const page = await conversation.entries(after === undefined ? {} : { maxEntryId: (after - 1) as EntryId }, 32, cursor, context);
		collected.push(...page.items);
		scannedEntries += page.items.length;
		for (const entry of page.items) scannedBytes += Buffer.byteLength(searchableText(entry), "utf8");
		cursor = page.next;
		if (cursor === undefined) {
			complete = true;
			break;
		}
		const users = collected.reduce((count, entry) => count + (entry.kind === "pi.user" ? 1 : 0), 0);
		if (users > turnLimit) break;
	}
	return { collected, complete, scannedEntries, scannedBytes };
}

/** Group oldest-first: every user entry starts a turn. */
function groupActivityTurns(collected: readonly EntryRecord[]): EntryRecord[][] {
	const turns: EntryRecord[][] = [];
	for (const entry of [...collected].reverse()) {
		let turn = turns[turns.length - 1];
		if (entry.kind === "pi.user" || turn === undefined) {
			turn = [];
			turns.push(turn);
		}
		turn.push(entry);
	}
	return turns;
}

async function activityMetadata(harness: Harness, conversation: Conversation, options: DurableInspectionOptions, context: Context): Promise<DurableActivityMetadata> {
	if (options.live !== true) {
		return { owner: options.owner ?? "unavailable", live: false, operation: null, runningTools: [], pending: null };
	}
	const live = await harness.snapshot(LiveDoc, conversation.id, context);
	const inbox = await harness.snapshot(InboxDoc, conversation.id, context);
	const now = options.now ?? Date.now();
	const issuedAt = live?.generation?.message?.timestamp;
	// The assistant tool-call timestamp predates execution; it is an issue time, not a start time.
	// A running call without a committed generation message is still real work, listed without times.
	const runningTools = (live?.tools ?? [])
		.filter((tool) => tool.status !== "done")
		.map((tool) => ({ toolCallId: tool.callId, name: tool.name, ...(issuedAt === undefined ? {} : { issuedAt: new Date(issuedAt).toISOString(), elapsedMs: Math.max(0, now - issuedAt), elapsedFrom: "tool-call-entry" as const }) }));
	const health = dashboardHealth(live, blockedTasks(await harness.inspect(context), conversation.id), now, options.retryMaxAttempts);
	const streamedText = live?.generation?.message === undefined ? undefined : textOfMessage(live.generation.message);
	return {
		owner: "here",
		live: true,
		operation: live?.run?.taskId ?? null,
		runningTools,
		pending: inbox === undefined ? null : inbox.items.length,
		...(streamedText === undefined || streamedText === "" ? {} : { streamedText }),
		...(health?.lastError === undefined ? {} : { lastError: health.lastError }),
		...(health?.compactionFailure === undefined ? {} : { compactionFailure: health.compactionFailure }),
		...(health?.autoRetry === undefined ? {} : { autoRetry: health.autoRetry }),
	};
}

interface ActivityRow {
	readonly turnIndex: number;
	readonly entryIndex: number;
	readonly failure: boolean;
	readonly row: DurableEntryRow;
}

interface ActivityCoverage {
	scannedEntries: number;
	scannedBytes: number;
	complete: boolean;
	entryLimitReached: boolean;
	scanByteLimitReached: boolean;
	byteLimitReached: boolean;
	bytes: number;
	omittedEntries: number;
	metadataTruncated: boolean;
}

interface ActivityBase {
	readonly view: "activity";
	readonly format: "compact";
	readonly sessionId: string;
	readonly conversationId: ConversationId;
	readonly nextCursor: Cursor | null;
	readonly metadata: DurableActivityMetadata;
	readonly detail: string;
}

interface ActivityDraft extends ActivityBase {
	turns: TurnRow[];
	coverage: ActivityCoverage;
}

const activityBytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), "utf8");

/** Surrogate-safe truncation of one metadata text field. */
function boundMetadataText(value: string, units: number): string {
	if (value.length <= units) return value;
	let end = units;
	const code = value.charCodeAt(end - 1);
	if (code >= 0xd800 && code <= 0xdbff) end -= 1;
	return value.slice(0, end);
}

/** Final marker for an error body that cannot fit even at the smallest bound. */
const ACTIVITY_METADATA_OMISSION = "[omitted: activity metadata exceeded the digest bound]";

/** Shrink the error bodies to one bound; fields stay present. */
function shrinkMetadataErrors(metadata: DurableActivityMetadata, units: number): DurableActivityMetadata {
	return {
		...metadata,
		...(metadata.lastError === undefined ? {} : { lastError: boundMetadataText(metadata.lastError, units) }),
		...(metadata.compactionFailure === undefined
			? {}
			: { compactionFailure: { ...metadata.compactionFailure, ...(metadata.compactionFailure.errorMessage === undefined ? {} : { errorMessage: boundMetadataText(metadata.compactionFailure.errorMessage, units) }) } }),
		...(metadata.autoRetry === undefined ? {} : { autoRetry: { ...metadata.autoRetry, errorMessage: boundMetadataText(metadata.autoRetry.errorMessage, units) } }),
	};
}

/** Replace every error body with the final omission marker. */
function omitMetadataErrors(metadata: DurableActivityMetadata): DurableActivityMetadata {
	return {
		...metadata,
		...(metadata.lastError === undefined ? {} : { lastError: ACTIVITY_METADATA_OMISSION }),
		...(metadata.compactionFailure === undefined ? {} : { compactionFailure: { ...metadata.compactionFailure, errorMessage: ACTIVITY_METADATA_OMISSION } }),
		...(metadata.autoRetry === undefined ? {} : { autoRetry: { ...metadata.autoRetry, errorMessage: ACTIVITY_METADATA_OMISSION } }),
	};
}

/**
 * Shrink metadata until `fits` accepts it. Streaming text shrinks and drops
 * first, then running-tool rows; error bodies shrink last, so `lastError`,
 * `compactionFailure`, and `autoRetry` survive a metadata-only overflow.
 */
export function reduceActivityMetadata(
	metadata: DurableActivityMetadata,
	fits: (candidate: DurableActivityMetadata) => boolean,
): { readonly metadata: DurableActivityMetadata; readonly truncated: boolean } {
	if (fits(metadata)) return { metadata, truncated: false };
	let current = metadata;
	if (current.streamedText !== undefined) {
		current = { ...current, streamedText: boundMetadataText(current.streamedText, 512) };
		if (!fits(current)) {
			const { streamedText: _dropped, ...withoutStream } = current;
			current = withoutStream as DurableActivityMetadata;
		}
	}
	if (current.runningTools.length > ACTIVITY_METADATA_TOOL_LIMIT && !fits(current)) current = { ...current, runningTools: current.runningTools.slice(0, ACTIVITY_METADATA_TOOL_LIMIT) };
	if (current.runningTools.length > 0 && !fits(current)) current = { ...current, runningTools: [] };
	for (const units of [1024, 256, 64]) {
		if (fits(current)) break;
		current = shrinkMetadataErrors(current, units);
	}
	if (!fits(current)) current = omitMetadataErrors(current);
	return { metadata: current, truncated: true };
}

/** True for an assistant error or abort, or an error tool result. */
function isFailureEntry(entry: EntryRecord): boolean {
	for (const message of entry.model ?? []) {
		if (message.role === "toolResult" && message.isError === true) return true;
		if (message.role === "assistant" && (message.stopReason === "error" || message.stopReason === "aborted" || message.errorMessage !== undefined)) return true;
	}
	return false;
}

/** Rebuild the turn structure newest-first from selected rows in chronological order. */
function activityTurns(rows: readonly ActivityRow[]): TurnRow[] {
	const ordered = [...rows].sort((left, right) => left.turnIndex - right.turnIndex || left.entryIndex - right.entryIndex);
	const turns: { turnIndex: number; entries: DurableEntryRow[] }[] = [];
	for (const row of ordered) {
		let current = turns[turns.length - 1];
		if (current === undefined || current.turnIndex !== row.turnIndex) {
			current = { turnIndex: row.turnIndex, entries: [] };
			turns.push(current);
		}
		current.entries.push(row.row);
	}
	return turns.map((turn) => ({ entries: turn.entries })).reverse();
}

function activityDraft(base: ActivityBase, scan: ActivityScan, rows: readonly ActivityRow[], totalRows: number, metadataTruncated: boolean, hasOlder: boolean): ActivityDraft {
	const omittedEntries = totalRows - rows.length;
	return {
		...base,
		turns: activityTurns(rows),
		coverage: {
			scannedEntries: scan.scannedEntries,
			scannedBytes: scan.scannedBytes,
			complete: scan.complete && !hasOlder && omittedEntries === 0 && !metadataTruncated,
			entryLimitReached: scan.scannedEntries >= ACTIVITY_SCAN_ENTRIES,
			scanByteLimitReached: scan.scannedBytes >= ACTIVITY_SCAN_BYTES,
			byteLimitReached: omittedEntries > 0 || metadataTruncated,
			bytes: 0,
			omittedEntries,
			metadataTruncated,
		},
	};
}

/** Set coverage.bytes to the stable size of the whole draft. */
function finalizedActivity(draft: ActivityDraft): ActivityDraft {
	let bytes = 0;
	for (;;) {
		draft.coverage.bytes = bytes;
		const next = activityBytes(draft);
		if (next === bytes) return draft;
		bytes = next;
	}
}

function activityCandidates(groups: readonly (readonly EntryRecord[])[]): ActivityRow[] {
	const candidates: ActivityRow[] = [];
	for (let turnIndex = 0; turnIndex < groups.length; turnIndex++) {
		const entries = groups[turnIndex] ?? [];
		for (let entryIndex = 0; entryIndex < entries.length; entryIndex++) {
			const entry = entries[entryIndex];
			if (entry === undefined) continue;
			candidates.push({ turnIndex, entryIndex, failure: isFailureEntry(entry), row: entryRow(entry, ENTRY_PREVIEW_UNITS) });
		}
	}
	return candidates;
}

/** Failure rows first, then ordinary rows, each newest-first when it still fits. */
function selectActivityRows(ranked: readonly ActivityRow[], fits: (rows: ActivityRow[]) => boolean): ActivityRow[] {
	const kept: ActivityRow[] = [];
	for (const row of ranked) {
		if (!row.failure) continue;
		const candidate = [...kept, row];
		if (fits(candidate)) kept.push(row);
	}
	for (const row of ranked) {
		if (row.failure) continue;
		const candidate = [...kept, row];
		if (fits(candidate)) kept.push(row);
	}
	return kept;
}

/** Drop the oldest ordinary row, or the oldest row when only failures remain. */
function dropOldestOrdinary(kept: ActivityRow[]): void {
	for (let index = kept.length - 1; index >= 0; index--) {
		const row = kept[index];
		if (row !== undefined && !row.failure) {
			kept.splice(index, 1);
			return;
		}
	}
	kept.pop();
}

/** Finalize and, if the fixed point exceeds the bound, drop rows until it holds. */
function boundedActivity(base: ActivityBase, scan: ActivityScan, candidates: readonly ActivityRow[], kept: ActivityRow[], metadataTruncated: boolean, hasOlder: boolean): ActivityDraft {
	let final = finalizedActivity(activityDraft(base, scan, kept, candidates.length, metadataTruncated, hasOlder));
	while (activityBytes(final) > ACTIVITY_DIGEST_BYTES && kept.length > 0) {
		dropOldestOrdinary(kept);
		final = finalizedActivity(activityDraft(base, scan, kept, candidates.length, metadataTruncated, hasOlder));
	}
	return final;
}

async function readActivity(harness: Harness, storageId: string, conversation: Conversation, params: DurableInspectParams, options: DurableInspectionOptions, context: Context): Promise<ActivityPage> {
	const turnLimit = boundedLimit(params.limit, ACTIVITY_TURN_LIMIT_DEFAULT, ACTIVITY_TURN_LIMIT_MAX);
	const scan = await scanActivity(conversation, params, turnLimit, context);
	const allGroups = groupActivityTurns(scan.collected);
	const groups = allGroups.slice(-turnLimit);
	const candidates = activityCandidates(groups);
	const oldestSelected = groups[0]?.[0];
	const hasOlder = allGroups.length > turnLimit || !scan.complete;
	const baseFor = (metadata: DurableActivityMetadata): ActivityBase => ({
		view: "activity",
		format: "compact",
		sessionId: durableIdentity(storageId, conversation.id === 1 ? undefined : conversation.id),
		conversationId: conversation.id,
		nextCursor: oldestSelected === undefined || !hasOlder ? null : ({ after: oldestSelected.id } as Cursor),
		metadata,
		detail: "Newest turns first. Compact readable entries; exact with entryId and offset 0 returns retained redacted JSON. Failure rows take priority within the digest bound; nextCursor resumes older turns and unfinished scans only, not rows dropped by the bound. Use history for those rows.",
	});
	// A metadata-only overflow must fit before any row is considered.
	const reduced = reduceActivityMetadata(await activityMetadata(harness, conversation, options, context), (candidate) =>
		activityBytes(activityDraft(baseFor(candidate), scan, [], candidates.length, false, hasOlder)) <= ACTIVITY_DIGEST_SELECT_BYTES,
	);
	const base = baseFor(reduced.metadata);
	const ranked = [...candidates].reverse();
	const kept = selectActivityRows(ranked, (rows) => activityBytes(activityDraft(base, scan, rows, candidates.length, reduced.truncated, hasOlder)) <= ACTIVITY_DIGEST_SELECT_BYTES);
	return boundedActivity(base, scan, candidates, kept, reduced.truncated, hasOlder);
}

interface ResultPage {
	readonly view: "result";
	readonly sessionId: string;
	readonly conversationId: ConversationId;
	readonly submissionId: SubmissionId;
	readonly status: SubmissionRecord["status"];
	readonly requestId?: string;
	readonly operationId?: string;
	readonly entryId?: EntryId;
	readonly answerEntryId?: EntryId;
	readonly reason?: string;
	readonly answer?: string;
	readonly providerBlock?: ProviderBlockFact;
	readonly recoveryOf?: string;
	readonly usage: UsageState;
}

async function resultTarget(harness: Harness, conversation: Conversation, params: DurableInspectParams, context: Context): Promise<{ readonly submissionId: SubmissionId; readonly operationId?: string }> {
	if (params.submissionId !== undefined) return { submissionId: params.submissionId, ...(params.operationId === undefined ? {} : { operationId: params.operationId }) };
	if (params.operationId === undefined) throw new TypeError("result inspection requires submissionId or operationId");
	const operationId = params.operationId;
	const receipts = await readReceipts(harness, undefined, context);
	const found = receipts.find((receipt) => receipt.operationId === operationId && receipt.conversationId === conversation.id);
	if (!found) throw new Error(`no retained result for operation ${operationId}`);
	return { submissionId: found.submissionId, operationId };
}

async function resultAnswer(harness: Harness, answerEntryId: EntryId, context: Context): Promise<{ readonly answer?: string; readonly reason?: string }> {
	const answer = await harness.commit((tx) => tx.entry(AssistantEntry, answerEntryId), context);
	const text = answer === undefined ? undefined : (answer.model ?? []).map(textOfMessage).join("");
	return text === undefined || text === "" ? { reason: `durable answer entry ${answerEntryId} is not retained` } : { answer: text };
}

async function readResult(harness: Harness, storageId: string, conversation: Conversation, params: DurableInspectParams, context: Context): Promise<ResultPage> {
	const target = await resultTarget(harness, conversation, params, context);
	const submission = await harness.submission(target.submissionId, context);
	if (!submission) throw new Error(`durable submission ${target.submissionId} is not retained`);
	const record = await submission.status(context);
	if (record.conversationId !== conversation.id) throw new Error(`durable submission ${target.submissionId} belongs to conversation ${record.conversationId}`);
	const usage = await harness.usage(context);
	const recoveryOf = await harness.commit((tx) => readInputRecovery(tx, record.id), context);
	const base = {
		...(recoveryOf === undefined ? {} : { recoveryOf }),
		view: "result" as const,
		sessionId: durableIdentity(storageId, conversation.id === 1 ? undefined : conversation.id),
		conversationId: conversation.id,
		submissionId: target.submissionId,
		status: record.status,
		...optionalParam("requestId", record.requestId),
		...optionalParam("operationId", target.operationId),
		usage,
	};
	if (record.type !== "input") return base;
	if (record.status === "done") return { ...base, entryId: record.entry, answerEntryId: record.answer, ...(await resultAnswer(harness, record.answer, context)) };
	if (record.status === "unanswered") {
		const providerBlock = await harness.commit((tx) => readInputProviderBlock(tx, record.id), context);
		return { ...base, ...(record.entry === undefined ? {} : { entryId: record.entry }), reason: record.reason, ...(providerBlock === undefined ? {} : { providerBlock }) };
	}
	return { ...base, ...(record.entry === undefined ? {} : { entryId: record.entry }) };
}

/** One bounded inspection over a conversation's committed entries, submissions, and receipts. */
export async function readInspection(harness: Harness, storageId: string, conversation: Conversation, params: DurableInspectParams, context: Context, options: DurableInspectionOptions = {}): Promise<unknown> {
	const view = params.view ?? "history";
	switch (view) {
		case "history":
			return readHistoryPage(storageId, conversation, params, "history", context);
		case "branch":
			return readHistoryPage(storageId, conversation, params, "branch", context);
		case "search":
			return readSearch(storageId, conversation, params, context);
		case "exact":
			return readExact(storageId, conversation, params, context);
		case "activity":
			return readActivity(harness, storageId, conversation, params, options, context);
		case "result":
			return readResult(harness, storageId, conversation, params, context);
	}
}

export interface DurableObservationOptions {
	readonly storageId: string;
	readonly registry: HarnessOptions["registry"];
	readonly models: Models;
	readonly settings?: HarnessOptions["settings"];
	readonly env?: HarnessOptions["env"];
	readonly onReport?: HarnessOptions["onReport"];
	/** Largest source database (main file plus WAL) a snapshot backup may copy. */
	readonly maxSourceBytes?: number;
	/** Longest a snapshot backup may run before it fails. */
	readonly backupTimeoutMs?: number;
	/**
	 * Writer-claim classification for dashboard rows. The caller composes this
	 * with `observeClaim`: a live or unknown claim is unavailable, an absent or
	 * dead claim is a readable, claimable storage whose owner is unknown here.
	 * Without it rows report `unavailable`.
	 */
	readonly classifyOwner?: () => { readonly owner: "here" | "unavailable" | "unknown"; readonly label?: string };
}

/** Default source bound for one cold snapshot. */
export const SNAPSHOT_MAX_SOURCE_BYTES = 512 * 1024 * 1024;
/** Default time bound for one cold snapshot backup. */
export const SNAPSHOT_BACKUP_TIMEOUT_MS = 30_000;

/** A caller-opened storage or a SQLite file copied through `node:sqlite` backup. */
export type DurableSnapshotSource = { readonly backupFrom: string } | { readonly storage: Storage };

interface SnapshotCopy {
	readonly absent?: boolean;
	readonly storage: Storage;
	readonly cleanup: (() => Promise<void>) | undefined;
}

/** Copy one SQLite source into a bounded temporary snapshot. Never writes the source. */
async function copySnapshot(backupFrom: string, maxSourceBytes: number, backupTimeoutMs: number): Promise<SnapshotCopy> {
	const sourceBytes = snapshotSourceBytes(backupFrom);
	if (sourceBytes === undefined) return { storage: await openNodeSqliteStorage(":memory:"), cleanup: undefined, absent: true };
	if (sourceBytes > maxSourceBytes) throw new RangeError(`snapshot source is ${sourceBytes} bytes, above the ${maxSourceBytes} byte bound`);
	const directory = await mkdtemp(join(tmpdir(), "pi-durable-snapshot-"));
	const target = join(directory, "snapshot.sqlite");
	try {
		const source = new DatabaseSync(backupFrom, { readOnly: true });
		let timer: NodeJS.Timeout | undefined;
		try {
			await Promise.race([
				backup(source, target),
				new Promise<never>((_, reject) => {
					timer = setTimeout(() => reject(new Error(`snapshot backup exceeded ${backupTimeoutMs} ms`)), backupTimeoutMs);
				}),
			]);
		} finally {
			if (timer !== undefined) clearTimeout(timer);
			source.close();
		}
		return { storage: await openNodeSqliteStorage(target), cleanup: async () => { await rm(directory, { recursive: true, force: true }); } };
	} catch (error) {
		await rm(directory, { recursive: true, force: true }).catch(() => {});
		throw error;
	}
}

/**
 * Read-only Harness over a cold snapshot or a caller-supplied storage. Opening
 * never calls `resume()`. The harness owns its storage: `close()` closes it and
 * removes the temporary snapshot directory when one was created.
 */
export class DurableObservation {
	readonly harness: Harness;
	readonly storageId: string;
	private readonly storage: Storage;
	private readonly release: () => Promise<void>;
	private readonly absent: boolean;
	private readonly classifyOwner: () => { readonly owner: "here" | "unavailable" | "unknown"; readonly label?: string };

	private constructor(harness: Harness, storage: Storage, storageId: string, release: () => Promise<void>, classifyOwner: () => { readonly owner: "here" | "unavailable" | "unknown"; readonly label?: string }, absent: boolean) {
		this.harness = harness;
		this.storage = storage;
		this.absent = absent;
		this.storageId = storageId;
		this.release = release;
		this.classifyOwner = classifyOwner;
	}

	static async open(options: DurableObservationOptions & DurableSnapshotSource, context: Context = BACKGROUND_CONTEXT): Promise<DurableObservation> {
		let storage: Storage;
		let cleanup: (() => Promise<void>) | undefined;
		let absent = false;
		if ("storage" in options) {
			storage = options.storage;
		} else {
			const copy = await copySnapshot(options.backupFrom, options.maxSourceBytes ?? SNAPSHOT_MAX_SOURCE_BYTES, options.backupTimeoutMs ?? SNAPSHOT_BACKUP_TIMEOUT_MS);
			storage = copy.storage;
			cleanup = copy.cleanup;
			absent = copy.absent === true;
		}
		let harness: Harness;
		try {
			harness = await Harness.open(
				storage,
				{
					models: options.models,
					registry: options.registry,
					...(options.settings === undefined ? {} : { settings: options.settings }),
					...(options.env === undefined ? {} : { env: options.env }),
					...(options.onReport === undefined ? {} : { onReport: options.onReport }),
				},
				context,
			);
		} catch (error) {
			try {
				await storage.close(BACKGROUND_CONTEXT);
			} catch {
				// Retain the open failure.
			}
			if (cleanup) await cleanup().catch(() => {});
			throw error;
		}
		const extra = cleanup;
		return new DurableObservation(
			harness,
			storage,
			options.storageId,
			async () => {
				try {
					await harness.close(BACKGROUND_CONTEXT);
				} finally {
					if (extra) await extra();
				}
			},
			options.classifyOwner ?? (() => ({ owner: "unavailable" })),
			absent,
		);
	}

	async conversation(id: ConversationId, context: Context = BACKGROUND_CONTEXT): Promise<Conversation | undefined> {
		return this.harness.conversation(id, context);
	}

	/** External identity of one conversation: the storage ID for the root. */
	identity(conversationId?: ConversationId): string {
		return conversationId === undefined || conversationId === 1 ? this.storageId : durableIdentity(this.storageId, conversationId);
	}

	async list(params: DurableListParams = {}, context: Context = BACKGROUND_CONTEXT): Promise<{ readonly items: readonly ConversationSummary[]; readonly next: Cursor | null }> {
		return readConversationList(this.harness, this.storageId, params, context);
	}

	async status(conversationId: ConversationId, options: DurableStatusOptions = {}, context: Context = BACKGROUND_CONTEXT): Promise<ConversationStatus | undefined> {
		return readConversationStatus(this.harness, this.storageId, conversationId, options, context);
	}

	async inspect(conversation: Conversation, params: DurableInspectParams = {}, context: Context = BACKGROUND_CONTEXT): Promise<unknown> {
		return readInspection(this.harness, this.storageId, conversation, params, context, { owner: this.classifyOwner().owner });
	}

	async receipts(ownerId?: string, context: Context = BACKGROUND_CONTEXT): Promise<readonly DeliveryReceipt[]> {
		return readReceipts(this.harness, ownerId, context);
	}

	async dashboard(params: DurableDashboardParams = {}, options: DurableDashboardOptions = {}, context: Context = BACKGROUND_CONTEXT): Promise<readonly AgentConversationSummary[]> {
		return readDashboard(this.harness, this.storageId, params, { ...options, storage: this.storage }, context);
	}

	async snapshot(conversationId: ConversationId, context: Context = BACKGROUND_CONTEXT): Promise<ConversationSnapshotPage> {
		if (this.absent) return emptyConversationSnapshot();
		return readConversationSnapshotPage(this.harness, conversationId, {}, context);
	}

	async usage(context: Context = BACKGROUND_CONTEXT): Promise<UsageState> {
		return readUsage(this.harness, context);
	}

	private async target(params: RequestParams | undefined, context: Context): Promise<Conversation> {
		const conversationId = resolveSessionConversationId(this.storageId, requestString(params, "sessionId"), requestPositiveId(params?.conversationId, "conversationId"));
		const conversation = await this.harness.conversation(conversationId, context);
		if (!conversation) throw new Error(`conversation ${durableIdentity(this.storageId, conversationId === 1 ? undefined : conversationId)} does not exist`);
		return conversation;
	}

	private async requestStatus(params: RequestParams | undefined, context: Context): Promise<unknown> {
		const sessionId = requestString(params, "sessionId");
		const conversationId = requestPositiveId(params?.conversationId, "conversationId");
		const options: DurableStatusOptions = optionalParam("cwd", requestString(params, "cwd"));
		if (sessionId !== undefined || conversationId !== undefined) {
			const conversation = await this.target(params, context);
			const status = await readConversationStatus(this.harness, this.storageId, conversation.id, options, context);
			if (!status) throw new Error(`conversation ${this.identity(conversation.id)} does not exist`);
			return { conversation: status };
		}
		const page = await this.harness.commit((tx) => tx.scanConversations({}, 50, undefined), context);
		const conversations: ConversationStatus[] = [];
		for (const record of page.items) {
			const status = await readConversationStatus(this.harness, this.storageId, record.id, options, context);
			if (status) conversations.push(status);
		}
		return { conversations };
	}

	private async requestList(params: RequestParams | undefined, context: Context): Promise<unknown> {
		const list: DurableListParams = {
			...optionalParam("limit", requestInteger(params, "limit")),
			...(params?.cursor === undefined ? {} : { cursor: params.cursor as Cursor }),
			...optionalParam("ownerConversationId", requestPositiveId(params?.ownerConversationId, "ownerConversationId") as ConversationId | undefined),
			...optionalParam("ownerTaskId", requestInteger(params, "ownerTaskId")),
		};
		return readConversationList(this.harness, this.storageId, list, context);
	}

	private async requestDashboard(params: RequestParams | undefined, context: Context): Promise<unknown> {
		const conversationId = requestPositiveId(params?.conversationId, "conversationId");
		const owner = this.classifyOwner();
		return readDashboard(
			this.harness,
			this.storageId,
			conversationId === undefined ? {} : { conversationId: conversationId as ConversationId },
			{ storage: this.storage, owner: owner.owner, ...(owner.label === undefined ? {} : { ownerLabel: owner.label }), ...optionalParam("cwd", requestString(params, "cwd")) },
			context,
		);
	}

	private async requestReceipts(params: RequestParams | undefined, context: Context): Promise<unknown> {
		if (requestBoolean(params, "wait") === true) throw new TypeError("a cold snapshot cannot wait for receipts");
		const ownerId = requestRequiredString(params, "ownerId");
		const deliveries = await undeliveredForOwner(this.harness, ownerId, context);
		const usages = new Map<ConversationId, unknown>();
		const receipts = [];
		for (const receipt of deliveries.receipts) {
			if (!usages.has(receipt.conversationId)) usages.set(receipt.conversationId, (await this.harness.snapshot(UsageDoc, receipt.conversationId, context)) ?? null);
			receipts.push({ ...receipt, identity: durableIdentity(this.storageId, receipt.conversationId === 1 ? undefined : receipt.conversationId), usage: usages.get(receipt.conversationId) });
		}
		return { receipts, reports: deliveries.reports, pending: await pendingDeliveries(this.harness, ownerId, context) };
	}

	/**
	 * The live host's read-only request surface over a cold snapshot: inspect,
	 * status, list, dashboard, snapshot, and receipts. External IDs and parameter
	 * parsing are identical to `DurableHost.request`; write methods reject.
	 */
	async request(method: string, params?: RequestParams, context: Context = BACKGROUND_CONTEXT): Promise<unknown> {
			if (method === "profile-read") {
				const { readProfile } = await import("./profile.ts");
				const conversation = await this.target(params, context);
				return readProfile(this.harness, this.storageId, conversation.id, context, false);
			}
			if (method === "collaboration-read" || method === "collaboration-list") {
				const { readCollaboration, listCollaboration } = await import("./collaboration.ts");
				return method === "collaboration-read" ? readCollaboration(this.harness, params ?? {}, context) : listCollaboration(this.harness, params ?? {}, context);
			}
			switch (method) {
				case "inspect": {
					const conversation = await this.target(params, context);
					return readInspection(this.harness, this.storageId, conversation, parseInspectParams(params), context, { owner: this.classifyOwner().owner });
				}
			case "status":
				return this.requestStatus(params, context);
			case "list":
				return this.requestList(params, context);
			case "dashboard":
				return this.requestDashboard(params, context);
			case "snapshot": {
				if (this.absent) {
					resolveSessionConversationId(this.storageId, requestString(params, "sessionId"), requestPositiveId(params?.conversationId, "conversationId"));
					parseConversationSnapshotParams(params);
					return emptyConversationSnapshot();
				}
				const conversation = await this.target(params, context);
				return readConversationSnapshotPage(this.harness, conversation.id, parseConversationSnapshotParams(params), context);
			}
			case "receipts":
				return this.requestReceipts(params, context);
			default:
				throw new TypeError(`cold observation does not support ${method}`);
		}
	}

	async close(): Promise<void> {
		await this.release();
	}
}

/** Read-only inspection over a live Harness that the caller already owns. */
export function inspectionReader(harness: Harness, storageId: string): {
	list(params: DurableListParams, context: Context): Promise<{ readonly items: readonly ConversationSummary[]; readonly next: Cursor | null }>;
	status(conversationId: ConversationId, options: DurableStatusOptions, context: Context): Promise<ConversationStatus | undefined>;
	inspect(conversation: Conversation, params: DurableInspectParams, context: Context): Promise<unknown>;
	receipts(ownerId: string | undefined, context: Context): Promise<readonly DeliveryReceipt[]>;
	usage(context: Context): Promise<UsageState>;
} {
	return {
		list: (params, context) => readConversationList(harness, storageId, params, context),
		status: (conversationId, options, context) => readConversationStatus(harness, storageId, conversationId, options, context),
		inspect: (conversation, params, context) => readInspection(harness, storageId, conversation, params, context),
		receipts: (ownerId, context) => readReceipts(harness, ownerId, context),
		usage: (context) => readUsage(harness, context),
	};
}
