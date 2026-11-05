import { sliceByColumn, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import type { DashboardLayout } from "./dashboard-state.ts";
type Paint = Pick<Theme, "fg" | "bg" | "bold">;
export const MIN_ROSTER_COLUMNS = 32;
export const MAX_ROSTER_COLUMNS = 60;
/** The list's share of the window width before a saved divider position applies. */
export const ROSTER_SHARE = 0.27;
export const MIN_DETAIL_COLUMNS = 60;
export const MIN_COMPOSER_ROWS = 5;
export const MIN_TRANSCRIPT_ROWS = 6;
/** Widest readable text column in the agent views. */
export const READING_TEXT_MAX_COLUMNS = 100;
/**
 * Body text column of a pane: two plain margin columns, then text up to the readable maximum.
 * The pane's last column stays free for the scrollbar; unused space stays on the right.
 */
export function readingGeometry(paneWidth: number): { margin: number; textWidth: number } {
	const margin = 2;
	return { margin, textWidth: Math.max(1, Math.min(READING_TEXT_MAX_COLUMNS, paneWidth - margin - 1)) };
}
export function clamp(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, Math.round(value)));
}
export function fitLine(text: string, width: number): string {
	const value = truncateToWidth(text, Math.max(1, width), "…");
	return value + " ".repeat(Math.max(0, width - visibleWidth(value)));
}
export function dashboardHeading(title: string, position: string, width: number, theme: Paint, bottom = false): string {
	const right = position ? ` ${position.replace(/\s+/g, " ").trim()} ` : "";
	const label = title ? ` ${truncateToWidth(title.replace(/\s+/g, " ").trim(), Math.max(1, width - visibleWidth(right) - 6), "…")} ` : "";
	const fill = "─".repeat(Math.max(0, width - visibleWidth(label) - visibleWidth(right) - 3));
	return fitLine(
		theme.fg("borderMuted", bottom ? "╰─" : "╭─") +
			theme.bold(theme.fg("accent", label)) +
			theme.fg("borderMuted", fill) +
			theme.fg("muted", right) +
			theme.fg("borderMuted", bottom ? "╯" : "╮"),
		width,
	);
}
export function dashboardRule(label: string, width: number, theme: Paint): string {
	const text = label ? `─ ${truncateToWidth(label, Math.max(1, width - 4), "…")} ` : "";
	return fitLine(
		theme.fg("muted", text) + theme.fg("borderMuted", "─".repeat(Math.max(0, width - visibleWidth(text)))),
		width,
	);
}
export function dashboardSelection(text: string, width: number, selected: boolean, theme: Paint): string {
	return selected ? theme.bg("selectedBg", fitLine(theme.fg("text", theme.bold(text)), width)) : text;
}

/** The selection background from `prefix` to the right edge; the rail and glyph columns keep the pane colour. */
export function highlightRow(line: string, width: number, prefix: number, theme: Paint): string {
	// Column slices can omit closing SGR codes at the right edge.
	const background = theme.bg("selectedBg", fitLine(sliceByColumn(line, prefix, width - prefix), width - prefix));
	return `${sliceByColumn(line, 0, prefix)}${background}\x1b[0m`;
}

/** One list item in the Agents, Threads and Efforts lists. */
export interface ListItem {
	readonly title: string;
	readonly glyph: string;
	readonly glyphColor: ThemeColor;
	readonly titleColor?: ThemeColor;
	/** The muted second fact line, already plain text. */
	readonly detail: string;
	readonly detailColor?: ThemeColor;
	/** A time at the right of the title row, or of the detail row when `timeOnDetail` is set for a long date. */
	readonly time?: string;
	readonly timeOnDetail?: boolean;
	readonly selected: boolean;
}

/** Rows of one list item, with the row that holds the time. */
export interface ListBlock {
	readonly lines: string[];
	readonly timeLine: number;
	readonly timeX: number;
	readonly timeWidth: number;
}

/** Rows per list item in every dashboard list: title, detail, then a gap or the title's second row. */
export const LIST_BLOCK_ROWS = 3;

/**
 * One list item in three rows. A title that fits takes one row, then the detail, then a blank gap row.
 * A longer title wraps into the gap row instead, so the list shows the identifying words before any
 * metadata. The selection rail and background cover the content rows only.
 */
export function listBlock(item: ListItem, width: number, theme: Paint): ListBlock {
	const rail = item.selected ? theme.fg("accent", "▌ ") : "  ";
	const time = item.time ?? "";
	const timeWidth = time ? Math.min(visibleWidth(time), Math.max(0, width - 6)) : 0;
	const onTitle = timeWidth > 0 && !item.timeOnDetail;
	const onDetail = timeWidth > 0 && item.timeOnDetail === true;
	const stamp = theme.fg("muted", truncateToWidth(time, timeWidth, ""));
	const [first, rest] = splitTitle(item.title, Math.max(1, width - 4 - (onTitle ? timeWidth + 1 : 0)), Math.max(1, width - 4));
	const paint = (text: string) => theme.bold(theme.fg(item.titleColor ?? "text", text));
	const titleRow = `${rail}${theme.fg(item.glyphColor, `${item.glyph} `)}${paint(first)}`;
	const lines = [onTitle ? `${fitLine(titleRow, width - timeWidth)}${stamp}` : titleRow];
	if (rest) lines.push(`${rail}  ${paint(rest)}`);
	const detail = `${rail}  ${theme.fg(item.detailColor ?? "muted", truncateToWidth(item.detail, Math.max(1, width - 4 - (onDetail ? timeWidth + 1 : 0)), "…"))}`;
	const timeLine = onDetail ? lines.length : 0;
	lines.push(onDetail ? `${fitLine(detail, width - timeWidth)}${stamp}` : detail);
	if (lines.length < LIST_BLOCK_ROWS) lines.push("");
	const painted = lines.map((line) => (item.selected && line ? highlightRow(line, width, 4, theme) : fitLine(line, width)));
	return { lines: painted, timeLine, timeX: width - timeWidth, timeWidth };
}

/** A title's first row at `firstRoom` columns and the rest on one row of `restRoom` columns, shortened with … when longer. */
function splitTitle(text: string, firstRoom: number, restRoom: number): [string, string] {
	const title = text.replace(/\s+/gu, " ").trim();
	const first = wrapTextWithAnsi(title, firstRoom)[0] ?? "";
	return [first, title.length > first.length ? truncateToWidth(title.slice(first.length).trim(), restRoom, "…") : ""];
}
export function dashboardPaneGeometry(paneHeight: number, headerRows: number, editorRows: number) {
	return {
		composerMaxRows: Math.max(0, paneHeight - headerRows - 2 - MIN_TRANSCRIPT_ROWS),
		bodyHeight: Math.max(0, paneHeight - headerRows - editorRows),
	};
}
export function dashboardGeometry(
	width: number,
	height: number,
	editorRows: number,
	console = false,
	reservedRows = 0,
	headerRows = 4,
	layout: DashboardLayout = {},
) {
	const wide = width >= 100 && !console;
	const rosterHeight = console || wide || height < 20 ? 0 : height >= 24 ? 8 : 5;
	const ratio = layout.rosterRatio;
	const rosterWidth = wide
		? typeof ratio === "number" && Number.isFinite(ratio) && ratio > 0 && ratio < 1
			? clamp(ratio * (width - 1), MIN_ROSTER_COLUMNS, Math.min(MAX_ROSTER_COLUMNS, width - 1 - MIN_DETAIL_COLUMNS))
			: clamp(Math.floor(width * ROSTER_SHARE), MIN_ROSTER_COLUMNS, Math.min(MAX_ROSTER_COLUMNS, width - 1 - MIN_DETAIL_COLUMNS))
		: width;
	const paneHeight = Math.max(0, height - 1 - rosterHeight - reservedRows);
	return {
		wide,
		rosterWidth,
		conversationWidth: wide ? width - rosterWidth - 1 : width,
		rosterHeight,
		paneHeight,
		...dashboardPaneGeometry(paneHeight, headerRows, editorRows),
		supported: width >= 60 && height >= 20,
	};
}
