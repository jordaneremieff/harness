import { basename } from "node:path";
import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { AgentConversationSummary, AgentDashboardCoverage } from "./dashboard-types.ts";
import { cleanDashboardText } from "./dashboard-conversation.ts";
import { formatCost } from "./agent-footer.ts";
import { fitLine, highlightRow } from "./dashboard-layout.ts";
import { dashboardTime } from "./dashboard-time.ts";

export interface AgentDashboardSnapshot {
	observedAt: number;
	sessions: readonly AgentConversationSummary[];
	coverage?: AgentDashboardCoverage;
	error?: string;
}
type StateAppearance = { label: string; glyph: string; color: ThemeColor };
export const sessionAppearance: Record<AgentConversationSummary["state"], StateAppearance> = {
	starting: { label: "Starting", glyph: "◌", color: "accent" },
	working: { label: "Working", glyph: "●", color: "accent" },
	idle: { label: "Idle", glyph: "○", color: "muted" },
	done: { label: "Done", glyph: "✓", color: "success" },
	failed: { label: "Failed", glyph: "!", color: "error" },
	stopped: { label: "Stopped", glyph: "■", color: "warning" },
	interrupted: { label: "Interrupted", glyph: "↯", color: "warning" },
	new: { label: "New", glyph: "·", color: "muted" },
	unavailable: { label: "Unavailable", glyph: "?", color: "error" },
};
const oneLine = (text: string) => cleanDashboardText(text).replace(/\s+/g, " ").trim();

/**
 * A provider error in plain words: `429: {"code":"1308","message":"Usage limit reached"}` reads
 * as `429 Usage limit reached`. Text without a parseable JSON body stays as it is.
 */
export function readableError(text: string): string {
	// A provider prefix that repeats its status code reads once: `xai API error (403): 403 "No credits` is `xai API error 403: No credits`.
	const flat = oneLine(text).replace(/\((\d{3})\):\s*\1\s+"?/u, "$1: ");
	const start = flat.indexOf("{");
	if (start < 0 || !flat.endsWith("}")) return flat;
	try {
		const body = JSON.parse(flat.slice(start)) as Record<string, unknown>;
		const nested =
			body.error && typeof body.error === "object" ? (body.error as Record<string, unknown>).message : undefined;
		const message =
			typeof body.message === "string"
				? body.message
				: typeof nested === "string"
					? nested
					: typeof body.error === "string"
						? body.error
						: undefined;
		if (!message) return flat;
		const prefix = flat.slice(0, start).replace(/[:\s]+$/u, "");
		return oneLine(prefix ? `${prefix} ${message}` : message);
	} catch {
		return flat;
	}
}
/** One label per agent: the display name, else the handle, else the quoted first input, else the full identity. */
export const titleOf = (row: AgentConversationSummary) =>
	oneLine(
		row.name?.trim() ||
			row.profile?.handle ||
			(row.firstMessage?.trim() ? `“${oneLine(row.firstMessage)}”` : "") ||
			row.id,
	);
export function elapsed(ms: number): string {
	const seconds = Math.max(0, Math.floor(ms / 1000));
	return seconds < 60
		? `${seconds}s`
		: seconds < 3600
			? `${Math.floor(seconds / 60)}m${seconds % 60}s`
			: seconds < 86400
				? `${Math.floor(seconds / 3600)}h${Math.floor((seconds % 3600) / 60)}m`
				: `${Math.floor(seconds / 86400)}d`;
}
function costOf(row: AgentConversationSummary): string {
	return formatCost(row.cost, row.partial);
}
function retryActivity(row: AgentConversationSummary): string | undefined {
	const retry = row.health?.autoRetry;
	if (!retry) return undefined;
	const error = readableError(retry.errorMessage);
	return `Provider retry scheduled after ${elapsed(retry.delayMs)}${error ? `: ${error}` : ""}`;
}
function stateLabel(row: AgentConversationSummary): string {
	const owner =
		row.owner === "unavailable"
			? " · unavailable"
			: row.owner === "unknown" && row.state !== "starting"
				? " · stored"
				: "";
	return `${sessionAppearance[row.state].label}${owner}`;
}
/** Catalog rank orders observed rows; a just-created startup row uses its source time until the next catalog refresh. */
export function compareRosterRows(left: AgentConversationSummary, right: AgentConversationSummary): number {
	return (
		Number(right.rosterOrder?.priority ?? false) - Number(left.rosterOrder?.priority ?? false) ||
		(right.rosterOrder?.modifiedAt ?? right.modifiedAt) - (left.rosterOrder?.modifiedAt ?? left.modifiedAt) ||
		left.id.localeCompare(right.id)
	);
}
/** A host fault or unavailable observation, not a retained failure or a scheduled retry. */
export function currentFault(row: AgentConversationSummary): boolean {
	return row.owner === "unavailable" || row.state === "unavailable" || Boolean(row.health?.lastError);
}
/**
 * The supported way forward for a row with an error. Inspect blocked tasks without starting new work.
 * A provider block needs a model change; a failed run needs a new message; a host fault needs Reconnect.
 */
export function recoveryHint(row: AgentConversationSummary): string | undefined {
	if (row.attention === "task-blocked") return "Open Tasks to inspect the blocked task";
	if (row.state === "working") return undefined;
	if (row.attention === "provider-blocked") return "Configure another model, then send a message";
	if (row.owner === "unavailable" || row.state === "unavailable")
		return "Reconnect starts the host when the storage is readable";
	if (currentFault(row)) return "Reconnect starts the host; unfinished work resumes";
	if (row.state === "failed") return "A new message runs the work again";
	return undefined;
}
/** One governing failure reason; full recovery records belong in Details. */
export function attentionReason(row: AgentConversationSummary): string | undefined {
	if (row.attention === "provider-blocked")
		return row.error ? `Provider blocked: ${readableError(row.error)}` : "Provider blocked";
	if (row.attention === "task-blocked")
		return row.health?.lastError ? `Blocked task: ${readableError(row.health.lastError)}` : "Blocked task";
	if (row.owner === "unavailable" || row.state === "unavailable")
		return `Unavailable: ${oneLine(row.error || row.ownerLabel || "Storage cannot be read")}`;
	if (row.health?.lastError) return `Host error: ${readableError(row.health.lastError)}`;
	const failure = row.health?.compactionFailure;
	if (failure)
		return `Compaction failed (${failure.trigger}): ${readableError(failure.errorMessage || "No error text")}`;
	if (row.state === "failed") return row.error ? readableError(row.error) : "The last turn failed";
	return undefined;
}
export function dashboardRecords(
	snapshot: AgentDashboardSnapshot | undefined,
	filter: string,
): AgentConversationSummary[] {
	const terms = oneLine(filter).toLocaleLowerCase().split(" ").filter(Boolean);
	return (snapshot?.sessions ?? [])
		.filter((row) => {
			const text =
				`${titleOf(row)} ${row.profile?.handle ?? ""} ${row.profile?.role ?? ""} ${row.firstMessage ?? ""} ${row.cwd} ${row.id} ${stateLabel(row)} ${row.model?.provider ?? ""} ${row.model?.modelId ?? ""} ${row.model?.thinkingLevel ?? ""}`.toLocaleLowerCase();
			return terms.every((term) => text.includes(term));
		})
		.sort(compareRosterRows);
}
function inventoryText(inventory: NonNullable<AgentDashboardCoverage["inventory"]>): string[] {
	const parts = [`${inventory.inspected}/${inventory.candidates} catalog records inspected`];
	if (inventory.unknownClaims)
		parts.push(`${inventory.unknownClaims} writer claims unknown; live priority not established`);
	if (inventory.remaining)
		parts.push(`${inventory.remaining} records (${inventory.remainingRows} rows) outside this page`);
	if (inventory.priorityRemaining)
		parts.push(
			`${inventory.priorityRemaining} live or caller-owned records (${inventory.priorityRemainingRows} rows) outside this page`,
		);
	return parts;
}
/** Coverage of the returned page; an empty or bounded page is not proof of absence. */
export function coverageText(coverage: AgentDashboardCoverage | undefined): string {
	if (!coverage) return "";
	const parts: string[] = [];
	parts.push(...inventoryText(coverage.inventory));
	if (coverage.skipped)
		parts.push(`${coverage.skipped} store${coverage.skipped === 1 ? "" : "s"} skipped (unknown, not absent)`);
	if (coverage.omitted) parts.push(`${coverage.omitted} row${coverage.omitted === 1 ? "" : "s"} not loaded`);
	if (coverage.nextCursor) parts.push("more records to load");
	if (!coverage.complete && !coverage.nextCursor) parts.push("coverage incomplete");
	return parts.join(" · ");
}
export function rosterTotals(snapshot: AgentDashboardSnapshot | undefined): string {
	const rows = snapshot?.sessions ?? [];
	const errors = rows.filter((row) => attentionReason(row) !== undefined).length;
	const working = rows.filter((row) => row.state === "working" || row.state === "starting").length;
	const coverage = snapshot?.coverage;
	const incomplete =
		rows.some((row) => row.partial || !Number.isFinite(row.cost)) ||
		Boolean(coverage && (!coverage.complete || coverage.nextCursor || coverage.skipped || coverage.omitted));
	const cost = rows.reduce((sum, row) => sum + (Number.isFinite(row.cost) ? row.cost : 0), 0);
	return `${working} working${errors ? ` · ${errors} with errors` : ""} · ${formatCost(cost, incomplete)} retained`;
}
/** Plain-text roster summary for non-TUI reads and status tests. */
export function dashboardText(snapshot: AgentDashboardSnapshot): string {
	const coverage = coverageText(snapshot.coverage);
	return [
		"Agent dashboard",
		rosterTotals(snapshot),
		...(coverage ? [`Coverage: ${coverage}`] : []),
		...(snapshot.error ? [`Store unavailable: ${snapshot.error}`] : []),
		...dashboardRecords(snapshot, "").flatMap((row) => {
			const reason = attentionReason(row) ?? (row.state === "working" ? retryActivity(row) : undefined);
			return [
				oneLine(
					`${sessionAppearance[row.state].glyph} ${stateLabel(row)} · ${titleOf(row)} · ${basename(row.cwd)} · ${row.model?.modelId ?? "unknown model"} · ${costOf(row)}`,
				),
				`  ${oneLine(row.id)} · ${oneLine(row.cwd)}`,
				...(row.profile?.role ? [`  Role: ${oneLine(row.profile.role)}`] : []),
				...(reason ? [`  ${reason}`] : []),
				...(row.latestReply ? [`  ${oneLine(row.latestReply).slice(0, 300)}`] : []),
			];
		}),
		"Use /agent help for actions.",
	].join("\n");
}

/** Duplicate labels carry their complete addresses; width is applied by the renderer. */
function uniqueName(row: AgentConversationSummary, rows: readonly AgentConversationSummary[]): string {
	const name = titleOf(row);
	return rows.some((other) => other.id !== row.id && titleOf(other) === name) ? `${name} ${oneLine(row.id)}` : name;
}
/** Published arguments can end mid-JSON; extract a string value without displaying the serialized object. */
export function argumentSummary(argument: string): string {
	let value: unknown;
	try {
		const parsed = JSON.parse(argument);
		value =
			typeof parsed === "string"
				? parsed
				: parsed && typeof parsed === "object"
					? Object.values(parsed).find((item) => typeof item === "string")
					: undefined;
	} catch {
		const match = argument.match(/"(?:\\.|[^"\\])*"\s*:\s*"((?:\\.|[^"\\])*)/);
		if (match) {
			try {
				value = JSON.parse(`"${match[1].replace(/\\$/, "")}"`);
			} catch {
				value = undefined;
			}
		} else if (!argument.trim().startsWith("{") && !argument.trim().startsWith("[")) value = argument;
	}
	return typeof value === "string" ? truncateToWidth(oneLine(value), 60, "…") : "";
}
export function activityOf(row: AgentConversationSummary): string {
	const reason = attentionReason(row);
	if (reason) return reason;
	if (row.state === "working")
		return (
			retryActivity(row) ??
			(row.currentTool ? oneLine(`${row.currentTool.name} ${argumentSummary(row.currentTool.argument)}`) : "Responding")
		);
	return row.latestReply ? oneLine(row.latestReply) : row.state === "starting" ? "Starting agent" : "No reply yet";
}
/** An absent observation time leaves the published age unchanged. */
function ageAt(age: number, observedAt: number | undefined, now: number): number {
	return age + (observedAt === undefined || !Number.isFinite(observedAt) ? 0 : Math.max(0, now - observedAt));
}

/** Admitted inputs that the agent has not read yet, with the age of the oldest one; empty when none waits. */
export function unplacedText(
	row: Pick<AgentConversationSummary, "unplaced" | "oldest" | "ageObservedAt">,
	now = Date.now(),
): string {
	if (!row.unplaced) return "";
	if (row.oldest === undefined) return `unplaced: ${row.unplaced}`;
	const seconds = Math.floor(ageAt(row.oldest, row.ageObservedAt, now) / 1000),
		minutes = Math.floor(seconds / 60);
	const age =
		minutes < 1 ? `${seconds}s` : minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
	return `unplaced: ${row.unplaced}, oldest: ${age}`;
}
/**
 * The reason the list shows. An unreadable host of an agent that is not at work matters only when
 * the operator writes to it, so the list keeps that agent's own outcome; the header still names it.
 */
export function listReason(row: AgentConversationSummary): string | undefined {
	return attentionReason(listedRow(row));
}
/** The row as the list judges it: a settled agent's unreadable host is not its outcome. */
export function listedRow(row: AgentConversationSummary): AgentConversationSummary {
	const settled = row.state !== "working" && row.state !== "starting" && row.state !== "unavailable";
	return settled && row.owner === "unavailable" ? { ...row, owner: "unknown" } : row;
}

/** The list's sections: agents at work, agents active in the last day, and the rest. */
export type RosterGroup = "working" | "recent" | "earlier";
const RECENT_MS = 24 * 60 * 60 * 1000;
const GROUP_LABEL: Record<RosterGroup, string> = { working: "Working", recent: "Recent", earlier: "Earlier" };
export function rosterGroup(row: AgentConversationSummary, now = Date.now()): RosterGroup {
	if (row.state === "working" || row.state === "starting") return "working";
	return now - row.modifiedAt < RECENT_MS ? "recent" : "earlier";
}
/** A stable partition: each section keeps the incoming roster order. */
export function groupRows(rows: readonly AgentConversationSummary[], now = Date.now()): AgentConversationSummary[] {
	const order: RosterGroup[] = ["working", "recent", "earlier"];
	return order.flatMap((group) => rows.filter((row) => rosterGroup(row, now) === group));
}

/** Rows per agent in the list: the state mark and the name, then the model and its thinking level. */
export const ROSTER_ROWS = 2;

/**
 * Rows one agent takes: the name and the model, and a third row while the agent works (what it is
 * doing now) or while it has an error reason (the reason). A compact list, such as the narrow strip
 * above the pane, keeps every agent to the first two rows.
 */
export function rosterRowCount(row: AgentConversationSummary): number {
	const active = row.state === "working" || row.state === "starting";
	return (active || listReason(row) ? ROSTER_ROWS + 1 : ROSTER_ROWS) + activityRowCount(row);
}

/** Running work rows under an agent. Up to two items take a row each; with more, the second row counts the rest. */
const ACTIVITY_ROWS = 2;
function activityRowCount(row: Pick<AgentConversationSummary, "activity">): number {
	return Math.min(ACTIVITY_ROWS, row.activity?.length ?? 0);
}

/** How long running work has run, in whole minutes; the list repaints its times once a minute. */
export function runningFor(startedAt: number, now = Date.now()): string {
	const minutes = Math.floor(Math.max(0, now - startedAt) / 60000);
	if (minutes < 1) return "<1m";
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	return hours < 24 ? `${hours}h ${minutes % 60}m` : `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

/**
 * One row of running work shows the yellow dot of running work, the item's label and, at the right, how long
 * it has run. The label is the reporting extension's own text, flattened to one line.
 */
export function activityLine(
	item: { label: string; startedAt: number },
	width: number,
	theme: Theme,
	now: number,
	right = runningFor(item.startedAt, now),
): string {
	const room = Math.max(1, width - 2 - (right ? visibleWidth(right) + 2 : 0));
	const label = theme.fg("muted", truncateToWidth(oneLine(item.label), room, "…"));
	const head = `${theme.fg("warning", "●")} ${label}`;
	if (!right) return head;
	return `${head}${" ".repeat(Math.max(2, width - visibleWidth(head) - visibleWidth(right)))}${theme.fg("dim", right)}`;
}

/** The running work rows of one agent in the list; a third item or more turns the second row into a count. */
function rosterActivityRows(row: AgentConversationSummary, width: number, theme: Theme, now: number): string[] {
	const items = row.activity ?? [];
	if (items.length === 0) return [];
	const room = Math.max(1, width - 4);
	if (items.length <= ACTIVITY_ROWS) return items.map((item) => activityLine(item, room, theme, now));
	return [
		activityLine(items[0], room, theme, now),
		theme.fg("muted", truncateToWidth(`  +${items.length - 1} more running`, room, "…")),
	];
}

/**
 * Quiet rows per agent: the state mark, the name and, for a settled agent, its age at the right; then
 * the model and its thinking level; then, while it applies, what a working agent is doing or the
 * error reason. Only agents at work and agents with an error carry colour; a settled agent's name is
 * muted, and the selected agent is bold on the selection colour.
 */
function rosterRow(
	row: AgentConversationSummary,
	rows: readonly AgentConversationSummary[],
	selected: string | undefined,
	width: number,
	theme: Theme,
	now: number,
	reasons?: (row: Pick<AgentConversationSummary, "model">) => boolean | undefined,
	compact = false,
): string[] {
	const chosen = row.id === selected;
	const rail = chosen ? theme.fg("accent", "▌") : " ";
	const lines = [
		rosterNameRow(row, rows, chosen, rail, width, theme, now),
		`${rail}   ${rosterModelRow(row, Math.max(1, width - 4), theme, reasons)}`,
	];
	const third = compact ? undefined : rosterThirdRow(row, width, theme);
	if (third) lines.push(`${rail}   ${third}`);
	if (!compact) for (const line of rosterActivityRows(row, width, theme, now)) lines.push(`${rail}   ${line}`);
	return lines.map((line) => (chosen ? highlightRow(line, width, 2, theme) : fitLine(line, width)));
}

/** The rail, the state mark and the name; a settled agent's age sits at the right while the list has room. */
function rosterNameRow(
	row: AgentConversationSummary,
	rows: readonly AgentConversationSummary[],
	chosen: boolean,
	rail: string,
	width: number,
	theme: Theme,
	now: number,
): string {
	const active = row.state === "working" || row.state === "starting";
	const reason = listReason(row);
	const tone = active ? "accent" : !reason ? "dim" : currentFault(listedRow(row)) ? "error" : "warning";
	const mark = theme.fg(tone, sessionAppearance[row.state].glyph);
	// A working agent's third row says what it does, so only a settled agent shows its age.
	const age = active ? "" : dashboardTime(row.modifiedAt, false, now);
	const ageRoom = age && width >= 24 ? visibleWidth(age) + 1 : 0;
	const name = truncateToWidth(uniqueName(row, rows), Math.max(1, width - 4 - ageRoom), "…");
	const label = chosen ? theme.bold(theme.fg("text", name)) : theme.fg(active || reason ? "text" : "muted", name);
	const head = `${rail} ${mark} ${label}`;
	if (!ageRoom) return head;
	return `${head}${" ".repeat(Math.max(1, width - visibleWidth(head) - visibleWidth(age)))}${theme.fg("dim", age)}`;
}

/** An agent's recorded cost estimate as the status line writes it, or nothing below half a cent. */
export function rosterCost(row: Pick<AgentConversationSummary, "cost" | "partial">): string {
	return Number.isFinite(row.cost) && row.cost >= 0.005 ? `~${formatCost(row.cost, row.partial)}` : "";
}

/** Columns between the model and the cost estimate on a model row. */
const COST_GAP = 2;

/**
 * The model row: the model and its thinking level, and the cost estimate at the right. The cost
 * shows only while the whole model fits beside it, so the model is never shortened for the cost.
 */
function rosterModelRow(
	row: AgentConversationSummary,
	width: number,
	theme: Theme,
	reasons?: (row: Pick<AgentConversationSummary, "model">) => boolean | undefined,
): string {
	const model = modelLabel(row, theme, width, reasons);
	const cost = rosterCost(row);
	// The whole model's width, so a shortened model leaves no room for the cost.
	const used = row.model ? modelColumns(row, reasons) : visibleWidth(model);
	const room = width - used - COST_GAP - visibleWidth(cost);
	if (!cost || room < 0) return model;
	return `${model}${" ".repeat(room + COST_GAP)}${theme.fg("dim", cost)}`;
}

/** Columns of the whole model label, `provider/model [level]`; nothing for an unknown model. */
function modelColumns(
	row: Pick<AgentConversationSummary, "model">,
	reasons?: (row: Pick<AgentConversationSummary, "model">) => boolean | undefined,
): number {
	const model = row.model;
	if (!model) return 0;
	const level = oneLine(model.thinkingLevel);
	const bracket = level && THINKING_LEVELS.includes(level) && reasons?.(row) !== false ? ` [${level}]` : "";
	return visibleWidth(oneLine(`${model.provider}/${model.modelId}`)) + visibleWidth(bracket);
}

/** Columns a model row needs to show the whole model and the cost estimate beside it. */
export function rosterModelColumns(
	row: Pick<AgentConversationSummary, "model" | "cost" | "partial">,
	reasons?: (row: Pick<AgentConversationSummary, "model">) => boolean | undefined,
): number {
	const model = modelColumns(row, reasons);
	if (!model) return 0;
	const cost = rosterCost(row);
	return model + (cost ? COST_GAP + visibleWidth(cost) : 0);
}

/** What a working agent does now, or an error reason; nothing for a settled agent without one. */
function rosterThirdRow(row: AgentConversationSummary, width: number, theme: Theme): string | undefined {
	const room = Math.max(1, width - 4);
	if (row.state === "working" || row.state === "starting") {
		const doing = row.state === "starting" ? "Starting" : activityOf(row);
		return theme.fg("muted", truncateToWidth(doing, room, "…"));
	}
	const reason = listReason(row);
	if (!reason) return undefined;
	return theme.fg(currentFault(listedRow(row)) ? "error" : "warning", truncateToWidth(oneLine(reason), room, "…"));
}

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
/**
 * The model as the main session's status line writes it: `provider/model` in the accent colour, then
 * `[level]` in that level's colour for a model that reasons. A long identity shortens before the level.
 */
export function modelLabel(
	row: Pick<AgentConversationSummary, "model">,
	theme: Pick<Theme, "fg">,
	width: number,
	reasons?: (row: Pick<AgentConversationSummary, "model">) => boolean | undefined,
): string {
	const model = row.model;
	if (!model) return theme.fg("dim", "model unknown");
	const level = oneLine(model.thinkingLevel);
	const bracket = level && THINKING_LEVELS.includes(level) && reasons?.(row) !== false ? ` [${level}]` : "";
	const identity = truncateToWidth(
		oneLine(`${model.provider}/${model.modelId}`),
		Math.max(1, width - visibleWidth(bracket)),
		"…",
	);
	return `${theme.fg("accent", identity)}${bracket ? theme.fg(`thinking${level.charAt(0).toUpperCase()}${level.slice(1)}` as ThemeColor, bracket) : ""}`;
}
interface RosterViewport {
	/** Whether the registry says a row's model reasons; unknown keeps the thinking level. */
	reasons?(row: Pick<AgentConversationSummary, "model">): boolean | undefined;
	start?: number;
	footer?: { text: string; color: ThemeColor };
	/** Two rows per agent, without the activity or reason row, for a list with little height. */
	compact?: boolean;
	/** Keep the agent rows, but omit sections from a list of running work. */
	flat?: boolean;
	range?(start: number, maxStart: number): void;
	row?(row: AgentConversationSummary, line: number, height: number): void;
}
interface RosterHit {
	row: AgentConversationSummary;
	line: number;
	height: number;
}
interface DerivedRoster {
	lines: string[];
	start: number;
	maxStart: number;
	hits: RosterHit[];
}

const rosterCaches = new WeakMap<readonly AgentConversationSummary[], WeakMap<Theme, Map<string, DerivedRoster>>>();

/** Model facts and theme values can change without replacing the observed rows. */
export function invalidateRoster(rows: readonly AgentConversationSummary[]): void {
	rosterCaches.delete(rows);
}

/** A section heading: the quiet label and its count, after one blank row unless it opens the window. */
function groupHeading(group: RosterGroup, total: SectionTotal, theme: Theme): string {
	const cost = rosterCost(total);
	return ` ${theme.bold(theme.fg("muted", GROUP_LABEL[group]))} ${theme.fg("dim", String(total.count))}${cost ? theme.fg("dim", ` · ${cost}`) : ""}`;
}

/** The lines from row `start` on: each section's heading before its first shown row. */
function layoutFrom(
	rows: readonly AgentConversationSummary[],
	groups: readonly RosterGroup[] | undefined,
	start: number,
	height: number,
	compact = false,
): { headings: Array<{ index: number; line: number; first: boolean }>; last: number } {
	let lines = 0;
	const headings: Array<{ index: number; line: number; first: boolean }> = [];
	let last = start - 1;
	for (let index = start; index < rows.length; index++) {
		const row = rows[index];
		const size = row && !compact ? rosterRowCount(row) : ROSTER_ROWS;
		const heading = groups && (index === start || groups[index] !== groups[index - 1]);
		const headingRows = heading ? (lines === 0 ? 1 : 2) : 0;
		if (lines + headingRows + size > height) break;
		if (heading) {
			headings.push({ index, line: lines + headingRows - 1, first: lines === 0 });
			lines += headingRows;
		}
		lines += size;
		last = index;
	}
	return { headings, last };
}

/** A section's row count and cost estimate over its loaded rows; an unknown or partial cost marks it partial. */
interface SectionTotal {
	count: number;
	cost: number;
	partial: boolean;
}
function sectionTotals(
	rows: readonly AgentConversationSummary[],
	groups: readonly RosterGroup[],
): Map<RosterGroup, SectionTotal> {
	const totals = new Map<RosterGroup, SectionTotal>();
	rows.forEach((row, index) => {
		const group = groups[index] ?? "earlier";
		const total = totals.get(group) ?? { count: 0, cost: 0, partial: false };
		const known = Number.isFinite(row.cost);
		totals.set(group, {
			count: total.count + 1,
			cost: total.cost + (known ? row.cost : 0),
			partial: total.partial || row.partial || !known,
		});
	});
	return totals;
}

/** Keep the selection in view unless the operator chose an explicit scroll position. */
function rosterWindow(
	rows: readonly AgentConversationSummary[],
	groups: readonly RosterGroup[] | undefined,
	selected: string | undefined,
	room: number,
	requested: number | undefined,
	compact = false,
): { start: number; maxStart: number } {
	// The last start that still fills the window from the end.
	let maxStart = rows.length - 1;
	while (maxStart > 0 && layoutFrom(rows, groups, maxStart - 1, room, compact).last === rows.length - 1) maxStart--;
	maxStart = Math.max(0, maxStart);
	const index = Math.max(
		0,
		rows.findIndex((row) => row.id === selected),
	);
	let start = Math.min(maxStart, Math.max(0, requested ?? 0));
	if (requested === undefined) {
		// Keep the selection in view: from the top when it fits, else with the selection near the window's end.
		while (start < index && layoutFrom(rows, groups, start, room, compact).last < index) start++;
	}
	return { start, maxStart };
}

function deriveRoster(
	rows: readonly AgentConversationSummary[],
	selected: string | undefined,
	width: number,
	height: number,
	now: number,
	theme: Theme,
	viewport?: RosterViewport,
): DerivedRoster {
	const compact = viewport?.compact ?? false;
	const groups = viewport?.flat ? undefined : rows.map((row) => rosterGroup(row, now));
	const totals = groups && sectionTotals(rows, groups);
	const room = Math.max(ROSTER_ROWS + 1, height - 1);
	const { start, maxStart } = rosterWindow(rows, groups, selected, room, viewport?.start, compact);
	const layout = layoutFrom(rows, groups, start, room, compact);
	const lines: string[] = [];
	const hits: RosterHit[] = [];
	for (let index = start; index <= layout.last; index++) {
		const row = rows[index];
		if (row === undefined) continue;
		const heading = layout.headings.find((item) => item.index === index);
		if (heading) {
			if (!heading.first) lines.push("");
			const group = groups?.[index] ?? "earlier";
			lines.push(groupHeading(group, totals?.get(group) ?? { count: 0, cost: 0, partial: false }, theme));
		}
		const block = rosterRow(row, rows, selected, width, theme, now, viewport?.reasons, compact);
		const line = lines.length;
		hits.push({ row, line, height: block.length });
		lines.push(...block);
	}
	const counted = rosterFooter(rows, start, layout.last);
	const footer = viewport?.footer ?? counted;
	while (lines.length < height - 1) lines.push("");
	lines.push(theme.fg(footer.color, footer.text));
	return { lines: lines.slice(0, height), start, maxStart, hits };
}
/** How many rows sit above or below the window; nothing when every row shows. */
function rosterFooter(
	rows: readonly AgentConversationSummary[],
	start: number,
	last: number,
): { text: string; color: ThemeColor } {
	const below = rows.length - 1 - last;
	if (!start && !below) return { text: "", color: "muted" };
	return {
		text: !start ? `↓ ${below} more` : !below ? `↑ ${start} more` : `↑ ${start} · ↓ ${below} more`,
		color: "muted",
	};
}
export function rosterLines(
	rows: readonly AgentConversationSummary[],
	selected: string | undefined,
	width: number,
	height: number,
	now: number,
	theme: Theme,
	viewport?: RosterViewport,
): string[] {
	let themes = rosterCaches.get(rows);
	if (!themes) {
		themes = new WeakMap();
		rosterCaches.set(rows, themes);
	}
	let cache = themes.get(theme);
	if (!cache) {
		cache = new Map();
		themes.set(theme, cache);
	}
	const key = JSON.stringify([
		selected,
		width,
		height,
		Math.floor(now / 60000),
		viewport?.start,
		viewport?.footer,
		viewport?.compact ?? false,
		viewport?.flat ?? false,
	]);
	let derived = cache.get(key);
	if (!derived) {
		derived = deriveRoster(rows, selected, width, height, now, theme, viewport);
		cache.set(key, derived);
		if (cache.size > 24) cache.delete(cache.keys().next().value ?? "");
	}
	viewport?.range?.(derived.start, derived.maxStart);
	for (const hit of derived.hits) viewport?.row?.(hit.row, hit.line, hit.height);
	return [...derived.lines];
}
