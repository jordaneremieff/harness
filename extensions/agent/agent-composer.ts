/**
 * Per-agent composer over the native Editor. One instance owns the caret
 * for one agent; the dashboard focuses exactly one composer at a time and stores
 * drafts outside the editor, so a selection change or reopen keeps
 * the text.
 */
import { getSelectListTheme, type Theme } from "@earendil-works/pi-coding-agent";
import {
	Editor,
	setKeybindings,
	type KeybindingsManager,
	matchesKey,
	parseKey,
	sliceByColumn,
	visibleWidth,
	type Component,
	type Focusable,
	type TUI,
	type TuiMouseEvent,
	type TuiMouseEventResult,
} from "@earendil-works/pi-tui";

import { dashboardHeading } from "./dashboard-layout.ts";

/** Text rows a compact message field shows before its draft scrolls. */
const DEFAULT_ROWS = 6;

class ComposerEditor extends Editor {
	topHidden = 0;
	bottomHidden = 0;
	protected override renderTopBorder(_width: number, hidden: number): string {
		this.topHidden = hidden;
		return "";
	}
	protected override renderBottomBorder(_width: number, hidden: number): string {
		this.bottomHidden = hidden;
		return "";
	}
}
export interface AgentComposerOptions {
	tui: TUI;
	theme: Theme;
	keys: KeybindingsManager;
	/** Receives expanded text; the draft stays until the owner confirms admission. */
	onSubmit(text: string): void;
	/** Receives every text change; the console uses it to retain a recoverable draft. */
	onChange?(text: string): void;
	/** Escape with no autocomplete open; the dashboard decides focus or exit. */
	onEscape(): void;
}

/** Column span of one border control, relative to the composer's own first column. */
export interface ComposerSpan {
	readonly x: number;
	readonly width: number;
}

export class AgentComposer implements Component, Focusable {
	private readonly editor: ComposerEditor;
	private readonly options: AgentComposerOptions;
	private viewportRows?: number;
	private rowLimit?: number;
	private paddingRows = 0;
	private bottomRow = 0;
	private textRows = 1;
	autocompleteRows = 0;
	grip?: "normal" | "hover" | "active";
	/** Spans of the last render: the delivery effect on the top border, and each bottom-border control. */
	spans: { mode?: ComposerSpan; controls: ComposerSpan[] } = { controls: [] };
	/** Rows of the last render, so a host can find the bottom border. */
	get renderedBottom(): number {
		return this.bottomRow;
	}

	constructor(options: AgentComposerOptions) {
		this.options = options;
		// The native editor shows 30% of the terminal rows, at least five; the proxy turns a row count into that height.
		const rows = () => Math.ceil((this.viewportRows ?? this.rowLimit ?? DEFAULT_ROWS) / 0.3);
		const tui = new Proxy(options.tui, {
			get(target, key) {
				if (key === "terminal")
					return new Proxy(target.terminal, {
						get(terminal, name) {
							return name === "rows" ? rows() : Reflect.get(terminal, name);
						},
					});
				const value = Reflect.get(target, key);
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
		this.editor = new ComposerEditor(
			tui,
			{
				borderColor: (text) => options.theme.fg("borderMuted", text),
				selectList: getSelectListTheme(),
			},
		);
		this.editor.disableSubmit = true;
		this.editor.onChange = () => options.onChange?.(this.editor.getExpandedText());
	}

	get focused(): boolean {
		return this.editor.focused;
	}
	set focused(value: boolean) {
		this.editor.focused = value;
	}

	/** Full draft text, with paste markers expanded to their payload. */
	getText(): string {
		return this.editor.getExpandedText();
	}

	/** Replace the draft. Line endings normalize to LF and tabs to spaces. */
	setText(text: string): void {
		this.editor.setText(text);
	}

	isEmpty(): boolean {
		return this.getText().trim() === "";
	}

	addToHistory(text: string): void {
		this.editor.addToHistory(text);
	}
	handleInput(data: string): void {
		const key = parseKey(data);
		if (key?.includes("alt+") || /^f\d+$/.test(key ?? "")) return;
		if ((matchesKey(data, "escape") || this.options.keys.matches(data, "app.interrupt")) && !this.editor.isShowingAutocomplete()) {
			this.options.onEscape();
			return;
		}
		if (this.options.keys.matches(data, "tui.input.newLine")) {
			setKeybindings(this.options.keys);
			this.editor.handleInput(data);
			this.options.onChange?.(this.getText());
			return;
		}
		if (matchesKey(data, "enter")) {
			if (!this.isEmpty()) this.options.onSubmit(this.getText());
			return;
		}
		if (matchesKey(data, "ctrl+c")) {
			this.setText("");
			this.options.onChange?.("");
			return;
		}
		if (matchesKey(data, "ctrl+d") && this.isEmpty()) return;
		setKeybindings(this.options.keys);
		this.editor.handleInput(data);
		this.options.onChange?.(this.getText());
	}

	setViewportRows(rows?: number): void {
		this.viewportRows = rows === undefined ? undefined : Math.max(5, Math.trunc(rows));
	}

	/** Cap the text rows a growing draft shows, without padding a short one; five is the native minimum. */
	limitRows(rows?: number): void {
		this.rowLimit = rows === undefined ? undefined : Math.max(5, Math.min(DEFAULT_ROWS, Math.trunc(rows)));
	}
	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.x < 1 || event.x >= event.width - 1) return;
		if (event.y > this.textRows && event.y < this.bottomRow) {
			if (event.type === "click" && event.button === "left") return { handled: true, focus: true };
			return;
		}
		const y = event.y >= this.bottomRow ? event.y - this.paddingRows : event.y;
		return this.editor.handleMouse({ ...event, x: event.x - 1, y, width: event.width - 2, height: event.height - this.paddingRows });
	}

	private topFrame(width: number, caption: string | ((width: number) => string), mode: string): string {
		const theme = this.options.theme;
		const hidden = this.editor.topHidden ? `↑ ${this.editor.topHidden} lines` : "";
		const position = [hidden, mode].filter(Boolean).join(" · ");
		const frameWidth = this.grip ? width - 4 : width;
		const captionWidth = Math.max(1, frameWidth - visibleWidth(position ? ` ${position} ` : "") - 6);
		const label = typeof caption === "function" ? caption(captionWidth) : caption;
		const top = dashboardHeading(label, position, frameWidth, theme);
		// The delivery effect ends the right segment, just before its trailing space and the corner.
		this.spans.mode = mode ? { x: frameWidth - 2 - visibleWidth(mode), width: visibleWidth(mode) } : undefined;
		if (!this.grip) return top;
		return sliceByColumn(top, 0, width - 5, true) + theme.fg(this.grip === "normal" ? "borderMuted" : "accent", `─${this.grip === "active" ? "━━━" : "┄┄┄"}╮`);
	}

	/** The bottom border: the receipt on the left, the labelled controls on the right. */
	private bottomFrame(width: number, receipt: string, controls: readonly string[]): string {
		const hidden = this.editor.bottomHidden ? `↓ ${this.editor.bottomHidden} lines` : "";
		const labels = controls.join(" · ");
		const position = [hidden, labels].filter(Boolean).join(" · ");
		const line = dashboardHeading(receipt, position, width, this.options.theme, true);
		const spans: ComposerSpan[] = [];
		let x = width - 2 - visibleWidth(labels);
		for (const control of controls) {
			spans.push({ x, width: visibleWidth(control) });
			x += visibleWidth(control) + 3;
		}
		this.spans.controls = spans;
		return line;
	}

	render(width: number, caption: string | ((width: number) => string) = "Message", mode = "", receipt = "", controls: readonly string[] = []): string[] {
		const lines = this.editor.render(Math.max(1, width - 2));
		const bottom = lines.findIndex((line, index) => index > 0 && line === "");
		this.autocompleteRows = Math.max(0, lines.length - bottom - 1);
		this.textRows = Math.max(1, bottom - 1);
		this.paddingRows = Math.max(0, (this.viewportRows ?? this.textRows) - this.textRows);
		this.bottomRow = bottom + this.paddingRows;
		if (this.paddingRows) lines.splice(bottom, 0, ...Array.from({ length: this.paddingRows }, () => " ".repeat(Math.max(1, width - 2))));
		const theme = this.options.theme;
		const border = (text: string) => theme.fg(this.focused ? "accent" : "borderMuted", text);
		this.spans = { controls: [] };
		return lines.map((line, index) => {
			if (index === 0) return this.topFrame(width, caption, mode);
			// Native text and autocomplete rows are padded; only our border hooks emit empty rows.
			if (line === "") return this.bottomFrame(width, receipt, controls);
			return border("│") + line + border("│");
		});
	}

	invalidate(): void {
		this.editor.invalidate();
	}
}
