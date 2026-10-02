/**
 * agent/status-overview: bounded no-target status for the primary manager.
 *
 * The manager reads a dashboard page and its own primary and failure records,
 * then this pure builder produces the status object. It caps the serialized
 * result at `STATUS_OVERVIEW_BYTE_LIMIT` including the exact `coverage.bytes`
 * figure, drops array tails in session, primary, failure order, and reports
 * each omission separately. `complete` is false and `byteLimitReached` is true
 * whenever a byte bound dropped anything; the caller's own catalog coverage
 * still travels in `coverage`.
 */
import type { AgentConversationPage, AgentConversationSummary } from "./dashboard-types.ts";

/** One primary row as the manager reports it. */
export interface StatusOverviewPrimary {
	readonly sessionId: string;
	readonly cwd: string;
	readonly name?: string;
	readonly model?: { readonly provider: string; readonly modelId: string };
	readonly thinkingLevel?: string;
}

export interface StatusOverviewFailure {
	readonly storageId: string;
	readonly error: string;
}

export interface StatusOverviewCoverage {
	/** True only when the catalog scan completed and no byte bound omitted any row. */
	readonly complete: boolean;
	readonly storagesVisited: number;
	readonly skipped: number;
	/** Materialized sessions excluded by the caller's page or this byte bound. */
	readonly omitted: number;
	readonly omittedPrimaries: number;
	readonly omittedFailures: number;
	/** Exact serialized byte size of the whole status object, this field included. */
	readonly bytes: number;
	readonly byteLimitReached: boolean;
	readonly nextCursor: string | null;
}

export interface StatusOverview {
	readonly sessions: readonly AgentConversationSummary[];
	readonly primaries: readonly StatusOverviewPrimary[];
	readonly failures: readonly StatusOverviewFailure[];
	readonly coverage: StatusOverviewCoverage;
	readonly observedAt: string;
	readonly discovery: string;
}

/** Largest serialized status overview, including the measured coverage bytes. */
export const STATUS_OVERVIEW_BYTE_LIMIT = 48 * 1024;

/** Stable discovery line the manager uses for the no-target status. */
export const STATUS_OVERVIEW_DISCOVERY = "Use agent_list for paged discovery.";

type MutableOverview = {
	sessions: AgentConversationSummary[];
	primaries: StatusOverviewPrimary[];
	failures: StatusOverviewFailure[];
	coverage: {
		complete: boolean;
		storagesVisited: number;
		skipped: number;
		omitted: number;
		omittedPrimaries: number;
		omittedFailures: number;
		bytes: number;
		byteLimitReached: boolean;
		nextCursor: string | null;
	};
	observedAt: string;
	discovery: string;
};

function measure(value: unknown): number {
	return Buffer.byteLength(JSON.stringify(value), "utf8");
}

/** Set coverage.bytes to the size of the whole object until the figure is stable. */
function fixedPointBytes(value: MutableOverview): number {
	let bytes = 0;
	for (;;) {
		value.coverage.bytes = bytes;
		const next = measure(value);
		if (next === bytes) return bytes;
		bytes = next;
	}
}

/**
 * Build the bounded no-target status. Sessions drop from the end first, then
 * primaries, then failures. Each dropped row increments its own coverage
 * counter; any drop sets `byteLimitReached` and `complete: false`.
 */
export function buildStatusOverview(
	page: AgentConversationPage,
	primaries: readonly StatusOverviewPrimary[],
	failures: readonly StatusOverviewFailure[],
): StatusOverview {
	const value: MutableOverview = {
		sessions: [...page.rows],
		primaries: [...primaries],
		failures: [...failures],
		coverage: {
			complete: page.coverage.complete,
			storagesVisited: page.coverage.storagesVisited,
			skipped: page.coverage.skipped,
			omitted: page.coverage.omitted,
			omittedPrimaries: 0,
			omittedFailures: 0,
			bytes: 0,
			byteLimitReached: false,
			nextCursor: page.coverage.nextCursor,
		},
		observedAt: page.observedAt,
		discovery: STATUS_OVERVIEW_DISCOVERY,
	};
	for (;;) {
		const dropped = value.coverage.omitted > page.coverage.omitted || value.coverage.omittedPrimaries > 0 || value.coverage.omittedFailures > 0;
		value.coverage.byteLimitReached = dropped;
		value.coverage.complete = page.coverage.complete && !dropped;
		const bytes = fixedPointBytes(value);
		if (bytes <= STATUS_OVERVIEW_BYTE_LIMIT) break;
		if (value.sessions.length > 0) {
			value.sessions.pop();
			value.coverage.omitted++;
			continue;
		}
		if (value.primaries.length > 0) {
			value.primaries.pop();
			value.coverage.omittedPrimaries++;
			continue;
		}
		if (value.failures.length > 0) {
			value.failures.pop();
			value.coverage.omittedFailures++;
			continue;
		}
		// An empty overview is far below the limit; nothing more can be dropped.
		break;
	}
	return value;
}
