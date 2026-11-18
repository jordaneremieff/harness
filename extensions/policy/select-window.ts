import type { Theme } from "@earendil-works/pi-coding-agent";
import { type SelectItem, SelectList } from "@earendil-works/pi-tui";
import { fitLine } from "./frame.ts";

/** Render a bounded window without letting a wheel turn change the staged or selected item. */
export function selectWindow(options: {
	items: SelectItem[];
	selected: number;
	focused: boolean;
	width: number;
	theme: Theme;
	marker?: boolean;
}): SelectList {
	const { items, selected, focused, width, theme } = options;
	const hasSelection = selected >= 0 && selected < items.length;
	const list = new SelectList(items, Math.max(1, items.length), {
		selectedPrefix: (text) => text,
		selectedText: (text) => {
			// SelectList prefixes every item with two columns. Keep the Policy marker in that space.
			const marker = hasSelection && focused && options.marker !== false ? theme.fg("accent", "›") : " ";
			const line = fitLine(`${marker} ${text.slice(2)}`, width);
			return hasSelection ? theme.bg("selectedBg", line) : line;
		},
		description: (text) => theme.fg("muted", text),
		scrollInfo: (text) => theme.fg("dim", text),
		noMatch: () => theme.fg("dim", "No match"),
	});
	list.setSelectedIndex(selected);
	return list;
}
