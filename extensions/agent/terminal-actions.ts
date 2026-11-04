import { randomUUID } from "node:crypto";
import type { AgentConversationSummary } from "./dashboard-types.ts";
import type { DashboardResult } from "./dashboard.ts";
import { agentDisplayName } from "./action-outcome.ts";
import { runActionFlow, type ActionFlowHost, type ActionResult } from "./action-dialogs.ts";
import { cancelAgentTimer, readAgentTimerRows, resetAgentContext, scheduleAgentInput, type ResetTimerDeps } from "./durable-reset-timers.ts";
import { configurationFormWithApply, type ModelSource } from "./configuration-dialog.ts";
import type { AgentDialogs, DialogChoice } from "./dialog-adapter.ts";
import { ModelChoicesSchema } from "./observation-schema.ts";
import { matchesSchema } from "./schema-check.ts";
import { readValue, runProfileForm, profileMenu, type ProfileDraft } from "./profile-dialog.ts";
import type { TerminalController } from "./terminal-client.ts";

const failureText = (value: unknown) => {
	const reason = (value as { reason?: unknown; error?: unknown } | null)?.reason ?? (value as { error?: unknown } | null)?.error;
	return typeof reason === "string" && reason ? `: ${reason.slice(0, 200)}` : "";
};

/** Profile drafts outlive one dialog, so cancelling and reopening keeps the unsaved text. */
const profileDrafts = new WeakMap<TerminalController, Map<string, ProfileDraft>>();

/** Native commands the target's live host advertises, with their descriptions. */
async function nativeCommands(read: () => Promise<unknown>): Promise<DialogChoice[]> {
	const status = await read() as { inventory?: { contributions?: Array<{ commands?: Array<{ name: string; description: string }> }> } };
	if (!status.inventory) throw new Error("This agent's host is not live. Reconnect it before running a native command.");
	const commands = status.inventory.contributions?.flatMap((contribution) => contribution.commands ?? []) ?? [];
	return [...commands.map((command) => ({ value: command.name, label: command.name, description: command.description })),
		{ value: "reload", label: "reload", description: "Reload host registrations (needs an idle storage)" }];
}

/**
 * Operator forms for the attached terminal. The target is captured before the first prompt,
 * so a later attachment change never redirects an answer. Exact identities stay behind labels.
 */
export async function terminalAction(controller: TerminalController, dialogs: AgentDialogs, name: string, target: AgentConversationSummary): Promise<DashboardResult | undefined> {
	const label = agentDisplayName(target);
	const control = (method: string, input: Record<string, unknown> = {}) => controller.manager.control(method, { sessionId: target.id, ...input }, controller.caller);
	const deps: ResetTimerDeps = { control: (method, input) => controller.manager.control(method, input, controller.caller), label: async () => label };
	const outcome = (text: string, sessionId = target.id): DashboardResult => ({ text, sessionId });
	const models: ModelSource = async () => {
		let read: unknown;
		try { read = await control("models"); } catch (error) { throw new Error(`Model list unavailable: ${error instanceof Error ? error.message : String(error)}`); }
		if (!matchesSchema(ModelChoicesSchema, read)) throw new Error("Model list unavailable: the host answered with an unreadable list");
		if (read.error) dialogs.notify(`The host reported a model error: ${read.error}`, "warning");
		return read.models.map((model) => ({ identity: `${model.provider}/${model.modelId}`, ...(model.name ? { name: model.name } : {}) }));
	};
	const confirm = (title: string, description: string, action: string) => dialogs.confirm(title, description, action);
	const runners: Record<string, (args: string[]) => Promise<ActionResult>> = {
		fork: async (args) => { const forked = await control("fork", args[0] ? { entryId: args[0] } : {}) as { identity?: string; status?: { name?: string } }; return outcome(`Created branch “${forked.status?.name ?? label}”`, forked.identity ?? target.id); },
		rewind: async (args) => { const result = await control("rewind", { entryId: args[0], correction: args[1], origin: "operator", selfOwned: true }) as { identity?: string }; return outcome(`Rewound “${label}” before the selected entry`, result.identity ?? target.id); },
		reset: (args) => resetAgentContext(deps, { sessionId: target.id, ...(args[0] ? { handoff: args[0] } : {}) }),
		compact: async (args) => { const result = await control("compact", args[0] ? { instructions: args[0] } : {}) as { status?: string }; return outcome(result?.status === "completed" ? `Compacted “${label}”` : `Compaction ${result?.status ?? "requested"} for “${label}”`); },
		command: async (args) => { const result = await control("command", { name: args[0], args: args[1] ?? "", origin: "operator", invocationId: randomUUID() }) as { reloaded?: boolean; text?: string }; return outcome(result?.reloaded ? `Reloaded host registrations for “${label}”` : `Ran command ${args[0]} on “${label}”${result?.text ? `: ${result.text}` : ""}`); },
		"timer-cancel": (args) => cancelAgentTimer(deps, { sessionId: target.id, timerId: Number(args[0]) }),
		abort: async () => { await control("abort"); return outcome(`Requested stop for “${label}”`); },
		attach: async () => { await control("attach"); return outcome(`Connected to “${label}”`); },
		"await-release": async (args) => { const result = await control("await-release", { expectedRunId: Number(args[0]) }) as { released?: boolean }; return outcome(result.released ? "Released the selected await" : "The selected await is no longer active"); },
	};
	const run = async (action: string, args: string[]): Promise<ActionResult> => {
		const runner = runners[action];
		if (!runner) throw new Error(`Unsupported terminal action: ${action}`);
		return runner(args);
	};
	const host: ActionFlowHost = {
		dialogs, row: target, state: controller.state, source: controller.source, run,
		timers: () => readAgentTimerRows(deps, target.id),
		schedule: (input) => scheduleAgentInput(deps, { sessionId: target.id, ...input, selfOwned: true }),
		configure: async () => configurationFormWithApply(target, dialogs, models, async (patch) => {
			// The native request takes the model as an object; the form stores the exact identity string.
			const split = patch.model?.indexOf("/") ?? -1;
			const { model: identity, ...rest } = patch;
			const result = await control("configure", { ...rest, ...(identity === undefined ? {} : { model: { provider: identity.slice(0, split), modelId: identity.slice(split + 1) } }) }) as { outcome?: string };
			if (result?.outcome === "failed") throw new Error(`Configuration failed for “${label}”${failureText(result)}`);
			return outcome(`Updated configuration for “${label}”`);
		}),
	};
	switch (name) {
		case "status": await dialogs.read(`Status of ${label}`, JSON.stringify(await control("status"), null, 2)); return undefined;
		case "release":
			if (!await confirm(`Release ${label}?`, "Stop this conversation and request retirement of its host. Other work stays.", "Release")) return undefined;
			await control("release");
			return outcome(`Requested release for “${label}”`);
		case "profile": {
			const drafts = profileDrafts.get(controller) ?? new Map<string, ProfileDraft>();
			profileDrafts.set(controller, drafts);
			const profile = readValue(await control("profile-read"));
			const draft = drafts.get(target.id) ?? { expectedRevision: profile.revision };
			drafts.set(target.id, draft);
			await runProfileForm(profile, draft, dialogs, (method, input) => control(method, input), profileMenu(dialogs));
			if (draft.role === undefined && draft.expertise === undefined) drafts.delete(target.id);
			return undefined;
		}
		case "command": return runActionFlow(name, host, await nativeCommands(() => control("status"))) as Promise<DashboardResult | undefined>;
		default: return runActionFlow(name, host) as Promise<DashboardResult | undefined>;
	}
}
