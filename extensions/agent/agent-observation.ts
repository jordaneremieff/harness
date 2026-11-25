import type { AgentConversationPage, AgentConversationSnapshot } from "./dashboard-types.ts";
import type { HostObservationListener, HostObservationState } from "./host-client.ts";
import type { ConversationSnapshotPage } from "./durable-observation.ts";
import type { ConversationFrame, ObservationFrame, TasksFrame } from "./live-frames.ts";
import { storageIdOf } from "./catalog.ts";

export interface AgentObservationHost {
	list(input?: { cursor?: string; ownerId?: string }): Promise<AgentConversationPage>;
	snapshot(id: string, params?: { before?: number }, signal?: AbortSignal): Promise<ConversationSnapshotPage>;
	observeLive(
		id: string,
		scope: "conversation" | "tasks",
		listener: HostObservationListener,
		signal?: AbortSignal,
	): Promise<(() => void) | undefined>;
	subscribeRoster(listener: () => void): () => void;
}
export interface AgentObservationSource {
	list(input?: { cursor?: string; ownerId?: string }): Promise<AgentConversationPage>;
	select(id: string | undefined): void;
	/** Reattach an unavailable selection; a pending or live attachment is unchanged. */
	refresh(id: string): void;
	/** An aborted `signal` ends the wait; a read of stored messages that has not started never starts. */
	snapshot(id: string, signal?: AbortSignal): Promise<AgentConversationSnapshot & { nextBefore?: number | null }>;
	frame(id: string): ConversationFrame | undefined;
	earlier(id: string, before: number): Promise<ConversationSnapshotPage>;
	tasks(id: string): Promise<TasksFrame>;
	/** Retry only the selected unavailable Tasks attachment, without acquiring a writer. */
	refreshTasks(id: string): void;
	releaseTasks(): void;
	availability(id: string): { state: HostObservationState; at: string } | undefined;
	subscribe(listener: () => void): () => void;
	subscribeRoster(listener: () => void): () => void;
}
/** One selected conversation and one optional task scope. Reads never acquire a writer. */
export function createAgentObservationSource(host: AgentObservationHost): AgentObservationSource {
	const listeners = new Set<() => void>();
	let selected: string | undefined;
	let frame: ConversationFrame | undefined;
	let availability: { state: HostObservationState; at: string } | undefined;
	let abort: AbortController | undefined;
	let off: (() => void) | undefined;
	let generation = 0;
	let taskId: string | undefined;
	let taskFrame: TasksFrame | undefined;
	let taskAbort: AbortController | undefined;
	let taskOff: (() => void) | undefined;
	let taskState: "pending" | HostObservationState | undefined;
	const notify = () => {
		for (const listener of listeners) listener();
	};
	function releaseTasks(): void {
		taskId = undefined;
		taskAbort?.abort();
		taskAbort = undefined;
		taskOff?.();
		taskOff = undefined;
		taskFrame = undefined;
		taskState = undefined;
	}
	function select(id: string | undefined): void {
		if (selected === id) return;
		abort?.abort();
		off?.();
		off = undefined;
		selected = id;
		frame = undefined;
		availability = undefined;
		const token = ++generation;
		if (!id) return;
		abort = new AbortController();
		void host
			.observeLive(
				id,
				"conversation",
				(value, _fresh, state) => {
					if (token === generation) conversationChanged(value, state ?? "live");
				},
				abort.signal,
			)
			.then((release) => {
				if (token !== generation) release?.();
				else {
					off = release;
					if (!release) {
						availability = { state: "unavailable", at: new Date().toISOString() };
						notify();
					}
				}
			})
			.catch(() => {
				if (token === generation) {
					availability = { state: "unavailable", at: new Date().toISOString() };
					notify();
				}
			});
	}
	function conversationChanged(value: ObservationFrame | undefined, state: HostObservationState): void {
		if (state === "live") {
			if (value?.scope !== "conversation" || (value.revision === frame?.revision && availability?.state === "live"))
				return;
		}
		if (value?.scope === "conversation") frame = value;
		availability = { state, at: frame?.observedAt ?? new Date().toISOString() };
		notify();
	}
	function taskChanged(value: ObservationFrame | undefined, state: HostObservationState): void {
		if (state === "unavailable") {
			if (!taskFrame) return;
			taskFrame = undefined;
		} else if (value?.scope !== "tasks") return;
		else if (state === "retired") taskFrame = { ...value, coverage: { ...value.coverage, live: false } };
		else {
			if (value.revision === taskFrame?.revision) return;
			taskFrame = value;
		}
		notify();
	}
	function attachTasks(): void {
		if (!taskId || taskState === "pending" || taskState === "live") return;
		taskAbort?.abort();
		taskOff?.();
		taskOff = undefined;
		taskFrame = undefined;
		taskState = "pending";
		taskAbort = new AbortController();
		const signal = taskAbort.signal;
		let observedState: HostObservationState = "live";
		void host
			.observeLive(
				taskId,
				"tasks",
				(value, _fresh, state) => {
					if (signal.aborted || ((state === undefined || state === "live") && value?.scope !== "tasks")) return;
					observedState = state ?? "live";
					if (taskState !== "pending") taskState = observedState;
					taskChanged(value, observedState);
				},
				signal,
			)
			.then((release) => {
				if (signal.aborted) release?.();
				else {
					taskOff = release;
					taskState = release ? observedState : "unavailable";
					if (!release) {
						taskFrame = undefined;
						notify();
					}
				}
			})
			.catch(() => {
				if (signal.aborted) return;
				taskState = "unavailable";
				taskFrame = undefined;
				notify();
			});
	}
	return {
		list: (input) => host.list(input),
		select,
		refresh(id) {
			if (id !== selected || (availability?.state !== "unavailable" && availability?.state !== "retired")) return;
			select(undefined);
			select(id);
		},
		async snapshot(id, signal) {
			if (id === selected && frame && availability?.state === "live")
				return {
					entries: frame.entries,
					partial: !frame.coverage.complete,
					revision: `r${frame.revision}`,
					nextBefore: frame.nextBefore,
				};
			return host.snapshot(id, undefined, signal);
		},
		frame: (id) => (id === selected ? frame : undefined),
		availability: (id) => (id === selected ? availability : undefined),
		earlier: (id, before) => host.snapshot(id, { before }),
		async tasks(id) {
			const storageId = storageIdOf(id);
			if (storageId !== taskId) {
				releaseTasks();
				taskId = storageId;
				attachTasks();
			}
			return (
				taskFrame ?? {
					scope: "tasks",
					storageId,
					revision: 0,
					observedAt: new Date(0).toISOString(),
					tasks: [],
					labels: [],
					coverage: { complete: false, live: false },
				}
			);
		},
		refreshTasks(id) {
			if (storageIdOf(id) === taskId && (taskState === "unavailable" || taskState === "retired")) attachTasks();
		},
		releaseTasks,
		subscribe(listener) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
				if (!listeners.size) {
					select(undefined);
					releaseTasks();
				}
			};
		},
		subscribeRoster: (listener) => host.subscribeRoster(listener),
	};
}
