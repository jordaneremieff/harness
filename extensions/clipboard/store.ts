/** Append-only, private filesystem persistence for clipboard history. */

import { randomUUID } from "node:crypto";
import { constants, type Dirent } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, stat, type FileHandle } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export interface ClipboardEntry {
	/** Stable archive identifier. */
	id: string;
	/** ISO 8601 UTC timestamp. */
	timestamp: string;
	label?: string;
	lines: number;
	chars: number;
	/** First ~100 chars, newlines collapsed to ↵. */
	preview: string;
	content: string;
	/** True when this in-memory view carries only a prefix of archived content. */
	contentTruncated?: boolean;
}

const PREVIEW_CHARS = 100;
const MAX_LABEL_CHARS = 200;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const READ_CHUNK_BYTES = 64 * 1024;
const MAX_ARCHIVE_RECORD_BYTES = 64 * 1024 * 1024;
const MAX_RETURNED_ENTRIES = 1000;
const DEFAULT_CONTENT_CHARS = 32 * 1024;

function contentStats(content: string): { chars: number; lines: number } {
	let chars = 0;
	let lines = 1;
	for (const char of content) {
		chars++;
		if (char === "\n") lines++;
	}
	return { chars, lines };
}

function characterPrefix(content: string, max: number): string {
	if (!Number.isFinite(max)) return content;
	const limit = Math.max(0, Math.floor(max));
	let result = "";
	let count = 0;
	for (const char of content) {
		if (count >= limit) break;
		result += char;
		count++;
	}
	return result;
}

export function makePreview(content: string, max: number = PREVIEW_CHARS): string {
	return characterPrefix(content, max).replace(/\n/g, "↵");
}

export function makeEntry(
	content: string,
	label?: string,
	now: Date = new Date(),
	id: string = randomUUID(),
): ClipboardEntry {
	const stats = contentStats(content);
	return {
		id,
		timestamp: now.toISOString(),
		label,
		lines: stats.lines,
		chars: stats.chars,
		preview: makePreview(content),
		content,
	};
}

const pad = (n: number) => String(n).padStart(2, "0");

/** YYYY-MM-DD in the local timezone. */
export function localDate(date: Date): string {
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function resolveClipboardDir(env: NodeJS.ProcessEnv = process.env, agentDir?: string): string {
	if (env.PI_CLIPBOARD_DIR) return env.PI_CLIPBOARD_DIR;
	return join(agentDir ?? join(homedir(), ".pi", "agent"), "clipboard");
}

function hasCode(error: unknown, code: string): boolean {
	return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === code;
}

async function ensurePrivateDirectory(dir: string, create: boolean): Promise<boolean> {
	if (create) await mkdir(dir, { recursive: true, mode: 0o700 });
	try {
		const info = await lstat(dir);
		if (!info.isDirectory() || info.isSymbolicLink())
			throw new Error(`clipboard store is not a regular directory: ${dir}`);
		await chmod(dir, 0o700);
		return true;
	} catch (error) {
		if (!create && hasCode(error, "ENOENT")) return false;
		throw error;
	}
}

/**
 * Append one entry. Archive failure is returned rather than thrown because the
 * primary clipboard write may already have succeeded and callers must report
 * that split outcome accurately.
 */
export async function appendEntry(dir: string, entry: ClipboardEntry): Promise<string | null> {
	try {
		const timestamp = new Date(entry.timestamp);
		if (Number.isNaN(timestamp.getTime())) throw new Error(`invalid clipboard timestamp: ${entry.timestamp}`);
		await ensurePrivateDirectory(dir, true);
		const path = join(dir, `${localDate(timestamp)}.jsonl`);
		const serialized = `${JSON.stringify(entry)}\n`;
		const bytes = Buffer.byteLength(serialized, "utf8");
		if (bytes > MAX_ARCHIVE_RECORD_BYTES) {
			throw new Error(`clipboard archive record is ${bytes} bytes; maximum is ${MAX_ARCHIVE_RECORD_BYTES}`);
		}
		const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
		const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | noFollow, 0o600);
		try {
			await handle.chmod(0o600);
			await handle.appendFile(serialized, "utf8");
		} finally {
			await handle.close();
		}
		return null;
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
}

interface ReadOptions {
	/** YYYY-MM-DD (local). When set, only that day's file is read. */
	date?: string;
	/** Max entries returned after newest-first ordering (hard maximum 1000). */
	limit?: number;
	/** Stop after resolving this stable id. */
	id?: string;
	/** Content prefix retained per result; defaults to 32,768 chars for lists and full content for id lookup. */
	contentChars?: number;
}

function archiveFiles(dirents: Dirent[], date?: string): string[] {
	return dirents
		.filter((entry) => entry.isFile() && /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(entry.name))
		.map((entry) => entry.name)
		.filter((name) => !date || name === `${date}.jsonl`)
		.sort();
}

function normalizeEntry(value: unknown, fallbackId: string, contentChars: number): ClipboardEntry | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const record = value as Record<string, unknown>;
	if (
		typeof record.timestamp !== "string" ||
		record.timestamp.length > 64 ||
		Number.isNaN(new Date(record.timestamp).getTime())
	)
		return null;
	if (typeof record.content !== "string") return null;
	const id = typeof record.id === "string" && SAFE_ID.test(record.id) ? record.id : fallbackId;
	const label = typeof record.label === "string" ? characterPrefix(record.label, MAX_LABEL_CHARS) : undefined;
	const entry = makeEntry(record.content, label, new Date(record.timestamp), id);
	const content = characterPrefix(entry.content, contentChars);
	return content === entry.content ? entry : { ...entry, content, contentTruncated: true };
}

async function openArchive(path: string): Promise<{ handle: FileHandle; size: number }> {
	const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
	const handle = await open(path, constants.O_RDONLY | noFollow);
	try {
		const info = await handle.stat();
		if (!info.isFile()) throw new Error(`not a regular archive file: ${path}`);
		await handle.chmod(0o600);
		return { handle, size: info.size };
	} catch (error) {
		await handle.close();
		throw error;
	}
}

async function physicalLineNumber(handle: FileHandle, startOffset: number): Promise<number> {
	const buffer = Buffer.alloc(READ_CHUNK_BYTES);
	let position = 0;
	let newlines = 0;
	while (position < startOffset) {
		const wanted = Math.min(buffer.length, startOffset - position);
		const { bytesRead } = await handle.read(buffer, 0, wanted, position);
		if (bytesRead === 0) break;
		for (let index = 0; index < bytesRead; index++) if (buffer[index] === 0x0a) newlines++;
		position += bytesRead;
	}
	return newlines + 1;
}

interface ReverseLine {
	startOffset: number;
	reverseIndex: number;
	text?: string;
}

/** Iterate physical JSONL records from the end with bounded per-record memory. */
async function* reverseLines(handle: FileHandle, size: number): AsyncGenerator<ReverseLine> {
	let position = size;
	let reverseIndex = 0;
	let parts: Buffer[] = [];
	let partBytes = 0;
	let oversized = false;

	const addPart = (part: Buffer): void => {
		if (part.length === 0 || oversized) return;
		partBytes += part.length;
		if (partBytes > MAX_ARCHIVE_RECORD_BYTES) {
			parts = [];
			oversized = true;
			return;
		}
		parts.push(Buffer.from(part));
	};
	const materialize = (): string | undefined => {
		if (oversized) return undefined;
		return Buffer.concat(parts.reverse(), partBytes).toString("utf8");
	};

	while (position > 0) {
		const wanted = Math.min(READ_CHUNK_BYTES, position);
		position -= wanted;
		const buffer = Buffer.allocUnsafe(wanted);
		let bytesRead = 0;
		while (bytesRead < wanted) {
			const result = await handle.read(buffer, bytesRead, wanted - bytesRead, position + bytesRead);
			if (result.bytesRead === 0) break;
			bytesRead += result.bytesRead;
		}
		const chunk = buffer.subarray(0, bytesRead);
		let end = chunk.length;
		for (let index = chunk.length - 1; index >= 0; index--) {
			if (chunk[index] !== 0x0a) continue;
			addPart(chunk.subarray(index + 1, end));
			yield { startOffset: position + index + 1, reverseIndex: reverseIndex++, text: materialize() };
			parts = [];
			partBytes = 0;
			oversized = false;
			end = index;
		}
		addPart(chunk.subarray(0, end));
	}
	yield { startOffset: 0, reverseIndex, text: materialize() };
}

function unusedId(fallbackId: string, seenIds: Set<string>): string {
	if (!seenIds.has(fallbackId)) return fallbackId;
	for (let suffix = 2; ; suffix++) {
		const candidate = `${fallbackId}-${suffix}`;
		if (!seenIds.has(candidate)) return candidate;
	}
}

/**
 * Read validated entries newest-first without materializing whole archive files.
 * Malformed and oversized individual records are skipped. Stable-id lookup stops
 * as soon as the newest matching record is found.
 */
export async function readEntries(dir: string, options: ReadOptions = {}): Promise<ClipboardEntry[]> {
	if (!(await ensurePrivateDirectory(dir, false))) return [];
	let dirents: Dirent[];
	try {
		dirents = await readdir(dir, { withFileTypes: true });
	} catch (error) {
		if (hasCode(error, "ENOENT")) return [];
		throw error;
	}
	const files = archiveFiles(dirents, options.date).reverse();
	const requestedLimit = options.id
		? 1
		: Math.min(MAX_RETURNED_ENTRIES, Math.max(0, Math.floor(options.limit ?? MAX_RETURNED_ENTRIES)));
	const contentChars = Math.max(
		0,
		options.contentChars ?? (options.id ? Number.POSITIVE_INFINITY : DEFAULT_CONTENT_CHARS),
	);
	if (requestedLimit === 0 || (options.id !== undefined && !SAFE_ID.test(options.id))) return [];

	const entries: ClipboardEntry[] = [];
	const seenIds = new Set<string>();
	for (const file of files) {
		const path = join(dir, file);
		let opened: { handle: FileHandle; size: number } | undefined;
		try {
			opened = await openArchive(path);
		} catch (error) {
			if (hasCode(error, "ENOENT") || hasCode(error, "ELOOP")) continue;
			throw error;
		}
		try {
			const date = file.replace(/\.jsonl$/, "");
			let anchorPhysicalLine: number | undefined;
			let anchorReverseIndex = 0;
			const numberFor = async (line: ReverseLine): Promise<number> => {
				if (anchorPhysicalLine === undefined) {
					anchorPhysicalLine = await physicalLineNumber(opened.handle, line.startOffset);
					anchorReverseIndex = line.reverseIndex;
				}
				return anchorPhysicalLine - (line.reverseIndex - anchorReverseIndex);
			};
			for await (const line of reverseLines(opened.handle, opened.size)) {
				if (!line.text?.trim()) continue;
				try {
					const parsed = JSON.parse(line.text) as unknown;
					const record =
						parsed && typeof parsed === "object" && !Array.isArray(parsed)
							? (parsed as Record<string, unknown>)
							: undefined;
					const needsFallback = typeof record?.id !== "string" || !SAFE_ID.test(record.id);
					let lineNumber = needsFallback ? await numberFor(line) : 0;
					let fallbackId = `legacy-${date}-${lineNumber}`;
					let entry = normalizeEntry(parsed, fallbackId, contentChars);
					if (!entry) continue;
					if (seenIds.has(entry.id)) {
						if (lineNumber === 0) lineNumber = await numberFor(line);
						fallbackId = `legacy-${date}-${lineNumber}`;
						entry = { ...entry, id: unusedId(fallbackId, seenIds) };
					}
					seenIds.add(entry.id);
					if (options.id) {
						if (entry.id === options.id) return [entry];
						continue;
					}
					entries.push(entry);
					if (entries.length >= requestedLimit) return entries;
				} catch {
					// A damaged record must not hide valid recovery data around it.
				}
			}
		} finally {
			await opened.handle.close();
		}
	}
	return entries;
}

/** File permission bits of one daily archive, for tests and diagnostics. */
export async function fileMode(dir: string, date: string): Promise<number | null> {
	try {
		const info = await stat(join(dir, `${date}.jsonl`));
		return info.mode & 0o777;
	} catch {
		return null;
	}
}
