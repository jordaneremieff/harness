import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { DashboardLayout } from "./dashboard-state.ts";
type Paint = Pick<Theme, "fg" | "bg" | "bold">;
export const MIN_ROSTER_COLUMNS = 24;
export const MIN_DETAIL_COLUMNS = 60;
export const MIN_COMPOSER_ROWS = 5;
export const MIN_TRANSCRIPT_ROWS = 6;
export function clamp(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, Math.round(value)));
}
export function fitLine(text: string, width: number): string {
	const value = truncateToWidth(text, Math.max(1, width));
	return value + " ".repeat(Math.max(0, width - visibleWidth(value)));
}
export function dashboardHeading(title: string, position: string, width: number, theme: Paint, bottom = false): string {
	const right = position ? ` ${position.replace(/\s+/g, " ").trim()} ` : "";
	const label = title ? ` ${truncateToWidth(title.replace(/\s+/g, " ").trim(), Math.max(1, width - visibleWidth(right) - 6))} ` : "";
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
	const text = label ? `─ ${truncateToWidth(label, Math.max(1, width - 4))} ` : "";
	return fitLine(
		theme.fg("muted", text) + theme.fg("borderMuted", "─".repeat(Math.max(0, width - visibleWidth(text)))),
		width,
	);
}
export function dashboardSelection(text: string, width: number, selected: boolean, theme: Paint): string {
	return selected ? theme.bg("selectedBg", fitLine(theme.fg("text", theme.bold(text)), width)) : text;
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
	const rosterHeight = console || wide ? 0 : 4;
	const ratio = layout.rosterRatio;
	const rosterWidth = wide
		? typeof ratio === "number" && Number.isFinite(ratio) && ratio > 0 && ratio < 1
			? clamp(ratio * (width - 1), MIN_ROSTER_COLUMNS, width - 1 - MIN_DETAIL_COLUMNS)
			: Math.min(40, Math.max(30, Math.floor(width * 0.22)))
		: width;
	const paneHeight = Math.max(0, height - 2 - rosterHeight - reservedRows);
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
