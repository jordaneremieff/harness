import { calculateContextTokens, type SessionEntry } from "@earendil-works/pi-coding-agent";
import type { UsageState } from "@earendil-works/pi-durable";
import type { Message } from "@earendil-works/pi-ai";
import type { AgentConversationEntry } from "./dashboard-types.ts";

function assistantTokens(message: Message): number | undefined {
	if (message.role !== "assistant" || ["pending", "error", "aborted"].includes(message.stopReason)) return undefined;
	const tokens = calculateContextTokens(message.usage);
	return tokens >= 0 && Number.isFinite(tokens) ? tokens : undefined;
}
/** Latest completed assistant usage, invalidated by a newer context rewrite. */
export function contextTokens(entries: readonly AgentConversationEntry[]): number | undefined {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry.kind === "pi.compaction" || entry.kind === "pi.reset") return undefined;
		for (const message of [...(entry.model ?? [])].reverse()) {
			const tokens = assistantTokens(message);
			if (tokens !== undefined) return tokens;
		}
	}
	return undefined;
}
export function compactTokens(tokens: number): string {
	if (tokens < 1000) return String(tokens);
	const million = tokens >= 1000000;
	const unit = million ? 1000000 : 1000;
	const value = tokens / unit;
	return `${value < 10 ? value.toFixed(1) : Math.round(value)}${million ? "M" : "k"}`;
}
function ordinaryEntryCost(entry: SessionEntry): number | undefined {
	if (entry.type === "usage" || entry.type === "compaction" || entry.type === "branch_summary")
		return entry.usage?.cost?.total ?? Number.NaN;
	if (entry.type !== "message") return undefined;
	if (entry.message.role === "assistant") return entry.message.usage?.cost?.total ?? Number.NaN;
	if (entry.message.role === "toolResult" && entry.message.usage !== undefined)
		return entry.message.usage.cost?.total ?? Number.NaN;
	return undefined;
}

/** Nominal usage from already-loaded ordinary entries, with an explicit visit bound. */
export function ordinaryReportedUsage(entries: readonly SessionEntry[]): { reportedCost: number; partial: boolean } {
	const limit = 4096;
	let reportedCost = 0;
	let partial = entries.length > limit;
	for (let index = Math.max(0, entries.length - limit); index < entries.length; index++) {
		const cost = ordinaryEntryCost(entries[index]);
		if (cost === undefined) continue;
		if (typeof cost !== "number" || !Number.isFinite(cost) || cost < 0) partial = true;
		else if (!Number.isFinite(reportedCost + cost)) partial = true;
		else reportedCost += cost;
	}
	return { reportedCost, partial };
}

export interface AgentUsageFacts {
	context?: number;
	window?: number;
	input?: number;
	output?: number;
}
export function usageFacts(context: number | undefined, window: number | undefined, usage?: UsageState): AgentUsageFacts {
	const facts: AgentUsageFacts = { context, window: window !== undefined && window > 0 && Number.isFinite(window) ? window : undefined };
	if (!usage) return facts;
	let input = 0;
	let output = 0;
	for (const value of [...Object.values(usage.models), ...Object.values(usage.tools)]) {
		input += value.input + value.cacheRead + value.cacheWrite;
		output += value.output;
	}
	return { ...facts, input, output };
}
