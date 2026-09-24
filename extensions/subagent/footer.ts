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

interface Spend { cost: number; incomplete: boolean }
export interface FooterCheckpoint { sessionId: string; raw: Spend; observedCost: number; agent: Spend }
export const FOOTER_ENTRY = "subagent.footer";

function validSpend(value: unknown): value is Spend {
	const spend = value as Spend | undefined;
	return !!spend && Number.isFinite(spend.cost) && spend.cost >= 0 && typeof spend.incomplete === "boolean";
}

/** Native identity prevents copied fork entries from acquiring another session's costs. */
export function restoreFooter(entries: readonly SessionEntry[], sessionId: string): FooterCheckpoint | undefined {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry.type !== "custom" || entry.customType !== FOOTER_ENTRY) continue;
		const saved = entry.data as FooterCheckpoint | undefined;
		if (saved?.sessionId !== sessionId) continue;
		if (validSpend(saved.raw) && validSpend(saved.agent) && Number.isFinite(saved.observedCost) && saved.observedCost >= 0) return structuredClone(saved);
		return { sessionId, raw: { cost: 0, incomplete: true }, observedCost: 0, agent: { cost: 0, incomplete: true } };
	}
	return undefined;
}

/** Raw publication never includes the separate ordinary-host contribution used for display. */
export class SessionFooter {
	readonly saved: FooterCheckpoint;
	private agentActive = 0;
	private agentAvailable = false;
	constructor(sessionId: string, saved?: FooterCheckpoint) {
		this.saved = saved ?? { sessionId, raw: { cost: 0, incomplete: false }, observedCost: 0, agent: { cost: 0, incomplete: false } };
	}
	raw(status: SubtreeStatus): SubtreeStatus {
		const delta = status.cost - this.saved.observedCost;
		if (delta >= 0 && Number.isFinite(this.saved.raw.cost + delta)) this.saved.raw.cost += delta;
		else this.saved.raw.incomplete = true;
		this.saved.observedCost = status.cost;
		return { ...status, cost: this.saved.raw.cost, incomplete: status.incomplete || this.saved.raw.incomplete };
	}
	acceptAgent(data: unknown): boolean {
		if (!data || typeof data !== "object") return false;
		const value = data as Record<string, unknown>;
		if (value.version !== 1 || value.publisher !== "agent" || value.sessionId !== this.saved.sessionId) return false;
		if (value.available === true && validSpend(value) && Number.isSafeInteger(value.active) && (value.active as number) >= 0) {
			this.saved.agent.incomplete = value.incomplete || value.cost < this.saved.agent.cost;
			this.saved.agent.cost = Math.max(this.saved.agent.cost, value.cost);
			this.agentActive = value.active as number;
			this.agentAvailable = true;
		} else {
			this.agentActive = 0; this.agentAvailable = false;
			this.saved.agent.incomplete = true;
		}
		return true;
	}
	finish(raw: SubtreeStatus): void {
		this.saved.raw.incomplete ||= raw.incomplete;
		this.saved.agent.incomplete ||= !this.agentAvailable && this.saved.agent.cost > 0;
	}
	display(raw: SubtreeStatus): SubtreeStatus {
		return { ...raw, active: raw.active + this.agentActive, cost: raw.cost + this.saved.agent.cost, incomplete: raw.incomplete || this.saved.agent.incomplete || (!this.agentAvailable && this.saved.agent.cost > 0) };
	}
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

export function formatSubtreeStatus(status: SubtreeStatus): string {
	const spend = status.cost > 0 && status.cost < 0.01 ? status.cost.toFixed(4) : status.cost.toFixed(2);
	const unknown = status.incomplete ? "+?" : "";
	return `subagents ${status.active}${unknown} · $${spend}${unknown}`;
}
