/**
 * Pure session-metrics scan for the statusline. Structurally typed over the
 * session-branch entries the extension context exposes, so tests need no Pi
 * session manager.
 */

interface UsageLike {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: { total: number };
}

export interface BranchEntryLike {
	type: string;
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
 * Single pass over the current branch accumulating token, cost, and cache
 * telemetry. The scan runs once per render; the branch is bounded by
 * compaction and the arithmetic is microsecond-scale, so there is no
 * memoization to invalidate.
 */
export function scanSession(entries: Iterable<BranchEntryLike>): SessionMetrics {
	const m = emptyMetrics();
	for (const e of entries) {
		if (e.type !== "message") continue;
		const msg = e.message;
		if (msg?.role !== "assistant" || !msg.usage) continue;
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
	return m;
}
