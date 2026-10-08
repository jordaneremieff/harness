import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { THINKING_LEVELS } from "./configuration.ts";

export const name = Type.String({ minLength: 1, maxLength: 64, pattern: "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$" });
const model = Type.String({ minLength: 3, maxLength: 512, pattern: "^[^/\\s]+/[^\\s]+$" });
const provider = Type.String({ minLength: 1, maxLength: 256, pattern: "^[^/\\s]+$" });
const thinking = Type.Union(THINKING_LEVELS.map((level) => Type.Literal(level)));
export const presetSchema = Type.Object(
	{
		model,
		thinkingLevel: Type.Optional(thinking),
		role: Type.Optional(Type.String({ maxLength: 2000 })),
		checkInMinutes: Type.Optional(Type.Number({ minimum: 0, maximum: 35791 })),
		notes: Type.Optional(Type.String({ maxLength: 2000 })),
	},
	{ additionalProperties: false },
);
export const preferenceSchema = Type.Object(
	{
		defaultPreset: Type.Optional(name),
		enforceRoster: Type.Optional(Type.Boolean()),
		excludedModels: Type.Optional(Type.Array(model, { maxItems: 64, uniqueItems: true })),
		excludedProviders: Type.Optional(Type.Array(provider, { maxItems: 64, uniqueItems: true })),
		contextBudgetTokens: Type.Optional(
			Type.Record(model, Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }), {
				maxProperties: 64,
				additionalProperties: false,
			}),
		),
		quotaSubstitutionOrder: Type.Optional(Type.Array(name, { maxItems: 64, uniqueItems: true })),
		reportingNotes: Type.Optional(Type.String({ maxLength: 4000 })),
	},
	{ additionalProperties: false },
);
export const AgentPreferencesSchema = Type.Object(
	{
		version: Type.Literal(1),
		presets: Type.Record(name, presetSchema, { maxProperties: 64, additionalProperties: false }),
		preferences: Type.Optional(preferenceSchema),
	},
	{ additionalProperties: false },
);
export type AgentPreferences = Static<typeof AgentPreferencesSchema>;

function wellFormed(value: unknown): boolean {
	if (typeof value === "string") return !/[\u0000\ud800-\udfff]/u.test(value);
	if (Array.isArray(value)) return value.every(wellFormed);
	return (
		value === null ||
		typeof value !== "object" ||
		Object.entries(value).every(([key, item]) => wellFormed(key) && wellFormed(item))
	);
}

export type ExecutionPreset = Static<typeof presetSchema>;
export type DelegationPreferences = Static<typeof preferenceSchema>;
export type ExecutionPresets = AgentPreferences["presets"];
export function validPresets(value: unknown): value is ExecutionPresets {
	return (
		Value.Check(AgentPreferencesSchema.properties.presets, value) &&
		wellFormed(value) &&
		Object.keys(value).every((key) => Value.Check(name, key))
	);
}
export function validPreferences(value: unknown): value is DelegationPreferences {
	return (
		Value.Check(preferenceSchema, value) &&
		wellFormed(value) &&
		Object.keys((value as DelegationPreferences).contextBudgetTokens ?? {}).every((key) => Value.Check(model, key))
	);
}
