import { randomUUID } from "node:crypto";
import { lstatSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export const HISTORY_DIRECTORY = ".memory-history";
export const REVISION_PATTERN =
	/^[0-9]{8}T[0-9]{9}Z-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}-[a-f0-9]{64}$/;

export function revisionIdentity(revision: string): { capturedAt: string; digest: string } {
	if (!REVISION_PATTERN.test(revision)) throw new Error("Invalid memory revision ID");
	const stamp = revision.slice(0, 19);
	const capturedAt = `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}T${stamp.slice(9, 11)}:${stamp.slice(11, 13)}:${stamp.slice(13, 15)}.${stamp.slice(15, 18)}Z`;
	if (!Number.isFinite(Date.parse(capturedAt)) || new Date(capturedAt).toISOString() !== capturedAt)
		throw new Error("Invalid memory revision capture time");
	return { capturedAt, digest: revision.slice(-64) };
}

export function newRevision(digest: string): string {
	return `${new Date().toISOString().replace(/[-:.]/g, "")}-${randomUUID()}-${digest}`;
}

function requireDirectory(path: string, create: boolean): boolean {
	if (create) {
		try {
			mkdirSync(path, { mode: 0o700 });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}
	}
	try {
		if (!lstatSync(path).isDirectory()) throw new Error("Memory history requires real directories");
	} catch (error) {
		if (!create && (error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
	return true;
}

/** History ancestors are real directories, never symbolic links. Reads never create them. */
export function historyDirectory(root: string, slug: string, create = false): string | undefined {
	let path = root;
	for (const part of [HISTORY_DIRECTORY, slug]) {
		path = join(path, part);
		if (!requireDirectory(path, create)) return undefined;
	}
	return path;
}
