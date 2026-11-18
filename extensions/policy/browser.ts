import type { Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, type TuiMouseEvent, type TuiMouseEventResult, visibleWidth } from "@earendil-works/pi-tui";
import { TextField } from "./fields.ts";
import { HitMap } from "./hits.ts";
import { keyMatches } from "./frame.ts";
import { ListView } from "./record-list.ts";
import { Reader } from "./reader.ts";
import { fitLine, plainLine } from "./frame.ts";
import type { Action, KeyHint, View, ViewHost } from "./frame.ts";

/** Below this width the detail moves to its own view, opened with Enter or Right. */
const SPLIT_MIN_WIDTH = 90;

interface Scope {
	readonly id: string;
	readonly label: string;
}

interface BrowserOptions<T> {
	readonly title: string;
	readonly host: ViewHost;
	key(item: T): string;
	line(item: T, width: number, theme: Theme): string;
	/** Detail content for the selected item; a placeholder while its read runs. Paint performs no read. */
	detail(item: T | undefined): string;
	/** Identity of the detail content; the reading position stays while it is unchanged. */
	detailKey(item: T): string;
	/** Actions for the selected item, re-read at every render and every invocation. */
	actions(item: T | undefined): readonly Action[];
	readonly scopes: readonly Scope[];
	/** The active scope, read at every render. */
	scope(): string;
	onScope(id: string): void;
	readonly search: {
		readonly placeholder: string;
		readonly value: string;
		change(query: string): void;
	};
	/** Loading, coverage, stale or error state, shown under the search row. */
	status(): string;
	/** Shown when the list is empty, distinct from loading and failure. */
	empty(): string;
	onSelect(item: T | undefined): void;
}

type Region = "search" | "scopes" | "list" | "detail";

const SELECT: KeyHint = { keys: ["up", "down"], label: "select", priority: 0 };
const FOCUS: KeyHint = { keys: ["tab"], label: "focus", priority: 3 };
const SEARCH: KeyHint = { keys: ["/"], label: "search", priority: 1 };

/** A detail of one item as its own view, for narrow windows. */
class DetailView<T> implements View {
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
export class Browser<T> implements View {
	readonly title: string;
	focused = false;
	private readonly options: BrowserOptions<T>;
	private readonly list: ListView<T>;
	private readonly reader = new Reader();
	private readonly search: TextField;
	private readonly hits = new HitMap();
	private region: Region;
	private split = true;
	/** Host of the narrow detail view that is open now; its actions push from it. */
	private detailHost?: ViewHost;

	constructor(options: BrowserOptions<T>) {
		this.options = options;
		this.title = options.title;
		this.list = new ListView<T>({
			key: options.key,
			line: options.line,
			onSelect: options.onSelect,
			onOpen: (item) => this.open(item),
		});
		this.search = new TextField("Search", options.search.value, options.search.change);
		this.region = "list";
	}

	get theme(): Theme {
		return this.options.host.theme;
	}

	get selected(): T | undefined {
		return this.list.selected;
	}

	setItems(items: readonly T[], prefer?: string): void {
		this.list.setItems(items, prefer);
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
	push(open: (host: ViewHost) => View): void {
		const host = this.detailHost && !this.detailHost.signal.aborted ? this.detailHost : this.options.host;
		host.push(open);
	}

	detailOf(item: T): string {
		return this.options.detail(item);
	}

	detailKeyOf(item: T): string {
		return this.options.detailKey(item);
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
		const order: Region[] = ["search", "scopes", "list"];
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
		this.region = backward ? (order.at(-1) ?? "list") : "list";
	}

	/** Escape clears a search edit, then leaves the search field, the scope row or the detail for the list. */
	escape(): boolean {
		if (this.region === "search" && this.search.value) {
			this.search.value = "";
			this.options.search.change("");
			return true;
		}
		if (this.region === "list") return false;
		this.region = "list";
		return true;
	}

	/** The keys of the focused region, for the footer. Owner actions follow them there. */
	keys(): readonly KeyHint[] {
		if (this.region === "search") {
			return [
				SELECT,
				{ keys: ["enter"], label: "done" },
				FOCUS,
				{ keys: ["escape"], label: this.search.value ? "clear" : "list" },
			];
		}
		if (this.region === "scopes")
			return [
				{ keys: ["left", "right"], label: "switch" },
				{ keys: ["enter"], label: "list" },
				SEARCH,
				FOCUS,
				{ keys: ["escape"], label: "list" },
			];
		if (this.region === "detail")
			return [
				{ keys: ["up", "down"], label: "scroll" },
				{ keys: ["pageUp", "pageDown"], label: "page" },
				SEARCH,
				FOCUS,
				{ keys: ["escape"], label: "list" },
			];
		// When the row is short, Tab leaves first, then the detail and paging keys; search stays with the actions.
		const hints: KeyHint[] = [SELECT, { keys: ["pageUp", "pageDown"], label: this.split ? "read" : "page" }];
		hints.push(SEARCH);
		if (this.list.selected !== undefined) {
			const enterTaken = this.actions().some((action) => action.key === "enter");
			hints.push({ keys: [enterTaken ? "right" : "enter"], label: this.split ? "detail" : "open" });
		}
		hints.push(FOCUS);
		return hints;
	}

	private switchScope(delta: number): void {
		const scopes = this.options.scopes;
		const index = scopes.findIndex((scope) => scope.id === this.options.scope());
		const next = scopes[Math.max(0, Math.min(scopes.length - 1, index + delta))];
		if (next && next.id !== this.options.scope()) this.options.onScope(next.id);
	}

	handleInput(data: string): boolean {
		if (this.region === "search") return this.searchInput(data);
		if (keyMatches(data, "/")) {
			this.region = "search";
			return true;
		}
		if (this.region === "scopes") return this.scopeInput(data);
		if (this.region === "detail") return this.reader.handleInput(data);
		return this.listInput(data);
	}

	private listInput(data: string): boolean {
		if (matchesKey(data, "right")) {
			const item = this.list.selected;
			if (item !== undefined) this.open(item);
			return true;
		}
		// Beside the list, PageUp and PageDown read the detail; the selection stays.
		if (this.split && (matchesKey(data, "pageUp") || matchesKey(data, "pageDown")))
			return this.reader.handleInput(data);
		return this.list.handleInput(data);
	}

	private searchInput(data: string): boolean {
		if (matchesKey(data, "up") || matchesKey(data, "down")) {
			this.list.move(matchesKey(data, "up") ? -1 : 1);
			return true;
		}
		if (matchesKey(data, "enter")) {
			this.region = "list";
			return true;
		}
		return this.search.handleInput(data);
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
		return this.hits.handle(event);
	}

	private renderHeader(width: number, theme: Theme): string {
		const scopes = this.options.scopes;
		const scopeText = scopes.map((scope) => {
			const active = scope.id === this.options.scope();
			const label = ` ${plainLine(scope.label)} `;
			const styled = active ? theme.bold(theme.fg("accent", label)) : theme.fg("muted", label);
			return this.focused && this.region === "scopes" && active ? theme.bg("selectedBg", styled) : styled;
		});
		const scopeWidth = scopes.reduce((total, scope) => total + visibleWidth(` ${plainLine(scope.label)} `) + 1, 0);
		const room = Math.max(10, width - scopeWidth - 1);
		this.search.focused = this.focused && this.region === "search";
		this.hits.add({
			x: 0,
			y: 0,
			width: room,
			height: 1,
			click: (event) => {
				this.region = "search";
				return { ...this.search.handleMouse(event, 8), handled: true, focus: true };
			},
		});
		let x = room + 1;
		scopes.forEach((scope) => {
			const w = visibleWidth(` ${plainLine(scope.label)} `);
			this.hits.add({ x, y: 0, width: w, height: 1, click: () => this.options.onScope(scope.id) });
			x += w + 1;
		});
		const left = this.search.render(room, theme, 8, `/ ${this.options.search.placeholder}`);
		return `${fitLine(left, room)} ${scopeText.join(" ")}`;
	}

	render(width: number, height: number): string[] {
		const theme = this.theme;
		this.hits.begin(width, height);
		this.split = width >= SPLIT_MIN_WIDTH;
		if (!this.split && this.region === "detail") this.region = "list";
		this.list.focused = this.focused && this.region === "list";
		const lines = [fitLine(this.renderHeader(width, theme), width)];
		const status = this.options.status();
		lines.push(fitLine(status ? theme.fg("muted", plainLine(status)) : "", width));
		const bodyHeight = Math.max(1, height - lines.length);
		const listWidth = this.split ? Math.max(30, Math.min(64, Math.floor(width * 0.42))) : width;
		const listLines = this.renderList(listWidth, bodyHeight, lines.length, theme);
		if (!this.split) return [...lines, ...listLines];
		return [...lines, ...this.renderSplit(listLines, listWidth, bodyHeight, lines.length, width, theme)];
	}

	private renderList(listWidth: number, bodyHeight: number, top: number, theme: Theme): string[] {
		this.hits.add({ x: 0, y: top, width: listWidth, height: bodyHeight, click: () => this.focusRegion("list") });
		if (this.list.length === 0) {
			const empty = this.options.empty();
			return Array.from({ length: bodyHeight }, (_, row) =>
				fitLine(row === 0 ? theme.fg("muted", plainLine(empty)) : "", listWidth),
			);
		}
		return this.list.render(listWidth, bodyHeight, theme, this.hits, top, () => this.focusRegion("list"));
	}

	private renderSplit(
		listLines: readonly string[],
		listWidth: number,
		bodyHeight: number,
		top: number,
		width: number,
		theme: Theme,
	): string[] {
		const lines: string[] = [];
		const detailWidth = Math.max(1, width - listWidth - 1);
		const selected = this.list.selected;
		this.reader.setContent(
			this.options.detail(selected),
			selected === undefined ? undefined : this.detailKeyOf(selected),
		);
		const detail = this.reader.render(detailWidth, bodyHeight, theme, this.hits, listWidth + 1, top);
		this.hits.add({
			x: listWidth + 1,
			y: top,
			width: detailWidth,
			height: bodyHeight,
			click: () => this.focusRegion("detail"),
		});
		const divider = theme.fg(this.focused && this.region === "detail" ? "accent" : "borderMuted", "│");
		for (let row = 0; row < bodyHeight; row++)
			lines.push(`${fitLine(listLines[row] ?? "", listWidth)}${divider}${fitLine(detail[row] ?? "", detailWidth)}`);
		return lines;
	}

	private focusRegion(region: Region): TuiMouseEventResult {
		this.region = region;
		return { handled: true, focus: true };
	}

	invalidate(): void {
		this.hits.clear();
	}
}
