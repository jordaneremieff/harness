/**
 * The statusline's destinations in the shared browsing frame: command discovery with guarded
 * dispatch, the complete extension status map, and the session's model and reasoning form.
 * Each view binds to the context it opens with; nothing here keeps a startup context.
 */

import type { ExtensionAPI, ExtensionContext, SlashCommandInfo, Theme } from "@earendil-works/pi-coding-agent";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import {
	type Action,
	Browser,
	type Choice,
	commandIdentity,
	commandLine,
	dispatchCommand,
	Form,
	type OperatorView,
	plainLine,
	type ViewHost,
} from "../../operator-ui/index.ts";
import { prepareDraft, restoreDraft, type DraftPlacement } from "./commands.ts";
import { sanitizeDisplay } from "./format.ts";

/** Command browsing state that survives closing and reopening the frame within one session. */
export interface CommandsState {
	query: string;
	/** Unsent argument text per exact registration identity. */
	args: Map<string, string>;
	/** Identity of the last selected command, reselected on reopen while it still exists. */
	selected?: string;
	/** A draft that "Replace draft" displaced, kept until restored or replaced again. */
	replaced?: string;
}

export function createCommandsState(): CommandsState {
	return { query: "", args: new Map() };
}

function kindLabel(command: SlashCommandInfo): string {
	if (command.source === "extension") return "command";
	if (command.source === "prompt") return "prompt";
	return "skill";
}

function matches(command: SlashCommandInfo, query: string): boolean {
	const words = query.toLowerCase().split(/\s+/).filter(Boolean);
	const haystack = `${command.name}\n${command.description ?? ""}`.toLowerCase();
	return words.every((word) => haystack.includes(word));
}

function commandDetail(command: SlashCommandInfo, state: CommandsState): string {
	const source = command.sourceInfo;
	const lines = [
		`/${plainLine(command.name)}`,
		`${command.source === "extension" ? "Extension command" : command.source === "prompt" ? "Prompt template" : "Skill"} · ${plainLine(source.source)}`,
		"",
		plainLine(command.description ?? "No description."),
	];
	const args = state.args.get(commandIdentity(command));
	if (args) lines.push("", `Unsent arguments: ${plainLine(args)}`);
	lines.push("", `Source: ${plainLine(source.path)}`);
	return lines.join("\n");
}

interface CommandDeps {
	readonly pi: ExtensionAPI;
	readonly ctx: ExtensionContext;
	readonly host: ViewHost;
	readonly state: CommandsState;
}

function runForm(deps: CommandDeps, command: SlashCommandInfo, host: ViewHost): OperatorView {
	const identity = commandIdentity(command);
	return new Form({
		title: `/${plainLine(command.name)}`,
		heading: `Run /${plainLine(command.name)} in this session`,
		intro: "Arguments follow the command name exactly as typed. The command's own owner decides what they mean.",
		fields: [{ kind: "text", id: "args", label: "Arguments", value: deps.state.args.get(identity) ?? "", placeholder: "optional" }],
		action: { label: "Run" },
		host,
		change: (values) => deps.state.args.set(identity, values.args ?? ""),
		submit: async (values) => {
			const args = values.args ?? "";
			host.close(() => dispatchNow(deps, command, args));
			return undefined;
		},
	});
}

function dispatchNow(deps: CommandDeps, command: SlashCommandInfo, args: string): void {
	const outcome = dispatchCommand(deps.pi, command, args);
	if (outcome.kind === "sent") deps.state.args.delete(commandIdentity(command));
	else deps.ctx.ui.notify(`/${sanitizeDisplay(command.name)} is no longer registered as selected; nothing was sent.`, "warning");
}

function prepareForm(deps: CommandDeps, command: SlashCommandInfo, host: ViewHost): OperatorView {
	const identity = commandIdentity(command);
	const draft = deps.ctx.ui.getEditorText().length > 0;
	const placement: Choice[] = [
		{ value: "insert", label: "Insert at the cursor", description: "keeps your draft" },
		{ value: "replace", label: "Replace the draft", description: "the draft stays recoverable here" },
	];
	return new Form({
		title: `/${plainLine(command.name)}`,
		heading: `Put /${plainLine(command.name)} in the editor`,
		intro: "Nothing is sent. The text waits in the editor for you to review and submit.",
		fields: [
			{ kind: "text", id: "args", label: "Arguments", value: deps.state.args.get(identity) ?? "", placeholder: "optional" },
			...(draft ? [{ kind: "choice" as const, id: "placement", label: "Placement", value: "insert", choices: placement }] : []),
		],
		action: { label: "Put in editor" },
		host,
		change: (values) => deps.state.args.set(identity, values.args ?? ""),
		submit: async (values) => {
			const line = commandLine(command.name, values.args ?? "");
			const where: DraftPlacement = values.placement === "replace" ? "replace" : "insert";
			host.close(() => {
				const outcome = prepareDraft(deps.ctx.ui, line, where);
				deps.state.args.delete(identity);
				if (outcome.replaced) {
					deps.state.replaced = outcome.replaced;
					deps.ctx.ui.notify("Draft replaced. Commands offers Restore replaced draft.", "info");
				}
			});
			return undefined;
		},
	});
}

function commandActions(deps: CommandDeps, command: SlashCommandInfo | undefined): Action[] {
	const actions: Action[] = [];
	if (command?.source === "extension") {
		actions.push({ id: "run", label: "Run", primary: true, description: `Send /${command.name} now`, run: () => deps.host.close(() => dispatchNow(deps, command, "")) });
		actions.push({ id: "args", label: "Run with arguments…", primary: true, run: () => deps.host.push((host) => runForm(deps, command, host)) });
	} else if (command) {
		actions.push({ id: "prepare", label: "Put in editor…", primary: true, run: () => deps.host.push((host) => prepareForm(deps, command, host)) });
	}
	const replaced = deps.state.replaced;
	if (replaced !== undefined)
		actions.push({
			id: "restore",
			label: "Restore replaced draft",
			description: "Put the displaced draft back in the editor",
			run: () =>
				deps.host.close(() => {
					restoreDraft(deps.ctx.ui, replaced);
					deps.state.replaced = undefined;
				}),
		});
	return actions;
}

/** Every registered command, searchable. Selection is harmless; Run and Put in editor are the effects. */
export function commandsView(pi: ExtensionAPI, ctx: ExtensionContext, host: ViewHost, state: CommandsState): OperatorView {
	const deps: CommandDeps = { pi, ctx, host, state };
	const read = () => pi.getCommands().map((command) => ({ ...command, sourceInfo: { ...command.sourceInfo } }));
	let all = read();
	const browser: Browser<SlashCommandInfo> = new Browser<SlashCommandInfo>({
		title: "Commands",
		host,
		key: commandIdentity,
		line: (command, width, theme) => {
			const kind = theme.fg("dim", kindLabel(command).padEnd(8));
			const name = theme.fg("accent", `/${plainLine(command.name)}`);
			return `${kind}${name}  ${theme.fg("muted", plainLine(command.description ?? ""))}`.slice(0, width * 4);
		},
		detail: (command) => (command ? commandDetail(command, state) : "Select a command to read it."),
		actions: (command) => commandActions(deps, command),
		search: {
			value: state.query,
			placeholder: "type to find a command",
			change: (query) => {
				state.query = query;
				browser.setItems(all.filter((command) => matches(command, query)));
			},
		},
		status: () => {
			const shown = all.filter((command) => matches(command, state.query)).length;
			return `${shown} of ${all.length} commands · Run sends a command; Put in editor never sends`;
		},
		empty: () => (state.query ? `No command matches “${plainLine(state.query)}”.` : "No commands are registered."),
		onSelect: (command) => {
			state.selected = command ? commandIdentity(command) : undefined;
		},
	});
	all = read();
	browser.setItems(all.filter((command) => matches(command, state.query)), state.selected);
	return browser;
}

/** The complete extension status map behind the footer, read from memory on every paint. */
export function statusesView(host: ViewHost, read: (() => ReadonlyMap<string, string>) | undefined): OperatorView {
	type Entry = { key: string; text: string };
	const entries = (): Entry[] => [...(read?.() ?? new Map<string, string>())].map(([key, text]) => ({ key, text: sanitizeDisplay(text) }));
	const browser = new Browser<Entry>({
		title: "Statuses",
		host,
		key: (entry) => entry.key,
		line: (entry, _width, theme) => `${theme.fg("accent", plainLine(entry.key))}  ${entry.text}`,
		detail: (entry) => (entry ? `${plainLine(entry.key)}\n\n${entry.text}` : "Select a status to read it."),
		actions: () => [],
		status: () => (read ? `${entries().length} extension status entries` : "Enable the statusline (/statusline) to read extension statuses."),
		empty: () => "No extension has set a status.",
	});
	browser.setItems(entries());
	const render = browser.render.bind(browser);
	browser.render = (width: number, height: number) => {
		browser.setItems(entries());
		return render(width, height);
	};
	return browser;
}

function modelChoices(ctx: ExtensionContext, theme: Theme): Choice[] {
	const current = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
	return ctx.modelRegistry.getAvailable().map((model) => {
		const identity = `${model.provider}/${model.id}`;
		const facts = [sanitizeDisplay(model.name), model.reasoning ? "reasoning" : "", identity === current ? "current" : ""].filter(Boolean);
		return { value: identity, label: sanitizeDisplay(identity), description: theme.fg("muted", facts.join(" · ")) };
	});
}

/** Model and reasoning for this session in one staged form; Apply changes this session only. */
export function modelView(pi: ExtensionAPI, ctx: ExtensionContext, host: ViewHost, done: () => void): OperatorView {
	const available = ctx.modelRegistry.getAvailable();
	const current = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "";
	const find = (identity: string) => available.find((model) => `${model.provider}/${model.id}` === identity);
	const levels = (values: Readonly<Record<string, string>>): Choice[] => {
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
			{ kind: "choice", id: "model", label: "Model", value: current, choices: modelChoices(ctx, host.theme), filter: true, rows: 8, hint: "Type to narrow; Up and Down stage a model" },
			{ kind: "choice", id: "reasoning", label: "Reasoning", value: ctx.model?.reasoning === true ? pi.getThinkingLevel() : "", choices: levels },
		],
		action: { label: "Apply" },
		host,
		validate: (values) => (find(values.model ?? "") ? undefined : "Choose an available model"),
		submit: async (values) => {
			const model = find(values.model ?? "");
			if (!model) throw new Error("The chosen model is no longer available.");
			const identity = `${model.provider}/${model.id}`;
			const changed = identity !== (ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "");
			if (changed && !(await pi.setModel(model))) throw new Error(`Pi refused ${sanitizeDisplay(identity)}: authentication is not configured for ${sanitizeDisplay(model.provider)}.`);
			if (model.reasoning === true && values.reasoning) pi.setThinkingLevel(values.reasoning as Parameters<typeof pi.setThinkingLevel>[0]);
			done();
			const level = model.reasoning === true ? ` · reasoning ${pi.getThinkingLevel()}` : "";
			return { notice: { text: `Model ${sanitizeDisplay(identity)}${level} for this session`, kind: "success" } };
		},
	});
}
