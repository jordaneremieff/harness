import { getSelectListTheme, type Theme } from "@earendil-works/pi-coding-agent";
import {
	Editor, Input, SelectList, matchesKey, truncateToWidth, wrapTextWithAnsi,
	type Component, type Focusable, type KeybindingsManager, type SelectItem, type TUI, type TuiMouseEvent, type TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import type { AgentDialogs, DialogChoice, InputOptions } from "./dialog-adapter.ts";

/** Dialog text may carry terminal controls from agent-supplied labels; only line breaks survive. */
const plain = (text: string) => text.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/gu, "").replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/gu, " ");

interface Button { label: string; run(): void }
interface Hit { x: number; width: number; y: number; run(): void }

/** Bracketed buttons on one row. Returns the row and the hit regions it drew. */
function buttonRow(buttons: readonly Button[], theme: Theme, width: number, y: number): { line: string; hits: Hit[] } {
	const hits: Hit[] = [];
	let x = 0;
	const parts: string[] = [];
	for (const button of buttons) {
		const text = `[ ${button.label} ]`;
		if (x + text.length > width) break;
		hits.push({ x, width: text.length, y, run: button.run });
		parts.push(theme.fg("accent", text));
		x += text.length + 2;
	}
	return { line: parts.join("  "), hits };
}

abstract class DialogBase implements Component, Focusable {
	abstract focused: boolean;
	protected hits: Hit[] = [];
	protected readonly tui: TUI;
	protected readonly theme: Theme;
	protected constructor(tui: TUI, theme: Theme) { this.tui = tui; this.theme = theme; }
	protected abstract frame(width: number, height: number): string[];
	protected get capacity(): number { return Math.max(6, Math.floor(this.tui.terminal.rows * 0.9) - 2); }
	protected title(text: string, width: number): string[] {
		return plain(text).split("\n").flatMap((line, index) => wrapTextWithAnsi(index === 0 ? this.theme.fg("accent", line) : line, Math.max(1, width)));
	}
	render(width: number): string[] {
		this.hits = [];
		// Every row fills the overlay, so the conversation behind the dialog never shows through.
		return this.frame(Math.max(1, width), this.capacity).map((line) => truncateToWidth(line, width, "", true));
	}
	protected clickFooter(event: TuiMouseEvent): boolean {
		if (event.type !== "click" || event.button !== "left") return false;
		const hit = this.hits.find((item) => item.y === event.y && event.x >= item.x && event.x < item.x + item.width);
		if (!hit) return false;
		hit.run();
		return true;
	}
	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined { return this.clickFooter(event) ? { handled: true } : undefined; }
	abstract handleInput(data: string): void;
	invalidate(): void { this.hits = []; }
}

/** A list the operator picks from; typing narrows a long list by label, identity and description. The chosen value is the exact identity. */
class ChoiceDialog extends DialogBase {
	private list: SelectList;
	private readonly items: readonly SelectItem[];
	private readonly filter = new Input({ prompt: "Filter: " });
	private readonly showFilter: boolean;
	private listTop = 0;
	private listHeight = 0;
	private readonly heading: string;
	private readonly finish: (value: string | undefined) => void;
	constructor(tui: TUI, theme: Theme, title: string, choices: readonly DialogChoice[], selected: string | undefined, finish: (value: string | undefined) => void) {
		super(tui, theme);
		this.heading = title;
		this.finish = finish;
		this.showFilter = choices.length > 8;
		this.items = choices.map((choice) => ({ value: choice.value, label: plain(choice.label), ...(choice.description ? { description: plain(choice.description) } : {}) }));
		this.list = this.build(this.items);
		const index = selected === undefined ? -1 : this.items.findIndex((item) => item.value === selected);
		if (index > 0) this.list.setSelectedIndex(index);
	}
	private build(items: readonly SelectItem[]): SelectList {
		const list = new SelectList([...items], Math.max(3, Math.min(items.length, 12)), getSelectListTheme());
		list.onSelect = (item) => this.finish(item.value);
		list.onCancel = () => this.finish(undefined);
		return list;
	}
	private narrow(): void {
		const terms = this.filter.getValue().toLocaleLowerCase().split(/\s+/u).filter(Boolean);
		this.list = this.build(this.items.filter((item) => terms.every((term) => `${item.label} ${item.value} ${item.description ?? ""}`.toLocaleLowerCase().includes(term))));
	}
	set focused(value: boolean) { this.filter.focused = value; }
	get focused(): boolean { return this.filter.focused; }
	protected frame(width: number, height: number): string[] {
		const head = this.title(this.heading, width);
		const filter = this.showFilter ? this.filter.render(width) : [];
		const list = this.list.render(width);
		const room = Math.max(1, height - head.length - filter.length - 2);
		const body = list.slice(0, room);
		this.listTop = head.length + filter.length;
		this.listHeight = body.length;
		const y = this.listTop + body.length + 1;
		const buttons = buttonRow([{ label: "Choose", run: () => { const item = this.list.getSelectedItem(); if (item) this.finish(item.value); } }, { label: "Cancel", run: () => this.finish(undefined) }], this.theme, width, y);
		this.hits = buttons.hits;
		const hint = this.showFilter ? "Type to filter · ↑↓ move · Enter choose · Esc cancel" : "↑↓ move · Enter choose · Esc cancel";
		return [...head, ...filter, ...body, this.theme.fg("muted", hint), buttons.line];
	}
	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) { this.finish(undefined); return; }
		if (matchesKey(data, "up") || matchesKey(data, "down") || matchesKey(data, "pageUp") || matchesKey(data, "pageDown") || matchesKey(data, "enter")) { this.list.handleInput(data); this.tui.requestRender(); return; }
		if (!this.showFilter) return;
		this.filter.handleInput(data);
		this.narrow();
		this.tui.requestRender();
	}
	override handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (this.clickFooter(event)) return { handled: true };
		if (event.y < this.listTop || event.y >= this.listTop + this.listHeight) return undefined;
		return this.list.handleMouse({ ...event, y: event.y - this.listTop, height: this.listHeight });
	}
}

/** One-line text with Apply and Cancel. */
class LineDialog extends DialogBase {
	private readonly input = new Input({ prompt: "> " });
	private readonly heading: string;
	private readonly finish: (value: string | undefined) => void;
	constructor(tui: TUI, theme: Theme, title: string, initial: string, finish: (value: string | undefined) => void) {
		super(tui, theme);
		this.heading = title;
		this.finish = finish;
		this.input.setValue(initial);
		this.input.handleInput("\x05");
		this.input.onSubmit = (value) => finish(value);
	}
	set focused(value: boolean) { this.input.focused = value; }
	get focused(): boolean { return this.input.focused; }
	protected frame(width: number): string[] {
		const head = this.title(this.heading, width);
		const field = this.input.render(width);
		const y = head.length + field.length + 1;
		const buttons = buttonRow([{ label: "Apply", run: () => this.finish(this.input.getValue()) }, { label: "Cancel", run: () => this.finish(undefined) }], this.theme, width, y);
		this.hits = buttons.hits;
		return [...head, ...field, this.theme.fg("muted", "Enter applies · Esc cancels"), buttons.line];
	}
	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) this.finish(undefined);
		else this.input.handleInput(data);
		this.tui.requestRender();
	}
}

/** Multiline text. Enter applies, as in the composer; Ctrl+J, Shift+Enter or the New line button inserts a break. */
class EditorDialog extends DialogBase {
	private readonly editor: Editor;
	private readonly heading: string;
	private readonly finish: (value: string | undefined) => void;
	constructor(tui: TUI, theme: Theme, title: string, initial: string, finish: (value: string | undefined) => void) {
		super(tui, theme);
		this.heading = title;
		this.finish = finish;
		this.editor = new Editor(tui, { borderColor: (text) => theme.fg("borderMuted", text), selectList: getSelectListTheme() });
		this.editor.setText(initial);
		this.editor.onSubmit = (text) => finish(text);
	}
	set focused(value: boolean) { this.editor.focused = value; }
	get focused(): boolean { return this.editor.focused; }
	protected frame(width: number): string[] {
		const head = this.title(this.heading, width);
		const field = this.editor.render(width);
		const y = head.length + field.length + 1;
		const buttons = buttonRow([
			{ label: "Apply", run: () => this.finish(this.editor.getExpandedText()) },
			{ label: "New line", run: () => { this.editor.insertTextAtCursor("\n"); this.tui.requestRender(); } },
			{ label: "Cancel", run: () => this.finish(undefined) },
		], this.theme, width, y);
		this.hits = buttons.hits;
		return [...head, ...field, this.theme.fg("muted", "Enter applies · Ctrl+J new line · Esc cancels"), buttons.line];
	}
	handleInput(data: string): void {
		if (matchesKey(data, "escape") && !this.editor.isShowingAutocomplete()) { this.finish(undefined); return; }
		this.editor.handleInput(data);
		this.tui.requestRender();
	}
	override handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (this.clickFooter(event)) return { handled: true };
		return event.type === "click" ? { handled: true, focus: true } : undefined;
	}
}

/** Full text with wrapping, so no line is lost to the right edge. */
class ReaderDialog extends DialogBase {
	focused = false;
	private offset = 0;
	private page = 1;
	private max = 0;
	private lines: string[] = [];
	private lineWidth = 0;
	private readonly heading: string;
	private readonly text: string;
	private readonly finish: () => void;
	constructor(tui: TUI, theme: Theme, title: string, text: string, finish: () => void) {
		super(tui, theme);
		this.heading = title;
		this.text = plain(text);
		this.finish = finish;
	}
	protected frame(width: number, height: number): string[] {
		const head = this.title(this.heading, width);
		if (this.lineWidth !== width) { this.lines = this.text.split("\n").flatMap((line) => wrapTextWithAnsi(line, width)); this.lineWidth = width; }
		this.page = Math.max(1, height - head.length - 3);
		this.max = Math.max(0, this.lines.length - this.page);
		this.offset = Math.min(this.offset, this.max);
		const body = this.lines.slice(this.offset, this.offset + this.page);
		const y = head.length + body.length + 1;
		const buttons = buttonRow([{ label: "Close", run: () => this.finish() }], this.theme, width, y);
		this.hits = buttons.hits;
		const where = `${this.lines.length ? this.offset + 1 : 0}-${Math.min(this.lines.length, this.offset + this.page)} of ${this.lines.length} lines`;
		return [...head, ...body, this.theme.fg("muted", `${where} · ↑↓ PgUp PgDn scroll · Esc closes`), buttons.line];
	}
	private scroll(delta: number): void { this.offset = Math.max(0, Math.min(this.max, this.offset + delta)); this.tui.requestRender(); }
	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "enter") || data === "q") this.finish();
		else if (matchesKey(data, "up")) this.scroll(-1);
		else if (matchesKey(data, "down")) this.scroll(1);
		else if (matchesKey(data, "pageUp")) this.scroll(-this.page);
		else if (matchesKey(data, "pageDown")) this.scroll(this.page);
		else if (matchesKey(data, "home")) this.scroll(-this.max);
		else if (matchesKey(data, "end")) this.scroll(this.max);
	}
	override handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.type === "wheel") { this.scroll(Math.sign(event.wheelDelta ?? 0) * 3); return { handled: true }; }
		return super.handleMouse(event);
	}
}

export interface TerminalDialogHost {
	readonly tui: TUI;
	readonly theme: Theme;
	readonly keys: KeybindingsManager;
	/** Marks one local interaction as open and returns its release. The cancel function closes it. */
	track(cancel: () => void): () => void;
	notify(text: string): void;
}

/** Standalone implementation of the dialog adapter, shown as overlays in the attached terminal. */
export function terminalDialogs(host: TerminalDialogHost): AgentDialogs {
	function open<T>(make: (finish: (value: T | undefined) => void) => Component & Focusable, cancelled: T | undefined = undefined): Promise<T | undefined> {
		return new Promise((resolve) => {
			let settled = false;
			let handle: { hide(): void } | undefined;
			let release = () => {};
			const finish = (value: T | undefined) => {
				if (settled) return;
				settled = true;
				release();
				handle?.hide();
				resolve(value);
				host.tui.requestRender();
			};
			release = host.track(() => finish(cancelled));
			handle = host.tui.showOverlay(make(finish), { width: "90%", maxHeight: "90%", anchor: "center" });
		});
	}
	return {
		filtersChoices: true,
		select: (title, choices, selected) => open<string>((finish) => new ChoiceDialog(host.tui, host.theme, title, choices, selected, finish)),
		confirm: async (title, description, action) => (await open<string>((finish) => new ChoiceDialog(host.tui, host.theme, `${title}\n${description}`, [{ value: "cancel", label: "Cancel" }, { value: "apply", label: action }], "cancel", finish))) === "apply",
		input: (title: string, options?: InputOptions) => open<string>((finish) => new LineDialog(host.tui, host.theme, title, options?.initial ?? "", finish)),
		editor: (title, initial = "") => open<string>((finish) => new EditorDialog(host.tui, host.theme, title, initial, finish)),
		read: async (title, text) => { await open<true>((finish) => new ReaderDialog(host.tui, host.theme, title, text, () => finish(true))); },
		notify: (text) => host.notify(text),
	};
}
