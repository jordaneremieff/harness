import type { Dirent } from "node:fs";
import { lstat, opendir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { gitFiles } from "./browse-git.ts";
import { EditorError, fileName } from "./store-files.ts";

export const FILES_LIMIT = 32_000;
const EXCLUDED = new Set(["node_modules", ".build", ".cache", ".venv", "__pycache__"]);
export type Entry = { path: string; name: string; dir: boolean };
export type Scan = { end: number; signal?: AbortSignal; limited: boolean };

export function available(scan: Scan): boolean {
	scan.signal?.throwIfAborted();
	if (performance.now() < scan.end) return true;
	scan.limited = true;
	return false;
}

export function leaf(parent: string, entry: Dirent): Entry | undefined {
	if (!entry.isDirectory() && !entry.isFile()) return;
	const path = parent ? `${parent}/${entry.name}` : entry.name;
	try {
		fileName(path);
	} catch {
		return;
	}
	return { path, name: entry.name, dir: entry.isDirectory() };
}

export async function canonicalDirectory(path: string): Promise<void> {
	if ((await realpath(path)) !== path || !(await lstat(path)).isDirectory()) {
		throw new EditorError("Use a directory that stays inside this folder without symlinks.", "invalid");
	}
}

async function* listDirectory(root: string, parent: string): AsyncGenerator<Dirent> {
	const path = join(root, parent);
	await canonicalDirectory(path);
	yield* await opendir(path, { bufferSize: 128 });
}

export async function walk(
	root: string,
	entryLimit: number,
	scan: Scan,
	visit: (path: string) => undefined | false,
	excluded = new Set<string>(),
): Promise<void> {
	// Visit sibling folders before any one subtree consumes the budget.
	const dirs = [""];
	let visited = 0;
	for (let i = 0; i < dirs.length && available(scan); i++) {
		const parent = dirs[i];
		const observe = (dirent: Dirent) => {
			if (!available(scan) || ++visited > entryLimit) {
				scan.limited = true;
				return false;
			}
			const entry = leaf(parent, dirent);
			if (!entry) return;
			if (!entry.dir) return visit(entry.path);
			if (!excluded.has(entry.name)) dirs.push(entry.path);
		};
		try {
			for await (const entry of listDirectory(root, parent)) if (observe(entry) === false) return;
		} catch (error) {
			scan.signal?.throwIfAborted();
			if (!parent) throw error;
			scan.limited = true;
		}
	}
}

async function regularGitFiles(root: string, files: string[], scan: Scan): Promise<string[]> {
	const dirs = new Map<string, Promise<boolean>>();
	const validDirectory = (path: string): Promise<boolean> => {
		const known = dirs.get(path);
		if (known) return known;
		const pending = canonicalDirectory(join(root, path)).then(
			() => true,
			() => false,
		);
		dirs.set(path, pending);
		return pending;
	};
	const valid = async (doc: string): Promise<boolean> => {
		const parent = doc.slice(0, Math.max(0, doc.lastIndexOf("/")));
		if (!(await validDirectory(parent)) || !available(scan)) return false;
		try {
			return (await lstat(join(root, doc))).isFile();
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") scan.limited = true;
			return false;
		}
	};
	const result: string[] = [];
	for (let start = 0; start < files.length && available(scan); start += 64) {
		const batch = files.slice(start, start + 64);
		const flags = await Promise.all(batch.map(valid));
		result.push(...batch.filter((_doc, index) => flags[index]));
	}
	return result;
}

export async function projectFiles(root: string, scan: Scan, validate = true): Promise<string[]> {
	await canonicalDirectory(root);
	const git = await gitFiles(root, scan.end, FILES_LIMIT, scan.signal);
	if (git) {
		scan.limited ||= git.limited;
		return validate ? regularGitFiles(root, git.files, scan) : git.files;
	}
	const files: string[] = [];
	let bytes = 0;
	await walk(
		root,
		FILES_LIMIT,
		scan,
		(path) => {
			bytes += Buffer.byteLength(path) + 1;
			if (bytes > 4 * 1024 * 1024) {
				scan.limited = true;
				return false;
			}
			files.push(path);
		},
		EXCLUDED,
	);
	return files;
}
