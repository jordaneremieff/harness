/**
 * Roster view shared by the agent peer window. It formats the host-published
 * conversation rows with sections, state glyphs, unique titles, search, and
 * coverage. It opens no storage itself; the caller supplies the bounded
 * snapshot the observation sources returned.
 */
import { basename } from "node:path";
import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { Input, matchesKey, truncateToWidth, visibleWidth, type Component, type TUI } from "@earendil-works/pi-tui";
import type { AgentConversationSummary, AgentDashboardCoverage } from "./dashboard-types.ts";
import { cleanDashboardText } from "./dashboard-conversation.ts";

export interface AgentDashboardSnapshot { observedAt: number; sessions: readonly AgentConversationSummary[]; coverage?: AgentDashboardCoverage; error?: string }
type StateAppearance = { label: string; glyph: string; color: ThemeColor };
export const sessionAppearance: Record<AgentConversationSummary["state"], StateAppearance> = {
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
const titleOf = (row: AgentConversationSummary) => oneLine(row.name || row.firstMessage || basename(row.cwd) || row.id);
const pad = (text: string, width: number) => { const clipped = truncateToWidth(text, Math.max(0, width)); return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped))); };
export function elapsed(ms: number): string {
	const seconds = Math.max(0, Math.floor(ms / 1000));
	return seconds < 60 ? `${seconds}s` : seconds < 3600 ? `${Math.floor(seconds / 60)}m${seconds % 60}s` : seconds < 86400 ? `${Math.floor(seconds / 3600)}h${Math.floor(seconds % 3600 / 60)}m` : `${Math.floor(seconds / 86400)}d`;
}
function costOf(row: AgentConversationSummary): string { return `${row.partial ? "≥" : ""}$${row.cost.toFixed(2)}`; }
/** Recovery detail for a held storage; an absent report is not a health verdict. */
function recoveryLines(row: AgentConversationSummary, skipRetry = false): Array<{ color: ThemeColor; text: string }> {
	const health = row.health;
	if (!health) return [];
	const lines: Array<{ color: ThemeColor; text: string }> = [];
	if (health.lastError) lines.push({ color: "error", text: `Last host error: ${oneLine(health.lastError)}` });
	if (health.compactionFailure) {
		const failure = health.compactionFailure;
		lines.push({ color: "warning", text: `Last compaction failure (${failure.reason}) at ${failure.at}: ${oneLine(failure.errorMessage ?? "no error text")}` });
	}
	if (!skipRetry && health.autoRetry) lines.push({ color: "warning", text: `provider retry ${health.autoRetry.attempt}/${health.autoRetry.maxAttempts} after ${elapsed(health.autoRetry.delayMs)}: ${oneLine(health.autoRetry.errorMessage)}` });
	return lines;
}
function healthMark(row: AgentConversationSummary, theme: Theme): string {
	const health = row.health;
	if (!health) return "";
	if (health.lastError) return theme.fg("error", "!");
	if (health.compactionFailure) return theme.fg("warning", "!");
	if (health.autoRetry) return theme.fg("accent", "↻");
	return "";
}
function stateLabel(row: AgentConversationSummary): string {
	const owner = row.owner === "unavailable" ? " · unavailable" : row.owner === "unknown" ? " · stored" : "";
	return `${sessionAppearance[row.state].label}${owner}`;
}
/** Attention means the operator must act; a terminal outcome alone is a record. */
function needsAttention(row: AgentConversationSummary): boolean {
	if (row.owner === "unavailable" || row.state === "unavailable") return true;
	if (row.health?.lastError || row.health?.compactionFailure) return true;
	const retry = row.health?.autoRetry;
	if (retry !== undefined && retry.attempt >= retry.maxAttempts) return true;
	return row.state === "failed" && Boolean(row.error);
}
function sectionOf(row: AgentConversationSummary, now: number): string {
	if (needsAttention(row)) return "Attention";
	if (row.state === "working") return "Working";
	const today = new Date(now); today.setHours(0, 0, 0, 0);
	const yesterday = new Date(today); yesterday.setDate(yesterday.getDate() - 1);
	return row.modifiedAt >= today.getTime() ? "Today" : row.modifiedAt >= yesterday.getTime() ? "Yesterday" : "Earlier";
}
export function dashboardRecords(snapshot: AgentDashboardSnapshot | undefined, filter: string): AgentConversationSummary[] {
	const terms = oneLine(filter).toLocaleLowerCase().split(" ").filter(Boolean);
	const sections = ["Working", "Attention", "Today", "Yesterday", "Earlier"];
	return (snapshot?.sessions ?? []).filter((row) => {
		const text = `${titleOf(row)} ${row.firstMessage ?? ""} ${row.cwd} ${row.id} ${stateLabel(row)} ${row.model?.provider ?? ""} ${row.model?.modelId ?? ""} ${row.model?.thinkingLevel ?? ""}`.toLocaleLowerCase();
		return terms.every((term) => text.includes(term));
	}).sort((a, b) => sections.indexOf(sectionOf(a, snapshot?.observedAt ?? Date.now())) - sections.indexOf(sectionOf(b, snapshot?.observedAt ?? Date.now())) || b.modifiedAt - a.modifiedAt || a.id.localeCompare(b.id));
}
/** Coverage of the returned page; an empty or bounded page is not proof of absence. */
export function coverageText(coverage: AgentDashboardCoverage | undefined): string {
	if (!coverage) return "";
	const parts: string[] = [];
	if (coverage.skipped) parts.push(`${coverage.skipped} store${coverage.skipped === 1 ? "" : "s"} skipped (unknown, not absent)`);
	if (coverage.omitted) parts.push(`${coverage.omitted} row${coverage.omitted === 1 ? "" : "s"} not loaded`);
	if (coverage.nextCursor) parts.push("more inventory to inspect");
	if (!coverage.complete && !coverage.nextCursor) parts.push("coverage incomplete");
	return parts.join(" · ");
}
function totals(snapshot: AgentDashboardSnapshot | undefined): string {
	const rows = snapshot?.sessions ?? [];
	const now = snapshot?.observedAt ?? Date.now();
	const working = rows.filter((row) => sectionOf(row, now) === "Working").length;
	const attention = rows.filter((row) => sectionOf(row, now) === "Attention").length;
	return `${working} working${attention ? ` · ${attention} need attention` : ""} · ${rows.some((row) => row.partial) ? "≥" : ""}$${rows.reduce((sum, row) => sum + row.cost, 0).toFixed(2)} spent`;
}
/** Plain-text roster summary for non-TUI reads and status tests. */
export function dashboardText(snapshot: AgentDashboardSnapshot): string {
	const coverage = coverageText(snapshot.coverage);
	return ["Agent dashboard", totals(snapshot), ...(coverage ? [`Coverage: ${coverage}`] : []), ...(snapshot.error ? [`Store unavailable: ${snapshot.error}`] : []), ...dashboardRecords(snapshot, "").flatMap((row) => [
		oneLine(`${sessionAppearance[row.state].glyph} ${stateLabel(row)} · ${titleOf(row)} · ${basename(row.cwd)} · ${row.model?.modelId ?? "unknown model"} · ${costOf(row)}`),
		`  ${oneLine(row.id)} · ${oneLine(row.cwd)}`,
		...recoveryLines(row).map((line) => `  ${oneLine(line.text)}`),
		...(row.latestReply ? [`  ${oneLine(row.latestReply).slice(0, 300)}`] : []),
	]), "Use /agent help for actions."].join("\n");
}

/** One selectable roster entry; `key` is absent for a section label. */
interface RosterEntry {
	key?: string;
	text?: string;
	row?: AgentConversationSummary;
	primary?: { label: string; detail?: string };
}

export interface AgentRosterOptions {
	tui: Pick<TUI, "requestRender" | "terminal">;
	theme: Theme;
	onSelect(key: string): void;
	onCancel(): void;
	/** Optional pinned first row, for the ordinary primary. */
	primary?: { label: string; detail?: string };
}

/**
 * Roster-only selection surface: filter text at the top, then sections and
 * rows. The caller supplies snapshots; this view reads no source.
 */
export class AgentRoster implements Component {
	private readonly options: AgentRosterOptions;
	private readonly input = new Input({ prompt: "Find › " });
	private snapshot?: AgentDashboardSnapshot;
	selectedKey?: string;
	private focusedFlag = false;

	constructor(options: AgentRosterOptions) {
		this.options = options;
		this.input.onSubmit = () => this.selectCurrent();
		this.input.onEscape = () => this.cancel();
	}

	setSnapshot(snapshot?: AgentDashboardSnapshot): void {
		this.snapshot = snapshot;
		const rows = this.rows();
		if (this.selectedKey === undefined) {
			this.selectedKey = this.options.primary ? "primary" : rows[0]?.id;
			return;
		}
		if (this.selectedKey === "primary") return;
		if (rows.some((row) => row.id === this.selectedKey)) return;
		this.selectedKey = this.fallbackKey();
		this.redraw();
	}

	get focused(): boolean {
		return this.focusedFlag;
	}
	set focused(value: boolean) {
		this.focusedFlag = value;
		this.input.focused = value;
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape")) {
			this.cancel();
			return;
		}
		if (matchesKey(data, "up") || matchesKey(data, "down")) {
			this.move(matchesKey(data, "up") ? -1 : 1);
			return;
		}
		this.input.handleInput(data);
		this.reconcileSelection();
		this.redraw();
	}

	/** Visible rows for the current filter. */
	rows(): AgentConversationSummary[] {
		return dashboardRecords(this.snapshot, this.input.getValue());
	}

	private cancel(): void {
		if (this.input.getValue() !== "") {
			this.input.setValue("");
			this.reconcileSelection();
			this.redraw();
			return;
		}
		this.options.onCancel();
	}

	private move(delta: number): void {
		const keys = this.entries().filter((entry) => entry.key !== undefined).map((entry) => entry.key);
		const index = keys.indexOf(this.selectedKey);
		const next = Math.max(0, Math.min(keys.length - 1, index + delta));
		if (keys[next] !== undefined) this.selectedKey = keys[next];
		this.redraw();
	}

	private selectCurrent(): void {
		if (this.selectedKey !== undefined) this.options.onSelect(this.selectedKey);
	}

	private reconcileSelection(): void {
		if (this.selectedKey === "primary") return;
		const rows = this.rows();
		if (this.selectedKey && rows.some((row) => row.id === this.selectedKey)) return;
		this.selectedKey = this.fallbackKey();
	}

	private redraw(): void {
		this.options.tui.requestRender();
	}

	private entries(): RosterEntry[] {
		const entries: RosterEntry[] = [];
		if (this.options.primary) entries.push({ key: "primary", primary: this.options.primary });
		let section = "";
		for (const row of this.rows()) {
			const next = sectionOf(row, this.snapshot?.observedAt ?? Date.now());
			if (next !== section) { section = next; entries.push({ text: next }); }
			entries.push({ key: row.id, row });
		}
		return entries;
	}

	private fallbackKey(): string | undefined {
		return this.rows()[0]?.id ?? (this.options.primary ? "primary" : undefined);
	}

	/** Distinct visible titles for duplicate names, resolved by a short ID suffix. */
	private titles(width: number): Map<string, string> {
		const groups = new Map<string, AgentConversationSummary[]>();
		for (const row of this.snapshot?.sessions ?? []) {
			const key = truncateToWidth(titleOf(row), width);
			const group = groups.get(key) ?? []; group.push(row); groups.set(key, group);
		}
		const titles = new Map<string, string>();
		for (const group of groups.values()) {
			if (group.length < 2) continue;
			for (const row of group) {
				let length = Math.min(6, row.id.length);
				while (length < row.id.length && group.some((other) => other.id !== row.id && other.id.slice(-length) === row.id.slice(-length))) length++;
				const suffix = row.id.slice(-length);
				const title = truncateToWidth(titleOf(row), Math.max(0, width - 1 - visibleWidth(suffix)));
				titles.set(row.id, `${title} ${suffix}`.trimStart());
			}
		}
		return titles;
	}

	private primaryRow(entry: RosterEntry, width: number): string {
		const selected = entry.key === this.selectedKey;
		const detail = entry.primary?.detail ? `  ${entry.primary.detail}` : "";
		const labelWidth = Math.max(0, width - 2 - visibleWidth(detail));
		const line = `${selected ? "›" : " "}${this.options.theme.fg("accent", truncateToWidth(`▌ ${entry.primary?.label ?? "Primary"}`, labelWidth))}${this.options.theme.fg("muted", detail)}`;
		const fitted = pad(line, width);
		return selected ? this.options.theme.bg("selectedBg", fitted) : fitted;
	}

	private rowLine(row: AgentConversationSummary, width: number, title: string): string {
		const selected = row.id === this.selectedKey;
		const appearance = sessionAppearance[row.state];
		const mark = healthMark(row, this.options.theme);
		const line = `${selected ? "›" : " "}${this.options.theme.fg(appearance.color, appearance.glyph)} ${pad(title, Math.max(0, width - 3 - visibleWidth(mark)))}${mark}`;
		return selected ? this.options.theme.bg("selectedBg", line) : line;
	}

	private header(rows: readonly AgentConversationSummary[], start: number, pageSize: number, total: number, width: number): string {
		const filter = this.input.getValue() !== "" ? `${rows.length} of ${this.snapshot?.sessions.length ?? 0} · ${oneLine(this.input.getValue())}` : `${rows.length} ${rows.length === 1 ? "session" : "sessions"}`;
		const coverage = coverageText(this.snapshot?.coverage);
		const markers = `${start > 0 ? " · ↑" : ""}${start + pageSize < total ? " · ↓" : ""}`;
		const line = [filter, coverage].filter(Boolean).join(" · ") + markers;
		return pad(this.options.theme.fg("dim", truncateToWidth(line, width)), width);
	}

	render(width: number, height: number = this.options.tui.terminal.rows): string[] {
		width = Math.max(1, Math.floor(width));
		height = Math.max(0, Math.floor(height));
		if (height === 0) return [];
		const entries = this.entries();
		const selectedIndex = Math.max(0, entries.findIndex((entry) => entry.key !== undefined && entry.key === this.selectedKey));
		const chrome = this.options.primary || this.snapshot ? 2 : 1;
		const pageSize = Math.max(1, height - chrome);
		const start = Math.min(Math.max(0, entries.length - pageSize), Math.max(0, selectedIndex - Math.floor(pageSize / 2)));
		const titles = this.titles(width - 4);
		const lines: string[] = [];
		if (height >= 1) lines.push(...this.input.render(width));
		if (height >= 2) lines.push(this.header(this.rows(), start, pageSize, entries.length, width));
		for (const entry of entries.slice(start, start + pageSize)) {
			if (entry.key === undefined) { lines.push(pad(this.options.theme.fg("accent", truncateToWidth(` ${entry.text ?? ""}`, width)), width)); continue; }
			if (entry.primary) lines.push(this.primaryRow(entry, width));
			else if (entry.row) lines.push(this.rowLine(entry.row, width, titles.get(entry.row.id) ?? titleOf(entry.row)));
		}
		while (lines.length < height) lines.push(" ".repeat(width));
		return lines.slice(0, height);
	}

	invalidate(): void {
		this.input.invalidate();
	}
}
