/** Interactive /clipboard browser. Clipboard and archive I/O are delegated to the host. */

import type { Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
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
	onRestore: (entry: ClipboardEntry) => Promise<RestoreOutcome>;
}

interface Layout {
	total: number;
	framed: boolean;
	filter: boolean;
	listRows: number;
	separator: boolean;
	previewRows: number;
}

function safeLine(value: string): string {
	return sanitizeTerminalText(value).text.replace(/\n/g, "↵");
}

function localTime(iso: string): string {
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) return "--:--";
	return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function fit(text: string, width: number): string {
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
		if (this.restoring) return;
		const entries = this.filtered;
		if (matchesKey(data, "escape")) {
			if (this.filter) {
				this.filter = "";
				this.selected = 0;
				this.listScroll = 0;
				this.previewScroll = 0;
				this.bump();
			} else {
				this.deps.done({});
			}
			return;
		}
		this.flash = null;
		if (matchesKey(data, "up")) {
			this.selected = Math.max(0, this.selected - 1);
			this.previewScroll = 0;
			this.bump();
			return;
		}
		if (matchesKey(data, "down")) {
			this.selected = Math.min(Math.max(0, entries.length - 1), this.selected + 1);
			this.previewScroll = 0;
			this.bump();
			return;
		}
		if (matchesKey(data, "left")) {
			this.previewScroll = Math.max(0, this.previewScroll - this.previewPageSize());
			this.bump();
			return;
		}
		if (matchesKey(data, "right")) {
			this.previewScroll = Math.min(this.previewMaxScroll(), this.previewScroll + this.previewPageSize());
			this.bump();
			return;
		}
		if (matchesKey(data, "backspace")) {
			if (this.filter) {
				this.filter = Array.from(this.filter).slice(0, -1).join("");
				this.selected = 0;
				this.listScroll = 0;
				this.previewScroll = 0;
				this.bump();
			}
			return;
		}
		if (matchesKey(data, "enter")) {
			const entry = entries[this.selected];
			if (!entry) return;
			this.restoring = true;
			this.bump();
			void (async () => {
				let outcome: RestoreOutcome;
				try {
					outcome = await this.deps.onRestore(entry);
				} catch (error) {
					outcome = { ok: false, error: error instanceof Error ? error.message : String(error) };
				}
				this.restoring = false;
				if ("error" in outcome) {
					this.flash = `restore failed: ${outcome.error}`;
					this.bump();
					return;
				}
				this.deps.done(outcome.warning === undefined ? { restored: entry } : { restored: entry, warning: outcome.warning });
			})();
			return;
		}
		if (data.length > 0 && !matchesKey(data, "ctrl+c") && /^[\p{L}\p{N}\p{P}\p{S} ]+$/u.test(data)) {
			this.filter += data;
			this.selected = 0;
			this.listScroll = 0;
			this.previewScroll = 0;
			this.bump();
		}
	}

	render(width: number): string[] {
		this.lastWidth = width;
		const layout = this.layout(width);
		if (
			this.cachedWidth === width &&
			this.cachedRows === layout.total &&
			this.cachedVersion === this.version
		) {
			return this.cachedLines;
		}
		this.previewScroll = Math.min(this.previewScroll, this.previewMaxScroll());
		const theme = this.deps.theme;
		const entries = this.filtered;
		const total = this.deps.entries.length;
		const innerWidth = layout.framed ? Math.max(0, width - 2) : width;
		type Color = Parameters<Theme["fg"]>[0];
		const styled = (text: string, targetWidth: number, color?: Color, bold = false): string => {
			let result = fit(text, targetWidth); // truncate before styling so resets cannot punch through the panel background
			if (bold) result = theme.bold(result);
			if (color) result = theme.fg(color, result);
			return result;
		};
		const paint = (text: string, color?: Color, bold = false): string =>
			theme.bg("customMessageBg", styled(text, width, color, bold));
		const row = (text: string, color?: Color, bold = false): string =>
			layout.framed
				? theme.bg(
						"customMessageBg",
						`${theme.fg("borderMuted", "│")}${styled(text, innerWidth, color, bold)}${theme.fg("borderMuted", "│")}`,
					)
				: paint(text, color, bold);
		const footer = (text: string): string =>
			layout.framed
				? theme.bg(
						"customMessageBg",
						`${theme.fg("borderMuted", "╰")}${styled(text, innerWidth, "dim")}${theme.fg("borderMuted", "╯")}`,
					)
				: paint(text, "dim");
		const lines: string[] = [];

		if (layout.total === 1) {
			lines.push(footer(" esc close"));
		} else {
			if (layout.framed) lines.push(paint(`╭${"─".repeat(innerWidth)}╮`, "borderMuted"));
			const loadedTotal = `${total}${this.deps.hasMore ? "+" : ""}`;
			const filterNote = this.filter
				? this.deps.hasMore
					? ` — ${entries.length} match in ${loadedTotal} recent`
					: ` — ${entries.length} of ${total} match`
				: ` — ${loadedTotal} entries`;
			lines.push(row(` Clipboard history ${filterNote}`, "accent", true));
			if (layout.filter) {
				lines.push(row(this.filter ? ` filter: ${safeLine(this.filter)}▌` : " type to filter", this.filter ? "muted" : "dim"));
			}

			if (this.selected < this.listScroll) this.listScroll = this.selected;
			if (this.selected >= this.listScroll + layout.listRows) {
				this.listScroll = this.selected - layout.listRows + 1;
			}
			const visible = entries.slice(this.listScroll, this.listScroll + layout.listRows);
			for (let index = 0; index < layout.listRows; index++) {
				const entry = visible[index];
				if (!entry) {
					const empty = index === 0 ? (total === 0 ? " No clipboard history yet." : " No matching entries.") : "";
					lines.push(row(empty, "dim"));
					continue;
				}
				const absolute = this.listScroll + index;
				const label = entry.label ? ` [${safeLine(entry.label)}]` : "";
				const preview = safeLine(entry.preview);
				const text = `${absolute === this.selected ? "›" : " "} ${localTime(entry.timestamp)}${label} (${entry.lines}L/${entry.chars}c)  ${preview}`;
				lines.push(row(text, absolute === this.selected ? "accent" : undefined, absolute === this.selected));
			}

			if (layout.separator) lines.push(row("─".repeat(innerWidth), "borderMuted"));
			const source = this.previewSource();
			const page = source.slice(this.previewScroll, this.previewScroll + layout.previewRows);
			for (let index = 0; index < layout.previewRows; index++) {
				let text = page[index] ?? "";
				if (index === layout.previewRows - 1 && source.length > this.previewScroll + layout.previewRows) {
					text = ` +${source.length - this.previewScroll - layout.previewRows} more · ${text}`;
				}
				lines.push(row(text, "muted"));
			}

			const position = entries.length > 0 ? `${this.selected + 1}/${entries.length}${this.deps.hasMore ? "+" : ""}` : "0/0";
			const hint = this.restoring
				? " restoring…"
				: this.flash
					? ` esc close · ${safeLine(this.flash)}`
					: ` enter restore · esc close · ←→ preview · ↑↓ select · ${position}`;
			lines.push(footer(hint));
		}

		this.cachedWidth = width;
		this.cachedRows = layout.total;
		this.cachedVersion = this.version;
		this.cachedLines = lines.slice(0, layout.total);
		return this.cachedLines;
	}

	invalidate(): void {
		this.cachedWidth = -1;
		this.cachedRows = -1;
		this.cachedVersion = -1;
		this.cachedLines = [];
	}
}
