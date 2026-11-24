import { opendir } from "node:fs/promises";
import { CatalogIndex, type AgentCatalog, type CatalogIndexEntry, type CatalogRecord } from "./catalog.ts";
import {
	validateCollaborationAction,
	type CollaborationList,
	type CollaborationProjection,
	type CollaborationSummary,
} from "./collaboration-contract.ts";

export interface RecentCollaborationPage {
	items: CollaborationSummary[];
	coverage: {
		visited: number;
		records: number;
		unreadable: number;
		missingHints: number;
		outOfScope?: number;
		omittedHints: number;
		omittedResults: number;
		unvisited: boolean;
		complete: boolean;
		reasons: string[];
	};
	limits: { visits: number; results: number; bytes: number; hintsPerRecord: number };
}
export const RECENT_COLLABORATION_LIMITS = { visits: 256, results: 12, bytes: 8192, hintsPerRecord: 8 } as const;
const CATALOG_RECORD_NAME = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\.json$/u;

type ThreadProjectScope = { prompt: boolean; matches(record: CatalogRecord): Promise<boolean> };

function recentPartial(page: RecentCollaborationPage, reason: string): void {
	page.coverage.complete = false;
	if (!page.coverage.reasons.includes(reason)) page.coverage.reasons.push(reason);
}
/**
 * A prompt keeps threads from priority sources (contacts, the reader's own storages, related live
 * efforts) ahead of sampled ones, each group in identity order; an observation shows newest first.
 */
async function collectRecentHints(
	page: RecentCollaborationPage,
	record: CatalogRecord,
	ranks: Map<string, number>,
	rank: number,
	scope?: ThreadProjectScope,
): Promise<void> {
	if (record.threads === undefined) {
		page.coverage.missingHints += 1;
		recentPartial(page, "missing-thread-hints");
		return;
	}
	page.coverage.omittedHints += record.threads.omitted;
	if (record.threads.omitted > 0) recentPartial(page, "omitted-thread-hints");
	const active = record.threads.items.slice(0, page.limits.hintsPerRecord).filter((thread) => !thread.closed);
	if (active.length > 0 && scope !== undefined && !(await scope.matches(record))) {
		page.coverage.outOfScope = (page.coverage.outOfScope ?? 0) + active.length;
		if (scope.prompt) return;
	}
	for (const thread of active) {
		if (ranks.has(thread.id)) continue;
		ranks.set(thread.id, rank);
		page.items.push(thread);
		page.items.sort(
			(a, b) =>
				(scope?.prompt ? (ranks.get(a.id) ?? 1) - (ranks.get(b.id) ?? 1) : b.updatedAt - a.updatedAt) ||
				a.id.localeCompare(b.id),
		);
		if (page.items.length > page.limits.results) {
			page.items.pop();
			page.coverage.omittedResults += 1;
			recentPartial(page, "result-limit");
		}
	}
}
/** An absent priority record, such as an ordinary session's identity, costs no visit. */
async function collectPriorityRecord(
	page: RecentCollaborationPage,
	catalog: AgentCatalog,
	name: string,
	ranks: Map<string, number>,
	scope?: ThreadProjectScope,
): Promise<void> {
	let record: CatalogRecord;
	try {
		record = catalog.read(name.slice(0, -5));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
		page.coverage.visited += 1;
		page.coverage.records += 1;
		page.coverage.unreadable += 1;
		recentPartial(page, "unreadable-records");
		return;
	}
	page.coverage.visited += 1;
	page.coverage.records += 1;
	// A priority source is related by contact or presence, so project scope does not filter it.
	await collectRecentHints(page, record, ranks, 0, scope && { prompt: scope.prompt, matches: async () => true });
}
async function collectRecentRecord(
	page: RecentCollaborationPage,
	catalog: AgentCatalog,
	entry: import("node:fs").Dirent,
	ranks: Map<string, number>,
	scope?: ThreadProjectScope,
): Promise<void> {
	page.coverage.records += 1;
	try {
		if (!entry.isFile()) throw new Error("Not a catalog file");
		await collectRecentHints(page, catalog.read(entry.name.slice(0, -5)), ranks, 1, scope);
	} catch {
		page.coverage.unreadable += 1;
		recentPartial(page, "unreadable-records");
	}
}

/**
 * Reading directly bounds directory traversal; catalog.page materializes the whole directory.
 * Storage files beside the records cost no visit, and a full budget is unvisited only when another
 * record remains.
 */
async function sampleDirectory(
	page: RecentCollaborationPage,
	catalog: AgentCatalog,
	seen: Set<string>,
	ranks: Map<string, number>,
	scope?: ThreadProjectScope,
): Promise<void> {
	let directory: Awaited<ReturnType<typeof opendir>>;
	try {
		directory = await opendir(catalog.root, { bufferSize: 32 });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
			page.coverage.unvisited = true;
			recentPartial(page, "directory-unreadable");
		}
		return;
	}
	try {
		for (;;) {
			const entry = await directory.read();
			if (entry === null) break;
			if (!CATALOG_RECORD_NAME.test(entry.name) || seen.has(entry.name)) continue;
			if (page.coverage.visited >= page.limits.visits) {
				page.coverage.unvisited = true;
				recentPartial(page, "visit-limit");
				break;
			}
			seen.add(entry.name);
			page.coverage.visited += 1;
			await collectRecentRecord(page, catalog, entry, ranks, scope);
		}
	} catch {
		page.coverage.unvisited = true;
		recentPartial(page, "directory-unreadable");
	} finally {
		await directory.close().catch(() => {});
	}
}

/** Known contact and live storages precede the bounded directory sample; native history remains authoritative. */
export async function readRecentCollaboration(
	catalog: AgentCatalog,
	priorityIdentities: readonly string[] = [],
	scope?: ThreadProjectScope,
): Promise<RecentCollaborationPage> {
	const page: RecentCollaborationPage = {
		items: [],
		limits: RECENT_COLLABORATION_LIMITS,
		coverage: {
			visited: 0,
			records: 0,
			unreadable: 0,
			missingHints: 0,
			omittedHints: 0,
			omittedResults: 0,
			unvisited: false,
			complete: true,
			reasons: [],
		},
	};
	const seen = new Set<string>();
	const ranks = new Map<string, number>();
	for (const identity of priorityIdentities) {
		if (page.coverage.visited >= page.limits.visits) break;
		const name = `${identity.split(":")[0]}.json`;
		if (!CATALOG_RECORD_NAME.test(name) || seen.has(name)) continue;
		seen.add(name);
		await collectPriorityRecord(page, catalog, name, ranks, scope);
	}
	await sampleDirectory(page, catalog, seen, ranks, scope);
	while (!scope?.prompt && Buffer.byteLength(JSON.stringify(page)) > page.limits.bytes && page.items.length > 0) {
		page.items.pop();
		page.coverage.omittedResults += 1;
		recentPartial(page, "byte-limit");
	}
	return page;
}

const MAX_DISCOVERY_SOURCES = 16;

/** One catalog record: `threads` is undefined when its host has published no hints or the record is unreadable. */
type ThreadHintSource = CatalogIndexEntry<CollaborationProjection | undefined>;
/** Published thread hints of every record; a read of an unchanged catalog reads no record. */
const threadHints = new CatalogIndex((record) =>
	record.threads === undefined ? undefined : structuredClone(record.threads),
);

type ThreadKey = { closed: boolean; updatedAt: number; id: string };
type ThreadCursor = { query: string; after: ThreadKey };
type DiscoverySource = { sessionId: string; omitted: number; unavailable: boolean };

function compareThreads(left: ThreadKey, right: ThreadKey): number {
	return (
		Number(left.closed) - Number(right.closed) ||
		right.updatedAt - left.updatedAt ||
		(left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
	);
}
function readCursor(input: Record<string, unknown>, query: string): ThreadCursor | null {
	if (input.cursor === undefined) return null;
	const invalid = "Invalid thread discovery cursor; repeat the same query without cursor";
	if (typeof input.cursor !== "string" || input.cursor.length > 2048) throw new Error(invalid);
	let cursor: ThreadCursor;
	try {
		cursor = JSON.parse(Buffer.from(input.cursor, "base64url").toString("utf8")) as ThreadCursor;
	} catch {
		throw new Error(invalid);
	}
	if (
		cursor?.query !== query ||
		typeof cursor.after?.id !== "string" ||
		typeof cursor.after.closed !== "boolean" ||
		!Number.isFinite(cursor.after.updatedAt)
	)
		throw new Error(invalid);
	return cursor;
}
function pageLimit(input: Record<string, unknown>): number {
	const limit = input.limit ?? 20;
	if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 20)
		throw new Error("Thread list limit must be 1..20");
	return limit;
}
function matches(row: CollaborationSummary, needle: string): boolean {
	return !needle || [row.id, row.title, row.purpose].some((value) => value.toLocaleLowerCase().includes(needle));
}

/** Records whose hints are missing, unreadable or cut: each is unknown coverage and names its storage. */
function sourceCoverage(records: readonly ThreadHintSource[]): {
	sources: DiscoverySource[];
	sourcesOmitted: number;
	omitted: number;
	unavailable: number;
} {
	const coverage = { sources: [] as DiscoverySource[], sourcesOmitted: 0, omitted: 0, unavailable: 0 };
	for (const record of records) {
		const omitted = record.value?.omitted ?? 0;
		const unavailable = record.value === undefined;
		if (!unavailable && omitted === 0) continue;
		coverage.omitted += omitted;
		if (unavailable) coverage.unavailable += 1;
		if (coverage.sources.length < MAX_DISCOVERY_SOURCES)
			coverage.sources.push({ sessionId: record.storageId, omitted, unavailable });
		else coverage.sourcesOmitted += 1;
	}
	return coverage;
}

function rankedRows(
	records: readonly ThreadHintSource[],
	needle: string,
	after: ThreadKey | undefined,
): CollaborationSummary[] {
	const rows: CollaborationSummary[] = [];
	for (const record of records)
		for (const row of record.value?.items ?? [])
			if (matches(row, needle) && (after === undefined || compareThreads(row, after) > 0)) rows.push(row);
	return rows.sort(compareThreads);
}

/**
 * Rank every matching published hint of the whole catalog: active before closed, newest update first,
 * thread ID as the tie break. The cursor is the last returned rank key, so a page continues after it
 * whatever changed in between. A record without hints, with omitted hints, or unreadable stays explicit
 * unknown coverage and names its storage in `sources`.
 */
export async function discoverCollaboration(
	catalog: AgentCatalog,
	input: Record<string, unknown>,
): Promise<CollaborationList & { sources: DiscoverySource[]; sourcesOmitted: number }> {
	if (input.action !== undefined && input.action !== "list") throw new Error("Thread discovery requires action list");
	validateCollaborationAction({ ...input, action: "list" });
	const query = typeof input.query === "string" ? input.query : "";
	if (query.length > 256) throw new Error("Thread query exceeds its bound");
	const limit = pageLimit(input);
	const after = readCursor(input, query)?.after;
	const needle = query.toLocaleLowerCase();
	const records = await threadHints.read(catalog);
	const coverage = sourceCoverage(records);
	const rows = rankedRows(records, needle, after);
	const items = rows.slice(0, limit);
	const last = items.at(-1);
	const next: ThreadCursor | null =
		rows.length > limit && last
			? { query, after: { closed: last.closed, updatedAt: last.updatedAt, id: last.id } }
			: null;
	return {
		items,
		sources: coverage.sources,
		sourcesOmitted: coverage.sourcesOmitted,
		nextCursor: next === null ? null : Buffer.from(JSON.stringify(next)).toString("base64url"),
		coverage: {
			complete: next === null && coverage.unavailable === 0 && coverage.omitted === 0,
			visited: records.length,
			omitted: coverage.omitted,
			unavailable: coverage.unavailable,
		},
	};
}
