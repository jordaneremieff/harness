import { lstatSync } from "node:fs";
import { opendir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { hostname } from "node:os";
import { readVerifiedPrimaryEndpointDescriptor, removeDeadPrimaryEndpoint } from "./primary-channel.ts";
import type {
	PrimaryInfo,
	PrimaryObservedPurpose,
	PrimaryRepositoryState,
	PrimaryWorkReference,
} from "./primary-channel.ts";
import { sharedWorkReferences } from "./work-references.ts";
import { sharedTopics, topicTerms } from "./effort-topics.ts";
import type { Dirent } from "node:fs";
import type { AgentCatalog } from "./catalog.ts";
import type { CatalogIndexEntry } from "./catalog-index.ts";
import { readEffortRecords, type EffortRecord } from "./effort-catalog.ts";
import { isThreadStorage } from "./identity.ts";
import type { PrimaryLocationResolver } from "./effort-location.ts";
import { hostPaths } from "./host-protocol.ts";
import { observeClaim, type ClaimObservation } from "./claims.ts";
import type { NativeIntentMetadata } from "./durable-controls.ts";

type EffortFacts = Pick<
	PrimaryInfo,
	| "id"
	| "cwd"
	| "name"
	| "repository"
	| "repositoryState"
	| "startedAt"
	| "lastActivityAt"
	| "intentClaim"
	| "observedPurpose"
	| "workRefs"
	| "hostname"
>;

/** Session-written intent, never a verified host fact or a grant to its reader. */
export type PrimaryIntentClaim = {
	readonly purpose: string;
	readonly integration: string;
	readonly authority: string;
	readonly scope: { readonly paths: string[]; readonly branches: string[]; readonly fullGate?: boolean };
	readonly contactThread?: string;
	readonly updatedAt: string;
};

export type EffortPresenceSelf = Pick<
	PrimaryInfo,
	"id" | "cwd" | "name" | "repository" | "repositoryState" | "intentClaim" | "observedPurpose" | "workRefs"
>;
/** The reader's own facts with its topic terms, computed once per read. */
type PresenceSelf = EffortPresenceSelf & { readonly topics: ReadonlySet<string> };
export interface RelatedEffort {
	readonly id: string;
	readonly cwd: string;
	readonly name?: string;
	readonly repository?: string;
	readonly repositoryState?: PrimaryRepositoryState;
	readonly startedAt: string;
	readonly lastActivityAt?: string;
	readonly intentClaim?: PrimaryIntentClaim;
	readonly observedPurpose?: PrimaryObservedPurpose;
	readonly liveness: "live" | "unknown" | "incompatible";
	readonly relationship: "repository" | "cwd" | "machine";
	readonly purposeClaim?: string;
	readonly contactThreadClaim?: string;
	readonly intentUpdatedAt?: string;
	readonly sharedSubstrates?: ("repository" | "cwd" | "machine-gates")[];
	readonly overlap?: { readonly basis: "intentClaim"; readonly paths: string[]; readonly branches: string[] };
	/** Work items that both sessions reported using, newest first for the other session. */
	readonly sharedWork?: PrimaryWorkReference[];
	/** Distinctive words that both sessions' stated purposes, names and item titles use, in alphabetical order. */
	readonly sharedTopics?: string[];
}
/** Prompt rows that a shared topic alone adds, strongest first; shared items and location add more. */
export const PROMPT_TOPIC_ROWS = 4;
/** Shared work items an observation shows per related effort, newest first for the other session. */
const SHARED_WORK_SHOWN = 8;
export interface EffortPresenceCoverage {
	/** Producers or document rows without native intent support are not omitted claims. */
	unsupported?: number;
	outOfScope?: number;
	visited: number;
	unreadable: number;
	dead: number;
	unrelated: number;
	omitted: number;
	complete: boolean;
	reasons: string[];
}
export interface EffortPresencePage {
	readonly efforts: RelatedEffort[];
	readonly coverage: EffortPresenceCoverage;
	readonly limits: { readonly visits: number; readonly results: number; readonly bytes: number };
}
export const EFFORT_PRESENCE_LIMITS = { visits: 256, results: 20, bytes: 16 * 1024 } as const;

export interface EffortProjectScope {
	readonly prompt: boolean;
	matches(other: Pick<EffortPresenceSelf, "cwd" | "repository" | "repositoryState">): Promise<boolean>;
}

/** Resources one manager or native contribution owns for its effort reads. */
export interface EffortReadResources {
	readonly catalog: AgentCatalog;
	readonly locations: PrimaryLocationResolver;
}

/** Observed origin text is a fallback, never a competing declared purpose. */
export function observedPurposeFallback(value: {
	intentClaim?: PrimaryIntentClaim;
	purposeClaim?: string;
	observedPurpose?: PrimaryObservedPurpose;
}): Pick<RelatedEffort, "observedPurpose"> {
	return value.intentClaim !== undefined || value.purposeClaim !== undefined || value.observedPurpose === undefined
		? {}
		: { observedPurpose: value.observedPurpose };
}

/** Exact paths and component-boundary prefixes only; wildcard strings are not interpreted. */
function pathIntersection(a: string, b: string): string | undefined {
	const left = a.replace(/\/+$/u, "") || "/";
	const right = b.replace(/\/+$/u, "") || "/";
	if (left === right) return left;
	if (right.startsWith(left === "/" ? "/" : `${left}/`)) return right;
	if (left.startsWith(right === "/" ? "/" : `${right}/`)) return left;
	return undefined;
}

function claimOverlap(
	self: PrimaryIntentClaim | undefined,
	other: PrimaryIntentClaim | undefined,
): RelatedEffort["overlap"] {
	if (!self || !other) return undefined;
	const paths = new Set<string>();
	for (const a of self.scope.paths)
		for (const b of other.scope.paths) {
			const match = pathIntersection(a, b);
			if (match && paths.size < 32) paths.add(match);
		}
	const branches = [...new Set(self.scope.branches.filter((branch) => other.scope.branches.includes(branch)))];
	return paths.size || branches.length ? { basis: "intentClaim", paths: [...paths], branches } : undefined;
}

function relation(self: PresenceSelf, other: EffortFacts): RelatedEffort["relationship"] | undefined {
	if (self.repository && self.repository === other.repository) return "repository";
	if (self.cwd === other.cwd) return "cwd";
	return other.hostname === hostname() ? "machine" : undefined;
}

function markPartial(page: EffortPresencePage, reason: string): void {
	page.coverage.complete = false;
	if (!page.coverage.reasons.includes(reason)) page.coverage.reasons.push(reason);
}

function projectIntent(
	claim: PrimaryIntentClaim | undefined,
	relationship: RelatedEffort["relationship"],
): Pick<RelatedEffort, "intentClaim" | "purposeClaim" | "contactThreadClaim" | "intentUpdatedAt"> {
	if (!claim) return {};
	if (relationship !== "machine") return { intentClaim: claim };
	return {
		purposeClaim: claim.purpose,
		...(claim.contactThread === undefined ? {} : { contactThreadClaim: claim.contactThread }),
		intentUpdatedAt: claim.updatedAt,
	};
}

/** A declared machine gate is shared only with a live effort: a claim without a running claimant gates nothing. */
function sharedSubstrates(
	self: PresenceSelf,
	other: Pick<PrimaryInfo, "cwd" | "repository" | "intentClaim" | "hostname">,
): NonNullable<RelatedEffort["sharedSubstrates"]> {
	const shared: NonNullable<RelatedEffort["sharedSubstrates"]> = [];
	if (self.repository && self.repository === other.repository) shared.push("repository");
	if (self.cwd === other.cwd) shared.push("cwd");
	// A row of an effort that has ended is never collected, so every declared gate here can still be in use.
	if (other.hostname === hostname() && (self.intentClaim?.scope.fullGate || other.intentClaim?.scope.fullGate))
		shared.push("machine-gates");
	return shared;
}

/** Memoised by text, so unchanged descriptors are not tokenized again on later reads. */
const TOPIC_CACHE_ENTRIES = 1024;
const topicCache = new Map<string, ReadonlySet<string>>();
export function effortTopics(value: {
	name?: string;
	intentClaim?: { purpose: string };
	purposeClaim?: string;
	observedPurpose?: PrimaryObservedPurpose;
	workRefs?: readonly PrimaryWorkReference[];
}): ReadonlySet<string> {
	const texts = [
		value.intentClaim?.purpose ?? value.purposeClaim ?? value.observedPurpose?.text,
		value.name,
		...(value.workRefs ?? []).map((reference) => reference.title),
	];
	const key = texts.join("\u0000");
	const cached = topicCache.get(key);
	// Least recently used order: a hit moves the key to the newest end, so long-lived sessions stay.
	topicCache.delete(key);
	const terms = cached ?? topicTerms(texts);
	if (topicCache.size >= TOPIC_CACHE_ENTRIES) topicCache.delete(topicCache.keys().next().value as string);
	topicCache.set(key, terms);
	return terms;
}

function effortRow(
	info: EffortFacts,
	self: PresenceSelf,
	liveness: RelatedEffort["liveness"],
	relationship: RelatedEffort["relationship"],
	topics: string[],
	prompt: boolean,
): RelatedEffort {
	const { id, cwd, name, repository, repositoryState, startedAt, lastActivityAt, intentClaim, observedPurpose } = info;
	const overlap = relationship === "machine" ? undefined : claimOverlap(self.intentClaim, intentClaim);
	// A prompt selects shared items in identity order from the whole bounded list, so a recency
	// change on the other session never changes which items the row names.
	const shared = sharedWorkReferences(self.workRefs, info.workRefs);
	const sharedWork = prompt ? shared : shared.slice(0, SHARED_WORK_SHOWN);
	return {
		id,
		cwd,
		startedAt,
		liveness,
		relationship,
		...(name === undefined ? {} : { name }),
		...(repository === undefined ? {} : { repository }),
		...(repositoryState === undefined ? {} : { repositoryState }),
		...(lastActivityAt === undefined ? {} : { lastActivityAt }),
		...projectIntent(intentClaim, relationship),
		sharedSubstrates: sharedSubstrates(self, info),
		...observedPurposeFallback({ intentClaim, observedPurpose }),
		...(overlap === undefined ? {} : { overlap }),
		...(sharedWork.length === 0 ? {} : { sharedWork }),
		...(topics.length === 0 ? {} : { sharedTopics: topics }),
	};
}

/** Project rows, then rows that share items, then rows that share only a topic. */
function promptTier(row: RelatedEffort): number {
	return row.relationship !== "machine" ? 0 : row.sharedWork?.length ? 1 : 2;
}

/**
 * The prompt keeps project rows in identity order, then the rows with the most shared items, then
 * at most PROMPT_TOPIC_ROWS rows with the most shared topic terms, and shows them in identity order.
 */
function selectPromptEfforts(rows: RelatedEffort[], limit: number): RelatedEffort[] {
	const strength = (row: RelatedEffort, tier: number) =>
		tier === 1 ? (row.sharedWork?.length ?? 0) : tier === 2 ? (row.sharedTopics?.length ?? 0) : 0;
	const ranked = rows
		.map((row) => ({ row, tier: promptTier(row) }))
		.sort(
			(a, b) =>
				a.tier - b.tier || strength(b.row, b.tier) - strength(a.row, a.tier) || a.row.id.localeCompare(b.row.id),
		);
	const selected: RelatedEffort[] = [];
	let topicRows = 0;
	for (const { row, tier } of ranked) {
		if (selected.length >= limit) break;
		if (tier === 2 && topicRows++ >= PROMPT_TOPIC_ROWS) continue;
		selected.push(row);
	}
	return selected;
}

const LIVENESS_ORDER: Readonly<Record<RelatedEffort["liveness"], number>> = { live: 0, incompatible: 1, unknown: 2 };

/** The latest of a row's last activity, claim update and start, in milliseconds. */
function recency(row: RelatedEffort): number {
	const times = [row.lastActivityAt, row.intentClaim?.updatedAt ?? row.intentUpdatedAt, row.startedAt]
		.map((value) => (value === undefined ? Number.NaN : Date.parse(value)))
		.filter(Number.isFinite);
	return times.length === 0 ? 0 : Math.max(...times);
}

/**
 * Observation order: live efforts first (an incompatible one runs another version), efforts at the reader's
 * location before efforts elsewhere, then more shared items and shared words, then the most recent activity
 * or claim, then identity.
 */
function observationOrder(a: RelatedEffort, b: RelatedEffort): number {
	return (
		LIVENESS_ORDER[a.liveness] - LIVENESS_ORDER[b.liveness] ||
		Number(a.relationship === "machine") - Number(b.relationship === "machine") ||
		(b.sharedWork?.length ?? 0) - (a.sharedWork?.length ?? 0) ||
		(b.sharedTopics?.length ?? 0) - (a.sharedTopics?.length ?? 0) ||
		recency(b) - recency(a) ||
		a.id.localeCompare(b.id)
	);
}

/**
 * An observation keeps the first rows in observation order that fit its result and byte limits. The first row
 * that does not fit ends the page, so no row left out is more relevant than a row shown. Each row left out
 * counts as omitted.
 */
function limitObservation(page: EffortPresencePage): void {
	const ordered = page.efforts.sort(observationOrder);
	let bytes = 2;
	let kept = 0;
	for (const row of ordered) {
		const size = Buffer.byteLength(JSON.stringify(row)) + (kept > 0 ? 1 : 0);
		const reason =
			kept >= page.limits.results ? "result-limit" : bytes + size > page.limits.bytes - 1024 ? "byte-limit" : undefined;
		if (reason) {
			page.coverage.omitted += ordered.length - kept;
			markPartial(page, reason);
			break;
		}
		kept++;
		bytes += size;
	}
	page.efforts.splice(kept);
}

/**
 * A prompt names project efforts and, outside the project, only live sessions that reported using
 * the same work items or share a topic; null leaves the effort out of the prompt.
 */
function promptRelation(
	self: PresenceSelf,
	info: EffortFacts,
	matches: boolean,
	topics: string[],
): RelatedEffort["relationship"] | null {
	if (matches) return self.repository === undefined ? "cwd" : "repository";
	return topics.length > 0 || sharedWorkReferences(self.workRefs, info.workRefs).length > 0 ? "machine" : null;
}

async function collectEffort(
	page: EffortPresencePage,
	self: PresenceSelf,
	info: EffortFacts,
	liveness: RelatedEffort["liveness"],
	scope?: EffortProjectScope,
): Promise<void> {
	if (scope?.prompt && liveness !== "live") return;
	const matches = scope === undefined || (await scope.matches(info));
	if (!matches && liveness === "live") page.coverage.outOfScope = (page.coverage.outOfScope ?? 0) + 1;
	const topics = sharedTopics(self.topics, effortTopics(info));
	const relationship = scope?.prompt ? promptRelation(self, info, matches, topics) : relation(self, info);
	if (relationship === null) return;
	if (!relationship) {
		page.coverage.unrelated++;
		return;
	}
	// Rows are selected and limited once after the traversal; prompt bytes are bounded by the formatter.
	page.efforts.push(effortRow(info, self, liveness, relationship, topics, scope?.prompt ?? false));
}

type EndpointRead = Promise<Awaited<ReturnType<typeof readVerifiedPrimaryEndpointDescriptor>>>;

/**
 * Start the verified read of one endpoint record, or count a record that names no other session.
 * The reads of a walk run concurrently, so the socket probes of live PIDs overlap; their results are
 * applied in walk order.
 */
function startEntry(
	sessionsRoot: string,
	self: PresenceSelf,
	page: EffortPresencePage,
	entry: Dirent,
	pending: EndpointRead[],
): boolean {
	const id = entry.name.endsWith(".json") ? entry.name.slice(0, -5) : undefined;
	if (!entry.isFile() || id === undefined || id === self.id) {
		page.coverage.unrelated += 1;
		return false;
	}
	pending.push(readVerifiedPrimaryEndpointDescriptor(sessionsRoot, id));
	return true;
}

/**
 * Apply one endpoint read; true when it spends a visit. A record whose owner is proven dead (its
 * PID ended, or it was written before the current boot) is removed and costs no visit, so records
 * of crashed, killed or rebooted sessions neither accumulate nor take the budget of live ones. A
 * record that another reader removed meanwhile is gone, not unreadable.
 */
async function visitEntry(
	sessionsRoot: string,
	self: PresenceSelf,
	page: EffortPresencePage,
	descriptor: Awaited<EndpointRead>,
	scope?: EffortProjectScope,
): Promise<boolean> {
	if (descriptor.state === "absent") return false;
	if (descriptor.unreadable || !descriptor.info) {
		page.coverage.unreadable += 1;
		markPartial(page, "unreadable");
		return true;
	}
	if (descriptor.state === "dead") {
		page.coverage.dead += 1;
		removeDeadPrimaryEndpoint(sessionsRoot, descriptor.info.id);
		return false;
	}
	if (descriptor.info.repositoryState === "unknown") markPartial(page, "repository-unknown");
	await collectEffort(page, self, descriptor.info, descriptor.state, scope);
	return true;
}

/** Endpoint reads one walk keeps in flight before it applies them in walk order. */
const PRESENCE_READ_BATCH = 16;
/** Records one walk examines at most, whether they spend visits or not; the rest wait for a later read. */
const PRESENCE_SCAN_LIMIT = EFFORT_PRESENCE_LIMITS.visits * 4;

/**
 * One walk over the endpoint records. Sockets beside them and records that `visitEntry` reports
 * free cost no visit; reads are applied before the walk decides that its visit budget is spent, so
 * the limit counts only records that spent visits.
 */
class EndpointWalk {
	private readonly sessionsRoot: string;
	private readonly self: PresenceSelf;
	private readonly page: EffortPresencePage;
	private readonly scope: EffortProjectScope | undefined;
	private readonly pending: EndpointRead[] = [];
	private scanned = 0;
	constructor(sessionsRoot: string, self: PresenceSelf, page: EffortPresencePage, scope?: EffortProjectScope) {
		this.sessionsRoot = sessionsRoot;
		this.self = self;
		this.page = page;
		this.scope = scope;
	}
	private spent(inFlight: number): boolean {
		return this.page.coverage.visited + inFlight >= this.page.limits.visits || this.scanned >= PRESENCE_SCAN_LIMIT;
	}
	/** False once the visit budget or the scan limit is spent; the entry is then left for a later read. */
	async step(entry: Dirent): Promise<boolean> {
		if (this.spent(this.pending.length)) {
			await this.apply();
			if (this.spent(0)) {
				markPartial(this.page, "visit-limit");
				return false;
			}
		}
		this.scanned++;
		if (!startEntry(this.sessionsRoot, this.self, this.page, entry, this.pending)) this.page.coverage.visited++;
		if (this.pending.length >= PRESENCE_READ_BATCH) await this.apply();
		return true;
	}
	async apply(): Promise<void> {
		for (const read of this.pending.splice(0))
			if (await visitEntry(this.sessionsRoot, this.self, this.page, await read, this.scope))
				this.page.coverage.visited++;
	}
	async abandon(): Promise<void> {
		await Promise.allSettled(this.pending.splice(0));
	}
}

async function visitPrimaries(
	sessionsRoot: string,
	self: PresenceSelf,
	page: EffortPresencePage,
	scope?: EffortProjectScope,
): Promise<void> {
	let directory: Awaited<ReturnType<typeof opendir>>;
	try {
		directory = await opendir(join(sessionsRoot, ".primaries"), { bufferSize: 16 });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") markPartial(page, "directory-unreadable");
		return;
	}
	const walk = new EndpointWalk(sessionsRoot, self, page, scope);
	try {
		for await (const entry of directory) {
			if (!entry.name.endsWith(".json")) continue;
			if (!(await walk.step(entry))) break;
		}
		await walk.apply();
	} catch {
		await walk.abandon();
		markPartial(page, "directory-unreadable");
	}
}
/**
 * A serving host truncates its lease file and writes its record when it takes the lease, and a clean end adds
 * an end marker. One-shot writers, such as a cold stop, take the lease without writing a record. An empty lease
 * file therefore records no serving host, and presence treats it as a missing one. A starting host leaves the
 * file empty only between its truncation and its write.
 */
function servingHost(observation: ClaimObservation, path: string): ClaimObservation {
	if (observation.kind !== "unknown") return observation;
	try {
		return lstatSync(path).size === 0 ? { kind: "absent" } : observation;
	} catch {
		return observation;
	}
}

async function nativeRow(
	record: EffortRecord,
	id: string,
	metadata: NativeIntentMetadata,
	self: PresenceSelf,
	page: EffortPresencePage,
	claims: Map<string, ClaimObservation>,
	scope?: EffortProjectScope,
): Promise<void> {
	if (!metadata.claim || id === self.id) {
		page.coverage.unrelated++;
		return;
	}
	const name = record.names[id];
	const info: EffortFacts = {
		id,
		cwd: metadata.cwd,
		hostname: metadata.hostname,
		startedAt: metadata.startedAt,
		repositoryState: metadata.repositoryState,
		intentClaim: metadata.claim,
		...(metadata.repository === null ? {} : { repository: metadata.repository }),
		...(name === undefined ? {} : { name }),
	};
	if (info.repositoryState === "unknown") markPartial(page, "repository-unknown");
	let ownership = claims.get(record.storageId);
	if (ownership === undefined) {
		const paths = hostPaths(record);
		ownership = servingHost(observeClaim(paths.claim, paths.identity), paths.claim);
		claims.set(record.storageId, ownership);
	}
	if (ownership.kind === "absent" || ownership.kind === "dead") {
		page.coverage.dead++;
		return;
	}
	await collectEffort(page, self, info, ownership.kind === "live" ? "live" : "unknown", scope);
}
async function visitNativeRecord(
	catalog: AgentCatalog,
	record: EffortRecord,
	self: PresenceSelf,
	page: EffortPresencePage,
	claims: Map<string, ClaimObservation>,
	scope?: EffortProjectScope,
): Promise<void> {
	if (isThreadStorage(record, catalog.root)) return;
	const claimRows = record.intentClaims;
	if (!claimRows) {
		page.coverage.unsupported = (page.coverage.unsupported ?? 0) + 1;
		return;
	}
	page.coverage.omitted += claimRows.coverage.omitted;
	if (!claimRows.coverage.complete) markPartial(page, "native-intent-incomplete");
	// A conversation without a declared claim publishes a null row; only claims spend visits.
	for (const [id, metadata] of Object.entries(claimRows.rows)) {
		if (metadata === null) continue;
		if (page.coverage.visited >= page.limits.visits) {
			markPartial(page, "visit-limit");
			break;
		}
		page.coverage.visited++;
		await nativeRow(record, id, metadata, self, page, claims, scope);
	}
}
/**
 * Every catalog record through the process-wide record index: a record costs a stat, and only its
 * claim rows spend visits, so native efforts are covered however many records the catalog holds.
 */
async function visitNativeRoot(
	catalog: AgentCatalog,
	self: PresenceSelf,
	page: EffortPresencePage,
	records: readonly CatalogIndexEntry<EffortRecord>[] | undefined,
	scope?: EffortProjectScope,
): Promise<void> {
	let entries = records;
	if (entries === undefined) {
		try {
			entries = await readEffortRecords(catalog);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") markPartial(page, "directory-unreadable");
			return;
		}
	}
	// One writer claim observation serves every claim row in this record during one pass.
	const claims = new Map<string, ClaimObservation>();
	for (const entry of entries) {
		if (page.coverage.visited >= page.limits.visits) {
			markPartial(page, "visit-limit");
			return;
		}
		if (entry.value === undefined) {
			page.coverage.unreadable++;
			markPartial(page, "native-record-unreadable");
		} else await visitNativeRecord(catalog, entry.value, self, page, claims, scope);
	}
}

/** Read-only presence page; ordinary records and native projections share all visit, result and byte caps. */
export async function readRelatedEfforts(
	resources: EffortReadResources,
	reader: EffortPresenceSelf,
	scope?: EffortProjectScope,
	records?: readonly CatalogIndexEntry<EffortRecord>[],
): Promise<EffortPresencePage> {
	return finishRelatedEfforts(await collectRelatedEfforts(resources, reader, scope, records), scope);
}

/** Select the prompt rows, or apply the observation order and limits, to a collected page. */
export function finishRelatedEfforts(page: EffortPresencePage, scope?: EffortProjectScope): EffortPresencePage {
	if (scope?.prompt) {
		page.efforts.splice(0, page.efforts.length, ...selectPromptEfforts(page.efforts, page.limits.results));
		page.efforts.sort((a, b) => a.id.localeCompare(b.id));
	} else limitObservation(page);
	return page;
}

/**
 * Every related row that one traversal finds, before prompt selection or observation limits; the visit
 * limit still bounds the traversal. finishRelatedEfforts makes the page that a reader sees.
 */
export async function collectRelatedEfforts(
	resources: EffortReadResources,
	reader: EffortPresenceSelf,
	scope?: EffortProjectScope,
	records?: readonly CatalogIndexEntry<EffortRecord>[],
): Promise<EffortPresencePage> {
	const self: PresenceSelf = { ...reader, topics: effortTopics(reader) };
	const sessionsRoot = dirname(resources.catalog.root);
	const page: EffortPresencePage = {
		efforts: [],
		coverage: {
			visited: 0,
			unreadable: 0,
			dead: 0,
			unrelated: 0,
			omitted: 0,
			complete: true,
			reasons: [],
			...(scope === undefined ? {} : { outOfScope: 0 }),
		},
		limits: EFFORT_PRESENCE_LIMITS,
	};
	if (self.repositoryState === "unknown") markPartial(page, "repository-unknown");
	await visitPrimaries(sessionsRoot, self, page, scope);
	if (page.coverage.visited < page.limits.visits) await visitNativeRoot(resources.catalog, self, page, records, scope);
	return page;
}
