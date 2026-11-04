/**
 * Session controls behind the footer menu: a model selector over the public model registry
 * and a reasoning selector over the current model's supported levels. Each is a small
 * overlay with Apply and Cancel; Apply reaches the public session API, Cancel changes nothing.
 * The component reads its row budget on every render.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import { SelectList, matchesKey, truncateToWidth, visibleWidth, type Component, type SelectListTheme, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";

export interface ChoiceItem {
	value: string;
	label: string;
	description?: string;
}

export interface ChoicePanelOptions {
	title: string;
	/** One line under the title: the current value or why the choice is limited. */
	hint: string;
	items: readonly ChoiceItem[];
	selected?: string;
	theme: Theme;
	rows: () => number;
	done: (value: string | undefined) => void;
}

const MIN_WIDTH = 24;
const MIN_ROWS = 6;

function selectTheme(theme: Theme): SelectListTheme {
	return {
		selectedPrefix: (text) => theme.fg("accent", text),
		selectedText: (text) => theme.fg("accent", text),
		description: (text) => theme.fg("dim", text),
		scrollInfo: (text) => theme.fg("dim", text),
		noMatch: (text) => theme.fg("dim", text),
	};
}

/**
 * A list with Apply and Cancel. Enter or Apply resolves with the highlighted value; Escape,
 * Cancel and ctrl+c resolve with undefined. Hit geometry is rebuilt on every render and
 * ignored when the event width differs from the rendered width.
 */
export class ChoicePanel implements Component {
	readonly capturesViewportInput = true;
	private readonly options: ChoicePanelOptions;
	private list!: SelectList;
	private height = 0;
	private renderedWidth = -1;
	private regions: Array<{ y: number; height: number; component?: Component; buttons?: Array<{ x: number; width: number; action: () => void }> }> = [];
	private closed = false;

	constructor(options: ChoicePanelOptions) {
		this.options = options;
		this.rebuild();
	}

	private listRows(): number {
		return Math.max(2, Math.min(16, this.options.rows() - 4));
	}

	private rebuild(): void {
		const current = this.list?.getSelectedItem()?.value ?? this.options.selected;
		this.height = this.listRows();
		this.list = new SelectList(this.options.items.map((item) => ({ value: item.value, label: item.label, description: item.description ?? "" })), this.height, selectTheme(this.options.theme));
		const index = this.options.items.findIndex((item) => item.value === current);
		if (index >= 0) this.list.setSelectedIndex(index);
		this.list.onSelect = (item) => this.finish(item.value);
		this.list.onCancel = () => this.finish(undefined);
		this.regions = [];
	}

	private finish(value: string | undefined): void {
		if (this.closed) return;
		this.closed = true;
		this.regions = [];
		this.options.done(value);
	}

	close(): void { this.finish(undefined); }
	dispose(): void { this.closed = true; this.regions = []; }
	invalidate(): void { this.regions = []; this.renderedWidth = -1; this.list.invalidate(); }

	handleInput(data: string): void {
		if (this.closed) return;
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) { this.finish(undefined); return; }
		this.list.handleInput(data);
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (this.closed || event.width !== this.renderedWidth) return undefined;
		const region = this.regions.find((candidate) => event.y >= candidate.y && event.y < candidate.y + candidate.height);
		if (!region) return undefined;
		if (region.buttons) {
			if (event.type !== "click" || event.button !== "left") return undefined;
			const button = region.buttons.find((candidate) => event.x >= candidate.x && event.x < candidate.x + candidate.width);
			if (!button) return undefined;
			button.action();
			return { handled: true };
		}
		if (!region.component?.handleMouse) return undefined;
		const result = region.component.handleMouse({ ...event, y: event.y - region.y, height: region.height });
		return result ? { handled: true, render: result.render } : undefined;
	}

	render(width: number): string[] {
		this.regions = [];
		this.renderedWidth = width;
		if (this.closed) return [];
		const rows = this.options.rows();
		if (width < MIN_WIDTH || rows < MIN_ROWS) return [truncateToWidth(`Terminal too small for ${this.options.title}. Escape closes.`, width)];
		if (this.height !== this.listRows()) this.rebuild();
		const lines: string[] = [truncateToWidth(this.options.theme.bold(this.options.title), width), truncateToWidth(this.options.theme.fg("dim", this.options.hint), width)];
		const listLines = this.list.render(width);
		this.regions.push({ y: lines.length, height: listLines.length, component: this.list });
		lines.push(...listLines);
		let x = 0;
		const hits: Array<{ x: number; width: number; action: () => void }> = [];
		let row = "";
		for (const [label, action] of [["Apply", () => this.finish(this.list.getSelectedItem()?.value ?? undefined)], ["Cancel", () => this.finish(undefined)]] as const) {
			const cell = `[${label}]`;
			hits.push({ x, width: visibleWidth(cell), action });
			row += `${this.options.theme.fg("accent", cell)}  `;
			x += visibleWidth(cell) + 2;
		}
		this.regions.push({ y: lines.length, height: 1, buttons: hits });
		lines.push(truncateToWidth(row, width));
		return lines.slice(0, rows);
	}
}
