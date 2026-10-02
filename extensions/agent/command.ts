import { basename } from "node:path";
import { stripVTControlCharacters } from "node:util";
import type { ExtensionContext, RegisteredCommand } from "@earendil-works/pi-coding-agent";
import { fuzzyFilter, type AutocompleteItem } from "@earendil-works/pi-tui";
import { showPeerWindow } from "./peer-window.ts";
import type { PeerAgentActions, PrimaryObserver } from "./peer-contract.ts";
import type { AgentConversationSummary, AgentObservationSources, DashboardTarget } from "./dashboard-types.ts";
import { selectDashboardAction } from "./dashboard-actions.ts";
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
	run(args: string[], ctx: ExtensionContext): Promise<string | AgentActionOutcome | undefined>;
}

function plain(text: string): string {
	return stripVTControlCharacters(text).replace(/[\p{Cc}\p{Cf}]/gu, " ").replace(/\s+/g, " ").trim();
}

function usage(action: AgentCommandAction): string {
	return `/agent ${action.name}${action.args.map((arg) => ` ${arg.optional ? `[${arg.name}]` : `<${arg.name}>`}`).join("")}`;
}

function actionHelp(action: AgentCommandAction): string {
	return [usage(action), action.description, action.help].filter(Boolean).join("\n");
}

type SearchChoice = AutocompleteItem & { search: string };

function sessionLabel(row: AgentConversationSummary): string {
	return plain(row.name ?? "") || `Session in ${plain(basename(row.cwd)) || "/"}`;
}

function sessionState(row: AgentConversationSummary): string {
	if (row.owner === "unavailable") return "Unavailable; stored metadata";
	if (row.owner === "unknown") return "Stored session";
	if (row.state === "working") return "Active work";
	return "Open session";
}

function sessionChoice(row: AgentConversationSummary, sessions: readonly AgentConversationSummary[], before: string, suffix: string): SearchChoice {
	const title = sessionLabel(row);
	const duplicates = sessions.filter((other) => sessionLabel(other) === title);
	const id = duplicates.some((other) => other.id !== row.id && other.id.slice(0, 8) === row.id.slice(0, 8)) ? row.id : row.id.slice(0, 8);
	return {
		value: `${before}${row.id}${suffix}`,
		label: duplicates.length > 1 || !row.name ? `${title} (${id})` : title,
		description: `${sessionState(row)}${row.ownerLabel ? ` · ${plain(row.ownerLabel)}` : ""} · ${plain(row.cwd)} · ${new Date(row.modifiedAt).toISOString()}`,
		search: `${row.id} ${title} ${plain(row.cwd)}`,
	};
}

async function metadataChoices(sources: AgentObservationSources, action: AgentCommandAction, rest: string, before: string): Promise<SearchChoice[] | null> {
	const firstWord = rest.split(/\s+/, 1)[0];
	const afterId = /\s/.test(rest);
	const suffix = action.args.length > 1 ? " " : "";
	const sessions = (await sources.list()).rows;
	// An exact ID ends selection. Later words belong to the message or correction.
	if (afterId && sessions.some((row) => row.id === firstWord)) return null;
	return sessions.slice().reverse().map((row) => sessionChoice(row, sessions, before, suffix));
}

function argumentHelp(action: AgentCommandAction, args: string[]): string | undefined {
	if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) return actionHelp(action);
	const required = action.args.filter((arg) => !arg.optional).length;
	if (args.length < required) return `Missing ${action.args[args.length].name}.\n${actionHelp(action)}`;
	if (!action.args.some((arg) => arg.rest) && args.length > action.args.length) return `Too many arguments.\n${actionHelp(action)}`;
	return undefined;
}

/** Both native entry points share argument validation and the original action closure. */
export async function executeAgentAction(action: AgentCommandAction, args: string[], ctx: ExtensionContext): Promise<string | AgentActionOutcome | undefined> {
	return argumentHelp(action, args) ?? await action.run(args, ctx);
}

function targetArgument(argument: CommandArgument, target?: DashboardTarget): string | undefined {
	if (!target) return undefined;
	if (argument.complete === "session" || argument.complete === "session-control") return target.id;
	return undefined;
}

/** Hides the peer window while a native dialog owns the screen. */
interface PromptSurface { hide(): void; show(): void }
async function hideAround<T>(surface: PromptSurface | undefined, action: () => Promise<T>): Promise<T> {
	if (surface === undefined) return action();
	surface.hide();
	try { return await action(); } finally { surface.show(); }
}

async function askDashboardArgument(action: AgentCommandAction, argument: CommandArgument, ctx: ExtensionContext, agent?: string, surface?: PromptSurface): Promise<string[] | undefined> {
	const value = await hideAround(surface, () => ctx.ui.input(`${usage(action)} · ${argument.name}${agent ? ` · ${agent}` : ""}${argument.optional ? " (optional; blank to omit)" : ""}`, argument.rest ? "Free text" : argument.name));
	if (value === undefined) return undefined;
	return value.trim() ? value.trim().split(/\s+/) : [];
}

async function dashboardArguments(action: AgentCommandAction, target: DashboardTarget | undefined, ctx: ExtensionContext, agent?: string, surface?: PromptSurface): Promise<string[] | string | undefined> {
	const args: string[] = [];
	for (const [index, argument] of action.args.entries()) {
		const preset = index === 0 ? targetArgument(argument, target) : undefined;
		if (preset !== undefined) { args.push(preset); continue; }
		const words = await askDashboardArgument(action, argument, ctx, agent, surface);
		if (words === undefined) return undefined;
		if (!words.length && argument.optional) break;
		const error = dashboardArgumentError(argument, words);
		if (error) return `${error}\n${actionHelp(action)}`;
		args.push(...words);
	}
	return args;
}

function dashboardArgumentError(argument: CommandArgument, words: string[]): string | undefined {
	if (!words.length || (!argument.rest && words.length !== 1)) return `${argument.name} requires ${argument.rest ? "text" : "one word"}.`;
	return undefined;
}

export async function chooseDashboardAction(actions: AgentCommandAction[], target: DashboardTarget | undefined, ctx: ExtensionContext, surface?: PromptSurface): Promise<string | AgentActionOutcome | undefined> {
	const agent = target === undefined ? undefined : agentDisplayName(target);
	const choice = await selectDashboardAction(actions, ctx, agent);
	if (choice === undefined) return undefined;
	const action = actions.find((item) => item.name === choice);
	if (!action) return undefined;
	if (action.dialog) {
		const dialog = action.dialog;
		return await hideAround(surface, () => dialog(target, ctx));
	}
	const args = await dashboardArguments(action, target, ctx, agent, surface);
	if (!Array.isArray(args)) return args;
	const help = argumentHelp(action, args);
	if (help) return help;
	if (action.confirm && !await hideAround(surface, () => ctx.ui.confirm(`Confirm /agent ${action.name}`, `${action.confirm}\n\n${usage(action)}\nArguments: ${args.join(" ")}`))) return undefined;
	return await executeAgentAction(action, args, ctx) ?? "Action returned no text. This is not proof of task completion.";
}

/** Human display text for one action result; legacy control JSON is summarized with the agent's display name. */
async function displayResult(result: string | AgentActionOutcome | undefined, sources: AgentObservationSources): Promise<string | undefined> {
	if (result === undefined) return undefined;
	if (typeof result === "object") return result.text;
	const sessionId = outcomeSessionId(result);
	let nameFor: ((id: string) => string | undefined) | undefined;
	if (sessionId !== undefined) {
		try {
			const rows = (await sources.list()).rows;
			nameFor = (id) => { const row = rows.find((item) => item.id === id); return row === undefined ? undefined : agentDisplayName(row); };
		} catch {
			// A failed roster read leaves the short identity in the summary.
		}
	}
	return actionOutcomeText(result, nameFor);
}

/** Dependencies the command needs to open the peer window. */
export interface AgentCommandPeerOptions {
	primary: PrimaryObserver;
}

/** The same actions own execution, argument validation, help, and native completion. */
export function createAgentCommand(actions: AgentCommandAction[], sources: AgentObservationSources, options: AgentCommandPeerOptions): Omit<RegisteredCommand, "name" | "sourceInfo"> & { openDashboard(ctx: ExtensionContext): Promise<void> } {
	const find = (name: string) => commands.find((action) => action.name === name);
	const unknown = (name: string) => `Unknown action "${plain(name).slice(0, 80)}". Use /agent help, or type /agent and a space to choose an action.`;
	const overview = () => [
		"/agent manages durable sessions. Choose an action below.",
		"For separate work: /agent new Check the error handling",
		"Actions:",
		...commands.map((action) => `  ${action.name}: ${action.description}`),
		"Use /agent help <action> for syntax and details. Tab completes a choice without running it.",
	].join("\n");
	const commands: AgentCommandAction[] = [...actions, {
		name: "help", description: "Show actions or help for one action", args: [{ name: "action", optional: true, complete: "command" }],
		run: async (args) => {
			if (!args[0]) return overview();
			const action = find(args[0]);
			return action ? actionHelp(action) : unknown(args[0]);
		},
	}];
	const actionItems = (query: string, before = ""): AutocompleteItem[] => fuzzyFilter(commands, query, (action) => `${action.name} ${action.description}`).map((action) => ({
		value: `${before}${action.name}${!before && action.args.length ? " " : ""}`,
		label: action.name,
		description: action.description,
	}));

	let peerOpen = false;
	const requireAction = (name: string): AgentCommandAction => {
		const action = find(name);
		if (!action) throw new Error(`Agent action unavailable: ${name}`);
		return action;
	};
	/** Operator-origin peer actions; the window only presents and routes them. */
	const peerActions = (ctx: ExtensionContext): PeerAgentActions => ({
		submit: async ({ id, text, mode }) => {
			const result = await executeAgentAction(requireAction(mode === "steer" ? "steer" : "send"), [id, text], ctx);
			return { text: actionOutcomeText(result) ?? (mode === "steer" ? "Queued a correction" : "Sent a task"), sessionId: outcomeSessionId(result) ?? id };
		},
		newAgent: async ({ prompt }) => {
			const result = await executeAgentAction(requireAction("new"), prompt ? [prompt] : [], ctx);
			return { text: actionOutcomeText(result) ?? "Requested a new agent", sessionId: outcomeSessionId(result) };
		},
		fork: async ({ id, entryId }) => {
			const result = await executeAgentAction(requireAction("fork"), entryId ? [id, entryId] : [id], ctx);
			return { text: actionOutcomeText(result) ?? "Requested a branch", sessionId: outcomeSessionId(result) ?? id };
		},
		repair: async ({ id, entryId, correction }) => {
			const result = await executeAgentAction(requireAction("rewind"), [id, entryId, correction], ctx);
			return { text: actionOutcomeText(result) ?? "Requested a corrected branch", sessionId: outcomeSessionId(result) ?? id };
		},
	});
	const openDashboard = async (ctx: ExtensionContext): Promise<void> => {
		if (!ctx.hasUI || peerOpen) return;
		peerOpen = true;
		try {
			await showPeerWindow({
				ctx,
				source: sources,
				primary: options.primary,
				actions: peerActions(ctx),
				runActions: async (target, surface) => {
					const result = await chooseDashboardAction(commands, target, ctx, surface);
					const text = await displayResult(result, sources);
					return text === undefined ? undefined : { text, sessionId: outcomeSessionId(result) };
				},
			});
		}
		finally { peerOpen = false; }
	};
	return {
		openDashboard,
		description: "Manage durable sessions; add a space to choose an action",
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
