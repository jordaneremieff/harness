import type { Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";
import { TextField } from "./field.ts";
import { HitMap } from "./hits.ts";
import { keyMatches } from "./keys.ts";
import { ListView } from "./list.ts";
import { Reader, type ReaderContent } from "./reader.ts";
import { fitLine, plainLine, visibleWidth } from "./text.ts";
import type { Action, KeyHint, OperatorView, ViewHost } from "./view.ts";

/** Below this width the detail moves to its own view, opened with Enter or Right. */
export const SPLIT_MIN_WIDTH = 90;

export interface Scope {
	readonly id: string;
	readonly label: string;
}

export interface BrowserOptions<T> {
	readonly title: string;
	readonly host: ViewHost;
	key(item: T): string;
	line(item: T, width: number, theme: Theme): string;
	/** Detail content for the selected item; a placeholder while its read runs. Paint performs no read. */
	detail(item: T | undefined): ReaderContent;
	/** Identity of the detail content; the reading position stays while it is unchanged. */
	detailKey?(item: T): string;
	/** Actions for the selected item, re-read at every render and every invocation. */
	actions(item: T | undefined): readonly Action[];
	readonly scopes?: readonly Scope[];
	/** The active scope, read at every render. */
	scope?(): string | undefined;
	onScope?(id: string): void;
	readonly search?: {
		readonly label?: string;
		readonly placeholder?: string | (() => string);
		readonly value?: string;
		change(query: string): void;
		/** Enter in the field, for searches that run only on request. Enter then returns to the list. */
		submit?(query: string): void;
		/** What Enter in the field does now, for the footer, for example "search". Default "done". */
		submitLabel?(): string | undefined;
	};
	/** Loading, coverage, stale or error state, shown under the search row. */
	status?(): string | undefined;
	/** Shown when the list is empty, distinct from loading and failure. */
	empty?(): string;
	onSelect?(item: T | undefined): void;
}

type Region = "search" | "scopes" | "list" | "detail";

const SELECT: KeyHint = { keys: ["up", "down"], label: "select", priority: 0 };
const FOCUS: KeyHint = { keys: ["tab"], label: "focus", priority: 3 };

/** A detail of one item as its own view, for narrow windows. */
class DetailView<T> implements OperatorView {
	readonly title: string;
	focused = false;
	private readonly reader = new Reader();
	private readonly hits = new HitMap();
	private readonly browser: Browser<T>;
	/** The item's key: the record is re-resolved from the browser's list on every use. */
	private readonly key: string;
	constructor(browser: Browser<T>, key: string, title: string) {
		this.browser = browser;
		this.key = key;
		this.title = title;
	}
	/** The listed record this detail shows, or undefined once the key is no longer listed. */
	private current(): T | undefined {
		return this.browser.itemOf(this.key);
	}
	render(width: number, height: number): string[] {
		this.hits.begin(width, height);
		const item = this.current();
		if (item === undefined) {
			const text = this.browser.theme.fg("muted", "This record is no longer listed.");
			return Array.from({ length: height }, (_, row) => fitLine(row === 0 ? text : "", width));
		}
		this.reader.focused = this.focused;
		this.reader.setContent(this.browser.detailOf(item), this.browser.detailKeyOf(item));
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
		if (this.current() === undefined) return [];
		return [
			{ keys: ["up", "down"], label: "scroll" },
			{ keys: ["pageUp", "pageDown"], label: "page" },
		];
	}
	dispose(): void {
		this.hits.clear();
	}
}

/**
 * Search, scopes, a list and a detail reader as one view. Selecting a row never runs an effect.
 * Up and Down select; `/` focuses the search field, which keeps every printable key as text;
 * Right (and Enter, unless an owner action takes Enter) opens the detail: focus at wide widths,
 * a nested view at narrow widths. PageUp and PageDown read the detail beside the list. Query,
 * scope, selection and reading position stay with the view.
 */
export class Browser<T> implements OperatorView {
	readonly title: string;
	focused = false;
	private readonly options: BrowserOptions<T>;
	private readonly list: ListView<T>;
	private readonly reader = new Reader();
	private readonly search?: TextField;
	private readonly hits = new HitMap();
	private region: Region;
	private split = true;
	private areas = { top: 0, listWidth: 0, height: 0 };
	/** Host of the narrow detail view that is open now; its actions push from it. */
	private detailHost?: ViewHost;

	constructor(options: BrowserOptions<T>) {
		this.options = options;
		this.title = options.title;
		this.list = new ListView<T>({
			key: options.key,
			line: options.line,
			onSelect: (item) => options.onSelect?.(item),
			onOpen: (item) => this.open(item),
		});
		if (options.search) this.search = new TextField(options.search.label ?? "Search", options.search.value ?? "", (value) => options.search?.change(value));
		this.region = "list";
	}

	get theme(): Theme {
		return this.options.host.theme;
	}

	get selected(): T | undefined {
		return this.list.selected;
	}

	get query(): string {
		return this.search?.value ?? "";
	}

	setItems(items: readonly T[], prefer?: string): void {
		this.list.setItems(items, prefer);
	}

	select(key: string | undefined): void {
		this.list.select(key);
	}

	/** The listed item of one key, or undefined when that key is no longer listed. */
	itemOf(key: string): T | undefined {
		return this.list.entries().find((item) => this.options.key(item) === key);
	}

	/**
	 * Open a nested view from wherever this browser shows now: the narrow detail's host while that
	 * detail is open, otherwise the browser's own host. Item actions use this, so a form opens from
	 * the visible detail and Cancel returns to the same record.
	 */
	push(open: (host: ViewHost) => OperatorView): void {
		const host = this.detailHost && !this.detailHost.signal.aborted ? this.detailHost : this.options.host;
		host.push(open);
	}

	detailOf(item: T): ReaderContent {
		return this.options.detail(item);
	}

	detailKeyOf(item: T): string {
		return this.options.detailKey?.(item) ?? this.options.key(item);
	}

	actionsOf(item: T | undefined): readonly Action[] {
		return this.options.actions(item);
	}

	actions(): readonly Action[] {
		return this.options.actions(this.list.selected);
	}

	editing(): boolean {
		return this.region === "search";
	}

	private open(item: T): void {
		if (this.split) {
			this.region = "detail";
			return;
		}
		const key = this.options.key(item);
		const title = plainLine(this.options.line(item, 60, this.theme)).slice(0, 48);
		this.options.host.push((child) => {
			const view = new DetailView(this, key, title || "Detail");
			this.detailHost = child;
			return view;
		});
	}

	private regions(): Region[] {
		const order: Region[] = [];
		if (this.search) order.push("search");
		if (this.options.scopes?.length) order.push("scopes");
		order.push("list");
		if (this.split) order.push("detail");
		return order;
	}

	focusNext(backward: boolean): boolean {
		const order = this.regions();
		const next = order.indexOf(this.region) + (backward ? -1 : 1);
		if (next < 0 || next >= order.length) return false;
		this.region = order[next] ?? this.region;
		return true;
	}

	focusEdge(backward: boolean): void {
		const order = this.regions();
		this.region = (backward ? order.at(-1) : order.includes("list") ? "list" : order[0]) ?? "list";
	}

	/** Escape clears a search edit, then leaves the search field, the scope row or the detail for the list. */
	escape(): boolean {
		if (this.region === "search" && this.search?.value) {
			this.search.value = "";
			this.options.search?.change("");
			return true;
		}
		if (this.region === "list") return false;
		this.region = "list";
		return true;
	}

	/** The keys of the focused region, for the footer. Owner actions follow them there. */
	keys(): readonly KeyHint[] {
		if (this.region === "search") {
			return [SELECT, { keys: ["enter"], label: this.options.search?.submitLabel?.() ?? "done" }, FOCUS, { keys: ["escape"], label: this.search?.value ? "clear" : "list" }];
		}
		if (this.region === "scopes") return [{ keys: ["left", "right"], label: "switch" }, { keys: ["enter"], label: "list" }, FOCUS, { keys: ["escape"], label: "list" }];
		if (this.region === "detail") return [{ keys: ["up", "down"], label: "scroll" }, { keys: ["pageUp", "pageDown"], label: "page" }, FOCUS, { keys: ["escape"], label: "list" }];
		// When the row is short, Tab leaves first, then the detail and paging keys; search stays with the actions.
		const hints: KeyHint[] = [SELECT, { keys: ["pageUp", "pageDown"], label: this.split ? "read" : "page" }];
		if (this.search) hints.push({ keys: ["/"], label: plainLine(this.options.search?.label ?? "Search").toLocaleLowerCase(), priority: 1 });
		if (this.list.selected !== undefined) {
			const enterTaken = this.actions().some((action) => action.key === "enter");
			hints.push({ keys: [enterTaken ? "right" : "enter"], label: this.split ? "detail" : "open" });
		}
		hints.push(FOCUS);
		return hints;
	}

	private switchScope(delta: number): void {
		const scopes = this.options.scopes ?? [];
		const index = scopes.findIndex((scope) => scope.id === this.options.scope?.());
		const next = scopes[Math.max(0, Math.min(scopes.length - 1, index + delta))];
		if (next && next.id !== this.options.scope?.()) this.options.onScope?.(next.id);
	}

	handleInput(data: string): boolean {
		if (this.region === "search") return this.searchInput(data);
		if (this.region === "scopes") return this.scopeInput(data);
		if (this.region === "detail") return this.reader.handleInput(data);
		return this.listInput(data);
	}

	private listInput(data: string): boolean {
		if (this.search && keyMatches(data, "/")) {
			this.region = "search";
			return true;
		}
		if (matchesKey(data, "right")) {
			const item = this.list.selected;
			if (item !== undefined) this.open(item);
			return true;
		}
		// Beside the list, PageUp and PageDown read the detail; the selection stays.
		if (this.split && (matchesKey(data, "pageUp") || matchesKey(data, "pageDown"))) return this.reader.handleInput(data);
		return this.list.handleInput(data);
	}

	private searchInput(data: string): boolean {
		if (!this.search) {
			this.region = "list";
			return true;
		}
		if (matchesKey(data, "up") || matchesKey(data, "down")) {
			this.list.move(matchesKey(data, "up") ? -1 : 1);
			return true;
		}
		if (matchesKey(data, "enter")) {
			this.options.search?.submit?.(this.search.value);
			this.region = "list";
			return true;
		}
		return this.search.handleInput(data);
	}

	/** Put the query in the visible field, for example when an owner restores retained state. */
	setQuery(query: string): void {
		if (this.search) this.search.value = query;
	}

	private scopeInput(data: string): boolean {
		if (matchesKey(data, "left") || matchesKey(data, "right")) {
			this.switchScope(matchesKey(data, "left") ? -1 : 1);
			return true;
		}
		if (matchesKey(data, "down") || matchesKey(data, "enter")) {
			this.region = "list";
			return true;
		}
		return false;
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		const { top, listWidth, height } = this.areas;
		const result = this.hits.handle(event);
		// The focused region follows only an accepted click, so a declined, modified or stale event
		// changes nothing.
		if (result?.handled && event.type === "click" && event.y >= top && event.y < top + height) {
			this.region = event.x < listWidth || !this.split ? "list" : "detail";
		}
		return result;
	}

	private placeholder(): string {
		const value = this.options.search?.placeholder;
		const text = (typeof value === "function" ? value() : value) ?? "";
		return text ? `/ ${text}` : "/ to search";
	}

	private renderHeader(width: number, theme: Theme): string {
		const scopes = this.options.scopes ?? [];
		const scopeText = scopes.map((scope) => {
			const active = scope.id === this.options.scope?.();
			const label = ` ${plainLine(scope.label)} `;
			const styled = active ? theme.bold(theme.fg("accent", label)) : theme.fg("muted", label);
			return this.focused && this.region === "scopes" && active ? theme.bg("selectedBg", styled) : styled;
		});
		const scopeWidth = scopes.reduce((total, scope) => total + visibleWidth(` ${plainLine(scope.label)} `) + 1, 0);
		const room = Math.max(10, width - scopeWidth - 1);
		if (this.search) {
			this.search.focused = this.focused && this.region === "search";
			this.hits.add({
				x: 0,
				y: 0,
				width: room,
				height: 1,
				click: (event) => {
					this.region = "search";
					return { ...this.search?.handleMouse(event, 8), handled: true, focus: true };
				},
			});
		}
		let x = room + 1;
		scopes.forEach((scope) => {
			const w = visibleWidth(` ${plainLine(scope.label)} `);
			this.hits.add({ x, y: 0, width: w, height: 1, click: () => this.options.onScope?.(scope.id) });
			x += w + 1;
		});
		const left = this.search ? this.search.render(room, theme, 8, this.placeholder()) : fitLine(theme.bold(plainLine(this.title)), room);
		return `${fitLine(left, room)} ${scopeText.join(" ")}`;
	}

	render(width: number, height: number): string[] {
		const theme = this.theme;
		this.hits.begin(width, height);
		this.split = width >= SPLIT_MIN_WIDTH;
		if (!this.split && this.region === "detail") this.region = "list";
		this.list.focused = this.focused && this.region === "list";
		this.reader.focused = this.focused && this.region === "detail";
		const lines = [fitLine(this.renderHeader(width, theme), width)];
		const status = this.options.status?.();
		lines.push(fitLine(status ? theme.fg("muted", plainLine(status)) : "", width));
		const bodyHeight = Math.max(1, height - lines.length);
		const listWidth = this.split ? Math.max(30, Math.min(64, Math.floor(width * 0.42))) : width;
		this.areas = { top: lines.length, listWidth, height: bodyHeight };
		const listLines = this.renderList(listWidth, bodyHeight, lines.length, width, height, theme);
		if (!this.split) return [...lines, ...listLines];
		return [...lines, ...this.renderSplit(listLines, listWidth, bodyHeight, lines.length, width, height, theme)];
	}

	private renderList(listWidth: number, bodyHeight: number, top: number, width: number, height: number, theme: Theme): string[] {
		this.hits.add({ x: 0, y: top, width: listWidth, height: bodyHeight, click: () => ({ handled: true, focus: true }) });
		if (this.list.length === 0) {
			const empty = this.options.empty?.() ?? "Nothing here.";
			return Array.from({ length: bodyHeight }, (_, row) => fitLine(row === 0 ? theme.fg("muted", plainLine(empty)) : "", listWidth));
		}
		const listHits = new HitMap();
		listHits.begin(width, height);
		const lines = this.list.render(listWidth, bodyHeight, theme, listHits, 0, top);
		this.hits.include(listHits, 0, 0);
		return lines;
	}

	private renderSplit(listLines: readonly string[], listWidth: number, bodyHeight: number, top: number, width: number, height: number, theme: Theme): string[] {
		const lines: string[] = [];
		const detailWidth = Math.max(1, width - listWidth - 1);
		const selected = this.list.selected;
		this.reader.setContent(this.options.detail(selected), selected === undefined ? undefined : this.detailKeyOf(selected));
		const readerHits = new HitMap();
		readerHits.begin(width, height);
		const detail = this.reader.render(detailWidth, bodyHeight, theme, readerHits, listWidth + 1, top);
		this.hits.add({ x: listWidth + 1, y: top, width: detailWidth, height: bodyHeight, click: () => ({ handled: true, focus: true }) });
		this.hits.include(readerHits, 0, 0);
		const divider = theme.fg(this.focused && this.region === "detail" ? "accent" : "borderMuted", "│");
		for (let row = 0; row < bodyHeight; row++) lines.push(`${fitLine(listLines[row] ?? "", listWidth)}${divider}${fitLine(detail[row] ?? "", detailWidth)}`);
		return lines;
	}

	invalidate(): void {
		this.hits.clear();
	}
}
