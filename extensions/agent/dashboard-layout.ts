import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
export function fitLine(text: string, width: number): string {
	const value = truncateToWidth(text, Math.max(1, width));
	return value + " ".repeat(Math.max(0, width - visibleWidth(value)));
}
/** Remove optional hints from the right, but always retain the escape destination. */
export function fitHints(items: readonly string[], backHint: string, width: number): string {
	const kept = [...items];
	while (kept.length && visibleWidth([...kept, backHint].join(" · ")) > width) kept.pop();
	return fitLine([...kept, backHint].join(" · "), width);
}
export function dashboardGeometry(
	width: number,
	height: number,
	editorRows: number,
	console = false,
	reservedRows = 0,
) {
	const wide = width >= 110 && !console;
	const rosterHeight = console || wide ? 0 : 5;
	const bodyHeight = Math.max(0, height - 6 - editorRows - rosterHeight - reservedRows);
	return {
		wide,
		rosterWidth: wide ? 38 : width,
		conversationWidth: wide ? width - 39 : width,
		rosterHeight,
		bodyHeight,
		supported: width >= 60 && height >= 20,
	};
}
