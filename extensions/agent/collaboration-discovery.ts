import { opendir, readdir } from "node:fs/promises";
import type { AgentCatalog, CatalogRecord } from "./catalog.ts";
import {
	validateCollaborationAction,
	type CollaborationList,
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
async function collectRecentHints(
	page: RecentCollaborationPage,
	record: CatalogRecord,
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
		page.items.push(thread);
		page.items.sort((a, b) => (scope?.prompt ? 0 : b.updatedAt - a.updatedAt) || a.id.localeCompare(b.id));
		if (page.items.length > page.limits.results) {
			page.items.pop();
			page.coverage.omittedResults += 1;
			recentPartial(page, "result-limit");
		}
	}
}
async function collectPriorityRecord(
	page: RecentCollaborationPage,
	catalog: AgentCatalog,
	name: string,
	scope?: ThreadProjectScope,
): Promise<void> {
	try {
		const record = catalog.read(name.slice(0, -5));
		page.coverage.records += 1;
		// A priority source is related by contact or presence, so project scope does not filter it.
		await collectRecentHints(page, record, scope && { prompt: scope.prompt, matches: async () => true });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
			page.coverage.records += 1;
			page.coverage.unreadable += 1;
			recentPartial(page, "unreadable-records");
		}
	}
}
async function collectRecentRecord(
	page: RecentCollaborationPage,
	catalog: AgentCatalog,
	entry: import("node:fs").Dirent,
	seen: Set<string>,
	scope?: ThreadProjectScope,
): Promise<void> {
	if (!CATALOG_RECORD_NAME.test(entry.name) || seen.has(entry.name)) return;
	seen.add(entry.name);
	page.coverage.records += 1;
	try {
		if (!entry.isFile()) throw new Error("Not a catalog file");
		await collectRecentHints(page, catalog.read(entry.name.slice(0, -5)), scope);
	} catch {
		page.coverage.unreadable += 1;
		recentPartial(page, "unreadable-records");
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
	for (const identity of priorityIdentities.slice(0, page.limits.visits)) {
		const name = `${identity.split(":")[0]}.json`;
		if (!CATALOG_RECORD_NAME.test(name) || seen.has(name)) continue;
		seen.add(name);
		page.coverage.visited += 1;
		await collectPriorityRecord(page, catalog, name, scope);
	}
	let directory: Awaited<ReturnType<typeof opendir>>;
	try {
		directory = await opendir(catalog.root, { bufferSize: 1 });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
			page.coverage.unvisited = true;
			recentPartial(page, "directory-unreadable");
		}
		return page;
	}
	try {
		// Reading directly bounds directory traversal; catalog.page materializes the whole directory.
		while (page.coverage.visited < page.limits.visits) {
			const entry = await directory.read();
			if (entry === null) break;
			page.coverage.visited += 1;
			await collectRecentRecord(page, catalog, entry, seen, scope);
		}
		if (page.coverage.visited === page.limits.visits) {
			page.coverage.unvisited = true;
			recentPartial(page, "visit-limit");
		}
	} catch {
		page.coverage.unvisited = true;
		recentPartial(page, "directory-unreadable");
	} finally {
		await directory.close().catch(() => {});
	}
	while (!scope?.prompt && Buffer.byteLength(JSON.stringify(page)) > page.limits.bytes && page.items.length > 0) {
		page.items.pop();
		page.coverage.omittedResults += 1;
		recentPartial(page, "byte-limit");
	}
	return page;
}

/** One call reads at most this many catalog records; larger catalogs continue in later windows. */
export const THREAD_DISCOVERY_VISITS = 1024;
const MAX_DISCOVERY_SOURCES = 16;

type ThreadKey = { closed: boolean; updatedAt: number; id: string };
type ThreadCursor = { query: string; window: string | null; after: ThreadKey | null };
type DiscoverySource = { sessionId: string; omitted: number; unavailable: boolean };

function compareThreads(left: ThreadKey, right: ThreadKey): number {
	return (
		Number(left.closed) - Number(right.closed) ||
		right.updatedAt - left.updatedAt ||
		(left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
	);
}
function readCursor(input: Record<string, unknown>, query: string): ThreadCursor {
	if (input.cursor === undefined) return { query, window: null, after: null };
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
		(cursor.window !== null && (typeof cursor.window !== "string" || !CATALOG_RECORD_NAME.test(cursor.window))) ||
		(cursor.after !== null &&
			(typeof cursor.after?.id !== "string" ||
				typeof cursor.after.closed !== "boolean" ||
				!Number.isFinite(cursor.after.updatedAt)))
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
function encode(cursor: ThreadCursor): string {
	return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

type WindowScan = {
	rows: CollaborationSummary[];
	sources: DiscoverySource[];
	sourcesOmitted: number;
	unavailable: number;
	omitted: number;
};

async function catalogWindow(catalog: AgentCatalog, start: string | null): Promise<{ names: string[]; more: boolean }> {
	let names: string[];
	try {
		names = (await readdir(catalog.root)).filter((name) => CATALOG_RECORD_NAME.test(name)).sort();
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		return { names: [], more: false };
	}
	const first = start === null ? 0 : names.findIndex((name) => name > start);
	if (first === -1) return { names: [], more: false };
	const window = names.slice(first, first + THREAD_DISCOVERY_VISITS);
	return { names: window, more: first + window.length < names.length };
}
function matches(row: CollaborationSummary, needle: string): boolean {
	return !needle || [row.id, row.title, row.purpose].some((value) => value.toLocaleLowerCase().includes(needle));
}
function scanRecord(scan: WindowScan, record: CatalogRecord, needle: string): void {
	const projection = record.threads;
	if (projection === undefined) scan.unavailable += 1;
	scan.omitted += projection?.omitted ?? 0;
	if (projection === undefined || projection.omitted > 0) {
		if (scan.sources.length < MAX_DISCOVERY_SOURCES)
			scan.sources.push({
				sessionId: record.storageId,
				omitted: projection?.omitted ?? 0,
				unavailable: projection === undefined,
			});
		else scan.sourcesOmitted += 1;
	}
	for (const row of projection?.items ?? []) if (matches(row, needle)) scan.rows.push(row);
}
function scanWindow(catalog: AgentCatalog, names: readonly string[], needle: string): WindowScan {
	const scan: WindowScan = { rows: [], sources: [], sourcesOmitted: 0, unavailable: 0, omitted: 0 };
	for (const name of names) {
		let record: CatalogRecord;
		try {
			record = catalog.read(name.slice(0, -5));
		} catch {
			scan.unavailable += 1;
			continue;
		}
		scanRecord(scan, record, needle);
	}
	scan.rows.sort(compareThreads);
	return scan;
}

/**
 * Read published hints from one window of catalog records in name order, then rank every match in
 * that window: active before closed, newest update first, thread ID as the tie break. A catalog that
 * fits in one window is ranked as a whole. Missing hints remain explicit unknown coverage.
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
	const cursor = readCursor(input, query);
	const window = await catalogWindow(catalog, cursor.window);
	const scan = scanWindow(catalog, window.names, query.toLocaleLowerCase());
	const after = cursor.after;
	const remaining = after === null ? scan.rows : scan.rows.filter((row) => compareThreads(row, after) > 0);
	const items = remaining.slice(0, limit);
	const last = items.at(-1);
	let next: ThreadCursor | null = null;
	if (remaining.length > limit && last)
		next = { query, window: cursor.window, after: { closed: last.closed, updatedAt: last.updatedAt, id: last.id } };
	else if (window.more) next = { query, window: window.names.at(-1) ?? null, after: null };
	return {
		items,
		sources: scan.sources,
		sourcesOmitted: scan.sourcesOmitted,
		nextCursor: next === null ? null : encode(next),
		coverage: {
			complete: next === null && cursor.window === null && scan.unavailable === 0 && scan.omitted === 0,
			visited: window.names.length,
			omitted: scan.omitted,
			unavailable: scan.unavailable,
		},
	};
}
