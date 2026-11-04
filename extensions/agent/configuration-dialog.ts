import { stripVTControlCharacters } from "node:util";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentConversationSummary } from "./dashboard-types.ts";
import { agentDisplayName } from "./action-outcome.ts";
import { THINKING_LEVELS, validateConfigurationPatch, type ConfigurationPatch } from "./configuration.ts";
import { ordinaryDialogs, type AgentDialogs, type DialogChoice } from "./dialog-adapter.ts";

/** One selectable model: the exact `provider/model` identity and an optional human name. */
export interface ModelOption { identity: string; name?: string }
/** The host's own model list for this form. A read failure surfaces as the form's error notice. */
export type ModelSource = () => Promise<readonly ModelOption[]>;

function display(value: string): string {
	return stripVTControlCharacters(value)
		.replace(/[\p{Cc}\p{Cf}]/gu, " ")
		.slice(0, 256);
}
function values(snapshot: AgentConversationSummary, patch: ConfigurationPatch) {
	return {
		name: display(patch.name ?? snapshot.name ?? "(unnamed)"),
		model: display(
			patch.model ?? (snapshot.model ? `${snapshot.model.provider}/${snapshot.model.modelId}` : "(unavailable)"),
		),
		level: patch.thinkingLevel ?? snapshot.model?.thinkingLevel ?? "(unavailable)",
	};
}
function modelChoices(options: readonly ModelOption[]): DialogChoice[] {
	return options.map((option) => ({ value: option.identity, label: option.name && option.name !== option.identity ? `${option.identity} · ${display(option.name)}` : option.identity }));
}
async function matchingModels(models: ModelSource, query: string): Promise<ModelOption[]> {
	const terms = query.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
	return (await models())
		.filter((option) => terms.every((term) => option.identity.toLocaleLowerCase().includes(term)))
		.sort((a, b) => a.identity.localeCompare(b.identity));
}
/** A host without a filtering list asks for search words first; a filtering list takes them while choosing. */
async function askQuery(dialogs: AgentDialogs, query: string): Promise<string | undefined> {
	const hint = query ? `Saved: ${query} (blank keeps it)` : "Model name or provider; blank shows all";
	const input = await dialogs.input(`Find an available model\n${hint}`, { initial: query, placeholder: hint });
	return input === undefined ? undefined : input.trim() ? input : query;
}
async function modelPatch(shown: ReturnType<typeof values>, dialogs: AgentDialogs, models: ModelSource): Promise<ConfigurationPatch> {
	let query = "";
	for (;;) {
		if (!dialogs.filtersChoices) {
			const asked = await askQuery(dialogs, query);
			if (asked === undefined) return {};
			query = asked;
		}
		const available = await matchingModels(models, query);
		if (!available.length) throw new Error(dialogs.filtersChoices ? "No available models were reported" : "No available model matches that search");
		const model = await dialogs.select("Model (exact provider/model)", modelChoices(available), shown.model);
		if (model !== undefined) return validateConfigurationPatch({ model });
		if (dialogs.filtersChoices) return {};
	}
}
async function fieldPatch(choice: string, shown: ReturnType<typeof values>, dialogs: AgentDialogs, models: ModelSource): Promise<ConfigurationPatch> {
	if (choice === "reasoning") {
		const value = await dialogs.select(
			"Reasoning level (Pi clamps it to the selected model)",
			THINKING_LEVELS.map((level) => ({ value: level, label: level })),
			shown.level,
		);
		return value === undefined ? {} : validateConfigurationPatch({ thinkingLevel: value });
	}
	if (choice === "model") return modelPatch(shown, dialogs, models);
	if (choice !== "name") return {};
	const value = await dialogs.input(`Session name (blank clears)\nCurrent: ${shown.name}`, { initial: shown.name === "(unnamed)" ? "" : shown.name, placeholder: shown.name });
	return value === undefined ? {} : validateConfigurationPatch({ name: value });
}

const FIELDS: readonly DialogChoice[] = [
	{ value: "name", label: "Name" }, { value: "model", label: "Model" }, { value: "reasoning", label: "Reasoning" },
	{ value: "apply", label: "Apply" }, { value: "cancel", label: "Cancel" },
];

/** Dialog edits stay local until Apply. The owner validates the current state at admission. */
export async function configurationForm(
	snapshot: AgentConversationSummary,
	dialogs: AgentDialogs,
	models: ModelSource,
	initial: ConfigurationPatch = {},
): Promise<ConfigurationPatch | undefined> {
	let patch: ConfigurationPatch = { ...initial };
	for (;;) {
		const shown = values(snapshot, patch);
		const label = display(agentDisplayName(snapshot));
		const choice = await dialogs.select(
			`Configure “${label}”\nName: ${shown.name} · Model: ${shown.model} · Reasoning: ${shown.level}`,
			FIELDS,
		);
		if (choice === undefined || choice === "cancel") return undefined;
		try {
			if (choice === "apply") return validateConfigurationPatch(patch);
			patch = { ...patch, ...(await fieldPatch(choice, shown, dialogs, models)) };
		} catch (error) {
			dialogs.notify(error instanceof Error ? error.message : "Invalid configuration", "error");
		}
	}
}

/** A refused write returns to the same staged fields; only Apply invokes the owner. */
export async function configurationFormWithApply<T>(
	snapshot: AgentConversationSummary,
	dialogs: AgentDialogs,
	models: ModelSource,
	apply: (patch: ConfigurationPatch) => Promise<T>,
): Promise<T | undefined> {
	let staged: ConfigurationPatch = {};
	for (;;) {
		const patch = await configurationForm(snapshot, dialogs, models, staged);
		if (!patch) return undefined;
		staged = patch;
		try {
			return await apply(patch);
		} catch (error) {
			dialogs.notify(error instanceof Error ? error.message : "Configuration failed", "error");
		}
	}
}

const ordinaryModels = (ctx: ExtensionContext): ModelSource => async () => ctx.modelRegistry.getAvailable().map((model) => ({ identity: `${model.provider}/${model.id}` }));

export function configurationDialog(snapshot: AgentConversationSummary, ctx: ExtensionContext, initial: ConfigurationPatch = {}): Promise<ConfigurationPatch | undefined> {
	return configurationForm(snapshot, ordinaryDialogs(ctx), ordinaryModels(ctx), initial);
}
export function configurationWithApply<T>(snapshot: AgentConversationSummary, ctx: ExtensionContext, apply: (patch: ConfigurationPatch) => Promise<T>): Promise<T | undefined> {
	return configurationFormWithApply(snapshot, ordinaryDialogs(ctx), ordinaryModels(ctx), apply);
}
