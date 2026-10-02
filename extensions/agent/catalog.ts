import { createHash, randomUUID } from "node:crypto";
import { constants, closeSync, fstatSync, mkdirSync, openSync, readSync, writeFileSync } from "node:fs";
import { opendir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseHostMetadata, type HostMetadata } from "./host-protocol.ts";
import { isThinkingLevel } from "./configuration.ts";

const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u;
const MAX_RECORD_BYTES = 32_768;
const MAX_VISITS = 256;
interface CatalogQuery { cursor?: string; limit?: number; query?: string; cwd?: string }
function requestStorageId(key: string): string {
	const hex = createHash("sha256").update(key).digest("hex").slice(0, 32);
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
function pageLimit(value: number | undefined): number {
	const limit = value ?? 20;
	if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20) throw new Error("Catalog limit must be between 1 and 20");
	return limit;
}
function queryBinding(revision: string, options: CatalogQuery): string { return JSON.stringify([revision, options.query ?? "", options.cwd ?? ""]); }
function startOffset(cursor: string | undefined, binding: string): number {
	if (!cursor) return 0;
	const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
	if (parsed.binding !== binding || !Number.isSafeInteger(parsed.offset) || parsed.offset < 0 || parsed.offset > 1_000_000) throw new Error("Catalog changed or cursor does not match the query; restart discovery");
	return parsed.offset;
}
function matches(record: CatalogRecord, options: CatalogQuery): boolean {
	if (options.cwd && options.cwd !== record.cwd) return false;
	const query = options.query?.toLocaleLowerCase();
	return !query || [record.storageId, record.cwd, record.name ?? ""].some((text) => text.toLocaleLowerCase().includes(query));
}
async function directoryRevision(root: string): Promise<string | undefined> {
	try { const info = await stat(root); return `${info.ino}:${info.mtimeMs}`; }
	catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}
export interface CatalogRecord extends HostMetadata { createdAt: string }
export function hostMetadata(record: CatalogRecord): HostMetadata { const { createdAt: _createdAt, ...metadata } = record; return metadata; }
export interface CatalogPage { records: CatalogRecord[]; nextCursor: string | null; coverage: { visited: number; skipped: number; complete: boolean }; observedAt: string }

export function storageIdOf(identity: string): string {
	const [storageId, conversationId, extra] = identity.split(":");
	if (!UUID.test(storageId) || extra !== undefined || (conversationId !== undefined && !/^\d+$/u.test(conversationId))) throw new Error("Invalid Durable agent identity");
	return storageId;
}

/** Discovery metadata locates storage. It never substitutes for native conversation state. */
export class AgentCatalog {
	readonly root: string;
	constructor(root: string) { this.root = resolve(root, "durable"); }
	create(input: Omit<HostMetadata, "storageId" | "storagePath">, requestId?: string): CatalogRecord {
		mkdirSync(this.root, { recursive: true, mode: 0o700 });
		const storageId = requestId === undefined ? randomUUID() : requestStorageId(JSON.stringify([input.ownerId, requestId]));
		const metadata = parseHostMetadata({ ...input, storageId, storagePath: join(this.root, `${storageId}.sqlite`) });
		if (!isThinkingLevel(metadata.thinkingLevel)) throw new Error("Unknown reasoning level");
		const record: CatalogRecord = { ...metadata, createdAt: new Date().toISOString() };
		try { writeFileSync(this.path(storageId), `${JSON.stringify(record)}\n`, { flag: "wx", mode: 0o600 }); }
		catch (error) {
			if (requestId === undefined || (error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			const previous = this.read(storageId);
			if (JSON.stringify(hostMetadata(previous)) !== JSON.stringify(metadata)) throw new Error("Spawn request ID already belongs to different agent configuration");
			return previous;
		}
		return record;
	}
	path(identity: string): string { return join(this.root, `${storageIdOf(identity)}.json`); }
	read(identity: string): CatalogRecord {
		const storageId = storageIdOf(identity);
		const fd = openSync(this.path(storageId), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
		try {
			const info = fstatSync(fd);
			if (!info.isFile() || info.size > MAX_RECORD_BYTES) throw new Error("Agent metadata exceeds its bound or is not a regular file");
			const bytes = Buffer.alloc(MAX_RECORD_BYTES + 1);
			let length = 0;
			while (length < bytes.length) { const count = readSync(fd, bytes, length, bytes.length - length, length); if (!count) break; length += count; }
			if (length > MAX_RECORD_BYTES) throw new Error("Agent metadata exceeds its read bound");
			const value: unknown = JSON.parse(bytes.toString("utf8", 0, length));
			if (!value || typeof value !== "object") throw new Error("Agent metadata is invalid");
			const record = value as CatalogRecord;
			if (record.storageId !== storageId || record.storagePath !== join(this.root, `${storageId}.sqlite`) || typeof record.cwd !== "string" || !record.cwd.startsWith("/") || typeof record.agentDir !== "string" || typeof record.packageDir !== "string" || typeof record.createdAt !== "string" || typeof record.model?.provider !== "string" || typeof record.model?.modelId !== "string") throw new Error("Agent metadata is invalid");
			parseHostMetadata(hostMetadata(record));
			if (!isThinkingLevel(record.thinkingLevel)) throw new Error("Agent metadata has an unknown reasoning level");
			return record;
		} finally { closeSync(fd); }
	}
	private select(name: string, options: CatalogQuery): CatalogRecord | undefined {
		if (!name.endsWith(".json") || !UUID.test(name.slice(0, -5))) return;
		const record = this.read(name.slice(0, -5));
		return matches(record, options) ? record : undefined;
	}
	async page(options: CatalogQuery = {}): Promise<CatalogPage> {
		const limit = pageLimit(options.limit);
		const observedAt = new Date().toISOString();
		const revision = await directoryRevision(this.root);
		if (revision === undefined) return { records: [], nextCursor: null, coverage: { visited: 0, skipped: 0, complete: true }, observedAt };
		const binding = queryBinding(revision, options);
		const start = startOffset(options.cursor, binding);
		const records: CatalogRecord[] = [];
		let index = 0, visited = 0, skipped = 0, complete = true;
		const directory = await opendir(this.root);
		for await (const entry of directory) {
			if (index++ < start) continue;
			visited++;
			try { const record = entry.isFile() ? this.select(entry.name, options) : undefined; if (record) records.push(record); }
			catch { skipped++; }
			if (visited === MAX_VISITS || records.length === limit) { complete = false; break; }
		}
		return { records, nextCursor: complete ? null : Buffer.from(JSON.stringify({ binding, offset: index })).toString("base64url"), coverage: { visited, skipped, complete }, observedAt };
	}
}
