import { basename } from "node:path";
import { stripVTControlCharacters } from "node:util";
import type { ExtensionContext, RegisteredCommand } from "@earendil-works/pi-coding-agent";
import { fuzzyFilter, type AutocompleteItem } from "@earendil-works/pi-tui";
import type { DashboardState } from "./dashboard-state.ts";
import type { DashboardPreferences } from "./dashboard-preferences.ts";
import { randomUUID } from "node:crypto";
import type { JsonValue } from "../../operator-ui/index.ts";
import type { ToolDisplayLookup } from "./tool-display.ts";
import type { DashboardOperations, DashboardResult, NewAgentDefaults } from "./dashboard.ts";
import type { EffortAwareness } from "./effort-awareness.ts";
import type { AgentObservationSource } from "./agent-observation.ts";
import type { AgentFormHost, ActionResult } from "./agent-forms.ts";
import type { ProfileDraft } from "./profile-dialog.ts";
import type { TimerListRow, TimerMode } from "./durable-timers.ts";
import type { AgentConversationPage, AgentConversationSummary, AgentObservationSources } from "./dashboard-types.ts";
import { actionOutcomeText, agentDisplayName, outcomeSessionId } from "./action-outcome.ts";

interface DashboardRuntime {
	readonly showAgentDashboard: typeof import("./dashboard.ts").showAgentDashboard;
	readonly dashboardSessionState: typeof import("./dashboard-state.ts").dashboardSessionState;
	readonly readAgentBranch: typeof import("./agent-git.ts").readAgentBranch;
}

let dashboardRuntimePromise: Promise<DashboardRuntime> | undefined;
function loadDashboardRuntime(): Promise<DashboardRuntime> {
	dashboardRuntimePromise ??= Promise.all([
		import("./dashboard.ts"),
		import("./dashboard-state.ts"),
		import("./agent-git.ts"),
	]).then(([dashboard, state, git]) => ({
		showAgentDashboard: dashboard.showAgentDashboard,
		dashboardSessionState: state.dashboardSessionState,
		readAgentBranch: git.readAgentBranch,
	}));
	return dashboardRuntimePromise;
}

let panelModulesPromise: Promise<typeof import("./panel-modules.ts")> | undefined;
function loadPanelModulesRuntime(): Promise<typeof import("./panel-modules.ts")> {
	panelModulesPromise ??= import("./panel-modules.ts");
	return panelModulesPromise;
}

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

/** Ordinary routes the work view uses beyond the text actions. */
export interface AgentViewWiring {
	timers(id: string, ctx: ExtensionContext): Promise<readonly TimerListRow[]>;
	schedule(input: { sessionId: string; message: string; deliverAt: string; mode: TimerMode }, ctx: ExtensionContext): Promise<AgentActionOutcome>;
	/** One native control with this session as the caller. `signal` withdraws the wait for the answer. */
	control(method: string, input: Record<string, unknown>, ctx: ExtensionContext, signal?: AbortSignal): Promise<unknown>;
	newAgent(input: { prompt?: string; preset?: string; cwd?: string }, ctx: ExtensionContext, onCreated: (row: AgentConversationSummary) => void): Promise<AgentActionOutcome>;
	newDefaults(ctx: ExtensionContext): NewAgentDefaults;
}

/** Actions whose form opens in the work view when a TUI command names a target without its other arguments. */
const VIEW_ACTIONS = new Set(["configure", "fork", "rewind", "compact", "reset", "command", "schedule", "timers", "profile", "abort", "attach", "timer-cancel"]);

/** The form a command opens: cancelling one scheduled message starts from the list of them. */
const formName = (name: string) => (name === "timer-cancel" ? "timers" : name);

/** A TUI command that names a target but not its other arguments opens that target's form instead. */
function opensForm(action: AgentCommandAction, args: string[]): boolean {
	if (!args[0] || !VIEW_ACTIONS.has(action.name)) return false;
	return action.name === "profile" || argumentHelp(action, args) !== undefined;
}

/** The owner's stated reason for a refused request, bounded for one line. */
function failureReason(result: { reason?: unknown; error?: unknown }): string {
	const reason = typeof result.reason === "string" ? result.reason : typeof result.error === "string" ? result.error : "";
	return reason ? `: ${reason.slice(0, 200)}` : "";
}

export interface AgentCommandAction {
	name: string;
	description: string;
	args: CommandArgument[];
	help?: string;
	confirm?: string;
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
	wiring: AgentViewWiring,
	collaborate?: (input: Record<string, unknown>, ctx: ExtensionContext) => Promise<unknown>,
	sessionFigures?: (ctx: ExtensionContext, page: AgentConversationPage) => Promise<string>,
	effortWiring?: {
		efforts(ctx: ExtensionContext): Promise<EffortAwareness>;
		messageEffort(id: string, text: string, ctx: ExtensionContext): Promise<DashboardResult>;
		observeEffort?(id: string, ctx?: ExtensionContext): Promise<string>;
	},
	preferences?: DashboardPreferences,
	readHideThinkingBlock?: () => boolean,
	toolDisplay?: ToolDisplayLookup,
	taskTargets?: (ctx: ExtensionContext) => readonly string[],
	readLineage?: (id: string, ctx: ExtensionContext) => Promise<unknown>,
): Omit<RegisteredCommand, "name" | "sourceInfo"> & { openDashboard(ctx: ExtensionContext, open?: { select?: string; action?: string }): Promise<void> } {
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
	const relationOperations = (ctx: ExtensionContext) => ({
		taskTargets: taskTargets ? () => taskTargets(ctx) : undefined,
		readLineage: readLineage ? (id: string) => readLineage(id, ctx) : undefined,
	});
	const profileDrafts = new Map<string, ProfileDraft>();
	/** A listed identity or handle selects its row; anything else stays the exact typed target. */
	const listedTarget = (target: string) => sources.list().then((page) => page.rows.find((row) => row.id === target || row.profile?.handle === target)?.id ?? target, () => target);
	/** Native commands the target's live host lists; a host that is not live leaves the name typed. */
	const nativeCommands = async (id: string, ctx: ExtensionContext) => {
		const status = (await wiring.control("status", { sessionId: id }, ctx)) as { inventory?: { contributions?: Array<{ commands?: Array<{ name: string; description: string }> }> } };
		if (!status?.inventory) return undefined;
		const commands = status.inventory.contributions?.flatMap((contribution) => contribution.commands ?? []) ?? [];
		return [...commands.map((command) => ({ value: command.name, label: command.name, description: command.description })), { value: "reload", label: "reload", description: "Reload host registrations (needs an idle storage)" }];
	};
	const formsHost = (ctx: ExtensionContext, state: DashboardState) => (row: AgentConversationSummary): AgentFormHost => ({
		row,
		state,
		source: sources,
		run: async (name, args) => {
			const [action, rest] = name === "release" ? ["abort", ["release"]] : [name, args];
			return requireAction(action).run([row.id, ...rest], ctx);
		},
		timers: () => wiring.timers(row.id, ctx),
		schedule: (input) => wiring.schedule({ sessionId: row.id, ...input }, ctx),
		models: async () => ctx.modelRegistry.getAvailable().map((model) => ({ identity: `${model.provider}/${model.id}`, name: model.name })),
		configure: async (patch): Promise<ActionResult> => {
			const result = (await wiring.control("configure", { sessionId: row.id, ...patch }, ctx)) as { outcome?: string; reason?: unknown; error?: unknown };
			const label = agentDisplayName(row);
			if (result?.outcome === "failed") throw new Error(`Configuration failed for “${label}”${failureReason(result)}`);
			return { text: `Updated configuration for “${label}”`, sessionId: row.id };
		},
		commands: () => nativeCommands(row.id, ctx),
		profile: (method, input) => wiring.control(method, input, ctx),
		profileDrafts,
		status: (signal) => wiring.control("status", { sessionId: row.id }, ctx, signal),
		inspect: (params, signal) => wiring.control("inspect", params, ctx, signal),
		outcome: () => {},
	});
	const panels = (ctx: ExtensionContext) => async (row: AgentConversationSummary) => {
		const status = (await wiring.control("status", { sessionId: row.id }, ctx)) as { inventory?: unknown };
		if (status?.inventory === undefined) return [];
		// Owner views load with their first use, like the work view itself.
		const { loadPanelModules, panelDestinations } = await loadPanelModulesRuntime();
		const loaded = await loadPanelModules(status.inventory);
		return panelDestinations(loaded, row.id, async (command, data: JsonValue, signal) => {
			const answer = (await wiring.control("command", { sessionId: row.id, name: command, data, origin: "operator", invocationId: randomUUID() }, ctx, signal)) as { text?: unknown; data?: JsonValue };
			if (typeof answer?.text !== "string") throw new Error("The host answered without command text");
			return { text: answer.text, ...(answer.data === undefined ? {} : { data: answer.data }) };
		});
	};
	const openDashboard = async (ctx: ExtensionContext, open: { select?: string; action?: string } = {}): Promise<void> => {
		if (!ctx.hasUI || dashboardOpen) return;
		dashboardOpen = true;
		try {
			const { showAgentDashboard, dashboardSessionState, readAgentBranch } = await loadDashboardRuntime();
			const state = dashboardSessionState(ctx.sessionManager.getSessionId(), preferences?.load);
			state.hideThinkingBlock = readHideThinkingBlock?.() ?? false;
			const operations: DashboardOperations = {
				toolDisplay,
				saveLayout: preferences ? (layout) => preferences.save(layout) : undefined,
				efforts: effortWiring ? () => effortWiring.efforts(ctx) : undefined,
				messageEffort: effortWiring ? (id, text) => effortWiring.messageEffort(id, text, ctx) : undefined,
				observeEffort: observationFor(ctx),
				sessionFigures: sessionFigures ? (page) => sessionFigures(ctx, page) : undefined,
				modelInfo: (provider, modelId) => ctx.modelRegistry?.find(provider, modelId),
				branch: readAgentBranch,
				collaborate: collaborate ? (input) => collaborate(input, ctx) : undefined,
				...relationOperations(ctx),
				submit: async ({ id, text, mode }) => {
					const result = await executeAgentAction(requireAction(mode === "steer" ? "steer" : "send"), [id, text], ctx);
					return { text: actionOutcomeText(result) ?? "Message admitted", sessionId: id };
				},
				newAgent: async ({ prompt, preset, cwd, onCreated }) => {
					const result = await wiring.newAgent({ prompt, preset, cwd }, ctx, onCreated);
					return { text: result.text, sessionId: result.sessionId };
				},
				newDefaults: () => wiring.newDefaults(ctx),
				forms: formsHost(ctx, state),
				panels: panels(ctx),
			};
			await showAgentDashboard({
				ctx,
				state,
				source: { ...sources, list: (input) => sources.list({ ...input, ownerId: ctx.sessionManager.getSessionId() }) },
				operations,
				...open,
			});
		} finally {
			dashboardOpen = false;
		}
	};
	/** Help, an action's result text, or a form in the work view when a TUI command names only its target. */
	const dispatch = async (name: string, args: string[], ctx: ExtensionContext): Promise<string | undefined> => {
		if (["--help", "-h"].includes(name)) return overview();
		const action = find(name);
		if (!action) return unknown(name);
		if (ctx.mode === "tui" && opensForm(action, args)) {
			await openDashboard(ctx, { select: await listedTarget(args[0] ?? ""), action: formName(action.name) });
			return undefined;
		}
		return displayResult(await executeAgentAction(action, args, ctx), sources);
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
			try {
				if (!name) return await openDashboard(ctx);
				const text = await dispatch(name, args, ctx);
				if (text !== undefined) ctx.ui.notify(text, "info");
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	};
}
