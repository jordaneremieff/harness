import { createHash, randomBytes, randomUUID } from "node:crypto";
import { publishCatalogChange } from "./catalog-events.ts";
import {
	closeSync,
	constants,
	fstatSync,
	lstatSync,
	mkdirSync,
	openSync,
	readSync,
	renameSync,
	unlinkSync,
	writeFileSync,
	linkSync,
} from "node:fs";
import { opendir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { type CatalogView, parseCatalogView } from "./catalog-view.ts";
import { parseCollaborationProjection, type CollaborationProjection } from "./collaboration.ts";
import { observeClaim } from "./claims.ts";
import { isThinkingLevel } from "./configuration.ts";
import { type HostMetadata, hostPaths, parseHostMetadata } from "./host-protocol.ts";

import { handleSlug, handleStorageId } from "./identity.ts";
import { profileText } from "./profile.ts";

const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u;
const MAX_RECORD_BYTES = 32_768;
const MAX_VISITS = 256;
interface CatalogQuery {
	cursor?: string;
	limit?: number;
	query?: string;
	cwd?: string;
}
function requestStorageId(key: string): string {
	const hex = createHash("sha256").update(key).digest("hex").slice(0, 32);
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
function pageLimit(value: number | undefined): number {
	const limit = value ?? 20;
	if (!Number.isSafeInteger(limit) || limit < 1 || limit > 32)
		throw new Error("Catalog limit must be between 1 and 32");
	return limit;
}
function queryBinding(revision: string, options: CatalogQuery): string {
	return JSON.stringify([revision, options.query ?? "", options.cwd ?? ""]);
}
function startOffset(cursor: string | undefined, binding: string): number {
	if (!cursor) return 0;
	const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
	if (
		parsed.binding !== binding ||
		!Number.isSafeInteger(parsed.offset) ||
		parsed.offset < 0 ||
		parsed.offset > 1_000_000
	)
		throw new Error("Catalog changed or cursor does not match the query; restart discovery");
	return parsed.offset;
}
function matches(record: CatalogRecord, options: CatalogQuery): boolean {
	if (options.cwd && options.cwd !== record.cwd) return false;
	const query = options.query?.toLocaleLowerCase();
	return (
		!query || [record.storageId, record.cwd, record.name ?? ""].some((text) => text.toLocaleLowerCase().includes(query))
	);
}
async function directoryRevision(root: string): Promise<string | undefined> {
	try {
		const info = await stat(root);
		return `${info.ino}:${info.mtimeMs}`;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}
export interface CatalogRecord extends HostMetadata {
	createdAt: string;
	/** Optional bounded conversation projection; absent means the projection is unknown. */
	view?: CatalogView;
	/** Bounded discovery hints; native documents retain the full thread. */
	threads?: CollaborationProjection;
	/** Host-local marker: true before admission or resume, false only on a clean idle host with no deliveries. */
	recoveryDue?: boolean;
}
export function hostMetadata(record: CatalogRecord): HostMetadata {
	const { createdAt: _createdAt, view: _view, threads: _threads, recoveryDue: _recoveryDue, ...metadata } = record;
	return metadata;
}
export interface CatalogPage {
	records: CatalogRecord[];
	/** Continuation after each record, so a prefetched batch may stop before its end. */
	recordCursors: string[];
	nextCursor: string | null;
	coverage: { visited: number; skipped: number; complete: boolean };
	observedAt: string;
}

/** Result of one catalog create: the retained record and whether this call created it. */
export interface CatalogCreateResult {
	readonly record: CatalogRecord;
	/** True when this call wrote the record; false when the request ID reused a retained one. */
	readonly created: boolean;
}

/** Outcome of one guarded discard. Only `removed` changes state. */
export type CatalogDiscardResult = "removed" | "record-changed" | "storage-present" | "writer-present";

export function storageIdOf(identity: string): string {
	const [storageId, conversationId, extra] = identity.split(":");
	if (!UUID.test(storageId) || extra !== undefined || (conversationId !== undefined && !/^\d+$/u.test(conversationId)))
		throw new Error("Invalid Durable agent identity");
	return storageId;
}

/** Discovery metadata locates storage. It never substitutes for native conversation state. */
export class AgentCatalog {
	readonly root: string;
	constructor(root: string) {
		this.root = resolve(root, "durable");
	}
	create(input: Omit<HostMetadata, "storageId" | "storagePath">, requestId?: string): CatalogRecord {
		return this.createTracked(input, requestId).record;
	}

	/** Publish one complete handle claim without replacing a concurrent creator's record. */
	createHandled(input: Omit<HostMetadata, "storageId" | "storagePath">, handle: string, role: string): CatalogCreateResult {
		handleSlug(handle);
		profileText(role, "role");
		mkdirSync(this.root, { recursive: true, mode: 0o700 });
		const storageId = handleStorageId(handle, this.root);
		const metadata = parseHostMetadata({ ...input, storageId, storagePath: join(this.root, `${storageId}.sqlite`) });
		if (!isThinkingLevel(metadata.thinkingLevel)) throw new Error("Unknown reasoning level");
		const createdAt = new Date().toISOString();
		const record: CatalogRecord = { ...metadata, createdAt, view: { updatedAt: createdAt, storageId, rows: [], coverage: { complete: false, omitted: 1 }, profileSeed: { handle, role } } };
		const prepared = join(this.root, `.${storageId}.${randomUUID()}.claim`);
		writeFileSync(prepared, `${JSON.stringify(record)}\n`, { flag: "wx", mode: 0o600 });
		try {
			try { linkSync(prepared, this.path(storageId)); }
			catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
				return { record: this.read(storageId), created: false };
			}
		} finally { unlinkSync(prepared); }
		publishCatalogChange(this.root);
		return { record, created: true };
	}

	/**
	 * Create the record, or reuse the one retained for this request ID. The result
	 * marks whether this call owns the new record, so a caller can discard only
	 * its own record when the first acquire fails.
	 */
	createTracked(input: Omit<HostMetadata, "storageId" | "storagePath">, requestId?: string): CatalogCreateResult {
		mkdirSync(this.root, { recursive: true, mode: 0o700 });
		const storageId =
			requestId === undefined ? randomUUID() : requestStorageId(JSON.stringify([input.ownerId, requestId]));
		const metadata = parseHostMetadata({ ...input, storageId, storagePath: join(this.root, `${storageId}.sqlite`) });
		if (!isThinkingLevel(metadata.thinkingLevel)) throw new Error("Unknown reasoning level");
		const record: CatalogRecord = { ...metadata, createdAt: new Date().toISOString() };
		try {
			writeFileSync(this.path(storageId), `${JSON.stringify(record)}\n`, { flag: "wx", mode: 0o600 });
		} catch (error) {
			if (requestId === undefined || (error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			const previous = this.read(storageId);
			if (JSON.stringify(hostMetadata(previous)) !== JSON.stringify(metadata))
				throw new Error("Spawn request ID already belongs to different agent configuration");
			return { record: previous, created: false };
		}
		publishCatalogChange(this.root);
		return { record, created: true };
	}

	/**
	 * Remove a record this call created when its host never opened. The record
	 * must be byte-identical at the same inode, no storage file may exist, and
	 * the native writer claim must be absent or a proven dead local claim. A
	 * reused record, a live or unknown writer, or any changed path is kept.
	 * Call this only for a `created: true` result.
	 */
	discardUnopened(record: CatalogRecord): CatalogDiscardResult {
		const path = this.path(record.storageId);
		const before = this.readRaw(record.storageId);
		if (before === undefined || before.raw !== `${JSON.stringify(record)}\n`) return "record-changed";
		if (lstatSync(record.storagePath, { throwIfNoEntry: false }) !== undefined) return "storage-present";
		const paths = hostPaths(record);
		const observation = observeClaim(paths.claim, paths.identity);
		if (observation.kind === "live" || observation.kind === "unknown") return "writer-present";
		const current = lstatSync(path, { throwIfNoEntry: false });
		if (current === undefined || current.dev !== before.dev || current.ino !== before.ino) return "record-changed";
		unlinkSync(path);
		publishCatalogChange(this.root);
		return "removed";
	}
	path(identity: string): string {
		return join(this.root, `${storageIdOf(identity)}.json`);
	}
	read(identity: string): CatalogRecord {
		const storageId = storageIdOf(identity);
		const fd = openSync(this.path(storageId), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
		try {
			const info = fstatSync(fd);
			if (!info.isFile() || info.size > MAX_RECORD_BYTES)
				throw new Error("Agent metadata exceeds its bound or is not a regular file");
			const bytes = Buffer.alloc(MAX_RECORD_BYTES + 1);
			let length = 0;
			while (length < bytes.length) {
				const count = readSync(fd, bytes, length, bytes.length - length, length);
				if (!count) break;
				length += count;
			}
			if (length > MAX_RECORD_BYTES) throw new Error("Agent metadata exceeds its read bound");
			const value: unknown = JSON.parse(bytes.toString("utf8", 0, length));
			if (!value || typeof value !== "object") throw new Error("Agent metadata is invalid");
			const record = value as CatalogRecord;
			if (
				record.storageId !== storageId ||
				record.storagePath !== join(this.root, `${storageId}.sqlite`) ||
				typeof record.cwd !== "string" ||
				!record.cwd.startsWith("/") ||
				typeof record.agentDir !== "string" ||
				typeof record.packageDir !== "string" ||
				typeof record.createdAt !== "string" ||
				typeof record.model?.provider !== "string" ||
				typeof record.model?.modelId !== "string"
			)
				throw new Error("Agent metadata is invalid");
			parseHostMetadata(hostMetadata(record));
			if (!isThinkingLevel(record.thinkingLevel)) throw new Error("Agent metadata has an unknown reasoning level");
			this.parseProjections(record);
			if (record.recoveryDue !== undefined && typeof record.recoveryDue !== "boolean")
				throw new Error("Agent metadata has an invalid recovery marker");
			return record;
		} finally {
			closeSync(fd);
		}
	}

	/**
	 * Replace one record's bounded view, preserving every immutable field from
	 * the stored record. The caller owns the storage writer claim; a symlink,
	 * corrupt record, missing record, or wrong stored identity is refused.
	 */
	updateView(identity: string, view: CatalogView, threads?: CollaborationProjection): CatalogRecord {
		const record = this.read(identity);
		const parsed = parseCatalogView(view);
		this.checkViewIdentity(record.storageId, parsed);
		return this.rewrite({ ...record, view: parsed, ...(threads === undefined ? {} : { threads: parseCollaborationProjection(threads, record.storageId) }) });
	}

	private parseProjections(record: CatalogRecord): void {
		if (record.view !== undefined) record.view = this.observedView(record.storageId, record.view);
		if (record.threads !== undefined) record.threads = parseCollaborationProjection(record.threads, record.storageId);
	}

	/** Unknown cached values are unavailable observations, not alternate native state shapes. */
	private observedView(storageId: string, value: CatalogView): CatalogView {
		if (value?.storageId !== undefined && value.storageId !== storageId) throw new Error("Agent view storageId does not match its catalog record");
		if (Array.isArray(value?.rows)) this.checkViewIdentity(storageId, value);
		try { return parseCatalogView(value); }
		catch {
			const states = Array.isArray(value?.rows) ? value.rows.slice(0, 5).map((row) => String(row?.state).slice(0, 64)) : [];
			return { storageId, updatedAt: new Date().toISOString(), rows: [], coverage: { complete: false, omitted: 0 }, unavailable: `Host metadata is unsupported by this Pi (states: ${JSON.stringify(states)}). Restart this Pi if the host runs newer code. No cached state was interpreted.` };
		}
	}

	private checkViewIdentity(storageId: string, view: CatalogView): void {
		if ((view.storageId !== undefined && view.storageId !== storageId) || view.rows.some((row) => row.storageId !== storageId)) throw new Error("Agent view storageId does not match its catalog record");
	}

	/**
	 * Set the host-local recovery marker, preserving the view and every immutable
	 * field. The caller sets true before admission or resume and false only on a
	 * clean idle host with no deliveries.
	 */
	markRecoveryDue(identity: string, recoveryDue: boolean): CatalogRecord {
		if (typeof recoveryDue !== "boolean") throw new TypeError("recoveryDue must be a boolean");
		const record = this.read(identity);
		return this.rewrite({ ...record, recoveryDue });
	}

	/** Atomically replace one record; the caller owns the storage writer claim. */
	private rewrite(record: CatalogRecord): CatalogRecord {
		const text = `${JSON.stringify(record)}\n`;
		if (Buffer.byteLength(text, "utf8") > MAX_RECORD_BYTES) throw new Error("Agent metadata exceeds its bound");
		const path = this.path(record.storageId);
		const temporary = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
		writeFileSync(temporary, text, { flag: "wx", mode: 0o600 });
		try {
			renameSync(temporary, path);
		} catch (error) {
			try {
				unlinkSync(temporary);
			} catch {
				// The rename failure is retained.
			}
			throw error;
		}
		publishCatalogChange(this.root);
		return record;
	}

	/** Bounded, symlink-refusing read of one record with its file identity. */
	private readRaw(identity: string): { raw: string; dev: number; ino: number } | undefined {
		const storageId = storageIdOf(identity);
		let fd: number;
		try {
			fd = openSync(this.path(storageId), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
		} catch {
			return undefined;
		}
		try {
			const info = fstatSync(fd);
			if (!info.isFile() || info.size > MAX_RECORD_BYTES) return undefined;
			const bytes = Buffer.alloc(MAX_RECORD_BYTES + 1);
			let length = 0;
			while (length < bytes.length) {
				const count = readSync(fd, bytes, length, bytes.length - length, length);
				if (!count) break;
				length += count;
			}
			if (length > MAX_RECORD_BYTES) return undefined;
			return { raw: bytes.toString("utf8", 0, length), dev: info.dev, ino: info.ino };
		} catch {
			return undefined;
		} finally {
			closeSync(fd);
		}
	}

	private select(name: string, options: CatalogQuery): CatalogRecord | undefined {
		if (!name.endsWith(".json") || !UUID.test(name.slice(0, -5))) return;
		const record = this.read(name.slice(0, -5));
		return matches(record, options) ? record : undefined;
	}
	async page(options: CatalogQuery = {}): Promise<CatalogPage> {
		const limit = pageLimit(options.limit);
		const observedAt = new Date().toISOString();
		const revision = await directoryRevision(this.root);
		if (revision === undefined)
			return { records: [], recordCursors: [], nextCursor: null, coverage: { visited: 0, skipped: 0, complete: true }, observedAt };
		const binding = queryBinding(revision, options);
		const start = startOffset(options.cursor, binding);
		const records: CatalogRecord[] = [];
		const recordCursors: string[] = [];
		const cursorAt = (offset: number): string => Buffer.from(JSON.stringify({ binding, offset })).toString("base64url");
		let index = 0,
			visited = 0,
			skipped = 0,
			complete = true;
		const directory = await opendir(this.root);
		for await (const entry of directory) {
			if (index++ < start) continue;
			visited++;
			try {
				const record = entry.isFile() ? this.select(entry.name, options) : undefined;
				if (record) {
					records.push(record);
					recordCursors.push(cursorAt(index));
				}
			} catch {
				skipped++;
			}
			if (visited === MAX_VISITS || records.length === limit) {
				complete = false;
				break;
			}
		}
		const nextCursor = complete ? null : cursorAt(index);
		if (recordCursors.length > 0) recordCursors[recordCursors.length - 1] = cursorAt(index);
		return {
			records,
			recordCursors,
			nextCursor,
			coverage: { visited, skipped, complete },
			observedAt,
		};
	}
}
