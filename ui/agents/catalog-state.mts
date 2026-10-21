import type { CatalogRecord, ClaimObservation, Publication } from "./catalog-record.mts";
export type CatalogRow = Publication["rows"][number] & { claim: ClaimObservation["state"]; publishedAt?: string; handle?: string; role?: string; attention?: {kind: "provider-blocked" | "task-blocked" | "failed-turn"; reason?: "missing_task" | "task_too_old" | "migration_failed" | "restart_limit"} };
/** Last native activity defines order; identity breaks equal-time ties without locale dependence. */
export function compareRosterRows(a: CatalogRow, b: CatalogRow): number {
	return b.modifiedAt - a.modifiedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}
export interface CatalogScan {
	scanId?: string;
	state: "not-started" | "running" | "ready" | "failed";
	complete: boolean;
	visited: number;
	skipped: number;
	omitted: number;
	error?: string;
}
export interface CatalogPage {
	changed?: CatalogRow[];
	removed?: string[];
	rows: CatalogRow[];
	nextCursor: string | null;
	coverage: { complete: boolean; omitted: number };
	observedAt?: string;
	stale: boolean;
	scan: CatalogScan;
}
export interface CatalogEntry {
	record: CatalogRecord;
	rows: CatalogRow[];
}
export interface CatalogUpdate {
	entries: CatalogEntry[];
	removed: string[];
	scan: CatalogScan;
	stale: boolean;
	observedAt?: string;
}
export const initialScan = (): CatalogScan => ({
	state: "not-started",
	complete: false,
	visited: 0,
	skipped: 0,
	omitted: 0,
});
function publishedAttention(publication: Publication): Map<string, NonNullable<Publication['attention']>['rows'][number] | null> {
	const attention = new Map<string, NonNullable<Publication['attention']>['rows'][number] | null>();
	for (const hint of publication.attention?.rows ?? []) attention.set(hint.identity, attention.has(hint.identity) ? null : hint);
	return attention;
}
export function retainedRows(record: CatalogRecord, claim: ClaimObservation): CatalogRow[] {
	const owner = claim.state === "live" ? "here" : claim.state === "unknown" ? "unavailable" : "unknown";
	const publication = record.view;
	const stamp = publication?.updatedAt;
	const label = [stamp ? `Stored publication at ${stamp}` : "Stored metadata; publication unavailable", claim.error]
		.filter(Boolean)
		.join("; ");
	if (!publication || publication.unavailable)
		return [
			{
				id: record.storageId,
				storageId: record.storageId,
				cwd: record.cwd,
				modifiedAt: Number.isFinite(Date.parse(record.createdAt)) ? Date.parse(record.createdAt) : 0,
				owner,
				state: "unavailable",
				cost: 0,
				partial: true,
				name: record.name,
				error: publication?.unavailable ?? record.publicationError ?? "Stored metadata; no publication",
				ownerLabel: label,
				claim: claim.state,
				publishedAt: stamp,
			},
		];
	const profiles = new Map<string, NonNullable<Publication['profiles']>['rows'][number] | null>();
	for (const hint of publication.profiles?.rows ?? []) {
		profiles.set(hint.identity, profiles.has(hint.identity) ? null : hint);
	}
	const attention = publishedAttention(publication);
	return publication.rows.map((source) => {
		const row: CatalogRow = { ...source, owner, ownerLabel: label, claim: claim.state, publishedAt: stamp };
		// Only an unambiguous public hint for this exact conversation supplies profile facts.
		delete row.handle; delete row.role; delete row.attention;
		const need = attention.get(source.id);
		if (need) row.attention = {kind: need.kind, ...(need.kind === "task-blocked" ? {reason: need.reason} : {})};
		const profile = profiles.get(source.id);
		if (typeof profile?.handle === "string") row.handle = profile.handle;
		if (profile?.role) row.role = profile.role;
		if (claim.state !== "live") {
			if (row.state === "working") row.state = "interrupted";
			delete row.currentTool;
		}
		return row;
	});
}
