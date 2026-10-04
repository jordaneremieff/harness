/** Compact fleet orientation over one supplied dashboard page, without host acquisition. */
import type { AgentConversationPage, AgentConversationSummary } from "./dashboard-types.ts";
import type { EffortAwareness } from "./effort-awareness.ts";

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
	/** Complete source inventory for this page, with no additional byte omissions. Summaries are intentional. */
	readonly complete: boolean;
	readonly storagesVisited: number;
	readonly skipped: number;
	/** Source-excluded rows plus live or attention rows excluded by this byte bound. */
	readonly omitted: number;
	readonly omittedPrimaries: number;
	readonly omittedFailures: number;
	/** Exact serialized size, including this field. */
	readonly bytes: number;
	readonly byteLimitReached: boolean;
	/** Status has no continuation parameter; raw source cursors are never exposed. */
	readonly nextCursor: null;
	/** Source boundaries and exact reasons that continuation cannot recover some detail. */
	readonly reasons: readonly string[];
}

export interface StatusOverview {
	readonly awareness?: EffortAwareness;
	readonly sessions: readonly AgentConversationSummary[];
	readonly primaries: readonly StatusOverviewPrimary[];
	readonly failures: readonly StatusOverviewFailure[];
	readonly summary: {
		readonly sessions: {
			readonly observed: number;
			readonly working: number;
			readonly attention: number;
			readonly quiet: number;
			readonly summarizedQuiet: number;
		};
		readonly primaries: { readonly observed: number; readonly summarized: number };
		readonly failures: { readonly observed: number; readonly summarized: number };
	};
	readonly coverage: StatusOverviewCoverage;
	readonly observedAt: string;
	readonly discovery: string;
}

export const STATUS_OVERVIEW_BYTE_LIMIT = 16 * 1024;
export const STATUS_OVERVIEW_DISCOVERY =
	"Counts cover the supplied page, not unseen storage. Quiet sessions, primaries, and failures include bounded samples. Call agent_list without a cursor, then repeat its nextCursor to see more. Use agent_status with sessionId for full status; agent_inspect retains full text.";
const EXCERPT_CHARACTERS = 160;
const QUIET_SAMPLE = 5;
const PRIMARY_SAMPLE = 3;
const FAILURE_SAMPLE = 5;

function measure(value: unknown): number {
	return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function fixedPointBytes(value: { coverage: { bytes: number } }): number {
	let bytes = 0;
	for (;;) {
		value.coverage.bytes = bytes;
		const next = measure(value);
		if (next === bytes) return bytes;
		bytes = next;
	}
}

/** Unicode code points remain intact; the marker occupies the last excerpt position. */
function excerpt(text: string): string {
	const characters: string[] = [];
	for (const character of text) {
		if (characters.length === EXCERPT_CHARACTERS) return `${characters.slice(0, -1).join("")}…`;
		characters.push(character);
	}
	return text;
}

function compactHealth(
	health: NonNullable<AgentConversationSummary["health"]>,
): NonNullable<AgentConversationSummary["health"]> {
	const result = { ...health };
	if (health.lastError !== undefined) result.lastError = excerpt(health.lastError);
	if (health.compactionFailure !== undefined) {
		result.compactionFailure = { ...health.compactionFailure };
		if (health.compactionFailure.errorMessage !== undefined)
			result.compactionFailure.errorMessage = excerpt(health.compactionFailure.errorMessage);
	}
	if (health.autoRetry !== undefined)
		result.autoRetry = { ...health.autoRetry, errorMessage: excerpt(health.autoRetry.errorMessage) };
	return result;
}

function compact(row: AgentConversationSummary): AgentConversationSummary {
	const { creatingOwnerId: _creatingOwnerId, ...result } = row;
	for (const key of ["name", "firstMessage", "latestReply", "ownerLabel", "error"] as const) {
		const text = row[key];
		if (text !== undefined) result[key] = excerpt(text);
	}
	if (row.currentTool !== undefined)
		result.currentTool = { ...row.currentTool, argument: excerpt(row.currentTool.argument) };
	if (row.health !== undefined) result.health = compactHealth(row.health);
	return result;
}

function priority(row: AgentConversationSummary): number {
	if (
		row.owner === "unavailable" ||
		row.state === "unavailable" ||
		row.health?.lastError ||
		row.health?.compactionFailure ||
		(row.health?.autoRetry && row.health.autoRetry.attempt >= row.health.autoRetry.maxAttempts) ||
		(row.state === "failed" && Boolean(row.error))
	)
		return 1;
	if (row.state === "working" || row.state === "starting") return 0;
	return 2;
}

function byIdentity(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

function initialOverview(
	page: AgentConversationPage,
	primaries: readonly StatusOverviewPrimary[],
	failures: readonly StatusOverviewFailure[],
	awareness?: EffortAwareness,
) {
	const ordered = [...page.rows].sort(
		(a, b) => priority(a) - priority(b) || b.modifiedAt - a.modifiedAt || byIdentity(a.id, b.id),
	);
	const working = ordered.filter((row) => priority(row) === 0).length;
	const attention = ordered.filter((row) => priority(row) === 1).length;
	const quiet = ordered.length - working - attention;
	const sessions = ordered.slice(0, working + attention + QUIET_SAMPLE).map(compact);
	const value = {
		...(awareness === undefined ? {} : { awareness: structuredClone(awareness) }),
		sessions,
		primaries: [...primaries]
			.sort((a, b) => byIdentity(a.sessionId, b.sessionId))
			.slice(0, PRIMARY_SAMPLE)
			.map((row) => ({ ...row, ...(row.name === undefined ? {} : { name: excerpt(row.name) }) })),
		failures: [...failures]
			.sort((a, b) => byIdentity(a.storageId, b.storageId))
			.slice(0, FAILURE_SAMPLE)
			.map((row) => ({ ...row, error: excerpt(row.error) })),
		summary: {
			sessions: {
				observed: ordered.length,
				working,
				attention,
				quiet,
				summarizedQuiet: Math.max(0, quiet - QUIET_SAMPLE),
			},
			primaries: { observed: primaries.length, summarized: Math.max(0, primaries.length - PRIMARY_SAMPLE) },
			failures: { observed: failures.length, summarized: Math.max(0, failures.length - FAILURE_SAMPLE) },
		},
		coverage: {
			complete: false,
			storagesVisited: page.coverage.storagesVisited,
			skipped: page.coverage.skipped,
			omitted: page.coverage.omitted,
			omittedPrimaries: 0,
			omittedFailures: 0,
			bytes: 0,
			byteLimitReached: false,
			nextCursor: null,
			reasons: [] as string[],
		},
		observedAt: page.observedAt,
		discovery: STATUS_OVERVIEW_DISCOVERY,
	};
	return value;
}

type MutableOverview = ReturnType<typeof initialOverview>;
type ByteOmissions = { sessions: number; quiet: number; rows: number };

function sourceReasons(page: AgentConversationPage): string[] {
	const reasons: string[] = [];
	if (
		!page.coverage.complete ||
		page.coverage.nextCursor !== null ||
		page.coverage.skipped > 0 ||
		page.coverage.omitted > 0
	) {
		reasons.push(
			"Source inventory is incomplete; counts describe only the supplied page, and the remaining extent is unknown.",
		);
		reasons.push(
			"agent_status has no continuation parameter; use fresh agent_list discovery. Call agent_list without a cursor, then repeat its nextCursor to see more.",
		);
	}
	if (page.coverage.skipped > 0)
		reasons.push(
			`${page.coverage.skipped} source storages were unreadable, unavailable, or had incomplete published views; this overview does not recover those views.`,
		);
	if (page.coverage.omitted > 0)
		reasons.push(
			`${page.coverage.omitted} rows were excluded by source view or page budgets; the source does not identify which exclusions fresh agent_list discovery recovers.`,
		);
	return reasons;
}

function excludeAwareness(awareness: EffortAwareness | undefined): boolean {
	if (!awareness) return false;
	if (awareness.presence.efforts.length > 0) {
		awareness.presence.efforts.pop();
		awareness.presence.coverage.omitted++;
		awareness.presence.coverage.complete = false;
		if (!awareness.presence.coverage.reasons.includes("status-byte-limit")) awareness.presence.coverage.reasons.push("status-byte-limit");
	} else if (awareness.threads.items.length > 0) {
		awareness.threads.items.pop();
		awareness.threads.coverage.omittedResults++;
		awareness.threads.coverage.complete = false;
		if (!awareness.threads.coverage.reasons.includes("status-byte-limit")) awareness.threads.coverage.reasons.push("status-byte-limit");
	} else if (awareness.self.intentClaim || awareness.self.observedPurpose) {
		const { id, cwd, repository } = awareness.self;
		awareness.self = { id, cwd, ...(repository === undefined ? {} : { repository }), omitted: true };
	} else return false;
	return true;
}

function excludeRow(value: MutableOverview, dropped: ByteOmissions): void {
	const rowBudget = STATUS_OVERVIEW_BYTE_LIMIT - measure({ ...value, sessions: [], primaries: [], failures: [], awareness: undefined });
	const oversized = value.sessions.findIndex((row) => measure(row) > rowBudget);
	const last = value.sessions.at(-1);
	if (oversized >= 0 || (last !== undefined && priority(last) === 2)) {
		const [row] = value.sessions.splice(oversized >= 0 ? oversized : value.sessions.length - 1, 1);
		if (priority(row) === 2) {
			value.summary.sessions.summarizedQuiet++;
			dropped.quiet++;
		} else {
			dropped.sessions++;
			value.coverage.omitted++;
		}
	} else if (value.primaries.length > 0) {
		value.primaries.pop();
		value.summary.primaries.summarized++;
		value.coverage.omittedPrimaries++;
	} else if (value.failures.length > 0) {
		value.failures.pop();
		value.summary.failures.summarized++;
		value.coverage.omittedFailures++;
	} else if (excludeAwareness(value.awareness)) {
		dropped.rows++;
		return;
	} else if (value.sessions.length > 0) {
		value.sessions.pop();
		dropped.sessions++;
		value.coverage.omitted++;
	} else {
		throw new Error("Status overview metadata exceeds the byte limit after every row was summarized or omitted.");
	}
	dropped.rows++;
}

/** Keep coordinator fields on working and attention rows; sample quiet history after those rows. */
export function buildStatusOverview(
	page: AgentConversationPage,
	primaries: readonly StatusOverviewPrimary[],
	failures: readonly StatusOverviewFailure[],
	awareness?: EffortAwareness,
): StatusOverview {
	const value = initialOverview(page, primaries, failures, awareness);
	const reasons = sourceReasons(page);
	const dropped: ByteOmissions = { sessions: 0, quiet: 0, rows: 0 };
	for (;;) {
		value.coverage.reasons = [...reasons];
		if (dropped.rows > 0)
			value.coverage.reasons.push(
				`Status byte limit excluded ${dropped.sessions} working or attention rows, ${dropped.quiet} quiet sample rows, ${value.coverage.omittedPrimaries} primary sample rows, and ${value.coverage.omittedFailures} failure sample rows; use fresh agent_list discovery or targeted agent_status. agent_status has no continuation parameter; call agent_list without a cursor to rediscover these rows.`,
			);
		if (value.awareness && (!value.awareness.presence.coverage.complete || !value.awareness.threads.coverage.complete || value.awareness.self.omitted)) value.coverage.reasons.push("Effort awareness is partial; its presence, thread, and self coverage identifies omitted observations.");
		value.coverage.complete = value.coverage.reasons.length === 0 && dropped.rows === 0;
		if (fixedPointBytes(value) <= STATUS_OVERVIEW_BYTE_LIMIT) return value;
		value.coverage.byteLimitReached = true;
		excludeRow(value, dropped);
	}
}
