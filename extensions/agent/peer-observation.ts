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
import type { PeerAgentSource } from "./peer-contract.ts";

/** Host operations this source consumes; the manager supplies them. */
export interface PeerObservationHost {
	list(): Promise<AgentConversationPage>;
	snapshot(id: string, params?: { before?: number }): Promise<ConversationSnapshotPage>;
	/** Attach-only live observation; undefined when no live writer owns the storage. */
	observeLive(id: string, scope: "conversation" | "tasks", listener: (frame: ObservationFrame, fresh: boolean) => void, signal?: AbortSignal): Promise<(() => void) | undefined>;
}

/** One agent's source state: the newest live frame and the last read snapshot. */
interface AgentState {
	frame?: ConversationFrame;
	snapshot?: AgentConversationSnapshot;
	subscription?: () => void;
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

	function onFrame(id: string, frame: ObservationFrame): void {
		if (frame.scope === "conversation") {
			const state = agents.get(id);
			if (state === undefined) return;
			state.frame = frame;
			state.snapshot = snapshotOf(frame);
		} else {
			taskFrames.set(frame.storageId, frame);
		}
		notify();
	}

	function ensureAgent(id: string): AgentState {
		const existing = agents.get(id);
		if (existing !== undefined) return existing;
		const state: AgentState = {};
		agents.set(id, state);
		void host
			.observeLive(id, "conversation", (frame) => onFrame(id, frame), undefined)
			.then((off) => {
				if (off === undefined) return;
				if (!attached || agents.get(id) !== state) {
					off();
					return;
				}
				state.subscription = off;
			})
			.catch(() => undefined);
		return state;
	}

	function ensureTasks(id: string): TasksFrame {
		const storageId = storageIdOf(id);
		if (!taskSubscriptions.has(storageId)) {
			taskSubscriptions.set(storageId, () => {});
			void host
				.observeLive(storageId, "tasks", (frame) => {
					if (frame.scope === "tasks") {
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
		}
		for (const [storageId, off] of taskSubscriptions) {
			off();
			taskSubscriptions.set(storageId, () => {});
		}
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
