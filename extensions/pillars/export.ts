import { randomBytes } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { link, lstat, open, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize, parse } from "node:path";
import { getHeapStatistics } from "node:v8";
import { type ExportDocument, MAX_BYTES, parseRequest, validateExport } from "./readback.ts";

export type Command =
	| { kind: "overview" | "revisions"; windowDays: number }
	| { kind: "export"; path: string; windowDays: number };
export function parseCommand(args: string): Command {
	if (Buffer.byteLength(args) > 8192 || /[\x00-\x1f\x7f]/.test(args)) throw new Error("invalid_command");
	const tokens: string[] = [];
	let i = 0;
	while (i < args.length) {
		if (args[i] === " ") {
			i++;
			continue;
		}
		let token = "";
		if (args[i] === '"') {
			i++;
			let closed = false;
			while (i < args.length) {
				const character = args[i++];
				if (character === '"') {
					closed = true;
					break;
				}
				if (character === "\\") {
					const escaped = args[i++];
					if (escaped !== '"' && escaped !== "\\") throw new Error("invalid_command");
					token += escaped;
				} else token += character;
			}
			if (!closed || (i < args.length && args[i] !== " ")) throw new Error("invalid_command");
		} else {
			while (i < args.length && args[i] !== " ") {
				if (/["'\\]/.test(args[i])) throw new Error("invalid_command");
				token += args[i++];
			}
		}
		tokens.push(token);
		if (tokens.length > 4) throw new Error("invalid_command");
	}
	let kind: Command["kind"] = "overview";
	let path: string | undefined;
	if (tokens[0] === "revisions" || tokens[0] === "export") kind = tokens.shift() as "revisions" | "export";
	if (kind === "export") {
		path = tokens.shift();
		if (!path || !validDestination(path)) throw new Error("invalid_command");
	}
	let windowDays = 30;
	if (tokens.length) {
		if (tokens.length !== 2 || tokens[0] !== "--days" || !/^(?:[1-9]|[12][0-9]|30)$/.test(tokens[1]))
			throw new Error("invalid_command");
		windowDays = Number(tokens[1]);
	}
	parseRequest({ windowDays });
	return kind === "export" ? { kind, path: path!, windowDays } : { kind, windowDays };
}
function validDestination(path: string): boolean {
	return (
		Buffer.byteLength(path) <= 4096 &&
		isAbsolute(path) &&
		path === normalize(path) &&
		!/[\x00-\x1f\x7f$`~]/.test(path) &&
		!path.includes("://") &&
		!path.endsWith("/") &&
		path.split("/").length <= 128
	);
}
export type ExportCode =
	| "export_created"
	| "export_invalid_destination"
	| "export_untrusted_destination"
	| "export_destination_exists"
	| "export_too_large"
	| "export_write_failed"
	| "export_published_sync_failed";
export interface ExportResult {
	code: ExportCode;
	published: boolean;
	durability: "confirmed" | "unconfirmed" | "not_published";
	message: string;
}
const MESSAGES: Record<ExportCode, string> = {
	export_created: "The export file was created and synchronized.",
	export_invalid_destination: "The export destination is invalid.",
	export_untrusted_destination: "The export requires trusted real directories on a supported local filesystem.",
	export_destination_exists: "The export destination already exists.",
	export_too_large: "The export exceeds the byte limit.",
	export_write_failed: "The export failed before publication.",
	export_published_sync_failed:
		"The export file exists. Publication cleanup or directory synchronization failed; durability is unconfirmed.",
};
const outcome = (code: ExportCode): ExportResult => ({
	code,
	published: code === "export_created" || code === "export_published_sync_failed",
	durability:
		code === "export_created" ? "confirmed" : code === "export_published_sync_failed" ? "unconfirmed" : "not_published",
	message: MESSAGES[code],
});
interface ParentIdentity {
	path: string;
	dev: number;
	ino: number;
}
function trusted(stats: Stats): boolean {
	const uid = process.getuid?.();
	return (
		uid !== undefined &&
		stats.isDirectory() &&
		!stats.isSymbolicLink() &&
		(stats.uid === 0 || stats.uid === uid) &&
		(stats.mode & 0o022) === 0
	);
}
async function parents(path: string): Promise<ParentIdentity[]> {
	const directory = dirname(path),
		root = parse(directory).root,
		identities: ParentIdentity[] = [];
	let current = root;
	const rootStat = await lstat(root);
	if (!trusted(rootStat)) throw new Error("untrusted");
	identities.push({ path: root, dev: rootStat.dev, ino: rootStat.ino });
	for (const component of directory.slice(root.length).split("/").filter(Boolean)) {
		current = join(current, component);
		const stats = await lstat(current);
		if (!trusted(stats)) throw new Error("untrusted");
		identities.push({ path: current, dev: stats.dev, ino: stats.ino });
	}
	return identities;
}
async function unchanged(identities: ParentIdentity[]): Promise<void> {
	for (const identity of identities) {
		const current = await lstat(identity.path);
		if (!trusted(current) || current.dev !== identity.dev || current.ino !== identity.ino) throw new Error("untrusted");
	}
}
function errno(error: unknown): string {
	return error !== null && typeof error === "object" && "code" in error ? String(error.code) : "";
}
export interface ExportOptions {
	signal?: AbortSignal;
	/** Test seam for failures at filesystem publication boundaries. */
	before?: (step: "write" | "file_sync" | "publish" | "directory_sync") => void | Promise<void>;
}
export async function exportLocal(
	path: string,
	document: ExportDocument,
	options: ExportOptions = {},
): Promise<ExportResult> {
	if (!validDestination(path)) return outcome("export_invalid_destination");
	let identities: ParentIdentity[];
	try {
		identities = await parents(path);
	} catch {
		return outcome("export_untrusted_destination");
	}
	try {
		await lstat(path);
		return outcome("export_destination_exists");
	} catch (error) {
		if (errno(error) !== "ENOENT") return outcome("export_invalid_destination");
	}
	let header: string, rows: string[];
	try {
		const memoryStart = process.memoryUsage().heapUsed;
		const withinMemory = () => {
			const used = process.memoryUsage().heapUsed;
			return used - memoryStart <= 192 * 1024 * 1024 && getHeapStatistics().heap_size_limit - used >= 128 * 1024 * 1024;
		};
		if (!withinMemory()) return outcome("export_too_large");
		validateExport(document);
		if (!withinMemory()) return outcome("export_too_large");
		const { rows: source, ...fields } = document;
		header = `${JSON.stringify(fields).slice(0, -1)},"rows":[`;
		let bytes = Buffer.byteLength(header) + 2;
		rows = [];
		for (const row of source) {
			const text = JSON.stringify(row);
			bytes += Buffer.byteLength(text) + (rows.length ? 1 : 0);
			if (bytes > MAX_BYTES) return outcome("export_too_large");
			rows.push(text);
			if (rows.length % 2048 === 0 && !withinMemory()) return outcome("export_too_large");
		}
		if (!withinMemory()) return outcome("export_too_large");
	} catch {
		return outcome("export_write_failed");
	}
	const directory = dirname(path),
		temporary = join(directory, `.pillars-export-${randomBytes(16).toString("hex")}.tmp`);
	let owned = false,
		published = false,
		file: Awaited<ReturnType<typeof open>> | undefined,
		temporaryIdentity: Stats | undefined;
	async function ownedTemporary() {
		await unchanged(identities);
		const current = await lstat(temporary);
		if (
			!current.isFile() ||
			!temporaryIdentity ||
			current.dev !== temporaryIdentity.dev ||
			current.ino !== temporaryIdentity.ino
		)
			throw new Error("untrusted");
	}
	async function removeTemporary() {
		await ownedTemporary();
		await unlink(temporary);
		owned = false;
	}
	try {
		options.signal?.throwIfAborted();
		await unchanged(identities);
		file = await open(
			temporary,
			constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
			0o600,
		);
		owned = true;
		temporaryIdentity = await file.stat();
		await options.before?.("write");
		await file.writeFile(header);
		for (let i = 0; i < rows.length; i++) {
			options.signal?.throwIfAborted();
			await file.writeFile(`${i ? "," : ""}${rows[i]}`);
		}
		await file.writeFile("]}");
		await options.before?.("file_sync");
		await file.sync();
		await file.close();
		file = undefined;
		options.signal?.throwIfAborted();
		await unchanged(identities);
		await options.before?.("publish");
		options.signal?.throwIfAborted();
		await ownedTemporary();
		await link(temporary, path);
		published = true;
		await removeTemporary();
		const handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
		try {
			await options.before?.("directory_sync");
			await handle.sync();
		} finally {
			await handle.close();
		}
		return outcome("export_created");
	} catch (error) {
		if (published) return outcome("export_published_sync_failed");
		return outcome(errno(error) === "EEXIST" ? "export_destination_exists" : "export_write_failed");
	} finally {
		if (file) await file.close().catch(() => {});
		if (owned) await removeTemporary().catch(() => {});
	}
}
