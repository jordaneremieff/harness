import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { AGENT_INPUT_KIND, isInputKind } from "./input-entry.ts";
import type { AgentCommandAction, AgentActionOutcome } from "./command.ts";
import type { AgentConversationEntry, AgentConversationSummary } from "./dashboard-types.ts";
import type { AgentObservationSource } from "./agent-observation.ts";
import type { TimerListRow, TimerMode } from "./durable-timers.ts";
import { agentState, type DashboardState, type ScheduleDraft } from "./dashboard-state.ts";
import { agentDisplayName } from "./action-outcome.ts";
import { dialogSteps, ordinaryDialogs, type AgentDialogs, type DialogChoice } from "./dialog-adapter.ts";
export interface ActionDialogExtras {
	timers(id: string, ctx: ExtensionContext): Promise<readonly TimerListRow[]>;
	schedule(
		input: { sessionId: string; message: string; deliverAt: string; mode: TimerMode },
		ctx: ExtensionContext,
	): Promise<AgentActionOutcome>;
}
export interface NativeSurface {
	hide(): void;
	show(): void;
}
export async function hideAround<T>(surface: NativeSurface, action: () => Promise<T>): Promise<T> {
	surface.hide();
	try {
		return await action();
	} finally {
		surface.show();
	}
}
export function committedChoices(entries: readonly AgentConversationEntry[]): Array<{ id: string; label: string }> {
	return entries
		.filter((entry) => /^\d+$/.test(entry.id) && (isInputKind(entry.kind) || entry.kind === "pi.assistant"))
		.map((entry) => {
			const text = (entry.model ?? [])
				.flatMap((message) =>
					typeof message.content === "string"
						? [message.content]
						: message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])),
				)
				.join(" ")
				.replace(/\s+/g, " ")
				.slice(0, 100);
			return {
				id: entry.id,
				label: `${entry.kind === "pi.user" ? "You" : entry.kind === AGENT_INPUT_KIND ? "Agent input" : "Agent"}: ${text || "(no text)"} · ${entry.id}`,
			};
		});
}
function ambiguousClock(deadline: Date): boolean {
	const clock = [
		deadline.getFullYear(),
		deadline.getMonth(),
		deadline.getDate(),
		deadline.getHours(),
		deadline.getMinutes(),
	].join(":");
	for (let minutes = -120; minutes <= 120; minutes++) {
		if (!minutes) continue;
		const other = new Date(deadline.getTime() + minutes * 60000);
		if (
			[other.getFullYear(), other.getMonth(), other.getDate(), other.getHours(), other.getMinutes()].join(":") === clock
		)
			return true;
	}
	return false;
}
function localDeadline(text: string, now: number): Date {
	const time = /^(\d{2}):(\d{2})$/.exec(text.trim());
	if (!time || Number(time[1]) > 23 || Number(time[2]) > 59) throw new Error("Use HH:MM local or +30m");
	const deadline = new Date(now);
	deadline.setHours(Number(time[1]), Number(time[2]), 0, 0);
	if (deadline.getTime() <= now) deadline.setDate(deadline.getDate() + 1);
	if (ambiguousClock(deadline)) throw new Error("That local time has two offsets; use a relative time");
	if (deadline.getHours() !== Number(time[1]) || deadline.getMinutes() !== Number(time[2]))
		throw new Error("That local time does not exist; use a relative time");
	return deadline;
}
/** Local clock syntax is small and explicit; the review always shows the exact offset. */
export function scheduleDeadline(text: string, now: number): string {
	const relative = /^\+(\d+)(m|h)$/.exec(text.trim());
	const deadline = relative
		? new Date(now + Number(relative[1]) * (relative[2] === "m" ? 60000 : 3600000))
		: localDeadline(text, now);
	if (!Number.isFinite(deadline.getTime()) || deadline.getTime() <= now)
		throw new Error("The deadline must be in the future");
	return deadline.toISOString();
}
async function entryPage(source: Pick<AgentObservationSource, "snapshot" | "earlier">, id: string, preferred: string | null | undefined) {
	let page = await source.snapshot(id);
	while (preferred && !page.entries.some((entry) => entry.id === preferred) && page.nextBefore) {
		page = await source.earlier(id, page.nextBefore);
	}
	return page;
}
const LATEST = "latest";
const EARLIER = "earlier";
function entryOptions(page: { entries: readonly AgentConversationEntry[]; nextBefore?: number | null }, fork: boolean, preferred: string | null | undefined) {
	const entries = committedChoices(page.entries).reverse();
	const saved = entries.findIndex((item) => item.id === preferred);
	if (saved > 0) entries.unshift(...entries.splice(saved, 1));
	const choices: DialogChoice[] = [
		...(fork ? [{ value: LATEST, label: "Latest committed entry" }] : []),
		...entries.map((item) => ({ value: item.id, label: item.label })),
		...(page.nextBefore ? [{ value: EARLIER, label: "Earlier messages" }] : []),
	];
	return { entries, choices };
}
async function entryChoice(
	source: Pick<AgentObservationSource, "snapshot" | "earlier">,
	id: string,
	dialogs: AgentDialogs,
	fork: boolean,
	preferred?: string | null,
): Promise<string | null | undefined> {
	let page = await entryPage(source, id, preferred);
	for (;;) {
		const { entries, choices } = entryOptions(page, fork, preferred);
		const selected = await dialogs.select("Choose a committed message", choices);
		if (selected === undefined) return undefined;
		if (selected === LATEST) return null;
		if (selected === EARLIER && page.nextBefore) {
			page = { ...(await source.earlier(id, page.nextBefore)) };
			continue;
		}
		return entries.some((item) => item.id === selected) ? selected : undefined;
	}
}
export type ActionResult = string | AgentActionOutcome | undefined;
/** Everything a form needs from its host: prompts, identity, and the effects it may request. */
export interface ActionFlowHost {
	readonly dialogs: AgentDialogs;
	readonly row: AgentConversationSummary;
	readonly state: DashboardState;
	readonly source: Pick<AgentObservationSource, "snapshot" | "earlier">;
	/** Run one native action with the positional arguments of its command form. */
	run(name: string, args: string[]): Promise<ActionResult>;
	timers(): Promise<readonly TimerListRow[]>;
	schedule(input: { message: string; deliverAt: string; mode: TimerMode }): Promise<AgentActionOutcome>;
	configure(): Promise<ActionResult>;
}
const labelOf = (host: ActionFlowHost) => agentDisplayName(host.row);
/** Native input ignores placeholders, so its title shows the completed value. */
function inputField(dialogs: AgentDialogs, title: string, value: string, placeholder: string): Promise<string | undefined> {
	const hint = value ? `Saved: ${value} (blank keeps it)` : placeholder;
	return dialogs.input(`${title}\n${hint}`, { initial: value, placeholder: hint });
}
/** Blank submission retains a completed single-line value. */
async function savedInput(dialogs: AgentDialogs, title: string, value: string, placeholder: string): Promise<string | undefined> {
	const input = await inputField(dialogs, title, value, placeholder);
	return input === undefined ? undefined : input.trim() ? input : value;
}
async function branchDialog(host: ActionFlowHost, rewind: boolean): Promise<ActionResult> {
	const { source, row, dialogs } = host;
	const label = labelOf(host);
	let entry: string | null | undefined;
	let correction = "";
	const choose = async () => {
		const selected = await entryChoice(source, row.id, dialogs, !rewind, entry);
		if (selected === undefined) return false;
		entry = selected;
		return true;
	};
	if (!rewind) {
		if (!(await choose()) || entry === undefined) return undefined;
		return host.run("fork", entry === null ? [] : [entry]);
	}
	if (
		!(await dialogSteps([
			choose,
			async () => {
				const text = await dialogs.editor(`Correction for ${label}`, correction);
				if (text === undefined) return false;
				correction = text;
				return Boolean(text.trim());
			},
			() =>
				dialogs.confirm(
					`Rewind ${label}?`,
					"Source history stays. Files do not roll back. A new branch starts corrected work.",
					"Rewind",
				),
		]))
	)
		return undefined;
	if (entry === undefined || entry === null) return undefined;
	return host.run("rewind", [entry, correction]);
}
async function contextDialog(host: ActionFlowHost, reset: boolean): Promise<ActionResult> {
	const { dialogs } = host;
	const label = labelOf(host);
	let text = "";
	const description = reset
		? "History, files, settings, and timers stay. No new turn starts. Busy work resets at the next boundary."
		: "Active work stops. The conversation compacts without resuming.";
	const title = reset ? "Reset context" : "Compact";
	if (
		!(await dialogSteps([
			async () => {
				const value = await dialogs.editor(`${reset ? "Optional handoff" : "Optional instructions"} for ${label}`, text);
				if (value === undefined) return false;
				text = value;
				return true;
			},
			() => dialogs.confirm(`${title} for ${label}?`, description, title),
		]))
	)
		return undefined;
	return host.run(reset ? "reset" : "compact", text.trim() ? [text] : []);
}
/** A host that lists its native commands offers them; otherwise the operator types the name. */
async function commandName(dialogs: AgentDialogs, label: string, commands: readonly DialogChoice[] | undefined, current: string): Promise<string | undefined> {
	if (commands) {
		if (!commands.length) throw new Error("This agent's host has no native commands.");
		return dialogs.select(`Command for ${label}`, commands, current || undefined);
	}
	const value = await savedInput(dialogs, `Command for ${label}`, current, "Command name");
	return value === undefined || !value.trim() ? undefined : value;
}
async function commandDialog(host: ActionFlowHost, commands: readonly DialogChoice[] | undefined): Promise<ActionResult> {
	const { dialogs } = host;
	const label = labelOf(host);
	let command = "";
	let input = "";
	if (
		!(await dialogSteps([
			async () => {
				const picked = await commandName(dialogs, label, commands, command);
				if (picked === undefined) return false;
				command = picked;
				return true;
			},
			async () => {
				const value = await savedInput(dialogs, `Arguments for ${label}`, input, "Optional arguments");
				if (value === undefined) return false;
				input = value;
				return true;
			},
			() => dialogs.confirm(`Run ${command} on ${label}?`, "This uses the selected agent's authority.", "Run"),
		]))
	)
		return undefined;
	return host.run("command", [command, input]);
}
/** Parse the typed time into an absolute deadline and refuse one that already passed. */
async function deadlineStep(dialogs: AgentDialogs, draft: ScheduleDraft): Promise<boolean> {
	const time = await inputField(dialogs, "Deadline", draft.time, "HH:MM local or +30m");
	if (time === undefined) return false;
	if (time.trim()) {
		draft.time = time.trim();
		draft.deadline = undefined;
	}
	draft.deadline ??= scheduleDeadline(draft.time, Date.now());
	if (Date.parse(draft.deadline) <= Date.now()) throw new Error("The saved deadline passed. Enter a new deadline.");
	return true;
}
async function dispositionStep(dialogs: AgentDialogs, draft: ScheduleDraft): Promise<boolean> {
	const modes: DialogChoice[] = [{ value: "followUp", label: "Follow-up" }, { value: "steer", label: "Steer" }];
	const mode = await dialogs.select("Busy disposition", modes, draft.mode);
	if (!mode) return false;
	draft.mode = mode === "steer" ? "steer" : "followUp";
	return true;
}
async function scheduleDialog(host: ActionFlowHost): Promise<ActionResult> {
	const { dialogs, row, state } = host;
	const label = labelOf(host);
	const record = agentState(state, row.id);
	record.schedule ??= { message: "", time: "", mode: "followUp" };
	const draft: ScheduleDraft = record.schedule;
	const reviewed = await dialogSteps([
		async () => {
			const message = await dialogs.editor(`Scheduled message to ${label}`, draft.message);
			if (message === undefined) return false;
			draft.message = message;
			return Boolean(message.trim());
		},
		() => deadlineStep(dialogs, draft),
		() => dispositionStep(dialogs, draft),
		async () => draft.deadline !== undefined && dialogs.confirm(
			`Schedule for ${label}?`,
			`${new Date(draft.deadline).toString()}\n${draft.deadline}\n${draft.mode === "steer" ? "Steer" : "Follow-up"}. The host must run at the deadline.`,
			"Schedule",
		),
	]);
	if (!reviewed || !draft.deadline) return undefined;
	const result = await host.schedule({ message: draft.message, deliverAt: draft.deadline, mode: draft.mode });
	record.schedule = undefined;
	return result;
}
async function timersDialog(host: ActionFlowHost): Promise<ActionResult> {
	const { dialogs } = host;
	const label = labelOf(host);
	const timers = await host.timers();
	if (!timers.length) return `No scheduled messages for ${label}`;
	const choices: DialogChoice[] = timers.map((timer) => ({
		value: String(timer.timerId),
		label: `${new Date(timer.deadline).toLocaleString()} · ${timer.status} · ${timer.messagePreview} · #${timer.timerId}`,
	}));
	let choice: string | undefined;
	if (
		!(await dialogSteps([
			async () => {
				const selected = await dialogs.select(`Scheduled messages for ${label}`, choices, choice);
				if (selected === undefined) return false;
				choice = selected;
				return choices.some((item) => item.value === selected);
			},
			() =>
				dialogs.confirm(
					`Cancel message for ${label}?`,
					`${choices.find((item) => item.value === choice)?.label}\nA fired message stays unchanged.`,
					"Cancel scheduled message",
				),
		]))
	)
		return undefined;
	const timer = timers.find((item) => String(item.timerId) === choice);
	if (!timer) return undefined;
	return host.run("timer-cancel", [String(timer.timerId)]);
}
async function stopDialog(host: ActionFlowHost): Promise<ActionResult> {
	const label = labelOf(host);
	if (!(await host.dialogs.confirm(`Stop ${label}?`, "History stays. Background work is not included.", "Stop current work"))) return undefined;
	return host.run("abort", []);
}
async function reconnectDialog(host: ActionFlowHost): Promise<ActionResult> {
	if (!(await host.dialogs.confirm(`Reconnect ${labelOf(host)}?`, "Retained unfinished work resumes.", "Reconnect"))) return undefined;
	return host.run("attach", []);
}
async function awaitReleaseDialog(host: ActionFlowHost): Promise<ActionResult> {
	const runId = host.row.awaiting?.runId;
	if (runId === undefined) return undefined;
	if (!(await host.dialogs.confirm(`Release await for ${labelOf(host)}?`, "The original request resumes with partial results. Producers stay active.", "Release await"))) return undefined;
	return host.run("await-release", [String(runId)]);
}
/** Run one operator form against its host. `commands` lists selectable native commands when the host knows them. */
export function runActionFlow(name: string, host: ActionFlowHost, commands?: readonly DialogChoice[]): Promise<ActionResult> {
	const flows: Record<string, () => Promise<ActionResult>> = {
		configure: () => host.configure(),
		fork: () => branchDialog(host, false),
		rewind: () => branchDialog(host, true),
		reset: () => contextDialog(host, true),
		compact: () => contextDialog(host, false),
		command: () => commandDialog(host, commands),
		schedule: () => scheduleDialog(host),
		timers: () => timersDialog(host),
		"await-release": () => awaitReleaseDialog(host),
		abort: () => stopDialog(host),
		attach: () => reconnectDialog(host),
	};
	return flows[name] ? flows[name]() : host.run(name, []);
}
export async function runActionDialog(
	name: string,
	row: AgentConversationSummary,
	ctx: ExtensionContext,
	actions: readonly AgentCommandAction[],
	source: AgentObservationSource,
	extras: ActionDialogExtras,
	state: DashboardState,
): Promise<ActionResult> {
	return runActionFlow(name, {
		dialogs: ordinaryDialogs(ctx), row, state, source,
		run: (action, args) => {
			const found = actions.find((item) => item.name === action);
			if (!found) throw new Error(`Action unavailable: ${action}`);
			return found.run([row.id, ...args], ctx);
		},
		timers: () => extras.timers(row.id, ctx),
		schedule: (input) => extras.schedule({ sessionId: row.id, ...input }, ctx),
		configure: async () => actions.find((item) => item.name === "configure")?.dialog?.(row, ctx),
	});
}
