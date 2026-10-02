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
 * Every mutation takes one exclusive lock file beside the book. The lock claim
 * follows the shared writer-claim shape (host, session identity, cwd), so a
 * foreign host or invalid claim refuses and only a proven dead local claim is
 * recovered. Reads never follow a symlink and never read more than
 * `PLACE_FILE_MAX_BYTES`. A mutation refuses a malformed, oversized, nonregular,
 * or symlinked book instead of replacing it, so unknown bindings are never
 * erased.
 */

import { randomBytes } from "node:crypto";
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
	writeSync,
} from "node:fs";
import { hostname } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { type ClaimFile, type ClaimIdentity, classifyClaim, readClaimFile } from "./claims.ts";

/** One area-to-session binding. */
export interface PlaceBinding {
	/** Absolute directory the session owns. */
	area: string;
	sessionId: string;
	/** Operator description of the concern; absent when none was given. */
	topic?: string;
	boundAt: string;
}

/** The result one `withArea` operation returns for the transaction to commit. */
export interface PlaceOperation<T> {
	readonly value: T;
	/** Session that owns the area after the operation. */
	readonly sessionId: string;
	readonly topic?: string;
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

/** Classify one bounded read of the book. */
function parseReadState(raw: string): PlaceReadState {
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
	return { kind: "ok", bindings: places.filter(isBinding) };
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

	constructor(root: string) {
		this.file = join(root, "places.json");
	}

	/** Bounded read state; corruption is explicit instead of an empty book. */
	readState(): PlaceReadState {
		let fd: number;
		try {
			fd = openSync(this.file, constants.O_RDONLY | noFollow());
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code === "ENOENT") return { kind: "absent" };
			return {
				kind: "corrupt",
				reason: code === "ELOOP" ? "the path is a symlink" : `the file cannot be opened (${code ?? "unknown"})`,
			};
		}
		try {
			const stat = fstatSync(fd);
			if (!stat.isFile()) return { kind: "corrupt", reason: "the path is not a regular file" };
			if (stat.size > PLACE_FILE_MAX_BYTES)
				return { kind: "corrupt", reason: `the file is larger than ${PLACE_FILE_MAX_BYTES} bytes` };
			const buffer = Buffer.alloc(stat.size);
			let offset = 0;
			while (offset < buffer.length) {
				const read = readSync(fd, buffer, offset, buffer.length - offset, offset);
				if (read <= 0) break;
				offset += read;
			}
			return parseReadState(buffer.subarray(0, offset).toString("utf8"));
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
		const state = this.readState();
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
		const release = this.lock();
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
		const release = this.lock();
		try {
			const target = resolve(area);
			const current = this.readForMutation();
			const removed = current.find((binding) => binding.area === target);
			if (removed) this.write(current.filter((binding) => binding.area !== target));
			return removed;
		} finally {
			release();
		}
	}

	/**
	 * Hold the mutation lock across one asynchronous place operation. The
	 * callback receives the retained binding whose area contains the requested
	 * path, longest area first. When a binding exists, that binding wins and the
	 * transaction writes nothing, so an owner bound to a parent directory also
	 * answers for its subdirectories. When no binding exists, the transaction
	 * commits the callback's session for the exact area. The lock refuses a live
	 * or unverifiable holder; it never waits.
	 */
	async withArea<T>(
		area: string,
		operation: (current: PlaceBinding | undefined) => Promise<PlaceOperation<T>>,
	): Promise<PlaceTransaction<T>> {
		const release = this.lock();
		try {
			const target = resolve(area);
			const current = longestBinding(this.readForMutation(), target);
			const outcome = await operation(current);
			if (current !== undefined) return { binding: current, value: outcome.value, created: false };
			const binding: PlaceBinding = {
				area: target,
				sessionId: outcome.sessionId,
				...(outcome.topic ? { topic: outcome.topic } : {}),
				boundAt: new Date().toISOString(),
			};
			this.write([...this.readForMutation().filter((existing) => existing.area !== target), binding]);
			return { binding, value: outcome.value, created: true };
		} finally {
			release();
		}
	}

	/** Read the book for a mutation. A book that cannot be read is never replaced. */
	private readForMutation(): PlaceBinding[] {
		const state = this.readState();
		if (state.kind === "ok") return state.bindings;
		if (state.kind === "absent") return [];
		throw new PlaceBookError(this.file, state.reason);
	}

	/** Claim identity used for classification: this book, in its own directory. */
	private claimIdentity(): ClaimIdentity {
		return { sessionId: LOCK_SESSION, cwd: dirname(this.file) };
	}

	private newClaim(): PlaceLockClaim {
		return {
			token: randomBytes(8).toString("hex"),
			pid: process.pid,
			host: hostname(),
			sessionId: LOCK_SESSION,
			cwd: resolve(dirname(this.file)),
			createdAt: new Date().toISOString(),
		};
	}

	/** Take the exclusive mutation lock, or throw when a live or unverifiable holder exists. */
	private lock(): () => void {
		const lockFile = `${this.file}.lock`;
		mkdirSync(dirname(this.file), { recursive: true });
		const claim = this.newClaim();
		const held = this.tryTake(lockFile, claim) ?? this.replaceDead(lockFile, claim);
		return () => this.release(lockFile, held);
	}

	/** One exclusive create. A taken path, including a symlink, returns undefined. */
	private tryTake(lockFile: string, claim: PlaceLockClaim): PlaceLockClaim | undefined {
		let fd: number;
		try {
			fd = openSync(lockFile, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | noFollow(), 0o600);
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code === "EEXIST" || code === "ELOOP") return undefined;
			throw error;
		}
		try {
			writeSync(fd, `${JSON.stringify(claim)}\n`, undefined, "utf8");
		} catch (error) {
			closeSync(fd);
			try {
				unlinkSync(lockFile);
			} catch {
				// The write failure is retained.
			}
			throw error;
		}
		closeSync(fd);
		return claim;
	}

	/** Read one lock claim, refusing with the lock path when it cannot be read. */
	private readLock(lockFile: string): ClaimFile {
		try {
			return readClaimFile(lockFile);
		} catch (error) {
			throw new PlaceLockedError(
				lockFile,
				undefined,
				`the lock claim is unreadable (${error instanceof Error ? error.message : String(error)})`,
			);
		}
	}

	private removeLock(lockFile: string, present: boolean): void {
		if (!present) return;
		try {
			unlinkSync(lockFile);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}

	/** Replace one same-host dead claim, with a dev/ino recheck so a concurrent replacement is refused. */
	private replaceDead(lockFile: string, claim: PlaceLockClaim): PlaceLockClaim {
		const file = this.readLock(lockFile);
		const observed = classifyClaim(file.claim, this.claimIdentity());
		const detail = isClaim(file.claim) ? file.claim : undefined;
		if (observed.kind === "live") throw new PlaceLockedError(lockFile, detail);
		if (observed.kind === "unknown") throw new PlaceLockedError(lockFile, detail, observed.error);
		const current = lstatSync(lockFile, { throwIfNoEntry: false });
		if (current && (current.dev !== file.dev || current.ino !== file.ino))
			throw new PlaceLockedError(lockFile, this.lockDetail(lockFile), "the lock claim changed during replacement");
		this.removeLock(lockFile, current !== undefined);
		const taken = this.tryTake(lockFile, claim);
		if (taken === undefined)
			throw new PlaceLockedError(lockFile, this.lockDetail(lockFile), "another process replaced the dead claim first");
		return taken;
	}

	/** Remove the lock only while this process still owns the claim. */
	private release(lockFile: string, claim: PlaceLockClaim): void {
		let file: ClaimFile;
		try {
			file = readClaimFile(lockFile);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
			throw error;
		}
		if (!isClaim(file.claim) || file.claim.token !== claim.token) return;
		unlinkSync(lockFile);
	}

	private lockDetail(lockFile: string): PlaceLockClaim | undefined {
		try {
			const claim = readClaimFile(lockFile).claim;
			return isClaim(claim) ? claim : undefined;
		} catch {
			return undefined;
		}
	}

	private write(places: PlaceBinding[]): void {
		const ordered = [...places].sort((left, right) => left.area.localeCompare(right.area));
		mkdirSync(dirname(this.file), { recursive: true });
		const temporary = `${this.file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
		const fd = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | noFollow(), 0o600);
		try {
			writeSync(fd, `${JSON.stringify({ places: ordered } satisfies PlaceFile, null, 2)}\n`, undefined, "utf8");
		} finally {
			closeSync(fd);
		}
		try {
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
