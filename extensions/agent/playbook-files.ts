import { createHash } from "node:crypto";
import {
	closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readlinkSync, readSync,
	realpathSync, statSync, writeFileSync, type BigIntStats,
} from "node:fs";
import { basename, dirname, join } from "node:path";

export const PLAYBOOK_MAX_BYTES = 16 * 1024;
export const playbookName = (name: string): boolean => name !== "off" && name.length <= 48
	&& /^[a-z]/u.test(name) && !/[^a-z0-9-]|--/u.test(name) && !name.endsWith("-");
export function hasCode(error: unknown, code: string): boolean {
	return error instanceof Error && (error as NodeJS.ErrnoException).code === code;
}
export function entry(path: string): BigIntStats | undefined {
	try { return lstatSync(path, { bigint: true }); }
	catch (error) { if (!hasCode(error, "ENOENT")) throw error; return undefined; }
}
export const sameEntry = (a: BigIntStats, b: BigIntStats | undefined): boolean => b !== undefined && a.dev === b.dev && a.ino === b.ino;
export function sameVersion(a: BigIntStats, b: BigIntStats | undefined): boolean {
	return sameEntry(a, b) && b !== undefined && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
}
export const digest = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");
export const safeLabel = (text: string): string => JSON.stringify(Array.from(text).slice(0, 180).join("")).replace(/[\p{Cc}\p{Cf}]/gu, (char) => `\\u{${char.codePointAt(0)?.toString(16)}}`);

export function readPlaybookFile(path: string): { bytes: Buffer; stat: BigIntStats; digest: string } {
	const named = entry(path);
	if (named === undefined || !named.isFile()) throw new Error("expected a regular file, not a link or special entry");
	if (named.size > BigInt(PLAYBOOK_MAX_BYTES)) throw new Error("file exceeds 16 KiB");
	let fd: number;
	try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
	catch { throw new Error("file could not be opened without following links"); }
	try {
		const before = fstatSync(fd, { bigint: true });
		if (!before.isFile() || !sameVersion(before, named)) throw new Error("file changed during open");
		const buffer = Buffer.alloc(PLAYBOOK_MAX_BYTES + 1);
		let length = 0;
		while (length < buffer.length) {
			const count = readSync(fd, buffer, length, buffer.length - length, length);
			if (!count) break;
			length += count;
		}
		if (length > PLAYBOOK_MAX_BYTES) throw new Error("file exceeds 16 KiB");
		if (BigInt(length) !== before.size || !sameVersion(before, fstatSync(fd, { bigint: true })) || !sameVersion(before, entry(path)))
			throw new Error("file changed during read");
		const bytes = buffer.subarray(0, length);
		return { bytes, stat: before, digest: digest(bytes) };
	} finally { closeSync(fd); }
}

export function playbookText(bytes: Buffer): string {
	let text: string;
	try { text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); }
	catch { throw new Error("file is not UTF-8"); }
	if (/[\p{Cc}\p{Cf}]/u.test(text.replace(/\r\n|[\n\t]/gu, ""))) throw new Error("file contains a BOM or control characters");
	return text;
}

export type PlaybookRoot = {
	dir: string;
	physical: string;
	logical: BigIntStats;
	physicalStat: BigIntStats;
	parent: string;
	parentStat: BigIntStats;
};
export const backingName = (dir: string): string => `${basename(dir)}-data`;

export function inspectPlaybookRoot(dir: string): PlaybookRoot | undefined {
	const logical = entry(dir);
	if (!logical) return undefined;
	const parent = realpathSync(dirname(dir));
	const parentStat = lstatSync(parent, { bigint: true });
	const physical = join(parent, logical.isSymbolicLink() ? backingName(dir) : basename(dir));
	if (logical.isSymbolicLink() && (!privateDirectory(parentStat) || readlinkSync(dir) !== backingName(dir)))
		throw new Error("catalog link must point to its relative sibling data directory in an operator-controlled parent");
	const physicalStat = entry(physical);
	if (!physicalStat?.isDirectory() || (!logical.isSymbolicLink() && !sameEntry(logical, physicalStat)))
		throw new Error("catalogue must be a real directory or a link to its real sibling data directory");
	if (logical.isSymbolicLink() && !privateDirectory(physicalStat)) throw new Error("catalog data directory must be operator-owned and not group- or world-writable");
	if (!sameEntry(logical, entry(dir)) || !sameEntry(parentStat, statSync(dirname(dir), { bigint: true }))) throw new Error("catalogue directory changed during inspection");
	return { dir, physical, logical, physicalStat, parent, parentStat };
}

export function sameRoot(a: PlaybookRoot, b: PlaybookRoot | undefined): boolean {
	return b !== undefined && a.physical === b.physical && a.parent === b.parent
		&& sameEntry(a.logical, b.logical) && sameEntry(a.physicalStat, b.physicalStat) && sameEntry(a.parentStat, b.parentStat);
}

function privateDirectory(stat: BigIntStats): boolean {
	return stat.isDirectory() && (process.getuid === undefined || stat.uid === BigInt(process.getuid())) && (stat.mode & 0o022n) === 0n;
}
export function requirePrivateDirectory(path: string): BigIntStats {
	const stat = lstatSync(path, { bigint: true });
	if (!privateDirectory(stat)) throw new Error("write directory must be operator-owned and not group- or world-writable");
	return stat;
}

/** Resolve existing ancestors once; create missing components only beneath an operator-controlled directory. */
export function ensurePublishParent(path: string): string {
	const missing: string[] = [];
	let ancestor = path;
	while (!entry(ancestor)) {
		missing.push(basename(ancestor));
		ancestor = dirname(ancestor);
	}
	let parent = realpathSync(ancestor);
	requirePrivateDirectory(parent);
	for (const name of missing.reverse()) {
		const child = join(parent, name);
		try { mkdirSync(child, { mode: 0o700 }); }
		catch (error) { if (!hasCode(error, "EEXIST")) throw error; }
		requirePrivateDirectory(child);
		parent = child;
	}
	if (!sameEntry(requirePrivateDirectory(parent), statSync(path, { bigint: true }))) throw new Error("catalogue parent changed");
	return parent;
}

export function writeNewPlaybookFile(path: string, bytes: Buffer): void {
	const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
	try { writeFileSync(fd, bytes); fsyncSync(fd); }
	finally { closeSync(fd); }
}

export function syncPlaybookDirectory(path: string): void {
	const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
	try { fsyncSync(fd); }
	finally { closeSync(fd); }
}
