/** Interactive /stash browser: presentation, selection, and labelled actions; reads and lifecycle changes stay in the host. */

import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	decodeKittyPrintable,
	Markdown,
	matchesKey,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
	type TuiMouseEvent,
	type TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import { stateLabel } from "./format.ts";
import type { StashEntry } from "./store.ts";
import { sanitizeTerminalText } from "./text.ts";

export interface StashPanelResult {
	selected?: StashEntry;
	manage?: StashEntry;
	complete?: StashEntry;
	note?: StashEntry;
	navigation?: "recent" | "search" | "continue" | "refresh";
	filter?: string;
	selectedId?: string;
	selectedIndex?: number;
	previewScroll?: number;
	detail?: boolean;
}

export type PanelTheme = Pick<Theme, "fg" | "bg" | "bold" | "italic" | "strikethrough" | "underline">;

interface StashPanelDeps {
	entries: StashEntry[];
	title: string;
	theme: PanelTheme;
	tui: { requestRender(): void };
	getMaxRows: () => number;
	hasMore?: boolean;
	done: (result: StashPanelResult) => void;
	copyResume: (entry: StashEntry) => Promise<void>;
	initialFilter?: string;
	initialSelectedId?: string;
	initialSelectedIndex?: number;
	initialPreviewScroll?: number;
	initialDetail?: boolean;
	/** "archive" marks an archive-search view; "recent" is the default preloaded scope. */
	scope?: "recent" | "archive";
	query?: string;
	/** One-line coverage description shown while browsing an archive view. */
	coverage?: string;
	/** True when the last archive read no longer matches the store; only Refresh is offered. */
	stale?: boolean;
	nextCursor?: string | null;
	/** Reads the selected artifact body on demand; the host owns cancellation and replacement. */
	loadPreview?: (entry: StashEntry, signal: AbortSignal) => Promise<StashEntry>;
}

type PanelAction =
	| "previous"
	| "next"
	| "detail"
	| "back"
	| "filter"
	| "recent"
	| "search"
	| "continue"
	| "refresh"
	| "manage"
	| "pickup"
	| "note"
	| "complete"
	| "copy"
	| "pageUp"
	| "pageDown"
	| "help"
	| "close";

interface HitRegion {
	x: number;
	y: number;
	width: number;
	action?: PanelAction;
	/** Entry id for row targets: a row click selects, never acts. */
	id?: string;
}

const SPLIT_MIN_WIDTH = 104;
const MIN_WIDTH = 32;
const MIN_ROWS = 5;
const NAVIGATIONS = new Set<PanelAction>(["recent", "search", "continue", "refresh"]);
const KEYS: Record<string, PanelAction> = {
	"/": "filter",
	a: "note",
	o: "complete",
	c: "copy",
	h: "help",
	b: "pageUp",
	" ": "pageDown",
	d: "detail",
	r: "recent",
	s: "search",
	n: "continue",
	f: "refresh",
};

const safe = (value: string) => sanitizeTerminalText(value).text;
const flat = (value: string) => safe(value).replace(/\s+/gu, " ").trim();
const identity = (text: string) => text;

function fitText(value: string, width: number): string {
	const text = truncateToWidth(value, Math.max(0, width));
	return `${text}${" ".repeat(Math.max(0, width - visibleWidth(text)))}`;
}

function entryDate(value: string): string {
	const compact = value.match(/^(\d{4})(\d{2})(\d{2})/);
	return compact ? `${compact[1]}-${compact[2]}-${compact[3]}` : value.slice(0, 10);
}

function entryMark(entry: StashEntry): string {
	if (entry.previewError !== undefined || entry.meta.invalidState !== undefined) return "◈";
	return { open: "○", active: "◐", closed: "●", unknown: "◈" }[entry.meta.state];
}

export function computePanes(inner: number, dividerWidth = 3): { listWidth: number; previewWidth: number } {
	const available = Math.max(2, inner - dividerWidth);
	const listWidth = Math.max(1, Math.min(46, Math.floor(inner * 0.36), available - 1));
	return { listWidth, previewWidth: available - listWidth };
}

function projectLine(entry: StashEntry): string {
	const { project, branch } = entry.meta;
	return `${flat(project ?? "project unknown")}${branch ? ` · ${flat(branch)}` : ""}`;
}

function headLines(entry: StashEntry): string[] {
	const meta = entry.meta;
	const optional = (label: string, value: string | undefined) => (value ? `${label}: ${flat(value)}` : "");
	return [
		flat(meta.title),
		`${stateLabel(meta, entry.previewError !== undefined)} · stashed ${flat(meta.created) || "?"}`,
		projectLine(entry),
		`id: ${flat(meta.id)}`,
		optional("session", meta.sessionId),
		`file: ${flat(entry.path)}`,
		optional("activated", meta.activatedAt),
		optional("closed", meta.closedAt),
		optional("outcome", meta.outcome),
		meta.tags.length > 0 ? `tags: ${meta.tags.map(flat).join(", ")}` : "",
	].filter((value) => value !== "");
}

function markdownLines(theme: PanelTheme, text: string, width: number): string[] {
	const rendered = new Markdown(safe(text), 0, 0, {
		heading: theme.bold,
		link: identity,
		linkUrl: identity,
		code: identity,
		codeBlock: identity,
		codeBlockBorder: identity,
		quote: identity,
		quoteBorder: identity,
		hr: identity,
		listBullet: identity,
		bold: theme.bold,
		italic: theme.italic,
		strikethrough: theme.strikethrough,
		underline: theme.underline,
	}).render(Math.max(1, width));
	// Wrapping each rendered line keeps every character of a long line reachable.
	return rendered.flatMap((value) => wrapTextWithAnsi(value, Math.max(1, width)));
}

function bodyLines(entry: StashEntry, theme: PanelTheme, width: number): string[] {
	if (entry.previewError !== undefined) return [`Preview unavailable: ${flat(entry.previewError)}`];
	const lines = entry.preview === undefined ? ["Preview read pending…"] : markdownLines(theme, entry.preview, width);
	if (entry.previewTruncated) lines.push("[preview truncated; pickup reads the full artifact]");
	return lines;
}

const HELP_PARAGRAPHS = [
	"What this is",
	"A browser over saved efforts. Select a row, then use a labelled control. Create an effort with /stash new <hint>.",
	"What it does",
	"Pickup activates an open or active stash and delivers its handover. Note asks for an optional operator note: cancelling that dialog returns here without pickup; an explicitly empty answer requests a plain pickup.",
	"Actions offers the transitions the store permits: Reopen for closed records, Release for active records, Rotate behind a confirmation. Closed records never offer pickup.",
	"Recent filters the newest preloaded records. Search archive searches full supported bodies through the same bounded search as stash_list. Continue stays available after an empty bounded page. Refresh restarts a stale query.",
	"Closing",
	"Close leaves every artifact and lifecycle state unchanged.",
];

interface ControlState {
	help: boolean;
	detail: boolean;
	archive: boolean;
	stale: boolean;
	hasNext: boolean;
	readable: boolean;
	pickable: boolean;
	active: boolean;
}

function controlList(state: ControlState): Array<[string, PanelAction]> {
	if (state.help) {
		return [
			["Back", "back"],
			["Page up", "pageUp"],
			["Page down", "pageDown"],
			["Close", "close"],
		];
	}
	const controls: Array<[string, PanelAction]> = [
		["Prev", "previous"],
		["Next", "next"],
		[state.detail ? "Back to list" : "Detail", state.detail ? "back" : "detail"],
		["Recent", "recent"],
		["Search archive", "search"],
		["Filter", "filter"],
		["Close", "close"],
	];
	if (state.archive) controls.push(["Refresh", "refresh"]);
	if (state.archive && state.hasNext && !state.stale) controls.push(["Continue", "continue"]);
	const mutable = state.readable && !state.stale;
	if (mutable) controls.push(["Actions", "manage"]);
	if (state.pickable) controls.push(["Pickup", "pickup"], ["Note", "note"]);
	if (mutable && state.active) controls.push(["Complete", "complete"]);
	controls.push(["Copy", "copy"], ["Page up", "pageUp"], ["Page down", "pageDown"], ["Help", "help"]);
	return controls;
}

/** Pack labelled controls into at most `capLines` rows; later controls that no longer fit stay keyboard-reachable. */
function packControls(
	controls: Array<[string, PanelAction]>,
	inner: number,
	capLines: number,
): { lines: string[]; hits: HitRegion[] } {
	const lines: string[] = [];
	const hits: HitRegion[] = [];
	let line = "";
	for (const [label, action] of controls) {
		const text = `[${label}]`;
		if (line && visibleWidth(line) + text.length + 1 > inner) {
			if (lines.length + 1 >= capLines) return { lines: [...lines, line], hits };
			lines.push(line);
			line = "";
		}
		hits.push({ x: 2 + visibleWidth(line), y: lines.length, width: text.length, action });
		line = `${line}${text} `;
	}
	return { lines: line ? [...lines, line] : lines, hits };
}

export class StashPanel {
	private readonly deps: StashPanelDeps;
	private filter: string;
	private filtering = false;
	private selected = 0;
	private listScroll = 0;
	private previewScroll: number;
	private detail: boolean;
	private help = false;
	private helpScroll = 0;
	private finished = false;
	private notice = "";
	private copying = false;
	private copyNoticeTimer: ReturnType<typeof setTimeout> | undefined;
	private lastWidth = -1;
	private lastRows = -1;
	private cachedLines: string[] | undefined;
	private hits: HitRegion[] = [];
	private bodyTop = 0;
	private bodyRows = 0;
	private listWidth = 0;
	private split = false;
	private previewAbort: AbortController | undefined;
	private previewGeneration = 0;

	constructor(deps: StashPanelDeps) {
		this.deps = deps;
		this.filter = deps.initialFilter ?? "";
		this.previewScroll = deps.initialPreviewScroll ?? 0;
		this.detail = deps.initialDetail ?? false;
		const found = this.filtered.findIndex((entry) => entry.meta.id === deps.initialSelectedId);
		const fallback = Math.min(deps.initialSelectedIndex ?? 0, this.filtered.length - 1);
		this.selected = Math.max(0, found >= 0 ? found : fallback);
		this.loadSelected();
	}

	private get filtered(): StashEntry[] {
		if (!this.filter) return this.deps.entries;
		const needle = this.filter.toLocaleLowerCase();
		return this.deps.entries.filter((entry) => this.searchFields(entry).some((value) => value.toLocaleLowerCase().includes(needle)));
	}

	private searchFields(entry: StashEntry): string[] {
		const meta = entry.meta;
		return [
			meta.id,
			meta.title,
			meta.created,
			meta.project ?? "",
			meta.branch ?? "",
			meta.tags.join(" "),
			stateLabel(meta, entry.previewError !== undefined),
			meta.outcome ?? "",
			entry.preview ?? "",
		];
	}

	private current(): StashEntry | undefined {
		return this.filtered[this.selected];
	}

	/** False when the entry's state or header is unknown: no lifecycle action may be offered as if it would work. */
	private readable(entry: StashEntry | undefined): entry is StashEntry {
		return entry !== undefined && entry.meta.invalidState === undefined && entry.previewError === undefined;
	}

	/** The store activates only open or active records; a closed record routes to the actions dialog, where reopen is the guarded step. */
	private pickable(entry: StashEntry | undefined): entry is StashEntry {
		return this.readable(entry) && (entry.meta.state === "open" || entry.meta.state === "active") && !this.deps.stale;
	}

	private mutable(entry: StashEntry | undefined): entry is StashEntry {
		return this.readable(entry) && !this.deps.stale;
	}

	private bump(): void {
		this.hits = [];
		this.cachedLines = undefined;
		this.deps.tui.requestRender();
	}

	private loadSelected(): void {
		this.previewAbort?.abort();
		const entry = this.current();
		if (!entry || !this.deps.loadPreview) return;
		const controller = new AbortController();
		const generation = ++this.previewGeneration;
		this.previewAbort = controller;
		const live = () => !this.finished && !controller.signal.aborted && generation === this.previewGeneration;
		void this.deps.loadPreview(entry, controller.signal).then(
			(loaded) => {
				if (!live() || this.current()?.meta.id !== entry.meta.id) return;
				const index = this.deps.entries.findIndex((candidate) => candidate.meta.id === entry.meta.id);
				if (index >= 0) this.deps.entries[index] = loaded;
				this.bump();
			},
			(error) => {
				if (!live()) return;
				this.notice = `Preview unavailable: ${flat(error instanceof Error ? error.message : String(error))}`;
				this.bump();
			},
		);
	}

	private select(index: number): void {
		this.selected = Math.max(0, Math.min(this.filtered.length - 1, index));
		this.previewScroll = 0;
		this.loadSelected();
		this.bump();
	}

	private finish(result: StashPanelResult): void {
		const state = {
			filter: this.filter,
			selectedId: this.current()?.meta.id,
			selectedIndex: this.selected,
			previewScroll: this.previewScroll,
			detail: this.detail,
		};
		this.dispose();
		this.deps.done({ ...state, ...result });
	}

	private copy(entry: StashEntry): void {
		if (this.copying) return;
		this.copying = true;
		this.notice = "copying…";
		this.bump();
		void this.deps.copyResume(entry).then(
			() => this.copyNotice("copied ✓"),
			() => this.copyNotice("clipboard copy failed"),
		);
	}

	private copyNotice(notice: string): void {
		this.copying = false;
		if (this.finished) return;
		this.notice = notice;
		this.bump();
		this.copyNoticeTimer = setTimeout(() => {
			this.notice = "";
			this.bump();
		}, 1600);
		this.copyNoticeTimer.unref?.();
	}

	private emptyText(): string {
		if (this.deps.scope === "archive") {
			return "No matches on this page. Coverage above says whether more pages remain; Continue reads them.";
		}
		return this.deps.entries.length ? "No matching stashes." : "No stashes yet. Create one with stash_write.";
	}

	private detailSource(width: number): string[] {
		const entry = this.current();
		if (!entry) return [this.emptyText()];
		const head = headLines(entry);
		return [this.deps.theme.bold(head[0]), ...head.slice(1), "", ...bodyLines(entry, this.deps.theme, width)];
	}

	private helpSource(width: number): string[] {
		return HELP_PARAGRAPHS.flatMap((value) => wrapTextWithAnsi(value, Math.max(8, width)));
	}

	private pageSource(): string[] {
		if (this.help) return this.helpSource(Math.max(8, this.lastWidth - 4));
		const width = this.split ? this.lastWidth - 4 - this.listWidth - 3 : this.lastWidth - 4;
		return this.detailSource(Math.max(1, width));
	}

	private page(delta: number): void {
		const amount = Math.max(1, this.bodyRows);
		const max = Math.max(0, this.pageSource().length - amount);
		const scroll = (this.help ? this.helpScroll : this.previewScroll) + delta * amount;
		const next = Math.max(0, Math.min(max, scroll));
		if (this.help) this.helpScroll = next;
		else this.previewScroll = next;
		this.bump();
	}

	private show(detail: boolean): void {
		this.help = false;
		this.helpScroll = 0;
		this.detail = detail;
		this.bump();
	}

	private toggleHelp(): void {
		this.help = !this.help;
		this.helpScroll = 0;
		this.bump();
	}

	private pageAction(action: PanelAction): void {
		if (!this.help && !this.split) this.detail = true;
		this.page(action === "pageUp" ? -1 : 1);
	}

	/** Pickup and note act only where the store would accept activation; a closed record opens the actions dialog instead. */
	private pickAction(action: "pickup" | "note", entry: StashEntry | undefined): void {
		if (this.pickable(entry)) this.finish(action === "pickup" ? { selected: entry } : { note: entry });
		else if (this.mutable(entry)) this.finish({ manage: entry });
	}

	private lifecycleAction(action: PanelAction, entry: StashEntry | undefined): void {
		if (action === "pickup" || action === "note") this.pickAction(action, entry);
		else if (action === "complete" && this.mutable(entry) && entry.meta.state === "active") this.finish({ complete: entry });
		else if (action === "manage" && this.mutable(entry)) this.finish({ manage: entry });
		else if (action === "copy" && entry) this.copy(entry);
	}

	private act(action: PanelAction): void {
		if (this.finished) return;
		if (action === "close") this.finish({});
		else if (action === "previous" || action === "next") this.select(this.selected + (action === "previous" ? -1 : 1));
		else if (action === "detail" || action === "back") this.show(action === "detail");
		else if (action === "filter") {
			this.filtering = true;
			this.bump();
		} else if (NAVIGATIONS.has(action)) this.finish({ navigation: action as "recent" | "search" | "continue" | "refresh" });
		else if (action === "help") this.toggleHelp();
		else if (action === "pageUp" || action === "pageDown") this.pageAction(action);
		else this.lifecycleAction(action, this.current());
	}

	private filterInput(raw: string, data: string): void {
		if (matchesKey(raw, "escape") || matchesKey(raw, "enter")) this.filtering = false;
		else if (matchesKey(raw, "backspace")) {
			this.filter = Array.from(this.filter).slice(0, -1).join("");
			this.select(0);
		} else if (matchesKey(raw, "up") || matchesKey(raw, "down")) this.select(this.selected + (matchesKey(raw, "up") ? -1 : 1));
		else if (!matchesKey(raw, "ctrl+c") && /^[\p{L}\p{N}\p{P}\p{S} ]+$/u.test(data)) {
			this.filter += data;
			this.select(0);
		} else return;
		this.bump();
	}

	private helpInput(raw: string, data: string): void {
		if (data === "h") this.act("help");
		else if (matchesKey(raw, "up") || data === "b") this.act("pageUp");
		else if (matchesKey(raw, "down") || data === " ") this.act("pageDown");
	}

	handleInput(raw: string): void {
		if (this.finished) return;
		// A terminal that negotiated the Kitty keyboard protocol sends CSI-u for
		// every key, printable ones included; decode first or typed text and letter
		// commands vanish.
		const data = decodeKittyPrintable(raw) ?? raw;
		if (this.filtering) this.filterInput(raw, data);
		else if (matchesKey(raw, "escape")) this.act(this.help || this.detail ? "back" : "close");
		else if (this.help) this.helpInput(raw, data);
		else if (matchesKey(raw, "up")) this.act("previous");
		else if (matchesKey(raw, "down")) this.act("next");
		else if (matchesKey(raw, "enter")) this.act("pickup");
		else if (matchesKey(raw, "tab")) this.act("manage");
		else if (KEYS[data]) this.act(KEYS[data]);
	}

	private geometryCurrent(event: TuiMouseEvent): boolean {
		return !!this.cachedLines && event.width === this.lastWidth && this.lastRows === this.deps.getMaxRows();
	}

	private wheel(event: TuiMouseEvent): boolean {
		if (event.y < this.bodyTop || event.y >= this.bodyTop + this.bodyRows) return false;
		const delta = Math.sign(event.wheelDelta ?? 0);
		const overList = !this.split || event.x < this.listWidth + 2;
		if (!this.help && !this.detail && overList) this.scrollList(delta * 3);
		else this.page(delta);
		return true;
	}

	private clickHit(event: TuiMouseEvent): boolean {
		const hit = this.hits.find((region) => event.y === region.y && event.x >= region.x && event.x < region.x + region.width);
		if (!hit) return false;
		if (hit.id !== undefined) {
			const index = this.filtered.findIndex((entry) => entry.meta.id === hit.id);
			if (index >= 0) this.select(index);
		} else if (hit.action) this.act(hit.action);
		return true;
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (this.finished) return undefined;
		if (!this.geometryCurrent(event)) {
			this.hits = [];
			return undefined;
		}
		if (event.type === "wheel") return this.wheel(event) ? { handled: true } : undefined;
		if (event.type !== "click" || event.button !== "left") return undefined;
		return this.clickHit(event) ? { handled: true } : undefined;
	}

	private scrollList(delta: number): void {
		const visible = Math.max(1, Math.floor(this.bodyRows / (this.split ? 1 : 2)));
		const max = Math.max(0, this.filtered.length - visible);
		this.listScroll = Math.max(0, Math.min(max, this.listScroll + delta));
		this.bump();
	}

	private controlState(): ControlState {
		const entry = this.current();
		return {
			help: this.help,
			detail: this.detail,
			archive: this.deps.scope === "archive",
			stale: this.deps.stale === true,
			hasNext: !!this.deps.nextCursor,
			readable: this.readable(entry),
			pickable: this.pickable(entry),
			active: entry?.meta.state === "active",
		};
	}

	private statusText(): string {
		const current = this.current();
		if (this.notice) return this.notice;
		if (this.filtering) return `filter ${flat(this.filter)}▌ · ${this.filtered.length} match`;
		if (this.deps.stale) return "Archive changed under this query; results may be stale. Refresh restarts the search.";
		if (this.deps.coverage) return this.deps.coverage;
		if (current && !this.readable(current)) return "State unknown: no lifecycle action is offered for this record.";
		return this.filter ? `Filter: ${flat(this.filter)}` : "Select a row; labelled controls act.";
	}

	private headerText(): string {
		const entries = this.filtered;
		const position = entries.length === 0 ? "0/0" : `${this.selected + 1}/${entries.length}${this.deps.hasMore ? "+" : ""}`;
		const scope = this.deps.scope === "archive" ? `Search archive: ${flat(this.deps.query ?? "")}` : "Recent";
		return `✦ ${flat(this.deps.title)} · ${scope} · ${position}`;
	}

	private tooSmall(width: number, rows: number): string[] {
		const label = "[Close]";
		this.hits.push({ x: 0, y: rows - 1, width: label.length, action: "close" });
		return Array.from({ length: rows }, (_, index) =>
			fitText(index === rows - 1 ? label : index === 0 ? "Resize to read stashes" : "", width),
		);
	}

	private listCell(entry: StashEntry, index: number, second: boolean): string {
		if (second) {
			return `  ${stateLabel(entry.meta, entry.previewError !== undefined)} · ${projectLine(entry)}`;
		}
		return `${index === this.selected ? "›" : " "} ${entryMark(entry)} ${entryDate(entry.meta.created)} ${flat(entry.meta.title)}`;
	}

	private keepSelectionVisible(): void {
		const visible = Math.max(1, Math.floor(this.bodyRows / (this.split ? 1 : 2)));
		if (this.selected < this.listScroll) this.listScroll = this.selected;
		if (this.selected >= this.listScroll + visible) this.listScroll = this.selected - visible + 1;
	}

	private listRow(row: number, y: number, width: number, source: string[]): string {
		const entries = this.filtered;
		const index = this.listScroll + (this.split ? row : Math.floor(row / 2));
		const second = !this.split && row % 2 === 1;
		const entry = entries[index];
		if (!entry) return row === 0 && entries.length === 0 ? (source[0] ?? "") : "";
		if (!second) this.hits.push({ x: 2, y, width, id: entry.meta.id });
		return this.listCell(entry, index, second);
	}

	private bodyRow(row: number, y: number, inner: number, source: string[], offset: number, panes: { listWidth: number; previewWidth: number }): string {
		if (this.help || (!this.split && this.detail)) return source[offset + row] ?? "";
		const cell = this.listRow(row, y, this.split ? panes.listWidth : inner, source);
		if (!this.split) return cell;
		return `${fitText(cell, panes.listWidth)} │ ${fitText(source[offset + row] ?? "", panes.previewWidth)}`;
	}

	private packedControls(inner: number, rows: number): { lines: string[]; hits: HitRegion[] } {
		const ordered = controlList(this.controlState());
		if (rows < 12) ordered.sort((a, b) => Number(b[1] === "close") - Number(a[1] === "close"));
		return packControls(ordered, inner, Math.max(1, rows - 5));
	}

	render(width: number): string[] {
		const rows = Math.max(1, Math.min(44, this.deps.getMaxRows()));
		if (this.cachedLines && this.lastWidth === width && this.lastRows === this.deps.getMaxRows()) return this.cachedLines;
		this.hits = [];
		this.lastWidth = width;
		this.lastRows = this.deps.getMaxRows();
		if (width < MIN_WIDTH || rows < MIN_ROWS) {
			this.cachedLines = this.tooSmall(width, rows);
			return this.cachedLines;
		}
		const theme = this.deps.theme;
		const inner = Math.max(1, width - 4);
		const packed = this.packedControls(inner, rows);
		const showStatus = rows - packed.lines.length - 3 >= 2;
		this.bodyTop = showStatus ? 2 : 1;
		this.bodyRows = Math.max(0, rows - packed.lines.length - (showStatus ? 4 : 3));
		this.split = width >= SPLIT_MIN_WIDTH && !this.help && !this.detail;
		const panes = computePanes(inner);
		this.listWidth = panes.listWidth;
		const source = this.help ? this.helpSource(inner) : this.detailSource(this.split ? panes.previewWidth : inner);
		const offset = this.help ? this.helpScroll : this.previewScroll;
		if (!this.help) this.previewScroll = Math.min(this.previewScroll, Math.max(0, source.length - this.bodyRows));
		this.keepSelectionVisible();
		const framed = (value: string) => theme.bg("customMessageBg", `│ ${fitText(value, inner)} │`);
		const out = [fitText(`┌─ ${this.headerText()}`, width)];
		if (showStatus) out.push(framed(this.statusText()));
		for (let row = 0; row < this.bodyRows; row++) out.push(framed(this.bodyRow(row, out.length, inner, source, offset, panes)));
		for (const hit of packed.hits) this.hits.push({ ...hit, y: out.length + hit.y });
		out.push(...packed.lines.map(framed), fitText(`└${"─".repeat(Math.max(0, width - 2))}┘`, width));
		this.cachedLines = out.slice(0, rows);
		return this.cachedLines;
	}

	hide(): void {
		this.invalidate();
		this.previewAbort?.abort();
	}

	invalidate(): void {
		this.hits = [];
		this.cachedLines = undefined;
	}

	dispose(): void {
		this.finished = true;
		this.hide();
		if (this.copyNoticeTimer) clearTimeout(this.copyNoticeTimer);
		this.copyNoticeTimer = undefined;
	}
}
