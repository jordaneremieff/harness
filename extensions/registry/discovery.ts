import { createHash } from "node:crypto";
import { BOUNDARY_LINES, boundResult, isoTime, oneLine, type Outcome } from "./format.ts";
import type { ModelSnapshot } from "./models.ts";
import { encodeCursor, paginate, type Query } from "./query.ts";
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

/** Page the host's existing metadata, without a second index or source reads. */
export function discoveryPage(request: DiscoveryRequest) {
	const { query, models, observation } = request;
	const modelQuery = query.kind === "model";
	const unavailable = modelQuery
		? !models?.catalogAvailable || (query.available !== undefined && !models?.availableSnapshot)
		: observation === null;
	const partial = modelQuery
		? models?.catalogError !== false
		: Boolean(observation?.overflowBytes || observation?.overflowRecords);
	const all: Record<string, unknown>[] = modelQuery
		? (models?.records ?? []).map((model) => ({ ...model }))
		: (observation?.contextFilePaths ?? []).map((path) => ({ kind: "context_file", name: path, path,
			evidence: "observation", at: observation?.observedAt }));
	const fingerprint = createHash("sha256").update(JSON.stringify({
		// Model read time changes on each request; context observation time marks its source snapshot.
		records: modelQuery ? all.map(({ at: _at, ...record }) => record) : all,
		unavailable, partial, scopeConfigured: models?.scopeConfigured, scopeOrder: models?.scopeOrder ?? null,
	})).digest("hex").slice(0, 32);
	const stale = request.expectedFingerprint !== undefined && request.expectedFingerprint !== fingerprint;
	const selected = all.filter((record) => {
		const name = String(record.name);
		return (query.name === undefined || (query.match === "exact" ? name === query.name : name.includes(query.name))) &&
			(query.search === undefined || `${name}\n${record.displayName ?? ""}`.toLowerCase().includes(query.search.toLowerCase())) &&
			(query.provider === undefined || record.provider === query.provider) &&
			(query.available === undefined || record.available === query.available);
	});
	const page = paginate(selected, request.offset, query.limit);
	const outcome: Outcome = stale ? "stale_cursor" : unavailable ? "unavailable" : partial ? "partial" : selected.length ? "ok" : "missing";
	const blocks = stale ? [] : page.items.map((record) => ({
		lines: ["", `${String(record.kind).toUpperCase()} ${oneLine(String(record.name))}`,
			...Object.entries(record).filter(([key]) => key !== "name" && key !== "kind")
				.map(([key, value]) => `  ${key}: ${oneLine(JSON.stringify(value))}`)],
		detail: record,
	}));
	const result = boundResult({
		header: [`registry outcome=${outcome}`, `observed at: ${isoTime(request.at)}`,
			...(stale ? ["The source snapshot changed. Reissue the original query."] : []),
			...(unavailable ? ["The required source is unavailable. This is not absence."] : []),
			...(partial ? ["The source is incomplete. This is not absence."] : []),
			...(modelQuery
				? ["Model catalog and availability are synchronous local snapshots. Configured auth is presence only, not valid credentials or remote health.",
					"Model fields are capability metadata, not a remote probe. No catalog refresh or auth resolution occurred."]
				: [observation ? `Context paths are prior observation evidence at ${isoTime(observation.observedAt)}.` : "Context paths are not_yet_observed.",
					"No context contents were retained or read. These inputs do not establish the final prompt or provider payload."]),
		],
		blocks,
		footer: ["", ...BOUNDARY_LINES],
		details: { outcome, query, total: selected.length, offset: page.offset,
			...(modelQuery ? { catalogAvailable: models?.catalogAvailable ?? false, availableSnapshot: models?.availableSnapshot ?? false,
				catalogError: models?.catalogError ?? null, scopeConfigured: models?.scopeConfigured ?? null }
				: { observed: observation !== null, observedAt: observation?.observedAt ?? null, observationPartial: partial }) },
		continuation: (kept) => !stale && request.offset + kept < selected.length
			? encodeCursor({ query, offset: request.offset + kept, fingerprint, epoch: request.epoch }) : undefined,
	});
	return { ...result, outcome };
}
