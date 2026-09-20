import { randomBytes } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { link, lstat, open, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize, parse } from "node:path";
import { getHeapStatistics } from "node:v8";
import { type ExportDocument, MAX_BYTES, parseRequest, validateExport } from "./readback.ts";

export type Command =
	| { kind: "overview" | "revisions"; windowDays: number }
	| { kind: "export"; path: string; windowDays: number };
const WINDOW_DAYS = /^(?:[1-9]|[12][0-9]|30)$/;

function readQuoted(args: string, start: number): { token: string; next: number } {
	let i = start + 1;
	let token = "";
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
	return { token, next: i };
}

function readBare(args: string, start: number): { token: string; next: number } {
	let i = start;
	let token = "";
	while (i < args.length && args[i] !== " ") {
		if (/["'\\]/.test(args[i])) throw new Error("invalid_command");
		token += args[i++];
	}
	return { token, next: i };
}

function tokenize(args: string): string[] {
	const tokens: string[] = [];
	let i = 0;
	while (i < args.length) {
		if (args[i] === " ") {
			i++;
			continue;
		}
		const read = args[i] === '"' ? readQuoted(args, i) : readBare(args, i);
		tokens.push(read.token);
		if (tokens.length > 4) throw new Error("invalid_command");
		i = read.next;
	}
	return tokens;
}

function parseWindowDays(tokens: string[]): number {
	if (!tokens.length) return 30;
	if (tokens.length !== 2 || tokens[0] !== "--days" || !WINDOW_DAYS.test(tokens[1]))
		throw new Error("invalid_command");
	return Number(tokens[1]);
}

export function parseCommand(args: string): Command {
	if (Buffer.byteLength(args) > 8192 || /[\x00-\x1f\x7f]/.test(args)) throw new Error("invalid_command");
	const tokens = tokenize(args);
	const head = tokens[0];
	const kind: Command["kind"] = head === "revisions" || head === "export" ? head : "overview";
	if (kind !== "overview") tokens.shift();
	if (kind === "export") {
		const path = tokens.shift();
		if (!path || !validDestination(path)) throw new Error("invalid_command");
		const windowDays = parseWindowDays(tokens);
		parseRequest({ windowDays });
		return { kind, path, windowDays };
	}
	const windowDays = parseWindowDays(tokens);
	parseRequest({ windowDays });
	return { kind, windowDays };
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
const HEAP_WORK_BYTES = 192 * 1024 * 1024;
const HEAP_RESERVE_BYTES = 128 * 1024 * 1024;

function memoryWithin(start: number): boolean {
	const used = process.memoryUsage().heapUsed;
	return used - start <= HEAP_WORK_BYTES && getHeapStatistics().heap_size_limit - used >= HEAP_RESERVE_BYTES;
}

function serializeExport(document: ExportDocument): { header: string; rows: string[] } | "export_too_large" {
	const memoryStart = process.memoryUsage().heapUsed;
	if (!memoryWithin(memoryStart)) return "export_too_large";
	validateExport(document);
	if (!memoryWithin(memoryStart)) return "export_too_large";
	const { rows: source, ...fields } = document;
	const header = `${JSON.stringify(fields).slice(0, -1)},"rows":[`;
	let bytes = Buffer.byteLength(header) + 2;
	const rows: string[] = [];
	for (const row of source) {
		const text = JSON.stringify(row);
		bytes += Buffer.byteLength(text) + (rows.length ? 1 : 0);
		if (bytes > MAX_BYTES) return "export_too_large";
		rows.push(text);
		if (rows.length % 2048 === 0 && !memoryWithin(memoryStart)) return "export_too_large";
	}
	if (!memoryWithin(memoryStart)) return "export_too_large";
	return { header, rows };
}

class ExportWriter {
	private owned = false;
	private published = false;
	private file: Awaited<ReturnType<typeof open>> | undefined;
	private identity: Stats | undefined;
	private readonly destination: string;
	private readonly temporary: string;
	private readonly identities: ParentIdentity[];
	private readonly before: ExportOptions["before"];
	private readonly signal?: AbortSignal;
	constructor(
		destination: string,
		temporary: string,
		identities: ParentIdentity[],
		before: ExportOptions["before"],
		signal?: AbortSignal,
	) {
		this.destination = destination;
		this.temporary = temporary;
		this.identities = identities;
		this.before = before;
		this.signal = signal;
	}

	async run(header: string, rows: string[]): Promise<ExportResult> {
		try {
			this.signal?.throwIfAborted();
			await unchanged(this.identities);
			this.file = await open(
				this.temporary,
				constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
				0o600,
			);
			this.owned = true;
			this.identity = await this.file.stat();
			await this.before?.("write");
			await this.file.writeFile(header);
			for (let i = 0; i < rows.length; i++) {
				this.signal?.throwIfAborted();
				await this.file.writeFile(`${i ? "," : ""}${rows[i]}`);
			}
			await this.file.writeFile("]}");
			await this.before?.("file_sync");
			await this.file.sync();
			await this.file.close();
			this.file = undefined;
			this.signal?.throwIfAborted();
			await unchanged(this.identities);
			await this.before?.("publish");
			this.signal?.throwIfAborted();
			await this.ownedTemporary();
			await link(this.temporary, this.destination);
			this.published = true;
			await this.removeTemporary();
			const handle = await open(
				dirname(this.destination),
				constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
			);
			try {
				await this.before?.("directory_sync");
				await handle.sync();
			} finally {
				await handle.close();
			}
			return outcome("export_created");
		} catch (error) {
			if (this.published) return outcome("export_published_sync_failed");
			return outcome(errno(error) === "EEXIST" ? "export_destination_exists" : "export_write_failed");
		} finally {
			await this.cleanup();
		}
	}

	private async ownedTemporary(): Promise<void> {
		await unchanged(this.identities);
		const current = await lstat(this.temporary);
		if (!current.isFile() || !this.identity || current.dev !== this.identity.dev || current.ino !== this.identity.ino)
			throw new Error("untrusted");
	}

	private async removeTemporary(): Promise<void> {
		await this.ownedTemporary();
		await unlink(this.temporary);
		this.owned = false;
	}

	private async cleanup(): Promise<void> {
		if (this.file) await this.file.close().catch(() => {});
		if (this.owned) await this.removeTemporary().catch(() => {});
	}
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
	let serialized: { header: string; rows: string[] };
	try {
		const result = serializeExport(document);
		if (result === "export_too_large") return outcome("export_too_large");
		serialized = result;
	} catch {
		return outcome("export_write_failed");
	}
	const temporary = join(dirname(path), `.pillars-export-${randomBytes(16).toString("hex")}.tmp`);
	return new ExportWriter(path, temporary, identities, options.before, options.signal).run(
		serialized.header,
		serialized.rows,
	);
}
