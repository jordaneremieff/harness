import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentCommandAction, AgentActionOutcome } from "./command.ts";
import type { AgentConversationEntry, AgentConversationSummary } from "./dashboard-types.ts";
import type { AgentObservationSource } from "./agent-observation.ts";
import type { TimerListRow, TimerMode } from "./durable-timers.ts";
import { agentState, type DashboardState, type ScheduleDraft } from "./dashboard-state.ts";
import { agentDisplayName } from "./action-outcome.ts";
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
		.filter((entry) => /^\d+$/.test(entry.id) && (entry.kind === "pi.user" || entry.kind === "pi.assistant"))
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
				label: `${entry.kind === "pi.user" ? "You" : "Agent"}: ${text || "(no text)"} · ${entry.id}`,
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
async function confirm(ctx: ExtensionContext, title: string, description: string, action: string): Promise<boolean> {
	return (await ctx.ui.select(`${title}\n${description}`, ["Cancel", action])) === action;
}
async function entryChoice(
	source: AgentObservationSource,
	id: string,
	ctx: ExtensionContext,
	fork: boolean,
): Promise<string | null | undefined> {
	let page = await source.snapshot(id);
	for (;;) {
		const choices = committedChoices(page.entries).reverse();
		const labels = [
			...(fork ? ["Latest committed entry"] : []),
			...choices.map((item) => item.label),
			...(page.nextBefore ? ["Earlier messages"] : []),
		];
		const selected = await ctx.ui.select("Choose a committed message", labels);
		if (selected === undefined) return undefined;
		if (selected === "Latest committed entry") return null;
		if (selected === "Earlier messages" && page.nextBefore) {
			const older = await source.earlier(id, page.nextBefore);
			page = { ...older };
			continue;
		}
		return choices.find((item) => item.label === selected)?.id;
	}
}
interface DialogContext {
	state: DashboardState;
	row: AgentConversationSummary;
	ctx: ExtensionContext;
	actions: readonly AgentCommandAction[];
	source: AgentObservationSource;
	extras: ActionDialogExtras;
	label: string;
}
async function runNative(
	context: DialogContext,
	name: string,
	args: string[] = [],
): Promise<string | AgentActionOutcome | undefined> {
	const action = context.actions.find((item) => item.name === name);
	if (!action) throw new Error(`Action unavailable: ${name}`);
	return action.run([context.row.id, ...args], context.ctx);
}
async function branchDialog(context: DialogContext, rewind: boolean): Promise<string | AgentActionOutcome | undefined> {
	const { source, row, ctx, label } = context;
	const entry = await entryChoice(source, row.id, ctx, !rewind);
	if (entry === undefined) return undefined;
	const args = entry === null ? [] : [entry];
	if (!rewind) return runNative(context, "fork", args);
	const correction = await ctx.ui.editor(`Correction for ${label}`);
	if (!correction?.trim()) return undefined;
	if (
		!(await confirm(
			ctx,
			`Rewind ${label}?`,
			"Source history stays. Files do not roll back. A new branch starts corrected work.",
			"Rewind",
		))
	)
		return undefined;
	return runNative(context, "rewind", [...args, correction]);
}
async function contextDialog(context: DialogContext, reset: boolean): Promise<string | AgentActionOutcome | undefined> {
	const { ctx, label } = context;
	const text = await ctx.ui.editor(`${reset ? "Optional handoff" : "Optional instructions"} for ${label}`);
	if (text === undefined) return undefined;
	const description = reset
		? "History, files, settings, and timers stay. No new turn starts. Busy work resets at the next boundary."
		: "Active work stops. The conversation compacts without resuming.";
	const title = reset ? "Reset context" : "Compact";
	if (!(await confirm(ctx, `${title} for ${label}?`, description, title))) return undefined;
	return runNative(context, reset ? "reset" : "compact", text.trim() ? [text] : []);
}
async function commandDialog(context: DialogContext): Promise<string | AgentActionOutcome | undefined> {
	const { ctx, label } = context;
	const command = await ctx.ui.input(`Command for ${label}`, "Command name");
	if (!command?.trim()) return undefined;
	const input = await ctx.ui.input(`Arguments for ${label}`, "Optional arguments");
	if (input === undefined) return undefined;
	if (!(await confirm(ctx, `Run ${command} on ${label}?`, "This uses the selected agent's authority.", "Run")))
		return undefined;
	return runNative(context, "command", [command, input]);
}
async function collectSchedule(context: DialogContext): Promise<ScheduleDraft | undefined> {
	const { ctx, row, label, state } = context;
	const record = agentState(state, row.id);
	record.schedule ??= { message: "", time: "", mode: "followUp" };
	const draft = record.schedule;
	const message = await ctx.ui.editor(`Scheduled message to ${label}`, draft.message);
	if (message === undefined) return undefined;
	draft.message = message;
	if (!message.trim()) return undefined;
	const time = await ctx.ui.input(
		draft.time ? `Deadline (saved ${draft.time}; blank keeps it)` : "Deadline",
		draft.time || "HH:MM local or +30m",
	);
	if (time === undefined) return undefined;
	if (time.trim()) {
		draft.time = time.trim();
		draft.deadline = undefined;
	}
	draft.deadline ??= scheduleDeadline(draft.time, Date.now());
	if (Date.parse(draft.deadline) <= Date.now()) throw new Error("The saved deadline passed. Enter a new deadline.");
	const modes = draft.mode === "steer" ? ["Steer", "Follow-up"] : ["Follow-up", "Steer"];
	const mode = await ctx.ui.select("Busy disposition", modes);
	if (!mode) return undefined;
	draft.mode = mode === "Steer" ? "steer" : "followUp";
	return draft;
}
async function scheduleDialog(context: DialogContext): Promise<string | AgentActionOutcome | undefined> {
	const { ctx, row, extras, label, state } = context;
	const draft = await collectSchedule(context);
	if (!draft?.deadline) return undefined;
	const mode = draft.mode === "steer" ? "Steer" : "Follow-up";
	if (
		!(await confirm(
			ctx,
			`Schedule for ${label}?`,
			`${new Date(draft.deadline).toString()}\n${draft.deadline}\n${mode}. The host must run at the deadline.`,
			"Schedule",
		))
	)
		return undefined;
	const record = agentState(state, row.id);
	const result = await extras.schedule(
		{ sessionId: row.id, message: draft.message, deliverAt: draft.deadline, mode: draft.mode },
		ctx,
	);
	record.schedule = undefined;
	return result;
}
async function timersDialog(context: DialogContext): Promise<string | AgentActionOutcome | undefined> {
	const { ctx, row, extras, label } = context;
	const timers = await extras.timers(row.id, ctx);
	if (!timers.length) return `No scheduled messages for ${label}`;
	const labels = timers.map(
		(timer) =>
			`${new Date(timer.deadline).toLocaleString()} · ${timer.status} · ${timer.messagePreview} · #${timer.timerId}`,
	);
	const choice = await ctx.ui.select(`Scheduled messages for ${label}`, labels);
	if (choice === undefined) return undefined;
	const timer = timers[labels.indexOf(choice)];
	if (!timer) return undefined;
	if (
		!(await confirm(
			ctx,
			`Cancel message for ${label}?`,
			`${choice}\nA fired message stays unchanged.`,
			"Cancel scheduled message",
		))
	)
		return undefined;
	return runNative(context, "timer-cancel", [String(timer.timerId)]);
}
async function stopDialog(context: DialogContext): Promise<string | AgentActionOutcome | undefined> {
	if (
		!(await confirm(
			context.ctx,
			`Stop ${context.label}?`,
			"History stays. Background work is not included.",
			"Stop current work",
		))
	)
		return undefined;
	return runNative(context, "abort");
}
async function reconnectDialog(context: DialogContext): Promise<string | AgentActionOutcome | undefined> {
	if (!(await confirm(context.ctx, `Reconnect ${context.label}?`, "Retained unfinished work resumes.", "Reconnect")))
		return undefined;
	return runNative(context, "attach");
}
export async function runActionDialog(
	name: string,
	row: AgentConversationSummary,
	ctx: ExtensionContext,
	actions: readonly AgentCommandAction[],
	source: AgentObservationSource,
	extras: ActionDialogExtras,
	state: DashboardState,
): Promise<string | AgentActionOutcome | undefined> {
	const context: DialogContext = { row, ctx, actions, source, extras, state, label: agentDisplayName(row) };
	const flows: Record<string, () => Promise<string | AgentActionOutcome | undefined>> = {
		configure: async () => actions.find((item) => item.name === "configure")?.dialog?.(row, ctx),
		fork: () => branchDialog(context, false),
		rewind: () => branchDialog(context, true),
		reset: () => contextDialog(context, true),
		compact: () => contextDialog(context, false),
		command: () => commandDialog(context),
		schedule: () => scheduleDialog(context),
		timers: () => timersDialog(context),
		abort: () => stopDialog(context),
		attach: () => reconnectDialog(context),
	};
	return flows[name] ? flows[name]() : runNative(context, name);
}
