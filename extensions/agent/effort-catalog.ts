import { CatalogIndex, type CatalogIndexEntry } from "./catalog-index.ts";
import type { AgentCatalog, CatalogRecord } from "./catalog.ts";
import type { CatalogIntentClaims } from "./catalog-view.ts";
import type { CollaborationProjection } from "./collaboration-contract.ts";

/**
 * What effort presence and thread hints read from one catalog record. One process-wide index keeps
 * it by record file stamp, so a read lists the catalog and stats each record, and parses only the
 * records that changed since the previous read.
 */
export interface EffortRecord {
	readonly storageId: string;
	readonly ownerId?: string;
	readonly agentDir: string;
	readonly cwd: string;
	/** Native claim rows; absent for a producer without intent support. */
	readonly intentClaims?: CatalogIntentClaims;
	/** Display names of the record's view rows, by conversation identity. */
	readonly names: Readonly<Record<string, string>>;
	readonly threads?: CollaborationProjection;
}

/** Conversations without a declared claim publish null rows; the index keeps the declared claims only. */
function declaredClaims(claims: CatalogIntentClaims): CatalogIntentClaims {
	const rows: Record<string, NonNullable<CatalogIntentClaims["rows"][string]>> = {};
	for (const [id, metadata] of Object.entries(claims.rows)) if (metadata !== null) rows[id] = structuredClone(metadata);
	return { ...claims, rows, coverage: { ...claims.coverage } };
}

function project(record: CatalogRecord): EffortRecord {
	const names: Record<string, string> = {};
	for (const row of record.view?.rows ?? []) if (row.name !== undefined) names[row.id] = row.name;
	return {
		storageId: record.storageId,
		...(record.ownerId === undefined ? {} : { ownerId: record.ownerId }),
		agentDir: record.agentDir,
		cwd: record.cwd,
		...(record.view?.intentClaims === undefined ? {} : { intentClaims: declaredClaims(record.view.intentClaims) }),
		names,
		...(record.threads === undefined ? {} : { threads: structuredClone(record.threads) }),
	};
}

const index = new CatalogIndex(project);

/** Every catalog record in storage ID order; values are shared between reads and must not change. */
export function readEffortRecords(catalog: AgentCatalog): Promise<CatalogIndexEntry<EffortRecord>[]> {
	return index.read(catalog);
}
