/**
 * agent/catalog-view: a bounded conversation projection stored beside one
 * catalog record.
 *
 * The view is optional host-local metadata, not part of the host identity.
 * `boundCatalogView` keeps the serialized view inside a fixed budget, emits the
 * root row first when it fits, trims long display fields, and reports truthful
 * coverage. A missing view stays absent; nothing here interprets, migrates, or
 * bootstraps an older record.
 */

import { Value } from "typebox/value";
import { AgentConversationSummarySchema } from "./observation-schema.ts";

/** Bytes available to one serialized view inside the catalog record bound. */
export const CATALOG_VIEW_BUDGET_BYTES = 24 * 1024;
/** Longest display text kept for one row field. */
export const CATALOG_VIEW_TEXT_LIMIT = 2000;
const TEXT_TRUNCATION_MARKER = " […]";

/** One conversation row projected for host metadata. Extra source fields travel unchanged. */
export interface CatalogViewRow {
	readonly id: string;
	readonly storageId: string;
	readonly cwd: string;
	readonly modifiedAt: number;
	readonly owner: string;
	readonly state: string;
	readonly cost: number;
	readonly partial: boolean;
	readonly name?: string;
	readonly firstMessage?: string;
	readonly model?: { readonly provider: string; readonly modelId: string; readonly thinkingLevel: string };
	readonly ownerLabel?: string;
	readonly latestReply?: string;
	readonly error?: string;
	readonly toolCalls?: number;
	readonly currentTool?: { readonly name: string; readonly argument: string };
	readonly durationMs?: number;
	readonly health?: unknown;
}

/** Bounded projection of one host's conversations. */
export interface CatalogView {
	/** ISO timestamp of this publication. */
	readonly updatedAt: string;
	/** Rows within the view budget; the root row is first when it fits. */
	readonly rows: readonly CatalogViewRow[];
	/** `complete` is false when any row was omitted or any text was trimmed. */
	readonly coverage: { readonly complete: boolean; readonly omitted: number };
	/** Storage identity the projection describes, when known. */
	readonly storageId?: string;
	/** Present when the producer could not build a projection; rows are empty. */
	readonly unavailable?: string;
}

/** Producer input for one bounded view. */
export interface CatalogViewSource<Row extends CatalogViewRow = CatalogViewRow> {
	readonly updatedAt: string;
	/** Rows in producer order. The row matching `rootId` is emitted first. */
	readonly rows: readonly Row[];
	readonly rootId?: string;
	readonly storageId?: string;
	readonly unavailable?: string;
}

function byteLength(value: unknown): number {
	return Buffer.byteLength(JSON.stringify(value), "utf8");
}

/** Bound one display text without splitting a surrogate pair. */
function boundText(text: string): { text: string; truncated: boolean } {
	if (text.length <= CATALOG_VIEW_TEXT_LIMIT) return { text, truncated: false };
	let end = CATALOG_VIEW_TEXT_LIMIT;
	const last = text.charCodeAt(end - 1);
	if (last >= 0xd800 && last <= 0xdbff) end -= 1;
	return { text: `${text.slice(0, end)}${TEXT_TRUNCATION_MARKER}`, truncated: true };
}

/** Bound one row's long display fields; other fields travel unchanged. */
function boundRow(row: CatalogViewRow): { row: CatalogViewRow; trimmed: boolean } {
	let trimmed = false;
	const bounded: Record<string, unknown> = { ...row };
	if (row.latestReply !== undefined) {
		const value = boundText(row.latestReply);
		bounded.latestReply = value.text;
		trimmed ||= value.truncated;
	}
	if (row.currentTool !== undefined) {
		const argument = boundText(row.currentTool.argument);
		bounded.currentTool = { name: row.currentTool.name, argument: argument.text };
		trimmed ||= argument.truncated;
	}
	return { row: bounded as unknown as CatalogViewRow, trimmed };
}

/**
 * Build one bounded view. The root row is emitted first when it fits. Rows that
 * do not fit are omitted and counted; long display texts are trimmed. A source
 * with an `unavailable` reason produces an explicit empty projection.
 */
export function boundCatalogView<Row extends CatalogViewRow>(source: CatalogViewSource<Row>): CatalogView {
	const base = {
		updatedAt: source.updatedAt,
		...(source.storageId === undefined ? {} : { storageId: source.storageId }),
	};
	if (source.unavailable !== undefined) {
		return parseCatalogView({
			...base,
			rows: [],
			coverage: { complete: false, omitted: 0 },
			unavailable: source.unavailable,
		});
	}
	const root = source.rootId === undefined ? undefined : source.rows.find((row) => row.id === source.rootId);
	const order: readonly CatalogViewRow[] =
		root === undefined ? [...source.rows] : [root, ...source.rows.filter((row) => row !== root)];
	const rows: CatalogViewRow[] = [];
	let omitted = 0;
	let trimmed = false;
	for (const candidate of order) {
		if (!Value.Check(AgentConversationSummarySchema, candidate)) throw new Error("Agent view has an invalid row");
		const bounded = boundRow(candidate);
		if (bounded.trimmed) trimmed = true;
		const next = [...rows, bounded.row];
		if (byteLength({ ...base, rows: next, coverage: { complete: false, omitted } }) > CATALOG_VIEW_BUDGET_BYTES) {
			omitted += 1;
			continue;
		}
		rows.push(bounded.row);
	}
	const view = { ...base, rows, coverage: { complete: !trimmed && omitted === 0, omitted } };
	while (byteLength(view) > CATALOG_VIEW_BUDGET_BYTES && rows.length > 0) {
		rows.pop();
		view.coverage.omitted++;
		view.coverage.complete = false;
	}
	return parseCatalogView(view);
}

function validateRows(rows: readonly CatalogViewRow[], storageId: string | undefined): void {
	for (const row of rows) {
		if (!Value.Check(AgentConversationSummarySchema, row)) throw new Error("Agent view has an invalid row");
		if (storageId !== undefined && row.storageId !== storageId) throw new Error("Agent view row has a different storageId");
	}
}

/** Validate one stored view. Oversized or malformed views are refused. */
export function parseCatalogView(value: unknown): CatalogView {
	if (value === null || typeof value !== "object" || Array.isArray(value))
		throw new Error("Agent view is not an object");
	const candidate = value as Partial<CatalogView>;
	if (typeof candidate.updatedAt !== "string") throw new Error("Agent view has no updatedAt");
	if (!Array.isArray(candidate.rows)) throw new Error("Agent view has no rows");
	const coverage = candidate.coverage;
	if (
		coverage === null ||
		typeof coverage !== "object" ||
		typeof coverage.complete !== "boolean" ||
		!Number.isSafeInteger(coverage.omitted) ||
		coverage.omitted < 0
	)
		throw new Error("Agent view has invalid coverage");
	if (candidate.storageId !== undefined && typeof candidate.storageId !== "string")
		throw new Error("Agent view has an invalid storageId");
	if (candidate.unavailable !== undefined && typeof candidate.unavailable !== "string")
		throw new Error("Agent view has an invalid unavailable reason");
	validateRows(candidate.rows, candidate.storageId);
	const view = candidate as CatalogView;
	if (byteLength(view) > CATALOG_VIEW_BUDGET_BYTES) throw new Error("Agent view exceeds its byte budget");
	if (!Number.isFinite(Date.parse(view.updatedAt)) || new Date(view.updatedAt).toISOString() !== view.updatedAt) throw new Error("Agent view has an invalid updatedAt");
	return view;
}

/** True when the value is a valid bounded view. */
export function isCatalogView(value: unknown): value is CatalogView {
	try {
		parseCatalogView(value);
		return true;
	} catch {
		return false;
	}
}
