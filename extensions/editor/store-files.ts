import { createHash, randomUUID } from "node:crypto";
import {
	type BigIntStats,
	closeSync,
	constants,
	fchmodSync,
	fstatSync,
	fsyncSync,
	linkSync,
	lstatSync,
	openSync,
	readSync,
	realpathSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";

export const MAX_FILE_BYTES = 2 * 1024 * 1024;
export type Eol = "\n" | "\r\n" | "\r";
const VCS = new Set([".git", ".hg", ".svn", ".bzr", "_darcs"]);
const NON_TEXT = /[\u0000-\u0008\u000b\u000e-\u001f\u007f\ud800-\udfff]/u;
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const BOM = Buffer.from([0xef, 0xbb, 0xbf]);

export class EditorError extends Error {
	readonly code: "conflict" | "invalid" | "not_found" | "limit";

	constructor(message: string, code: EditorError["code"]) {
		super(message);
		this.code = code;
	}
}

export function isWithin(root: string, path: string): boolean {
	const rel = relative(root, path);
	return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

export function fileName(input: string): string {
	if (Buffer.byteLength(input) > 4096) throw new EditorError("File path exceeds 4096 bytes.", "limit");
	if (
		input.includes("\\") ||
		input.startsWith("scratch:") ||
		/[\u0000-\u001f\u007f\ud800-\udfff]/u.test(input) ||
		input.split("/").some((part) => !part || part === "." || part === ".." || VCS.has(part.toLowerCase()))
	) {
		throw new EditorError("Use a folder-relative file path outside version-control internals.", "invalid");
	}
	return input;
}

export function folderRoot(input: string): string {
	const root = realpathSync.native(input);
	if (!lstatSync(root).isDirectory() || root.split(sep).some((part) => VCS.has(part.toLowerCase()))) {
		throw new EditorError("Choose a folder outside version-control internals.", "invalid");
	}
	return root;
}

export function statIfPresent(path: string): BigIntStats | undefined {
	try {
		return lstatSync(path, { bigint: true });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		return undefined;
	}
}

function identity(stat: BigIntStats): string {
	return `${stat.dev}:${stat.ino}`;
}

export function signature(stat: BigIntStats): string {
	return `${identity(stat)}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
}

export interface Location {
	path: string;
	doc: string;
	parent: string;
	parentId: string;
	stat: BigIntStats | undefined;
}

export function locate(root: string, doc: string): Location {
	fileName(doc);
	let parentStat = lstatSync(root, { bigint: true });
	if (realpathSync.native(root) !== root || !parentStat.isDirectory()) {
		throw new EditorError("The workspace folder changed on disk.", "conflict");
	}
	const parts = doc.split("/");
	const leaf = parts.pop() as string;
	let parent = root;
	for (const part of parts) {
		parent = join(parent, part);
		const stat = statIfPresent(parent);
		if (!stat?.isDirectory())
			throw new EditorError("The parent must be an existing folder without symlinks.", "invalid");
		parentStat = stat;
	}
	const canonical = realpathSync.native(parent);
	if (!isWithin(root, canonical)) throw new EditorError("The path leaves the workspace folder.", "invalid");
	if (identity(lstatSync(canonical, { bigint: true })) !== identity(parentStat)) {
		throw new EditorError("The parent changed on disk.", "conflict");
	}
	let path = join(canonical, leaf);
	const stat = statIfPresent(path);
	if (stat) {
		if (!stat.isFile()) throw new EditorError("Only regular files without symlinks are supported.", "invalid");
		path = realpathSync.native(path);
		if (dirname(path) !== canonical || signature(lstatSync(path, { bigint: true })) !== signature(stat)) {
			throw new EditorError("The file path changed on disk.", "conflict");
		}
	}
	return { path, parent: canonical, parentId: identity(parentStat), doc: fileName(relative(root, path)), stat };
}

export function digest(bytes: Buffer): string {
	return createHash("sha256").update(bytes).digest("hex");
}

export function readBytes(target: Location): Buffer {
	if (!target.stat) throw new EditorError(`File not found: ${target.doc}`, "not_found");
	const fd = openSync(target.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	try {
		const before = fstatSync(fd, { bigint: true });
		if (!before.isFile() || signature(before) !== signature(target.stat)) {
			throw new EditorError("The file changed during the read. Try again.", "conflict");
		}
		if (before.size > MAX_FILE_BYTES) throw new EditorError("Files are limited to 2 MiB.", "limit");
		const bytes = Buffer.allocUnsafe(Number(before.size) + 1);
		let offset = 0;
		while (offset < bytes.length) {
			const length = readSync(fd, bytes, offset, bytes.length - offset, null);
			if (!length) break;
			offset += length;
		}
		if (offset !== bytes.length - 1 || signature(before) !== signature(fstatSync(fd, { bigint: true }))) {
			throw new EditorError("The file changed during the read. Try again.", "conflict");
		}
		return bytes.subarray(0, offset);
	} finally {
		closeSync(fd);
	}
}

export function normalise(text: string): string {
	return text.includes("\r") ? text.replace(/\r\n?/g, "\n") : text;
}

export function plainText(text: string): void {
	if (NON_TEXT.test(text)) {
		throw new EditorError("The editor supports valid UTF-8 text without binary control characters.", "invalid");
	}
}

export function decode(bytes: Buffer): { text: string; eol: Eol; bom: boolean } {
	const bom = bytes.subarray(0, BOM.length).equals(BOM);
	let text: string;
	try {
		text = decoder.decode(bom ? bytes.subarray(BOM.length) : bytes);
	} catch {
		throw new EditorError("The file is not valid UTF-8 text.", "invalid");
	}
	plainText(text);
	return { text: normalise(text), eol: (/\r\n|[\r\n]/u.exec(text)?.[0] as Eol | undefined) ?? "\n", bom };
}

export function assertFileSize(text: string, eol: Eol, bom: boolean): void {
	if (text.length > MAX_FILE_BYTES) throw new EditorError("Files are limited to 2 MiB.", "limit");
	let size = Buffer.byteLength(text) + (bom ? BOM.length : 0);
	if (eol === "\r\n") {
		for (let start = text.indexOf("\n"); start !== -1; start = text.indexOf("\n", start + 1)) size++;
	}
	if (size > MAX_FILE_BYTES) throw new EditorError("Files are limited to 2 MiB.", "limit");
}

export function encode(text: string, eol: Eol, bom: boolean): Buffer {
	assertFileSize(text, eol, bom);
	const bytes = Buffer.from(eol === "\n" ? text : text.replaceAll("\n", eol));
	return bom ? Buffer.concat([BOM, bytes]) : bytes;
}

function assertUnchangedTarget(root: string, target: Location): void {
	const latest = locate(root, target.doc);
	const expectedStamp = target.stat && signature(target.stat);
	const latestStamp = latest.stat && signature(latest.stat);
	if (latest.path !== target.path || latest.parentId !== target.parentId || expectedStamp !== latestStamp) {
		throw new EditorError("The file or its parent changed before save. The draft is still available.", "conflict");
	}
}

export function publish(root: string, target: Location, bytes: Buffer): void {
	assertUnchangedTarget(root, target);
	const temporary = join(target.parent, `.editor-save-${randomUUID()}`);
	const fd = openSync(
		temporary,
		constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
		0o600,
	);
	let renamed = false;
	try {
		writeFileSync(fd, bytes);
		if (target.stat) fchmodSync(fd, Number(target.stat.mode & 0o7777n));
		fsyncSync(fd);
		assertUnchangedTarget(root, target);
		if (signature(lstatSync(temporary, { bigint: true })) !== signature(fstatSync(fd, { bigint: true }))) {
			throw new EditorError("The staged file changed before save. The draft is still available.", "conflict");
		}
		if (target.stat) {
			renameSync(temporary, target.path);
			renamed = true;
		} else {
			try {
				linkSync(temporary, target.path);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
				throw new EditorError(`The save target already exists: ${basename(target.path)}`, "conflict");
			}
		}
	} finally {
		try {
			const staged = renamed ? undefined : statIfPresent(temporary);
			if (staged?.isFile() && identity(staged) === identity(fstatSync(fd, { bigint: true }))) unlinkSync(temporary);
		} finally {
			closeSync(fd);
		}
	}
}
