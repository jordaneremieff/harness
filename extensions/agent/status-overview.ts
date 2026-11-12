/** Compact fleet orientation over one supplied dashboard page, without host acquisition. */
import type { AgentPriorityPage, AgentConversationSummary } from "./dashboard-types.ts";
import type { EffortAwareness } from "./effort-awareness.ts";
import type { CatalogPriorityCoverage } from "./catalog.ts";
import { CompactConversationSchema, type CompactSelectedStatusSchema, type CompactStorageStatusSchema, StorageStatusCoverageSchema, type ToolOverviewRow } from "./observation-schema.ts";
import type { Static } from "@earendil-works/pi-schema";
import { matchesSchema } from "./schema-check.ts";

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
	readonly inventory: CatalogPriorityCoverage;
	/** Live or caller-owned rows excluded by the overview byte limit. */
	readonly omittedPriorityRows: number;
	/** Distinct records with at least one priority row excluded by the overview byte limit. */
	readonly omittedPriorityRecords: number;
	readonly skipped: number;
	/** Host-view omissions plus working or attention byte omissions; inventory counts source-output exclusions. */
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
	readonly sessions: readonly ToolOverviewRow[];
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
	"Counts cover the supplied page, not unseen storage. Quiet sessions, primaries, and failures include bounded samples. Call agent_list without a cursor, then repeat its nextCursor to see more. Use agent_status with sessionId and detail:true for full status; agent_inspect retains full text.";
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

/** Drops catalog-local fields the overview row schema does not declare; the intervention hint stays. */
function compact(row: AgentConversationSummary): ToolOverviewRow {
	const { creatingOwnerId: _creatingOwnerId, rosterOrder: _rosterOrder, profile: _profile, ...result } = row;
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
	page: AgentPriorityPage,
	primaries: readonly StatusOverviewPrimary[],
	failures: readonly StatusOverviewFailure[],
	awareness?: EffortAwareness,
) {
	const ordered = [...page.rows].sort(
		(a, b) => Number(b.rosterOrder.priority) - Number(a.rosterOrder.priority) ||
			b.rosterOrder.modifiedAt - a.rosterOrder.modifiedAt || byIdentity(a.id, b.id),
	);
	const working = ordered.filter((row) => priority(row) === 0).length;
	const attention = ordered.filter((row) => priority(row) === 1).length;
	const quiet = ordered.length - working - attention;
	let sampledQuiet = 0;
	const selected = ordered.filter((row) => {
		if (row.rosterOrder.priority || priority(row) < 2) return true;
		return sampledQuiet++ < QUIET_SAMPLE;
	});
	const sessions = selected.map(compact);
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
				summarizedQuiet: quiet - selected.filter((row) => priority(row) === 2).length,
			},
			primaries: { observed: primaries.length, summarized: Math.max(0, primaries.length - PRIMARY_SAMPLE) },
			failures: { observed: failures.length, summarized: Math.max(0, failures.length - FAILURE_SAMPLE) },
		},
		coverage: {
			complete: false,
			storagesVisited: page.coverage.storagesVisited,
			inventory: page.coverage.inventory, omittedPriorityRows: 0, omittedPriorityRecords: 0,
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
type ByteOmissions = { sessions: number; quiet: number; rows: number; priority: number };

function sourceReasons(page: AgentPriorityPage): string[] {
	const reasons: string[] = [];
	const inventory = page.coverage.inventory;
	if (inventory.unknownClaims) reasons.push(`${inventory.unknownClaims} writer claims have unknown owners; live-host priority is not established for those records.`);
	if (inventory.remaining) reasons.push(`${inventory.remaining} catalog records (${inventory.remainingRows} published rows) fall outside the source output limit; ${inventory.priorityRemaining} records (${inventory.priorityRemainingRows} rows) are live or caller-owned.`);
	if (
		!page.coverage.complete ||
		page.coverage.nextCursor !== null ||
		page.coverage.skipped > 0 ||
		page.coverage.omitted > 0
	) {
		reasons.push(
			"Source output or published views are incomplete; inventory reports the initial catalog scan and excluded published rows.",
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

function excludeRow(value: MutableOverview, dropped: ByteOmissions, priorityIds: ReadonlySet<string>): void {
	const rowBudget = STATUS_OVERVIEW_BYTE_LIMIT - measure({ ...value, sessions: [], primaries: [], failures: [], awareness: undefined });
	const oversized = value.sessions.findIndex((row) => measure(row) > rowBudget);
	const last = value.sessions.at(-1);
	if (oversized >= 0 || (last !== undefined && priority(last) === 2)) {
		const [row] = value.sessions.splice(oversized >= 0 ? oversized : value.sessions.length - 1, 1);
		dropped.priority += Number(priorityIds.has(row.id));
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
		const row = value.sessions.pop() as ToolOverviewRow;
		dropped.priority += Number(priorityIds.has(row.id));
		dropped.sessions++;
		value.coverage.omitted++;
	} else {
		throw new Error("Status overview metadata exceeds the byte limit after every row was summarized or omitted.");
	}
	dropped.rows++;
}

/** Keep coordinator fields on working and attention rows; sample quiet history after those rows. */
export function buildStatusOverview(
	page: AgentPriorityPage,
	primaries: readonly StatusOverviewPrimary[],
	failures: readonly StatusOverviewFailure[],
	awareness?: EffortAwareness,
): StatusOverview {
	const value = initialOverview(page, primaries, failures, awareness);
	const reasons = sourceReasons(page);
	const dropped: ByteOmissions = { sessions: 0, quiet: 0, rows: 0, priority: 0 };
	const priorityIds = new Set(page.rows.filter((row) => row.rosterOrder.priority).map((row) => row.id));
	for (;;) {
		value.coverage.reasons = [...reasons];
		value.coverage.omittedPriorityRows = dropped.priority;
		const retained = new Set(value.sessions.map((row) => row.id));
		value.coverage.omittedPriorityRecords = new Set(page.rows.filter((row) => priorityIds.has(row.id) && !retained.has(row.id)).map((row) => row.storageId)).size;
		if (dropped.priority) value.coverage.reasons.push(`Status byte limit excluded ${dropped.priority} live or caller-owned rows from ${value.coverage.omittedPriorityRecords} records; a record counts once when any of its priority rows was excluded.`);
		if (dropped.rows > 0)
			value.coverage.reasons.push(
				`Status byte limit excluded ${dropped.sessions} working or attention rows, ${dropped.quiet} quiet sample rows, ${value.coverage.omittedPrimaries} primary sample rows, and ${value.coverage.omittedFailures} failure sample rows; use fresh agent_list discovery or targeted agent_status. agent_status has no continuation parameter; call agent_list without a cursor to rediscover these rows.`,
			);
		if (value.awareness && (!value.awareness.presence.coverage.complete || !value.awareness.threads.coverage.complete || value.awareness.self.omitted)) value.coverage.reasons.push("Effort awareness is partial; its presence, thread, and self coverage identifies omitted observations.");
		value.coverage.complete = value.coverage.reasons.length === 0 && dropped.rows === 0;
		if (fixedPointBytes(value) <= STATUS_OVERVIEW_BYTE_LIMIT) return value;
		value.coverage.byteLimitReached = true;
		excludeRow(value, dropped, priorityIds);
	}
}

export const SELECTED_STATUS_BYTE_LIMIT = 8 * 1024;
type CompactConversation = Static<typeof CompactConversationSchema>;
type CompactSelected = Static<typeof CompactSelectedStatusSchema>;
type CompactStorage = Static<typeof CompactStorageStatusSchema>;
export interface PresentationRefusal { format: "refused"; reason: string; byteLimit: number }
function refusal(byteLimit: number, reason: string): PresentationRefusal { return { format: "refused", reason, byteLimit }; }
function record(value: unknown): Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function count(value: unknown): number | undefined { return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : undefined; }

/** Detail belongs to one explicit target, not to a page or a fleet selection. */
export function validateStatusDetail(input: { sessionId?: unknown; detail?: unknown; view?: unknown; storageId?: unknown; cursor?: unknown; limit?: unknown }): void {
	if (input.detail === undefined) return;
	if (typeof input.detail !== "boolean" || typeof input.sessionId !== "string" || !input.sessionId ||
		input.view !== undefined || input.storageId !== undefined || input.cursor !== undefined || input.limit !== undefined)
		throw new Error("detail requires one explicit sessionId and cannot be combined with fleet or storage-page selectors.");
}

function addCompactName(row: CompactConversation, name: unknown): void {
	if (typeof name !== "string") return;
	row.name = excerpt(name);
	if (row.name !== name) row.omitted.push("name shortened");
}

function compactConversation(source: unknown, availability: CompactConversation["availability"]): CompactConversation | undefined {
	const row = record(source);
	if (typeof row.identity !== "string" || !row.identity || !(count(row.conversationId) ?? 0)) return undefined;
	const agent = record(row.agent), model = record(agent.model), live = record(row.live), run = record(live.run);
	const result: CompactConversation = {
		identity: row.identity, conversationId: Number(row.conversationId), busy: typeof row.busy === "boolean" ? row.busy : null, availability,
		queue: { inbox: Array.isArray(record(row.inbox).items) ? (record(row.inbox).items as unknown[]).length : null,
			submissions: Array.isArray(row.submissions) ? row.submissions.filter(value => ["queued", "placed"].includes(String(record(value).status))).length : null },
		timers: Array.isArray(row.timers) ? row.timers.length : null, context: "unknown",
		omitted: ["instructions", "tools", "extensions", "historical tasks and submissions", "usage", "context fact unavailable"],
		detail: { tool: "agent_status", sessionId: row.identity, detail: true },
	};
	addCompactName(result, row.name);
	if (typeof model.provider === "string" && typeof model.modelId === "string") result.model = { provider: model.provider, modelId: model.modelId };
	if (typeof agent.thinkingLevel === "string") result.thinkingLevel = agent.thinkingLevel;
	if ((count(run.taskId) ?? 0) > 0) result.runId = Number(run.taskId);
	addCompactAwait(result, row.awaiting);
	const block = record(row.providerBlock);
	if (typeof block.blockId === "string") {
		result.providerBlock = { blockId: block.blockId, recovery: `agent_configure({sessionId:${JSON.stringify(row.identity)},model:<explicit provider/model>}), then a new agent_send follow-up` };
		result.omitted.push("provider evidence; use detail or result view");
	}
	return result;
}

function addCompactAwait(result: CompactConversation, value: unknown): void {
	const awaiting = record(value);
	if ((count(awaiting.runId) ?? 0) > 0 && Array.isArray(awaiting.results)) {
		const items = awaiting.results.slice(0, 4).map(value => { const item = record(value); return { result: structuredClone(item.result), status: item.status }; });
		const fact = { runId: awaiting.runId, results: items, queuedInputCount: awaiting.queuedInputCount,
			omittedResults: Math.max(0, awaiting.results.length - items.length) + (count(record(awaiting.omitted).results) ?? 0) };
		const candidate = { ...result, awaiting: fact };
		if (matchesSchema(CompactConversationSchema, candidate)) result.awaiting = candidate.awaiting as CompactConversation["awaiting"];
		result.omitted.push("await producer graph and held-input detail");
	}
}

/** Only descriptive fields are expendable; identities, counts, and continuation calls stay exact. */
function reduceCompact(row: CompactConversation, selectionOptional = true): void {
	if (row.name !== undefined) { delete row.name; row.omitted.push("name omitted for byte limit"); }
	if (!selectionOptional) return;
	if (row.model !== undefined) { delete row.model; row.omitted.push("model omitted for byte limit"); }
	if (row.thinkingLevel !== undefined) { delete row.thinkingLevel; row.omitted.push("thinking level omitted for byte limit"); }
}

function compactPrimary(source: Record<string, unknown>): CompactConversation | undefined {
	if (typeof source.sessionId !== "string") return undefined;
	const presence = record(source.presence), model = record(presence.model);
	const conversation: CompactConversation = { identity: source.sessionId, busy: null, availability: "unknown", queue: { inbox: null, submissions: null }, timers: null, context: "unknown",
		omitted: ["retained ancestry", "live session progress unavailable", "context fact unavailable"], detail: { tool: "agent_status", sessionId: source.sessionId, detail: true } };
	addCompactName(conversation, presence.name);
	if (typeof model.provider === "string" && typeof model.modelId === "string") conversation.model = { provider: model.provider, modelId: model.modelId };
	return conversation;
}
function sourceAvailability(source: Record<string, unknown>): CompactConversation["availability"] {
	if (source.live === false) return "retained";
	return source.inventory !== undefined || source.pid !== undefined ? "live" : "unknown";
}

/** Public selected status is separate from the complete host record. */
export function projectSelectedStatus(value: unknown): CompactSelected | PresentationRefusal {
	const source = record(value);
	const conversation = source.kind === "ordinary-primary" ? compactPrimary(source) : compactConversation(source.conversation, sourceAvailability(source));
	if (!conversation) return refusal(SELECTED_STATUS_BYTE_LIMIT, "Selected status source identity is unavailable.");
	const result: CompactSelected = { format: "compact", conversation, omitted: ["host inventory", "effort awareness"] };
	if (typeof source.storageId === "string") result.storageId = source.storageId;
	if (typeof source.live === "boolean") result.live = source.live;
	if (measure(result) > SELECTED_STATUS_BYTE_LIMIT) reduceCompact(conversation, false);
	return measure(result) <= SELECTED_STATUS_BYTE_LIMIT ? result : refusal(SELECTED_STATUS_BYTE_LIMIT, "Mandatory selected identity, state, or recovery metadata exceeds the output byte limit; request detail:true.");
}

/** Preserve every source-page identity and the backend continuation without another discovery pass. */
export function projectStorageStatus(value: unknown): CompactStorage | PresentationRefusal {
	const source = record(value);
	if (typeof source.storageId !== "string" || !Array.isArray(source.conversations) || !matchesSchema(StorageStatusCoverageSchema, source.coverage))
		return refusal(STATUS_OVERVIEW_BYTE_LIMIT, "Storage status source identity or coverage is unavailable.");
	const availability = sourceAvailability(source);
	const conversations: CompactConversation[] = [];
	for (const row of source.conversations) {
		const compact = compactConversation(row, availability);
		if (!compact) return refusal(STATUS_OVERVIEW_BYTE_LIMIT, "A storage status row has no complete source identity.");
		conversations.push(compact);
	}
	const result: CompactStorage = { format: "compact", storageId: source.storageId, conversations, coverage: structuredClone(source.coverage),
		omitted: ["host inventory", "effort awareness", "created-agent detail"] };
	if (typeof source.live === "boolean") result.live = source.live;
	if (measure(result) > STATUS_OVERVIEW_BYTE_LIMIT) for (const row of conversations) reduceCompact(row);
	return measure(result) <= STATUS_OVERVIEW_BYTE_LIMIT ? result : refusal(STATUS_OVERVIEW_BYTE_LIMIT, "Mandatory storage identities, state, or coverage exceed the output byte limit; no identities were cut and no continuation was invented.");
}
