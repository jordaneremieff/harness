import { basename } from "node:path";
import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { AgentConversationSummary, AgentDashboardCoverage } from "./dashboard-types.ts";
import { cleanDashboardText } from "./dashboard-conversation.ts";
import { formatCost } from "./agent-footer.ts";
import { fitLine, highlightRow } from "./dashboard-layout.ts";

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
		const nested = body.error && typeof body.error === "object" ? (body.error as Record<string, unknown>).message : undefined;
		const message = typeof body.message === "string" ? body.message : typeof nested === "string" ? nested : typeof body.error === "string" ? body.error : undefined;
		if (!message) return flat;
		const prefix = flat.slice(0, start).replace(/[:\s]+$/u, "");
		return oneLine(prefix ? `${prefix} ${message}` : message);
	} catch {
		return flat;
	}
}
/** One label per agent: the display name, else the handle, else the quoted first input, else the folder. */
export const titleOf = (row: AgentConversationSummary) =>
	oneLine(row.name?.trim() || row.profile?.handle || (row.firstMessage?.trim() ? `“${oneLine(row.firstMessage)}”` : "") || basename(row.cwd) || row.id);
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
/** Recovery detail for a held storage; an absent report is not a health verdict. */
function recoveryLines(row: AgentConversationSummary, skipRetry = false): Array<{ color: ThemeColor; text: string }> {
	const health = row.health;
	if (!health) return [];
	const lines: Array<{ color: ThemeColor; text: string }> = [];
	if (health.lastError) lines.push({ color: "error", text: `Last host error: ${oneLine(health.lastError)}` });
	if (health.compactionFailure) {
		const failure = health.compactionFailure;
		lines.push({
			color: "warning",
			text: `Last compaction failure (${failure.trigger}) at ${failure.at}: ${oneLine(failure.errorMessage ?? "no error text")}`,
		});
	}
	if (!skipRetry && health.autoRetry)
		lines.push({
			color: "warning",
			text: `provider retry ${health.autoRetry.attempt}/${health.autoRetry.maxAttempts} after ${elapsed(health.autoRetry.delayMs)}: ${oneLine(health.autoRetry.errorMessage)}`,
		});
	return lines;
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
	return Number(right.rosterOrder?.priority ?? false) - Number(left.rosterOrder?.priority ?? false) ||
		(right.rosterOrder?.modifiedAt ?? right.modifiedAt) - (left.rosterOrder?.modifiedAt ?? left.modifiedAt) || left.id.localeCompare(right.id);
}
/** Attention means the operator must act; a terminal outcome alone is a record. */
export function needsAttention(row: AgentConversationSummary): boolean {
	if (row.owner === "unavailable" || row.state === "unavailable") return true;
	if (row.health?.lastError || row.health?.compactionFailure) return true;
	const retry = row.health?.autoRetry;
	if (retry !== undefined && retry.attempt >= retry.maxAttempts) return true;
	return row.state === "failed" && Boolean(row.error);
}
/** A fault the host reports now, as opposed to the stored outcome of a finished run. */
export function currentFault(row: AgentConversationSummary): boolean {
	if (row.owner === "unavailable" || row.state === "unavailable") return true;
	if (row.health?.lastError || row.health?.compactionFailure) return true;
	const retry = row.health?.autoRetry;
	return retry !== undefined && retry.attempt >= retry.maxAttempts;
}
/**
 * The supported way forward for a row with an error. A provider block needs a model change before the
 * next message; a failed run needs a new message, which runs the work again; a host fault needs Reconnect.
 */
export function recoveryHint(row: AgentConversationSummary): string | undefined {
	if (row.state === "working") return undefined;
	if (row.attention === "provider-blocked") return "Configure another model, then send a message";
	if (row.attention === "task-blocked") return "The host must repair a blocked task; Reconnect starts it";
	if (row.owner === "unavailable" || row.state === "unavailable") return "Reconnect starts the host when the storage is readable";
	if (currentFault(row)) return "Reconnect starts the host; unfinished work resumes";
	if (row.state === "failed" && row.error) return "A new message runs the work again";
	return undefined;
}
/** One governing failure reason; full recovery records belong in Details. */
export function attentionReason(row: AgentConversationSummary): string | undefined {
	if (row.owner === "unavailable" || row.state === "unavailable")
		return `Unavailable: ${oneLine(row.error || row.ownerLabel || "Storage cannot be read")}`;
	if (row.health?.lastError) return `Host error: ${readableError(row.health.lastError)}`;
	const failure = row.health?.compactionFailure;
	if (failure) return `Compaction failed (${failure.trigger}): ${readableError(failure.errorMessage || "No error text")}`;
	const retry = row.health?.autoRetry;
	if (retry && retry.attempt >= retry.maxAttempts) return `Retries exhausted: ${readableError(retry.errorMessage)}`;
	if (row.state === "failed" && row.error) return readableError(row.error);
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
	if (inventory.unknownClaims) parts.push(`${inventory.unknownClaims} writer claims unknown; live priority not established`);
	if (inventory.remaining) parts.push(`${inventory.remaining} records (${inventory.remainingRows} rows) outside this page`);
	if (inventory.priorityRemaining) parts.push(`${inventory.priorityRemaining} live or caller-owned records (${inventory.priorityRemainingRows} rows) outside this page`);
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
	const attention = rows.filter(needsAttention).length;
	const working = rows.filter((row) => !needsAttention(row) && (row.state === "working" || row.state === "starting")).length;
	const coverage = snapshot?.coverage;
	const incomplete =
		rows.some((row) => row.partial || !Number.isFinite(row.cost)) ||
		Boolean(coverage && (!coverage.complete || coverage.nextCursor || coverage.skipped || coverage.omitted));
	const cost = rows.reduce((sum, row) => sum + (Number.isFinite(row.cost) ? row.cost : 0), 0);
	return `${working} working${attention ? ` · ${attention} need attention` : ""} · ${formatCost(cost, incomplete)} retained`;
}
/** Plain-text roster summary for non-TUI reads and status tests. */
export function dashboardText(snapshot: AgentDashboardSnapshot): string {
	const coverage = coverageText(snapshot.coverage);
	return [
		"Agent dashboard",
		rosterTotals(snapshot),
		...(coverage ? [`Coverage: ${coverage}`] : []),
		...(snapshot.error ? [`Store unavailable: ${snapshot.error}`] : []),
		...dashboardRecords(snapshot, "").flatMap((row) => [
			oneLine(
				`${sessionAppearance[row.state].glyph} ${stateLabel(row)} · ${titleOf(row)} · ${basename(row.cwd)} · ${row.model?.modelId ?? "unknown model"} · ${costOf(row)}`,
			),
			`  ${oneLine(row.id)} · ${oneLine(row.cwd)}`,
			...(row.profile?.role ? [`  Role: ${oneLine(row.profile.role)}`] : []),
			...recoveryLines(row).map((line) => `  ${oneLine(line.text)}`),
			...(row.latestReply ? [`  ${oneLine(row.latestReply).slice(0, 300)}`] : []),
		]),
		"Use /agent help for actions.",
	].join("\n");
}

/** The row label, with the shortest identity suffix that tells duplicate labels apart. */
function uniqueName(row: AgentConversationSummary, rows: readonly AgentConversationSummary[]): string {
	const name = titleOf(row);
	const duplicates = rows.filter((other) => titleOf(other) === name);
	if (duplicates.length < 2) return name;
	let length = 4;
	while (
		length < row.id.length &&
		duplicates.some((other) => other.id !== row.id && other.id.slice(-length) === row.id.slice(-length))
	)
		length++;
	return `${name} ${row.id.slice(-length)}`;
}
/** Published arguments can end mid-JSON; extract a string value without displaying the serialized object. */
export function argumentSummary(argument: string): string {
	let value: unknown;
	try {
		const parsed = JSON.parse(argument);
		value = typeof parsed === "string" ? parsed : parsed && typeof parsed === "object" ? Object.values(parsed).find((item) => typeof item === "string") : undefined;
	} catch {
		const match = argument.match(/"(?:\\.|[^"\\])*"\s*:\s*"((?:\\.|[^"\\])*)/);
		if (match) {
			try { value = JSON.parse(`"${match[1].replace(/\\$/, "")}"`); } catch { value = undefined; }
		} else if (!argument.trim().startsWith("{") && !argument.trim().startsWith("[")) value = argument;
	}
	return typeof value === "string" ? truncateToWidth(oneLine(value), 60, "…") : "";
}
export function activityOf(row: AgentConversationSummary): string {
	const reason = attentionReason(row);
	if (reason) return reason;
	if (row.state === "working") return row.currentTool ? oneLine(`${row.currentTool.name} ${argumentSummary(row.currentTool.argument)}`) : "Responding";
	return row.latestReply ? oneLine(row.latestReply) : row.state === "starting" ? "Starting agent" : "No reply yet";
}
/** An absent observation time leaves the published age unchanged. */
function ageAt(age: number, observedAt: number | undefined, now: number): number {
	return age + (observedAt === undefined || !Number.isFinite(observedAt) ? 0 : Math.max(0, now - observedAt));
}

/** Admitted inputs that the agent has not read yet, with the age of the oldest one; empty when none waits. */
export function unplacedText(row: Pick<AgentConversationSummary, "unplaced" | "oldest" | "ageObservedAt">, now = Date.now()): string {
	if (!row.unplaced) return "";
	if (row.oldest === undefined) return `unplaced: ${row.unplaced}`;
	const seconds = Math.floor(ageAt(row.oldest, row.ageObservedAt, now) / 1000), minutes = Math.floor(seconds / 60);
	const age = minutes < 1 ? `${seconds}s` : minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
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
 * Two quiet rows per agent: the state mark and the name, then the model and its thinking level. Only
 * agents at work and agents with an error carry colour; a settled agent's name is muted, and the
 * selected agent is bold on the selection colour.
 */
function rosterRow(
	row: AgentConversationSummary,
	rows: readonly AgentConversationSummary[],
	selected: string | undefined,
	width: number,
	theme: Theme,
	reasons?: (row: Pick<AgentConversationSummary, "model">) => boolean | undefined,
): string[] {
	const appearance = sessionAppearance[row.state];
	const chosen = row.id === selected;
	const active = row.state === "working" || row.state === "starting";
	const reason = listReason(row);
	const mark = theme.fg(active ? "accent" : reason ? (currentFault(listedRow(row)) ? "error" : "warning") : "dim", appearance.glyph);
	const name = truncateToWidth(uniqueName(row, rows), Math.max(1, width - 4), "…");
	const label = chosen ? theme.bold(theme.fg("text", name)) : theme.fg(active || reason ? "text" : "muted", name);
	const rail = chosen ? theme.fg("accent", "▌") : " ";
	const lines = [`${rail} ${mark} ${label}`, `${rail}   ${modelLabel(row, theme, Math.max(1, width - 4), reasons)}`];
	return lines.map((line) => (chosen ? highlightRow(line, width, 2, theme) : fitLine(line, width)));
}

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
/**
 * The model as the main session's status line writes it: `provider/model` in the accent colour, then
 * `[level]` in that level's colour for a model that reasons. A long identity shortens before the level.
 */
export function modelLabel(row: Pick<AgentConversationSummary, "model">, theme: Pick<Theme, "fg">, width: number, reasons?: (row: Pick<AgentConversationSummary, "model">) => boolean | undefined): string {
	const model = row.model;
	if (!model) return theme.fg("dim", "model unknown");
	const level = oneLine(model.thinkingLevel);
	const bracket = level && THINKING_LEVELS.includes(level) && reasons?.(row) !== false ? ` [${level}]` : "";
	const identity = truncateToWidth(oneLine(`${model.provider}/${model.modelId}`), Math.max(1, width - visibleWidth(bracket)), "…");
	return `${theme.fg("accent", identity)}${bracket ? theme.fg(`thinking${level.charAt(0).toUpperCase()}${level.slice(1)}` as ThemeColor, bracket) : ""}`;
}
interface RosterViewport {
	/** Whether the registry says a row's model reasons; unknown keeps the thinking level. */
	reasons?(row: Pick<AgentConversationSummary, "model">): boolean | undefined;
	start?: number;
	footer?: { text: string; color: ThemeColor };
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
function groupHeading(group: RosterGroup, count: number, theme: Theme): string {
	return ` ${theme.bold(theme.fg("muted", GROUP_LABEL[group]))} ${theme.fg("dim", String(count))}`;
}

/** The lines from row `start` on: each section's heading before its first shown row. */
function layoutFrom(rows: readonly AgentConversationSummary[], groups: readonly RosterGroup[], start: number, height: number): { headings: Array<{ index: number; line: number; first: boolean }>; last: number } {
	let lines = 0;
	const headings: Array<{ index: number; line: number; first: boolean }> = [];
	let last = start - 1;
	for (let index = start; index < rows.length; index++) {
		const heading = index === start || groups[index] !== groups[index - 1];
		const headingRows = heading ? (lines === 0 ? 1 : 2) : 0;
		if (lines + headingRows + ROSTER_ROWS > height) break;
		if (heading) {
			headings.push({ index, line: lines + headingRows - 1, first: lines === 0 });
			lines += headingRows;
		}
		lines += ROSTER_ROWS;
		last = index;
	}
	return { headings, last };
}

/** Keep the selection in view unless the operator chose an explicit scroll position. */
function rosterWindow(rows: readonly AgentConversationSummary[], groups: readonly RosterGroup[], selected: string | undefined, room: number, requested: number | undefined): { start: number; maxStart: number } {
	// The last start that still fills the window from the end.
	let maxStart = rows.length - 1;
	while (maxStart > 0 && layoutFrom(rows, groups, maxStart - 1, room).last === rows.length - 1) maxStart--;
	maxStart = Math.max(0, maxStart);
	const index = Math.max(0, rows.findIndex((row) => row.id === selected));
	let start = Math.min(maxStart, Math.max(0, requested ?? 0));
	if (requested === undefined) {
		// Keep the selection in view: from the top when it fits, else with the selection near the window's end.
		while (start < index && layoutFrom(rows, groups, start, room).last < index) start++;
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
	const groups = rows.map((row) => rosterGroup(row, now));
	const counts = new Map<RosterGroup, number>();
	for (const group of groups) counts.set(group, (counts.get(group) ?? 0) + 1);
	const room = Math.max(ROSTER_ROWS, height - 1);
	const { start, maxStart } = rosterWindow(rows, groups, selected, room, viewport?.start);
	const layout = layoutFrom(rows, groups, start, room);
	const lines: string[] = [];
	const hits: RosterHit[] = [];
	for (let index = start; index <= layout.last; index++) {
		const row = rows[index];
		if (row === undefined) continue;
		const heading = layout.headings.find((item) => item.index === index);
		if (heading) {
			if (!heading.first) lines.push("");
			lines.push(groupHeading(groups[index] ?? "earlier", counts.get(groups[index] ?? "earlier") ?? 0, theme));
		}
		const block = rosterRow(row, rows, selected, width, theme, viewport?.reasons);
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
function rosterFooter(rows: readonly AgentConversationSummary[], start: number, last: number): { text: string; color: ThemeColor } {
	const below = rows.length - 1 - last;
	if (!start && !below) return { text: "", color: "muted" };
	return { text: !start ? `↓ ${below} more` : !below ? `↑ ${start} more` : `↑ ${start} · ↓ ${below} more`, color: "muted" };
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
	const key = JSON.stringify([selected, width, height, Math.floor(now / 60000), viewport?.start, viewport?.footer]);
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
