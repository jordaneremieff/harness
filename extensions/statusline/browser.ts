import { matchesKey, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";
import { fitLine, type KeyHint, keyMatches, plainLine, type View, type ViewHost } from "./frame.ts";
import { CHOOSE, Choices, PAGE, Reader, SCROLL } from "./view-parts.ts";

interface Options<T> {
	readonly title: string;
	readonly host: ViewHost;
	readonly items: () => readonly T[];
	readonly key: (item: T) => string;
	readonly line: (item: T) => string;
	readonly detail: (item: T | undefined) => string;
	readonly status: (shown: number) => string;
	readonly empty: () => string;
}

type Region = "list" | "detail";
const FOCUS: KeyHint = { keys: ["tab"], label: "focus", priority: 3 };

/** A list with side-by-side detail at 90 columns, or a nested reader below that width. */
export class Browser<T> implements View {
	readonly title: string;
	focused = false;
	private readonly choices: Choices;
	private readonly reader = new Reader();
	private region: Region = "list";
	private selected?: string;
	private items = new Map<string, T>();
	private listed?: readonly T[];
	private split = true;
	private area = { listWidth: 0, rows: 0 };

	private readonly options: Options<T>;

	constructor(options: Options<T>) {
		this.options = options;
		this.title = options.title;
		this.choices = new Choices(options.host.theme, (key) => this.select(key));
		this.refresh();
	}

	private refresh(): void {
		const entries = this.options.items();
		if (this.listed === entries) return;
		this.listed = entries;
		this.items = new Map(entries.map((item) => [this.options.key(item), item]));
		const first = this.items.keys().next().value;
		if (this.selected === undefined || !this.items.has(this.selected)) this.select(first);
		this.choices.set(
			[...this.items].map(([value, item]) => ({ value, label: this.options.line(item) })),
			this.selected,
		);
	}

	private select(key: string | undefined): void {
		if (key !== this.selected) this.reader.reset();
		this.selected = key;
	}

	private current(): T | undefined {
		return this.selected === undefined ? undefined : this.items.get(this.selected);
	}

	private openDetail(): void {
		if (this.selected === undefined) return;
		if (this.split) {
			this.region = "detail";
			return;
		}
		const key = this.selected;
		this.options.host.push((host) => {
			const reader = new Reader();
			const item = () => this.options.items().find((entry) => this.options.key(entry) === key);
			return {
				title: "Detail",
				render: (width, height) => reader.render(this.options.detail(item()), width, height, host.theme),
				handleInput: (data) => reader.handleInput(data),
				handleMouse: (event) => reader.handleMouse(event),
				keys: () => [SCROLL, PAGE],
			};
		});
	}

	focusStep(backward: boolean): void {
		const order: Region[] = this.split ? ["list", "detail"] : ["list"];
		this.region = order[(order.indexOf(this.region) + (backward ? -1 : 1) + order.length) % order.length];
	}

	keys(): readonly KeyHint[] {
		if (this.region === "detail") return [SCROLL, PAGE, FOCUS, { keys: ["escape"], label: "list" }];
		const detail: KeyHint[] =
			this.selected === undefined ? [] : [{ keys: ["enter"], label: this.split ? "detail" : "open" }];
		return [CHOOSE, { ...PAGE, label: this.split ? "read" : "page" }, ...detail, FOCUS];
	}

	escape(): boolean {
		if (this.region === "list") return false;
		this.region = "list";
		return true;
	}

	handleInput(data: string): boolean {
		if (this.region === "detail") return this.reader.handleInput(data);
		if (keyMatches(data, "enter") || matchesKey(data, "right")) this.openDetail();
		else if (!this.split || !this.reader.handleInput(data, false)) this.choices.handleInput(data);
		return true;
	}

	render(width: number, height: number): string[] {
		this.refresh();
		const theme = this.options.host.theme;
		this.split = width >= 90;
		if (!this.split && this.region === "detail") this.region = "list";
		const listWidth = this.split ? Math.max(30, Math.min(64, Math.floor(width * 0.42))) : width;
		const rows = Math.max(0, height - 2);
		this.area = { listWidth, rows };
		const status = theme.fg("muted", this.options.status(this.items.size));
		const list = this.items.size
			? this.choices.render(listWidth, rows, this.focused && this.region === "list")
			: [theme.fg("muted", plainLine(this.options.empty()))];
		const detail = this.split
			? this.reader.render(this.options.detail(this.current()), width - listWidth - 1, rows, theme)
			: [];
		const divider = this.split
			? theme.fg(this.region === "detail" && this.focused ? "accent" : "borderMuted", "│")
			: "";
		return [
			theme.bold(this.title),
			status,
			...Array.from({ length: rows }, (_, y) => fitLine(list[y] ?? "", listWidth) + divider + (detail[y] ?? "")),
		];
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		const { listWidth, rows } = this.area;
		if (event.y < 2 || event.y >= rows + 2) return undefined;
		if (event.x < listWidth) {
			if (event.type === "click") this.region = "list";
			return this.choices.handleMouse({ ...event, y: event.y - 2, height: rows, width: listWidth });
		}
		if (event.x === listWidth) return undefined;
		if (event.type === "wheel") return this.reader.handleMouse(event);
		this.region = "detail";
		return { handled: true };
	}
}
