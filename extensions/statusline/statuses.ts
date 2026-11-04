/**
 * Read-only reader for the complete extension status map.
 *
 * The footer shows one cell per status and sheds cells from the right behind a
 * `+N` count when space runs out. This reader shows every current entry with
 * its owner key as the label and its value as opaque text: terminal sequences
 * removed, control characters spaced, nothing parsed. Refresh re-reads the map
 * from the host; there is no timer or event subscription of its own.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	matchesKey,
	replaceControlCharacters,
	stripTerminalSequences,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
	type Component,
	type TuiMouseEvent,
	type TuiMouseEventResult,
} from "@earendil-works/pi-tui";

export interface StatusEntry {
	key: string;
	value: string;
}

/** Opaque reader text for one status field; keys and values use the same rule. */
export function statusText(text: string): string {
	return replaceControlCharacters(stripTerminalSequences(text)).replace(/ +/g, " ").trim();
}

/** Every current entry in map order, with empty values shown as such. */
export function statusEntries(statuses: ReadonlyMap<string, string>): StatusEntry[] {
	return [...statuses].map(([key, value]) => ({ key: statusText(key) || "(unnamed)", value: statusText(value) || "(empty)" }));
}

export interface StatusPanelOptions {
	theme: Theme;
	/** Rows the overlay can show right now; read on every render. */
	rows: () => number;
	read: () => ReadonlyMap<string, string>;
	done: () => void;
}

interface Button {
	x: number;
	width: number;
	action: () => void;
}

/**
 * Scrollable reader with Close and Refresh controls. Hit geometry is rebuilt
 * on every render and ignored for events whose width differs from the
 * rendered width.
 */
export class StatusPanel implements Component {
	readonly capturesViewportInput = true;
	private readonly theme: Theme;
	private readonly rows: () => number;
	private readonly read: () => ReadonlyMap<string, string>;
	private readonly done: () => void;
	private entries: StatusEntry[];
	private lines: string[] = [];
	private renderedWidth = -1;
	private offset = 0;
	private buttons: Button[] = [];
	private buttonRow = -1;
	private closed = false;

	constructor(options: StatusPanelOptions) {
		this.theme = options.theme;
		this.rows = options.rows;
		this.read = options.read;
		this.done = options.done;
		this.entries = statusEntries(options.read());
	}

	/** Heading, controls and the position line are reserved before the scrollable body. */
	private bodyHeight(): number {
		return Math.max(2, Math.min(this.rows() - 3, 40));
	}

	private scroll(delta: number): void {
		const max = Math.max(0, this.lines.length - this.bodyHeight());
		this.offset = Math.max(0, Math.min(max, this.offset + delta));
	}

	refresh(): void {
		this.entries = statusEntries(this.read());
		this.renderedWidth = -1;
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		this.buttons = [];
		this.done();
	}

	dispose(): void {
		this.closed = true;
		this.buttons = [];
	}

	invalidate(): void {
		this.renderedWidth = -1;
		this.buttons = [];
	}

	handleInput(data: string): void {
		if (this.closed) return;
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c") || matchesKey(data, "enter")) this.close();
		else if (data === "r") this.refresh();
		else if (matchesKey(data, "down")) this.scroll(1);
		else if (matchesKey(data, "up")) this.scroll(-1);
		else if (matchesKey(data, "pageDown")) this.scroll(this.bodyHeight());
		else if (matchesKey(data, "pageUp")) this.scroll(-this.bodyHeight());
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (this.closed || event.width !== this.renderedWidth) return undefined;
		if (event.type === "wheel") {
			this.scroll(event.wheelDelta ?? 0);
			return { handled: true };
		}
		if (event.type !== "click" || event.button !== "left" || event.y !== this.buttonRow) return undefined;
		const button = this.buttons.find((candidate) => event.x >= candidate.x && event.x < candidate.x + candidate.width);
		if (!button) return undefined;
		button.action();
		return { handled: true };
	}

	private layout(width: number): void {
		if (this.renderedWidth === width) return;
		const lines: string[] = [];
		for (const entry of this.entries) {
			lines.push(this.theme.fg("accent", truncateToWidth(entry.key, width)));
			for (const line of wrapTextWithAnsi(entry.value, Math.max(1, width - 2))) lines.push(`  ${line}`);
		}
		if (lines.length === 0) lines.push(this.theme.fg("dim", "No extension statuses."));
		this.lines = lines;
		this.renderedWidth = width;
		this.scroll(0);
	}

	render(width: number): string[] {
		this.buttons = [];
		if (this.closed) return [];
		this.layout(width);
		const out: string[] = [];
		out.push(truncateToWidth(`${this.theme.bold("Extension statuses")} ${this.theme.fg("dim", `${this.entries.length} entries`)}`, width));
		let row = "";
		let x = 0;
		for (const [label, action] of [["Close", () => this.close()], ["Refresh", () => this.refresh()]] as const) {
			const cell = `[${label}]`;
			this.buttons.push({ x, width: visibleWidth(cell), action });
			row += `${this.theme.fg("accent", cell)}  `;
			x += visibleWidth(cell) + 2;
		}
		this.buttonRow = out.length;
		out.push(truncateToWidth(row, width));
		const height = this.bodyHeight();
		this.scroll(0);
		for (const line of this.lines.slice(this.offset, this.offset + height)) out.push(truncateToWidth(line, width));
		if (this.lines.length > height) {
			out.push(truncateToWidth(this.theme.fg("dim", `${this.offset + 1}-${Math.min(this.lines.length, this.offset + height)} of ${this.lines.length} lines · wheel or arrows scroll · r refreshes`), width));
		}
		return out.slice(0, this.rows());
	}
}
