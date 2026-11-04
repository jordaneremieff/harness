/** Interactive clipboard archive browser. The host owns archive and clipboard I/O. */

import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	decodeKittyPrintable,
	type KeyId,
	matchesKey,
	truncateToWidth,
	type TuiMouseEvent,
	type TuiMouseEventResult,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { RestoreOutcome } from "./browser-operations.ts";
import type { SearchPage } from "./search.ts";
import type { ClipboardEntry } from "./store.ts";
import { sanitizeTerminalText } from "./text.ts";

export type { RestoreOutcome };

interface PanelResult {
	restored?: ClipboardEntry;
	warning?: string;
}

export interface PanelDeps {
	entries: ClipboardEntry[];
	theme: Theme;
	tui: { requestRender(): void };
	getMaxRows: () => number;
	hasMore?: boolean;
	done: (result: PanelResult) => void;
	onRestore: (entry: ClipboardEntry, signal: AbortSignal) => Promise<RestoreOutcome>;
	onPreview?: (entry: ClipboardEntry, signal: AbortSignal) => Promise<ClipboardEntry>;
	onRecent?: (signal: AbortSignal) => Promise<{ entries: ClipboardEntry[]; hasMore: boolean }>;
	onSearch?: (query: string, cursor: string | undefined, signal: AbortSignal) => Promise<SearchPage>;
}

type Action =
	| "recent"
	| "archive"
	| "search"
	| "help"
	| "detail"
	| "continue"
	| "refresh"
	| "close"
	| "restore"
	| "back"
	| "previous"
	| "next";
type Scope = "recent" | "archive";
type Colour = Parameters<Theme["fg"]>[0];

interface Hit {
	x: number;
	y: number;
	width: number;
	action?: Action;
	entry?: ClipboardEntry;
	pane?: "list" | "preview";
}

const SHORTCUTS: ReadonlyArray<readonly [KeyId, Action]> = [
	["ctrl+f", "search"],
	["f1", "help"],
	["ctrl+d", "detail"],
	["ctrl+n", "continue"],
	["ctrl+r", "refresh"],
	["ctrl+q", "close"],
];
/** Secondary help; the footer itself stays short. */
const HELP_LINES = [
	"Rows select; labelled controls act. Restore writes the full archived record to the clipboard.",
	"Keys: ↑↓ select · ←→ or PageUp/PageDown scroll the preview · Enter restores the selection",
	"F2 switches Recent and Search archive · Ctrl+F search · Ctrl+D detail · Ctrl+N continue · Ctrl+R refresh",
	"Esc leaves help, detail or the query; Esc on the list closes. Ctrl+Q closes.",
	"Continue appears only while an archive scan has a next page; Refresh restarts a stale query.",
];
const MIN_COLUMNS = 48;
const MIN_ROWS = 12;

const safe = (value: string) => sanitizeTerminalText(value).text;
const single = (value: string) => safe(value).replace(/\n/g, "↵");
const identity = (entry: ClipboardEntry) => `${entry.archiveDate ?? ""}\0${entry.id}`;
const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));

function dateTime(value: string): string {
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return "unknown date";
	const pad = (part: number) => String(part).padStart(2, "0");
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function fitCells(value: string, width: number): string {
	const text = truncateToWidth(value, Math.max(0, width)).replace(/\x1b\[[0-9;]*m/g, "");
	return `${text}${" ".repeat(Math.max(0, width - visibleWidth(text)))}`;
}

function matchEntry(match: SearchPage["matches"][number]): ClipboardEntry {
	return {
		id: match.id,
		archiveDate: match.date,
		timestamp: match.timestamp,
		label: match.label,
		lines: match.lines,
		chars: match.chars,
		preview: match.match.excerpt,
		content: "",
		contentTruncated: true,
	};
}

function coverageText(page: SearchPage): string {
	const detail = `Stop ${page.stop}; ${page.scan.records} records; skipped ${page.scan.malformed} malformed and ${page.scan.oversized} oversized.`;
	return page.hasMore ? `Partial scan; Continue remains available. ${detail}` : `End of observed scan. ${detail}`;
}

export class ClipboardPanel {
	private readonly deps: PanelDeps;
	private readonly handlers: Record<Action, () => void>;
	private recent: ClipboardEntry[];
	private recentMore: boolean;
	private scope: Scope = "recent";
	private query = "";
	private searchedQuery = "";
	private editing = false;
	private archive: ClipboardEntry[] = [];
	private cursor?: string;
	private coverage = "Enter literal text, then select Search.";
	private stale = false;
	private selectedKey?: string;
	private listScroll = 0;
	private previewScroll = 0;
	private detail = false;
	private help = false;
	private preview?: ClipboardEntry;
	private previewError?: string;
	private flash?: string;
	private busy = false;
	private restoring = false;
	private disposed = false;
	private hidden = false;
	private generation = 0;
	private previewGeneration = 0;
	private readController?: AbortController;
	private previewController?: AbortController;
	private restoreController?: AbortController;
	private version = 0;
	private cachedVersion = -1;
	private width = 0;
	private rows = 0;
	private cached: string[] = [];
	private hits: Hit[] = [];
	private listRows = 1;
	private previewRows = 1;
	private wrapped: string[] = [];
	private wrappedKey = "";

	constructor(deps: PanelDeps) {
		this.deps = deps;
		this.recent = deps.entries;
		this.recentMore = deps.hasMore ?? false;
		this.selectedKey = this.recent[0] && identity(this.recent[0]);
		this.handlers = {
			recent: () => this.switchScope("recent"),
			archive: () => this.switchScope("archive"),
			search: () => this.onSearchAction(),
			help: () => this.toggle("help"),
			detail: () => this.toggle("detail"),
			continue: () => void this.search(true),
			refresh: () => void this.refresh(),
			close: () => this.close(),
			restore: () => void this.restore(),
			back: () => this.backToList(),
			previous: () => this.scrollPreview(-this.previewRows),
			next: () => this.scrollPreview(this.previewRows),
		};
		this.loadPreview();
	}

	private entries(): ClipboardEntry[] {
		if (this.scope === "archive") return this.archive;
		const query = this.query.toLocaleLowerCase();
		return query
			? this.recent.filter((entry) =>
					`${entry.id}\n${entry.label ?? ""}\n${entry.preview}`.toLocaleLowerCase().includes(query),
				)
			: this.recent;
	}

	private selected(): ClipboardEntry | undefined {
		return this.entries().find((entry) => identity(entry) === this.selectedKey);
	}

	private isSelected(entry: ClipboardEntry | undefined): boolean {
		return entry !== undefined && identity(entry) === this.selectedKey;
	}

	private changed(): void {
		this.hits = [];
		this.version++;
		if (!this.disposed) this.deps.tui.requestRender();
	}

	private select(entry: ClipboardEntry, reveal = false): void {
		if (this.selectedKey !== identity(entry)) {
			this.selectedKey = identity(entry);
			this.previewScroll = 0;
			this.loadPreview();
		}
		if (reveal) {
			const index = this.entries().findIndex((item) => this.isSelected(item));
			if (index < this.listScroll) this.listScroll = index;
			if (index >= this.listScroll + this.listRows) this.listScroll = index - this.listRows + 1;
		}
		this.changed();
	}

	private loadPreview(): void {
		const generation = ++this.previewGeneration;
		this.previewController?.abort();
		this.preview = undefined;
		this.previewError = undefined;
		this.wrappedKey = "";
		const entry = this.selected();
		if (!entry) return;
		if (!this.deps.onPreview) {
			this.preview = entry;
			return;
		}
		const controller = new AbortController();
		this.previewController = controller;
		const current = () => !this.disposed && !controller.signal.aborted && generation === this.previewGeneration;
		this.deps.onPreview(entry, controller.signal).then(
			(preview) => {
				if (!current()) return;
				this.preview = preview;
				this.changed();
			},
			(error: unknown) => {
				if (!current()) return;
				this.previewError = error instanceof Error ? error.message : String(error);
				this.stale = this.scope === "archive";
				this.changed();
			},
		);
	}

	private setQuery(query: string): void {
		this.query = query;
		this.readController?.abort();
		this.generation++;
		this.busy = false;
		if (this.scope === "archive") {
			this.cursor = undefined;
			this.stale = true;
			this.coverage = "Query changed. Select Search or Refresh before an action.";
		} else {
			this.keepSelectionVisible();
		}
		this.listScroll = 0;
		this.changed();
	}

	private keepSelectionVisible(): void {
		const entries = this.entries();
		if (entries.some((entry) => this.isSelected(entry))) return;
		this.selectedKey = entries[0] && identity(entries[0]);
		this.previewScroll = 0;
		this.loadPreview();
	}

	private switchScope(scope: Scope): void {
		if (scope === this.scope) return;
		this.readController?.abort();
		this.generation++;
		this.busy = false;
		this.scope = scope;
		this.editing = scope === "archive";
		this.listScroll = 0;
		this.keepSelectionVisible();
		this.changed();
	}

	private isCurrent(generation: number, controller: AbortController): boolean {
		return !this.disposed && !controller.signal.aborted && generation === this.generation;
	}

	private finishRead(generation: number): void {
		if (!this.disposed && generation === this.generation) {
			this.busy = false;
			this.changed();
		}
	}

	private startRead(): { generation: number; controller: AbortController } {
		const generation = ++this.generation;
		this.readController?.abort();
		const controller = new AbortController();
		this.readController = controller;
		this.busy = true;
		this.changed();
		return { generation, controller };
	}

	private async search(continuation: boolean): Promise<void> {
		if (!this.deps.onSearch || !this.query.trim() || this.busy) return;
		if (continuation && (!this.cursor || this.stale || this.query !== this.searchedQuery)) return;
		const query = this.query;
		const cursor = continuation ? this.cursor : undefined;
		this.editing = false;
		this.flash = undefined;
		const { generation, controller } = this.startRead();
		try {
			const page = await this.deps.onSearch(query, cursor, controller.signal);
			if (this.isCurrent(generation, controller)) this.applyPage(page, query, continuation);
		} catch (error) {
			if (this.isCurrent(generation, controller)) this.markStale(error);
		} finally {
			this.finishRead(generation);
		}
	}

	private applyPage(page: SearchPage, query: string, continuation: boolean): void {
		const existing = continuation ? this.archive : [];
		const keys = new Set(existing.map(identity));
		this.archive = [...existing, ...page.matches.map(matchEntry).filter((entry) => !keys.has(identity(entry)))];
		this.cursor = page.nextCursor ?? undefined;
		this.searchedQuery = query;
		this.stale = false;
		this.coverage = coverageText(page);
		if (!this.archive.some((entry) => this.isSelected(entry))) {
			this.selectedKey = this.archive[0] && identity(this.archive[0]);
		}
		if (!continuation) this.listScroll = 0;
		this.loadPreview();
	}

	private markStale(error: unknown): void {
		this.stale = true;
		this.coverage = `Archive state unavailable or stale. Refresh required: ${error instanceof Error ? error.message : String(error)}`;
	}

	private async refresh(): Promise<void> {
		if (this.scope === "archive") {
			await this.search(false);
			return;
		}
		if (!this.deps.onRecent || this.busy) return;
		const { generation, controller } = this.startRead();
		try {
			const page = await this.deps.onRecent(controller.signal);
			if (this.isCurrent(generation, controller)) this.replaceEntries(page.entries, page.hasMore);
		} catch (error) {
			if (!controller.signal.aborted) {
				this.flash = `Refresh failed: ${error instanceof Error ? error.message : String(error)}`;
			}
		} finally {
			this.finishRead(generation);
		}
	}

	/** Replaces the Recent entries from the host and resets hit geometry. */
	replaceEntries(entries: ClipboardEntry[], hasMore = false): void {
		this.recent = entries;
		this.recentMore = hasMore;
		this.keepSelectionVisible();
		this.changed();
	}

	private async restore(): Promise<void> {
		const entry = this.preview;
		const refused = !entry || this.previewError !== undefined || (this.stale && this.scope === "archive");
		if (refused || this.busy || this.restoring) {
			this.flash = "Restore unavailable. Read the selected record; refresh stale archive state.";
			this.changed();
			return;
		}
		const controller = new AbortController();
		this.restoreController = controller;
		this.restoring = true;
		this.changed();
		let outcome: RestoreOutcome;
		try {
			outcome = await this.deps.onRestore(entry, controller.signal);
		} catch (error) {
			outcome = { ok: false, error: error instanceof Error ? error.message : String(error) };
		}
		this.restoring = false;
		if (this.disposed) return;
		if (!outcome.ok) {
			this.flash = `Restore failed: ${outcome.error}`;
			this.changed();
			return;
		}
		this.close({ restored: entry, ...(outcome.warning === undefined ? {} : { warning: outcome.warning }) });
	}

	private close(result: PanelResult = {}): void {
		this.hide();
		this.deps.done(result);
	}

	private act(action: Action): void {
		if (this.restoring) {
			if (action === "close") this.restoreController?.abort();
			return;
		}
		this.handlers[action]();
	}

	private onSearchAction(): void {
		if (this.scope === "archive" && this.editing) void this.search(false);
		else {
			this.editing = true;
			this.changed();
		}
	}

	private toggle(key: "help" | "detail"): void {
		this[key] = !this[key];
		this.editing = false;
		this.previewScroll = 0;
		this.wrappedKey = "";
		this.changed();
	}

	private backToList(): void {
		this.help = false;
		this.detail = false;
		this.editing = false;
		this.wrappedKey = "";
		this.changed();
	}

	/** Continue is offered only while the last archive page left a next page for the same query. */
	private canContinue(): boolean {
		return this.scope === "archive" && this.cursor !== undefined && !this.stale && this.query === this.searchedQuery;
	}

	private scrollPreview(delta: number): void {
		this.previewScroll = clamp(this.previewScroll + delta, 0, Math.max(0, this.wrapped.length - this.previewRows));
		this.changed();
	}

	private scrollList(delta: number): void {
		this.listScroll = clamp(this.listScroll + delta, 0, Math.max(0, this.entries().length - this.listRows));
		this.changed();
	}

	handleInput(data: string): void {
		if (this.disposed || this.hidden) return;
		if (this.restoring) {
			if (matchesKey(data, "escape")) this.restoreController?.abort();
			return;
		}
		const shortcut = SHORTCUTS.find(([key]) => matchesKey(data, key));
		if (shortcut) {
			this.act(shortcut[1]);
			return;
		}
		if (matchesKey(data, "f2")) this.switchScope(this.scope === "recent" ? "archive" : "recent");
		else if (matchesKey(data, "escape")) this.onEscape();
		else if (matchesKey(data, "enter")) this.onEnter();
		else if (this.onNavigate(data)) return;
		else if (matchesKey(data, "backspace")) this.setQuery(Array.from(this.query).slice(0, -1).join(""));
		else this.onText(data);
	}

	private onEscape(): void {
		if (this.busy) {
			this.readController?.abort();
			this.generation++;
			this.busy = false;
			this.changed();
		} else if (this.help || this.detail || this.editing) this.backToList();
		else if (this.query) this.setQuery("");
		else this.close();
	}

	private onEnter(): void {
		if (!this.editing) {
			this.act("restore");
			return;
		}
		this.editing = false;
		if (this.scope === "archive") void this.search(false);
		else this.changed();
	}

	private onNavigate(data: string): boolean {
		if (matchesKey(data, "up") || matchesKey(data, "down")) {
			const entries = this.entries();
			const index = entries.findIndex((entry) => this.isSelected(entry));
			const step = matchesKey(data, "up") ? -1 : 1;
			const next = entries[clamp(index + step, 0, entries.length - 1)];
			if (next) this.select(next, true);
			return true;
		}
		if (matchesKey(data, "left") || matchesKey(data, "pageUp")) {
			this.act("previous");
			return true;
		}
		if (matchesKey(data, "right") || matchesKey(data, "pageDown")) {
			this.act("next");
			return true;
		}
		return false;
	}

	private onText(data: string): void {
		const typed = decodeKittyPrintable(data) ?? data;
		if (typed && /^[\p{L}\p{N}\p{P}\p{S} ]+$/u.test(typed)) {
			this.editing = true;
			this.setQuery(this.query + typed);
		}
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (this.disposed || this.hidden || event.width !== this.width || this.rows !== this.maxRows()) {
			this.hits = [];
			return;
		}
		const hit = this.hits.find((item) => item.y === event.y && event.x >= item.x && event.x < item.x + item.width);
		if (!hit) return;
		if (event.type === "wheel") {
			if (hit.pane === "preview") this.scrollPreview(event.wheelDelta ?? 0);
			else if (hit.pane === "list") this.scrollList(event.wheelDelta ?? 0);
			return { handled: true };
		}
		if (event.type !== "click" || event.button !== "left") return;
		if (hit.entry) this.select(hit.entry);
		else if (hit.action) this.act(hit.action);
		return { handled: true };
	}

	private maxRows(): number {
		return Math.max(1, Math.min(44, Math.floor(this.deps.getMaxRows())));
	}

	render(width: number): string[] {
		const rows = this.maxRows();
		if (this.cachedVersion === this.version && this.width === width && this.rows === rows) return this.cached;
		this.hits = [];
		this.width = width;
		this.rows = rows;
		const inner = Math.max(0, width - 2);
		const lines =
			rows < MIN_ROWS || width < MIN_COLUMNS ? this.compactLines(rows, inner) : this.fullLines(rows, inner);
		this.cached = lines.slice(0, rows);
		this.cachedVersion = this.version;
		return this.cached;
	}

	/** A row is fitted to the pane before styling, so colour codes survive into the output. */
	private row(text: string, inner: number, colour: Colour = "muted"): string {
		return this.deps.theme.bg("customMessageBg", this.deps.theme.fg(colour, `│${fitCells(text, inner)}│`));
	}

	/** Labelled controls become hit regions at the row index they occupy. */
	private controlRow(y: number, inner: number, items: ReadonlyArray<readonly [string, Action]>): string {
		let text = "";
		for (const [label, action] of items) {
			const value = `[${label}] `;
			if (visibleWidth(text + value) > inner) break;
			this.hits.push({ x: 1 + visibleWidth(text), y, width: visibleWidth(value) - 1, action });
			text += value;
		}
		return this.row(text, inner, "accent");
	}

	private compactLines(rows: number, inner: number): string[] {
		if (rows === 1) return [this.controlRow(0, inner, [["Close", "close"]])];
		const lines = [this.row(`Resize to ${MIN_COLUMNS}x${MIN_ROWS} or larger.`, inner)];
		while (lines.length < rows - 1) lines.push(this.row("", inner));
		lines.push(this.controlRow(lines.length, inner, [["Close", "close"]]));
		return lines;
	}

	private headerLines(inner: number): string[] {
		const count = this.scope === "recent" ? this.entries().length : this.archive.length;
		const scopeText = this.scope === "recent" ? `Recent ${count}${this.recentMore ? "+" : ""}` : `Search archive ${count}`;
		return [
			this.row(`Clipboard history · ${scopeText}${this.busy ? " · Read in progress" : ""}`, inner, "accent"),
			this.controlRow(1, inner, [
				[this.scope === "recent" ? "Recent ✓" : "Recent", "recent"],
				[this.scope === "archive" ? "Search archive ✓" : "Search archive", "archive"],
				["Refresh", "refresh"],
				[this.help ? "Help ✓" : "Help", "help"],
			]),
			this.controlRow(2, inner, [
				[this.scope === "archive" && this.editing ? "Run search" : "Search", "search"],
				["Restore", "restore"],
				[this.detail ? "Back to list" : "Detail", this.detail ? "back" : "detail"],
				...(this.canContinue() ? [["Continue", "continue"] as const] : []),
				["Close", "close"],
			]),
		];
	}

	private fullLines(rows: number, inner: number): string[] {
		const lines = this.headerLines(inner);
		lines.push(this.row(this.queryText(), inner));
		lines.push(...this.coverageLines(inner));
		const available = rows - lines.length - 2;
		this.listRows = this.detail ? 0 : Math.max(1, Math.floor(available * 0.45));
		this.previewRows = Math.max(1, available - this.listRows);
		lines.push(...this.listLines(lines.length, inner));
		lines.push(this.controlRow(lines.length, inner, [
			["Previous page", "previous"],
			["Next page", "next"],
			[this.detail ? "Back to list" : "Read detail", "detail"],
		]));
		lines.push(...this.previewLines(lines.length, inner));
		lines.push(this.row(this.footerText(), inner, this.flash ? "warning" : "dim"));
		return lines;
	}

	private queryText(): string {
		const label = this.scope === "recent" ? "Recent filter" : "Literal archive query";
		return `${label}: ${single(this.query)}${this.editing ? "▌ (Enter to apply)" : ""}`;
	}

	private coverageLines(inner: number): string[] {
		if (this.scope === "recent") return [this.row("Recent filters labels, ids and excerpts. Search archive reads full records.", inner, "dim")];
		return wrapTextWithAnsi(this.coverage, inner)
			.slice(0, 2)
			.map((line) => this.row(line, inner, this.stale ? "warning" : "dim"));
	}

	private listLines(y0: number, inner: number): string[] {
		const entries = this.entries();
		const out: string[] = [];
		for (let index = 0; index < this.listRows; index++) {
			const entry = entries[this.listScroll + index];
			this.hits.push({ x: 1, y: y0 + index, width: inner, pane: "list", entry });
			out.push(this.row(this.listText(entry, index), inner, this.isSelected(entry) ? "accent" : "muted"));
		}
		return out;
	}

	private listText(entry: ClipboardEntry | undefined, index: number): string {
		if (entry) {
			const marker = this.isSelected(entry) ? "›" : " ";
			const label = entry.label ? single(entry.label) : single(entry.preview);
			return `${marker} ${dateTime(entry.timestamp)} · ${label} · ${entry.chars}c`;
		}
		if (index !== 0) return "";
		if (this.scope === "archive") return "No matches on this page. Check coverage and Continue.";
		return "No clipboard history matches.";
	}

	private previewBody(): string {
		if (this.help) return HELP_LINES.join("\n");
		if (this.preview) {
			const entry = this.preview;
			const header = `${entry.id}\n${entry.timestamp} · archive ${entry.archiveDate ?? "unavailable"} · ${entry.chars} chars`;
			const notice = entry.contentTruncated ? "\n[Preview truncated; restore uses the full archived entry]" : "";
			return `${header}\n${entry.content}${notice}`;
		}
		return this.previewError ?? (this.selected() ? "Read in progress…" : "Select a record.");
	}

	private previewLines(y0: number, inner: number): string[] {
		const key = `${this.previewGeneration}:${inner}:${this.help ? "help" : this.preview ? "ready" : "pending"}:${this.previewError ?? ""}`;
		if (this.wrappedKey !== key) {
			this.wrapped = wrapTextWithAnsi(safe(this.previewBody()), Math.max(1, inner));
			this.wrappedKey = key;
		}
		this.previewScroll = clamp(this.previewScroll, 0, Math.max(0, this.wrapped.length - this.previewRows));
		const out: string[] = [];
		for (let index = 0; index < this.previewRows; index++) {
			this.hits.push({ x: 1, y: y0 + index, width: inner, pane: "preview" });
			out.push(this.row(this.wrapped[this.previewScroll + index] ?? "", inner));
		}
		return out;
	}

	private footerText(): string {
		if (this.restoring) return "Restore in progress · Escape cancels";
		if (this.flash) return single(this.flash);
		if (this.help) return "Help · Esc or Help returns to the browser";
		const selected = this.selected();
		if (!selected) return "Select a record · F1 help";
		if (this.scope === "archive" && this.stale) return "Archive state is stale · Refresh before Restore · F1 help";
		return `Enter or Restore writes the full archived record ${selected.id} to the clipboard · F1 help`;
	}

	hide(): void {
		this.hidden = true;
		this.hits = [];
		this.previewController?.abort();
		this.readController?.abort();
	}

	dispose(): void {
		this.disposed = true;
		this.hide();
		this.restoreController?.abort();
	}

	invalidate(): void {
		this.hits = [];
		this.cachedVersion = -1;
		this.wrappedKey = "";
	}
}
