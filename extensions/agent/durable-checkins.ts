/** Durable owner check-ins for unanswered tool admissions. */
import { withAbortSignal } from "@earendil-works/chord/context";
import { defineTask, LiveDoc, UsageDoc, type ConversationId, type Tx, type UsageState, type ToolSlot, type EntryId, type EntryRecord } from "@earendil-works/pi-durable";
import { AgentDeliveryDoc, type DeliveryOrigin, type DeliveryMessage } from "./durable-controls.ts";
import { readAwaitFact } from "./await-observation.ts";
import { awaitFactLines } from "./await-facts.ts";

export const CHECK_IN_MAX_MINUTES = 35791;
/** Only model tool admissions apply the environment default. */
export function checkInMinutes(value: unknown, origin: DeliveryOrigin = "model"): number {
	if (value === undefined) {
		if (origin !== "model") return 0;
		const raw = process.env.PI_AGENT_CHECK_IN_MINUTES;
		const minutes = Number(raw ?? 30);
		if (raw?.trim() === "" || !Number.isFinite(minutes) || minutes < 0 || minutes > CHECK_IN_MAX_MINUTES)
			throw new TypeError(`PI_AGENT_CHECK_IN_MINUTES must be a finite number from 0 through ${CHECK_IN_MAX_MINUTES}`);
		return minutes;
	}
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > CHECK_IN_MAX_MINUTES)
		throw new TypeError(`checkInMinutes must be a finite number from 0 through ${CHECK_IN_MAX_MINUTES}`);
	return value;
}

export type CheckInInput = {
	conversationId: number;
	requestId: string;
	ownerId: string;
	senderIdentity: string;
	message: DeliveryMessage;
	whenBusy: "steer" | "followUp" | "reject";
	origin: DeliveryOrigin;
	admittedAt: number;
	intervalMs: number;
};
type CheckInState = { phase: "watch"; next: number };

function textOf(model: unknown): string {
	if (!Array.isArray(model)) return "";
	return model.flatMap((message) => typeof message.content === "string" ? [message.content] : Array.isArray(message.content) ? message.content.flatMap((part: { type?: string; text?: string }) => part.type === "text" && typeof part.text === "string" ? [part.text] : []) : []).join("\n");
}
function bounded(text: string, limit: number): string {
	return text.length > limit ? `${text.slice(0, limit)}… [truncated]` : text;
}

function retainedCost(usage: UsageState): number | null {
	const costs = [...Object.values(usage.models), ...Object.values(usage.tools)].map((bucket) => bucket.cost?.total);
	return costs.every((value) => typeof value === "number" && Number.isFinite(value)) ? costs.reduce((sum, value) => sum + (value ?? 0), 0) : null;
}

function assistantCalls(model: NonNullable<EntryRecord["model"]>): { id: string; timestamp: number }[] {
	return model.flatMap((message) => message.role === "assistant" && Array.isArray(message.content)
		? message.content.flatMap((part) => part.type === "toolCall" ? [{ id: part.id, timestamp: message.timestamp }] : [])
		: []);
}

async function recentActivity(tx: Tx, conversationId: ConversationId, minEntryId: EntryId | undefined): Promise<{ calls: number; latest: string; issuedAt: Map<string, number>; truncated: boolean }> {
	const issuedAt = new Map<string, number>();
	// Queued inputs have no transcript boundary and no task activity yet.
	if (minEntryId === undefined) return { calls: 0, latest: "", issuedAt, truncated: false };
	const page = await tx.scanEntries({ conversationId, minEntryId }, 64);
	let calls = 0;
	let latest = "";
	for (const entry of page.items) {
		if (entry.kind !== "pi.assistant" || !Array.isArray(entry.model)) continue;
		if (latest === "") latest = textOf(entry.model);
		for (const call of assistantCalls(entry.model)) {
			calls += 1;
			if (!issuedAt.has(call.id)) issuedAt.set(call.id, call.timestamp);
		}
	}
	return { calls, latest, issuedAt, truncated: page.next !== undefined };
}

function runningToolLines(tool: ToolSlot, issuedAt: number | undefined, now: number): string[] {
	const age = issuedAt === undefined ? "call age unknown" : `call issued ${Math.max(0, Math.round((now - issuedAt) / 1000))}s ago`;
	const lines = [`Current tool: ${bounded(tool.name, 80)}; ${age} (not exact runtime).`];
	if (tool.output) lines.push(`Last tool lines:\n${bounded(tool.output.split("\n").slice(-3).join("\n"), 800)}`);
	return lines;
}

/** One bounded native snapshot; cost is retained conversation spend, not an estimate of an in-flight request. */
async function digest(tx: Tx, input: CheckInInput, inputEntry: EntryId | undefined, now: number): Promise<{ cost: number | null; digest: string }> {
	const id = input.conversationId as ConversationId;
	const live = await tx.doc(LiveDoc, id);
	const usage = await tx.doc(UsageDoc, id);
	const awaiting = await readAwaitFact(tx, input.senderIdentity.split(":")[0], id);
	if (awaiting !== undefined) return { cost: retainedCost(usage), digest: bounded(awaitFactLines(awaiting).join("\n"), 2400) };
	const recent = await recentActivity(tx, id, inputEntry);
	// Native input placement follows the prior tool round and clears its live tools.
	const running = (inputEntry === undefined ? [] : live.tools ?? []).filter((tool) => tool.status === "running").slice(0, 4);
	const generation = inputEntry === undefined ? undefined : live.generation;
	const lines = [recent.truncated
		? `Tool calls: at least ${recent.calls} (bounded retained entries for watched task).`
		: `Tool calls: ${recent.calls} (watched task).`];
	for (const tool of running) lines.push(...runningToolLines(tool, recent.issuedAt.get(tool.callId), now));
	if (running.length === 0) lines.push(generation ? "Current step: model request." : "Current step: queued or between steps.");
	const latest = textOf(generation?.message === undefined ? [] : [generation.message]) || recent.latest;
	lines.push(`Latest reply excerpt (not a result): ${latest === "" ? "No reply text yet." : bounded(latest, 600)}`);
	return { cost: retainedCost(usage), digest: bounded(lines.join("\n"), 2400) };
}

export const CheckInTask = defineTask<CheckInInput, CheckInState, null>({
	name: "agent.check-in",
	version: 1,
	initial: () => ({ phase: "watch", next: 1 }),
	phases: {
		watch: async (task, runtime, context) => {
			const input = task.input;
			const id = input.conversationId as ConversationId;
			const conversation = await runtime.conversation(id, context);
			if (conversation === undefined) throw new Error("check-in conversation is absent");
			// Reacquire the submission through the public, request-deduplicated admission handle.
			const message = typeof input.message === "string" ? input.message : input.message.map((part) => part.type === "image" ? { type: "image" as const, data: part.data, mimeType: part.mimeType } : { type: "text" as const, text: part.text });
			const submission = await conversation.submit({ type: "input", content: message, requestId: input.requestId, whenBusy: input.whenBusy }, context);
			const deadline = input.admittedAt + task.state.checkpoint.next * input.intervalMs;
			const cancel = new AbortController();
			const waitContext = withAbortSignal(cancel.signal, context);
			const settled = submission.wait(waitContext).then(() => "settled" as const);
			const due = runtime.sleep(deadline, waitContext).then(() => "due" as const);
			let winner: "settled" | "due";
			try { winner = await Promise.race([settled, due]); }
			finally { cancel.abort(); await Promise.allSettled([settled, due]); }
			const now = runtime.now();
			await runtime.commit(async (tx) => {
				const retained = await tx.submissionByRequest(id, input.requestId);
				if (winner === "settled" || retained?.status === "done" || retained?.status === "unanswered")
					return { status: "terminal", outcome: { status: "completed", result: null } };
				// Collapse overdue boundaries into one current notice, then return to the admission's fixed cadence.
				const k = Math.max(task.state.checkpoint.next, Math.floor((now - input.admittedAt) / input.intervalMs));
				const sourceId = `check-in:${id}:${input.requestId}:${k}`;
				const state = await tx.doc(AgentDeliveryDoc);
				if (!state.reports.some((report) => report.sourceId === sourceId)) {
					const fallbackBroadcast = state.reports.some((report) => report.ownerId === input.ownerId && report.checkIn?.conversationId === input.conversationId && report.checkIn.requestId === input.requestId && report.checkIn.fallbackBroadcast === true);
					for (let index = state.reports.length - 1; index >= 0; index -= 1) {
						const previous = state.reports[index];
						if (previous?.checkIn?.conversationId === input.conversationId && previous.checkIn.requestId === input.requestId && previous.ownerId === input.ownerId && !previous.acknowledged) state.reports.splice(index, 1);
					}
					const snapshot = await digest(tx, input, retained?.entry, now);
					state.reports.push({ sourceId, requestId: sourceId, ownerId: input.ownerId, senderIdentity: input.senderIdentity, message: snapshot.digest, replyTo: null, acknowledged: false, createdAt: now, checkIn: { origin: input.origin, elapsedMs: Math.max(0, now - input.admittedAt), cost: snapshot.cost, conversationId: input.conversationId, requestId: input.requestId, ...fallbackMarker(fallbackBroadcast) } });
				}
				return { status: "running", checkpoint: { phase: "watch", next: k + 1 } };
			}, context);
		},
	},
	abort: (_task, runtime, context) => runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
});

/** Omit a fallback marker until a quiet broadcast was accepted. */
function fallbackMarker(accepted: boolean): { fallbackBroadcast?: boolean } {
	return accepted ? { fallbackBroadcast: true } : {};
}

/** Create with the admission intent or local reporter, never with output deliveries. */
export async function createCheckIn(tx: Tx, input: Omit<CheckInInput, "intervalMs">, minutes: number): Promise<void> {
	checkInMinutes(minutes, input.origin);
	if (minutes === 0) return;
	await tx.createTask(CheckInTask, { ...input, intervalMs: Math.max(1, Math.round(minutes * 60000)) }, { ownership: { kind: "conversation" }, conversationId: input.conversationId as ConversationId, background: true });
}
