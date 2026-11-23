/**
 * The reader and the staged form of the stash views, on pi-tui's Editor and width helpers. Both
 * follow the view shape in frame.ts, so the ordinary frame and the Agent terminal host them alike.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	CURSOR_MARKER,
	Editor,
	getKeybindings,
	matchesKey,
	type TUI,
	type TuiMouseEvent,
	type TuiMouseEventResult,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { type Action, fitLine, type KeyHint, plainLine, type View, type ViewHost } from "./frame.ts";

/** Wrapped display lines; an empty line stays one empty line. */
export function wrap(text: string, width: number): string[] {
	const columns = Math.max(1, Math.floor(width));
	return text.split("\n").flatMap((line) => (line === "" ? [""] : wrapTextWithAnsi(line, columns)));
}

/**
 * Read-only scrolling lines with a scrollbar column. The reading position stays while the content
 * key stays the same, so rereading the same record does not jump.
 */
export class Reader {
	private offset = 0;
	private height = 1;
	private total = 0;
	private key?: string;

	/** Start a new content: a different key starts at the top. */
	show(key: string | undefined): void {
		if (key === undefined || key !== this.key) this.offset = 0;
		this.key = key;
	}

	scroll(delta: number): void {
		this.offset = Math.max(0, Math.min(Math.max(0, this.total - this.height), this.offset + delta));
	}

	render(lines: readonly string[], width: number, height: number, theme: Theme): string[] {
		this.height = Math.max(1, height);
		this.total = lines.length;
		this.offset = Math.max(0, Math.min(Math.max(0, this.total - this.height), this.offset));
		const overflow = this.total > this.height;
		const thumb = overflow ? Math.max(1, Math.round((this.height * this.height) / this.total)) : 0;
		const thumbTop = overflow
			? Math.round(((this.height - thumb) * this.offset) / Math.max(1, this.total - this.height))
			: 0;
		return Array.from({ length: this.height }, (_, row) => {
			const text = lines[this.offset + row] ?? "";
			if (width <= 8) return fitLine(text, width);
			const bar = !overflow
				? " "
				: row >= thumbTop && row < thumbTop + thumb
					? theme.fg("scrollbarThumb", "┃")
					: theme.fg("scrollbarTrack", "│");
			return fitLine(text, width - 1) + bar;
		});
	}

	/** Up, Down, PageUp, PageDown, Home and End read; other keys are not the reader's. */
	handleInput(data: string): boolean {
		const page = Math.max(1, this.height - 1);
		if (matchesKey(data, "up")) this.scroll(-1);
		else if (matchesKey(data, "down")) this.scroll(1);
		else if (matchesKey(data, "pageUp")) this.scroll(-page);
		else if (matchesKey(data, "pageDown")) this.scroll(page);
		else if (matchesKey(data, "home")) this.offset = 0;
		else if (matchesKey(data, "end")) this.offset = Number.MAX_SAFE_INTEGER;
		else return false;
		return true;
	}
}

export const READER_KEYS: readonly KeyHint[] = [
	{ keys: ["up", "down"], label: "scroll" },
	{ keys: ["pageUp", "pageDown"], label: "page" },
];

/** A text view with its own reading position, for help. */
export function readerView(title: string, host: ViewHost, text: () => string): View {
	const reader = new Reader();
	reader.show(title);
	return {
		title,
		render: (width, height) => reader.render(wrap(text(), Math.max(1, width - 1)), width, height, host.theme),
		handleInput: (data) => reader.handleInput(data),
		handleMouse: (event) => {
			if (event.type !== "wheel" || !event.wheelDelta) return undefined;
			reader.scroll(Math.trunc(event.wheelDelta));
			return { handled: true };
		},
		keys: () => READER_KEYS,
	};
}

/** Pi's Editor without its rules; the form draws its own edge. */
class AreaEditor extends Editor {
	protected override renderTopBorder(): string {
		return "";
	}
	protected override renderBottomBorder(): string {
		return "";
	}
}

export interface FormOptions {
	readonly title: string;
	/** The first row, naming the effect and its target. */
	readonly heading: string;
	readonly intro: string;
	/** One multi-line field, or none for a confirmation. */
	readonly field?: { readonly label: string; readonly rows: number };
	/** The submit action, named for its effect. */
	readonly action: { readonly label: string; readonly tone?: "accent" | "danger" };
	readonly host: ViewHost;
	validate?(value: string): string | undefined;
	/** The single owner call. A rejection keeps the text and shows the reason. */
	submit(value: string): Promise<{ notice?: { text: string; kind: "success" }; after?: () => void } | undefined>;
}

/**
 * A staged form with one multi-line field or none. Enter submits; the newline keys break lines in
 * the field. Cancel and Escape send nothing and return to the view beneath.
 */
export class Form implements View {
	readonly title: string;
	focused = false;
	private readonly options: FormOptions;
	private readonly editor?: AreaEditor;
	private rows: number;
	private pending = false;
	private error?: string;
	/** Rows of the field's editor in the last render, for pointer events. */
	private area = { top: 0, height: 0 };

	constructor(options: FormOptions) {
		this.options = options;
		this.title = options.title;
		this.rows = Math.max(1, options.field?.rows ?? 1);
		if (!options.field) return;
		const form = this;
		// The editor sizes its viewport from the terminal height; this host gives it the field's rows.
		const host = {
			terminal: {
				get rows() {
					return Math.ceil(form.rows / 0.3);
				},
				get columns() {
					return 200;
				},
			},
			requestRender: () => options.host.requestRender(),
		};
		const theme = options.host.theme;
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
		this.editor.onChange = () => {
			this.error = undefined;
		};
	}

	private label(): string {
		const text = plainLine(this.options.action.label);
		return `${text.charAt(0).toLocaleLowerCase()}${text.slice(1)}`;
	}

	actions(): readonly Action[] {
		return [
			{
				id: "submit",
				label: this.pending ? `${this.options.action.label}…` : this.options.action.label,
				key: "enter",
				primary: true,
				tone: this.options.action.tone ?? "accent",
				...(this.pending ? { disabled: "The request is still running" } : {}),
				run: () => void this.submit(),
			},
			{ id: "cancel", label: "Cancel", key: "escape", primary: true, run: () => this.options.host.back() },
		];
	}

	/** While the field has focus the key row shows only its keys: Enter submits, the newline keys break lines. */
	keys(): readonly KeyHint[] {
		if (!this.editor) return [];
		const newline = getKeybindings().getKeys("tui.input.newLine");
		return [{ keys: ["enter"], label: this.label() }, ...(newline.length ? [{ keys: newline, label: "newline" }] : [])];
	}

	editing(): boolean {
		return this.editor !== undefined;
	}

	async submit(): Promise<void> {
		if (this.pending) return;
		const value = this.editor?.getExpandedText() ?? "";
		const problem = this.options.validate?.(value);
		const host = this.options.host;
		if (problem) {
			this.error = problem;
			host.requestRender();
			return;
		}
		this.pending = true;
		this.error = undefined;
		host.requestRender();
		try {
			const result = await this.options.submit(value);
			if (host.signal.aborted) return;
			if (result?.notice) host.notify(result.notice.text, result.notice.kind);
			host.back();
			result?.after?.();
		} catch (error) {
			if (!host.signal.aborted) this.error = error instanceof Error ? error.message : String(error);
		} finally {
			this.pending = false;
			if (!host.signal.aborted) host.requestRender();
		}
	}

	handleInput(data: string): boolean {
		if (!this.editor) return false;
		if (this.pending) return true;
		// The newline keys come first: a legacy terminal sends Ctrl+J as the byte Enter also uses.
		if (getKeybindings().matches(data, "tui.input.newLine")) this.editor.handleInput(data);
		else if (matchesKey(data, "enter")) void this.submit();
		else this.editor.handleInput(data);
		return true;
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (
			!this.editor ||
			event.type !== "click" ||
			event.y < this.area.top ||
			event.y >= this.area.top + this.area.height
		)
			return undefined;
		this.editor.handleMouse({
			...event,
			x: Math.max(0, event.x - 1),
			y: event.y - this.area.top,
			width: Math.max(1, event.width - 2),
			height: this.area.height,
		});
		return { handled: true };
	}

	/** The heading, then the intro and the field, then the pending and error rows at the bottom. */
	render(width: number, height: number): string[] {
		const theme = this.options.host.theme;
		const status: string[] = [];
		if (this.pending) status.push(theme.fg("warning", "Sending… the form stays until the owner answers."));
		if (this.error) for (const line of wrap(plainLine(this.error), width)) status.push(theme.fg("error", line));
		const body = [...wrap(plainLine(this.options.intro), width).map((line) => theme.fg("muted", line)), ""];
		if (this.editor)
			body.push(...this.fieldRows(this.editor, width, height - body.length - status.length - 2, 1 + body.length));
		const room = Math.max(0, height - 1 - status.length);
		return [theme.bold(plainLine(this.options.heading)), ...body.slice(0, room), ...status]
			.slice(0, height)
			.map((line) => fitLine(line, width));
	}

	/** The field's label and a window of the editor's rows that keeps the caret visible; `top` is the label's row. */
	private fieldRows(editor: AreaEditor, width: number, room: number, top: number): string[] {
		const theme = this.options.host.theme;
		editor.focused = this.focused;
		this.rows = Math.max(1, Math.min(this.options.field?.rows ?? 1, room));
		const rows = editor.render(Math.max(1, width - 2)).filter((line) => line !== "");
		const caret = rows.findIndex((line) => line.includes(CURSOR_MARKER));
		const first = caret < 0 ? 0 : Math.max(0, Math.min(Math.max(0, rows.length - this.rows), caret - this.rows + 1));
		const edge = theme.fg(this.focused ? "accent" : "borderMuted", "▏");
		this.area = { top: top + 1, height: this.rows };
		const lines = [theme.fg(this.focused ? "accent" : "muted", plainLine(this.options.field?.label ?? ""))];
		for (let row = 0; row < this.rows; row++)
			lines.push(`${edge}${fitLine(rows[first + row] ?? "", Math.max(1, width - 1))}`);
		return lines;
	}
}
