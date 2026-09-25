/** Bounded, stateless discovery over the existing daily clipboard archives. */

import { createHash } from "node:crypto";
import type { BigIntStats } from "node:fs";
import { type FileHandle, lstat, opendir } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
	type ClipboardEntry,
	ensurePrivateDirectory,
	MAX_ARCHIVE_RECORD_BYTES,
	normalizeEntry,
	openArchive,
} from "./store.ts";
import { sanitizeTerminalText } from "./text.ts";

export const SEARCH_LIMITS = {
	directoryEntries: 4096,
	files: 32,
	records: 1000,
	bytes: 128 * 1024 * 1024,
	recordBytes: MAX_ARCHIVE_RECORD_BYTES,
	matchBytes: 16 * 1024,
	queryChars: 256,
	cursorChars: 1024,
} as const;
const CHUNK_BYTES = 64 * 1024;
const ARCHIVE_NAME = /^\d{4}-\d{2}-\d{2}\.jsonl$/;
const DIGEST = /^[a-f0-9]{64}$/;

interface SearchOptions {
	query: string;
	date?: string;
	limit?: number;
	cursor?: string;
	signal?: AbortSignal;
}
interface Position {
	file: string;
	/** Exclusive byte offset, at a record boundary unless discarding an oversized record. */
	offset: number;
	discard: boolean;
}
interface Candidate {
	id: string;
	file: string;
	end: number;
	resume: Position | null;
}
interface Cursor {
	v: 1;
	scope: string;
	catalog: string;
	position: Position;
	candidate: Candidate | null;
}
interface Archive {
	name: string;
	size: number;
	stamp: string;
}
export interface SearchMatch {
	id: string;
	date: string;
	timestamp: string;
	label?: string;
	lines: number;
	chars: number;
	match: { field: "content" | "label"; offset: number; excerpt: string };
}
export interface SearchPage {
	matches: SearchMatch[];
	nextCursor: string | null;
	hasMore: boolean;
	stop: "end" | "matches" | "bytes" | "records" | "files" | "output";
	scan: {
		directoryEntries: number;
		archives: number;
		files: number;
		bytes: number;
		records: number;
		malformed: number;
		oversized: number;
		duplicates: number;
	};
	limits: typeof SEARCH_LIMITS;
}

const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const changed = () => new Error("Clipboard archives changed; restart clipboard_list without cursor.");
const invalidCursor = () => new Error("Invalid clipboard search cursor; restart clipboard_list without cursor.");
const missing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === "ENOENT";
const identity = (info: BigIntStats) => `${info.dev}:${info.ino}`;
const stamp = (info: BigIntStats) => `${identity(info)}:${info.size}:${info.mtimeNs}`;

function validateOptions(options: SearchOptions): void {
	if (
		typeof options.query !== "string" ||
		!options.query.trim() ||
		options.query.length > SEARCH_LIMITS.queryChars ||
		/[\uD800-\uDFFF]/u.test(options.query)
	)
		throw new Error("Clipboard query must contain 1–256 UTF-16 units of well-formed, nonblank literal text.");
	if (options.date !== undefined) {
		const date = new Date(`${options.date}T12:00:00Z`);
		if (
			!/^\d{4}-\d{2}-\d{2}$/.test(options.date) ||
			Number.isNaN(date.getTime()) ||
			date.toISOString().slice(0, 10) !== options.date
		)
			throw new Error("Clipboard search date must be a valid YYYY-MM-DD local archive date.");
	}
	if (options.limit !== undefined && (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 50))
		throw new Error("Clipboard search limit must be an integer from 1 to 50.");
}

function decodeCursor(value: string | undefined, scope: string): Cursor | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string" || value.length > SEARCH_LIMITS.cursorChars || !/^[A-Za-z0-9_-]+$/.test(value))
		throw invalidCursor();
	try {
		const bytes = Buffer.from(value, "base64url");
		if (bytes.toString("base64url") !== value) throw invalidCursor();
		const cursor = JSON.parse(bytes.toString("utf8")) as Cursor;
		if (
			!cursor ||
			Object.keys(cursor).sort().join(",") !== "candidate,catalog,position,scope,v" ||
			cursor.v !== 1 ||
			cursor.scope !== scope ||
			!DIGEST.test(cursor.catalog) ||
			!validPosition(cursor.position) ||
			(cursor.candidate !== null &&
				(!cursor.candidate ||
					Object.keys(cursor.candidate).sort().join(",") !== "end,file,id,resume" ||
					typeof cursor.candidate.id !== "string" ||
					!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(cursor.candidate.id) ||
					!ARCHIVE_NAME.test(cursor.candidate.file) ||
					!Number.isSafeInteger(cursor.candidate.end) ||
					cursor.candidate.end < 1 ||
					(cursor.candidate.resume !== null && !validPosition(cursor.candidate.resume))))
		)
			throw invalidCursor();
		return cursor;
	} catch {
		throw invalidCursor();
	}
}

function validPosition(value: Position): boolean {
	return (
		!!value &&
		Object.keys(value).sort().join(",") === "discard,file,offset" &&
		typeof value.file === "string" &&
		ARCHIVE_NAME.test(value.file) &&
		Number.isSafeInteger(value.offset) &&
		value.offset >= 0 &&
		typeof value.discard === "boolean"
	);
}

async function archiveNames(dir: string, date: string | undefined, signal?: AbortSignal) {
	if (date) return { names: [`${date}.jsonl`], visited: 1 };
	const names: string[] = [];
	let visited = 0;
	const directory = await opendir(dir, { bufferSize: 32 });
	try {
		while (true) {
			signal?.throwIfAborted();
			const entry = await directory.read();
			if (!entry) break;
			if (++visited > SEARCH_LIMITS.directoryEntries)
				throw new Error("Clipboard search directory exceeds 4096 entries; pass date to search one archive.");
			if (entry.isFile() && ARCHIVE_NAME.test(entry.name)) names.push(entry.name);
		}
	} finally {
		await directory.close();
	}
	return { names, visited };
}

async function describeArchive(dir: string, name: string, exactDate: boolean): Promise<Archive | null> {
	let info: BigIntStats;
	try {
		info = await lstat(join(dir, name), { bigint: true });
	} catch (error) {
		if (exactDate && missing(error)) return null;
		if (missing(error)) throw changed();
		throw error;
	}
	if (info.isSymbolicLink()) return null;
	if (!info.isFile()) throw new Error("Clipboard archive is not a regular file.");
	const size = Number(info.size);
	if (!Number.isSafeInteger(size)) throw new Error("Clipboard archive exceeds safe byte addressing.");
	return { name, size, stamp: stamp(info) };
}

async function catalog(dir: string, date: string | undefined, signal?: AbortSignal) {
	const before = await lstat(dir, { bigint: true });
	const { names, visited } = await archiveNames(dir, date, signal);
	const files: Archive[] = [];
	for (const name of names.sort().reverse()) {
		signal?.throwIfAborted();
		const file = await describeArchive(dir, name, date !== undefined);
		if (file) files.push(file);
	}
	const after = await lstat(dir, { bigint: true });
	if (identity(before) !== identity(after) || before.mtimeNs !== after.mtimeNs) throw changed();
	return { files, visited, digest: hash(JSON.stringify([identity(after), files])) };
}

function excerpt(source: string, offset: number): string {
	let start = Math.max(0, offset - 48);
	if (start > 0 && /[\uDC00-\uDFFF]/.test(source[start])) start--;
	let end = Math.min(source.length, offset + 272);
	if (end < source.length && /[\uDC00-\uDFFF]/.test(source[end])) end++;
	return `${start ? "…" : ""}${sanitizeTerminalText(source.slice(start, end)).text}${end < source.length ? "…" : ""}`;
}

function characterOffset(source: string, units: number): number {
	let offset = 0;
	let characters = 0;
	for (const char of source) {
		if (offset >= units) break;
		offset += char.length;
		characters++;
	}
	return characters;
}

function matchEntry(entry: ClipboardEntry, file: string, query: string): SearchMatch | undefined {
	const contentOffset = entry.content.indexOf(query);
	const labelOffset = entry.label?.indexOf(query) ?? -1;
	if (contentOffset < 0 && labelOffset < 0) return undefined;
	const field = contentOffset >= 0 ? "content" : "label";
	const offset = contentOffset >= 0 ? contentOffset : labelOffset;
	const source = field === "content" ? entry.content : (entry.label ?? "");
	return {
		id: entry.id,
		date: file.slice(0, 10),
		timestamp: entry.timestamp,
		label: entry.label === undefined ? undefined : sanitizeTerminalText(entry.label).text,
		lines: entry.lines,
		chars: entry.chars,
		match: { field, offset: characterOffset(source, offset), excerpt: excerpt(source, offset) },
	};
}

interface RecordObservation {
	entry: ClipboardEntry | null;
	file: string;
	end: number;
}

interface RecordParts {
	chunks: Buffer[];
	bytes: number;
	discard: boolean;
}

function appendPart(parts: RecordParts, part: Buffer, page: SearchPage): void {
	if (parts.discard || part.length === 0) return;
	parts.bytes += part.length;
	if (parts.bytes > SEARCH_LIMITS.recordBytes) {
		parts.chunks = [];
		parts.discard = true;
		page.scan.oversized++;
	} else parts.chunks.push(Buffer.from(part));
}

function parseRecord(parts: RecordParts, page: SearchPage): ClipboardEntry | null {
	if (parts.discard) return null;
	const text = Buffer.concat(parts.chunks.reverse(), parts.bytes).toString("utf8");
	if (!text.trim()) return null;
	let entry: ClipboardEntry | null = null;
	try {
		entry = normalizeEntry(JSON.parse(text), Number.POSITIVE_INFINITY);
	} catch {
		/* Skip damaged JSON. */
	}
	if (!entry) page.scan.malformed++;
	return entry;
}

/** One traversal owns its descriptor and chunk cache; the page owns all work budgets. */
class ArchiveScan {
	position: Position | null;
	private handle?: FileHandle;
	private file?: Archive;
	private chunk: Buffer = Buffer.alloc(0);
	private chunkStart = 0;
	private dir: string;
	private files: Archive[];
	private page: SearchPage;
	private signal: AbortSignal | undefined;

	constructor(
		dir: string,
		files: Archive[],
		page: SearchPage,
		signal: AbortSignal | undefined,
		position?: Position | null,
	) {
		this.dir = dir;
		this.files = files;
		this.page = page;
		this.signal = signal;
		this.position = position === undefined ? this.first() : position;
		if (this.position) this.checkPosition(this.position);
	}

	private first(): Position | null {
		const file = this.files[0];
		return file ? { file: file.name, offset: file.size, discard: false } : null;
	}

	checkPosition(position: Position): void {
		const file = this.files.find((file) => file.name === position.file);
		if (!file || position.offset > file.size) throw invalidCursor();
	}

	async close(): Promise<void> {
		const handle = this.handle;
		const file = this.file;
		this.handle = undefined;
		this.file = undefined;
		this.chunk = Buffer.alloc(0);
		if (!handle || !file) return;
		try {
			if (
				stamp(await handle.stat({ bigint: true })) !== file.stamp ||
				stamp(await lstat(join(this.dir, file.name), { bigint: true })) !== file.stamp
			)
				throw changed();
		} finally {
			await handle.close();
		}
	}

	private async openFile(file: Archive, position: Position): Promise<boolean> {
		if (this.handle) return true;
		if (this.page.scan.files >= SEARCH_LIMITS.files) {
			this.page.stop = "files";
			return false;
		}
		if (this.page.scan.bytes >= SEARCH_LIMITS.bytes) {
			this.page.stop = "bytes";
			return false;
		}
		this.handle = (await openArchive(join(this.dir, file.name))).handle;
		this.file = file;
		this.page.scan.files++;
		if (stamp(await this.handle.stat({ bigint: true })) !== file.stamp) throw changed();
		if (position.offset > 0 && position.offset < file.size && !position.discard) {
			const boundary = Buffer.alloc(1);
			const result = await this.handle.read(boundary, 0, 1, position.offset);
			this.page.scan.bytes += result.bytesRead;
			if (result.bytesRead !== 1 || boundary[0] !== 0x0a) throw invalidCursor();
		}
		return true;
	}

	private async selectFile(): Promise<boolean> {
		while (this.position) {
			this.signal?.throwIfAborted();
			const file = this.files.find((file) => file.name === this.position?.file);
			if (!file) throw invalidCursor();
			if (!(await this.openFile(file, this.position))) return false;
			if (this.position.offset > 0) return true;
			await this.close();
			const next = this.files[this.files.indexOf(file) + 1];
			this.position = next ? { file: next.name, offset: next.size, discard: false } : null;
		}
		return false;
	}

	private async loadChunk(end: number): Promise<boolean> {
		if (this.chunk.length && end > this.chunkStart && end <= this.chunkStart + this.chunk.length) return true;
		if (this.page.scan.bytes >= SEARCH_LIMITS.bytes) {
			this.page.stop = "bytes";
			return false;
		}
		const wanted = Math.min(CHUNK_BYTES, end, SEARCH_LIMITS.bytes - this.page.scan.bytes);
		this.chunkStart = end - wanted;
		this.chunk = Buffer.allocUnsafe(wanted);
		let read = 0;
		while (read < wanted) {
			this.signal?.throwIfAborted();
			if (!this.handle) throw new Error("Clipboard search archive is closed.");
			const result = await this.handle.read(this.chunk, read, wanted - read, this.chunkStart + read);
			if (!result.bytesRead) throw changed();
			read += result.bytesRead;
			this.page.scan.bytes += result.bytesRead;
		}
		return true;
	}

	async next(): Promise<RecordObservation | undefined> {
		if (this.page.scan.records >= SEARCH_LIMITS.records) {
			this.page.stop = "records";
			return undefined;
		}
		if (!(await this.selectFile()) || !this.position) return undefined;
		const start = { ...this.position };
		const parts: RecordParts = { chunks: [], bytes: 0, discard: start.discard };
		while (this.position.offset > 0) {
			this.signal?.throwIfAborted();
			if (!(await this.loadChunk(this.position.offset))) {
				if (!this.position.discard) this.position = start;
				return undefined;
			}
			const segment = this.chunk.subarray(0, this.position.offset - this.chunkStart);
			const newline = segment.lastIndexOf(0x0a);
			const part = segment.subarray(newline + 1);
			appendPart(parts, part, this.page);
			this.position.discard = parts.discard;
			this.position.offset = this.chunkStart + Math.max(0, newline);
			if (newline >= 0) break;
		}
		this.position.discard = false;
		this.page.scan.records++;
		const entry = parseRecord(parts, this.page);
		this.signal?.throwIfAborted();
		return { entry, file: start.file, end: start.offset };
	}
}

interface SearchState {
	dir: string;
	files: Archive[];
	options: SearchOptions;
	page: SearchPage;
	scan: ArchiveScan;
	candidate: Candidate | null;
	seen: Set<string>;
	matchBytes: number;
}

async function moveScan(state: SearchState, position?: Position | null): Promise<void> {
	await state.scan.close();
	state.scan = new ArchiveScan(state.dir, state.files, state.page, state.options.signal, position);
}

function acceptCandidate(state: SearchState, record: RecordObservation, entry: ClipboardEntry): boolean {
	const candidate = state.candidate;
	if (!candidate) throw invalidCursor();
	if (record.file !== candidate.file || record.end !== candidate.end) {
		state.page.scan.duplicates++;
		return true;
	}
	const match = matchEntry(entry, record.file, state.options.query);
	if (!match) throw invalidCursor();
	const bytes = Buffer.byteLength(JSON.stringify(match));
	if (state.matchBytes + bytes > SEARCH_LIMITS.matchBytes) {
		state.page.stop = "output";
		return false;
	}
	state.matchBytes += bytes;
	state.page.matches.push(match);
	return true;
}

async function visitRecord(state: SearchState, record: RecordObservation): Promise<boolean> {
	const entry = record.entry;
	if (!entry) return true;
	if (state.candidate) {
		if (entry.id !== state.candidate.id) return true;
		if (!acceptCandidate(state, record, entry)) return false;
		await moveScan(state, state.candidate.resume);
		state.candidate = null;
		return true;
	}
	if (state.seen.has(entry.id)) {
		state.page.scan.duplicates++;
		return true;
	}
	state.seen.add(entry.id);
	if (!matchEntry(entry, record.file, state.options.query)) return true;
	state.candidate = {
		id: entry.id,
		file: record.file,
		end: record.end,
		resume: state.scan.position ? { ...state.scan.position } : null,
	};
	await moveScan(state);
	return true;
}

async function runSearch(state: SearchState): Promise<void> {
	while (state.scan.position) {
		state.options.signal?.throwIfAborted();
		if (state.page.matches.length >= (state.options.limit ?? 10)) {
			state.page.stop = "matches";
			break;
		}
		const before = { ...state.scan.position };
		const record = await state.scan.next();
		if (!record) break;
		if (!(await visitRecord(state, record))) {
			state.scan.position = before;
			break;
		}
	}
}

function finishPage(state: SearchState, scope: string, digest: string): SearchPage {
	const page = state.page;
	if (state.scan.position) {
		page.nextCursor = Buffer.from(
			JSON.stringify({ v: 1, scope, catalog: digest, position: state.scan.position, candidate: state.candidate }),
		).toString("base64url");
		if (page.nextCursor.length > SEARCH_LIMITS.cursorChars)
			throw new Error("Clipboard search cursor exceeds its size limit.");
		page.hasMore = true;
	} else if (state.candidate) throw changed();
	else page.stop = "end";
	return page;
}

/** Verify each candidate from the newest record, so a nonmatching duplicate cannot produce a stale hit. */
export async function searchEntries(dir: string, options: SearchOptions): Promise<SearchPage> {
	validateOptions(options);
	options.signal?.throwIfAborted();
	const scope = hash(JSON.stringify([resolve(dir), options.query, options.date ?? null]));
	const cursor = decodeCursor(options.cursor, scope);
	const page: SearchPage = {
		matches: [],
		nextCursor: null,
		hasMore: false,
		stop: "end",
		scan: {
			directoryEntries: 0,
			archives: 0,
			files: 0,
			bytes: 0,
			records: 0,
			malformed: 0,
			oversized: 0,
			duplicates: 0,
		},
		limits: SEARCH_LIMITS,
	};
	if (!(await ensurePrivateDirectory(dir, false))) {
		if (cursor) throw changed();
		return page;
	}
	let state: SearchState | undefined;
	try {
		const snapshot = await catalog(dir, options.date, options.signal);
		page.scan.directoryEntries = snapshot.visited;
		page.scan.archives = snapshot.files.length;
		if (cursor && cursor.catalog !== snapshot.digest) throw changed();
		state = {
			dir,
			files: snapshot.files,
			options,
			page,
			scan: new ArchiveScan(dir, snapshot.files, page, options.signal, cursor?.position),
			candidate: cursor?.candidate ?? null,
			seen: new Set(),
			matchBytes: 0,
		};
		if (state.candidate) {
			state.scan.checkPosition({ file: state.candidate.file, offset: state.candidate.end, discard: false });
			if (state.candidate.resume) state.scan.checkPosition(state.candidate.resume);
		}
		await runSearch(state);
		await state.scan.close();
		return finishPage(state, scope, snapshot.digest);
	} catch (error) {
		if (missing(error) || (error as NodeJS.ErrnoException)?.code === "ELOOP") throw changed();
		throw error;
	} finally {
		await state?.scan.close();
	}
}
