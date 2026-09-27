/** Bounded, read-only discovery over the flat handover store. */
import { createHash } from "node:crypto";
import type { Dirent, Stats } from "node:fs";
import { lstat, opendir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { isStashState, parseFrontmatter, type StashMeta, type StashState } from "./format.ts";
import { redactSecrets } from "./redact.ts";
import { MAX_STASH_BYTES, normalizeMeta, openRegular, validateStore } from "./store.ts";
import { sanitizeTerminalText } from "./text.ts";

export const SEARCH_LIMITS = {
	directoryEntries: 10_000,
	candidates: 256,
	bytes: 4 * 1024 * 1024,
	matches: 10,
	outputBytes: 16 * 1024,
	queryUnits: 256,
} as const;
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}\.md$/;
const DIGEST = /^[a-f0-9]{64}$/;
const CONSISTENCY =
	"Membership is checked on each page. Bodies and filters are observations at each read, not a frozen snapshot. Repeat query and filters with nextCursor, even after an empty page. Skipped records prevent complete coverage. Read the selected stash before resuming; search does not activate it.";
const REPRESENTATION =
	"UTF-16 offsets in the full credential-redacted, terminal-escaped field; body uses parseFrontmatter's trimmed body. No normalization; Unicode simple case folding (JavaScript iu), not full folding.";

export interface SearchOptions {
	query: string;
	cursor?: string;
	limit?: number;
	tag?: string;
	state?: StashState;
}
interface Cursor {
	v: 1;
	binding: string;
	inventory: string;
	position: number;
	skipped: number;
}
export interface SearchMatch {
	id: string;
	title: string;
	state: string;
	field: string;
	start: number;
	end: number;
	excerptStart: number;
	excerptEnd: number;
	excerpt: string;
}
export interface SearchPage {
	matches: SearchMatch[];
	skipped: { id: string; reason: string }[];
	coverage: {
		directoryEntries: number;
		candidates: number;
		from: number;
		next: number;
		visited: number;
		bytesRead: number;
		searched: number;
		filtered: number;
		deferred: number;
		skippedTotal: number;
		complete: boolean;
	};
	nextCursor: string | null;
	consistency: string;
	representation: string;
}

function digest(value: unknown): string {
	return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
function cancelled(signal?: AbortSignal): void {
	if (signal?.aborted) throw new Error("stash_list cancelled");
}
function validateOptions(options: SearchOptions): void {
	if (
		typeof options.query !== "string" ||
		!options.query.trim() ||
		options.query.length > SEARCH_LIMITS.queryUnits ||
		/[\p{Cs}\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(options.query)
	) {
		throw new Error(
			"query must be nonblank, well-formed Unicode, at most 256 UTF-16 units, without controls or line separators",
		);
	}
	if (options.tag !== undefined && (typeof options.tag !== "string" || options.tag.length > 80))
		throw new Error("invalid tag");
	if (options.state !== undefined && !isStashState(options.state)) throw new Error("invalid state");
	if (options.limit !== undefined && (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 50))
		throw new Error("invalid limit");
}
function decodeCursor(raw: string | undefined): Cursor | undefined {
	if (raw === undefined) return undefined;
	const fail = () => new Error("invalid search cursor; restart without cursor");
	if (typeof raw !== "string" || raw.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(raw)) throw fail();
	try {
		const value = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as Cursor;
		if (
			value.v !== 1 ||
			!DIGEST.test(value.binding) ||
			!DIGEST.test(value.inventory) ||
			!Number.isSafeInteger(value.position) ||
			value.position < 1 ||
			value.position > SEARCH_LIMITS.directoryEntries ||
			!Number.isSafeInteger(value.skipped) ||
			value.skipped < 0 ||
			value.skipped > value.position ||
			encodeCursor(value) !== raw
		)
			throw fail();
		return value;
	} catch {
		throw fail();
	}
}
function encodeCursor(value: Cursor): string {
	const payload = {
		v: value.v,
		binding: value.binding,
		inventory: value.inventory,
		position: value.position,
		skipped: value.skipped,
	};
	return Buffer.from(JSON.stringify({ ...payload, checksum: digest(payload) })).toString("base64url");
}
function sameDirectory(a: Stats, b: Stats): boolean {
	return (
		b.isDirectory() &&
		!b.isSymbolicLink() &&
		a.dev === b.dev &&
		a.ino === b.ino &&
		a.mtimeMs === b.mtimeMs &&
		a.ctimeMs === b.ctimeMs
	);
}

function entryKind(entry: Dirent): string {
	if (entry.isFile()) return "file";
	if (entry.isSymbolicLink()) return "symlink";
	if (entry.isDirectory()) return "directory";
	return "other";
}

async function inventory(dir: string, signal?: AbortSignal) {
	cancelled(signal);
	const before = await validateStore(dir, false);
	cancelled(signal);
	if (!before) return { names: [] as string[], count: 0, identity: [resolve(dir), null], hash: digest([]) };
	const directory = await opendir(dir, { bufferSize: 1 });
	const entries: [string, string][] = [];
	try {
		while (true) {
			cancelled(signal);
			const entry = await directory.read();
			cancelled(signal);
			if (!entry) break;
			if (entries.length === SEARCH_LIMITS.directoryEntries)
				throw new Error(
					"search inventory exceeds 10000 directory entries; no search performed; narrow the store before retrying",
				);
			entries.push([entry.name, entryKind(entry)]);
		}
	} finally {
		await directory.close();
	}
	const after = await lstat(dir);
	cancelled(signal);
	if (!sameDirectory(before, after)) throw new Error("stash directory changed during enumeration; restart search");
	entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
	return {
		// Include nonregular artifact paths so the no-follow open reports explicit skips.
		names: entries
			.filter(([name]) => SAFE_NAME.test(name))
			.map(([name]) => name)
			.reverse(),
		count: entries.length,
		identity: [resolve(dir), after.dev, after.ino],
		hash: digest(entries),
	};
}

interface ReadBudget {
	bytes: number;
}
async function readCandidate(path: string, budget: ReadBudget, signal?: AbortSignal): Promise<string> {
	cancelled(signal);
	const { handle, info } = await openRegular(path);
	try {
		cancelled(signal);
		if ((info.mode & 0o7777) !== 0o600) await handle.chmod(0o600);
		const before = await handle.stat();
		if (before.size > MAX_STASH_BYTES) throw new Error("oversized");
		const buffer = Buffer.alloc(MAX_STASH_BYTES + 1);
		let offset = 0;
		while (offset < buffer.length) {
			cancelled(signal);
			const result = await handle.read(buffer, offset, buffer.length - offset, offset);
			offset += result.bytesRead;
			budget.bytes += result.bytesRead;
			cancelled(signal);
			if (result.bytesRead === 0) break;
		}
		const after = await handle.stat();
		const current = await lstat(path);
		cancelled(signal);
		if (offset > MAX_STASH_BYTES) throw new Error("oversized");
		if (
			before.size !== offset ||
			after.size !== offset ||
			before.mtimeMs !== after.mtimeMs ||
			before.ctimeMs !== after.ctimeMs ||
			current.dev !== after.dev ||
			current.ino !== after.ino ||
			current.size !== after.size ||
			current.mtimeMs !== after.mtimeMs ||
			current.ctimeMs !== after.ctimeMs ||
			!current.isFile() ||
			current.isSymbolicLink()
		)
			throw new Error("changed during read");
		try {
			return new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, offset));
		} catch {
			throw new Error("invalid UTF-8");
		}
	} finally {
		await handle.close();
	}
}

function safeField(value: string): string {
	return sanitizeTerminalText(redactSecrets(value)).text;
}
function boundary(text: string, offset: number): number {
	if (
		offset > 0 &&
		offset < text.length &&
		/[\uDC00-\uDFFF]/u.test(text[offset]) &&
		/[\uD800-\uDBFF]/u.test(text[offset - 1])
	)
		return offset - 1;
	return offset;
}
function shortTitle(value: string): string {
	return value.length <= 160 ? value : `${value.slice(0, boundary(value, 159))}…`;
}
function matchField(value: string, pattern: RegExp) {
	const text = safeField(value);
	const hit = pattern.exec(text);
	if (!hit) return undefined;
	const start = hit.index;
	const end = start + hit[0].length;
	const excerptStart = boundary(text, Math.max(0, start - 48));
	const excerptEnd = boundary(text, Math.min(text.length, end + 48));
	return { start, end, excerptStart, excerptEnd, excerpt: text.slice(excerptStart, excerptEnd) };
}
function validateHeader(text: string): void {
	const lines = text.split("\n");
	if (lines[0]?.trim() !== "---") return;
	for (const line of lines.slice(1)) {
		if (line.trim() === "---") return;
		if (!line.trim()) continue;
		const separator = line.indexOf(":");
		if (separator < 1) throw new Error("malformed header");
		try {
			JSON.parse(line.slice(separator + 1).trim());
		} catch {
			throw new Error("malformed header");
		}
	}
	throw new Error("unclosed header");
}
function candidateFields(meta: StashMeta, body: string): [string, string][] {
	const fields: [string, string][] = [
		["id", meta.id],
		["title", meta.title],
	];
	for (const [index, tag] of meta.tags.entries()) fields.push([`tags[${index}]`, tag]);
	for (const key of [
		"created",
		"project",
		"branch",
		"sessionId",
		"state",
		"activatedAt",
		"closedAt",
		"outcome",
	] as const) {
		const value = meta[key];
		if (typeof value === "string") fields.push([key, value]);
	}
	fields.push(["body", body]);
	return fields;
}
function inspectCandidate(
	name: string,
	text: string,
	options: SearchOptions,
	pattern: RegExp,
): { match?: SearchMatch; filtered: boolean } {
	validateHeader(text);
	const parsed = parseFrontmatter(text);
	const meta = normalizeMeta(name, parsed.meta);
	if (safeField(meta.id) !== meta.id) throw new Error("redacted filename");
	if ((options.tag && !meta.tags.includes(options.tag)) || (options.state && meta.state !== options.state))
		return { filtered: true };
	for (const [field, value] of candidateFields(meta, parsed.body)) {
		const hit = matchField(value, pattern);
		if (hit)
			return {
				filtered: false,
				match: { id: meta.id, title: shortTitle(safeField(meta.title)), state: meta.state, field, ...hit },
			};
	}
	return { filtered: false };
}
function skipReason(error: unknown): string {
	const known = [
		"oversized",
		"changed during read",
		"invalid UTF-8",
		"unclosed header",
		"malformed header",
		"redacted filename",
	];
	if (error instanceof Error && known.includes(error.message)) return error.message;
	if (error instanceof Error && "code" in error) {
		if (error.code === "ENOENT") return "vanished";
		if (error.code === "EACCES" || error.code === "EPERM") return "unreadable";
		if (error.code === "ELOOP") return "symlink";
	}
	return "unreadable or nonregular";
}

async function consumeCandidate(
	dir: string,
	name: string,
	options: SearchOptions,
	pattern: RegExp,
	page: SearchPage,
	budget: ReadBudget,
	signal?: AbortSignal,
): Promise<boolean> {
	cancelled(signal);
	page.coverage.visited++;
	let result: ReturnType<typeof inspectCandidate>;
	try {
		const text = await readCandidate(join(dir, name), budget, signal);
		result = inspectCandidate(name, text, options, pattern);
	} catch (error) {
		cancelled(signal);
		page.skipped.push({ id: safeField(name.slice(0, -3)), reason: skipReason(error) });
		page.coverage.skippedTotal++;
		page.coverage.next++;
		return true;
	}
	if (result.match) {
		page.matches.push(result.match);
		// Keep the current candidate unconsumed if its result does not fit.
		if (Buffer.byteLength(JSON.stringify(page), "utf8") > SEARCH_LIMITS.outputBytes - 1024) {
			page.matches.pop();
			page.coverage.deferred++;
			return false;
		}
	}
	if (result.filtered) page.coverage.filtered++;
	else page.coverage.searched++;
	page.coverage.next++;
	return true;
}

/** Search one bounded page without a store sweep or persistent search state. */
export async function searchStashes(dir: string, options: SearchOptions, signal?: AbortSignal): Promise<SearchPage> {
	validateOptions(options);
	const cursor = decodeCursor(options.cursor);
	const found = await inventory(dir, signal);
	const binding = digest([options.query, options.tag ?? null, options.state ?? null, found.identity]);
	if (
		cursor &&
		(cursor.binding !== binding || cursor.inventory !== found.hash || cursor.position >= found.names.length)
	)
		throw new Error("search cursor no longer matches query, filters, store, or inventory; restart without cursor");
	const from = cursor?.position ?? 0;
	const page: SearchPage = {
		matches: [],
		skipped: [],
		coverage: {
			directoryEntries: found.count,
			candidates: found.names.length,
			from,
			next: from,
			visited: 0,
			bytesRead: 0,
			searched: 0,
			filtered: 0,
			deferred: 0,
			skippedTotal: cursor?.skipped ?? 0,
			complete: false,
		},
		nextCursor: null,
		consistency: CONSISTENCY,
		representation: REPRESENTATION,
	};
	const budget = { bytes: 0 };
	const pattern = new RegExp(options.query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "iu");
	const limit = Math.min(options.limit ?? 10, SEARCH_LIMITS.matches);
	while (
		page.coverage.next < found.names.length &&
		page.coverage.visited < SEARCH_LIMITS.candidates &&
		page.matches.length < limit &&
		budget.bytes + MAX_STASH_BYTES + 1 <= SEARCH_LIMITS.bytes &&
		Buffer.byteLength(JSON.stringify(page), "utf8") <= SEARCH_LIMITS.outputBytes - 2048
	) {
		if (!(await consumeCandidate(dir, found.names[page.coverage.next], options, pattern, page, budget, signal))) break;
	}
	cancelled(signal);
	page.coverage.bytesRead = budget.bytes;
	if (page.coverage.next < found.names.length) {
		page.nextCursor = encodeCursor({
			v: 1,
			binding,
			inventory: found.hash,
			position: page.coverage.next,
			skipped: page.coverage.skippedTotal,
		});
	}
	page.coverage.complete = page.nextCursor === null && page.coverage.skippedTotal === 0;
	return page;
}
