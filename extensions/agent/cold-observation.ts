/**
 * cold-observation: cached read-only inspection of one Durable storage file.
 *
 * A cold read does not boot the cwd-bound services, the model runtime, or the
 * extension set. It reads the source database through the public
 * `DurableObservation` with an empty public registry and
 * `pi-ai`'s `createModels()`, because no read path calls a model or resolves a
 * configured extension. Native `AgentMetaDoc` and delivery documents load from
 * the shared slice modules, so the existing `snapshot`, `status`, `list`,
 * `dashboard`, `receipts`, and `inspect` views keep their exact schemas.
 *
 * A settled source is read in place, with no copy: its write-ahead log and
 * rollback journal hold no bytes, so the main file is the complete committed
 * state. A writer's first commit adds bytes to the write-ahead log, and a
 * checkpoint changes the main file, so the source identity is compared again
 * after every read in place; a changed identity discards the read and opens
 * the source again. The writer claim is no part of this proof: a claim file can
 * outlive its writer. Every other source is copied first.
 *
 * One snapshot per storage path is kept while the source identity is unchanged.
 * The identity pins the database and its `-wal` file by device, inode, size,
 * and nanosecond modification and change times; an absent or unreadable file is part of the
 * key. An absent database uses a transient empty observation, so database
 * creation never retains an empty cache entry or fails that first empty read.
 * A changed identity disposes the snapshot and copies again. Results are
 * cached per exact method and serialized parameters under a byte and entry
 * bound. The manager owns the cache and awaits disposal when its last consumer
 * leaves. Eviction and invalidation dispose their own snapshots.
 *
 * A copy never opens source files through SQLite, and neither path resumes a
 * Harness or changes source bytes or sidecars. Only a stable source identity
 * is eligible for reuse.
 *
 * All cache work across every path is serialized: an open, a read, eviction, and
 * disposal never overlap, so a snapshot is never closed while borrowed and a
 * repeated result is never retained twice.
 */
import { statSync } from "node:fs";
import { resolve } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { observeClaim } from "./claims.ts";
import { hostPaths } from "./host-protocol.ts";
import type { HostMetadata } from "./host-protocol.ts";

interface ColdObservationRuntime {
	readonly createModels: typeof import("@earendil-works/pi-ai").createModels;
	readonly createRegistry: typeof import("@earendil-works/pi-durable").createRegistry;
	readonly DurableObservation: typeof import("./durable-observation.ts").DurableObservation;
	readonly sweepAbandonedSnapshots: typeof import("./snapshot-capture.ts").sweepAbandonedSnapshots;
}

let coldObservationRuntimePromise: Promise<ColdObservationRuntime> | undefined;

function loadColdObservationRuntime(): Promise<ColdObservationRuntime> {
	coldObservationRuntimePromise ??= Promise.all([
		import("@earendil-works/pi-ai"),
		import("@earendil-works/pi-durable"),
		import("./durable-observation.ts"),
		import("./snapshot-capture.ts"),
	]).then(([ai, durable, observation, capture]) => ({
		createModels: ai.createModels,
		createRegistry: durable.createRegistry,
		DurableObservation: observation.DurableObservation,
		sweepAbandonedSnapshots: capture.sweepAbandonedSnapshots,
	}));
	return coldObservationRuntimePromise;
}

const MAX_STORAGES = 8;
/** A read in place repeats when a writer changed the source during it; the last attempt reports the change. */
const IN_PLACE_READ_ATTEMPTS = 3;
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
	/** The handle reads the source file itself, so the cache compares the source identity after each read. */
	readonly inPlace?: boolean;
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
	/** Neither the write-ahead log nor the rollback journal holds bytes: the main file is complete. */
	readonly settled?: boolean;
}

/** Test hooks. The default opener is the public snapshot path. */
export interface ColdObservationHooks {
	readonly open?: (input: ColdOpenInput) => Promise<ColdObservationHandle>;
}

export interface ColdObservationOptions {
	readonly hooks?: ColdObservationHooks;
	/** A read whose signal aborted before its turn in the queue opens and reads nothing. */
	readonly signal?: AbortSignal;
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
		return {
			state: "file",
			key: `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`,
			size: Number(stat.size),
		};
	} catch (error) {
		return errnoCode(error) === "ENOENT"
			? { state: "absent", key: "absent" }
			: { state: "error", key: `error:${errnoCode(error) ?? "unknown"}` };
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

function holdsNoBytes(file: ColdFileState): boolean {
	return file.state === "absent" || (file.state === "file" && file.size === 0);
}

/** A source whose main file is the complete committed state. */
function settledSource(storagePath: string, source: ColdSourceState): boolean {
	return source.db !== "absent" && holdsNoBytes(source.wal) && holdsNoBytes(fileState(`${storagePath}-journal`));
}

/** Reader capture never creates source sidecars; the full source identity must stay stable. */
function stableAfterOpen(pre: ColdSourceState, post: ColdSourceState): boolean {
	return pre.key === post.key;
}

/** Stable serialization of JSON control parameters, with object keys sorted. */
function stableKey(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "undefined";
	if (Array.isArray(value)) return `[${value.map(stableKey).join(",")}]`;
	const record = value as Record<string, unknown>;
	return `{${Object.keys(record)
		.sort()
		.map((key) => `${JSON.stringify(key)}:${stableKey(record[key])}`)
		.join(",")}}`;
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
function claimState(metadata: HostMetadata): {
	readonly pin: string;
	readonly classification: ColdOwnerClassification;
} {
	try {
		const paths = hostPaths(metadata);
		const claim = observeClaim(paths.claim, paths.identity);
		if (claim.kind === "absent" || claim.kind === "dead")
			return { pin: claim.kind, classification: { owner: "unknown" } };
		return {
			pin: `${claim.kind}:${claim.label ?? ""}`,
			classification: { owner: "unavailable", ...(claim.label === undefined ? {} : { label: claim.label }) },
		};
	} catch {
		return { pin: "error", classification: { owner: "unavailable" } };
	}
}

/** The default public snapshot opener: no services, no model runtime, no resume. */
export async function openColdObservationSnapshot(input: ColdOpenInput): Promise<ColdObservationHandle> {
	const { createModels, createRegistry, DurableObservation, sweepAbandonedSnapshots } =
		await loadColdObservationRuntime();
	// Copies that a killed process left go in the background; no read waits for their removal.
	void sweepAbandonedSnapshots().catch(() => undefined);
	const options = {
		storageId: input.storageId,
		models: createModels(),
		registry: createRegistry(),
		...(input.classifyOwner === undefined ? {} : { classifyOwner: input.classifyOwner }),
	};
	if (input.settled) {
		try {
			const observation = await DurableObservation.openSettled(
				{ ...options, settledFrom: input.storagePath },
				BACKGROUND_CONTEXT,
			);
			return {
				inPlace: true,
				request: (method, params) => observation.request(method, params),
				close: () => observation.close(),
			};
		} catch {
			// A storage that needs preparation, or that no read-only connection can open, is read through a copy.
		}
	}
	const observation = await DurableObservation.open(
		{ ...options, backupFrom: input.storagePath },
		BACKGROUND_CONTEXT,
	).catch((error: unknown) => {
		if ((error as { code?: unknown }).code !== "limit_exceeded") throw error;
		throw Object.assign(
			new Error(
				"This storage is larger than the 512 MiB bound of a cold copy, and its write-ahead log holds bytes, so it cannot be read while its host is not running. A message to the agent starts its host; a running host answers without a copy.",
			),
			{ code: "limit_exceeded" },
		);
	});
	return {
		request: (method, params) => observation.request(method, params),
		close: () => observation.close(),
	};
}

// The queue owns no handles and bounds copying across manager lifetimes.
let cacheQueue: Promise<void> = Promise.resolve();
function runExclusive<T>(action: () => Promise<T>): Promise<T> {
	const result = cacheQueue.then(action, action);
	cacheQueue = result.then(
		() => undefined,
		() => undefined,
	);
	return result;
}

/** Bounded snapshots owned by one manager, with a process-wide serial borrowing queue. */
export function createColdObservationCache() {
	const entries = new Map<string, ColdEntry>();
	let closed = false;
	let closing: Promise<void> | undefined;

	/** Evict least-recently-used storages beyond the bound; the caller holds the cache queue. */
	async function evictToBound(): Promise<void> {
		while (entries.size > MAX_STORAGES) {
			const path = entries.keys().next().value;
			if (path === undefined) return;
			const entry = entries.get(path);
			entries.delete(path);
			if (entry !== undefined) await entry.handle.close().catch(() => undefined);
		}
	}

	/** Open one snapshot and retain it only when the source stayed stable across the copy. */
	async function openEntry(
		storagePath: string,
		storageId: string,
		claimPin: string,
		hooks: ColdObservationHooks | undefined,
		classifyOwner: () => ColdOwnerClassification,
	): Promise<ColdEntry> {
		const pre = sourceState(storagePath);
		const existing = entries.get(storagePath);
		if (existing !== undefined) {
			entries.delete(storagePath);
			await existing.handle.close().catch(() => undefined);
		}
		const handle = await (hooks?.open ?? openColdObservationSnapshot)({
			storagePath,
			storageId,
			classifyOwner,
			settled: settledSource(storagePath, pre),
		});
		const post = sourceState(storagePath);
		if (pre.db === "absent") {
			return { key: pre.key, handle, results: new Map(), retainedBytes: 0, transient: true };
		}
		if (!stableAfterOpen(pre, post)) {
			await handle.close().catch(() => undefined);
			throw new Error(`cold source ${storagePath} changed during the snapshot copy; retry the read`);
		}
		const entry: ColdEntry = { key: `${post.key}|claim:${claimPin}`, handle, results: new Map(), retainedBytes: 0 };
		entries.set(storagePath, entry);
		await evictToBound();
		return entry;
	}

	/** Reuse one snapshot when the current source identity equals the identity captured after its open. */
	async function acquireEntry(
		storagePath: string,
		storageId: string,
		claimPin: string,
		hooks: ColdObservationHooks | undefined,
		classifyOwner: () => ColdOwnerClassification,
	): Promise<ColdEntry> {
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
			entry.results.delete(key);
			entry.results.set(key, cached);
			return cached.value;
		}
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

	const CHANGED = Symbol("source changed during the read");

	/** One acquire and read; a read in place whose source changed is discarded and answers `CHANGED`. */
	async function observeOnce(
		storagePath: string,
		metadata: HostMetadata,
		method: string,
		params: Record<string, unknown>,
		hooks: ColdObservationHooks | undefined,
	): Promise<unknown> {
		const source = claimState(metadata);
		const classifyOwner = (): ColdOwnerClassification => source.classification;
		const entry = await acquireEntry(storagePath, metadata.storageId, source.pin, hooks, classifyOwner);
		const read = await readEntry(entry, method, { ...params, cwd: metadata.cwd }).then(
			(value) => ({ value }),
			(error: unknown) => ({ error }),
		);
		if (entry.transient) await entry.handle.close().catch(() => undefined);
		if (entry.handle.inPlace && entry.key !== `${sourceState(storagePath).key}|claim:${claimState(metadata).pin}`) {
			// A writer committed during the read: neither a value nor a failure describes one state.
			if (entries.get(storagePath) === entry) entries.delete(storagePath);
			await entry.handle.close().catch(() => undefined);
			return CHANGED;
		}
		if ("error" in read) throw read.error;
		return method === "status" ? statusShape(read.value, metadata) : read.value;
	}

	/**
	 * Read one cold method against the cached snapshot of `metadata.storagePath`.
	 * The source identity is checked on every call; an unchanged source reuses the
	 * snapshot and the exact result. A failed open retains no snapshot; a failed
	 * request retains no result.
	 */
	async function observe(
		metadata: HostMetadata,
		method: string,
		params: Record<string, unknown> = {},
		options: ColdObservationOptions = {},
	): Promise<unknown> {
		if (closed) throw new Error("Cold observation cache is closed");
		const storagePath = resolve(metadata.storagePath);
		return await runExclusive(async () => {
			options.signal?.throwIfAborted();
			for (let attempt = 0; attempt < IN_PLACE_READ_ATTEMPTS; attempt++) {
				const value = await observeOnce(storagePath, metadata, method, params, options.hooks);
				if (value !== CHANGED) return value;
			}
			throw new Error(`cold source ${storagePath} changed during the read; retry the read`);
		});
	}

	/** Dispose every retained snapshot inside the cache queue. */
	async function clear(): Promise<void> {
		await runExclusive(async () => {
			const retained = [...entries.values()];
			entries.clear();
			await Promise.all(retained.map((entry) => entry.handle.close().catch(() => undefined)));
		});
	}

	function close(): Promise<void> {
		closed = true;
		closing ??= clear();
		return closing;
	}
	return { observe, close };
}
