import type { CatalogRecord, ClaimObservation, Publication } from "./catalog-record.mts";
export type CatalogRow = Publication["rows"][number] & { claim: ClaimObservation["state"]; publishedAt?: string };
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
	return publication.rows.map((source) => {
		const row: CatalogRow = { ...source, owner, ownerLabel: label, claim: claim.state, publishedAt: stamp };
		if (claim.state !== "live") {
			if (row.state === "working") row.state = "interrupted";
			delete row.currentTool;
		}
		return row;
	});
}
