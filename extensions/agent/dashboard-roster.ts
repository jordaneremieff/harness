import { basename } from "node:path";
import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
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
export function rosterAge(modifiedAt: number, now: number): string {
	return now - modifiedAt < 1000 ? "now" : elapsed(now - modifiedAt);
}
function rosterRow(
	row: AgentConversationSummary,
	rows: readonly AgentConversationSummary[],
	selected: string | undefined,
	width: number,
	now: number,
	theme: Theme,
	compact: boolean,
): string[] {
	const appearance = sessionAppearance[row.state];
	const detail = `${appearance.label}  ${costOf(row)}  ${rosterAge(row.modifiedAt, now)}`;
	const titleWidth = compact ? Math.max(1, width - 3 - visibleWidth(detail)) : width - 3;
	let text = (row.id === selected ? "› " : "  ") + pad(uniqueTitle(row, rows, titleWidth), titleWidth);
	if (compact) text += ` ${theme.fg(appearance.color, detail)}`;
	text = pad(text, width);
	const lines = [row.id === selected ? theme.bg("selectedBg", text) : text];
	if (!compact) lines.push(theme.fg(appearance.color, truncateToWidth(`  ${detail}`, width)));
	return lines;
}
export function rosterLines(
	rows: readonly AgentConversationSummary[],
	selected: string | undefined,
	width: number,
	height: number,
	now: number,
	theme: Theme,
	compact: boolean,
): string[] {
	const index = Math.max(
		0,
		rows.findIndex((row) => row.id === selected),
	);
	const capacity = compact ? 3 : Math.max(1, Math.floor((height - 3) / 3));
	const start = Math.min(Math.max(0, rows.length - capacity), Math.max(0, index - Math.floor(capacity / 2)));
	const lines: string[] = compact ? [] : ["Roster"];
	let section = "";
	for (const row of rows.slice(start, start + capacity)) {
		const group = sectionOf(row, now);
		if (!compact && group !== section) {
			lines.push(theme.fg("accent", group));
			section = group;
		}
		lines.push(...rosterRow(row, rows, selected, width, now, theme, compact));
	}
	while (compact && lines.length < 3) lines.push("");
	lines.push(`${rows.slice(start, start + capacity).length} of ${rows.length} loaded agents shown`);
	return lines.slice(0, height);
}
