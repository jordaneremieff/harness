import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, opendir, rename, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import lockfile from "proper-lockfile";
import {
	isRelativePath,
	locateReviewPosition,
	readReviewAnchor,
	readReviewDiff,
	type Repo,
	type ResolvedScope,
	type ReviewScope,
	type ReviewSide,
	resolveAnchor,
	resolveScope,
	validScope,
} from "./repository.ts";

type State = "draft" | "open" | "sent" | "answered" | "resolved";
type LocalAuthor = "operator" | "agent";
type Author = LocalAuthor | "remote";
type Anchor = { start: number; end: number; commit: string | null; quote: string };
type ThreadEntry = { id: string; author: Author; by?: string; text: string; at: string };
type RemoteReply = { by: string; text: string; at?: string };
type RemoteComment = RemoteReply & {
	id: string;
	path: string;
	start: number;
	end: number;
	side?: ReviewSide;
	url?: string;
	resolved?: boolean;
	replies?: RemoteReply[];
};
export type CreateNote = Anchor & {
	path: string;
	side: "head" | "base";
	author: LocalAuthor;
	state: "draft" | "open" | "sent";
	text: string;
	title?: string;
};
type StoredNote = Omit<CreateNote, keyof Anchor | "state" | "author"> & {
	author: Author;
	by?: string;
	url?: string;
	external?: string;
	id: string;
	anchor: Anchor;
	state: State;
	tour?: { id: string; order: number };
	thread: ThreadEntry[];
	requestId?: string;
	createdAt: string;
	updatedAt: string;
};
export type Note = StoredNote & {
	start: number;
	end: number;
	location: "same" | "moved" | "outdated";
	movedFrom?: number;
};
export type Tour = {
	id: string;
	title: string;
	url?: string;
	summary?: string;
	scope?: ReviewScope;
	stops: string[];
	createdAt: string;
};
type Finished = { head: string; at: string };
type Review = { version: 1; key: string; viewed: string[]; finished?: Finished };
type Markers = { version: 1; branches: Record<string, Finished> };
type RecentRoot = { path: string; label: string };
type Recents = { version: 1; roots: RecentRoot[] };
type Fields = Record<string, unknown>;
type WritePlan = () => Promise<{ note?: StoredNote; notes?: StoredNote[]; fields?: Fields }>;
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
const MAX_TOUR = 32;
const MAX_RECENTS = 32;
const MAX_THREAD = 256;
const NOTE_ID = /^n-[0-9a-f]{20}$/u;
const TOUR_ID = /^t-[0-9a-f]{20}$/u;
const ENTRY_ID = /^r-[0-9a-f]{20}$/u;
const HASH = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const REVIEW_KEY =
	/^(?:worktree@(?:empty|[0-9a-f]{40}|[0-9a-f]{64})|(?:empty|[0-9a-f]{40}|[0-9a-f]{64})\.\.(?:[0-9a-f]{40}|[0-9a-f]{64}))$/u;
const WRITE_OPS = new Set([
	"create",
	"import",
	"update",
	"reply",
	"state",
	"delete",
	"tour-create",
	"tour-delete",
	"review-set",
	"remember",
]);
const READ_OPS = new Set(["list", "read", "export", "review-get", "marker"]);
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const id = (prefix: string) => `${prefix}-${randomBytes(10).toString("hex")}`;
const now = () => new Date().toISOString();
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
		path(value.path) &&
		line(value.start) &&
		line(value.end) &&
		value.start <= value.end &&
		(value.side === undefined || value.side === "base" || value.side === "head") &&
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
function noteBody(value: Fields): boolean {
	return (
		path(value.path) &&
		(value.side === "head" || value.side === "base") &&
		text(value.text) &&
		(value.title === undefined || title(value.title))
	);
}
function createNote(value: unknown): value is CreateNote {
	return (
		object(value) &&
		noteBody(value) &&
		localAuthor(value.author) &&
		(value.state === "draft" || value.state === "open" || value.state === "sent") &&
		anchor(value)
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
		noteBody(value) &&
		(value.author === "remote"
			? name(value.by) && name(value.external) && (value.url === undefined || url(value.url))
			: localAuthor(value.author) &&
				value.by === undefined &&
				value.external === undefined &&
				value.url === undefined) &&
		anchor(value.anchor) &&
		state(value.state) &&
		date(value.createdAt) &&
		date(value.updatedAt) &&
		(value.requestId === undefined || requestId(value.requestId)) &&
		(value.tour === undefined ||
			(object(value.tour) &&
				matches(value.tour.id, TOUR_ID) &&
				line(value.tour.order) &&
				value.tour.order <= MAX_TOUR)) &&
		Array.isArray(value.thread) &&
		value.thread.length <= MAX_THREAD &&
		value.thread.every(entry) &&
		!("start" in value || "end" in value || "location" in value || "movedFrom" in value)
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
function tourRecord(value: unknown, expectedId: string): value is Tour {
	return (
		object(value) &&
		value.id === expectedId &&
		title(value.title) &&
		(value.url === undefined || url(value.url)) &&
		(value.summary === undefined || commentText(value.summary)) &&
		date(value.createdAt) &&
		idList(value.stops, MAX_TOUR) &&
		(value.scope === undefined || validScope(value.scope))
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

	private file(area: "notes" | "tours" | "reviews", name: string) {
		return join(this.repoDir, area, `${name}.json`);
	}
	private async note(id: string): Promise<StoredNote> {
		const { value } = (await directory(join(this.repoDir, "notes"), false))
			? await readRecord(this.file("notes", id))
			: { value: undefined };
		if (!storedNote(value, id)) return message("not-found", "The Explorer note is missing or unreadable.");
		return value;
	}
	private resolve(note: StoredNote): Promise<Note> {
		return resolveAnchor(this.repo, note.path, note.anchor).then((location) => ({ ...note, ...location }));
	}
	private make(note: CreateNote, tour?: StoredNote["tour"]): StoredNote {
		const at = now();
		return {
			id: id("n"),
			path: note.path,
			side: note.side,
			author: note.author,
			state: note.state,
			text: note.text,
			title: note.title,
			tour,
			thread: [],
			createdAt: at,
			updatedAt: at,
			anchor: { start: note.start, end: note.end, commit: note.commit, quote: note.quote },
		};
	}

	private async records(area: "notes" | "tours", budget: { bytes: number; unreadable: number; truncated: boolean }) {
		const folder = join(this.repoDir, area);
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
			if (!child.isFile() || !matches(id, area === "notes" ? NOTE_ID : TOUR_ID)) {
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
		const budget = { unreadable: Number(status === "unreadable"), bytes: 0, truncated: false };
		const tours: Tour[] = [];
		const notes: Note[] = [];
		if (status !== "ready") return { notes, tours, unreadable: budget.unreadable, truncated: false };
		let output = 128;
		const fits = (value: unknown) => {
			output += Buffer.byteLength(JSON.stringify(value)) + 1;
			if (output <= MAX_RESULT) return true;
			budget.truncated = true;
			return false;
		};
		for (const row of await this.records("tours", budget)) {
			if (!tourRecord(row.value, row.id)) {
				budget.unreadable++;
				continue;
			}
			if (!fits(row.value)) break;
			tours.push(row.value);
		}
		tours.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
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
		return { notes, tours, unreadable: budget.unreadable, truncated: budget.truncated };
	}

	private async listStoredNotes(
		filter: string | undefined,
		budget: { bytes: number; unreadable: number; truncated: boolean },
	) {
		const stored: StoredNote[] = [];
		for (const row of await this.records("notes", budget)) {
			if (!storedNote(row.value, row.id)) {
				budget.unreadable++;
				continue;
			}
			if (filter === undefined || row.value.path === filter) stored.push(row.value);
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
		const plan = op === "import" ? await this.planImport(fields, signal) : this.plan(op, fields);
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
				return { head: Object.hasOwn(branches, name) ? (branches[name]?.head ?? null) : null };
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
		const skipped: { id: string; reason: string }[] = [];
		const ready: { comment: RemoteComment; side: ReviewSide; anchor: Anchor }[] = [];
		for (const comment of comments) {
			signal?.throwIfAborted();
			const { path, start, end, side = "head" } = comment;
			try {
				const anchor = await readReviewAnchor(this.repo, review, path, side, start, end);
				if (!string(anchor.quote, MiB, false)) throw new Error("The note quote exceeds its size limit.");
				ready.push({ comment, side, anchor });
			} catch (error) {
				skipped.push({
					id: comment.id,
					reason:
						object(error) && error.code === "ENOENT"
							? "The review file is missing."
							: error instanceof Error
								? error.message
								: "The comment could not be anchored.",
				});
			}
		}
		return async () => {
			let updated = 0;
			const notes: { id: string; external: string }[] = [];
			if (!ready.length) return { fields: { created: 0, updated, notes, skipped } };
			const existing = await this.remoteNotes();
			await directory(join(this.repoDir, "notes"), true);
			const at = now();
			for (const { comment, side, anchor } of ready) {
				const previous = existing.get(comment.id);
				const noteId = previous?.id ?? id("n");
				const thread = importThread(comment, previous, noteId, at);
				const note: StoredNote = {
					id: noteId,
					author: "remote",
					by: comment.by,
					external: comment.id,
					url: comment.url,
					path: comment.path,
					side,
					anchor,
					state: comment.resolved ? "resolved" : "open",
					text: comment.text,
					thread,
					requestId: previous?.requestId,
					createdAt: previous?.createdAt ?? at,
					updatedAt: at,
				};
				const data = JSON.stringify(note);
				if (thread.length > MAX_THREAD || Buffer.byteLength(data) + 1 > MAX_RECORD) {
					skipped.push({ id: comment.id, reason: "The note and its replies exceed the store limit." });
					continue;
				}
				await replace(this.file("notes", noteId), `${data}\n`);
				updated += Number(previous !== undefined);
				notes.push({ id: noteId, external: comment.id });
			}
			return { fields: { created: notes.length - updated, updated, notes, skipped } };
		};
	}

	private async exportReview(fields: Fields, status: "ready" | "empty" | "unreadable", signal?: AbortSignal) {
		const { ids } = fields;
		check(ids === undefined || idList(ids, MAX_BATCH), "The export note IDs are invalid.");
		const review = await this.review(fields.review);
		const { base, head, label } = review;
		if (status === "unreadable") return message("store-failure", "The Explorer notes store is unreadable.");
		let selected: StoredNote[];
		if (ids !== undefined) {
			selected = await Promise.all(ids.map((id) => this.note(id)));
			check(
				selected.every((note) => note.author === "operator"),
				"Only operator notes can be exported.",
			);
		} else {
			const budget = { bytes: 0, unreadable: 0, truncated: false };
			selected =
				status === "ready"
					? (await this.listStoredNotes(undefined, budget)).filter(
							(note) => note.author === "operator" && (note.state === "draft" || note.state === "sent"),
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
			const position = await locateReviewPosition(this.repo, review, diff, note);
			const { id, path, side, title, text, state } = note;
			const row = { id, path, side, title, text, state, ...position };
			output += Buffer.byteLength(JSON.stringify(row)) + 1;
			if (output > MAX_RESULT) return message("conflict", "Select fewer Explorer notes for this export.");
			notes.push(row);
		}
		return { review: scope, notes };
	}

	private checkEditable(note: StoredNote) {
		if (note.author !== "operator" || (note.state !== "draft" && note.state !== "open"))
			message("conflict", "Only draft or open operator notes support this operation.");
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
			pending = serialise({ ...marks, branches: { ...marks.branches, [name]: review.finished } });
		}
		await replace(this.file("reviews", hash(key)), serialise(review));
		if (pending) await replace(file, pending);
		return { fields: { viewed: review.viewed, ...(review.finished ? { finished: review.finished } : {}) } };
	}

	private async saveNote(note: StoredNote) {
		note.updatedAt = now();
		await replace(this.file("notes", note.id), serialise(note));
		return { note };
	}

	private planNoteWrite(op: "update" | "reply" | "delete", fields: Fields) {
		const { id: noteId, text: body, author: who, requestId: request } = fields;
		check(matches(noteId, NOTE_ID), "An Explorer note ID is required.");
		if (op === "delete")
			return async () => {
				const note = await this.note(noteId);
				if (note.author === "agent") message("conflict", "Only operator or remote notes can be deleted.");
				await unlink(this.file("notes", noteId));
				return {};
			};
		check(text(body), "Note text is required.");
		if (op === "update")
			return async () => {
				const note = await this.note(noteId);
				this.checkEditable(note);
				return this.saveNote({ ...note, text: body });
			};
		check(localAuthor(who) && (request === undefined || requestId(request)), "The reply is invalid.");
		return async () => {
			const note = await this.note(noteId);
			if (note.thread.length >= MAX_THREAD) return message("conflict", "This Explorer note thread is full.");
			note.thread.push({ id: id("r"), author: who, text: body, at: now() });
			if (request !== undefined) note.requestId = request;
			return this.saveNote(note);
		};
	}

	private planTour(fields: Fields): WritePlan {
		const { title: name, scope, notes: stops, url: link, summary } = fields;
		check(
			title(name) &&
				(link === undefined || url(link)) &&
				(summary === undefined || commentText(summary)) &&
				(scope === undefined || validScope(scope)) &&
				Array.isArray(stops) &&
				stops.length > 0 &&
				stops.length <= MAX_TOUR &&
				stops.every((note) => createNote(note) && note.author === "agent"),
			"The walkthrough is invalid.",
		);
		const tourId = id("t");
		const notes = (stops as CreateNote[]).map((note, index) => this.make(note, { id: tourId, order: index + 1 }));
		const tour: Tour = {
			id: tourId,
			title: name,
			...(link === undefined ? {} : { url: link }),
			...(summary === undefined ? {} : { summary }),
			scope: scope as ReviewScope | undefined,
			stops: notes.map((note) => note.id),
			createdAt: now(),
		};
		const records = notes.map((note) => ({ file: this.file("notes", note.id), data: serialise(note) }));
		return async () => {
			await directory(join(this.repoDir, "tours"), true);
			await directory(join(this.repoDir, "notes"), true);
			const created: string[] = [];
			try {
				for (const { file, data } of records) {
					await replace(file, data);
					created.push(file);
				}
				await replace(this.file("tours", tour.id), serialise(tour));
			} catch (error) {
				await Promise.allSettled(created.map((file) => unlink(file)));
				throw error;
			}
			return { fields: { tour } };
		};
	}

	private plan(op: string, fields: Fields): WritePlan {
		switch (op) {
			case "create": {
				check(createNote(fields.note), "The note is invalid.");
				const note = this.make(fields.note);
				return async () => {
					await directory(join(this.repoDir, "notes"), true);
					await replace(this.file("notes", note.id), serialise(note));
					return { note };
				};
			}
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
						note.updatedAt = now();
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
			case "tour-create":
				return this.planTour(fields);
			case "tour-delete": {
				const { id } = fields;
				check(matches(id, TOUR_ID), "An Explorer walkthrough ID is required.");
				return async () => {
					if (!(await directory(join(this.repoDir, "tours"), false)))
						return message("not-found", "The walkthrough is missing or unreadable.");
					const file = this.file("tours", id);
					const { value } = await readRecord(file);
					if (!tourRecord(value, id)) return message("not-found", "The walkthrough is missing or unreadable.");
					for (const stop of value.stops) {
						const note = await this.note(stop).catch((error: unknown) => {
							if (error instanceof NotesError && error.code === "not-found") return undefined;
							throw error;
						});
						if (note?.tour?.id !== id) continue;
						delete note.tour;
						await replace(this.file("notes", stop), serialise(note));
					}
					await unlink(file);
					return {};
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
