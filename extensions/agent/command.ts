import { basename } from "node:path";
import { stripVTControlCharacters } from "node:util";
import type { ExtensionCommandContext, RegisteredCommand } from "@earendil-works/pi-coding-agent";
import { fuzzyFilter, type AutocompleteItem } from "@earendil-works/pi-tui";
import type { DetachedRunView } from "./detached.ts";

export interface AgentSessionSummary {
	sessionId: string;
	name?: string;
	cwd: string;
	modifiedAt: number;
	live: boolean;
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
	run(args: string[], ctx: ExtensionCommandContext): Promise<string | undefined>;
}

interface CommandSources {
	sessions(): Promise<AgentSessionSummary[]>;
	runs(): Promise<DetachedRunView[]>;
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

/** The same actions own execution, argument validation, help, and native completion. */
export function createAgentCommand(actions: AgentCommandAction[], sources: CommandSources): Omit<RegisteredCommand, "name" | "sourceInfo"> {
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
		run: async (args) => args[0] ? (find(args[0]) ? actionHelp(find(args[0])!) : unknown(args[0])) : overview(),
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
			if (!action) return null;
			const rest = split[2];
			const argument = action.args[0];
			if (!argument?.complete) return null;
			const before = `${split[1]} `;
			if (argument.complete === "command") return /\s/.test(rest) ? null : actionItems(rest, before);
			const query = rest.trim();
			const firstWord = rest.split(/\s+/, 1)[0];
			const afterId = /\s/.test(rest);
			const suffix = action.args.length > 1 ? " " : "";
			try {
				let choices: Array<AutocompleteItem & { search: string }>;
				if (argument.complete === "run") {
					const runs = await sources.runs();
					if (afterId && runs.some((run) => run.runId === firstWord)) return null;
					choices = runs.map((run) => ({
						value: `${before}${run.runId}${suffix}`,
						label: `${plain(run.prompt).slice(0, 60) || "Detached run"} (${run.runId.slice(0, 8)})`,
						description: `${run.state} · ${plain(run.cwd)} · ${run.startedAt}`,
						search: `${run.runId} ${plain(run.prompt)} ${plain(run.cwd)}`,
					}));
				} else {
					const sessions = await sources.sessions();
					// An exact ID ends selection. Later words belong to the message or correction.
					if (afterId && sessions.some((row) => row.sessionId === firstWord)) return null;
					const label = (row: AgentSessionSummary) => plain(row.name ?? "") || `Session in ${plain(basename(row.cwd)) || "/"}`;
					choices = sessions.filter((row) => !row.detachedRunId || argument.complete === "session-control").reverse().map((row) => {
						const title = label(row);
						const duplicates = sessions.filter((other) => label(other) === title);
						const id = duplicates.some((other) => other.sessionId !== row.sessionId && other.sessionId.slice(0, 8) === row.sessionId.slice(0, 8)) ? row.sessionId : row.sessionId.slice(0, 8);
						const state = row.detachedRunId ? "Detached run; owner control" : row.operation ? "Active work" : row.live ? "Open session" : "Stored session";
						return {
							value: `${before}${row.sessionId}${suffix}`,
							label: duplicates.length > 1 || !row.name ? `${title} (${id})` : title,
							description: `${state} · ${plain(row.cwd)} · ${new Date(row.modifiedAt).toISOString()}`,
							search: `${row.sessionId} ${title} ${plain(row.cwd)}`,
						};
					});
				}
				return fuzzyFilter(choices, query, (item) => item.search).map(({ search: _search, ...item }) => item);
			} catch {
				// Completion has no error channel. Invocation reports store and ownership errors.
				return null;
			}
		},
		async handler(input, ctx) {
			const [name, ...args] = input.trim().split(/\s+/);
			const notify = (text: string) => ctx.ui.notify(text, "info");
			try {
				if (!name) return notify(overview());
				if (name === "--help" || name === "-h") return notify(overview());
				const action = find(name);
				if (!action) return notify(unknown(name));
				if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) return notify(actionHelp(action));
				const required = action.args.filter((arg) => !arg.optional).length;
				if (args.length < required) return notify(`Missing ${action.args[args.length].name}.\n${actionHelp(action)}`);
				if (!action.args.some((arg) => arg.rest) && args.length > action.args.length) return notify(`Too many arguments.\n${actionHelp(action)}`);
				const result = await action.run(args, ctx);
				if (typeof result === "string") notify(result);
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	};
}
