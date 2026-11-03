import { str, num, int, bool, nul, lit, union, arr, obj } from "@earendil-works/pi-schema";
import { ListOutputProperties, ListRowProperties, ListCoverageProperties } from "./observation-schema.ts";
import type { ProfileHints } from "./profile-schema.ts";
import type { AgentConversationSummary } from "./dashboard-types.ts";

const nullableText = union([str(), nul()]);
const ProfiledListRowSchema = obj({
	...ListRowProperties,
	handle: nullableText, role: nullableText,
	profile: union([obj({ revision: str(), hasExpertise: bool(), updatedAt: union([num(), nul()]), source: lit("retained") }), nul()]),
	profileCoverage: union([lit("retained"), lit("unknown")]),
});
/** Frontend composite; the base host list operation keeps its independent schema. */
export const ProfiledListOutputSchema = obj({
	...ListOutputProperties,
	rows: arr(ProfiledListRowSchema),
	coverage: obj({
		...ListCoverageProperties,
		profileHints: obj({ complete: bool(), unknownStorages: int({ minimum: 0 }), omitted: int({ minimum: 0 }) }),
	}),
});

/** Retained profile hints enrich frontend rows, never the base host wire schema. */
export function composeListRow<T extends { identity: string; name?: string; firstMessage?: string }>(
	row: T, hints: ProfileHints | undefined, cwd: string, storageId: string,
) {
	const hint = hints?.rows.find((item) => item.identity === row.identity);
	return {
		...row, sessionId: row.identity, storageId, cwd,
		handle: hint?.handle ?? null, role: hint?.role ?? null,
		profile: hint ? { revision: hint.revision, hasExpertise: hint.hasExpertise, updatedAt: hint.updatedAt, source: "retained" as const } : null,
		profileCoverage: hint ? "retained" as const : "unknown" as const,
	};
}

/** Literal discovery includes concern addresses and roles without a host read. */
export function matchesListRow(row: { identity: string; name?: string; firstMessage?: string; cwd: string; handle?: string | null; role?: string | null }, query: string): boolean {
	const term = query.toLocaleLowerCase();
	return [row.identity, row.name, row.firstMessage, row.cwd, row.handle, row.role]
		.some((value) => value?.toLocaleLowerCase().includes(term));
}

export function enrichDashboardRow(row: AgentConversationSummary, hints: ProfileHints | undefined): AgentConversationSummary {
	const profile = hints?.rows.find((hint) => hint.identity === row.id);
	return profile ? { ...row, profile } : row;
}
