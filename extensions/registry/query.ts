/**
 * Query parsing, deterministic paging, and cursor continuation.
 *
 * A cursor carries its own query, so continuation accepts no new selectors. It
 * also carries the evidence stamps a resumed page depends on: the session epoch,
 * a fingerprint over the ordered record identities, and — for a content query —
 * the scanned file's own stamp. A change to any of them invalidates the cursor
 * with `stale_cursor` rather than silently paging a different corpus.
 */

import { createHash } from "node:crypto";
import { compareRecords, RESOURCE_KINDS, type ResourceRecord } from "./records.ts";

export const NAME_MIN = 1;
export const NAME_MAX = 256;
export const CONTAINS_MIN = 1;
export const CONTAINS_MAX = 1024;
export const LIMIT_MIN = 1;
export const LIMIT_MAX = 100;
export const LIMIT_DEFAULT = 20;
export const CURSOR_MAX_BYTES = 16 * 1024;

export type MatchMode = "exact" | "substring";
export const QUERY_KINDS = [...RESOURCE_KINDS, "model", "context_file"] as const;
export type QueryKind = (typeof QUERY_KINDS)[number];

export interface Query {
	name?: string;
	match: MatchMode;
	kind?: QueryKind;
	search?: string;
	detail?: boolean;
	provider?: string;
	available?: boolean;
	contains?: string;
	limit: number;
}

/** Identity of a scanned file at the moment it was read. */
export interface FileStamp {
	path: string;
	size: number;
	mtimeMs: number;
	ctimeMs: number;
	ino: number;
	dev: number;
	digest: string;
}

export interface CursorState {
	query: Query;
	offset: number;
	fingerprint: string;
	epoch: string;
	file?: FileStamp;
}

export interface RawParams {
	name?: string;
	match?: string;
	kind?: string;
	search?: string;
	detail?: boolean;
	provider?: string;
	available?: boolean;
	contains?: string;
	limit?: number;
	cursor?: string;
}

export class QueryError extends Error {
	readonly reason: "invalid_arguments" | "stale_cursor";
	constructor(reason: "invalid_arguments" | "stale_cursor", message: string) {
		super(message);
		this.reason = reason;
		this.name = "QueryError";
	}
}

const SELECTOR_KEYS = ["name", "match", "kind", "contains", "limit", "search", "detail", "provider", "available"] as const;

export function hasAnySelector(params: RawParams): boolean {
	return SELECTOR_KEYS.some((key) => params[key] !== undefined);
}

/** Parse a fresh (non-cursor) request. Schema bounds are re-checked here so the
 * pure query layer is safe to test and reuse without the tool schema. */
export function parseQuery(params: RawParams): Query {
	if (!params || typeof params !== "object" || Array.isArray(params) ||
		Object.keys(params).some((key) => ![...SELECTOR_KEYS, "cursor"].includes(key))) {
		throw new QueryError("invalid_arguments", "arguments must contain only documented fields");
	}
	if (params.name !== undefined) {
		if (typeof params.name !== "string" || params.name.length < NAME_MIN || params.name.length > NAME_MAX) {
			throw new QueryError("invalid_arguments", `name must be ${NAME_MIN}-${NAME_MAX} characters`);
		}
	}
	if (params.contains !== undefined) {
		if (
			typeof params.contains !== "string" ||
			params.contains.length < CONTAINS_MIN ||
			params.contains.length > CONTAINS_MAX
		) {
			throw new QueryError("invalid_arguments", `contains must be ${CONTAINS_MIN}-${CONTAINS_MAX} characters`);
		}
	}
	if (params.match !== undefined && params.match !== "exact" && params.match !== "substring") {
		throw new QueryError("invalid_arguments", `match must be "exact" or "substring"`);
	}
	if (params.kind !== undefined && !(QUERY_KINDS as readonly string[]).includes(params.kind)) {
		throw new QueryError("invalid_arguments", `kind must be one of ${QUERY_KINDS.join(", ")}`);
	}
	for (const key of ["search", "provider"] as const) {
		const value = params[key];
		if (value !== undefined && (typeof value !== "string" || value.length < 1 || value.length > NAME_MAX)) {
			throw new QueryError("invalid_arguments", `${key} must be 1-${NAME_MAX} characters`);
		}
	}
	for (const key of ["detail", "available"] as const) {
		if (params[key] !== undefined && typeof params[key] !== "boolean") {
			throw new QueryError("invalid_arguments", `${key} must be boolean`);
		}
	}
	if (params.detail !== undefined && (params.kind !== "tool" || params.name === undefined ||
		(params.match !== undefined && params.match !== "exact") || params.contains !== undefined || params.search !== undefined)) {
		throw new QueryError("invalid_arguments", "detail requires kind tool and an exact name, without search or contains");
	}
	if ((params.provider !== undefined || params.available !== undefined) && params.kind !== "model") {
		throw new QueryError("invalid_arguments", "provider and available require kind model");
	}
	if (params.contains !== undefined && (params.kind === "model" || params.kind === "context_file")) {
		throw new QueryError("invalid_arguments", "contains accepts only file-backed skills or prompts");
	}
	let limit = LIMIT_DEFAULT;
	if (params.limit !== undefined) {
		if (!Number.isInteger(params.limit) || params.limit < LIMIT_MIN || params.limit > LIMIT_MAX) {
			throw new QueryError("invalid_arguments", `limit must be an integer ${LIMIT_MIN}-${LIMIT_MAX}`);
		}
		limit = params.limit;
	}
	const query: Query = { match: (params.match as MatchMode) ?? "exact", limit };
	if (params.name !== undefined) query.name = params.name;
	if (params.kind !== undefined) query.kind = params.kind as QueryKind;
	if (params.contains !== undefined) query.contains = params.contains;
	if (params.search !== undefined) query.search = params.search;
	if (params.detail !== undefined) query.detail = params.detail;
	if (params.provider !== undefined) query.provider = params.provider;
	if (params.available !== undefined) query.available = params.available;
	return query;
}

/** Case-sensitive name comparison; a skill also answers to its invocation name. */
export function matchesName(record: ResourceRecord, query: Query): boolean {
	if (query.name === undefined) return true;
	const candidates = [record.name];
	if (record.invocation !== undefined) {
		candidates.push(record.invocation, record.invocation.replace(/^\//, ""));
	}
	return query.match === "exact"
		? candidates.includes(query.name)
		: candidates.some((candidate) => candidate.includes(query.name as string));
}

export function selectRecords(records: ResourceRecord[], query: Query): ResourceRecord[] {
	const search = query.search?.toLowerCase();
	return records
		.filter((record) => (query.kind === undefined || record.kind === query.kind) && matchesName(record, query) &&
			(search === undefined || [record.name, record.description ?? "",
				...(record.kind === "tool" ? record.promptGuidelines ?? [] : [])]
				.some((value) => value.toLowerCase().includes(search))))
		.sort(compareRecords);
}

/** Fingerprint over ordered record identities. Any add, removal, rename, or
 * source change moves it, which invalidates outstanding cursors. */
export function fingerprintRecords(records: ResourceRecord[]): string {
	const hash = createHash("sha256");
	for (const record of [...records].sort(compareRecords)) {
		const { at: _at, ...metadata } = record;
		hash.update(JSON.stringify(metadata));
		hash.update(record.kind);
		hash.update("\u0000");
		hash.update(record.name);
		hash.update("\u0000");
		hash.update(record.sourceInfo.source);
		hash.update("\u0000");
		hash.update(record.sourceInfo.path);
		hash.update("\u0000");
		hash.update(record.sourceInfo.scope);
		hash.update("\u0000");
		hash.update(record.sourceInfo.origin);
		hash.update("\u0000");
		hash.update(record.sourceInfo.baseDir ?? "");
		hash.update("\u001e");
	}
	return hash.digest("hex").slice(0, 32);
}

export function stampsEqual(a: FileStamp | undefined, b: FileStamp | undefined): boolean {
	if (a === undefined && b === undefined) return true;
	if (a === undefined || b === undefined) return false;
	return a.path === b.path && a.size === b.size && a.mtimeMs === b.mtimeMs &&
		a.ctimeMs === b.ctimeMs && a.ino === b.ino && a.dev === b.dev && a.digest === b.digest;
}

export function encodeCursor(state: CursorState): string {
	const payload = {
		v: 1,
		q: state.query,
		o: state.offset,
		f: state.fingerprint,
		e: state.epoch,
		...(state.file ? { s: state.file } : {}),
	};
	const cursor = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
	if (Buffer.byteLength(cursor, "utf8") > CURSOR_MAX_BYTES) {
		throw new QueryError("invalid_arguments", "source metadata exceeds the continuation bound");
	}
	return cursor;
}

export function decodeCursor(cursor: string): CursorState {
	if (typeof cursor !== "string" || cursor.length === 0) {
		throw new QueryError("invalid_arguments", "cursor must be non-empty text");
	}
	if (Buffer.byteLength(cursor, "utf8") > CURSOR_MAX_BYTES) {
		throw new QueryError("invalid_arguments", `cursor exceeds ${CURSOR_MAX_BYTES} bytes`);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
	} catch {
		throw new QueryError("invalid_arguments", "cursor is not a cursor this tool issued");
	}
	if (typeof parsed !== "object" || parsed === null) {
		throw new QueryError("invalid_arguments", "cursor is not a cursor this tool issued");
	}
	const raw = parsed as Record<string, unknown>;
	if (raw.v !== 1 || typeof raw.f !== "string" || typeof raw.e !== "string" || raw.e.length === 0 ||
		!Number.isSafeInteger(raw.o) || (raw.o as number) < 0) {
		throw new QueryError("invalid_arguments", "cursor is not a cursor this tool issued");
	}
	const encoded = raw.q as RawParams | undefined;
	if (typeof encoded !== "object" || encoded === null) {
		throw new QueryError("invalid_arguments", "cursor carries no query");
	}
	const query = parseQuery(encoded);
	const state: CursorState = {
		query,
		offset: raw.o as number,
		fingerprint: raw.f,
		epoch: raw.e,
	};
	const stamp = raw.s as FileStamp | undefined;
	if (raw.s !== undefined) {
		if (!stamp || typeof stamp.path !== "string" || typeof stamp.digest !== "string" ||
			![stamp.size, stamp.mtimeMs, stamp.ctimeMs, stamp.ino, stamp.dev].every(Number.isFinite) || stamp.size < 0) {
			throw new QueryError("invalid_arguments", "cursor carries an invalid file stamp");
		}
		state.file = { path: stamp.path, size: stamp.size, mtimeMs: stamp.mtimeMs,
			ctimeMs: stamp.ctimeMs, ino: stamp.ino, dev: stamp.dev, digest: stamp.digest };
	}
	return state;
}

export interface Page<T> {
	items: T[];
	total: number;
	offset: number;
	nextOffset: number | null;
}

export function paginate<T>(items: T[], offset: number, limit: number): Page<T> {
	const start = Math.min(offset, items.length);
	const slice = items.slice(start, start + limit);
	const end = start + slice.length;
	return { items: slice, total: items.length, offset: start, nextOffset: end < items.length ? end : null };
}
