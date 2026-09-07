/**
 * Bounded content scan over one uniquely resolved file-backed resource.
 *
 * The tool accepts no path argument and crawls no directory: the only file a
 * scan can open is the one a resolved registry record already points at. The
 * read stops at SCAN_MAX_BYTES, and a stopped read reports `partial` so an
 * incomplete scan can never establish absence. The file handle is closed on
 * every exit, including cancellation.
 */

import { createHash } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { open, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import type { FileStamp } from "./query.ts";
import { isFileBacked, type ResourceRecord } from "./records.ts";

export const SCAN_MAX_BYTES = 256 * 1024;
export const SCAN_CONTEXT_LINES = 1;

export interface ScanMatch {
	line: number;
	text: string;
	before?: string;
	after?: string;
}

export type ScanOutcome = "ok" | "partial" | "cancelled" | "io_error" | "unavailable";

export interface FrontmatterEvidence {
	state: "absent" | "incomplete" | "invalid" | "non_object" | "valid";
	disableModelInvocation?: boolean;
}

/**
 * A synthetic source is a registration marker such as `<builtin:read>`, not a
 * file. Rejecting it here keeps the scan from turning a marker into a path.
 */
export function isRealFilePath(path: string): boolean {
	if (typeof path !== "string" || path.length === 0) return false;
	if (path.startsWith("<") && path.endsWith(">")) return false;
	if (path.includes("\u0000")) return false;
	return isAbsolute(path);
}

export interface ScanResult {
	outcome: ScanOutcome;
	matches: ScanMatch[];
	bytesRead: number;
	fileSize: number;
	/** True when the read stopped at the byte bound before the end of the file. */
	truncated: boolean;
	stamp?: FileStamp;
	/** Frontmatter evidence from this read, when the file declares it. */
	disableModelInvocation?: boolean;
	frontmatter?: FrontmatterEvidence;
	at?: number;
	error?: string;
}

export type Resolution =
	| { kind: "resolved"; record: ResourceRecord }
	| { kind: "ambiguous"; candidates: ResourceRecord[] }
	| { kind: "missing" }
	| { kind: "unavailable" };

/** A content query needs exactly one candidate that is a real file on disk. */
export function resolveScanTarget(candidates: ResourceRecord[]): Resolution {
	const fileBacked = candidates.filter((record) => isFileBacked(record) && isRealFilePath(record.sourceInfo.path));
	if (fileBacked.length === 1) return { kind: "resolved", record: fileBacked[0] };
	if (fileBacked.length === 0) return { kind: candidates.some(isFileBacked) ? "unavailable" : "missing" };
	return { kind: "ambiguous", candidates: fileBacked };
}

/**
 * Read `disable-model-invocation` with Pi's own frontmatter parser, so this
 * tool cannot disagree with the loader about what a skill file declares.
 *
 * The flag is reported only from a complete frontmatter block that parses. A
 * truncated read, an unterminated block, or invalid YAML stays unknown rather
 * than reporting a default as evidence.
 */
export function readFrontmatter(text: string): FrontmatterEvidence {
	const normalized = text
		.replace(/^\uFEFF/, "")
		.replace(/\r\n/g, "\n")
		.replace(/\r/g, "\n");
	if (!normalized.startsWith("---")) return { state: "absent" };
	if (normalized.indexOf("\n---", 3) === -1) return { state: "incomplete" };
	try {
		const { frontmatter } = parseFrontmatter(text);
		if (!frontmatter || typeof frontmatter !== "object" || Array.isArray(frontmatter)) {
			return { state: "non_object" };
		}
		return { state: "valid", disableModelInvocation: frontmatter["disable-model-invocation"] === true };
	} catch {
		return { state: "invalid" };
	}
}

export function readFrontmatterDisableFlag(text: string): boolean | undefined {
	return readFrontmatter(text).disableModelInvocation;
}

/** Case-insensitive literal search with one line of context on each side. */
export function findLiteral(text: string, needle: string): ScanMatch[] {
	const lines = text.split(/\r?\n/);
	const target = needle.toLowerCase();
	const matches: ScanMatch[] = [];
	for (let i = 0; i < lines.length; i += 1) {
		if (!lines[i].toLowerCase().includes(target)) continue;
		const match: ScanMatch = { line: i + 1, text: lines[i] };
		const before = lines[i - SCAN_CONTEXT_LINES];
		const after = lines[i + SCAN_CONTEXT_LINES];
		if (before !== undefined) match.before = before;
		if (after !== undefined) match.after = after;
		matches.push(match);
	}
	return matches;
}

export interface ScanHandle {
	stat(): Promise<Stats>;
	read(buffer: Buffer, offset: number, length: number, position: number): Promise<{ bytesRead: number }>;
	close(): Promise<void>;
}

export interface ScanIO {
	stat(path: string): Promise<Stats>;
	open(path: string, flags: number): Promise<ScanHandle>;
}

export async function scanFile(
	path: string, needle: string, signal?: AbortSignal, io: ScanIO = { stat, open },
): Promise<ScanResult> {
	if (signal?.aborted) {
		return { outcome: "cancelled", matches: [], bytesRead: 0, fileSize: 0, truncated: false };
	}
	if (!isRealFilePath(path)) {
		return {
			outcome: "io_error",
			matches: [],
			bytesRead: 0,
			fileSize: 0,
			truncated: false,
			error: "the resolved source is not an absolute file path",
		};
	}
	let handle: ScanHandle | undefined;
	let closing: Promise<void> | undefined;
	const close = () => {
		if (handle) closing ??= handle.close().catch(() => {});
		return closing;
	};
	const onAbort = () => { void close(); };
	signal?.addEventListener("abort", onAbort, { once: true });
	try {
		// A pipe, device, or socket must be rejected before the open, because
		// opening one can block past cancellation. O_NONBLOCK, where the platform
		// defines it, keeps the open itself from parking on a reader-less FIFO.
		const pre = await io.stat(path);
		signal?.throwIfAborted();
		if (!pre.isFile()) {
			return {
				outcome: "io_error",
				matches: [],
				bytesRead: 0,
				fileSize: 0,
				truncated: false,
				error: "the resolved source is not a regular file",
			};
		}
		const flags = constants.O_RDONLY | (constants.O_NONBLOCK ?? 0);
		handle = await io.open(path, flags);
		signal?.throwIfAborted();
		const stat2 = await handle.stat();
		signal?.throwIfAborted();
		if (!stat2.isFile()) {
			return {
				outcome: "io_error",
				matches: [],
				bytesRead: 0,
				fileSize: 0,
				truncated: false,
				error: "the resolved source stopped being a regular file before the read",
			};
		}
		const stamp: FileStamp = { path, size: stat2.size, mtimeMs: stat2.mtimeMs,
			ctimeMs: stat2.ctimeMs, ino: stat2.ino, dev: stat2.dev, digest: "" };
		const budget = Math.min(stat2.size, SCAN_MAX_BYTES);
		const buffer = Buffer.alloc(budget);
		const { bytesRead } = budget > 0 ? await handle.read(buffer, 0, budget, 0) : { bytesRead: 0 };
		if (signal?.aborted) {
			return { outcome: "cancelled", matches: [], bytesRead, fileSize: stat2.size, truncated: false, stamp };
		}
		const after = await handle.stat();
		signal?.throwIfAborted();
		const changed = after.size !== stat2.size || after.mtimeMs !== stat2.mtimeMs || after.ctimeMs !== stat2.ctimeMs;
		const text = buffer.subarray(0, bytesRead).toString("utf8");
		stamp.digest = createHash("sha256").update(buffer.subarray(0, bytesRead)).digest("hex");
		const truncated = bytesRead < stat2.size || changed;
		const result: ScanResult = {
			at: Date.now(),
			outcome: truncated ? "partial" : "ok",
			matches: findLiteral(text, needle),
			bytesRead,
			fileSize: stat2.size,
			truncated,
			stamp,
		};
		// The complete frontmatter block is evidence even when the body exceeds
		// the read budget. A concurrent mutation invalidates this evidence.
		if (!changed) {
			const frontmatter = readFrontmatter(text);
			result.frontmatter = frontmatter;
			if (frontmatter.state === "invalid" || frontmatter.state === "non_object") {
				result.outcome = "unavailable";
				result.error = `frontmatter is ${frontmatter.state}; skill metadata is unavailable`;
			}
			if (frontmatter.disableModelInvocation !== undefined) {
				result.disableModelInvocation = frontmatter.disableModelInvocation;
			}
		}
		return result;
	} catch (error) {
		if (signal?.aborted) {
			return { outcome: "cancelled", matches: [], bytesRead: 0, fileSize: 0, truncated: false };
		}
		return {
			outcome: "io_error",
			matches: [],
			bytesRead: 0,
			fileSize: 0,
			truncated: false,
			error: error instanceof Error ? error.message : String(error),
		};
	} finally {
		signal?.removeEventListener("abort", onAbort);
		await close();
	}
}
