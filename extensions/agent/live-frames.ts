/**
 * agent/live-frames: the JSON shape of one live host observation frame and the
 * pure builders that derive the visible tail and the task-graph projection from
 * published Durable view values.
 *
 * A frame is transport data: strict JSON, bounded by its source page, with a
 * monotonic revision and explicit coverage. Nothing here opens storage, starts
 * work, or interprets private state.
 */
import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";
import type { LiveState, TaskGraph, TaskGraphNode } from "@earendil-works/pi-durable";
import type { AgentConversationEntry } from "./dashboard-types.ts";
import type { ConversationSnapshotCoverage, ConversationStatus } from "./durable-observation.ts";

/** One bounded conversation reading: committed entries, the uncommitted tail, and the retained status. */
export interface ConversationFrame {
	readonly scope: "conversation";
	readonly storageId: string;
	readonly conversationId: number;
	/** Monotonic per observed conversation; a rebuild after a commit advances it. */
	readonly revision: number;
	readonly observedAt: string;
	/** Committed active entries, oldest first, hidden kinds excluded. */
	readonly entries: readonly AgentConversationEntry[];
	/** Pass as `before` to continue strictly older than the oldest committed entry; null at the oldest visible entry. */
	readonly nextBefore: number | null;
	/** Uncommitted tail: a partial assistant answer and running tool output, in display order. */
	readonly live: readonly AgentConversationEntry[];
	readonly status: ConversationStatus;
	readonly coverage: ConversationSnapshotCoverage;
}

/** One live task node, flattened for display. */
export interface TaskGraphRow {
	readonly id: number;
	readonly kind: string;
	readonly conversationId: number;
	/** Owner task; absent for a conversation-owned task. */
	readonly owner?: number;
	readonly background: boolean;
	readonly abortRequested: boolean;
	readonly status: TaskGraphNode["state"]["status"];
	readonly phase: string;
	/** Live tasks this one waits for. */
	readonly waitsOn: readonly number[];
	readonly policy?: string;
	readonly outcome?: string;
	/** Conversations this task owns, in ID order. */
	readonly conversations: readonly number[];
}

/** Display metadata for one conversation the live graph references. */
export interface TaskLabel {
	readonly conversationId: number;
	/** External identity of the conversation in its storage. */
	readonly identity: string;
	readonly name?: string;
	readonly firstMessage?: string;
}

/** One live task-graph reading for a storage. */
export interface TasksFrame {
	readonly scope: "tasks";
	readonly storageId: string;
	readonly revision: number;
	readonly observedAt: string;
	readonly tasks: readonly TaskGraphRow[];
	readonly labels: readonly TaskLabel[];
	readonly coverage: { readonly complete: boolean; readonly live: boolean };
}

export type ObservationFrame = ConversationFrame | TasksFrame;

/** ID of the synthetic entry that carries the in-flight assistant answer. */
export const LIVE_GENERATION_ID = "live:generation";
/** Prefix of the synthetic entry that carries one running tool call's output. */
export const LIVE_TOOL_PREFIX = "live:tool:";

function isAssistantPartial(message: AssistantMessage | undefined): message is AssistantMessage {
	return message !== undefined && message.stopReason === "pending" && assistantHasVisibleContent(message);
}

function assistantHasVisibleContent(message: AssistantMessage): boolean {
	for (const part of message.content) {
		if (part.type === "text" && part.text.trim() !== "") return true;
		if (part.type === "thinking" && (part.thinking.trim() !== "" || part.redacted === true)) return true;
		if (part.type === "toolCall") return true;
	}
	return false;
}

/** True when the committed transcript already carries this in-flight message. */
function partialCommitted(message: AssistantMessage, committed: readonly AgentConversationEntry[]): boolean {
	for (const entry of committed) {
		for (const candidate of entry.model ?? []) {
			if (candidate.role !== "assistant") continue;
			if (candidate.timestamp === message.timestamp && candidate.stopReason !== "pending") return true;
		}
	}
	return false;
}

/**
 * The uncommitted tail of one conversation: the in-flight assistant message
 * before its entry commits, and running tool output before its result entry
 * commits. A committed message or a terminal tool slot is omitted so the tail
 * never duplicates the committed transcript.
 */
export function buildLiveEntries(live: unknown, committed: readonly AgentConversationEntry[]): AgentConversationEntry[] {
	if (live === null || typeof live !== "object") return [];
	const state = live as LiveState;
	const out: AgentConversationEntry[] = [];
	const message = state.generation?.message as AssistantMessage | undefined;
	if (isAssistantPartial(message) && !partialCommitted(message, committed)) {
		out.push({ id: LIVE_GENERATION_ID, kind: "pi.assistant", model: [message] });
	}
	for (const slot of state.tools ?? []) {
		if (slot.status === "done" || slot.entry !== undefined) continue;
		const output = slot.output ?? "";
		if (output.trim() === "" && slot.details === undefined) continue;
		const message: ToolResultMessage = {
			role: "toolResult",
			toolCallId: slot.callId,
			toolName: slot.name,
			content: output === "" ? [] : [{ type: "text", text: output }],
			details: slot.details,
			isError: false,
			timestamp: 0,
		};
		out.push({
			id: `${LIVE_TOOL_PREFIX}${slot.callId}`,
			kind: "pi.tool-result",
			model: [message],
			data: { live: true, status: slot.status, droppedBytes: slot.droppedBytes, droppedLines: slot.droppedLines, details: slot.details },
		});
	}
	return out;
}

/** Flatten every live task in ID order. Terminal tasks are absent from the graph by construction. */
export function taskGraphRows(graph: TaskGraph): TaskGraphRow[] {
	const rows: TaskGraphRow[] = [];
	for (const key of Object.keys(graph.tasks).sort((left, right) => Number(left) - Number(right))) {
		const node = graph.tasks[key];
		if (node === undefined) continue;
		const state = node.state;
		rows.push({
			id: node.id,
			kind: node.kind,
			conversationId: node.conversationId,
			...(node.owner === undefined ? {} : { owner: node.owner }),
			background: node.background,
			abortRequested: node.abortRequested,
			status: state.status,
			phase: state.status === "completing" ? "completing" : state.phase,
			waitsOn: state.status === "waiting" ? [...state.on] : [],
			...(state.status === "waiting" ? { policy: state.policy } : {}),
			...(state.status === "completing" ? { outcome: state.outcome } : {}),
			conversations: [...node.conversations],
		});
	}
	return rows;
}

/** Minimal structural check for one frame received from the transport. */
export function isObservationFrame(value: unknown): value is ObservationFrame {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
	const candidate = value as { scope?: unknown; revision?: unknown; storageId?: unknown };
	if (typeof candidate.storageId !== "string" || typeof candidate.revision !== "number" || !Number.isFinite(candidate.revision)) return false;
	if (candidate.scope === "conversation") {
		const frame = value as { conversationId?: unknown; entries?: unknown; live?: unknown; status?: unknown };
		return typeof frame.conversationId === "number" && Array.isArray(frame.entries) && Array.isArray(frame.live) && frame.status !== null && typeof frame.status === "object";
	}
	if (candidate.scope === "tasks") return Array.isArray((value as { tasks?: unknown }).tasks);
	return false;
}

/** Parse one frame out of replicated-state ops; the host publishes a root replacement. */
export function frameFromOps(ops: readonly unknown[]): ObservationFrame | undefined {
	for (let index = ops.length - 1; index >= 0; index--) {
		const op = ops[index];
		if (Array.isArray(op) && op[0] === "r" && isObservationFrame(op[1])) return op[1];
	}
	return undefined;
}

/**
 * Strict-JSON copy of one frame. The transport validator rejects own keys with
 * an undefined value, which optional status fields can produce; serializing the
 * frame once here keeps every published and returned frame wire-safe.
 */
export function jsonSafeFrame<T extends ObservationFrame>(frame: T): T {
	return JSON.parse(JSON.stringify(frame)) as T;
}
