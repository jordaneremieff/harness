import { str, num, int, bool, lit, union, arr, opt, obj, type Schema, type Static } from "@earendil-works/pi-schema";
import { matchesSchema } from "./schema-check.ts";
import { THINKING_LEVELS } from "./configuration.ts";

export const name = str({ minLength: 1, maxLength: 64, pattern: "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$" });
const model = str({ minLength: 3, maxLength: 512, pattern: "^[^/\\s]+/[^\\s]+$" });
const provider = str({ minLength: 1, maxLength: 256, pattern: "^[^/\\s]+$" });
const thinking = union(THINKING_LEVELS.map((level) => lit(level)));
export const presetProperties = {
		model,
		thinkingLevel: opt(thinking),
		role: opt(str({ maxLength: 2000 })),
		checkInMinutes: opt(num({ minimum: 0, maximum: 35791 })),
		notes: opt(str({ maxLength: 2000 })),
	};
export const presetSchema = obj(presetProperties);
export const preferenceSchema = obj(
	{
		defaultPreset: opt(name),
		enforceRoster: opt(bool()),
		excludedModels: opt(arr(model, { maxItems: 64, uniqueItems: true })),
		excludedProviders: opt(arr(provider, { maxItems: 64, uniqueItems: true })),
		contextBudgetTokens: opt(
			{ type: "object", patternProperties: { [model.pattern as string]: int({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }) }, maxProperties: 64, additionalProperties: false } as Schema<Record<string, number>>,
		),
		quotaSubstitutionOrder: opt(arr(name, { maxItems: 64, uniqueItems: true })),
		reportingNotes: opt(str({ maxLength: 4000 })),
	},
);
const presetsSchema: Schema<Record<string, Static<typeof presetSchema>>> = {
	type: "object", patternProperties: { [name.pattern as string]: presetSchema }, maxProperties: 64, additionalProperties: false,
};
export const AgentPreferencesSchema = obj(
	{
		version: lit(1),
		presets: presetsSchema,
		preferences: opt(preferenceSchema),
	},
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
		matchesSchema(presetsSchema, value) &&
		wellFormed(value) &&
		Object.keys(value).every((key) => matchesSchema(name, key))
	);
}
export function validPreferences(value: unknown): value is DelegationPreferences {
	return (
		matchesSchema(preferenceSchema, value) &&
		wellFormed(value) &&
		Object.keys((value as DelegationPreferences).contextBudgetTokens ?? {}).every((key) => matchesSchema(model, key))
	);
}
