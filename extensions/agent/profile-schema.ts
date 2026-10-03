import { Type, type Static } from "typebox";
import { HANDLE_PATTERN } from "./identity.ts";

const nullableText = Type.Union([Type.String(), Type.Null()]);
const nullableTime = Type.Union([Type.Number(), Type.Null()]);
export const ProfileParams = Type.Object({
	sessionId: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
	action: Type.Union([Type.Literal("read"), Type.Literal("update")]),
	expectedRevision: Type.Optional(Type.String({ pattern: "^[a-f0-9]{64}$" })),
	role: Type.Optional(Type.String({ maxLength: 2000 })),
	expertise: Type.Optional(Type.String({ maxLength: 16384 })),
}, { additionalProperties: false });
export const HandleSchema = Type.String({ pattern: HANDLE_PATTERN, maxLength: 64 });
export const ProfileHintSchema = Type.Object({
	identity: Type.String(), handle: nullableText, role: Type.String(), revision: Type.String(), hasExpertise: Type.Boolean(), updatedAt: nullableTime,
}, { additionalProperties: false });
export const ProfileHintsSchema = Type.Object({
	rows: Type.Array(ProfileHintSchema), coverage: Type.Object({ complete: Type.Boolean(), omitted: Type.Integer({ minimum: 0 }) }, { additionalProperties: false }),
}, { additionalProperties: false });
export type ProfileHint = Static<typeof ProfileHintSchema>;
export type ProfileHints = Static<typeof ProfileHintsSchema>;
export const AgentProfileSchema = Type.Object({
	identity: Type.String(), handle: nullableText, name: nullableText, role: Type.String(), expertise: Type.String(), revision: Type.String(),
	updatedAt: nullableTime, updatedBy: nullableText, creator: nullableText,
	model: Type.Union([Type.Object({ provider: Type.String(), modelId: Type.String() }, { additionalProperties: false }), Type.Null()]),
	thinkingLevel: nullableText, cwd: nullableText, live: Type.Boolean(),
	requests: Type.Array(Type.Object({ requestId: Type.String(), requester: Type.String(), replyTo: Type.String(), origin: Type.Union([Type.Literal("operator"), Type.Literal("model")]), status: Type.Union([Type.Literal("admitting"), Type.Literal("queued"), Type.Literal("placed")]) }, { additionalProperties: false })),
}, { additionalProperties: false });
export type AgentProfile = Static<typeof AgentProfileSchema>;
export const ProfileUpdateSchema = Type.Object({
	outcome: Type.Union([Type.Literal("applied"), Type.Literal("conflict")]), deduped: Type.Boolean(), profile: AgentProfileSchema,
}, { additionalProperties: false });
export const ProfileOutputSchema = Type.Union([AgentProfileSchema, ProfileUpdateSchema]);
