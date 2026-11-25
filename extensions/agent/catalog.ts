import { createHash, randomBytes, randomUUID } from "node:crypto";
import { catalogChange, publishCatalogChange, type CatalogChange } from "./catalog-events.ts";
import {
	closeSync,
	constants,
	fstatSync,
	lstatSync,
	mkdirSync,
	openSync,
	readSync,
	renameSync,
	unlinkSync,
	writeFileSync,
	linkSync,
	type BigIntStats,
	type Dirent,
} from "node:fs";
import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { type CatalogView, parseCatalogView } from "./catalog-view.ts";
import { parseCollaborationProjection, type CollaborationProjection } from "./collaboration-contract.ts";
import { CLAIM_BYTES, claimFilePresent, observeClaimAsync, type ClaimObservation } from "./claims.ts";
import { isThinkingLevel } from "./configuration.ts";
import { type HostMetadata, hostPaths, parseHostMetadata } from "./host-protocol.ts";

import { handleSlug, handleStorageId, isThreadStorage, threadStorageId } from "./identity.ts";
import { profileText } from "./profile-schema.ts";

const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u;
export const MAX_RECORD_BYTES = 32_768;
const MAX_VISITS = 256;
/** Claim age after which an explicit inventory read reconciles every record and claim. */
const EXPLICIT_RECONCILE_MS = 2_000;
/** Claim age after which a notice-driven background read reconciles every record and claim. */
export const BACKGROUND_RECONCILE_MS = 30_000;
const VALIDATED_RECORD_LIMIT = 512;
const VALIDATED_PAYLOAD_LIMIT = 8 * 1024 * 1024;
// A read opens the bounded file and checks its identity. Only an unchanged file skips payload reads.
interface ValidatedRecord {
	readonly revision: string;
	readonly record: CatalogRecord;
	readonly bytes: number;
}
const validatedRecords = new Map<string, ValidatedRecord>();
let validatedPayloadBytes = 0;
function forgetValidatedRecord(path: string): void {
	const cached = validatedRecords.get(path);
	if (cached === undefined) return;
	validatedRecords.delete(path);
	validatedPayloadBytes -= cached.bytes;
}
function rememberValidatedRecord(path: string, revision: string, record: CatalogRecord, bytes: number): void {
	forgetValidatedRecord(path);
	validatedRecords.set(path, { revision, record: structuredClone(record), bytes });
	validatedPayloadBytes += bytes;
	while (validatedRecords.size > VALIDATED_RECORD_LIMIT || validatedPayloadBytes > VALIDATED_PAYLOAD_LIMIT) {
		const oldest = validatedRecords.keys().next().value;
		if (oldest === undefined) break;
		forgetValidatedRecord(oldest);
	}
}
interface CatalogQuery {
	cursor?: string;
	limit?: number;
	query?: string;
	cwd?: string;
}
function requestStorageId(key: string): string {
	const hex = createHash("sha256").update(key).digest("hex").slice(0, 32);
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
function pageLimit(value: number | undefined): number {
	const limit = value ?? 20;
	if (!Number.isSafeInteger(limit) || limit < 1 || limit > 32)
		throw new Error("Catalog limit must be between 1 and 32");
	return limit;
}
function queryBinding(options: CatalogQuery): string {
	return JSON.stringify([options.query ?? "", options.cwd ?? ""]);
}
function startName(cursor: string | undefined, binding: string): string {
	if (!cursor) return "";
	let parsed: { binding?: unknown; after?: unknown } | null;
	try {
		parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
	} catch {
		throw new Error("Invalid catalog cursor; restart discovery");
	}
	if (
		!parsed ||
		typeof parsed.binding !== "string" ||
		typeof parsed.after !== "string" ||
		!parsed.after ||
		parsed.after.length > 255 ||
		/[/\0]/u.test(parsed.after)
	)
		throw new Error("Invalid catalog cursor; restart discovery");
	if (parsed.binding !== binding)
		throw new Error("Catalog cursor does not match the query or cwd; repeat the same query and cwd");
	return parsed.after;
}
function matches(record: CatalogRecord, options: CatalogQuery): boolean {
	if (options.cwd && options.cwd !== record.cwd) return false;
	const query = options.query?.toLocaleLowerCase();
	return (
		!query || [record.storageId, record.cwd, record.name ?? ""].some((text) => text.toLocaleLowerCase().includes(query))
	);
}
async function directoryEntries(root: string) {
	try {
		const entries = await readdir(root, { withFileTypes: true });
		// Filename order survives record replacement and insertion/removal before the cursor.
		return entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
}
export { CatalogIndex, type CatalogIndexEntry } from "./catalog-index.ts";
export interface CatalogRecord extends HostMetadata {
	createdAt: string;
	/** Optional bounded conversation projection; absent means the projection is unknown. */
	view?: CatalogView;
	/** Bounded discovery hints; native documents retain the full thread. */
	threads?: CollaborationProjection;
	/** Host-local marker: true before admission or resume, false only on a clean idle host with no deliveries. */
	recoveryDue?: boolean;
}
/** Extract retained metadata; acquisitions supply the caller's running Pi installation. */
export function hostMetadata(record: CatalogRecord, packageDir = record.packageDir): HostMetadata {
	const { createdAt: _createdAt, view: _view, threads: _threads, recoveryDue: _recoveryDue, ...metadata } = record;
	return { ...metadata, packageDir };
}
export interface CatalogPage {
	records: CatalogRecord[];
	nextCursor: string | null;
	coverage: { visited: number; skipped: number; complete: boolean };
	observedAt: string;
}

export interface CatalogPriorityCoverage {
	/** Initial directory snapshot bounds this scan; each candidate is read at most once. */
	candidates: number;
	inspected: number;
	unreadable: number;
	/** Claims whose live/dead owner classification is unavailable. */
	unknownClaims: number;
	returned: number;
	remaining: number;
	priorityRemaining: number;
	remainingRows: number;
	priorityRemainingRows: number;
	recordByteLimit: number;
	claimByteLimit: number;
	outputLimit: number;
}
export interface CatalogPriorityRecord {
	record: CatalogRecord;
	modifiedAt: number;
	priority: boolean;
	claim: ClaimObservation;
	observedAt: string;
}
interface PriorityKey {
	priority: boolean;
	modifiedAt: number;
	storageId: string;
}
function comparePriority(left: PriorityKey, right: PriorityKey): number {
	return (
		Number(right.priority) - Number(left.priority) ||
		right.modifiedAt - left.modifiedAt ||
		(left.storageId < right.storageId ? -1 : left.storageId > right.storageId ? 1 : 0)
	);
}

function checkPriorityLimit(limit: number): void {
	if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("Invalid roster output limit");
}
/**
 * The storage IDs that the earlier pages of one enumeration returned. A page returns the first records, in the
 * current order, that no earlier page returned. A position in the order cannot continue an enumeration: a record
 * that is created, or published again, between two pages sorts before every position.
 */
function priorityCursor(cursor: string | undefined, binding: string): Set<string> | undefined {
	if (!cursor) return;
	try {
		const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
		if (
			value.binding !== binding ||
			!Array.isArray(value.returned) ||
			!value.returned.every((id: unknown) => typeof id === "string")
		)
			throw new Error();
		return new Set(value.returned);
	} catch {
		throw new Error("Invalid roster cursor or caller changed; restart the roster");
	}
}

function fileStamp(info: BigIntStats): string {
	return `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`;
}

export interface CatalogFact {
	fileStamp: string;
	record: CatalogRecord;
	modifiedAt: number;
	claim: ClaimObservation;
	observedAt: string;
}
export interface CatalogInventory {
	/** Null means an identified source was unreadable, not absent. */
	facts: ReadonlyMap<string, CatalogFact | null>;
	/** Oldest retained observation; projecting a page does not advance freshness. */
	observedAt: string;
}
interface CatalogPriorityOptions {
	ownerIds?: readonly string[];
	activeStorageIds?: readonly string[];
	hasCurrentPublication?: (fact: CatalogFact) => boolean;
	cursor?: string;
	limit: number;
}
interface CatalogPriorityPage {
	items: CatalogPriorityRecord[];
	coverage: CatalogPriorityCoverage;
	nextCursor: string | null;
	observedAt: string;
}

/** One manager's derived inventory, reconciled on demand rather than by another timer. */
export class CatalogObservation {
	private facts = new Map<string, CatalogFact | null>();
	private dirty = new Set<string>();
	private full = true;
	private reconciledAt = 0;
	private observedAt = "";
	private pending?: Promise<CatalogInventory>;
	private readonly catalog: AgentCatalog;
	constructor(catalog: AgentCatalog) {
		this.catalog = catalog;
	}

	invalidate(change?: CatalogChange): void {
		const identities = catalogChange(change);
		if (!identities) {
			this.full = true;
			this.dirty.clear();
			return;
		}
		if (this.full) return;
		for (const id of identities) this.dirty.add(id);
		if (!catalogChange([...this.dirty])) {
			this.full = true;
			this.dirty.clear();
		}
	}

	ownerId(storageId: string): string | undefined {
		return this.facts.get(storageId)?.record.ownerId;
	}

	/**
	 * Every read checks all record stamps. Explicit reads (dashboard, status, list) also observe every
	 * claim when the last full pass is two seconds old, which reveals silent host deaths. Background
	 * readers that react to change notices pass a longer bound, so a busy host elsewhere does not make
	 * every ordinary session observe every claim in the catalogue every two seconds.
	 */
	read(options: { reconcileAfterMs?: number } = {}): Promise<CatalogInventory> {
		// A stricter reader that joins a read in flight still gets a full pass before it resolves.
		if (Date.now() - this.reconciledAt >= (options.reconcileAfterMs ?? EXPLICIT_RECONCILE_MS)) this.full = true;
		if (this.pending) return this.pending;
		this.pending = this.refresh().finally(() => {
			this.pending = undefined;
		});
		return this.pending;
	}

	private async refresh(): Promise<CatalogInventory> {
		try {
			do {
				const full = this.full;
				this.full = false;
				const changed = new Set(this.dirty);
				this.dirty.clear();
				const started = Date.now();
				// A full pass in progress already satisfies readers that join it; a failed pass forces another.
				if (full) this.reconciledAt = started;
				const identities = await this.catalog.identities();
				const facts = new Map<string, CatalogFact | null>();
				for (const id of identities) await this.refreshRecord(facts, id, full || changed.has(id));
				this.facts = facts;
				if (full) this.observedAt = new Date(started).toISOString();
			} while (this.full || this.dirty.size);
			return { facts: this.facts, observedAt: this.observedAt };
		} catch (error) {
			this.full = true;
			throw error;
		}
	}

	private async refreshRecord(facts: Map<string, CatalogFact | null>, id: string, dirty: boolean): Promise<void> {
		try {
			const stamp = this.catalog.recordStamp(id);
			const previous = this.facts.get(id);
			if (previous?.fileStamp !== stamp) facts.set(id, await this.catalog.observeRecord(id));
			else
				facts.set(
					id,
					dirty
						? {
								...previous,
								claim: await this.catalog.observeClaim(previous.record),
								observedAt: new Date().toISOString(),
							}
						: previous,
				);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") facts.delete(id);
			else facts.set(id, null);
		}
	}
}

/** Rank raw facts for this caller only; continuations bind the caller's ownership set. */
export function projectCatalogPriority(
	inventory: CatalogInventory,
	options: CatalogPriorityOptions,
): CatalogPriorityPage {
	checkPriorityLimit(options.limit);
	const ownerIds = options.ownerIds ?? [];
	const activeStorageIds = options.activeStorageIds ?? [];
	const binding = JSON.stringify([[...ownerIds].sort(), [...activeStorageIds].sort()]);
	const returned = priorityCursor(options.cursor, binding);
	const coverage: CatalogPriorityCoverage = {
		candidates: inventory.facts.size,
		inspected: inventory.facts.size,
		unreadable: 0,
		unknownClaims: 0,
		returned: 0,
		remaining: 0,
		priorityRemaining: 0,
		remainingRows: 0,
		priorityRemainingRows: 0,
		recordByteLimit: MAX_RECORD_BYTES,
		claimByteLimit: CLAIM_BYTES,
		outputLimit: options.limit,
	};
	const items: CatalogPriorityRecord[] = [];
	for (const fact of inventory.facts.values()) {
		if (!fact) {
			coverage.unreadable++;
			continue;
		}
		const { record, modifiedAt, claim } = fact;
		coverage.unknownClaims += Number(claim.kind === "unknown");
		const priority =
			claim.kind === "live" ||
			ownerIds.includes(record.ownerId ?? "") ||
			activeStorageIds.includes(record.storageId) ||
			options.hasCurrentPublication?.(fact) === true;
		if (returned?.has(record.storageId)) continue;
		items.push({ record, modifiedAt, priority, claim, observedAt: fact.observedAt });
	}
	items.sort((left, right) =>
		comparePriority({ ...left, storageId: left.record.storageId }, { ...right, storageId: right.record.storageId }),
	);
	const selected = items.slice(0, options.limit);
	coverage.returned = selected.length;
	coverage.remaining = items.length - selected.length;
	const remaining = items.slice(selected.length);
	coverage.priorityRemaining = remaining.filter((item) => item.priority).length;
	const rowCount = (item: CatalogPriorityRecord) =>
		!item.record.view || item.record.view.unavailable ? 1 : item.record.view.rows.length;
	coverage.remainingRows = remaining.reduce((total, item) => total + rowCount(item), 0);
	coverage.priorityRemainingRows = remaining
		.filter((item) => item.priority)
		.reduce((total, item) => total + rowCount(item), 0);
	const nextCursor = remaining.length
		? Buffer.from(
				JSON.stringify({
					binding,
					returned: [...(returned ?? []), ...selected.map((item) => item.record.storageId)],
				}),
			).toString("base64url")
		: null;
	return { items: selected, coverage, nextCursor, observedAt: inventory.observedAt };
}

/** Result of one catalog create: the retained record and whether this call created it. */
export interface CatalogCreateResult {
	readonly record: CatalogRecord;
	/** True when this call wrote the record; false when the request ID reused a retained one. */
	readonly created: boolean;
}

/** Outcome of one guarded discard. Only `removed` changes state. */
export type CatalogDiscardResult = "removed" | "record-changed" | "storage-present" | "writer-present";

/** Locate storage without revalidating a retained conversation selector. */
export function storageIdOf(identity: string): string {
	const [storageId, conversationId, extra] = identity.split(":");
	if (!UUID.test(storageId) || extra !== undefined || (conversationId !== undefined && !/^\d+$/u.test(conversationId)))
		throw new Error(
			`Invalid Durable agent identity ${JSON.stringify(identity.slice(0, 80))}. Use @handle, or an exact identity from agent_status or agent_list: storageId, or storageId:conversationId. Display names and ID prefixes are not identities.`,
		);
	return storageId;
}

/** Validate an exact delivery recipient before accepting a new route. */
export function validateDeliveryRecipient(identity: string): void {
	try {
		const storageId = storageIdOf(identity);
		if (storageId === identity) return;
		const suffix = identity.slice(storageId.length + 1);
		const id = Number(suffix);
		if (Number.isSafeInteger(id) && id > 0 && String(id) === suffix) return;
	} catch {
		// Storage lookup rejected the identity before the conversation-ID check.
	}
	throw new Error("Delivery recipient must be an exact native or primary identity");
}

/** Discovery metadata locates storage. It never substitutes for native conversation state. */
export class AgentCatalog {
	readonly root: string;
	constructor(root: string) {
		this.root = resolve(root, "durable");
	}
	create(input: Omit<HostMetadata, "storageId" | "storagePath">, requestId?: string): CatalogRecord {
		return this.createTracked(input, requestId).record;
	}

	/** Publish one complete handle claim without replacing a concurrent creator's record. */
	createHandled(
		input: Omit<HostMetadata, "storageId" | "storagePath">,
		handle: string,
		role: string,
	): CatalogCreateResult {
		handleSlug(handle);
		profileText(role, "role");
		mkdirSync(this.root, { recursive: true, mode: 0o700 });
		const storageId = handleStorageId(handle, this.root);
		const metadata = parseHostMetadata({ ...input, storageId, storagePath: join(this.root, `${storageId}.sqlite`) });
		if (!isThinkingLevel(metadata.thinkingLevel)) throw new Error("Unknown reasoning level");
		const createdAt = new Date().toISOString();
		const record: CatalogRecord = {
			...metadata,
			createdAt,
			view: {
				updatedAt: createdAt,
				storageId,
				rows: [],
				coverage: { complete: false, omitted: 1 },
				profileSeed: { handle, role },
			},
		};
		const prepared = join(this.root, `.${storageId}.${randomUUID()}.claim`);
		writeFileSync(prepared, `${JSON.stringify(record)}\n`, { flag: "wx", mode: 0o600 });
		try {
			try {
				linkSync(prepared, this.path(storageId));
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
				return { record: this.read(storageId), created: false };
			}
		} finally {
			unlinkSync(prepared);
		}
		forgetValidatedRecord(this.path(storageId));
		publishCatalogChange(this.root, storageId);
		return { record, created: true };
	}

	/** Publish the owner's thread storage record, or return the one a concurrent creator published. */
	createThreadStorage(
		input: Omit<HostMetadata, "storageId" | "storagePath"> & { ownerId: string },
	): CatalogCreateResult {
		mkdirSync(this.root, { recursive: true, mode: 0o700 });
		const storageId = threadStorageId(input.ownerId, this.root);
		const metadata = parseHostMetadata({ ...input, storageId, storagePath: join(this.root, `${storageId}.sqlite`) });
		if (!isThinkingLevel(metadata.thinkingLevel)) throw new Error("Unknown reasoning level");
		const record: CatalogRecord = { ...metadata, createdAt: new Date().toISOString() };
		const prepared = join(this.root, `.${storageId}.${randomUUID()}.claim`);
		writeFileSync(prepared, `${JSON.stringify(record)}\n`, { flag: "wx", mode: 0o600 });
		try {
			try {
				linkSync(prepared, this.path(storageId));
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
				return { record: this.read(storageId), created: false };
			}
		} finally {
			unlinkSync(prepared);
		}
		forgetValidatedRecord(this.path(storageId));
		publishCatalogChange(this.root, storageId);
		return { record, created: true };
	}

	/**
	 * Create the record, or reuse the one retained for this request ID. The result
	 * marks whether this call owns the new record, so a caller can discard only
	 * its own record when the first acquire fails.
	 */
	createTracked(
		input: Omit<HostMetadata, "storageId" | "storagePath">,
		requestId?: string,
		beforeCreate?: (storageId: string) => void,
	): CatalogCreateResult {
		mkdirSync(this.root, { recursive: true, mode: 0o700 });
		const storageId =
			requestId === undefined ? randomUUID() : requestStorageId(JSON.stringify([input.ownerId, requestId]));
		const metadata = parseHostMetadata({ ...input, storageId, storagePath: join(this.root, `${storageId}.sqlite`) });
		if (!isThinkingLevel(metadata.thinkingLevel)) throw new Error("Unknown reasoning level");
		const record: CatalogRecord = { ...metadata, createdAt: new Date().toISOString() };
		const text = `${JSON.stringify(record)}\n`;
		if (Buffer.byteLength(text, "utf8") > MAX_RECORD_BYTES) throw new Error("Agent metadata exceeds its bound");
		beforeCreate?.(storageId);
		const path = this.path(storageId);
		const prepared = join(this.root, `.${storageId}.${randomUUID()}.claim`);
		const fd = openSync(prepared, "wx", 0o600);
		try {
			try {
				writeFileSync(fd, text, "utf8");
			} finally {
				closeSync(fd);
			}
			try {
				linkSync(prepared, path);
			} catch (error) {
				if (requestId === undefined || (error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
				const previous = this.read(storageId);
				if (JSON.stringify(hostMetadata(previous, metadata.packageDir)) !== JSON.stringify(metadata))
					throw new Error("Spawn request ID already belongs to different agent configuration");
				return { record: previous, created: false };
			}
		} finally {
			try {
				unlinkSync(prepared);
			} catch {
				// A leftover staging file does not change the result at the published path.
			}
		}
		forgetValidatedRecord(path);
		publishCatalogChange(this.root, storageId);
		return { record, created: true };
	}

	/**
	 * Remove a record this call created when its host never opened. The record
	 * must be byte-identical at the same inode, no storage file may exist, and
	 * no native writer claim file may exist. An ended diagnostic record does
	 * not exclude a new holder before its metadata write, and a starting host's
	 * file is empty between its truncation and its record. Any claim file,
	 * reused record, or changed path is kept.
	 * Call this only for a `created: true` result.
	 */
	discardUnopened(record: CatalogRecord): CatalogDiscardResult {
		const path = this.path(record.storageId);
		const before = this.readRaw(record.storageId);
		if (before === undefined || before.raw !== `${JSON.stringify(record)}\n`) return "record-changed";
		if (lstatSync(record.storagePath, { throwIfNoEntry: false }) !== undefined) return "storage-present";
		if (claimFilePresent(hostPaths(record).claim)) return "writer-present";
		const current = lstatSync(path, { throwIfNoEntry: false });
		if (current === undefined || current.dev !== before.dev || current.ino !== before.ino) return "record-changed";
		unlinkSync(path);
		forgetValidatedRecord(path);
		publishCatalogChange(this.root, record.storageId);
		return "removed";
	}
	/**
	 * The first identity in a chain of creating owners that names no agent storage: normally the ordinary Pi session
	 * whose agent started the chain. Undefined when a record in the chain has no owner or the chain exceeds 32 steps.
	 */
	ordinaryOwner(ownerId: string | undefined): string | undefined {
		for (let depth = 0; ownerId !== undefined && depth < 32; depth++) {
			const target: string = ownerId;
			try {
				ownerId = this.read(target).ownerId;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
				return target;
			}
		}
		return undefined;
	}
	/** Read the storage already assigned to one creation request, without resolving defaults again. */
	readRequest(ownerId: string, requestId: string): CatalogRecord | undefined {
		try {
			const record = this.read(requestStorageId(JSON.stringify([ownerId, requestId])));
			if (record.ownerId !== ownerId) throw new Error("Spawn request record has a different creating owner");
			return record;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
			throw error;
		}
	}
	path(identity: string): string {
		return join(this.root, `${storageIdOf(identity)}.json`);
	}
	read(identity: string): CatalogRecord {
		return this.readWithTime(identity).record;
	}

	readHandle(handle: string): CatalogRecord | undefined {
		try {
			return this.read(handleStorageId(handle, this.root));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			return undefined;
		}
	}

	/**
	 * The owner when the identity names a thread storage of this catalog. Undefined for every other
	 * identity, including one that has no record or an unreadable one.
	 */
	threadStorageOwner(identity: string): string | undefined {
		try {
			const { record } = this.readRetained(identity, true);
			return isThreadStorage(record, this.root) ? record.ownerId : undefined;
		} catch {
			return undefined;
		}
	}

	/**
	 * Derive a value from one validated record, with the record's file stamp. The record can be the
	 * cache's own object: `project` copies what it keeps and changes nothing. The read neither enters
	 * the record into the validated-record cache nor renews its entry, so a scan of the whole catalog
	 * leaves that cache as it is.
	 */
	derive<T>(identity: string, project: (record: CatalogRecord) => T): { fileStamp: string; value: T } {
		const { record, fileStamp } = this.readRetained(identity, false);
		return { fileStamp, value: project(record) };
	}

	private readWithTime(identity: string): { record: CatalogRecord; modifiedAt: number; fileStamp: string } {
		const { retained, ...value } = this.readRetained(identity, true);
		return retained ? { ...value, record: structuredClone(value.record) } : value;
	}

	/**
	 * One validated read. A retained record is the cache's own object: read it, never change it or
	 * return it. `remember` false neither enters a parsed record into the cache nor renews its entry.
	 */
	private readRetained(
		identity: string,
		remember: boolean,
	): { record: CatalogRecord; modifiedAt: number; fileStamp: string; retained: boolean } {
		const storageId = storageIdOf(identity);
		const path = this.path(storageId);
		const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
		try {
			const info = fstatSync(fd, { bigint: true });
			if (!info.isFile() || info.size > BigInt(MAX_RECORD_BYTES))
				throw new Error("Agent metadata exceeds its bound or is not a regular file");
			const revision = fileStamp(info);
			const cached = validatedRecords.get(path);
			if (cached?.revision === revision) {
				if (remember) {
					validatedRecords.delete(path);
					validatedRecords.set(path, cached);
				}
				return { record: cached.record, modifiedAt: Number(info.mtimeMs), fileStamp: revision, retained: true };
			}
			forgetValidatedRecord(path);
			const { record, length } = this.parseRecord(fd, storageId);
			const after = fstatSync(fd, { bigint: true });
			if (remember && fileStamp(after) === revision) rememberValidatedRecord(path, revision, record, length);
			return { record, modifiedAt: Number(info.mtimeMs), fileStamp: revision, retained: false };
		} finally {
			closeSync(fd);
		}
	}

	/** Bounded read and full validation of one opened record. */
	private parseRecord(fd: number, storageId: string): { record: CatalogRecord; length: number } {
		const bytes = Buffer.alloc(MAX_RECORD_BYTES + 1);
		let length = 0;
		while (length < bytes.length) {
			const count = readSync(fd, bytes, length, bytes.length - length, length);
			if (!count) break;
			length += count;
		}
		if (length > MAX_RECORD_BYTES) throw new Error("Agent metadata exceeds its read bound");
		const value: unknown = JSON.parse(bytes.toString("utf8", 0, length));
		if (!value || typeof value !== "object") throw new Error("Agent metadata is invalid");
		const record = value as CatalogRecord;
		if (
			record.storageId !== storageId ||
			record.storagePath !== join(this.root, `${storageId}.sqlite`) ||
			typeof record.cwd !== "string" ||
			!record.cwd.startsWith("/") ||
			typeof record.agentDir !== "string" ||
			typeof record.packageDir !== "string" ||
			typeof record.createdAt !== "string" ||
			typeof record.model?.provider !== "string" ||
			typeof record.model?.modelId !== "string"
		)
			throw new Error("Agent metadata is invalid");
		parseHostMetadata(hostMetadata(record));
		if (!isThinkingLevel(record.thinkingLevel)) throw new Error("Agent metadata has an unknown reasoning level");
		this.parseProjections(record);
		if (record.recoveryDue !== undefined && typeof record.recoveryDue !== "boolean")
			throw new Error("Agent metadata has an invalid recovery marker");
		return { record, length };
	}

	/**
	 * Capture source identities before byte-bounded record and claim observation: the records of a
	 * names-only listing in storage ID order. Other directory entries cost a name test and nothing else.
	 */
	async identities(): Promise<string[]> {
		let names: string[];
		try {
			names = await readdir(this.root);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
			throw error;
		}
		const identities: string[] = [];
		for (const name of names)
			if (name.endsWith(".json") && UUID.test(name.slice(0, -5))) identities.push(name.slice(0, -5));
		return identities.sort();
	}

	/** Check a catalog pathname without opening its payload or following a symlink. */
	recordStamp(storageId: string): string {
		const info = lstatSync(this.path(storageId), { bigint: true });
		if (!info.isFile() || info.size > BigInt(MAX_RECORD_BYTES))
			throw new Error("Agent metadata exceeds its bound or is not a regular file");
		return fileStamp(info);
	}

	/** The single record/claim read seam for raw inventory observations. */
	async observeRecord(storageId: string): Promise<CatalogFact> {
		const value = this.readWithTime(storageId);
		return { ...value, claim: await this.observeClaim(value.record), observedAt: new Date().toISOString() };
	}

	/** Claim freshness is independent of an unchanged catalog payload. */
	async observeClaim(record: CatalogRecord): Promise<ClaimObservation> {
		const paths = hostPaths(record);
		return observeClaimAsync(paths.claim, paths.identity);
	}

	/** Standalone callers observe once; manager consumers share their owned observation. */
	async priorityPage(options: CatalogPriorityOptions): Promise<CatalogPriorityPage> {
		return projectCatalogPriority(await new CatalogObservation(this).read(), options);
	}

	/**
	 * Replace one record's bounded view, preserving every immutable field from
	 * the stored record. The caller owns the storage writer claim; a symlink,
	 * corrupt record, missing record, or wrong stored identity is refused.
	 */
	updateView(identity: string, view: CatalogView, threads?: CollaborationProjection): CatalogRecord {
		const record = this.read(identity);
		const parsed = parseCatalogView(view);
		this.checkViewIdentity(record.storageId, parsed);
		return this.rewrite({
			...record,
			view: parsed,
			...(threads === undefined ? {} : { threads: parseCollaborationProjection(threads, record.storageId) }),
		});
	}

	private parseProjections(record: CatalogRecord): void {
		if (record.view !== undefined) record.view = this.observedView(record.storageId, record.view);
		if (record.threads !== undefined) record.threads = parseCollaborationProjection(record.threads, record.storageId);
	}

	/** Unknown cached values are unavailable observations, not alternate native state shapes. */
	private observedView(storageId: string, value: CatalogView): CatalogView {
		if (value?.storageId !== undefined && value.storageId !== storageId)
			throw new Error("Agent view storageId does not match its catalog record");
		if (Array.isArray(value?.rows)) this.checkViewIdentity(storageId, value);
		try {
			return parseCatalogView(value);
		} catch {
			const states = Array.isArray(value?.rows)
				? value.rows.slice(0, 5).map((row) => String(row?.state).slice(0, 64))
				: [];
			return {
				storageId,
				updatedAt: new Date().toISOString(),
				rows: [],
				coverage: { complete: false, omitted: 0 },
				unavailable: `Host metadata is unsupported by this Pi (states: ${JSON.stringify(states)}). Restart this Pi if the host runs newer code. No cached state was interpreted.`,
			};
		}
	}

	private checkViewIdentity(storageId: string, view: CatalogView): void {
		if (
			(view.storageId !== undefined && view.storageId !== storageId) ||
			view.rows.some((row) => row.storageId !== storageId)
		)
			throw new Error("Agent view storageId does not match its catalog record");
	}

	/**
	 * Set the host-local recovery marker, preserving the view and every immutable
	 * field. The caller sets true before admission or resume and clears it when
	 * no native work or active delivery remains.
	 */
	markRecoveryDue(identity: string, recoveryDue: boolean): CatalogRecord {
		if (typeof recoveryDue !== "boolean") throw new TypeError("recoveryDue must be a boolean");
		const record = this.read(identity);
		if (record.recoveryDue === recoveryDue) return record;
		return this.rewrite({ ...record, recoveryDue });
	}

	/** Atomically replace one record; the caller owns the storage writer claim. */
	private rewrite(record: CatalogRecord): CatalogRecord {
		const text = `${JSON.stringify(record)}\n`;
		if (Buffer.byteLength(text, "utf8") > MAX_RECORD_BYTES) throw new Error("Agent metadata exceeds its bound");
		const path = this.path(record.storageId);
		const temporary = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
		writeFileSync(temporary, text, { flag: "wx", mode: 0o600 });
		try {
			renameSync(temporary, path);
		} catch (error) {
			try {
				unlinkSync(temporary);
			} catch {
				// The rename failure is retained.
			}
			throw error;
		}
		forgetValidatedRecord(path);
		publishCatalogChange(this.root, record.storageId);
		return record;
	}

	/** Bounded, symlink-refusing read of one record with its file identity. */
	private readRaw(identity: string): { raw: string; dev: number; ino: number } | undefined {
		const storageId = storageIdOf(identity);
		let fd: number;
		try {
			fd = openSync(this.path(storageId), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
		} catch {
			return undefined;
		}
		try {
			const info = fstatSync(fd);
			if (!info.isFile() || info.size > MAX_RECORD_BYTES) return undefined;
			const bytes = Buffer.alloc(MAX_RECORD_BYTES + 1);
			let length = 0;
			while (length < bytes.length) {
				const count = readSync(fd, bytes, length, bytes.length - length, length);
				if (!count) break;
				length += count;
			}
			if (length > MAX_RECORD_BYTES) return undefined;
			return { raw: bytes.toString("utf8", 0, length), dev: info.dev, ino: info.ino };
		} catch {
			return undefined;
		} finally {
			closeSync(fd);
		}
	}

	private select(name: string, options: CatalogQuery): CatalogRecord | undefined {
		if (!name.endsWith(".json") || !UUID.test(name.slice(0, -5))) return;
		const record = this.read(name.slice(0, -5));
		return matches(record, options) ? record : undefined;
	}
	async page(options: CatalogQuery = {}): Promise<CatalogPage> {
		const limit = pageLimit(options.limit);
		const observedAt = new Date().toISOString();
		const binding = queryBinding(options);
		const start = startName(options.cursor, binding);
		const entries = await directoryEntries(this.root);
		const first = entries.findIndex((entry) => entry.name > start);
		return this.collectPage(entries, first === -1 ? entries.length : first, limit, options, observedAt).page;
	}

	/** Read several internal pages from one directory listing; record contents remain independently observed. */
	async *scanPages(limit: number, maxPages: number): AsyncGenerator<CatalogPage> {
		const size = pageLimit(limit);
		const observedAt = new Date().toISOString();
		const entries = await directoryEntries(this.root);
		let first = 0;
		for (let count = 0; count < maxPages; count++) {
			const { page, next } = this.collectPage(entries, first, size, {}, observedAt);
			yield page;
			if (page.nextCursor === null) return;
			first = next;
		}
	}

	private collectPage(
		entries: readonly Dirent[],
		first: number,
		limit: number,
		options: CatalogQuery,
		observedAt: string,
	): { page: CatalogPage; next: number } {
		const records: CatalogRecord[] = [];
		let next = first;
		let skipped = 0;
		for (; next < entries.length && next - first < MAX_VISITS && records.length < limit; next++) {
			try {
				const record = this.select(entries[next].name, options);
				if (record) records.push(record);
			} catch {
				skipped++;
			}
		}
		const complete = next === entries.length;
		const nextCursor = complete
			? null
			: Buffer.from(JSON.stringify({ binding: queryBinding(options), after: entries[next - 1].name })).toString(
					"base64url",
				);
		return {
			next,
			page: { records, nextCursor, coverage: { visited: next - first, skipped, complete }, observedAt },
		};
	}
}
