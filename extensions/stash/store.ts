/** Filesystem persistence for durable stash artifacts. */

import { randomUUID } from "node:crypto";
import { constants, type Dirent, type Stats } from "node:fs";
import { chmod, link, lstat, mkdir, open, readdir, rename, unlink, writeFile, type FileHandle } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	isStashState,
	parseFrontmatter,
	serializeArtifact,
	slugify,
	updateFrontmatter,
	utcTimestamp,
	type StashMeta,
	type StashRecord,
	type StashState,
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
	const handle = await open(path, constants.O_RDONLY | noFollow);
	try {
		const info = await handle.stat();
		if (!info.isFile()) throw new Error(`not a regular file: ${path}`);
		return { handle, info };
	} catch (error) {
		await handle.close();
		throw error;
	}
}

/**
 * Make the store private on every touch, including stores created by an older
 * version, while keeping the per-operation cost O(1) in artifact count: modes
 * are only rewritten when they differ from the expected private modes. Symlinks
 * are ignored rather than followed.
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
	for (const entry of artifactDirents(dirents)) {
		try {
			const { handle, info } = await openRegular(join(dir, entry.name));
			try {
				// Hardening for stores written before artifacts were published at
				// 0600; artifacts already at 0600 (everything written by current
				// code) skip the redundant chmod.
				if ((info.mode & 0o7777) !== 0o600) await handle.chmod(0o600);
			} finally {
				await handle.close();
			}
		} catch (error) {
			if (!hasCode(error, "ENOENT") && !hasCode(error, "ELOOP")) throw error;
		}
	}
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
		let published = false;
		try {
			await writeFile(temporary, serialized, { encoding: "utf8", flag: "wx", mode: 0o600 });
			await chmod(temporary, 0o600);
			try {
				await link(temporary, path);
			} catch (error) {
				if (hasCode(error, "EEXIST")) continue;
				throw error;
			}
			// A hard link shares the already-enforced 0600 mode with the completed
			// temporary inode, so no fallible metadata step remains after publish.
			published = true;
			return { record, path };
		} finally {
			try {
				await unlink(temporary);
			} catch (error) {
				// Do not turn a successful publish into a reported failure that could
				// prompt a duplicate retry. Any orphan remains private and dot-hidden.
				// biome-ignore lint/correctness/noUnsafeFinally: guarded rethrow after publish failure
				if (!published && !hasCode(error, "ENOENT")) throw error;
			}
		}
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
 * trims to "---". The parser cannot tell an unclosed header from a legacy
 * artifact with no header at all, and the difference matters: an unread header
 * means the state is UNKNOWN, not the default "open". Treating it as open
 * would let a state filter report an active effort as open and let rotation
 * move it to the trash.
 */
function headerUnclosed(text: string): boolean {
	const lines = text.split("\n");
	if (lines[0]?.trim() !== "---") return false;
	return !lines.slice(1).some((line) => line.trim() === "---");
}

async function readPrefix(path: string, maxBytes: number): Promise<{ text: string; truncated: boolean; size: number }> {
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
		// An ABSENT state is legacy `open`. A present-but-unrecognized value is not:
		// every transition rejects it, so it must not be presented as usable.
		state: isStashState(parsed.state) ? parsed.state : "open",
		invalidState: parsed.state !== undefined && !isStashState(parsed.state) ? String(parsed.state) : undefined,
		activatedAt: typeof parsed.activatedAt === "string" ? parsed.activatedAt : undefined,
		closedAt: typeof parsed.closedAt === "string" ? parsed.closedAt : undefined,
		outcome: typeof parsed.outcome === "string" ? parsed.outcome : undefined,
	};
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
		const path = join(dir, name);
		let meta = normalizeMeta(name, {});
		let preview: string | undefined;
		let previewTruncated: boolean | undefined;
		let previewError: string | undefined;
		try {
			const previewBytes = Math.min(MAX_STASH_BYTES - HEADER_SCAN_BYTES, Math.max(0, options.previewBytes ?? 0));
			const prefix = await readPrefix(path, HEADER_SCAN_BYTES + previewBytes);
			// The lifecycle decision always uses the bounded header window, no
			// matter how much preview was requested, so every consumer sees the
			// same state for the same artifact (a header closing beyond the
			// window is unverified everywhere, including the browser).
			const headerPrefix = previewBytes > 0 ? await readPrefix(path, HEADER_SCAN_BYTES) : prefix;
			if (headerUnclosed(headerPrefix.text)) {
				throw new Error(
					headerPrefix.truncated
						? `artifact header is longer than the ${HEADER_SCAN_BYTES}-byte scan window; its state cannot be verified`
						: "artifact header never closes; its state cannot be verified",
				);
			}
			const parsed = parseFrontmatter(prefix.text);
			meta = normalizeMeta(name, parsed.meta);
			if (options.previewBytes !== undefined) {
				const bodyPrefix = utf8BodyPrefix(parsed.body, previewBytes);
				preview = bodyPrefix.text;
				previewTruncated = prefix.truncated || bodyPrefix.truncated;
			}
		} catch (error) {
			previewError = error instanceof Error ? error.message : String(error);
		}
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
		entries.push({ meta, path, preview, previewTruncated, previewError });
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

/** Read one regular artifact by exact id or unique id prefix. */
export async function readStash(dir: string, idOrPrefix: string): Promise<ReadResult> {
	const dirents = await secureStore(dir, false);
	if (!dirents) return { ok: false, error: `stash store not found: ${dir}` };
	const located = locateArtifact(dir, dirents, idOrPrefix);
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
	if (meta.state === undefined) return "open";
	if (!isStashState(meta.state)) throw new Error(`stash has invalid lifecycle state: ${String(meta.state)}`);
	return meta.state;
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
	let patch: Record<string, unknown | undefined>;

	if (change.action === "activate") {
		if (state === "closed") throw new Error(`stash ${located.id} is closed; reopen it before pickup`);
		if (state === "active") {
			return {
				...located,
				content: source.content,
				meta: normalizeMeta(`${located.id}.md`, parsed.meta),
				changed: false,
			};
		}
		patch = { state: "active", activatedAt: stamp, closedAt: undefined, outcome: undefined };
	} else if (change.action === "close") {
		// The outcome is operator/model-authored text stored durably; the same
		// deterministic redaction applies so a credential cannot enter an
		// artifact through the lifecycle path either.
		const outcome = redactSecrets(change.outcome.trim());
		if (!outcome) throw new Error("stash completion outcome must not be empty");
		if (outcome.length > 20_000) throw new Error("stash completion outcome exceeds 20000 characters");
		if (state !== "active")
			throw new Error(`stash ${located.id} must be active before it can be closed (state: ${state})`);
		patch = { state: "closed", closedAt: stamp, outcome };
	} else if (change.action === "release") {
		// The inverse of pickup: an active effort whose owning session died or
		// polluted its context returns to pristine open, so a fresh session picks
		// it up without reconciling a phantom predecessor. Nothing durable is
		// lost — the artifact body is untouched and pickup is one action away.
		if (state !== "active")
			throw new Error(`stash ${located.id} can be released only from active state (state: ${state})`);
		patch = { state: "open", activatedAt: undefined };
	} else {
		if (state !== "closed")
			throw new Error(`stash ${located.id} can be reopened only from closed state (state: ${state})`);
		patch = { state: "open", closedAt: undefined, outcome: undefined };
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
		try {
			await unlink(temporary);
		} catch (error) {
			// biome-ignore lint/correctness/noUnsafeFinally: guarded rethrow after publish failure
			if (!hasCode(error, "ENOENT") && !published) throw error;
		}
	}
	return {
		...located,
		content,
		meta: normalizeMeta(`${located.id}.md`, parseFrontmatter(content).meta),
		changed: true,
	};
}

/**
 * Operator-initiated rotation: atomically move an open or closed artifact into
 * the dot-hidden archive subdirectory (`.trash`). Rotated artifacts disappear
 * from discovery, listing, pickup, and lifecycle changes, but the file is
 * retained byte-for-byte and restoring it is a plain move back into the store.
 * Active artifacts are excluded: a live session owns them and completion is the
 * only close path. The content itself is never read, so oversized historical
 * artifacts remain rotatable; only the bounded header is read for eligibility.
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

	// Capture the exact regular-file identity under O_NOFOLLOW so the rename
	// cannot be redirected onto a different file in the window before publish.
	let identity: { dev: number; ino: number };
	{
		const { handle, info } = await openRegular(located.path);
		try {
			identity = { dev: info.dev, ino: info.ino };
		} finally {
			await handle.close();
		}
	}

	const archiveDir = join(dir, ROTATED_STORE_NAME);
	await mkdir(archiveDir, { recursive: true, mode: 0o700 });
	const archiveInfo = await lstat(archiveDir);
	if ((archiveInfo.mode & 0o7777) !== 0o700) await chmod(archiveDir, 0o700);

	const archivePath = join(archiveDir, `${located.id}.md`);
	// A previous archive of the same id must never be silently replaced; the
	// operator can restore and re-rotate only after removing the old archive.
	try {
		await lstat(archivePath);
		throw new Error(`stash ${located.id} is already rotated`);
	} catch (error) {
		if (!hasCode(error, "ENOENT")) throw error;
	}

	const current = await lstat(located.path);
	if (current.isSymbolicLink() || !current.isFile()) throw new Error("stash target is no longer a regular file");
	if (current.dev !== identity.dev || current.ino !== identity.ino) {
		throw new Error("stash target changed before rotation; retry the operation");
	}
	await rename(located.path, archivePath);
	return { id: located.id, path: located.path, archivePath, state };
}
