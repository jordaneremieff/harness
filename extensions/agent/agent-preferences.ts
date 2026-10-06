import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { join, resolve } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { getSupportedThinkingLevels, type Api, type Model } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { THINKING_LEVELS, configurationModel } from "./configuration.ts";

export const PREFERENCES_MAX_BYTES = 65536;
const name = Type.String({ minLength: 1, maxLength: 64, pattern: "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$" });
export const PresetParameter = Type.Optional({ ...name, description: "Named execution preset from the machine's agent-preferences.json. Explicit fields win; preferences inform selection without admission gates." });
const model = Type.String({ minLength: 3, maxLength: 512, pattern: "^[^/\\s]+/[^\\s]+$" });
const provider = Type.String({ minLength: 1, maxLength: 256, pattern: "^[^/\\s]+$" });
const thinking = Type.Union(THINKING_LEVELS.map((level) => Type.Literal(level)));
const presetSchema = Type.Object({
	model,
	thinkingLevel: Type.Optional(thinking),
	role: Type.Optional(Type.String({ maxLength: 2000 })),
	checkInMinutes: Type.Optional(Type.Number({ minimum: 0, maximum: 35791 })),
	notes: Type.Optional(Type.String({ maxLength: 2000 })),
}, { additionalProperties: false });
const preferenceSchema = Type.Object({
	excludedModels: Type.Optional(Type.Array(model, { maxItems: 64, uniqueItems: true })),
	excludedProviders: Type.Optional(Type.Array(provider, { maxItems: 64, uniqueItems: true })),
	contextBudgetTokens: Type.Optional(Type.Record(model, Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }), { maxProperties: 64, additionalProperties: false })),
	quotaSubstitutionOrder: Type.Optional(Type.Array(name, { maxItems: 64, uniqueItems: true })),
	reportingNotes: Type.Optional(Type.String({ maxLength: 4000 })),
}, { additionalProperties: false });
export const AgentPreferencesSchema = Type.Object({
	version: Type.Literal(1),
	presets: Type.Record(name, presetSchema, { maxProperties: 64, additionalProperties: false }),
	preferences: Type.Optional(preferenceSchema),
}, { additionalProperties: false });
export type AgentPreferences = Static<typeof AgentPreferencesSchema>;
export type PreferenceCatalog = {
	getModel(provider: string, modelId: string): Model<Api> | undefined;
	getModels?(): readonly Model<Api>[];
};
export type PreferenceDiagnostic = { field: string; message: string };
export type PreferenceSource = { path: string; digest: string | null; observedAt: string; status: "loaded" | "missing" | "unavailable" };
export type PreferenceSnapshot = { source: PreferenceSource; document?: AgentPreferences; diagnostics: PreferenceDiagnostic[] };
export type ExecutionFields = { model?: string; thinkingLevel?: string; role?: string; checkInMinutes?: number };
export type ExecutionOrigin = "explicit" | "preset" | "inherited" | "retained" | "default";
export type ExecutionSelection = {
	inputDigest: string;
	source: PreferenceSource;
	preset?: string;
	values: ExecutionFields;
	origins: Partial<Record<keyof ExecutionFields, ExecutionOrigin>>;
	unapplied: string[];
	diagnostics: PreferenceDiagnostic[];
	thinking?: { requested: string; effective: string };
};

const selectionSchema = Type.Object({
	inputDigest: Type.String({ pattern: "^[a-f0-9]{64}$" }),
	source: Type.Object({ path: Type.String({ maxLength: 4096 }), digest: Type.Union([Type.String({ pattern: "^[a-f0-9]{64}$" }), Type.Null()]), observedAt: Type.String({ maxLength: 64 }), status: Type.Union([Type.Literal("loaded"), Type.Literal("missing"), Type.Literal("unavailable")]) }, { additionalProperties: false }),
	preset: Type.Optional(name),
	values: Type.Object({ model: Type.Optional(model), thinkingLevel: Type.Optional(thinking), role: Type.Optional(Type.String({ maxLength: 2000 })), checkInMinutes: Type.Optional(Type.Number({ minimum: 0, maximum: 35791 })) }, { additionalProperties: false }),
	origins: Type.Object(Object.fromEntries(["model", "thinkingLevel", "role", "checkInMinutes"].map((field) => [field, Type.Optional(Type.Union([Type.Literal("explicit"), Type.Literal("preset"), Type.Literal("inherited"), Type.Literal("retained"), Type.Literal("default")]))])), { additionalProperties: false }),
	unapplied: Type.Array(Type.String({ maxLength: 32 }), { maxItems: 4 }),
	diagnostics: Type.Array(Type.Object({ field: Type.String({ maxLength: 600 }), message: Type.String({ maxLength: 1200 }) }, { additionalProperties: false }), { maxItems: 512 }),
	thinking: Type.Optional(Type.Object({ requested: Type.String({ maxLength: 16 }), effective: Type.String({ maxLength: 16 }) }, { additionalProperties: false })),
}, { additionalProperties: false });

export function parsePreferenceSnapshot(value: unknown): PreferenceSnapshot {
	if (!Value.Check(Type.Object({ source: selectionSchema.properties.source, document: Type.Optional(AgentPreferencesSchema), diagnostics: selectionSchema.properties.diagnostics }, { additionalProperties: false }), value)) throw new Error("Invalid machine preference snapshot");
	const snapshot = value as PreferenceSnapshot;
	if ((snapshot.source.status === "loaded") !== (snapshot.document !== undefined)) throw new Error("Machine preference snapshot status does not match its document");
	if (snapshot.document !== undefined) parseAgentPreferences(JSON.stringify(snapshot.document));
	return structuredClone(snapshot);
}

export function parseExecutionSelection(value: unknown): ExecutionSelection {
	if (!Value.Check(selectionSchema, value)) throw new Error("Invalid retained execution selection");
	return structuredClone(value) as ExecutionSelection;
}

/** This path is machine configuration, never cwd-based project discovery. */
export function agentPreferencesPath(agentDir = process.env.PI_AGENT_DIR ?? getAgentDir()): string {
	const override = process.env.PI_AGENT_PREFERENCES_FILE;
	return override === undefined ? join(agentDir, "agent-preferences.json") : resolve(agentDir, override);
}

function wellFormed(value: unknown): boolean {
	if (typeof value === "string") return !/[\u0000\ud800-\udfff]/u.test(value);
	if (Array.isArray(value)) return value.every(wellFormed);
	return value === null || typeof value !== "object" || Object.entries(value).every(([key, item]) => wellFormed(key) && wellFormed(item));
}

export function parseAgentPreferences(bytes: Uint8Array | string): AgentPreferences {
	if (Buffer.byteLength(bytes) > PREFERENCES_MAX_BYTES) throw new Error(`Document exceeds ${PREFERENCES_MAX_BYTES} UTF-8 bytes`);
	const text = typeof bytes === "string" ? bytes : new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	const value: unknown = JSON.parse(text);
	if (!Value.Check(AgentPreferencesSchema, value)) {
		const first = [...Value.Errors(AgentPreferencesSchema, value)][0];
		throw new Error(`Invalid machine preferences at ${first?.instancePath ?? "/"}: ${first?.message ?? "schema mismatch"}`);
	}
	if (!wellFormed(value)) throw new Error("Machine preferences contain malformed text or NUL");
	// Record key schemas describe patterns; enforce their length bounds explicitly.
	for (const key of Object.keys(value.presets)) if (!Value.Check(name, key)) throw new Error("Invalid preset name (1-64 lowercase slug characters)");
	for (const key of Object.keys(value.preferences?.contextBudgetTokens ?? {})) if (!Value.Check(model, key)) throw new Error("Invalid context budget model identity");
	return value;
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
			if (preferences?.excludedModels?.includes(preset.model) || preferences?.excludedProviders?.includes(providerId)) facts.push({ field, message: `Preset model matches an operator exclusion preference: ${preset.model}; this is not an admission gate.` });
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

/** A failed read is evidence, not a reason to retain stale prompt text. */
export function readAgentPreferences(agentDir?: string, catalog?: PreferenceCatalog): PreferenceSnapshot {
	const path = agentPreferencesPath(agentDir);
	const source: PreferenceSource = { path, digest: null, observedAt: new Date().toISOString(), status: "unavailable" };
	let fd: number | undefined;
	try {
		fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
		const stat = fstatSync(fd);
		if (!stat.isFile() || stat.size > PREFERENCES_MAX_BYTES) throw new Error(`Expected a regular file within ${PREFERENCES_MAX_BYTES} bytes`);
		const bytes = Buffer.alloc(PREFERENCES_MAX_BYTES + 1);
		let length = 0;
		while (length < bytes.length) {
			const count = readSync(fd, bytes, length, bytes.length - length, length);
			if (!count) break;
			length += count;
		}
		const content = bytes.subarray(0, length);
		source.digest = createHash("sha256").update(content).digest("hex");
		const document = parseAgentPreferences(content);
		source.status = "loaded";
		let diagnostics: PreferenceDiagnostic[];
		try { diagnostics = catalogDiagnostics(document, catalog); }
		catch (error) { diagnostics = [{ field: "catalog", message: `Local catalog checks are unavailable: ${error instanceof Error ? error.message.slice(0, 512) : "catalog read failed"}` }]; }
		return { source, document, diagnostics };
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { source: { ...source, status: "missing" }, diagnostics: [] };
		return { source: { ...source, status: "unavailable" }, diagnostics: [{ field: "file", message: error instanceof Error ? error.message.slice(0, 512) : "Machine preferences could not be read" }] };
	} finally { if (fd !== undefined) closeSync(fd); }
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

type ResolutionOptions = { inherited?: boolean; role?: boolean; checkIn?: boolean; reused?: boolean };
type ExecutionPreset = Static<typeof presetSchema>;

function selectedPreset(snapshot: PreferenceSnapshot, selector: string | undefined): ExecutionPreset | undefined {
	if (selector === undefined) return undefined;
	if (!Value.Check(name, selector)) throw new Error(`Invalid preset selector ${JSON.stringify(selector)} in ${snapshot.source.path}`);
	const preset = snapshot.document && Object.hasOwn(snapshot.document.presets, selector) ? snapshot.document.presets[selector] : undefined;
	if (!preset) throw new Error(`Cannot resolve preset ${JSON.stringify(selector)} in ${snapshot.source.path}: ${snapshot.diagnostics.find((fact) => fact.field === "file")?.message ?? (snapshot.source.status === "missing" ? "file is missing" : "preset is absent")}`);
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
	return options.inherited ? "inherited" : "retained";
}

function resolveField(result: ExecutionSelection, field: keyof ExecutionFields, input: ExecutionFields, preset: ExecutionPreset | undefined, defaults: ExecutionFields, options: ResolutionOptions): void {
	const proposed = input[field] ?? preset?.[field];
	const supported = supportsField(field, options);
	if (!supported && proposed !== undefined) { result.unapplied.push(field); result.origins[field] = input[field] !== undefined ? "explicit" : "preset"; }
	const retained: ExecutionFields = { model: defaults.model, thinkingLevel: defaults.thinkingLevel };
	const value = supported ? proposed ?? defaults[field] : retained[field];
	if (value === undefined) return;
	Object.assign(result.values, { [field]: value });
	result.origins[field] = fieldOrigin(field, input, preset, options);
}

/** Resolve only supported fields. Retained state is a default, never caller inheritance. */
export function resolveExecutionPreset(snapshot: PreferenceSnapshot, input: ExecutionFields & { preset?: string }, defaults: ExecutionFields, options: ResolutionOptions = {}): ExecutionSelection {
	const preset = selectedPreset(snapshot, input.preset);
	const result: ExecutionSelection = { inputDigest: executionInputDigest(input), source: { ...snapshot.source }, ...(input.preset === undefined ? {} : { preset: input.preset }), values: {}, origins: {}, unapplied: [], diagnostics: snapshot.diagnostics.map((fact) => ({ ...fact })) };
	for (const field of ["model", "thinkingLevel", "role", "checkInMinutes"] as const) resolveField(result, field, input, preset, defaults, options);
	if (result.values.model) {
		const excluded = snapshot.document?.preferences;
		const providerId = configurationModel(result.values.model).provider;
		if (excluded?.excludedModels?.includes(result.values.model) || excluded?.excludedProviders?.includes(providerId)) result.diagnostics.push({ field: "selection.model", message: `Selected model matches an operator exclusion preference: ${result.values.model}; selection remains explicit.` });
	}
	result.diagnostics = boundedDiagnostics(result.diagnostics);
	return result;
}

/** Add execution evidence without changing the requested snapshot. */
export function effectiveExecutionSelection(selection: ExecutionSelection, effective: string | undefined): ExecutionSelection {
	return { ...selection, ...(selection.values.thinkingLevel === undefined || effective === undefined ? {} : { thinking: { requested: selection.values.thinkingLevel, effective } }) };
}

/** Compact current facts, with explicit omitted coverage rather than silent clipping. */
export function renderAgentPreferences(snapshot: PreferenceSnapshot): string {
	if (snapshot.source.status === "missing") return `No machine preferences file is present at ${JSON.stringify(snapshot.source.path)}. Ordinary defaults apply.`;
	const lines = ["Machine delegation preferences (local catalog evidence).", `Source: ${JSON.stringify(snapshot.source.path)}; ${snapshot.source.status}; digest ${snapshot.source.digest ?? "none"}.`];
	if (snapshot.source.status === "unavailable") lines.push("Machine preferences are unavailable. Previous preference text is not current. Explicit preset selection fails until the file is repaired.");
	else lines.push(...preferenceLines(snapshot.document));
	for (const fact of snapshot.diagnostics) lines.push(`Diagnostic ${JSON.stringify(fact.field)}: ${JSON.stringify(fact.message)}`);
	return boundedLines(lines);
}

function preferenceLines(document: AgentPreferences | undefined): string[] {
	const lines = ["Explicit fields override execution presets; presets override creation inheritance. Exclusions and budgets inform choices, not admission. Context budgets are planning preferences, not enforced capacity. Quota substitution requires a deliberate choice, never automatic fallback."];
	const preferences = document?.preferences;
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
