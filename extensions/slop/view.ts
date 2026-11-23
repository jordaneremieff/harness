import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import {
	Input,
	Markdown,
	type MarkdownTheme,
	matchesKey,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
	type TUI,
	type TuiMouseEvent,
} from "@earendil-works/pi-tui";
import { scopes, type Scope } from "./catalog.ts";
import { searchEntry, stateLabel } from "./operations.ts";
import { singleLine, terminalText } from "./presentation-text.ts";
import type { CatalogEntry } from "./store.ts";

export type ViewState = { query: string; selected?: string; scope?: Scope };
type Operations = {
	entries(): CatalogEntry[];
	setDisabled(id: string, disabled: boolean): void;
	attach(close: () => void): void;
};
type Control = { label: string; key: Parameters<typeof matchesKey>[1]; run(): void };
type Target = { x: number; y: number; width: number; run(): void };

function markdownTheme(theme: Theme): MarkdownTheme {
	const muted = (text: string) => theme.fg("muted", text);
	return {
		heading: (text) => theme.fg("accent", theme.bold(text)),
		link: (text) => text,
		linkUrl: muted,
		code: (text) => theme.fg("accent", text),
		codeBlock: (text) => text,
		codeBlockBorder: muted,
		quote: muted,
		quoteBorder: muted,
		hr: muted,
		listBullet: muted,
		bold: (text) => theme.bold(text),
		italic: (text) => theme.italic(text),
		strikethrough: (text) => theme.strikethrough(text),
		underline: (text) => theme.underline(text),
	};
}

class SlopView {
	readonly capturesViewportInput = true;
	readonly input = new Input();
	private focus: "list" | "search" | "read" = "list";
	private nested = false;
	private scroll = 0;
	private confirm?: { id: string; disabled: boolean };
	private more?: { index: number; actions: Control[] };
	private openMore?: () => void;
	private notice = "";
	private entries: CatalogEntry[] = [];
	private targets: Target[] = [];
	private shownWidth = 0;
	private shownHeight = 0;
	private detailColumn = 0;
	private page = 10;
	private scrollLimit = 0;
	private rendered?: { key: string; rows: string[] };

	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly state: ViewState;
	private readonly ops: Operations;
	readonly close: () => void;
	constructor(tui: TUI, theme: Theme, state: ViewState, ops: Operations, close: () => void) {
		this.tui = tui;
		this.theme = theme;
		this.state = state;
		this.ops = ops;
		this.close = close;
		this.input.setValue(singleLine(state.query));
	}
	invalidate() {
		this.input.invalidate();
	}

	private select(id: string | undefined) {
		if (this.state.selected !== id) this.scroll = 0;
		this.state.selected = id;
	}
	private step(delta: number) {
		const i = this.entries.findIndex((entry) => entry.id === this.state.selected);
		this.select(this.entries[Math.max(0, Math.min(i + delta, this.entries.length - 1))]?.id);
	}
	private read() {
		if (this.state.selected) {
			this.nested = true;
			this.focus = "read";
		}
	}
	private search() {
		this.nested = false;
		this.focus = "search";
	}
	private changeScope() {
		const index = this.state.scope === undefined ? -1 : scopes.indexOf(this.state.scope);
		this.state.scope = scopes[index + 1];
	}
	private reviewState() {
		const entry = this.entries.find((item) => item.id === this.state.selected);
		if (entry) {
			this.notice = "";
			this.confirm = { id: entry.id, disabled: entry.disabled };
		}
	}
	private applyState() {
		if (!this.confirm) return;
		const { id, disabled } = this.confirm;
		try {
			const entry = this.ops.entries().find((item) => item.id === id);
			if (!entry || entry.disabled !== disabled)
				throw new Error("The entry changed. Cancel and open its current state.");
			this.ops.setDisabled(id, !disabled);
			this.confirm = undefined;
			this.notice = `${id} is ${disabled ? "active" : "disabled"}.`;
		} catch (error) {
			this.notice = String(error instanceof Error ? error.message : error);
		}
	}
	private scrollBy(delta: number) {
		this.scroll = Math.max(0, Math.min(this.scrollLimit, this.scroll + delta));
	}
	private escape() {
		if (this.more) this.more = undefined;
		else if (this.focus === "search") this.focus = "list";
		else if (this.confirm) {
			this.confirm = undefined;
			this.notice = "";
		} else if (this.nested || this.focus === "read") {
			this.nested = false;
			this.focus = "list";
		} else this.close();
	}

	private commands(): Control[] {
		if (this.confirm)
			return [{ key: "enter", label: this.confirm.disabled ? "enable" : "disable", run: () => this.applyState() }];
		if (this.focus === "search")
			return [
				{
					key: "enter",
					label: "list",
					run: () => {
						this.focus = "list";
					},
				},
			];
		const common: Control[] = [
			{ key: "/", label: "search", run: () => this.search() },
			{ key: "s", label: "scope", run: () => this.changeScope() },
		];
		if (this.focus === "read")
			return [
				{ key: "pageUp", label: "read up", run: () => this.scrollBy(-this.page) },
				{ key: "pageDown", label: "read down", run: () => this.scrollBy(this.page) },
				{ key: "e", label: "entry state", run: () => this.reviewState() },
				...common,
			];
		return [
			{ key: "up", label: "select up", run: () => this.step(-1) },
			{ key: "down", label: "select down", run: () => this.step(1) },
			{ key: "enter", label: "read", run: () => this.read() },
			...common,
		];
	}

	private keyName(key: Control["key"]) {
		return (
			({ up: "↑", down: "↓", pageUp: "pgup", pageDown: "pgdn", escape: "esc" } as Record<string, string>)[key] ?? key
		);
	}
	private keyRow(width: number, y: number): string {
		const exit: Control = {
			key: "escape",
			label: this.more || this.confirm ? "cancel" : this.focus !== "list" ? "list" : "close",
			run: () => this.escape(),
		};
		const moreKey = this.focus === "search" ? "ctrl+n" : "x";
		const controls = this.more ? [] : this.commands();
		const label = (control: Control) => `${this.keyName(control.key)} ${control.label}`;
		const size = (items: Control[]) => visibleWidth(items.map(label).join("  "));
		const shown = [...controls];
		const hidden: Control[] = [];
		const more: Control = {
			key: moreKey,
			label: "more",
			run: () => {
				if (this.more) this.more = undefined;
				else if (hidden.length) this.more = { index: 0, actions: hidden };
			},
		};
		while (shown.length && size([...shown, ...(hidden.length ? [more] : []), exit]) > width)
			hidden.unshift(shown.pop() as Control);
		this.openMore = hidden.length ? more.run : undefined;
		if (hidden.length) shown.push(more);
		shown.push(exit);
		let x = 0;
		return shown
			.map((control) => {
				const length = Math.min(visibleWidth(label(control)), width - x);
				if (length > 0) this.targets.push({ x, y, width: length, run: control.run });
				x += visibleWidth(label(control)) + 2;
				return this.theme.fg("accent", this.keyName(control.key)) + this.theme.fg("muted", ` ${control.label}`);
			})
			.join("  ");
	}

	private refresh(): string | undefined {
		try {
			const { scope, query } = this.state;
			this.entries = this.ops
				.entries()
				.filter((entry) => (!scope || entry.applies.includes(scope)) && searchEntry(entry, query));
			if (!this.nested && !this.confirm && !this.selectedEntry()) this.select(this.entries[0]?.id);
		} catch (error) {
			this.entries = [];
			return singleLine(error instanceof Error ? error.message : String(error));
		}
	}
	private selectedEntry() {
		return this.entries.find((entry) => entry.id === this.state.selected);
	}
	private menuRows(width: number, y: number, menu: NonNullable<SlopView["more"]>) {
		const heading = this.theme.fg("muted", "More controls");
		return [
			heading,
			...menu.actions.map((action, index) => {
				const selected = index === menu.index;
				const row = `${selected ? "› " : "  "}${this.keyName(action.key)} ${action.label}`;
				this.targets.push({
					x: 0,
					y: y + index + 1,
					width: Math.min(width, visibleWidth(row)),
					run: () => {
						this.more = undefined;
						action.run();
					},
				});
				return this.theme.fg(selected ? "accent" : "text", row);
			}),
		];
	}
	private confirmationRows(confirm: NonNullable<SlopView["confirm"]>) {
		const title = this.selectedEntry()?.title ?? confirm.id;
		return [
			this.theme.fg("muted", `Catalog / ${confirm.id}`),
			`${confirm.disabled ? "Enable" : "Disable"} ${singleLine(title)}?`,
			"Disabled entries stay in the catalog but do not run or appear in the prompt.",
		];
	}
	private searchRow(width: number, y: number) {
		this.input.focused = this.focus === "search";
		const label = `Scope: ${this.state.scope ?? "all"} · Search: `;
		const column = visibleWidth(label);
		if (!this.input.focused)
			this.targets.push({ x: column - 8, y, width: Math.max(1, width - column + 8), run: () => this.search() });
		const text = this.input.focused ? this.input.render(Math.max(1, width - column))[0] : singleLine(this.state.query);
		return this.theme.fg("muted", label) + text;
	}
	private listItem(row: CatalogEntry | undefined, width: number, y: number, empty: boolean) {
		if (!row) return empty ? "No matching entries." : "";
		this.targets.push({
			x: 0,
			y,
			width,
			run: () => {
				this.select(row.id);
				this.focus = "list";
				this.nested = false;
			},
		});
		const selected = row.id === this.state.selected;
		const title = `${selected ? "› " : "  "}${singleLine(row.title)}${row.source === "local" ? " (local)" : ""}${row.disabled ? " (disabled)" : ""}`;
		return this.theme.fg(selected ? "accent" : "text", truncateToWidth(title, width));
	}
	private listRows(width: number, y: number, entry?: CatalogEntry) {
		const current = this.entries.findIndex((item) => item.id === this.state.selected);
		const start = Math.max(0, Math.min(current - Math.floor(this.page / 2), this.entries.length - this.page));
		const list = this.entries.slice(start, start + this.page);
		const detail = this.detailColumn && entry ? this.detail(entry, width - this.detailColumn) : [];
		const column = this.detailColumn ? this.detailColumn - 2 : width;
		return Array.from({ length: Math.max(list.length, detail.length, 1) }, (_, i) => {
			const title = this.listItem(list[i], column, y + i, i === 0);
			if (!this.detailColumn) return title;
			if (detail[i] !== undefined)
				this.targets.push({ x: this.detailColumn, y: y + i, width: width - this.detailColumn, run: () => this.read() });
			return `${truncateToWidth(title, column, "…", true)}  ${detail[i] ?? ""}`;
		});
	}
	private browserRows(width: number, y: number) {
		const entry = this.selectedEntry();
		if (this.nested && !this.detailColumn)
			return [this.theme.fg("muted", `Catalog / ${this.state.selected ?? "entry"}`), ...this.detail(entry, width)];
		return [this.searchRow(width, y), ...this.listRows(width, y + 1, entry)];
	}

	render(width: number): string[] {
		this.targets = [];
		const lines = [this.theme.fg("accent", this.theme.bold("Slop")) + this.theme.fg("muted", " · catalog")];
		const error = this.refresh();
		this.page = Math.max(3, Math.min(14, this.tui.terminal.rows - 10));
		this.detailColumn = width >= 90 && !this.more && !this.confirm ? 39 : 0;
		if (error) lines.push(this.theme.fg("error", error));
		else if (this.more) lines.push(...this.menuRows(width, lines.length, this.more));
		else if (this.confirm) lines.push(...this.confirmationRows(this.confirm));
		else lines.push(...this.browserRows(width, lines.length));
		if (this.notice) lines.push(this.theme.fg("muted", singleLine(this.notice)));
		lines.push(this.keyRow(width, lines.length));
		this.shownWidth = width;
		this.shownHeight = lines.length;
		return lines.map((line) => truncateToWidth(line, width));
	}

	private detail(entry: CatalogEntry | undefined, width: number): string[] {
		const rows = entry ? this.entryRows(entry, Math.max(1, width)) : ["The entry is no longer in this list."];
		this.scrollLimit = Math.max(0, rows.length - this.page);
		this.scrollBy(0);
		return rows.slice(this.scroll, this.scroll + this.page);
	}

	/** The entry as rendered Markdown under one line of its facts; the front matter is not shown. */
	private entryRows(entry: CatalogEntry, width: number): string[] {
		const key = `${entry.id}\u0000${entry.source}\u0000${entry.disabled}\u0000${width}\u0000${entry.raw}`;
		if (this.rendered?.key === key) return this.rendered.rows;
		const facts = `${entry.id} · ${entry.domain} · ${entry.applies.join(", ")} · ${entry.source} · ${stateLabel(entry)}`;
		const body = terminalText(entry.raw.replace(/^---\r?\n[\s\S]*?\r?\n---[^\n]*\n+/, ""));
		const markdown = new Markdown(body.trim() || "(no text)", 0, 0, markdownTheme(this.theme), {
			color: (value) => this.theme.fg("text", value),
		});
		const rows = [...wrapTextWithAnsi(this.theme.fg("muted", singleLine(facts)), width), "", ...markdown.render(width)];
		this.rendered = { key, rows };
		return rows;
	}

	private handleMenu(data: string, more: NonNullable<SlopView["more"]>) {
		if (matchesKey(data, "x") || matchesKey(data, "ctrl+n")) this.more = undefined;
		else if (matchesKey(data, "up")) more.index = Math.max(0, more.index - 1);
		else if (matchesKey(data, "down")) more.index = Math.min(more.actions.length - 1, more.index + 1);
		else {
			const action = matchesKey(data, "enter")
				? more.actions[more.index]
				: more.actions.find((item) => matchesKey(data, item.key));
			if (action) {
				this.more = undefined;
				action.run();
			}
		}
	}
	private moveFocus(back: boolean) {
		const order = ["list", "search", "read"] as const;
		const next = order[(order.indexOf(this.focus) + (back ? 2 : 1)) % order.length];
		if (next === "read") this.read();
		else {
			this.focus = next;
			this.nested = false;
		}
	}
	private handleBrowser(data: string) {
		if (matchesKey(data, "tab") || matchesKey(data, "shift+tab")) this.moveFocus(matchesKey(data, "shift+tab"));
		else if (this.focus === "search") {
			if (matchesKey(data, "enter")) this.focus = "list";
			else {
				this.input.handleInput(data);
				this.state.query = singleLine(this.input.getValue());
			}
		} else if (matchesKey(data, "right") && this.focus === "list") this.read();
		else
			this.commands()
				.find((control) => matchesKey(data, control.key))
				?.run();
	}
	handleInput(data: string): void {
		if (matchesKey(data, "escape")) this.escape();
		else if (this.more) this.handleMenu(data, this.more);
		else if (matchesKey(data, "ctrl+n") || (this.focus !== "search" && matchesKey(data, "x"))) this.openMore?.();
		else if (this.confirm) {
			if (matchesKey(data, "enter")) this.applyState();
		} else this.handleBrowser(data);
		this.tui.requestRender();
	}

	handleMouse(event: TuiMouseEvent) {
		if (event.shift || event.alt || event.ctrl || event.width !== this.shownWidth || event.height !== this.shownHeight)
			return;
		if (event.type === "wheel" && !this.more && !this.confirm && event.y > 0 && event.y < this.shownHeight - 1) {
			if ((this.nested && !this.detailColumn) || (this.detailColumn > 0 && event.x >= this.detailColumn))
				this.scrollBy(event.wheelDelta ?? 0);
			else this.step(event.wheelDelta ?? 0);
			return { handled: true };
		}
		if (event.type !== "click" || event.button !== "left") return;
		const target = this.targets.find(
			(target) => target.y === event.y && target.x <= event.x && target.x + target.width > event.x,
		);
		if (target) {
			target.run();
			return { handled: true };
		}
	}
}

export async function openView(ctx: ExtensionContext, state: ViewState, ops: Operations): Promise<void> {
	await ctx.ui.custom<void>((tui, theme, _keys, done) => {
		const close = () => done();
		ops.attach(close);
		return new SlopView(tui, theme, state, ops, close);
	});
}
