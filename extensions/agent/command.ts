import { basename } from "node:path";
import { stripVTControlCharacters } from "node:util";
import type { ExtensionContext, RegisteredCommand } from "@earendil-works/pi-coding-agent";
import { fuzzyFilter, type AutocompleteItem } from "@earendil-works/pi-tui";
import { dashboardSessionState } from "./dashboard-state.ts";
import { readAgentBranch } from "./agent-git.ts";
import type { DashboardPreferences } from "./dashboard-preferences.ts";
import { showAgentDashboard, type DashboardResult } from "./dashboard.ts";
import type { EffortAwareness } from "./effort-awareness.ts";
import type { AgentObservationSource } from "./agent-observation.ts";
import { hideAround, runActionDialog, type ActionDialogExtras } from "./action-dialogs.ts";
import type { AgentConversationPage, AgentConversationSummary, AgentObservationSources, DashboardTarget } from "./dashboard-types.ts";
import { actionOutcomeText, agentDisplayName, outcomeSessionId } from "./action-outcome.ts";

interface CommandArgument {
	name: string;
	optional?: boolean;
	rest?: boolean;
	complete?: "session" | "session-control" | "command";
}

/** One action outcome: display text plus the agent it acted on, when any. */
export interface AgentActionOutcome {
	text: string;
	sessionId?: string;
}

export interface AgentCommandAction {
	name: string;
	description: string;
	args: CommandArgument[];
	help?: string;
	confirm?: string;
	dialog?(target: DashboardTarget | undefined, ctx: ExtensionContext): Promise<string | AgentActionOutcome | undefined>;
	run(
		args: string[],
		ctx: ExtensionContext,
		onCreated?: (row: AgentConversationSummary) => void,
	): Promise<string | AgentActionOutcome | undefined>;
}

function plain(text: string): string {
	return stripVTControlCharacters(text)
		.replace(/[\p{Cc}\p{Cf}]/gu, " ")
		.replace(/\s+/g, " ")
		.trim();
}

function usage(action: AgentCommandAction): string {
	return `/agent ${action.name}${action.args.map((arg) => ` ${arg.optional ? `[${arg.name}]` : `<${arg.name}>`}`).join("")}`;
}

function actionHelp(action: AgentCommandAction): string {
	return [usage(action), action.description, action.help].filter(Boolean).join("\n");
}

type SearchChoice = AutocompleteItem & { search: string };

function sessionLabel(row: AgentConversationSummary): string {
	return row.profile?.handle
		? plain(`${row.profile.handle}${row.name ? ` · ${row.name}` : ""}`)
		: plain(row.name ?? "") || `Session in ${plain(basename(row.cwd)) || "/"}`;
}

function sessionState(row: AgentConversationSummary): string {
	if (row.owner === "unavailable") return "Unavailable; stored metadata";
	if (row.owner === "unknown") return "Stored session";
	if (row.state === "working") return "Active work";
	return "Open session";
}

function sessionChoice(
	row: AgentConversationSummary,
	sessions: readonly AgentConversationSummary[],
	before: string,
	suffix: string,
): SearchChoice {
	const title = sessionLabel(row);
	const duplicates = sessions.filter((other) => sessionLabel(other) === title);
	const id = duplicates.some((other) => other.id !== row.id && other.id.slice(0, 8) === row.id.slice(0, 8))
		? row.id
		: row.id.slice(0, 8);
	return {
		value: `${before}${row.profile?.handle ?? row.id}${suffix}`,
		label: duplicates.length > 1 || !row.name ? `${title} (${id})` : title,
		description: `${row.profile?.role ? `${plain(row.profile.role)} · ` : ""}${sessionState(row)}${row.ownerLabel ? ` · ${plain(row.ownerLabel)}` : ""} · ${plain(row.cwd)} · ${new Date(row.modifiedAt).toISOString()}`,
		search: `${row.id} ${title} ${plain(row.profile?.role ?? "")} ${plain(row.cwd)}`,
	};
}

async function metadataChoices(
	sources: AgentObservationSources,
	action: AgentCommandAction,
	rest: string,
	before: string,
): Promise<SearchChoice[] | null> {
	const firstWord = rest.split(/\s+/, 1)[0];
	const afterId = /\s/.test(rest);
	const suffix = action.args.length > 1 ? " " : "";
	const sessions = (await sources.list()).rows;
	// An exact address ends selection. Later words belong to the message or correction.
	if (afterId && sessions.some((row) => row.id === firstWord || row.profile?.handle === firstWord)) return null;
	return sessions
		.slice()
		.reverse()
		.flatMap((row) => {
			const choice = sessionChoice(row, sessions, before, suffix);
			return row.profile?.handle
				? [choice, { ...choice, value: `${before}${row.id}${suffix}`, label: `${choice.label} (${row.id})` }]
				: [choice];
		});
}

function argumentHelp(action: AgentCommandAction, args: string[]): string | undefined {
	if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) return actionHelp(action);
	const required = action.args.filter((arg) => !arg.optional).length;
	if (args.length < required) return `Missing ${action.args[args.length].name}.\n${actionHelp(action)}`;
	if (!action.args.some((arg) => arg.rest) && args.length > action.args.length)
		return `Too many arguments.\n${actionHelp(action)}`;
	return undefined;
}

/** Text commands validate arguments before invoking the original action closure. */
export async function executeAgentAction(
	action: AgentCommandAction,
	args: string[],
	ctx: ExtensionContext,
	onCreated?: (row: AgentConversationSummary) => void,
): Promise<string | AgentActionOutcome | undefined> {
	return argumentHelp(action, args) ?? (await action.run(args, ctx, onCreated));
}

/** Human display text for one action result; legacy control JSON is summarized with the agent's display name. */
async function displayResult(
	result: string | AgentActionOutcome | undefined,
	sources: AgentObservationSources,
): Promise<string | undefined> {
	if (result === undefined) return undefined;
	if (typeof result === "object") return result.text;
	const sessionId = outcomeSessionId(result);
	let nameFor: ((id: string) => string | undefined) | undefined;
	if (sessionId !== undefined) {
		try {
			const rows = (await sources.list()).rows;
			nameFor = (id) => {
				const row = rows.find((item) => item.id === id);
				return row === undefined ? undefined : agentDisplayName(row);
			};
		} catch {
			// A failed roster read leaves the short identity in the summary.
		}
	}
	return actionOutcomeText(result, nameFor);
}

/** The same actions own execution, argument validation, help, and native completion. */
export function createAgentCommand(
	actions: AgentCommandAction[],
	sources: AgentObservationSource,
	options: ActionDialogExtras,
	collaborate?: (input: Record<string, unknown>, ctx: ExtensionContext) => Promise<unknown>,
	sessionFigures?: (ctx: ExtensionContext, page: AgentConversationPage) => Promise<string>,
	effortWiring?: {
		efforts(ctx: ExtensionContext): Promise<EffortAwareness>;
		messageEffort(id: string, text: string, ctx: ExtensionContext): Promise<DashboardResult>;
		observeEffort?(id: string, ctx?: ExtensionContext): Promise<string>;
	},
	preferences?: DashboardPreferences,
	readHideThinkingBlock?: () => boolean,
): Omit<RegisteredCommand, "name" | "sourceInfo"> & { openDashboard(ctx: ExtensionContext): Promise<void> } {
	const find = (name: string) => commands.find((action) => action.name === name);
	const unknown = (name: string) =>
		`Unknown action "${plain(name).slice(0, 80)}". Use /agent help, or type /agent and a space to choose an action.`;
	const overview = () =>
		[
			"/agent manages durable sessions. Choose an action below.",
			"For separate work: /agent new Check the error handling",
			"Actions:",
			...commands.map((action) => `  ${action.name}: ${action.description}`),
			"Use /agent help <action> for syntax and details. Tab completes a choice without running it.",
		].join("\n");
	const commands: AgentCommandAction[] = [
		...actions,
		{
			name: "help",
			description: "Show actions or help for one action",
			args: [{ name: "action", optional: true, complete: "command" }],
			run: async (args) => {
				if (!args[0]) return overview();
				const action = find(args[0]);
				return action ? actionHelp(action) : unknown(args[0]);
			},
		},
	];
	const actionItems = (query: string, before = ""): AutocompleteItem[] =>
		fuzzyFilter(commands, query, (action) => `${action.name} ${action.description}`).map((action) => ({
			value: `${before}${action.name}${!before && action.args.length ? " " : ""}`,
			label: action.name,
			description: action.description,
		}));

	let dashboardOpen = false;
	const requireAction = (name: string): AgentCommandAction => {
		const action = find(name);
		if (!action) throw new Error(`Agent action unavailable: ${name}`);
		return action;
	};
	const observationFor = (ctx: ExtensionContext) => {
		const observe = effortWiring?.observeEffort;
		return observe ? (id: string) => observe(id, ctx) : undefined;
	};
	const openDashboard = async (ctx: ExtensionContext): Promise<void> => {
		if (!ctx.hasUI || dashboardOpen) return;
		dashboardOpen = true;
		const state = dashboardSessionState(ctx.sessionManager.getSessionId(), preferences?.load);
		state.hideThinkingBlock = readHideThinkingBlock?.() ?? false;
		try {
			await showAgentDashboard({
				ctx,
				state,
				source: sources,
				operations: {
					saveLayout: preferences ? (layout) => preferences.save(layout) : undefined,
					efforts: effortWiring ? () => effortWiring.efforts(ctx) : undefined,
					messageEffort: effortWiring ? (id, text) => effortWiring.messageEffort(id, text, ctx) : undefined,
					observeEffort: observationFor(ctx),
					sessionFigures: sessionFigures ? (page) => sessionFigures(ctx, page) : undefined,
					modelInfo: (provider, modelId) => ctx.modelRegistry.find(provider, modelId),
					branch: readAgentBranch,
					collaborate: collaborate ? (input) => collaborate(input, ctx) : undefined,
					chooseConversation: async (labels, surface) =>
						hideAround(surface, async () => {
							const choices = labels.map(
								(label) => `${label.name || label.firstMessage || "Conversation"} · ${label.identity}`,
							);
							const choice = await ctx.ui.select("Choose a conversation", choices);
							return labels[choices.indexOf(choice ?? "")]?.identity;
						}),
					submit: async ({ id, text, mode }) => {
						const result = await executeAgentAction(
							requireAction(mode === "steer" ? "steer" : "send"),
							[id, text],
							ctx,
						);
						return { text: actionOutcomeText(result) ?? "Message admitted", sessionId: id };
					},
					newAgent: async ({ prompt, onCreated }) => {
						const result = await requireAction("new").run([prompt], ctx, onCreated);
						return { text: actionOutcomeText(result) ?? "Agent requested", sessionId: outcomeSessionId(result) };
					},
					action: async (name, target, surface) => {
						const result = await hideAround(surface, () =>
							runActionDialog(name, target, ctx, commands, sources, options, state),
						);
						const text = await displayResult(result, sources);
						return text === undefined ? undefined : { text, sessionId: outcomeSessionId(result) };
					},
				},
			});
		} finally {
			dashboardOpen = false;
		}
	};
	return {
		openDashboard,
		description: "Open the agent dashboard; add a space for a control action",
		async getArgumentCompletions(prefix) {
			const text = prefix.trimStart();
			const split = /^(\S+)\s+([\s\S]*)$/.exec(text);
			if (!split) return actionItems(text);
			const action = find(split[1]);
			if (!action) return actionItems(text);
			const rest = split[2];
			const argument = action.args[0];
			if (!argument?.complete) return null;
			const before = `${split[1]} `;
			if (argument.complete === "command") return actionItems(rest, before);
			try {
				const choices = await metadataChoices(sources, action, rest, before);
				if (!choices) return null;
				return fuzzyFilter(choices, rest.trim(), (item) => item.search).map(({ search: _search, ...item }) => item);
			} catch {
				// Completion has no error channel. Invocation reports store and ownership errors.
				return null;
			}
		},
		async handler(input, ctx) {
			const [name, ...args] = input.trim().split(/\s+/);
			const notify = (text: string) => ctx.ui.notify(text, "info");
			try {
				if (!name) return await openDashboard(ctx);
				if (["--help", "-h"].includes(name)) return notify(overview());
				const action = find(name);
				if (!action) return notify(unknown(name));
				const result = await executeAgentAction(action, args, ctx);
				const text = await displayResult(result, sources);
				if (text !== undefined) notify(text);
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	};
}
