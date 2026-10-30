/**
 * Observation contract between host-published catalog metadata and the agent
 * dashboard. The board reads only the bounded views a Durable host publishes
 * beside its catalog record: it bootstraps no services, copies no database, and
 * launches no host for the roster. A deep snapshot is available only for the
 * selected conversation. This module names the UI data and merges coverage;
 * it imports no runtime storage, worker, or activity module.
 */
import type { Message } from "@earendil-works/pi-ai";
import type { CommunicationView } from "./communication.ts";
import type { TaskSenders } from "./task-senders.ts";
import type { ProfileHint } from "./profile-schema.ts";
import type { AwaitFact } from "./await-facts.ts";
import type { CatalogPriorityCoverage } from "./catalog.ts";

/** Dashboard lifecycle bucket for one durable conversation. */
export type AgentConversationState =
	| "starting"
	| "working"
	| "idle"
	| "done"
	| "failed"
	| "stopped"
	| "interrupted"
	| "new"
	| "unavailable";

/**
 * Source ownership for one row. `here` holds the writer claim; `unknown` is
 * readable and claimable later; `unavailable` is unreadable or claim-conflicted.
 * An absent or dead claim leaves the row `unknown`.
 */
export type AgentConversationOwner = "here" | "unavailable" | "unknown";

/** One failed native compaction retained in the host-published view. */
export interface DashboardCompactionFailure {
	reason: "manual" | "threshold" | "overflow";
	errorMessage?: string;
	at?: string;
}

/** One in-progress provider retry retained in the host-published view. */
export interface DashboardAutoRetry {
	attempt: number;
	maxAttempts: number;
	delayMs: number;
	errorMessage: string;
}

/**
 * Recovery fields retained in one host-published view. Values are a snapshot
 * from the view's publication time, not a fresh health assertion. Absent fields
 * mean the publication carried none, not that the storage is healthy. A later
 * publication can clear a failure or retry that its source cleared.
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
	/** Storage-creation provenance, not nonroot conversation ancestry or the current requester. */
	creatingOwnerId?: string;
	/** Presentation-only catalog rank; never part of host-published or native wire rows. */
	rosterOrder?: { priority: boolean; modifiedAt: number };
	/** Stored conversation name when one exists. */
	name?: string;
	/** Retained profile hint, joined outside the base observation wire contract. Absent means unknown coverage. */
	profile?: ProfileHint;
	/** Historical first user input; not the agent's current role or task. */
	firstMessage?: string;
	/** Working directory recorded for the conversation; the storage directory when the agent sets none. */
	cwd: string;
	/** Effective model and reasoning level when resolved. */
	model?: { provider: string; modelId: string; thinkingLevel: string };
	/** Source-published update time in epoch milliseconds; the publication timestamp when the view carries no row time. */
	modifiedAt: number;
	/** "here" is held by this process; "unknown" is readable and claimable later; "unavailable" is unreadable or unclaimable. */
	owner: AgentConversationOwner;
	/** Source detail for refusal guidance: the host metadata timestamp, plus a claim error when the claim is unreadable. */
	ownerLabel?: string;
	/** Dashboard lifecycle bucket from the published view. A row whose writer claim is absent or dead shows `interrupted` when the view said it was working. */
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
	/** Retained recovery detail from the host-published view; absent when the publication carries none. */
	health?: DashboardHealth;
	awaiting?: AwaitFact;
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
	/** Committed display rows carry an exact owner join; uncommitted rows omit it. */
	communication?: CommunicationView;
}

/** Active transcript of one conversation, oldest first. */
export interface AgentConversationSnapshot {
	entries: readonly AgentConversationEntry[];
	/** Exact requester hints for selected inputs; absent hints mean unknown. */
	taskSenders?: TaskSenders;
	/** True when the source bounded or could not completely read the transcript. */
	partial: boolean;
	/** Opaque revision that changes with the visible transcript. */
	revision: string;
}

/** Bounded coverage of one dashboard page. */
export interface AgentDashboardCoverage {
	/** Candidate scan and output bounds from the manager's priority reader. */
	inventory: CatalogPriorityCoverage;
	/** Per-storage view exclusions for distinct accounting across refreshed priority pages. */
	projections: Record<string, { skipped: number; omitted: number }>;
	/** True when the catalog scan and page output reached the inventory end. */
	complete: boolean;
	/** Storages visited for this page. */
	storagesVisited: number;
	/** Stores skipped as unreadable or unavailable, plus stores whose published view was incomplete. */
	skipped: number;
	/** Rows excluded by host views; inventory separately counts rows outside the page output limit. */
	omitted: number;
	/** Continuation for more output; inventory reports the snapshot remainder. */
	nextCursor: string | null;
}

/** Merge retained rows while counting one latest inventory scan and one projection per storage. */
export function mergeAgentCoverage(previous: AgentDashboardCoverage, current: AgentDashboardCoverage): AgentDashboardCoverage {
	const projections = { ...previous.projections, ...current.projections };
	return { ...current, projections, storagesVisited: current.inventory.inspected,
		skipped: current.inventory.unreadable + Object.values(projections).reduce((total, item) => total + item.skipped, 0),
		omitted: Object.values(projections).reduce((total, item) => total + item.omitted, 0) };
}

/** One bounded dashboard page: roster rows plus the coverage of their collection. */
export interface AgentConversationPage {
	rows: readonly AgentConversationSummary[];
	coverage: AgentDashboardCoverage;
	/** Observation time as an ISO timestamp. */
	observedAt: string;
}

/** Manager roster rows carry caller-side rank; native publications and startup rows do not. */
export interface AgentPrioritySummary extends AgentConversationSummary {
	rosterOrder: { priority: boolean; modifiedAt: number };
}
export interface AgentPriorityPage extends AgentConversationPage {
	rows: readonly AgentPrioritySummary[];
}

/**
 * Async observation surface the dashboard consumes. The parent reads the
 * published catalog metadata and the selected transcript; this UI calls no
 * session service directly.
 */
export interface AgentObservationSources {
	/** One bounded roster page built from host-published catalog views; the board opens no storage, copies no database, and launches no host. */
	list(): Promise<AgentConversationPage>;
	/** Deep read of the selected conversation; the source may serve it from a cached public snapshot without services or model bootstrap. */
	snapshot(id: string): Promise<AgentConversationSnapshot>;
}

/** The board selection an action dialog receives. */
export type DashboardTarget = AgentConversationSummary;
