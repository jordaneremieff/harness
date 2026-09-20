import { createHash } from "node:crypto";
import { BOUNDARY_LINES, boundResult, isoTime, oneLine, type Block, type Outcome } from "./format.ts";
import type { ModelSnapshot } from "./models.ts";
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
			}),
		)
		.digest("hex")
		.slice(0, 32);
}

function matchesDiscovery(record: Record<string, unknown>, query: Query): boolean {
	const name = String(record.name);
	return (
		(query.name === undefined || (query.match === "exact" ? name === query.name : name.includes(query.name))) &&
		(query.search === undefined ||
			`${name}\n${record.displayName ?? ""}`.toLowerCase().includes(query.search.toLowerCase())) &&
		(query.provider === undefined || record.provider === query.provider) &&
		(query.available === undefined || record.available === query.available)
	);
}

function discoveryBlocks(records: Record<string, unknown>[], stale: boolean): Block[] {
	if (stale) return [];
	return records.map((record) => ({
		lines: [
			"",
			`${String(record.kind).toUpperCase()} ${oneLine(String(record.name))}`,
			...Object.entries(record)
				.filter(([key]) => key !== "name" && key !== "kind")
				.map(([key, value]) => `  ${key}: ${oneLine(JSON.stringify(value))}`),
		],
		detail: record,
	}));
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
			"Model catalog and availability are synchronous local snapshots. Configured auth is presence only, not valid credentials or remote health.",
			"Model fields are capability metadata, not a remote probe. No catalog refresh or auth resolution occurred.",
		);
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
					catalogAvailable: models?.catalogAvailable ?? false,
					availableSnapshot: models?.availableSnapshot ?? false,
					catalogError: models?.catalogError ?? null,
					scopeConfigured: models?.scopeConfigured ?? null,
				}
			: { observed: observation !== null, observedAt: observation?.observedAt ?? null, observationPartial: partial }),
	};
}

/** Page the host's existing metadata, without a second index or source reads. */
export function discoveryPage(request: DiscoveryRequest) {
	const { query, models, observation } = request;
	const modelQuery = query.kind === "model";
	const unavailable = discoveryUnavailable(query, models, observation, modelQuery);
	const partial = discoveryPartial(models, observation, modelQuery);
	const all = discoveryRecords(models, observation, modelQuery);
	const fingerprint = discoveryFingerprint(all, modelQuery, unavailable, partial, models);
	const stale = request.expectedFingerprint !== undefined && request.expectedFingerprint !== fingerprint;
	const selected = all.filter((record) => matchesDiscovery(record, query));
	const page = paginate(selected, request.offset, query.limit);
	const outcome: Outcome = stale ? "stale_cursor" : unavailable ? "unavailable" : partial ? "partial" : selected.length ? "ok" : "missing";
	const result = boundResult({
		header: discoveryHeader(outcome, request, modelQuery, observation, stale, unavailable, partial),
		blocks: discoveryBlocks(page.items, stale),
		footer: ["", ...BOUNDARY_LINES],
		details: discoveryDetails(outcome, query, selected, page, modelQuery, models, observation, partial),
		continuation: (kept) =>
			!stale && request.offset + kept < selected.length
				? encodeCursor({ query, offset: request.offset + kept, fingerprint, epoch: request.epoch })
				: undefined,
	});
	return { ...result, outcome };
}
