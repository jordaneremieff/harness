/** Filesystem-only capture of a SQLite database and its WAL into private storage. */
import { constants, type BigIntStats } from "node:fs";
import { lstat, mkdtemp, open, realpath, rm, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import type { Storage } from "@earendil-works/pi-durable";
import { checkRetainedRead, RetainedReadError } from "./retained-errors.ts";

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
		if (!info.isFile()) throw new RetainedReadError("source_unreadable");
		return identity(info);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

async function sourceFile(path: string): Promise<SourceFile | undefined> {
	let handle: FileHandle;
	try { handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw new RetainedReadError("source_unreadable");
	}
	try {
		const info = await handle.stat({ bigint: true });
		if (!info.isFile()) throw new RetainedReadError("source_unreadable");
		const key = identity(info);
		if (await pathIdentity(path) !== key) throw new RetainedReadError("source_changed");
		return { path, handle, identity: key, size: Number(info.size) };
	} catch (error) { await handle.close(); throw error; }
}

interface SourcePair {
	readonly db: SourceFile;
	readonly wal?: SourceFile;
}

async function openSourcePair(path: string, files: SourceFile[], maxSourceBytes: number): Promise<SourcePair | undefined> {
	const db = await sourceFile(path);
	if (db === undefined) return undefined;
	files.push(db);
	const wal = await sourceFile(`${path}-wal`);
	if (wal) files.push(wal);
	const journal = await sourceFile(`${path}-journal`);
	if (journal) files.push(journal);
	if (journal && journal.size > 0) throw new RetainedReadError("source_unreadable");
	if (db.size + (wal?.size ?? 0) > maxSourceBytes) throw new RetainedReadError("limit_exceeded");
	if (db.size < 16) throw new RetainedReadError("source_unreadable");
	return { db, wal };
}

async function createPrivateDirectory(path: string, options: SnapshotCaptureOptions): Promise<string> {
	const sourceRoot = await realpath(options.sourceRoot ?? dirname(path));
	const scratchRoot = await realpath(tmpdir());
	const scratchRelative = relative(sourceRoot, scratchRoot);
	if (scratchRelative === "" || (!isAbsolute(scratchRelative) && scratchRelative !== ".." && !scratchRelative.startsWith("../"))) throw new RetainedReadError("source_unreadable");
	checkRetainedRead(options.signal, options.deadline);
	return mkdtemp(join(scratchRoot, "pi-durable-snapshot-"));
}

async function writeChunk(destination: FileHandle, buffer: Buffer, bytesRead: number, offset: number, options: SnapshotCaptureOptions): Promise<void> {
	let written = 0;
	while (written < bytesRead) {
		checkRetainedRead(options.signal, options.deadline);
		const result = await destination.write(buffer, written, bytesRead - written, offset + written);
		if (result.bytesWritten === 0) throw new RetainedReadError("internal");
		written += result.bytesWritten;
	}
}

async function copySourceFile(file: SourceFile, target: string, main: boolean, buffer: Buffer, budget: { copied: number }, options: SnapshotCaptureOptions): Promise<void> {
	const destination = await open(target, "wx", 0o600);
	try {
		let offset = 0;
		while (offset < file.size) {
			checkRetainedRead(options.signal, options.deadline);
			const { bytesRead } = await file.handle.read(buffer, 0, Math.min(buffer.length, file.size - offset), offset);
			if (bytesRead === 0) throw new RetainedReadError("source_changed");
			if (main && offset === 0 && buffer.subarray(0, 16).toString("binary") !== "SQLite format 3\u0000") throw new RetainedReadError("source_unreadable");
			budget.copied += bytesRead;
			if (budget.copied > options.maxSourceBytes) throw new RetainedReadError("limit_exceeded");
			await writeChunk(destination, buffer, bytesRead, offset, options);
			offset += bytesRead;
			await options.onChunk?.(file.path, offset);
		}
	} finally { await destination.close(); }
}

async function copySourcePair(pair: SourcePair, target: string, options: SnapshotCaptureOptions): Promise<void> {
	const buffer = Buffer.alloc(64 * 1024);
	const budget = { copied: 0 };
	await copySourceFile(pair.db, target, true, buffer, budget, options);
	if (pair.wal) await copySourceFile(pair.wal, `${target}-wal`, false, buffer, budget, options);
}

async function optionalWalStat(path: string): Promise<BigIntStats | undefined> {
	try { return await lstat(`${path}-wal`, { bigint: true }); }
	catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}

async function checkStableSource(path: string, files: SourceFile[], maxSourceBytes: number): Promise<void> {
	const currentSizes = await Promise.all([lstat(path, { bigint: true }), optionalWalStat(path)]);
	if (Number(currentSizes[0]?.size ?? 0n) + Number(currentSizes[1]?.size ?? 0n) > maxSourceBytes) throw new RetainedReadError("limit_exceeded");
	for (const suffix of ["", "-wal", "-journal"]) {
		const file = files.find((value) => value.path === `${path}${suffix}`);
		if (await pathIdentity(`${path}${suffix}`) !== file?.identity) throw new RetainedReadError("source_changed");
		if (file && identity(await file.handle.stat({ bigint: true })) !== file.identity) throw new RetainedReadError("source_changed");
	}
}

async function closeSourceFiles(files: SourceFile[], options: SnapshotCaptureOptions): Promise<void> {
	const closed = await Promise.allSettled(files.map((file) => options.closeSource ? options.closeSource(file.handle) : file.handle.close()));
	if (closed.some((result) => result.status === "rejected")) throw new RetainedReadError("source_unreadable");
	files.length = 0;
}

/** Recovery and validation use only the disposable copy, without a copied SHM index. */
function validatePrivateDatabase(target: string): void {
	const validation = new DatabaseSync(target);
	try {
		const rows = validation.prepare("PRAGMA quick_check").all();
		if (rows.length !== 1 || Object.values(rows[0] ?? {})[0] !== "ok") throw new RetainedReadError("source_unreadable");
	} finally { validation.close(); }
}

async function cleanupFailedCapture(storage: Storage | undefined, directory: string | undefined): Promise<void> {
	await storage?.close(BACKGROUND_CONTEXT).catch(() => {});
	if (directory) await rm(directory, { recursive: true, force: true });
}

function captureFailure(error: unknown): RetainedReadError {
	if (error instanceof RetainedReadError) return error;
	if ((error as NodeJS.ErrnoException).code === "ENOENT") return new RetainedReadError("source_changed");
	return new RetainedReadError("source_unreadable");
}

/** Never opens the retained source through SQLite, even for an idle database. */
export async function captureSnapshot(path: string, options: SnapshotCaptureOptions): Promise<{ storage: Storage; cleanup?: () => Promise<void>; absent?: boolean }> {
	const files: SourceFile[] = [];
	let directory: string | undefined;
	let storage: Storage | undefined;
	const check = (): void => checkRetainedRead(options.signal, options.deadline);
	try {
		check();
		const pair = await openSourcePair(path, files, options.maxSourceBytes);
		if (pair === undefined) {
			if (options.requireExists) throw new RetainedReadError("not_found");
			return { storage: await openNodeSqliteStorage(":memory:"), absent: true };
		}
		directory = await createPrivateDirectory(path, options);
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
		return { storage, cleanup: () => rm(ownedDirectory, { recursive: true, force: true }) };
	} catch (error) {
		await cleanupFailedCapture(storage, directory);
		throw captureFailure(error);
	} finally { await Promise.allSettled(files.map((file) => file.handle.close())); }
}
