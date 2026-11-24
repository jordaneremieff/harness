import { opendir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { hostname } from "node:os";
import { readPrimaryEndpointDescriptor } from "./primary-channel.ts";
import type {
	PrimaryInfo,
	PrimaryObservedPurpose,
	PrimaryRepositoryState,
	PrimaryWorkReference,
} from "./primary-channel.ts";
import { sharedWorkReferences } from "./work-references.ts";
import { sharedTopics, topicTerms } from "./effort-topics.ts";
import type { Dirent } from "node:fs";
import type { AgentCatalog, CatalogRecord } from "./catalog.ts";
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
/** Shared work items shown per related effort. */
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

function sharedSubstrates(
	self: PresenceSelf,
	other: Pick<PrimaryInfo, "cwd" | "repository" | "intentClaim" | "hostname">,
): NonNullable<RelatedEffort["sharedSubstrates"]> {
	const shared: NonNullable<RelatedEffort["sharedSubstrates"]> = [];
	if (self.repository && self.repository === other.repository) shared.push("repository");
	if (self.cwd === other.cwd) shared.push("cwd");
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
): RelatedEffort {
	const { id, cwd, name, repository, repositoryState, startedAt, lastActivityAt, intentClaim, observedPurpose } = info;
	const overlap = relationship === "machine" ? undefined : claimOverlap(self.intentClaim, intentClaim);
	const sharedWork = sharedWorkReferences(self.workRefs, info.workRefs).slice(0, SHARED_WORK_SHOWN);
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

function appendEffort(page: EffortPresencePage, row: RelatedEffort, prompt: boolean): void {
	// Prompt rows are selected once after the traversal; prompt bytes are bounded by the formatter.
	if (prompt) {
		page.efforts.push(row);
		return;
	}
	const reason =
		page.efforts.length >= page.limits.results
			? "result-limit"
			: Buffer.byteLength(JSON.stringify([...page.efforts, row])) > page.limits.bytes - 1024
				? "byte-limit"
				: undefined;
	if (reason) {
		page.coverage.omitted += 1;
		markPartial(page, reason);
	} else page.efforts.push(row);
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
	appendEffort(page, effortRow(info, self, liveness, relationship, topics), scope?.prompt ?? false);
}

async function visitEntry(
	sessionsRoot: string,
	self: PresenceSelf,
	page: EffortPresencePage,
	entry: Dirent,
	scope?: EffortProjectScope,
): Promise<void> {
	const id = entry.name.endsWith(".json") ? entry.name.slice(0, -5) : undefined;
	if (!entry.isFile() || id === undefined || id === self.id) {
		page.coverage.unrelated += 1;
		return;
	}
	const descriptor = readPrimaryEndpointDescriptor(sessionsRoot, id);
	if (descriptor.unreadable || !descriptor.info || descriptor.state === "absent") {
		page.coverage.unreadable += 1;
		markPartial(page, "unreadable");
		return;
	}
	if (descriptor.state === "dead") {
		page.coverage.dead += 1;
		return;
	}
	if (descriptor.info.repositoryState === "unknown") markPartial(page, "repository-unknown");
	await collectEffort(page, self, descriptor.info, descriptor.state, scope);
}

async function visitDirectory(
	path: string,
	page: EffortPresencePage,
	visit: (entry: Dirent) => void | Promise<void>,
): Promise<void> {
	let directory: Awaited<ReturnType<typeof opendir>>;
	try {
		directory = await opendir(path, { bufferSize: 16 });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") markPartial(page, "directory-unreadable");
		return;
	}
	try {
		for await (const entry of directory) {
			if (page.coverage.visited >= page.limits.visits) {
				markPartial(page, "visit-limit");
				break;
			}
			page.coverage.visited++;
			await visit(entry);
			if (page.coverage.visited >= page.limits.visits) {
				markPartial(page, "visit-limit");
				break;
			}
		}
	} catch {
		markPartial(page, "directory-unreadable");
	}
}
async function nativeRow(
	record: CatalogRecord,
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
	const info: EffortFacts = {
		id,
		cwd: metadata.cwd,
		hostname: metadata.hostname,
		startedAt: metadata.startedAt,
		repositoryState: metadata.repositoryState,
		intentClaim: metadata.claim,
		...(metadata.repository === null ? {} : { repository: metadata.repository }),
		...(record.view?.rows.find((row) => row.id === id)?.name === undefined
			? {}
			: { name: record.view.rows.find((row) => row.id === id)?.name }),
	};
	if (info.repositoryState === "unknown") markPartial(page, "repository-unknown");
	let ownership = claims.get(record.storageId);
	if (ownership === undefined) {
		const paths = hostPaths(record);
		ownership = observeClaim(paths.claim, paths.identity);
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
	entry: Dirent,
	self: PresenceSelf,
	page: EffortPresencePage,
	claims: Map<string, ClaimObservation>,
	scope?: EffortProjectScope,
): Promise<void> {
	if (!entry.isFile() || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\.json$/u.test(entry.name)) {
		page.coverage.unrelated++;
		return;
	}
	let record: CatalogRecord;
	try {
		record = catalog.read(entry.name.slice(0, -5));
	} catch {
		page.coverage.unreadable++;
		markPartial(page, "native-record-unreadable");
		return;
	}
	if (isThreadStorage(record, catalog.root)) {
		page.coverage.unrelated++;
		return;
	}
	const claimRows = record.view?.intentClaims;
	if (!claimRows) {
		page.coverage.unsupported = (page.coverage.unsupported ?? 0) + 1;
		return;
	}
	page.coverage.unrelated++;
	page.coverage.omitted += claimRows.coverage.omitted;
	if (!claimRows.coverage.complete) markPartial(page, "native-intent-incomplete");
	for (const [id, metadata] of Object.entries(claimRows.rows)) {
		if (page.coverage.visited >= page.limits.visits) {
			markPartial(page, "visit-limit");
			break;
		}
		page.coverage.visited++;
		if (metadata === null) page.coverage.unrelated++;
		else await nativeRow(record, id, metadata, self, page, claims, scope);
	}
}
async function visitNativeRoot(
	catalog: AgentCatalog,
	self: PresenceSelf,
	page: EffortPresencePage,
	scope?: EffortProjectScope,
): Promise<void> {
	// One writer claim observation serves every claim row in this record during one pass.
	const claims = new Map<string, ClaimObservation>();
	await visitDirectory(catalog.root, page, (entry) => visitNativeRecord(catalog, entry, self, page, claims, scope));
}

/** Read-only presence page; ordinary records and native projections share all visit, result and byte caps. */
export async function readRelatedEfforts(
	resources: EffortReadResources,
	reader: EffortPresenceSelf,
	scope?: EffortProjectScope,
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
	await visitDirectory(join(sessionsRoot, ".primaries"), page, (entry) =>
		visitEntry(sessionsRoot, self, page, entry, scope),
	);
	if (page.coverage.visited < page.limits.visits) await visitNativeRoot(resources.catalog, self, page, scope);
	if (scope?.prompt)
		page.efforts.splice(0, page.efforts.length, ...selectPromptEfforts(page.efforts, page.limits.results));
	page.efforts.sort((a, b) => a.id.localeCompare(b.id));
	return page;
}
