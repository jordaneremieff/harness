/**
 * Segment files, bounded inventory, cross-process locking, retention and batched append for the
 * policy telemetry directory. Persistence failures are thrown to the writer, which decides how to
 * report them and how to stop admission.
 */

import { closeSync, constants, fstatSync, linkSync, lstatSync, openSync, unlinkSync } from "node:fs";
import { chmod, type FileHandle, lstat, mkdir, open, readdir, unlink } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { PolicyRecord } from "./record.ts";

export const TELEMETRY_DIRECTORY = "telemetry";
/** Persistent lock file. A writer owns exclusion through an open descriptor lock on it. */
export const TELEMETRY_LOCK_FILE = ".telemetry-writer.lock";
/**
 * Name that writers of earlier releases create exclusively and remove after each batch. A writer
 * of this module holds a hard link to the persistent lock under this name while it appends.
 */
export const TELEMETRY_LEGACY_LOCK_FILE = ".telemetry-lock";
export const TELEMETRY_SEGMENT_BYTES = 32 * 1024 * 1024;
export const TELEMETRY_INVENTORY_ENTRIES = 512;
export const TELEMETRY_QUEUE_RECORDS = 512;
export const TELEMETRY_QUEUE_BYTES = 4 * 1024 * 1024;
export const TELEMETRY_BATCH_RECORDS = 32;
export const TELEMETRY_BATCH_BYTES = 64 * 1024;
export const MAX_TELEMETRY_RECORD_BYTES = 256 * 1024;
export const TELEMETRY_DEFAULT_MAX_BYTES = 1024 * 1024 * 1024;
export const TELEMETRY_DEFAULT_MAX_AGE_DAYS = 30;

const LOCK_WAIT_MS = 500;
const LOCK_RETRY_MS = 25;
/** Bounds the owner note read from a lock file of an earlier release, and the persistent lock's size. */
const LOCK_NOTE_BYTES = 256;
/** `open(2)` on macOS takes a flock-style exclusive lock atomically with this flag. */
const O_EXLOCK = 0x20;
const DAY_MS = 86_400_000;
const SEGMENT_NAME = /^(\d{4}-\d{2}-\d{2})\.(\d{6})\.jsonl$/;

export interface TelemetryRetention {
	readonly maxBytes: number;
	readonly maxAgeDays: number;
}

export interface TelemetrySegment {
	readonly name: string;
	readonly day: string;
	readonly ordinal: number;
	readonly size: number;
}

/** Cumulative recovery counts of one writer. */
export interface TelemetryRecovery {
	/** Times persistence stopped after a failed append. */
	readonly stops: number;
	/** Times a completed append ended a stop. */
	readonly resumes: number;
	/** Locks left by a stopped writer that this writer proved stale and took over. */
	readonly staleLocks: number;
}

export interface TelemetryHealth {
	/**
	 * `ok`: the latest batch reached storage. `pressure`: records dropped at a queue bound or behind
	 * a held lock. `failed`: an append failed and admission is stopped until `retryAt`.
	 */
	readonly state: "ok" | "pressure" | "failed";
	/** Records that did not reach storage, and their serialised bytes. */
	readonly lostRecords: number;
	readonly lostBytes: number;
	/**
	 * Records of batches that failed after bytes may have reached storage. Each may be stored,
	 * truncated or absent, and none is written again. Absent while zero.
	 */
	readonly uncertainRecords?: number;
	readonly uncertainBytes?: number;
	/** The failure that stopped persistence, while the state is `failed`. */
	readonly reason?: string;
	/** Evidence about the held lock while the writer is in pressure from lock contention. */
	readonly lock?: TelemetryLockHolder;
	/** Time from which a stopped writer admits a record and tries to write again. */
	readonly retryAt?: string;
	/** Absent until the writer stops or takes over a lock for the first time. */
	readonly recovery?: TelemetryRecovery;
}

export interface TelemetryWriter {
	enqueue(record: PolicyRecord): boolean;
	health(): TelemetryHealth;
	close(): Promise<void>;
}

/**
 * Evidence about a held telemetry lock. Age, the noted process and its liveness are diagnostic
 * only: no writer removes a lock because of them.
 */
export interface TelemetryLockHolder {
	/** Lock path relative to the policy directory. */
	readonly path: string;
	/**
	 * `live`: the kernel reports a descriptor lock, so a running writer holds it. `uncertain`: a
	 * lock file of an earlier release exists; its writer may run or may have stopped.
	 */
	readonly ownership: "live" | "uncertain";
	/** Time since an `uncertain` lock file last changed. */
	readonly ageMs?: number;
	readonly pid?: number;
	/** Whether the noted process runs on this host; absent when the lock names no process here. */
	readonly running?: boolean;
}

/** Acquisition exhausted its wait on a safe held lock, before retention or append. */
export class TelemetryLockBusyError extends Error {
	readonly holder?: TelemetryLockHolder;
	constructor(path: string, holder?: TelemetryLockHolder) {
		super(`policy telemetry lock remains held at ${path}`);
		this.name = "TelemetryLockBusyError";
		if (holder) this.holder = holder;
	}
}

/** Acquisition expired before lock creation, without retention or append. */
export class TelemetryAcquisitionExpiredError extends Error {
	constructor(path: string) {
		super(`policy telemetry acquisition expired before lock creation at ${path}`);
		this.name = "TelemetryAcquisitionExpiredError";
	}
}

/**
 * The append failed after record bytes may have reached storage: a partial write, a later segment
 * of the same batch, or lock release. The batch may be stored, truncated or absent, so a caller
 * must not write it again. Every other rejection of an append means that no record byte was written.
 */
export class TelemetryUncertainAppendError extends Error {
	constructor(cause: unknown) {
		super(cause instanceof Error ? cause.message : String(cause), { cause });
		this.name = "TelemetryUncertainAppendError";
	}
}

export interface TelemetryAppendOptions {
	/** Absolute monotonic deadline shared by a batch's acquisition attempts. */
	readonly acquireUntil?: number;
	/** Runs when this append takes over a lock that a stopped writer left. */
	readonly onStaleLock?: () => void;
	readonly hooks?: TelemetryFileHooks;
}

/** One record serialised once at admission, before it enters a write queue or batch. */
export interface SerializedTelemetryRecord {
	readonly day: string;
	readonly json: string;
	readonly bytes: number;
}

/**
 * One bounded batch of admitted record bytes written to the telemetry store under its own lock.
 * A rejection with `TelemetryUncertainAppendError` means record bytes may have reached storage;
 * any other rejection means none did.
 */
export type AppendTelemetry = (
	dir: string,
	records: readonly SerializedTelemetryRecord[],
	retention: TelemetryRetention,
	options?: TelemetryAppendOptions,
) => Promise<void>;

export const DEFAULT_TELEMETRY_RETENTION: TelemetryRetention = Object.freeze({
	maxBytes: TELEMETRY_DEFAULT_MAX_BYTES,
	maxAgeDays: TELEMETRY_DEFAULT_MAX_AGE_DAYS,
});

const pad = (value: number) => String(value).padStart(2, "0");

/** YYYY-MM-DD in the local timezone. */
export function localDate(date: Date): string {
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Validate one retention policy. A byte budget below one segment cannot hold a rotated segment. */
export function validateTelemetryRetention(value: TelemetryRetention): TelemetryRetention {
	if (!Number.isSafeInteger(value.maxBytes) || value.maxBytes < TELEMETRY_SEGMENT_BYTES)
		throw new Error(`telemetry byte budget must be an integer of at least ${TELEMETRY_SEGMENT_BYTES} bytes`);
	if (!Number.isSafeInteger(value.maxAgeDays) || value.maxAgeDays < 1)
		throw new Error("telemetry age budget must be a positive integer of days");
	return { maxBytes: value.maxBytes, maxAgeDays: value.maxAgeDays };
}

export function telemetryDirectory(policyDir: string): string {
	return join(policyDir, TELEMETRY_DIRECTORY);
}

function segmentName(day: string, ordinal: number): string {
	return `${day}.${String(ordinal).padStart(6, "0")}.jsonl`;
}

function retiredDay(day: string, maxAgeDays: number): string {
	const first = Date.parse(`${day}T00:00:00.000Z`) - (maxAgeDays - 1) * DAY_MS;
	return Number.isFinite(first) ? new Date(first).toISOString().slice(0, 10) : "0000-01-01";
}

export type TelemetryInventoryIssue = "symlink" | "nonregular" | "inspect-error" | "foreign-owner";

export interface TelemetryInventoryEntry extends TelemetrySegment {
	readonly dev: number;
	readonly ino: number;
	readonly unsafe: TelemetryInventoryIssue | null;
}

export interface TelemetryInventory {
	readonly directory: "available" | "missing" | "nonregular" | "symlink" | "unreadable";
	/** Recognised segment names, oldest first. Unrecognised names are never returned or removed. */
	readonly entries: readonly TelemetryInventoryEntry[];
	readonly totalBytes: number;
	/** A listing limit, listing error, or unsafe entry means the inventory is not complete. */
	readonly incomplete: boolean;
}

const EMPTY_INVENTORY: TelemetryInventory = {
	directory: "missing",
	entries: [],
	totalBytes: 0,
	incomplete: false,
};

/** Whether one inspected file belongs to another user. */
function foreignOwner(path: string, uid: number, hooks: TelemetryFileHooks | undefined): boolean {
	if (hooks?.foreignOwner) return hooks.foreignOwner(path, uid);
	return typeof process.getuid === "function" && uid !== process.getuid();
}

/** One recognised segment name, inspected without following links. Other names return undefined. */
async function inspectSegment(
	dir: string,
	name: string,
	hooks: TelemetryFileHooks | undefined,
): Promise<TelemetryInventoryEntry | undefined> {
	const match = SEGMENT_NAME.exec(name);
	if (!match) return undefined;
	const base = { name, day: match[1], ordinal: Number(match[2]), size: 0, dev: 0, ino: 0 };
	const path = join(dir, name);
	let info: Awaited<ReturnType<typeof lstat>>;
	try {
		info = await lstat(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return undefined;
		return { ...base, unsafe: "inspect-error" };
	}
	const identity = { ...base, dev: info.dev, ino: info.ino };
	if (info.isSymbolicLink()) return { ...identity, unsafe: "symlink" };
	if (!info.isFile()) return { ...identity, unsafe: "nonregular" };
	if (foreignOwner(path, info.uid, hooks)) return { ...identity, unsafe: "foreign-owner" };
	return { ...identity, size: info.size, unsafe: null };
}

/**
 * Read one bounded inventory of the telemetry directory. Stat calls inspect recognised names only;
 * every other name is ignored and retained. A foreign owner is unsafe.
 */
export async function readTelemetryInventory(
	policyDir: string,
	hooks?: TelemetryFileHooks,
): Promise<TelemetryInventory> {
	const dir = telemetryDirectory(policyDir);
	try {
		const info = await lstat(dir);
		if (info.isSymbolicLink()) return { ...EMPTY_INVENTORY, directory: "symlink" };
		if (!info.isDirectory()) return { ...EMPTY_INVENTORY, directory: "nonregular" };
	} catch (error) {
		if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return EMPTY_INVENTORY;
		return { ...EMPTY_INVENTORY, directory: "unreadable" };
	}
	let names: string[];
	try {
		names = await readdir(dir);
	} catch {
		return { ...EMPTY_INVENTORY, directory: "unreadable" };
	}
	let incomplete = names.length > TELEMETRY_INVENTORY_ENTRIES;
	const entries: TelemetryInventoryEntry[] = [];
	let totalBytes = 0;
	for (const name of names.slice(0, TELEMETRY_INVENTORY_ENTRIES)) {
		const entry = await inspectSegment(dir, name, hooks);
		if (!entry) continue;
		entries.push(entry);
		if (entry.unsafe !== null) incomplete = true;
		else totalBytes += entry.size;
	}
	entries.sort((left, right) => left.day.localeCompare(right.day) || left.ordinal - right.ordinal);
	return { directory: "available", entries, totalBytes, incomplete };
}

async function privateDirectory(path: string): Promise<void> {
	const created = await mkdir(path, { recursive: true, mode: 0o700 });
	const info = await lstat(path);
	if (!info.isDirectory() || info.isSymbolicLink())
		throw new Error(`policy telemetry path is not a regular directory: ${path}`);
	if (typeof process.getuid === "function" && info.uid !== process.getuid())
		throw new Error(`policy telemetry path is not owned by this user: ${path}`);
	if (created !== undefined) await chmod(path, 0o700);
	else if ((info.mode & 0o077) !== 0)
		throw new Error(`policy telemetry path permissions are not private: ${path}`);
}

function errorCode(error: unknown): string | undefined {
	return (error as NodeJS.ErrnoException | undefined)?.code;
}

function notRegularLock(path: string): Error {
	return new Error(`policy telemetry lock is not a regular non-symlink file: ${path}`);
}

function foreignLock(path: string): Error {
	return new Error(`policy telemetry lock is not owned by this user: ${path}`);
}

/** The descriptor lock that one writer holds on the persistent lock file. */
interface HeldDescriptor {
	readonly fd: number;
	readonly dev: number;
	readonly ino: number;
}

/**
 * Take the descriptor lock in one nonblocking attempt; a lock that another descriptor holds
 * returns undefined. The kernel releases the lock when its holder exits, so a held lock always
 * has a running owner. The file is never written, truncated or removed.
 */
function openDescriptorLock(path: string, hooks: TelemetryFileHooks | undefined): HeldDescriptor | undefined {
	if (process.platform !== "darwin") throw new Error("policy telemetry writes need the macOS descriptor lock");
	let fd: number;
	try {
		fd = openSync(path, constants.O_RDWR | constants.O_CREAT | constants.O_NONBLOCK | constants.O_NOFOLLOW | O_EXLOCK, 0o600);
	} catch (error) {
		if (errorCode(error) === "EAGAIN") return undefined;
		if (errorCode(error) === "ELOOP" || errorCode(error) === "EISDIR") throw notRegularLock(path);
		throw error;
	}
	try {
		const info = fstatSync(fd);
		if (!info.isFile()) throw notRegularLock(path);
		if (foreignOwner(path, info.uid, hooks)) throw foreignLock(path);
		if ((info.mode & 0o077) !== 0) throw new Error(`policy telemetry lock permissions are not private: ${path}`);
		if (info.size > LOCK_NOTE_BYTES) throw new Error(`policy telemetry lock exceeds ${LOCK_NOTE_BYTES} bytes: ${path}`);
		const named = lstatSync(path);
		if (!named.isFile() || named.dev !== info.dev || named.ino !== info.ino)
			throw new Error(`policy telemetry lock changed during acquisition: ${path}`);
		return { fd, dev: info.dev, ino: info.ino };
	} catch (error) {
		closeSync(fd);
		throw error;
	}
}

type LegacyClaim = "claimed" | "recovered" | "held" | "vanished";

/**
 * Exclude writers of earlier releases by linking the persistent lock to the name that they create
 * exclusively. Those writers only ever create a new file under that name. An entry there with the
 * identity of the persistent lock was therefore linked by a writer of this protocol, and such a
 * writer keeps the link only while it holds the descriptor lock. The caller holds that lock, so
 * a matching entry was left by a stopped writer: the caller takes it over. An entry with any
 * other identity may belong to a running writer and is left alone.
 */
function claimLegacyName(
	held: HeldDescriptor,
	lockPath: string,
	legacyPath: string,
	hooks: TelemetryFileHooks | undefined,
): LegacyClaim {
	try {
		linkSync(lockPath, legacyPath);
	} catch (error) {
		if (errorCode(error) !== "EEXIST") throw error;
		return inspectLegacyName(held, legacyPath, hooks);
	}
	const linked = lstatSync(legacyPath);
	if (!linked.isFile() || linked.dev !== held.dev || linked.ino !== held.ino)
		throw new Error(`policy telemetry lock changed during acquisition: ${legacyPath}`);
	return "claimed";
}

/** Classify an existing entry under the legacy name without following or changing it. */
function inspectLegacyName(
	held: HeldDescriptor,
	legacyPath: string,
	hooks: TelemetryFileHooks | undefined,
): Exclude<LegacyClaim, "claimed"> {
	let info: ReturnType<typeof lstatSync>;
	try {
		info = lstatSync(legacyPath);
	} catch (error) {
		if (errorCode(error) === "ENOENT") return "vanished";
		throw error;
	}
	if (info.isSymbolicLink() || !info.isFile()) throw notRegularLock(legacyPath);
	if (info.dev === held.dev && info.ino === held.ino) return "recovered";
	if (foreignOwner(legacyPath, info.uid, hooks)) throw foreignLock(legacyPath);
	return "held";
}

/** Exclusion that one append holds against writers of this protocol and of earlier releases. */
interface WriterLease {
	/**
	 * Compare the held descriptor with both lock names. A missing or changed name ends this lease:
	 * every later call throws, and the lease removes nothing.
	 */
	assertHeld(): void;
	/** Remove the legacy name after the same comparison, then release the descriptor lock. */
	release(): void;
}

function writerLease(held: HeldDescriptor, lockPath: string, legacyPath: string): WriterLease {
	let lost: Error | undefined;
	const same = (inspect: () => { isFile(): boolean; dev: number; ino: number }): boolean => {
		try {
			const info = inspect();
			return info.isFile() && info.dev === held.dev && info.ino === held.ino;
		} catch {
			return false;
		}
	};
	const assertHeld = () => {
		if (lost) throw lost;
		const changed =
			!same(() => fstatSync(held.fd)) || !same(() => lstatSync(lockPath))
				? lockPath
				: same(() => lstatSync(legacyPath))
					? undefined
					: legacyPath;
		if (changed === undefined) return;
		lost = new Error(`policy telemetry lock changed while held; refusing to continue or to remove ${changed}`);
		throw lost;
	};
	return {
		assertHeld,
		release() {
			try {
				assertHeld();
				unlinkSync(legacyPath);
			} finally {
				closeSync(held.fd);
			}
		},
	};
}

/**
 * One acquisition attempt. Returns the lease, the kind of holder that the attempt met, or
 * undefined when the legacy name vanished during inspection and another attempt can run at once.
 */
function tryAcquire(
	lockPath: string,
	legacyPath: string,
	options: TelemetryAppendOptions,
): WriterLease | TelemetryLockHolder["ownership"] | undefined {
	const held = openDescriptorLock(lockPath, options.hooks);
	if (!held) return "live";
	let claim: LegacyClaim;
	try {
		claim = claimLegacyName(held, lockPath, legacyPath, options.hooks);
	} catch (error) {
		closeSync(held.fd);
		throw error;
	}
	if (claim === "held" || claim === "vanished") {
		closeSync(held.fd);
		return claim === "held" ? "uncertain" : undefined;
	}
	if (claim === "recovered") {
		try {
			options.onStaleLock?.();
		} catch {
			// Reporting has no persistence authority.
		}
	}
	return writerLease(held, lockPath, legacyPath);
}

async function busyError(
	ownership: TelemetryLockHolder["ownership"],
	lockPath: string,
	legacyPath: string,
): Promise<TelemetryLockBusyError> {
	if (ownership === "live")
		return new TelemetryLockBusyError(lockPath, { path: `${TELEMETRY_DIRECTORY}/${TELEMETRY_LOCK_FILE}`, ownership });
	return new TelemetryLockBusyError(legacyPath, await legacyHolder(legacyPath));
}

/**
 * Acquire exclusion within a bounded wait, or throw. A held descriptor lock and a lock file of an
 * earlier release are both waited on and never removed.
 */
async function acquireLease(dir: string, options: TelemetryAppendOptions): Promise<WriterLease> {
	const lockPath = join(dir, TELEMETRY_LOCK_FILE);
	const legacyPath = join(dir, TELEMETRY_LEGACY_LOCK_FILE);
	const deadline = Math.min(performance.now() + LOCK_WAIT_MS, options.acquireUntil ?? Number.POSITIVE_INFINITY);
	let contended: TelemetryLockHolder["ownership"] | undefined;
	for (;;) {
		if (performance.now() >= deadline) {
			if (contended) throw await busyError(contended, lockPath, legacyPath);
			throw new TelemetryAcquisitionExpiredError(lockPath);
		}
		const attempt = tryAcquire(lockPath, legacyPath, options);
		if (attempt === undefined) continue;
		if (typeof attempt !== "string") return attempt;
		contended = attempt;
		const remaining = deadline - performance.now();
		if (remaining <= 0) throw await busyError(contended, lockPath, legacyPath);
		await delay(Math.min(LOCK_RETRY_MS, remaining));
	}
}

function processRunning(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return errorCode(error) === "EPERM";
	}
}

/**
 * Read the owner note of a lock file from an earlier release without following links. Any doubt
 * yields less evidence, not an error. Nothing here proves that the owner stopped.
 */
async function legacyHolder(path: string): Promise<TelemetryLockHolder> {
	const holder: { path: string; ownership: "uncertain"; ageMs?: number; pid?: number; running?: boolean } = {
		path: `${TELEMETRY_DIRECTORY}/${TELEMETRY_LEGACY_LOCK_FILE}`,
		ownership: "uncertain",
	};
	let handle: FileHandle | undefined;
	try {
		handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
		const info = await handle.stat();
		if (!info.isFile()) return holder;
		holder.ageMs = Math.max(0, Math.round(Date.now() - info.mtimeMs));
		const buffer = Buffer.alloc(LOCK_NOTE_BYTES);
		const { bytesRead } = await handle.read(buffer, 0, LOCK_NOTE_BYTES, 0);
		let note: { pid?: unknown; host?: unknown } = {};
		try {
			note = JSON.parse(buffer.subarray(0, bytesRead).toString("utf8")) as typeof note;
		} catch {
			// Some earlier writers create an empty lock; its age remains evidence.
		}
		if (typeof note.pid === "number" && Number.isSafeInteger(note.pid) && note.pid > 0) {
			holder.pid = note.pid;
			if (note.host === hostname()) holder.running = processRunning(note.pid);
		}
	} catch {
		// The lock may have gone, or it is not readable; the path alone remains evidence.
	} finally {
		await handle?.close().catch(() => {});
	}
	return holder;
}

/** Bytes one batch occupies in a segment: a leading newline, each record, and its newline. */
function batchBytes(batch: readonly SerializedTelemetryRecord[]): number {
	return batch.reduce((total, record) => total + record.bytes - 1, 1);
}

/** Serialise and bound one record. The returned bytes are what a queue or append persists. */
export function serializeTelemetryRecord(record: PolicyRecord): SerializedTelemetryRecord {
	const timestamp = new Date(record.at);
	if (Number.isNaN(timestamp.getTime())) throw new Error(`invalid policy timestamp: ${record.at}`);
	const json = JSON.stringify(record);
	const bytes = Buffer.byteLength(json, "utf8") + 2;
	if (bytes > MAX_TELEMETRY_RECORD_BYTES)
		throw new Error(`policy record exceeds ${MAX_TELEMETRY_RECORD_BYTES} bytes`);
	return { day: localDate(timestamp), json, bytes };
}

/** Test seams for failures that a real directory cannot produce on demand. */
export interface TelemetryFileHooks {
	/** Runs after directory preparation and before the first lock-creation attempt. */
	readonly afterDirectoryPreparation?: () => Promise<void>;
	/** Runs after the inventory is read and before any retention or append. */
	readonly afterInventory?: () => Promise<void>;
	/** Replaces the removal of one inspected segment. */
	readonly unlinkSegment?: (path: string) => Promise<void>;
	/** Reports whether one inspected path belongs to another user, overriding this process's owner. */
	readonly foreignOwner?: (path: string, uid: number) => boolean;
	/** Replaces one chunk write to exercise partial append failures. */
	readonly writeChunk?: (handle: FileHandle, bytes: Uint8Array) => Promise<number>;
}

/** State that one append shares with each segment operation under its lease. */
interface AppendContext {
	readonly hooks: TelemetryFileHooks | undefined;
	/** Throws when the lease no longer names this writer's lock; runs before each namespace change. */
	readonly assertHeld: () => void;
	/** Set before the first record byte is offered to storage. */
	wrote: boolean;
}

async function removeSegment(
	dir: string,
	entry: TelemetryInventoryEntry,
	context: AppendContext,
): Promise<void> {
	const path = join(dir, entry.name);
	const info = await lstat(path);
	if (
		info.isSymbolicLink() ||
		!info.isFile() ||
		info.dev !== entry.dev ||
		info.ino !== entry.ino ||
		foreignOwner(path, info.uid, context.hooks)
	)
		throw new Error(`policy telemetry segment changed after inspection: ${entry.name}`);
	context.assertHeld();
	await (context.hooks?.unlinkSegment ?? unlink)(path);
}

interface SegmentFile {
	readonly dev: number;
	readonly ino: number;
	readonly size: number;
}

async function appendSegment(
	dir: string,
	target: TelemetryInventoryEntry,
	created: boolean,
	batch: readonly SerializedTelemetryRecord[],
	context: AppendContext,
): Promise<SegmentFile> {
	const path = join(dir, target.name);
	const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
	const flags = created
		? constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NONBLOCK | noFollow
		: constants.O_WRONLY | constants.O_APPEND | constants.O_NONBLOCK | noFollow;
	const buffer = Buffer.from(`\n${batch.map((record) => record.json).join("\n")}\n`, "utf8");
	context.assertHeld();
	const handle = await open(path, flags, 0o600);
	try {
		const info = await handle.stat();
		if (!info.isFile()) throw new Error(`policy record store is not a regular file: ${path}`);
		if (typeof process.getuid === "function" && info.uid !== process.getuid())
			throw new Error(`policy record store is not owned by this user: ${path}`);
		if (!created && (info.dev !== target.dev || info.ino !== target.ino))
			throw new Error(`policy telemetry segment changed after inspection: ${target.name}`);
		await handle.chmod(0o600);
		let written = 0;
		context.wrote = true;
		while (written < buffer.length) {
			const bytesWritten = context.hooks?.writeChunk
				? await context.hooks.writeChunk(handle, buffer.subarray(written))
				: (await handle.write(buffer, written, buffer.length - written, null)).bytesWritten;
			if (bytesWritten <= 0)
				throw new Error(`policy record write stopped at ${written} of ${buffer.length} bytes`);
			written += bytesWritten;
		}
		const after = await handle.stat();
		return { dev: after.dev, ino: after.ino, size: after.size };
	} finally {
		await handle.close();
	}
}

interface Ledger {
	entries: TelemetryInventoryEntry[];
	totalBytes: number;
}

function groupByDay(
	records: readonly SerializedTelemetryRecord[],
): Map<string, SerializedTelemetryRecord[]> {
	const groups = new Map<string, SerializedTelemetryRecord[]>();
	for (const record of records) {
		const group = groups.get(record.day);
		if (group) group.push(record);
		else groups.set(record.day, [record]);
	}
	return groups;
}

async function readSafeInventory(
	policyDir: string,
	hooks: TelemetryFileHooks | undefined,
): Promise<TelemetryInventory> {
	const inventory = await readTelemetryInventory(policyDir, hooks);
	const dir = telemetryDirectory(policyDir);
	if (inventory.directory !== "available")
		throw new Error(`policy telemetry directory is ${inventory.directory}: ${dir}`);
	const unsafe = inventory.entries.find((entry) => entry.unsafe !== null);
	if (unsafe?.unsafe === "foreign-owner")
		throw new Error(`policy telemetry inventory contains a foreign-owned segment: ${unsafe.name}`);
	if (unsafe) throw new Error(`policy telemetry inventory contains a nonregular or symbolic link: ${unsafe.name}`);
	if (inventory.incomplete) throw new Error(`policy telemetry inventory is incomplete: ${dir}`);
	return inventory;
}

async function removeFromLedger(
	dir: string,
	ledger: Ledger,
	victim: TelemetryInventoryEntry,
	context: AppendContext,
): Promise<void> {
	await removeSegment(dir, victim, context);
	ledger.totalBytes -= victim.size;
	ledger.entries = ledger.entries.filter((candidate) => candidate !== victim);
}

/** Remove segments past the age budget, then the oldest others until the batch fits the byte budget. */
async function applyRetention(
	dir: string,
	ledger: Ledger,
	day: string,
	bytes: number,
	kept: TelemetryInventoryEntry | undefined,
	retention: TelemetryRetention,
	context: AppendContext,
): Promise<void> {
	const cutoff = retiredDay(day, retention.maxAgeDays);
	for (const entry of [...ledger.entries]) if (entry.day < cutoff) await removeFromLedger(dir, ledger, entry, context);
	while (ledger.totalBytes + bytes > retention.maxBytes) {
		const victim = ledger.entries.find((entry) => entry !== kept);
		if (!victim) break;
		await removeFromLedger(dir, ledger, victim, context);
	}
	if (ledger.totalBytes + bytes > retention.maxBytes)
		throw new Error(`policy telemetry byte budget cannot hold the next batch: ${retention.maxBytes} bytes`);
}

function insertEntry(ledger: Ledger, entry: TelemetryInventoryEntry): void {
	const index = ledger.entries.findIndex(
		(candidate) => candidate.day > entry.day || (candidate.day === entry.day && candidate.ordinal > entry.ordinal),
	);
	if (index < 0) ledger.entries.push(entry);
	else ledger.entries.splice(index, 0, entry);
}

async function appendGroup(
	dir: string,
	ledger: Ledger,
	day: string,
	batch: readonly SerializedTelemetryRecord[],
	retention: TelemetryRetention,
	context: AppendContext,
): Promise<void> {
	const bytes = batchBytes(batch);
	if (bytes > TELEMETRY_SEGMENT_BYTES)
		throw new Error(`policy telemetry batch exceeds ${TELEMETRY_SEGMENT_BYTES} bytes`);
	const current = ledger.entries.filter((entry) => entry.day === day).at(-1);
	const fits =
		current !== undefined && current.size + bytes <= TELEMETRY_SEGMENT_BYTES && current.size + bytes <= retention.maxBytes;
	await applyRetention(dir, ledger, day, bytes, fits ? current : undefined, retention, context);
	if (fits && current) {
		const file = await appendSegment(dir, current, false, batch, context);
		ledger.totalBytes += file.size - current.size;
		ledger.entries = ledger.entries.map((entry) => (entry === current ? { ...entry, size: file.size } : entry));
	} else {
		const ordinal = (current?.ordinal ?? 0) + 1;
		if (ordinal > 999_999) throw new Error(`policy telemetry segment ordinal exceeded for ${day}`);
		const target: TelemetryInventoryEntry = {
			name: segmentName(day, ordinal),
			day,
			ordinal,
			size: 0,
			dev: 0,
			ino: 0,
			unsafe: null,
		};
		const file = await appendSegment(dir, target, true, batch, context);
		ledger.totalBytes += file.size;
		insertEntry(ledger, { ...target, size: file.size, dev: file.dev, ino: file.ino });
	}
}

async function appendUnderLock(
	policyDir: string,
	groups: Map<string, SerializedTelemetryRecord[]>,
	retention: TelemetryRetention,
	context: AppendContext,
): Promise<void> {
	const inventory = await readSafeInventory(policyDir, context.hooks);
	await context.hooks?.afterInventory?.();
	const ledger: Ledger = { entries: [...inventory.entries], totalBytes: inventory.totalBytes };
	const dir = telemetryDirectory(policyDir);
	const ordered = [...groups].sort(([left], [right]) => left.localeCompare(right));
	for (const [day, batch] of ordered) await appendGroup(dir, ledger, day, batch, retention, context);
}

/**
 * Append one bounded batch of admitted record bytes to `<policyDir>/telemetry`. The telemetry lock
 * serialises rotation, retention and append across processes. Unrecognised names, symbolic links,
 * nonregular files, foreign-owned segments and segments whose identity changed are never removed.
 * A failure after the first record byte was offered to storage rejects with
 * `TelemetryUncertainAppendError`.
 */
export async function appendSerializedTelemetryRecords(
	policyDir: string,
	records: readonly SerializedTelemetryRecord[],
	retention: TelemetryRetention = DEFAULT_TELEMETRY_RETENTION,
	options: TelemetryAppendOptions = {},
): Promise<void> {
	if (records.length === 0) return;
	const bounded = validateTelemetryRetention(retention);
	const groups = groupByDay(records);
	await privateDirectory(policyDir);
	const dir = telemetryDirectory(policyDir);
	await privateDirectory(dir);
	await options.hooks?.afterDirectoryPreparation?.();
	const lease = await acquireLease(dir, options);
	const context: AppendContext = { hooks: options.hooks, assertHeld: lease.assertHeld, wrote: false };
	let failure: unknown;
	try {
		await appendUnderLock(policyDir, groups, bounded, context);
	} catch (error) {
		failure = error;
	}
	try {
		lease.release();
	} catch (error) {
		failure ??= error;
	}
	if (failure !== undefined) throw context.wrote ? new TelemetryUncertainAppendError(failure) : failure;
}

/** Serialise each record once, then append the admitted bytes. */
export async function appendTelemetryRecords(
	policyDir: string,
	records: readonly PolicyRecord[],
	retention: TelemetryRetention = DEFAULT_TELEMETRY_RETENTION,
	hooks?: TelemetryFileHooks,
): Promise<void> {
	await appendSerializedTelemetryRecords(policyDir, records.map(serializeTelemetryRecord), retention, { hooks });
}
