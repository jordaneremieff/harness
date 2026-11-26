import { type Dirent, constants } from "node:fs";
import { type FileHandle, lstat, open, opendir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { gitBrowse } from "./browse-git.ts";
import { fileName, normalise } from "./store-files.ts";

const PAGE_SIZE = 160;
const TREE_ENTRIES = 20_000;
const PATH_ENTRIES = 32_000;
const TEXT_ENTRIES = 16_000;
const SEARCH_HITS = 150;
const TEXT_FILES = 4_096;
const TEXT_BYTES = 16 * 1024 * 1024;
const FILE_BYTES = 512 * 1024;
const TEXT_BATCH = 8;
const PREVIEW_LENGTH = 220;
const QUERY_BYTES = 512;
const decoder = new TextDecoder("utf-8", { fatal: true });
const nonText = /[\u0000-\u0008\u000b\u000e-\u001f\u007f]/u;

type Entry = { path: string; name: string; dir: boolean };
type Hit = { path: string; line?: number; preview?: string };
type Scan = { end: number; signal?: AbortSignal; limited: boolean; bytes: number };

function available(scan: Scan): boolean {
	scan.signal?.throwIfAborted();
	if (performance.now() < scan.end) return true;
	scan.limited = true;
	return false;
}

function leaf(parent: string, entry: Dirent): Entry | undefined {
	if (!entry.isDirectory() && !entry.isFile()) return;
	const path = parent ? `${parent}/${entry.name}` : entry.name;
	try {
		fileName(path);
	} catch {
		return;
	}
	return { path, name: entry.name, dir: entry.isDirectory() };
}

async function canonicalDirectory(path: string): Promise<void> {
	if ((await realpath(path)) !== path || !(await lstat(path)).isDirectory()) {
		throw new Error("Use a directory that stays inside this folder without symlinks.");
	}
}

async function directoryPath(root: string, path: string, signal?: AbortSignal): Promise<string> {
	if (!path) return root;
	for (const part of fileName(path).split("/")) {
		signal?.throwIfAborted();
		root = join(root, part);
		if (!(await lstat(root)).isDirectory()) throw new Error("Use a directory without symlinks.");
	}
	return root;
}

async function tree(
	root: string,
	input: Record<string, unknown>,
	signal?: AbortSignal,
): Promise<Record<string, unknown>> {
	const path = input.path ?? "";
	const offset = input.offset ?? 0;
	if (typeof path !== "string") throw new Error("Use a folder-relative directory path.");
	if (typeof offset !== "number" || !Number.isSafeInteger(offset) || offset < 0 || offset >= TREE_ENTRIES) {
		throw new Error("Invalid directory page offset.");
	}
	const end = performance.now() + 350;
	const dirPath = await directoryPath(root, path, signal);
	await canonicalDirectory(dirPath);
	const dir = await opendir(dirPath, { bufferSize: 64 });
	const entries: Entry[] = [];
	let cursor = 0;
	for await (const dirent of dir) {
		signal?.throwIfAborted();
		if (cursor >= TREE_ENTRIES || performance.now() >= end) return { entries, next: null, limited: true };
		const index = cursor++;
		if (index < offset) continue;
		const entry = leaf(path, dirent);
		if (!entry) continue;
		if (entries.length === PAGE_SIZE) return { entries, next: index };
		entries.push(entry);
	}
	signal?.throwIfAborted();
	return { entries, next: null };
}

function decodeText(bytes: Buffer): string | undefined {
	try {
		const text = decoder.decode(bytes);
		return nonText.test(text) ? undefined : normalise(text);
	} catch {
		return;
	}
}

async function textFrom(file: FileHandle, size: number, scan: Scan): Promise<string | undefined> {
	const capacity = size + 1;
	if (size > FILE_BYTES || capacity > scan.bytes) {
		scan.limited = true;
		return;
	}
	if (!available(scan)) return;
	scan.bytes -= capacity;
	const buffer = Buffer.allocUnsafe(capacity);
	let length = 0;
	while (length < capacity && available(scan)) {
		const { bytesRead } = await file.read(buffer, length, capacity - length, null);
		scan.signal?.throwIfAborted();
		if (!bytesRead) break;
		length += bytesRead;
	}
	if (length === size) return decodeText(buffer.subarray(0, length));
	scan.limited = true;
}

async function readText(root: string, path: string, scan: Scan): Promise<string | undefined> {
	if (!available(scan)) return;
	try {
		const absolute = join(root, path);
		const expected = await lstat(absolute);
		if (!expected.isFile() || (await realpath(absolute)) !== absolute) {
			scan.limited = true;
			return;
		}
		const file = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
		try {
			const stat = await file.stat();
			if (stat.ino === expected.ino && stat.dev === expected.dev && (await realpath(absolute)) === absolute) {
				return await textFrom(file, stat.size, scan);
			}
			scan.limited = true;
		} finally {
			await file.close();
		}
	} catch {
		scan.signal?.throwIfAborted();
		scan.limited = true;
	}
}

function textHits(text: string, path: string, query: string, hits: Hit[]): boolean {
	let start = 0;
	let line = 1;
	let match = text.indexOf(query);
	while (match >= 0) {
		const breakAt = text.indexOf("\n", start);
		const end = breakAt < 0 ? text.length : breakAt;
		if (match <= end) {
			if (hits.length === SEARCH_HITS) return false;
			const from = Math.max(start, match - 40);
			hits.push({ path, line, preview: text.slice(from, Math.min(end, from + PREVIEW_LENGTH)) });
			match = text.indexOf(query, end + 1);
		}
		if (breakAt < 0) break;
		line++;
		start = end + 1;
	}
	return true;
}

function walkError(error: unknown, parent: string, scan: Scan): void {
	scan.signal?.throwIfAborted();
	if (!parent) throw error;
	scan.limited = true;
}

function withinBudget(scan: Scan, visited: number, limit: number): boolean {
	if (available(scan) && visited <= limit) return true;
	scan.limited = true;
	return false;
}

type Walk = { dirs: string[]; visited: number; limit: number };
type Visit = (path: string) => undefined | false | Promise<boolean>;

async function visitDirectory(root: string, parent: string, state: Walk, scan: Scan, visit: Visit): Promise<boolean> {
	const dirPath = join(root, parent);
	await canonicalDirectory(dirPath);
	const dir = await opendir(dirPath, { bufferSize: 64 });
	try {
		while (available(scan)) {
			const dirent = await dir.read();
			if (!dirent) return true;
			if (!withinBudget(scan, ++state.visited, state.limit)) return false;
			const entry = leaf(parent, dirent);
			if (!entry) continue;
			if (entry.dir) {
				state.dirs.push(entry.path);
				continue;
			}
			const result = visit(entry.path);
			if (result === false || (result !== undefined && !(await result))) return false;
		}
		return false;
	} finally {
		await dir.close();
	}
}

async function walk(root: string, entryLimit: number, scan: Scan, visit: Visit): Promise<void> {
	// Breadth first gives sibling projects a chance before a deep tree consumes the budget.
	const state: Walk = { dirs: [""], visited: 0, limit: entryLimit };
	for (let i = 0; i < state.dirs.length && available(scan); i++) {
		const parent = state.dirs[i];
		try {
			if (!(await visitDirectory(root, parent, state, scan, visit))) return;
		} catch (error) {
			walkError(error, parent, scan);
		}
	}
}

async function pathSearch(root: string, query: string, scan: Scan): Promise<Hit[]> {
	const hits: Hit[] = [];
	const needle = query.toLowerCase();
	await walk(root, PATH_ENTRIES, scan, (path) => {
		if (!path.toLowerCase().includes(needle)) return;
		if (hits.length === SEARCH_HITS) {
			scan.limited = true;
			return false;
		}
		hits.push({ path });
	});
	return hits;
}

async function textSearch(root: string, query: string, scan: Scan): Promise<Hit[]> {
	const hits: Hit[] = [];
	const pending: string[] = [];
	let files = 0;
	const flush = async () => {
		const paths = pending.splice(0);
		const texts = await Promise.all(paths.map((path) => readText(root, path, scan)));
		for (let i = 0; i < texts.length; i++) {
			const text = texts[i];
			if (text !== undefined && !textHits(text, paths[i], query, hits)) {
				scan.limited = true;
				return false;
			}
		}
		return true;
	};
	await walk(root, TEXT_ENTRIES, scan, (path) => {
		if (++files > TEXT_FILES || scan.bytes <= 0) {
			scan.limited = true;
			return false;
		}
		pending.push(path);
		if (pending.length === TEXT_BATCH) return flush();
	});
	if (pending.length) await flush();
	return hits;
}

async function search(
	root: string,
	input: Record<string, unknown>,
	signal?: AbortSignal,
): Promise<Record<string, unknown>> {
	const { query, kind } = input;
	if (typeof query !== "string" || Buffer.byteLength(query) > QUERY_BYTES || (kind !== "paths" && kind !== "text")) {
		throw new Error("Use a path or literal text query of at most 512 bytes.");
	}
	if (!query.length) return { hits: [], limited: false };
	const scan: Scan = { end: performance.now() + 750, signal, limited: false, bytes: TEXT_BYTES };
	const hits = kind === "paths" ? await pathSearch(root, query, scan) : await textSearch(root, query, scan);
	signal?.throwIfAborted();
	return { hits, limited: scan.limited };
}

export async function browse(
	root: string,
	input: Record<string, unknown>,
	signal?: AbortSignal,
): Promise<Record<string, unknown>> {
	signal?.throwIfAborted();
	await canonicalDirectory(root);
	signal?.throwIfAborted();
	switch (input.op) {
		case "tree":
			return tree(root, input, signal);
		case "search":
			return search(root, input, signal);
		case "git":
			return gitBrowse(root, input.doc, signal);
		default:
			throw new Error("Unknown file navigation operation.");
	}
}
