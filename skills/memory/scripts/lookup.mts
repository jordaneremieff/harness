#!/usr/bin/env node
// lookup.mts - bounded, read-only discovery over an operator memory corpus.
//
// The corpus root is the absolute path in PI_MEMORY_DIR. One run emits one
// compact JSON object: a paged index of raw frontmatter cue lines, or one
// bounded source page for a named note. Discovery reads filenames and raw cue
// lines only; it never searches note bodies and never writes to the corpus.

import { createHash } from "node:crypto";
import {
	type Dirent,
	type Stats,
	closeSync,
	constants,
	fstatSync,
	openSync,
	opendirSync,
	readSync,
	realpathSync,
	statSync,
} from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const VISIT_CAP = 512;
const INDEX_READ_BYTES = 8 * 1024;
const SOURCE_READ_BYTES = 64 * 1024;
const INDEX_PAGE_SIZE = 25;
const PAGE_CODEPOINTS = 4000;
const MAX_STDOUT_BYTES = 48 * 1024;
const MAX_QUERY_CHARS = 200;
const MAX_SLUG_CHARS = 120;
const MAX_ROOT_CHARS = 1024;
const MAX_ERROR_CHARS = 500;
const MAX_ISSUES = 20;
const MAX_ISSUE_CHARS = 240;
const MAX_TITLE_CHARS = 160;
const MAX_CUE_CHARS = 240;
const OFFSET_LIMIT = 1_000_000_000;
const INDEX_LIMIT = 1_000_000;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const SLUG_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const CUE_KEYS = ["title", "tags", "status", "supersedes", "superseded_by"];
const NOTE_OPEN_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const OPTION_NAMES = new Map<string, string>([
	["--query", "query"],
	["--note", "note"],
	["--offset", "offset"],
	["--digest", "digest"],
	["--index", "index"],
]);

type MetadataState = "ok" | "absent" | "partial" | "malformed";
type TitleSource = "frontmatter" | "heading" | "filename";

type Cue = {
	metadata: MetadataState;
	issue?: string;
	lines: Map<string, string>;
	multiline: boolean;
	duplicate: boolean;
	body: string;
};

type NoteCue = {
	slug: string;
	file: string;
	title: string;
	titleSource: TitleSource;
	cues: Map<string, string>;
	cuesClipped: boolean;
	cuesMultiline: boolean;
	cuesDuplicate: boolean;
	metadata: MetadataState;
	metadataIssue?: string;
	searchText: string;
	size: number;
};

type Issue = { code: string; message: string };

type Scan = {
	notes: NoteCue[];
	issues: Issue[];
	issueCount: number;
	visited: number;
	complete: boolean;
};

type OpenResult = { ok: true; fd: number; size: number } | { ok: false; reason: string };
type IndexWindow = { ok: true; text: string; truncated: boolean; size: number } | { ok: false; reason: string };
type SourceResult = { ok: true; buffer: Buffer } | { ok: false; reason: string };
type PageSlice = { content: string; nextOffset: number; contentCodePoints: number; hasMore: boolean };

type Args =
	| { kind: "help" }
	| { kind: "index"; query: string | null; index: number }
	| { kind: "note"; slug: string; offset: number; digest: string | null };

class LookupError extends Error {
	readonly exitCode: number;
	constructor(message: string, exitCode: number) {
		super(message);
		this.name = "LookupError";
		this.exitCode = exitCode;
	}
}

class UsageError extends LookupError {
	constructor(message: string) {
		super(message, 2);
	}
}

class CorpusError extends LookupError {
	constructor(message: string) {
		super(message, 3);
	}
}

class DigestError extends LookupError {
	constructor(message: string) {
		super(message, 4);
	}
}

function helpText(): string {
	return `Usage: node skills/memory/scripts/lookup.mts [OPTIONS]

Read the operator memory corpus rooted at PI_MEMORY_DIR (required, absolute).
This command is read-only. It never creates the root, the README, or any file.
README.md is the required corpus contract and is not itself a note.

Options:
  --query <text>   Show only notes whose slug, filename, or raw title/tag cue
                   text contains <text>. The match is literal and
                   case-insensitive. This is NOT semantic or full-body search.
                   Maximum 200 characters.
  --note <slug>    Return one bounded source page for <slug>. The value README
                   selects the corpus contract README.md instead of a note.
  --offset <n>     Unicode code-point offset into the note source (default 0).
                   Valid only with --note. An offset above 0 requires --digest.
  --digest <hex>   Lowercase SHA-256 hex of the accepted source from a prior
                   page. Valid only with --note. A mismatch rejects changed
                   source.
  --index <n>      Zero-based entry offset into the filtered, sorted matches
                   (default 0). Valid only without --note. Maximum 1000000.
  -h, --help       Show this help.

Output:
  stdout  One compact JSON object on success.
  stderr  A single "Error: <message>" line on failure.

Exit codes:
  0  Success
  2  Invalid invocation
  3  Corpus unavailable, note missing, source too large, invalid UTF-8, or path
     refused
  4  Note source changed since the supplied digest

Cue index:
  Each note exposes title, titleSource, and cues: raw frontmatter lines for
  title, tags, status, supersedes, and superseded_by, kept verbatim. Status
  and supersession text is source evidence, not parsed interpretation. Cues
  are not validated as YAML. flags cuesClipped, cuesMultiline, and
  cuesDuplicate mark a clipped line, an unsupported multiline/empty value, and
  a repeated field. metadata is ok, absent, partial (frontmatter not closed
  within the read window), or malformed (frontmatter not closed).

Bounds:
  - The directory scan is non-recursive and stops at 512 entries.
  - The index reads the first 8192 bytes of each note.
  - The index page target is 25 notes, shrunk as needed so the serialized
    stdout, including its newline, stays below 50 KiB. nextIndex continues
    exactly after the last returned record, so no record is skipped.
  - A note source must be at most 65536 bytes and valid UTF-8; otherwise it is
    refused.
  - A source page holds at most 4000 code points.
  - Hidden entries are ignored. A note is opened with O_NOFOLLOW and
    O_NONBLOCK, checked with fstat, read through that descriptor, and must be
    a regular file. Symbolic links, nonregular files, and filenames outside
    the --note slug grammar are refused or excluded with a reported issue.
  - README.md must exist and be a readable regular file for index and note
    access.
`;
}

function bounded(text: string, max: number): string {
	const safe = text.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ");
	return safe.length <= max ? safe : `${safe.slice(0, max - 1)}\u2026`;
}

function parseBoundedInt(name: string, raw: string, min: number, max: number): number {
	if (!/^(?:0|[1-9][0-9]*)$/.test(raw)) throw new UsageError(`${name} must be a non-negative integer`);
	const value = Number(raw);
	if (value < min || value > max) throw new UsageError(`${name} must be between ${min} and ${max}`);
	return value;
}

function normalizeQuery(text: string): string | null {
	const trimmed = text.trim();
	if (trimmed.length > MAX_QUERY_CHARS) {
		throw new UsageError(`--query is ${trimmed.length} characters; maximum is ${MAX_QUERY_CHARS}`);
	}
	return trimmed === "" ? null : trimmed;
}

function normalizeSlug(slug: string): string {
	if (slug === "README") return slug;
	if (/\.md$/i.test(slug)) throw new UsageError("use the note slug without the .md extension");
	if (!SLUG_PATTERN.test(slug) || slug.length > MAX_SLUG_CHARS) throw new UsageError(`invalid note slug: ${slug}`);
	return slug;
}

function normalizeDigest(raw: string): string {
	const value = raw.toLowerCase();
	if (!DIGEST_PATTERN.test(value)) throw new UsageError("--digest must be a 64-character SHA-256 hex value");
	return value;
}

function collectOptions(argv: string[]): { help: boolean; values: Map<string, string> } {
	const values = new Map<string, string>();
	let help = false;
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === "--help" || arg === "-h") {
			help = true;
			continue;
		}
		const name = OPTION_NAMES.get(arg);
		if (name === undefined) throw new UsageError(`unknown option: ${arg}`);
		if (values.has(name)) throw new UsageError(`duplicate option: ${arg}`);
		const value = argv[index + 1];
		if (value === undefined) throw new UsageError(`option ${arg} requires a value`);
		values.set(name, value);
		index += 1;
	}
	return { help, values };
}

function buildNoteArgs(values: Map<string, string>): Args {
	if (values.has("query")) throw new UsageError("--query cannot be combined with --note");
	if (values.has("index")) throw new UsageError("--index cannot be combined with --note");
	const slug = normalizeSlug(values.get("note") ?? "");
	const offsetRaw = values.get("offset");
	const offset = offsetRaw === undefined ? 0 : parseBoundedInt("--offset", offsetRaw, 0, OFFSET_LIMIT);
	const digestRaw = values.get("digest");
	if (offset > 0 && digestRaw === undefined) {
		throw new UsageError("--offset above 0 requires --digest for safe continuation");
	}
	const digest = digestRaw === undefined ? null : normalizeDigest(digestRaw);
	return { kind: "note", slug, offset, digest };
}

function buildIndexArgs(values: Map<string, string>): Args {
	if (values.has("offset")) throw new UsageError("--offset requires --note");
	if (values.has("digest")) throw new UsageError("--digest requires --note");
	const indexRaw = values.get("index");
	const index = indexRaw === undefined ? 0 : parseBoundedInt("--index", indexRaw, 0, INDEX_LIMIT);
	const queryRaw = values.get("query");
	const query = queryRaw === undefined ? null : normalizeQuery(queryRaw);
	return { kind: "index", query, index };
}

function parseArgs(argv: string[]): Args {
	const { help, values } = collectOptions(argv);
	if (help) return { kind: "help" };
	return values.has("note") ? buildNoteArgs(values) : buildIndexArgs(values);
}

function noteFileForSlug(slug: string): string {
	return slug === "README" ? "README.md" : `${slug}.md`;
}

// Only names that --note reproduces exactly are addressable.
function addressableSlug(name: string): string | undefined {
	if (!name.endsWith(".md")) return undefined;
	const slug = name.slice(0, -3);
	if (slug === "README" || /\.md$/i.test(slug)) return undefined;
	if (!SLUG_PATTERN.test(slug) || slug.length > MAX_SLUG_CHARS) return undefined;
	return slug;
}

function findFrontmatterClose(text: string): { start: number; end: number } | undefined {
	const match = /^---[ \t]*$/m.exec(text);
	if (match === null || match.index === undefined) return undefined;
	const start = match.index;
	let end = start + match[0].length;
	if (text[end] === "\n") end += 1;
	return { start, end };
}

type CueFieldState = {
	lines: Map<string, string>;
	problems: string[];
	blockKey: string | undefined;
	multiline: boolean;
	duplicate: boolean;
};

function applyCueLine(state: CueFieldState, rawLine: string): void {
	if (rawLine.trim() === "") return;
	if (/^[ \t]/.test(rawLine)) {
		if (state.blockKey !== undefined) {
			state.multiline = true;
			state.problems.push(`unsupported multiline cue: ${state.blockKey}`);
		}
		return;
	}
	state.blockKey = undefined;
	const match = /^([A-Za-z_][A-Za-z0-9_-]*):[ \t]?(.*)$/.exec(rawLine);
	if (match === null || !CUE_KEYS.includes(match[1])) return;
	const key = match[1];
	const value = match[2].trim();
	if (value === "" || /^[|>]/.test(value)) {
		state.blockKey = key;
		state.problems.push(`${key} has an empty or block value`);
	}
	if (state.lines.has(key)) {
		state.duplicate = true;
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
} {
	const state: CueFieldState = {
		lines: new Map(),
		problems: [],
		blockKey: undefined,
		multiline: false,
		duplicate: false,
	};
	for (const rawLine of block.split("\n")) applyCueLine(state, rawLine);
	return { lines: state.lines, multiline: state.multiline, duplicate: state.duplicate, problems: state.problems };
}

function extractCue(raw: string, truncated: boolean): Cue {
	const text = raw.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
	const open = /^---[ \t]*\n/.exec(text);
	if (open === null) return { metadata: "absent", lines: new Map(), multiline: false, duplicate: false, body: text };
	const afterOpen = text.slice(open[0].length);
	const close = findFrontmatterClose(afterOpen);
	if (close === undefined) {
		return {
			metadata: truncated ? "partial" : "malformed",
			issue: truncated ? "frontmatter not closed within the read window" : "frontmatter has no closing delimiter",
			lines: new Map(),
			multiline: false,
			duplicate: false,
			body: "",
		};
	}
	const fields = extractCueFields(afterOpen.slice(0, close.start));
	const cue: Cue = {
		metadata: "ok",
		lines: fields.lines,
		multiline: fields.multiline,
		duplicate: fields.duplicate,
		body: afterOpen.slice(close.end),
	};
	if (fields.problems.length > 0) cue.issue = bounded(fields.problems.join("; "), MAX_ISSUE_CHARS);
	return cue;
}

function valueAfterKey(line: string): string {
	const colon = line.indexOf(":");
	return colon < 0 ? "" : line.slice(colon + 1).trim();
}

function findHeading(text: string): string | undefined {
	const match = text.match(/^[ \t]{0,3}#{1,6}[ \t]+(.+)$/m);
	if (match === null) return undefined;
	const title = match[1].replace(/[ \t]+#+[ \t]*$/, "").trim();
	return title === "" ? undefined : title;
}

function buildNoteCue(file: string, slug: string, text: string, truncated: boolean, size: number): NoteCue {
	const cue = extractCue(text, truncated);
	const titleLine = cue.lines.get("title");
	const titleValue = titleLine === undefined ? undefined : valueAfterKey(titleLine) || undefined;
	const heading = titleValue === undefined ? findHeading(cue.body) : undefined;
	const title = titleValue ?? heading ?? slug;
	const tagLine = cue.lines.get("tags");
	const tagText = tagLine === undefined ? "" : valueAfterKey(tagLine);
	let cuesClipped = false;
	for (const line of cue.lines.values()) {
		if (line.length > MAX_CUE_CHARS) cuesClipped = true;
	}
	const problems = cue.issue === undefined ? [] : [cue.issue];
	if (cuesClipped) problems.push("cue text clipped");
	const note: NoteCue = {
		slug,
		file,
		title,
		titleSource: titleValue !== undefined ? "frontmatter" : heading !== undefined ? "heading" : "filename",
		cues: cue.lines,
		cuesClipped,
		cuesMultiline: cue.multiline,
		cuesDuplicate: cue.duplicate,
		metadata: cue.metadata,
		searchText: [slug, file, title, tagText].join("\n").toLowerCase(),
		size,
	};
	if (problems.length > 0) note.metadataIssue = bounded(problems.join("; "), MAX_ISSUE_CHARS);
	return note;
}

function toOutputNote(note: NoteCue): Record<string, unknown> {
	const cues: Record<string, string> = {};
	for (const [key, line] of note.cues) cues[key] = bounded(line, MAX_CUE_CHARS);
	const output: Record<string, unknown> = {
		slug: note.slug,
		file: note.file,
		title: bounded(note.title, MAX_TITLE_CHARS),
		titleSource: note.titleSource,
		cues,
		cuesClipped: note.cuesClipped,
		cuesMultiline: note.cuesMultiline,
		cuesDuplicate: note.cuesDuplicate,
		metadata: note.metadata,
		size: note.size,
	};
	if (note.metadataIssue !== undefined) output.metadataIssue = note.metadataIssue;
	return output;
}

function matchesQuery(cue: NoteCue, query: string): boolean {
	return cue.searchText.includes(query.toLowerCase());
}

function utf8SequenceLength(lead: number): number {
	if (lead < 0x80) return 1;
	if ((lead & 0xe0) === 0xc0) return 2;
	if ((lead & 0xf0) === 0xe0) return 3;
	if ((lead & 0xf8) === 0xf0) return 4;
	return 1;
}

function trimUtf8(buffer: Buffer, truncated: boolean): Buffer {
	if (!truncated || buffer.length === 0) return buffer;
	let index = buffer.length - 1;
	while (index >= 0 && (buffer[index] & 0xc0) === 0x80) index -= 1;
	if (index < 0) return buffer;
	const end = index + utf8SequenceLength(buffer[index]) <= buffer.length ? buffer.length : index;
	return buffer.subarray(0, end);
}

function openRegular(path: string, opener: (path: string, flags: number) => number = openSync): OpenResult {
	let fd: number;
	try {
		fd = opener(path, NOTE_OPEN_FLAGS);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ELOOP") return { ok: false, reason: `refused symbolic link note: ${basename(path)}` };
		if (code === "ENOENT") return { ok: false, reason: `note not found: ${basename(path)}` };
		return { ok: false, reason: `note is not readable: ${basename(path)}` };
	}
	let info: Stats;
	try {
		info = fstatSync(fd);
	} catch {
		closeSync(fd);
		return { ok: false, reason: `note is not readable: ${basename(path)}` };
	}
	if (!info.isFile()) {
		closeSync(fd);
		return { ok: false, reason: `refused nonregular note: ${basename(path)}` };
	}
	return { ok: true, fd, size: info.size };
}

function readDescriptor(fd: number, maxBytes: number): Buffer {
	const buffer = Buffer.allocUnsafe(maxBytes);
	let total = 0;
	while (total < maxBytes) {
		const bytesRead = readSync(fd, buffer, total, maxBytes - total, total);
		if (bytesRead <= 0) break;
		total += bytesRead;
	}
	return buffer.subarray(0, total);
}

function decodeUtf8(buffer: Buffer): string | undefined {
	try {
		return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buffer);
	} catch {
		return undefined;
	}
}

function readIndexWindow(path: string): IndexWindow {
	const opened = openRegular(path);
	if (!opened.ok) return opened;
	try {
		const bytes = readDescriptor(opened.fd, INDEX_READ_BYTES);
		const text = decodeUtf8(trimUtf8(bytes, opened.size > INDEX_READ_BYTES));
		if (text === undefined) return { ok: false, reason: `note is not valid UTF-8: ${basename(path)}` };
		return { ok: true, text, truncated: opened.size > INDEX_READ_BYTES, size: opened.size };
	} finally {
		closeSync(opened.fd);
	}
}

function readNoteSource(path: string): SourceResult {
	const opened = openRegular(path);
	if (!opened.ok) return opened;
	try {
		const buffer = readDescriptor(opened.fd, SOURCE_READ_BYTES + 1);
		if (buffer.length > SOURCE_READ_BYTES) {
			return { ok: false, reason: `note exceeds the ${SOURCE_READ_BYTES}-byte source limit: ${basename(path)}` };
		}
		return { ok: true, buffer };
	} finally {
		closeSync(opened.fd);
	}
}

function requireReadme(root: string): void {
	const opened = openRegular(join(root, "README.md"));
	if (!opened.ok)
		throw new CorpusError(`Memory unavailable: README.md corpus contract is not readable (${opened.reason})`);
	closeSync(opened.fd);
}

function pushIssue(scan: Scan, code: string, message: string): void {
	scan.issueCount += 1;
	if (scan.issues.length < MAX_ISSUES) scan.issues.push({ code, message: bounded(message, MAX_ISSUE_CHARS) });
}

function considerEntry(root: string, entry: Dirent, scan: Scan): void {
	if (!/\.md$/i.test(entry.name)) return;
	if (entry.isDirectory()) {
		pushIssue(scan, "note.nonregular", `skipped directory named like a note: ${entry.name}`);
		return;
	}
	if (entry.name.toLowerCase() === "readme.md") return;
	if (entry.isSymbolicLink()) {
		pushIssue(scan, "note.symlink", `skipped symbolic link: ${entry.name}`);
		return;
	}
	const slug = addressableSlug(entry.name);
	if (slug === undefined) {
		pushIssue(scan, "note.unaddressable", `excluded filename outside the --note slug grammar: ${entry.name}`);
		return;
	}
	const window = readIndexWindow(join(root, entry.name));
	if (!window.ok) {
		pushIssue(scan, "note.unreadable", window.reason);
		return;
	}
	const cue = buildNoteCue(entry.name, slug, window.text, window.truncated, window.size);
	scan.notes.push(cue);
	if (window.size > SOURCE_READ_BYTES) {
		pushIssue(scan, "note.oversized", `${entry.name} exceeds the ${SOURCE_READ_BYTES}-byte source limit`);
	}
	if (cue.metadata !== "ok" && cue.metadata !== "absent") {
		pushIssue(
			scan,
			"note.metadata",
			`${entry.name}: ${cue.metadata} frontmatter (${cue.metadataIssue ?? "no detail"})`,
		);
	} else if (cue.cuesMultiline || cue.cuesDuplicate || cue.cuesClipped) {
		pushIssue(scan, "note.metadata", `${entry.name}: cue extraction problem (${cue.metadataIssue ?? "no detail"})`);
	}
}

function scanCorpus(root: string): Scan {
	const scan: Scan = { notes: [], issues: [], issueCount: 0, visited: 0, complete: true };
	let handle: ReturnType<typeof opendirSync>;
	try {
		handle = opendirSync(root);
	} catch {
		throw new CorpusError(`cannot read corpus root: ${root}`);
	}
	try {
		for (let entry = handle.readSync(); entry !== null; entry = handle.readSync()) {
			scan.visited += 1;
			if (scan.visited > VISIT_CAP) {
				scan.complete = false;
				pushIssue(scan, "scan.limit", `directory scan stopped at the ${VISIT_CAP}-entry cap; results are incomplete`);
				break;
			}
			if (entry.name.startsWith(".")) continue;
			considerEntry(root, entry, scan);
		}
	} finally {
		handle.closeSync();
	}
	scan.notes.sort((left, right) => (left.slug < right.slug ? -1 : left.slug > right.slug ? 1 : 0));
	return scan;
}

function codePointCount(text: string): number {
	let count = 0;
	let index = 0;
	while (index < text.length) {
		const code = text.codePointAt(index);
		index += code !== undefined && code > 0xffff ? 2 : 1;
		count += 1;
	}
	return count;
}

function utf16IndexAtCodePoint(text: string, target: number): number {
	let count = 0;
	let index = 0;
	while (index < text.length && count < target) {
		const code = text.codePointAt(index);
		index += code !== undefined && code > 0xffff ? 2 : 1;
		count += 1;
	}
	return index;
}

function sliceByCodePoints(text: string, offset: number, maxCodePoints: number): PageSlice {
	const total = codePointCount(text);
	const from = Math.min(offset, total);
	const to = Math.min(from + maxCodePoints, total);
	return {
		content: text.slice(utf16IndexAtCodePoint(text, from), utf16IndexAtCodePoint(text, to)),
		nextOffset: to,
		contentCodePoints: to - from,
		hasMore: to < total,
	};
}

function sha256(buffer: Buffer): string {
	return createHash("sha256").update(buffer).digest("hex");
}

function byteLength(value: unknown): number {
	return Buffer.byteLength(JSON.stringify(value));
}

function serializedSize(value: unknown): number {
	return byteLength(value) + 1;
}

function formatScan(scan: Scan): Record<string, unknown> {
	const shown = scan.issues.slice(0, MAX_ISSUES);
	return {
		complete: scan.complete,
		visited: scan.visited,
		visitCap: VISIT_CAP,
		issueCount: scan.issueCount,
		issuesShown: shown.length,
		issues: shown,
	};
}

function corpusEmptiness(scan: Scan): boolean | null {
	if (scan.notes.length > 0) return false;
	return scan.complete && scan.issueCount === 0 ? true : null;
}

function indexPageFields(
	notes: Record<string, unknown>[],
	index: number,
	totalMatches: number,
): Record<string, unknown> {
	const nextIndex = index + notes.length;
	const hasMore = nextIndex < totalMatches;
	return { notes, returned: notes.length, hasMore, nextIndex: hasMore ? nextIndex : null };
}

function runIndex(root: string, args: { query: string | null; index: number }): Record<string, unknown> {
	const scan = scanCorpus(root);
	const matches = args.query === null ? scan.notes : scan.notes.filter((cue) => matchesQuery(cue, args.query ?? ""));
	const totalMatches = matches.length;
	let kept = matches.slice(args.index, args.index + INDEX_PAGE_SIZE).map(toOutputNote);
	const result: Record<string, unknown> = {
		ok: true,
		kind: "index",
		root: bounded(root, MAX_ROOT_CHARS),
		query: args.query,
		index: args.index,
		pageSize: INDEX_PAGE_SIZE,
		totalNotes: scan.notes.length,
		totalMatches,
		returned: 0,
		hasMore: false,
		nextIndex: null,
		corpusEmpty: corpusEmptiness(scan),
		scan: formatScan(scan),
		notes: [],
	};
	for (;;) {
		Object.assign(result, indexPageFields(kept, args.index, totalMatches));
		if (serializedSize(result) <= MAX_STDOUT_BYTES) break;
		if (kept.length === 0) throw new CorpusError("serialized output exceeds the stdout bound");
		kept = kept.slice(0, -1);
	}
	if (kept.length === 0 && args.index < totalMatches) {
		throw new CorpusError("serialized output cannot hold one record within the stdout bound");
	}
	return result;
}

function runNote(root: string, args: { slug: string; offset: number; digest: string | null }): Record<string, unknown> {
	const file = noteFileForSlug(args.slug);
	const source = readNoteSource(join(root, file));
	if (!source.ok) throw new CorpusError(source.reason);
	const digest = sha256(source.buffer);
	if (args.digest !== null && args.digest !== digest) {
		throw new DigestError(`note source changed since the supplied digest: ${file}`);
	}
	const text = decodeUtf8(source.buffer);
	if (text === undefined) throw new CorpusError(`note is not valid UTF-8: ${file}`);
	const totalCodePoints = codePointCount(text);
	if (args.offset > totalCodePoints) throw new UsageError(`offset ${args.offset} is beyond the end of ${file}`);
	const slice = sliceByCodePoints(text, args.offset, PAGE_CODEPOINTS);
	const result: Record<string, unknown> = {
		ok: true,
		kind: "note",
		root: bounded(root, MAX_ROOT_CHARS),
		slug: args.slug,
		file,
		source: file.toLowerCase() === "readme.md" ? "contract" : "note",
		sourceBytes: source.buffer.length,
		maxSourceBytes: SOURCE_READ_BYTES,
		digest,
		offset: args.offset,
		nextOffset: slice.nextOffset,
		totalCodePoints,
		contentCodePoints: slice.contentCodePoints,
		hasMore: slice.hasMore,
		content: slice.content,
	};
	let contentCodePoints = slice.contentCodePoints;
	for (;;) {
		if (serializedSize(result) <= MAX_STDOUT_BYTES) break;
		if (contentCodePoints === 0) throw new CorpusError("serialized output exceeds the stdout bound");
		contentCodePoints = Math.max(0, contentCodePoints - 256);
		const trimmed = sliceByCodePoints(text, args.offset, contentCodePoints);
		result.content = trimmed.content;
		result.contentCodePoints = trimmed.contentCodePoints;
		result.nextOffset = trimmed.nextOffset;
		result.hasMore = trimmed.hasMore;
	}
	if (contentCodePoints === 0 && args.offset < totalCodePoints) {
		throw new CorpusError("source page cannot progress within the stdout bound");
	}
	return result;
}

function readMemoryRoot(): string {
	const raw = process.env.PI_MEMORY_DIR;
	if (raw === undefined || raw.trim() === "") {
		throw new CorpusError("Memory unavailable: set PI_MEMORY_DIR to an absolute corpus path");
	}
	if (!isAbsolute(raw)) throw new CorpusError("Memory unavailable: PI_MEMORY_DIR must be an absolute path");
	let info: Stats;
	try {
		info = statSync(raw);
	} catch {
		throw new CorpusError(`Memory unavailable: PI_MEMORY_DIR does not exist: ${raw}`);
	}
	if (!info.isDirectory()) throw new CorpusError(`Memory unavailable: PI_MEMORY_DIR is not a directory: ${raw}`);
	const root = resolve(raw);
	if (root.length > MAX_ROOT_CHARS) {
		throw new CorpusError(`Memory unavailable: corpus path exceeds ${MAX_ROOT_CHARS} characters`);
	}
	return root;
}

function isDirectRun(): boolean {
	const entry = process.argv[1];
	if (entry === undefined) return false;
	try {
		return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
	} catch {
		return false;
	}
}

function main(): void {
	try {
		const args = parseArgs(process.argv.slice(2));
		if (args.kind === "help") {
			process.stdout.write(helpText());
			return;
		}
		const root = readMemoryRoot();
		requireReadme(root);
		const result = args.kind === "index" ? runIndex(root, args) : runNote(root, args);
		const payload = `${JSON.stringify(result)}\n`;
		if (Buffer.byteLength(payload) > MAX_STDOUT_BYTES) {
			throw new CorpusError("serialized output exceeds the stdout bound");
		}
		process.stdout.write(payload);
	} catch (error) {
		const exitCode = error instanceof LookupError ? error.exitCode : 70;
		const message = error instanceof Error ? error.message : String(error);
		process.stderr.write(`Error: ${bounded(message, MAX_ERROR_CHARS)}\n`);
		process.exitCode = exitCode;
	}
}

export {
	NOTE_OPEN_FLAGS,
	addressableSlug,
	extractCue,
	openRegular,
	parseArgs,
	readMemoryRoot,
	scanCorpus,
	sliceByCodePoints,
	trimUtf8,
};

if (isDirectRun()) main();
