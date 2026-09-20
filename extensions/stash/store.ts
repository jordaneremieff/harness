/** Filesystem persistence for durable stash artifacts. */

import { randomUUID } from "node:crypto";
import { constants, type Dirent, type Stats } from "node:fs";
import { chmod, type FileHandle, link, lstat, mkdir, open, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
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
import { redactSecrets } from "./redact.ts";

const HEADER_SCAN_BYTES = 16 * 1024;
const MAX_STASH_BYTES = 256 * 1024;
const SAFE_STEM = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;

/** Dot-hidden sibling of the store that receives rotated artifacts. */
export const ROTATED_STORE_NAME = ".trash";

interface StashInput {
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

export interface StashEntry {
	meta: StashMeta;
	path: string;
	/** Body-only prefix used by the interactive browser. */
	preview?: string;
	previewTruncated?: boolean;
	previewError?: string;
}

export function resolveStoreDir(env: NodeJS.ProcessEnv = process.env, agentDir?: string): string {
	if (env.PI_STASH_DIR) return env.PI_STASH_DIR;
	return join(agentDir ?? join(homedir(), ".pi", "agent"), "stash");
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
async function openRegular(path: string): Promise<{ handle: FileHandle; info: Stats }> {
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

/**
 * Enforce directory privacy on every touch and sweep artifact permissions once
 * per process. Subsequent reads enforce 0600 on each opened regular artifact;
 * writes publish at 0600. The cached sweep avoids repeated linear hardening
 * without weakening the per-touch directory and per-read file checks.
 */
async function secureStore(dir: string, create: boolean): Promise<Dirent[] | null> {
	if (create) await mkdir(dir, { recursive: true, mode: 0o700 });
	try {
		const info = await lstat(dir);
		if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`stash store is not a regular directory: ${dir}`);
		if ((info.mode & 0o7777) !== 0o700) await chmod(dir, 0o700);
	} catch (error) {
		if (!create && hasCode(error, "ENOENT")) return null;
		throw error;
	}

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

/** Write a fully materialized artifact with an atomic, no-clobber link. */
export async function writeStash(
	dir: string,
	input: StashInput,
	now: Date = new Date(),
): Promise<{ record: StashRecord; path: string }> {
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
		if (await publishArtifact(temporary, path, serialized)) return { record, path };
	}
	throw new Error(`could not allocate a unique stash id for ${baseId}`);
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

function normalizeMeta(name: string, parsed: Partial<StashMeta> & Record<string, unknown>): StashMeta {
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
	| { ok: true; id: string; path: string; content: string }
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
		const artifact = await readPrefix(located.path, MAX_STASH_BYTES);
		if (artifact.truncated) {
			return {
				ok: false,
				error: `stash ${located.id} is ${artifact.size} bytes; maximum readable size is ${MAX_STASH_BYTES}`,
			};
		}
		return { ...located, content: artifact.text };
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
	id: string;
	path: string;
	content: string;
	meta: StashMeta;
	changed: boolean;
}

async function readMutationSource(path: string): Promise<{
	content: string;
	identity: { dev: number; ino: number };
}> {
	const { handle, info } = await openRegular(path);
	try {
		const before = info;
		if ((before.mode & 0o7777) !== 0o600) await handle.chmod(0o600);
		if (before.size > MAX_STASH_BYTES) {
			throw new Error(`stash is ${before.size} bytes; maximum mutable size is ${MAX_STASH_BYTES}`);
		}
		const buffer = Buffer.alloc(MAX_STASH_BYTES + 1);
		let offset = 0;
		while (offset < buffer.length) {
			const result = await handle.read(buffer, offset, buffer.length - offset, offset);
			if (result.bytesRead === 0) break;
			offset += result.bytesRead;
		}
		const after = await handle.stat();
		if (offset > MAX_STASH_BYTES || after.size > MAX_STASH_BYTES) {
			throw new Error(`stash exceeds the maximum mutable size of ${MAX_STASH_BYTES} bytes`);
		}
		if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || after.size !== offset) {
			throw new Error("stash changed while its lifecycle metadata was being read; retry the operation");
		}
		return {
			content: buffer.subarray(0, offset).toString("utf8"),
			identity: { dev: after.dev, ino: after.ino },
		};
	} finally {
		await handle.close();
	}
}

function currentState(meta: Partial<StashMeta> & Record<string, unknown>): StashState {
	if (!isStashState(meta.state)) throw new Error(`stash has invalid lifecycle state: ${String(meta.state)}`);
	return meta.state;
}

function completionOutcome(raw: string): string {
	const outcome = redactSecrets(raw.trim());
	if (!outcome) throw new Error("stash completion outcome must not be empty");
	if (outcome.length > 20_000) throw new Error("stash completion outcome exceeds 20000 characters");
	return outcome;
}

function lifecyclePatch(
	id: string,
	state: StashState,
	change: StashLifecycleChange,
	stamp: string,
): Record<string, unknown> | null {
	if (change.action === "activate") {
		if (state === "closed") throw new Error(`stash ${id} is closed; reopen it before pickup`);
		if (state === "active") return null;
		return { state: "active", activatedAt: stamp, closedAt: undefined, outcome: undefined };
	}
	if (change.action === "close") {
		const outcome = completionOutcome(change.outcome);
		if (state !== "active") throw new Error(`stash ${id} must be active before it can be closed (state: ${state})`);
		return { state: "closed", closedAt: stamp, outcome };
	}
	if (change.action === "release") {
		if (state !== "active") throw new Error(`stash ${id} can be released only from active state (state: ${state})`);
		return { state: "open", activatedAt: undefined };
	}
	if (state !== "closed") throw new Error(`stash ${id} can be reopened only from closed state (state: ${state})`);
	return { state: "open", closedAt: undefined, outcome: undefined };
}

/** Atomically rewrite only lifecycle frontmatter after rechecking the regular-file target. */
export async function transitionStash(
	dir: string,
	idOrPrefix: string,
	change: StashLifecycleChange,
	now: Date = new Date(),
): Promise<StashTransitionResult> {
	const dirents = await secureStore(dir, false);
	if (!dirents) throw new Error(`stash store not found: ${dir}`);
	const located = locateArtifact(dir, dirents, idOrPrefix);
	if ("error" in located) {
		const candidates = located.candidates?.length ? ` Candidates: ${located.candidates.join(", ")}.` : "";
		throw new Error(`${located.error}.${candidates}`);
	}
	const source = await readMutationSource(located.path);
	const parsed = parseFrontmatter(source.content);
	// The full content is read here, so the unclosed-header check runs on the
	// whole artifact, not the bounded scan window: a header that closes beyond
	// 16 KiB stays readable, while a header that never closes is UNKNOWN and
	// must not be mutated as if it were a verified state.
	if (headerUnclosed(source.content)) {
		throw new Error(
			`stash ${located.id} has a header that never closes; its state cannot be verified for lifecycle changes`,
		);
	}
	const state = currentState(parsed.meta);
	const stamp = utcTimestamp(now);
	const patch = lifecyclePatch(located.id, state, change, stamp);
	if (!patch) {
		return {
			...located,
			content: source.content,
			meta: normalizeMeta(`${located.id}.md`, parsed.meta),
			changed: false,
		};
	}

	const content = updateFrontmatter(source.content, patch);
	const bytes = Buffer.byteLength(content, "utf8");
	if (bytes > MAX_STASH_BYTES) throw new Error(`updated stash is ${bytes} bytes; maximum is ${MAX_STASH_BYTES}`);
	const temporary = join(dir, `.${located.id}.${randomUUID()}.tmp`);
	let published = false;
	try {
		await writeFile(temporary, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
		await chmod(temporary, 0o600);
		const current = await lstat(located.path);
		if (current.isSymbolicLink() || !current.isFile()) throw new Error("stash target is no longer a regular file");
		if (current.dev !== source.identity.dev || current.ino !== source.identity.ino) {
			throw new Error("stash target changed before lifecycle publication; retry the operation");
		}
		await rename(temporary, located.path);
		published = true;
	} finally {
		await cleanTemporary(temporary, published);
	}
	return {
		...located,
		content,
		meta: normalizeMeta(`${located.id}.md`, parseFrontmatter(content).meta),
		changed: true,
	};
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

/**
 * Operator-initiated rotation: retain an open or closed artifact under
 * the dot-hidden archive subdirectory (`.trash`). Rotated artifacts disappear
 * from discovery, listing, pickup, and lifecycle changes, but the file is
 * retained byte-for-byte and restoring it is a plain move back into the store.
 * Active artifacts are excluded: a live session owns them and completion is the
 * only close path. Only the bounded header is read for eligibility, so oversized
 * artifacts remain rotatable. A private temporary link pins the verified inode
 * before exclusive archive publication; source removal follows publication.
 */
export async function rotateStash(dir: string, idOrPrefix: string): Promise<StashRotateResult> {
	const dirents = await secureStore(dir, false);
	if (!dirents) throw new Error(`stash store not found: ${dir}`);
	const located = locateArtifact(dir, dirents, idOrPrefix);
	if ("error" in located) {
		const candidates = located.candidates?.length ? ` Candidates: ${located.candidates.join(", ")}.` : "";
		throw new Error(`${located.error}.${candidates}`);
	}

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
	const state = currentState(parseFrontmatter(prefix.text).meta);
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
}
