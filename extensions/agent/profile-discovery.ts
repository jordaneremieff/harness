import { str, num, int, bool, nul, lit, union, arr, obj } from "@earendil-works/pi-schema";
import { ListOutputProperties, ListRowProperties, ListCoverageProperties } from "./observation-schema.ts";
import type { ProfileHints } from "./profile-schema.ts";
import type { AgentConversationSummary } from "./dashboard-types.ts";
import type { CatalogFact, CatalogRecord } from "./catalog.ts";
import type { ClaimObservation } from "./claims.ts";

const nullableText = union([str(), nul()]);
const ProfiledListRowSchema = obj({
	...ListRowProperties,
	handle: nullableText, role: nullableText,
	profile: union([obj({ revision: str(), hasExpertise: bool(), updatedAt: union([num(), nul()]), source: lit("retained") }), nul()]),
	profileCoverage: union([lit("retained"), lit("unknown")]),
});
/** Frontend composite; the base host list operation keeps its independent schema. */
export const ProfiledListOutputSchema = obj({
	...ListOutputProperties,
	rows: arr(ProfiledListRowSchema),
	coverage: obj({
		...ListCoverageProperties,
		profileHints: obj({ complete: bool(), unknownStorages: int({ minimum: 0 }), omitted: int({ minimum: 0 }) }),
	}),
});

/** Retained profile hints enrich frontend rows, never the base host wire schema. */
export function composeListRow<T extends { identity: string; name?: string; firstMessage?: string }>(
	row: T, hints: ProfileHints | undefined, cwd: string, storageId: string,
) {
	const hint = hints?.rows.find((item) => item.identity === row.identity);
	return {
		...row, sessionId: row.identity, storageId, cwd,
		handle: hint?.handle ?? null, role: hint?.role ?? null,
		profile: hint ? { revision: hint.revision, hasExpertise: hint.hasExpertise, updatedAt: hint.updatedAt, source: "retained" as const } : null,
		profileCoverage: hint ? "retained" as const : "unknown" as const,
	};
}

/** Literal discovery includes concern addresses and roles without a host read. */
export function matchesListRow(row: { identity: string; name?: string; firstMessage?: string; cwd: string; handle?: string | null; role?: string | null }, query: string): boolean {
	const term = query.toLocaleLowerCase();
	return [row.identity, row.name, row.firstMessage, row.cwd, row.handle, row.role]
		.some((value) => value?.toLocaleLowerCase().includes(term));
}

/**
 * How one storage takes part in a list scan:
 * - `candidate`: its catalog record carries the query text, or cannot decide the query;
 * - `settled`: its record proves that no row matches, so the scan never observes it;
 * - `remainder`: its publication has no match, but the record cannot prove that the publication is current.
 */
export type ListStorageClass = "candidate" | "settled" | "remainder";
export type ListPass = "candidates" | "remainder";

/** The record's own text for every field that `matchesListRow` reads from an observed row. */
function recordCarriesQuery(record: CatalogRecord, term: string): boolean {
	const texts: Array<string | null | undefined> = [record.storageId, record.cwd, record.name];
	for (const row of record.view?.rows ?? []) texts.push(row.id, row.name, row.firstMessage);
	for (const hint of record.view?.profiles?.rows ?? []) texts.push(hint.handle, hint.role);
	return texts.some((value) => value?.toLocaleLowerCase().includes(term));
}

/**
 * Classify one storage for a query from catalog data alone.
 *
 * A publication decides the query only when it is available, omits no row and has at least one row, and the
 * recovery marker is false. The byte budget of a publication is smaller than the rows of a storage at the
 * publisher's conversation scan bound, so a scan-bounded publication always reports omitted rows. A published
 * row carries the identity, name and first message that an observed row carries; handles and roles reach a row
 * only through the published hints, so an observation adds none.
 *
 * A deciding publication without a match is proof only when it is the last state of the store. A host writes its
 * end marker only after a clean idle close, and that close publishes first and fails without a publication. Only a
 * host changes the published fields of a store, and each host replaces the claim record before it opens the store.
 * An open, crashed, unreadable or absent claim proves nothing about the store after the publication, and that
 * storage stays in the remainder.
 */
export function classifyListStorage(record: CatalogRecord, claim: ClaimObservation, query: string): ListStorageClass {
	if (!query) return "candidate";
	const view = record.view;
	if (!view || view.unavailable !== undefined || view.coverage.omitted > 0 || view.rows.length === 0 || record.recoveryDue !== false) return "candidate";
	if (recordCarriesQuery(record, query.toLocaleLowerCase())) return "candidate";
	return claim.kind === "dead" && claim.endedAt !== undefined && view.updatedAt <= claim.endedAt ? "settled" : "remainder";
}

/** One storage a pass observes; a missing record marks an unreadable catalog file. */
export interface ListScanStep { storageId: string; record?: CatalogRecord }
export interface ListScanPlan {
	/** Readable catalog records in scope. */
	storages: number;
	settled: number;
	candidates: ListScanStep[];
	remainder: ListScanStep[];
	profileHints: { complete: boolean; unknownStorages: number; omitted: number };
}

/**
 * Order the observations of one discovery from a catalog inventory, in storage identity order.
 *
 * The candidates pass comes first. The remainder pass also takes each candidate whose record file changed at or
 * after `since`, the start of the discovery: the candidates pass can have read an earlier record that was no
 * candidate. Such a storage can be observed in both passes.
 */
export function planListScan(facts: ReadonlyMap<string, CatalogFact | null>, query: string, cwd: string, since: number): ListScanPlan {
	const plan: ListScanPlan = { storages: 0, settled: 0, candidates: [], remainder: [], profileHints: { complete: true, unknownStorages: 0, omitted: 0 } };
	for (const storageId of [...facts.keys()].sort()) {
		const fact = facts.get(storageId);
		if (!fact) { plan.candidates.push({ storageId }); continue; }
		const { record } = fact;
		if (cwd && record.cwd !== cwd) continue;
		plan.storages++;
		const hints = record.view?.profiles;
		if (!hints) { plan.profileHints.complete = false; plan.profileHints.unknownStorages++; }
		else { plan.profileHints.complete &&= hints.coverage.complete; plan.profileHints.omitted += hints.coverage.omitted; }
		const kind = classifyListStorage(record, fact.claim, query);
		if (kind === "settled") { plan.settled++; continue; }
		if (kind === "candidate") plan.candidates.push({ storageId, record });
		if (kind === "remainder" || (query && fact.modifiedAt >= since)) plan.remainder.push({ storageId, record });
	}
	return plan;
}

/** State what one list result rests on, so a page without rows is never read as absence. */
export function listCoverageBasis(state: { query: string; pass: ListPass; pending: number; settled: number }): string {
	const { query, pass, pending, settled } = state;
	if (pending > 0) {
		const open = `${pending} storage observation${pending === 1 ? " is" : "s are"} still open, so a page without rows is not absence. Call agent_list with the fields of coverage.next.`;
		if (!query) return `Storages are observed in identity order. ${open}`;
		return pass === "candidates"
			? `Candidates pass: storages whose catalog record carries the query, or cannot decide it, are observed first. ${open}`
			: `Remainder pass: every candidate storage is observed. The remaining storages publish no match, but their publication can be older than the store. ${open}`;
	}
	if (!query) return "Every storage in scope was observed.";
	return `Every storage in scope was observed or settled. ${settled} settled storage${settled === 1 ? " was" : "s were"} not observed: a settled storage has a complete publication without a match from a writer that ended cleanly.`;
}

export function enrichDashboardRow(row: AgentConversationSummary, hints: ProfileHints | undefined): AgentConversationSummary {
	const profile = hints?.rows.find((hint) => hint.identity === row.id);
	return profile ? { ...row, profile } : row;
}
