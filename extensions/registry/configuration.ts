import { createHash } from "node:crypto";
import { collectSettings, type SettingsBus, type SettingsPublication } from "../../settings/index.ts";
import { boundResult, escapeJsonControls, isoTime, oneLine, queryLine, type Outcome } from "./format.ts";
import { decodeCursor, encodeCursor, hasAnySelector, paginate, parseQuery, type Query, type RawParams } from "./query.ts";

export interface SettingsSnapshot {
	publications: SettingsPublication[];
	available: boolean;
	collection: { status: "available" | "unavailable" | "disposed"; slices: string[]; malformed: number; omitted: number };
}

/** The public event bus belongs to the factory's ordinary session or Durable host. */
export function settingsReader(bus: SettingsBus) {
	let collector: ReturnType<typeof collectSettings> | undefined;
	return {
		read(): SettingsSnapshot {
			try {
				if (collector) collector.refresh();
				else collector = collectSettings(bus);
				const collection = collector.coverage();
				return { publications: collector.snapshots(), available: collection.status === "available", collection };
			} catch {
				return { publications: [], available: false, collection: { status: "unavailable", slices: [], malformed: 0, omitted: 0 } };
			}
		},
		dispose() { collector?.dispose(); collector = undefined; },
	};
}

export function settingQuery(params: RawParams): boolean {
	try {
		const query = params.cursor === undefined ? parseQuery(params) : decodeCursor(params.cursor).query;
		return query.kind === "setting" && !(params.cursor !== undefined && hasAnySelector(params));
	} catch { return false; }
}

function projection(publications: SettingsPublication[]) {
	return publications.flatMap((publication) => publication.records.map((record) => ({
		kind: "setting" as const,
		...record,
		slice: publication.slice,
		documentPath: publication.source.path,
		documentStatus: publication.source.status,
		observedAt: publication.source.observedAt,
		diagnostics: publication.diagnostics.filter((diagnostic) => diagnostic.field === record.name),
	}))).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
}

function coverage(snapshot: SettingsSnapshot) {
	return {
		available: snapshot.available,
		respondingSlices: snapshot.publications.map((publication) => publication.slice).sort(),
		installedCoverage: "unknown" as const,
		collection: snapshot.collection,
		publications: snapshot.publications.map((publication) => ({
			slice: publication.slice,
			documentPath: publication.source.path,
			documentStatus: publication.source.status,
			observedAt: publication.source.observedAt,
			diagnostics: publication.diagnostics,
		})),
	};
}

function fingerprint(snapshot: SettingsSnapshot): string {
	// Raw document digests depend on rejected secret inputs; only safe projections enter cursors.
	const stable = {
		...coverage(snapshot),
		publications: coverage(snapshot).publications.map(({ observedAt: _at, ...publication }) => publication),
		records: projection(snapshot.publications).map(({ observedAt: _at, ...record }) => record),
	};
	return createHash("sha256").update(JSON.stringify(stable)).digest("hex").slice(0, 32);
}

function matchesSetting(record: ReturnType<typeof projection>[number], query: Query): boolean {
	if (query.name !== undefined && !(query.match === "exact" ? record.name === query.name : record.name.includes(query.name))) return false;
	const search = query.search?.toLowerCase();
	return search === undefined || [record.name, record.description, record.env].some((text) => text.toLowerCase().includes(search));
}
function settingBlock(record: ReturnType<typeof projection>[number]) {
	const value = record.secret ? record.secretState : record.value === undefined ? "unset" : escapeJsonControls(JSON.stringify(record.value));
	return {
		detail: record,
		lines: ["", `SETTING ${record.name}`, `  value: ${value}`,
			`  origin: ${record.origin} | validity: ${record.status} | type: ${record.type}`,
			`  description: ${oneLine(record.description, 2048)}`, `  env: ${record.env}`, `  document: ${oneLine(record.documentPath, 4096)}`,
			...record.diagnostics.map((fact) => `  diagnostic: ${fact.code}: ${fact.message}`)],
	};
}
function settingOutcome(stale: boolean, snapshot: SettingsSnapshot, partial: boolean, total: number): Outcome {
	if (stale) return "stale_cursor";
	if (!snapshot.available) return "unavailable";
	if (partial) return "partial";
	if (snapshot.publications.length === 0) return "unavailable";
	return total ? "ok" : "missing";
}

export function settingsPage(request: {
	query: Query; snapshot?: SettingsSnapshot; epoch: string; at: number; offset: number; expectedFingerprint?: string;
}) {
	const snapshot: SettingsSnapshot = request.snapshot ?? { publications: [], available: false,
		collection: { status: "unavailable", slices: [], malformed: 0, omitted: 0 } };
	const stamp = fingerprint(snapshot);
	const stale = request.expectedFingerprint !== undefined && request.expectedFingerprint !== stamp;
	const query = request.query;
	const selected = projection(snapshot.publications).filter((record) => matchesSetting(record, query));
	const page = paginate(selected, request.offset, query.limit);
	const partial = snapshot.collection.malformed > 0 || snapshot.collection.omitted > 0 ||
		snapshot.publications.some((publication) => publication.diagnostics.some((fact) => fact.code === "coverage"));
	const outcome = settingOutcome(stale, snapshot, partial, selected.length);
	const result = boundResult({
		header: [
			`registry outcome=${outcome}`, `observed at: ${isoTime(request.at)}`, `query: ${queryLine(query)}`,
			"Source: responding loaded settings publishers on the public host event bus.",
			"Values are fresh configuration snapshots, not proof a running runtime applied edits.",
			"Coverage excludes nonresponding, inactive, and unloaded extensions; their settings remain unknown.",
			`Collection: ${snapshot.collection.status} | malformed publications: ${snapshot.collection.malformed} | omitted publications: ${snapshot.collection.omitted}`,
			...(partial ? ["Publication or diagnostic coverage is partial; no absence is established."] : []),
			...(stale ? ["The configured settings or publication coverage changed; start a new query."] : []),
			...(!snapshot.available ? ["The settings collection is unavailable; no absence is established."] : []),
			...(snapshot.publications.length ? [] : ["No loaded publisher responded. This does not establish that no settings exist."]),
		],
		blocks: stale ? [] : page.items.map(settingBlock),
		footer: ["", "Document and unknown-key diagnostics remain in settingsCoverage.publications, including diagnostics without declared rows.",
			...snapshot.publications.flatMap((publication) => publication.diagnostics.map((fact) =>
				`${oneLine(fact.field.startsWith(`${publication.slice}.`) ? fact.field : `${publication.slice}.${fact.field}`, 320)}: ${fact.source} ${fact.code}: ${fact.message}`))],
		details: { outcome, query, total: selected.length, offset: page.offset, settingsCoverage: coverage(snapshot) },
		pageSummary: (kept) => `settings: ${kept} shown of ${selected.length} matched | offset ${page.offset} | limit ${query.limit}`,
		continuation: (kept) => !stale && !partial && snapshot.available && request.offset + kept < selected.length
			? encodeCursor({ query, offset: request.offset + kept, fingerprint: stamp, epoch: request.epoch }) : undefined,
	});
	return { ...result, outcome };
}
