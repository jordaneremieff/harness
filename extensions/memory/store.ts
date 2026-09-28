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
import { isAbsolute, join } from "node:path";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";

export const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const DIGEST = /^[a-f0-9]{64}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_BYTES = 64 * 1024;
const LOCK = ".memory-write.lock";
const CONTRACT = `# Memory corpus

One Markdown file per durable operator-specific subject. README.md is this contract, not a note.
Current operator instructions control; stored notes never grant authority.
Store durable preferences, confirmed decisions, verified environment facts, and reusable lessons.
Exclude task state, handovers, TODOs, logs, repository-defined facts, secrets, and speculation.

Notes use lowercase kebab-case slugs and frontmatter: title, tags (list), status (active or superseded),
created and updated (YYYY-MM-DD), verified (boolean), verified_date (date or null),
supersedes (list of slugs), and superseded_by (slug or null).
The body contains # Title, ## Summary, ## Details, and ## Sources.
Supersession preserves the replaced note with status: superseded and a reciprocal pointer.
`;

export interface MemoryWrite {
	slug: string;
	title: string;
	tags: string[];
	summary: string;
	details: string;
	sources: string;
	verified: boolean;
	expectedDigest?: string;
	supersedes?: Array<{ slug: string; digest: string }>;
}
export interface WriteReceipt {
	ok: boolean;
	slug: string;
	file: string;
	digest?: string;
	written: string[];
	notWritten: string[];
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

export function memoryRoot(value = process.env.PI_MEMORY_DIR): string {
	if (!value || !isAbsolute(value) || value.length > 1024 || /[\p{Cc}\p{Cf}]/u.test(value)) {
		throw new Error("Memory unavailable: set PI_MEMORY_DIR to an absolute corpus path");
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
function text(value: unknown, name: string, max: number, multiline = true): asserts value is string {
	if (
		typeof value !== "string" ||
		!value.trim() ||
		value.length > max ||
		/[\uD800-\uDFFF]/u.test(value) ||
		/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value) ||
		(!multiline && /[\r\n]/u.test(value))
	)
		throw new Error(`Invalid ${name}`);
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
	if (input.supersedes !== undefined && (!Array.isArray(input.supersedes) || input.supersedes.length > 16))
		throw new Error("Use at most 16 supersession targets");
	const seen = new Set<string>();
	for (const target of input.supersedes ?? []) {
		slug(target.slug);
		digest(target.digest);
		if (target.slug === input.slug || seen.has(target.slug))
			throw new Error("Supersession targets must be unique and different from the destination");
		seen.add(target.slug);
	}
	// A conservative refusal catches recognizable credential forms without echoing them.
	const payload = JSON.stringify(input);
	if (
		/-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[A-Z0-9]{16})\b|\b(?:api[_ -]?key|access[_ -]?token|password|secret)\s*[=:]\s*["']?[^\s"',;]{8,}/i.test(
			payload,
		)
	)
		throw new Error("Credential-like material refused; no note content was written");
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
function date(value: unknown): value is string {
	return (
		typeof value === "string" &&
		DATE.test(value) &&
		Number.isFinite(Date.parse(value)) &&
		new Date(value).toISOString().slice(0, 10) === value
	);
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
	if (!match) throw new Error("Mutation requires valid frontmatter; repair the source explicitly first");
	let meta: Record<string, unknown>;
	try {
		meta = parseFrontmatter<Record<string, unknown>>(match[0]).frontmatter;
	} catch {
		throw new Error("Mutation requires unambiguous frontmatter");
	}
	if (
		!meta ||
		typeof meta !== "object" ||
		Array.isArray(meta) ||
		!date(meta.created) ||
		!date(meta.updated) ||
		!(meta.status === "active" || meta.status === "superseded") ||
		!Array.isArray(meta.supersedes) ||
		meta.supersedes.length > 16 ||
		meta.supersedes.some((v) => typeof v !== "string" || !SLUG.test(v)) ||
		!(meta.superseded_by === null || (typeof meta.superseded_by === "string" && SLUG.test(meta.superseded_by)))
	)
		throw new Error("Mutation requires valid lifecycle fields; source remains readable");
	return { text: source, meta, end: match[0].length };
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
function serialize(input: MemoryWrite, created: string, today: string, supersedes: string[]): string {
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
	};
	const header = Object.entries(fields)
		.map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
		.join("\n");
	const result = `---\n${header}\n---\n\n# ${input.title.trim()}\n\n## Summary\n\n${input.summary.trim()}\n\n## Details\n\n${input.details.trim()}\n\n## Sources\n\n${input.sources.trim()}\n`;
	if (Buffer.byteLength(result) > MAX_BYTES) throw new Error("Note exceeds the 64 KiB source limit");
	return result;
}
/** Only lifecycle lines change; introductory text, fences, and the complete body survive. */
function superseded(source: Existing, replacement: string, today: string): string {
	const header = source.text.slice(0, source.end);
	const updated = header.replace(
		/^(status|updated|superseded_by):[^\r\n]*(?:\r?\n[ \t]+[^\r\n]*)*/gm,
		(_line, key: string) =>
			`${key}: ${JSON.stringify(key === "status" ? "superseded" : key === "updated" ? today : replacement)}`,
	);
	// The parser permits YAML forms that line replacement cannot safely edit.
	const parsed = parseFrontmatter<Record<string, unknown>>(updated).frontmatter;
	if (parsed.status !== "superseded" || parsed.updated !== today || parsed.superseded_by !== replacement)
		throw new Error("Lifecycle fields require plain top-level keys for supersession");
	const result = updated + source.text.slice(source.end);
	if (Buffer.byteLength(result) > MAX_BYTES) throw new Error("Superseded source exceeds 64 KiB");
	return result;
}
function stage(root: string, content: string): string {
	const path = join(root, `.memory-${randomUUID()}.tmp`);
	const fd = openSync(path, "wx", 0o600);
	try {
		writeFileSync(fd, content);
		fsyncSync(fd);
	} catch (error) {
		closeSync(fd);
		unlinkSync(path);
		throw error;
	}
	closeSync(fd);
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
}
function targetPlans(root: string, input: MemoryWrite, today: string, signal?: AbortSignal): Publication[] {
	return (input.supersedes ?? []).map((target) => {
		checkAbort(signal);
		const file = `${target.slug}.md`;
		const source = existing(join(root, file), target.digest);
		if (
			(source.meta.status === "active" && source.meta.superseded_by !== null) ||
			(source.meta.status !== "active" && source.meta.superseded_by !== input.slug)
		)
			throw new Error("A supersession target already names another replacement");
		return { file, content: superseded(source, input.slug, today), expected: target.digest };
	});
}
function destinationSource(destination: string, input: MemoryWrite): Existing | undefined {
	const present = exists(destination);
	if (present && input.expectedDigest === undefined)
		throw new Error("Duplicate slug refused; read the note and supply expectedDigest to update");
	if (!present && input.expectedDigest !== undefined) throw new Error("Update target does not exist");
	const prior = present ? existing(destination, input.expectedDigest) : undefined;
	if (prior && (prior.meta.status !== "active" || prior.meta.superseded_by !== null))
		throw new Error("A superseded note cannot be updated; inspect its replacement");
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
	const content = serialize(input, (prior?.meta.created as string | undefined) ?? today, today, [...links]);
	const contractPath = join(root, "README.md");
	const contractExists = exists(contractPath);
	if (contractExists) readSource(contractPath);
	return [
		...(contractExists ? [] : [{ file: "README.md", content: CONTRACT }]),
		{ file, content, expected: input.expectedDigest },
		...targets,
	];
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
		if (error) recordFailure(receipt, `Temporary file cleanup failed (${error})`);
	}
	try {
		release();
	} catch (error) {
		recordFailure(receipt, `Writer lock cleanup failed (${errorCode(error)}); inspect .memory-write.lock before retry`);
	}
}

export interface WriteHooks {
	/** Test boundary for failures immediately before an atomic publication. */
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
	mkdirSync(rootValue, { recursive: true, mode: 0o700 });
	const root = realpathSync(rootValue);
	const release = acquire(root);
	const receipt: WriteReceipt = {
		ok: false,
		slug: input.slug,
		file: `${input.slug}.md`,
		written: [],
		notWritten: [],
		initialized: false,
	};
	const staged: string[] = [];
	try {
		const plans = planWrites(root, input, signal);
		receipt.notWritten = plans.map((plan) => plan.file);
		const prepared = plans.map((plan) => {
			const temp = stage(root, plan.content);
			staged.push(temp);
			return { ...plan, temp };
		});
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
