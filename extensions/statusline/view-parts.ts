import type { Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, SelectList, type SelectItem, type TuiMouseEvent, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { fitLine, type KeyHint, listCapacity, listTheme } from "./frame.ts";

export const CHOOSE: KeyHint = { keys: ["up", "down"], label: "choose" };
export const PAGE: KeyHint = { keys: ["pageUp", "pageDown"], label: "page" };
export const SCROLL: KeyHint = { keys: ["up", "down"], label: "scroll" };

export function wrap(text: string, width: number): string[] {
	return text.split("\n").flatMap((line) => (line ? wrapTextWithAnsi(line, Math.max(1, width)) : [""]));
}

/** SelectList with a viewport local to a view, and no effect on selection. */
export class Choices {
	private items: SelectItem[] = [];
	private list: SelectList;
	private rows = 0;
	private active = true;
	private selected?: string;

	private readonly theme: Theme;
	private readonly changed: (value: string) => void;

	constructor(theme: Theme, changed: (value: string) => void = () => {}) {
		this.theme = theme;
		this.changed = changed;
		this.list = new SelectList([], 1, listTheme(theme));
	}

	set(items: SelectItem[], selected: string | undefined = this.selected): void {
		const same =
			this.items.length === items.length &&
			this.items.every((old, i) => {
				const next = items[i];
				return old.value === next.value && old.label === next.label && old.description === next.description;
			});
		if (!same) this.items = items;
		if (same && this.selected === selected) return;
		this.selected = this.items.find((item) => item.value === selected)?.value ?? this.items[0]?.value;
		this.rebuild();
	}

	private rebuild(): void {
		this.list = new SelectList(
			this.items,
			listCapacity(this.items.length, Math.max(1, this.rows)),
			listTheme(this.theme, this.active),
		);
		this.list.setSelectedIndex(this.items.findIndex((item) => item.value === this.selected));
		this.list.onSelectionChange = (item) => {
			this.selected = item.value;
			this.changed(item.value);
		};
	}

	render(width: number, rows: number, active: boolean): string[] {
		if (rows !== this.rows || active !== this.active) {
			this.rows = rows;
			this.active = active;
			this.rebuild();
		}
		return this.list.render(width).slice(0, rows);
	}

	handleInput(data: string): void {
		if (!this.items.length) return;
		if (matchesKey(data, "home")) this.selectEdge(0);
		else if (matchesKey(data, "end")) this.selectEdge(this.items.length - 1);
		else if (!this.atBoundary(data)) this.list.handleInput(data);
	}

	private atBoundary(data: string): boolean {
		return (
			(matchesKey(data, "up") && this.items[0]?.value === this.selected) ||
			(matchesKey(data, "down") && this.items.at(-1)?.value === this.selected)
		);
	}

	private selectEdge(index: number): void {
		const item = this.items[index];
		if (!item || item.value === this.selected) return;
		this.list.setSelectedIndex(index);
		this.list.onSelectionChange?.(item);
	}

	handleMouse(event: TuiMouseEvent) {
		return this.list.handleMouse(event);
	}
}

/** Read wrapped text without depending on Pi's root layout for a viewport. */
export class Reader {
	private offset = 0;
	private height = 1;
	private total = 0;

	reset(): void {
		this.offset = 0;
	}

	private scroll(delta: number): void {
		this.offset = Math.max(0, Math.min(Math.max(0, this.total - this.height), this.offset + delta));
	}

	render(text: string, width: number, height: number, theme: Theme): string[] {
		const contentWidth = width > 8 ? width - 1 : width;
		const lines = wrap(text, contentWidth);
		this.height = height;
		this.total = lines.length;
		this.scroll(0);
		const range = this.total - height;
		const thumb = range > 0 ? Math.max(1, Math.round((height * height) / this.total)) : 0;
		const top = range > 0 ? Math.round(((height - thumb) * this.offset) / range) : 0;
		return Array.from({ length: height }, (_, row) => {
			const line = fitLine(lines[this.offset + row] ?? "", contentWidth);
			if (width <= 8) return line;
			const inside = row >= top && row < top + thumb;
			const bar = !thumb ? " " : inside ? theme.fg("scrollbarThumb", "┃") : theme.fg("scrollbarTrack", "│");
			return line + bar;
		});
	}

	handleInput(data: string, arrows = true): boolean {
		const page = Math.max(1, this.height - 1);
		if (matchesKey(data, "pageUp")) this.scroll(-page);
		else if (matchesKey(data, "pageDown")) this.scroll(page);
		else if (arrows && matchesKey(data, "up")) this.scroll(-1);
		else if (arrows && matchesKey(data, "down")) this.scroll(1);
		else if (arrows && matchesKey(data, "home")) this.reset();
		else if (arrows && matchesKey(data, "end")) this.scroll(this.total);
		else return false;
		return true;
	}

	handleMouse(event: TuiMouseEvent) {
		if (event.type !== "wheel" || !event.wheelDelta) return undefined;
		this.scroll(Math.trunc(event.wheelDelta));
		return { handled: true };
	}
}
