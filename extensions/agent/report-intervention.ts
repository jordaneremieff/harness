/** Pure report associations match exact admitted inputs, not a sender's other work. */
import { arr, int, obj, type Static } from "@earendil-works/pi-schema";
import { ResultReferenceSchema, type ResultReference } from "./result-schema.ts";
import { matchesSchema } from "./schema-check.ts";
import { communicationIdentity } from "./communication.ts";

export const ReportInterventionSchema = obj({ producerRunId: int({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }), producerResults: arr(ResultReferenceSchema, { minItems: 1, uniqueItems: true }) });
export type ReportIntervention = Static<typeof ReportInterventionSchema>;
export function parseReportIntervention(value: unknown): ReportIntervention {
	if (!matchesSchema(ReportInterventionSchema, value) || !value.producerResults.every((result) => communicationIdentity(result.sessionId))) throw new Error("Report intervention must identify exact native inputs");
	const keys = value.producerResults.map((result) => `${result.sessionId}/${result.submissionId}`);
	if (new Set(keys).size !== keys.length) throw new Error("Report intervention repeats an admitted input");
	return JSON.parse(JSON.stringify(value)) as ReportIntervention;
}
export function interventionMatches(intervention: ReportIntervention, results: readonly ResultReference[]): boolean {
	return intervention.producerResults.some((observed) => results.some((expected) => expected.sessionId === observed.sessionId && expected.submissionId === observed.submissionId && (expected.requestId === undefined || observed.requestId === undefined || expected.requestId === observed.requestId)));
}
