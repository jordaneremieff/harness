/**
 * The statusline's editor-slot views: the complete extension status map and the
 * session's model and reasoning form.
 * Each view binds to the context it opens with; nothing here keeps a startup context.
 */

import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import type { SelectItem } from "@earendil-works/pi-tui";
import { Browser } from "./browser.ts";
import { Form } from "./form.ts";
import { plainLine, type View, type ViewHost } from "./frame.ts";
import { sanitizeDisplay } from "./format.ts";

/** The complete extension status map behind the footer, read from memory on every paint. */
export function statusesView(host: ViewHost, read: (() => ReadonlyMap<string, string>) | undefined): View {
	type Entry = { key: string; text: string };
	return new Browser<Entry>({
		title: "Statuses",
		host,
		items: () => [...(read?.() ?? [])].map(([key, text]) => ({ key, text: sanitizeDisplay(text) })),
		key: (entry) => entry.key,
		line: (entry) => `${host.theme.fg("accent", plainLine(entry.key))}  ${entry.text}\x1b[0m`,
		detail: (entry) => (entry ? `${plainLine(entry.key)}\n\n${entry.text}\x1b[0m` : "Select a status to read it."),
		status: (count) =>
			read ? `${count} extension status entries` : "Enable the statusline (/statusline) to read extension statuses.",
		empty: () => "No extension has set a status.",
	});
}

function modelChoices(
	available: ReturnType<ExtensionContext["modelRegistry"]["getAvailable"]>,
	current: string,
	theme: Theme,
): SelectItem[] {
	return available.map((model) => {
		const identity = `${model.provider}/${model.id}`;
		const facts = [
			sanitizeDisplay(model.name),
			model.reasoning ? "reasoning" : "",
			identity === current ? "current" : "",
		].filter(Boolean);
		return { value: identity, label: sanitizeDisplay(identity), description: theme.fg("muted", facts.join(" · ")) };
	});
}

/** Model and reasoning for this session in one staged form; Apply changes this session only. */
export function modelView(pi: ExtensionAPI, ctx: ExtensionContext, host: ViewHost, done: () => void): View {
	const available = ctx.modelRegistry.getAvailable();
	const current = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "";
	const find = (identity: string) => available.find((model) => `${model.provider}/${model.id}` === identity);
	const levels = (values: Readonly<Record<string, string>>): SelectItem[] => {
		const model = find(values.model ?? "");
		if (model?.reasoning !== true) return [{ value: "", label: "No reasoning levels for this model" }];
		return getSupportedThinkingLevels(model).map((level) => ({ value: level, label: level }));
	};
	return new Form({
		title: "Model",
		heading: "Model and reasoning for this session",
		intro: available.length
			? "Choose from the configured registry. Apply changes this session only; Cancel keeps the current model."
			: "No model is available in the configured registry.",
		fields: [
			{
				kind: "choice",
				id: "model",
				label: "Model",
				value: current,
				choices: modelChoices(available, current, host.theme),
				filter: true,
				rows: 8,
				hint: "Type to narrow; Up and Down stage a model",
			},
			{
				kind: "choice",
				id: "reasoning",
				label: "Reasoning",
				value: ctx.model?.reasoning === true ? pi.getThinkingLevel() : "",
				choices: levels,
			},
		],
		action: { label: "Apply" },
		host,
		validate: (values) => (find(values.model ?? "") ? undefined : "Choose an available model"),
		submit: async (values, signal) => {
			const model = find(values.model ?? "");
			if (!model) throw new Error("The chosen model is no longer available.");
			const identity = `${model.provider}/${model.id}`;
			const changed = identity !== (ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "");
			if (changed && !(await pi.setModel(model)))
				throw new Error(
					`Pi refused ${sanitizeDisplay(identity)}: authentication is not configured for ${sanitizeDisplay(model.provider)}.`,
				);
			if (signal.aborted) return undefined;
			if (model.reasoning === true && values.reasoning)
				pi.setThinkingLevel(values.reasoning as Parameters<typeof pi.setThinkingLevel>[0]);
			done();
			const level = model.reasoning === true ? ` · reasoning ${pi.getThinkingLevel()}` : "";
			return { notice: { text: `Model ${sanitizeDisplay(identity)}${level} for this session`, kind: "success" } };
		},
	});
}
