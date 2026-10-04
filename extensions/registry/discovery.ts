import { createHash } from "node:crypto";
import { BOUNDARY_LINES, MODEL_CATALOG_BOUNDARY, MODEL_SCOPE_BOUNDARY, boundResult, fullRecordQuery, isoTime, oneLine, type Block, type Outcome } from "./format.ts";
import type { ModelRecord, ModelSnapshot } from "./models.ts";
import { catalogHealth, HEALTH_BOUNDARIES, healthCoverage, type HealthFinding } from "./health.ts";
import { encodeCursor, paginate, type Page, type Query } from "./query.ts";
import type { ObservationSnapshot } from "./records.ts";

export interface DiscoveryRequest {
	query: Query;
	models?: ModelSnapshot;
	observation: ObservationSnapshot | null;
	epoch: string;
	at: number;
	offset: number;
	expectedFingerprint?: string;
}

function discoveryUnavailable(
	query: Query,
	models: ModelSnapshot | undefined,
	observation: ObservationSnapshot | null,
	modelQuery: boolean,
): boolean {
	if (modelQuery) return !models?.catalogAvailable || (query.available !== undefined && !models?.availableSnapshot);
	return observation === null;
}

function discoveryPartial(
	models: ModelSnapshot | undefined,
	observation: ObservationSnapshot | null,
	modelQuery: boolean,
): boolean {
	if (modelQuery) return models?.catalogError !== false;
	return Boolean(observation?.overflowBytes || observation?.overflowRecords);
}

function discoveryRecords(
	models: ModelSnapshot | undefined,
	observation: ObservationSnapshot | null,
	modelQuery: boolean,
): Record<string, unknown>[] {
	if (modelQuery) return (models?.records ?? []).map((model) => ({ ...model }));
	return (observation?.contextFilePaths ?? []).map((path) => ({
		kind: "context_file",
		name: path,
		path,
		evidence: "observation",
		at: observation?.observedAt,
	}));
}

function discoveryFingerprint(
	records: Record<string, unknown>[],
	modelQuery: boolean,
	unavailable: boolean,
	partial: boolean,
	models: ModelSnapshot | undefined,
): string {
	return createHash("sha256")
		.update(
			JSON.stringify({
				// Model read time changes on each request; context observation time marks its source snapshot.
				records: modelQuery ? records.map(({ at: _at, ...record }) => record) : records,
				unavailable,
				partial,
				scopeConfigured: models?.scopeConfigured,
				scopeOrder: models?.scopeOrder ?? null,
				settingsScope: models?.settingsScope === undefined ? null
					: { status: models.settingsScope.status, patterns: models.settingsScope.patterns },
			}),
		)
		.digest("hex")
		.slice(0, 32);
}

function matchesDiscovery(record: Record<string, unknown>, query: Query): boolean {
	const name = String(record.name);
	const text = `${name}\n${record.displayName ?? ""}`.toLowerCase();
	const tokens = query.search?.toLowerCase().trim().split(/\s+/).filter(Boolean);
	const matchesSearch = query.search === undefined || (query.kind === "model"
		? tokens !== undefined && tokens.length > 0 && tokens.every((token) => text.includes(token))
		: text.includes(query.search.toLowerCase()));
	return (
		(query.name === undefined || (query.match === "exact" ? name === query.name : name.includes(query.name))) &&
		matchesSearch &&
		(query.provider === undefined || record.provider === query.provider) &&
		(query.available === undefined || record.available === query.available)
	);
}

function compactModelQuery(query: Query): boolean {
	return query.kind === "model" && !fullRecordQuery(query) && !query.health;
}

const MODEL_LIST_FIELDS = ["displayName", "input", "selected", "catalog", "available", "configuredAuth", "oauth", "subscriptionRecognized", "authSource", "catalogCost", "catalogCostHasTiers", "inScope", "scopeIndex", "providerHasScopedModels", "providerNamedInSettings", "reasoning", "contextWindow", "supportedThinkingLevels", "currentThinkingLevel"];

const MODEL_LIST_LABELS: Record<string, string> = { subscriptionRecognized: "subscription", catalogCost: "price", catalogCostHasTiers: "tiers", providerHasScopedModels: "providerScoped", providerNamedInSettings: "providerSettings" };

function compactModelValue(key: string, value: unknown): string {
	if (key !== "catalogCost" || value === null) return oneLine(JSON.stringify(value));
	const cost = value as NonNullable<ModelRecord["catalogCost"]>;
	return [cost.input, cost.output, cost.cacheRead, cost.cacheWrite].join("/");
}

function compactModelRecord(record: Record<string, unknown>): Record<string, unknown> {
	const cost = record.catalogCost as ModelRecord["catalogCost"];
	if (cost === null) return record;
	const { tiers: _tiers, ...rates } = cost;
	return { ...record, catalogCost: rates };
}

function discoveryBlocks(records: Record<string, unknown>[], stale: boolean, compact: boolean, exact: boolean): Block[] {
	if (stale) return [];
	return records.map((source) => {
		const record = source.kind === "model" && !exact ? compactModelRecord(source) : source;
		return {
			lines: compact ? [
				`MODEL ${oneLine(String(record.name))}`,
				`  ${MODEL_LIST_FIELDS.filter((key) => key in record).map((key) => `${MODEL_LIST_LABELS[key] ?? key}=${compactModelValue(key, record[key])}`).join(" ")}`,
				`  evidence: ${oneLine(String(record.evidence))} at ${isoTime(Number(record.at))}`,
			] : [
				"",
				`${String(record.kind).toUpperCase()} ${oneLine(String(record.name))}`,
				...Object.entries(record)
					.filter(([key]) => key !== "name" && key !== "kind" && key !== "findings")
					.map(([key, value]) => `  ${key}: ${oneLine(JSON.stringify(value))}`),
				...((record.findings ?? []) as HealthFinding[]).flatMap((finding) => [
					`  ${finding.code}: ${finding.reason}`,
					`    boundary: ${finding.boundary}`,
					...(finding.fields ? [`    conflicting fields: ${finding.fields.join(", ")} | duplicate records: ${finding.duplicateRecords}`] : []),
				]),
			],
			detail: record,
		};
	});
}

function settingsScopeLines(models: ModelSnapshot | undefined): string[] {
	const scope = models?.settingsScope;
	if (scope === undefined) return [];
	return [
		`Settings scope configuration: ${scope.status}; enabledModels=${oneLine(JSON.stringify(scope.patterns))}`,
		"Raw settings patterns are not effective session scope or operator preference; Durable inScope and providerScoped remain unknown. providerSettings reports a literal provider/ prefix, without model matching.",
	];
}

function discoveryHeader(
	outcome: Outcome,
	request: DiscoveryRequest,
	modelQuery: boolean,
	observation: ObservationSnapshot | null,
	stale: boolean,
	unavailable: boolean,
	partial: boolean,
): string[] {
	const lines = [`registry outcome=${outcome}`, `observed at: ${isoTime(request.at)}`];
	if (stale) lines.push("The source snapshot changed. Reissue the original query.");
	if (unavailable) lines.push("The required source is unavailable. This is not absence.");
	if (partial) lines.push("The source is incomplete. This is not absence.");
	if (modelQuery) {
		lines.push(
			MODEL_CATALOG_BOUNDARY,
			"Order: available with provider configuration evidence first, then other available, then remaining configured-auth records, then the rest; alphabetical provider/id within each group.",
			"Provider configuration evidence: providerScoped=true from resolved scope in ordinary sessions; providerSettings=true from literal settings prefixes in Durable. Neither filters the catalog nor establishes operator preference.",
			"Model metadata and cached availability are synchronous local snapshots. configuredAuth is presence, not credential validity; no refresh, auth resolution, or probe. Quota, balance, and remote health remain unchecked.",
			MODEL_SCOPE_BOUNDARY,
			"price: catalog USD/Mtok, input/output/cacheRead/cacheWrite; not billed spend. subscription means Pi-recognized, not inferred from OAuth; false does not imply metered billing. tiers marks price tiers; exact model lookup returns them.",
			...settingsScopeLines(request.models),
			...(compactModelQuery(request.query) ? ["Compact models; use kind:model + exact provider/id name for full metadata."] : []),
		);
		if (request.query.health) {
			lines.push(...HEALTH_BOUNDARIES);
			if (!stale && !unavailable && !partial) lines.push("No flagged records means no supported signal matched the requested filters, not that the catalog is healthy.");
		}
	} else {
		lines.push(
			observation
				? `Context paths are prior observation evidence at ${isoTime(observation.observedAt)}.`
				: "Context paths are not_yet_observed.",
			"No context contents were retained or read. These inputs do not establish the final prompt or provider payload.",
		);
	}
	return lines;
}

function discoveryDetails(
	outcome: Outcome,
	query: Query,
	selected: Record<string, unknown>[],
	page: Page<Record<string, unknown>>,
	modelQuery: boolean,
	models: ModelSnapshot | undefined,
	observation: ObservationSnapshot | null,
	partial: boolean,
): Record<string, unknown> {
	return {
		outcome,
		query,
		total: selected.length,
		offset: page.offset,
		...(modelQuery
			? {
					catalogBoundary: MODEL_CATALOG_BOUNDARY,
					catalogAvailable: models?.catalogAvailable ?? false,
					availableSnapshot: models?.availableSnapshot ?? false,
					catalogError: models?.catalogError ?? null,
					scopeConfigured: models?.scopeConfigured ?? null,
					...(models?.settingsScope === undefined ? {} : { settingsScope: models.settingsScope }),
				}
			: { observed: observation !== null, observedAt: observation?.observedAt ?? null, observationPartial: partial }),
	};
}

function discoveryOutcome(stale: boolean, unavailable: boolean, partial: boolean, hasResults: boolean): Outcome {
	if (stale) return "stale_cursor";
	if (unavailable) return "unavailable";
	if (partial) return "partial";
	return hasResults ? "ok" : "missing";
}

/** Page the host's existing metadata, without a second index or source reads. */
export function discoveryPage(request: DiscoveryRequest) {
	const { query, models, observation } = request;
	const modelQuery = query.kind === "model";
	const unavailable = discoveryUnavailable(query, models, observation, modelQuery);
	const partial = discoveryPartial(models, observation, modelQuery) ||
		Boolean(query.health && models?.records.some((record) => record.selected && record.configuredAuth === null));
	const all = discoveryRecords(models, observation, modelQuery);
	const fingerprint = discoveryFingerprint(all, modelQuery, unavailable, partial, models);
	const stale = request.expectedFingerprint !== undefined && request.expectedFingerprint !== fingerprint;
	const candidates = query.health ? catalogHealth(models).map((record) => ({ ...record })) : all;
	const matched = all.filter((record) => matchesDiscovery(record, query));
	const selected = candidates.filter((record) => matchesDiscovery(record, query));
	const page = paginate(selected, request.offset, query.limit);
	const outcome = discoveryOutcome(stale, unavailable, partial, selected.length > 0 || query.health === true);
	const result = boundResult({
		header: discoveryHeader(outcome, request, modelQuery, observation, stale, unavailable, partial),
		blocks: discoveryBlocks(page.items, stale, compactModelQuery(query), fullRecordQuery(query)),
		footer: ["", ...BOUNDARY_LINES],
		details: {
			...discoveryDetails(outcome, query, selected, page, modelQuery, models, observation, partial),
			...(query.health ? { health: { ...healthCoverage(models), matchedRecords: matched.length,
				unflaggedRecords: matched.length - selected.length, boundaries: HEALTH_BOUNDARIES } } : {}),
		},
		...(query.health ? { pageSummary: (kept: number) =>
			`flagged records: ${kept} shown of ${selected.length} | matched records: ${matched.length} | unflagged records: ${matched.length - selected.length}` } : {}),
		continuation: (kept) =>
			outcome === "ok" && request.offset + kept < selected.length
				? encodeCursor({ query, offset: request.offset + kept, fingerprint, epoch: request.epoch })
				: undefined,
	});
	return { ...result, outcome };
}
