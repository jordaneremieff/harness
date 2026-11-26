import { randomUUID } from "node:crypto";
import {
	closeSync,
	constants,
	linkSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	realpathSync,
	rmSync,
} from "node:fs";
import { basename, join } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import {
	assertFileSize,
	decode,
	digest,
	type Eol,
	EditorError,
	encode,
	fileName,
	folderRoot,
	isWithin,
	type Location,
	locate,
	MAX_FILE_BYTES,
	normalise,
	plainText,
	publish,
	readBytes,
	signature,
	statIfPresent,
} from "./store-files.ts";
import { initViews, viewHeaders, views } from "./views.ts";
import {
	checkSubtree,
	copyEntry,
	fileAction,
	makeFolder,
	moveEntry,
	sourceEntry,
	systemTrash,
	targetEntry,
	type Trash,
	trashEntry,
} from "./workspace-files.ts";

const DOCS_LIMIT = 512;
const THREADS_LIMIT = 128;
const QUOTE_LIMIT = 8192;
const HEADER_TEXT_LIMIT = 240;
const MESSAGE_BYTES = 4096;
const THREAD_BYTES = 32 * 1024;
const THREAD_MESSAGES = 64;
const SCRATCH = /^scratch:[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/u;

type Document = {
	doc: string;
	rev: number;
	dirty: 0 | 1;
	seq?: number;
	base: string | null;
	stamp: string | null;
	eol: Eol;
	bom: 0 | 1;
};
export type ProjectText = {
	doc: string;
	text: string;
	draft: boolean;
	seq?: number;
	eol: Eol;
	bom: boolean;
	stamp: string | null;
	base: string | null;
};

export function diskProjectText(target: Location, seq?: number): ProjectText {
	if (!target.stat) throw new EditorError(`File not found: ${target.doc}`, "not_found");
	const bytes = readBytes(target);
	return {
		doc: target.doc,
		...decode(bytes),
		draft: false,
		seq,
		stamp: signature(target.stat),
		base: digest(bytes),
	};
}

const TARGET_KINDS = ["file", "folder", "tab", "pane", "setting", "view"] as const;
type Target = { kind: (typeof TARGET_KINDS)[number]; key: string };
type Header = {
	id: string;
	doc: string | null;
	start: number;
	end: number;
	rev: number;
	quote: string;
	target_kind: Target["kind"] | null;
	target_key: string | null;
};

function targetField(value: unknown): Target {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new EditorError("Note target must contain a kind and key.", "invalid");
	}
	const { kind, key } = value as Partial<Target>;
	if (!kind || !TARGET_KINDS.includes(kind) || typeof key !== "string") {
		throw new EditorError("Note target requires a supported kind and a text key.", "invalid");
	}
	if (kind === "file" || kind === "folder" || kind === "tab") {
		if (!(kind === "folder" && key === "") && !(kind === "tab" && SCRATCH.test(key))) fileName(key);
	} else if (!key.trim() || Buffer.byteLength(key) > 256 || /[\u0000-\u001f\u007f\ud800-\udfff]/u.test(key)) {
		throw new EditorError("Pane, setting and view keys must be non-empty text of at most 256 bytes.", "invalid");
	}
	return { kind, key };
}

function anchorFields(row: Header) {
	return {
		id: row.id,
		doc: row.doc ?? "",
		start: row.start,
		end: row.end,
		rev: row.rev,
		quote: row.quote,
		...(row.target_kind ? { target: { kind: row.target_kind, key: row.target_key as string } } : {}),
	};
}

function field(input: Record<string, unknown>, name: string): string {
	const value = input[name];
	if (typeof value !== "string") throw new EditorError(`${name} must be text.`, "invalid");
	return value;
}

function number(input: Record<string, unknown>, name: string): number {
	const value = input[name];
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
		throw new EditorError(`${name} must be a non-negative integer.`, "invalid");
	}
	return value;
}

function optionalNumber(input: Record<string, unknown>, name: string): number | undefined {
	return input[name] === undefined ? undefined : number(input, name);
}

function docField(input: Record<string, unknown>): string {
	const doc = field(input, "doc");
	return SCRATCH.test(doc) ? doc : fileName(doc);
}

function title(doc: string): string {
	return SCRATCH.test(doc) ? "Untitled" : basename(doc);
}

function describe(row: Pick<Document, "doc" | "rev" | "dirty">) {
	return { doc: row.doc, title: title(row.doc), rev: row.rev, dirty: row.dirty === 1 };
}

function revision(row: Document, expected: number): void {
	if (row.rev !== expected) {
		throw new EditorError(`Draft revision changed from ${expected} to ${row.rev}. Read the current draft.`, "conflict");
	}
}

function withinText(text: string, start: number, end: number): void {
	function splitsPair(offset: number) {
		const unit = text.charCodeAt(offset);
		return unit >= 0xdc00 && unit <= 0xdfff;
	}
	if (start > end || end > text.length || splitsPair(start) || splitsPair(end)) {
		throw new EditorError("Range must use valid UTF-16 positions in the current draft.", "invalid");
	}
}

function privateDirectory(path: string): void {
	try {
		mkdirSync(path, { mode: 0o700 });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
	}
	const stat = lstatSync(path);
	if (!stat.isDirectory() || (stat.mode & 0o777) !== 0o700 || stat.uid !== process.getuid?.()) {
		throw new EditorError("The editor requires an owned private workspace directory (0700).", "invalid");
	}
}

const SCHEMA = `
	CREATE TABLE IF NOT EXISTS workspace (id INTEGER PRIMARY KEY CHECK (id = 1), seq INTEGER NOT NULL) STRICT;
	INSERT OR IGNORE INTO workspace VALUES (1, 0);
	CREATE TABLE IF NOT EXISTS documents (
		doc TEXT PRIMARY KEY, rev INTEGER NOT NULL, dirty INTEGER NOT NULL,
		base TEXT, stamp TEXT, eol TEXT NOT NULL, bom INTEGER NOT NULL, seq INTEGER NOT NULL
	) STRICT;
	CREATE INDEX IF NOT EXISTS document_order ON documents(dirty DESC, seq DESC);
	CREATE TABLE IF NOT EXISTS bodies (
		doc TEXT PRIMARY KEY REFERENCES documents(doc) ON UPDATE CASCADE, text TEXT NOT NULL
	) STRICT;
	CREATE TABLE IF NOT EXISTS threads (
		id TEXT PRIMARY KEY, doc TEXT REFERENCES documents(doc) ON UPDATE CASCADE,
		start INTEGER NOT NULL, end INTEGER NOT NULL, rev INTEGER NOT NULL, quote TEXT NOT NULL,
		target_kind TEXT, target_key TEXT,
		header_quote TEXT NOT NULL, quote_short INTEGER NOT NULL,
		preview TEXT NOT NULL, preview_short INTEGER NOT NULL,
		message_count INTEGER NOT NULL, bytes INTEGER NOT NULL, seq INTEGER NOT NULL
	) STRICT;
	CREATE INDEX IF NOT EXISTS thread_order ON threads(seq DESC);
	CREATE INDEX IF NOT EXISTS thread_document ON threads(doc);
	CREATE TABLE IF NOT EXISTS messages (
		thread TEXT NOT NULL REFERENCES threads(id), position INTEGER NOT NULL,
		author TEXT NOT NULL, text TEXT NOT NULL,
		PRIMARY KEY(thread, position)
	) STRICT, WITHOUT ROWID;
	PRAGMA user_version = 1;
`;

function createDatabase(dir: string, path: string): void {
	// Set WAL mode before exposing the database: SQLite cannot wait for a peer
	// that tries to change the journal mode of the same new file.
	const staging = mkdtempSync(join(dir, ".db-"));
	const temporary = join(staging, "workspace.db");
	try {
		closeSync(openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600));
		const db = new DatabaseSync(temporary);
		try {
			db.exec("PRAGMA journal_mode = WAL; BEGIN IMMEDIATE;");
			db.exec(SCHEMA);
			initViews(db);
			db.exec("COMMIT");
		} finally {
			db.close();
		}
		try {
			linkSync(temporary, path);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}
	} finally {
		rmSync(staging, { recursive: true, force: true });
	}
}

function openDatabase(dir: string): DatabaseSync {
	const path = join(dir, "workspace.db");
	if (!statIfPresent(path)) createDatabase(dir, path);
	for (const file of [path, `${path}-wal`, `${path}-shm`]) {
		const stat = statIfPresent(file);
		if (stat && (!stat.isFile() || (stat.mode & 0o077n) !== 0n || stat.uid !== BigInt(process.getuid?.() ?? -1))) {
			throw new EditorError("The workspace database requires owned private regular files.", "invalid");
		}
	}
	const db = new DatabaseSync(path, { timeout: 5000 });
	try {
		db.exec("PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON;");
		if (db.prepare("PRAGMA user_version").get()?.user_version !== 1) {
			throw new EditorError("Unsupported editor workspace database format.", "invalid");
		}
		return db;
	} catch (error) {
		db.close();
		throw error;
	}
}

function shorten(text: string): string {
	if (text.length <= HEADER_TEXT_LIMIT) return text;
	const unit = text.charCodeAt(HEADER_TEXT_LIMIT);
	return text.slice(0, unit >= 0xdc00 && unit <= 0xdfff ? HEADER_TEXT_LIMIT - 1 : HEADER_TEXT_LIMIT);
}

export class Workspace {
	readonly root: string;
	readonly dir: string;
	readonly #db: DatabaseSync;
	readonly #statements = new Map<string, StatementSync>();
	readonly #trash: Trash;
	#lastDiskCheck: { doc: string; stamp: string; hash: string } | undefined;
	#closed = false;

	constructor(root: string, agentDir: string, trash: Trash = systemTrash) {
		this.#trash = trash;
		this.root = folderRoot(root);
		const privateRoot = join(realpathSync.native(agentDir), "editor");
		this.dir = join(privateRoot, digest(Buffer.from(this.root)));
		if (isWithin(this.root, this.dir) || isWithin(privateRoot, this.root)) {
			throw new EditorError("Choose a project folder separate from the editor’s private store.", "invalid");
		}
		privateDirectory(privateRoot);
		privateDirectory(this.dir);
		this.#db = openDatabase(this.dir);
	}

	close(): void {
		if (this.#closed) return;
		this.#db.close();
		this.#closed = true;
	}

	#sql(sql: string): StatementSync {
		let statement = this.#statements.get(sql);
		if (!statement) {
			statement = this.#db.prepare(sql);
			this.#statements.set(sql, statement);
		}
		return statement;
	}

	#transaction<T>(write: boolean, act: () => T): T {
		this.#db.exec(write ? "BEGIN IMMEDIATE" : "BEGIN");
		try {
			const result = act();
			this.#db.exec("COMMIT");
			return result;
		} catch (error) {
			if (this.#db.isTransaction) this.#db.exec("ROLLBACK");
			throw error;
		}
	}

	#bump(): number {
		return this.#sql("UPDATE workspace SET seq = seq + 1 WHERE id = 1 RETURNING seq").get()?.seq as number;
	}

	#state(since: number | undefined): Record<string, unknown> {
		return this.#transaction(false, () => {
			const seq = this.#sql("SELECT seq FROM workspace WHERE id = 1").get()?.seq as number;
			if (seq === since) return { seq, unchanged: true };
			const docs = this.#sql("SELECT doc, rev, dirty FROM documents ORDER BY dirty DESC, seq DESC LIMIT ?").all(
				DOCS_LIMIT + 1,
			) as Pick<Document, "doc" | "rev" | "dirty">[];
			const threads =
				this.#sql(`SELECT id, doc, start, end, rev, header_quote AS quote, quote_short, target_kind, target_key,
				message_count, preview, preview_short FROM threads ORDER BY seq DESC LIMIT ?`).all(
					THREADS_LIMIT + 1,
				) as (Header & {
					quote_short: number;
					message_count: number;
					preview: string;
					preview_short: number;
				})[];
			return {
				root: this.root,
				seq,
				docs: docs.slice(0, DOCS_LIMIT).map(describe),
				...(docs.length > DOCS_LIMIT ? { docsLimited: true } : {}),
				threads: threads.slice(0, THREADS_LIMIT).map((row) => ({
					...anchorFields(row),
					messageCount: row.message_count,
					preview: row.preview,
					...(row.quote_short ? { quoteShortened: true } : {}),
					...(row.preview_short ? { previewShortened: true } : {}),
				})),
				...(threads.length > THREADS_LIMIT ? { threadsLimited: true } : {}),
				views: viewHeaders(this.#db),
			};
		});
	}

	#get(doc: string): Document | undefined {
		return this.#sql("SELECT doc, rev, dirty, base, stamp, eol, bom, seq FROM documents WHERE doc = ?").get(doc) as
			| Document
			| undefined;
	}

	#need(doc: string): Document {
		const row = this.#get(doc);
		if (!row) throw new EditorError("Draft not found. Read a file or create a draft first.", "not_found");
		return row;
	}

	#body(doc: string): string {
		return this.#sql("SELECT text FROM bodies WHERE doc = ?").get(doc)?.text as string;
	}

	#add(row: Document, text: string): void {
		this.#sql(
			"INSERT INTO documents (doc, rev, dirty, base, stamp, eol, bom, seq) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
		).run(row.doc, row.rev, row.dirty, row.base, row.stamp, row.eol, row.bom, this.#bump());
		this.#sql("INSERT INTO bodies VALUES (?, ?)").run(row.doc, text);
	}

	#dirtyDisk(row: Document, target: Location | undefined): boolean {
		if (!target) return true;
		if (!target.stat) return row.base !== null;
		if (row.base === null) return true;
		const stamp = signature(target.stat);
		if (stamp === row.stamp) return false;
		if (this.#lastDiskCheck?.doc !== row.doc || this.#lastDiskCheck.stamp !== stamp) {
			try {
				this.#lastDiskCheck = { doc: row.doc, stamp, hash: digest(readBytes(target)) };
			} catch (error) {
				if (error instanceof EditorError || (error as NodeJS.ErrnoException).code) return true;
				throw error;
			}
		}
		return this.#lastDiskCheck.hash !== row.base;
	}

	#peek(doc: string, row: Document | undefined): Location | undefined {
		try {
			return locate(this.root, doc);
		} catch (error) {
			if (row?.dirty && (error instanceof EditorError || (error as NodeJS.ErrnoException).code)) return undefined;
			throw error;
		}
	}

	#readResult(row: Document, ifRev: number | undefined, diskChanged = false): Record<string, unknown> {
		const { doc, rev, dirty } = describe(row);
		const disk = diskChanged ? { diskChanged: true } : {};
		if (row.rev === ifRev) return { doc, rev, dirty, unchanged: true, ...disk };
		return { doc, title: title(doc), rev, dirty, text: this.#body(doc), ...disk };
	}

	#named(doc: string): { row: Document | undefined; target: Location | undefined } {
		const row = this.#get(doc);
		const target = this.#peek(doc, row);
		return { row: row ?? (target && target.doc !== doc ? this.#get(target.doc) : undefined), target };
	}

	#cached(row: Document | undefined, target: Location | undefined, ifRev: number | undefined) {
		if (row?.dirty) return this.#readResult(row, ifRev, this.#dirtyDisk(row, target));
		if (row && target?.stat && row.stamp === signature(target.stat)) return this.#readResult(row, ifRev);
		return undefined;
	}

	#read(doc: string, ifRev: number | undefined): Record<string, unknown> {
		if (SCRATCH.test(doc)) return this.#transaction(false, () => this.#readResult(this.#need(doc), ifRev));
		const cached = this.#transaction(false, () => {
			const { row, target } = this.#named(doc);
			return this.#cached(row, target, ifRev);
		});
		if (cached) return cached;
		return this.#transaction(true, () => {
			const { row, target } = this.#named(doc);
			return this.#cached(row, target, ifRev) ?? this.#refreshDisk(doc, target, row, ifRev);
		});
	}

	#refreshDisk(doc: string, target: Location | undefined, row: Document | undefined, ifRev: number | undefined) {
		if (!target?.stat) throw new EditorError(`File not found: ${doc}`, "not_found");
		const stamp = signature(target.stat);
		const bytes = readBytes(target);
		const base = digest(bytes);
		if (row?.base === base) {
			this.#sql("UPDATE documents SET stamp = ? WHERE doc = ?").run(stamp, row.doc);
			return this.#readResult(row, ifRev);
		}
		const { text, eol, bom } = decode(bytes);
		if (!row) {
			const added: Document = { doc: target.doc, rev: 1, dirty: 0, base, stamp, eol, bom: bom ? 1 : 0 };
			this.#add(added, text);
			return { ...describe(added), text };
		}
		// An encoding-only change must not move exact text anchors.
		if (this.#body(row.doc) !== text) {
			row.rev++;
			this.#sql("UPDATE bodies SET text = ? WHERE doc = ?").run(text, row.doc);
		}
		this.#sql("UPDATE documents SET rev = ?, base = ?, stamp = ?, eol = ?, bom = ?, seq = ? WHERE doc = ?").run(
			row.rev,
			base,
			stamp,
			eol,
			Number(bom),
			this.#bump(),
			row.doc,
		);
		if (row.rev === ifRev) return { doc: row.doc, rev: row.rev, dirty: false, unchanged: true };
		return { ...describe(row), text };
	}

	projectDrafts(limit: number): string[] {
		return this.#sql("SELECT doc FROM documents WHERE dirty = 1 AND doc NOT GLOB 'scratch:*' ORDER BY seq DESC LIMIT ?")
			.all(limit)
			.map((row) => row.doc as string);
	}

	projectText(doc: string): ProjectText {
		return this.#transaction(false, () => {
			const { row, target } = this.#named(doc);
			if (row?.dirty) {
				const { seq, stamp, base, eol, bom } = row;
				return { doc: row.doc, text: this.#body(row.doc), draft: true, seq, stamp, base, eol, bom: bom === 1 };
			}
			if (!target) throw new EditorError(`File not found: ${doc}`, "not_found");
			return diskProjectText(target, row?.seq);
		});
	}

	replaceProjectText(previous: ProjectText, text: string): { doc: string; rev: number } {
		const { doc, eol, bom } = previous;
		plainText(text);
		assertFileSize(text, eol, bom);
		return this.#transaction(true, () => {
			const row = this.#get(doc);
			if (row?.seq !== previous.seq)
				throw new EditorError("The draft changed during replace. Search again.", "conflict");
			const target = locate(this.root, doc);
			if (target.doc !== doc || (!previous.draft && (!target.stat || signature(target.stat) !== previous.stamp))) {
				throw new EditorError("The disk file changed during replace. Search again.", "conflict");
			}
			const rev = (row?.rev ?? 0) + 1;
			if (!row)
				this.#add(
					{ doc, rev, dirty: 1, base: previous.base, stamp: previous.stamp, eol, bom: Number(bom) as 0 | 1 },
					text,
				);
			else {
				this.#sql("UPDATE bodies SET text = ? WHERE doc = ?").run(text, doc);
				this.#sql(
					"UPDATE documents SET rev = ?, dirty = 1, base = ?, stamp = ?, eol = ?, bom = ?, seq = ? WHERE doc = ?",
				).run(rev, previous.base, previous.stamp, eol, Number(bom), this.#bump(), doc);
			}
			return { doc, rev };
		});
	}

	#revert(doc: string, expected: number): Record<string, unknown> {
		if (SCRATCH.test(doc)) throw new EditorError("A scratch draft has no disk file.", "invalid");
		return this.#transaction(true, () => {
			const row = this.#need(doc);
			revision(row, expected);
			const disk = diskProjectText(locate(this.root, doc));
			const changed = this.#body(doc) !== disk.text;
			if (changed) {
				row.rev++;
				this.#sql("UPDATE bodies SET text = ? WHERE doc = ?").run(disk.text, doc);
			}
			if (changed || row.dirty || row.base !== disk.base) {
				this.#sql(
					"UPDATE documents SET rev = ?, dirty = 0, base = ?, stamp = ?, eol = ?, bom = ?, seq = ? WHERE doc = ?",
				).run(row.rev, disk.base, disk.stamp, disk.eol, Number(disk.bom), this.#bump(), doc);
			}
			return { ...describe({ ...row, dirty: 0 }), text: disk.text };
		});
	}

	#new(path: string | undefined): Record<string, unknown> {
		return this.#transaction(true, () => {
			const target = path === undefined ? undefined : locate(this.root, path);
			const doc = target?.doc ?? `scratch:${randomUUID()}`;
			if (target?.stat || this.#get(doc)) throw new EditorError(`File or draft already exists: ${doc}`, "conflict");
			const row: Document = { doc, rev: 1, dirty: 1, base: null, stamp: null, eol: "\n", bom: 0 };
			this.#add(row, "");
			return { ...describe(row), text: "" };
		});
	}

	#edit(input: Record<string, unknown>, splice: boolean): Record<string, unknown> {
		const doc = docField(input);
		const expected = number(input, "rev");
		const insertion = field(input, splice ? "text" : "replace");
		if (insertion.length > MAX_FILE_BYTES) throw new EditorError("Files are limited to 2 MiB.", "limit");
		plainText(insertion);
		const replacement = normalise(insertion);
		return this.#transaction(true, () => {
			const row = this.#need(doc);
			revision(row, expected);
			const old = this.#body(doc);
			let start: number;
			let end: number;
			if (splice) {
				start = number(input, "start");
				end = number(input, "end");
			} else {
				const find = field(input, "find");
				if (!find.length) throw new EditorError("Find must not be empty.", "invalid");
				plainText(find);
				start = old.indexOf(find);
				if (start < 0 || old.indexOf(find, start + 1) >= 0) {
					throw new EditorError("Find must match exactly once in the draft.", "conflict");
				}
				end = start + find.length;
			}
			withinText(old, start, end);
			const next = old.slice(0, start) + replacement + old.slice(end);
			assertFileSize(next, row.eol, row.bom === 1);
			if (next === old) return { doc, rev: row.rev, dirty: row.dirty === 1 };
			const rev = row.rev + 1;
			this.#sql("UPDATE bodies SET text = ? WHERE doc = ?").run(next, doc);
			this.#sql("UPDATE documents SET rev = ?, dirty = 1, seq = ? WHERE doc = ?").run(rev, this.#bump(), doc);
			return { doc, rev, dirty: true };
		});
	}

	#saveTarget(row: Document, path: string | undefined): Location {
		if (path === undefined && SCRATCH.test(row.doc)) {
			throw new EditorError("Choose a new file path for this scratch draft.", "invalid");
		}
		const target = locate(this.root, path ?? row.doc);
		if (path !== undefined) {
			if (target.stat || this.#get(target.doc)) {
				throw new EditorError(`File or draft already exists: ${target.doc}`, "conflict");
			}
			return target;
		}
		const base = target.stat ? digest(readBytes(target)) : null;
		if (base !== row.base) {
			throw new EditorError("Disk contents changed. The disk file and the draft were both kept.", "conflict");
		}
		if (target.doc !== row.doc && this.#get(target.doc)) {
			throw new EditorError(`A draft already uses the current file name: ${target.doc}`, "conflict");
		}
		return target;
	}

	#markSaved(previous: string, row: Document): void {
		this.#sql("UPDATE documents SET doc = ?, dirty = 0, base = ?, stamp = NULL, seq = ? WHERE doc = ?").run(
			row.doc,
			row.base,
			this.#bump(),
			previous,
		);
		if (row.doc !== previous) {
			this.#sql("UPDATE threads SET target_key = ? WHERE target_kind = 'tab' AND target_key = ?").run(
				row.doc,
				previous,
			);
		}
	}

	#save(doc: string, expected: number, path: string | undefined): Record<string, unknown> {
		return this.#transaction(true, () => {
			const row = this.#need(doc);
			revision(row, expected);
			const target = this.#saveTarget(row, path);
			if (path === undefined && !row.dirty) return this.#readResult(row, undefined);
			const text = this.#body(doc);
			const bytes = encode(text, row.eol, row.bom === 1);
			const copy = path !== undefined && !SCRATCH.test(doc);
			const saved: Document = {
				...row,
				doc: target.doc,
				rev: copy ? 1 : row.rev,
				dirty: 0,
				base: digest(bytes),
				stamp: null,
			};
			if (copy) this.#add(saved, text);
			else this.#markSaved(doc, saved);
			publish(this.root, target, bytes);
			return { ...describe(saved), text };
		});
	}

	#below(doc: string) {
		const rows = this.#sql(
			"SELECT doc, dirty FROM documents WHERE doc = ? OR (doc >= ? AND doc < ?) ORDER BY doc LIMIT 8193",
		).all(doc, `${doc}/`, `${doc}0`) as Pick<Document, "doc" | "dirty">[];
		if (rows.length > 8192) throw new EditorError("Too many drafts belong to this folder.", "limit");
		return rows;
	}

	#rename(from: string, to: string) {
		if (from === to) throw new EditorError("Choose a different destination.", "invalid");
		const source = sourceEntry(this.root, from);
		const destination = targetEntry(this.root, to, source);
		const oldDoc = source.doc,
			newDoc = destination.doc;
		checkSubtree(this.root, source);
		let moved = false;
		try {
			return this.#transaction(true, () => {
				if (this.#below(newDoc).length) throw new EditorError("A draft already uses the destination.", "conflict");
				const mapping = this.#below(oldDoc).map(({ doc }) => ({
					from: doc,
					to: fileName(newDoc + doc.slice(oldDoc.length)),
				}));
				const targets = this.#sql(`SELECT DISTINCT target_key AS key FROM threads
					WHERE target_kind IN ('file', 'folder', 'tab') AND (target_key = ? OR (target_key >= ? AND target_key < ?)) LIMIT 8193`).all(
					oldDoc,
					`${oldDoc}/`,
					`${oldDoc}0`,
				);
				if (targets.length > 8192) throw new EditorError("Too many thread anchors belong to this folder.", "limit");
				const seq = this.#bump();
				for (const change of mapping)
					this.#sql("UPDATE documents SET doc = ?, seq = ? WHERE doc = ?").run(change.to, seq, change.from);
				for (const row of targets) {
					const key = row.key as string;
					this.#sql(
						"UPDATE threads SET target_key = ? WHERE target_key = ? AND target_kind IN ('file', 'folder', 'tab')",
					).run(fileName(newDoc + key.slice(oldDoc.length)), key);
				}
				moveEntry(this.root, source, destination);
				moved = true;
				return { from: oldDoc, to: newDoc, mapping };
			});
		} catch (error) {
			if (moved) {
				try {
					const item = sourceEntry(this.root, newDoc);
					if (item.stat.dev !== source.stat.dev || item.stat.ino !== source.stat.ino) throw error;
					moveEntry(this.root, item, targetEntry(this.root, oldDoc, item));
				} catch {
					throw new EditorError(
						"The disk move completed, but the workspace update failed. The drafts still use their old paths.",
						"conflict",
					);
				}
			}
			throw error;
		}
	}

	#remove(path: string) {
		const source = sourceEntry(this.root, path);
		checkSubtree(this.root, source);
		return this.#transaction(true, () => {
			const kept: string[] = [];
			for (const row of this.#below(source.doc)) {
				if (row.dirty) {
					kept.push(row.doc);
					continue;
				}
				this.#sql("UPDATE threads SET doc = NULL, target_kind = 'file', target_key = ? WHERE doc = ?").run(
					row.doc,
					row.doc,
				);
				this.#sql("DELETE FROM bodies WHERE doc = ?").run(row.doc);
				this.#sql("DELETE FROM documents WHERE doc = ?").run(row.doc);
			}
			this.#bump();
			trashEntry(this.root, source, this.#trash);
			return { path: source.doc, kept };
		});
	}

	#mkdir(path: string) {
		return this.#transaction(true, () => {
			const target = targetEntry(this.root, path);
			if (this.#get(target.doc)) throw new EditorError("A draft already uses the destination.", "conflict");
			makeFolder(this.root, target);
			return { path: target.doc };
		});
	}

	#copy(from: string, to: string) {
		return this.#transaction(true, () => {
			const source = sourceEntry(this.root, from);
			const target = targetEntry(this.root, to);
			if (source.stat.isDirectory() && isWithin(source.path, target.path)) {
				throw new EditorError("A folder cannot be copied into itself.", "invalid");
			}
			if (this.#below(target.doc).length) throw new EditorError("A draft already uses the destination.", "conflict");
			copyEntry(this.root, source, target);
			return { path: target.doc };
		});
	}

	#thread(id: string): Record<string, unknown> {
		return this.#transaction(false, () => {
			const anchor = this.#sql(
				"SELECT id, doc, start, end, quote, rev, target_kind, target_key FROM threads WHERE id = ?",
			).get(id) as Header | undefined;
			if (!anchor) throw new EditorError("Thread not found.", "not_found");
			const messages = this.#sql("SELECT author, text FROM messages WHERE thread = ? ORDER BY position").all(id);
			return { ...anchorFields(anchor), messages };
		});
	}

	#note(input: Record<string, unknown>, author: string, message: string, bytes: number): Record<string, unknown> {
		const target = input.target === undefined ? undefined : targetField(input.target);
		if (target && ["doc", "rev", "start", "end"].some((name) => input[name] !== undefined)) {
			throw new EditorError("Choose either a note target or a text range, not both.", "invalid");
		}
		const doc = target ? null : docField(input);
		const rev = target ? 0 : number(input, "rev");
		const start = target ? 0 : number(input, "start");
		const end = target ? 0 : number(input, "end");
		if (end - start > QUOTE_LIMIT) throw new EditorError("Select at most 8192 UTF-16 units for a note.", "limit");
		return this.#transaction(true, () => {
			let quote = "";
			if (doc !== null) {
				revision(this.#need(doc), rev);
				const text = this.#body(doc);
				withinText(text, start, end);
				quote = text.slice(start, end);
			}
			const shortQuote = shorten(quote);
			const preview = shorten(message);
			const id = randomUUID();
			this.#sql(`INSERT INTO threads (id, doc, start, end, rev, quote, target_kind, target_key, header_quote,
				quote_short, preview, preview_short, message_count, bytes, seq) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`).run(
				id,
				doc,
				start,
				end,
				rev,
				quote,
				target?.kind ?? null,
				target?.key ?? null,
				shortQuote,
				Number(shortQuote !== quote),
				preview,
				Number(preview !== message),
				bytes,
				this.#bump(),
			);
			this.#sql("INSERT INTO messages VALUES (?, 1, ?, ?)").run(id, author, message);
			return { id };
		});
	}

	#reply(id: string, author: string, message: string, bytes: number): Record<string, unknown> {
		return this.#transaction(true, () => {
			const thread = this.#sql("SELECT message_count, bytes FROM threads WHERE id = ?").get(id) as
				| { message_count: number; bytes: number }
				| undefined;
			if (!thread) throw new EditorError("Thread not found.", "not_found");
			if (thread.message_count >= THREAD_MESSAGES || thread.bytes + bytes > THREAD_BYTES) {
				throw new EditorError("Thread limit: 64 messages and 32 KiB of message data. Start another thread.", "limit");
			}
			const count = thread.message_count + 1;
			const preview = shorten(message);
			this.#sql("INSERT INTO messages VALUES (?, ?, ?, ?)").run(id, count, author, message);
			this.#sql(
				"UPDATE threads SET message_count = ?, bytes = ?, preview = ?, preview_short = ?, seq = ? WHERE id = ?",
			).run(count, thread.bytes + bytes, preview, Number(preview !== message), this.#bump(), id);
			return { id };
		});
	}

	run(input: Record<string, unknown>, author: string): Record<string, unknown> {
		switch (input.op) {
			case "state":
				return this.#state(optionalNumber(input, "since"));
			case "read":
				return this.#read(docField(input), optionalNumber(input, "ifRev"));
			case "new":
				return this.#new(input.path === undefined ? undefined : field(input, "path"));
			case "edit":
			case "patch":
				return this.#edit(input, input.op === "patch");
			case "revert":
				return this.#revert(docField(input), number(input, "rev"));
			case "rename":
				return fileAction(() => this.#rename(field(input, "from"), field(input, "to")));
			case "remove":
				return fileAction(() => this.#remove(field(input, "path")));
			case "mkdir":
				return fileAction(() => this.#mkdir(field(input, "path")));
			case "copy":
				return fileAction(() => this.#copy(field(input, "from"), field(input, "to")));
			case "save":
				return this.#save(
					docField(input),
					number(input, "rev"),
					input.path === undefined ? undefined : field(input, "path"),
				);
			case "thread":
				return this.#thread(field(input, "id"));
			case "view":
				return views(this.#db, input, author);
			case "compose":
				return this.#transaction(true, () => {
					const result = views(this.#db, input, author);
					this.#bump();
					return result;
				});
			case "note":
			case "reply": {
				const message = field(input, "text");
				const size = Buffer.byteLength(message);
				const authorSize = Buffer.byteLength(author);
				if (size > MESSAGE_BYTES || authorSize > 256) {
					throw new EditorError("Messages are limited to 4096 bytes and author names to 256 bytes.", "limit");
				}
				if (!message.trim() || !author.trim())
					throw new EditorError("Message and author must not be empty.", "invalid");
				plainText(message);
				plainText(author);
				return input.op === "note"
					? this.#note(input, author, message, size + authorSize)
					: this.#reply(field(input, "id"), author, message, size + authorSize);
			}
			default:
				throw new EditorError("Unknown editor workspace operation.", "invalid");
		}
	}
}
