import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, opendir, rename, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import lockfile from "proper-lockfile";
import {
	isRelativePath,
	locateReviewPosition,
	pinNoteReview,
	readReviewAnchor,
	readReviewDiff,
	type Repo,
	type ResolvedScope,
	type ReviewScope,
	type ReviewSide,
	resolveAnchor,
	resolveScope,
	validScope,
	verifyNoteFile,
} from "./repository.ts";

type State = "draft" | "open" | "sent" | "answered" | "resolved";
type LocalAuthor = "operator" | "agent";
type Author = LocalAuthor | "remote";
type Anchor = {
	start: number;
	end: number;
	commit: string | null;
	quote: string;
};
type ThreadEntry = {
	id: string;
	author: Author;
	by?: string;
	text: string;
	at: string;
};
type RemoteReply = { by: string; text: string; at?: string };
type RemoteComment = RemoteReply & {
	id: string;
	path?: string;
	start?: number;
	end?: number;
	side?: ReviewSide;
	commit?: string;
	url?: string;
	resolved?: boolean;
	replies?: RemoteReply[];
};
export type NoteTarget =
	| { kind: "file"; path: string; side?: ReviewSide }
	| { kind: "commit"; commit: string }
	| { kind: "review"; review: ReviewScope };
type NoteCommon = {
	author: Author;
	state: State;
	text: string;
	title?: string;
	url?: string;
	reviewKey?: string;
};
export type CreateLineNote = NoteCommon &
	Anchor & {
		path: string;
		side: ReviewSide;
		author: LocalAuthor;
		state: "draft" | "open" | "sent";
	};
export type CreateTargetNote = NoteCommon & {
	target: NoteTarget;
	author: LocalAuthor;
	state: "draft" | "open" | "sent";
};
export type CreateNote = CreateLineNote | CreateTargetNote;
type StoredCommon = NoteCommon & {
	by?: string;
	external?: string;
	id: string;
	thread: ThreadEntry[];
	requestId?: string;
	createdAt: string;
	updatedAt: string;
};
export type StoredLineNote = Omit<StoredCommon, "author" | "state"> & {
	author: Author;
	state: State;
	path: string;
	side: ReviewSide;
	anchor: Anchor;
};
export type StoredTargetNote = Omit<StoredCommon, "author" | "state"> & {
	author: Author;
	state: State;
	target: NoteTarget;
};
export type StoredNote = StoredLineNote | StoredTargetNote;
type NoteLocation = Pick<StoredLineNote, "path" | "side" | "anchor"> | Pick<StoredTargetNote, "target">;
type ImportItem = { comment: RemoteComment; location: NoteLocation };
type ImportSkip = { id: string; reason: string };
export type Note =
	| (StoredLineNote & {
			start: number;
			end: number;
			location: "same" | "moved" | "outdated";
			movedFrom?: number;
	  })
	| StoredTargetNote;
type Finished = { head: string; at: string };
type Review = {
	version: 1;
	key: string;
	viewed: string[];
	finished?: Finished;
};
type Markers = { version: 1; branches: Record<string, Finished> };
type RecentRoot = { path: string; label: string };
type Recents = { version: 1; roots: RecentRoot[] };
type Fields = Record<string, unknown>;
type WritePlan = () => Promise<{
	note?: StoredNote;
	notes?: StoredNote[];
	fields?: Fields;
}>;
type ErrorCode = "invalid" | "not-found" | "conflict" | "busy" | "store-failure";
export class NotesError extends Error {
	readonly code: ErrorCode;
	constructor(code: ErrorCode, message: string) {
		super(message);
		this.name = "NotesError";
		this.code = code;
	}
}

const MiB = 1024 * 1024;
const MAX_RECORD = 2 * MiB;
const MAX_LOOKUP_BYTES = 24 * MiB;
const MAX_RESULT = 15 * MiB;
const MAX_ENTRIES = 4096;
const MAX_BATCH = 100;
const MAX_RECENTS = 32;
const MAX_THREAD = 256;
const NOTE_ID = /^n-[0-9a-f]{20}$/u;
const ENTRY_ID = /^r-[0-9a-f]{20}$/u;
const HASH = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const REVIEW_KEY =
	/^(?:worktree@(?:empty|[0-9a-f]{40}|[0-9a-f]{64})|(?:empty|[0-9a-f]{40}|[0-9a-f]{64})\.\.(?:[0-9a-f]{40}|[0-9a-f]{64}))$/u;
const WRITE_OPS = new Set(["create", "import", "update", "reply", "state", "delete", "review-set", "remember"]);
const READ_OPS = new Set(["list", "read", "export", "review-get", "marker"]);
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const id = (prefix: string) => `${prefix}-${randomBytes(10).toString("hex")}`;
const now = () => new Date().toISOString();
const nextVersion = (updatedAt: string) => new Date(Math.max(Date.now(), Date.parse(updatedAt) + 1)).toISOString();
const missing = (error: unknown) => object(error) && error.code === "ENOENT";
const message = (code: ErrorCode, text: string): never => {
	throw new NotesError(code, text);
};
function check(condition: unknown, text: string): asserts condition {
	if (!condition) message("invalid", text);
}
function object(value: unknown): value is Fields {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function string(value: unknown, max: number, nonblank = true): value is string {
	return (
		typeof value === "string" && value.length <= max && !/[\uD800-\uDFFF]/u.test(value) && (!nonblank || !!value.trim())
	);
}
function matches(value: unknown, pattern: RegExp): value is string {
	return typeof value === "string" && pattern.exec(value)?.[0] === value;
}
function path(value: unknown): value is string {
	return string(value, 4096) && isRelativePath(value);
}
export function absoluteStorePath(value: unknown): value is string {
	return string(value, 4096) && !value.includes("\0") && isAbsolute(value);
}
function line(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 2_147_483_647;
}
function date(value: unknown): value is string {
	return (
		matches(value, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u) &&
		Number.isFinite(Date.parse(value)) &&
		new Date(value).toISOString() === value
	);
}
function localAuthor(value: unknown): value is LocalAuthor {
	return value === "agent" || value === "operator";
}
function name(value: unknown): value is string {
	return string(value, 200) && !/[\p{Cc}]/u.test(value);
}
function url(value: unknown): value is string {
	if (!string(value, 2048) || !/^https?:\/\//iu.test(value) || /[\s\p{Cc}]/u.test(value)) return false;
	return URL.canParse(value);
}
function commentText(value: unknown): value is string {
	return string(value, 16384);
}
function remoteReply(value: unknown): value is RemoteReply {
	return (
		object(value) &&
		name(value.by) &&
		commentText(value.text) &&
		(value.at === undefined ||
			(string(value.at, 40) &&
				/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/u.test(value.at) &&
				Number.isFinite(Date.parse(value.at))))
	);
}
function remoteComment(value: unknown): value is RemoteComment {
	return (
		object(value) &&
		name(value.id) &&
		name(value.by) &&
		commentText(value.text) &&
		(value.path === undefined || path(value.path)) &&
		(value.start === undefined || line(value.start)) &&
		(value.end === undefined || line(value.end)) &&
		(value.side === undefined || value.side === "base" || value.side === "head") &&
		(value.commit === undefined || string(value.commit, 512)) &&
		(value.url === undefined || url(value.url)) &&
		(value.resolved === undefined || typeof value.resolved === "boolean") &&
		(value.replies === undefined ||
			(Array.isArray(value.replies) && value.replies.length <= 64 && value.replies.every(remoteReply)))
	);
}
function state(value: unknown): value is State {
	return value === "draft" || value === "open" || value === "sent" || value === "answered" || value === "resolved";
}
function branch(value: unknown): value is string {
	return string(value, 1024) && !/[\u0000-\u0020\u007f]/u.test(value);
}
function requestId(value: unknown): value is string {
	return string(value, 256) && !/[\u0000-\u0020\u007f]/u.test(value);
}
function title(value: unknown): value is string {
	return string(value, 200);
}
function text(value: unknown): value is string {
	return string(value, 128 * 1024);
}
function anchor(value: unknown): value is Anchor {
	return (
		object(value) &&
		line(value.start) &&
		line(value.end) &&
		value.end >= value.start &&
		(value.commit === null || matches(value.commit, HASH)) &&
		string(value.quote, MiB, false)
	);
}
function noteTarget(value: unknown): value is NoteTarget {
	if (!object(value)) return false;
	const keys = Object.keys(value);
	if (value.kind === "file")
		return (
			(keys.length === 2 || (keys.length === 3 && value.side !== undefined)) &&
			path(value.path) &&
			(value.side === undefined || value.side === "base" || value.side === "head")
		);
	if (value.kind === "commit") return keys.length === 2 && matches(value.commit, HASH);
	if (value.kind === "review") return keys.length === 2 && validScope(value.review);
	return false;
}
function noteCommon(value: Fields): boolean {
	return (
		text(value.text) &&
		(value.title === undefined || title(value.title)) &&
		(value.url === undefined || url(value.url)) &&
		(value.reviewKey === undefined || matches(value.reviewKey, REVIEW_KEY))
	);
}
function createNote(value: unknown): value is CreateNote {
	if (!object(value) || !noteCommon(value) || !localAuthor(value.author)) return false;
	if (value.state !== "draft" && value.state !== "open" && value.state !== "sent") return false;
	if (value.target !== undefined)
		return (
			noteTarget(value.target) &&
			value.path === undefined &&
			value.side === undefined &&
			value.anchor === undefined &&
			value.start === undefined &&
			value.end === undefined &&
			value.commit === undefined &&
			value.quote === undefined
		);
	return (
		path(value.path) &&
		(value.side === "head" || value.side === "base") &&
		anchor(value) &&
		value.start !== undefined &&
		value.end !== undefined
	);
}
function lineStored(value: Fields): boolean {
	return (
		path(value.path) &&
		(value.side === "head" || value.side === "base") &&
		anchor(value.anchor) &&
		value.target === undefined &&
		!("start" in value || "end" in value || "location" in value || "movedFrom" in value)
	);
}
function targetStored(value: Fields): boolean {
	return (
		noteTarget(value.target) &&
		!("path" in value || "side" in value || "anchor" in value || "start" in value || "end" in value)
	);
}
function entry(value: unknown): value is ThreadEntry {
	return (
		object(value) &&
		matches(value.id, ENTRY_ID) &&
		text(value.text) &&
		date(value.at) &&
		(value.author === "remote"
			? name(value.by)
			: localAuthor(value.author) && (value.by === undefined || name(value.by)))
	);
}
function storedNote(value: unknown, expectedId: string): value is StoredNote {
	return (
		object(value) &&
		value.id === expectedId &&
		noteCommon(value) &&
		state(value.state) &&
		(value.author === "remote"
			? name(value.by) && name(value.external)
			: localAuthor(value.author) && value.by === undefined && value.external === undefined) &&
		date(value.createdAt) &&
		date(value.updatedAt) &&
		(value.requestId === undefined || requestId(value.requestId)) &&
		(lineStored(value) || targetStored(value)) &&
		Array.isArray(value.thread) &&
		value.thread.length <= MAX_THREAD &&
		value.thread.every(entry)
	);
}
function idList(value: unknown, limit: number): value is string[] {
	return (
		Array.isArray(value) &&
		value.length > 0 &&
		value.length <= limit &&
		value.every((item) => matches(item, NOTE_ID)) &&
		new Set(value).size === value.length
	);
}
function finished(value: unknown): value is Finished {
	return object(value) && matches(value.head, HASH) && date(value.at);
}
function viewed(value: unknown): value is string[] {
	return Array.isArray(value) && value.length <= 20_000 && value.every(path);
}
function reviewRecord(value: unknown, key: string): value is Review {
	return (
		object(value) &&
		value.version === 1 &&
		value.key === key &&
		viewed(value.viewed) &&
		(value.finished === undefined || finished(value.finished))
	);
}
function markerRecord(value: unknown): value is Markers {
	return (
		object(value) &&
		value.version === 1 &&
		object(value.branches) &&
		Object.entries(value.branches).every(([name, mark]) => branch(name) && finished(mark))
	);
}
function recentRecord(value: unknown): value is Recents {
	return (
		object(value) &&
		value.version === 1 &&
		Array.isArray(value.roots) &&
		value.roots.length <= MAX_RECENTS &&
		value.roots.every((row) => object(row) && absoluteStorePath(row.path) && string(row.label, 4096))
	);
}
function currentRecord(note: StoredNote): StoredNote {
	const { id, author, text, title, url, reviewKey, by, external, state, thread, requestId, createdAt, updatedAt } =
		note;
	const common = {
		id,
		author,
		text,
		title,
		url,
		reviewKey,
		by,
		external,
		state,
		thread,
		requestId,
		createdAt,
		updatedAt,
	};
	if ("target" in note) return { ...common, target: note.target };
	return { ...common, path: note.path, side: note.side, anchor: note.anchor };
}

// Distinguish missing from corrupt records so a write never repairs corruption as a side effect.
const corrupt = Symbol("corrupt");
async function readRecord(file: string): Promise<{ value: unknown; bytes: number }> {
	let handle: Awaited<ReturnType<typeof open>> | undefined;
	try {
		handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
		const stat = await handle.stat();
		if (!stat.isFile() || stat.size > MAX_RECORD) return { value: corrupt, bytes: 0 };
		const buffer = Buffer.allocUnsafe(stat.size + 1);
		let size = 0;
		while (size < buffer.length) {
			const { bytesRead } = await handle.read(buffer, size, buffer.length - size, size);
			if (!bytesRead) break;
			size += bytesRead;
		}
		if (size !== stat.size) return { value: corrupt, bytes: size };
		try {
			return {
				value: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, size))),
				bytes: size,
			};
		} catch {
			return { value: corrupt, bytes: size };
		}
	} catch (error) {
		return { value: missing(error) ? undefined : corrupt, bytes: 0 };
	} finally {
		await handle?.close();
	}
}
async function directory(dir: string, create: boolean): Promise<boolean> {
	if (create) await mkdir(dir, { recursive: true, mode: 0o700 });
	try {
		if ((await lstat(dir)).isDirectory()) return true;
		return message("store-failure", "An Explorer store directory is not a directory.");
	} catch (error) {
		if (!create && missing(error)) return false;
		throw error;
	}
}
function serialise(value: unknown): string {
	const data = `${JSON.stringify(value)}\n`;
	if (Buffer.byteLength(data) > MAX_RECORD) message("conflict", "The Explorer record exceeds its size limit.");
	return data;
}
async function replace(file: string, data: string) {
	const temp = join(dirname(file), `.${id("write")}.tmp`);
	const handle = await open(temp, "wx", 0o600);
	try {
		try {
			await handle.writeFile(data);
		} finally {
			await handle.close();
		}
		await rename(temp, file);
	} finally {
		await unlink(temp).catch(() => {});
	}
}

export async function recentRoots(dir: string): Promise<RecentRoot[]> {
	if (!absoluteStorePath(dir) || !(await directory(resolve(dir), false))) return [];
	const { value } = await readRecord(join(dir, "recents.json"));
	return recentRecord(value) ? value.roots.map(({ path, label }) => ({ path, label })) : [];
}

function importThread(comment: RemoteComment, previous: StoredNote | undefined, noteId: string, at: string) {
	const local = previous?.thread.filter((reply) => reply.author !== "remote") ?? [];
	const remote = new Map(
		previous?.thread.filter((reply) => reply.author === "remote").map((reply) => [reply.id, reply.at]),
	);
	const occurrences = new Map<string, number>();
	const thread = (comment.replies ?? []).map(({ by, text, at: sourceTime }): ThreadEntry => {
		const signature = hash(JSON.stringify([by, text, sourceTime]));
		const index = occurrences.get(signature) ?? 0;
		occurrences.set(signature, index + 1);
		const entryId = `r-${hash(`${noteId}:${signature}:${index}`).slice(0, 20)}`;
		return {
			id: entryId,
			author: "remote",
			by,
			text,
			at: sourceTime ? new Date(sourceTime).toISOString() : (remote.get(entryId) ?? at),
		};
	});
	thread.push(...local);
	thread.sort((a, b) => a.at.localeCompare(b.at));
	return thread;
}

function importReason(error: unknown) {
	if (object(error) && error.code === "ENOENT") return "The review file is missing.";
	return error instanceof Error ? error.message : "The comment could not be anchored.";
}
function importedRecord(key: string, item: ImportItem, previous: StoredNote | undefined, at: string): StoredNote {
	const { comment, location } = item;
	const noteId = previous?.id ?? id("n");
	return {
		...location,
		id: noteId,
		author: "remote",
		by: comment.by,
		external: comment.id,
		url: comment.url,
		state: comment.resolved ? "resolved" : "open",
		text: comment.text,
		title: previous?.title,
		reviewKey: key,
		thread: importThread(comment, previous, noteId, at),
		requestId: previous?.requestId,
		createdAt: previous?.createdAt ?? at,
		updatedAt: previous ? nextVersion(previous.updatedAt) : at,
	};
}
function editNote(note: StoredNote, expected: string, agentOnly: boolean, body?: string, heading?: string | null) {
	if (agentOnly && note.author !== "agent") message("conflict", "Only agent notes can be updated by this tool.");
	if (note.author === "remote") message("conflict", "Remote note text is mirrored and cannot be changed.");
	if (note.updatedAt !== expected) message("conflict", "The note changed since it was read.");
	if (body !== undefined) note.text = body;
	if (heading !== undefined) note.title = heading ?? undefined;
}

export class NotesStore {
	private readonly dir: string;
	private readonly key: string;
	private readonly repoDir: string;
	private readonly repo: Repo;
	constructor(dir: string, repo: Repo) {
		check(absoluteStorePath(dir), "The Explorer store path must be absolute.");
		this.repo = repo;
		this.dir = resolve(dir);
		this.key = hash(repo.identity).slice(0, 32);
		this.repoDir = join(this.dir, "repos", this.key);
	}

	private async init(write: boolean): Promise<"ready" | "empty" | "unreadable"> {
		const rootFile = join(this.dir, "store.json");
		if (!(await directory(this.dir, write))) return "empty";
		const root = (await readRecord(rootFile)).value;
		if (write && root === undefined)
			await replace(rootFile, serialise({ version: 1, storeId: randomBytes(16).toString("hex") }));
		else if (root === undefined) return "empty";
		else if (!object(root) || root.version !== 1 || !matches(root.storeId, /^[0-9a-f]{32}$/u)) {
			if (write) return message("store-failure", "The Explorer store record is unreadable.");
			return "unreadable";
		}
		return this.initRepo(write);
	}

	private async initRepo(write: boolean): Promise<"ready" | "empty" | "unreadable"> {
		if (!(await directory(join(this.dir, "repos"), write)) || !(await directory(this.repoDir, write))) return "empty";
		const repoFile = join(this.repoDir, "repo.json");
		const repo = (await readRecord(repoFile)).value;
		if (write && repo === undefined) {
			await replace(
				repoFile,
				serialise({
					version: 1,
					key: this.key,
					kind: this.repo.kind,
					identity: this.repo.identity,
					label: this.repo.label,
					createdAt: now(),
				}),
			);
		} else if (repo === undefined) return "empty";
		else if (
			!object(repo) ||
			repo.version !== 1 ||
			repo.key !== this.key ||
			repo.kind !== this.repo.kind ||
			repo.identity !== this.repo.identity ||
			!string(repo.label, 4096) ||
			!date(repo.createdAt)
		) {
			if (write) return message("store-failure", "The Explorer repository record is unreadable.");
			return "unreadable";
		}
		return "ready";
	}

	private async locked<T>(work: () => Promise<T>): Promise<T> {
		await directory(this.dir, true);
		let compromise: Error | undefined;
		let release: () => Promise<void>;
		try {
			release = await lockfile.lock(this.dir, {
				retries: { retries: 7, minTimeout: 20, maxTimeout: 160 },
				onCompromised(error) {
					compromise = error;
				},
			});
		} catch (error) {
			if (object(error) && error.code === "ELOCKED") return message("busy", "The Explorer store is busy.");
			throw error;
		}
		try {
			const value = await work();
			if (compromise) throw compromise;
			return value;
		} finally {
			await release();
		}
	}

	private file(area: "notes" | "reviews", name: string) {
		return join(this.repoDir, area, `${name}.json`);
	}
	private async note(id: string): Promise<StoredNote> {
		const { value } = (await directory(join(this.repoDir, "notes"), false))
			? await readRecord(this.file("notes", id))
			: { value: undefined };
		if (!storedNote(value, id)) return message("not-found", "The Explorer note is missing or unreadable.");
		return currentRecord(value);
	}
	private resolve(note: StoredNote): Promise<Note> {
		if ("target" in note) return Promise.resolve(note);
		if (note.reviewKey && (note.side === "base" || !note.reviewKey.startsWith("worktree@"))) {
			const { start, end } = note.anchor;
			return Promise.resolve({ ...note, start, end, location: "same" });
		}
		return resolveAnchor(this.repo, note.path, note.anchor).then((location) => ({ ...note, ...location }));
	}
	private async make(note: CreateNote): Promise<StoredNote> {
		const at = now();
		let target: NoteTarget | undefined;
		let reviewKey = note.reviewKey;
		if ("target" in note) {
			target = note.target;
			if (target.kind === "review") {
				const resolved = await this.review(target.review);
				target = { kind: "review", review: pinNoteReview(resolved) };
				reviewKey = resolved.key;
			}
		}
		const common = {
			id: id("n"),
			author: note.author,
			state: note.state,
			text: note.text,
			...(note.title === undefined ? {} : { title: note.title }),
			...(note.url === undefined ? {} : { url: note.url }),
			...(reviewKey === undefined ? {} : { reviewKey }),
			thread: [],
			createdAt: at,
			updatedAt: at,
		};
		if (target !== undefined) return { ...common, target };
		const line = note as CreateLineNote;
		return {
			...common,
			path: line.path,
			side: line.side,
			anchor: {
				start: line.start,
				end: line.end,
				commit: line.commit,
				quote: line.quote,
			},
		};
	}

	private async records(budget: { bytes: number; unreadable: number; truncated: boolean }) {
		const folder = join(this.repoDir, "notes");
		if (!(await directory(folder, false))) return [];
		const entries: { id: string; value: unknown }[] = [];
		let visited = 0;
		for await (const child of await opendir(folder)) {
			if (++visited > MAX_ENTRIES || budget.bytes >= MAX_LOOKUP_BYTES) {
				budget.truncated = true;
				break;
			}
			if (!child.name.endsWith(".json")) continue;
			const id = child.name.slice(0, -5);
			if (!child.isFile() || !matches(id, NOTE_ID)) {
				budget.unreadable++;
				continue;
			}
			const record = await readRecord(join(folder, child.name));
			budget.bytes += record.bytes;
			entries.push({ id, value: record.value });
		}
		return entries;
	}

	private async list(filter: string | undefined, status: "ready" | "empty" | "unreadable") {
		const budget = {
			unreadable: Number(status === "unreadable"),
			bytes: 0,
			truncated: false,
		};
		const notes: Note[] = [];
		if (status !== "ready") return { notes, unreadable: budget.unreadable, truncated: false };
		let output = 128;
		const fits = (value: unknown) => {
			output += Buffer.byteLength(JSON.stringify(value)) + 1;
			if (output <= MAX_RESULT) return true;
			budget.truncated = true;
			return false;
		};
		const stored = await this.listStoredNotes(filter, budget);
		const deadline = Date.now() + 5000;
		for (let index = 0; index < stored.length && output <= MAX_RESULT; index += 8) {
			if (Date.now() >= deadline) {
				budget.truncated = true;
				break;
			}
			for (const note of await Promise.all(stored.slice(index, index + 8).map((note) => this.resolve(note)))) {
				if (!fits(note)) break;
				notes.push(note);
			}
		}
		return {
			notes,
			unreadable: budget.unreadable,
			truncated: budget.truncated,
		};
	}

	private async listStoredNotes(
		filter: string | undefined,
		budget: { bytes: number; unreadable: number; truncated: boolean },
	) {
		const stored: StoredNote[] = [];
		for (const row of await this.records(budget)) {
			if (!storedNote(row.value, row.id)) {
				budget.unreadable++;
				continue;
			}
			const note = currentRecord(row.value);
			if (
				filter === undefined ||
				("target" in note ? note.target.kind === "file" && note.target.path === filter : note.path === filter)
			)
				stored.push(note);
		}
		return stored.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
	}

	private async readReview(key: string, write: boolean): Promise<Review> {
		const { value } = (await directory(join(this.repoDir, "reviews"), write))
			? await readRecord(this.file("reviews", hash(key)))
			: { value: undefined };
		if (reviewRecord(value, key)) return value;
		if (write && value !== undefined) return message("store-failure", "The Explorer review record is unreadable.");
		return { version: 1, key, viewed: [] };
	}
	private async markers(write: boolean): Promise<Markers> {
		const { value } = await readRecord(join(this.repoDir, "markers.json"));
		if (markerRecord(value)) return value;
		if (write && value !== undefined) return message("store-failure", "The Explorer review markers are unreadable.");
		return { version: 1, branches: {} };
	}

	async request(op: string, fields: Fields = {}, signal?: AbortSignal): Promise<Fields> {
		try {
			check(object(fields) && (READ_OPS.has(op) || WRITE_OPS.has(op)), "Unknown Explorer notes operation.");
			if (WRITE_OPS.has(op)) return await this.write(op, fields, signal);
			return await this.read(op, fields, signal);
		} catch (error) {
			if (error instanceof NotesError) throw error;
			return message("store-failure", "The Explorer store operation failed.");
		}
	}

	private async write(op: string, fields: Fields, signal?: AbortSignal): Promise<Fields> {
		const plan = op === "import" ? await this.planImport(fields, signal) : await this.plan(op, fields);
		const result = await this.locked(async () => {
			signal?.throwIfAborted();
			await this.init(true);
			return plan();
		});
		if (result.note) return { note: await this.resolve(result.note) };
		if (!result.notes) return result.fields ?? {};
		const notes: Note[] = [];
		for (let index = 0; index < result.notes.length; index += 8) {
			notes.push(...(await Promise.all(result.notes.slice(index, index + 8).map((note) => this.resolve(note)))));
		}
		return { notes };
	}

	private async read(op: string, fields: Fields, signal?: AbortSignal): Promise<Fields> {
		const status = await this.init(false);
		switch (op) {
			case "list": {
				const filter = fields.path;
				check(filter === undefined || path(filter), "A note path must be relative to the opened root.");
				return this.list(filter, status);
			}
			case "read": {
				const { id } = fields;
				check(matches(id, NOTE_ID), "An Explorer note ID is required.");
				if (status !== "ready") return message("not-found", "The Explorer note is missing or unreadable.");
				return { note: await this.resolve(await this.note(id)) };
			}
			case "export":
				return this.exportReview(fields, status, signal);
			case "review-get": {
				const { key } = fields;
				check(matches(key, REVIEW_KEY), "An Explorer review key is required.");
				if (status !== "ready") return { viewed: [] };
				const { viewed, finished } = await this.readReview(key, false);
				return { viewed, ...(finished ? { finished } : {}) };
			}
			case "marker": {
				const name = fields.branch;
				check(branch(name), "A branch name is required.");
				const { branches } = status === "ready" ? await this.markers(false) : { branches: {} as Markers["branches"] };
				return {
					head: Object.hasOwn(branches, name) ? (branches[name]?.head ?? null) : null,
				};
			}
			default:
				return message("invalid", "Unknown Explorer notes operation.");
		}
	}

	private async review(scope: unknown): Promise<ResolvedScope> {
		check(validScope(scope), "An Explorer review scope is required.");
		const branch = this.repo.branch;
		const marks = scope.kind === "since-review" && branch ? await this.markers(false) : undefined;
		const marker = branch && marks && Object.hasOwn(marks.branches, branch) ? marks.branches[branch]?.head : undefined;
		return resolveScope(this.repo, scope, marker).catch((error: Error) => message("invalid", error.message));
	}

	private async remoteNotes() {
		const budget = { bytes: 0, unreadable: 0, truncated: false };
		const existing = new Map<string, StoredNote>();
		for (const note of await this.listStoredNotes(undefined, budget)) {
			if (note.author !== "remote" || note.external === undefined) continue;
			if (existing.has(note.external))
				return message("store-failure", "Remote comment IDs in the Explorer store are not unique.");
			existing.set(note.external, note);
		}
		if (budget.truncated || budget.unreadable)
			return message("store-failure", "The Explorer store could not check all remote comment IDs.");
		return existing;
	}

	private async remoteLocation(comment: RemoteComment, review: ResolvedScope): Promise<NoteLocation> {
		const { path: file, start, end, side, commit } = comment;
		const hasLines = start !== undefined || end !== undefined;
		if (commit !== undefined) {
			check(
				file === undefined && side === undefined && !hasLines,
				"A commit comment cannot use a path, side or lines.",
			);
			check(matches(commit, HASH), "A commit note requires a full commit SHA.");
			await this.review({ kind: "commit", commit });
			return { target: { kind: "commit", commit } };
		}
		if (hasLines) return this.remoteAnchor(comment, review);
		if (file !== undefined) {
			await verifyNoteFile(this.repo, file, review, side);
			return { target: { kind: "file", path: file, ...(side === undefined ? {} : { side }) } };
		}
		check(side === undefined, "A review comment does not use a side.");
		return { target: { kind: "review", review: pinNoteReview(review) } };
	}
	private async remoteAnchor(comment: RemoteComment, review: ResolvedScope): Promise<NoteLocation> {
		const { path, start, end, side = "head" } = comment;
		check(
			path !== undefined && line(start) && line(end) && start <= end,
			"A line comment requires a path and ordered lines.",
		);
		const anchor = await readReviewAnchor(this.repo, review, path, side, start, end);
		check(string(anchor.quote, MiB, false), "The note quote exceeds its size limit.");
		return { path, side, anchor };
	}
	private async planImport(fields: Fields, signal?: AbortSignal): Promise<WritePlan> {
		const { comments } = fields;
		check(
			Array.isArray(comments) && comments.length > 0 && comments.length <= MAX_BATCH && comments.every(remoteComment),
			"The remote comments are invalid.",
		);
		check(
			new Set(comments.map(({ id }) => id)).size === comments.length,
			"Remote comment IDs must be unique within an import.",
		);
		const review = await this.review(fields.review);
		const skipped: ImportSkip[] = [];
		const ready: ImportItem[] = [];
		for (const comment of comments) {
			signal?.throwIfAborted();
			try {
				ready.push({ comment, location: await this.remoteLocation(comment, review) });
			} catch (error) {
				skipped.push({ id: comment.id, reason: importReason(error) });
			}
		}
		return () => this.writeImport(review.key, ready, skipped);
	}
	private async writeImport(key: string, ready: ImportItem[], skipped: ImportSkip[]) {
		let updated = 0;
		const notes: { id: string; external: string }[] = [];
		if (!ready.length) return { fields: { created: 0, updated, notes, skipped } };
		const existing = await this.remoteNotes();
		await directory(join(this.repoDir, "notes"), true);
		const at = now();
		for (const item of ready) {
			const { id } = item.comment;
			const previous = existing.get(id);
			const note = importedRecord(key, item, previous, at);
			const data = JSON.stringify(note);
			if (note.thread.length > MAX_THREAD || Buffer.byteLength(data) + 1 > MAX_RECORD) {
				skipped.push({ id, reason: "The note and its replies exceed the store limit." });
				continue;
			}
			await replace(this.file("notes", note.id), `${data}\n`);
			updated += Number(previous !== undefined);
			notes.push({ id: note.id, external: id });
		}
		return { fields: { created: notes.length - updated, updated, notes, skipped } };
	}

	private async exportReview(fields: Fields, status: "ready" | "empty" | "unreadable", signal?: AbortSignal) {
		const { ids } = fields;
		check(ids === undefined || idList(ids, MAX_BATCH), "The export note IDs are invalid.");
		const review = await this.review(fields.review);
		const { base, head, label } = review;
		if (status === "unreadable") return message("store-failure", "The Explorer notes store is unreadable.");
		let selected: StoredLineNote[];
		if (ids !== undefined) {
			const found = await Promise.all(ids.map((id) => this.note(id)));
			check(
				found.every((note): note is StoredLineNote => note.author === "operator" && !("target" in note)),
				"Only operator line notes can be exported.",
			);
			selected = found;
		} else {
			const budget = { bytes: 0, unreadable: 0, truncated: false };
			selected =
				status === "ready"
					? (await this.listStoredNotes(undefined, budget)).filter(
							(note): note is StoredLineNote =>
								note.author === "operator" && !("target" in note) && (note.state === "draft" || note.state === "sent"),
						)
					: [];
			if (budget.truncated || budget.unreadable)
				return message(
					"store-failure",
					"The Explorer store could not read all exportable notes. Select exact note IDs.",
				);
		}
		const scope = { base, head, label };
		if (!selected.length) return { review: scope, notes: [] };
		const diff = await readReviewDiff(this.repo, review).catch((error: Error) => message("invalid", error.message));
		const notes = [];
		let output = 512;
		for (const stored of selected) {
			signal?.throwIfAborted();
			const note = await this.resolve(stored);
			if ("target" in note) continue;
			const position = await locateReviewPosition(this.repo, review, diff, note);
			const { id, path, side, title, text, state } = note;
			const row = { id, path, side, title, text, state, ...position };
			output += Buffer.byteLength(JSON.stringify(row)) + 1;
			if (output > MAX_RESULT) return message("conflict", "Select fewer Explorer notes for this export.");
			notes.push(row);
		}
		return { review: scope, notes };
	}

	private async setReview(
		key: string,
		paths: string[] | undefined,
		head: string | undefined,
		name: string | undefined,
	) {
		const review = await this.readReview(key, true);
		if (paths !== undefined) review.viewed = [...new Set(paths)];
		if (head) review.finished = { head, at: now() };
		const file = join(this.repoDir, "markers.json");
		let pending: string | undefined;
		if (head && name !== undefined && review.finished) {
			const marks = await this.markers(true);
			pending = serialise({
				...marks,
				branches: { ...marks.branches, [name]: review.finished },
			});
		}
		await replace(this.file("reviews", hash(key)), serialise(review));
		if (pending) await replace(file, pending);
		return {
			fields: {
				viewed: review.viewed,
				...(review.finished ? { finished: review.finished } : {}),
			},
		};
	}

	private async saveNote(note: StoredNote) {
		note.updatedAt = nextVersion(note.updatedAt);
		await replace(this.file("notes", note.id), serialise(note));
		return { note };
	}

	private planNoteWrite(op: "update" | "reply" | "delete", fields: Fields): WritePlan {
		const { id: noteId, text: body, author: who, requestId: request } = fields;
		const { agentOnly } = fields;
		check(agentOnly === undefined || typeof agentOnly === "boolean", "The note write guard is invalid.");
		if (op === "delete") {
			const ids = fields.ids !== undefined ? fields.ids : noteId !== undefined ? [noteId] : undefined;
			check(idList(ids, MAX_BATCH), "Explorer note IDs are required.");
			return async () => {
				const notes: StoredNote[] = [];
				for (const id of ids) {
					const note = await this.note(id);
					if (agentOnly === true && note.author !== "agent")
						message("conflict", "Only agent notes can be deleted by this tool.");
					notes.push(note);
				}
				for (const note of notes) await unlink(this.file("notes", note.id));
				return { fields: { ids: notes.map((note) => note.id) } };
			};
		}
		if (op === "update") {
			check(matches(noteId, NOTE_ID), "An Explorer note ID is required.");
			const heading = fields.title;
			check(body !== undefined || heading !== undefined, "Note text or title is required.");
			check(body === undefined || text(body), "Note text is required.");
			check(heading === undefined || heading === null || title(heading), "The note title is invalid.");
			const expected = fields.expectedUpdatedAt;
			check(date(expected), "The expected note update time is required.");
			return async () => {
				const note = await this.note(noteId);
				editNote(note, expected, agentOnly === true, body, heading);
				return this.saveNote(note);
			};
		}
		check(matches(noteId, NOTE_ID), "An Explorer note ID is required.");
		check(text(body), "Note text is required.");
		check(localAuthor(who) && (request === undefined || requestId(request)), "The reply is invalid.");
		return async () => {
			const note = await this.note(noteId);
			if (note.thread.length >= MAX_THREAD) return message("conflict", "This Explorer note thread is full.");
			note.thread.push({ id: id("r"), author: who, text: body, at: now() });
			if (request !== undefined) note.requestId = request;
			return this.saveNote(note);
		};
	}

	private async planCreate(fields: Fields): Promise<WritePlan> {
		const single = fields.note;
		const batch = fields.notes;
		check(single !== undefined || batch !== undefined, "A note is required.");
		check(batch === undefined || single === undefined, "Supply one note or a notes array, not both.");
		const input: unknown = batch !== undefined ? batch : [single];
		check(
			Array.isArray(input) && input.length > 0 && input.length <= MAX_BATCH && input.every(createNote),
			"The note is invalid.",
		);
		const records: { note: StoredNote; data: string }[] = [];
		for (const spec of input as CreateNote[]) {
			const note = await this.make(spec);
			records.push({ note, data: serialise(note) });
		}
		return async () => {
			await directory(join(this.repoDir, "notes"), true);
			for (const { note, data } of records) await replace(this.file("notes", note.id), data);
			const notes = records.map(({ note }) => note);
			return batch === undefined && notes.length === 1 ? { note: notes[0] } : { notes };
		};
	}

	private async plan(op: string, fields: Fields): Promise<WritePlan> {
		switch (op) {
			case "create":
				return this.planCreate(fields);
			case "update":
			case "reply":
			case "delete":
				return this.planNoteWrite(op, fields);
			case "state": {
				const { ids, state: next, requestId: request } = fields;
				check(
					idList(ids, MAX_BATCH) && state(next) && (request === undefined || requestId(request)),
					"The note state request is invalid.",
				);
				return async () => {
					const records: { note: StoredNote; data: string }[] = [];
					let bytes = 0;
					for (const id of ids) {
						const note = await this.note(id);
						note.state = next;
						note.updatedAt = nextVersion(note.updatedAt);
						if (request !== undefined) note.requestId = request;
						const data = serialise(note);
						bytes += Buffer.byteLength(data) + 128;
						if (bytes > MAX_RESULT) return message("conflict", "Select fewer Explorer notes for this operation.");
						records.push({ note, data });
					}
					for (const { note, data } of records) await replace(this.file("notes", note.id), data);
					return { notes: records.map(({ note }) => note) };
				};
			}
			case "review-set": {
				const { key, viewed: paths, finished: done, head, branch: name } = fields;
				check(
					matches(key, REVIEW_KEY) &&
						(paths === undefined || viewed(paths)) &&
						(done === undefined || done === true) &&
						(head === undefined || matches(head, HASH)) &&
						(name === undefined || branch(name)),
					"The review state request is invalid.",
				);
				const keyHead = key.startsWith("worktree@") ? key.slice(9) : key.split("..").at(-1);
				check(head === undefined || head === keyHead, "The review head does not match the review key.");
				return () => this.setReview(key, paths, done && matches(keyHead, HASH) ? keyHead : undefined, name);
			}
			case "remember":
				return async () => {
					const file = join(this.dir, "recents.json");
					const { value } = await readRecord(file);
					if (value !== undefined && !recentRecord(value))
						return message("store-failure", "The Explorer recent roots record is unreadable.");
					const { root: path, label } = this.repo;
					const roots = [{ path, label }, ...(value?.roots ?? []).filter((row) => row.path !== path)].slice(
						0,
						MAX_RECENTS,
					);
					await replace(file, serialise({ version: 1, roots }));
					return {};
				};
			default:
				return message("invalid", "Unknown Explorer notes operation.");
		}
	}
}
