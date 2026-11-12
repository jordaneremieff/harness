import { basename } from "node:path";
import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { dashboardTime } from "./dashboard-time.ts";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { AgentConversationSummary, AgentDashboardCoverage } from "./dashboard-types.ts";
import { cleanDashboardText } from "./dashboard-conversation.ts";
import { formatCost } from "./agent-footer.ts";
import { LIST_BLOCK_ROWS, listBlock } from "./dashboard-layout.ts";

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
/** Declared work stays visible after its input settles and before its final report. */
export function openWorkText(row: Pick<AgentConversationSummary, "openWorkCount" | "openWorkOldest" | "ageObservedAt">, now = Date.now()): string {
	if (!row.openWorkCount) return "";
	if (row.openWorkOldest === undefined) return `work open: ${row.openWorkCount}`;
	const seconds = Math.floor(ageAt(row.openWorkOldest, row.ageObservedAt, now) / 1000), minutes = Math.floor(seconds / 60);
	const age = minutes < 1 ? `${seconds}s` : minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
	return `work open: ${row.openWorkCount}, oldest: ${age}`;
}
function rosterModel(row: AgentConversationSummary): string {
	if (!row.model) return "";
	return `${oneLine(row.model.modelId)} ${oneLine(row.model.thinkingLevel)}`;
}
/**
 * The roster's second line. A row with an error shows its reason; a working agent shows its current
 * tool; every other row shows its model, reasoning level and cost. Inputs that the agent has not
 * read yet show as a count with the age of the oldest one. Rows with open work or unplaced inputs put their model facts first.
 */
export function rosterDetail(row: AgentConversationSummary, now = Date.now()): { text: string; color: ThemeColor } {
	const reason = attentionReason(row);
	// The list keeps the reason's first sentence; the selected agent's header shows all of it.
	const openWork = openWorkText(row, now), unplaced = unplacedText(row, now);
	const facts = [rosterModel(row), costOf(row)].filter(Boolean).join(" · ");
	if (reason) return { text: [openWork || unplaced ? facts : "", openWork, unplaced, reason.split(/(?<=[.!?])\s/u)[0] ?? reason].filter(Boolean).join(" · "), color: currentFault(row) ? "error" : "warning" };
	if (row.state === "working") return { text: (openWork || unplaced ? [facts, openWork, activityOf(row), unplaced] : [activityOf(row), facts]).filter(Boolean).join(" · "), color: "muted" };
	return { text: [facts, openWork, unplaced].filter(Boolean).join(" · "), color: "muted" };
}
function rosterRow(
	row: AgentConversationSummary,
	rows: readonly AgentConversationSummary[],
	selected: string | undefined,
	width: number,
	theme: Theme,
	exactTime: boolean,
	now: number,
	primaryId?: string,
): { lines: string[]; timeX: number; timeWidth: number; timeLine: number } {
	const appearance = sessionAppearance[row.state];
	const time = dashboardTime(row.modifiedAt, exactTime, now);
	void primaryId;
	const detail = rosterDetail(row, now);
	// An exact date is long, so it shares the detail row instead of shortening the name.
	const block = listBlock({ title: uniqueName(row, rows), glyph: appearance.glyph, glyphColor: appearance.color, detail: detail.text, detailColor: detail.color, time, timeOnDetail: exactTime, selected: row.id === selected }, width, theme);
	return { lines: block.lines, timeX: block.timeX, timeWidth: block.timeWidth, timeLine: block.timeLine };
}
function rosterWindow(
	rows: readonly AgentConversationSummary[],
	selected: string | undefined,
	height: number,
	requested?: number,
): { capacity: number; start: number; maxStart: number } {
	const index = Math.max(
		0,
		rows.findIndex((row) => row.id === selected),
	);
	const capacity = Math.max(1, Math.floor((height - 1) / LIST_BLOCK_ROWS));
	const maxStart = Math.max(0, rows.length - capacity);
	const start = Math.min(maxStart, Math.max(0, requested ?? index - Math.floor(capacity / 2)));
	return { capacity, maxStart, start };
}
interface RosterViewport {
	primaryId?: string;
	start?: number;
	exactTime?: boolean;
	footer?: { text: string; color: ThemeColor };
	/** The rows are the error filter's result; the footer offers the way back to every row. */
	errorsOnly?: boolean;
	range?(start: number, maxStart: number): void;
	row?(row: AgentConversationSummary, line: number, height: number): void;
	timestamp?(row: AgentConversationSummary, line: number, x: number, width: number): void;
	/** The footer's error filter control: its row, first column and width. */
	errors?(line: number, x: number, width: number): void;
}
interface RosterHit {
	row: AgentConversationSummary;
	line: number;
	height: number;
}
interface RosterTimeHit {
	row: AgentConversationSummary;
	line: number;
	x: number;
	width: number;
}
interface DerivedRoster {
	lines: string[];
	start: number;
	maxStart: number;
	hits: RosterHit[];
	times: RosterTimeHit[];
	errors?: { line: number; x: number; width: number };
}
const rosterCaches = new WeakMap<readonly AgentConversationSummary[], WeakMap<Theme, Map<string, DerivedRoster>>>();
function deriveRoster(
	rows: readonly AgentConversationSummary[],
	selected: string | undefined,
	width: number,
	height: number,
	now: number,
	theme: Theme,
	viewport?: RosterViewport,
): DerivedRoster {
	const { capacity, start, maxStart } = rosterWindow(rows, selected, height, viewport?.start);
	const lines: string[] = [];
	const hits: RosterHit[] = [];
	const times: RosterTimeHit[] = [];
	for (const row of rows.slice(start, start + capacity)) {
		const block = rosterRow(row, rows, selected, width, theme, viewport?.exactTime ?? false, now, viewport?.primaryId);
		const line = lines.length;
		if (line < height) {
			hits.push({ row, line, height: Math.min(block.lines.length, height - line) });
			const timeLine = line + block.timeLine;
			if (timeLine < height) times.push({ row, line: timeLine, x: block.timeX, width: Math.min(block.timeWidth, width - block.timeX) });
		}
		lines.push(...block.lines);
	}
	const shown = rows.slice(start, start + capacity).length;
	const counted = rosterFooter(rows, start, shown, viewport?.errorsOnly ?? false);
	const footer = viewport?.footer ?? counted;
	lines.push(theme.fg(footer.color, footer.text));
	const control = viewport?.footer ? undefined : counted.control;
	return { lines: lines.slice(0, height), start, maxStart, hits, times, ...(control && lines.length <= height ? { errors: { line: lines.length - 1, ...control } } : {}) };
}
/**
 * The list footer: how many loaded rows sit above or below the visible window, then the error count
 * or the error filter's state. The count is a passive fact that also takes a click; the filter's
 * control is `e` in the key footer.
 */
function rosterFooter(rows: readonly AgentConversationSummary[], start: number, shown: number, errorsOnly: boolean): { text: string; color: ThemeColor; control?: { x: number; width: number } } {
	const hidden = rows.length - shown;
	const below = rows.length - start - shown;
	const position = !hidden
		? `${rows.length} ${errorsOnly ? "with errors" : `agent${rows.length === 1 ? "" : "s"}`}`
		: !start ? `↓ ${below} more` : !below ? `↑ ${start} more` : `↑ ${start} · ↓ ${below} more`;
	const errors = rows.filter(needsAttention).length;
	const label = errorsOnly ? "errors only" : errors ? `${errors} with errors` : "";
	if (!label) return { text: position, color: "muted" };
	const prefix = `${position} · `;
	return { text: `${prefix}${label}`, color: "muted", control: { x: visibleWidth(prefix), width: visibleWidth(label) } };
}
export function rosterLines(
	rows: readonly AgentConversationSummary[],
	selected: string | undefined,
	width: number,
	height: number,
	now: number,
	theme: Theme,
	compact: boolean,
	viewport?: RosterViewport,
): string[] {
	void compact;
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
	const ticking = rows.some((row) => Number.isFinite(row.ageObservedAt) && ((row.unplaced && row.oldest !== undefined) || (row.openWorkCount && row.openWorkOldest !== undefined)));
	const key = JSON.stringify([selected, width, height, Math.floor(now / (ticking ? 1000 : 60000)), viewport?.start, viewport?.exactTime, viewport?.primaryId, viewport?.footer, viewport?.errorsOnly]);
	let derived = cache.get(key);
	if (!derived) {
		derived = deriveRoster(rows, selected, width, height, now, theme, viewport);
		cache.set(key, derived);
		if (cache.size > 24) cache.delete(cache.keys().next().value ?? "");
	}
	viewport?.range?.(derived.start, derived.maxStart);
	for (const hit of derived.hits) viewport?.row?.(hit.row, hit.line, hit.height);
	for (const hit of derived.times) viewport?.timestamp?.(hit.row, hit.line, hit.x, hit.width);
	if (derived.errors) viewport?.errors?.(derived.errors.line, derived.errors.x, derived.errors.width);
	return [...derived.lines];
}
