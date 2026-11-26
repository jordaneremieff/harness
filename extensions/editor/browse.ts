import { lstat, opendir } from "node:fs/promises";
import { join } from "node:path";
import { gitBrowse } from "./browse-git.ts";
import { canonicalDirectory, type Entry, FILES_LIMIT, leaf, projectFiles, type Scan, walk } from "./project-files.ts";
import { projectSearch } from "./project-search.ts";
import { EditorError, fileName } from "./store-files.ts";
import type { Workspace } from "./store.ts";

const PAGE_SIZE = 160;
const TREE_ENTRIES = 20_000;
const SEARCH_HITS = 150;
const QUERY_BYTES = 512;

async function directoryPath(root: string, path: string, signal?: AbortSignal): Promise<string> {
	if (!path) return root;
	for (const part of fileName(path).split("/")) {
		signal?.throwIfAborted();
		root = join(root, part);
		if (!(await lstat(root)).isDirectory()) throw new EditorError("Use a directory without symlinks.", "invalid");
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
	if (typeof path !== "string") throw new EditorError("Use a folder-relative directory path.", "invalid");
	if (typeof offset !== "number" || !Number.isSafeInteger(offset) || offset < 0 || offset >= TREE_ENTRIES) {
		throw new EditorError("Invalid directory page offset.", "invalid");
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

async function pathSearch(root: string, query: unknown, signal?: AbortSignal) {
	if (typeof query !== "string" || Buffer.byteLength(query) > QUERY_BYTES) {
		throw new EditorError("Use a path query of at most 512 bytes.", "invalid");
	}
	const hits: { path: string }[] = [];
	if (!query.length) return { hits, limited: false };
	const scan: Scan = { end: performance.now() + 750, signal, limited: false };
	const needle = query.toLowerCase();
	await walk(root, FILES_LIMIT, scan, (path) => {
		if (!path.toLowerCase().includes(needle)) return;
		if (hits.length === SEARCH_HITS) {
			scan.limited = true;
			return false;
		}
		hits.push({ path });
	});
	return { hits, limited: scan.limited };
}

export async function browse(
	root: string,
	input: Record<string, unknown>,
	signal?: AbortSignal,
	store?: Workspace,
): Promise<Record<string, unknown>> {
	signal?.throwIfAborted();
	await canonicalDirectory(root);
	signal?.throwIfAborted();
	switch (input.op) {
		case "tree":
			return tree(root, input, signal);
		case "files": {
			const scan: Scan = { end: performance.now() + 1500, signal, limited: false };
			const files = await projectFiles(root, scan);
			return { files, limited: scan.limited };
		}
		case "search":
			if (input.kind === "paths") return pathSearch(root, input.query, signal);
			if (input.kind === "text") return projectSearch(root, input, signal, store);
			throw new EditorError("Choose path or text search.", "invalid");
		case "git":
			if (input.base !== undefined && typeof input.base !== "boolean") {
				throw new EditorError("base must be true or false.", "invalid");
			}
			return gitBrowse(root, input.doc, signal, input.base === true);
		default:
			throw new EditorError("Unknown file navigation operation.", "invalid");
	}
}
