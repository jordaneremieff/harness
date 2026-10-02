/**
 * Shared types for the peer window: two equal conversation panes over the
 * ordinary primary session and one selected Durable agent. The window consumes
 * agent frames through PeerAgentSource and the ordinary primary through
 * PrimaryObserver, so a live-watch service can replace the polled source
 * without changing the presentation modules.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import type { ConversationFrame, TasksFrame } from "./live-frames.ts";
import type { AgentConversationEntry, AgentConversationPage, AgentConversationSnapshot, AgentConversationState, AgentConversationSummary } from "./dashboard-types.ts";

/** A visible conversation endpoint: the ordinary primary or one Durable conversation. */
export type PeerKind = "primary" | "agent";

/** Display state of one peer. The ordinary primary has its own state. */
export type PeerState = "primary" | AgentConversationState;

/** Metadata the window shows for one peer; all fields come from public data. */
export interface PeerDescriptor {
	/** Stable peer identity: the ordinary session ID, or the Durable dashboard identity. */
	id: string;
	kind: PeerKind;
	name: string;
	cwd: string;
	/** Exact `provider/model` when known. */
	model?: string;
	thinkingLevel?: string;
	state: PeerState;
	/** Short additional status, for example an owner or delivery note. */
	detail?: string;
	/** Retained cost when known; undefined means unknown, never zero. */
	cost?: number;
	/** True when a retained cost component is missing or unreadable. */
	partialCost?: boolean;
}

/** A rendered transcript at one width. */
export interface PeerDocument {
	lines: string[];
	anchors: Array<{ id: string; line: number }>;
}

/** Read-only view over rendered transcript blocks. */
export interface PeerTranscript {
	render(width: number): PeerDocument;
	invalidate(): void;
}

/**
 * Builds one transcript view from explicit entries. The window consumes the
 * Durable transcript renderer only through this interface, so its messages and
 * tool cards stay a presentation detail of that module.
 */
export interface PeerTranscriptFactory {
	create(input: {
		entries: readonly AgentConversationEntry[];
		cwd: string;
		tui: TUI;
		expanded: boolean;
		showThinking: boolean;
		/** Optional card renderer for custom message blocks; an absent renderer keeps the text fallback. */
		renderCustom?: (entry: AgentConversationEntry) => Component | undefined;
	}): PeerTranscript;
}

/**
 * Agent-side data source. `list` and `snapshot` are the published dashboard
 * reads; `subscribe` lets a host watch service push changes instead of the
 * window's bounded refresh timer. `frame` and `tasks` are optional live reads:
 * a source without them keeps the polled, committed-only behavior.
 */
export interface PeerAgentSource {
	list(): Promise<AgentConversationPage>;
	snapshot(id: string): Promise<AgentConversationSnapshot & { nextBefore?: number | null }>;
	/** Newest live conversation frame, or undefined while no live host supplies one. */
	frame?(id: string): ConversationFrame | undefined;
	/** Live task graph for the storage that owns one agent identity. */
	tasks?(id: string): Promise<TasksFrame>;
	/** One earlier committed page, continued strictly older than `before`; optional. */
	earlier?(id: string, before: number): Promise<{ entries: readonly AgentConversationEntry[]; nextBefore: number | null }>;
	subscribe?(listener: () => void): () => void;
}

/** Result of one peer action; the session ID lets the window follow a new peer. */
export interface PeerActionResult {
	text: string;
	sessionId?: string;
}

/** Operations other modules own; the window only presents and routes them. */
export interface PeerAgentActions {
	submit(input: { id: string; text: string; mode: "send" | "steer" }): Promise<PeerActionResult>;
	newAgent(input: { prompt?: string }): Promise<PeerActionResult>;
	fork(input: { id: string; entryId?: string }): Promise<PeerActionResult>;
	repair(input: { id: string; entryId: string; correction: string }): Promise<PeerActionResult>;
}

/** Busy behavior for plain primary input, always chosen by the operator. */
export type PrimarySubmitMode = "auto" | "steer" | "followUp";

/** A tool call streaming in the primary that has no committed result yet. */
export interface PrimaryLiveTool {
	toolCallId: string;
	toolName: string;
	args: unknown;
	partial?: unknown;
	result?: unknown;
	isError?: boolean;
}

/** One primary reading: metadata plus committed and uncommitted transcript blocks. */
export interface PrimarySnapshot {
	descriptor: PeerDescriptor;
	/** Committed blocks. No live material appears here. */
	entries: readonly AgentConversationEntry[];
	revision: string;
	/** Uncommitted tail that must render after `entries`; pairs open tool calls with running output. */
	live: readonly AgentConversationEntry[];
	liveRevision: string;
	busy: boolean;
}

/**
 * Ordinary-primary bridge. The observer reads the real session manager and the
 * public message and tool events; it never creates a session, writer, or model
 * loop of its own.
 */
export interface PrimaryObserver {
	/** Rebind after a session start or replacement. */
	attach(ctx: ExtensionContext, pi?: ExtensionAPI): void;
	/** Forward one public extension event. Unknown event types are ignored. */
	observe(event: { type: string }): void;
	/** Re-read the session after an append that emits no extension event. */
	refresh(): void;
	snapshot(): PrimarySnapshot;
	subscribe(listener: () => void): () => void;
	sendPlain(text: string, mode: PrimarySubmitMode): void;
	/** Replace the native editor text, returning the draft that was there. */
	handoffToNative(text: string): string;
	nativeDraft(): string;
}

/** Per-pane transcript reading position and display options. */
export interface PeerViewState {
	/** True while the pane follows new output. */
	follow: boolean;
	/** Absolute scroll line used when follow is false and no anchor resolves. */
	scroll: number;
	/** Committed block that anchored the reading position. */
	anchor?: { id: string; offset: number };
	expanded: boolean;
	showThinking: boolean;
}

/** Persistent composer draft and reading position for one peer. */
export interface PeerPaneState {
	draft: string;
	view: PeerViewState;
	mode: "auto" | "send" | "steer" | "followUp";
}

/** One side of the split; undefined means the side is closed. */
export type PeerSlot = { kind: "primary" } | { kind: "agent"; id: string } | undefined;

/** Window state that survives focus changes, Expand, Close, and reopen in one process. */
export interface PeerWindowState {
	focus: "left" | "right";
	left: PeerSlot;
	right: PeerSlot;
	/** Last agent the operator selected; the next open pairs it with the primary. */
	selectedAgent?: string;
	/** The side that fills the window; undefined keeps the split. */
	expanded?: "left" | "right";
	/** Per-peer state keyed by `peerKey`. */
	panes: Map<string, PeerPaneState>;
	/** Native editor text replaced by the last handoff, kept for explicit restore. */
	nativeDraftBefore?: string;
	/** Short-lived operational message, shown in the strip and cleared by actions. */
	notice?: string;
	/** Observation clock reading for `notice`; an old notice stays hidden. */
	noticeAt?: number;
}

/** Stable state key for one slot value. */
export function peerKey(slot: Exclude<PeerSlot, undefined>): string {
	return slot.kind === "primary" ? "primary" : `agent:${slot.id}`;
}

/** Fresh empty window state with both panes on their default pair. */
export function createPeerWindowState(): PeerWindowState {
	return { focus: "left", left: { kind: "primary" }, right: undefined, panes: new Map() };
}

/** Per-peer state accessor that creates defaults on first use. */
export function paneState(state: PeerWindowState, key: string): PeerPaneState {
	const existing = state.panes.get(key);
	if (existing) return existing;
	const created: PeerPaneState = { draft: "", view: { follow: true, scroll: 0, expanded: false, showThinking: true }, mode: "auto" };
	state.panes.set(key, created);
	return created;
}

/** Narrow primary row metadata to a peer descriptor. */
export function agentDescriptor(row: AgentConversationSummary): PeerDescriptor {
	return {
		id: row.id,
		kind: "agent",
		name: row.name?.trim() || row.firstMessage?.trim() || row.id,
		cwd: row.cwd,
		model: row.model ? `${row.model.provider}/${row.model.modelId}` : undefined,
		thinkingLevel: row.model?.thinkingLevel,
		state: row.state,
		detail: row.owner === "here" ? undefined : row.owner === "unknown" ? "stored" : "unavailable",
		cost: row.cost,
		partialCost: row.partial,
	};
}
