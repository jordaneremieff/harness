import { Type } from "typebox";
import { ListOutputSchema, ListRowSchema } from "./observation-schema.ts";
import type { ProfileHints } from "./profile-schema.ts";
import type { AgentConversationSummary } from "./dashboard-types.ts";

const nullableText = Type.Union([Type.String(), Type.Null()]);
const ProfiledListRowSchema = Type.Object({
	...ListRowSchema.properties,
	handle: nullableText, role: nullableText,
	profile: Type.Union([Type.Object({ revision: Type.String(), hasExpertise: Type.Boolean(), updatedAt: Type.Union([Type.Number(), Type.Null()]), source: Type.Literal("retained") }, { additionalProperties: false }), Type.Null()]),
	profileCoverage: Type.Union([Type.Literal("retained"), Type.Literal("unknown")]),
}, { additionalProperties: false });
/** Frontend composite; the base host list operation keeps its independent schema. */
export const ProfiledListOutputSchema = Type.Object({
	...ListOutputSchema.properties,
	rows: Type.Array(ProfiledListRowSchema),
	coverage: Type.Object({
		...ListOutputSchema.properties.coverage.properties,
		profileHints: Type.Object({ complete: Type.Boolean(), unknownStorages: Type.Integer({ minimum: 0 }), omitted: Type.Integer({ minimum: 0 }) }, { additionalProperties: false }),
	}, { additionalProperties: false }),
}, { additionalProperties: false });

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
