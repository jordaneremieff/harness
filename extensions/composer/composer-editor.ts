import { CustomEditor, type KeybindingsManager } from "@earendil-works/pi-coding-agent";
import {
	type AutocompleteProvider,
	type EditorComponent,
	type EditorTheme,
	type TUI,
	decodeKittyPrintable,
	isKeyRelease,
} from "@earendil-works/pi-tui";
import { DRAFT_BYTES, type ComposerEvent } from "./composer-bridge.ts";

const START_PASTE = "\x1b[200~";
const END_PASTE = "\x1b[201~";

function decodeModifyOtherKeys(data: string): string | undefined {
	const match = /^\x1b\[27;[12];([0-9]{1,7})~$/u.exec(data);
	if (!match || match[0] !== data) return undefined;
	const code = Number(match[1]);
	if (code > 0x10ffff) return undefined;
	const text = String.fromCodePoint(code);
	return /[\p{Cc}\p{Cf}\p{Cn}\p{Cs}\p{Zl}\p{Zp}]/u.test(text) ? undefined : text;
}

export class ComposerEditor extends CustomEditor {
	private visible = false;
	private reported = "";
	private paste?: string;
	private discardPaste = false;
	provider?: AutocompleteProvider;

	private readonly ui: TUI;
	private readonly keys: KeybindingsManager;
	private readonly emit: (event: ComposerEvent) => void;
	private readonly base?: EditorComponent;
	private readonly remember?: (text: string) => void;
	/**
	 * Pi's TUI sets `focused` on the component that receives terminal input. The editor loses it
	 * whenever a dialog, selector, extension view or focusing overlay takes the input, and Pi
	 * gives it back when that closes.
	 */
	onFocusChange?: (focused: boolean) => void;
	constructor(
		ui: TUI,
		theme: EditorTheme,
		keys: KeybindingsManager,
		emit: (event: ComposerEvent) => void,
		base?: EditorComponent,
		remember?: (text: string) => void,
	) {
		super(ui, theme, keys);
		this.ui = ui;
		this.keys = keys;
		this.emit = emit;
		this.base = base;
		this.remember = remember;
		// The base editor declares `focused` as an instance field, which a prototype accessor cannot observe.
		let focused = this.focused;
		Object.defineProperty(this, "focused", {
			configurable: true,
			enumerable: true,
			get: () => focused,
			set: (value: boolean) => {
				if (value === focused) return;
				focused = value;
				this.onFocusChange?.(value);
			},
		});
		if (base) {
			base.onChange = (text) => {
				this.onChange?.(text);
			};
			base.onSubmit = (text) => {
				this.onSubmit?.(text);
			};
		}
	}
	setVisible(visible: boolean): void {
		if (visible === this.visible) return;
		this.visible = visible;
		this.paste = undefined;
		this.discardPaste = false;
		this.ui.requestRender();
	}
	acceptDraft(text: string): void {
		this.reported = text;
		if (text !== this.getExpandedText()) this.setText(text);
	}
	setSubmissionText(text: string): void {
		if (this.base) this.base.setText(text);
		else super.setText(text);
	}
	reportHandoff(text: string): void {
		this.reported = text;
		this.emit({ type: "setText", text });
	}
	override getText(): string {
		return this.base?.getText() ?? super.getText();
	}
	override getExpandedText(): string {
		return this.base ? (this.base.getExpandedText?.() ?? this.base.getText()) : super.getExpandedText();
	}
	override setText(text: string): void {
		this.setSubmissionText(text);
		const current = this.getExpandedText();
		if (this.visible && current && current !== this.reported) this.reportHandoff(current);
	}
	override insertTextAtCursor(text: string): void {
		if (!text) return;
		if (this.visible) {
			if (Buffer.byteLength(text) <= DRAFT_BYTES && !/\p{Cs}/u.test(text)) this.emit({ type: "insert", text });
			else
				this.emit({
					type: "notice",
					level: "warning",
					text: "Composer insertion exceeds its text limit or is not valid Unicode.",
				});
		} else if (this.base?.insertTextAtCursor) this.base.insertTextAtCursor(text);
		else if (this.base) this.base.setText(this.getExpandedText() + text);
		else super.insertTextAtCursor(text);
	}
	override addToHistory(text: string): void {
		super.addToHistory(text);
		this.base?.addToHistory?.(text);
		this.remember?.(text);
	}
	override setAutocompleteProvider(provider: AutocompleteProvider): void {
		this.provider = provider;
		super.setAutocompleteProvider(provider);
		this.base?.setAutocompleteProvider?.(provider);
	}
	override setPaddingX(padding: number): void {
		super.setPaddingX(padding);
		this.base?.setPaddingX?.(padding);
	}
	override setAutocompleteMaxVisible(maxVisible: number): void {
		super.setAutocompleteMaxVisible(maxVisible);
		this.base?.setAutocompleteMaxVisible?.(maxVisible);
	}
	override render(width: number): string[] {
		if (this.visible) return [];
		if (!this.base) return super.render(width);
		if (this.base.borderColor !== undefined) this.base.borderColor = this.borderColor;
		if ("focused" in this.base) this.base.focused = this.focused;
		return this.base.render(width);
	}
	private appendPaste(chunk: string, final: boolean): void {
		if (this.discardPaste) return;
		const text = (this.paste ?? "") + chunk;
		if (final) this.insertTextAtCursor(text.replace(/\r\n?/gu, "\n"));
		else if (Buffer.byteLength(text) <= DRAFT_BYTES) this.paste = text;
		else {
			this.paste = undefined;
			this.discardPaste = true;
			this.emit({ type: "notice", level: "warning", text: "Composer paste exceeds 1 MiB of UTF-8." });
		}
	}
	private forwardPaste(data: string): boolean {
		let chunk = data;
		if (this.paste === undefined && !this.discardPaste) {
			if (!data.startsWith(START_PASTE)) return false;
			chunk = data.slice(START_PASTE.length);
		}
		const end = chunk.indexOf(END_PASTE);
		this.appendPaste(end === -1 ? chunk : chunk.slice(0, end), end !== -1);
		if (end !== -1) {
			this.paste = undefined;
			this.discardPaste = false;
			const rest = chunk.slice(end + END_PASTE.length);
			if (rest) this.handleInput(rest);
		}
		return true;
	}
	private fallbackInput(data: string): void {
		if (this.base instanceof CustomEditor) {
			this.base.onExtensionShortcut ??= this.onExtensionShortcut;
			this.base.onEscape ??= this.onEscape;
			this.base.onCtrlD ??= this.onCtrlD;
			this.base.onPasteImage ??= this.onPasteImage;
			for (const [action, handler] of this.actionHandlers)
				if (!this.base.actionHandlers.has(action)) this.base.onAction(action, handler);
		}
		if (this.base) this.base.handleInput(data);
		else super.handleInput(data);
	}
	private appInput(data: string): boolean {
		const keys = this.keys;
		if (keys.matches(data, "app.clipboard.pasteImage")) {
			this.onPasteImage?.();
			return true;
		}
		if (keys.matches(data, "app.interrupt")) {
			(this.onEscape ?? this.actionHandlers.get("app.interrupt"))?.();
			return true;
		}
		if (keys.matches(data, "app.exit")) {
			if (!this.getText()) (this.onCtrlD ?? this.actionHandlers.get("app.exit"))?.();
			return true;
		}
		if (keys.matches(data, "tui.editor.historyPrevious") || keys.matches(data, "tui.editor.historyNext")) return true;
		for (const [action, handler] of this.actionHandlers) {
			if (action !== "app.interrupt" && action !== "app.exit" && keys.matches(data, action)) {
				handler();
				return true;
			}
		}
		return false;
	}
	override handleInput(data: string): void {
		if (!this.visible) {
			this.fallbackInput(data);
			return;
		}
		if (this.forwardPaste(data) || isKeyRelease(data) || this.onExtensionShortcut?.(data) || this.appInput(data))
			return;
		if (this.keys.matches(data, "tui.input.submit")) {
			this.emit({ type: "focus" });
			return;
		}
		const decoded = decodeKittyPrintable(data) ?? decodeModifyOtherKeys(data);
		if (decoded) this.insertTextAtCursor(decoded);
		else if (data && !/\p{Cc}/u.test(data)) this.insertTextAtCursor(data);
	}
}
