import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
type Paint = Pick<Theme, "fg" | "bg" | "bold">;
export function fitLine(text: string, width: number): string {
	const value = truncateToWidth(text, Math.max(1, width));
	return value + " ".repeat(Math.max(0, width - visibleWidth(value)));
}
export function dashboardHeading(title: string, position: string, width: number, theme: Paint, bottom = false): string {
	const right = position ? ` ${position} ` : "";
	const label = truncateToWidth(title.replace(/\s+/g, " ").trim(), Math.max(1, width - visibleWidth(right) - 6));
	const fill = "─".repeat(Math.max(0, width - visibleWidth(label) - visibleWidth(right) - 5));
	return fitLine(
		theme.fg("borderMuted", bottom ? "╰─ " : "╭─ ") +
			theme.bold(theme.fg("accent", label)) +
			theme.fg("borderMuted", ` ${fill}`) +
			theme.fg("muted", right) +
			theme.fg("borderMuted", bottom ? "╯" : "╮"),
		width,
	);
}
export function dashboardRule(label: string, width: number, theme: Paint): string {
	const text = `─ ${truncateToWidth(label, Math.max(1, width - 4))} `;
	return fitLine(
		theme.fg("muted", text) + theme.fg("borderMuted", "─".repeat(Math.max(0, width - visibleWidth(text)))),
		width,
	);
}
export function dashboardSelection(text: string, width: number, selected: boolean, theme: Paint): string {
	return selected ? theme.bg("selectedBg", fitLine(theme.fg("accent", theme.bold(text)), width)) : text;
}
function paintHint(hint: string, theme: Paint): string {
	const split = hint.indexOf(" ");
	return split < 0
		? theme.fg("accent", hint)
		: theme.bold(theme.fg("accent", hint.slice(0, split))) + theme.fg("muted", hint.slice(split));
}
/** Remove optional hints from the right, but always retain the escape destination. */
export function fitHints(
	items: readonly string[],
	backHint: string,
	width: number,
	onHint?: (hint: string, x: number, width: number) => void,
	theme?: Paint,
): string {
	const kept = [...items];
	while (kept.length && visibleWidth([...kept, backHint].join(" · ")) > width) kept.pop();
	let x = 0;
	for (const hint of [...kept, backHint]) {
		const size = visibleWidth(hint);
		if (x < width) onHint?.(hint, x, Math.min(size, width - x));
		x += size + 3;
	}
	const shown = [...kept, backHint];
	if (!theme) return fitLine(shown.join(" · "), width);
	return theme.bg(
		"customMessageBg",
		fitLine(shown.map((hint) => paintHint(hint, theme)).join(theme.fg("dim", " · ")), width),
	);
}
export function dashboardGeometry(
	width: number,
	height: number,
	editorRows: number,
	console = false,
	reservedRows = 0,
	statusRows = 2,
) {
	const wide = width >= 110 && !console;
	const rosterHeight = console || wide ? 0 : 5;
	const bodyHeight = Math.max(0, height - 4 - statusRows - editorRows - rosterHeight - reservedRows);
	return {
		wide,
		rosterWidth: wide ? 38 : width,
		conversationWidth: wide ? width - 39 : width,
		rosterHeight,
		bodyHeight,
		supported: width >= 60 && height >= 20,
	};
}
