import { basename } from "node:path";
import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { dashboardTime } from "./dashboard-time.ts";
import { truncateToWidth, visibleWidth, sliceByColumn } from "@earendil-works/pi-tui";
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
	new: { label: "New", glyph: "·", color: "muted" },
	unavailable: { label: "Unavailable", glyph: "?", color: "error" },
};
const oneLine = (text: string) => cleanDashboardText(text).replace(/\s+/g, " ").trim();
export const titleOf = (row: AgentConversationSummary) =>
	oneLine(row.profile?.handle
		? `${row.profile.handle}${row.name ? ` · ${row.name}` : ""}`
		: row.name || (row.firstMessage ? `Historical: ${row.firstMessage}` : basename(row.cwd) || row.id));
const clip = (text: string, width: number) => cleanDashboardText(truncateToWidth(text, Math.max(0, width), "…"));
const pad = (text: string, width: number) => {
	const clipped = truncateToWidth(text, Math.max(0, width), "…");
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
				`${titleOf(row)} ${row.profile?.role ?? ""} ${row.firstMessage ?? ""} ${row.cwd} ${row.id} ${stateLabel(row)} ${row.model?.provider ?? ""} ${row.model?.modelId ?? ""} ${row.model?.thinkingLevel ?? ""}`.toLocaleLowerCase();
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
			...(row.profile?.role ? [`  Role: ${oneLine(row.profile.role)}`] : []),
			...recoveryLines(row).map((line) => `  ${oneLine(line.text)}`),
			...(row.latestReply ? [`  ${oneLine(row.latestReply).slice(0, 300)}`] : []),
		]),
		"Use /agent help for actions.",
	].join("\n");
}

function uniqueTitle(row: AgentConversationSummary, rows: readonly AgentConversationSummary[], width: number): string {
	const name = titleOf(row);
	const duplicates = rows.filter((other) => titleOf(other) === name);
	if (duplicates.length < 2) return clip(name, width);
	let length = 4;
	while (
		length < row.id.length &&
		duplicates.some((other) => other.id !== row.id && other.id.slice(-length) === row.id.slice(-length))
	)
		length++;
	const suffix = ` ${row.id.slice(-length)}`;
	return clip(name, Math.max(1, width - visibleWidth(suffix))) + suffix;
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
	return typeof value === "string" ? truncateToWidth(oneLine(value), 60) : "";
}
export function activityOf(row: AgentConversationSummary): string {
	const reason = attentionReason(row);
	if (reason) return reason;
	if (row.state === "working") return row.currentTool ? oneLine(`${row.currentTool.name} ${argumentSummary(row.currentTool.argument)}`) : "Responding";
	return row.latestReply ? oneLine(row.latestReply) : row.state === "starting" ? "Starting agent" : "No reply yet";
}
function rosterActivity(row: AgentConversationSummary, size: number, theme: Theme): string {
	const reason = attentionReason(row);
	if (reason) return theme.fg("error", clip(reason, size));
	const activity = activityOf(row);
	if (row.state === "working") return theme.fg("text", clip(activity, size));
	if (["starting", "done"].includes(row.state)) return theme.fg("muted", clip(activity, size));
	const state = sessionAppearance[row.state];
	const rest = activity.toLowerCase().startsWith(state.label.toLowerCase()) ? activity.slice(state.label.length) : ` · ${activity}`;
	return theme.fg(state.color, state.label) + theme.fg("muted", clip(rest, Math.max(0, size - visibleWidth(state.label))));
}
function rosterModel(row: AgentConversationSummary, size: number): string {
	if (!row.model) return clip("model ?", size);
	const thinking = ` ${oneLine(row.model.thinkingLevel)}`;
	return clip(oneLine(row.model.modelId), Math.max(1, size - visibleWidth(thinking))) + thinking;
}
function highlightRow(line: string, width: number, prefix: number, theme: Theme): string {
	// Column slices can omit closing SGR codes at the right edge.
	const background = theme.bg("selectedBg", pad(sliceByColumn(line, prefix, width - prefix), width - prefix));
	return `${sliceByColumn(line, 0, prefix)}${background}\x1b[0m`;
}
function paintRosterBlock(lines: string[], row: AgentConversationSummary, selected: boolean, width: number, theme: Theme): string[] {
	return lines.map((line, index) => {
		if (!selected || ((index === 1 || lines.length === 1) && (needsAttention(row) || row.state === "failed"))) return pad(line, width);
		return highlightRow(line, width, index === 0 ? 4 : 2, theme);
	});
}
function rosterRow(
	row: AgentConversationSummary,
	rows: readonly AgentConversationSummary[],
	selected: string | undefined,
	width: number,
	theme: Theme,
	compact: boolean,
	exactTime: boolean,
	now: number,
): { lines: string[]; timeX: number; timeWidth: number; timeLine: number } {
	const appearance = sessionAppearance[row.state];
	const time = dashboardTime(row.modifiedAt, exactTime, now);
	const chosen = row.id === selected;
	const rail = chosen ? theme.fg("accent", "▌ ") : "  ";
	const glyph = theme.fg(appearance.color, `${appearance.glyph} `);
	const exactRow = exactTime && !compact;
	const timeWidth = Math.min(visibleWidth(time), width - 4);
	const timeX = width - timeWidth;
	const titleWidth = compact ? Math.max(8, Math.floor((width - timeWidth - 10) * 0.3)) : Math.max(1, width - 4 - (exactRow ? 0 : timeWidth + 1));
	const title = theme.bold(theme.fg("text", pad(uniqueTitle(row, rows, titleWidth), titleWidth)));
	let lines: string[];
	if (compact) {
		const cost = costOf(row);
		const modelWidth = Math.max(6, Math.floor((width - titleWidth - timeWidth - visibleWidth(cost) - 9) / 2));
		const activityWidth = Math.max(1, width - titleWidth - timeWidth - visibleWidth(cost) - modelWidth - 8);
		lines = [`${rail + glyph + title} ${pad(rosterActivity(row, activityWidth, theme), activityWidth)} ${theme.fg("muted", `${pad(rosterModel(row, modelWidth), modelWidth)} ${cost} ${time}`)}`];
	} else {
		const identity = rail + glyph + title;
		const cost = costOf(row);
		const modelWidth = Math.max(1, width - visibleWidth(cost) - 3);
		lines = [
			exactRow ? identity : pad(identity, timeX) + theme.fg("muted", time),
			rail + rosterActivity(row, width - 2, theme),
			rail + theme.fg("muted", `${pad(rosterModel(row, modelWidth), modelWidth)} ${cost}`),
		];
		if (exactRow) lines.push(rail + theme.fg("muted", pad("", timeX - 2) + time));
	}
	return {
		lines: paintRosterBlock(lines, row, chosen, width, theme),
		timeX, timeWidth, timeLine: exactRow ? 3 : 0,
	};
}
function rosterWindow(
	rows: readonly AgentConversationSummary[],
	selected: string | undefined,
	height: number,
	compact: boolean,
	now: number,
	requested?: number,
	exactTime = false,
): { capacity: number; start: number; maxStart: number } {
	const index = Math.max(
		0,
		rows.findIndex((row) => row.id === selected),
	);
	if (compact) {
		const maxStart = Math.max(0, rows.length - 3);
		return { capacity: 3, maxStart, start: Math.min(maxStart, Math.max(0, requested ?? index - 1)) };
	}
	const capacityAt = (start: number) => {
		let used = 1;
		let capacity = 0;
		let section = "";
		for (const row of rows.slice(start)) {
			const next = sectionOf(row, now);
			const cost = (exactTime ? 4 : 3) + (next !== section ? 1 : 0);
			if (used + cost > height) break;
			used += cost;
			section = next;
			capacity++;
		}
		return Math.max(1, capacity);
	};
	let maxStart = rows.length;
	while (maxStart > 0 && capacityAt(maxStart - 1) >= rows.length - maxStart + 1) maxStart--;
	let start = Math.min(maxStart, Math.max(0, requested ?? index - Math.floor((height - 3) / 6)));
	if (requested === undefined && index >= start + capacityAt(start)) start = Math.min(maxStart, index);
	return { capacity: capacityAt(start), maxStart, start };
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
	const { capacity, start, maxStart } = rosterWindow(rows, selected, height, compact, now, viewport?.start, viewport?.exactTime);
	viewport?.range?.(start, maxStart);
	const lines: string[] = [];
	let section = "";
	for (const row of rows.slice(start, start + capacity)) {
		const group = sectionOf(row, now);
		if (!compact && group !== section) {
			lines.push(theme.fg("muted", `${group} · ${rows.filter((item) => sectionOf(item, now) === group).length}`));
			section = group;
		}
		const block = rosterRow(row, rows, selected, width, theme, compact, viewport?.exactTime ?? false, now);
		rosterHit(viewport, row, block, lines.length, width, height);
		lines.push(...block.lines);
	}
	while (compact && lines.length < 3) lines.push("");
	const shown = rows.slice(start, start + capacity).length;
	const hidden = rows.length - shown;
	const direction = start === 0 ? "↓" : start + shown === rows.length ? "↑" : "↕";
	lines.push(theme.fg("muted", hidden ? `${direction} ${hidden} more` : `${rows.length} loaded`));
	return lines.slice(0, height);
}
