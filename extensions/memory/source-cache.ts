// Bounded reuse of verified-source header parsing.
//
// Callers keep every root, inventory, no-follow, bounded-read and evidence check.
// This module receives the text from that safe read and retains only its parse
// products: never bodies, scans, cursors, descriptors or abort signals.

import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";

const CUE_KEYS = ["title", "tags", "status", "supersedes", "superseded_by"];
const MAX_ISSUE_CHARS = 240;
const DEFAULT_MAX_ENTRIES = 2048;
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_ENTRY_BYTES = 256 * 1024;

export type MemoryHeaderState = "ok" | "absent" | "partial" | "malformed";

/** Parse products of one complete bounded header, reused only for identical verified source text. */
export type ParsedMemoryHeader = {
	readonly header: string;
	/** UTF-16 index in the supplied source where the body begins. */
	readonly bodyStart: number;
	readonly metadata: MemoryHeaderState;
	readonly issue?: string;
	readonly lines: ReadonlyMap<string, string>;
	readonly multiline: boolean;
	readonly duplicate: boolean;
	readonly unusable: ReadonlySet<string>;
	readonly parsed?: Record<string, unknown>;
	readonly status?: unknown;
	readonly supersededBy?: unknown;
	/** One isolated scalar field, parsed with its own alias and representation rules. */
	pointer(key: string): string | undefined;
};

export interface MemorySourceCache {
	read(
		root: string,
		file: string,
		source: Readonly<{ text: string; truncated: boolean }>,
	): ParsedMemoryHeader;
	invalidate(root: string, file: string): void;
	clear(): void;
}

export type MemorySourceCacheStatistics = {
	entries: number;
	bytes: number;
	hits: number;
	misses: number;
	yamlParses: number;
	evictions: number;
	skipped: number;
};

export type MemorySourceCacheLimits = {
	maxEntries?: number;
	maxBytes?: number;
	maxEntryBytes?: number;
};

type Entry = {
	header: ParsedMemoryHeader;
	bytes: number;
	live: boolean;
};

type HeaderRecord = {
	header: string;
	bodyStart: number;
	metadata: MemoryHeaderState;
	issue?: string;
	lines: Map<string, string>;
	multiline: boolean;
	duplicate: boolean;
	unusable: Set<string>;
	parsed?: Record<string, unknown>;
	status?: unknown;
	supersededBy?: unknown;
};

type CueFieldState = {
	lines: Map<string, string>;
	problems: string[];
	blockKey: string | undefined;
	multiline: boolean;
	duplicate: boolean;
	unusable: Set<string>;
};

type HeaderSkeleton = {
	header: string;
	bodyStart: number;
	metadata: MemoryHeaderState;
	issue?: string;
	block?: string;
};

function boundedIssue(text: string): string {
	const safe = text.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ");
	if (safe.length <= MAX_ISSUE_CHARS) return safe;
	let end = MAX_ISSUE_CHARS - 1;
	const last = safe.charCodeAt(end - 1);
	if (last >= 0xd800 && last <= 0xdbff) end -= 1;
	return `${safe.slice(0, end)}\u2026`;
}

/** Find a closing delimiter line without interpreting YAML. */
export function findFrontmatterClose(text: string): { start: number; end: number } | undefined {
	const match = /(?:^|\n)---[ \t]*(?=\r?\n|$)/.exec(text);
	if (match === null) return undefined;
	const start = match.index + (match[0].startsWith("\n") ? 1 : 0);
	let end = match.index + match[0].length;
	if (text[end] === "\r") end += 1;
	if (text[end] === "\n") end += 1;
	return { start, end };
}

function applyCueLine(state: CueFieldState, rawLine: string): void {
	if (rawLine.trim() === "") return;
	if (/^[ \t]/.test(rawLine)) {
		if (state.blockKey !== undefined) {
			state.multiline = true;
			state.unusable.add(state.blockKey);
			state.problems.push(`unsupported multiline cue: ${state.blockKey}`);
		}
		return;
	}
	state.blockKey = undefined;
	const match = /^([A-Za-z_][A-Za-z0-9_-]*):[ \t]?(.*)$/.exec(rawLine);
	if (match === null || !CUE_KEYS.includes(match[1])) return;
	const key = match[1];
	const value = match[2].trim();
	state.blockKey = key;
	if (value === "" || /^[|>]/.test(value)) {
		state.unusable.add(key);
		state.problems.push(`${key} has an empty or block value`);
	}
	if (state.lines.has(key)) {
		state.duplicate = true;
		state.unusable.add(key);
		state.problems.push(`duplicate cue field: ${key}`);
	} else {
		state.lines.set(key, rawLine.trimEnd());
	}
}

function extractCueFields(block: string): {
	lines: Map<string, string>;
	multiline: boolean;
	duplicate: boolean;
	problems: string[];
	unusable: Set<string>;
} {
	const state: CueFieldState = {
		lines: new Map(),
		problems: [],
		blockKey: undefined,
		multiline: false,
		duplicate: false,
		unusable: new Set(),
	};
	for (const rawLine of block.split("\n")) applyCueLine(state, rawLine);
	return {
		lines: state.lines,
		multiline: state.multiline,
		duplicate: state.duplicate,
		problems: state.problems,
		unusable: state.unusable,
	};
}

/** Map a normalized-text index back to the exact supplied source. */
function rawOffset(raw: string, normalizedIndex: number): number {
	let rawIndex = raw.charCodeAt(0) === 0xfeff ? 1 : 0;
	let index = 0;
	while (index < normalizedIndex) {
		if (raw.charCodeAt(rawIndex) === 13 && raw.charCodeAt(rawIndex + 1) === 10) rawIndex += 2;
		else rawIndex += 1;
		index += 1;
	}
	return rawIndex;
}

function scanHeader(raw: string, truncated: boolean): HeaderSkeleton {
	const text = raw.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
	const open = /^---[ \t]*\n/.exec(text);
	if (open === null) {
		return { header: "", bodyStart: raw.charCodeAt(0) === 0xfeff ? 1 : 0, metadata: "absent" };
	}
	const afterOpen = text.slice(open[0].length);
	const close = findFrontmatterClose(afterOpen);
	const rawOpen = /^\uFEFF?---[ \t]*\r?\n/.exec(raw);
	const rawClose = rawOpen === null ? undefined : findFrontmatterClose(raw.slice(rawOpen[0].length));
	const header = rawOpen !== null && rawClose !== undefined ? raw.slice(0, rawOpen[0].length + rawClose.end) : raw;
	if (close === undefined) {
		return {
			header,
			bodyStart: raw.length,
			metadata: truncated ? "partial" : "malformed",
			issue: truncated
				? "frontmatter not closed within the read window"
				: "frontmatter has no closing delimiter",
		};
	}
	const bodyStart =
		rawOpen !== null && rawClose !== undefined
			? rawOpen[0].length + rawClose.end
			: rawOffset(raw, open[0].length + close.end);
	return { header, bodyStart, metadata: "ok", block: afterOpen.slice(0, close.start) };
}

function buildHeader(skeleton: HeaderSkeleton, parse: () => void): HeaderRecord {
	const base = {
		header: skeleton.header,
		bodyStart: skeleton.bodyStart,
		lines: new Map<string, string>(),
		multiline: false,
		duplicate: false,
		unusable: new Set<string>(),
	};
	if (skeleton.metadata !== "ok") return { ...base, metadata: skeleton.metadata, issue: skeleton.issue };
	const fields = extractCueFields(skeleton.block ?? "");
	const problems = fields.problems;
	const result: HeaderRecord = {
		...base,
		metadata: "ok",
		lines: fields.lines,
		multiline: fields.multiline,
		duplicate: fields.duplicate,
		unusable: fields.unusable,
		parsed: undefined,
		status: undefined,
		supersededBy: undefined,
	};
	try {
		parse();
		const { frontmatter, body } = parseFrontmatter<Record<string, unknown>>(
			`---\n${skeleton.block ?? ""}---\n`,
		);
		if (body !== "" || !frontmatter || typeof frontmatter !== "object" || Array.isArray(frontmatter))
			throw new Error("Ambiguous header");
		result.parsed = frontmatter;
		result.status = Object.hasOwn(frontmatter, "status") ? frontmatter.status : undefined;
		result.supersededBy = Object.hasOwn(frontmatter, "superseded_by") ? frontmatter.superseded_by : undefined;
	} catch {
		result.metadata = "malformed";
		problems.unshift("invalid or ambiguous frontmatter; metadata cues are untrusted");
	}
	if (problems.length > 0) result.issue = boundedIssue(problems.join("; "));
	return result;
}

function parsePointer(record: ParsedMemoryHeader, key: string, parse: () => void): string | undefined {
	if (record.metadata !== "ok" || record.unusable.has(key)) return undefined;
	const line = record.lines.get(key);
	if (line === undefined) return undefined;
	parse();
	try {
		const fields = parseFrontmatter<Record<string, unknown>>(`---\n${line}\n---\n`).frontmatter;
		return Object.keys(fields).length === 1 && typeof fields[key] === "string" ? fields[key] : undefined;
	} catch {
		return undefined;
	}
}

function accountedSize(root: string, file: string, header: ParsedMemoryHeader): number {
	return Buffer.byteLength(
		JSON.stringify({
			root,
			file,
			header: header.header,
			bodyStart: header.bodyStart,
			metadata: header.metadata,
			issue: header.issue ?? null,
			lines: [...header.lines],
			multiline: header.multiline,
			duplicate: header.duplicate,
			unusable: [...header.unusable],
			parsed: header.parsed ?? null,
			status: header.status ?? null,
			supersededBy: header.supersededBy ?? null,
		}),
	);
}

/** An unaccountable parse product is skipped rather than failing the read. */
function accountedBytes(root: string, file: string, header: ParsedMemoryHeader): number | undefined {
	try {
		return accountedSize(root, file, header);
	} catch {
		return undefined;
	}
}

function pointerSize(key: string, value: string | undefined): number {
	return Buffer.byteLength(key) + (value === undefined ? 0 : Buffer.byteLength(value)) + 8;
}

/**
 * Copy a bounded region into its own storage.
 *
 * A slice keeps its complete parent string alive, so a retained header slice
 * would retain the whole read window. A UTF-8 round trip creates independent
 * storage; text that cannot round-trip exactly is left for the caller to skip.
 */
function detach(text: string): string | undefined {
	const copy = Buffer.from(text, "utf8").toString("utf8");
	return copy === text ? copy : undefined;
}

function detachedSkeleton(skeleton: HeaderSkeleton): HeaderSkeleton | undefined {
	const header = detach(skeleton.header);
	if (header === undefined) return undefined;
	if (skeleton.block === undefined) return { ...skeleton, header };
	const block = detach(skeleton.block);
	return block === undefined ? undefined : { ...skeleton, header, block };
}

/**
 * Bounded least-recently-used reuse of header parse products.
 *
 * A key binds the canonical root, filename, truncation interpretation, body offset
 * and exact raw header bytes. A changed root or changed header cannot reuse another
 * corpus's or note's products. Accounts include the retained parse products. A miss
 * copies the header region into its own storage, so an entry does not retain the read
 * window it was parsed from. A parse product that cannot be accounted for is returned
 * uncached and counted as skipped.
 *
 * A source without a closing delimiter has no separable body region: its header
 * interpretation is the bounded read window, which is what an entry retains.
 */
export function createMemorySourceCache(
	limits: MemorySourceCacheLimits = {},
): MemorySourceCache & { statistics(): MemorySourceCacheStatistics } {
	const maxEntries = limits.maxEntries ?? DEFAULT_MAX_ENTRIES;
	const maxBytes = limits.maxBytes ?? DEFAULT_MAX_BYTES;
	const maxEntryBytes = limits.maxEntryBytes ?? DEFAULT_MAX_ENTRY_BYTES;
	const entries = new Map<string, Entry>();
	let totalBytes = 0;
	let hits = 0;
	let misses = 0;
	let yamlParses = 0;
	let evictions = 0;
	let skipped = 0;

	const trim = () => {
		while (entries.size > maxEntries || totalBytes > maxBytes) {
			const oldest = entries.keys().next();
			if (oldest.done) return;
			const entry = entries.get(oldest.value);
			entries.delete(oldest.value);
			evictions += 1;
			if (entry === undefined) continue;
			entry.live = false;
			totalBytes -= entry.bytes;
		}
	};

	const read = (
		root: string,
		file: string,
		source: Readonly<{ text: string; truncated: boolean }>,
	): ParsedMemoryHeader => {
		const canonical = resolve(root);
		const skeleton = scanHeader(source.text, source.truncated);
		const key = [
			canonical,
			file,
			source.truncated ? "truncated" : "complete",
			String(skeleton.bodyStart),
			createHash("sha256").update(skeleton.header).digest("hex"),
		].join("\u0000");
		const existing = entries.get(key);
		if (existing !== undefined) {
			hits += 1;
			entries.delete(key);
			entries.set(key, existing);
			return existing.header;
		}
		misses += 1;
		const pointers = new Map<string, string | undefined>();
		const retained = detachedSkeleton(skeleton);
		const parsed = buildHeader(retained ?? skeleton, () => {
			yamlParses += 1;
		});
		let entry: Entry | undefined;
		const header: ParsedMemoryHeader = {
			...parsed,
			pointer(key: string) {
				if (pointers.has(key)) return pointers.get(key);
				const value = parsePointer(header, key, () => {
					yamlParses += 1;
				});
				pointers.set(key, value);
				if (entry === undefined || !entry.live) return value;
				const delta = pointerSize(key, value);
				entry.bytes += delta;
				totalBytes += delta;
				trim();
				return value;
			},
		};
		const bytes = accountedBytes(canonical, file, header);
		if (retained === undefined || bytes === undefined) {
			// A product outside the accounting contract stays readable but is never retained.
			skipped += 1;
			return header;
		}
		if (bytes > maxEntryBytes || bytes > maxBytes) {
			skipped += 1;
			return header;
		}
		entry = { header, bytes, live: true };
		entries.set(key, entry);
		totalBytes += bytes;
		trim();
		return header;
	};

	const invalidate = (root: string, file: string): void => {
		const prefix = `${resolve(root)}\u0000${file}\u0000`;
		for (const [key, entry] of entries) {
			if (!key.startsWith(prefix)) continue;
			entries.delete(key);
			entry.live = false;
			totalBytes -= entry.bytes;
		}
	};

	const clear = (): void => {
		for (const entry of entries.values()) entry.live = false;
		entries.clear();
		totalBytes = 0;
	};

	return {
		read,
		invalidate,
		clear,
		statistics: () => ({ entries: entries.size, bytes: totalBytes, hits, misses, yamlParses, evictions, skipped }),
	};
}

/** The corpus parse reuse used by retrieval and invalidated by owned publications. */
export const memorySourceCache = createMemorySourceCache();
