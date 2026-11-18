import type { Theme } from "@earendil-works/pi-coding-agent";
import { Input, matchesKey, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";

import { ListView } from "./list.ts";
import { Reader } from "./reader.ts";
import { type Action, fitLine, type KeyHint, keyMatches, plainLine, type View, type ViewHost } from "./frame.ts";

/** Below this width the detail moves to its own view, opened with Enter or Right. */
const SPLIT_MIN_WIDTH = 90;

interface BrowserOptions<T> {
	readonly title: string;
	readonly host: ViewHost;
	key(item: T): string;
	line(item: T, width: number, theme: Theme): string;
	/** Detail content for the selected item; a placeholder while its read runs. Paint performs no read. */
	detail(item: T | undefined): string;
	/** Actions for the selected item, re-read at every render and every invocation. */
	actions(item: T | undefined): readonly Action[];
	readonly search: {
		readonly placeholder: string;
		readonly value?: string;
		change(query: string): void;
	};
	/** Loading, coverage, stale or error state, shown under the search row. */
	status(): string;
	/** Shown when the list is empty, distinct from loading and failure. */
	empty(): string;
	onSelect?(item: T | undefined): void;
}

type Region = "search" | "list" | "detail";

const SELECT: KeyHint = { keys: ["up", "down"], label: "select", priority: 0 };
const FOCUS: KeyHint = { keys: ["tab"], label: "focus", priority: 3 };

/** A detail of one item as its own view, for narrow windows. */
class DetailView<T> implements View {
	readonly title: string;
	focused = false;
	private readonly reader = new Reader();
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
		const item = this.current();
		if (item === undefined) {
			const text = this.browser.theme.fg("muted", "This record is no longer listed.");
			return Array.from({ length: height }, (_, row) => fitLine(row === 0 ? text : "", width));
		}
		this.reader.setContent(this.browser.detailOf(item), this.browser.detailKeyOf(item));
		return this.reader.render(width, height, this.browser.theme);
	}
	handleInput(data: string): boolean {
		return this.current() === undefined ? true : this.reader.handleInput(data);
	}
	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		return wheel(this.reader, event);
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
}

/**
 * Search, a list and a detail reader as one view. Selecting a row never runs an effect.
 * Up and Down select; `/` focuses the search field, which keeps every printable key as text;
 * Right (and Enter, unless an owner action takes Enter) opens the detail: focus at wide widths,
 * a nested view at narrow widths. PageUp and PageDown read the detail beside the list. Query,
 * selection and reading position stay with the view.
 */
export class Browser<T> implements View {
	readonly title: string;
	focused = false;
	private readonly options: BrowserOptions<T>;
	private readonly list: ListView<T>;
	private readonly reader = new Reader();
	private readonly search = new Input({ prompt: "" });
	private region: Region;
	private split = true;
	private areas = { top: 0, listWidth: 0, height: 0, width: 0, rows: 0 };

	constructor(options: BrowserOptions<T>) {
		this.options = options;
		this.title = options.title;
		this.list = new ListView<T>({
			key: options.key,
			line: options.line,
			onSelect: (item) => options.onSelect?.(item),
			onOpen: (item) => this.open(item),
		});
		if (options.search.value) this.search.handleInput(`\u001b[200~${options.search.value}\u001b[201~`);
		this.region = "list";
	}

	get theme(): Theme {
		return this.options.host.theme;
	}

	get selected(): T | undefined {
		return this.list.selected;
	}

	private get query(): string {
		return this.search.getValue();
	}

	setItems(items: readonly T[], prefer?: string): void {
		this.list.setItems(items, prefer);
	}

	/** The listed item of one key, or undefined when that key is no longer listed. */
	itemOf(key: string): T | undefined {
		return this.list.entries().find((item) => this.options.key(item) === key);
	}

	detailOf(item: T): string {
		return this.options.detail(item);
	}

	detailKeyOf(item: T): string {
		return this.options.key(item);
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
		this.options.host.push(() => new DetailView(this, key, title || "Detail"));
	}

	private regions(): Region[] {
		const order: Region[] = ["search"];
		order.push("list");
		if (this.split) order.push("detail");
		return order;
	}

	focusNext(backward: boolean): boolean {
		const order = this.regions();
		const next = order.indexOf(this.region) + (backward ? -1 : 1);
		this.region = order[(next + order.length) % order.length] ?? "list";
		return true;
	}

	focusEdge(backward: boolean): void {
		const order = this.regions();
		this.region = backward ? (order.at(-1) ?? "list") : "list";
	}

	/** Escape clears a search edit, then leaves the search field or the detail for the list. */
	escape(): boolean {
		if (this.region === "search" && this.query) {
			this.search.setValue("");
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
				{ keys: ["escape"], label: this.query ? "clear" : "list" },
			];
		}
		if (this.region === "detail")
			return [
				{ keys: ["up", "down"], label: "scroll" },
				{ keys: ["pageUp", "pageDown"], label: "page" },
				FOCUS,
				{ keys: ["escape"], label: "list" },
			];
		// When the row is short, Tab leaves first, then the detail and paging keys; search stays with the actions.
		const hints: KeyHint[] = [SELECT, { keys: ["pageUp", "pageDown"], label: this.split ? "read" : "page" }];
		hints.push({ keys: ["/"], label: "search", priority: 1 });
		if (this.list.selected !== undefined) {
			const enterTaken = this.actions().some((action) => action.key === "enter");
			hints.push({ keys: [enterTaken ? "right" : "enter"], label: this.split ? "detail" : "open" });
		}
		hints.push(FOCUS);
		return hints;
	}

	handleInput(data: string): boolean {
		if (this.region === "search") return this.searchInput(data);
		if (keyMatches(data, "/")) {
			this.region = "search";
			return true;
		}
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
		const before = this.query;
		this.search.handleInput(data);
		if (this.query !== before) this.options.search.change(this.query);
		return true;
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		const { top, listWidth, height, width, rows } = this.areas;
		if (event.shift || event.alt || event.ctrl || event.width !== width || event.height !== rows) return undefined;
		if (event.type !== "wheel" && (event.type !== "click" || event.button !== "left")) return undefined;
		if (event.type === "click" && event.y === 0) return this.headerClick(event);
		if (event.y < top || event.y >= top + height) return undefined;
		if (event.x < listWidth) {
			if (event.type === "click") this.region = "list";
			return this.list.handleMouse({ ...event, y: event.y - top, width: listWidth, height });
		}
		if (event.x === listWidth || !this.split) return undefined;
		if (event.type === "wheel") return wheel(this.reader, event);
		this.region = "detail";
		return { handled: true, focus: true };
	}

	private headerClick(event: TuiMouseEvent): TuiMouseEventResult {
		this.region = "search";
		if (event.x >= 8) this.search.handleMouse({ ...event, x: event.x - 8, width: event.width - 8, height: 1 });
		return { handled: true, focus: true };
	}

	private searchRow(width: number, theme: Theme): string {
		this.search.focused = this.focused && this.region === "search";
		const label = fitLine(theme.fg(this.search.focused ? "accent" : "muted", "Search"), 8);
		const hint = this.options.search.placeholder;
		const text =
			this.search.focused || this.query
				? (this.search.render(Math.max(1, width - 8))[0] ?? "")
				: theme.fg("dim", `/ ${hint}`);
		return label + fitLine(text, width - 8);
	}

	render(width: number, height: number): string[] {
		const theme = this.theme;
		this.split = width >= SPLIT_MIN_WIDTH;
		if (!this.split && this.region === "detail") this.region = "list";
		this.list.focused = this.focused && this.region === "list";
		const lines = [
			fitLine(this.searchRow(width, theme), width),
			fitLine(theme.fg("muted", plainLine(this.options.status())), width),
		];
		const bodyHeight = Math.max(0, height - lines.length);
		const listWidth = this.split ? Math.max(30, Math.min(64, Math.floor(width * 0.42))) : width;
		this.areas = { top: lines.length, listWidth, height: bodyHeight, width, rows: height };
		if (!bodyHeight) return lines.slice(0, height);
		const list = this.list.length
			? this.list.render(listWidth, bodyHeight, theme)
			: [theme.fg("muted", plainLine(this.options.empty()))];
		if (!this.split)
			return Array.from({ length: height }, (_, row) =>
				fitLine((row < lines.length ? lines[row] : list[row - lines.length]) ?? "", width),
			);
		return [...lines, ...this.detailRows(list, listWidth, width, bodyHeight)];
	}

	private detailRows(list: string[], listWidth: number, width: number, height: number): string[] {
		const theme = this.theme;
		const selected = this.list.selected;
		this.reader.setContent(
			this.options.detail(selected),
			selected === undefined ? undefined : this.detailKeyOf(selected),
		);
		const detail = this.reader.render(width - listWidth - 1, height, theme);
		const divider = theme.fg(this.focused && this.region === "detail" ? "accent" : "borderMuted", "│");
		return detail.map((text, row) => `${fitLine(list[row] ?? "", listWidth)}${divider}${text}`);
	}
}

function wheel(reader: Reader, event: TuiMouseEvent): TuiMouseEventResult | undefined {
	if (event.type !== "wheel" || !event.wheelDelta || event.shift || event.alt || event.ctrl) return undefined;
	reader.scroll(Math.trunc(event.wheelDelta));
	return { handled: true };
}
