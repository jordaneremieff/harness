import type { AgentConversationPage, AgentConversationSnapshot } from "./dashboard-types.ts";
import type { ConversationSnapshotPage } from "./durable-observation.ts";
import type { ConversationFrame, ObservationFrame, TasksFrame } from "./live-frames.ts";
import { storageIdOf } from "./catalog.ts";

export interface AgentObservationHost {
	list(input?: { cursor?: string }): Promise<AgentConversationPage>;
	snapshot(id: string, params?: { before?: number }): Promise<ConversationSnapshotPage>;
	observeLive(
		id: string,
		scope: "conversation" | "tasks",
		listener: (frame: ObservationFrame | undefined, fresh: boolean, state?: "live" | "unavailable") => void,
		signal?: AbortSignal,
	): Promise<(() => void) | undefined>;
	subscribeRoster(listener: () => void): () => void;
}
export interface AgentObservationSource {
	list(input?: { cursor?: string }): Promise<AgentConversationPage>;
	select(id: string | undefined): void;
	/** Reattach the selected conversation when it has no live frame; a live selection is unchanged. */
	refresh(id: string): void;
	snapshot(id: string): Promise<AgentConversationSnapshot & { nextBefore?: number | null }>;
	frame(id: string): ConversationFrame | undefined;
	earlier(id: string, before: number): Promise<ConversationSnapshotPage>;
	tasks(id: string): Promise<TasksFrame>;
	releaseTasks(): void;
	availability(id: string): { state: "live" | "unavailable"; at: string } | undefined;
	subscribe(listener: () => void): () => void;
	subscribeRoster(listener: () => void): () => void;
}
/** One selected conversation and one optional task scope. Reads never acquire a writer. */
export function createAgentObservationSource(host: AgentObservationHost): AgentObservationSource {
	const listeners = new Set<() => void>();
	let selected: string | undefined;
	let frame: ConversationFrame | undefined;
	let availability: { state: "live" | "unavailable"; at: string } | undefined;
	let abort: AbortController | undefined;
	let off: (() => void) | undefined;
	let generation = 0;
	let taskId: string | undefined;
	let taskFrame: TasksFrame | undefined;
	let taskAbort: AbortController | undefined;
	let taskOff: (() => void) | undefined;
	const notify = () => {
		for (const listener of listeners) listener();
	};
	function releaseTasks(): void {
		taskId = undefined;
		taskAbort?.abort();
		taskOff?.();
		taskOff = undefined;
		taskFrame = undefined;
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
					if (token !== generation) return;
					if (state === "unavailable") {
						availability = { state, at: frame?.observedAt ?? new Date().toISOString() };
						notify();
						return;
					}
					if (value?.scope !== "conversation" || (value.revision === frame?.revision && availability?.state === "live"))
						return;
					frame = value;
					availability = { state: "live", at: value.observedAt };
					notify();
				},
				abort.signal,
			)
			.then((release) => {
				if (token !== generation) release?.();
				else off = release;
			})
			.catch(() => {
				if (token === generation) {
					availability = { state: "unavailable", at: new Date().toISOString() };
					notify();
				}
			});
	}
	function taskChanged(value: ObservationFrame | undefined, state?: "live" | "unavailable"): void {
		if (state === "unavailable") {
			if (!taskFrame) return;
			taskFrame = undefined;
		} else if (value?.scope === "tasks") {
			if (value.revision === taskFrame?.revision) return;
			taskFrame = value;
		}
		notify();
	}
	return {
		list: (input) => host.list(input),
		select,
		refresh(id) {
			if (id !== selected || availability?.state === "live") return;
			select(undefined);
			select(id);
		},
		async snapshot(id) {
			if (id === selected && frame && availability?.state === "live")
				return {
					entries: frame.entries,
					partial: !frame.coverage.complete,
					revision: `r${frame.revision}`,
					nextBefore: frame.nextBefore,
				};
			return host.snapshot(id);
		},
		frame: (id) => (id === selected ? frame : undefined),
		availability: (id) => (id === selected ? availability : undefined),
		earlier: (id, before) => host.snapshot(id, { before }),
		async tasks(id) {
			const storageId = storageIdOf(id);
			if (storageId !== taskId) {
				releaseTasks();
				taskId = storageId;
				taskAbort = new AbortController();
				const signal = taskAbort.signal;
				void host
					.observeLive(
						storageId,
						"tasks",
						(value, _fresh, state) => {
							if (!signal.aborted) taskChanged(value, state);
						},
						signal,
					)
					.then((release) => {
						if (signal.aborted) release?.();
						else taskOff = release;
					})
					.catch(() => undefined);
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
