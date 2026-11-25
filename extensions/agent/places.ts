/**
 * agent/places: durable bindings from a working area to the agent session that
 * owns it.
 *
 * A place is a directory plus the session that carries the reasoning about it.
 * The binding lives beside the sessions, so the same session answers for the
 * same area across primary sessions and machine restarts. Resolution is by
 * longest matching directory, so a session bound to a subdirectory wins over a
 * session bound to its parent.
 *
 * Every mutation holds a kernel lock (`O_EXLOCK`) on one lock file beside the
 * book, which the kernel releases when its holder exits, so a dead holder never
 * blocks a later mutation. The file also carries a claim in the shared
 * writer-claim shape, marked as kernel-held, for diagnostics. A claim without
 * that mark comes from the exclusive-create protocol that takes no kernel lock,
 * and it still excludes: its holder may be live. The holder removes the file
 * while it still holds the lock. A mutation waits a bounded time for a live
 * holder. Reads never follow a symlink. Reads admit at most
 * `PLACE_FILE_MAX_BYTES` and use one extra sentinel byte to detect growth.
 * A mutation refuses a malformed, oversized, nonregular,
 * or symlinked book instead of replacing it, so unknown bindings are never
 * erased.
 */

import { randomBytes } from "node:crypto";
import {
	closeSync,
	constants,
	fstatSync,
	ftruncateSync,
	lstatSync,
	mkdirSync,
	openSync,
	readSync,
	realpathSync,
	renameSync,
	unlinkSync,
	watch,
	writeSync,
	writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import { dirname, join, resolve, sep } from "node:path";

/** One area-to-session binding. */
export interface PlaceBinding {
	/** Absolute directory the session owns. */
	area: string;
	sessionId: string;
	/** Operator description of the concern; absent when none was given. */
	topic?: string;
	boundAt: string;
}

/** Committed transaction: the retained binding, the caller value, and whether the operation bound a session. */
export interface PlaceTransaction<T> {
	readonly binding: PlaceBinding;
	readonly value: T;
	readonly created: boolean;
}

/** Claim written by the process that holds the mutation lock; the shared claim fields plus a release token. */
export interface PlaceLockClaim {
	readonly token: string;
	readonly pid: number;
	readonly host: string;
	readonly sessionId: string;
	readonly cwd: string;
	readonly createdAt: string;
	/** Set by a holder of the kernel lock; its claim excludes only while that lock is held. */
	readonly kernel?: true;
}

/** One bounded read of the book: usable bindings, an absent file, or explicit corruption. */
export type PlaceReadState =
	| { readonly kind: "ok"; readonly bindings: PlaceBinding[] }
	| { readonly kind: "absent" }
	| { readonly kind: "corrupt"; readonly reason: string };

/** The mutation lock is held by a live or unverifiable holder. */
export class PlaceLockedError extends Error {
	readonly file: string;
	readonly claim: PlaceLockClaim | undefined;

	constructor(file: string, claim: PlaceLockClaim | undefined, detail?: string) {
		const suffix = detail === undefined ? "" : `: ${detail}`;
		super(
			claim === undefined
				? `place book ${file} is locked and its claim is unreadable${suffix}`
				: `place book ${file} is locked by process ${claim.pid} on ${claim.host} since ${claim.createdAt}${suffix}`,
		);
		this.name = "PlaceLockedError";
		this.file = file;
		this.claim = claim;
	}
}

/** The book exists but cannot be read safely, so a mutation must not replace it. */
export class PlaceBookError extends Error {
	readonly file: string;

	constructor(file: string, detail: string) {
		super(`place book ${file} cannot be read: ${detail}`);
		this.name = "PlaceBookError";
		this.file = file;
	}
}

/** Byte cap for one book read. A larger file reports corruption and refuses mutation. */
export const PLACE_FILE_MAX_BYTES = 1024 * 1024;

const LOCK_SESSION = "agent.places";
const DARWIN_O_EXLOCK = 0x20;
/** How long a place operation waits for a live holder of the book lock. */
export const PLACE_LOCK_WAIT_MS = 15_000;
const LOCK_RECHECK_MS = 100;
const LOCK_CLAIM_BYTES = 4096;
/**
 * An unheld empty lock file younger than this can be an exclusive-create holder between its create and its claim
 * write, so it is not taken. A modification time further in the future than this, after a clock step backwards,
 * counts as old; a nearer one is clock and timestamp granularity, so an orphan clears within twice this bound.
 */
const EMPTY_LOCK_GRACE_MS = 2_000;

interface PlaceFile {
	places: PlaceBinding[];
}

function isBinding(value: unknown): value is PlaceBinding {
	const candidate = value as Partial<PlaceBinding> | null;
	return (
		!!candidate &&
		typeof candidate.area === "string" &&
		typeof candidate.sessionId === "string" &&
		typeof candidate.boundAt === "string" &&
		(candidate.topic === undefined || typeof candidate.topic === "string")
	);
}

function isClaim(value: unknown): value is PlaceLockClaim {
	const candidate = value as Partial<PlaceLockClaim> | null;
	return (
		!!candidate &&
		typeof candidate.token === "string" &&
		typeof candidate.pid === "number" &&
		Number.isSafeInteger(candidate.pid) &&
		candidate.pid > 0 &&
		typeof candidate.host === "string" &&
		typeof candidate.sessionId === "string" &&
		typeof candidate.cwd === "string" &&
		typeof candidate.createdAt === "string"
	);
}

/** Directory containment: equal paths, or `path` inside `area`. */
function contains(area: string, path: string): boolean {
	return path === area || path.startsWith(area.endsWith(sep) ? area : area + sep);
}

/** The binding whose area contains `path`, longest area first. */
function longestBinding(bindings: readonly PlaceBinding[], path: string): PlaceBinding | undefined {
	return bindings
		.filter((binding) => contains(binding.area, path))
		.sort((left, right) => right.area.length - left.area.length)[0];
}

/** `O_NOFOLLOW` where the platform supplies it; a missing constant leaves the default behavior. */
function noFollow(): number {
	return typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
}

interface HeldLock {
	readonly descriptor: number;
	readonly dev: number;
	readonly ino: number;
}
type PlaceLockAttempt =
	| { readonly kind: "held"; readonly release: () => void }
	| {
			readonly kind: "busy";
			readonly claim: PlaceLockClaim | undefined;
			readonly detail?: string;
			/** The holder released between two opens; a new attempt follows at once. */
			readonly retry?: boolean;
			/** Waiting cannot help: refuse at once, as for a live exclusive-create holder. */
			readonly final?: boolean;
	  };

/**
 * Resolve when the lock directory changes or after `ms`, whichever comes first. A change notice only shortens
 * the wait for the next attempt; the timer covers a notice that the platform drops.
 */
function lockChange(directory: string, ms: number): Promise<void> {
	return new Promise((done) => {
		let watcher: ReturnType<typeof watch> | undefined;
		const finish = () => {
			clearTimeout(timer);
			watcher?.close();
			done();
		};
		const timer = setTimeout(finish, ms);
		try {
			watcher = watch(directory, { persistent: false }, finish);
			watcher.on("error", finish);
		} catch {
			// Without a watcher the timer alone ends the wait.
		}
	});
}

/** Classify one bounded read of the book. */
function parseReadState(raw: string, tolerateInvalidBindings: boolean): PlaceReadState {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return { kind: "corrupt", reason: "the file is not valid JSON" };
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
		return { kind: "corrupt", reason: "the file is not a place book object" };
	const places = (parsed as Partial<PlaceFile>).places;
	if (!Array.isArray(places)) return { kind: "corrupt", reason: "the file has no places array" };
	if (!tolerateInvalidBindings && !places.every(isBinding))
		return { kind: "corrupt", reason: "the places array contains a malformed binding" };
	return { kind: "ok", bindings: places.filter(isBinding) };
}

function readPlaceFile(fd: number, tolerateInvalidBindings: boolean): PlaceReadState {
	const stat = fstatSync(fd);
	if (!stat.isFile()) return { kind: "corrupt", reason: "the path is not a regular file" };
	if (stat.size > PLACE_FILE_MAX_BYTES)
		return { kind: "corrupt", reason: `the file is larger than ${PLACE_FILE_MAX_BYTES} bytes` };
	const buffer = Buffer.alloc(stat.size + 1);
	let offset = 0;
	while (offset < buffer.length) {
		const read = readSync(fd, buffer, offset, buffer.length - offset, offset);
		if (read <= 0) break;
		offset += read;
	}
	if (offset > stat.size || fstatSync(fd).size !== stat.size)
		return { kind: "corrupt", reason: "the file changed size during the read" };
	return parseReadState(buffer.subarray(0, offset).toString("utf8"), tolerateInvalidBindings);
}

/**
 * The bindings file for one agent store.
 *
 * `resolve` and `exact` tolerate a damaged file by reporting no bindings: a
 * place is a convenience index over durable sessions, and refusing every lookup
 * because one JSON file is malformed is worse than rebinding. `readState`
 * exposes the corruption, and every mutation refuses to replace a book it could
 * not read in full.
 */
export class PlaceBook {
	readonly file: string;
	private readonly lockWaitMs: number;

	constructor(root: string, options: { readonly lockWaitMs?: number } = {}) {
		this.file = join(root, "places.json");
		this.lockWaitMs = options.lockWaitMs ?? PLACE_LOCK_WAIT_MS;
	}

	/** Bounded read state; corruption is explicit instead of an empty book. */
	readState(): PlaceReadState {
		return this.load(false);
	}

	private load(tolerateInvalidBindings: boolean): PlaceReadState {
		let fd: number;
		try {
			fd = openSync(this.file, constants.O_RDONLY | constants.O_NONBLOCK | noFollow());
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code === "ENOENT") return { kind: "absent" };
			return {
				kind: "corrupt",
				reason: code === "ELOOP" ? "the path is a symlink" : `the file cannot be opened (${code ?? "unknown"})`,
			};
		}
		try {
			return readPlaceFile(fd, tolerateInvalidBindings);
		} catch (error) {
			return {
				kind: "corrupt",
				reason: `the file cannot be read (${error instanceof Error ? error.message : String(error)})`,
			};
		} finally {
			closeSync(fd);
		}
	}

	/** Tolerant bindings for lookup callers; see `readState` for explicit corruption. */
	read(): PlaceBinding[] {
		const state = this.load(true);
		return state.kind === "ok" ? state.bindings : [];
	}

	/** The binding whose area contains `path`, longest area first. */
	resolve(path: string): PlaceBinding | undefined {
		return longestBinding(this.read(), resolve(path));
	}

	/** The binding for exactly this area. */
	exact(area: string): PlaceBinding | undefined {
		const target = resolve(area);
		return this.read().find((binding) => binding.area === target);
	}

	bind(area: string, sessionId: string, topic?: string): PlaceBinding {
		const release = this.lockNow();
		try {
			const target = resolve(area);
			const binding: PlaceBinding = {
				area: target,
				sessionId,
				...(topic ? { topic } : {}),
				boundAt: new Date().toISOString(),
			};
			this.write([...this.readForMutation().filter((existing) => existing.area !== target), binding]);
			return binding;
		} finally {
			release();
		}
	}

	unbind(area: string): PlaceBinding | undefined {
		const release = this.lockNow();
		try {
			const target = resolve(area);
			const current = this.readForMutation();
			// An exact retained path remains removable even after the directory moves or vanishes.
			const removed = current.find((binding) => binding.area === target) ?? this.aliasBinding(current, target);
			if (removed) this.write(current.filter((binding) => binding.area !== removed.area));
			return removed;
		} finally {
			release();
		}
	}

	private aliasBinding(bindings: PlaceBinding[], area: string): PlaceBinding | undefined {
		let canonical: string;
		try {
			canonical = realpathSync(area);
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code === "ENOENT" || code === "ENOTDIR") return undefined;
			throw error;
		}
		return bindings.find((binding) => binding.area === canonical);
	}

	/**
	 * Run one place operation. The lock covers only the book: a reused binding
	 * is read under it and the operation runs after its release. A creation
	 * reserves a bounded binding under the lock, and the lock holds until that
	 * binding is published, which happens before any task dispatch. A dispatch
	 * failure does not undo ownership.
	 */
	async withArea<T>(
		area: string,
		operation: (
			current: PlaceBinding | undefined,
			reserve: (sessionId: string, topic?: string) => () => void,
		) => Promise<T>,
	): Promise<PlaceTransaction<T>> {
		let release: (() => void) | undefined = await this.lock();
		const unlock = () => {
			const held = release;
			release = undefined;
			held?.();
		};
		try {
			const target = resolve(area);
			const bindings = this.readForMutation();
			const current = longestBinding(bindings, target);
			if (current) unlock();
			let reserved = false;
			let published: PlaceBinding | undefined;
			const value = await operation(current, (sessionId, topic) => {
				if (current || reserved) throw new Error("The place operation already has a binding");
				const candidate = { area: target, sessionId, ...(topic ? { topic } : {}), boundAt: new Date().toISOString() };
				const serialized = this.serialize([...bindings, candidate]);
				reserved = true;
				return () => {
					if (published) throw new Error("The place operation already published its binding");
					this.publish(serialized);
					published = candidate;
					unlock();
				};
			});
			const binding = current ?? published;
			if (!binding) throw new Error("The place operation did not publish a binding");
			return { binding, value, created: current === undefined };
		} finally {
			unlock();
		}
	}

	/** Read the book for a mutation. A book that cannot be read is never replaced. */
	private readForMutation(): PlaceBinding[] {
		const state = this.readState();
		if (state.kind === "ok") return state.bindings;
		if (state.kind === "absent") return [];
		throw new PlaceBookError(this.file, state.reason);
	}

	private newClaim(): PlaceLockClaim {
		return {
			token: randomBytes(8).toString("hex"),
			pid: process.pid,
			host: hostname(),
			sessionId: LOCK_SESSION,
			cwd: resolve(dirname(this.file)),
			createdAt: new Date().toISOString(),
			kernel: true,
		};
	}

	/** Take the mutation lock once, or report its holder. */
	private tryLock(): PlaceLockAttempt {
		const lockFile = `${this.file}.lock`;
		const opened = this.openLock(lockFile);
		if ("kind" in opened) return opened;
		const { descriptor, created } = opened;
		try {
			const stat = fstatSync(descriptor);
			const held = { descriptor, dev: stat.dev, ino: stat.ino };
			// The path lookup and the lock are two steps: a file that its holder removed in between is not the lock.
			if (!this.named(lockFile, held)) {
				closeSync(descriptor);
				return { kind: "busy", claim: undefined, retry: true };
			}
			if (!created) {
				const existing = this.readLockClaim(descriptor);
				// Unheld, a marked claim belongs to an exited holder and an old empty file to a creator that never wrote.
				// Any other content comes from the exclusive-create protocol, which takes no kernel lock.
				if (existing?.kernel !== true && stat.size > 0) {
					closeSync(descriptor);
					return {
						kind: "busy",
						claim: existing,
						detail: "held under the exclusive-create protocol, which takes no kernel lock",
						final: true,
					};
				}
				const age = Date.now() - stat.mtimeMs;
				if (existing?.kernel !== true && Math.abs(age) < EMPTY_LOCK_GRACE_MS) {
					closeSync(descriptor);
					return {
						kind: "busy",
						claim: undefined,
						detail: "being created under the exclusive-create protocol, which takes no kernel lock",
					};
				}
				ftruncateSync(descriptor, 0);
			}
			writeSync(descriptor, `${JSON.stringify(this.newClaim())}\n`, 0, "utf8");
			return { kind: "held", release: () => this.release(lockFile, held) };
		} catch (error) {
			closeSync(descriptor);
			throw error;
		}
	}

	/** Open the lock file with the kernel lock: created by this call, or an existing file that no process holds. */
	private openLock(lockFile: string): { descriptor: number; created: boolean } | PlaceLockAttempt {
		mkdirSync(dirname(this.file), { recursive: true });
		const flags = constants.O_RDWR | DARWIN_O_EXLOCK | constants.O_NONBLOCK | noFollow();
		try {
			return { descriptor: openSync(lockFile, flags | constants.O_CREAT | constants.O_EXCL, 0o600), created: true };
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code !== "EEXIST" && code !== "EAGAIN") throw error;
		}
		try {
			return { descriptor: openSync(lockFile, flags), created: false };
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			// A holder released the file between the two opens: the next attempt creates it again.
			if (code === "ENOENT") return { kind: "busy", claim: undefined, retry: true };
			if (code !== "EAGAIN") throw error;
			return { kind: "busy", claim: this.readLockClaim(lockFile) };
		}
	}

	/** Take the mutation lock, waiting up to `waitMs` for a live holder to release it. */
	private async lock(waitMs = this.lockWaitMs): Promise<() => void> {
		const deadline = Date.now() + waitMs;
		for (;;) {
			const attempt = this.tryLock();
			if (attempt.kind === "held") return attempt.release;
			const remaining = deadline - Date.now();
			if (attempt.final === true || (remaining <= 0 && attempt.retry !== true))
				throw new PlaceLockedError(`${this.file}.lock`, attempt.claim, attempt.detail);
			await lockChange(dirname(this.file), Math.max(1, Math.min(remaining, LOCK_RECHECK_MS)));
		}
	}

	/** A one-attempt lock for synchronous mutations; a live holder refuses at once. */
	private lockNow(): () => void {
		for (;;) {
			const attempt = this.tryLock();
			if (attempt.kind === "held") return attempt.release;
			if (attempt.retry !== true) throw new PlaceLockedError(`${this.file}.lock`, attempt.claim, attempt.detail);
		}
	}

	/** The diagnostic claim in the lock file, or undefined when it is absent or unreadable. */
	private readLockClaim(source: string | number): PlaceLockClaim | undefined {
		let descriptor: number;
		try {
			descriptor = typeof source === "number" ? source : openSync(source, constants.O_RDONLY | noFollow());
		} catch {
			return undefined;
		}
		try {
			const buffer = Buffer.alloc(LOCK_CLAIM_BYTES);
			const bytes = readSync(descriptor, buffer, 0, buffer.length, 0);
			const parsed: unknown = JSON.parse(buffer.subarray(0, bytes).toString("utf8"));
			return isClaim(parsed) ? parsed : undefined;
		} catch {
			return undefined;
		} finally {
			if (typeof source !== "number") closeSync(descriptor);
		}
	}

	/** True while the lock path names the held file; a replaced or removed path no longer excludes. */
	private named(lockFile: string, held: HeldLock): boolean {
		try {
			const named = lstatSync(lockFile);
			return named.dev === held.dev && named.ino === held.ino;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
			throw error;
		}
	}

	/** Remove the lock file while the kernel lock still excludes, then drop the lock. */
	private release(lockFile: string, held: HeldLock): void {
		try {
			if (!this.named(lockFile, held))
				throw new Error(`place book lock ${lockFile} was replaced while held; the mutation is not confirmed exclusive`);
			unlinkSync(lockFile);
		} finally {
			closeSync(held.descriptor);
		}
	}

	private serialize(places: PlaceBinding[]): string {
		const ordered = [...places].sort((left, right) => left.area.localeCompare(right.area));
		const serialized = `${JSON.stringify({ places: ordered } satisfies PlaceFile, null, 2)}\n`;
		if (Buffer.byteLength(serialized, "utf8") > PLACE_FILE_MAX_BYTES)
			throw new PlaceBookError(this.file, `the proposed book exceeds ${PLACE_FILE_MAX_BYTES} bytes`);
		return serialized;
	}

	private write(places: PlaceBinding[]): void {
		this.publish(this.serialize(places));
	}

	private publish(serialized: string): void {
		mkdirSync(dirname(this.file), { recursive: true });
		const temporary = `${this.file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
		const fd = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | noFollow(), 0o600);
		try {
			try {
				writeFileSync(fd, serialized, "utf8");
			} finally {
				closeSync(fd);
			}
			renameSync(temporary, this.file);
		} catch (error) {
			try {
				unlinkSync(temporary);
			} catch {
				// The rename failure is retained.
			}
			throw error;
		}
	}
}
