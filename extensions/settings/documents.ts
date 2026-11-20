import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { chmod, lstat, mkdir, open, realpath, rename, stat, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import lockfile from "proper-lockfile";
import { isObject } from "./json.ts";
import type { DocumentName, Scope } from "./protocol.ts";

export const HARNESS_DOCUMENT_BYTES = 131072;
export const PI_DOCUMENT_BYTES = 4 * 1024 * 1024;

export type DocumentSpec = {
	name: DocumentName;
	scope: Scope;
	path: string;
	/** `harness`: strict envelope `{version: 1}` without a byte-order mark. `pi`: Pi's settings file. */
	kind: "harness" | "pi";
};
export type Layout = { indent: string; newline: boolean };
export type DocumentRead =
	| { status: "missing"; revision: null; value?: undefined; problem?: undefined }
	| { status: "loaded"; revision: string; value: Record<string, unknown>; layout: Layout; problem?: undefined }
	| { status: "invalid" | "unavailable"; revision: string | null; value?: undefined; problem: string };

export function revisionOf(bytes: Uint8Array): string {
	return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}
function limit(spec: DocumentSpec): number {
	return spec.kind === "harness" ? HARNESS_DOCUMENT_BYTES : PI_DOCUMENT_BYTES;
}
function layoutOf(text: string): Layout {
	const indented = /\n([ \t]+)\S/.exec(text);
	return { indent: indented ? indented[1] : "  ", newline: text.endsWith("\n") };
}
/** Parses document bytes with the owner's rules. */
export function parseDocument(spec: DocumentSpec, bytes: Uint8Array): DocumentRead {
	const revision = revisionOf(bytes);
	if (bytes.length > limit(spec)) return { status: "invalid", revision, problem: "The file exceeds its size limit." };
	let text: string;
	try {
		text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
	} catch {
		return { status: "invalid", revision, problem: "The file is not valid UTF-8." };
	}
	// Pi strips a byte-order mark before parsing; the machine document contract rejects one.
	const body = spec.kind === "pi" && text.startsWith("\ufeff") ? text.slice(1) : text;
	let value: unknown;
	try {
		value = JSON.parse(body);
	} catch {
		return { status: "invalid", revision, problem: "The file is not valid JSON." };
	}
	if (!isObject(value)) return { status: "invalid", revision, problem: "The file does not hold a JSON object." };
	if (spec.kind === "harness" && value.version !== 1)
		return { status: "invalid", revision, problem: 'The machine document lacks "version": 1.' };
	return { status: "loaded", revision, value, layout: layoutOf(body) };
}
/** Reads with a nonblocking open so a nonregular path cannot block the host. */
export function readDocument(spec: DocumentSpec): DocumentRead {
	let fd: number | undefined;
	try {
		fd = openSync(spec.path, constants.O_RDONLY | constants.O_NONBLOCK);
		if (!fstatSync(fd).isFile())
			return { status: "unavailable", revision: null, problem: "The path is not a regular file." };
		const max = limit(spec) + 1;
		const buffer = Buffer.alloc(max);
		let length = 0;
		while (length < max) {
			const count = readSync(fd, buffer, length, max - length, length);
			if (!count) break;
			length += count;
		}
		return parseDocument(spec, buffer.subarray(0, length));
	} catch (error) {
		if (isObject(error) && error.code === "ENOENT") return { status: "missing", revision: null };
		return { status: "unavailable", revision: null, problem: "The file cannot be read." };
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}
export function serialize(value: Record<string, unknown>, layout: Layout): string {
	const text = JSON.stringify(value, null, layout.indent);
	return layout.newline ? `${text}\n` : text;
}

export type LockedWrite<T> = { write: false; result: T } | { write: true; value: Record<string, unknown>; result: T };
export type CommitOutcome<T> =
	| { written: false; result: T; read: DocumentRead }
	| { written: true; result: T; before: string | null; after: string; readback: "matched" | "changed" };

/**
 * Runs one read, check and replacement under the owner's lock: `proper-lockfile` on the
 * resolved path with `realpath: false`, the protocol Pi uses for its settings files.
 */
export async function withLockedDocument<T>(
	spec: DocumentSpec,
	decide: (current: DocumentRead) => LockedWrite<T>,
	options: { createParent?: boolean } = {},
): Promise<CommitOutcome<T>> {
	const parent = dirname(spec.path);
	try {
		await stat(parent);
	} catch (error) {
		if (!(isObject(error) && error.code === "ENOENT") || !options.createParent) throw error;
		await mkdir(parent, { recursive: true });
	}
	let compromised = false;
	const release = await lockfile.lock(spec.path, {
		realpath: false,
		retries: { retries: 25, minTimeout: 20, maxTimeout: 200, factor: 1.5 },
		onCompromised: () => {
			compromised = true;
		},
	});
	try {
		const current = readDocument(spec);
		const decision = decide(current);
		if (!decision.write) return { written: false, result: decision.result, read: current };
		if (current.status === "invalid" || current.status === "unavailable")
			throw new Error(`${spec.path} is ${current.status}; Settings does not replace it.`);
		const text = serialize(
			decision.value,
			current.status === "loaded" ? current.layout : { indent: "  ", newline: true },
		);
		const bytes = Buffer.from(text, "utf8");
		if (bytes.length > limit(spec))
			throw new Error(`The result would exceed the ${limit(spec)}-byte limit of ${spec.path}.`);
		if (compromised) throw new Error(`The lock on ${spec.path} was lost before the write.`);
		await replace(spec, bytes);
		const back = readDocument(spec);
		const written = revisionOf(bytes);
		return {
			written: true,
			result: decision.result,
			before: current.revision,
			after: back.revision ?? written,
			readback: back.revision === written ? "matched" : "changed",
		};
	} finally {
		await release().catch(() => {});
	}
}

/**
 * Replaces the file atomically through a temporary file beside the real target. A symbolic
 * link keeps pointing at its target; a file with several hard links is written in place so
 * every link keeps the new content.
 */
async function replace(spec: DocumentSpec, bytes: Buffer): Promise<void> {
	let target = spec.path;
	let mode: number | undefined;
	let links = 1;
	try {
		const link = await lstat(spec.path);
		if (link.isSymbolicLink()) target = await realpath(spec.path);
		const info = await stat(target);
		if (!info.isFile()) throw new Error(`${spec.path} is not a regular file.`);
		mode = info.mode & 0o7777;
		links = info.nlink;
	} catch (error) {
		if (!(isObject(error) && error.code === "ENOENT")) throw error;
	}
	if (links > 1) {
		const handle = await open(target, "r+");
		try {
			await handle.truncate(0);
			await handle.write(bytes, 0, bytes.length, 0);
			await handle.sync();
		} finally {
			await handle.close();
		}
		return;
	}
	const temporary = join(dirname(target), `.${basename(target)}.${randomUUID()}.tmp`);
	const fileMode = mode ?? (spec.kind === "harness" ? 0o600 : 0o644);
	const handle = await open(temporary, "wx", fileMode);
	try {
		await handle.write(bytes, 0, bytes.length, 0);
		await handle.sync();
	} finally {
		await handle.close();
	}
	try {
		await chmod(temporary, fileMode);
		await rename(temporary, target);
	} catch (error) {
		await unlink(temporary).catch(() => {});
		throw error;
	}
}
