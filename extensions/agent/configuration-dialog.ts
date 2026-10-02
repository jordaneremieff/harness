import { stripVTControlCharacters } from "node:util";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentConversationSummary } from "./dashboard-types.ts";
import { agentDisplayName } from "./action-outcome.ts";
import { THINKING_LEVELS, validateConfigurationPatch, type ConfigurationPatch } from "./configuration.ts";

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
function preferredChoices(value: string, choices: readonly string[]): string[] {
	return choices.includes(value) ? [value, ...choices.filter((choice) => choice !== value)] : [...choices];
}
async function modelPatch(shown: ReturnType<typeof values>, ctx: ExtensionContext): Promise<ConfigurationPatch> {
	let query = "";
	for (;;) {
		const hint = query ? `Saved: ${query} (blank keeps it)` : "Model name or provider; blank shows all";
		const input = await ctx.ui.input(`Find an available model\n${hint}`, hint);
		if (input === undefined) return {};
		if (input.trim()) query = input;
		const terms = query.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
		const models = ctx.modelRegistry
			.getAvailable()
			.map((model) => `${model.provider}/${model.id}`)
			.filter((identity) => terms.every((term) => identity.toLocaleLowerCase().includes(term)))
			.sort();
		if (!models.length) throw new Error("No available model matches that search");
		const model = await ctx.ui.select("Model (exact provider/model)", preferredChoices(shown.model, models));
		if (model !== undefined) return validateConfigurationPatch({ model });
	}
}
async function fieldPatch(
	choice: string,
	shown: ReturnType<typeof values>,
	ctx: ExtensionContext,
): Promise<ConfigurationPatch> {
	if (choice === "Reasoning") {
		const value = await ctx.ui.select(
			"Reasoning level (Pi clamps it to the selected model)",
			preferredChoices(shown.level, THINKING_LEVELS),
		);
		return value === undefined ? {} : validateConfigurationPatch({ thinkingLevel: value });
	}
	if (choice === "Model") return modelPatch(shown, ctx);
	if (choice !== "Name") return {};
	const value = await ctx.ui.input(`Session name (blank clears)\nCurrent: ${shown.name}`, shown.name);
	return value === undefined ? {} : validateConfigurationPatch({ name: value });
}

/** Dialog edits stay local until Apply. The owner validates the current state at admission. */
export async function configurationDialog(
	snapshot: AgentConversationSummary,
	ctx: ExtensionContext,
	initial: ConfigurationPatch = {},
): Promise<ConfigurationPatch | undefined> {
	let patch: ConfigurationPatch = { ...initial };
	for (;;) {
		const shown = values(snapshot, patch);
		const label = display(agentDisplayName(snapshot));
		const choice = await ctx.ui.select(
			`Configure “${label}”\nName: ${shown.name} · Model: ${shown.model} · Reasoning: ${shown.level}`,
			["Name", "Model", "Reasoning", "Apply", "Cancel"],
		);
		if (choice === undefined || choice === "Cancel") return undefined;
		try {
			if (choice === "Apply") return validateConfigurationPatch(patch);
			patch = { ...patch, ...(await fieldPatch(choice, shown, ctx)) };
		} catch (error) {
			ctx.ui.notify(error instanceof Error ? error.message : "Invalid configuration", "error");
		}
	}
}

/** A refused write returns to the same staged fields; only Apply invokes the owner. */
export async function configurationWithApply<T>(
	snapshot: AgentConversationSummary,
	ctx: ExtensionContext,
	apply: (patch: ConfigurationPatch) => Promise<T>,
): Promise<T | undefined> {
	let staged: ConfigurationPatch = {};
	for (;;) {
		const patch = await configurationDialog(snapshot, ctx, staged);
		if (!patch) return undefined;
		staged = patch;
		try {
			return await apply(patch);
		} catch (error) {
			ctx.ui.notify(error instanceof Error ? error.message : "Configuration failed", "error");
		}
	}
}
