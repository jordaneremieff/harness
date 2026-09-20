/** Interactive /clipboard browser. Clipboard and archive I/O are delegated to the host. */

import type { Theme } from "@earendil-works/pi-coding-agent";
import { decodeKittyPrintable, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { ClipboardEntry } from "./store.ts";
import { sanitizeTerminalText } from "./text.ts";

export type RestoreOutcome = { ok: true; warning?: string } | { ok: false; error: string };

interface PanelResult {
	restored?: ClipboardEntry;
	warning?: string;
}

interface PanelDeps {
	entries: ClipboardEntry[];
	theme: Theme;
	tui: { requestRender(): void };
	getMaxRows: () => number;
	hasMore?: boolean;
	done: (result: PanelResult) => void;
	onRestore: (entry: ClipboardEntry, signal: AbortSignal) => Promise<RestoreOutcome>;
}

interface Layout {
	total: number;
	framed: boolean;
	filter: boolean;
	listRows: number;
	separator: boolean;
	previewRows: number;
}

type Color = Parameters<Theme["fg"]>[0];

function safeLine(value: string): string {
	return sanitizeTerminalText(value).text.replace(/\n/g, "↵");
}

function localTime(iso: string): string {
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) return "--:--";
	return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function fitText(text: string, width: number): string {
	if (width <= 0) return "";
	// Input is plain, sanitized text. Strip SGR resets the width helper may add
	// around a Unicode ellipsis before applying the panel's own styling.
	const truncated = truncateToWidth(text, width).replace(/\x1b\[[0-9;]*m/g, "");
	return `${truncated}${" ".repeat(Math.max(0, width - visibleWidth(truncated)))}`;
}

function computeLayout(maxRows: number, width: number): Layout {
	const total = Math.min(44, Math.max(1, Math.floor(maxRows)));
	if (total === 1) return { total, framed: false, filter: false, listRows: 0, separator: false, previewRows: 0 };
	const framed = total >= 8 && width >= 4;
	const contentRows = total - 1 - (framed ? 1 : 0); // footer, plus framed top
	const filter = contentRows >= 3;
	let remaining = contentRows - 1 - (filter ? 1 : 0); // header + optional filter
	let separator = remaining >= 3;
	if (separator) remaining--;
	let listRows = 0;
	let previewRows = 0;
	if (remaining === 1) {
		listRows = 1;
	} else if (remaining >= 2) {
		listRows = Math.max(1, Math.ceil(remaining * 0.48));
		previewRows = remaining - listRows;
	}
	if (previewRows === 0) separator = false;
	return { total, framed, filter, listRows, separator, previewRows };
}

export class ClipboardPanel {
	private readonly deps: PanelDeps;
	private filter = "";
	private selected = 0;
	private listScroll = 0;
	private previewScroll = 0;
	private flash: string | null = null;
	private restoring = false;
	private restoreController?: AbortController;
	private disposed = false;
	private version = 0;
	private lastWidth = 80;
	private cachedWidth = -1;
	private cachedRows = -1;
	private cachedVersion = -1;
	private cachedLines: string[] = [];

	constructor(deps: PanelDeps) {
		this.deps = deps;
	}

	private get filtered(): ClipboardEntry[] {
		if (!this.filter) return this.deps.entries;
		const needle = this.filter.toLocaleLowerCase();
		return this.deps.entries.filter(
			(entry) =>
				entry.content.toLocaleLowerCase().includes(needle) ||
				(entry.label ?? "").toLocaleLowerCase().includes(needle) ||
				entry.id.toLocaleLowerCase().includes(needle),
		);
	}

	private layout(width = this.lastWidth): Layout {
		return computeLayout(this.deps.getMaxRows(), width);
	}

	private previewSource(): string[] {
		const entry = this.filtered[this.selected];
		if (!entry) return [];
		const lines = entry.content.split("\n").map(safeLine);
		if (entry.contentTruncated) lines.push("[preview truncated; restore uses the full archived entry]");
		return lines;
	}

	private previewPageSize(): number {
		return Math.max(1, this.layout().previewRows);
	}

	private previewMaxScroll(): number {
		return Math.max(0, this.previewSource().length - this.layout().previewRows);
	}

	private bump(): void {
		this.version++;
		this.deps.tui.requestRender();
	}

	handleInput(data: string): void {
		if (this.disposed) return;
		if (this.restoring) {
			if (matchesKey(data, "escape")) this.restoreController?.abort();
			return;
		}
		const entries = this.filtered;
		if (matchesKey(data, "escape")) {
			this.onEscape();
			return;
		}
		this.flash = null;
		if (matchesKey(data, "up")) {
			this.onUp();
			return;
		}
		if (matchesKey(data, "down")) {
			this.onDown(entries.length);
			return;
		}
		if (matchesKey(data, "left")) {
			this.onPreview(-1);
			return;
		}
		if (matchesKey(data, "right")) {
			this.onPreview(1);
			return;
		}
		if (matchesKey(data, "backspace")) {
			this.onBackspace();
			return;
		}
		if (matchesKey(data, "enter")) {
			this.onEnter(entries);
			return;
		}
		this.handleTyped(data);
	}

	private onEscape(): void {
		if (this.filter) {
			this.filter = "";
			this.selected = 0;
			this.listScroll = 0;
			this.previewScroll = 0;
			this.bump();
		} else {
			this.deps.done({});
		}
	}

	private onUp(): void {
		this.selected = Math.max(0, this.selected - 1);
		this.previewScroll = 0;
		this.bump();
	}

	private onDown(count: number): void {
		this.selected = Math.min(Math.max(0, count - 1), this.selected + 1);
		this.previewScroll = 0;
		this.bump();
	}

	private onPreview(direction: number): void {
		const page = this.previewPageSize();
		this.previewScroll =
			direction < 0
				? Math.max(0, this.previewScroll - page)
				: Math.min(this.previewMaxScroll(), this.previewScroll + page);
		this.bump();
	}

	private onBackspace(): void {
		if (!this.filter) return;
		this.filter = Array.from(this.filter).slice(0, -1).join("");
		this.selected = 0;
		this.listScroll = 0;
		this.previewScroll = 0;
		this.bump();
	}

	private onEnter(entries: ClipboardEntry[]): void {
		const entry = entries[this.selected];
		if (!entry) return;
		this.restoring = true;
		const controller = new AbortController();
		this.restoreController = controller;
		this.bump();
		void this.restore(entry, controller);
	}

	private async restore(entry: ClipboardEntry, controller: AbortController): Promise<void> {
		let outcome: RestoreOutcome;
		try {
			outcome = await this.deps.onRestore(entry, controller.signal);
		} catch (error) {
			outcome = { ok: false, error: error instanceof Error ? error.message : String(error) };
		}
		this.restoreController = undefined;
		this.restoring = false;
		if (this.disposed) return;
		if ("error" in outcome) {
			this.flash = `restore failed: ${outcome.error}`;
			this.bump();
			return;
		}
		this.deps.done(outcome.warning === undefined ? { restored: entry } : { restored: entry, warning: outcome.warning });
	}

	private handleTyped(data: string): void {
		// A terminal that negotiated the Kitty keyboard protocol sends CSI-u for
		// every key, printable ones included. Decode first, the way pi-tui's own
		// input component does, or typed filter text never arrives.
		const typed = decodeKittyPrintable(data) ?? data;
		if (typed.length === 0 || matchesKey(data, "ctrl+c") || !/^[\p{L}\p{N}\p{P}\p{S} ]+$/u.test(typed)) return;
		this.filter += typed;
		this.selected = 0;
		this.listScroll = 0;
		this.previewScroll = 0;
		this.bump();
	}

	render(width: number): string[] {
		this.lastWidth = width;
		const layout = this.layout(width);
		if (this.cachedWidth === width && this.cachedRows === layout.total && this.cachedVersion === this.version) {
			return this.cachedLines;
		}
		this.previewScroll = Math.min(this.previewScroll, this.previewMaxScroll());
		const lines = this.buildLines(width, layout);
		this.cachedWidth = width;
		this.cachedRows = layout.total;
		this.cachedVersion = this.version;
		this.cachedLines = lines.slice(0, layout.total);
		return this.cachedLines;
	}

	private styleLine(text: string, targetWidth: number, color?: Color, bold = false): string {
		let result = fitText(text, targetWidth); // truncate before styling so resets cannot punch through the panel background
		if (bold) result = this.deps.theme.bold(result);
		if (color) result = this.deps.theme.fg(color, result);
		return result;
	}

	private paintLine(width: number, text: string, color?: Color, bold = false): string {
		return this.deps.theme.bg("customMessageBg", this.styleLine(text, width, color, bold));
	}

	private rowLine(
		layout: Layout,
		width: number,
		innerWidth: number,
		text: string,
		color?: Color,
		bold = false,
	): string {
		if (!layout.framed) return this.paintLine(width, text, color, bold);
		const theme = this.deps.theme;
		return theme.bg(
			"customMessageBg",
			`${theme.fg("borderMuted", "│")}${this.styleLine(text, innerWidth, color, bold)}${theme.fg("borderMuted", "│")}`,
		);
	}

	private footerLine(layout: Layout, width: number, innerWidth: number, text: string): string {
		if (!layout.framed) return this.paintLine(width, text, "dim");
		const theme = this.deps.theme;
		return theme.bg(
			"customMessageBg",
			`${theme.fg("borderMuted", "╰")}${this.styleLine(text, innerWidth, "dim")}${theme.fg("borderMuted", "╯")}`,
		);
	}

	private buildLines(width: number, layout: Layout): string[] {
		const entries = this.filtered;
		const total = this.deps.entries.length;
		const innerWidth = layout.framed ? Math.max(0, width - 2) : width;
		if (layout.total === 1) return [this.footerLine(layout, width, innerWidth, " esc close")];
		const lines: string[] = [];
		if (layout.framed) lines.push(this.paintLine(width, `╭${"─".repeat(innerWidth)}╮`, "borderMuted"));
		lines.push(
			this.rowLine(layout, width, innerWidth, ` Clipboard history ${this.filterNote(entries.length, total)}`, "accent", true),
		);
		if (layout.filter) {
			lines.push(
				this.rowLine(
					layout,
					width,
					innerWidth,
					this.filter ? ` filter: ${safeLine(this.filter)}▌` : " type to filter",
					this.filter ? "muted" : "dim",
				),
			);
		}
		this.syncListScroll(layout);
		lines.push(...this.listLines(layout, width, innerWidth, entries, total));
		if (layout.separator) lines.push(this.rowLine(layout, width, innerWidth, "─".repeat(innerWidth), "borderMuted"));
		lines.push(...this.previewLines(layout, width, innerWidth));
		lines.push(this.footerLine(layout, width, innerWidth, this.hintLine(entries.length)));
		return lines;
	}

	private filterNote(count: number, total: number): string {
		const loadedTotal = `${total}${this.deps.hasMore ? "+" : ""}`;
		if (!this.filter) return ` — ${loadedTotal} entries`;
		return this.deps.hasMore ? ` — ${count} match in ${loadedTotal} recent` : ` — ${count} of ${total} match`;
	}

	private syncListScroll(layout: Layout): void {
		if (this.selected < this.listScroll) this.listScroll = this.selected;
		if (this.selected >= this.listScroll + layout.listRows) {
			this.listScroll = this.selected - layout.listRows + 1;
		}
	}

	private emptyRow(index: number, total: number): string {
		if (index !== 0) return "";
		return total === 0 ? " No clipboard history yet." : " No matching entries.";
	}

	private entryRowText(entry: ClipboardEntry, absolute: number): string {
		const label = entry.label ? ` [${safeLine(entry.label)}]` : "";
		const preview = safeLine(entry.preview);
		const marker = absolute === this.selected ? "›" : " ";
		return `${marker} ${localTime(entry.timestamp)}${label} (${entry.lines}L/${entry.chars}c)  ${preview}`;
	}

	private listLines(
		layout: Layout,
		width: number,
		innerWidth: number,
		entries: ClipboardEntry[],
		total: number,
	): string[] {
		const lines: string[] = [];
		const visible = entries.slice(this.listScroll, this.listScroll + layout.listRows);
		for (let index = 0; index < layout.listRows; index++) {
			const entry = visible[index];
			if (!entry) {
				lines.push(this.rowLine(layout, width, innerWidth, this.emptyRow(index, total), "dim"));
				continue;
			}
			const absolute = this.listScroll + index;
			lines.push(
				this.rowLine(
					layout,
					width,
					innerWidth,
					this.entryRowText(entry, absolute),
					absolute === this.selected ? "accent" : undefined,
					absolute === this.selected,
				),
			);
		}
		return lines;
	}

	private previewLines(layout: Layout, width: number, innerWidth: number): string[] {
		const lines: string[] = [];
		const source = this.previewSource();
		const page = source.slice(this.previewScroll, this.previewScroll + layout.previewRows);
		for (let index = 0; index < layout.previewRows; index++) {
			let text = page[index] ?? "";
			if (index === layout.previewRows - 1 && source.length > this.previewScroll + layout.previewRows) {
				text = ` +${source.length - this.previewScroll - layout.previewRows} more · ${text}`;
			}
			lines.push(this.rowLine(layout, width, innerWidth, text, "muted"));
		}
		return lines;
	}

	private hintLine(count: number): string {
		if (this.restoring) return " restoring… · esc cancel";
		if (this.flash) return ` esc close · ${safeLine(this.flash)}`;
		const position = count > 0 ? `${this.selected + 1}/${count}${this.deps.hasMore ? "+" : ""}` : "0/0";
		return ` enter restore · esc close · ←→ preview · ↑↓ select · ${position}`;
	}

	dispose(): void {
		this.disposed = true;
		this.restoreController?.abort();
	}

	invalidate(): void {
		this.cachedWidth = -1;
		this.cachedRows = -1;
		this.cachedVersion = -1;
		this.cachedLines = [];
	}
}
