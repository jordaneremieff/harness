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

import { Compile } from "typebox/compile";
import { NativeIntentMetadataSchema } from "./effort-schema.ts";
import type { NativeIntentMetadata } from "./durable-controls.ts";
import { boundModelEvidence, MODEL_EVIDENCE_BUDGET_BYTES, ModelEvidenceSchema, type ModelEvidence } from "./model-evidence.ts";
import { AgentConversationSummarySchema } from "./observation-schema.ts";
import { ProfileHintsSchema, type ProfileHints } from "./profile-schema.ts";
import type { ProfileSeed } from "./profile.ts";
import { handleSlug } from "./identity.ts";
import { CatalogAttentionHintsSchema, type CatalogAttentionHints } from "./catalog-attention.ts";

/** Bytes available to one serialized view inside the catalog record bound. */
export const CATALOG_VIEW_BUDGET_BYTES = 24 * 1024;
/** Longest display text kept for one row field. */
export const CATALOG_VIEW_TEXT_LIMIT = 2000;
const TEXT_TRUNCATION_MARKER = " […]";
const conversationSummaryValidator = Compile(AgentConversationSummarySchema);
const attentionHintsValidator = Compile(CatalogAttentionHintsSchema);
const intentMetadataValidator = Compile(NativeIntentMetadataSchema);
const modelEvidenceValidator = Compile(ModelEvidenceSchema);
const profileHintsValidator = Compile(ProfileHintsSchema);

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

export interface CatalogIntentClaims {
	readonly rows: Readonly<Record<string, NativeIntentMetadata | null>>;
	readonly coverage: { readonly complete: boolean; readonly omitted: number };
}

/** Bounded projection of one host's conversations. */
export interface CatalogView {
	/** Optional native claims. Absence means unsupported or unavailable, never an empty claim set. */
	readonly intentClaims?: CatalogIntentClaims;
	/** Optional intervention hints; absence remains unknown, even with complete coverage. */
	readonly attention?: CatalogAttentionHints;
	/** Optional sampled model evidence; absence means unknown, never zero usage. */
	readonly modelEvidence?: ModelEvidence;
	/** Bounded optional hints; base wire rows remain unchanged. */
	readonly profiles?: ProfileHints;
	/** Retained creation defaults, consumed only in the root's creation commit. */
	readonly profileSeed?: ProfileSeed;
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
	let end = CATALOG_VIEW_TEXT_LIMIT - TEXT_TRUNCATION_MARKER.length;
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
		if (!conversationSummaryValidator.Check(candidate)) throw new Error("Agent view has an invalid row");
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
		if (!conversationSummaryValidator.Check(row)) throw new Error("Agent view has an invalid row");
		if (storageId !== undefined && row.storageId !== storageId) throw new Error("Agent view row has a different storageId");
	}
}

function validateAttentionHints(candidate: Partial<CatalogView>): void {
	if (candidate.attention === undefined) return;
	if (!attentionHintsValidator.Check(candidate.attention)) throw new Error("Invalid attention hints");
	const identities = new Set(candidate.rows?.map((row) => row.id));
	const seen = new Set<string>();
	for (const hint of candidate.attention.rows) {
		if (!identities.has(hint.identity) || seen.has(hint.identity)) throw new Error("Invalid attention hint identity");
		seen.add(hint.identity);
	}
}

function validateIntentOwner(identity: string, storageId: string): void {
	const owner = identity.split(":");
	if (owner[0] !== storageId || owner.length > 2 || owner[1] !== undefined && (!/^[1-9]\d*$/u.test(owner[1]) || !Number.isSafeInteger(Number(owner[1])))) throw new Error("Native intent belongs to a different storage");
}

function validateIntentClaims(candidate: Partial<CatalogView>): void {
	const claims = candidate.intentClaims;
	if (claims === undefined) return;
	if (!candidate.storageId || !claims || typeof claims !== "object" || !claims.rows || typeof claims.rows !== "object" || Array.isArray(claims.rows)) throw new Error("Invalid native intent projection");
	if (!claims.coverage || typeof claims.coverage.complete !== "boolean" || !Number.isSafeInteger(claims.coverage.omitted) || claims.coverage.omitted < 0 || claims.coverage.complete && claims.coverage.omitted !== 0) throw new Error("Invalid native intent coverage");
	const rows = new Map(candidate.rows?.map(row => [row.id, row]));
	for (const [identity, metadata] of Object.entries(claims.rows)) {
		const row = rows.get(identity);
		validateIntentOwner(identity, candidate.storageId);
		if (!row || metadata !== null && (!intentMetadataValidator.Check(metadata) || metadata.cwd !== row.cwd)) throw new Error("Native intent belongs to a different conversation or location");
	}
}
function validateHints(candidate: Partial<CatalogView>): void {
	validateIntentClaims(candidate);
	validateAttentionHints(candidate);
	if (candidate.modelEvidence !== undefined && (!modelEvidenceValidator.Check(candidate.modelEvidence) || byteLength(candidate.modelEvidence) > MODEL_EVIDENCE_BUDGET_BYTES))
		throw new Error("Invalid model evidence");
	if (candidate.profiles !== undefined && !profileHintsValidator.Check(candidate.profiles)) throw new Error("Invalid profile hints");
	if (candidate.profileSeed === undefined) return;
	handleSlug(candidate.profileSeed.handle);
	if (typeof candidate.profileSeed.role !== "string" || [...candidate.profileSeed.role].length > 2000) throw new Error("Invalid profile creation seed");
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
	validateHints(candidate);
	const view = candidate as CatalogView;
	if (byteLength(view) > CATALOG_VIEW_BUDGET_BYTES) throw new Error("Agent view exceeds its byte budget");
	if (!Number.isFinite(Date.parse(view.updatedAt)) || new Date(view.updatedAt).toISOString() !== view.updatedAt) throw new Error("Agent view has an invalid updatedAt");
	return view;
}

/** Retain whole claims only; omission never changes their text or weakens their declared scope. */
export function withIntentClaims(view: CatalogView, source: CatalogIntentClaims): CatalogView {
	const { intentClaims: _previous, ...base } = view;
	const identities = new Set(base.rows.map(row => row.id));
	const rows: Record<string, NativeIntentMetadata | null> = Object.create(null);
	let omitted = source.coverage.omitted;
	const result = () => ({ ...base, intentClaims: { rows, coverage: { complete: source.coverage.complete && omitted === 0, omitted } } });
	for (const [identity, metadata] of Object.entries(source.rows)) {
		if (!identities.has(identity)) { omitted++; continue; }
		rows[identity] = metadata;
		if (byteLength(result()) > CATALOG_VIEW_BUDGET_BYTES) { delete rows[identity]; omitted++; }
	}
	return byteLength(result()) > CATALOG_VIEW_BUDGET_BYTES ? base : parseCatalogView(result());
}

/** Add optional hints without evicting base operational rows from their budget. */
export function withProfileHints(view: CatalogView, profiles: ProfileHints): CatalogView {
	const rows: ProfileHints["rows"] = [];
	let omitted = profiles.coverage.omitted;
	for (const hint of profiles.rows) {
		const next = { ...view, profiles: { rows: [...rows, hint], coverage: { complete: false, omitted } } };
		if (byteLength(next) > CATALOG_VIEW_BUDGET_BYTES - 32) omitted++;
		else rows.push(hint);
	}
	const result = { ...view, profiles: { rows, coverage: { complete: profiles.coverage.complete && omitted === 0, omitted } } };
	if (byteLength(result) > CATALOG_VIEW_BUDGET_BYTES) return view;
	return parseCatalogView(result);
}

/** Add intervention hints only in the space left by operational rows and profile hints. */
export function withAttentionHints(view: CatalogView, source: CatalogAttentionHints): CatalogView {
	if (!attentionHintsValidator.Check(source)) throw new Error("Invalid attention hints");
	const { attention: _attention, ...base } = view;
	const rows: CatalogAttentionHints["rows"] = [];
	let omitted = source.coverage.omitted + source.rows.length;
	const projection = () => ({ ...base, attention: { rows, coverage: { complete: source.coverage.complete && omitted === 0, omitted } } });
	for (const hint of source.rows) {
		rows.push(hint);
		omitted--;
		if (byteLength(projection()) > CATALOG_VIEW_BUDGET_BYTES) {
			rows.pop();
			omitted++;
		}
	}
	const result = projection();
	return byteLength(result) > CATALOG_VIEW_BUDGET_BYTES ? base : parseCatalogView(result);
}

/** Evidence uses only the space left by operational rows and optional hints. */
export function withModelEvidence(view: CatalogView, source: ModelEvidence): CatalogView {
	const remaining = CATALOG_VIEW_BUDGET_BYTES - byteLength(view) - Buffer.byteLength(',"modelEvidence":');
	const modelEvidence = boundModelEvidence(source, Math.min(MODEL_EVIDENCE_BUDGET_BYTES, remaining));
	return modelEvidence === undefined ? view : parseCatalogView({ ...view, modelEvidence });
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
