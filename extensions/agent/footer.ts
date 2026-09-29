import type { SessionEntry, SessionManager } from "@earendil-works/pi-coding-agent";

export interface Spend { cost: number; incomplete: boolean }
export interface AgentFooterState { active: boolean; spend: Spend }

/** Count only entries appended while this host owns the session. */
export class OwnedSpend {
	private manager: SessionManager | undefined;
	private cursor = 0;
	readonly total: Spend = { cost: 0, incomplete: false };
	bind(manager: SessionManager): void {
		if (this.manager === manager) return;
		this.sync();
		this.manager = manager;
		this.cursor = manager.getEntries().length;
	}
	sync(): void {
		if (!this.manager) return;
		const entries = this.manager.getEntries();
		for (const entry of entries.slice(this.cursor)) this.add(entry);
		this.cursor = entries.length;
	}
	private add(entry: SessionEntry): void {
		let usage: unknown;
		let required = false;
		if (entry.type === "usage") { usage = entry.usage; required = true; }
		else if (entry.type === "compaction" || entry.type === "branch_summary") {
			usage = entry.usage; required = entry.fromHook !== true;
		} else if (entry.type === "message") {
			if (entry.message.role === "assistant") { usage = entry.message.usage; required = true; }
			else if (entry.message.role === "toolResult") usage = entry.message.usage;
		}
		if (usage === undefined && !required) return;
		const cost = (usage as { cost?: { total?: unknown } } | null)?.cost?.total;
		if (typeof cost !== "number" || !Number.isFinite(cost) || cost < 0) this.total.incomplete = true;
		else this.total.cost += cost;
	}
}

function price(spend: Spend): string {
	const digits = spend.cost > 0 && spend.cost < 0.01 ? 4 : 2;
	return `$${spend.cost.toFixed(digits)}${spend.incomplete ? "+?" : ""}`;
}

export interface DetachedFooterState { recorded: number | null; unavailable: number | null; exists: boolean }

export interface FooterTotals { active: number; spend: Spend }
export interface FooterCheckpoint { sessionId: string; spend: Spend }
export const FOOTER_ENTRY = "agent.footer";

export function aggregateFooter(states: AgentFooterState[]): FooterTotals {
	return {
		active: states.filter((state) => state.active).length,
		spend: states.reduce<Spend>((sum, state) => ({ cost: sum.cost + state.spend.cost, incomplete: sum.incomplete || state.spend.incomplete }), { cost: 0, incomplete: false }),
	};
}

function validSpend(value: unknown): value is Spend {
	const spend = value as Spend | undefined;
	return !!spend && typeof spend.cost === "number" && Number.isFinite(spend.cost) && spend.cost >= 0 && typeof spend.incomplete === "boolean";
}

/** Session identity excludes copied fork checkpoints; all branches describe actual incurred work. */
export function restoreFooter(entries: readonly SessionEntry[], sessionId: string): FooterCheckpoint {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry.type !== "custom" || entry.customType !== FOOTER_ENTRY) continue;
		const saved = entry.data as FooterCheckpoint | undefined;
		if (saved?.sessionId !== sessionId) continue;
		if (validSpend(saved.spend)) return { sessionId, spend: { ...saved.spend } };
		return { sessionId, spend: { cost: 0, incomplete: true } };
	}
	return { sessionId, spend: { cost: 0, incomplete: false } };
}

/** A primary observes only manager changes after attachment, plus its own saved totals. */
export class SessionFooter {
	private previous: FooterTotals;
	readonly saved: FooterCheckpoint;
	constructor(saved: FooterCheckpoint, initial: FooterTotals) { this.saved = saved; this.previous = initial; }
	observe(current: FooterTotals): FooterTotals {
		const delta = current.spend.cost - this.previous.spend.cost;
		if (delta >= 0 && Number.isFinite(this.saved.spend.cost + delta)) this.saved.spend.cost += delta;
		else this.saved.spend.incomplete = true;
		this.saved.spend.incomplete ||= current.spend.incomplete;
		this.previous = current;
		return { active: current.active, spend: { ...this.saved.spend } };
	}
}

export function formatAgentFooter(states: AgentFooterState[], detached: DetachedFooterState): string {
	return formatAgentTotals(aggregateFooter(states), detached);
}

export function formatAgentTotals(totals: FooterTotals, detached: DetachedFooterState): string {
	const exception = detached.recorded !== 0 || detached.unavailable !== 0;
	return `agents ${totals.active} · ${price(totals.spend)}${exception ? ` · detached ${detached.recorded ?? "?"}${detached.unavailable === null ? "/? lost" : detached.unavailable ? `/${detached.unavailable} lost` : ""}/$?` : ""}`;
}
