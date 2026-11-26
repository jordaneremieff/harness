import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { EditorError, fileName } from "./store-files.ts";

const VIEW_LIMIT = 64;
const BLOCK_LIMIT = 96;
const TITLE_BYTES = 160;
const AUTHOR_BYTES = 512;
const TEXT_BYTES = 32 * 1024;
const BODY_BYTES = 128 * 1024;
const UUID = /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/u;

type ViewHeader = { id: string; title: string; rev: number };

export function initViews(db: DatabaseSync): void {
	db.exec(`
		CREATE TABLE IF NOT EXISTS editor_views (
			id TEXT PRIMARY KEY, title TEXT NOT NULL, rev INTEGER NOT NULL, author TEXT NOT NULL, blocks TEXT NOT NULL
		) STRICT;
	`);
}

export function viewHeaders(db: DatabaseSync): ViewHeader[] {
	const rows = db.prepare("SELECT id, title, rev FROM editor_views ORDER BY rowid DESC LIMIT ?").all(VIEW_LIMIT);
	return rows.map(({ id, title, rev }) => ({ id: id as string, title: title as string, rev: rev as number }));
}

function allowOnly(input: Record<string, unknown>, keys: string[]): void {
	if (Object.keys(input).some((key) => !keys.includes(key))) {
		throw new EditorError(`Use only ${keys.join(", ")}.`, "invalid");
	}
}

function textField(value: unknown, name: string, limit: number): string {
	if (typeof value !== "string") throw new EditorError(`${name} must be text.`, "invalid");
	if (value.length > limit || Buffer.byteLength(value) > limit) {
		throw new EditorError(`${name} exceeds ${limit} UTF-8 bytes.`, "limit");
	}
	if (/[\ud800-\udfff]/u.test(value)) throw new EditorError(`${name} must contain valid Unicode.`, "invalid");
	return value;
}

function label(value: unknown, name: string, limit: number): string {
	const text = textField(value, name, limit);
	if (!text.trim() || /[\u0000-\u001f\u007f]/u.test(text)) {
		throw new EditorError(`${name} must be non-blank text on one line.`, "invalid");
	}
	return text;
}

function viewId(value: unknown): string {
	if (typeof value !== "string" || !UUID.test(value)) throw new EditorError("Invalid view ID.", "invalid");
	return value;
}

function positive(value: unknown, name: string): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
		throw new EditorError(`${name} must be a positive integer.`, "invalid");
	}
	return value;
}

function location(value: unknown): string {
	if (typeof value !== "string") throw new EditorError("Location doc must be text.", "invalid");
	if (value.startsWith("scratch:") && UUID.test(value.slice(8))) return value;
	return fileName(value);
}

function encodeBlock(value: unknown): string {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new EditorError("Each view block must be an object.", "invalid");
	}
	const block = value as Record<string, unknown>;
	const kind = block.kind;
	if (kind !== "text" && kind !== "code" && kind !== "location") {
		throw new EditorError("Block kind must be text, code or location.", "invalid");
	}
	allowOnly(block, kind === "location" ? ["kind", "text", "doc", "line"] : ["kind", "text"]);
	const text = textField(block.text, "Block text", TEXT_BYTES);
	if (kind !== "location") return JSON.stringify({ kind, text });
	return JSON.stringify({ kind, text, doc: location(block.doc), line: positive(block.line, "Location line") });
}

function encodeBlocks(value: unknown): string {
	if (!Array.isArray(value)) throw new EditorError("View blocks must be an array.", "invalid");
	if (value.length > BLOCK_LIMIT) throw new EditorError(`A view holds at most ${BLOCK_LIMIT} blocks.`, "limit");
	let bytes = 2;
	const encoded: string[] = [];
	for (const block of value) {
		const json = encodeBlock(block);
		bytes += Buffer.byteLength(json) + (encoded.length ? 1 : 0);
		if (bytes > BODY_BYTES) throw new EditorError("View blocks exceed 128 KiB as JSON.", "limit");
		encoded.push(json);
	}
	return `[${encoded.join(",")}]`;
}

export function views(db: DatabaseSync, input: Record<string, unknown>, author: string): Record<string, unknown> {
	if (input.op === "view") {
		allowOnly(input, ["op", "id"]);
		const row = db
			.prepare("SELECT id, title, rev, author, blocks FROM editor_views WHERE id = ?")
			.get(viewId(input.id));
		if (!row) throw new EditorError("View not found.", "not_found");
		return { ...row, blocks: JSON.parse(row.blocks as string) };
	}
	if (input.op !== "compose") throw new EditorError("Unknown view operation.", "invalid");
	allowOnly(input, ["op", "id", "rev", "title", "blocks"]);
	const replace = Object.hasOwn(input, "id");
	if (replace !== Object.hasOwn(input, "rev")) {
		throw new EditorError("To replace a view, supply both its ID and revision.", "invalid");
	}
	const title = label(input.title, "View title", TITLE_BYTES);
	const by = label(author, "View author", AUTHOR_BYTES);
	const blocks = encodeBlocks(input.blocks);
	if (!replace) {
		const id = randomUUID();
		const result = db
			.prepare("INSERT INTO editor_views SELECT ?, ?, 1, ?, ? WHERE (SELECT count(*) FROM editor_views) < ?")
			.run(id, title, by, blocks, VIEW_LIMIT);
		if (!result.changes) throw new EditorError(`A workspace holds at most ${VIEW_LIMIT} composed views.`, "limit");
		return { id, title, rev: 1 };
	}
	const id = viewId(input.id);
	const rev = positive(input.rev, "View revision");
	if (rev === Number.MAX_SAFE_INTEGER) throw new EditorError("View revision limit reached.", "limit");
	const result = db
		.prepare("UPDATE editor_views SET title = ?, rev = rev + 1, author = ?, blocks = ? WHERE id = ? AND rev = ?")
		.run(title, by, blocks, id, rev);
	if (!result.changes) {
		const current = db.prepare("SELECT rev FROM editor_views WHERE id = ?").get(id);
		if (!current) throw new EditorError("View not found.", "not_found");
		throw new EditorError(`View revision changed from ${rev} to ${current.rev}. Read the current view.`, "conflict");
	}
	return { id, title, rev: rev + 1 };
}
