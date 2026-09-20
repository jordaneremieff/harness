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

interface SessionMetrics {
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
