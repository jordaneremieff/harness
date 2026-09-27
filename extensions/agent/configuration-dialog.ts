import { stripVTControlCharacters } from "node:util";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentSessionSummary } from "./command.ts";
import { THINKING_LEVELS, validateConfigurationPatch, type ConfigurationPatch } from "./configuration.ts";

function display(value: string): string { return stripVTControlCharacters(value).replace(/[\p{Cc}\p{Cf}]/gu, " ").slice(0, 256); }
function values(snapshot: AgentSessionSummary, patch: ConfigurationPatch) {
	return {
		name: display(patch.name ?? snapshot.name ?? "(unnamed)"),
		model: display(patch.model ?? (snapshot.model ? `${snapshot.model.provider}/${snapshot.model.modelId}` : "(unavailable)")),
		level: patch.thinkingLevel ?? snapshot.model?.thinkingLevel ?? "(unavailable)",
	};
}
async function fieldPatch(choice: string, shown: ReturnType<typeof values>, ctx: ExtensionContext): Promise<ConfigurationPatch> {
	if (choice === "Reasoning") {
		const value = await ctx.ui.select("Reasoning level (Pi clamps it to the selected model)", [...THINKING_LEVELS]);
		return value === undefined ? {} : validateConfigurationPatch({ thinkingLevel: value });
	}
	if (choice !== "Name" && choice !== "Model") return {};
	const field = choice === "Name" ? "name" : "model";
	const value = await ctx.ui.input(choice === "Name" ? "Session name (blank clears)" : "Exact provider/model", shown[field]);
	return value === undefined ? {} : validateConfigurationPatch({ [field]: value });
}

/** Dialog edits stay local until Apply. The owner validates the current state at admission. */
export async function configurationDialog(snapshot: AgentSessionSummary, ctx: ExtensionContext): Promise<ConfigurationPatch | undefined> {
	let patch: ConfigurationPatch = {};
	for (;;) {
		const shown = values(snapshot, patch);
		const choice = await ctx.ui.select(`Configure ${display(snapshot.sessionId)}\nSnapshot or draft: name=${shown.name || "(unnamed)"}; model=${shown.model}; reasoning=${shown.level}`, ["Name", "Model", "Reasoning", "Apply", "Cancel"]);
		if (choice === undefined || choice === "Cancel") return undefined;
		try {
			if (choice === "Apply") return validateConfigurationPatch(patch);
			patch = { ...patch, ...await fieldPatch(choice, shown, ctx) };
		} catch (error) { ctx.ui.notify(error instanceof Error ? error.message : "Invalid configuration", "error"); }
	}
}
