/**
 * Pure session-metrics scan for the statusline. Structurally typed over the
 * session entries the extension context exposes, so tests need no Pi
 * session manager.
 */

interface UsageLike {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: { total: number };
}

export interface SessionEntryLike {
	type: string;
	usage?: UsageLike;
	message?: { role?: string; usage?: UsageLike };
}

export interface SessionMetrics {
	inputTokens: number;
	outputTokens: number;
	cost: number;
	cacheRead: number;
	cacheWrite: number;
	/** Cache outcome of the most recent cache-active turn; null when no turn used cache yet. */
	lastTurnCacheHit: boolean | null;
	/** Whether any assistant turn reported cache usage at all. */
	sawCacheUsage: boolean;
}

export function emptyMetrics(): SessionMetrics {
	return {
		inputTokens: 0,
		outputTokens: 0,
		cost: 0,
		cacheRead: 0,
		cacheWrite: 0,
		lastTurnCacheHit: null,
		sawCacheUsage: false,
	};
}

/**
 * Cost includes all Pi usage-bearing entry types, including cache warming and
 * abandoned branches. Cache statistics include only assistant turns, so paid
 * background refreshes do not masquerade as cache reuse by an assistant.
 */
function addEntryMetrics(m: SessionMetrics, e: SessionEntryLike): void {
	if (e.type === "usage" || e.type === "compaction" || e.type === "branch_summary") {
		m.cost += e.usage?.cost.total ?? 0;
		return;
	}
	if (e.type !== "message") return;
	const msg = e.message;
	if (msg?.role === "toolResult") {
		m.cost += msg.usage?.cost.total ?? 0;
		return;
	}
	if (msg?.role !== "assistant" || !msg.usage) return;
	const u = msg.usage;
	m.inputTokens += u.input;
	m.outputTokens += u.output;
	m.cost += u.cost.total;
	m.cacheRead += u.cacheRead;
	m.cacheWrite += u.cacheWrite;
	if (u.cacheRead > 0 || u.cacheWrite > 0) {
		m.sawCacheUsage = true;
		m.lastTurnCacheHit = u.cacheRead > 0;
	}
}

export function scanSession(entries: Iterable<SessionEntryLike>): SessionMetrics {
	const m = emptyMetrics();
	for (const e of entries) addEntryMetrics(m, e);
	return m;
}

export interface MetricsSource {
	getEntries(): SessionEntryLike[];
	getLeafId(): string | null;
	getEntry(id: string): (SessionEntryLike & { parentId: string | null }) | undefined;
}

/** Whole-session totals with bounded catch-up over new append-only entries. */
export class MetricsCache {
	value = emptyMetrics();
	private leaf: string | null = null;
	private pending: { target: string | null; cursor: string | null; delta: SessionMetrics } | undefined;

	/** Session replacement and tree navigation require one authoritative reconciliation. */
	reset(source: MetricsSource): void {
		this.value = scanSession(source.getEntries());
		this.leaf = source.getLeafId();
		this.pending = undefined;
	}

	/** False requests another bounded catch-up turn; unchanged history requires no entry reads. */
	refresh(source: MetricsSource): boolean {
		const target = source.getLeafId();
		if (!this.pending && target === this.leaf) return true;
		let pending = this.pending;
		if (pending === undefined) {
			pending = { target, cursor: target, delta: emptyMetrics() };
			this.pending = pending;
		}
		for (let visited = 0; pending.cursor !== this.leaf && visited < 256; visited += 1) {
			const entry = pending.cursor === null ? undefined : source.getEntry(pending.cursor);
			if (!entry) { this.reset(source); return true; }
			const newestCache = pending.delta.lastTurnCacheHit;
			addEntryMetrics(pending.delta, entry);
			if (newestCache !== null) pending.delta.lastTurnCacheHit = newestCache;
			pending.cursor = entry.parentId;
		}
		if (pending.cursor !== this.leaf) return false;
		for (const key of ["inputTokens", "outputTokens", "cost", "cacheRead", "cacheWrite"] as const)
			this.value[key] += pending.delta[key];
		this.value.sawCacheUsage ||= pending.delta.sawCacheUsage;
		if (pending.delta.lastTurnCacheHit !== null) this.value.lastTurnCacheHit = pending.delta.lastTurnCacheHit;
		this.leaf = pending.target;
		this.pending = undefined;
		return source.getLeafId() === this.leaf;
	}
}
