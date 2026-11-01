import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { JsonValue } from "@earendil-works/chord";
import type { RexCoreOptions, RexResult } from "./core.ts";
import { validateStatusBinding, type RexExecutor, type StatusStore } from "./status.ts";
import { initialOwnershipState, validateOwnershipState, type OwnershipState, type OwnershipStore } from "./ownership.ts";

export function resultChannels(result: RexResult): { content: Array<{ type: "text"; text: string }>; structuredContent: JsonValue; isError: boolean; details: { outcome: string; effects: string } } {
	return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: JSON.parse(JSON.stringify(result)) as JsonValue, isError: !result.ok, details: { outcome: result.outcome, effects: result.effects.state } };
}

export interface RexAdapterOptions {
	createCore?: (options: RexCoreOptions) => RexExecutor;
}

/** Live invocation identity ends only after the owning tool finishes its cleanup. */
export function liveCalls(): { enter(ownerId: string, callId: string): () => void; isCallActive(ownerId: string, callId: string): boolean; drain(): Promise<void> } {
	const owners = new Map<string, Map<string, number>>();
	const waiters = new Set<() => void>();
	return {
		enter: (ownerId, callId) => {
			const calls = owners.get(ownerId) ?? new Map<string, number>();
			owners.set(ownerId, calls);
			calls.set(callId, (calls.get(callId) ?? 0) + 1);
			let released = false;
			return () => {
				if (released) return;
				released = true;
				const count = calls.get(callId) ?? 0;
				if (count > 1) calls.set(callId, count - 1);
				else calls.delete(callId);
				if (calls.size === 0) owners.delete(ownerId);
				if (owners.size === 0) { for (const resolve of waiters) resolve(); waiters.clear(); }
			};
		},
		isCallActive: (ownerId, callId) => owners.get(ownerId)?.has(callId) ?? false,
		drain: () => owners.size === 0 ? Promise.resolve() : new Promise<void>((resolve) => { waiters.add(resolve); }),
	};
}

/** Serialise a complete read/change/write operation, not only the final write. */
export function serialiseOwners(): <T>(owner: string, action: () => Promise<T>) => Promise<T> {
	const tails = new Map<string, Promise<unknown>>();
	return async <T>(owner: string, action: () => Promise<T>): Promise<T> => {
		const previous = tails.get(owner) ?? Promise.resolve();
		const current = previous.catch(() => undefined).then(action);
		tails.set(owner, current);
		try { return await current; }
		finally { if (tails.get(owner) === current) tails.delete(owner); }
	};
}

export function ordinaryStatusStore(pi: Pick<ExtensionAPI, "appendEntry">, ctx: Pick<ExtensionContext, "sessionManager">, serialise: ReturnType<typeof serialiseOwners>, signal?: AbortSignal): StatusStore {
	const ownerId = ordinaryOwner(ctx);
	const check = () => { if (ordinaryOwner(ctx) !== ownerId) throw new Error("The Rex caller changed sessions."); };
	return {
		read: async () => {
			check();
			const entries = ctx.sessionManager.getEntries();
			for (let index = entries.length - 1; index >= 0; index--) {
				const entry = entries[index];
				if (entry.type !== "custom" || entry.customType !== "rex.status") continue;
				const data = entry.data as { ownerId?: unknown; binding?: unknown } | undefined;
				if (data?.ownerId === ownerId) return validateStatusBinding(data.binding, ownerId);
			}
			return undefined;
		},
		write: (binding) => serialise(ownerId, async () => {
			if (signal?.aborted) throw new Error("The status call was cancelled before state write.");
			check();
			pi.appendEntry("rex.status", { ownerId, binding: validateStatusBinding(binding, ownerId) ?? null });
		}),
	};
}

export function ordinaryOwner(ctx: Pick<ExtensionContext, "sessionManager">): string {
	return `ordinary:${ctx.sessionManager.getSessionId()}`;
}

/** Session entries retain claims without placing them in model context. */
export function ordinaryOwnershipStore(
	pi: Pick<ExtensionAPI, "appendEntry">,
	ctx: Pick<ExtensionContext, "sessionManager">,
	maxRecords: number,
	serialise: ReturnType<typeof serialiseOwners>,
): OwnershipStore {
	const owner = ordinaryOwner(ctx);
	const assertOwner = (ownerId: string) => {
		if (ownerId !== owner || ordinaryOwner(ctx) !== owner) throw new Error("The Rex caller changed sessions. Reconcile in the original session.");
	};
	const read = async (ownerId: string): Promise<OwnershipState> => {
		assertOwner(ownerId);
		const entries = ctx.sessionManager.getEntries();
		for (let index = entries.length - 1; index >= 0; index--) {
			const entry = entries[index];
			if (entry.type !== "custom" || entry.customType !== "rex.ownership") continue;
			const data = entry.data as { ownerId?: unknown; state?: unknown } | undefined;
			if (data?.ownerId === owner) {
				const state = validateOwnershipState(data.state, maxRecords);
				if (state.records.some((record) => record.ownerId !== owner)) throw new Error("Rex ownership records belong to another caller.");
				return state;
			}
		}
		return initialOwnershipState();
	};
	return {
		read,
		update: (ownerId, change) => serialise(ownerId, async () => {
			const state = validateOwnershipState(change(await read(ownerId)), maxRecords);
			assertOwner(ownerId);
			if (state.records.some((record) => record.ownerId !== ownerId)) throw new Error("Rex ownership records belong to another caller.");
			if (state.records.some((record) => record.phase === "pending") && ctx.sessionManager.getSessionFile()) {
				const admitted = ctx.sessionManager.getEntries().some((entry) => entry.type === "message" && (entry.message.role === "user" || entry.message.role === "assistant"));
				if (!admitted) throw new Error("A persistent Rex effect requires an admitted user or assistant message.");
			}
			pi.appendEntry("rex.ownership", { ownerId, state });
			return state;
		}),
	};
}
