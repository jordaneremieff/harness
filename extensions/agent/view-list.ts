import type { Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";
import { HitMap } from "./view-hits.ts";
import type { Action, KeyHint, View, ViewHost } from "./view-model.ts";
import { Reader, type ReaderContent } from "./view-reader.ts";
import { fitCells, plainLine } from "./view-text.ts";

/** Below this width the detail moves to its own view, opened with Enter or Right. */
const SPLIT_MIN_WIDTH = 90;

export interface ListBrowserOptions<T> {
	readonly title: string;
	readonly host: ViewHost;
	key(item: T): string;
	/** One display line for an item, without selection styling. */
	line(item: T, width: number, theme: Theme): string;
	/** Detail content for the selected item. Paint performs no read. */
	detail(item: T | undefined): ReaderContent;
	/** Actions for the selected item, re-read at every render and every invocation. */
	actions(item: T | undefined): readonly Action[];
	/** Loading, coverage, stale or error state, shown on the first row. */
	status?(): string | undefined;
	/** Shown when the list is empty, distinct from loading and failure. */
	empty?(): string;
}

type Region = "list" | "detail";

const SELECT: KeyHint = { keys: ["up", "down"], label: "select", priority: 0 };
const FOCUS: KeyHint = { keys: ["tab"], label: "focus", priority: 3 };
const READ_KEYS: readonly KeyHint[] = [
	{ keys: ["up", "down"], label: "scroll" },
	{ keys: ["pageUp", "pageDown"], label: "page" },
];

/** The detail of one item as its own view, for narrow windows. The record is re-read from the list on every use. */
class DetailView<T> implements View {
	readonly title: string;
	focused = false;
	private readonly reader = new Reader();
	private readonly hits = new HitMap();
	private readonly browser: ListBrowser<T>;
	private readonly key: string;

	constructor(browser: ListBrowser<T>, key: string, title: string) {
		this.browser = browser;
		this.key = key;
		this.title = title;
	}
	private current(): T | undefined {
		return this.browser.itemOf(this.key);
	}
	render(width: number, height: number): string[] {
		this.hits.begin(width, height);
		const item = this.current();
		if (item === undefined) {
			const text = this.browser.theme.fg("muted", "This record is no longer listed.");
			return Array.from({ length: height }, (_, row) => fitCells(row === 0 ? text : "", width));
		}
		this.reader.focused = this.focused;
		this.reader.setContent(this.browser.detailOf(item), this.key);
		return this.reader.render(width, height, this.browser.theme, this.hits, 0, 0);
	}
	handleInput(data: string): boolean {
		return this.current() === undefined ? true : this.reader.handleInput(data);
	}
	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		return this.hits.handle(event);
	}
	actions(): readonly Action[] {
		const item = this.current();
		return item === undefined ? [] : this.browser.actionsOf(item);
	}
	keys(): readonly KeyHint[] {
		return this.current() === undefined ? [] : READ_KEYS;
	}
	dispose(): void {
		this.hits.clear();
	}
}

/**
 * A list with a detail reader beside it, or the detail as its own view below `SPLIT_MIN_WIDTH`
 * columns. Selecting a row never runs an effect. Up and Down select; Right (and Enter, unless an
 * action takes Enter) opens the detail; PageUp and PageDown read the detail beside the list; Tab
 * moves between the list and the detail. Keys keep the selection visible; the wheel moves only the
 * window. A click selects, a double click opens.
 */
export class ListBrowser<T> implements View {
	readonly title: string;
	focused = false;
	private readonly options: ListBrowserOptions<T>;
	private readonly reader = new Reader();
	private readonly hits = new HitMap();
	private items: readonly T[] = [];
	private selectedKey?: string;
	private top = 0;
	private listHeight = 1;
	/** True after a wheel turn: the window stays where the operator put it until a key moves the selection. */
	private manual = false;
	private region: Region = "list";
	private split = true;
	private areas = { top: 0, listWidth: 0, height: 0 };
	/** Host of the narrow detail view that is open now; its actions push from it. */
	private detailHost?: ViewHost;

	constructor(options: ListBrowserOptions<T>) {
		this.options = options;
		this.title = options.title;
	}

	get theme(): Theme {
		return this.options.host.theme;
	}

	get selected(): T | undefined {
		return this.items.find((item) => this.options.key(item) === this.selectedKey);
	}

	private get selectedIndex(): number {
		return this.items.findIndex((item) => this.options.key(item) === this.selectedKey);
	}

	/** Replace the items, keeping the selection by identity; a vanished selection moves to the nearest item. */
	setItems(items: readonly T[]): void {
		const previousIndex = this.selectedIndex;
		const wanted = this.selectedKey;
		this.items = items;
		if (wanted !== undefined && items.some((item) => this.options.key(item) === wanted)) return;
		const fallback = items[Math.max(0, Math.min(items.length - 1, previousIndex < 0 ? 0 : previousIndex))];
		this.selectedKey = fallback === undefined ? undefined : this.options.key(fallback);
	}

	itemOf(key: string): T | undefined {
		return this.items.find((item) => this.options.key(item) === key);
	}

	/**
	 * Open a nested view from wherever this browser shows now: the narrow detail's host while that
	 * detail is open, otherwise the browser's own host, so Cancel returns to the same record.
	 */
	push(open: (host: ViewHost) => View): void {
		const host = this.detailHost && !this.detailHost.signal.aborted ? this.detailHost : this.options.host;
		host.push(open);
	}

	detailOf(item: T): ReaderContent {
		return this.options.detail(item);
	}

	actionsOf(item: T | undefined): readonly Action[] {
		return this.options.actions(item);
	}

	actions(): readonly Action[] {
		return this.options.actions(this.selected);
	}

	private select(key: string): void {
		this.selectedKey = key;
		this.manual = false;
	}

	private move(delta: number): void {
		if (!this.items.length) return;
		const index = this.selectedIndex;
		const item = this.items[Math.max(0, Math.min(this.items.length - 1, (index < 0 ? 0 : index) + delta))];
		if (item !== undefined) this.select(this.options.key(item));
	}

	private scroll(delta: number): void {
		this.manual = true;
		this.top = Math.max(0, Math.min(Math.max(0, this.items.length - this.listHeight), this.top + delta));
	}

	private open(item: T): void {
		if (this.split) {
			this.region = "detail";
			return;
		}
		const key = this.options.key(item);
		const title = plainLine(this.options.line(item, 60, this.theme)).slice(0, 48);
		this.options.host.push((child) => {
			this.detailHost = child;
			return new DetailView(this, key, title || "Detail");
		});
	}

	focusNext(backward: boolean): boolean {
		if (!this.split) return false;
		const next: Region = backward ? "list" : "detail";
		if (next === this.region) return false;
		this.region = next;
		return true;
	}

	focusEdge(backward: boolean): void {
		this.region = backward && this.split ? "detail" : "list";
	}

	/** Escape leaves the detail for the list. */
	escape(): boolean {
		if (this.region === "list") return false;
		this.region = "list";
		return true;
	}

	keys(): readonly KeyHint[] {
		if (this.region === "detail") return [...READ_KEYS, FOCUS, { keys: ["escape"], label: "list" }];
		// When the row is short, Tab leaves first, then the detail and paging keys.
		const hints: KeyHint[] = [SELECT, { keys: ["pageUp", "pageDown"], label: this.split ? "read" : "page" }];
		if (this.selected !== undefined) {
			const enterTaken = this.actions().some((action) => action.key === "enter");
			hints.push({ keys: [enterTaken ? "right" : "enter"], label: this.split ? "detail" : "open" });
		}
		hints.push(FOCUS);
		return hints;
	}

	handleInput(data: string): boolean {
		if (this.region === "detail") return this.reader.handleInput(data);
		if (matchesKey(data, "right")) {
			const item = this.selected;
			if (item !== undefined) this.open(item);
			return true;
		}
		// Beside the list, PageUp and PageDown read the detail; the selection stays.
		if (this.split && (matchesKey(data, "pageUp") || matchesKey(data, "pageDown")))
			return this.reader.handleInput(data);
		return this.listInput(data);
	}

	private listInput(data: string): boolean {
		const page = Math.max(1, this.listHeight - 1);
		const steps: Array<[string, number]> = [
			["up", -1],
			["down", 1],
			["pageUp", -page],
			["pageDown", page],
			["home", -this.items.length],
			["end", this.items.length],
		];
		const step = steps.find(([key]) => matchesKey(data, key as "up"));
		if (step) {
			this.move(step[1]);
			return true;
		}
		if (!matchesKey(data, "enter")) return false;
		const item = this.selected;
		if (item !== undefined) this.open(item);
		return true;
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		const { top, listWidth, height } = this.areas;
		const result = this.hits.handle(event);
		// The focused region follows only an accepted click, so a declined, modified or stale event changes nothing.
		if (result?.handled && event.type === "click" && event.y >= top && event.y < top + height) {
			this.region = event.x < listWidth || !this.split ? "list" : "detail";
		}
		return result;
	}

	render(width: number, height: number): string[] {
		const theme = this.theme;
		this.hits.begin(width, height);
		this.split = width >= SPLIT_MIN_WIDTH;
		if (!this.split && this.region === "detail") this.region = "list";
		this.reader.focused = this.focused && this.region === "detail";
		const status = this.options.status?.();
		const lines = [
			fitCells(theme.bold(plainLine(this.title)), width),
			fitCells(status ? theme.fg("muted", plainLine(status)) : "", width),
		];
		const bodyHeight = Math.max(1, height - lines.length);
		const listWidth = this.split ? Math.max(30, Math.min(64, Math.floor(width * 0.42))) : width;
		this.areas = { top: lines.length, listWidth, height: bodyHeight };
		const listLines = this.renderList(listWidth, bodyHeight, lines.length, theme);
		if (!this.split) return [...lines, ...listLines];
		return [...lines, ...this.renderSplit(listLines, listWidth, bodyHeight, lines.length, width, height, theme)];
	}

	private renderList(width: number, height: number, y0: number, theme: Theme): string[] {
		this.hits.add({ x: 0, y: y0, width, height, click: () => ({ handled: true, focus: true }) });
		if (this.items.length === 0) {
			const empty = this.options.empty?.() ?? "Nothing here.";
			return Array.from({ length: height }, (_, row) =>
				fitCells(row === 0 ? theme.fg("muted", plainLine(empty)) : "", width),
			);
		}
		this.listHeight = Math.max(1, height);
		this.reveal();
		const focused = this.focused && this.region === "list";
		const lines: string[] = [];
		for (let row = 0; row < this.listHeight; row++) {
			const item = this.items[this.top + row];
			if (item === undefined) {
				lines.push(fitCells("", width));
				continue;
			}
			const key = this.options.key(item);
			const selected = key === this.selectedKey;
			const text = `${selected && focused ? theme.fg("accent", "›") : " "}${this.options.line(item, Math.max(1, width - 1), theme)}`;
			lines.push(selected ? theme.bg("selectedBg", fitCells(text, width)) : fitCells(text, width));
			this.hits.add({
				x: 0,
				y: y0 + row,
				width,
				height: 1,
				click: (event) => {
					this.select(key);
					if ((event.clickCount ?? 1) >= 2) this.open(item);
					return { handled: true, focus: true };
				},
			});
		}
		this.hits.add({ x: 0, y: y0, width, height: this.listHeight, wheel: (delta) => this.scroll(delta) });
		return lines;
	}

	/** Keep the selection inside the window unless the wheel moved the window since the last key. */
	private reveal(): void {
		this.top = Math.max(0, Math.min(Math.max(0, this.items.length - this.listHeight), this.top));
		const index = this.selectedIndex;
		if (this.manual || index < 0) return;
		if (index < this.top) this.top = index;
		if (index >= this.top + this.listHeight) this.top = index - this.listHeight + 1;
	}

	private renderSplit(
		listLines: readonly string[],
		listWidth: number,
		bodyHeight: number,
		top: number,
		width: number,
		height: number,
		theme: Theme,
	): string[] {
		const detailWidth = Math.max(1, width - listWidth - 1);
		const selected = this.selected;
		this.reader.setContent(
			this.options.detail(selected),
			selected === undefined ? undefined : this.options.key(selected),
		);
		const readerHits = new HitMap();
		readerHits.begin(width, height);
		const detail = this.reader.render(detailWidth, bodyHeight, theme, readerHits, listWidth + 1, top);
		this.hits.add({
			x: listWidth + 1,
			y: top,
			width: detailWidth,
			height: bodyHeight,
			click: () => ({ handled: true, focus: true }),
		});
		this.hits.include(readerHits, 0, 0);
		const divider = theme.fg(this.focused && this.region === "detail" ? "accent" : "borderMuted", "│");
		return Array.from(
			{ length: bodyHeight },
			(_, row) => `${fitCells(listLines[row] ?? "", listWidth)}${divider}${fitCells(detail[row] ?? "", detailWidth)}`,
		);
	}

	invalidate(): void {
		this.hits.clear();
	}
}
