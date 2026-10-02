/**
 * agent/durable-reset-timers: the control surfaces for context reset and
 * one-shot scheduled inputs.
 *
 * `registerResetTimerTools` adds the model-facing reset control to the
 * ordinary primary session. `createResetTimerActions` adds the operator
 * `/agent` actions, and the exported action functions are the small hooks the
 * dashboard calls for Reset context, Schedule input, List timers, and Cancel
 * timer. Pending timers appear in `agent_status`, and `agent_abort` with a
 * `timerId` cancels one scheduled input. Every surface sends the same host
 * controls, so a primary action, a dashboard action, and a native Durable tool
 * share one behavior.
 *
 * Operator surfaces record `origin: "operator"`, so a fired timer's answer
 * shows in the ordinary primary chat without starting a model turn. A model
 * surface records `origin: "model"` and keeps the waking notice.
 */
import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { AgentCommandAction } from "./command.ts";
import { AGENT_CONTROL_GUIDANCE } from "./control-guidance.ts";
import { parseDeliverAt, type CancelTimerResult, type ScheduleTimerResult, type TimerListRow, type TimerMode } from "./durable-timers.ts";
import type { ResetResult } from "./durable-reset.ts";

/** Host control caller: one method against the selected storage. */
export interface ResetTimerDeps {
	readonly control: (method: string, input: Record<string, unknown>) => Promise<unknown>;
	/** Display label of one agent; a failed read falls back to the short identity. */
	readonly label: (sessionId: string) => Promise<string>;
}

/** One operator-facing outcome: display text plus the agent it acted on. */
export interface ResetTimerOutcome {
	readonly text: string;
	readonly sessionId?: string;
}

function requireSession(sessionId: string): string {
	if (sessionId.trim() === "") throw new Error("An agent session is required");
	return sessionId;
}

/** Local date and time of one absolute deadline. */
function localTime(deadline: number): string {
	return new Date(deadline).toLocaleString();
}

async function labelOf(deps: ResetTimerDeps, sessionId: string): Promise<string> {
	try {
		return await deps.label(sessionId);
	} catch {
		return sessionId.slice(0, 8);
	}
}

export async function resetAgentContext(deps: ResetTimerDeps, input: { readonly sessionId: string; readonly handoff?: string }): Promise<ResetTimerOutcome> {
	const sessionId = requireSession(input.sessionId);
	const handoff = input.handoff !== undefined && input.handoff.trim() !== "" ? input.handoff : undefined;
	const result = (await deps.control("reset", { sessionId, ...(handoff === undefined ? {} : { handoff }) })) as ResetResult;
	const label = await labelOf(deps, sessionId);
	if (result.status === "placed") return { text: `Reset placed for “${label}”; the next input starts from the new context. History stays inspectable.`, sessionId };
	if (result.status === "queued") return { text: `Reset queued for “${label}”; it places at the next native boundary and starts no model turn.`, sessionId };
	return { text: `Reset did not place for “${label}”: ${result.reason ?? "unknown reason"}.`, sessionId };
}

export async function scheduleAgentInput(deps: ResetTimerDeps, input: { readonly sessionId: string; readonly deliverAt: string | number; readonly message: string; readonly mode?: TimerMode }): Promise<ResetTimerOutcome> {
	const sessionId = requireSession(input.sessionId);
	const message = input.message.trim();
	if (message === "") throw new Error("A scheduled input requires a message");
	const deadline = parseDeliverAt(input.deliverAt);
	const mode = input.mode ?? "followUp";
	const result = (await deps.control("timer-schedule", {
		sessionId,
		message,
		deliverAt: deadline,
		mode,
		origin: "operator",
		scheduleId: `timer:${randomUUID()}`,
		requestId: `timer-delivery:${randomUUID()}`,
	})) as ScheduleTimerResult;
	const label = await labelOf(deps, sessionId);
	const kind = mode === "steer" ? "steering" : "follow-up";
	return {
		text: `Scheduled timer #${result.timerId} for “${label}” at ${localTime(result.deadline)} (${kind}${result.deduped ? ", already scheduled" : ""}). The storage host must run at the deadline.`,
		sessionId,
	};
}

export async function cancelAgentTimer(deps: ResetTimerDeps, input: { readonly sessionId: string; readonly timerId: number }): Promise<ResetTimerOutcome> {
	const sessionId = requireSession(input.sessionId);
	const result = (await deps.control("timer-cancel", { sessionId, timerId: input.timerId })) as CancelTimerResult;
	const label = await labelOf(deps, sessionId);
	if (result.status === "cancelled") return { text: `Cancelled timer #${result.timerId} for “${label}”.`, sessionId };
	if (result.status === "fired") return { text: `Timer #${result.timerId} for “${label}” already fired; nothing was cancelled.`, sessionId };
	return { text: `Timer #${result.timerId} for “${label}” is ${result.status}; nothing was cancelled.`, sessionId };
}

/** One line of a timer listing with its local deadline, state, target, and origin. */
function timerLine(row: TimerListRow): string {
	const state = row.live && row.status === "pending" ? "pending" : row.status;
	const settled = row.status === "fired" && row.firedAt !== null ? `, fired ${localTime(row.firedAt)}${row.overdueMs !== null && row.overdueMs > 0 ? `, overdue ${Math.round(row.overdueMs / 1000)}s` : ""}` : "";
	return `#${row.timerId} ${state} ${localTime(row.deadline)} (${row.mode}, ${row.origin}) → ${row.identity}${settled}: ${row.messagePreview}`;
}

/** Structured rows for selected-message pickers; display strings are not a protocol. */
export async function readAgentTimerRows(deps: ResetTimerDeps, sessionId: string): Promise<TimerListRow[]> {
 const result = await deps.control("timer-list", { sessionId }) as { timers: TimerListRow[] };
 return result.timers;
}

export async function listAgentTimers(deps: ResetTimerDeps, input: { readonly sessionId: string }): Promise<ResetTimerOutcome> {
	const sessionId = requireSession(input.sessionId);
	const result = (await deps.control("timer-list", { sessionId })) as { timers: TimerListRow[] };
	const label = await labelOf(deps, sessionId);
	if (result.timers.length === 0) return { text: `No scheduled inputs for “${label}”.`, sessionId };
	const lines = result.timers.map(timerLine);
	return { text: `Scheduled inputs for “${label}” (${result.timers.length}):\n${lines.join("\n")}`, sessionId };
}

function sessionArgument(): AgentCommandAction["args"][number] {
	return { name: "session", complete: "session" };
}

/** Operator `/agent` actions for reset and timers. */
export function createResetTimerActions(bind: (ctx: ExtensionContext) => ResetTimerDeps): AgentCommandAction[] {
	return [
		{
			name: "reset",
			description: "Reset an agent's active context with an optional handoff",
			help: "History, identity, files, settings, and timers stay. A busy agent queues the reset until its next native boundary. No model turn starts.",
			confirm: "This starts a new active context for the selected agent. Retained history stays inspectable.",
			args: [sessionArgument(), { name: "handoff", optional: true, rest: true }],
			run: async ([sessionId, ...words], ctx) => {
				const outcome = await resetAgentContext(bind(ctx), { sessionId: sessionId ?? "", handoff: words.join(" ") });
				return { text: outcome.text, ...(outcome.sessionId === undefined ? {} : { sessionId: outcome.sessionId }) };
			},
		},
		{
			name: "schedule",
			description: "Schedule an input at an absolute time",
			help: "Use an ISO 8601 date-time with an offset, for example 2026-10-03T09:00:00+10:00, or epoch milliseconds. Follow-up is the busy mode. The input fires only while the storage host runs.",
			args: [sessionArgument(), { name: "time" }, { name: "message", rest: true }],
			run: async ([sessionId, when, ...words], ctx) => {
				const outcome = await scheduleAgentInput(bind(ctx), { sessionId: sessionId ?? "", deliverAt: when ?? "", message: words.join(" ") });
				return { text: outcome.text, ...(outcome.sessionId === undefined ? {} : { sessionId: outcome.sessionId }) };
			},
		},
		{
			name: "timers",
			description: "List scheduled inputs for one agent",
			help: "Shows deadline, target, mode, origin, and state. Cancel with timer-cancel and the timer ID.",
			args: [sessionArgument()],
			run: async ([sessionId], ctx) => {
				const outcome = await listAgentTimers(bind(ctx), { sessionId: sessionId ?? "" });
				return { text: outcome.text, ...(outcome.sessionId === undefined ? {} : { sessionId: outcome.sessionId }) };
			},
		},
		{
			name: "timer-cancel",
			description: "Cancel a scheduled input by its timer ID",
			confirm: "This cancels the timer before it fires. A timer that already fired is reported unchanged.",
			args: [sessionArgument(), { name: "timer" }],
			run: async ([sessionId, timerId], ctx) => {
				const parsed = Number(timerId);
				if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error("A positive timer ID from /agent timers is required");
				const outcome = await cancelAgentTimer(bind(ctx), { sessionId: sessionId ?? "", timerId: parsed });
				return { text: outcome.text, ...(outcome.sessionId === undefined ? {} : { sessionId: outcome.sessionId }) };
			},
		},
	];
}

function toolResult(value: { readonly text: string }): { content: Array<{ type: "text"; text: string }>; details: Record<string, unknown> } {
	return { content: [{ type: "text", text: value.text }], details: { text: value.text } };
}

/** Model-facing primary control for reset. Timer listing lives in `agent_status`; timer cancellation uses `agent_abort` with a `timerId`. */
export function registerResetTimerTools(pi: ExtensionAPI, bind: (ctx: ExtensionContext) => ResetTimerDeps): void {
	const guidance = AGENT_CONTROL_GUIDANCE.agent_reset;
	pi.registerTool({
		name: "agent_reset",
		label: "Agent Reset",
		description: "Reset one agent's active context with an optional handoff. History, identity, files, settings, and timers stay. The write places at the next native boundary while the agent is busy and starts no model turn.",
		parameters: Type.Object({ sessionId: Type.String({ minLength: 1, maxLength: 256 }), handoff: Type.Optional(Type.String()) }, { additionalProperties: false }),
		...(guidance.snippet === undefined ? {} : { promptSnippet: guidance.snippet }),
		...(guidance.guidelines === undefined ? {} : { promptGuidelines: [...guidance.guidelines] }),
		async execute(_callId, params, _signal, _update, ctx) {
			return toolResult(await resetAgentContext(bind(ctx), { sessionId: params.sessionId, ...(params.handoff === undefined ? {} : { handoff: params.handoff }) }));
		},
	});
}
