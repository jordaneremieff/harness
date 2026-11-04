import { str, num, int, bool, nul, lit, union, arr, opt, obj, type Schema, type Static } from "@earendil-works/pi-schema";
import { HANDLE_PATTERN } from "./identity.ts";

const nullableText = union([str(), nul()]);
const nullableTime = union([num(), nul()]);
const StringEnum = <const T extends readonly string[]>(values: T): Schema<T[number]> => ({ type: "string", enum: [...values] });
export const ProfileParams = obj({
	sessionId: opt(str({ minLength: 1, maxLength: 256 })),
	action: StringEnum(["read", "update"]),
	expectedRevision: opt(str({ pattern: "^[a-f0-9]{64}$" })),
	role: opt(str({ maxLength: 2000 })),
	expertise: opt(str({ maxLength: 16384 })),
});
export const HandleSchema = str({ pattern: HANDLE_PATTERN, maxLength: 64 });
export const ProfileHintSchema = obj({
	identity: str(), handle: nullableText, role: str(), revision: str(), hasExpertise: bool(), updatedAt: nullableTime,
});
export const ProfileHintsSchema = obj({
	rows: arr(ProfileHintSchema), coverage: obj({ complete: bool(), omitted: int({ minimum: 0 }) }),
});
export type ProfileHint = Static<typeof ProfileHintSchema>;
export type ProfileHints = Static<typeof ProfileHintsSchema>;
export const AgentProfileSchema = obj({
	identity: str(), handle: nullableText, name: nullableText, role: str(), expertise: str(), revision: str(),
	updatedAt: nullableTime, updatedBy: nullableText, creator: nullableText,
	model: union([obj({ provider: str(), modelId: str() }), nul()]),
	thinkingLevel: nullableText, cwd: nullableText, live: bool(),
	requestsOmitted: opt(int({ minimum: 0 })),
	requests: arr(obj({ requestId: str(), requester: str(), replyTo: str(), origin: union([lit("operator"), lit("model")]), status: union([lit("admitting"), lit("queued"), lit("placed")]) })),
});
export type AgentProfile = Static<typeof AgentProfileSchema>;
export const ProfileUpdateSchema = obj({
	outcome: union([lit("applied"), lit("conflict")]), deduped: bool(), profile: AgentProfileSchema,
});
export const ProfileOutputSchema = union([AgentProfileSchema, ProfileUpdateSchema]);
