/**
 * Per-agent composer over the native CustomEditor. One instance owns the caret
 * for one agent; the dashboard focuses exactly one composer at a time and stores
 * drafts outside the editor, so a selection change or reopen keeps
 * the text.
 */
import { CustomEditor, getSelectListTheme, type KeybindingsManager, type Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, parseKey, type Component, type Focusable, type TUI } from "@earendil-works/pi-tui";

export interface AgentComposerOptions {
	tui: TUI;
	theme: Theme;
	keys: KeybindingsManager;
	/** Receives the submitted text; the native editor clears its own buffer first. */
	onSubmit(text: string): void;
	/** Receives every text change; the console uses it to retain a recoverable draft. */
	onChange?(text: string): void;
	/** Escape with no autocomplete open; the dashboard decides focus or exit. */
	onEscape(): void;
}

export class AgentComposer implements Component, Focusable {
	private readonly editor: CustomEditor;
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
		this.editor = new CustomEditor(
			tui,
			{
				borderColor: (text) => options.theme.fg("borderMuted", text),
				selectList: getSelectListTheme(),
			},
			options.keys,
		);
		this.editor.disableSubmit = true;
		this.editor.onChange = (text) => options.onChange?.(text);
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

	render(width: number): string[] {
		return this.editor.render(width);
	}

	invalidate(): void {
		this.editor.invalidate();
	}
}
