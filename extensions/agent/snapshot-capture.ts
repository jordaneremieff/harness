/**
 * Filesystem-only capture of a SQLite database and its WAL into private storage.
 *
 * Each private directory holds an owner file that its process keeps locked until it removes the directory. A
 * process removes its directories when it exits. A process that is killed cannot, so every process removes, once,
 * the directories whose owner lock is free.
 */
import { constants, lstatSync, mkdtempSync, rmSync, type BigIntStats } from "node:fs";
import { lstat, open, readdir, realpath, rm, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import type { Storage } from "@earendil-works/pi-durable";
import { tryNativeWriterLease, type NativeWriterLease } from "./native-lease.ts";

const DIRECTORY_PREFIX = "pi-durable-snapshot-";
const OWNER_FILE = "owner.lock";
/**
 * A directory without an owner file is between its creation and its owner file, or belongs to a process that writes
 * no owner file. Removal waits this long; a holder keeps its open files when its directory goes.
 */
const UNOWNED_DIRECTORY_GRACE_MS = 10 * 60 * 1000;

interface OwnedDirectory {
	readonly path: string;
	readonly lease: NativeWriterLease;
}

const ownedDirectories = new Map<string, OwnedDirectory>();
let exitHook = false;

/** Create one private directory and lock its owner file in the same synchronous step. */
function createOwnedDirectory(scratchRoot: string): OwnedDirectory {
	if (!exitHook) {
		exitHook = true;
		process.once("exit", () => {
			for (const owned of ownedDirectories.values()) {
				try {
					rmSync(owned.path, { recursive: true, force: true });
				} catch {
					// The owner lock ends with the process; another process removes the directory.
				}
			}
		});
	}
	const path = mkdtempSync(join(scratchRoot, DIRECTORY_PREFIX));
	try {
		const attempt = tryNativeWriterLease(join(path, OWNER_FILE));
		if (attempt.kind !== "held") throw new SnapshotCaptureError("internal");
		const owned = { path, lease: attempt.lease };
		ownedDirectories.set(path, owned);
		return owned;
	} catch (error) {
		rmSync(path, { recursive: true, force: true });
		throw error;
	}
}

async function removeOwnedDirectory(path: string): Promise<void> {
	const owned = ownedDirectories.get(path);
	try {
		await rm(path, { recursive: true, force: true });
	} finally {
		if (owned) {
			ownedDirectories.delete(path);
			owned.lease.release();
		}
	}
}

/** Remove one abandoned directory; a locked owner file or a recent directory without one stays. */
async function removeAbandonedDirectory(path: string, now: number): Promise<boolean> {
	const info = lstatSync(path);
	if (!info.isDirectory() || info.uid !== process.getuid?.()) return false;
	let ownerFile = true;
	try {
		lstatSync(join(path, OWNER_FILE));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		ownerFile = false;
	}
	if (!ownerFile) {
		if (now - info.mtimeMs < UNOWNED_DIRECTORY_GRACE_MS) return false;
		await rm(path, { recursive: true, force: true });
		return true;
	}
	const attempt = tryNativeWriterLease(join(path, OWNER_FILE));
	if (attempt.kind !== "held") return false;
	try {
		await rm(path, { recursive: true, force: true });
	} finally {
		attempt.lease.release();
	}
	return true;
}

/**
 * Remove the private capture directories that no live process owns and return their count. A directory that cannot
 * be examined stays for a later run.
 */
export async function removeAbandonedSnapshots(
	scratchRoot: string = tmpdir(),
	now: number = Date.now(),
): Promise<number> {
	let names: string[];
	try {
		names = await readdir(scratchRoot);
	} catch {
		return 0;
	}
	let removed = 0;
	for (const name of names) {
		if (!name.startsWith(DIRECTORY_PREFIX)) continue;
		try {
			if (await removeAbandonedDirectory(join(scratchRoot, name), now)) removed++;
		} catch {
			// Another process removed it, or it is not a private directory of this user.
		}
	}
	return removed;
}

let abandonedSweep: Promise<number> | undefined;

/** Start the one removal of abandoned capture directories that each process runs; later calls return the same run. */
export function sweepAbandonedSnapshots(): Promise<number> {
	abandonedSweep ??= removeAbandonedSnapshots();
	return abandonedSweep;
}

export type SnapshotCaptureErrorCode =
	| "not_found"
	| "source_changed"
	| "source_unreadable"
	| "limit_exceeded"
	| "timeout"
	| "cancelled"
	| "internal";

const messages: Record<SnapshotCaptureErrorCode, string> = {
	not_found: "The snapshot source does not exist.",
	source_changed: "The snapshot source changed during capture. Retry the capture.",
	source_unreadable: "The snapshot source is unreadable.",
	limit_exceeded: "The snapshot source exceeds its byte bound.",
	timeout: "The snapshot capture deadline expired.",
	cancelled: "The snapshot capture was cancelled.",
	internal: "The snapshot capture failed.",
};

export class SnapshotCaptureError extends Error {
	readonly code: SnapshotCaptureErrorCode;
	readonly retryable: boolean;
	constructor(code: SnapshotCaptureErrorCode) {
		super(messages[code]);
		this.code = code;
		this.retryable = code === "source_changed" || code === "timeout";
	}
}

function checkSnapshotCapture(signal?: AbortSignal, deadline?: number): void {
	if (signal?.aborted)
		throw signal.reason instanceof SnapshotCaptureError ? signal.reason : new SnapshotCaptureError("cancelled");
	if (deadline !== undefined && Date.now() >= deadline) throw new SnapshotCaptureError("timeout");
}

export interface SnapshotCaptureOptions {
	readonly maxSourceBytes: number;
	readonly deadline: number;
	readonly signal?: AbortSignal;
	readonly requireExists?: boolean;
	readonly sourceRoot?: string;
	/** Deterministic race barriers for capture tests; no production callback is installed. */
	readonly onChunk?: (path: string, copiedBytes: number) => void | Promise<void>;
	readonly onDirectory?: (path: string) => void;
	readonly closeSource?: (handle: FileHandle) => Promise<void>;
}

interface SourceFile {
	readonly path: string;
	readonly handle: FileHandle;
	readonly identity: string;
	readonly size: number;
}

function identity(info: BigIntStats): string {
	return `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`;
}

async function pathIdentity(path: string): Promise<string | undefined> {
	try {
		const info = await lstat(path, { bigint: true });
		if (!info.isFile()) throw new SnapshotCaptureError("source_unreadable");
		return identity(info);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

async function sourceFile(path: string): Promise<SourceFile | undefined> {
	let handle: FileHandle;
	try {
		handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw new SnapshotCaptureError("source_unreadable");
	}
	try {
		const info = await handle.stat({ bigint: true });
		if (!info.isFile()) throw new SnapshotCaptureError("source_unreadable");
		const key = identity(info);
		if ((await pathIdentity(path)) !== key) throw new SnapshotCaptureError("source_changed");
		return { path, handle, identity: key, size: Number(info.size) };
	} catch (error) {
		await handle.close();
		throw error;
	}
}

interface SourcePair {
	readonly db: SourceFile;
	readonly wal?: SourceFile;
}

async function openSourcePair(
	path: string,
	files: SourceFile[],
	maxSourceBytes: number,
): Promise<SourcePair | undefined> {
	const db = await sourceFile(path);
	if (db === undefined) return undefined;
	files.push(db);
	const wal = await sourceFile(`${path}-wal`);
	if (wal) files.push(wal);
	const journal = await sourceFile(`${path}-journal`);
	if (journal) files.push(journal);
	if (journal && journal.size > 0) throw new SnapshotCaptureError("source_unreadable");
	if (db.size + (wal?.size ?? 0) > maxSourceBytes) throw new SnapshotCaptureError("limit_exceeded");
	if (db.size < 16) throw new SnapshotCaptureError("source_unreadable");
	return { db, wal };
}

async function createPrivateDirectory(path: string, options: SnapshotCaptureOptions): Promise<OwnedDirectory> {
	const sourceRoot = await realpath(options.sourceRoot ?? dirname(path));
	const scratchRoot = await realpath(tmpdir());
	const scratchRelative = relative(sourceRoot, scratchRoot);
	if (
		scratchRelative === "" ||
		(!isAbsolute(scratchRelative) && scratchRelative !== ".." && !scratchRelative.startsWith("../"))
	)
		throw new SnapshotCaptureError("source_unreadable");
	checkSnapshotCapture(options.signal, options.deadline);
	return createOwnedDirectory(scratchRoot);
}

async function writeChunk(
	destination: FileHandle,
	buffer: Buffer,
	bytesRead: number,
	offset: number,
	options: SnapshotCaptureOptions,
): Promise<void> {
	let written = 0;
	while (written < bytesRead) {
		checkSnapshotCapture(options.signal, options.deadline);
		const result = await destination.write(buffer, written, bytesRead - written, offset + written);
		if (result.bytesWritten === 0) throw new SnapshotCaptureError("internal");
		written += result.bytesWritten;
	}
}

async function copySourceFile(
	file: SourceFile,
	target: string,
	main: boolean,
	buffer: Buffer,
	budget: { copied: number },
	options: SnapshotCaptureOptions,
): Promise<void> {
	const destination = await open(target, "wx", 0o600);
	try {
		let offset = 0;
		while (offset < file.size) {
			checkSnapshotCapture(options.signal, options.deadline);
			const { bytesRead } = await file.handle.read(buffer, 0, Math.min(buffer.length, file.size - offset), offset);
			if (bytesRead === 0) throw new SnapshotCaptureError("source_changed");
			if (main && offset === 0 && buffer.subarray(0, 16).toString("binary") !== "SQLite format 3\u0000")
				throw new SnapshotCaptureError("source_unreadable");
			budget.copied += bytesRead;
			if (budget.copied > options.maxSourceBytes) throw new SnapshotCaptureError("limit_exceeded");
			await writeChunk(destination, buffer, bytesRead, offset, options);
			offset += bytesRead;
			await options.onChunk?.(file.path, offset);
		}
	} finally {
		await destination.close();
	}
}

async function copySourcePair(pair: SourcePair, target: string, options: SnapshotCaptureOptions): Promise<void> {
	const buffer = Buffer.alloc(64 * 1024);
	const budget = { copied: 0 };
	await copySourceFile(pair.db, target, true, buffer, budget, options);
	if (pair.wal) await copySourceFile(pair.wal, `${target}-wal`, false, buffer, budget, options);
}

async function optionalWalStat(path: string): Promise<BigIntStats | undefined> {
	try {
		return await lstat(`${path}-wal`, { bigint: true });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

async function checkStableSource(path: string, files: SourceFile[], maxSourceBytes: number): Promise<void> {
	const currentSizes = await Promise.all([lstat(path, { bigint: true }), optionalWalStat(path)]);
	if (Number(currentSizes[0]?.size ?? 0n) + Number(currentSizes[1]?.size ?? 0n) > maxSourceBytes)
		throw new SnapshotCaptureError("limit_exceeded");
	for (const suffix of ["", "-wal", "-journal"]) {
		const file = files.find((value) => value.path === `${path}${suffix}`);
		if ((await pathIdentity(`${path}${suffix}`)) !== file?.identity) throw new SnapshotCaptureError("source_changed");
		if (file && identity(await file.handle.stat({ bigint: true })) !== file.identity)
			throw new SnapshotCaptureError("source_changed");
	}
}

async function closeSourceFiles(files: SourceFile[], options: SnapshotCaptureOptions): Promise<void> {
	const closed = await Promise.allSettled(
		files.map((file) => (options.closeSource ? options.closeSource(file.handle) : file.handle.close())),
	);
	if (closed.some((result) => result.status === "rejected")) throw new SnapshotCaptureError("source_unreadable");
	files.length = 0;
}

/** Recovery and validation use only the disposable copy, without a copied SHM index. */
function validatePrivateDatabase(target: string): void {
	const validation = new DatabaseSync(target);
	try {
		const rows = validation.prepare("PRAGMA quick_check").all();
		if (rows.length !== 1 || Object.values(rows[0] ?? {})[0] !== "ok")
			throw new SnapshotCaptureError("source_unreadable");
	} finally {
		validation.close();
	}
}

async function cleanupFailedCapture(storage: Storage | undefined, directory: string | undefined): Promise<void> {
	await storage?.close(BACKGROUND_CONTEXT).catch(() => {});
	if (directory) await removeOwnedDirectory(directory).catch(() => {});
}

function captureFailure(error: unknown): SnapshotCaptureError {
	if (error instanceof SnapshotCaptureError) return error;
	if ((error as NodeJS.ErrnoException).code === "ENOENT") return new SnapshotCaptureError("source_changed");
	return new SnapshotCaptureError("source_unreadable");
}

/** Never opens the retained source through SQLite, even for an idle database. */
export async function captureSnapshot(
	path: string,
	options: SnapshotCaptureOptions,
): Promise<{ storage: Storage; reopen: () => Promise<Storage>; cleanup?: () => Promise<void>; absent?: boolean }> {
	const files: SourceFile[] = [];
	let directory: string | undefined;
	let storage: Storage | undefined;
	const check = (): void => checkSnapshotCapture(options.signal, options.deadline);
	try {
		check();
		const pair = await openSourcePair(path, files, options.maxSourceBytes);
		if (pair === undefined) {
			if (options.requireExists) throw new SnapshotCaptureError("not_found");
			return {
				storage: await openNodeSqliteStorage(":memory:"),
				reopen: () => openNodeSqliteStorage(":memory:"),
				absent: true,
			};
		}
		directory = (await createPrivateDirectory(path, options)).path;
		options.onDirectory?.(directory);
		const target = join(directory, "snapshot.sqlite");
		await copySourcePair(pair, target, options);
		check();
		await checkStableSource(path, files, options.maxSourceBytes);
		await closeSourceFiles(files, options);
		check();
		validatePrivateDatabase(target);
		check();
		storage = await openNodeSqliteStorage(target);
		check();
		const ownedDirectory = directory;
		return {
			storage,
			reopen: () => openNodeSqliteStorage(target),
			cleanup: () => removeOwnedDirectory(ownedDirectory),
		};
	} catch (error) {
		await cleanupFailedCapture(storage, directory);
		throw captureFailure(error);
	} finally {
		await Promise.allSettled(files.map((file) => file.handle.close()));
	}
}
