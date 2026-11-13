import { createHash, randomBytes, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, mkdir, open, opendir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import lockfile from "proper-lockfile";

export const LIMITS = { sourceBytes: 2 * 1024 * 1024, titleChars: 200, assetCount: 64, assetBytes: 8 * 1024 * 1024, totalAssetBytes: 32 * 1024 * 1024, listing: 2000, recordBytes: 256 * 1024, stagingAgeMs: 86400000 } as const;
export type DocumentKind = "published" | "response" | "file";
export type Completeness = { state: "complete" | "partial"; reason?: "length" | "aborted" | "error" | "tool-use"; note?: string };
export type ContentOrigin = { kind: "ordinary-response" | "native-response" | "file" | "tool"; host?: string; session?: string; conversation?: string; entry?: string; model?: string; path?: string; cwd?: string; capturedAt: string; parts?: { chars: number }[] };
export type AssetRecord = { kind: "image" | "link"; reference: string; state: "retained" | "external" | "embedded" | "unavailable" | "local-only"; file?: string; mediaType?: string; bytes?: number; digest?: string; reason?: "outside-root" | "missing" | "too-large" | "unsupported-type" | "unsupported-scheme" | "invalid" | "no-base" | "limit" };
export type ReferenceInventory = { state: "inspected" | "uninspected"; truncated: boolean; omitted: number; items: AssetRecord[] };
export type CapturedAsset = { record: AssetRecord; data?: Uint8Array };
export type DocumentRecord = { version: 1; id: string; kind: DocumentKind; title: string; createdAt: string; updatedAt: string; revision: number; digest: string; bytes: number };
export type RevisionRecord = { version: 1; document: string; revision: number; title: string; createdAt: string; digest: string; bytes: number; publication?: string; completeness: Completeness; contentOrigin: ContentOrigin; references: ReferenceInventory; selfContained?: boolean };
export type StoredDocument = { document: DocumentRecord; revision: RevisionRecord; source: string };
export type WriteInput = { title: string; source: string; contentOrigin: ContentOrigin; completeness?: Completeness; references?: ReferenceInventory; assets?: CapturedAsset[]; invocationDigest?: string };
export type WriteResult = StoredDocument & { created: boolean; replayed: boolean };
export type ErrorCode = "invalid" | "too-large" | "not-found" | "conflict" | "replay-conflict" | "file-unreadable" | "store-failure";
export class StoreError extends Error {
	code: ErrorCode;
	currentRevision?: number;
	currentDigest?: string;
	constructor(code: ErrorCode, message: string, currentRevision?: number, currentDigest?: string) { super(message); this.name = "StoreError"; this.code = code; this.currentRevision = currentRevision; this.currentDigest = currentDigest; }
}
export function digest(source: string | Uint8Array): string { return `sha256:${createHash("sha256").update(source).digest("hex")}`; }
function hash(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function validId(value: string): boolean { return /^md-[0-9a-f]{20}$/.test(value); }
export function validateInput(input: WriteInput): void {
	if (typeof input.source !== "string" || /[\ud800-\udfff]/u.test(input.source)) throw new StoreError("invalid", "Source must contain valid Unicode text.");
	if (Buffer.byteLength(input.source) > LIMITS.sourceBytes) throw new StoreError("too-large", "Source exceeds 2 MiB.");
	if (typeof input.title !== "string" || !input.title.trim() || [...input.title].length > LIMITS.titleChars || /[\p{Cc}\p{Zl}\p{Zp}\u202a-\u202e\u2066-\u2069\ud800-\udfff]/u.test(input.title)) throw new StoreError("invalid", "Title must contain one nonempty line of at most 200 characters.");
	validateAssets(input.assets ?? []);
	validateReferences(input.references);
}
function validateReferences(references?: ReferenceInventory): void {
	if (!references) return;
	if (!["inspected", "uninspected"].includes(references.state) || typeof references.truncated !== "boolean" || !Number.isSafeInteger(references.omitted) || references.omitted < 0 || !Array.isArray(references.items) || references.items.length > 256) throw new StoreError("invalid", "Invalid reference inventory.");
	if (references.state === "uninspected" && (references.items.length || references.omitted || references.truncated)) throw new StoreError("invalid", "Uninspected references have no inventory.");
}
function validateAssets(assets: CapturedAsset[]): void {
	if (assets.length > LIMITS.assetCount) throw new StoreError("too-large", "Asset count exceeds 64.");
	let total = 0;
	for (const { record, data } of assets) {
		if (record.state !== "retained") continue;
		if (!data || !/^assets\/[0-9a-f]{64}\.(png|jpg|gif|webp|svg)$/.test(record.file ?? "") || record.digest !== digest(data) || !record.file?.startsWith(`assets/${record.digest.slice(7)}.`) || record.bytes !== data.byteLength) throw new StoreError("invalid", "Invalid retained asset.");
		total += data.byteLength;
		if (data.byteLength > LIMITS.assetBytes || total > LIMITS.totalAssetBytes) throw new StoreError("too-large", "Asset bytes exceed the retention limit.");
	}
}
async function directory(path: string): Promise<void> { await mkdir(path, { recursive: true, mode: 0o700 }); await chmod(path, 0o700); }
async function file(path: string, content: string | Uint8Array): Promise<void> {
	const handle = await open(path, "wx", 0o600);
	try { await handle.writeFile(content); await handle.sync(); } finally { await handle.close(); }
}
async function json(path: string, value: unknown): Promise<void> {
	const temp = `${path}.tmp-${randomUUID()}`;
	try { await file(temp, JSON.stringify(value)); await rename(temp, path); } finally { await rm(temp, { force: true }); }
}
async function jsonNew(path: string, value: unknown, beforeRename?: () => void | Promise<void>): Promise<void> {
	const temp = `${path}.tmp-${randomUUID()}`;
	try {
		await file(temp, JSON.stringify(value));
		await beforeRename?.();
		try { await stat(path); throw new StoreError("store-failure", "Index record already exists."); } catch (error) { if (!absent(error)) throw error; }
		await rename(temp, path);
	} finally { await rm(temp, { force: true }); }
}
async function readBytes(path: string, limit: number): Promise<Buffer> {
	const handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
	try {
		const info = await handle.stat();
		if (!info.isFile() || info.size > limit) throw new StoreError("store-failure", "Store record is nonregular or oversized.");
		const bytes = Buffer.alloc(Math.min(info.size + 1, limit + 1)); let length = 0;
		while (length < bytes.length) { const { bytesRead } = await handle.read(bytes, length, bytes.length - length, length); if (!bytesRead) break; length += bytesRead; }
		if (length > limit || length > info.size) throw new StoreError("store-failure", "Store record exceeded its size during the read.");
		return bytes.subarray(0, length);
	} finally { await handle.close(); }
}
async function readJson<T>(path: string, limit = 8 * 1024 * 1024): Promise<T> { return JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(await readBytes(path, limit))) as T; }
export type StoreIdentity = { version: 1; storeId: string };
function validIdentity(value: StoreIdentity): boolean { return value?.version === 1 && typeof value.storeId === "string" && /^[0-9a-f]{32}$/.test(value.storeId); }
function listingRecord(record: DocumentRecord, name: string, kind: DocumentKind): boolean { return validPointer(record, name) && record.kind === kind; }
function collection(kind: DocumentKind): "documents" | "snapshots" { return kind === "published" ? "documents" : "snapshots"; }
function validPointer(record: DocumentRecord, id: string): boolean { return record.version === 1 && record.id === id && ["published", "response", "file"].includes(record.kind) && Number.isSafeInteger(record.revision) && record.revision > 0; }
function pointerMatches(document: DocumentRecord, record: RevisionRecord): boolean { return document.digest === record.digest && document.bytes === record.bytes && document.title === record.title; }
function listLimit(limit?: number): number { if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1)) throw new StoreError("invalid", "Listing limit must be a positive integer."); return Math.min(LIMITS.listing, limit ?? LIMITS.listing); }
function absent(error: unknown): boolean { return (error as NodeJS.ErrnoException)?.code === "ENOENT"; }
type Checkpoint = "reuse-temp" | "source-index" | "intent" | "revision" | "pointer";
export type PublicationPlan = { publicationId: string; inputDigest: string; documentId: string; revision: number };
export function planPublication(input: WriteInput, document?: string, expectedRevision?: number): PublicationPlan {
	return { publicationId: randomUUID(), documentId: document ?? `md-${randomBytes(10).toString("hex")}`, revision: (expectedRevision ?? 0) + 1, inputDigest: publicationDigest(input, document, expectedRevision) };
}
function publicationDigest(input: WriteInput, document?: string, expectedRevision?: number): string {
	return input.invocationDigest ?? digest(JSON.stringify({ title: input.title, source: input.source, document, expectedRevision }));
}

type WriteOptions = { id?: string; expectedRevision?: number; kind?: DocumentKind; plan?: PublicationPlan; reuseKey?: string };
function records(input: WriteInput, plan: PublicationPlan, previous?: DocumentRecord, kind?: DocumentKind): { document: DocumentRecord; revision: RevisionRecord } {
	const now = new Date().toISOString();
	const documentKind = previous?.kind ?? kind ?? "published";
	const revision: RevisionRecord = { version: 1, document: plan.documentId, revision: plan.revision, title: input.title, createdAt: now, digest: digest(input.source), bytes: Buffer.byteLength(input.source), completeness: input.completeness ?? { state: "complete" }, contentOrigin: input.contentOrigin, references: input.references ?? { state: "uninspected", truncated: false, omitted: 0, items: [] } };
	if (revision.references.state === "inspected") revision.selfContained = !revision.references.truncated && revision.references.omitted === 0 && revision.references.items.every((item) => item.state === "retained" || item.state === "embedded");
	if (documentKind === "published") revision.publication = plan.publicationId;
	const document: DocumentRecord = { version: 1, id: plan.documentId, kind: documentKind, title: input.title, createdAt: previous?.createdAt ?? now, updatedAt: now, revision: plan.revision, digest: revision.digest, bytes: revision.bytes };
	return { document, revision };
}
async function retainAsset(staging: string, asset: CapturedAsset): Promise<void> {
	if (asset.record.state !== "retained" || !asset.data || !asset.record.file) return;
	await directory(join(staging, "assets"));
	try { await file(join(staging, asset.record.file), asset.data); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
}
async function prepareRevision(base: string, dest: string, input: WriteInput, revision: RevisionRecord, plan: PublicationPlan): Promise<RevisionRecord> {
	try {
		const orphan = await readJson<RevisionRecord>(join(dest, "revision.json"));
		if (orphan.publication === plan.publicationId) return orphan;
		await rm(dest, { recursive: true, force: true });
	} catch (error) { if (!absent(error)) throw error; }
	const staging = join(base, "revisions", `.tmp-${randomUUID()}`);
	try {
		await directory(staging);
		await file(join(staging, "source.md"), input.source);
		await file(join(staging, "revision.json"), JSON.stringify(revision));
		for (const asset of input.assets ?? []) await retainAsset(staging, asset);
		await rename(staging, dest);
	} catch (error) { await rm(staging, { recursive: true, force: true }); throw error; }
	return revision;
}

async function pruneStagingIn(parent: string, cutoff: number): Promise<void> {
	let entries: Awaited<ReturnType<typeof opendir>>;
	try { entries = await opendir(parent); } catch (error) { if (absent(error)) return; throw error; }
	let visited = 0;
	for await (const entry of entries) {
		if (++visited > LIMITS.listing) break;
		if (entry.isDirectory() && /^\.tmp-[0-9a-f-]{36}$/.test(entry.name)) await removeIfOlder(join(parent, entry.name), cutoff);
	}
}
async function removeIfOlder(path: string, cutoff: number): Promise<void> {
	try { if ((await stat(path)).mtimeMs < cutoff) await rm(path, { recursive: true, force: true }); } catch (error) { if (!absent(error)) throw error; }
}

/** All writers, including index admission, share one process-safe store lock. Readers take no lock. */
export class MarkdownStore {
	readonly root: string;
	private readonly checkpoint?: (step: Checkpoint) => void | Promise<void>;
	constructor(root: string, checkpoint?: (step: Checkpoint) => void | Promise<void>) { this.root = root; this.checkpoint = checkpoint; }
	private path(id: string, kind: DocumentKind = "published"): string { if (!validId(id)) throw new StoreError("invalid", "Invalid document identity."); return join(this.root, collection(kind), id); }
	private async locate(id: string): Promise<{ path: string; document: DocumentRecord }> {
		for (const name of ["documents", "snapshots"] as const) {
			const path = join(this.root, name, id);
			let document: DocumentRecord;
			try { document = await readJson<DocumentRecord>(join(path, "document.json")); } catch (error) { if (absent(error)) continue; throw error; }
			if (!validPointer(document, id) || collection(document.kind) !== name) throw new StoreError("store-failure", "Document kind disagrees with its collection.");
			return { path, document };
		}
		throw new StoreError("not-found", "Document not found.");
	}
	async identity(): Promise<StoreIdentity | undefined> {
		try {
			const value = await readJson<StoreIdentity>(join(this.root, "store.json"), 16384);
			if (!validIdentity(value)) throw new Error("Invalid store identity");
			return { version: 1, storeId: value.storeId };
		} catch (error) { if (absent(error)) return undefined; throw new StoreError("store-failure", "Store identity is unavailable or invalid."); }
	}
	async initialise(): Promise<StoreIdentity> {
		return this.locked(async () => {
			const value = await this.identity();
			if (!value) throw new StoreError("store-failure", "Store identity is unavailable.");
			return value;
		});
	}
	private async locked<T>(operation: () => Promise<T>): Promise<T> {
		await directory(this.root);
		const release = await lockfile.lock(this.root, { realpath: false, lockfilePath: join(this.root, ".lock"), stale: 10000, update: 2000, retries: { retries: 200, minTimeout: 10, maxTimeout: 100, randomize: true } });
		try {
			await chmod(join(this.root, ".lock"), 0o700);
			for (const name of ["documents", "snapshots", "sources", "reuse", "opens"]) await directory(join(this.root, name));
			if (!await this.identity()) await json(join(this.root, "store.json"), { version: 1, storeId: randomBytes(16).toString("hex") });
			return await operation();
		} finally { await release(); }
	}
	async get(identity: string, revision?: number): Promise<StoredDocument> {
		const id = validId(identity) ? identity : await this.resolve(identity);
		try {
			const { document, path } = await this.locate(id);
			const number = revision ?? document.revision;
			if (!Number.isSafeInteger(number) || number < 1 || number > document.revision) throw new StoreError("not-found", "Revision not found.");
			const base = join(path, "revisions", String(number));
			const record = await readJson<RevisionRecord>(join(base, "revision.json"));
			const bytes = await readBytes(join(base, "source.md"), LIMITS.sourceBytes);
			if (bytes.length > LIMITS.sourceBytes || record.version !== 1 || record.document !== id || record.revision !== number || record.digest !== digest(bytes) || record.bytes !== bytes.length) throw new Error("Invalid revision");
			if (number === document.revision && !pointerMatches(document, record)) throw new Error("Pointer and revision differ");
			const source = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
			return { document, revision: record, source };
		} catch (error) { if (error instanceof StoreError) throw error; if (absent(error)) throw new StoreError("not-found", "Document not found."); throw new StoreError("store-failure", "Document is unavailable or invalid."); }
	}
	async list(options: { kind?: DocumentKind; limit?: number } = {}): Promise<{ documents: DocumentRecord[]; bounded: boolean; scanned: number }> {
		const limit = listLimit(options.limit);
		const kind = options.kind ?? "published";
		const documents: DocumentRecord[] = [];
		let scanned = 0; let bounded = false;
		let entries: Awaited<ReturnType<typeof opendir>>;
		try { entries = await opendir(join(this.root, collection(kind))); } catch (error) { if (absent(error)) return { documents, bounded, scanned }; throw error; }
		for await (const entry of entries) {
			if (scanned >= LIMITS.listing) { bounded = true; break; }
			scanned++;
			if (!entry.isDirectory() || !validId(entry.name)) continue;
			try { const record = await readJson<DocumentRecord>(join(this.path(entry.name, kind), "document.json")); if (listingRecord(record, entry.name, kind)) documents.push(record); } catch { /* An incomplete or damaged document is not a listing row. */ }
		}
		documents.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
		return { documents: documents.slice(0, limit), bounded, scanned };
	}
	async resolve(prefix: string): Promise<string> {
		if (!/^md-[0-9a-f]{3,20}$/.test(prefix)) throw new StoreError("invalid", "Use an identity prefix of at least six characters.");
		const published = await this.matchNames("documents", prefix);
		const snapshots = await this.matchNames("snapshots", prefix);
		const matches = [...published.matches, ...snapshots.matches];
		if (matches.length > 1 || published.bounded || snapshots.bounded) throw new StoreError("invalid", "Identity prefix is ambiguous or exceeds the lookup bound.");
		if (!matches[0]) throw new StoreError("not-found", "Document not found.");
		return matches[0];
	}
	private async matchNames(name: "documents" | "snapshots", prefix: string): Promise<{ matches: string[]; bounded: boolean }> {
		const matches: string[] = []; let visited = 0; let bounded = false;
		let entries: Awaited<ReturnType<typeof opendir>>;
		try { entries = await opendir(join(this.root, name)); } catch (error) { if (absent(error)) return { matches, bounded }; throw error; }
		for await (const entry of entries) {
			if (visited++ >= 100000) { bounded = true; break; }
			if (entry.isDirectory() && validId(entry.name) && entry.name.startsWith(prefix)) matches.push(entry.name);
			if (matches.length > 1) break;
		}
		return { matches, bounded };
	}
	async reusePlan(key: string, inputDigest: string): Promise<PublicationPlan | undefined> {
		try {
			const plan = await readJson<PublicationPlan>(join(this.root, "reuse", `${hash(key)}.json`));
			if (plan.inputDigest !== inputDigest) throw new StoreError("replay-conflict", "Request identity already names different input.");
			return plan;
		} catch (error) { if (absent(error)) return undefined; throw error; }
	}
	async preparePlan(input: WriteInput, options: { document?: string; expectedRevision?: number; reuseKey?: string } = {}): Promise<PublicationPlan> {
		validateInput(input);
		return this.locked(() => this.publicationPlan(input, { id: options.document, expectedRevision: options.expectedRevision, reuseKey: options.reuseKey }));
	}
	async create(input: WriteInput, options: { kind?: DocumentKind; plan?: PublicationPlan; reuseKey?: string } = {}): Promise<WriteResult> {
		validateInput(input);
		return this.locked(() => this.write(input, { kind: options.kind ?? "published", plan: options.plan, reuseKey: options.reuseKey }));
	}
	async update(id: string, expectedRevision: number, input: WriteInput, options: { plan?: PublicationPlan; reuseKey?: string } = {}): Promise<WriteResult> {
		validateInput(input);
		if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) throw new StoreError("invalid", "Expected revision must be a positive integer.");
		return this.locked(() => this.write(input, { id, expectedRevision, plan: options.plan, reuseKey: options.reuseKey }));
	}
	async snapshot(sourceKey: string, kind: "response" | "file", input: WriteInput): Promise<WriteResult> {
		validateInput(input);
		return this.locked(async () => {
			const index = join(this.root, "sources", `${hash(sourceKey)}.json`);
			let existing: { documentId: string } | undefined;
			try { existing = await readJson(index); } catch (error) { if (!absent(error)) throw error; }
			const current = existing ? await this.sourceDocument(existing.documentId) : undefined;
			if (current && current.document.kind === kind) {
				if (current.revision.digest === digest(input.source)) return { ...current, created: false, replayed: true };
				return this.write(input, { id: current.document.id, expectedRevision: current.document.revision });
			}
			const plan = await this.snapshotPlan(index, input, existing, current);
			await this.checkpoint?.("source-index");
			return this.write(input, { kind, plan });
		});
	}
	private async snapshotPlan(index: string, input: WriteInput, existing?: { documentId: string }, current?: StoredDocument): Promise<PublicationPlan> {
		const plan = planPublication(input);
		if (existing && !current && validId(existing.documentId)) plan.documentId = existing.documentId;
		if (!existing) await jsonNew(index, { version: 1, documentId: plan.documentId });
		else if (existing.documentId !== plan.documentId) await json(index, { version: 1, documentId: plan.documentId });
		return plan;
	}
	private async sourceDocument(id: string): Promise<StoredDocument | undefined> {
		if (!validId(id)) return undefined;
		try { return await this.get(id); } catch (error) { if (error instanceof StoreError && error.code === "not-found") return undefined; throw error; }
	}
	private async publicationPlan(input: WriteInput, options: WriteOptions): Promise<PublicationPlan> {
		const inputDigest = publicationDigest(input, options.id, options.expectedRevision);
		let plan = options.plan;
		const request = options.reuseKey === undefined ? undefined : join(this.root, "reuse", `${hash(options.reuseKey)}.json`);
		let reused = false;
		if (request) { try { plan = await readJson<PublicationPlan>(request); reused = true; } catch (error) { if (!absent(error)) throw error; } }
		if (plan && plan.inputDigest !== inputDigest) throw new StoreError("replay-conflict", "Request identity already names different input.");
		plan ??= planPublication(input, options.id, options.expectedRevision);
		if (!validId(plan.documentId) || plan.revision !== (options.expectedRevision ?? 0) + 1 || (options.id && options.id !== plan.documentId)) throw new StoreError("invalid", "Invalid publication plan.");
		if (request && !reused) { await jsonNew(request, plan, () => this.checkpoint?.("reuse-temp")); await this.checkpoint?.("intent"); }
		return plan;
	}
	private async savedPublication(plan: PublicationPlan): Promise<WriteResult | undefined> {
		const id = plan.documentId;
		try {
			const saved = await this.get(id, plan.revision);
			if (saved.revision.publication === plan.publicationId) {
				return { ...saved, created: plan.revision === 1, replayed: true };
			}
		} catch (error) { if (!(error instanceof StoreError) || error.code !== "not-found") throw error; }
		return undefined;
	}
	private async previousDocument(id: string, options: WriteOptions): Promise<DocumentRecord | undefined> {
		let previous: DocumentRecord | undefined;
		try { previous = (await this.get(id)).document; } catch (error) { if (!(error instanceof StoreError) || error.code !== "not-found") throw error; }
		if (options.id && !previous) throw new StoreError("not-found", "Document not found.");
		if (previous && options.expectedRevision !== previous.revision) throw new StoreError("conflict", "Expected revision is stale.", previous.revision, previous.digest);
		return previous;
	}
	private async write(input: WriteInput, options: WriteOptions): Promise<WriteResult> {
		const plan = await this.publicationPlan(input, options);
		const saved = await this.savedPublication(plan);
		if (saved) return saved;
		await this.pruneStaging(["documents", "snapshots"].map((name) => join(this.root, name)));
		const id = plan.documentId;
		const previous = await this.previousDocument(id, options);
		const { document, revision } = records(input, plan, previous, options.kind);
		if (Buffer.byteLength(JSON.stringify(revision)) > LIMITS.recordBytes) throw new StoreError("too-large", "Revision metadata exceeds 256 KiB.");
		const number = plan.revision;
		const target = this.path(id, document.kind);
		if (previous) await this.pruneStaging([join(target, "revisions")]);
		const base = previous ? target : join(this.root, collection(document.kind), `.tmp-${randomUUID()}`);
		try {
			await directory(join(base, "revisions"));
			const dest = join(base, "revisions", String(number));
			const prepared = await prepareRevision(base, dest, input, revision, plan);
			await this.checkpoint?.("revision");
			await json(join(base, "document.json"), { ...document, title: prepared.title, updatedAt: prepared.createdAt, digest: prepared.digest, bytes: prepared.bytes });
			if (!previous) await rename(base, target);
		} catch (error) { if (!previous) await rm(base, { recursive: true, force: true }); throw error; }
		await this.checkpoint?.("pointer");
		return { ...await this.get(id, number), created: !previous, replayed: false };
	}
	/** Removes staging directories that a terminated writer left; committed documents and revisions have other names. */
	private async pruneStaging(parents: string[]): Promise<void> {
		for (const parent of parents) await pruneStagingIn(parent, Date.now() - LIMITS.stagingAgeMs);
	}
	async pruneOpenRequests(olderThanMs = 86400000): Promise<number> {
		if (!Number.isFinite(olderThanMs) || olderThanMs < 0) throw new StoreError("invalid", "Invalid request age.");
		return this.locked(() => this.pruneOpens(olderThanMs));
	}
	private async pruneOpens(olderThanMs: number): Promise<number> {
		const opens = join(this.root, "opens"); let visited = 0; let removed = 0;
		for await (const entry of await opendir(opens)) {
			if (++visited > LIMITS.listing) break;
			if (!entry.isFile() || !/^[0-9a-f-]{36}\.json$/.test(entry.name)) continue;
			const path = join(opens, entry.name);
			try { if ((await stat(path)).mtimeMs < Date.now() - olderThanMs) { await rm(path, { force: true }); removed++; } } catch (error) { if (!absent(error)) throw error; }
		}
		return removed;
	}
	async writeOpenRequest(document: string, revision: number, launchOrigin: unknown = null): Promise<string> {
		const selected = await this.get(document, revision);
		return this.locked(async () => {
			await this.pruneOpens(86400000);
			const { storeId } = await readJson<{ storeId: string }>(join(this.root, "store.json"));
			const path = join(this.root, "opens", `${randomUUID()}.json`);
			await file(path, JSON.stringify({ version: 1, storeId, document: selected.document.id, revision, digest: selected.revision.digest, requestedAt: new Date().toISOString(), launchOrigin }));
			return path;
		});
	}
}
