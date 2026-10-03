/**
 * Per-agent composer over the native CustomEditor. One instance owns the caret
 * for one agent; the dashboard focuses exactly one composer at a time and stores
 * drafts outside the editor, so a selection change or reopen keeps
 * the text.
 */
import { CustomEditor, getSelectListTheme, type KeybindingsManager, type Theme } from "@earendil-works/pi-coding-agent";
import {
	matchesKey,
	parseKey,
	type Component,
	type Focusable,
	type TUI,
	type TuiMouseEvent,
	type TuiMouseEventResult,
} from "@earendil-works/pi-tui";

import { dashboardHeading } from "./dashboard-layout.ts";

class ComposerEditor extends CustomEditor {
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

export class AgentComposer implements Component, Focusable {
	private readonly editor: ComposerEditor;
	private readonly options: AgentComposerOptions;

	constructor(options: AgentComposerOptions) {
		this.options = options;
		const tui = new Proxy(options.tui, {
			get(target, key) {
				if (key === "terminal")
					return new Proxy(target.terminal, {
						get(terminal, name) {
							return name === "rows" ? 20 : Reflect.get(terminal, name);
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
			options.keys,
		);
		this.editor.disableSubmit = true;
		this.editor.onChange = () => options.onChange?.(this.editor.getExpandedText());
		this.editor.onEscape = () => options.onEscape();
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
		if (matchesKey(data, "escape")) {
			this.options.onEscape();
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
		const key = parseKey(data);
		if (key?.includes("alt+") || /^f\d+$/.test(key ?? "")) return;
		this.editor.handleInput(data);
		this.options.onChange?.(this.getText());
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.x < 1 || event.x >= event.width - 1) return;
		return this.editor.handleMouse({ ...event, x: event.x - 1, width: event.width - 2 });
	}

	render(width: number, caption = "Message"): string[] {
		const lines = this.editor.render(Math.max(1, width - 2));
		const theme = this.options.theme;
		const border = (text: string) => theme.fg(this.focused ? "accent" : "borderMuted", text);
		return lines.map((line, index) => {
			if (index === 0)
				return dashboardHeading(caption, this.editor.topHidden ? `↑ ${this.editor.topHidden} lines` : "", width, theme);
			// Native text and autocomplete rows are padded; only our border hooks emit empty rows.
			if (line === "")
				return dashboardHeading(
					"",
					this.editor.bottomHidden ? `↓ ${this.editor.bottomHidden} lines` : "",
					width,
					theme,
					true,
				);
			return border("│") + line + border("│");
		});
	}

	invalidate(): void {
		this.editor.invalidate();
	}
}
