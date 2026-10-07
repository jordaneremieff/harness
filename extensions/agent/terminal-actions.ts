import { randomUUID } from "node:crypto";
import type { AgentConversationSummary } from "./dashboard-types.ts";
import type { DashboardResult } from "./dashboard.ts";
import { committedChoices } from "./action-dialogs.ts";
import { scheduleAgentInput } from "./durable-reset-timers.ts";
import type { AgentProfile } from "./profile-schema.ts";
import { requestRequiredString } from "./durable-observation.ts";
import type { TerminalController } from "./terminal-client.ts";

export type TerminalAsk = (title: string, lines: string[], prompt: string, initial?: string) => Promise<string | undefined>;
const result = (value: unknown, sessionId?: string): DashboardResult => ({ text: JSON.stringify(value, null, 2), sessionId });

export function parseTerminalConfiguration(patch: string): Record<string, unknown> {
	const value: unknown = JSON.parse(patch);
	if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => !["name", "model", "thinkingLevel"].includes(key))) throw new Error("Use only name, model, and thinkingLevel");
	const params = value as Record<string, unknown>;
	if (params.model !== undefined && params.model !== null) {
		if (typeof params.model !== "object" || Array.isArray(params.model)) throw new Error("Use model: {provider,modelId}, not a provider/model string");
		const model = params.model as Record<string, unknown>;
		requestRequiredString(model, "provider");
		requestRequiredString(model, "modelId");
	}
	return params;
}

/** Dialogs invoke captured native targets, without ordinary extension context or session emulation. */
export async function terminalAction(controller: TerminalController, ask: TerminalAsk, name: string, target: AgentConversationSummary): Promise<DashboardResult | undefined> {
	const control = (method: string, input: Record<string, unknown> = {}) => controller.manager.control(method, { sessionId: target.id, ...input }, controller.caller);
	const confirm = async (word: string, description: string) => (await ask(`${target.name ?? target.id}: ${name}`, [description], `Type ${word}: `)) === word;
	const actions: Record<string, () => Promise<DashboardResult | undefined>> = {
		status: async () => result(await control("status")),
		attach: async () => result(await control("attach")),
		abort: async () => await confirm("stop", "Stop current work in this conversation. History and other conversations stay.") ? result(await control("abort")) : undefined,
		"await-release": async () => await confirm("release", "Return partial await results. Producers continue.") ? result(await control(name, { expectedRunId: target.awaiting?.runId })) : undefined,
		compact: async () => {
			if (!await confirm("compact", "Stop active work and compact without a new model turn.")) return undefined;
			const instructions = await ask("Compaction instructions", [], "Instructions (optional): ");
			return instructions === undefined ? undefined : result(await control(name, { instructions }));
		},
		reset: async () => {
			if (!await confirm("reset", "Start a new active context. History, timers, and identity stay.")) return undefined;
			const handoff = await ask("Context handoff", [], "Handoff (optional): ");
			return handoff === undefined ? undefined : result(await control(name, { handoff }));
		},
		command: async () => {
			const command = await ask("Run native agent command", ["This command uses the selected agent's authority."], "Command name: ");
			if (!command?.trim()) return undefined;
			const args = await ask(command, [], "Arguments (optional): ");
			return args === undefined ? undefined : result(await control(name, { name: command, args, origin: "operator", invocationId: randomUUID() }));
		},
		configure: async () => {
			const patch = await ask("Configure selected agent", [`JSON object with name, thinkingLevel, and/or model: {"provider":"...","modelId":"..."}.`], "Patch: ");
			if (patch === undefined) return undefined;
			return result(await control(name, parseTerminalConfiguration(patch)));
		},
		profile: async () => {
			const profile = await control("profile-read") as AgentProfile;
			const field = await ask("Profile", [`Identity: ${profile.identity}`, `Handle: ${profile.handle ?? "none"}`, `Role: ${profile.role}`, `Expertise: ${profile.expertise}`, "Leave empty to read only. Type role or expertise to edit."], "Field: ");
			if (!field) return result(profile);
			if (field !== "role" && field !== "expertise") throw new Error("Choose role or expertise");
			const text = await ask(`Edit ${field}`, [], `${field}: `, profile[field]);
			return text === undefined ? undefined : result(await control("profile-update", { expectedRevision: profile.revision, [field]: text }));
		},
		fork: () => branch(false),
		rewind: () => branch(true),
		schedule: async () => {
			const message = await ask("Schedule input", [], "Message: ");
			if (!message?.trim()) return undefined;
			const deliverAt = await ask("Deadline", ["Use an ISO 8601 time with an offset. The host must run at the deadline."], "Time: ");
			if (!deliverAt) return undefined;
			return scheduleAgentInput({ control, label: async () => target.name ?? target.id }, { sessionId: target.id, message, deliverAt, selfOwned: true });
		},
		timers: async () => {
			const timers = await control("timer-list");
			const id = await ask("Scheduled messages", [JSON.stringify(timers)], "Timer ID to cancel (empty reads only): ");
			if (!id) return result(timers);
			if (!/^[1-9]\d*$/.test(id)) throw new Error("Use a positive timer ID");
			return await confirm("cancel", `Cancel timer ${id}. Current work stays.`) ? result(await control("timer-cancel", { timerId: Number(id) })) : undefined;
		},
	};
	async function branch(rewind: boolean): Promise<DashboardResult | undefined> {
		const snapshot = await controller.manager.snapshot(target.id);
		const choices = committedChoices(snapshot.entries);
		const entryId = await chooseEntry(choices, rewind);
		if (entryId === undefined) return undefined;
		const correction = rewind ? await ask("Correction", ["This starts a corrected branch against current files. The source stays."], "Correction: ") : undefined;
		if (rewind && !correction?.trim()) return undefined;
		const params: Record<string, unknown> = {};
		if (entryId) params.entryId = entryId;
		if (correction) { params.correction = correction; params.origin = "operator"; params.selfOwned = true; }
		const forked = await control(name, params) as { identity?: string };
		return result(forked, forked.identity);
	}
	async function chooseEntry(choices: Array<{ id: string; label: string }>, rewind: boolean): Promise<string | undefined> {
		const entry = await ask(name, choices.map((choice) => choice.label), rewind ? "Entry ID: " : "Entry ID (empty uses newest): ");
		if (entry && !choices.some((choice) => choice.id === entry)) throw new Error("Choose a listed committed entry ID");
		if (rewind && entry === "") throw new Error("Rewind requires an entry ID");
		return entry;
	}
	const action = actions[name];
	if (!action) throw new Error(`Unsupported terminal action: ${name}`);
	return action();
}
