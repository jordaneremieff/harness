/**
 * Per-peer composer over the native CustomEditor. One instance owns the caret
 * for one peer; the window focuses exactly one composer at a time and stores
 * drafts outside the editor, so a focus switch, Expand, Close, or reopen keeps
 * the text.
 */
import { CustomEditor, getSelectListTheme, type KeybindingsManager, type Theme } from "@earendil-works/pi-coding-agent";
import type { Component, Focusable, TUI } from "@earendil-works/pi-tui";

export interface PeerComposerOptions {
	tui: TUI;
	theme: Theme;
	keys: KeybindingsManager;
	/** Receives the submitted text; the native editor clears its own buffer first. */
	onSubmit(text: string): void;
	/** Receives every text change; the pane uses it to retain a recoverable draft. */
	onChange?(text: string): void;
	/** Escape with no autocomplete open; the window decides focus or exit. */
	onEscape(): void;
}

export class PeerComposer implements Component, Focusable {
	private readonly editor: CustomEditor;

	constructor(options: PeerComposerOptions) {
		this.editor = new CustomEditor(options.tui, {
			borderColor: (text) => options.theme.fg("borderMuted", text),
			selectList: getSelectListTheme(),
		}, options.keys);
		this.editor.onSubmit = (text) => options.onSubmit(text);
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

	handleInput(data: string): void {
		this.editor.handleInput(data);
	}

	render(width: number): string[] {
		return this.editor.render(width);
	}

	invalidate(): void {
		this.editor.invalidate();
	}
}
