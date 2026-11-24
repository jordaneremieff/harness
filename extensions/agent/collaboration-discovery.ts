import { CatalogIndex, type AgentCatalog, type CatalogIndexEntry } from "./catalog.ts";
import { readEffortRecords, type EffortRecord } from "./effort-catalog.ts";
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
type ThreadProjectScope = { prompt: boolean; matches(record: { cwd: string }): Promise<boolean> };

function recentPartial(page: RecentCollaborationPage, reason: string): void {
	page.coverage.complete = false;
	if (!page.coverage.reasons.includes(reason)) page.coverage.reasons.push(reason);
}

/** Which threads of one record a read admits: all its active threads, or only named contact threads. */
type Admission = { rank: number; only?: ReadonlySet<string> };

/**
 * A prompt keeps threads from priority sources (the reader's own storages, related live efforts and
 * their contact threads) ahead of the other records' threads, each group in identity order; an
 * observation shows newest first.
 */
async function collectRecentHints(
	page: RecentCollaborationPage,
	record: EffortRecord,
	ranks: Map<string, number>,
	admission: Admission,
	scope?: ThreadProjectScope,
): Promise<void> {
	if (record.threads === undefined) {
		page.coverage.missingHints += 1;
		recentPartial(page, "missing-thread-hints");
		return;
	}
	page.coverage.omittedHints += record.threads.omitted;
	if (record.threads.omitted > 0) recentPartial(page, "omitted-thread-hints");
	const active = record.threads.items
		.slice(0, page.limits.hintsPerRecord)
		.filter((thread) => !thread.closed && (admission.only === undefined || admission.only.has(thread.id)));
	// A priority source is related by contact or presence, so project scope does not filter it.
	if (active.length > 0 && admission.rank > 0 && scope !== undefined && !(await scope.matches(record))) {
		page.coverage.outOfScope = (page.coverage.outOfScope ?? 0) + active.length;
		if (scope.prompt) return;
	}
	for (const thread of active) {
		if (ranks.has(thread.id)) continue;
		ranks.set(thread.id, admission.rank);
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

/** Priority storages admit all their active threads; a contact thread alone admits only itself. */
function threadAdmissions(priorities: readonly string[], contacts: readonly string[]): Map<string, Admission> {
	const admissions = new Map<string, Admission>();
	for (const thread of contacts) {
		const storage = thread.split("/")[0];
		const only = new Set(admissions.get(storage)?.only ?? []);
		only.add(thread);
		admissions.set(storage, { rank: 0, only });
	}
	for (const identity of priorities) admissions.set(identity.split(":")[0], { rank: 0 });
	return admissions;
}

/**
 * Active thread hints of every catalog record, read through the process-wide record index, so no
 * record is left unvisited. `priorityIdentities` name storages whose threads rank first (an
 * identity with a conversation suffix names its storage); `contactThreads` admit one thread each
 * from a storage that is not a priority. Native history remains authoritative.
 */
export async function readRecentCollaboration(
	catalog: AgentCatalog,
	priorityIdentities: readonly string[] = [],
	scope?: ThreadProjectScope,
	options: { contactThreads?: readonly string[]; records?: readonly CatalogIndexEntry<EffortRecord>[] } = {},
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
	let entries = options.records;
	if (entries === undefined) {
		try {
			entries = await readEffortRecords(catalog);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
				page.coverage.unvisited = true;
				recentPartial(page, "directory-unreadable");
			}
			return page;
		}
	}
	const admissions = threadAdmissions(priorityIdentities.slice(0, page.limits.visits), options.contactThreads ?? []);
	const ranks = new Map<string, number>();
	const ordered = [
		...entries.filter((entry) => admissions.has(entry.storageId)),
		...entries.filter((entry) => !admissions.has(entry.storageId)),
	];
	for (const entry of ordered) {
		page.coverage.visited += 1;
		page.coverage.records += 1;
		if (entry.value === undefined) {
			page.coverage.unreadable += 1;
			recentPartial(page, "unreadable-records");
			continue;
		}
		await collectRecentHints(page, entry.value, ranks, admissions.get(entry.storageId) ?? { rank: 1 }, scope);
	}
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
