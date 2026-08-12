/**
 * Sidebar slot: show this session's subagent activity in the herdr sidebar.
 *
 * The subagent extension owns the active-worker count and cumulative spend. It
 * publishes both on the Pi event bus; this extension listens, formats them into
 * one herdr metadata token, and reports that token on the identity source so a
 * sidebar row can show it. The two extensions share only the documented channel
 * and payload: this one never reads the subagent status text.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { HerdrClient } from "./socket.ts";

/** Event bus channel the subagent extension emits activity on. */
export const SUBAGENT_ACTIVITY_CHANNEL = "harness:subagent:activity";

/** Source the token is reported on, shared with the model token. */
export const SOURCE = "custom:pi-identity";
/** Token name herdr renders as `$subagents` in a sidebar row. */
const TOKEN_NAME = "subagents";
/** Bounded staleness: a fresh event re-syncs; a quiet session clears it. */
const TTL_MS = 30 * 60 * 1000;

/** Format a cost the way the status line does: four decimals under one cent. */
export function formatCost(cost: number): string {
	return cost > 0 && cost < 0.01 ? cost.toFixed(4) : cost.toFixed(2);
}

/** Format the `active · cost` token value herdr shows in a sidebar row. */
export function formatSubagentToken(active: number, cost: number): string {
	return `${active} active · $${formatCost(cost)}`;
}

/** Read the structured payload, or undefined when it is not the activity event. */
export function parseSubagentActivity(payload: unknown): { active: number; cost: number } | undefined {
	if (typeof payload !== "object" || payload === null) return undefined;
	const candidate = payload as { active?: unknown; cost?: unknown };
	const { active, cost } = candidate;
	if (typeof active !== "number" || typeof cost !== "number") return undefined;
	if (!Number.isFinite(active) || !Number.isFinite(cost)) return undefined;
	return { active: Math.max(0, Math.trunc(active)), cost: Math.max(0, cost) };
}

export interface SubagentSlotDeps {
	client: HerdrClient;
	paneId: string;
}

/**
 * Report the activity as a sidebar token.
 *
 * Returns the token value written, so a caller can clear the source on shutdown.
 */
export async function reportSubagentToken(deps: SubagentSlotDeps, activity: { active: number; cost: number }): Promise<string> {
	const value = formatSubagentToken(activity.active, activity.cost);
	await deps.client.send("pane.report_metadata", {
		pane_id: deps.paneId,
		source: SOURCE,
		agent: "pi",
		seq: deps.client.nextSeq(),
		tokens: { [TOKEN_NAME]: value },
		ttl_ms: TTL_MS,
	});
	return value;
}

/** Withdraw the token, for example when the activity goes empty. */
export async function clearSubagentToken(deps: SubagentSlotDeps): Promise<void> {
	await deps.client.send("pane.report_metadata", {
		pane_id: deps.paneId,
		source: SOURCE,
		agent: "pi",
		seq: deps.client.nextSeq(),
		tokens: { [TOKEN_NAME]: null },
	});
}

/**
 * Listen for subagent activity and report each change as a sidebar token.
 *
 * Returns an unsubscribe function. The listener is fire-and-forget: a failed
 * report drops and the next event re-syncs.
 */
export function registerSubagentSlot(pi: ExtensionAPI, deps: SubagentSlotDeps): () => void {
	return pi.events.on(SUBAGENT_ACTIVITY_CHANNEL, (payload) => {
		const activity = parseSubagentActivity(payload);
		if (!activity) return;
		if (activity.active === 0 && activity.cost === 0) {
			void clearSubagentToken(deps);
			return;
		}
		void reportSubagentToken(deps, activity);
	});
}
