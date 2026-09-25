import { basename } from "node:path";
import { stripVTControlCharacters } from "node:util";
import type { ExtensionCommandContext, RegisteredCommand } from "@earendil-works/pi-coding-agent";
import { fuzzyFilter, type AutocompleteItem } from "@earendil-works/pi-tui";
import { showAgentDashboard, type AgentObservationSources, type DashboardTarget } from "./dashboard.ts";
import type { UnavailableHostState } from "./worker.ts";

export interface AgentSessionSummary {
	sessionId: string;
	name?: string;
	firstMessage?: string;
	model?: { provider: string; modelId: string; thinkingLevel: string };
	provenance?: "live" | "stored";
	parentSessionIds?: string[];
	cwd: string;
	modifiedAt: number;
	live: boolean;
	hostState?: UnavailableHostState;
	operation?: string | null;
	detachedRunId?: string;
}

interface CommandArgument {
	name: string;
	optional?: boolean;
	rest?: boolean;
	complete?: "session" | "session-control" | "run" | "command";
}

export interface AgentCommandAction {
	name: string;
	description: string;
	args: CommandArgument[];
	help?: string;
	confirm?: string;
	run(args: string[], ctx: ExtensionCommandContext): Promise<string | undefined>;
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

function sessionLabel(row: AgentSessionSummary): string {
	return plain(row.name ?? "") || `Session in ${plain(basename(row.cwd)) || "/"}`;
}

function sessionState(row: AgentSessionSummary): string {
	if (row.hostState) return `Host ${row.hostState}; stored metadata`;
	if (row.detachedRunId) return "Detached run; owner control";
	if (row.operation) return "Active work";
	return row.live ? "Open session" : "Stored session";
}

function sessionChoice(row: AgentSessionSummary, sessions: AgentSessionSummary[], before: string, suffix: string): SearchChoice {
	const title = sessionLabel(row);
	const duplicates = sessions.filter((other) => sessionLabel(other) === title);
	const id = duplicates.some((other) => other.sessionId !== row.sessionId && other.sessionId.slice(0, 8) === row.sessionId.slice(0, 8)) ? row.sessionId : row.sessionId.slice(0, 8);
	return {
		value: `${before}${row.sessionId}${suffix}`,
		label: duplicates.length > 1 || !row.name ? `${title} (${id})` : title,
		description: `${sessionState(row)} · ${plain(row.cwd)} · ${new Date(row.modifiedAt).toISOString()}`,
		search: `${row.sessionId} ${title} ${plain(row.cwd)}`,
	};
}

async function metadataChoices(sources: AgentObservationSources, action: AgentCommandAction, completion: CommandArgument["complete"], rest: string, before: string): Promise<SearchChoice[] | null> {
	const firstWord = rest.split(/\s+/, 1)[0];
	const afterId = /\s/.test(rest);
	const suffix = action.args.length > 1 ? " " : "";
	if (completion === "run") {
		const runs = await sources.runs();
		if (afterId && runs.some((run) => run.runId === firstWord)) return null;
		return runs.map((run) => ({
			value: `${before}${run.runId}${suffix}`,
			label: `${plain(run.prompt).slice(0, 60) || "Detached run"} (${run.runId.slice(0, 8)})`,
			description: `${run.state} · ${plain(run.cwd)} · ${run.startedAt}`,
			search: `${run.runId} ${plain(run.prompt)} ${plain(run.cwd)}`,
		}));
	}
	const sessions = await sources.sessions();
	// An exact ID ends selection. Later words belong to the message or correction.
	if (afterId && sessions.some((row) => row.sessionId === firstWord)) return null;
	return sessions.filter((row) => !row.detachedRunId || completion === "session-control").reverse()
		.map((row) => sessionChoice(row, sessions, before, suffix));
}

function argumentHelp(action: AgentCommandAction, args: string[]): string | undefined {
	if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) return actionHelp(action);
	const required = action.args.filter((arg) => !arg.optional).length;
	if (args.length < required) return `Missing ${action.args[args.length].name}.\n${actionHelp(action)}`;
	if (!action.args.some((arg) => arg.rest) && args.length > action.args.length) return `Too many arguments.\n${actionHelp(action)}`;
	return undefined;
}

/** Both native entry points share argument validation and the original action closure. */
export async function executeAgentAction(action: AgentCommandAction, args: string[], ctx: ExtensionCommandContext): Promise<string | undefined> {
	return argumentHelp(action, args) ?? await action.run(args, ctx);
}

function targetArgument(argument: CommandArgument, target?: DashboardTarget): string | undefined {
	if (!target) return undefined;
	if (argument.complete === "session" || argument.complete === "session-control") return target.kind === "session" ? target.session.sessionId : target.run.currentSessionId ?? target.run.sessionId;
	if (argument.complete === "run" && target.kind === "run") return target.run.runId;
	return undefined;
}

async function askDashboardArgument(action: AgentCommandAction, argument: CommandArgument, ctx: ExtensionCommandContext): Promise<string[] | undefined> {
	const value = await ctx.ui.input(`${usage(action)} · ${argument.name}${argument.optional ? " (optional; blank to omit)" : ""}`, argument.rest ? "Free text" : argument.name);
	if (value === undefined) return undefined;
	return value.trim() ? value.trim().split(/\s+/) : [];
}

async function dashboardArguments(action: AgentCommandAction, target: DashboardTarget | undefined, ctx: ExtensionCommandContext): Promise<string[] | string | undefined> {
	const args: string[] = [];
	for (const [index, argument] of action.args.entries()) {
		const preset = index === 0 ? targetArgument(argument, target) : undefined;
		if (preset !== undefined) { args.push(preset); continue; }
		const words = await askDashboardArgument(action, argument, ctx);
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

export async function chooseDashboardAction(actions: AgentCommandAction[], target: DashboardTarget | undefined, ctx: ExtensionCommandContext): Promise<string | undefined> {
	const labels = actions.map((action) => `${action.name}: ${action.description}`);
	const choice = await ctx.ui.select("Agent actions", labels);
	if (choice === undefined) return undefined;
	const action = actions[labels.indexOf(choice)];
	if (!action) return undefined;
	const args = await dashboardArguments(action, target, ctx);
	if (!Array.isArray(args)) return args;
	const help = argumentHelp(action, args);
	if (help) return help;
	if (action.confirm && !await ctx.ui.confirm(`Confirm /agent ${action.name}`, `${action.confirm}\n\n${usage(action)}\nArguments: ${args.join(" ")}`)) return undefined;
	return await executeAgentAction(action, args, ctx) ?? "Action returned no text. This is not proof of task completion.";
}

/** The same actions own execution, argument validation, help, and native completion. */
export function createAgentCommand(actions: AgentCommandAction[], sources: AgentObservationSources): Omit<RegisteredCommand, "name" | "sourceInfo"> {
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

	return {
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
				const choices = await metadataChoices(sources, action, argument.complete, rest, before);
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
				if (!name) return await showAgentDashboard(sources, ctx, { run: (target) => chooseDashboardAction(commands, target, ctx) });
				if (["--help", "-h"].includes(name)) return notify(overview());
				const action = find(name);
				if (!action) return notify(unknown(name));
				const result = await executeAgentAction(action, args, ctx);
				if (typeof result === "string") notify(result);
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	};
}
