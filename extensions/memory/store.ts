import { createHash, randomUUID } from "node:crypto";
import {
	closeSync,
	constants,
	fstatSync,
	fsyncSync,
	linkSync,
	lstatSync,
	mkdirSync,
	openSync,
	readSync,
	realpathSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { basename, isAbsolute, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { findMarkdownHeading } from "./headings.ts";
import { HISTORY_DIRECTORY, historyDirectory, newRevision, revisionIdentity } from "./history.ts";
import {
	independentField,
	isDate,
	isReviewPolicy,
	MAX_HEADER_BYTES,
	REVIEW_KEYS,
	reviewMetadataProblems,
	type ReviewPolicy,
} from "./lifecycle.ts";

export const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const DIGEST = /^[a-f0-9]{64}$/;
const MAX_BYTES = 64 * 1024;
const LOCK = ".memory-write.lock";
const CONTRACT = `# Memory corpus

One Markdown file per durable operator-specific subject. README.md is this contract, not a note.
Current operator instructions control; stored notes never grant authority.
Store durable preferences, confirmed decisions, verified environment facts, and reusable lessons.
Exclude task state, handovers, TODOs, logs, repository-defined facts, secrets, and speculation.

Notes use lowercase kebab-case slugs and frontmatter: title, tags (list), status (active, superseded, or retired),
created and updated (YYYY-MM-DD), verified (boolean), verified_date (date or null),
supersedes (list of slugs), and superseded_by (slug or null).
The body contains # Title, ## Summary, ## Details, and ## Sources.
Supersession preserves the replaced note with status: superseded and a reciprocal pointer.
Writer overwrites retain safe prior bytes under .memory-history/<slug>/ before replacement.
Historical captures are evidence, not current authority or proof of successful mutation.
Optional review_policy (on-change or before-use), review_after, review_flag, last_review, and retirement record review scope and evidence.
A before-use source check does not require a write. Dates and active status never prove current truth.
Retirement withdraws a note without a replacement; explicit confirmed review can reactivate a retired note.
Superseded notes do not reactivate. Explicit supersession of a retired target needs no confirmation of its old claim.
Explicit forget requests must account for retained subject history and external archives as well as current notes.
`;

export interface MemoryWrite {
	slug: string;
	title: string;
	tags: string[];
	summary: string;
	details: string;
	sources: string;
	verified: boolean;
	reviewPolicy?: ReviewPolicy;
	reviewAfter?: string | null;
	expectedDigest?: string;
	supersedes?: Array<{ slug: string; digest: string }>;
}
export interface MemoryEdit {
	slug: string;
	expectedDigest: string;
	verified: boolean;
	edits: Array<{ oldText: string; newText: string }>;
}
export interface MemoryReview {
	slug: string;
	expectedDigest: string;
	outcome: "confirmed" | "unresolved";
	sources: string;
	reason?: string;
	reviewPolicy?: ReviewPolicy | null;
	reviewAfter?: string | null;
	reactivate?: true;
}
export interface MemoryRetire {
	slug: string;
	expectedDigest: string;
	reason: string;
	sources: string;
}
export interface WriteReceipt {
	ok: boolean;
	slug: string;
	file: string;
	digest?: string;
	written: string[];
	notWritten: string[];
	captured: Array<{ slug: string; revision: string; capturedAt: string; digest: string; bytes: number }>;
	historyOmitted: Array<{ file: string; reason: "credential-policy" }>;
	initialized: boolean;
	error?: string;
}

export class MemoryWriteError extends Error {
	readonly receipt: WriteReceipt;
	constructor(receipt: WriteReceipt) {
		super(`Memory write incomplete: ${JSON.stringify(receipt)}`);
		this.receipt = receipt;
		this.name = "MemoryWriteError";
	}
}

export function memoryRoot(value: string | undefined): string {
	if (!value || !isAbsolute(value) || value.length > 1024 || /[\p{Cc}\p{Cf}]/u.test(value)) {
		throw new Error("Memory unavailable: configure memory.dir or PI_MEMORY_DIR with an absolute corpus path");
	}
	return value;
}
export function sourceDigest(text: string | Buffer): string {
	return createHash("sha256").update(text).digest("hex");
}
function checkAbort(signal?: AbortSignal): void {
	if (signal?.aborted) throw new Error("Memory write cancelled");
}
function errorCode(error: unknown): string {
	return error && typeof error === "object" && "code" in error && typeof error.code === "string"
		? error.code
		: "IO_ERROR";
}
function slug(value: unknown): asserts value is string {
	if (typeof value !== "string" || value.length > 120 || !SLUG.test(value) || value === "readme")
		throw new Error("Use a lowercase kebab-case subject slug, other than readme");
}
function digest(value: unknown): asserts value is string {
	if (typeof value !== "string" || !DIGEST.test(value))
		throw new Error("An expected SHA-256 source digest is required");
}
function unsafeText(value: string): boolean {
	return /[\uD800-\uDFFF]/u.test(value) || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value);
}
function text(value: unknown, name: string, max: number, multiline = true): asserts value is string {
	if (
		typeof value !== "string" ||
		!value.trim() ||
		value.length > max ||
		unsafeText(value) ||
		(!multiline && /[\r\n\u2028\u2029]/u.test(value))
	)
		throw new Error(
			`Invalid ${name}: use nonblank ${multiline ? "text" : "single-line text"} within ${max} characters, without disallowed controls or unpaired surrogates`,
		);
}
function validateReviewSelection(input: { reviewPolicy?: unknown; reviewAfter?: unknown }, clear: boolean): void {
	if (
		input.reviewPolicy !== undefined &&
		!(clear && input.reviewPolicy === null) &&
		!isReviewPolicy(input.reviewPolicy)
	)
		throw new Error("reviewPolicy must be on-change or before-use; only review permits null to clear it");
	if (input.reviewAfter !== undefined && input.reviewAfter !== null && !isDate(input.reviewAfter))
		throw new Error("reviewAfter must be a real YYYY-MM-DD date or null");
}
function validate(input: MemoryWrite): void {
	slug(input.slug);
	text(input.title, "title", 160, false);
	text(input.summary, "summary", 4000);
	text(input.details, "details", 24000);
	text(input.sources, "sources", 8000);
	if (!Array.isArray(input.tags) || input.tags.length > 16) throw new Error("Use at most 16 subject tags");
	for (const tag of input.tags) text(tag, "tag", 80, false);
	if (new Set(input.tags).size !== input.tags.length) throw new Error("Tags must be unique");
	if (typeof input.verified !== "boolean") throw new Error("verified must be explicit");
	if (input.expectedDigest !== undefined) digest(input.expectedDigest);
	validateReviewSelection(input, false);
	if (input.supersedes !== undefined && (!Array.isArray(input.supersedes) || input.supersedes.length > 16))
		throw new Error("Use at most 16 supersession targets");
	const seen = new Set<string>();
	for (const [index, target] of (input.supersedes ?? []).entries()) {
		slug(target.slug);
		checkCredentials(target.slug, `supersedes[${index}].slug`);
		digest(target.digest);
		if (target.slug === input.slug || seen.has(target.slug))
			throw new Error("Supersession targets must be unique and different from the destination");
		seen.add(target.slug);
	}
	for (const field of ["slug", "title", "summary", "details", "sources"] as const)
		checkCredentials(input[field], field);
	input.tags.forEach((tag, index) => {
		checkCredentials(tag, `tags[${index}]`);
	});
}

/** Recognizable formats only: assignment syntax and entropy do not distinguish technical examples from secrets. */
function checkCredentials(payload: string, location = "resulting note"): void {
	const family = credentialFamily(payload);
	if (family)
		throw new Error(
			`Credential-like material refused in ${location} (${family}); use a descriptive placeholder instead of a credential value. No note content was written`,
		);
}

function credentialFamily(payload: string): string | undefined {
	return /-----BEGIN [A-Z ]*PRIVATE KEY-----/i.test(payload)
		? "private-key marker"
		: /\b(?:sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[A-Z0-9]{16})\b/i.test(
					payload,
				)
			? "recognized token prefix"
			: undefined;
}

/** Open the inode itself, not a link target, and bound the read before allocation. */
function readSource(path: string): string {
	const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	try {
		const before = fstatSync(fd);
		if (!before.isFile() || before.nlink !== 1 || before.size > MAX_BYTES)
			throw new Error("Mutation requires a regular, unlinked source within 64 KiB");
		const buffer = Buffer.alloc(before.size + 1);
		let used = 0;
		while (used < buffer.length) {
			const n = readSync(fd, buffer, used, buffer.length - used, null);
			if (n === 0) break;
			used += n;
		}
		const after = fstatSync(fd);
		if (used !== before.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs)
			throw new Error("Source changed during read");
		return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buffer.subarray(0, used));
	} finally {
		closeSync(fd);
	}
}
function exists(path: string): boolean {
	try {
		lstatSync(path);
		return true;
	} catch (error) {
		if (errorCode(error) === "ENOENT") return false;
		throw error;
	}
}
interface Existing {
	text: string;
	meta: Record<string, unknown>;
	end: number;
}
function existing(path: string, expected?: string): Existing {
	const source = readSource(path);
	if (expected !== undefined && sourceDigest(source) !== expected)
		throw new Error("Source digest changed; read the current note before retry");
	const match = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(source);
	if (!match)
		throw new Error(
			"Mutation requires valid frontmatter with exact --- delimiter lines; repair the source explicitly first",
		);
	let meta: Record<string, unknown>;
	try {
		const parsed = parseFrontmatter<Record<string, unknown>>(match[0]);
		if (parsed.body !== "") throw new Error("Ambiguous header boundary");
		meta = parsed.frontmatter;
	} catch {
		throw new Error(
			"Mutation requires unambiguous frontmatter with exact --- delimiter lines; repair the source explicitly first",
		);
	}
	if (!meta || typeof meta !== "object" || Array.isArray(meta))
		throw new Error("Mutation requires a frontmatter mapping; source remains readable");
	validateLifecycle(meta, basename(path, ".md"));
	const problems = reviewMetadataProblems(meta);
	if (problems.length)
		throw new Error(`Mutation requires valid review metadata: ${problems.join("; ")}; source remains readable`);
	for (const key of REVIEW_KEYS) independentField(match[0], key, meta);
	return { text: source, meta, end: match[0].length };
}
function validateLifecycle(meta: Record<string, unknown>, subject: string): void {
	const isSubject = (value: unknown): value is string =>
		typeof value === "string" && value.length <= 120 && SLUG.test(value) && value !== "readme";
	if (!isDate(meta.created) || !isDate(meta.updated))
		throw new Error(
			"Mutation requires valid lifecycle dates: created and updated must be YYYY-MM-DD; source remains readable",
		);
	if (
		!Array.isArray(meta.supersedes) ||
		meta.supersedes.length > 16 ||
		new Set(meta.supersedes).size !== meta.supersedes.length ||
		meta.supersedes.some((value) => !isSubject(value) || value === subject)
	)
		throw new Error(
			"Mutation requires valid lifecycle links: supersedes must be a list of at most 16 unique subject slugs, without self-links; source remains readable",
		);
	if (
		!(meta.status === "active" || meta.status === "superseded" || meta.status === "retired") ||
		(meta.status === "superseded"
			? !isSubject(meta.superseded_by) || meta.superseded_by === subject
			: meta.superseded_by !== null)
	)
		throw new Error(
			"Mutation requires valid lifecycle status: active or retired requires superseded_by: null; superseded requires a different subject slug. Source remains readable",
		);
}
/** Partial publication can leave active historical nodes; inspect transitive links before adding an edge. */
function checkCycles(root: string, destination: string, targets: string[], signal?: AbortSignal): void {
	const pending = [...targets];
	const seen = new Set<string>();
	let bytes = 0;
	while (pending.length) {
		checkAbort(signal);
		const current = pending.pop() as string;
		if (current === destination) throw new Error("Supersession would form a cycle");
		if (seen.has(current)) continue;
		if (seen.size >= 512) throw new Error("Supersession graph exceeds the 512-note safety bound");
		seen.add(current);
		const source = existing(join(root, `${current}.md`));
		bytes += Buffer.byteLength(source.text);
		if (bytes > 8 * 1024 * 1024) throw new Error("Supersession graph exceeds the 8 MiB safety bound");
		pending.push(...(source.meta.supersedes as string[]));
	}
}
function serialize(input: MemoryWrite, created: string, today: string, supersedes: string[], prior?: Existing): string {
	const fields = {
		title: input.title.trim(),
		tags: input.tags,
		status: "active",
		created,
		updated: today,
		verified: input.verified,
		verified_date: input.verified ? today : null,
		supersedes,
		superseded_by: null,
		...(input.reviewPolicy !== undefined ? { review_policy: input.reviewPolicy } : {}),
		...(input.reviewAfter !== undefined ? { review_after: input.reviewAfter } : {}),
		...(!input.verified && prior?.meta.review_flag ? { review_flag: prior.meta.review_flag } : {}),
	};
	const problems = reviewMetadataProblems(fields);
	if (problems.length) throw new Error(problems.join("; "));
	const header = Object.entries(fields)
		.map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
		.join("\n");
	if (Buffer.byteLength(`---\n${header}\n---\n`) > MAX_HEADER_BYTES) throw new Error("Generated header exceeds 8 KiB");
	const result = `---\n${header}\n---\n\n# ${input.title.trim()}\n\n## Summary\n\n${input.summary.trim()}\n\n## Details\n\n${input.details.trim()}\n\n## Sources\n\n${input.sources.trim()}\n`;
	if (Buffer.byteLength(result) > MAX_BYTES) throw new Error("Note exceeds the 64 KiB source limit");
	return result;
}
/** Only lifecycle lines change; introductory text, fences, and the complete body survive. */
function superseded(source: Existing, replacement: string, today: string): string {
	const header = changedHeader(source, {
		status: "superseded",
		updated: today,
		superseded_by: replacement,
		...(source.meta.status === "retired" ? { retirement: undefined } : {}),
	});
	const result = header + source.text.slice(source.end);
	if (Buffer.byteLength(result) > MAX_BYTES) throw new Error("Superseded source exceeds 64 KiB");
	return result;
}
function stage(root: string, content: string): string {
	const file = `.memory-${randomUUID()}.tmp`;
	const path = join(root, file);
	let fd: number | undefined;
	const failures: string[] = [];
	try {
		fd = openSync(path, "wx", 0o600);
		writeFileSync(fd, content);
		fsyncSync(fd);
	} catch (error) {
		failures.push(`Temporary file staging failed (${errorCode(error)})`);
	}
	if (fd !== undefined) {
		try {
			closeSync(fd);
		} catch (error) {
			failures.push(`Temporary file close failed (${errorCode(error)})`);
		}
		if (failures.length) {
			const error = removeFile(path);
			if (error)
				failures.push(
					`Temporary file cleanup failed (${error}); retained artifact: ${file}. Confirm no writer remains before manual removal`,
				);
		}
	}
	if (failures.length) throw new Error(`${failures.join("; ")}; no notes were written`);
	return path;
}

/** Publish complete lock metadata in one link operation, never a half-written lock. */
function acquire(root: string): () => void {
	const lock = join(root, LOCK);
	const candidate = stage(root, JSON.stringify({ pid: process.pid, started: new Date().toISOString() }));
	let acquired = false;
	try {
		linkSync(candidate, lock);
		acquired = true;
		unlinkSync(candidate);
		return () => unlinkSync(lock);
	} catch (error) {
		const retained: string[] = [];
		if (acquired && removeFile(lock)) retained.push(LOCK);
		if (removeFile(candidate)) retained.push(candidate.slice(root.length + 1));
		const reason =
			!acquired && errorCode(error) === "EEXIST"
				? "Memory writer lock exists (.memory-write.lock)."
				: `Memory lock acquisition failed (${errorCode(error)}); no notes were written.`;
		throw new Error(
			`${reason} Inspect its owner and confirm no writer remains before manual removal; never remove a live lock.${retained.length ? ` Retained artifacts: ${retained.join(", ")}` : ""}`,
		);
	}
}

function removeFile(path: string): string | undefined {
	try {
		unlinkSync(path);
	} catch (error) {
		if (errorCode(error) !== "ENOENT") return errorCode(error);
	}
	return undefined;
}

interface Publication {
	file: string;
	content: string;
	expected?: string;
	prior?: string;
}
function targetPlans(root: string, input: MemoryWrite, today: string, signal?: AbortSignal): Publication[] {
	return (input.supersedes ?? []).map((target) => {
		checkAbort(signal);
		const file = `${target.slug}.md`;
		const source = existing(join(root, file), target.digest);
		if (source.meta.status === "superseded" && source.meta.superseded_by !== input.slug)
			throw new Error("A supersession target already names another replacement");
		return { file, content: superseded(source, input.slug, today), expected: target.digest, prior: source.text };
	});
}
function destinationSource(destination: string, input: { expectedDigest?: string }): Existing | undefined {
	const present = exists(destination);
	if (present && input.expectedDigest === undefined)
		throw new Error("Duplicate slug refused; read the note and supply expectedDigest to update");
	if (!present && input.expectedDigest !== undefined) throw new Error("Update target does not exist");
	const prior = present ? existing(destination, input.expectedDigest) : undefined;
	if (prior && (prior.meta.status !== "active" || prior.meta.superseded_by !== null))
		throw new Error(`A ${prior.meta.status} note cannot be updated; inspect its retirement or replacement`);
	return prior;
}
function planWrites(root: string, input: MemoryWrite, signal?: AbortSignal): Publication[] {
	checkAbort(signal);
	const today = new Date().toISOString().slice(0, 10);
	const file = `${input.slug}.md`;
	const prior = destinationSource(join(root, file), input);
	const links = new Set<string>((prior?.meta.supersedes as string[] | undefined) ?? []);
	for (const target of input.supersedes ?? []) links.add(target.slug);
	if (links.size > 16) throw new Error("A note supports at most 16 supersession links");
	const targets = targetPlans(root, input, today, signal);
	if (targets.length) checkCycles(root, input.slug, [...links], signal);
	const content = serialize(input, (prior?.meta.created as string | undefined) ?? today, today, [...links], prior);
	const contractPath = join(root, "README.md");
	const contractExists = exists(contractPath);
	if (contractExists) readSource(contractPath);
	return [
		...(contractExists ? [] : [{ file: "README.md", content: CONTRACT }]),
		{ file, content, expected: input.expectedDigest, prior: prior?.text },
		...targets,
	];
}
function validateEdit(input: MemoryEdit): void {
	slug(input.slug);
	checkCredentials(input.slug, "slug");
	digest(input.expectedDigest);
	if (typeof input.verified !== "boolean") throw new Error("verified must be explicit for the whole edited note");
	if (!Array.isArray(input.edits) || input.edits.length < 1 || input.edits.length > 32)
		throw new Error("Use between 1 and 32 edits");
	for (const [index, edit] of input.edits.entries()) {
		if (!edit || typeof edit !== "object") throw new Error("Invalid edit");
		for (const key of ["oldText", "newText"] as const) {
			const value = edit[key];
			if (
				typeof value !== "string" ||
				value.length > 24000 ||
				(key === "oldText" && value.length === 0) ||
				unsafeText(value)
			)
				throw new Error(`Invalid edits[].${key}`);
		}
		checkCredentials(edit.newText, `edits[${index}].newText`);
	}
}

function editedBody(source: Existing, edits: MemoryEdit["edits"]): string {
	const body = source.text.slice(source.end);
	const heading = findMarkdownHeading(body, 1);
	if (
		!heading ||
		(heading.title !== source.meta.title && heading.text.replace(/[\r\n]+$/, "") !== `# ${source.meta.title}`)
	)
		throw new Error(
			"Editing requires a title heading that matches frontmatter: the first unfenced # heading must match title. Preserve that heading; use memory_write only for an intentional complete rewrite",
		);
	const matches = edits
		.map((edit, index) => {
			const start = body.indexOf(edit.oldText);
			if (start < 0) throw new Error(`edits[${index}].oldText does not match the original body`);
			if (body.indexOf(edit.oldText, start + 1) !== -1)
				throw new Error(`edits[${index}].oldText is ambiguous in the original body`);
			const end = start + edit.oldText.length;
			if (start < heading.end && end > heading.start) throw new Error("The title heading cannot be edited");
			return { start, end, newText: edit.newText };
		})
		.sort((a, b) => a.start - b.start);
	let cursor = 0;
	let result = "";
	for (const match of matches) {
		if (match.start < cursor) throw new Error("Edits overlap; merge them into one replacement");
		result += body.slice(cursor, match.start) + match.newText;
		cursor = match.end;
	}
	result += body.slice(cursor);
	if (result === body) throw new Error("Edits produce no body change");
	const expectedStart = matches
		.filter((match) => match.end <= heading.start)
		.reduce((start, match) => start + match.newText.length - (match.end - match.start), heading.start);
	const resultingHeading = findMarkdownHeading(result, 1);
	if (resultingHeading?.text !== heading.text || resultingHeading.start !== expectedStart)
		throw new Error("The title heading cannot be changed or preceded by another title");
	return result;
}

function replaceHeaderFields(source: Existing, fields: Record<string, unknown>) {
	const original = source.text.slice(0, source.end);
	const expected = { ...source.meta };
	const changes: Array<{ start: number; end: number; text: string }> = [];
	const close = /(\r?\n)---(\r?\n|$)$/.exec(original);
	if (!close) throw new Error("Ambiguous header boundary");
	const newline = close[2] || close[1];
	const insertAt = close.index + close[1].length;
	let additions = "";
	for (const [key, value] of Object.entries(fields)) {
		const optional = REVIEW_KEYS.some((candidate) => candidate === key);
		const span = independentField(original, key, source.meta);
		if (!optional && (!span || value === undefined)) throw new Error("Required generated field missing");
		if (value === undefined) delete expected[key];
		else expected[key] = value;
		const replacement = value === undefined ? "" : `${key}: ${JSON.stringify(value)}${span?.newline ?? newline}`;
		if (span) changes.push({ start: span.start, end: span.end, text: replacement });
		else additions += replacement;
	}
	changes.push({ start: insertAt, end: insertAt, text: additions });
	let header = original;
	for (const change of changes.sort((a, b) => b.start - a.start))
		header = header.slice(0, change.start) + change.text + header.slice(change.end);
	return { header, expected };
}

/** Replace owned lines in place; only optional review keys permit insertion or removal. */
function changedHeader(source: Existing, fields: Record<string, unknown>): string {
	try {
		const { header, expected } = replaceHeaderFields(source, fields);
		let parsed: ReturnType<typeof parseFrontmatter<Record<string, unknown>>>;
		try {
			parsed = parseFrontmatter<Record<string, unknown>>(header);
		} catch {
			throw new Error("Generated metadata is ambiguous");
		}
		if (parsed.body !== "" || !isDeepStrictEqual(parsed.frontmatter, expected))
			throw new Error("Metadata changed outside generated fields");
		const problems = reviewMetadataProblems(expected);
		if (problems.length) throw new Error(problems.join("; "));
		if (Buffer.byteLength(header) > MAX_HEADER_BYTES) throw new Error("Changed header exceeds 8 KiB");
		return header;
	} catch (error) {
		throw new Error(
			`Generated fields (${Object.keys(fields).join(", ")}) require independent plain top-level keys; other metadata must remain unchanged. ${error instanceof Error ? error.message : "Invalid metadata"}`,
		);
	}
}

function planEdit(root: string, input: MemoryEdit, signal?: AbortSignal): Publication[] {
	checkAbort(signal);
	const file = `${input.slug}.md`;
	const source = destinationSource(join(root, file), input) as Existing;
	const today = new Date().toISOString().slice(0, 10);
	const content =
		changedHeader(source, {
			updated: today,
			verified: input.verified,
			verified_date: input.verified ? today : null,
			...(input.verified ? { review_flag: undefined } : {}),
		}) + editedBody(source, input.edits);
	if (Buffer.byteLength(content) > MAX_BYTES) throw new Error("Note exceeds the 64 KiB source limit");
	return [{ file, content, expected: input.expectedDigest, prior: source.text }];
}

export function editMemory(
	rootValue: string,
	input: MemoryEdit,
	signal?: AbortSignal,
	hooks: WriteHooks = {},
): WriteReceipt {
	memoryRoot(rootValue);
	validateEdit(input);
	return mutate(rootValue, input.slug, (root) => planEdit(root, input, signal), signal, hooks);
}

function validateReviewIdentity(input: MemoryRetire | MemoryReview): void {
	slug(input.slug);
	digest(input.expectedDigest);
	text(input.sources, "sources", 1500);
	checkCredentials(input.slug, "slug");
	checkCredentials(input.sources, "sources");
	if (input.reason !== undefined) {
		text(input.reason, "reason", 600);
		checkCredentials(input.reason, "reason");
	}
}

function planMetadata(
	root: string,
	input: { slug: string; expectedDigest: string },
	fields: (source: Existing, today: string) => Record<string, unknown>,
	signal?: AbortSignal,
): Publication[] {
	checkAbort(signal);
	const file = `${input.slug}.md`;
	const path = join(root, file);
	if (!exists(path)) throw new Error("Update target does not exist");
	const source = existing(path, input.expectedDigest);
	const today = new Date().toISOString().slice(0, 10);
	const header = changedHeader(source, { updated: today, ...fields(source, today) });
	const content = header + source.text.slice(source.end);
	if (Buffer.byteLength(content) > MAX_BYTES) throw new Error("Note exceeds the 64 KiB source limit");
	return [{ file, content, expected: input.expectedDigest, prior: source.text }];
}

function reviewFields(source: Existing, input: MemoryReview, today: string): Record<string, unknown> {
	if (source.meta.status === "superseded")
		throw new Error("A superseded note cannot be reviewed; inspect its replacement");
	if (source.meta.status === "retired" && input.reactivate !== true)
		throw new Error("A retired note requires explicit confirmed reactivation");
	if (source.meta.status !== "retired" && input.reactivate === true)
		throw new Error("Reactivation applies only to a retired note");
	const fields: Record<string, unknown> = {};
	if (input.reviewPolicy !== undefined) fields.review_policy = input.reviewPolicy ?? undefined;
	if (input.reviewAfter !== undefined) fields.review_after = input.reviewAfter ?? undefined;
	if (input.outcome === "confirmed")
		Object.assign(fields, {
			verified: true,
			verified_date: today,
			last_review: { date: today, digest: input.expectedDigest, sources: input.sources },
			review_flag: undefined,
		});
	else fields.review_flag = { date: today, reason: input.reason, sources: input.sources };
	if (input.reactivate === true)
		Object.assign(fields, { status: "active", superseded_by: null, retirement: undefined });
	return fields;
}

export function reviewMemory(
	rootValue: string,
	input: MemoryReview,
	signal?: AbortSignal,
	hooks: WriteHooks = {},
): WriteReceipt {
	memoryRoot(rootValue);
	validateReviewIdentity(input);
	validateReviewSelection(input, true);
	if (input.outcome !== "confirmed" && input.outcome !== "unresolved") throw new Error("Invalid review outcome");
	if (input.outcome === "unresolved") text(input.reason, "reason", 600);
	else if (input.reason !== undefined) throw new Error("reason applies only to an unresolved review");
	if (input.reactivate !== undefined && (input.reactivate !== true || input.outcome !== "confirmed"))
		throw new Error("Reactivation requires an explicit confirmed review");
	return mutate(
		rootValue,
		input.slug,
		(root) => planMetadata(root, input, (source, today) => reviewFields(source, input, today), signal),
		signal,
		hooks,
	);
}

export function retireMemory(
	rootValue: string,
	input: MemoryRetire,
	signal?: AbortSignal,
	hooks: WriteHooks = {},
): WriteReceipt {
	memoryRoot(rootValue);
	validateReviewIdentity(input);
	text(input.reason, "reason", 600);
	return mutate(
		rootValue,
		input.slug,
		(root) =>
			planMetadata(
				root,
				input,
				(source, today) => {
					if (source.meta.status !== "active") throw new Error("Only an active note accepts retirement");
					return {
						status: "retired",
						superseded_by: null,
						retirement: { date: today, reason: input.reason, sources: input.sources },
					};
				},
				signal,
			),
		signal,
		hooks,
	);
}

function publish(root: string, plan: Publication & { temp: string }): void {
	const path = join(root, plan.file);
	if (plan.expected === undefined) {
		linkSync(plan.temp, path);
		return;
	}
	if (sourceDigest(readSource(path)) !== plan.expected)
		throw new Error(`Source changed before publication: ${plan.file}`);
	renameSync(plan.temp, path);
}
function recordFailure(receipt: WriteReceipt, message: string): void {
	receipt.ok = false;
	receipt.error = receipt.error ? `${receipt.error}; ${message}` : message;
}
function cleanup(staged: string[], release: () => void, receipt: WriteReceipt): void {
	for (const path of staged) {
		const error = removeFile(path);
		if (error)
			recordFailure(
				receipt,
				`Temporary file cleanup failed (${error}); retained artifact: ${basename(path)}. Confirm no writer remains before manual removal`,
			);
	}
	try {
		release();
	} catch (error) {
		recordFailure(receipt, `Writer lock cleanup failed (${errorCode(error)}); inspect .memory-write.lock before retry`);
	}
}

export interface WriteHooks {
	/** Test boundaries immediately before archive and live publication. */
	beforeCapture?: (file: string) => void;
	beforePublish?: (file: string) => void;
}

export function writeMemory(
	rootValue: string,
	input: MemoryWrite,
	signal?: AbortSignal,
	hooks: WriteHooks = {},
): WriteReceipt {
	memoryRoot(rootValue);
	validate(input);
	checkAbort(signal);
	try {
		mkdirSync(rootValue, { recursive: true, mode: 0o700 });
	} catch (error) {
		throw new Error(`Memory unavailable: corpus directory cannot be created (${errorCode(error)})`);
	}
	return mutate(rootValue, input.slug, (root) => planWrites(root, input, signal), signal, hooks);
}

function validatePublications(plans: Publication[], destination: string): void {
	for (const publication of plans) {
		if (publication.file === "README.md") continue;
		if (unsafeText(publication.content))
			throw new Error("Resulting note contains disallowed control characters or unpaired surrogates");
		checkCredentials(publication.content, publication.file === destination ? "resulting note" : "supersession target");
	}
}

/** Publish every safe prior copy before any live file changes. Captures survive failed mutations. */
function capturePriors(
	root: string,
	plans: Publication[],
	receipt: WriteReceipt,
	staged: string[],
	signal: AbortSignal | undefined,
	hooks: WriteHooks,
): void {
	for (const plan of plans) {
		checkAbort(signal);
		if (plan.prior === undefined) continue;
		if (credentialFamily(plan.prior)) {
			receipt.historyOmitted.push({ file: plan.file, reason: "credential-policy" });
			continue;
		}
		hooks.beforeCapture?.(plan.file);
		checkAbort(signal);
		if (sourceDigest(readSource(join(root, plan.file))) !== plan.expected)
			throw new Error(`Source changed before history capture: ${plan.file}`);
		const subject = basename(plan.file, ".md");
		const directory = historyDirectory(root, subject, true) as string;
		const digest = sourceDigest(plan.prior);
		const revision = newRevision(digest);
		const temp = stage(directory, plan.prior);
		staged.push(temp);
		linkSync(temp, join(directory, `${revision}.md`));
		receipt.captured.push({
			slug: subject,
			revision,
			capturedAt: revisionIdentity(revision).capturedAt,
			digest,
			bytes: Buffer.byteLength(plan.prior),
		});
		unlinkSync(temp);
		// Sync the directory entry before live publication; filesystem power-loss guarantees remain external.
		for (const path of [directory, join(root, HISTORY_DIRECTORY), root]) {
			const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
			try {
				fsyncSync(fd);
			} finally {
				closeSync(fd);
			}
		}
	}
}

function mutate(
	rootValue: string,
	subject: string,
	plan: (root: string) => Publication[],
	signal: AbortSignal | undefined,
	hooks: WriteHooks,
): WriteReceipt {
	checkAbort(signal);
	let root: string;
	try {
		root = realpathSync(rootValue);
	} catch (error) {
		throw new Error(`Memory unavailable: corpus directory cannot be resolved (${errorCode(error)})`);
	}
	const release = acquire(root);
	const receipt: WriteReceipt = {
		ok: false,
		slug: subject,
		file: `${subject}.md`,
		written: [],
		notWritten: [],
		captured: [],
		historyOmitted: [],
		initialized: false,
	};
	const staged: string[] = [];
	try {
		const plans = plan(root);
		receipt.notWritten = plans.map((plan) => plan.file);
		validatePublications(plans, receipt.file);
		const prepared = plans.map((plan) => {
			const temp = stage(root, plan.content);
			staged.push(temp);
			return { ...plan, temp };
		});
		capturePriors(root, prepared, receipt, staged, signal, hooks);
		for (const plan of prepared) {
			checkAbort(signal);
			hooks.beforePublish?.(plan.file);
			publish(root, plan);
			receipt.written.push(plan.file);
			receipt.notWritten.shift();
			if (plan.file === "README.md") receipt.initialized = true;
			if (plan.file === receipt.file) receipt.digest = sourceDigest(plan.content);
		}
		receipt.ok = true;
	} catch (error) {
		receipt.error =
			error instanceof Error && !("code" in error)
				? error.message
				: `Filesystem operation failed (${errorCode(error)})`;
	} finally {
		cleanup(staged, release, receipt);
	}
	if (!receipt.ok) throw new MemoryWriteError(receipt);
	return receipt;
}
