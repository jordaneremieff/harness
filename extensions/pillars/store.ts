/** Private local persistence for Pillars day shards: lock-free reads, rename-published writes. */

import { closeSync, constants, fstatSync, lstatSync, openSync, renameSync, unlinkSync, type Stats } from "node:fs";
import { lstat, mkdir, open, readdir } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { getHeapStatistics } from "node:v8";
import {
	dayNumber, inWindow, LIMITS, planCommit, validateBatch, validateShard, validateSnapshot,
	type Batch, type CommitStatus, type Shard, type Snapshot,
} from "./capacity.ts";

export class StoreUnavailableError extends Error {
	constructor(message = "store_unreadable") { super(message); this.name = "StoreUnavailableError"; }
}

export class StoreBusyError extends StoreUnavailableError {
	constructor() {
		super("Pillars aggregate writer is busy. The next publication event retries. This writer never removes the lock file. Do not remove it.");
		this.name = "StoreBusyError";
	}
}
export class StoreLockIdentityError extends StoreUnavailableError {
	constructor() {
		super("Pillars lock path changed during the write. Publication stopped. This writer never removes the lock file. Do not remove it.");
		this.name = "StoreLockIdentityError";
	}
}
export class StorePlatformError extends StoreUnavailableError {
	constructor() { super("Pillars aggregate writes require macOS."); this.name = "StorePlatformError"; }
}
interface ExclusiveLease {
	readonly descriptor: number;
	readonly device: number;
	readonly inode: number;
	assertNamed(): void;
	release(): void;
}

const LOCK = "store.lock";
const PENDING = "pending.tmp";
const SLOT = /^day-(?:[0-2][0-9])\.json$/;
const O_EXLOCK = 0x20;
const REJECTIONS = ["clock_rollback", "store_corrupt", "response_overflow"];
const NO_FOLLOW = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;

interface Scan { slots: Map<string, number>; pending: boolean }

function aborted(): Error { return new DOMException("The operation was aborted", "AbortError"); }
function corrupt(): Error { return new Error("store_corrupt"); }
function code(error: unknown): string | undefined {
	return error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : undefined;
}
function owner(): number | undefined {
	return typeof process.getuid === "function" ? process.getuid() : undefined;
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
function chainFrom(root: string): string[] {
	if (!isAbsolute(root) || resolve(root) !== root) throw new StoreUnavailableError();
	const chain: string[] = [];
	for (let current = root; ; current = dirname(current)) {
		chain.unshift(current);
		if (dirname(current) === current) break;
	}
	return chain;
}

function verifyChainDirectory(info: Stats, uid: number | undefined, isPrivate: boolean): void {
	if (!info.isDirectory() || info.isSymbolicLink()) throw new StoreUnavailableError();
	if (uid !== undefined && (isPrivate ? info.uid !== uid : info.uid !== uid && info.uid !== 0))
		throw new StoreUnavailableError();
	if ((info.mode & (isPrivate ? 0o077 : 0o022)) !== 0) throw new StoreUnavailableError();
}

async function chainEntry(component: string): Promise<Stats | undefined> {
	try {
		return await lstat(component);
	} catch (error) {
		if (code(error) === "ENOENT") return undefined;
		throw error;
	}
}

async function verifyChain(root: string): Promise<boolean> {
	const chain = chainFrom(root);
	const uid = owner();
	for (const [index, component] of chain.entries()) {
		const info = await chainEntry(component);
		if (!info) return false;
		verifyChainDirectory(info, uid, index === chain.length - 1);
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
	private heldLock: ExclusiveLease | undefined;
	private pendingIdentity: { dev: number; ino: number } | undefined;
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
			if (error instanceof StoreBusyError || error instanceof StoreLockIdentityError || error instanceof StorePlatformError) throw error;
			if (signal?.aborted) throw aborted();
			if (error instanceof Error && REJECTIONS.includes(error.message)) throw error;
			throw new StoreUnavailableError();
		} finally { this.active = false; }
	}

	private async read(today: string, start: NodeJS.MemoryUsage, signal?: AbortSignal): Promise<Snapshot> {
		if (!(await verifyChain(this.root))) return { shards: {} };
		if (signal?.aborted) throw aborted();
		const scan = await this.scan();
		// Only a writer can resolve an interrupted publication.
		if (scan.pending) throw new StoreUnavailableError();
		const snapshot = await this.load(scan, start);
		try {
			validateSnapshot(snapshot, today);
		} catch (error) {
			if (error instanceof Error && error.message === "clock_rollback") throw error;
			throw corrupt();
		}
		return { shards: Object.fromEntries(Object.entries(snapshot.shards).filter(([day]) => inWindow(day, today))) };
	}

	private async confirmNoPublication(status: CommitStatus): Promise<CommitStatus> {
		if (status !== "duplicate") return status;
		try { await syncDirectory(this.root); }
		catch { return "publication_failed"; }
		return status;
	}

	private async write(batch: Batch, today: string, start: NodeJS.MemoryUsage, signal?: AbortSignal): Promise<CommitStatus> {
		if (process.platform !== "darwin") throw new StorePlatformError();
		await mkdir(this.root, { recursive: true, mode: 0o700 });
		if (!(await verifyChain(this.root))) throw new StoreUnavailableError();
		if (signal?.aborted) throw aborted();
		this.heldLock = this.acquire(signal);
		try {
			let scan = await this.scan();
			if (scan.pending) {
				// An interrupted publication never reached a slot name; drop it.
				this.heldLock.assertNamed();
				unlinkSync(join(this.root, PENDING));
				await syncDirectory(this.root);
				scan = await this.scan();
			}
			if (signal?.aborted) throw aborted();
			const snapshot = await this.load(scan, start);
			try { validateSnapshot(snapshot); } catch { throw corrupt(); }
			const plan = planCommit(snapshot, batch, today);
			if (!plan.candidate || !plan.slot) {
				this.heldLock.assertNamed();
				const status = await this.confirmNoPublication(plan.status);
				this.heldLock.assertNamed();
				return status;
			}
			if (signal?.aborted) throw aborted();
			const published = await this.publish(this.encode(plan.candidate, scan), plan.slot, plan.expiredSlots);
			this.heldLock.assertNamed();
			if (signal?.aborted) throw aborted();
			return published ? plan.status : "publication_failed";
		} catch (error) {
			this.lease().assertNamed();
			throw error;
		} finally {
			const held = this.heldLock;
			this.heldLock = undefined;
			held.release();
		}
	}

	private encode(candidate: Shard, scan: Scan): Buffer {
		const payload = Buffer.from(JSON.stringify(candidate), "utf8");
		let stored = 0;
		for (const size of scan.slots.values()) stored += size;
		if (payload.length > LIMITS.shardBytes || stored + payload.length + LIMITS.controlBytes > LIMITS.storeBytes)
			throw new StoreUnavailableError();
		return payload;
	}

	private acquire(signal?: AbortSignal): ExclusiveLease {
		if (signal?.aborted) throw aborted();
		const path = join(this.root, LOCK);
		let descriptor: number;
		try {
			descriptor = openSync(path, constants.O_RDWR | constants.O_CREAT | constants.O_NONBLOCK | NO_FOLLOW | O_EXLOCK, 0o600);
		} catch (error) {
			if (code(error) === "EAGAIN") throw new StoreBusyError();
			throw new StoreUnavailableError();
		}
		let closed = false, poisoned = false;
		try {
			const info = fstatSync(descriptor);
			if (!info.isFile() || info.nlink < 1 || owner() === undefined || info.uid !== owner() ||
				(info.mode & 0o077) !== 0 || info.size > LIMITS.controlBytes) throw new StoreUnavailableError();
			const lease: ExclusiveLease = {
				descriptor, device: info.dev, inode: info.ino,
				assertNamed() {
					if (closed || poisoned) throw new StoreLockIdentityError();
					try {
						const held = fstatSync(descriptor), named = lstatSync(path);
						if (!named.isFile() || held.dev !== info.dev || held.ino !== info.ino ||
							named.dev !== held.dev || named.ino !== held.ino) throw new StoreLockIdentityError();
					} catch {
						poisoned = true;
						throw new StoreLockIdentityError();
					}
				},
				release() { if (!closed) { closed = true; closeSync(descriptor); } },
			};
			lease.assertNamed();
			return lease;
		} catch (error) { closeSync(descriptor); throw error; }
	}

	private async entryStats(name: string, uid: number | undefined): Promise<Stats> {
		if (name !== LOCK && name !== PENDING && !SLOT.test(name)) throw new StoreUnavailableError();
		const info = await lstat(join(this.root, name));
		const maxBytes = name === LOCK ? LIMITS.controlBytes : LIMITS.shardBytes;
		if (
			!info.isFile() ||
			(name === LOCK ? info.nlink < 1 : info.nlink !== 1) ||
			(uid !== undefined && info.uid !== uid) ||
			(info.mode & 0o077) !== 0 ||
			info.size > maxBytes
		) {
			throw new StoreUnavailableError();
		}
		return info;
	}

	/** Admission is by name, type, link count, owner, private mode, and size. */
	private async scan(): Promise<Scan> {
		const names = (await readdir(this.root)).filter((name) => name !== ".DS_Store");
		if (names.length > LIMITS.entries) throw new StoreUnavailableError();
		const uid = owner();
		const scan: Scan = { slots: new Map(), pending: false };
		for (const name of names.sort()) {
			const info = await this.entryStats(name, uid);
			if (name === PENDING) scan.pending = true;
			else if (name !== LOCK) scan.slots.set(name, info.size);
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

	/** Readers see a whole shard after rename; its receipt survives an uncertain directory sync. */
	private async writePending(path: string, payload: Buffer): Promise<void> {
		const handle = await open(path, "wx", 0o600);
		try {
			const info = await handle.stat();
			this.pendingIdentity = { dev: info.dev, ino: info.ino };
			for (let written = 0; written < payload.length; ) {
				const { bytesWritten } = await handle.write(payload, written, payload.length - written, written);
				if (bytesWritten === 0) throw new StoreUnavailableError();
				written += bytesWritten;
			}
			await handle.sync();
		} finally { await handle.close(); }
	}

	private lease(): ExclusiveLease {
		if (!this.heldLock) throw new StoreLockIdentityError();
		return this.heldLock;
	}

	private async removeExpired(slots: readonly string[]): Promise<void> {
		const lease = this.lease();
		lease.assertNamed();
		let removed = false;
		for (const expired of slots) {
			try {
				lease.assertNamed();
				unlinkSync(join(this.root, expired));
				removed = true;
			} catch (error) { if (code(error) !== "ENOENT") throw error; }
		}
		if (removed) await syncDirectory(this.root);
	}

	private discardPending(pending: string, lease: ExclusiveLease): void {
		if (!this.pendingIdentity) return;
		try {
			const named = lstatSync(pending);
			if (named.dev !== this.pendingIdentity.dev || named.ino !== this.pendingIdentity.ino) return;
			lease.assertNamed();
			unlinkSync(pending);
		} catch (error) { if (error instanceof StoreLockIdentityError) throw error; }
	}

	private async publish(payload: Buffer, slot: string, expiredSlots: readonly string[]): Promise<boolean> {
		const pending = join(this.root, PENDING), lease = this.lease();
		let renamed = false;
		this.pendingIdentity = undefined;
		try {
			lease.assertNamed();
			await this.writePending(pending, payload);
			lease.assertNamed();
			renameSync(pending, join(this.root, slot));
			renamed = true;
			await syncDirectory(this.root);
			await this.removeExpired(expiredSlots);
			return true;
		} catch (error) {
			if (error instanceof StoreLockIdentityError) throw error;
			lease.assertNamed();
			if (!renamed) this.discardPending(pending, lease);
			return false;
		}
	}
}
