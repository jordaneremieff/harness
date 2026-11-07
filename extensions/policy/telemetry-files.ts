/**
 * Segment files, bounded inventory, cross-process locking, retention and batched append for the
 * policy telemetry directory. Persistence failures are thrown to the writer, which decides how to
 * report them and how to stop admission.
 */

import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { PolicyRecord } from "./record.ts";

export const TELEMETRY_DIRECTORY = "telemetry";
export const TELEMETRY_LOCK_FILE = ".telemetry-lock";
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

export interface TelemetryWriter {
	enqueue(record: PolicyRecord): boolean;
	close(): Promise<void>;
}

/** One record serialised once at admission, before it enters a write queue or batch. */
export interface SerializedTelemetryRecord {
	readonly day: string;
	readonly json: string;
	readonly bytes: number;
}

/** One bounded batch of admitted record bytes written to the telemetry store under its own lock. */
export type AppendTelemetry = (
	dir: string,
	records: readonly SerializedTelemetryRecord[],
	retention: TelemetryRetention,
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

/** Inspect a held lock; a vanished file permits another attempt. A stale lock is never removed. */
async function inspectLock(path: string): Promise<void> {
	try {
		const info = await lstat(path);
		if (info.isSymbolicLink() || !info.isFile())
			throw new Error(`policy telemetry lock is not a regular non-symlink file: ${path}`);
	} catch (error) {
		if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
	}
}

/** Acquire the exclusive telemetry lock within a bounded wait, or throw without stealing it. */
async function acquireLock(path: string): Promise<Awaited<ReturnType<typeof open>>> {
	const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
	const attempts = Math.max(1, Math.floor(LOCK_WAIT_MS / LOCK_RETRY_MS));
	for (let attempt = 0; attempt < attempts; attempt++) {
		try {
			return await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow, 0o600);
		} catch (error) {
			if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") throw error;
			await inspectLock(path);
			if (attempt + 1 < attempts) await delay(LOCK_RETRY_MS);
		}
	}
	throw new Error(`policy telemetry lock remains held at ${path}`);
}

async function releaseLock(handle: Awaited<ReturnType<typeof open>>, path: string): Promise<void> {
	const owned = await handle.stat();
	const current = await lstat(path);
	if (current.dev !== owned.dev || current.ino !== owned.ino || current.isSymbolicLink() || !current.isFile())
		throw new Error(`policy telemetry lock changed; refusing to remove ${path}`);
	await unlink(path);
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
	/** Runs after the inventory is read and before any retention or append. */
	readonly afterInventory?: () => Promise<void>;
	/** Replaces the removal of one inspected segment. */
	readonly unlinkSegment?: (path: string) => Promise<void>;
	/** Reports whether one inspected path belongs to another user, overriding this process's owner. */
	readonly foreignOwner?: (path: string, uid: number) => boolean;
}

async function removeSegment(
	dir: string,
	entry: TelemetryInventoryEntry,
	hooks: TelemetryFileHooks | undefined,
): Promise<void> {
	const path = join(dir, entry.name);
	const info = await lstat(path);
	if (
		info.isSymbolicLink() ||
		!info.isFile() ||
		info.dev !== entry.dev ||
		info.ino !== entry.ino ||
		foreignOwner(path, info.uid, hooks)
	)
		throw new Error(`policy telemetry segment changed after inspection: ${entry.name}`);
	await (hooks?.unlinkSegment ?? unlink)(path);
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
): Promise<SegmentFile> {
	const path = join(dir, target.name);
	const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
	const flags = created
		? constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NONBLOCK | noFollow
		: constants.O_WRONLY | constants.O_APPEND | constants.O_NONBLOCK | noFollow;
	const buffer = Buffer.from(`\n${batch.map((record) => record.json).join("\n")}\n`, "utf8");
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
		while (written < buffer.length) {
			const { bytesWritten } = await handle.write(buffer, written, buffer.length - written, null);
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
	hooks: TelemetryFileHooks | undefined,
): Promise<void> {
	await removeSegment(dir, victim, hooks);
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
	hooks: TelemetryFileHooks | undefined,
): Promise<void> {
	const cutoff = retiredDay(day, retention.maxAgeDays);
	for (const entry of [...ledger.entries]) if (entry.day < cutoff) await removeFromLedger(dir, ledger, entry, hooks);
	while (ledger.totalBytes + bytes > retention.maxBytes) {
		const victim = ledger.entries.find((entry) => entry !== kept);
		if (!victim) break;
		await removeFromLedger(dir, ledger, victim, hooks);
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
	hooks: TelemetryFileHooks | undefined,
): Promise<void> {
	const bytes = batchBytes(batch);
	if (bytes > TELEMETRY_SEGMENT_BYTES)
		throw new Error(`policy telemetry batch exceeds ${TELEMETRY_SEGMENT_BYTES} bytes`);
	const current = ledger.entries.filter((entry) => entry.day === day).at(-1);
	const fits =
		current !== undefined && current.size + bytes <= TELEMETRY_SEGMENT_BYTES && current.size + bytes <= retention.maxBytes;
	await applyRetention(dir, ledger, day, bytes, fits ? current : undefined, retention, hooks);
	if (fits && current) {
		const file = await appendSegment(dir, current, false, batch);
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
		const file = await appendSegment(dir, target, true, batch);
		ledger.totalBytes += file.size;
		insertEntry(ledger, { ...target, size: file.size, dev: file.dev, ino: file.ino });
	}
}

async function appendUnderLock(
	policyDir: string,
	groups: Map<string, SerializedTelemetryRecord[]>,
	retention: TelemetryRetention,
	hooks: TelemetryFileHooks | undefined,
): Promise<void> {
	const inventory = await readSafeInventory(policyDir, hooks);
	await hooks?.afterInventory?.();
	const ledger: Ledger = { entries: [...inventory.entries], totalBytes: inventory.totalBytes };
	const dir = telemetryDirectory(policyDir);
	const ordered = [...groups].sort(([left], [right]) => left.localeCompare(right));
	for (const [day, batch] of ordered) await appendGroup(dir, ledger, day, batch, retention, hooks);
}

/**
 * Append one bounded batch of admitted record bytes to `<policyDir>/telemetry`. The telemetry lock
 * serialises rotation, retention and append across processes. Unrecognised names, symbolic links,
 * nonregular files, foreign-owned segments and segments whose identity changed are never removed.
 */
export async function appendSerializedTelemetryRecords(
	policyDir: string,
	records: readonly SerializedTelemetryRecord[],
	retention: TelemetryRetention = DEFAULT_TELEMETRY_RETENTION,
	hooks?: TelemetryFileHooks,
): Promise<void> {
	if (records.length === 0) return;
	const bounded = validateTelemetryRetention(retention);
	const groups = groupByDay(records);
	await privateDirectory(policyDir);
	const dir = telemetryDirectory(policyDir);
	await privateDirectory(dir);
	const lockPath = join(dir, TELEMETRY_LOCK_FILE);
	const handle = await acquireLock(lockPath);
	let failure: unknown;
	try {
		if (!(await handle.stat()).isFile()) throw new Error(`policy telemetry lock is not a regular file: ${lockPath}`);
		await appendUnderLock(policyDir, groups, bounded, hooks);
	} catch (error) {
		failure = error;
	}
	for (const finish of [() => releaseLock(handle, lockPath), () => handle.close()]) {
		try {
			await finish();
		} catch (error) {
			failure ??= error;
		}
	}
	if (failure !== undefined) throw failure;
}

/** Serialise each record once, then append the admitted bytes. */
export async function appendTelemetryRecords(
	policyDir: string,
	records: readonly PolicyRecord[],
	retention: TelemetryRetention = DEFAULT_TELEMETRY_RETENTION,
	hooks?: TelemetryFileHooks,
): Promise<void> {
	await appendSerializedTelemetryRecords(policyDir, records.map(serializeTelemetryRecord), retention, hooks);
}
