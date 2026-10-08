import { createHash } from "node:crypto";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { getSupportedThinkingLevels, type Api, type Model } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { THINKING_LEVELS, configurationModel } from "./configuration.ts";

import { readSettings, type Environment, type Source } from "./settings.ts";
import { name, presetSchema, AgentPreferencesSchema, validPresets, validPreferences, type AgentPreferences, type ExecutionPreset } from "./preference-schema.ts";
export type { AgentPreferences } from "./preference-schema.ts";
export function presetParameter(snapshot: PreferenceSnapshot) {
	return Type.Optional({ ...name, description: `Delegate with a named execution preset. Omit model and preset for the machine default on creation. Explicit fields override the preset. ${presetInventory(snapshot)}` });
}
export const PresetParameter = Type.Optional({ ...name, description: "Delegate with a named execution preset. Omit model and preset for the machine default on creation; explicit fields override the preset." });
const model = presetSchema.properties.model;
const thinking = Type.Union(THINKING_LEVELS.map((level) => Type.Literal(level)));
export type PreferenceCatalog = {
	getModel(provider: string, modelId: string): Model<Api> | undefined;
	getModels?(): readonly Model<Api>[];
};
export type PreferenceDiagnostic = { field: string; message: string };
export type PreferenceSource = Source;
export type PreferenceSnapshot = { source: PreferenceSource; document?: AgentPreferences; diagnostics: PreferenceDiagnostic[] };
export type ExecutionFields = { model?: string; thinkingLevel?: string; role?: string; checkInMinutes?: number };
export type ExecutionOrigin = "explicit" | "preset" | "defaultPreset" | "retained" | "default";
export type ExecutionSelection = {
	inputDigest: string;
	source: PreferenceSource;
	preset?: string;
	presetNames: string[];
	values: ExecutionFields;
	origins: Partial<Record<keyof ExecutionFields, ExecutionOrigin>>;
	unapplied: string[];
	diagnostics: PreferenceDiagnostic[];
	thinking?: { requested: string; effective: string };
};

const selectionSchema = Type.Object({
	inputDigest: Type.String({ pattern: "^[a-f0-9]{64}$" }),
	source: Type.Object({ path: Type.String({ maxLength: 4096 }), digest: Type.Union([Type.String({ pattern: "^[a-f0-9]{64}$" }), Type.Null()]), observedAt: Type.String({ maxLength: 64 }), status: Type.Union([Type.Literal("loaded"), Type.Literal("missing"), Type.Literal("invalid"), Type.Literal("unavailable")]) }, { additionalProperties: false }),
	preset: Type.Optional(name),
	presetNames: Type.Array(name, { maxItems: 64, uniqueItems: true }),
	values: Type.Object({ model: Type.Optional(model), thinkingLevel: Type.Optional(thinking), role: Type.Optional(Type.String({ maxLength: 2000 })), checkInMinutes: Type.Optional(Type.Number({ minimum: 0, maximum: 35791 })) }, { additionalProperties: false }),
	origins: Type.Object(Object.fromEntries(["model", "thinkingLevel", "role", "checkInMinutes"].map((field) => [field, Type.Optional(Type.Union([Type.Literal("explicit"), Type.Literal("preset"), Type.Literal("defaultPreset"), Type.Literal("retained"), Type.Literal("default")]))])), { additionalProperties: false }),
	unapplied: Type.Array(Type.String({ maxLength: 32 }), { maxItems: 4 }),
	diagnostics: Type.Array(Type.Object({ field: Type.String({ maxLength: 600 }), message: Type.String({ maxLength: 1200 }) }, { additionalProperties: false }), { maxItems: 512 }),
	thinking: Type.Optional(Type.Object({ requested: Type.String({ maxLength: 16 }), effective: Type.String({ maxLength: 16 }) }, { additionalProperties: false })),
}, { additionalProperties: false });

export function parsePreferenceSnapshot(value: unknown): PreferenceSnapshot {
	if (!Value.Check(Type.Object({ source: selectionSchema.properties.source, document: Type.Optional(AgentPreferencesSchema), diagnostics: selectionSchema.properties.diagnostics }, { additionalProperties: false }), value)) throw new Error("Invalid machine preference snapshot");
	const snapshot = value as PreferenceSnapshot;
	if (snapshot.document === undefined) throw new Error("Machine preference snapshot has no effective settings");
	if (!validPresets(snapshot.document.presets) || !validPreferences(snapshot.document.preferences ?? {})) throw new Error("Invalid effective delegation settings");
	return structuredClone(snapshot);
}

export function parseExecutionSelection(value: unknown): ExecutionSelection {
	if (!Value.Check(selectionSchema, value)) throw new Error("Invalid retained execution selection");
	return structuredClone(value) as ExecutionSelection;
}

function catalogDiagnostics(document: AgentPreferences, catalog: PreferenceCatalog | undefined): PreferenceDiagnostic[] {
	if (!catalog) return [{ field: "catalog", message: "Local model catalog is unavailable; model and provider checks are unknown." }];
	const facts: PreferenceDiagnostic[] = [];
	const preferences = document.preferences;
	const lookup = (identity: string, field: string) => {
		const { provider, modelId } = configurationModel(identity);
		const found = catalog.getModel(provider, modelId);
		if (!found) facts.push({ field, message: `Unknown model in the local catalog: ${identity}` });
		return found;
	};
	const checkPresets = () => {
		for (const [key, preset] of Object.entries(document.presets)) {
			const field = `presets.${key}`;
			const found = lookup(preset.model, `${field}.model`);
			if (found && preset.thinkingLevel !== undefined && !getSupportedThinkingLevels(found).includes(preset.thinkingLevel)) facts.push({ field: `${field}.thinkingLevel`, message: `Unsupported thinking level ${preset.thinkingLevel} for ${preset.model}` });
			const providerId = configurationModel(preset.model).provider;
			if (preferences?.excludedModels?.includes(preset.model) || preferences?.excludedProviders?.includes(providerId)) facts.push({ field, message: `Preset model matches an operator exclusion preference: ${preset.model}; ${preferences?.enforceRoster ? "creation enforcement rejects it" : "this is advisory, not an admission gate"}.` });
		}
	};
	const checkExclusions = () => {
		for (const identity of preferences?.excludedModels ?? []) lookup(identity, "preferences.excludedModels");
		const models = catalog.getModels?.();
		for (const providerId of preferences?.excludedProviders ?? []) {
			if (!models) facts.push({ field: "preferences.excludedProviders", message: `Provider catalog coverage is unknown: ${providerId}` });
			else if (!models.some((entry) => entry.provider === providerId)) facts.push({ field: "preferences.excludedProviders", message: `Unknown provider in the local model catalog: ${providerId}` });
		}
	};
	const checkPlanning = () => {
		for (const [identity, budget] of Object.entries(preferences?.contextBudgetTokens ?? {})) {
			const found = lookup(identity, `preferences.contextBudgetTokens.${identity}`);
			if (found && budget > found.contextWindow) facts.push({ field: `preferences.contextBudgetTokens.${identity}`, message: `Planning budget ${budget} exceeds catalog capacity ${found.contextWindow}` });
		}
		for (const key of preferences?.quotaSubstitutionOrder ?? []) if (!Object.hasOwn(document.presets, key)) facts.push({ field: "preferences.quotaSubstitutionOrder", message: `Unknown preset: ${key}` });
	};
	checkPresets(); checkExclusions(); checkPlanning();
	return facts;
}

/** Read effective delegation settings; file status never substitutes for field validation. */
export function readAgentPreferences(agentDir = process.env.PI_AGENT_DIR ?? getAgentDir(), catalog?: PreferenceCatalog, env?: Environment): PreferenceSnapshot {
	const snapshot = readSettings({ agentDir, env });
	const document: AgentPreferences = { version: 1, presets: snapshot.values.presets, preferences: snapshot.values.preferences };
	const diagnostics: PreferenceDiagnostic[] = snapshot.diagnostics.map((fact) => ({ field: fact.field, message: `${fact.source}: ${fact.message}` }));
	try { diagnostics.push(...catalogDiagnostics(document, catalog)); }
	catch { diagnostics.push({ field: "catalog", message: "Local catalog checks are unavailable." }); }
	return { source: snapshot.source, document, diagnostics };
}

function boundedDiagnostics(facts: PreferenceDiagnostic[]): PreferenceDiagnostic[] {
	const kept: PreferenceDiagnostic[] = [];
	let size = 0;
	for (const fact of facts) {
		const length = JSON.stringify(fact).length;
		if (size + length > 4000) break;
		kept.push({ ...fact }); size += length;
	}
	if (kept.length < facts.length) kept.push({ field: "coverage", message: `${facts.length - kept.length} diagnostic facts omitted; read current machine preference guidance for bounded catalog evidence.` });
	return kept;
}

export function executionInputDigest(input: ExecutionFields & { preset?: string }): string {
	return createHash("sha256").update(JSON.stringify([input.preset, input.model, input.thinkingLevel, input.role, input.checkInMinutes])).digest("hex");
}

type ResolutionOptions = { creation?: boolean; role?: boolean; checkIn?: boolean; reused?: boolean };

export function presetNames(snapshot: PreferenceSnapshot): string[] {
	return Object.keys(snapshot.document?.presets ?? {}).sort();
}

export function presetInventory(snapshot: PreferenceSnapshot): string {
	return `Presets: ${JSON.stringify(presetNames(snapshot))}; digest ${snapshot.source.digest ?? "none"}; file ${JSON.stringify(snapshot.source.path)} (${snapshot.source.status}).`;
}

function selectedPreset(snapshot: PreferenceSnapshot, selector: string | undefined): ExecutionPreset | undefined {
	if (selector === undefined) return undefined;
	if (!Value.Check(name, selector)) throw new Error(`Invalid preset selector ${JSON.stringify(selector)}. ${presetInventory(snapshot)}`);
	const preset = snapshot.document && Object.hasOwn(snapshot.document.presets, selector) ? snapshot.document.presets[selector] : undefined;
	if (!preset) throw new Error(`Cannot resolve preset ${JSON.stringify(selector)} in ${snapshot.source.path}: ${snapshot.diagnostics.find((fact) => fact.field === "document" || fact.field.startsWith("agent."))?.message ?? (snapshot.source.status === "missing" ? "file is missing" : "preset is absent")}. ${presetInventory(snapshot)}`);
	return preset;
}

function supportsField(field: keyof ExecutionFields, options: ResolutionOptions): boolean {
	if (field === "role") return !!options.role && !options.reused;
	if (field === "checkInMinutes") return !!options.checkIn;
	return !options.reused;
}

function fieldOrigin(field: keyof ExecutionFields, input: ExecutionFields, preset: ExecutionPreset | undefined, options: ResolutionOptions): ExecutionOrigin {
	if (!supportsField(field, options)) return "retained";
	if (input[field] !== undefined) return "explicit";
	if (preset?.[field] !== undefined) return "preset";
	if (field === "checkInMinutes") return "default";
	return options.creation && !options.reused ? "default" : "retained";
}

function resolveField(result: ExecutionSelection, field: keyof ExecutionFields, input: ExecutionFields, preset: ExecutionPreset | undefined, defaults: ExecutionFields, options: ResolutionOptions): void {
	const proposed = input[field] ?? preset?.[field];
	const supported = supportsField(field, options);
	if (!supported && proposed !== undefined) { result.unapplied.push(field); result.origins[field] = input[field] !== undefined ? "explicit" : "preset"; }
	const retained: ExecutionFields = { model: defaults.model, thinkingLevel: defaults.thinkingLevel };
	const fallback = options.creation && !options.reused ? (field === "thinkingLevel" ? "off" : undefined) : defaults[field];
	const value = supported ? proposed ?? fallback : retained[field];
	if (value === undefined) return;
	Object.assign(result.values, { [field]: value });
	result.origins[field] = fieldOrigin(field, input, preset, options);
}

function creationSelection(options: ResolutionOptions): boolean {
	return !!options.creation && !options.reused;
}

function presetSelector(snapshot: PreferenceSnapshot, input: ExecutionFields & { preset?: string }, options: ResolutionOptions): { selector?: string; useDefault: boolean } {
	const useDefault = creationSelection(options) && input.model === undefined && input.preset === undefined;
	const selector = input.preset ?? (useDefault ? snapshot.document?.preferences?.defaultPreset : undefined);
	if (useDefault && selector === undefined) throw new Error(`Creation requires model, preset, or preferences.defaultPreset in ${snapshot.source.path}. ${presetInventory(snapshot)} ${snapshot.diagnostics.find((fact) => fact.field === "file")?.message ?? "No defaultPreset is configured."}`);
	return { selector, useDefault };
}

function enforceCreationRoster(snapshot: PreferenceSnapshot, input: ExecutionFields, identity: string, outside: boolean, excluded: boolean, options: ResolutionOptions): void {
	if (!creationSelection(options) || !snapshot.document?.preferences?.enforceRoster) return;
	if (excluded || (input.model !== undefined && outside)) throw new Error(`Creation refused by preferences.enforceRoster: ${identity} ${excluded ? "matches an operator exclusion" : "matches no preset"}. ${presetInventory(snapshot)}`);
}

function modelSelectionDiagnostics(snapshot: PreferenceSnapshot, input: ExecutionFields, result: ExecutionSelection, options: ResolutionOptions): PreferenceDiagnostic[] {
	const identity = result.values.model;
	if (identity === undefined) return [];
	const preferences = snapshot.document?.preferences;
	const providerId = configurationModel(identity).provider;
	const excluded = !!(preferences?.excludedModels?.includes(identity) || preferences?.excludedProviders?.includes(providerId));
	const outside = !Object.values(snapshot.document?.presets ?? {}).some((entry) => entry.model === identity);
	enforceCreationRoster(snapshot, input, identity, outside, excluded, options);
	const facts: PreferenceDiagnostic[] = [];
	if (!options.reused && input.model !== undefined) facts.push({ field: "selection.model", message: `Explicit model override: ${input.model}; ${outside ? "matches no preset" : "matches a preset model"}.` });
	if (excluded) facts.push({ field: "selection.model", message: `Selected model matches an operator exclusion preference: ${identity}; advisory only.` });
	return facts;
}

/** Resolve only supported fields. Retained state is a default, never caller inheritance. */
export function resolveExecutionPreset(snapshot: PreferenceSnapshot, input: ExecutionFields & { preset?: string }, defaults: ExecutionFields, options: ResolutionOptions = {}): ExecutionSelection {
	const { selector, useDefault } = presetSelector(snapshot, input, options);
	const preset = selectedPreset(snapshot, selector);
	const result: ExecutionSelection = { inputDigest: executionInputDigest(input), source: { ...snapshot.source }, ...(selector === undefined ? {} : { preset: selector }), presetNames: presetNames(snapshot), values: {}, origins: {}, unapplied: [], diagnostics: [] };
	for (const field of ["model", "thinkingLevel", "role", "checkInMinutes"] as const) {
		resolveField(result, field, input, preset, defaults, options);
		if (useDefault && result.origins[field] === "preset") result.origins[field] = "defaultPreset";
	}
	result.diagnostics = boundedDiagnostics([...modelSelectionDiagnostics(snapshot, input, result, options), ...snapshot.diagnostics.map((fact) => ({ ...fact }))]);
	return result;
}

/** Add execution evidence without changing the requested snapshot. */
export function effectiveExecutionSelection(selection: ExecutionSelection, effective: string | undefined): ExecutionSelection {
	return { ...selection, ...(selection.values.thinkingLevel === undefined || effective === undefined ? {} : { thinking: { requested: selection.values.thinkingLevel, effective } }) };
}

/** Operator view omits planning prose but preserves every preset name and model. */
export function renderPreferenceStatus(snapshot: PreferenceSnapshot): string[] {
	return [
		`Preferences: ${snapshot.source.status === "missing" ? "absent" : snapshot.source.status}; default preset: ${snapshot.document?.preferences?.defaultPreset ?? "none"}`,
		`File: ${snapshot.source.path}`,
		`Digest: ${snapshot.source.digest ?? "none"}`,
		...snapshot.diagnostics.filter((fact) => fact.field !== "catalog").map((fact) => `Diagnostic ${fact.field}: ${fact.message}`),
		`Roster enforcement: ${snapshot.document?.preferences?.enforceRoster ?? false}`,
		...presetNames(snapshot).map((key) => `Preset ${key}: ${snapshot.document?.presets[key].model}`),
		...(presetNames(snapshot).length ? [] : ["Presets: none"]),
	];
}

/** Compact current facts, with explicit omitted coverage rather than silent clipping. */
export function renderAgentPreferences(snapshot: PreferenceSnapshot): string {
	const lines = ["Operator machine configuration for agent delegation. Catalog check results are local evidence.", `Source: ${JSON.stringify(snapshot.source.path)}; ${snapshot.source.status}; digest ${snapshot.source.digest ?? "none"}.`];
	if (snapshot.source.status === "unavailable" || snapshot.source.status === "invalid") lines.push(`Machine document is ${snapshot.source.status}. Previous preference text is not current. Invalid fields use safe defaults; valid environment settings remain available.`);
	lines.push(...preferenceLines(snapshot.document));
	for (const fact of snapshot.diagnostics) lines.push(`Diagnostic ${JSON.stringify(fact.field)}: ${JSON.stringify(fact.message)}`);
	return boundedLines(lines);
}

function preferenceLines(document: AgentPreferences | undefined): string[] {
	const lines = ["Delegate with preset; omit model and preset to use preferences.defaultPreset on creation. Name model only when a direction or task requires an override; receipts record it. Explicit fields override preset fields. Creation never inherits parent execution settings. Configure retains target values. Exclusions are advisory unless preferences.enforceRoster is true for creation. Context budgets are planning preferences, not enforced capacity. Quota substitution requires a deliberate choice, never automatic fallback."];
	const preferences = document?.preferences;
	lines.push(`Default preset: ${preferences?.defaultPreset ?? "none"}; enforceRoster: ${preferences?.enforceRoster ?? false}.`);
	for (const value of preferences?.excludedModels ?? []) lines.push(`Excluded model preference: ${JSON.stringify(value)}`);
	for (const value of preferences?.excludedProviders ?? []) lines.push(`Excluded provider preference: ${JSON.stringify(value)}`);
	for (const [key, value] of Object.entries(preferences?.contextBudgetTokens ?? {})) lines.push(`Planning context budget: ${JSON.stringify(key)} ${value} tokens`);
	if (preferences?.quotaSubstitutionOrder) lines.push(`Quota substitution order: ${JSON.stringify(preferences.quotaSubstitutionOrder)}`);
	if (preferences?.reportingNotes !== undefined) lines.push(`Reporting notes: ${JSON.stringify(preferences.reportingNotes)}`);
	for (const [key, value] of Object.entries(document?.presets ?? {})) {
		const { role: _role, ...settings } = value;
		lines.push(`Preset ${JSON.stringify(key)}: ${JSON.stringify(settings)}`);
	}
	return lines;
}

function boundedLines(lines: string[]): string {
	const output: string[] = [];
	let size = 0;
	for (const line of lines) {
		if (size + line.length > 12000) break;
		output.push(line); size += line.length + 1;
	}
	if (output.length < lines.length) output.push(`Omitted ${lines.length - output.length} lines; read the machine file for full definitions. Dispatch rechecks the selected values.`);
	return output.join("\n");
}
