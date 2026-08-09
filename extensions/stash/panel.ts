/** Interactive /stash browser. Filesystem access and pickup injection stay in the host. */

import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	Markdown,
	matchesKey,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
	type MarkdownTheme,
} from "@earendil-works/pi-tui";
import type { StashEntry } from "./store.ts";
import { sanitizeTerminalText } from "./text.ts";

export interface StashPanelResult {
	selected?: StashEntry;
	manage?: StashEntry;
	complete?: StashEntry;
	filter?: string;
	selectedId?: string;
	selectedIndex?: number;
}

interface StashPanelDeps {
	entries: StashEntry[];
	title: string;
	theme: Theme;
	tui: { requestRender(): void };
	getMaxRows: () => number;
	hasMore?: boolean;
	done: (result: StashPanelResult) => void;
	copyResume: (entry: StashEntry) => Promise<void>;
	initialFilter?: string;
	initialSelectedId?: string;
	initialSelectedIndex?: number;
}

interface Layout {
	total: number;
	framed: boolean;
	bodyRows: number;
	innerWidth: number;
	listWidth: number;
	previewWidth: number;
}

type Color = Parameters<Theme["fg"]>[0];

function formatCreated(value: string): string {
	const compact = value.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/);
	if (compact) return `${compact[1]}-${compact[2]}-${compact[3]} ${compact[4]}:${compact[5]} UTC`;
	const iso = value.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/);
	return iso ? `${iso[1]} ${iso[2]} UTC` : value;
}

function formatDate(value: string): string {
	const compact = value.match(/^(\d{4})(\d{2})(\d{2})/);
	if (compact) return `${compact[1]}-${compact[2]}-${compact[3]}`;
	return value.match(/^\d{4}-\d{2}-\d{2}/)?.[0] ?? value.slice(0, 10);
}

function safeLine(value: string): string {
	return sanitizeTerminalText(value).text.replace(/\n/g, "↵");
}

function oneLine(value: string): string {
	return safeLine(value).replace(/\s+/g, " ").trim();
}

function fit(text: string, width: number): string {
	if (width <= 0) return "";
	const hadAnsi = text.includes("\x1b");
	let truncated = truncateToWidth(text, width);
	if (!hadAnsi) truncated = truncated.replace(/\x1b\[[0-9;]*m/g, "");
	return `${truncated}${" ".repeat(Math.max(0, width - visibleWidth(truncated)))}`;
}

function keepTail(text: string, width: number): string {
	if (width <= 0) return "";
	if (visibleWidth(text) <= width) return text;
	const chars = Array.from(text);
	while (chars.length > 0 && visibleWidth(`…${chars.join("")}`) > width) chars.shift();
	return `…${chars.join("")}`;
}

/** Compute the side-by-side panes while protecting useful preview width. */
export function computePanes(inner: number, dividerWidth = 3): { listWidth: number; previewWidth: number } {
	const available = Math.max(2, inner - dividerWidth);
	let listWidth = Math.max(16, Math.min(46, Math.floor(inner * 0.36)));
	let previewWidth = available - listWidth;
	if (previewWidth < 24) {
		listWidth = Math.max(12, available - 24);
		previewWidth = available - listWidth;
	}
	if (previewWidth < 8) {
		previewWidth = Math.max(1, Math.min(8, available - 1));
		listWidth = Math.max(1, available - previewWidth);
	}
	return { listWidth, previewWidth };
}

function computeLayout(maxRows: number, width: number): Layout {
	const total = Math.min(44, Math.max(1, Math.floor(maxRows)));
	if (total < 5 || width < 72) {
		return {
			total,
			framed: false,
			bodyRows: Math.max(0, total - 1),
			innerWidth: width,
			listWidth: width,
			previewWidth: 0,
		};
	}
	const innerWidth = Math.max(1, width - 4);
	const panes = computePanes(innerWidth);
	return {
		total,
		framed: true,
		bodyRows: Math.max(1, total - 4),
		innerWidth,
		...panes,
	};
}

function markdownTheme(theme: Theme): MarkdownTheme {
	return {
		heading: (text) => theme.fg("mdHeading", text),
		link: (text) => theme.fg("mdLink", text),
		linkUrl: (text) => theme.fg("mdLinkUrl", text),
		code: (text) => theme.fg("mdCode", text),
		codeBlock: (text) => theme.fg("mdCodeBlock", text),
		codeBlockBorder: (text) => theme.fg("mdCodeBlockBorder", text),
		quote: (text) => theme.fg("mdQuote", text),
		quoteBorder: (text) => theme.fg("mdQuoteBorder", text),
		hr: (text) => theme.fg("mdHr", text),
		listBullet: (text) => theme.fg("mdListBullet", text),
		bold: (text) => theme.bold(text),
		italic: (text) => theme.italic(text),
		strikethrough: (text) => theme.strikethrough(text),
		underline: (text) => theme.underline(text),
	};
}

function stateMark(state: string): { glyph: string; color: Color } {
	switch (state) {
		case "open":
			return { glyph: "○", color: "muted" };
		case "active":
			return { glyph: "◐", color: "accent" };
		case "closed":
			return { glyph: "●", color: "success" };
		default:
			return { glyph: "◈", color: "warning" };
	}
}

export class StashPanel {
	private readonly deps: StashPanelDeps;
	private filter: string;
	private filtering = false;
	private selected = 0;
	private listScroll = 0;
	private previewScroll = 0;
	private help = false;
	private helpScroll = 0;
	private copyNotice: { text: string; color: "success" | "error" } | undefined;
	private copyNoticeTimer: ReturnType<typeof setTimeout> | undefined;
	private copying = false;
	private finished = false;
	private version = 0;
	private lastWidth = 104;
	private cachedWidth = -1;
	private cachedRows = -1;
	private cachedVersion = -1;
	private cachedLines: string[] = [];
	private previewCacheKey = "";
	private previewCacheLines: string[] = [];

	constructor(deps: StashPanelDeps) {
		this.deps = deps;
		this.filter = deps.initialFilter ?? "";
		if (deps.initialSelectedId) {
			const wanted = this.filtered.findIndex((entry) => entry.meta.id === deps.initialSelectedId);
			if (wanted >= 0) this.selected = wanted;
			else if (deps.initialSelectedIndex !== undefined) {
				this.selected = Math.max(0, Math.min(deps.initialSelectedIndex, Math.max(0, this.filtered.length - 1)));
			}
		} else if (deps.initialSelectedIndex !== undefined) {
			this.selected = Math.max(0, Math.min(deps.initialSelectedIndex, Math.max(0, this.filtered.length - 1)));
		}
	}

	private get filtered(): StashEntry[] {
		if (!this.filter) return this.deps.entries;
		const needle = this.filter.toLocaleLowerCase();
		return this.deps.entries.filter((entry) => {
			const fields = [
				entry.meta.id,
				entry.meta.title,
				entry.meta.created,
				entry.meta.project ?? "",
				entry.meta.branch ?? "",
				entry.meta.tags.join(" "),
				entry.meta.state,
				entry.meta.activatedAt ?? "",
				entry.meta.closedAt ?? "",
				entry.meta.outcome ?? "",
				entry.preview ?? "",
			];
			return fields.some((field) => field.toLocaleLowerCase().includes(needle));
		});
	}

	private current(): StashEntry | undefined {
		return this.filtered[this.selected];
	}

	private layout(width = this.lastWidth): Layout {
		return computeLayout(this.deps.getMaxRows(), width);
	}

	private previewSource(width = this.layout().previewWidth): string[] {
		const entry = this.current();
		if (!entry) return [this.deps.entries.length === 0 ? "No stashes yet. Create one with stash_write." : "No matching stashes."];
		const key = [entry.meta.id, width, entry.previewError, entry.previewTruncated, entry.preview, JSON.stringify(entry.meta)].join("\0");
		if (key === this.previewCacheKey) return this.previewCacheLines;
		if (entry.previewError) {
			this.previewCacheKey = key;
			this.previewCacheLines = [`Preview unavailable: ${safeLine(entry.previewError)}`];
			return this.previewCacheLines;
		}
		const meta = entry.meta;
		const metadata = [
			`**${safeLine(meta.state)}** · stashed ${safeLine(formatCreated(meta.created)) || "?"}`,
			meta.activatedAt ? `activated: ${safeLine(formatCreated(meta.activatedAt))}` : undefined,
			meta.closedAt ? `closed: ${safeLine(formatCreated(meta.closedAt))}` : undefined,
			meta.outcome ? `outcome: ${safeLine(meta.outcome)}` : undefined,
			meta.tags.length > 0 ? `tags: ${meta.tags.map(safeLine).join(", ")}` : undefined,
			meta.sessionId ? `session: ${safeLine(meta.sessionId)}` : undefined,
			meta.project ? `project: ${safeLine(meta.project)}` : undefined,
			meta.branch ? `branch: ${safeLine(meta.branch)}` : undefined,
			`file: ${safeLine(entry.path)}`,
		]
			.filter((value): value is string => Boolean(value))
			.join("  \n");
		const body = sanitizeTerminalText(entry.preview ?? "").text;
		const markdown = `${metadata}\n\n---\n\n${body}`;
		let lines: string[];
		try {
			lines = new Markdown(markdown, 0, 0, markdownTheme(this.deps.theme), {
				color: (text) => this.deps.theme.fg("text", text),
			}).render(Math.max(1, width));
		} catch {
			lines = markdown.split("\n").map(safeLine);
		}
		if (entry.previewTruncated) lines.push("[preview truncated; pickup includes the full artifact]");
		this.previewCacheKey = key;
		this.previewCacheLines = lines;
		return lines;
	}

	private helpSource(width: number): string[] {
		const theme = this.deps.theme;
		const out: string[] = [];
		const section = (title: string, paragraphs: string[]) => {
			if (out.length > 0) out.push("");
			out.push(theme.bold(theme.fg("accent", title)));
			out.push(theme.fg("dim", "─".repeat(Math.min(Math.max(1, width), visibleWidth(title)))));
			for (const paragraph of paragraphs) {
				for (const line of wrapTextWithAnsi(paragraph, Math.max(8, width))) out.push(theme.fg("text", line));
			}
		};
		section("What this is", [
			"A two-pane browser over durable stashed work. Select an effort on the left and read its handover on the right. To create another stash, run /stash new <hint>; the hint guides what the distiller preserves.",
		]);
		section("What it does", [
			"Pickup activates a stash and resumes it in this session. Active efforts can close with a concrete outcome. Copy keeps the browser open; the actions dialog exposes guarded reopen and archive operations.",
		]);
		section("Closing", [
			"Closing without pickup discards nothing. Every stash stays on disk, and no lifecycle state changes unless you choose an action.",
		]);
		return out;
	}

	private pageSize(): number {
		return Math.max(1, this.layout().bodyRows);
	}

	private previewMaxScroll(): number {
		const layout = this.layout();
		return Math.max(0, this.previewSource(layout.previewWidth).length - layout.bodyRows);
	}

	private helpMaxScroll(): number {
		const layout = this.layout();
		return Math.max(0, this.helpSource(layout.innerWidth).length - layout.bodyRows);
	}

	private bump(): void {
		this.version++;
		this.deps.tui.requestRender();
	}

	private finish(result: StashPanelResult): void {
		this.finished = true;
		if (this.copyNoticeTimer) clearTimeout(this.copyNoticeTimer);
		this.deps.done({
			...result,
			filter: this.filter,
			selectedId: this.current()?.meta.id,
			selectedIndex: this.selected,
		});
	}

	private copy(entry: StashEntry): void {
		if (this.copying) return;
		this.copying = true;
		this.bump();
		void this.deps.copyResume(entry).then(
			() => this.showCopyNotice("copied ✓", "success"),
			() => this.showCopyNotice("clipboard copy failed", "error"),
		);
	}

	private showCopyNotice(text: string, color: "success" | "error"): void {
		this.copying = false;
		if (this.finished) return;
		if (this.copyNoticeTimer) clearTimeout(this.copyNoticeTimer);
		this.copyNotice = { text, color };
		this.bump();
		this.copyNoticeTimer = setTimeout(() => {
			this.copyNotice = undefined;
			this.copyNoticeTimer = undefined;
			this.bump();
		}, 1_600);
		this.copyNoticeTimer.unref?.();
	}

	private resetSelection(): void {
		this.selected = 0;
		this.listScroll = 0;
		this.previewScroll = 0;
	}

	private moveSelection(delta: number): void {
		const entries = this.filtered;
		this.selected = Math.max(0, Math.min(Math.max(0, entries.length - 1), this.selected + delta));
		this.previewScroll = 0;
	}

	handleInput(data: string): void {
		if (this.help) {
			if (data === "h" || matchesKey(data, "escape")) {
				this.help = false;
				this.helpScroll = 0;
			} else if (matchesKey(data, "up")) {
				this.helpScroll = Math.max(0, this.helpScroll - 1);
			} else if (matchesKey(data, "down")) {
				this.helpScroll = Math.min(this.helpMaxScroll(), this.helpScroll + 1);
			} else if (data === "b") {
				this.helpScroll = Math.max(0, this.helpScroll - this.pageSize());
			} else if (matchesKey(data, "space")) {
				this.helpScroll = Math.min(this.helpMaxScroll(), this.helpScroll + this.pageSize());
			} else {
				return;
			}
			this.bump();
			return;
		}

		if (this.filtering) {
			if (matchesKey(data, "escape") || matchesKey(data, "enter")) {
				this.filtering = false;
			} else if (matchesKey(data, "backspace")) {
				this.filter = Array.from(this.filter).slice(0, -1).join("");
				this.resetSelection();
			} else if (matchesKey(data, "up")) {
				this.moveSelection(-1);
			} else if (matchesKey(data, "down")) {
				this.moveSelection(1);
			} else if (data.length > 0 && !matchesKey(data, "ctrl+c") && /^[\p{L}\p{N}\p{P}\p{S} ]+$/u.test(data)) {
				this.filter += data;
				this.resetSelection();
			} else {
				return;
			}
			this.bump();
			return;
		}

		if (matchesKey(data, "escape")) {
			this.finish({});
			return;
		}
		if (matchesKey(data, "up")) {
			this.moveSelection(-1);
			this.bump();
			return;
		}
		if (matchesKey(data, "down")) {
			this.moveSelection(1);
			this.bump();
			return;
		}
		if (this.lastWidth < 104) {
			if (matchesKey(data, "enter")) {
				const selected = this.current();
				if (selected) this.finish({ selected });
			}
			return;
		}
		if (data === "b") {
			this.previewScroll = Math.max(0, this.previewScroll - this.pageSize());
			this.bump();
			return;
		}
		if (matchesKey(data, "space")) {
			this.previewScroll = Math.min(this.previewMaxScroll(), this.previewScroll + this.pageSize());
			this.bump();
			return;
		}
		if (data === "h") {
			this.help = true;
			this.helpScroll = 0;
			this.bump();
			return;
		}
		if (data === "/") {
			this.filtering = true;
			this.bump();
			return;
		}
		if (matchesKey(data, "enter")) {
			const selected = this.current();
			if (selected) this.finish({ selected });
			return;
		}
		if (matchesKey(data, "tab")) {
			const selected = this.current();
			if (selected) this.finish({ manage: selected });
			return;
		}
		if (data === "o") {
			const selected = this.current();
			if (selected?.meta.state === "active") this.finish({ complete: selected });
			return;
		}
		if (data === "c") {
			const selected = this.current();
			if (selected) this.copy(selected);
		}
	}

	private topBorder(width: number, position: string): string {
		const theme = this.deps.theme;
		const title = `✦ ${safeLine(this.deps.title)}`;
		const right = ` ${position} ─┐`;
		const leftBudget = Math.max(1, width - visibleWidth(right) - 4);
		const shownTitle = truncateToWidth(title, leftBudget);
		const left = `┌─ ${shownTitle} `;
		const fill = Math.max(0, width - visibleWidth(left) - visibleWidth(right));
		return theme.bg(
			"customMessageBg",
			`${theme.fg("borderMuted", left.slice(0, 3))}${theme.bold(theme.fg("accent", left.slice(3)))}${theme.fg("borderMuted", "─".repeat(fill))}${theme.fg("dim", ` ${position}`)}${theme.fg("borderMuted", " ─┐")}`,
		);
	}

	private keyPair(key: string, label: string): string {
		return `${this.deps.theme.fg("accent", key)}${this.deps.theme.fg("dim", ` ${label}`)}`;
	}

	private footerText(innerWidth: number): string {
		const theme = this.deps.theme;
		if (this.copyNotice) return theme.fg(this.copyNotice.color, this.copyNotice.text);
		if (this.copying) return theme.fg("dim", "copying…");
		if (this.filtering) {
			const suffix = ` · ↑↓ select · enter/esc done · ${this.filtered.length} match`;
			const queryWidth = Math.max(1, innerWidth - visibleWidth("filter ") - visibleWidth(suffix));
			return `${theme.fg("accent", "filter ")}${theme.fg("text", keepTail(`${safeLine(this.filter)}▌`, queryWidth))}${theme.fg("dim", suffix)}`;
		}
		if (this.help) {
			return [this.keyPair("↑↓", "scroll"), this.keyPair("b/spc", "page"), this.keyPair("h/esc", "back")].join(theme.fg("dim", " · "));
		}
		if (this.lastWidth < 104) {
			return [this.keyPair("↑↓", "select"), this.keyPair("enter", "pick"), this.keyPair("esc", "close")].join(theme.fg("dim", " · "));
		}
		const parts = [
			this.keyPair("↑↓", "select"),
			this.keyPair("b/spc", "page"),
			this.keyPair("tab", "actions"),
			this.keyPair("/", "filter"),
			this.keyPair("enter", "pick"),
		];
		if (this.current()?.meta.state === "active") parts.push(this.keyPair("o", "close"));
		parts.push(this.keyPair("c", "copy"), this.keyPair("h", "help"), this.keyPair("esc", "close"));
		return parts.join(theme.fg("dim", " · "));
	}

	render(width: number): string[] {
		this.lastWidth = width;
		const layout = this.layout(width);
		if (this.cachedWidth === width && this.cachedRows === layout.total && this.cachedVersion === this.version) {
			return this.cachedLines;
		}
		const theme = this.deps.theme;
		const entries = this.filtered;
		const position = entries.length === 0 ? "0/0" : `${this.selected + 1}/${entries.length}${this.deps.hasMore ? "+" : ""}`;
		const paint = (text: string): string => theme.bg("customMessageBg", fit(text, width));
		const lines: string[] = [];

		if (!layout.framed) {
			const headerRows = layout.total > 1 ? 1 : 0;
			if (headerRows) lines.push(paint(`${safeLine(this.deps.title)} · ${position}`));
			const itemRows = Math.max(0, layout.total - headerRows - 1);
			for (let slot = 0; slot < itemRows; slot++) {
				const absolute = this.listScroll + slot;
				const entry = entries[absolute];
				const empty = slot === 0 && entries.length === 0
					? this.deps.entries.length === 0
						? "No stashes yet. Create one with stash_write."
						: "No matching stashes."
					: "";
				lines.push(paint(entry ? `${absolute === this.selected ? "›" : " "} ${stateMark(entry.meta.state).glyph} ${formatDate(entry.meta.created)} ${oneLine(entry.meta.title)}` : empty));
			}
			lines.push(paint(this.footerText(width)));
			this.cachedWidth = width;
			this.cachedRows = layout.total;
			this.cachedVersion = this.version;
			this.cachedLines = lines.slice(0, layout.total);
			return this.cachedLines;
		}

		lines.push(this.topBorder(width, position));
		if (this.help) {
			const source = this.helpSource(layout.innerWidth);
			this.helpScroll = Math.min(this.helpScroll, Math.max(0, source.length - layout.bodyRows));
			const page = source.slice(this.helpScroll, this.helpScroll + layout.bodyRows);
			for (let index = 0; index < layout.bodyRows; index++) {
				lines.push(
					theme.bg(
						"customMessageBg",
						`${theme.fg("borderMuted", "│ ")}${fit(page[index] ?? "", layout.innerWidth)}${theme.fg("borderMuted", " │")}`,
					),
				);
			}
		} else {
			if (this.selected < this.listScroll) this.listScroll = this.selected;
			if (this.selected >= this.listScroll + layout.bodyRows) this.listScroll = this.selected - layout.bodyRows + 1;
			this.previewScroll = Math.min(this.previewScroll, this.previewMaxScroll());
			const preview = this.previewSource(layout.previewWidth);
			const previewPage = preview.slice(this.previewScroll, this.previewScroll + layout.bodyRows);
			for (let index = 0; index < layout.bodyRows; index++) {
				const absolute = this.listScroll + index;
				const entry = entries[absolute];
				let listCell = "";
				if (entry) {
					const selected = absolute === this.selected;
					const mark = stateMark(entry.meta.state);
					listCell = `${selected ? theme.fg("accent", "› ") : "  "}${theme.fg(mark.color, mark.glyph)} ${theme.fg("dim", formatDate(entry.meta.created))} ${theme.fg(selected ? "accent" : "text", oneLine(entry.meta.title))}`;
				}
				lines.push(
					theme.bg(
						"customMessageBg",
						`${theme.fg("borderMuted", "│ ")}${fit(listCell, layout.listWidth)}${theme.fg("borderMuted", " │ ")}${fit(previewPage[index] ?? "", layout.previewWidth)}${theme.fg("borderMuted", " │")}`,
					),
				);
			}
		}

		lines.push(theme.bg("customMessageBg", theme.fg("borderMuted", `├${"─".repeat(Math.max(0, width - 2))}┤`)));
		lines.push(
			theme.bg(
				"customMessageBg",
				`${theme.fg("borderMuted", "│ ")}${fit(this.footerText(layout.innerWidth), layout.innerWidth)}${theme.fg("borderMuted", " │")}`,
			),
		);
		lines.push(theme.bg("customMessageBg", theme.fg("borderMuted", `└${"─".repeat(Math.max(0, width - 2))}┘`)));

		this.cachedWidth = width;
		this.cachedRows = layout.total;
		this.cachedVersion = this.version;
		this.cachedLines = lines.slice(0, layout.total);
		return this.cachedLines;
	}

	dispose(): void {
		this.finished = true;
		if (this.copyNoticeTimer) clearTimeout(this.copyNoticeTimer);
		this.copyNoticeTimer = undefined;
	}

	invalidate(): void {
		this.cachedWidth = -1;
		this.cachedRows = -1;
		this.cachedVersion = -1;
		this.cachedLines = [];
		this.previewCacheKey = "";
		this.previewCacheLines = [];
	}
}
