/**
 * Observation contract between native Durable session sources and the agent
 * dashboard. The parent owns reading Pi Durable storage; this module names the
 * data the UI consumes and imports no storage, worker, or activity module.
 */
import type { Message } from "@earendil-works/pi-ai";

/** Dashboard lifecycle bucket for one durable conversation. */
export type AgentConversationState = "working" | "idle" | "done" | "failed" | "stopped" | "interrupted" | "new" | "unavailable";

/** Control ownership the source can observe for one conversation. */
export type AgentConversationOwner = "here" | "unavailable" | "unknown";

/** One failed native compaction retained by a held storage. */
export interface DashboardCompactionFailure {
	reason: "manual" | "threshold" | "overflow";
	errorMessage?: string;
	at: string;
}

/** One in-progress provider retry retained by a held storage. */
export interface DashboardAutoRetry {
	attempt: number;
	maxAttempts: number;
	delayMs: number;
	errorMessage: string;
}

/**
 * Recovery fields from a storage this process holds. An entry exists only for a
 * held storage, so an absent entry is not a health statement. An empty report
 * means the source lists no recovery issue. A later successful compaction
 * clears the failure; the retry's end clears the retry.
 */
export interface DashboardHealth {
	lastError?: string;
	compactionFailure?: DashboardCompactionFailure;
	autoRetry?: DashboardAutoRetry;
}

/** One durable conversation summary for the dashboard roster. */
export interface AgentConversationSummary {
	/** Dashboard identity: the storage ID for the root conversation, otherwise `${storageId}:${conversationId}`. */
	id: string;
	/** Storage that owns this conversation. */
	storageId: string;
	/** Stored conversation name when one exists. */
	name?: string;
	/** First user input; the title fallback. */
	firstMessage?: string;
	/** Working directory recorded for the conversation; the storage directory when the agent sets none. */
	cwd: string;
	/** Effective model and reasoning level when resolved. */
	model?: { provider: string; modelId: string; thinkingLevel: string };
	/** Last known activity in epoch milliseconds; the latest entry timestamp, else the storage file time. */
	modifiedAt: number;
	/** This process holds the storage; "unavailable" and "unknown" rows are read-only. */
	owner: AgentConversationOwner;
	/** Optional owner detail for refusal guidance. */
	ownerLabel?: string;
	/** Dashboard lifecycle bucket. */
	state: AgentConversationState;
	/** Retained usage cost for the conversation. */
	cost: number;
	/** True when a retained cost component is missing or unreadable. */
	partial: boolean;
	/** Latest assistant answer text, bounded by the source. */
	latestReply?: string;
	/** Terminal failure or unavailable reason, separate from recovery fields. */
	error?: string;
	/** Tool calls on the active transcript. */
	toolCalls?: number;
	/** First unresolved tool call of the current round, not proof of execution. */
	currentTool?: { name: string; argument: string };
	/** Observed span of the latest user turn in milliseconds; absent without an established start. */
	durationMs?: number;
	/** Recovery detail from the held storage; absent otherwise. */
	health?: DashboardHealth;
}

/**
 * One native Pi Durable entry for conversation rendering. The UI inspects
 * known kinds and renders their model messages with Pi's published components;
 * it never parses storage records.
 */
export interface AgentConversationEntry {
	/** Native durable entry ID as a stable string. */
	id: string;
	/** Native entry kind, for example `pi.user`, `pi.assistant`, `pi.tool-result`, `pi.compaction`, or `pi.reset`. */
	kind: string;
	/** Model-facing messages this entry contributes, in order. */
	model?: readonly Message[];
	/** Application payload retained by the entry; rendered as bounded display text only. */
	data?: unknown;
	/** First entry retained by a compaction or reset entry. */
	head?: string;
}

/** Active transcript of one conversation, oldest first. */
export interface AgentConversationSnapshot {
	entries: readonly AgentConversationEntry[];
	/** True when the source bounded or could not completely read the transcript. */
	partial: boolean;
	/** Opaque revision that changes with the visible transcript. */
	revision: string;
}

/**
 * Async observation surface the dashboard consumes. The parent reads its
 * native Durable hosts; this UI calls no session service directly.
 */
export interface AgentObservationSources {
	/** Summaries across every Durable storage this process holds. */
	list(): Promise<readonly AgentConversationSummary[]>;
	/** Active transcript and revision for one dashboard ID. */
	snapshot(id: string): Promise<AgentConversationSnapshot>;
}

/** The board selection an action dialog receives. */
export type DashboardTarget = AgentConversationSummary;
