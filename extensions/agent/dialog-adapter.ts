import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

/** An exact identity behind a display label. Forms store the value and show the label. */
export interface DialogChoice { value: string; label: string; description?: string }

export interface InputOptions {
	/** Prefilled text. A host without a prefill (Pi's single-line input) shows `placeholder` instead. */
	initial?: string;
	placeholder?: string;
}

/**
 * Form operations carry values, not display labels and not an emulated host context.
 * Ordinary Pi and the standalone terminal each supply one implementation.
 * Every prompt resolves `undefined` when the operator cancels.
 */
export interface AgentDialogs {
	/** True when `select` lets the operator narrow a long list by typing. */
	readonly filtersChoices?: boolean;
	select(title: string, choices: readonly DialogChoice[], selected?: string): Promise<string | undefined>;
	confirm(title: string, description: string, action: string): Promise<boolean>;
	input(title: string, options?: InputOptions): Promise<string | undefined>;
	/** Multiline text with Apply and Cancel. */
	editor(title: string, initial?: string): Promise<string | undefined>;
	/** Scrollable read-only text. */
	read(title: string, text: string): Promise<void>;
	notify(text: string, type?: "info" | "warning" | "error"): void;
}

export const dialogChoices = (values: readonly string[]): DialogChoice[] => values.map((value) => ({ value, label: value }));

/** Pi's native dialogs show only labels, so a repeated label gets its position to stay distinguishable. */
function distinctLabels(choices: readonly DialogChoice[]): string[] {
	return choices.map((choice, index) => choices.some((other, n) => n !== index && other.label === choice.label) ? `${choice.label} (${index + 1})` : choice.label);
}

export function ordinaryDialogs(ctx: ExtensionContext): AgentDialogs {
	const select: AgentDialogs["select"] = async (title, choices, selected) => {
		const labels = distinctLabels(choices);
		const first = selected === undefined ? -1 : choices.findIndex((choice) => choice.value === selected);
		const shown = first > 0 ? [labels[first], ...labels.filter((_, index) => index !== first)] : labels;
		const picked = await ctx.ui.select(title, shown);
		return picked === undefined ? undefined : choices[labels.indexOf(picked)]?.value;
	};
	return {
		select,
		confirm: async (title, description, action) => (await select(`${title}\n${description}`, [{ value: "cancel", label: "Cancel" }, { value: "apply", label: action }])) === "apply",
		input: (title, options) => ctx.ui.input(title, options?.placeholder ?? options?.initial ?? ""),
		editor: (title, initial = "") => ctx.ui.editor(title, initial),
		read: async (title, text) => { await ctx.ui.editor(`${title} (read only; changes are not saved)`, text); },
		notify: (text, type = "info") => ctx.ui.notify(text, type),
	};
}

/** A cancelled step goes back once; cancellation at the first step leaves the form. */
export async function dialogSteps(steps: readonly (() => Promise<boolean>)[]): Promise<boolean> {
	for (let step = 0; step < steps.length;) {
		if (await steps[step]?.()) step++;
		else if (step === 0) return false;
		else step--;
	}
	return true;
}
