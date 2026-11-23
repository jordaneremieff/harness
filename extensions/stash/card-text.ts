import type { KeybindingHints, Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { homedir } from "node:os";
import { stripVTControlCharacters } from "node:util";

export const safe = (value: string) =>
	stripVTControlCharacters(value).replace(/[\p{Cc}\p{Cf}]/gu, (character) =>
		character === "\n" || character === "\t" || character === "\u200d" ? character : "",
	);
export const oneLine = (value: string) => safe(value).replace(/\s+/gu, " ").trim();
export const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

export function record(value: unknown): Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export function pathLabel(path: string): string {
	const home = homedir();
	return path === home || path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

export function clipRow(line: string, width: number): string {
	return truncateToWidth(line, Math.max(0, width), "…").replace(
		/\x1b\[0m…\x1b\[0m$/u,
		"…\x1b[22;23;24;25;27;28;29;39m",
	);
}

export function wrapBody(text: string, width: number): string[] {
	if (!text || width < 1) return [];
	return text
		.replace(/\t/gu, "   ")
		.split("\n")
		.flatMap((row) => wrapTextWithAnsi(row, width));
}

export function expansionHint(theme: Theme, keys: Partial<KeybindingHints>, hidden?: number, clickable = true): string {
	const key = keys.keyText?.("app.tools.expand");
	if (!key && !clickable) return "";
	const action = key
		? (keys.keyHint?.("app.tools.expand", "to expand") ?? theme.fg("dim", key) + theme.fg("muted", " to expand"))
		: theme.fg("muted", "click to expand");
	return (
		theme.fg("muted", `... (${hidden ? `${plural(hidden, "more line", "more lines")}, ` : ""}`) +
		action +
		theme.fg("muted", ")")
	);
}

export const clipsRow = (line: string, width: number) => visibleWidth(line) > width;
