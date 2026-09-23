import type { ModelRecord, ModelSnapshot } from "./models.ts";

export interface HealthFinding {
	code: "expiry_marker" | "selected_not_in_catalog" | "selected_auth_missing" | "metadata_conflict";
	reason: string;
	boundary: string;
	fields?: string[];
	duplicateRecords?: number;
}

export interface HealthRecord extends ModelRecord {
	findings: HealthFinding[];
}

const CAPABILITY_FIELDS = ["reasoning", "input", "contextWindow", "maxTokens", "supportedThinkingLevels"] as const;

/** Compare capability sets, not array order or provider-specific display names. */
function capabilityValue(record: ModelRecord, field: (typeof CAPABILITY_FIELDS)[number]): string {
	const value = record[field];
	return JSON.stringify(Array.isArray(value) ? [...new Set(value)].sort() : value);
}

function metadataDifferences(records: ModelRecord[]): Map<string, HealthFinding> {
	const groups = new Map<string, ModelRecord[]>();
	for (const record of records) {
		if (!record.catalog) continue;
		const identity = JSON.stringify([record.provider, record.id]);
		const group = groups.get(identity) ?? [];
		group.push(record);
		groups.set(identity, group);
	}
	const differences = new Map<string, HealthFinding>();
	for (const [identity, group] of groups) {
		if (group.length < 2) continue;
		const fields = CAPABILITY_FIELDS.filter((field) => new Set(group.map((record) => capabilityValue(record, field))).size > 1);
		if (fields.length === 0) continue;
		differences.set(identity, {
			code: "metadata_conflict", fields, duplicateRecords: group.length,
			reason: "The same provider/model identity has conflicting capability metadata in the returned catalog.",
			boundary: "Only visible catalog rows and projected capability fields are compared. Different providers are distinct identities; shadowed registrations and remote capabilities are not checked.",
		});
	}
	return differences;
}

export const HEALTH_BOUNDARIES = [
	"Catalog health is an offline review of ID markers, selected-model membership/auth presence, and same-identity capability conflicts. It is not remote health.",
	"Expiry detection recognizes the explicit expires-on- marker followed by a date-shaped suffix. It does not infer a year, validate a retirement date, or treat ordinary model version dates as expiry.",
	"The host can omit a provider whose catalog getter fails without reporting a catalog error. No findings does not establish complete provider coverage.",
	"Provider-refresh membership/time and recent dispatch use/age are unavailable in this snapshot. No sibling store is read; no refresh, credential resolution, or live probe occurs.",
];

/** Derive review signals only from the existing safe projection. No retained state. */
export function catalogHealth(snapshot: ModelSnapshot | undefined): HealthRecord[] {
	const records = snapshot?.records ?? [];
	const differences = metadataDifferences(records);
	return records.flatMap((record) => {
		const findings: HealthFinding[] = [];
		if (/(?:^|[-_/.])expires-on-\d{4}(?:-\d{2}-\d{2})?(?=$|[-_/.])/i.test(record.id)) {
			findings.push({
				code: "expiry_marker",
				reason: "The model ID contains an explicit expires-on- date marker.",
				boundary: "ID text only. The date and remote retirement status are unverified; a four-digit suffix supplies no year.",
			});
		}
		if (record.selected && !record.catalog && snapshot?.catalogAvailable && snapshot.catalogError === false) {
			findings.push({
				code: "selected_not_in_catalog",
				reason: "The selected provider/model ID is absent from the returned local catalog.",
				boundary: "Current selection compared with returned getAll rows. The host can silently omit failed providers; this does not establish removal, last-refresh membership, or remote resolution.",
			});
		}
		if (record.selected && record.configuredAuth === false) {
			findings.push({
				code: "selected_auth_missing",
				reason: "The selected model has no configured auth according to the host.",
				boundary: "Current selection and configured-auth presence only, not recent dispatch use, credential validity, or a remote auth failure.",
			});
		}
		const difference = record.catalog ? differences.get(JSON.stringify([record.provider, record.id])) : undefined;
		if (difference) findings.push(difference);
		return findings.length === 0 ? [] : [{ ...record, findings }];
	});
}

export function healthCoverage(snapshot: ModelSnapshot | undefined) {
	const selected = snapshot?.records.find((record) => record.selected);
	return {
		evidence: "local_catalog_review",
		catalogRecords: snapshot?.records.filter((record) => record.catalog).length ?? 0,
		selectedAuth: !selected ? "not_selected" : selected.configuredAuth === null ? "unavailable" : "checked",
		providerRefreshMembership: "unavailable",
		providerRefreshTime: "unavailable",
		recentDispatchUse: "unavailable",
		lastDispatchAge: "unavailable",
		remoteResolution: "not_checked",
	};
}
