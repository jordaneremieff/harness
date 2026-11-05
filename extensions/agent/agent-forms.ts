/**
 * Staged forms and readers for agent actions, shown in the work view's inspector beside the
 * conversation. Each form binds to the target captured when it opened, keeps every staged field
 * after a refusal, and calls its owner once on the effect-labelled action. Cancel sends nothing.
 * Ordinary Pi and the attached terminal supply the same host interface with their own routes.
 */

import { type Choice, Form, LoadingView, type OperatorView, plainLine, ReaderView, type ViewHost } from "../../operator-ui/index.ts";
import type { AgentActionOutcome } from "./command.ts";
import { AGENT_INPUT_KIND, isInputKind } from "./input-entry.ts";
import type { AgentConversationEntry, AgentConversationSummary } from "./dashboard-types.ts";
import type { AgentObservationSource } from "./agent-observation.ts";
import type { TimerListRow, TimerMode } from "./durable-timers.ts";
import { agentState, type DashboardState } from "./dashboard-state.ts";
import { agentDisplayName } from "./action-outcome.ts";
import { THINKING_LEVELS, validateConfigurationPatch, type ConfigurationPatch } from "./configuration.ts";
import { profileText, readValue, type ProfileDraft } from "./profile-dialog.ts";
import { matchesSchema } from "./schema-check.ts";
import { ProfileUpdateSchema, type AgentProfile } from "./profile-schema.ts";

export type ActionResult = string | AgentActionOutcome | undefined;

/** One selectable model: the exact `provider/model` identity and an optional human name. */
export interface ModelOption {
	identity: string;
	name?: string;
}

/** Everything an agent form needs from its host. The target is captured; it never follows selection. */
export interface AgentFormHost {
	readonly row: AgentConversationSummary;
	readonly state: DashboardState;
	readonly source: Pick<AgentObservationSource, "snapshot" | "earlier">;
	/** Run one native action with the positional arguments of its command form; the target is implied. */
	run(name: string, args: string[]): Promise<ActionResult>;
	timers(): Promise<readonly TimerListRow[]>;
	schedule(input: { message: string; deliverAt: string; mode: TimerMode }): Promise<AgentActionOutcome>;
	/** The models this target's host can use. A failure is shown in the form, never replaced by typing. */
	models(): Promise<readonly ModelOption[]>;
	configure(patch: ConfigurationPatch): Promise<ActionResult>;
	/** Native commands the target's live host lists, or undefined when the name is typed. */
	commands(): Promise<readonly Choice[] | undefined>;
	profile(method: "profile-read" | "profile-update", input: Record<string, unknown>): Promise<unknown>;
	/** Unsaved profile drafts by identity; they survive closing and reopening the form. */
	readonly profileDrafts: Map<string, ProfileDraft>;
	status(): Promise<unknown>;
	/** Report an action's result to the work view's outcome line. */
	outcome(result: ActionResult, name: string): void;
}

const label = (host: AgentFormHost) => plainLine(agentDisplayName(host.row));
const text = (result: ActionResult) => (typeof result === "object" ? result.text : result);

/** Committed entries a fork or rewind can start from, newest first. */
export function committedChoices(entries: readonly AgentConversationEntry[]): Array<{ id: string; label: string }> {
	return entries
		.filter((entry) => /^\d+$/.test(entry.id) && (isInputKind(entry.kind) || entry.kind === "pi.assistant"))
		.map((entry) => {
			const body = (entry.model ?? [])
				.flatMap((message) =>
					typeof message.content === "string" ? [message.content] : message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])),
				)
				.join(" ")
				.replace(/\s+/g, " ")
				.slice(0, 100);
			const who = entry.kind === "pi.user" ? "You" : entry.kind === AGENT_INPUT_KIND ? "Agent input" : "Agent";
			return { id: entry.id, label: `${who}: ${body || "(no text)"} · ${entry.id}` };
		});
}

function ambiguousClock(deadline: Date): boolean {
	const clock = [deadline.getFullYear(), deadline.getMonth(), deadline.getDate(), deadline.getHours(), deadline.getMinutes()].join(":");
	for (let minutes = -120; minutes <= 120; minutes++) {
		if (!minutes) continue;
		const other = new Date(deadline.getTime() + minutes * 60000);
		if ([other.getFullYear(), other.getMonth(), other.getDate(), other.getHours(), other.getMinutes()].join(":") === clock) return true;
	}
	return false;
}

function localDeadline(value: string, now: number): Date {
	const time = /^(\d{2}):(\d{2})$/.exec(value.trim());
	if (!time || Number(time[1]) > 23 || Number(time[2]) > 59) throw new Error("Use HH:MM local or +30m");
	const deadline = new Date(now);
	deadline.setHours(Number(time[1]), Number(time[2]), 0, 0);
	if (deadline.getTime() <= now) deadline.setDate(deadline.getDate() + 1);
	if (ambiguousClock(deadline)) throw new Error("That local time has two offsets; use a relative time");
	if (deadline.getHours() !== Number(time[1]) || deadline.getMinutes() !== Number(time[2])) throw new Error("That local time does not exist; use a relative time");
	return deadline;
}

/** Local clock syntax is small and explicit; the schedule form shows the exact resulting instant. */
export function scheduleDeadline(value: string, now: number): string {
	const relative = /^\+(\d+)(m|h)$/.exec(value.trim());
	const deadline = relative ? new Date(now + Number(relative[1]) * (relative[2] === "m" ? 60000 : 3600000)) : localDeadline(value, now);
	if (!Number.isFinite(deadline.getTime()) || deadline.getTime() <= now) throw new Error("The deadline must be in the future");
	return deadline.toISOString();
}

/** The exact instant a typed deadline names now, or why it names none. */
export function deliveryText(value: string, now: number): string {
	if (!value.trim()) return "Type HH:MM local or +30m";
	try {
		const deadline = scheduleDeadline(value, now);
		return `${new Date(deadline).toLocaleString()} local · ${deadline}`;
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
}

function finish(host: AgentFormHost, name: string, result: ActionResult) {
	host.outcome(result, name);
	const message = text(result);
	return { close: true, ...(message ? { notice: { text: message, kind: "success" as const } } : {}) };
}

/** The host's models by exact identity; a current model the host does not list stays choosable. */
function modelChoices(models: readonly ModelOption[], current: string): Choice[] {
	const choices: Choice[] = models
		.map((model) => ({ value: model.identity, label: plainLine(model.identity), ...(model.name && model.name !== model.identity ? { description: plainLine(model.name) } : {}) }))
		.sort((a, b) => a.value.localeCompare(b.value));
	if (current && !choices.some((choice) => choice.value === current)) choices.unshift({ value: current, label: plainLine(current), description: "current · not listed by the host" });
	return choices;
}

/** Only changed fields enter the patch; an unchanged form is refused before any request. */
function configurationPatch(host: AgentFormHost, values: Readonly<Record<string, string>>, current: string): ConfigurationPatch {
	const patch: ConfigurationPatch = {};
	if ((values.name ?? "") !== (host.row.name ?? "")) patch.name = values.name ?? "";
	if (values.model && values.model !== current) patch.model = values.model;
	if (values.thinkingLevel && values.thinkingLevel !== (host.row.model?.thinkingLevel ?? "")) patch.thinkingLevel = values.thinkingLevel as ConfigurationPatch["thinkingLevel"];
	if (!Object.keys(patch).length) throw new Error("Nothing changed; edit a field or Cancel.");
	return validateConfigurationPatch(patch);
}

function configureView(host: AgentFormHost, view: ViewHost): OperatorView {
	return new LoadingView("Configure", view, async () => {
		const models = await host.models();
		const current = host.row.model ? `${host.row.model.provider}/${host.row.model.modelId}` : "";
		const choices = modelChoices(models, current);
		return new Form({
			title: "Configure",
			heading: `Configure ${label(host)}`,
			intro: "Name, model and reasoning apply together on Apply. Pi clamps reasoning to the model. The owner refuses a busy agent; your fields stay.",
			fields: [
				{ kind: "text", id: "name", label: "Name", value: host.row.name ?? "", placeholder: "blank clears the name" },
				{ kind: "choice", id: "model", label: "Model", value: current, choices, filter: true, rows: 7, hint: "Type to narrow the host's available models" },
				{ kind: "choice", id: "thinkingLevel", label: "Reasoning", value: host.row.model?.thinkingLevel ?? "off", choices: THINKING_LEVELS.map((level) => ({ value: level, label: level })) },
			],
			action: { label: "Apply" },
			host: view,
			submit: async (values) => finish(host, "configure", await host.configure(configurationPatch(host, values, current))),
		});
	});
}

async function entryChoices(host: AgentFormHost, pages: number): Promise<{ choices: Choice[]; more: boolean }> {
	let page = await host.source.snapshot(host.row.id);
	const entries = [...page.entries];
	for (let read = 1; read < pages && page.nextBefore; read++) {
		page = await host.source.earlier(host.row.id, page.nextBefore);
		entries.unshift(...page.entries);
	}
	const choices = committedChoices(entries)
		.reverse()
		.map((item) => ({ value: item.id, label: plainLine(item.label) }));
	return { choices, more: Boolean(page.nextBefore) };
}

function branchForm(host: AgentFormHost, view: ViewHost, rewind: boolean, choices: readonly Choice[]): Form {
	const latest = rewind ? [] : [{ value: "", label: "Latest committed entry" }];
	return new Form({
		title: rewind ? "Rewind" : "Fork",
		heading: rewind ? `Rewind ${label(host)} before a mistaken message` : `Fork ${label(host)}`,
		intro: rewind
			? "A new branch starts corrected work before the chosen message. Source history stays; files do not roll back."
			: "An idle branch starts from the chosen committed message. The source conversation is unchanged.",
		fields: [
			{ kind: "choice", id: "entry", label: "Message", value: rewind ? choices[0]?.value : "", choices: [...latest, ...choices], filter: true, rows: 6 },
			...(rewind ? [{ kind: "area" as const, id: "correction", label: "Correction", rows: 4, hint: "What the new branch should do instead" }] : []),
		],
		action: { label: rewind ? "Rewind" : "Fork", tone: rewind ? "danger" : "accent" },
		host: view,
		validate: (values) => (rewind && !(values.correction ?? "").trim() ? "Write the correction first." : undefined),
		submit: async (values) => {
			const entry = values.entry ?? "";
			const result = rewind ? await host.run("rewind", [entry, values.correction ?? ""]) : await host.run("fork", entry ? [entry] : []);
			return finish(host, rewind ? "rewind" : "fork", result);
		},
	});
}

function branchView(host: AgentFormHost, view: ViewHost, rewind: boolean, pages = 1): OperatorView {
	return new LoadingView(rewind ? "Rewind" : "Fork", view, async () => {
		const { choices, more } = await entryChoices(host, pages);
		if (!choices.length && rewind) throw new Error("No committed message is available to rewind before.");
		const form = branchForm(host, view, rewind, choices);
		if (!more) return form;
		const actions = form.actions.bind(form);
		form.actions = () => [...actions(), { id: "earlier", label: "Earlier messages", description: "Read one more page of committed messages", run: () => view.push((next) => branchView(host, next, rewind, pages + 1)) }];
		return form;
	});
}

function contextView(host: AgentFormHost, view: ViewHost, reset: boolean): OperatorView {
	return new Form({
		title: reset ? "Reset context" : "Compact",
		heading: `${reset ? "Reset the context of" : "Compact"} ${label(host)}`,
		intro: reset
			? "A new context starts at the next boundary. History, files, settings and timers stay. No new turn starts."
			: "Compaction summarises the context at the next native boundary. Active work and queued input continue.",
		fields: [{ kind: "area", id: "text", label: reset ? "Handoff" : "Instructions", rows: 4, hint: "Optional" }],
		action: { label: reset ? "Reset context" : "Compact" },
		host: view,
		submit: async (values) => {
			const value = (values.text ?? "").trim();
			return finish(host, reset ? "reset" : "compact", await host.run(reset ? "reset" : "compact", value ? [value] : []));
		},
	});
}

function commandView(host: AgentFormHost, view: ViewHost): OperatorView {
	return new LoadingView("Run command", view, async () => {
		const commands = await host.commands();
		if (commands && !commands.length) throw new Error("This agent's host lists no native commands.");
		return new Form({
			title: "Run command",
			heading: `Run a native command on ${label(host)}`,
			intro: "The command runs with this agent's authority. Arguments follow the command name exactly.",
			fields: [
				commands
					? { kind: "choice", id: "name", label: "Command", choices: commands, filter: true, rows: 6 }
					: { kind: "text", id: "name", label: "Command", placeholder: "command name" },
				{ kind: "text", id: "args", label: "Arguments", placeholder: "optional" },
			],
			action: { label: "Run" },
			host: view,
			validate: (values) => ((values.name ?? "").trim() ? undefined : "Choose or type a command."),
			submit: async (values) => finish(host, "command", await host.run("command", [values.name ?? "", values.args ?? ""])),
		});
	});
}

function scheduleView(host: AgentFormHost, view: ViewHost): OperatorView {
	const record = agentState(host.state, host.row.id);
	record.schedule ??= { message: "", time: "", mode: "followUp" };
	const draft = record.schedule;
	const form = new Form({
		title: "Schedule message",
		heading: `Schedule a message to ${label(host)}`,
		intro: "The message is admitted at the deadline. The host must be running then. The draft stays until it is scheduled.",
		fields: [
			{ kind: "area", id: "message", label: "Message", value: draft.message, rows: 4 },
			{ kind: "text", id: "time", label: "Deadline", value: draft.time, placeholder: "HH:MM local or +30m" },
			{ kind: "info", id: "at", label: "Delivers", value: (values) => deliveryText(values.time ?? "", Date.now()) },
			{ kind: "choice", id: "mode", label: "If busy", value: draft.mode, choices: [{ value: "followUp", label: "Follow-up after the answer" }, { value: "steer", label: "Steer at the next step" }] },
		],
		action: { label: "Schedule" },
		host: view,
		change: (values) => {
			draft.message = values.message ?? "";
			draft.time = values.time ?? "";
			draft.mode = values.mode === "steer" ? "steer" : "followUp";
		},
		validate: (values) => {
			if (!(values.message ?? "").trim()) return "Write the message first.";
			try {
				scheduleDeadline(values.time ?? "", Date.now());
				return undefined;
			} catch (error) {
				return error instanceof Error ? error.message : String(error);
			}
		},
		submit: async (values) => {
			const deliverAt = scheduleDeadline(values.time ?? "", Date.now());
			const result = await host.schedule({ message: values.message ?? "", deliverAt, mode: values.mode === "steer" ? "steer" : "followUp" });
			record.schedule = undefined;
			return finish(host, "schedule", result);
		},
	});
	return form;
}

function timersView(host: AgentFormHost, view: ViewHost): OperatorView {
	return new LoadingView("Scheduled messages", view, async () => {
		const timers = await host.timers();
		const rows = timers.map((timer) => ({ value: String(timer.timerId), label: `${new Date(timer.deadline).toLocaleString()} · ${timer.status} · ${plainLine(timer.messagePreview)}` }));
		if (!rows.length) return new ReaderView("Scheduled messages", view, () => `No scheduled messages for ${label(host)}.`);
		return new Form({
			title: "Scheduled messages",
			heading: `Scheduled messages for ${label(host)}`,
			intro: "Choose one to cancel. A message that already fired stays unchanged.",
			fields: [{ kind: "choice", id: "timer", label: "Message", choices: rows, rows: 8 }],
			action: { label: "Cancel scheduled message", tone: "danger" },
			cancelLabel: "Back",
			host: view,
			submit: async (values) => finish(host, "timer-cancel", await host.run("timer-cancel", [values.timer ?? ""])),
		});
	});
}

function confirmView(view: ViewHost, title: string, heading: string, intro: string, action: string, run: () => Promise<ReturnType<typeof finish>>, tone: "accent" | "danger" = "accent"): OperatorView {
	return new Form({ title, heading, intro, fields: [], action: { label: action, tone }, host: view, submit: run });
}

const hasPatch = (draft: ProfileDraft) => draft.role !== undefined || draft.expertise !== undefined;

function profileEditView(host: AgentFormHost, view: ViewHost, profile: AgentProfile, draft: ProfileDraft, reread: () => void): OperatorView {
	const conflict = draft.needsRead || draft.expectedRevision !== profile.revision;
	return new Form({
		title: "Edit profile",
		heading: `Edit the profile of ${plainLine(profile.handle ?? profile.name ?? profile.identity)}`,
		intro: conflict
			? "The profile changed since your draft began. Read the current profile, then choose its revision before Save."
			: `Save checks revision ${plainLine(profile.revision)}. A conflict keeps your draft.`,
		fields: [
			{ kind: "area", id: "role", label: "Role", value: draft.role ?? profile.role ?? "", rows: 3 },
			{ kind: "area", id: "expertise", label: "Expertise", value: draft.expertise ?? profile.expertise ?? "", rows: 8 },
		],
		action: { label: "Save" },
		host: view,
		change: (values) => {
			draft.role = values.role !== (profile.role ?? "") ? values.role : undefined;
			draft.expertise = values.expertise !== (profile.expertise ?? "") ? values.expertise : undefined;
			if (hasPatch(draft)) host.profileDrafts.set(profile.identity, draft);
		},
		submit: async () => {
			if (!hasPatch(draft)) throw new Error("Edit the role or the expertise before Save.");
			if (draft.needsRead || draft.expectedRevision !== profile.revision) throw new Error("Draft kept. Read the current profile and choose its revision before Save.");
			const result = await host.profile("profile-update", {
				sessionId: profile.identity,
				expectedRevision: draft.expectedRevision,
				...(draft.role === undefined ? {} : { role: draft.role }),
				...(draft.expertise === undefined ? {} : { expertise: draft.expertise }),
			});
			if (!matchesSchema(ProfileUpdateSchema, result)) throw new Error("Invalid profile update response");
			if (result.outcome === "conflict") {
				draft.needsRead = true;
				throw new Error(`The profile changed to revision ${result.profile.revision}. Draft kept; read the current profile.`);
			}
			host.profileDrafts.delete(profile.identity);
			reread();
			return { close: true, notice: { text: "Profile saved", kind: "success" } };
		},
	});
}

function profileView(host: AgentFormHost, view: ViewHost): OperatorView {
	let profile: AgentProfile | undefined;
	let error: string | undefined;
	const read = () => {
		host.profile("profile-read", { sessionId: host.row.id }).then(
			(value) => {
				if (view.signal.aborted) return;
				profile = readValue(value);
				error = undefined;
				const draft = host.profileDrafts.get(profile.identity);
				if (draft) draft.needsRead = false;
				view.requestRender();
			},
			(reason: unknown) => {
				if (view.signal.aborted) return;
				error = plainLine(reason instanceof Error ? reason.message : String(reason));
				view.requestRender();
			},
		);
	};
	read();
	const draftOf = (current: AgentProfile): ProfileDraft => host.profileDrafts.get(current.identity) ?? { expectedRevision: current.revision };
	return new ReaderView(
		"Profile",
		view,
		() => (profile ? profileText(profile, host.profileDrafts.get(profile.identity)) : error ? `The profile could not be read: ${error}` : "Reading the profile…"),
		() => {
			const current = profile;
			if (!current) return [{ id: "read", label: "Read again", key: "r", primary: true, run: read }];
			const draft = draftOf(current);
			const stale = draft.expectedRevision !== current.revision && !draft.needsRead;
			return [
				{ id: "edit", label: hasPatch(draft) ? "Continue editing" : "Edit role or expertise", key: "e", short: hasPatch(draft) ? "continue editing" : "edit", primary: true, run: () => view.push((next) => profileEditView(host, next, current, draft, read)) },
				{ id: "read", label: "Read current profile", key: "r", short: "read again", primary: true, run: read },
				...(stale ? [{ id: "revision", label: "Use current revision for the draft", key: "u", short: "use current revision", primary: true, run: () => { draft.expectedRevision = current.revision; view.requestRender(); } }] : []),
				...(hasPatch(draft) ? [{ id: "discard", label: "Discard draft", run: () => { host.profileDrafts.delete(current.identity); view.requestRender(); } }] : []),
			];
		},
	);
}

function detailsView(host: AgentFormHost, view: ViewHost): OperatorView {
	let content = "Reading details…";
	host.status().then(
		(value) => {
			if (view.signal.aborted) return;
			content = JSON.stringify(value, null, 2);
			view.requestRender();
		},
		(error: unknown) => {
			if (view.signal.aborted) return;
			content = `Details could not be read: ${error instanceof Error ? error.message : String(error)}`;
			view.requestRender();
		},
	);
	const id = host.row.id;
	return new ReaderView("Details", view, () => `${label(host)}\nIdentity: ${id}\nDirectory: ${host.row.cwd}\n\n${content}`);
}

/** Open one agent action as its inspector view. */
export function actionView(name: string, host: AgentFormHost, view: ViewHost): OperatorView {
	const who = label(host);
	const run = (action: string, args: string[] = []) => async () => finish(host, action, await host.run(action, args));
	switch (name) {
		case "configure":
			return configureView(host, view);
		case "fork":
			return branchView(host, view, false);
		case "rewind":
			return branchView(host, view, true);
		case "reset":
			return contextView(host, view, true);
		case "compact":
			return contextView(host, view, false);
		case "command":
			return commandView(host, view);
		case "schedule":
			return scheduleView(host, view);
		case "timers":
			return timersView(host, view);
		case "profile":
			return profileView(host, view);
		case "status":
			return detailsView(host, view);
		case "abort":
			return confirmView(view, "Stop", `Stop the current work of ${who}`, "History stays. Background work is not included. The conversation stays available.", "Stop current work", run("abort"), "danger");
		case "release":
			return confirmView(view, "Release", `Stop ${who} and release its host`, "This stops the conversation and requests retirement of its host. Other work stays.", "Stop and release host", run("release"), "danger");
		case "attach":
			return confirmView(view, "Reconnect", `Reconnect ${who}`, "This starts the host if it is not running. Retained unfinished work resumes. No new input starts.", "Reconnect", run("attach"));
		case "await-release": {
			const runId = host.row.awaiting?.runId;
			return confirmView(view, "Release await", `Release the await of ${who}`, "The original request resumes with partial results. Producers stay active.", "Release await", run("await-release", runId === undefined ? [] : [String(runId)]));
		}
		default:
			return new ReaderView(name, view, () => `The action ${name} has no form here.`);
	}
}
