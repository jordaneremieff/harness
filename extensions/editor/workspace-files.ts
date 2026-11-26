import { spawnSync } from "node:child_process";
import {
	linkSync,
	mkdirSync,
	mkdtempSync,
	opendirSync,
	renameSync,
	rmSync,
	rmdirSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { basename, join, relative } from "node:path";
import {
	decode,
	EditorError,
	fileName,
	isWithin,
	type Location,
	locate,
	readBytes,
	signature,
	statIfPresent,
} from "./store-files.ts";

const TREE_LIMIT = 8192;
const COPY_BYTES = 64 * 1024 * 1024;
type Existing = Location & { stat: NonNullable<Location["stat"]> };

function errno(error: unknown) {
	return (error as NodeJS.ErrnoException).code;
}

export function fileAction<T>(act: () => T): T {
	try {
		return act();
	} catch (error) {
		if (error instanceof EditorError) throw error;
		switch (errno(error)) {
			case "EEXIST":
			case "ENOTEMPTY":
			case "EISDIR":
				throw new EditorError("The destination already exists.", "conflict");
			case "ENOENT":
				throw new EditorError("A source file or folder no longer exists.", "not_found");
			case "EXDEV":
				throw new EditorError("Move the file or folder within the same volume.", "invalid");
			default:
				if (!errno(error)) throw error;
				throw new EditorError("The file operation failed on disk.", "invalid");
		}
	}
}

export function sourceEntry(root: string, doc: string): Existing {
	const target = locate(root, doc, true);
	if (!target.stat) throw new EditorError(`File or folder not found: ${doc}`, "not_found");
	return target as Existing;
}

export function targetEntry(root: string, doc: string, source?: Existing): Location {
	const target = locate(root, doc, true);
	if (
		source &&
		target.path === source.path &&
		doc !== source.doc &&
		target.parent === source.parent &&
		basename(doc) !== basename(source.doc)
	) {
		return { ...target, doc: fileName(relative(root, join(target.parent, basename(doc)))) };
	}
	if (target.stat) throw new EditorError(`File or folder already exists: ${doc}`, "conflict");
	if (source?.stat.isDirectory() && isWithin(source.path, target.path)) {
		throw new EditorError("A folder cannot be moved or copied into itself.", "invalid");
	}
	return target;
}

function checked(root: string, entry: Location): Location {
	const latest = locate(root, entry.doc, true);
	if (
		latest.path !== entry.path ||
		latest.parentId !== entry.parentId ||
		(latest.stat && signature(latest.stat)) !== (entry.stat && signature(entry.stat))
	) {
		throw new EditorError("The file, folder or its parent changed on disk.", "conflict");
	}
	return latest;
}

function* descendants(root: string, source: Existing, end: number): Generator<Existing> {
	const queue = [source];
	for (let i = 0; i < queue.length; i++) {
		const entry = queue[i];
		yield entry;
		if (!entry.stat.isDirectory()) continue;
		checked(root, entry);
		const dir = opendirSync(entry.path);
		try {
			for (let item = dir.readSync(); item; item = dir.readSync()) {
				if (queue.length === TREE_LIMIT || performance.now() >= end) {
					throw new EditorError("The operation exceeds the folder scan limit.", "limit");
				}
				queue.push(sourceEntry(root, `${entry.doc}/${item.name}`));
			}
		} finally {
			dir.closeSync();
		}
	}
}

export function checkSubtree(root: string, source: Existing): void {
	for (const entry of descendants(root, source, performance.now() + 800)) checked(root, entry);
}

export function moveEntry(root: string, source: Existing, target: Location): void {
	checked(root, source);
	checked(root, target);
	if (target.path === source.path) {
		// On a case-insensitive volume both spellings resolve to the source.
		renameSync(source.path, join(target.parent, basename(target.doc)));
		return;
	}
	if (!source.stat.isDirectory()) {
		linkSync(source.path, target.path);
		try {
			unlinkSync(source.path);
		} catch (error) {
			unlinkSync(target.path);
			throw error;
		}
		return;
	}

	// POSIX rename replaces an empty destination directory. Reserve it first so an existing folder is never replaced.
	mkdirSync(target.path, { mode: 0o700 });
	const reservation = statIfPresent(target.path);
	const ownsReservation = () => {
		const current = statIfPresent(target.path);
		return !!reservation && current?.dev === reservation.dev && current.ino === reservation.ino;
	};
	try {
		checked(root, source);
		if (!ownsReservation()) throw new EditorError("The destination changed on disk.", "conflict");
		renameSync(source.path, target.path);
	} catch (error) {
		if (ownsReservation()) rmdirSync(target.path);
		throw error;
	}
}

export function makeFolder(root: string, target: Location): void {
	checked(root, target);
	mkdirSync(target.path);
}

export function copyEntry(root: string, source: Existing, target: Location): void {
	checked(root, target);
	const stage = mkdtempSync(join(target.parent, ".editor-copy-"));
	const staged = join(stage, "item");
	let bytes = 0;
	try {
		for (const entry of descendants(root, source, performance.now() + 1200)) {
			checked(root, entry);
			const output = entry.doc === source.doc ? staged : join(staged, entry.doc.slice(source.doc.length + 1));
			if (entry.stat.isDirectory()) mkdirSync(output);
			else {
				const raw = readBytes(entry);
				decode(raw);
				bytes += raw.length;
				if (bytes > COPY_BYTES) throw new EditorError("The copy exceeds the 64 MiB operation limit.", "limit");
				writeFileSync(output, raw, { flag: "wx", mode: Number(entry.stat.mode & 0o777n) });
			}
		}
		moveEntry(root, sourceEntry(root, fileName(relative(root, staged))), target);
	} finally {
		rmSync(stage, { recursive: true, force: true });
	}
}

export type Trash = (path: string) => void;
export const systemTrash: Trash = (path) => {
	const result = spawnSync("/usr/bin/trash", ["-s", path], { stdio: "ignore", timeout: 5000, killSignal: "SIGKILL" });
	if (result.status !== 0) throw new EditorError("macOS Trash refused the file or folder.", "invalid");
};

export function trashEntry(root: string, source: Existing, trash: Trash): void {
	checked(root, source);
	trash(source.path);
	if (statIfPresent(source.path)) throw new EditorError("The file or folder was not moved to Trash.", "conflict");
}
