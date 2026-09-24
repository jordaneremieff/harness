import type { EventBus, SessionEntry, SessionManager } from "@earendil-works/pi-coding-agent";

/** Package contract: docs/conventions/status-keys.md. */
export const WORK_STATUS_REQUEST = "harness:work-status:request";
export const WORK_STATUS_SNAPSHOT = "harness:work-status:snapshot";
export interface Spend { cost: number; incomplete: boolean }
export interface NestedWork extends Spend { active: number; available: boolean }
export interface AgentFooterState { active: boolean; spend: Spend; nested: NestedWork }

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

function isAvailableSnapshot(value: Record<string, unknown>): value is Record<string, unknown> & NestedWork {
	return value.available === true && Number.isSafeInteger(value.active) && (value.active as number) >= 0
		&& typeof value.cost === "number" && Number.isFinite(value.cost) && value.cost >= 0 && typeof value.incomplete === "boolean";
}

/** A snapshot replaces its predecessor; it is never a spend delta. */
export class NestedStatus {
	private current: NestedWork = { active: 0, cost: 0, incomplete: false, available: false };
	private retained: Spend = { cost: 0, incomplete: false };
	private sessionId: string | undefined;
	private baseline: number | undefined;
	private initializing = true;
	private initialGap = false;
	private unsubscribe: (() => void) | undefined;
	bind(bus: EventBus, sessionId: string, changed: () => void): void {
		this.unsubscribe?.();
		if (this.sessionId !== sessionId) {
			if (this.sessionId) {
				this.retained.cost += this.current.cost;
				this.retained.incomplete ||= this.current.incomplete || !this.current.available;
			}
			this.current = { active: 0, cost: 0, incomplete: false, available: false };
			this.baseline = undefined;
			this.initializing = true;
			this.initialGap = false;
		}
		this.sessionId = sessionId;
		this.unsubscribe = bus.on(WORK_STATUS_SNAPSHOT, (data: unknown) => {
			if (!data || typeof data !== "object") return;
			const value = data as Record<string, unknown>;
			if (value.version !== 1 || value.publisher !== "subagent" || value.sessionId !== this.sessionId) return;
			if (value.available === false) {
				this.current.available = false;
				this.current.active = 0;
			} else if (isAvailableSnapshot(value)) {
				if (this.baseline === undefined) {
					this.baseline = value.cost;
					this.initialGap = !this.initializing;
				}
				const cost = value.cost - this.baseline;
				this.current = { active: value.active, cost: Math.max(this.current.cost, cost), incomplete: value.incomplete || this.initialGap || cost < this.current.cost, available: true };
			} else {
				this.current.available = false;
				this.current.incomplete = true;
			}
			changed();
		});
	}
	request(bus: EventBus): void {
		bus.emit(WORK_STATUS_REQUEST, { version: 1, publisher: "subagent", sessionId: this.sessionId });
		this.initializing = false;
	}
	snapshot(): NestedWork {
		return { ...this.current, cost: this.retained.cost + this.current.cost, incomplete: this.retained.incomplete || this.current.incomplete };
	}
	close(): void {
		this.unsubscribe?.(); this.unsubscribe = undefined;
		this.current.active = 0; this.current.available = false;
	}
}

function price(spend: Spend): string {
	const digits = spend.cost > 0 && spend.cost < 0.01 ? 4 : 2;
	return `$${spend.cost.toFixed(digits)}${spend.incomplete ? "+?" : ""}`;
}

export interface DetachedFooterState { recorded: number | null; unavailable: number | null; exists: boolean }

export interface FooterTotals { active: number; spend: Spend; nested: NestedWork }
export interface FooterCheckpoint { sessionId: string; spend: Spend; nested: Spend }
export const FOOTER_ENTRY = "agent.footer";

export function aggregateFooter(states: AgentFooterState[]): FooterTotals {
	return {
		active: states.filter((state) => state.active).length,
		spend: states.reduce<Spend>((sum, state) => ({ cost: sum.cost + state.spend.cost, incomplete: sum.incomplete || state.spend.incomplete }), { cost: 0, incomplete: false }),
		nested: states.reduce<NestedWork>((sum, state) => ({ active: sum.active + state.nested.active, cost: sum.cost + state.nested.cost, incomplete: sum.incomplete || state.nested.incomplete, available: sum.available && state.nested.available }), { active: 0, cost: 0, incomplete: false, available: true }),
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
		if (validSpend(saved.spend) && validSpend(saved.nested)) return structuredClone(saved);
		return { sessionId, spend: { cost: 0, incomplete: true }, nested: { cost: 0, incomplete: true } };
	}
	return { sessionId, spend: { cost: 0, incomplete: false }, nested: { cost: 0, incomplete: false } };
}

/** A primary observes only manager changes after attachment, plus its own saved totals. */
export class SessionFooter {
	private previous: FooterTotals;
	readonly saved: FooterCheckpoint;
	constructor(saved: FooterCheckpoint, initial: FooterTotals) { this.saved = saved; this.previous = initial; }
	observe(current: FooterTotals): FooterTotals {
		for (const key of ["spend", "nested"] as const) {
			const delta = current[key].cost - this.previous[key].cost;
			if (delta >= 0 && Number.isFinite(this.saved[key].cost + delta)) this.saved[key].cost += delta;
			else this.saved[key].incomplete = true;
			if (key === "spend") this.saved[key].incomplete ||= current[key].incomplete;
		}
		this.previous = current;
		return { active: current.active, spend: { ...this.saved.spend }, nested: { ...current.nested, cost: this.saved.nested.cost, incomplete: this.saved.nested.incomplete || current.nested.incomplete } };
	}
}

export function formatAgentFooter(states: AgentFooterState[], detached: DetachedFooterState): string {
	return formatAgentTotals(aggregateFooter(states), detached);
}

export function formatAgentTotals(totals: FooterTotals, detached: DetachedFooterState): string {
	const exception = detached.recorded !== 0 || detached.unavailable !== 0;
	return `agents ${totals.active} · ${price(totals.spend)}${exception ? ` · detached ${detached.recorded ?? "?"}${detached.unavailable === null ? "/? lost" : detached.unavailable ? `/${detached.unavailable} lost` : ""}/$?` : ""}`;
}
