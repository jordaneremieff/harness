import { closeSync, constants, fstatSync, openSync, readSync, type Stats } from "node:fs";
import type { PluginError } from "@earendil-works/chord";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { primaryRefusal } from "./primary-channel.ts";

const READ_BYTES = 1024 * 1024;
type FilePin = { path: string; dev: number; ino: number; size: number; mtimeMs: number };
type Scan = { offset: number; lineOffset: number; possible?: Buffer[]; startAtEnd?: boolean; file?: FilePin };
type Attempt = { scan: Scan; queued: boolean };
type Observation = { found: boolean; complete: boolean; exists: boolean };
function object(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
function source(value: unknown): string | undefined {
	return object(value) && typeof value.sourceId === "string" ? value.sourceId : undefined;
}
function payload(details: unknown, sourceId: string): unknown {
	return { ...(object(details) ? details : details === undefined ? {} : { payload: details }), sourceId };
}
function parse(bytes: Buffer): unknown {
	return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}

/**
 * Why one source-ledger delivery does not belong to `recipient`, or undefined when it does. The source names its
 * exact recipient as both `deliveryRecipient` and `originalOwnerId`.
 */
export function retainedDeliveryRefusal(details: unknown, recipient: string): PluginError | undefined {
	if (!object(details))
		return primaryRefusal("misaddressed", "Primary delivery names no recipient; this session takes no part of it");
	if (details.deliveryRecipient !== recipient || details.originalOwnerId !== recipient)
		return primaryRefusal(
			"misaddressed",
			`Primary delivery for ${String(details.originalOwnerId)} reached session ${recipient}; it takes no delivery for another recipient`,
		);
	return undefined;
}

/** A session file that this user owns; Pi creates it without a symbolic link. */
function ownFile(stat: Stats): boolean {
	return (
		stat.isFile() && Number.isSafeInteger(stat.size) && (process.getuid === undefined || stat.uid === process.getuid())
	);
}

function checkFile(scan: Scan, path: string, stat: Stats): void {
	if (!ownFile(stat)) throw new Error("Primary delivery session file is invalid");
	const prior = scan.file;
	if (!prior) return;
	if (prior.path !== path || prior.dev !== stat.dev || prior.ino !== stat.ino || stat.size < prior.size)
		throw new Error("Primary delivery session file changed outside append");
	if (stat.size === prior.size && stat.mtimeMs !== prior.mtimeMs)
		throw new Error("Primary delivery session file changed outside append");
}
function headerEnd(fd: number, stat: Stats, sessionId: string): number {
	const bytes = Buffer.alloc(Math.min(16 * 1024, stat.size));
	const count = readSync(fd, bytes, 0, bytes.length, 0),
		newline = bytes.subarray(0, count).indexOf(10);
	if (newline < 0) throw new Error("Primary delivery session header is incomplete");
	const identity = parse(bytes.subarray(0, newline));
	if (!object(identity) || identity.type !== "session" || identity.id !== sessionId)
		throw new Error("Primary delivery session identity changed");
	return newline + 1;
}
function startOffset(fd: number, scan: Scan, stat: Stats, end: number): void {
	if (scan.startAtEnd) {
		const tail = Buffer.alloc(1);
		if (readSync(fd, tail, 0, 1, stat.size - 1) !== 1 || tail[0] !== 10)
			throw new Error("Primary delivery session tail is incomplete");
		scan.offset = stat.size;
		scan.startAtEnd = false;
	}
	if (scan.offset === 0) scan.offset = end;
}
/** Skip unrelated records without buffering them; only exact candidate lines establish retention. */
function records(bytes: Buffer, scan: Scan, ids: Map<string, string>): boolean {
	const candidates = [...ids.values()].map((entry) => Buffer.from(entry));
	let offset = 0,
		found = false;
	while (offset < bytes.length) {
		const newline = bytes.indexOf(10, offset),
			end = newline < 0 ? bytes.length : newline;
		const fragment = bytes.subarray(offset, end),
			start = scan.lineOffset;
		scan.possible ??= candidates;
		scan.possible = scan.possible.filter(
			(entry) =>
				fragment.length <= entry.length - start && fragment.equals(entry.subarray(start, start + fragment.length)),
		);
		scan.lineOffset += fragment.length;
		if (newline >= 0) {
			if (scan.possible.some((entry) => entry.length === scan.lineOffset)) found = true;
			scan.lineOffset = 0;
			scan.possible = undefined;
		}
		offset = end + 1;
	}
	return found;
}
function readNotice(fd: number, scan: Scan, stat: Stats, ids: Map<string, string>): Observation {
	const bytes = Buffer.alloc(Math.min(READ_BYTES, stat.size - scan.offset));
	const count = readSync(fd, bytes, 0, bytes.length, scan.offset);
	const next = { ...scan };
	const found = records(bytes.subarray(0, count), next, ids);
	const after = fstatSync(fd);
	if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs)
		throw new Error("Primary delivery session changed during verification");
	if (scan.offset + count === stat.size && next.lineOffset > 0)
		throw new Error("Primary delivery session tail is incomplete");
	scan.lineOffset = next.lineOffset;
	scan.possible = next.possible;
	scan.offset += count;
	return { found, complete: scan.offset === stat.size, exists: true };
}

/** Confirmation reads the actual append-only session file, never Pi's append-before-write memory view. */
export class PrimaryRetention {
	private readonly attempts = new Map<string, Attempt>();
	private readonly session: ExtensionContext["sessionManager"];
	private readonly idle: () => boolean;
	private readonly send: (text: string, details: unknown) => void;
	constructor(
		session: ExtensionContext["sessionManager"],
		idle: () => boolean,
		send: (text: string, details: unknown) => void,
	) {
		this.session = session;
		this.idle = idle;
		this.send = send;
	}

	private entries(sourceId: string): Map<string, string> {
		return new Map(
			this.session
				.getEntries()
				.flatMap((entry) =>
					entry.type === "custom_message" && entry.customType === "agent.peer" && source(entry.details) === sourceId
						? [[entry.id, JSON.stringify(entry)] as const]
						: [],
				),
		);
	}
	private unsaved(): PluginError {
		return primaryRefusal(
			"unsaved",
			`Primary session ${this.session.getSessionId()} has no saved transcript yet; the delivery waits at its source until the session saves its first message`,
		);
	}
	private sessionPath(): string {
		const path = this.session.getSessionFile();
		if (path === undefined)
			throw primaryRefusal(
				"no-transcript",
				`Primary session ${this.session.getSessionId()} keeps no transcript; the delivery stays at its source and reaches no other session`,
			);
		return path;
	}

	/**
	 * Refuse before any receiver state changes unless the session file exists as this user's regular file with this
	 * session's header. A file name or Pi's memory view does not establish that the session retains messages.
	 */
	assertRetainable(): void {
		const path = this.sessionPath();
		let fd: number;
		try {
			fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") throw this.unsaved();
			throw error;
		}
		try {
			const stat = fstatSync(fd);
			if (!ownFile(stat)) throw new Error("Primary delivery session file is invalid");
			headerEnd(fd, stat, this.session.getSessionId());
		} finally {
			closeSync(fd);
		}
	}

	private scan(scan: Scan, ids: Map<string, string>): Observation {
		const path = this.sessionPath();
		let fd: number;
		try {
			fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT" || scan.file !== undefined) throw error;
			scan.startAtEnd = false;
			return { found: false, complete: true, exists: false };
		}
		try {
			const stat = fstatSync(fd);
			checkFile(scan, path, stat);
			startOffset(fd, scan, stat, headerEnd(fd, stat, this.session.getSessionId()));
			const result = readNotice(fd, scan, stat, ids);
			scan.file = { path, dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs };
			return result;
		} finally {
			closeSync(fd);
		}
	}
	private transmit(attempt: Attempt, sourceId: string, text: string, details: unknown): void {
		attempt.queued = true;
		try {
			this.send(text, payload(details, sourceId));
		} catch (error) {
			attempt.queued = false;
			throw error;
		}
	}

	hasQueued(sourceId: string): boolean {
		return this.attempts.get(sourceId)?.queued === true && this.entries(sourceId).size === 0;
	}

	/** A transient refusal lets the source keep its ledger and continue with other owners. */
	deliver(sourceId: string, text: string, details: unknown): void {
		if (typeof sourceId !== "string" || sourceId === "")
			throw new Error("Primary delivery requires its transport source identity");
		const ids = this.entries(sourceId);
		let attempt = this.attempts.get(sourceId);
		// Pi's full memory view locates old attempts; only the file read proves positive retention.
		if (attempt === undefined) {
			attempt = { scan: { offset: 0, lineOffset: 0, startAtEnd: ids.size === 0 }, queued: false };
			this.attempts.set(sourceId, attempt);
		}
		const observed = this.scan(attempt.scan, ids);
		if (observed.found) {
			this.attempts.delete(sourceId);
			return;
		}
		// A bounded unfinished read is not evidence that a notice is absent.
		if (!observed.complete) throw new Error("Primary delivery awaits retained-entry verification");
		// Pi keeps a message of a session without a file in memory only; it would reach the transcript, and start a
		// run, in a session that has not begun.
		if (!observed.exists) {
			this.attempts.delete(sourceId);
			throw this.unsaved();
		}
		if (this.idle()) attempt.queued = false;
		if (!attempt.queued) {
			this.transmit(attempt, sourceId, text, details);
			if (this.scan(attempt.scan, this.entries(sourceId)).found) {
				this.attempts.delete(sourceId);
				return;
			}
		}
		throw new Error("Primary delivery awaits a retained agent.peer entry; its source remains unacknowledged");
	}

	/** Settlement permits dropped attempts to retry without discarding unconfirmed retained entries. */
	settled(): void {
		for (const [sourceId, attempt] of this.attempts) {
			if (this.entries(sourceId).size === 0) attempt.queued = false;
		}
	}
	clear(): void {
		this.attempts.clear();
	}
}
