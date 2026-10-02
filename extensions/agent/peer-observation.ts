/**
 * agent/peer-observation: a PeerAgentSource over the host live-observation
 * service.
 *
 * The source serves the roster from the manager's bounded catalog page and each
 * selected agent from one host-owned conversation observation. A frame pushes
 * committed entries, the uncommitted tail, and the retained status; `subscribe`
 * notifies the window when any observed frame changes, so the window repaints
 * without polling the host for every commit. A storage with no live writer stays
 * cold: the source falls back to the manager's snapshot and reports no live
 * frame.
 */
import type { AgentConversationPage, AgentConversationSnapshot } from "./dashboard-types.ts";
import { storageIdOf } from "./catalog.ts";
import type { ConversationSnapshotPage } from "./durable-observation.ts";
import type { ConversationFrame, ObservationFrame, TasksFrame } from "./live-frames.ts";
import type { PeerAgentSource, PeerAvailability } from "./peer-contract.ts";

/** Host operations this source consumes; the manager supplies them. */
export interface PeerObservationHost {
	list(): Promise<AgentConversationPage>;
	snapshot(id: string, params?: { before?: number }): Promise<ConversationSnapshotPage>;
	/**
	 * Attach-only live observation; undefined when no live writer owns the storage.
	 * The listener receives the last frame (or undefined) plus `state: "unavailable"`
	 * when the host observation closes; the next fresh frame reports `state: "live"`.
	 */
	observeLive(id: string, scope: "conversation" | "tasks", listener: (frame: ObservationFrame | undefined, fresh: boolean, state?: "live" | "unavailable") => void, signal?: AbortSignal): Promise<(() => void) | undefined>;
}

/** One agent's source state: the newest live frame and the last read snapshot. */
interface AgentState {
	frame?: ConversationFrame;
	snapshot?: AgentConversationSnapshot;
	subscription?: () => void;
	attaching?: boolean;
	observedAt?: string;
	unavailableAt?: string;
}

/** A peer source with live frames and host-backed earlier pages. */
export interface PeerObservationSource extends PeerAgentSource {
	/** The newest live conversation frame, or undefined while no live host supplies one. */
	frame(id: string): ConversationFrame | undefined;
	/** The live task graph for the storage that owns one agent identity. */
	tasks(id: string): Promise<TasksFrame>;
	/** One earlier committed page, continued strictly older than `before`. */
	earlier(id: string, before: number): Promise<ConversationSnapshotPage>;
	/** True while a live host observation is attached for this agent. */
	live(id: string): boolean;
}

/** Snapshot shape the window consumes; a live frame serves it without a second read. */
function snapshotOf(frame: ConversationFrame): AgentConversationSnapshot {
	return { entries: frame.entries, partial: !frame.coverage.complete, revision: `r${frame.revision}` };
}

const EMPTY_TASKS_COVERAGE = { complete: false, live: false } as const;

/** One task reading for a storage with no live host: explicit, not an empty claim. */
function coldTasksFrame(storageId: string): TasksFrame {
	return { scope: "tasks", storageId, revision: 0, observedAt: new Date(0).toISOString(), tasks: [], labels: [], coverage: { ...EMPTY_TASKS_COVERAGE } };
}

export function createPeerObservationSource(host: PeerObservationHost): PeerObservationSource {
	const agents = new Map<string, AgentState>();
	const taskFrames = new Map<string, TasksFrame>();
	const taskSubscriptions = new Map<string, () => void>();
	const listeners = new Set<() => void>();
	let attached = false;

	function notify(): void {
		for (const listener of [...listeners]) {
			try {
				listener();
			} catch {
				// One window listener failure never stops the others.
			}
		}
	}

	function markUnavailable(id: string, frame: ObservationFrame | undefined): void {
		const agentState = agents.get(id);
		if (agentState === undefined) return;
		const at = frame !== undefined && frame.scope === "conversation" ? frame.observedAt : undefined;
		agentState.unavailableAt = at ?? new Date().toISOString();
	}

	function onFrame(id: string, frame: ObservationFrame | undefined, state?: "live" | "unavailable"): void {
		const agentState = agents.get(id);
		if (state === "unavailable") {
			markUnavailable(id, frame);
			notify();
			return;
		}
		if (frame === undefined) return;
		if (frame.scope === "conversation") {
			if (agentState === undefined) return;
			agentState.frame = frame;
			agentState.snapshot = snapshotOf(frame);
			agentState.observedAt = frame.observedAt;
			agentState.unavailableAt = undefined;
		} else {
			taskFrames.set(frame.storageId, frame);
		}
		notify();
	}

	/**
	 * Attach one live conversation observation when none is live. A reopened
	 * window releases and re-reads: the cached frame must not block a new
	 * subscription after the previous window closed.
	 */
	function attachAgent(id: string, state: AgentState): void {
		if (state.subscription !== undefined || state.attaching === true) return;
		state.attaching = true;
		void host
			.observeLive(id, "conversation", (frame, _fresh, state) => onFrame(id, frame, state), undefined)
			.then((off) => {
				state.attaching = false;
				if (off === undefined) return;
				if (!attached || agents.get(id) !== state) {
					off();
					return;
				}
				state.subscription = off;
			})
			.catch(() => {
				state.attaching = false;
				state.unavailableAt = new Date().toISOString();
				notify();
			});
	}

	function ensureAgent(id: string): AgentState {
		const existing = agents.get(id);
		if (existing !== undefined) {
			attachAgent(id, existing);
			return existing;
		}
		const state: AgentState = {};
		agents.set(id, state);
		attachAgent(id, state);
		return state;
	}

	function ensureTasks(id: string): TasksFrame {
		const storageId = storageIdOf(id);
		if (!taskSubscriptions.has(storageId)) {
			taskSubscriptions.set(storageId, () => {});
			void host
				.observeLive(storageId, "tasks", (frame, _fresh, state) => {
					if (state === "unavailable") {
						notify();
						return;
					}
					if (frame !== undefined && frame.scope === "tasks") {
						taskFrames.set(frame.storageId, frame);
						notify();
					}
				}, undefined)
				.then((off) => {
					if (off === undefined) return;
					if (!attached) {
						off();
						return;
					}
					taskSubscriptions.set(storageId, off);
				})
				.catch(() => undefined);
		}
		return taskFrames.get(storageId) ?? coldTasksFrame(storageId);
	}

	/** Release every host subscription; the next read reopens on demand. */
	function releaseAll(): void {
		for (const state of agents.values()) {
			state.subscription?.();
			state.subscription = undefined;
			state.attaching = false;
		}
		for (const off of taskSubscriptions.values()) off();
		taskSubscriptions.clear();
	}

	return {
		async list(): Promise<AgentConversationPage> {
			return host.list();
		},

		async snapshot(id: string): Promise<AgentConversationSnapshot> {
			const state = ensureAgent(id);
			if (state.snapshot !== undefined) return state.snapshot;
			const page = await host.snapshot(id);
			state.snapshot = page;
			return page;
		},

		frame(id: string): ConversationFrame | undefined {
			ensureAgent(id);
			return agents.get(id)?.frame;
		},

		async earlier(id: string, before: number): Promise<ConversationSnapshotPage> {
			return host.snapshot(id, { before });
		},

		async tasks(id: string): Promise<TasksFrame> {
			return ensureTasks(id);
		},

		live(id: string): boolean {
			return agents.get(id)?.subscription !== undefined;
		},

		availability(id: string): PeerAvailability | undefined {
			const state = agents.get(id);
			if (state === undefined) return undefined;
			if (state.unavailableAt !== undefined) return { state: "unavailable", at: state.unavailableAt };
			if (state.observedAt !== undefined) return { state: "live", at: state.observedAt };
			return undefined;
		},

		subscribe(listener: () => void): () => void {
			listeners.add(listener);
			attached = true;
			return () => {
				listeners.delete(listener);
				if (listeners.size === 0) {
					attached = false;
					releaseAll();
				}
			};
		},
	};
}
