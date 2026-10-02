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
async function entryPage(source: AgentObservationSource, id: string, preferred: string | null | undefined) {
	let page = await source.snapshot(id);
	while (preferred && !page.entries.some((entry) => entry.id === preferred) && page.nextBefore) {
		page = await source.earlier(id, page.nextBefore);
	}
	return page;
}
async function entryChoice(
	source: AgentObservationSource,
	id: string,
	ctx: ExtensionContext,
	fork: boolean,
	preferred?: string | null,
): Promise<string | null | undefined> {
	let page = await entryPage(source, id, preferred);
	for (;;) {
		const choices = committedChoices(page.entries).reverse();
		const saved = choices.findIndex((item) => item.id === preferred);
		if (saved > 0) choices.unshift(...choices.splice(saved, 1));
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
/** A cancelled step goes back once; cancellation at the first step leaves the action. */
async function formSteps(steps: readonly (() => Promise<boolean>)[]): Promise<boolean> {
	for (let step = 0; step < steps.length; ) {
		if (await steps[step]?.()) step++;
		else if (step === 0) return false;
		else step--;
	}
	return true;
}
/** Native input ignores placeholders, so its title shows the completed value. */
function inputField(
	ctx: ExtensionContext,
	title: string,
	value: string,
	placeholder: string,
): Promise<string | undefined> {
	const hint = value ? `Saved: ${value} (blank keeps it)` : placeholder;
	return ctx.ui.input(`${title}\n${hint}`, hint);
}
/** Blank submission retains a completed single-line value. */
async function savedInput(
	ctx: ExtensionContext,
	title: string,
	value: string,
	placeholder: string,
): Promise<string | undefined> {
	const input = await inputField(ctx, title, value, placeholder);
	return input === undefined ? undefined : input.trim() ? input : value;
}
async function branchDialog(context: DialogContext, rewind: boolean): Promise<string | AgentActionOutcome | undefined> {
	const { source, row, ctx, label } = context;
	let entry: string | null | undefined;
	let correction = "";
	const choose = async () => {
		const selected = await entryChoice(source, row.id, ctx, !rewind, entry);
		if (selected === undefined) return false;
		entry = selected;
		return true;
	};
	if (!rewind) {
		if (!(await choose()) || entry === undefined) return undefined;
		return runNative(context, "fork", entry === null ? [] : [entry]);
	}
	if (
		!(await formSteps([
			choose,
			async () => {
				const text = await ctx.ui.editor(`Correction for ${label}`, correction);
				if (text === undefined) return false;
				correction = text;
				return Boolean(text.trim());
			},
			() =>
				confirm(
					ctx,
					`Rewind ${label}?`,
					"Source history stays. Files do not roll back. A new branch starts corrected work.",
					"Rewind",
				),
		]))
	)
		return undefined;
	if (entry === undefined || entry === null) return undefined;
	return runNative(context, "rewind", [entry, correction]);
}
async function contextDialog(context: DialogContext, reset: boolean): Promise<string | AgentActionOutcome | undefined> {
	const { ctx, label } = context;
	let text = "";
	const description = reset
		? "History, files, settings, and timers stay. No new turn starts. Busy work resets at the next boundary."
		: "Active work stops. The conversation compacts without resuming.";
	const title = reset ? "Reset context" : "Compact";
	if (
		!(await formSteps([
			async () => {
				const value = await ctx.ui.editor(`${reset ? "Optional handoff" : "Optional instructions"} for ${label}`, text);
				if (value === undefined) return false;
				text = value;
				return true;
			},
			() => confirm(ctx, `${title} for ${label}?`, description, title),
		]))
	)
		return undefined;
	return runNative(context, reset ? "reset" : "compact", text.trim() ? [text] : []);
}
async function commandDialog(context: DialogContext): Promise<string | AgentActionOutcome | undefined> {
	const { ctx, label } = context;
	let command = "";
	let input = "";
	if (
		!(await formSteps([
			async () => {
				const value = await savedInput(ctx, `Command for ${label}`, command, "Command name");
				if (value === undefined || !value.trim()) return false;
				command = value;
				return true;
			},
			async () => {
				const value = await savedInput(ctx, `Arguments for ${label}`, input, "Optional arguments");
				if (value === undefined) return false;
				input = value;
				return true;
			},
			() => confirm(ctx, `Run ${command} on ${label}?`, "This uses the selected agent's authority.", "Run"),
		]))
	)
		return undefined;
	return runNative(context, "command", [command, input]);
}
async function scheduleDialog(context: DialogContext): Promise<string | AgentActionOutcome | undefined> {
	const { ctx, row, extras, label, state } = context;
	const record = agentState(state, row.id);
	record.schedule ??= { message: "", time: "", mode: "followUp" };
	const draft: ScheduleDraft = record.schedule;
	if (
		!(await formSteps([
			async () => {
				const message = await ctx.ui.editor(`Scheduled message to ${label}`, draft.message);
				if (message === undefined) return false;
				draft.message = message;
				return Boolean(message.trim());
			},
			async () => {
				const time = await inputField(ctx, "Deadline", draft.time, "HH:MM local or +30m");
				if (time === undefined) return false;
				if (time.trim()) {
					draft.time = time.trim();
					draft.deadline = undefined;
				}
				draft.deadline ??= scheduleDeadline(draft.time, Date.now());
				if (Date.parse(draft.deadline) <= Date.now())
					throw new Error("The saved deadline passed. Enter a new deadline.");
				return true;
			},
			async () => {
				const modes = draft.mode === "steer" ? ["Steer", "Follow-up"] : ["Follow-up", "Steer"];
				const mode = await ctx.ui.select("Busy disposition", modes);
				if (!mode) return false;
				draft.mode = mode === "Steer" ? "steer" : "followUp";
				return true;
			},
			async () => {
				if (!draft.deadline) return false;
				return confirm(
					ctx,
					`Schedule for ${label}?`,
					`${new Date(draft.deadline).toString()}\n${draft.deadline}\n${draft.mode === "steer" ? "Steer" : "Follow-up"}. The host must run at the deadline.`,
					"Schedule",
				);
			},
		]))
	)
		return undefined;
	if (!draft.deadline) return undefined;
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
	let choice: string | undefined;
	if (
		!(await formSteps([
			async () => {
				const selected = await ctx.ui.select(
					`Scheduled messages for ${label}`,
					choice ? [choice, ...labels.filter((item) => item !== choice)] : labels,
				);
				if (selected === undefined) return false;
				choice = selected;
				return labels.includes(selected);
			},
			() =>
				confirm(
					ctx,
					`Cancel message for ${label}?`,
					`${choice}\nA fired message stays unchanged.`,
					"Cancel scheduled message",
				),
		]))
	)
		return undefined;
	const timer = timers[labels.indexOf(choice ?? "")];
	if (!timer) return undefined;
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
