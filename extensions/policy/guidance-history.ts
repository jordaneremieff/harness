/**
 * Persistent placement of context guidance in the active request history.
 *
 * Each record freezes its text and the observation pins behind it, and names
 * one conversation message as its anchor by the stable identity of the
 * contribution that produced it (entry id and contribution index) plus a content
 * digest. Later requests project every record immediately after that same
 * message, wherever it now sits in the request, so guidance already sent keeps
 * its bytes while later conversation messages continue to append. Records never
 * move to a new tail and are never evicted while their anchor is active.
 */
import { createHash } from "node:crypto";
import {
	GUIDANCE_BYTES,
	GUIDANCE_PREFIX,
	type ProgramEvaluation,
	PROGRAM_LIMITS,
} from "./program.ts";
import type { ObservationState, StatePin } from "./state.ts";

/** Bounds for one active context's retained guidance. */
export const GUIDANCE_HISTORY_LIMITS = { records: 128, bytes: 256 * 1024 } as const;

/** Custom entry type for ordinary sessions. The entry stays out of LLM context. */
export const GUIDANCE_ENTRY = "policy_guidance";

/** Health state published by the projection. */
export type GuidanceStatus = "ok" | "capacity" | "anchor-mismatch" | "persistence-failed";

/** One model-visible message and the stable identity of the contribution that produced it. */
export interface GuidanceSource {
	readonly entryId: string;
	readonly contribution: number;
	readonly message: unknown;
}

export interface GuidanceAnchor {
	/** The context epoch in which the record was created. */
	readonly epoch: string;
	readonly entryId: string;
	readonly contribution: number;
	readonly messageDigest: string;
}

/** The epoch of the current request and the last epoch the ledger was checked against. */
export interface GuidanceEpochs {
	readonly epoch: string;
	/** Absent when the ledger was just restored and has no earlier check. */
	readonly validatedEpoch: string | undefined;
}

export interface GuidanceRecord {
	readonly id: string;
	readonly anchor: GuidanceAnchor;
	readonly timestamp: number;
	readonly text: string;
	readonly pins: readonly StatePin[];
}

export interface GuidanceHistory {
	readonly records: readonly GuidanceRecord[];
	readonly retainedBytes: number;
}

export interface PreparedGuidance {
	readonly text: string;
	readonly pins: readonly StatePin[];
}

export interface PreparedGuidanceSelection extends PreparedGuidance {
	/** Rule ids whose allowance this text consumes only after persistence. */
	readonly ids: readonly string[];
}

/** The frozen message a record projects. */
export interface GuidanceMessage {
	role: "user";
	content: Array<{ type: "text"; text: string }>;
	timestamp: number;
}

export interface GuidanceProjection<M> {
	readonly messages: Array<M | GuidanceMessage>;
	/** Records whose anchor still names the same message. */
	readonly retained: GuidanceRecord[];
	/** Records whose source contribution was removed or replaced across an epoch boundary. */
	readonly retired: GuidanceRecord[];
	/** Records that cannot be placed: a source lost inside the validated epoch, or an ambiguous request mapping. */
	readonly mismatched: GuidanceRecord[];
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function safeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** Deterministic JSON shape for digests and record identity. */
function canonical(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonical);
	if (value !== null && typeof value === "object") {
		const source = value as Record<string, unknown>;
		const ordered: Record<string, unknown> = {};
		for (const key of Object.keys(source).sort()) {
			const child = source[key];
			if (child === undefined) continue;
			ordered[key] = canonical(child);
		}
		return ordered;
	}
	return value;
}

/** Bounded terminal-safe guidance text with one shared byte allowance. */
export function guidanceText(lines: readonly string[]): string | undefined {
	let text = GUIDANCE_PREFIX;
	for (const line of new Set(lines)) {
		const safe = line
			.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
			.replace(/\s+/g, " ")
			.trim();
		if (!safe) continue;
		if (Buffer.byteLength(`${text} ${safe}`, "utf8") > GUIDANCE_BYTES) break;
		text += ` ${safe}`;
	}
	return text === GUIDANCE_PREFIX ? undefined : text;
}

/** Select eligible guide text without consuming any observation allowance. */
export function prepareGuidanceSelection(
	evaluations: readonly ProgramEvaluation[],
	state: ObservationState,
	now: number,
	turn: number,
): PreparedGuidanceSelection | undefined {
	const selected: ProgramEvaluation[] = [];
	const lines: string[] = [];
	for (const entry of evaluations) {
		if (entry.action.kind !== "guide" || entry.truth !== true) continue;
		if (!state.eligible(entry.id, now, turn)) continue;
		const next = guidanceText([...lines, entry.action.text]);
		if (next === guidanceText(lines)) continue;
		lines.push(entry.action.text);
		selected.push(entry);
	}
	const text = guidanceText(lines);
	if (!text) return undefined;
	const pins: StatePin[] = [];
	const ids: string[] = [];
	for (const entry of selected) {
		const pin = state.pin(entry.id);
		if (!pin) continue;
		pins.push(pin);
		ids.push(entry.id);
	}
	return { text, pins, ids };
}

/** Select guidance text and the pins that identify its source observations. */
export function prepareGuidance(
	evaluations: readonly ProgramEvaluation[],
	state: ObservationState,
	now: number,
	turn: number,
): PreparedGuidance | undefined {
	return prepareGuidanceSelection(evaluations, state, now, turn);
}

/** SHA-256 of one message's canonical JSON. */
export function messageDigest(message: unknown): string {
	return createHash("sha256")
		.update(JSON.stringify(canonical(message)))
		.digest("hex");
}

function singleText(message: { content?: unknown }): string | undefined {
	const content = message.content;
	if (!Array.isArray(content) || content.length !== 1) return undefined;
	const block = objectValue(content[0]);
	return block?.type === "text" && typeof block.text === "string" ? block.text : undefined;
}

function ownMessageMatcher(records: readonly GuidanceRecord[]): (message: { role: string }) => boolean {
	const keys = new Set(records.map((record) => `${record.timestamp}\u0000${record.text}`));
	return (message) => {
		const text = message.role === "user" ? singleText(message as { content?: unknown }) : undefined;
		const timestamp = (message as { timestamp?: unknown }).timestamp;
		return text !== undefined && typeof timestamp === "number" && keys.has(`${timestamp}\u0000${text}`);
	};
}

function basePositions<M extends { role: string }>(messages: readonly M[], isOwn: (message: M) => boolean): number[] {
	const indexes: number[] = [];
	for (let index = 0; index < messages.length; index++) {
		const message = messages[index];
		if (!message || message.role === "system") continue;
		if (isOwn(message)) continue;
		indexes.push(index);
	}
	return indexes;
}

function safeDigest(message: unknown): string {
	try {
		return message === undefined ? "" : messageDigest(message);
	} catch {
		return "";
	}
}

/** Cheap grouping key: equal messages always share it, so only a group's members need hashing. */
function messageKey(message: unknown): string {
	const record = objectValue(message);
	const timestamp = record?.timestamp;
	return `${typeof record?.role === "string" ? record.role : ""}\u0000${typeof timestamp === "number" ? timestamp : ""}`;
}

function sourceRef(entryId: string, contribution: number): string {
	return `${entryId}\u0000${contribution}`;
}

/** The most request messages one tail search inspects. */
const TAIL_CANDIDATES = 16;

/**
 * Resolves contributions of the conversation to positions in one request. A
 * message is located only when the contributions and the request messages with
 * the same content are equally many, matched in order; otherwise the mapping is
 * ambiguous and nothing is guessed. Request-only messages never take part.
 */
class RequestLocator {
	private readonly refs = new Map<string, number>();
	private readonly sourceGroups = new Map<string, number[]>();
	private readonly requestGroups = new Map<string, number[]>();
	private readonly sourceDigests = new Map<number, string>();
	private readonly requestDigests = new Map<number, string>();
	readonly positions: readonly number[];
	private readonly messages: readonly unknown[];
	private readonly sources: readonly GuidanceSource[];

	constructor(messages: readonly unknown[], sources: readonly GuidanceSource[], positions: readonly number[]) {
		this.messages = messages;
		this.sources = sources;
		this.positions = positions;
		for (let index = 0; index < sources.length; index++) {
			const source = sources[index];
			if (!source) continue;
			const message = objectValue(source.message);
			if (!message || message.role === "system") continue;
			this.refs.set(sourceRef(source.entryId, source.contribution), index);
			const key = messageKey(message);
			const group = this.sourceGroups.get(key);
			if (group) group.push(index);
			else this.sourceGroups.set(key, [index]);
		}
		for (const position of positions) {
			const key = messageKey(messages[position]);
			const group = this.requestGroups.get(key);
			if (group) group.push(position);
			else this.requestGroups.set(key, [position]);
		}
	}

	sourceIndex(anchor: GuidanceAnchor): number | undefined {
		return this.refs.get(sourceRef(anchor.entryId, anchor.contribution));
	}

	sourceDigest(index: number): string {
		let digest = this.sourceDigests.get(index);
		if (digest === undefined) {
			digest = safeDigest(this.sources[index]?.message);
			this.sourceDigests.set(index, digest);
		}
		return digest;
	}

	private requestDigest(position: number): string {
		let digest = this.requestDigests.get(position);
		if (digest === undefined) {
			digest = safeDigest(this.messages[position]);
			this.requestDigests.set(position, digest);
		}
		return digest;
	}

	/** Contributions and request positions that carry exactly this content. */
	private equal(key: string, digest: string): { sources: number[]; requests: number[] } {
		return {
			sources: (this.sourceGroups.get(key) ?? []).filter((index) => this.sourceDigest(index) === digest),
			requests: (this.requestGroups.get(key) ?? []).filter((position) => this.requestDigest(position) === digest),
		};
	}

	/** The request position of one contribution, or undefined when the mapping is ambiguous. */
	positionOf(index: number): number | undefined {
		const digest = this.sourceDigest(index);
		if (!digest) return undefined;
		const { sources, requests } = this.equal(messageKey(this.sources[index]?.message), digest);
		if (sources.length !== requests.length) return undefined;
		const rank = sources.indexOf(index);
		return rank < 0 ? undefined : requests[rank];
	}

	/** The contribution behind one request position, or undefined for a request-only or ambiguous message. */
	sourceAt(position: number): number | undefined {
		const digest = this.requestDigest(position);
		if (!digest) return undefined;
		const { sources, requests } = this.equal(messageKey(this.messages[position]), digest);
		if (sources.length !== requests.length) return undefined;
		const rank = requests.indexOf(position);
		return rank < 0 ? undefined : sources[rank];
	}

	/** The anchor after the newest request message that has exactly one source contribution. */
	tailAnchor(epoch: string): GuidanceAnchor | undefined {
		for (let step = 0; step < TAIL_CANDIDATES; step++) {
			const position = this.positions[this.positions.length - 1 - step];
			if (position === undefined) return undefined;
			const index = this.sourceAt(position);
			const source = index === undefined ? undefined : this.sources[index];
			if (index === undefined || !source) continue;
			return {
				epoch,
				entryId: source.entryId,
				contribution: source.contribution,
				messageDigest: this.sourceDigest(index),
			};
		}
		return undefined;
	}
}

/** The frozen user message for one record. */
export function guidanceMessage(record: GuidanceRecord): GuidanceMessage {
	return {
		role: "user",
		content: [{ type: "text", text: record.text }],
		timestamp: record.timestamp,
	};
}

/** Deterministic identity for one record at one anchor. */
export function guidanceRecordId(
	epoch: string,
	anchor: GuidanceAnchor,
	pins: readonly StatePin[],
	text: string,
): string {
	return createHash("sha256")
		.update(
			JSON.stringify(
				canonical({
					epoch,
					entryId: anchor.entryId,
					contribution: anchor.contribution,
					digest: anchor.messageDigest,
					pins: pins
						.map(({ id, revision, generation }) => ({ id, revision, generation }))
						.sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)),
					text,
				}),
			),
		)
		.digest("hex");
}

/** Build the record for one prepared selection at one anchor. */
export function guidanceRecord(
	anchor: GuidanceAnchor,
	timestamp: number,
	prepared: PreparedGuidance,
): GuidanceRecord {
	return {
		id: guidanceRecordId(anchor.epoch, anchor, prepared.pins, prepared.text),
		anchor,
		timestamp,
		text: prepared.text,
		pins: prepared.pins,
	};
}

/** Serialized size of one record, including its metadata. */
export function guidanceRecordBytes(record: GuidanceRecord): number {
	return Buffer.byteLength(JSON.stringify(record), "utf8");
}

/** A deduplicated history and its byte total. */
export function guidanceHistory(records: readonly GuidanceRecord[]): GuidanceHistory {
	const seen = new Set<string>();
	const retained: GuidanceRecord[] = [];
	let retainedBytes = 0;
	for (const record of records) {
		if (seen.has(record.id)) continue;
		seen.add(record.id);
		retained.push(record);
		retainedBytes += guidanceRecordBytes(record);
	}
	return { records: retained, retainedBytes };
}

/** Append one record without evicting an existing one. */
export function appendGuidance(
	history: GuidanceHistory,
	record: GuidanceRecord,
): { history: GuidanceHistory; status: "appended" | "present" | "capacity" } {
	if (history.records.some((entry) => entry.id === record.id)) return { history, status: "present" };
	const bytes = guidanceRecordBytes(record);
	if (
		history.records.length >= GUIDANCE_HISTORY_LIMITS.records ||
		history.retainedBytes + bytes > GUIDANCE_HISTORY_LIMITS.bytes
	)
		return { history, status: "capacity" };
	return {
		history: { records: [...history.records, record], retainedBytes: history.retainedBytes + bytes },
		status: "appended",
	};
}

function parseAnchor(value: unknown): GuidanceAnchor | undefined {
	const anchor = objectValue(value);
	if (!anchor) return undefined;
	const { epoch, entryId, contribution, messageDigest: digest } = anchor;
	if (typeof epoch !== "string" || !epoch || epoch.length > 512) return undefined;
	if (typeof entryId !== "string" || !entryId || entryId.length > 256) return undefined;
	if (!safeInteger(contribution)) return undefined;
	if (typeof digest !== "string" || !/^[a-f0-9]{64}$/.test(digest)) return undefined;
	return { epoch, entryId, contribution, messageDigest: digest };
}

function parsePin(value: unknown): StatePin | undefined {
	const pin = objectValue(value);
	if (!pin || typeof pin.id !== "string" || !pin.id) return undefined;
	if (typeof pin.revision !== "string" || !pin.revision || !safeInteger(pin.generation)) return undefined;
	return { id: pin.id, revision: pin.revision, generation: pin.generation };
}

function parsePins(value: unknown): StatePin[] | undefined {
	if (!Array.isArray(value) || value.length > PROGRAM_LIMITS.rules) return undefined;
	const pins: StatePin[] = [];
	for (const raw of value) {
		const pin = parsePin(raw);
		if (!pin) return undefined;
		pins.push(pin);
	}
	return pins;
}

/** Validate one stored record. */
export function parseGuidanceRecord(value: unknown): GuidanceRecord | undefined {
	const entry = objectValue(value);
	if (!entry) return undefined;
	if (typeof entry.id !== "string" || !entry.id || entry.id.length > 128) return undefined;
	if (typeof entry.timestamp !== "number" || !Number.isFinite(entry.timestamp) || entry.timestamp < 0)
		return undefined;
	const text = entry.text;
	if (typeof text !== "string" || !text || Buffer.byteLength(text, "utf8") > GUIDANCE_HISTORY_LIMITS.bytes)
		return undefined;
	const anchor = parseAnchor(entry.anchor);
	const pins = parsePins(entry.pins);
	if (!anchor || !pins) return undefined;
	return { id: entry.id, anchor, timestamp: entry.timestamp, text, pins };
}

interface Placement {
	readonly retained: GuidanceRecord[];
	readonly retired: GuidanceRecord[];
	readonly mismatched: GuidanceRecord[];
	readonly insertions: Map<number, GuidanceRecord[]>;
}

/**
 * Match each record to its source contribution. A removed or replaced source
 * retires its record when the epoch changed since the ledger was last checked;
 * inside that epoch it is a projection fault. Only the messages actually
 * referenced, and the messages equal to them, are hashed.
 */
function placeRecords(locator: RequestLocator, history: GuidanceHistory, epochs: GuidanceEpochs): Placement {
	const placement: Placement = { retained: [], retired: [], mismatched: [], insertions: new Map() };
	const boundary = epochs.validatedEpoch !== epochs.epoch;
	for (const record of history.records) {
		const index = locator.sourceIndex(record.anchor);
		if (index === undefined || locator.sourceDigest(index) !== record.anchor.messageDigest) {
			(boundary ? placement.retired : placement.mismatched).push(record);
			continue;
		}
		const position = locator.positionOf(index);
		if (position === undefined) {
			placement.mismatched.push(record);
			continue;
		}
		placement.retained.push(record);
		const bucket = placement.insertions.get(position);
		if (bucket) bucket.push(record);
		else placement.insertions.set(position, [record]);
	}
	return placement;
}

function project<M extends { role: string }>(
	messages: readonly M[],
	locator: RequestLocator,
	history: GuidanceHistory,
	epochs: GuidanceEpochs,
): GuidanceProjection<M> {
	const placement = placeRecords(locator, history, epochs);
	const projected: Array<M | GuidanceMessage> = [];
	for (let index = 0; index < messages.length; index++) {
		const message = messages[index];
		if (message !== undefined) projected.push(message);
		for (const record of placement.insertions.get(index) ?? []) projected.push(guidanceMessage(record));
	}
	return {
		messages: projected,
		retained: placement.retained,
		retired: placement.retired,
		mismatched: placement.mismatched,
	};
}

function locatorFor<M extends { role: string }>(
	messages: readonly M[],
	sources: readonly GuidanceSource[],
	history: GuidanceHistory,
	isOwn?: (message: M) => boolean,
): RequestLocator {
	return new RequestLocator(
		messages,
		sources,
		basePositions(messages, isOwn ?? ownMessageMatcher(history.records)),
	);
}

/**
 * Insert every record after its source message. System messages and system
 * patches keep their original relative order. A record whose source was removed
 * or replaced across an epoch boundary is retired; one that cannot be placed
 * inside the validated epoch, or whose request mapping is ambiguous, is reported
 * as a projection fault. No case guesses a new position.
 */
export function projectGuidance<M extends { role: string }>(
	messages: readonly M[],
	sources: readonly GuidanceSource[],
	history: GuidanceHistory,
	epochs: GuidanceEpochs,
	isOwn?: (message: M) => boolean,
): GuidanceProjection<M> {
	return project(messages, locatorFor(messages, sources, history, isOwn), history, epochs);
}

/** One request's guidance decision, before any record is persisted. */
export interface GuidancePlan<M> {
	/** Records to keep, with any mismatched record held in place rather than dropped. */
	readonly history: GuidanceHistory;
	/** The request with the existing records projected. */
	readonly messages: Array<M | GuidanceMessage>;
	readonly status: GuidanceStatus;
	/** A new record the caller may persist; absent when nothing new is allowed or selected. */
	readonly addition?: {
		readonly record: GuidanceRecord;
		readonly prepared: PreparedGuidanceSelection;
		readonly history: GuidanceHistory;
		readonly messages: Array<M | GuidanceMessage>;
	};
}

/**
 * Project existing records and, when the placement is healthy and a selection
 * exists, describe the one new record to persist. The caller consumes the
 * selection's allowance only after persisting the addition.
 */
export function planGuidance<M extends { role: string }>(
	messages: readonly M[],
	sources: readonly GuidanceSource[],
	stored: GuidanceHistory,
	epochs: GuidanceEpochs,
	select: (() => PreparedGuidanceSelection | undefined) | undefined,
	now: number,
): GuidancePlan<M> {
	const locator = locatorFor(messages, sources, stored);
	const existing = project(messages, locator, stored, epochs);
	const faulted = existing.mismatched.length > 0;
	const history = guidanceHistory(faulted ? [...existing.retained, ...existing.mismatched] : existing.retained);
	const base = { history, messages: existing.messages };
	if (faulted) return { ...base, status: "anchor-mismatch" };
	const prepared = select?.();
	const anchor = prepared ? locator.tailAnchor(epochs.epoch) : undefined;
	if (!prepared || !anchor) return { ...base, status: "ok" };
	const record = guidanceRecord(anchor, now, prepared);
	const appended = appendGuidance(history, record);
	if (appended.status === "capacity") return { ...base, status: "capacity" };
	if (appended.status === "present") return { ...base, status: "ok" };
	return {
		...base,
		status: "ok",
		addition: {
			record,
			prepared,
			history: appended.history,
			messages: project(messages, locator, appended.history, epochs).messages,
		},
	};
}
