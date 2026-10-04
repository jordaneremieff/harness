import { opendir } from "node:fs/promises";
import type { AgentCatalog, CatalogRecord } from "./catalog.ts";
import type { CollaborationList, CollaborationSummary } from "./collaboration.ts";

export interface RecentCollaborationPage {
	items: CollaborationSummary[];
	coverage: {
		visited: number; records: number; unreadable: number; missingHints: number;
		omittedHints: number; omittedResults: number; unvisited: boolean; complete: boolean; reasons: string[];
	};
	limits: { visits: number; results: number; bytes: number; hintsPerRecord: number };
}
export const RECENT_COLLABORATION_LIMITS = { visits: 256, results: 12, bytes: 8192, hintsPerRecord: 8 } as const;
const CATALOG_RECORD_NAME = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\.json$/u;

function recentPartial(page: RecentCollaborationPage, reason: string): void {
	page.coverage.complete = false;
	if (!page.coverage.reasons.includes(reason)) page.coverage.reasons.push(reason);
}
function collectRecentHints(page: RecentCollaborationPage, record: CatalogRecord): void {
	if (record.threads === undefined) { page.coverage.missingHints += 1; recentPartial(page, "missing-thread-hints"); return; }
	page.coverage.omittedHints += record.threads.omitted;
	if (record.threads.omitted > 0) recentPartial(page, "omitted-thread-hints");
	for (const thread of record.threads.items.slice(0, page.limits.hintsPerRecord)) {
		if (thread.closed) continue;
		page.items.push(thread);
		page.items.sort((a, b) => b.updatedAt - a.updatedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
		if (page.items.length > page.limits.results) { page.items.pop(); page.coverage.omittedResults += 1; recentPartial(page, "result-limit"); }
	}
}
function collectRecentRecord(page: RecentCollaborationPage, catalog: AgentCatalog, entry: import("node:fs").Dirent): void {
	if (!CATALOG_RECORD_NAME.test(entry.name)) return;
	page.coverage.records += 1;
	try {
		if (!entry.isFile()) throw new Error("Not a catalog file");
		collectRecentHints(page, catalog.read(entry.name.slice(0, -5)));
	} catch { page.coverage.unreadable += 1; recentPartial(page, "unreadable-records"); }
}

/** Newest active published hints in a bounded directory sample, not a complete store history. */
export async function readRecentCollaboration(catalog: AgentCatalog): Promise<RecentCollaborationPage> {
	const page: RecentCollaborationPage = {
		items: [], limits: RECENT_COLLABORATION_LIMITS,
		coverage: { visited: 0, records: 0, unreadable: 0, missingHints: 0, omittedHints: 0, omittedResults: 0, unvisited: false, complete: true, reasons: [] },
	};
	let directory: Awaited<ReturnType<typeof opendir>>;
	try { directory = await opendir(catalog.root, { bufferSize: 1 }); }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") { page.coverage.unvisited = true; recentPartial(page, "directory-unreadable"); }
		return page;
	}
	try {
		// Reading directly bounds directory traversal; catalog.page materializes the whole directory.
		while (page.coverage.visited < page.limits.visits) {
			const entry = await directory.read();
			if (entry === null) break;
			page.coverage.visited += 1;
			collectRecentRecord(page, catalog, entry);
		}
		if (page.coverage.visited === page.limits.visits) { page.coverage.unvisited = true; recentPartial(page, "visit-limit"); }
	} catch { page.coverage.unvisited = true; recentPartial(page, "directory-unreadable"); }
	finally { await directory.close().catch(() => {}); }
	while (Buffer.byteLength(JSON.stringify(page)) > page.limits.bytes && page.items.length > 0) {
		page.items.pop(); page.coverage.omittedResults += 1; recentPartial(page, "byte-limit");
	}
	return page;
}

type ThreadCursor = { query: string; catalog: string | null; storage: string | null; offset: number; publication: string | null };
type DiscoverySource = { sessionId: string; omitted: number; unavailable: boolean };
type DiscoveryState = { items: CollaborationSummary[]; sources: DiscoverySource[]; visited: number; unavailable: number; omitted: number };

function readCursor(input: Record<string, unknown>, query: string): ThreadCursor {
	if (input.cursor === undefined) return { query, catalog: null, storage: null, offset: 0, publication: null };
	if (typeof input.cursor !== "string" || input.cursor.length > 2048) throw new Error("Invalid thread discovery cursor");
	const cursor = JSON.parse(Buffer.from(input.cursor, "base64url").toString("utf8")) as ThreadCursor;
	if (cursor?.query !== query || !Number.isInteger(cursor.offset) || cursor.offset < 0 || cursor.offset > 8) throw new Error("Invalid thread discovery cursor; repeat the same query");
	for (const field of [cursor.catalog, cursor.storage, cursor.publication]) if (field !== null && typeof field !== "string") throw new Error("Invalid thread discovery cursor");
	return cursor;
}
function pageLimit(input: Record<string, unknown>): number {
	const limit = input.limit ?? 20;
	if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 20) throw new Error("Thread list limit must be 1..20");
	return limit;
}
async function nextRecord(catalog: AgentCatalog, cursor: ThreadCursor, state: DiscoveryState): Promise<CatalogRecord | undefined> {
	if (cursor.storage !== null) {
		const record = catalog.read(cursor.storage);
		if ((record.threads?.updatedAt ?? null) !== cursor.publication) throw new Error("Thread discovery changed; restart the query");
		return record;
	}
	const page = await catalog.page({ limit: 1, ...(cursor.catalog === null ? {} : { cursor: cursor.catalog }) });
	state.unavailable += page.coverage.skipped;
	cursor.catalog = page.nextCursor;
	const record = page.records[0];
	if (record === undefined) return undefined;
	cursor.storage = record.storageId;
	cursor.offset = 0;
	cursor.publication = record.threads?.updatedAt ?? null;
	return record;
}
function collect(record: CatalogRecord, cursor: ThreadCursor, state: DiscoveryState, query: string, limit: number): void {
	const projection = record.threads;
	if (projection === undefined || projection.omitted > 0) state.sources.push({ sessionId: record.storageId, omitted: projection?.omitted ?? 0, unavailable: projection === undefined });
	if (projection === undefined) state.unavailable += 1;
	state.omitted += projection?.omitted ?? 0;
	const rows = projection?.items ?? [];
	for (; cursor.offset < rows.length && state.items.length < limit; cursor.offset++) {
		const row = rows[cursor.offset];
		if (!query || [row.id, row.title, row.purpose].some((value) => value.toLocaleLowerCase().includes(query))) state.items.push(row);
	}
	if (cursor.offset === rows.length) { cursor.storage = null; cursor.offset = 0; cursor.publication = null; }
}

/** Read only bounded published hints. Missing hints remain explicit unknown coverage. */
export async function discoverCollaboration(catalog: AgentCatalog, input: Record<string, unknown>): Promise<CollaborationList & { sources: DiscoverySource[] }> {
	const query = typeof input.query === "string" ? input.query : "";
	if (query.length > 256) throw new Error("Thread query exceeds its bound");
	const limit = pageLimit(input);
	const cursor = readCursor(input, query);
	const state: DiscoveryState = { items: [], sources: [], visited: 0, unavailable: 0, omitted: 0 };
	let exhausted = false;
	while (state.visited < 8 && state.items.length < limit) {
		const record = await nextRecord(catalog, cursor, state);
		state.visited += 1;
		if (record) collect(record, cursor, state, query.toLocaleLowerCase(), limit);
		if (cursor.storage === null && cursor.catalog === null) { exhausted = true; break; }
	}
	return { items: state.items, sources: state.sources, nextCursor: exhausted ? null : Buffer.from(JSON.stringify(cursor)).toString("base64url"), coverage: { complete: exhausted && state.unavailable === 0 && state.omitted === 0, visited: state.visited, omitted: state.omitted, unavailable: state.unavailable } };
}
