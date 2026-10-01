import { getSelectListTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { type Component, Editor, type Focusable, type TUI } from "@earendil-works/pi-tui";

/**
 * Multiline composer for dashboard message and task drafts over pi-tui's
 * native editor, through its public API only. The interactive host installs
 * the same keybinding manager it passes to custom UI factories as pi-tui's
 * global table, and the native editor consults that table, so submit and
 * newline routing needs no adapter.
 */
export class AgentMessageEditor implements Component, Focusable {
	private readonly editor: Editor;

	constructor(tui: TUI, theme: Theme, onSubmit: (text: string) => void) {
		this.editor = new Editor(tui, {
			borderColor: (text) => theme.fg("borderMuted", text),
			selectList: getSelectListTheme(),
		});
		this.editor.onSubmit = (text) => onSubmit(text);
	}

	get focused(): boolean {
		return this.editor.focused;
	}
	set focused(value: boolean) {
		this.editor.focused = value;
	}

	/**
	 * Fully expanded current content, including live paste markers. The
	 * native editor clears its content before it invokes `onSubmit`, so the
	 * callback argument supplies the submitted value, not a later call to
	 * this method.
	 */
	getText(): string {
		return this.editor.getExpandedText();
	}

	/**
	 * Replace the draft. Line endings normalize to LF and tabs to spaces;
	 * previously pasted marker text becomes literal content again.
	 */
	setText(text: string): void {
		this.editor.setText(text);
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
