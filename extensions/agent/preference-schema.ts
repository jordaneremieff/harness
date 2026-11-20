import { str, num, int, bool, lit, union, arr, opt, obj, type Schema, type Static } from "@earendil-works/pi-schema";
import { matchesSchema } from "./schema-check.ts";
import { THINKING_LEVELS } from "./configuration.ts";

export const name = str({
	title: "Name",
	description: "Use lowercase letters and digits, with hyphens between parts. Start with a letter.",
	minLength: 1,
	maxLength: 64,
	pattern: "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$",
});
const model = str({
	title: "Model",
	description: "Use the exact model identity in provider/model form.",
	format: "model",
	minLength: 3,
	maxLength: 512,
	pattern: "^[^/\\s]+/[^\\s]+$",
});
const provider = str({
	title: "Provider",
	description: "Use the exact provider identity.",
	format: "provider",
	minLength: 1,
	maxLength: 256,
	pattern: "^[^/\\s]+$",
});
const thinkingTitles = {
	off: "Off",
	minimal: "Minimal",
	low: "Low",
	medium: "Medium",
	high: "High",
	xhigh: "Extra high",
	max: "Max",
} satisfies Record<(typeof THINKING_LEVELS)[number], string>;
export const presetProperties = {
	model,
	thinkingLevel: opt(
		union(
			THINKING_LEVELS.map((level) => lit(level, { title: thinkingTitles[level] })),
			{
				title: "Thinking level",
				description: "Select the Pi thinking level for this preset.",
			},
		),
	),
	role: opt(
		str({
			title: "Role",
			description: "Set the role only when a new named agent is created.",
			maxLength: 2000,
		}),
	),
	checkInMinutes: opt(
		num({
			title: "Check-in interval in minutes",
			description: "Set the automatic owner check-in interval. Zero disables automatic check-ins.",
			minimum: 0,
			maximum: 35791,
		}),
	),
	notes: opt(
		str({
			title: "Notes",
			description: "Explain when to use this preset.",
			maxLength: 2000,
		}),
	),
};
export const presetSchema = obj(presetProperties, { title: "Preset" });
export const preferenceSchema = obj({
	defaultPreset: opt(
		str({
			...name,
			title: "Default preset",
			description:
				"Use this preset for new agent creation only when neither a model nor a preset is specified. There is no implicit default.",
		}),
	),
	enforceRoster: opt(
		bool({
			title: "Enforce roster",
			description:
				"When enabled, new agent creation refuses explicit models outside all presets and any selected excluded model or provider. This does not affect configuration or reuse.",
			default: false,
		}),
	),
	excludedModels: opt(
		arr(model, {
			title: "Excluded models",
			description: "List exact model identities that you prefer not to select.",
			maxItems: 64,
			uniqueItems: true,
		}),
	),
	excludedProviders: opt(
		arr(provider, {
			title: "Excluded providers",
			description: "List exact provider identities that you prefer not to select.",
			maxItems: 64,
			uniqueItems: true,
		}),
	),
	contextBudgetTokens: opt({
		type: "object",
		title: "Context budgets",
		description:
			"Set a planning budget in tokens for each exact model identity. These budgets do not limit context use.",
		propertyNames: model,
		additionalProperties: int({ title: "Budget in tokens", minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
		maxProperties: 64,
	} as Schema<Record<string, number>>),
	quotaSubstitutionOrder: opt(
		arr(str({ ...name, title: "Preset" }), {
			title: "Quota substitution order",
			description:
				"List presets in the order to consult after a quota error. This list does not cause automatic substitution.",
			maxItems: 64,
			uniqueItems: true,
		}),
	),
	reportingNotes: opt(
		str({
			title: "Reporting notes",
			description: "Give guidance for delegation and reports.",
			maxLength: 4000,
		}),
	),
});
export const presetsSchema: Schema<Record<string, Static<typeof presetSchema>>> = {
	type: "object",
	propertyNames: name,
	additionalProperties: presetSchema,
	maxProperties: 64,
};
export const AgentPreferencesSchema = obj({
	version: lit(1),
	presets: presetsSchema,
	preferences: opt(preferenceSchema),
});
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
	return matchesSchema(presetsSchema, value) && wellFormed(value);
}
export function validPreferences(value: unknown): value is DelegationPreferences {
	return matchesSchema(preferenceSchema, value) && wellFormed(value);
}
