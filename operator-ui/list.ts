import type { Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey } from "@earendil-works/pi-tui";
import type { HitMap } from "./hits.ts";
import { fitLine } from "./text.ts";

export interface ListOptions<T> {
	key(item: T): string;
	/** One display line for an item, without selection styling. */
	line(item: T, width: number, theme: Theme): string;
	/** The selection changed. Selection is harmless: owners may start a passive read, never an effect. */
	onSelect?(item: T | undefined): void;
	/** Enter on the focused list, or a double click: open or focus the item's detail. */
	onOpen?(item: T): void;
}

/**
 * A scrolling list with one selected item. Keys move the selection and keep it visible; the wheel
 * moves only the window. A click selects, a double click opens.
 */
export class ListView<T> {
	focused = false;
	private items: readonly T[] = [];
	private selectedKey?: string;
	private top = 0;
	private height = 1;
	/** True after a wheel turn: the window stays where the operator put it until a key moves the selection. */
	private manual = false;
	private readonly options: ListOptions<T>;

	constructor(options: ListOptions<T>) {
		this.options = options;
	}

	get length(): number {
		return this.items.length;
	}

	get selected(): T | undefined {
		return this.items.find((item) => this.options.key(item) === this.selectedKey);
	}

	get selectedIndex(): number {
		return this.items.findIndex((item) => this.options.key(item) === this.selectedKey);
	}

	/** Replace the items, keeping the selection by identity; a vanished selection moves to the nearest item. */
	setItems(items: readonly T[], prefer?: string): void {
		const previous = this.selectedKey;
		const previousIndex = this.selectedIndex;
		this.items = items;
		const wanted = prefer ?? previous;
		if (wanted !== undefined && items.some((item) => this.options.key(item) === wanted)) this.selectedKey = wanted;
		else {
			const fallback = items[Math.max(0, Math.min(items.length - 1, previousIndex < 0 ? 0 : previousIndex))];
			this.selectedKey = fallback === undefined ? undefined : this.options.key(fallback);
		}
		if (this.selectedKey !== previous) this.options.onSelect?.(this.selected);
	}

	select(key: string | undefined): void {
		if (key === this.selectedKey) return;
		if (key !== undefined && !this.items.some((item) => this.options.key(item) === key)) return;
		this.selectedKey = key;
		this.manual = false;
		this.options.onSelect?.(this.selected);
	}

	move(delta: number): void {
		if (!this.items.length) return;
		const index = this.selectedIndex;
		const next = Math.max(0, Math.min(this.items.length - 1, (index < 0 ? 0 : index) + delta));
		const item = this.items[next];
		if (item !== undefined) this.select(this.options.key(item));
		this.manual = false;
	}

	/** Move the window without touching the selection. */
	scroll(delta: number): void {
		this.manual = true;
		this.top = Math.max(0, Math.min(Math.max(0, this.items.length - this.height), this.top + delta));
	}

	private reveal(): void {
		const index = this.selectedIndex;
		if (this.manual || index < 0) return;
		if (index < this.top) this.top = index;
		if (index >= this.top + this.height) this.top = index - this.height + 1;
	}

	render(width: number, height: number, theme: Theme, hits: HitMap, x0: number, y0: number): string[] {
		this.height = Math.max(1, height);
		this.top = Math.max(0, Math.min(Math.max(0, this.items.length - this.height), this.top));
		this.reveal();
		const lines: string[] = [];
		for (let row = 0; row < this.height; row++) {
			const item = this.items[this.top + row];
			if (item === undefined) {
				lines.push(fitLine("", width));
				continue;
			}
			const key = this.options.key(item);
			const selected = key === this.selectedKey;
			const marker = selected && this.focused ? theme.fg("accent", "›") : " ";
			const text = `${marker}${this.options.line(item, Math.max(1, width - 1), theme)}`;
			lines.push(selected ? theme.bg("selectedBg", fitLine(text, width)) : fitLine(text, width));
			hits.add({
				x: x0,
				y: y0 + row,
				width,
				height: 1,
				click: (event) => {
					this.select(key);
					if ((event.clickCount ?? 1) >= 2) this.options.onOpen?.(item);
					return { handled: true, focus: true };
				},
			});
		}
		hits.add({ x: x0, y: y0, width, height: this.height, wheel: (delta) => this.scroll(delta) });
		return lines;
	}

	handleInput(data: string): boolean {
		const page = Math.max(1, this.height - 1);
		const steps: Array<[string, number]> = [
			["up", -1],
			["down", 1],
			["pageUp", -page],
			["pageDown", page],
		];
		for (const [key, delta] of steps) {
			if (matchesKey(data, key as "up")) {
				this.move(delta);
				return true;
			}
		}
		if (matchesKey(data, "home") || matchesKey(data, "end")) {
			this.move(matchesKey(data, "home") ? -this.items.length : this.items.length);
			return true;
		}
		if (matchesKey(data, "enter")) {
			const item = this.selected;
			if (item !== undefined) this.options.onOpen?.(item);
			return true;
		}
		return false;
	}
}
