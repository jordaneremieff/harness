import type { Theme } from "@earendil-works/pi-coding-agent";
import { Editor, Input, type TUI, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";
import { fitLine, plainLine, visibleWidth } from "./text.ts";

/** A single-line field: a label column, then the native pi-tui Input with its cursor and editing keys. */
export class TextField {
	readonly input: Input;
	label: string;
	private readonly change?: (value: string) => void;

	constructor(label: string, value = "", change?: (value: string) => void) {
		this.label = label;
		// The label column names the field, so the input draws no prompt of its own.
		this.input = new Input({ prompt: "" });
		this.place(value);
		this.change = change;
	}

	/** Replace the value with the cursor after its last character, where typing continues it. */
	private place(value: string): void {
		this.input.setValue("");
		// A bracketed paste is the input's public way to insert text and move the cursor past it.
		if (value) this.input.handleInput(`\u001b[200~${value}\u001b[201~`);
	}

	get focused(): boolean {
		return this.input.focused;
	}

	set focused(value: boolean) {
		this.input.focused = value;
	}

	get value(): string {
		return this.input.getValue();
	}

	set value(value: string) {
		this.place(value);
	}

	/** Keys for the input. Returns true when the value or cursor may have changed. */
	handleInput(data: string): boolean {
		const before = this.input.getValue();
		this.input.handleInput(data);
		const after = this.input.getValue();
		if (after !== before) this.change?.(after);
		return true;
	}

	handleMouse(event: TuiMouseEvent, labelWidth: number): TuiMouseEventResult | undefined {
		if (event.x < labelWidth) return { handled: true, focus: true };
		return this.input.handleMouse({ ...event, x: event.x - labelWidth, width: Math.max(1, event.width - labelWidth) });
	}

	render(width: number, theme: Theme, labelWidth: number, placeholder = ""): string {
		const label = fitLine(theme.fg(this.focused ? "accent" : "muted", plainLine(this.label)), labelWidth);
		const room = Math.max(1, width - labelWidth);
		if (!this.focused && !this.input.getValue() && placeholder) return label + fitLine(theme.fg("dim", placeholder), room);
		const [line = ""] = this.input.render(room);
		return label + fitLine(line, room);
	}
}

class AreaEditor extends Editor {
	protected override renderTopBorder(): string {
		return "";
	}
	protected override renderBottomBorder(): string {
		return "";
	}
}

/**
 * A multiline field over the native pi-tui Editor: native cursor, paste, word movement and undo.
 * Enter inserts a line break; submission belongs to the form's labelled action.
 */
export class TextArea {
	readonly editor: Editor;
	label: string;
	private visible: number;
	private readonly change?: (value: string) => void;

	constructor(label: string, theme: Theme, requestRender: () => void, value = "", rows = 4, change?: (value: string) => void) {
		this.label = label;
		this.visible = Math.max(1, rows);
		this.change = change;
		const area = this;
		// The editor sizes its viewport from the terminal height; this host gives it the field's rows.
		const host = {
			terminal: {
				get rows() {
					return Math.ceil(area.visible / 0.3);
				},
				get columns() {
					return 200;
				},
			},
			requestRender,
		};
		this.editor = new AreaEditor(host as unknown as TUI, {
			borderColor: (text) => theme.fg("borderMuted", text),
			selectList: {
				selectedPrefix: (text) => theme.fg("accent", text),
				selectedText: (text) => theme.fg("accent", text),
				description: (text) => theme.fg("muted", text),
				scrollInfo: (text) => theme.fg("dim", text),
				noMatch: (text) => theme.fg("dim", text),
			},
		});
		this.editor.disableSubmit = true;
		this.editor.setText(value);
	}

	set rows(value: number) {
		this.visible = Math.max(1, value);
	}

	get focused(): boolean {
		return this.editor.focused;
	}

	set focused(value: boolean) {
		this.editor.focused = value;
	}

	get value(): string {
		return this.editor.getExpandedText();
	}

	set value(value: string) {
		this.editor.setText(value);
	}

	handleInput(data: string): boolean {
		const before = this.value;
		// Enter is a line break here; the editor's newline binding inserts one.
		this.editor.handleInput(data === "\r" ? "\n" : data);
		const after = this.value;
		if (after !== before) this.change?.(after);
		return true;
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		return this.editor.handleMouse(event);
	}

	/** The label line, then the editor's rows. */
	render(width: number, theme: Theme): string[] {
		const rows = this.editor.render(Math.max(1, width - 2)).filter((line) => line !== "");
		const label = fitLine(theme.fg(this.focused ? "accent" : "muted", plainLine(this.label)), width);
		const edge = theme.fg(this.focused ? "accent" : "borderMuted", "▏");
		const body = rows.slice(0, Math.max(this.visible, 1)).map((line) => `${edge}${fitLine(line, Math.max(1, width - 1))}`);
		while (body.length < this.visible) body.push(`${edge}${" ".repeat(Math.max(0, width - 1))}`);
		return [label, ...body];
	}

	/** Column width of the rendered label line, for pointer offsets. */
	static labelWidth(label: string): number {
		return visibleWidth(plainLine(label));
	}
}
