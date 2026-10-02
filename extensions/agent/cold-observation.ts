/**
 * cold-observation: cached read-only inspection of one Durable storage file.
 *
 * A cold read does not boot the cwd-bound services, the model runtime, or the
 * extension set. It copies the source database through the public
 * `DurableObservation` snapshot path with an empty public registry and
 * `pi-ai`'s `createModels()`, because no read path calls a model or resolves a
 * configured extension. Native `AgentMetaDoc` and delivery documents load from
 * the shared slice modules, so the existing `snapshot`, `status`, `list`,
 * `dashboard`, `receipts`, and `inspect` views keep their exact schemas.
 *
 * One snapshot per storage path is kept while the source identity is unchanged.
 * The identity pins the database and its `-wal` file by device, inode, size,
 * and nanosecond modification time; an absent or unreadable file is part of the
 * key. An absent database uses a transient empty observation, so database
 * creation never retains an empty cache entry or fails that first empty read.
 * A changed identity disposes the snapshot and copies again. Results are
 * cached per exact method and serialized parameters under a byte and entry
 * bound. `closeColdObservations()` releases every retained snapshot; eviction
 * and invalidation dispose their own.
 *
 * The snapshot never writes source content and never resumes a Harness. SQLite
 * can create or update the source `-wal` and `-shm` sidecars when it opens the
 * database read-only, so one entry records the source identity after its own
 * open; a later content change still invalidates it.
 *
 * All cache work for one path is serialized: an open, a read, eviction, and
 * disposal never overlap, so a snapshot is never closed while borrowed and a
 * repeated result is never retained twice.
 */
import { statSync } from "node:fs";
import { resolve } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai";
import { createRegistry } from "@earendil-works/pi-durable";
import { observeClaim } from "./claims.ts";
import { DurableObservation } from "./durable-observation.ts";
import { hostPaths } from "./host-protocol.ts";
import type { HostMetadata } from "./host-protocol.ts";

const MAX_STORAGES = 8;
const MAX_RESULTS_PER_STORAGE = 64;
const MAX_RESULT_BYTES = 4 * 1024 * 1024;

/** One read-only snapshot and its bounded result cache; absent sources are transient. */
interface ColdEntry {
	readonly transient?: boolean;
	readonly key: string;
	readonly handle: ColdObservationHandle;
	readonly results: Map<string, ColdResult>;
	retainedBytes: number;
}

interface ColdResult {
	readonly value: unknown;
	readonly bytes: number;
}

/** One read-only snapshot the cache can request and close. */
export interface ColdObservationHandle {
	request(method: string, params: Record<string, unknown>): Promise<unknown>;
	close(): Promise<void>;
}

/** Owner classification used by the activity view for one cached snapshot. */
export interface ColdOwnerClassification {
	readonly owner: "here" | "unavailable" | "unknown";
	readonly label?: string;
}

/** Snapshot opener input. */
export interface ColdOpenInput {
	readonly storagePath: string;
	readonly storageId: string;
	readonly classifyOwner?: () => ColdOwnerClassification;
}

/** Test hooks. The default opener is the public snapshot path. */
export interface ColdObservationHooks {
	readonly open?: (input: ColdOpenInput) => Promise<ColdObservationHandle>;
}

export interface ColdObservationOptions {
	readonly hooks?: ColdObservationHooks;
}

export interface ColdObservationMetrics {
	readonly opens: number;
	readonly hits: number;
	readonly misses: number;
	readonly invalidations: number;
	readonly evictions: number;
	readonly storages: number;
}

const entries = new Map<string, ColdEntry>();
const counters = { opens: 0, hits: 0, misses: 0, invalidations: 0, evictions: 0 };
let cacheQueue: Promise<void> = Promise.resolve();

/** Serialize every cache operation; selected deep reads are low volume and never borrow across a close. */
function runExclusive<T>(action: () => Promise<T>): Promise<T> {
	const result = cacheQueue.then(action, action);
	cacheQueue = result.then(() => undefined, () => undefined);
	return result;
}

function errnoCode(error: unknown): string | undefined {
	return (error as NodeJS.ErrnoException).code;
}

/** One file's identity: absent, error qualification, or device/inode/size/mtime nanoseconds. */
interface ColdFileState {
	readonly state: "absent" | "error" | "file";
	readonly key: string;
	readonly size?: number;
}

function fileState(path: string): ColdFileState {
	try {
		const stat = statSync(path, { bigint: true });
		return { state: "file", key: `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}`, size: Number(stat.size) };
	} catch (error) {
		return errnoCode(error) === "ENOENT" ? { state: "absent", key: "absent" } : { state: "error", key: `error:${errnoCode(error) ?? "unknown"}` };
	}
}

interface ColdSourceState {
	readonly key: string;
	readonly db: string;
	readonly wal: ColdFileState;
}

/** Database plus write-ahead log identity. */
function sourceState(storagePath: string): ColdSourceState {
	const db = fileState(storagePath);
	const wal = fileState(`${storagePath}-wal`);
	return { key: `db:${db.key}|wal:${wal.key}`, db: db.key, wal };
}

/** Only a stable database plus an absent-to-empty WAL creation may keep a just-opened snapshot. */
function stableAfterOpen(pre: ColdSourceState, post: ColdSourceState): boolean {
	if (pre.db !== post.db) return false;
	if (pre.wal.key === post.wal.key) return true;
	return pre.wal.state === "absent" && post.wal.state === "file" && post.wal.size === 0;
}

/** Stable serialization of JSON control parameters, with object keys sorted. */
function stableKey(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "undefined";
	if (Array.isArray(value)) return `[${value.map(stableKey).join(",")}]`;
	const record = value as Record<string, unknown>;
	return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableKey(record[key])}`).join(",")}}`;
}

function resultKey(method: string, params: Record<string, unknown>): string {
	return `${method}\u0000${stableKey(params)}`;
}

function resultBytes(value: unknown): number {
	try {
		return Buffer.byteLength(JSON.stringify(value) ?? "");
	} catch {
		return 0;
	}
}

/** Claim state pins the owner classification into the cache identity. */
function claimState(metadata: HostMetadata): { readonly pin: string; readonly classification: ColdOwnerClassification } {
	try {
		const paths = hostPaths(metadata);
		const claim = observeClaim(paths.claim, paths.identity);
		if (claim.kind === "absent" || claim.kind === "dead") return { pin: claim.kind, classification: { owner: "unknown" } };
		return { pin: `${claim.kind}:${claim.label ?? ""}`, classification: { owner: "unavailable", ...(claim.label === undefined ? {} : { label: claim.label }) } };
	} catch {
		return { pin: "error", classification: { owner: "unavailable" } };
	}
}

/** The default public snapshot opener: no services, no model runtime, no resume. */
export async function openColdObservationSnapshot(input: ColdOpenInput): Promise<ColdObservationHandle> {
	const observation = await DurableObservation.open({
		backupFrom: input.storagePath,
		storageId: input.storageId,
		models: createModels(),
		registry: createRegistry(),
		...(input.classifyOwner === undefined ? {} : { classifyOwner: input.classifyOwner }),
	}, BACKGROUND_CONTEXT);
	return {
		request: (method, params) => observation.request(method, params),
		close: () => observation.close(),
	};
}

/** Evict least-recently-used storages beyond the bound; the caller holds the cache queue. */
async function evictToBound(): Promise<void> {
	while (entries.size > MAX_STORAGES) {
		const path = entries.keys().next().value;
		if (path === undefined) return;
		const entry = entries.get(path);
		entries.delete(path);
		counters.evictions += 1;
		if (entry !== undefined) await entry.handle.close().catch(() => undefined);
	}
}

/** Open one snapshot and retain it only when the source stayed stable across the copy. */
async function openEntry(storagePath: string, storageId: string, claimPin: string, hooks: ColdObservationHooks | undefined, classifyOwner: () => ColdOwnerClassification): Promise<ColdEntry> {
	const pre = sourceState(storagePath);
	const existing = entries.get(storagePath);
	if (existing !== undefined) {
		entries.delete(storagePath);
		counters.invalidations += 1;
		await existing.handle.close().catch(() => undefined);
	}
	const handle = await (hooks?.open ?? openColdObservationSnapshot)({ storagePath, storageId, classifyOwner });
	const post = sourceState(storagePath);
	if (pre.db === "absent") {
		counters.opens += 1;
		return { key: pre.key, handle, results: new Map(), retainedBytes: 0, transient: true };
	}
	if (!stableAfterOpen(pre, post)) {
		await handle.close().catch(() => undefined);
		throw new Error(`cold source ${storagePath} changed during the snapshot copy; retry the read`);
	}
	const entry: ColdEntry = { key: `${post.key}|claim:${claimPin}`, handle, results: new Map(), retainedBytes: 0 };
	entries.set(storagePath, entry);
	counters.opens += 1;
	await evictToBound();
	return entry;
}

/** Reuse one snapshot when the current source identity equals the identity captured after its open. */
async function acquireEntry(storagePath: string, storageId: string, claimPin: string, hooks: ColdObservationHooks | undefined, classifyOwner: () => ColdOwnerClassification): Promise<ColdEntry> {
	const existing = entries.get(storagePath);
	const desired = `${sourceState(storagePath).key}|claim:${claimPin}`;
	if (existing !== undefined && existing.key === desired) {
		entries.delete(storagePath);
		entries.set(storagePath, existing);
		return existing;
	}
	return await openEntry(storagePath, storageId, claimPin, hooks, classifyOwner);
}

/** Read one cached result or run the request and cache its raw value. */
async function readEntry(entry: ColdEntry, method: string, params: Record<string, unknown>): Promise<unknown> {
	const key = resultKey(method, params);
	const cached = entry.results.get(key);
	if (cached !== undefined) {
		counters.hits += 1;
		entry.results.delete(key);
		entry.results.set(key, cached);
		return cached.value;
	}
	counters.misses += 1;
	const value = await entry.handle.request(method, params);
	const bytes = resultBytes(value);
	const replaced = entry.results.get(key);
	if (replaced !== undefined) entry.retainedBytes -= replaced.bytes;
	entry.results.set(key, { value, bytes });
	entry.retainedBytes += bytes;
	while (entry.results.size > MAX_RESULTS_PER_STORAGE || entry.retainedBytes > MAX_RESULT_BYTES) {
		const oldest = entry.results.keys().next().value;
		if (oldest === undefined) break;
		const removed = entry.results.get(oldest);
		entry.results.delete(oldest);
		if (removed !== undefined) entry.retainedBytes -= removed.bytes;
	}
	return value;
}

function statusShape(value: unknown, metadata: HostMetadata): unknown {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
	return { ...(value as Record<string, unknown>), live: false, storageId: metadata.storageId };
}

/**
 * Read one cold method against the cached snapshot of `metadata.storagePath`.
 * The source identity is checked on every call; an unchanged source reuses the
 * snapshot and the exact result. A failed open retains no snapshot; a failed
 * request retains no result.
 */
export async function observeColdStorage(metadata: HostMetadata, method: string, params: Record<string, unknown> = {}, options: ColdObservationOptions = {}): Promise<unknown> {
	const storagePath = resolve(metadata.storagePath);
	return await runExclusive(async () => {
		const source = claimState(metadata);
		const classifyOwner = (): ColdOwnerClassification => source.classification;
		const entry = await acquireEntry(storagePath, metadata.storageId, source.pin, options.hooks, classifyOwner);
		try {
			const value = await readEntry(entry, method, { ...params, cwd: metadata.cwd });
			return method === "status" ? statusShape(value, metadata) : value;
		} finally {
			if (entry.transient) await entry.handle.close().catch(() => undefined);
		}
	});
}

/** Dispose every retained snapshot inside the cache queue. */
export async function closeColdObservations(): Promise<void> {
	await runExclusive(async () => {
		const retained = [...entries.values()];
		entries.clear();
		await Promise.all(retained.map((entry) => entry.handle.close().catch(() => undefined)));
	});
}

/** Dispose one storage's retained snapshot inside the cache queue. */
export async function disposeColdStorage(storagePath: string): Promise<void> {
	const path = resolve(storagePath);
	await runExclusive(async () => {
		const entry = entries.get(path);
		entries.delete(path);
		if (entry !== undefined) await entry.handle.close().catch(() => undefined);
	});
}

export function coldObservationMetrics(): ColdObservationMetrics {
	return { ...counters, storages: entries.size };
}

export function resetColdObservationMetrics(): void {
	counters.opens = 0;
	counters.hits = 0;
	counters.misses = 0;
	counters.invalidations = 0;
	counters.evictions = 0;
}
