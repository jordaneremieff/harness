import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, opendir, rename, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import lockfile from "proper-lockfile";
import { isRelativePath, type Repo, type ReviewScope, resolveAnchor, validScope } from "./repository.ts";

type State = "draft" | "open" | "sent" | "answered" | "resolved";
type Author = "operator" | "agent";
type Anchor = { start: number; end: number; commit: string | null; quote: string };
type ThreadEntry = { id: string; author: Author; text: string; at: string };
export type CreateNote = Anchor & {
	path: string;
	side: "head" | "base";
	author: Author;
	state: "draft" | "open" | "sent";
	text: string;
	title?: string;
};
type StoredNote = Omit<CreateNote, keyof Anchor | "state"> & {
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
export type Tour = { id: string; title: string; scope?: ReviewScope; stops: string[]; createdAt: string };
type Finished = { head: string; at: string };
type Review = { version: 1; key: string; viewed: string[]; finished?: Finished };
type Markers = { version: 1; branches: Record<string, Finished> };
type RecentRoot = { path: string; label: string };
type Recents = { version: 1; roots: RecentRoot[] };
type Fields = Record<string, unknown>;
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
	"update",
	"reply",
	"state",
	"delete",
	"tour-create",
	"tour-delete",
	"review-set",
	"remember",
]);
const READ_OPS = new Set(["list", "read", "review-get", "marker"]);
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
function author(value: unknown): value is Author {
	return value === "agent" || value === "operator";
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
		author(value.author) &&
		text(value.text) &&
		(value.title === undefined || title(value.title))
	);
}
function createNote(value: unknown): value is CreateNote {
	return (
		object(value) &&
		noteBody(value) &&
		(value.state === "draft" || value.state === "open" || value.state === "sent") &&
		anchor(value)
	);
}
function entry(value: unknown): value is ThreadEntry {
	return object(value) && matches(value.id, ENTRY_ID) && author(value.author) && text(value.text) && date(value.at);
}
function storedNote(value: unknown, expectedId: string): value is StoredNote {
	return (
		object(value) &&
		value.id === expectedId &&
		noteBody(value) &&
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

	async request(op: string, fields: Fields = {}): Promise<Fields> {
		try {
			check(object(fields) && (READ_OPS.has(op) || WRITE_OPS.has(op)), "Unknown Explorer notes operation.");
			if (WRITE_OPS.has(op)) {
				const plan = this.plan(op, fields);
				const result = await this.locked(async () => {
					await this.init(true);
					return plan();
				});
				if (result.note) return { note: await this.resolve(result.note) };
				if (result.notes) {
					const notes: Note[] = [];
					for (let index = 0; index < result.notes.length; index += 8) {
						notes.push(...(await Promise.all(result.notes.slice(index, index + 8).map((note) => this.resolve(note)))));
					}
					return { notes };
				}
				return result.fields ?? {};
			}
			return await this.read(op, fields);
		} catch (error) {
			if (error instanceof NotesError) throw error;
			return message("store-failure", "The Explorer store operation failed.");
		}
	}

	private async read(op: string, fields: Fields): Promise<Fields> {
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
				if (note.author !== "operator") message("conflict", "Only operator notes can be deleted.");
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
		check(author(who) && (request === undefined || requestId(request)), "The reply is invalid.");
		return async () => {
			const note = await this.note(noteId);
			if (note.thread.length >= MAX_THREAD) return message("conflict", "This Explorer note thread is full.");
			note.thread.push({ id: id("r"), author: who, text: body, at: now() });
			if (request !== undefined) note.requestId = request;
			return this.saveNote(note);
		};
	}

	private plan(
		op: string,
		fields: Fields,
	): () => Promise<{ note?: StoredNote; notes?: StoredNote[]; fields?: Fields }> {
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
			case "tour-create": {
				const { title: name, scope, notes: stops } = fields;
				check(
					title(name) &&
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
