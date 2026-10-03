/**
 * agent/live-observation: the host-owned live observation engine.
 *
 * One process owns the storage writer. This service keeps at most one watch per
 * observed conversation and one task-graph watch, advances a monotonic revision
 * from native view publications and committed status/label changes, and builds
 * bounded JSON frames on demand. A watch exists only while at least one observation token references
 * it. Reading never resumes the Harness, schedules work, or opens storage.
 */
import type { Context } from "@earendil-works/chord";
import type { ConversationId, ConversationView, Harness, LiveState, TaskGraph, WatchHandle } from "@earendil-works/pi-durable";
import { AgentMetaDoc } from "./durable-controls.ts";
import { durableIdentity, publicLiveState, readConversationStatus, selectSnapshotEntries, SNAPSHOT_BYTE_LIMIT, SNAPSHOT_ENTRY_LIMIT, snapshotEntry } from "./durable-observation.ts";
import { buildLiveEntries, jsonSafeFrame, taskGraphRows, type ConversationFrame, type ObservationFrame, type TaskLabel, type TasksFrame } from "./live-frames.ts";

/** What one observation token reads. */
export type ObservationScope = { readonly scope: "conversation"; readonly conversationId: ConversationId } | { readonly scope: "tasks" };

export interface LiveObservationOptions {
	readonly storageId: string;
	/** Clock override for tests. */
	readonly now?: () => number;
}

interface ConversationWatchState {
	readonly conversationId: ConversationId;
	readonly handle: WatchHandle<ConversationView>;
	revision: number;
	dirty: boolean;
	references: number;
	frame: ConversationFrame | undefined;
}

interface TaskGraphWatchState {
	readonly handle: WatchHandle<TaskGraph>;
	revision: number;
	dirty: boolean;
	references: number;
	frame: TasksFrame | undefined;
}

interface TokenState {
	readonly scope: ObservationScope;
	readonly key: string;
}

/** Label bound for one task-graph frame; conversation labels beyond it stay absent. */
export const TASK_LABEL_LIMIT = 64;

/** One host's live observation state over an already-open Harness. */
export class LiveObservationService {
	private readonly harness: Harness;
	private readonly options: LiveObservationOptions;
	private readonly context: Context;
	private readonly conversations = new Map<ConversationId, ConversationWatchState>();
	private readonly tokens = new Map<string, TokenState>();
	private taskGraph: TaskGraphWatchState | undefined;
	private operations: Promise<void> = Promise.resolve();

	/** Token and watch ownership change on one line, including asynchronous first-frame setup. */
	private serialize<T>(operation: () => Promise<T>): Promise<T> {
		const result = this.operations.then(operation);
		this.operations = result.then(() => {}, () => {});
		return result;
	}

	constructor(harness: Harness, options: LiveObservationOptions, context: Context) {
		this.harness = harness;
		this.options = options;
		this.context = context;
	}

	/** Open or reuse one token. Repeated calls with the same token return the current frame. */
	open(token: string, scope: ObservationScope): Promise<ObservationFrame> {
		return this.serialize(() => this.openToken(token, scope));
	}

	private async openToken(token: string, scope: ObservationScope): Promise<ObservationFrame> {
		const existing = this.tokens.get(token);
		if (existing) {
			const frame = await this.tokenFrame(token);
			if (frame === undefined) throw new Error(`observation token ${token} has no frame`);
			return frame;
		}
		const key = scope.scope === "conversation" ? `conversation:${scope.conversationId}` : "tasks";
		const state = scope.scope === "conversation" ? await this.acquireConversation(scope.conversationId) : await this.acquireTaskGraph();
		state.references += 1;
		try {
			const frame = "conversationId" in state ? await this.conversationFrame(state) : await this.taskFrame(state);
			this.tokens.set(token, { scope, key });
			return frame;
		} catch (error) {
			await this.releaseKey(key);
			throw error;
		}
	}

	/** The current frame for one token, rebuilt only after an observed publication. */
	frame(token: string): Promise<ObservationFrame | undefined> {
		return this.serialize(() => this.tokenFrame(token));
	}

	private async tokenFrame(token: string): Promise<ObservationFrame | undefined> {
		const tokenState = this.tokens.get(token);
		if (!tokenState) return undefined;
		try {
			if (tokenState.scope.scope === "conversation") {
				const state = this.conversations.get(tokenState.scope.conversationId);
				if (state === undefined) return undefined;
				return await this.conversationFrame(state);
			}
			const state = this.taskGraph;
			if (state === undefined) return undefined;
			return await this.taskFrame(state);
		} catch (error) {
			// A watch that lost its source closes rather than returning a stale frame.
			await this.releaseKey(tokenState.key);
			this.tokens.delete(token);
			throw error;
		}
	}

	/** Release one token; the last release stops the watch it referenced. */
	close(token: string): Promise<boolean> {
		return this.serialize(() => this.closeToken(token));
	}

	private async closeToken(token: string): Promise<boolean> {
		const tokenState = this.tokens.get(token);
		if (!tokenState) return false;
		this.tokens.delete(token);
		await this.releaseKey(tokenState.key);
		return true;
	}

	/** Stop every watch. Called when the host process shuts down. */
	closeAll(): Promise<void> {
		return this.serialize(() => this.stopAll());
	}

	private async stopAll(): Promise<void> {
		this.tokens.clear();
		const stops: Promise<unknown>[] = [];
		for (const state of this.conversations.values()) {
			state.references = 0;
			stops.push(state.handle.stop().catch(() => undefined));
		}
		this.conversations.clear();
		if (this.taskGraph !== undefined) {
			this.taskGraph.references = 0;
			stops.push(this.taskGraph.handle.stop().catch(() => undefined));
			this.taskGraph = undefined;
		}
		await Promise.all(stops);
	}

	/** Status and labels read documents outside the native view mounts. */
	invalidate(): void {
		for (const state of this.conversations.values()) this.invalidateState(state);
		if (this.taskGraph) this.invalidateState(this.taskGraph);
	}

	private invalidateState(state: ConversationWatchState | TaskGraphWatchState): void {
		state.revision += 1;
		state.dirty = true;
		state.frame = undefined;
	}

	/** Number of open tokens; test and diagnostics surface. */
	get size(): number {
		return this.tokens.size;
	}

	/** Number of live watches currently kept for open tokens; test and diagnostics surface. */
	get watches(): number {
		return this.conversations.size + (this.taskGraph === undefined ? 0 : 1);
	}

	private async acquireConversation(conversationId: ConversationId): Promise<ConversationWatchState> {
		const existing = this.conversations.get(conversationId);
		if (existing) return existing;
		const conversation = await this.harness.conversation(conversationId, this.context);
		if (!conversation) throw new Error(`observed conversation ${conversationId} does not exist`);
		const handle = await conversation.watch(this.context);
		const state: ConversationWatchState = { conversationId, handle, revision: 1, dirty: true, references: 0, frame: undefined };
		try {
			handle.start(async () => {
				state.revision += 1;
				state.dirty = true;
				state.frame = undefined;
			});
		} catch (error) {
			await handle.stop().catch(() => undefined);
			throw error;
		}
		this.conversations.set(conversationId, state);
		return state;
	}

	private async acquireTaskGraph(): Promise<TaskGraphWatchState> {
		if (this.taskGraph) return this.taskGraph;
		const handle = await this.harness.watchTaskGraph(this.context);
		const state: TaskGraphWatchState = { handle, revision: 1, dirty: true, references: 0, frame: undefined };
		try {
			handle.start(async () => {
				state.revision += 1;
				state.dirty = true;
				state.frame = undefined;
			});
		} catch (error) {
			await handle.stop().catch(() => undefined);
			throw error;
		}
		this.taskGraph = state;
		return state;
	}

	private async releaseKey(key: string): Promise<void> {
		if (key === "tasks") {
			const state = this.taskGraph;
			if (state === undefined) return;
			state.references = Math.max(0, state.references - 1);
			if (state.references > 0) return;
			this.taskGraph = undefined;
			await state.handle.stop().catch(() => undefined);
			return;
		}
		const id = Number(key.slice("conversation:".length)) as ConversationId;
		const state = this.conversations.get(id);
		if (state === undefined) return;
		state.references = Math.max(0, state.references - 1);
		if (state.references > 0) return;
		this.conversations.delete(id);
		await state.handle.stop().catch(() => undefined);
	}

	private async conversationFrame(state: ConversationWatchState): Promise<ConversationFrame> {
		if (state.frame !== undefined && !state.dirty) return state.frame;
		const revision = state.revision;
		const value = state.handle.value;
		const selection = selectSnapshotEntries([...value.entries].reverse(), SNAPSHOT_ENTRY_LIMIT, SNAPSHOT_BYTE_LIMIT);
		const entries = selection.entries.map((entry) => snapshotEntry(entry));
		const status = await readConversationStatus(this.harness, this.options.storageId, state.conversationId, {}, this.context);
		if (!status) throw new Error(`observed conversation ${state.conversationId} has no status`);
		const frame: ConversationFrame = jsonSafeFrame({
			scope: "conversation",
			storageId: this.options.storageId,
			conversationId: state.conversationId,
			revision,
			observedAt: new Date(this.options.now?.() ?? Date.now()).toISOString(),
			entries,
			nextBefore: selection.nextBefore,
			live: buildLiveEntries(publicLiveState(value.docs["pi.live"] as LiveState | undefined), entries),
			status,
			coverage: selection.coverage,
		});
		if (state.revision === revision) { state.frame = frame; state.dirty = false; }
		return frame;
	}

	private async taskFrame(state: TaskGraphWatchState): Promise<TasksFrame> {
		if (state.frame !== undefined && !state.dirty) return state.frame;
		const revision = state.revision;
		const rows = taskGraphRows(state.handle.value);
		const frame: TasksFrame = jsonSafeFrame({
			scope: "tasks",
			storageId: this.options.storageId,
			revision,
			observedAt: new Date(this.options.now?.() ?? Date.now()).toISOString(),
			tasks: rows,
			labels: await this.labelsFor(rows),
			coverage: { complete: true, live: true },
		});
		if (state.revision === revision) { state.frame = frame; state.dirty = false; }
		return frame;
	}

	private async labelsFor(rows: readonly { readonly conversationId: number; readonly conversations: readonly number[] }[]): Promise<TaskLabel[]> {
		const ids = new Set<ConversationId>();
		for (const row of rows) {
			ids.add(row.conversationId as ConversationId);
			for (const id of row.conversations) ids.add(id as ConversationId);
		}
		const labels: TaskLabel[] = [];
		for (const id of [...ids].sort((left, right) => left - right).slice(0, TASK_LABEL_LIMIT)) {
			try {
				const meta = await this.harness.snapshot(AgentMetaDoc, id, this.context);
				labels.push({
					conversationId: id,
					identity: durableIdentity(this.options.storageId, id === 1 ? undefined : id),
					...(typeof meta?.name === "string" ? { name: meta.name } : {}),
					...(typeof meta?.firstMessage === "string" ? { firstMessage: meta.firstMessage } : {}),
				});
			} catch {
				labels.push({ conversationId: id, identity: durableIdentity(this.options.storageId, id === 1 ? undefined : id) });
				// A missing label is display-only; the task row still carries the raw ID.
			}
		}
		return labels;
	}
}
