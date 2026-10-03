import { basename } from "node:path";
import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { dashboardTime } from "./dashboard-time.ts";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { AgentConversationSummary, AgentDashboardCoverage } from "./dashboard-types.ts";
import { cleanDashboardText } from "./dashboard-conversation.ts";
import { formatCost } from "./agent-footer.ts";

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
	new: { label: "New", glyph: "·", color: "dim" },
	unavailable: { label: "Unavailable", glyph: "?", color: "error" },
};
const oneLine = (text: string) => cleanDashboardText(text).replace(/\s+/g, " ").trim();
export const titleOf = (row: AgentConversationSummary) =>
	oneLine(row.name || row.firstMessage || basename(row.cwd) || row.id);
const pad = (text: string, width: number) => {
	const clipped = truncateToWidth(text, Math.max(0, width));
	return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
};
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
			text: `Last compaction failure (${failure.reason}) at ${failure.at}: ${oneLine(failure.errorMessage ?? "no error text")}`,
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
/** Attention means the operator must act; a terminal outcome alone is a record. */
export function needsAttention(row: AgentConversationSummary): boolean {
	if (row.owner === "unavailable" || row.state === "unavailable") return true;
	if (row.health?.lastError || row.health?.compactionFailure) return true;
	const retry = row.health?.autoRetry;
	if (retry !== undefined && retry.attempt >= retry.maxAttempts) return true;
	return row.state === "failed" && Boolean(row.error);
}
/** One governing Attention reason; full recovery records belong in Details. */
export function attentionReason(row: AgentConversationSummary): string | undefined {
	if (row.owner === "unavailable" || row.state === "unavailable")
		return `Unavailable: ${oneLine(row.error || row.ownerLabel || "Storage cannot be read")}`;
	if (row.health?.lastError) return `Host error: ${oneLine(row.health.lastError)}`;
	const failure = row.health?.compactionFailure;
	if (failure) return `Compaction failed (${failure.reason}): ${oneLine(failure.errorMessage || "No error text")}`;
	const retry = row.health?.autoRetry;
	if (retry && retry.attempt >= retry.maxAttempts) return `Retries exhausted: ${oneLine(retry.errorMessage)}`;
	if (row.state === "failed" && row.error) return `Work failed: ${oneLine(row.error)}`;
	return undefined;
}
export function sectionOf(row: AgentConversationSummary, now: number): string {
	if (needsAttention(row)) return "Attention";
	if (row.state === "working" || row.state === "starting") return "Working";
	const today = new Date(now);
	today.setHours(0, 0, 0, 0);
	const yesterday = new Date(today);
	yesterday.setDate(yesterday.getDate() - 1);
	return row.modifiedAt >= today.getTime() ? "Today" : row.modifiedAt >= yesterday.getTime() ? "Yesterday" : "Earlier";
}
export function dashboardRecords(
	snapshot: AgentDashboardSnapshot | undefined,
	filter: string,
): AgentConversationSummary[] {
	const terms = oneLine(filter).toLocaleLowerCase().split(" ").filter(Boolean);
	const sections = ["Working", "Attention", "Today", "Yesterday", "Earlier"];
	return (snapshot?.sessions ?? [])
		.filter((row) => {
			const text =
				`${titleOf(row)} ${row.firstMessage ?? ""} ${row.cwd} ${row.id} ${stateLabel(row)} ${row.model?.provider ?? ""} ${row.model?.modelId ?? ""} ${row.model?.thinkingLevel ?? ""}`.toLocaleLowerCase();
			return terms.every((term) => text.includes(term));
		})
		.sort(
			(a, b) =>
				sections.indexOf(sectionOf(a, snapshot?.observedAt ?? Date.now())) -
					sections.indexOf(sectionOf(b, snapshot?.observedAt ?? Date.now())) ||
				b.modifiedAt - a.modifiedAt ||
				a.id.localeCompare(b.id),
		);
}
/** Coverage of the returned page; an empty or bounded page is not proof of absence. */
export function coverageText(coverage: AgentDashboardCoverage | undefined): string {
	if (!coverage) return "";
	const parts: string[] = [];
	if (coverage.skipped)
		parts.push(`${coverage.skipped} store${coverage.skipped === 1 ? "" : "s"} skipped (unknown, not absent)`);
	if (coverage.omitted) parts.push(`${coverage.omitted} row${coverage.omitted === 1 ? "" : "s"} not loaded`);
	if (coverage.nextCursor) parts.push("more inventory to inspect");
	if (!coverage.complete && !coverage.nextCursor) parts.push("coverage incomplete");
	return parts.join(" · ");
}
export function rosterTotals(snapshot: AgentDashboardSnapshot | undefined): string {
	const rows = snapshot?.sessions ?? [];
	const now = snapshot?.observedAt ?? Date.now();
	const working = rows.filter((row) => sectionOf(row, now) === "Working").length;
	const attention = rows.filter((row) => sectionOf(row, now) === "Attention").length;
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
			...recoveryLines(row).map((line) => `  ${oneLine(line.text)}`),
			...(row.latestReply ? [`  ${oneLine(row.latestReply).slice(0, 300)}`] : []),
		]),
		"Use /agent help for actions.",
	].join("\n");
}

function uniqueTitle(row: AgentConversationSummary, rows: readonly AgentConversationSummary[], width: number): string {
	const name = titleOf(row);
	const duplicates = rows.filter((other) => titleOf(other) === name);
	if (duplicates.length < 2) return truncateToWidth(name, width);
	let length = 4;
	while (
		length < row.id.length &&
		duplicates.some((other) => other.id !== row.id && other.id.slice(-length) === row.id.slice(-length))
	)
		length++;
	const suffix = ` ${row.id.slice(-length)}`;
	return truncateToWidth(name, Math.max(1, width - visibleWidth(suffix))) + suffix;
}
function rosterRow(
	row: AgentConversationSummary,
	rows: readonly AgentConversationSummary[],
	selected: string | undefined,
	width: number,
	theme: Theme,
	compact: boolean,
	exactTime: boolean,
): { lines: string[]; timeX: number; timeWidth: number; timeLine: number } {
	const appearance = sessionAppearance[row.state];
	const updated = `Updated ${dashboardTime(row.modifiedAt, exactTime)}`;
	const detail = `${appearance.label}  ${costOf(row)}  ${updated}`;
	const titleWidth = compact ? Math.max(1, width - 5 - visibleWidth(detail)) : width - 5;
	const title = pad(uniqueTitle(row, rows, titleWidth), titleWidth);
	let text =
		(row.id === selected ? theme.fg("accent", "› ") : "  ") +
		theme.fg(appearance.color, `${appearance.glyph} `) +
		(row.id === selected ? theme.bold(theme.fg("accent", title)) : title);
	if (compact)
		text += ` ${theme.fg(appearance.color, appearance.label)}  ${theme.fg("muted", `${costOf(row)}  ${updated}`)}`;
	text = pad(text, width);
	const lines = [row.id === selected ? theme.bg("selectedBg", text) : text];
	if (!compact) {
		lines.push(theme.fg(appearance.color, truncateToWidth(`  ${appearance.label}  ${costOf(row)}`, width)));
		lines.push(theme.fg("muted", truncateToWidth(`  ${updated}`, width)));
	}
	const timeX = compact ? 5 + titleWidth + visibleWidth(`${appearance.label}  ${costOf(row)}  `) : 2;
	return {
		lines: lines.map((line) => truncateToWidth(line, width)),
		timeX,
		timeWidth: Math.max(0, Math.min(visibleWidth(updated), width - timeX)),
		timeLine: compact ? 0 : 2,
	};
}
function rosterWindow(
	rows: readonly AgentConversationSummary[],
	selected: string | undefined,
	height: number,
	compact: boolean,
	requested?: number,
): { capacity: number; start: number; maxStart: number } {
	const index = Math.max(
		0,
		rows.findIndex((row) => row.id === selected),
	);
	const capacity = compact ? 3 : Math.max(1, Math.floor((height - 2) / 4));
	const maxStart = Math.max(0, rows.length - capacity);
	return { capacity, maxStart, start: Math.min(maxStart, Math.max(0, requested ?? index - Math.floor(capacity / 2))) };
}
interface RosterViewport {
	start?: number;
	exactTime?: boolean;
	range?(start: number, maxStart: number): void;
	row?(row: AgentConversationSummary, line: number, height: number): void;
	timestamp?(row: AgentConversationSummary, line: number, x: number, width: number): void;
}
function rosterHit(
	viewport: RosterViewport | undefined,
	row: AgentConversationSummary,
	block: ReturnType<typeof rosterRow>,
	line: number,
	width: number,
	height: number,
): void {
	if (line >= height) return;
	viewport?.row?.(row, line, Math.min(block.lines.length, height - line));
	const timeLine = line + block.timeLine;
	if (timeLine < height)
		viewport?.timestamp?.(row, timeLine, block.timeX, Math.min(block.timeWidth, width - block.timeX));
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
	const { capacity, start, maxStart } = rosterWindow(rows, selected, height, compact, viewport?.start);
	viewport?.range?.(start, maxStart);
	const lines: string[] = compact ? [] : [theme.fg("muted", "Roster")];
	let section = "";
	for (const row of rows.slice(start, start + capacity)) {
		const group = sectionOf(row, now);
		if (!compact && group !== section) {
			lines.push(theme.fg("accent", group));
			section = group;
		}
		const block = rosterRow(row, rows, selected, width, theme, compact, viewport?.exactTime ?? false);
		rosterHit(viewport, row, block, lines.length, width, height);
		lines.push(...block.lines);
	}
	while (compact && lines.length < 3) lines.push("");
	const shown = rows.slice(start, start + capacity).length;
	const hidden = rows.length - shown;
	lines.push(
		hidden && !compact
			? `${shown}/${rows.length} loaded · +${hidden} more`
			: `${shown} of ${rows.length} loaded agents shown${hidden ? ` · +${hidden} more` : ""}`,
	);
	return lines.slice(0, height);
}
