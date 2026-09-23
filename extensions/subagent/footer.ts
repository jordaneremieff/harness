import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { WorkerRecord } from "./index.ts";

/** Native entries define observed spend; copied transcript entries stay outside the cursor. */
export class UsageEvidence {
	private cursor: number;
	cost = 0;
	incomplete = false;
	constructor(start = 0) { this.cursor = start; }
	observe(entries: readonly SessionEntry[]): void {
		if (entries.length < this.cursor) this.incomplete = true;
		for (; this.cursor < entries.length; this.cursor++) {
			const entry = entries[this.cursor];
			let usage: unknown;
			if (entry.type === "usage" || entry.type === "compaction" || entry.type === "branch_summary") {
				usage = entry.usage;
			} else if (entry.type === "message" && entry.message.role === "assistant") {
				usage = entry.message.usage;
			} else if (entry.type === "message" && entry.message.role === "toolResult" && entry.message.usage) {
				usage = entry.message.usage;
			} else continue;
			const amount = (usage as { cost?: { total?: unknown } } | undefined)?.cost?.total;
			if (typeof amount === "number" && Number.isFinite(amount) && amount >= 0 && Number.isFinite(this.cost + amount)) this.cost += amount;
			else this.incomplete = true;
		}
	}
}

export interface SubtreeStatus {
	active: number;
	cost: number;
	incomplete: boolean;
	workers: number;
}

/** Follow worker-session ownership edges, never arbitrary session ancestry. */
export function subtreeStatus(
	records: readonly WorkerRecord[],
	ownerSession: string,
	activeIds: ReadonlySet<string>,
	observedIds: ReadonlySet<string> = activeIds,
): SubtreeStatus {
	const children = new Map<string, WorkerRecord[]>();
	for (const record of records) {
		if (!record.ownerSession) continue;
		const group = children.get(record.ownerSession) ?? [];
		group.push(record);
		children.set(record.ownerSession, group);
	}
	const result: SubtreeStatus = { active: 0, cost: 0, incomplete: false, workers: 0 };
	const seen = new Set<string>();
	const sessions = [ownerSession];
	for (let index = 0; index < sessions.length; index++) {
		for (const record of children.get(sessions[index]) ?? []) {
			if (seen.has(record.id)) continue;
			seen.add(record.id);
			sessions.push(...ownedSessions(record));
			addRecordStatus(result, record, activeIds, observedIds);
		}
	}
	return result;
}

function ownedSessions(record: WorkerRecord): string[] {
	return [...new Set([record.sessionId, ...(record.previousSessionIds ?? [])].filter(Boolean))];
}

function addRecordStatus(result: SubtreeStatus, record: WorkerRecord, active: ReadonlySet<string>, observed: ReadonlySet<string>): void {
	result.workers++;
	if (record.state === "running") {
		if (active.has(record.id)) result.active++;
		if (!observed.has(record.id)) result.incomplete = true;
	}
	const cost = record.usage?.cost;
	if (typeof cost === "number" && Number.isFinite(cost) && cost >= 0 && Number.isFinite(result.cost + cost)) result.cost += cost;
	else result.incomplete = true;
	if (record.usage?.incomplete) result.incomplete = true;
}

export function formatSubtreeStatus(status: SubtreeStatus): string | undefined {
	if (status.workers === 0 && !status.incomplete) return undefined;
	const spend = status.cost > 0 && status.cost < 0.01 ? status.cost.toFixed(4) : status.cost.toFixed(2);
	const unknown = status.incomplete ? "+?" : "";
	return `subagents: ${status.active}${unknown} active · $${spend}${unknown}`;
}
