/** Private local persistence for Pillars day shards: lock-free reads, rename-published writes. */

import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, rename, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { getHeapStatistics } from "node:v8";
import {
	dayNumber, inWindow, LIMITS, planCommit, validateBatch, validateShard, validateSnapshot,
	type Batch, type CommitStatus, type Shard, type Snapshot,
} from "./capacity.ts";

export class StoreUnavailableError extends Error {
	constructor() { super("store_unreadable"); this.name = "StoreUnavailableError"; }
}

const LOCK = "store.lock";
const PENDING = "pending.tmp";
const SLOT = /^day-(?:[0-2][0-9])\.json$/;
/** A lock older than this belongs to a dead writer; the next writer removes it. */
const STALE_LOCK_MS = 30_000;
const POLL_MS = 5;
const REJECTIONS = ["clock_rollback", "store_corrupt", "response_overflow"];
const NO_FOLLOW = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;

interface Scan { slots: Map<string, number>; lockBytes?: number; pending: boolean }

function aborted(): Error { return new DOMException("The operation was aborted", "AbortError"); }
function corrupt(): Error { return new Error("store_corrupt"); }
function code(error: unknown): string | undefined {
	return error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : undefined;
}
function owner(): number | undefined {
	return typeof process.getuid === "function" ? process.getuid() : undefined;
}
function delay(milliseconds: number): Promise<void> {
	return new Promise((accept) => { setTimeout(accept, milliseconds); });
}
function memoryGuard(start: NodeJS.MemoryUsage): void {
	const used = process.memoryUsage();
	if (used.heapUsed - start.heapUsed > 192 * 1024 * 1024 || used.rss - start.rss > 256 * 1024 * 1024 ||
		getHeapStatistics().heap_size_limit - used.heapUsed < 128 * 1024 * 1024) throw new Error("response_overflow");
}

/**
 * Every component from the filesystem root down must be a real directory that no
 * other user can rewrite, and the store itself must be private to this user.
 * Returns false when the store does not exist yet; a reader treats that as empty.
 */
async function verifyChain(root: string): Promise<boolean> {
	if (!isAbsolute(root) || resolve(root) !== root) throw new StoreUnavailableError();
	const chain: string[] = [];
	for (let current = root; ; current = dirname(current)) {
		chain.unshift(current);
		if (dirname(current) === current) break;
	}
	const uid = owner();
	for (const [index, component] of chain.entries()) {
		let info: Awaited<ReturnType<typeof lstat>>;
		try {
			info = await lstat(component);
		} catch (error) {
			if (code(error) === "ENOENT") return false;
			throw error;
		}
		if (!info.isDirectory() || info.isSymbolicLink()) throw new StoreUnavailableError();
		if (index === chain.length - 1) {
			if ((uid !== undefined && info.uid !== uid) || (info.mode & 0o077) !== 0) throw new StoreUnavailableError();
		} else if ((uid !== undefined && info.uid !== uid && info.uid !== 0) || (info.mode & 0o022) !== 0) {
			throw new StoreUnavailableError();
		}
	}
	return true;
}

async function syncDirectory(root: string): Promise<void> {
	const handle = await open(root, "r");
	try { await handle.sync(); } finally { await handle.close(); }
}

/** One transaction at a time per instance; readers never create, write, or remove a file. */
export class PillarsStore {
	readonly root: string;
	private active = false;
	constructor(root: string) { this.root = root; }

	async capture(today: string, signal?: AbortSignal): Promise<Snapshot> {
		return this.transaction(today, signal, (start) => this.read(today, start, signal));
	}

	async commit(batch: Batch, today: string, signal?: AbortSignal): Promise<CommitStatus> {
		validateBatch(batch);
		// The immutable copy protects a pending write against later caller mutation.
		const sealed = structuredClone(batch);
		return this.transaction(today, signal, (start) => this.write(sealed, today, start, signal));
	}

	private async transaction<T>(today: string, signal: AbortSignal | undefined, run: (start: NodeJS.MemoryUsage) => Promise<T>): Promise<T> {
		dayNumber(today);
		if (signal?.aborted) throw aborted();
		if (this.active) throw new StoreUnavailableError();
		this.active = true;
		try {
			const start = process.memoryUsage();
			memoryGuard(start);
			return await run(start);
		} catch (error) {
			if (signal?.aborted) throw aborted();
			if (error instanceof Error && REJECTIONS.includes(error.message)) throw error;
			throw new StoreUnavailableError();
		} finally { this.active = false; }
	}

	private async read(today: string, start: NodeJS.MemoryUsage, signal?: AbortSignal): Promise<Snapshot> {
		if (!(await verifyChain(this.root))) return { shards: {} };
		if (signal?.aborted) throw aborted();
		const scan = await this.scan();
		// Unresolved temporary state and a written control file are writer business.
		if (scan.pending || (scan.lockBytes !== undefined && scan.lockBytes > 0)) throw new StoreUnavailableError();
		const snapshot = await this.load(scan, start);
		try {
			validateSnapshot(snapshot, today);
		} catch (error) {
			if (error instanceof Error && error.message === "clock_rollback") throw error;
			throw corrupt();
		}
		return { shards: Object.fromEntries(Object.entries(snapshot.shards).filter(([day]) => inWindow(day, today))) };
	}

	private async write(batch: Batch, today: string, start: NodeJS.MemoryUsage, signal?: AbortSignal): Promise<CommitStatus> {
		await mkdir(this.root, { recursive: true, mode: 0o700 });
		if (!(await verifyChain(this.root))) throw new StoreUnavailableError();
		if (signal?.aborted) throw aborted();
		await this.acquire(signal);
		try {
			let scan = await this.scan();
			if (scan.pending) {
				// An interrupted publication never reached a slot name; drop it.
				await unlink(join(this.root, PENDING));
				await syncDirectory(this.root);
				scan = await this.scan();
			}
			if (signal?.aborted) throw aborted();
			const snapshot = await this.load(scan, start);
			try { validateSnapshot(snapshot); } catch { throw corrupt(); }
			const plan = planCommit(snapshot, batch, today);
			if (!plan.candidate || !plan.slot) return plan.status;
			if (signal?.aborted) throw aborted();
			const payload = Buffer.from(JSON.stringify(plan.candidate), "utf8");
			let stored = 0;
			for (const size of scan.slots.values()) stored += size;
			if (payload.length > LIMITS.shardBytes || stored + payload.length + LIMITS.controlBytes > LIMITS.storeBytes) {
				throw new StoreUnavailableError();
			}
			const published = await this.publish(payload, plan.slot, plan.expiredSlots);
			if (signal?.aborted) throw aborted();
			return published ? plan.status : "publication_failed";
		} finally { await this.release(); }
	}

	private async acquire(signal?: AbortSignal): Promise<void> {
		const path = join(this.root, LOCK);
		const deadline = Date.now() + LIMITS.lockMilliseconds;
		let broken = false;
		for (let attempt = 0; ; attempt++) {
			if (attempt > 0 && Date.now() >= deadline) throw new StoreUnavailableError();
			try {
				const handle = await open(path, "wx", 0o600);
				await handle.close();
				return;
			} catch (error) {
				if (code(error) !== "EEXIST") throw error;
			}
			if (!broken) {
				let info: Awaited<ReturnType<typeof lstat>> | undefined;
				try {
					info = await lstat(path);
				} catch (error) {
					if (code(error) !== "ENOENT") throw error;
					continue;
				}
				if (!info.isFile()) throw new StoreUnavailableError();
				if (Date.now() - info.mtimeMs > STALE_LOCK_MS) {
					broken = true;
					try { await unlink(path); } catch (error) { if (code(error) !== "ENOENT") throw error; }
					continue;
				}
			}
			await delay(POLL_MS);
			if (signal?.aborted) throw aborted();
		}
	}

	private async release(): Promise<void> {
		try { await unlink(join(this.root, LOCK)); } catch (error) { if (code(error) !== "ENOENT") throw error; }
	}

	/** Admission is by name, type, link count, owner, private mode, and size. */
	private async scan(): Promise<Scan> {
		const names = await readdir(this.root);
		if (names.length > LIMITS.entries) throw new StoreUnavailableError();
		const uid = owner();
		const scan: Scan = { slots: new Map(), pending: false };
		for (const name of names.sort()) {
			if (name !== LOCK && name !== PENDING && !SLOT.test(name)) throw new StoreUnavailableError();
			const info = await lstat(join(this.root, name));
			if (!info.isFile() || info.nlink !== 1 || (uid !== undefined && info.uid !== uid) ||
				(info.mode & 0o077) !== 0 || info.size > (name === LOCK ? LIMITS.controlBytes : LIMITS.shardBytes)) {
				throw new StoreUnavailableError();
			}
			if (name === LOCK) scan.lockBytes = info.size;
			else if (name === PENDING) scan.pending = true;
			else scan.slots.set(name, info.size);
		}
		return scan;
	}

	private async load(scan: Scan, start: NodeJS.MemoryUsage): Promise<Snapshot> {
		const shards: Record<string, Shard> = {};
		for (const slot of scan.slots.keys()) {
			const shard = await this.readShard(slot, start);
			if (Object.hasOwn(shards, shard.day)) throw new StoreUnavailableError();
			shards[shard.day] = shard;
		}
		return { shards };
	}

	private async readShard(slot: string, start: NodeJS.MemoryUsage): Promise<Shard> {
		const handle = await open(join(this.root, slot), constants.O_RDONLY | NO_FOLLOW);
		let raw: Buffer;
		try {
			const info = await handle.stat();
			if (!info.isFile() || info.nlink !== 1 || info.size > LIMITS.shardBytes) throw new StoreUnavailableError();
			raw = Buffer.alloc(info.size);
			for (let read = 0; read < info.size; ) {
				const { bytesRead } = await handle.read(raw, read, info.size - read, read);
				if (bytesRead === 0) throw new StoreUnavailableError();
				read += bytesRead;
			}
		} finally { await handle.close(); }
		let value: unknown;
		try {
			value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw));
		} catch (error) {
			if (error instanceof SyntaxError || error instanceof RangeError || error instanceof TypeError) throw corrupt();
			throw error;
		}
		memoryGuard(start);
		try { validateShard(value, slot); } catch { throw corrupt(); }
		return value;
	}

	/**
	 * A slot file changes only by rename, so every reader sees a whole shard.
	 * A failure keeps the sealed batch retryable: the caller receives a status,
	 * never a partially applied store.
	 */
	private async publish(payload: Buffer, slot: string, expiredSlots: readonly string[]): Promise<boolean> {
		const pending = join(this.root, PENDING);
		let renamed = false;
		try {
			const handle = await open(pending, "wx", 0o600);
			try {
				for (let written = 0; written < payload.length; ) {
					const { bytesWritten } = await handle.write(payload, written, payload.length - written, written);
					if (bytesWritten === 0) throw new StoreUnavailableError();
					written += bytesWritten;
				}
				await handle.sync();
			} finally { await handle.close(); }
			await rename(pending, join(this.root, slot));
			renamed = true;
			await syncDirectory(this.root);
			let removed = false;
			for (const expired of expiredSlots) {
				try {
					await unlink(join(this.root, expired));
					removed = true;
				} catch (error) { if (code(error) !== "ENOENT") throw error; }
			}
			if (removed) await syncDirectory(this.root);
			return true;
		} catch {
			if (!renamed) { try { await unlink(pending); } catch { /* the temporary file may not exist */ } }
			return false;
		}
	}
}
