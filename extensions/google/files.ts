import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, link, lstat, mkdir, open, readFile, rename, stat, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";
import { GoogleError } from "./result.ts";

export const ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024;
export const UPLOAD_MAX_BYTES = 25 * 1024 * 1024;

export function sha256(bytes: Buffer | string): string {
	return createHash("sha256").update(bytes).digest("hex");
}

export async function ensurePrivateDir(path: string): Promise<void> {
	await mkdir(path, { recursive: true, mode: 0o700 });
	const info = await lstat(path);
	if (!info.isDirectory() || info.isSymbolicLink())
		throw new GoogleError("FILE_ERROR", `Not a private directory: ${path}`);
}

export async function ensureEmptyDotEnv(workDir: string): Promise<void> {
	const path = join(workDir, ".env");
	try {
		const handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
		try {
			const bytes = await readFile(handle);
			if (bytes.length !== 0)
				throw new GoogleError("CONFIG_ERROR", `The controlled gws working directory requires an empty .env: ${path}`);
		} finally {
			await handle.close();
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
		await handle.close();
	}
}

export type Snapshot = { bytes: Buffer; sha256: string; name: string; size: number };

/** Open once and read from that descriptor so validation and use cover the same bytes. */
export async function readSnapshot(path: string, maxBytes: number): Promise<Snapshot> {
	if (!isAbsolute(path)) throw new GoogleError("INVALID_ARGUMENT", "Local file paths must be absolute.");
	const linkInfo = await lstat(path).catch((error: NodeJS.ErrnoException) => {
		throw new GoogleError("FILE_ERROR", `Cannot inspect local file ${path}: ${error.message}`);
	});
	if (linkInfo.isSymbolicLink() || !linkInfo.isFile())
		throw new GoogleError("FILE_ERROR", `Local input must be a regular non-symlink file: ${path}`);
	const flags = constants.O_RDONLY | ("O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0);
	const handle = await open(path, flags);
	try {
		const info = await handle.stat();
		if (!info.isFile()) throw new GoogleError("FILE_ERROR", `Local input is not a regular file: ${path}`);
		if (info.size > maxBytes) throw new GoogleError("SIZE_LIMIT", `Local input exceeds ${maxBytes} bytes: ${path}`);
		const bytes = await readFile(handle);
		if (bytes.length > maxBytes) throw new GoogleError("SIZE_LIMIT", `Local input exceeds ${maxBytes} bytes: ${path}`);
		return { bytes, sha256: sha256(bytes), name: basename(path), size: bytes.length };
	} finally {
		await handle.close();
	}
}

export async function stageBytes(dir: string, bytes: Buffer, suffix = ".bin"): Promise<string> {
	await ensurePrivateDir(dir);
	const path = join(dir, `${randomUUID()}${suffix}`);
	const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
	try {
		await handle.writeFile(bytes);
		await handle.sync();
	} finally {
		await handle.close();
	}
	return path;
}

export async function removeQuietly(path: string): Promise<void> {
	await unlink(path).catch(() => undefined);
}

/** Gmail documents base64url data without stating whether padding is present, so trailing padding is accepted. */
export function decodeBase64Url(input: string, maxBytes: number): Buffer {
	const data = input.replace(/={1,2}$/, "");
	if (!/^[A-Za-z0-9_-]*$/.test(data) || data.length % 4 === 1)
		throw new GoogleError("BACKEND_SCHEMA_ERROR", "Gmail returned invalid base64url data.");
	if (Math.floor((data.length * 3) / 4) > maxBytes + 2)
		throw new GoogleError("SIZE_LIMIT", `Decoded content exceeds ${maxBytes} bytes.`);
	const bytes = Buffer.from(data, "base64url");
	if (bytes.length > maxBytes) throw new GoogleError("SIZE_LIMIT", `Decoded content exceeds ${maxBytes} bytes.`);
	if (bytes.toString("base64url") !== data)
		throw new GoogleError("BACKEND_SCHEMA_ERROR", "Gmail returned non-canonical base64url data.");
	return bytes;
}

export function encodeBase64Url(bytes: Buffer): string {
	return bytes.toString("base64url");
}

/** Publish with an atomic hard-link creation so a concurrent destination is never overwritten. */
export async function writeNewFile(
	destination: string,
	bytes: Buffer,
): Promise<{ path: string; bytes: number; sha256: string }> {
	if (!isAbsolute(destination)) throw new GoogleError("INVALID_ARGUMENT", "The destination path must be absolute.");
	const parent = dirname(destination);
	const parentInfo = await stat(parent).catch((error: NodeJS.ErrnoException) => {
		throw new GoogleError("FILE_ERROR", `Destination parent is unavailable: ${error.message}`);
	});
	if (!parentInfo.isDirectory()) throw new GoogleError("FILE_ERROR", "The destination parent must be a directory.");
	const existing = await lstat(destination).catch((error: NodeJS.ErrnoException) =>
		error.code === "ENOENT" ? undefined : Promise.reject(error),
	);
	if (existing) throw new GoogleError("FILE_EXISTS", `Refusing to overwrite or follow the destination: ${destination}`);
	const temporary = join(parent, `.${basename(destination)}.${randomUUID()}.tmp`);
	let handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
	try {
		await handle.writeFile(bytes);
		await handle.sync();
		await handle.close();
		handle = undefined as never;
		await link(temporary, destination);
		await chmod(destination, 0o600);
		return { path: destination, bytes: bytes.length, sha256: sha256(bytes) };
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST")
			throw new GoogleError("FILE_EXISTS", `Refusing to overwrite the destination: ${destination}`);
		throw error;
	} finally {
		if (handle) await handle.close().catch(() => undefined);
		await removeQuietly(temporary);
	}
}

export async function publishStagedFile(
	staged: string,
	destination: string,
	maxBytes: number,
): Promise<{ path: string; bytes: number; sha256: string }> {
	const snapshot = await readSnapshot(staged, maxBytes);
	return writeNewFile(destination, snapshot.bytes);
}

export async function replacePrivateFile(path: string, bytes: Buffer): Promise<void> {
	await ensurePrivateDir(dirname(path));
	const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
	const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
	try {
		await handle.writeFile(bytes);
		await handle.sync();
		await handle.close();
		await rename(temporary, path);
		await chmod(path, 0o600);
		const directory = await open(dirname(path), constants.O_RDONLY);
		try {
			await directory.sync();
		} finally {
			await directory.close();
		}
	} finally {
		await removeQuietly(temporary);
	}
}
