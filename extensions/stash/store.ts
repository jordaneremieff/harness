/** Filesystem persistence for durable stash artifacts. */

import { createHash, randomUUID } from "node:crypto";
import { constants, type Dirent, type Stats } from "node:fs";
import { chmod, type FileHandle, link, lstat, mkdir, open, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { readSettings, type Environment } from "../../settings/index.ts";
import { settings } from "./settings.ts";
import {
	isStashState,
	parseFrontmatter,
	type StashMeta,
	type StashRecord,
	type StashState,
	serializeArtifact,
	slugify,
	updateFrontmatter,
	utcTimestamp,
} from "./format.ts";
import {
	mergeRedactionReports,
	type RedactionReport,
	redactPayloadWithReport,
	redactSecrets,
	redactSecretsWithReport,
} from "./redact.ts";

const HEADER_SCAN_BYTES = 16 * 1024;
export const MAX_STASH_BYTES = 256 * 1024;
const SAFE_STEM = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;

/** Dot-hidden sibling of the store that receives rotated artifacts. */
export const ROTATED_STORE_NAME = ".trash";

export interface StashInput {
	title: string;
	summary: string;
	decisions?: string[];
	openLoops?: string[];
	nextActions?: string[];
	files?: string[];
	tags?: string[];
	project?: string;
	branch?: string;
	sessionId?: string;
}

export interface StashEditInput {
	expectedDigest: string;
	edits: { oldText: string; newText: string }[];
	allowActive?: boolean;
}

export interface StashEditResult {
	redactions: RedactionReport;
	id: string;
	path: string;
	content: string;
	digest: string;
	meta: StashMeta;
	changed: boolean;
}

export interface StashEntry {
	meta: StashMeta;
	path: string;
	/** Body-only prefix used by the interactive browser. */
	preview?: string;
	previewTruncated?: boolean;
	previewError?: string;
}

export function resolveStoreDir(env: Environment, agentDir: string): string {
	return readSettings(settings, { agentDir, env }).values.dir;
}

function hasCode(error: unknown, code: string): boolean {
	return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === code;
}

function artifactDirents(dirents: Dirent[]): Dirent[] {
	return dirents.filter((entry) => entry.isFile() && entry.name.endsWith(".md") && !entry.name.startsWith("."));
}

/**
 * Open an artifact as a regular file, ignoring rather than following symlinks.
 * The stat taken to verify regularity is returned with the handle so callers
 * can avoid a second stat.
 */
export async function openRegular(path: string): Promise<{ handle: FileHandle; info: Stats }> {
	const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
	const handle = await open(path, constants.O_RDONLY | noFollow | constants.O_NONBLOCK);
	try {
		const info = await handle.stat();
		if (!info.isFile()) throw new Error(`not a regular file: ${path}`);
		return { handle, info };
	} catch (error) {
		await handle.close();
		throw error;
	}
}

/** Store directories whose artifacts this process has already hardened. */
const hardenedStores = new Set<string>();

/** Harden discovered artifacts through nonblocking, no-follow regular-file descriptors. */
async function hardenArtifacts(dir: string, dirents: Dirent[]): Promise<void> {
	for (const entry of artifactDirents(dirents)) {
		try {
			const { handle, info } = await openRegular(join(dir, entry.name));
			try {
				if ((info.mode & 0o7777) !== 0o600) await handle.chmod(0o600);
			} finally {
				await handle.close();
			}
		} catch (error) {
			if (!hasCode(error, "ENOENT") && !hasCode(error, "ELOOP")) throw error;
		}
	}
}

/** Validate and harden only the directory, without enumerating or sweeping artifacts. */
export async function validateStore(dir: string, create: boolean): Promise<Stats | null> {
	if (create) await mkdir(dir, { recursive: true, mode: 0o700 });
	try {
		const info = await lstat(dir);
		if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`stash store is not a regular directory: ${dir}`);
		if ((info.mode & 0o7777) !== 0o700) {
			await chmod(dir, 0o700);
			return await lstat(dir);
		}
		return info;
	} catch (error) {
		if (!create && hasCode(error, "ENOENT")) return null;
		throw error;
	}
}

/** Enforce directory privacy and sweep artifacts once, caching only a completed sweep. */
async function secureStore(dir: string, create: boolean): Promise<Dirent[] | null> {
	if (!(await validateStore(dir, create))) return null;
	let dirents: Dirent[];
	try {
		dirents = await readdir(dir, { withFileTypes: true });
	} catch (error) {
		if (!create && hasCode(error, "ENOENT")) return null;
		throw error;
	}
	if (hardenedStores.has(dir)) return dirents;
	await hardenArtifacts(dir, dirents);
	// Mark the store hardened only after a completed sweep so an interrupted one
	// retries on the next touch.
	hardenedStores.add(dir);
	return dirents;
}

function recordFor(id: string, created: string, input: StashInput): StashRecord {
	return {
		id,
		title: input.title,
		created,
		project: input.project,
		branch: input.branch,
		sessionId: input.sessionId,
		tags: input.tags ?? [],
		state: "open",
		summary: input.summary,
		decisions: input.decisions ?? [],
		openLoops: input.openLoops ?? [],
		nextActions: input.nextActions ?? [],
		files: input.files ?? [],
	};
}

async function publishArtifact(temporary: string, path: string, serialized: string): Promise<boolean> {
	let published = false;
	try {
		await writeFile(temporary, serialized, { encoding: "utf8", flag: "wx", mode: 0o600 });
		await chmod(temporary, 0o600);
		try {
			await link(temporary, path);
		} catch (error) {
			if (hasCode(error, "EEXIST")) return false;
			throw error;
		}
		// The hard link shares the completed temporary inode's private mode.
		published = true;
		return true;
	} finally {
		await cleanTemporary(temporary, published);
	}
}

/** Cleanup must not turn a successful publication into a duplicate-producing failure. */
async function cleanTemporary(path: string, published: boolean): Promise<void> {
	try {
		await unlink(path);
	} catch (error) {
		if (!published && !hasCode(error, "ENOENT")) throw error;
	}
}

/** Whether an existing name already holds exactly this serialized artifact. */
async function reusePublished(path: string, serialized: string): Promise<boolean> {
	try {
		const existing = await readPrefix(path, MAX_STASH_BYTES);
		return !existing.truncated && existing.text === serialized;
	} catch (error) {
		if (!hasCode(error, "ENOENT") && !hasCode(error, "ELOOP")) throw error;
		return false;
	}
}

/**
 * Publish a fully materialized artifact under the first free deterministic id.
 * With `reuseExisting`, a name already holding the exact bytes this call would
 * publish is that call's earlier attempt, so it is returned instead of a
 * suffixed duplicate; any other collision keeps the ordinary suffix scan.
 */
async function publishStash(
	dir: string,
	input: StashInput,
	now: Date,
	reuseExisting: boolean,
): Promise<{ record: StashRecord; path: string; redactions: RedactionReport }> {
	const scanned = redactPayloadWithReport(input);
	input = scanned.payload;
	await secureStore(dir, true);
	const created = utcTimestamp(now);
	const baseId = `${created}-${slugify(input.title)}`;

	for (let attempt = 1; attempt <= 10_000; attempt++) {
		const id = attempt === 1 ? baseId : `${baseId}-${attempt}`;
		const record = recordFor(id, created, input);
		const serialized = serializeArtifact(record);
		const bytes = Buffer.byteLength(serialized, "utf8");
		if (bytes > MAX_STASH_BYTES) {
			throw new Error(`stash artifact is ${bytes} bytes; maximum is ${MAX_STASH_BYTES}`);
		}
		const path = join(dir, `${id}.md`);
		const temporary = join(dir, `.${id}.${randomUUID()}.tmp`);
		if (await publishArtifact(temporary, path, serialized)) return { record, path, redactions: scanned.report };
		if (reuseExisting && (await reusePublished(path, serialized))) return { record, path, redactions: scanned.report };
	}
	throw new Error(`could not allocate a unique stash id for ${baseId}`);
}

/** Write a fully materialized artifact with an atomic, no-clobber link. */
export async function writeStash(
	dir: string,
	input: StashInput,
	now: Date = new Date(),
): Promise<{ record: StashRecord; path: string; redactions: RedactionReport }> {
	return publishStash(dir, input, now, false);
}

/**
 * Write like `writeStash`, but reuse a byte-identical artifact already
 * published under the candidate id. A durable tool rerun after process loss
 * calls this with the same input and timestamp, so it returns its earlier
 * artifact instead of allocating a suffixed duplicate.
 */
export async function writeReplayableStash(
	dir: string,
	input: StashInput,
	now: Date = new Date(),
): Promise<{ record: StashRecord; path: string; redactions: RedactionReport }> {
	return publishStash(dir, input, now, true);
}

interface ListOptions {
	limit?: number;
	tag?: string;
	state?: StashState;
	/** Include at most this many UTF-8 bytes of body preview per entry. */
	previewBytes?: number;
}

/**
 * True when a text opens a frontmatter header that never closes. Mirrors the
 * extension's own parseFrontmatter (format.ts) exactly: the header opens only
 * when the first line trims to "---" and closes at the first later line that
 * trims to "---". An unread header has unknown state and cannot authorize
 * lifecycle changes or rotation.
 */
function headerUnclosed(text: string): boolean {
	const lines = text.split("\n");
	if (lines[0]?.trim() !== "---") return false;
	return !lines.slice(1).some((line) => line.trim() === "---");
}

async function readPrefix(
	path: string,
	maxBytes: number,
): Promise<{ text: string; truncated: boolean; size: number; identity: { dev: number; ino: number } }> {
	const limit = Math.max(0, Math.floor(maxBytes));
	const { handle, info } = await openRegular(path);
	try {
		if ((info.mode & 0o7777) !== 0o600) await handle.chmod(0o600);
		const buffer = Buffer.alloc(limit + 1);
		let bytesRead = 0;
		while (bytesRead < buffer.length) {
			const result = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
			if (result.bytesRead === 0) break;
			bytesRead += result.bytesRead;
		}
		const truncated = info.size > limit || bytesRead > limit;
		let end = Math.min(bytesRead, limit);
		// A byte-bounded cut can split a multi-byte UTF-8 character; back off
		// trailing continuation bytes so the decoded prefix never ends in U+FFFD.
		if (truncated) {
			while (end > 0 && (buffer[end] & 0xc0) === 0x80) end--;
		}
		return {
			text: buffer.subarray(0, end).toString("utf8"),
			truncated,
			size: Math.max(info.size, bytesRead),
			identity: { dev: info.dev, ino: info.ino },
		};
	} finally {
		await handle.close();
	}
}

function utf8BodyPrefix(body: string, maxBytes: number): { text: string; truncated: boolean } {
	const bytes = Buffer.from(body, "utf8");
	if (bytes.length <= maxBytes) return { text: body, truncated: false };
	let end = Math.max(0, maxBytes);
	while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
	return { text: bytes.subarray(0, end).toString("utf8"), truncated: true };
}

export function normalizeMeta(name: string, parsed: Partial<StashMeta> & Record<string, unknown>): StashMeta {
	const id = name.replace(/\.md$/, "");
	return {
		id,
		title: typeof parsed.title === "string" ? parsed.title : id,
		created: typeof parsed.created === "string" ? parsed.created : "",
		project: typeof parsed.project === "string" ? parsed.project : undefined,
		branch: typeof parsed.branch === "string" ? parsed.branch : undefined,
		sessionId: typeof parsed.sessionId === "string" ? parsed.sessionId : undefined,
		tags: Array.isArray(parsed.tags) ? parsed.tags.filter((tag): tag is string => typeof tag === "string") : [],
		state: isStashState(parsed.state) ? parsed.state : "unknown",
		invalidState: isStashState(parsed.state)
			? undefined
			: parsed.state === undefined
				? "missing"
				: String(parsed.state),
		activatedAt: typeof parsed.activatedAt === "string" ? parsed.activatedAt : undefined,
		closedAt: typeof parsed.closedAt === "string" ? parsed.closedAt : undefined,
		outcome: typeof parsed.outcome === "string" ? parsed.outcome : undefined,
	};
}

async function listingEntry(dir: string, name: string, options: ListOptions): Promise<StashEntry> {
	const path = join(dir, name);
	const entry: StashEntry = {
		meta: normalizeMeta(name, {}),
		path,
		preview: undefined,
		previewTruncated: undefined,
		previewError: undefined,
	};
	try {
		const previewBytes = Math.min(MAX_STASH_BYTES - HEADER_SCAN_BYTES, Math.max(0, options.previewBytes ?? 0));
		const prefix = await readPrefix(path, HEADER_SCAN_BYTES + previewBytes);
		// Every consumer uses the same bounded header window for lifecycle decisions.
		const headerPrefix = previewBytes > 0 ? await readPrefix(path, HEADER_SCAN_BYTES) : prefix;
		if (headerUnclosed(headerPrefix.text)) {
			throw new Error(
				headerPrefix.truncated
					? `artifact header is longer than the ${HEADER_SCAN_BYTES}-byte scan window; its state cannot be verified`
					: "artifact header never closes; its state cannot be verified",
			);
		}
		const parsed = parseFrontmatter(prefix.text);
		entry.meta = normalizeMeta(name, parsed.meta);
		if (options.previewBytes !== undefined) {
			const bodyPrefix = utf8BodyPrefix(parsed.body, previewBytes);
			entry.preview = bodyPrefix.text;
			entry.previewTruncated = prefix.truncated || bodyPrefix.truncated;
		}
	} catch (error) {
		entry.previewError = error instanceof Error ? error.message : String(error);
	}
	return entry;
}

/** List artifacts newest-first without allowing malformed files to hide their siblings. */
export async function listStashes(dir: string, options: ListOptions = {}): Promise<StashEntry[]> {
	const dirents = await secureStore(dir, false);
	if (!dirents) return [];
	const limit = Math.max(0, options.limit ?? 10);
	if (limit === 0) return [];
	const names = artifactDirents(dirents)
		.map((entry) => entry.name)
		.filter((name) => SAFE_STEM.test(name.replace(/\.md$/, "")))
		.sort()
		.reverse();
	const entries: StashEntry[] = [];

	for (const name of names) {
		const entry = await listingEntry(dir, name, options);
		const { meta, previewError } = entry;
		// An unreadable artifact has no readable tags, so an explicit tag filter
		// cannot match it; it stays visible in unfiltered listings (the same rule
		// as the state filter below).
		if (options.tag && !meta.tags.includes(options.tag)) continue;
		// An artifact whose header could not be read has an unknown state (for
		// example a file removed or replaced mid-listing); it must not satisfy an
		// explicit state filter as if it were verified open.
		if (
			options.state &&
			(previewError !== undefined || meta.invalidState !== undefined || meta.state !== options.state)
		)
			continue;
		entries.push(entry);
		if (entries.length >= limit) break;
	}
	return entries;
}

type ReadResult =
	| { ok: true; id: string; path: string; content: string; digest: string }
	| { ok: false; error: string; candidates?: string[] };

type LocatedArtifact = { ok: true; id: string; path: string } | Extract<ReadResult, { ok: false }>;

function locateArtifact(dir: string, dirents: Dirent[], idOrPrefix: string): LocatedArtifact {
	const stems = artifactDirents(dirents)
		.map((entry) => entry.name.replace(/\.md$/, ""))
		.filter((stem) => SAFE_STEM.test(stem));
	const exact = stems.filter((stem) => stem === idOrPrefix);
	const matches =
		exact.length > 0
			? exact
			: stems
					.filter((stem) => stem.startsWith(idOrPrefix))
					.sort()
					.reverse();
	if (matches.length === 0) return { ok: false, error: `no stash matches "${idOrPrefix}"` };
	if (matches.length > 1) {
		return { ok: false, error: `"${idOrPrefix}" is ambiguous`, candidates: matches.slice(0, 10) };
	}
	return { ok: true, id: matches[0], path: join(dir, `${matches[0]}.md`) };
}

/** Resolve a discovered regular artifact without loading its body or applying the read-size cap. */
export async function resolveStash(dir: string, idOrPrefix: string): Promise<LocatedArtifact> {
	const dirents = await secureStore(dir, false);
	if (!dirents) return { ok: false, error: `stash store not found: ${dir}` };
	return locateArtifact(dir, dirents, idOrPrefix);
}

/** Read one regular artifact by exact id or unique id prefix. */
export async function readStash(dir: string, idOrPrefix: string): Promise<ReadResult> {
	const located = await resolveStash(dir, idOrPrefix);
	if ("error" in located) return located;
	try {
		const artifact = await readMutationSource(located.path, "readable");
		return { ...located, content: artifact.content, digest: artifact.digest };
	} catch (error) {
		return {
			ok: false,
			error: `failed to read ${located.path}: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
}

export type StashLifecycleChange =
	| { action: "activate" }
	| { action: "close"; outcome: string }
	| { action: "reopen" }
	| { action: "release" };

export interface StashRotateResult {
	id: string;
	/** Store-relative id (the artifact no longer lives at `path` after rotation). */
	path: string;
	/** New location inside the dot-hidden archive subdirectory. */
	archivePath: string;
	/** Lifecycle state recorded at rotation time: open or closed. */
	state: Exclude<StashState, "active">;
}

interface StashTransitionResult {
	redactions: RedactionReport;
	id: string;
	path: string;
	content: string;
	meta: StashMeta;
	changed: boolean;
}

interface MutationSource {
	content: string;
	digest: string;
	identity: Stats;
}

function artifactDigest(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function sameRevision(before: Stats, after: Stats): boolean {
	return (
		before.dev === after.dev &&
		before.ino === after.ino &&
		before.size === after.size &&
		before.mtimeMs === after.mtimeMs &&
		before.ctimeMs === after.ctimeMs
	);
}

async function readMutationSource(path: string, sizeKind = "mutable"): Promise<MutationSource> {
	const { handle, info } = await openRegular(path);
	try {
		if ((info.mode & 0o7777) !== 0o600) await handle.chmod(0o600);
		// Permission hardening changes ctime, so it precedes the consistency baseline.
		const before = await handle.stat();
		if (before.size > MAX_STASH_BYTES) {
			throw new Error(`stash is ${before.size} bytes; maximum ${sizeKind} size is ${MAX_STASH_BYTES}`);
		}
		const buffer = Buffer.alloc(MAX_STASH_BYTES + 1);
		let offset = 0;
		while (offset < buffer.length) {
			const result = await handle.read(buffer, offset, buffer.length - offset, offset);
			if (result.bytesRead === 0) break;
			offset += result.bytesRead;
		}
		const after = await handle.stat();
		const current = await lstat(path);
		if (offset > MAX_STASH_BYTES || after.size > MAX_STASH_BYTES) {
			throw new Error(`stash exceeds the maximum ${sizeKind} size of ${MAX_STASH_BYTES} bytes`);
		}
		if (
			!sameRevision(before, after) ||
			after.size !== offset ||
			!current.isFile() ||
			current.isSymbolicLink() ||
			!sameRevision(after, current)
		) {
			throw new Error("stash changed while it was being read; retry the operation");
		}
		const bytes = buffer.subarray(0, offset);
		let content: string;
		try {
			content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
		} catch {
			throw new Error("stash contains invalid UTF-8; repair the artifact before retrying");
		}
		return { content, digest: artifactDigest(bytes), identity: after };
	} finally {
		await handle.close();
	}
}

function checkMutationSignal(signal?: AbortSignal): void {
	if (signal?.aborted) throw new Error("stash mutation cancelled");
}

/** Shared cross-process exclusion for edits, lifecycle changes, and rotation. */
async function withArtifactMutation<T>(
	dir: string,
	idOrPrefix: string,
	signal: AbortSignal | undefined,
	change: (located: Extract<LocatedArtifact, { ok: true }>) => Promise<T>,
): Promise<T> {
	checkMutationSignal(signal);
	const located = await resolveStash(dir, idOrPrefix);
	if ("error" in located) {
		const candidates = located.candidates?.length ? ` Candidates: ${located.candidates.join(", ")}.` : "";
		throw new Error(`${located.error}.${candidates}`);
	}
	checkMutationSignal(signal);
	const lockPath = join(dir, `.${located.id}.lock`);
	let lock: FileHandle;
	try {
		lock = await open(lockPath, "wx", 0o600);
	} catch (error) {
		if (hasCode(error, "EEXIST")) {
			throw new Error(
				`stash ${located.id} is busy; mutation lock exists at ${lockPath}. Retry after the mutation ends. If its process stopped, remove this exact lock only after confirming no mutation remains active.`,
			);
		}
		throw error;
	}
	let completed = false;
	let result!: T;
	let failure: unknown;
	try {
		await lock.chmod(0o600);
		checkMutationSignal(signal);
		result = await change(located);
		completed = true;
	} catch (error) {
		failure = error;
	}
	try {
		await releaseMutationLock(lock, lockPath);
	} catch (error) {
		throw new Error(
			`stash mutation ${completed ? "completed" : "stopped"}, but lock cleanup failed at ${lockPath}: ${error instanceof Error ? error.message : String(error)}`,
			{ cause: failure ?? error },
		);
	}
	if (!completed) throw failure;
	return result;
}

async function releaseMutationLock(lock: FileHandle, lockPath: string): Promise<void> {
	try {
		const identity = await lock.stat();
		const current = await lstat(lockPath);
		if (!sameRegularFile(current, identity)) throw new Error("mutation lock was replaced");
		await unlink(lockPath);
	} finally {
		await lock.close();
	}
}

function currentState(meta: Partial<StashMeta> & Record<string, unknown>): StashState {
	if (!isStashState(meta.state))
		throw new Error(
			`stash has invalid lifecycle state: ${String(meta.state)}; inspect the artifact header and repair its JSON-encoded state before retrying`,
		);
	return meta.state;
}

function completionOutcome(raw: string): string {
	const outcome = redactSecrets(raw.trim());
	if (!outcome) throw new Error("stash completion outcome must not be empty; supply a concrete terminal outcome");
	if (outcome.length > 20_000)
		throw new Error("stash completion outcome exceeds 20000 characters; shorten the outcome and retry");
	return outcome;
}

function lifecyclePatch(
	id: string,
	state: StashState,
	change: StashLifecycleChange,
	stamp: string,
): Record<string, unknown> | null {
	if (change.action === "activate") {
		if (state === "closed") throw new Error(`stash ${id} is closed; reopen it before pickup with /stash reopen ${id}`);
		if (state === "active") return null;
		return { state: "active", activatedAt: stamp, closedAt: undefined, outcome: undefined };
	}
	if (change.action === "close") {
		const outcome = completionOutcome(change.outcome);
		if (state === "closed")
			throw new Error(
				`stash ${id} is already closed; use stash_read with this id to inspect its outcome. To replace the outcome deliberately, first use /stash reopen ${id}`,
			);
		return { state: "closed", closedAt: stamp, outcome };
	}
	if (change.action === "release") {
		if (state !== "active")
			throw new Error(
				`stash ${id} can be released only from active state (state: ${state}); use /stash get ${id} to resume an open effort, or /stash reopen ${id} to return a closed effort to open`,
			);
		return { state: "open", activatedAt: undefined };
	}
	if (state !== "closed")
		throw new Error(
			`stash ${id} can be reopened only from closed state (state: ${state}); use /stash release ${id} to return an active effort to open, or /stash get ${id} to resume an open effort`,
		);
	return { state: "open", closedAt: undefined, outcome: undefined };
}

/** Atomically rewrite only lifecycle frontmatter under the artifact mutation lock. */
export async function transitionStash(
	dir: string,
	idOrPrefix: string,
	change: StashLifecycleChange,
	now: Date = new Date(),
): Promise<StashTransitionResult> {
	return withArtifactMutation(dir, idOrPrefix, undefined, async (located) => {
		const source = await readMutationSource(located.path);
		const parsed = parseFrontmatter(source.content);
		// The full content is read here, so the unclosed-header check runs on the
		// whole artifact, not the bounded scan window: a header that closes beyond
		// 16 KiB stays readable, while a header that never closes is UNKNOWN and
		// must not be mutated as if it were a verified state.
		if (headerUnclosed(source.content)) {
			throw new Error(
				`stash ${located.id} has a header that never closes; its state cannot be verified for lifecycle changes. Inspect the artifact and repair the frontmatter delimiter before retrying`,
			);
		}
		const state = currentState(parsed.meta);
		const stamp = utcTimestamp(now);
		const scanned = redactSecretsWithReport(change.action === "close" ? change.outcome.trim() : "");
		const safeChange = change.action === "close" ? { ...change, outcome: scanned.text } : change;
		const patch = lifecyclePatch(located.id, state, safeChange, stamp);
		if (!patch) {
			return {
				...located,
				content: source.content,
				meta: normalizeMeta(`${located.id}.md`, parsed.meta),
				changed: false,
				redactions: scanned.report,
			};
		}

		const content = updateFrontmatter(source.content, patch);
		await publishRevision(dir, located, source, content);
		return {
			...located,
			content,
			meta: normalizeMeta(`${located.id}.md`, parseFrontmatter(content).meta),
			changed: true,
			redactions: scanned.report,
		};
	});
}

async function publishRevision(
	dir: string,
	located: Extract<LocatedArtifact, { ok: true }>,
	source: MutationSource,
	content: string,
	signal?: AbortSignal,
): Promise<void> {
	const bytes = Buffer.byteLength(content, "utf8");
	if (bytes > MAX_STASH_BYTES) throw new Error(`updated stash is ${bytes} bytes; maximum is ${MAX_STASH_BYTES}`);
	checkMutationSignal(signal);
	const temporary = join(dir, `.${located.id}.${randomUUID()}.tmp`);
	let staged = false;
	let published = false;
	try {
		await writeFile(temporary, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
		staged = true;
		await chmod(temporary, 0o600);
		const current = await lstat(located.path);
		if (current.isSymbolicLink() || !current.isFile()) throw new Error("stash target is no longer a regular file");
		if (!sameRevision(source.identity, current)) {
			throw new Error("stash target changed before revision publication; retry the operation");
		}
		checkMutationSignal(signal);
		await rename(temporary, located.path);
		published = true;
	} finally {
		if (staged) await cleanTemporary(temporary, published);
	}
}

function validateEdits(input: StashEditInput): void {
	if (typeof input.expectedDigest !== "string" || !/^[a-f0-9]{64}$/.test(input.expectedDigest)) {
		throw new Error("expectedDigest must be a SHA-256 digest from stash_read");
	}
	if (!Array.isArray(input.edits) || input.edits.length < 1 || input.edits.length > 32) {
		throw new Error("stash edits must contain 1 to 32 replacements");
	}
	if (input.allowActive !== undefined && typeof input.allowActive !== "boolean") {
		throw new Error("allowActive must be a boolean");
	}
	for (const edit of input.edits) {
		if (
			!edit ||
			typeof edit.oldText !== "string" ||
			typeof edit.newText !== "string" ||
			!edit.oldText ||
			edit.oldText.length > 100_000 ||
			edit.newText.length > 100_000
		) {
			throw new Error("each stash edit requires nonempty oldText and string newText, each at most 100000 characters");
		}
		for (const text of [edit.oldText, edit.newText]) {
			if (Buffer.from(text, "utf8").toString("utf8") !== text) {
				throw new Error("stash edits must not contain unpaired Unicode surrogates");
			}
		}
	}
}

/** Preserve the original header delimiters, whitespace, and all metadata bytes. */
function bodyOffset(content: string): number {
	const lines = content.split("\n");
	if (lines[0]?.trim() !== "---") throw new Error("stash requires a closed frontmatter header");
	let offset = lines[0].length + 1;
	for (let index = 1; index < lines.length; index++) {
		offset += lines[index].length + (index < lines.length - 1 ? 1 : 0);
		if (lines[index].trim() === "---") return offset;
	}
	throw new Error("stash requires a closed frontmatter header");
}

function bodyTitle(body: string): string | undefined {
	const first = body.split("\n").find((line) => line.trim() !== "");
	return first !== undefined && /^#(?:[ \t]+|$)/.test(first) ? first : undefined;
}

function replaceBody(
	content: string,
	edits: StashEditInput["edits"],
): { content: string; redactions: RedactionReport } {
	const reports: RedactionReport[] = [];
	const offset = bodyOffset(content);
	const body = content.slice(offset);
	const replacements = edits
		.map(({ oldText, newText }, index) => {
			const start = body.indexOf(oldText);
			if (start < 0) throw new Error(`stash edit ${index + 1} oldText does not match the body`);
			if (body.indexOf(oldText, start + 1) >= 0) {
				throw new Error(`stash edit ${index + 1} oldText matches more than once; supply a unique body anchor`);
			}
			const scanned = redactSecretsWithReport(newText);
			reports.push({
				...scanned.report,
				contexts: scanned.report.contexts.map((context) => `edits[${index}]: ${context}`),
			});
			return { start, end: start + oldText.length, text: scanned.text };
		})
		.sort((left, right) => left.start - right.start);
	let position = 0;
	const parts: string[] = [];
	for (const replacement of replacements) {
		if (replacement.start < position) throw new Error("stash edits overlap in the original body");
		parts.push(body.slice(position, replacement.start), replacement.text);
		position = replacement.end;
	}
	parts.push(body.slice(position));
	const updatedBody = parts.join("");
	if (bodyTitle(updatedBody) !== bodyTitle(body)) {
		throw new Error("stash edits must preserve the body title heading");
	}
	return { content: content.slice(0, offset) + updatedBody, redactions: mergeRedactionReports(...reports) };
}

/** Apply all exact body replacements under the shared artifact mutation lock. */
export async function editStash(
	dir: string,
	idOrPrefix: string,
	input: StashEditInput,
	signal?: AbortSignal,
): Promise<StashEditResult> {
	checkMutationSignal(signal);
	validateEdits(input);
	return withArtifactMutation(dir, idOrPrefix, signal, async (located) => {
		const source = await readMutationSource(located.path);
		checkMutationSignal(signal);
		if (source.digest !== input.expectedDigest) {
			throw new Error(
				`stash revision conflict for ${located.id}; current digest is ${source.digest}. Read the stash again before retrying.`,
			);
		}
		const parsed = parseFrontmatter(source.content);
		const state = currentState(parsed.meta);
		if (state === "closed") {
			throw new Error(
				`stash ${located.id} is closed; deliberately reopen it with /stash reopen ${located.id}, then read it again before editing`,
			);
		}
		if (state === "active" && input.allowActive !== true) {
			throw new Error(
				`stash ${located.id} is active; allowActive: true explicitly acknowledges an edit to the active handover`,
			);
		}
		const { content, redactions } = replaceBody(source.content, input.edits);
		const changed = content !== source.content;
		if (changed) await publishRevision(dir, located, source, content, signal);
		return {
			id: located.id,
			path: located.path,
			content,
			digest: changed ? artifactDigest(Buffer.from(content, "utf8")) : source.digest,
			meta: normalizeMeta(`${located.id}.md`, parsed.meta),
			changed,
			redactions,
		};
	});
}

async function secureArchive(dir: string): Promise<string> {
	const archiveDir = join(dir, ROTATED_STORE_NAME);
	await mkdir(archiveDir, { recursive: true, mode: 0o700 });
	const archiveInfo = await lstat(archiveDir);
	if (!archiveInfo.isDirectory() || archiveInfo.isSymbolicLink()) {
		throw new Error(`stash archive is not a regular directory: ${archiveDir}`);
	}
	if ((archiveInfo.mode & 0o7777) !== 0o700) await chmod(archiveDir, 0o700);
	return archiveDir;
}

type FileIdentity = { dev: number; ino: number };

function sameRegularFile(info: Stats, identity: FileIdentity): boolean {
	return info.isFile() && !info.isSymbolicLink() && info.dev === identity.dev && info.ino === identity.ino;
}

async function removeArchivedSource(path: string, archivePath: string, identity: FileIdentity): Promise<void> {
	try {
		const archived = await lstat(archivePath);
		const source = await lstat(path);
		if (!sameRegularFile(archived, identity) || source.dev !== identity.dev || source.ino !== identity.ino) {
			throw new Error("stash target changed during rotation");
		}
		await unlink(path);
	} catch (error) {
		throw new Error(
			`stash archive retained at ${archivePath}, but source removal failed: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

async function publishArchive(
	id: string,
	path: string,
	archivePath: string,
	temporary: string,
	identity: FileIdentity,
): Promise<void> {
	let staged = false;
	let published = false;
	try {
		await link(path, temporary);
		staged = true;
		const retained = await lstat(temporary);
		if (!sameRegularFile(retained, identity))
			throw new Error("stash target changed during rotation; retry the operation");
		try {
			await link(temporary, archivePath);
		} catch (error) {
			if (hasCode(error, "EEXIST")) throw new Error(`stash ${id} is already rotated`);
			throw error;
		}
		published = true;
		await removeArchivedSource(path, archivePath, identity);
	} finally {
		if (staged) await cleanTemporary(temporary, published);
	}
}

async function readRotationSource(located: Extract<LocatedArtifact, { ok: true }>) {
	let prefix: Awaited<ReturnType<typeof readPrefix>>;
	try {
		prefix = await readPrefix(located.path, HEADER_SCAN_BYTES);
	} catch (error) {
		throw new Error(`failed to read ${located.path}: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (headerUnclosed(prefix.text)) {
		throw new Error(
			prefix.truncated
				? `stash ${located.id} has a header longer than the ${HEADER_SCAN_BYTES}-byte scan window; its state cannot be verified for rotation`
				: `stash ${located.id} has a header that never closes; its state cannot be verified for rotation`,
		);
	}
	return { prefix, state: currentState(parseFrontmatter(prefix.text).meta) };
}

/**
 * Retain an open or closed artifact byte-for-byte under the hidden `.trash`
 * directory. Active artifacts require completion or release before rotation.
 * The shared mutation lock excludes cooperating lifecycle and edit operations.
 * A bounded header read permits rotation of oversized bodies. A private hard
 * link pins the verified inode before exclusive archive publication; source
 * removal follows publication. Raw external writers do not honor the lock.
 */
export async function rotateStash(dir: string, idOrPrefix: string): Promise<StashRotateResult> {
	return withArtifactMutation(dir, idOrPrefix, undefined, async (located) => {
		const { prefix, state } = await readRotationSource(located);
		if (state === "active") {
			throw new Error(`stash ${located.id} is active; complete it before rotation (state: active)`);
		}

		const archiveDir = await secureArchive(dir);

		const archivePath = join(archiveDir, `${located.id}.md`);
		const current = await lstat(located.path);
		if (current.isSymbolicLink() || !current.isFile()) throw new Error("stash target is no longer a regular file");
		if (current.dev !== prefix.identity.dev || current.ino !== prefix.identity.ino) {
			throw new Error("stash target changed before rotation; retry the operation");
		}
		// Pin and verify the inode under a private name before final publication.
		// A source-path replacement must not reserve the archive name with an
		// unverified inode. Cleanup owns only this temporary link, never the archive.
		const temporary = join(archiveDir, `.${located.id}.${randomUUID()}.tmp`);
		await publishArchive(located.id, located.path, archivePath, temporary, prefix.identity);
		return { id: located.id, path: located.path, archivePath, state };
	});
}
