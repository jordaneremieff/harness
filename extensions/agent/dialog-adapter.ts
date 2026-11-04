import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export interface DialogChoice { value: string; label: string; description?: string }
/** Form operations carry values, not display labels or an emulated host context. */
export interface AgentDialogs {
	select(title: string, choices: readonly DialogChoice[]): Promise<string | undefined>;
	confirm(title: string, description: string, action: string): Promise<boolean>;
	input(title: string, initial?: string): Promise<string | undefined>;
	editor(title: string, initial?: string): Promise<string | undefined>;
	read(title: string, text: string): Promise<void>;
	notify(text: string, type?: "info" | "warning" | "error"): void;
}
export const dialogChoices = (values: readonly string[]): DialogChoice[] => values.map((value) => ({ value, label: value }));

export function ordinaryDialogs(ctx: ExtensionContext): AgentDialogs {
	const select: AgentDialogs["select"] = async (title, choices) => {
		const labels = choices.map((choice, index) => choices.some((other, n) => n !== index && other.label === choice.label) ? `${choice.label} (${index + 1})` : choice.label);
		const selected = await ctx.ui.select(title, labels);
		return selected === undefined ? undefined : choices[labels.indexOf(selected)]?.value;
	};
	return {
		select,
		confirm: async (title, description, action) => (await select(`${title}\n${description}`, [{ value: "cancel", label: "Cancel" }, { value: "apply", label: action }])) === "apply",
		input: async (title, initial = "") => {
			// The ordinary input API has no initial-value argument. Its native editor does.
			return ctx.ui.editor(title, initial);
		},
		editor: (title, initial = "") => ctx.ui.editor(title, initial),
		read: async (title, text) => { await ctx.ui.editor(`${title} (read only; changes are not saved)`, text); },
		notify: (text, type = "info") => ctx.ui.notify(text, type),
	};
}

/** Cancellation at a later step returns to the previous completed field. */
export async function dialogSteps(steps: readonly (() => Promise<boolean>)[]): Promise<boolean> {
	for (let step = 0; step < steps.length;) {
		if (await steps[step]?.()) step++;
		else if (step === 0) return false;
		else step--;
	}
	return true;
}
