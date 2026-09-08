import type { ExtensionCommandContext, KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import {
	CURSOR_MARKER,
	decodeKittyPrintable,
	Editor,
	Input,
	Key,
	matchesKey,
	type TUI,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { cleanConsoleText } from "./console.ts";
import { clipText, footerLine, headerPair } from "./panel.ts";
import type { ProfileEntry } from "./profiles.ts";

export type ProfilePanelDefinition = Pick<
	Extract<ProfileEntry, { ok: true }>,
	"enabled" | "model" | "thinking" | "cwd" | "grounding" | "instructions"
>;

/** Store operations own validation, persistence, and stale-write rejection. */
export interface ProfilePanelDeps {
	list(): { entries: ProfileEntry[]; truncated: boolean };
	read(name: string): ProfileEntry;
	create(name: string, definition: ProfilePanelDefinition): ProfileEntry;
	update(name: string, definition: ProfilePanelDefinition, expectedSha256: string): ProfileEntry;
	remove(name: string, expectedSha256: string): void;
	setEnabled(name: string, enabled: boolean, expectedSha256: string): ProfileEntry;
}

const fields = [
	"Name",
	"Model",
	"Thinking",
	"Working directory",
	"Grounding JSON",
	"Enabled",
	"Default instructions",
	"Save",
	"Cancel",
];
const levels = ["", "off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
const help = [
	"Profiles supply defaults and source pointers for future dispatches. They are not permission sets.",
	"List: Up/Down selects a profile. Enter or e edits it. n creates a profile.",
	"t enables or disables the selected profile. d opens removal confirmation. r refreshes the store.",
	"/ edits the name filter. Enter applies the filter; Escape cancels it.",
	"Editor: Tab/Down selects the next field. Shift+Tab/Up selects the previous field.",
	"Type in text fields. Left/Right or Space changes Thinking and Enabled.",
	"Enter advances, or activates Save/Cancel. Ctrl+S saves from any field. Escape cancels without a write.",
	"Default instructions: Enter inserts a newline. Arrow keys move the cursor. Tab/Shift+Tab changes the field.",
	"The native text editor normalizes line endings and tabs after an instructions edit. Unchanged instructions stay exact.",
	"Blank Model, Thinking, or Working directory inherits the dispatch default.",
	'Grounding JSON is an array of source pointers, for example [{"name":"guide","path":"/docs/guide.md"}].',
	"A stale save retains the draft. Cancel and reopen the profile to read its current version.",
	"Broken profiles require replacement fields. Files without a readable digest refuse edits and removal.",
	"Help: Up/Down scrolls. Escape returns. List: Escape closes the panel.",
];
function clean(value: string): string {
	return cleanConsoleText(value).replace(/[\p{Cc}\p{Cf}]/gu, " ");
}
function padded(value: string, width: number): string {
	const line = truncateToWidth(value, Math.max(0, width), "");
	return line + " ".repeat(Math.max(0, width - visibleWidth(line)));
}
function digest(entry: ProfileEntry): string {
	if (!("sha256" in entry) || typeof entry.sha256 !== "string")
		throw new Error("No readable digest. Refresh after repair outside this panel.");
	return entry.sha256;
}

type Draft = {
	name: string | null;
	sha256?: string;
	inputs: Input[];
	thinking: number;
	enabled: boolean;
	instructions: Editor;
	originalInstructions: string;
	initialEditorText: string;
};

class ProfilePanel {
	private entries: ProfileEntry[] = [];
	private truncated = false;
	private selected: string | null = null;
	private filter: string;
	private search: Input | null = null;
	private draft: Draft | null = null;
	private field = 0;
	private removal: { name: string; sha256: string } | null = null;
	private confirmRemove = false;
	private helpOpen = false;
	private helpScroll = 0;
	private notice = "";
	private closed = false;
	private _focused = false;

	private deps: ProfilePanelDeps;
	private tui: TUI;
	private theme: Theme;
	private keys: KeybindingsManager;
	private done: () => void;
	constructor(deps: ProfilePanelDeps, tui: TUI, theme: Theme, keys: KeybindingsManager, done: () => void, filter = "") {
		this.deps = deps;
		this.tui = tui;
		this.theme = theme;
		this.keys = keys;
		this.done = done;
		this.filter = clean(filter);
		this.attempt(() => this.refresh());
	}
	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
		this.forwardFocus();
	}
	private activeInput(): Input | null {
		return (
			this.search ??
			(this.draft && [0, 1, 3, 4].includes(this.field) && (this.field !== 0 || this.draft.name === null)
				? this.draft.inputs[this.field]
				: null)
		);
	}
	private forwardFocus(): void {
		for (const input of this.draft?.inputs ?? []) if (input) input.focused = false;
		if (this.search) this.search.focused = false;
		if (this.draft) this.draft.instructions.focused = this.field === 6 && this._focused && !this.closed;
		const input = this.activeInput();
		if (input) input.focused = this._focused && !this.closed;
	}
	private attempt(action: () => void): void {
		try {
			action();
		} catch (error) {
			this.notice = clean(error instanceof Error ? error.message : String(error));
		}
	}
	private visible(): ProfileEntry[] {
		return this.entries.filter((entry) => entry.name.toLowerCase().includes(this.filter.toLowerCase()));
	}
	private refresh(preferred = this.selected): void {
		const result = this.deps.list();
		this.entries = result.entries;
		this.truncated = result.truncated;
		const visible = this.visible();
		this.selected = visible.some((entry) => entry.name === preferred) ? preferred : (visible[0]?.name ?? null);
	}
	private input(value: string): Input {
		const input = new Input();
		input.setValue(clean(value));
		return input;
	}
	private edit(create: boolean): void {
		if (!create && !this.selected) return;
		const entry = create ? null : this.deps.read(this.selected!);
		const sha256 = entry ? digest(entry) : undefined;
		const good = entry?.ok ? entry : null;
		const instructions = new Editor(this.tui, {
			borderColor: (text) => this.theme.fg("borderMuted", text),
			selectList: {
				selectedPrefix: (text) => this.theme.fg("accent", text),
				selectedText: (text) => this.theme.fg("accent", text),
				description: (text) => this.theme.fg("muted", text),
				scrollInfo: (text) => this.theme.fg("dim", text),
				noMatch: (text) => this.theme.fg("warning", text),
			},
		});
		instructions.disableSubmit = true;
		instructions.setText(good?.instructions ?? "");
		this.draft = {
			instructions,
			originalInstructions: good?.instructions ?? "",
			initialEditorText: instructions.getExpandedText(),
			name: entry?.name ?? null,
			sha256,
			inputs: [
				this.input(entry?.name ?? ""),
				this.input(good?.model ?? ""),
				this.input(""),
				this.input(good?.cwd ?? ""),
				this.input(JSON.stringify(good?.grounding ?? [])),
			],
			thinking: levels.indexOf(good?.thinking ?? ""),
			enabled: good?.enabled ?? true,
		};
		this.field = entry ? 1 : 0;
		if (entry && !entry.ok) this.notice = "Broken profile. Enter replacement fields before Save.";
	}
	private save(): void {
		const draft = this.draft;
		if (!draft) return;
		let grounding: ProfilePanelDefinition["grounding"];
		try {
			grounding = JSON.parse(draft.inputs[4].getValue());
		} catch {
			throw new Error("Grounding must contain valid JSON. The draft remains unchanged.");
		}
		const definition: ProfilePanelDefinition = { enabled: draft.enabled, grounding };
		const model = draft.inputs[1].getValue().trim();
		const cwd = draft.inputs[3].getValue().trim();
		const editedInstructions = draft.instructions.getExpandedText();
		const instructions =
			editedInstructions === draft.initialEditorText ? draft.originalInstructions : editedInstructions;
		if (instructions.trim()) definition.instructions = instructions;
		if (model) definition.model = model;
		if (cwd) definition.cwd = cwd;
		if (levels[draft.thinking]) definition.thinking = levels[draft.thinking] || undefined;
		const name = draft.name ?? draft.inputs[0].getValue().trim();
		const entry =
			draft.name === null ? this.deps.create(name, definition) : this.deps.update(name, definition, draft.sha256!);
		if (!entry.ok) throw new Error(entry.error);
		this.draft = null;
		this.filter = "";
		this.notice = `Saved ${clean(entry.name)}.`;
		this.refresh(entry.name);
	}
	private move(amount: number): void {
		const entries = this.visible();
		const index = entries.findIndex((entry) => entry.name === this.selected);
		this.selected = entries[Math.max(0, Math.min(entries.length - 1, index + amount))]?.name ?? null;
	}
	private matches(data: string, action: "up" | "down" | "confirm" | "cancel"): boolean {
		return (
			this.keys?.matches(data, `tui.select.${action}`) ??
			matchesKey(data, action === "confirm" ? Key.enter : action === "cancel" ? Key.escape : action)
		);
	}
	handleInput(data: string): void {
		if (this.closed) return;
		const key = decodeKittyPrintable(data) ?? data;
		const cancel = this.matches(data, "cancel") || matchesKey(data, Key.escape);
		const enter = this.matches(data, "confirm");
		const up = this.matches(data, "up");
		const down = this.matches(data, "down");
		this.attempt(() => {
			if (cancel) {
				if (this.helpOpen) this.helpOpen = false;
				else if (this.search) this.search = null;
				else if (this.draft) this.draft = null;
				else if (this.removal) this.removal = null;
				else {
					this.dispose();
					this.done();
				}
				this.notice = "";
			} else if (this.helpOpen) {
				if (up) this.helpScroll = Math.max(0, this.helpScroll - 1);
				if (down) this.helpScroll++;
			} else if (this.search) {
				if (enter) {
					this.filter = this.search.getValue();
					this.search = null;
					this.refresh();
				} else this.feed(this.search, data);
			} else if (this.removal) {
				if (up || down || matchesKey(data, Key.tab) || matchesKey(data, Key.left) || matchesKey(data, Key.right))
					this.confirmRemove = !this.confirmRemove;
				else if (enter) {
					if (this.confirmRemove) {
						this.deps.remove(this.removal.name, this.removal.sha256);
						this.notice = `Removed ${clean(this.removal.name)}.`;
						this.removal = null;
						this.refresh();
					} else this.removal = null;
				}
			} else if (this.draft) {
				if (matchesKey(data, Key.ctrl("s"))) this.save();
				else if (matchesKey(data, Key.shift("tab")) || (up && this.field !== 6))
					this.field = (this.field + fields.length - 1) % fields.length;
				else if (matchesKey(data, Key.tab) || (down && this.field !== 6)) this.field = (this.field + 1) % fields.length;
				else if (this.field === 6) {
					const editor = this.draft.instructions;
					const before = editor.getExpandedText();
					if (enter) editor.insertTextAtCursor("\n");
					else editor.handleInput(data);
					if ([...editor.getExpandedText()].some((char) => /[\p{Cc}\p{Cf}]/u.test(char) && !"\r\n\t".includes(char))) {
						editor.setText(before);
						throw new Error("Default instructions refuse control characters. The prior draft remains unchanged.");
					}
				} else if (enter) {
					if (this.field === 7) this.save();
					else if (this.field === 8) this.draft = null;
					else this.field++;
				} else if (this.field === 2 && (key === " " || matchesKey(data, Key.left) || matchesKey(data, Key.right))) {
					this.draft.thinking =
						(this.draft.thinking + (matchesKey(data, Key.left) ? levels.length - 1 : 1)) % levels.length;
				} else if (this.field === 5 && (key === " " || matchesKey(data, Key.left) || matchesKey(data, Key.right)))
					this.draft.enabled = !this.draft.enabled;
				else {
					const input = this.activeInput();
					if (input) this.feed(input, data);
				}
			} else {
				this.notice = "";
				if (up) this.move(-1);
				else if (down) this.move(1);
				else if (key === "n") this.edit(true);
				else if (key === "e" || enter) this.edit(false);
				else if (key === "r") this.refresh();
				else if (key === "/") this.search = this.input(this.filter);
				else if (key === "?") {
					this.helpOpen = true;
					this.helpScroll = 0;
				} else if (this.selected && key === "d") {
					const entry = this.deps.read(this.selected);
					this.removal = { name: entry.name, sha256: digest(entry) };
					this.confirmRemove = false;
				} else if (this.selected && key === "t") {
					const entry = this.entries.find((entry) => entry.name === this.selected)!;
					if (!entry.ok) throw new Error("Broken profile. Edit the replacement fields before enable or disable.");
					const updated = this.deps.setEnabled(entry.name, !entry.enabled, entry.sha256);
					if (!updated.ok) throw new Error(updated.error);
					this.refresh(updated.name);
				}
			}
		});
		this.forwardFocus();
		this.tui.requestRender();
	}
	private feed(input: Input, data: string): void {
		input.handleInput(data);
		const value = input.getValue();
		const safe = clean(value);
		if (safe !== value) input.setValue(safe);
	}
	private background(color: "customMessageBg" | "selectedBg", text: string): string {
		return this.theme.bg(
			color,
			text.replace(/\x1b\[(?:0|49)?m/g, (reset) => reset + this.theme.getBgAnsi(color)),
		);
	}
	private selectedLine(value: string, width: number): string {
		return this.background("selectedBg", padded(value, width));
	}
	private fieldValue(index: number): string {
		if (!this.draft) return "";
		if (index === 2) return levels[this.draft.thinking] || "inherit";
		if (index === 5) return this.draft.enabled ? "true" : "false";
		if (index === 6) return this.draft.instructions.getExpandedText() || "(blank)";
		if (index > 6) return "Enter";
		return this.draft.inputs[index].getValue() || "(blank)";
	}
	render(width: number): string[] {
		if (width <= 0) return [];
		const height = Math.max(1, this.tui.terminal.rows - 2);
		const framed = width >= 24 && height >= 10;
		const inner = Math.max(1, width - (framed ? 4 : 0));
		const capacity = Math.max(1, height - (framed ? 3 : 0));
		const lines: string[] = [];
		const body = Math.max(0, capacity - 1);
		const add = (line: string) => {
			if (lines.length < body) lines.push(clipText(line, inner));
		};
		let controls = [
			{ key: "?", label: "help" },
			{ key: "n", label: "new" },
			{ key: "↑↓", label: "select" },
			{ key: "enter", label: "edit" },
			{ key: "t", label: "toggle" },
			{ key: "d", label: "remove" },
			{ key: "r", label: "refresh" },
			{ key: "/", label: "filter" },
		];
		let exit = "close";
		if (this.helpOpen) {
			exit = "back";
			controls = [{ key: "↑↓", label: "scroll" }];
			const wrapped = help.flatMap((line) => wrapTextWithAnsi(line, inner));
			this.helpScroll = Math.min(this.helpScroll, Math.max(0, wrapped.length - Math.max(1, body)));
			for (const line of wrapped.slice(this.helpScroll, this.helpScroll + body)) add(line);
		} else if (this.search) {
			exit = "cancel";
			controls = [{ key: "enter", label: "apply" }];
			if (body > 1) add("Filter profiles by name");
			add(this.search.render(inner)[0]);
		} else if (this.removal) {
			exit = "cancel";
			controls = [
				{ key: "tab", label: "select" },
				{ key: "enter", label: "confirm" },
			];
			if (body > 1) add(`Remove ${clean(this.removal.name)}?`);
			add(this.selectedLine(this.confirmRemove ? "> Remove permanently" : "> Cancel", inner));
			if (this.notice) add(this.theme.fg("error", this.notice));
		} else if (this.draft) {
			exit = "cancel";
			controls = [
				{ key: "tab", label: "next" },
				{ key: this.field === 6 ? "shift-tab" : "↑", label: "previous" },
				{ key: "^S", label: "save" },
			];
			const title = `${this.draft.name === null ? "New" : "Edit"} · ${fields[this.field]} ${this.field + 1}/${fields.length}`;
			if (body > 1) add(this.theme.fg("accent", title));
			const input = this.activeInput();
			if (this.field === 6) {
				const rendered = this.draft.instructions.render(inner).slice(1, -1);
				const room = Math.max(1, body - lines.length - (body > 4 ? 2 : 0));
				const cursor = Math.max(
					0,
					rendered.findIndex((line) => line.includes(CURSOR_MARKER)),
				);
				const start = Math.max(0, Math.min(cursor - Math.floor(room / 2), rendered.length - room));
				for (const line of rendered.slice(start, start + room)) add(line);
			} else
				add(
					input
						? input.render(inner)[0]
						: this.selectedLine(`${fields[this.field]}: ${this.fieldValue(this.field)}`, inner),
				);
			if (this.notice) add(this.theme.fg("error", this.notice));
			add(
				this.field === 4
					? 'JSON array: [{"name":"guide","path":"/docs/guide.md"}]'
					: this.field === 2 || this.field === 5
						? "Left/Right or Space changes the value."
						: this.field === 6
							? "Enter adds a line. Tab changes the field. Ctrl+S saves."
							: this.field > 6
								? "Enter activates this action."
								: this.field === 0 && this.draft.name
									? "The stored name is immutable."
									: "Type a value. Blank optional fields inherit defaults.",
			);
			add(
				this.field === 6
					? "Tab next · Shift+Tab previous · Ctrl+S save · Esc cancel"
					: "Tab/Down next · Shift+Tab/Up previous · Ctrl+S save · Esc cancel",
			);
			if (body >= 8) {
				add("");
				for (let index = 0; index < fields.length; index++)
					add(`${index === this.field ? ">" : " "} ${fields[index]}: ${clean(this.fieldValue(index))}`);
			}
		} else {
			const visible = this.visible();
			if (body > 1)
				add(
					headerPair(
						inner,
						`Profiles${this.filter ? ` / ${clean(this.filter)}` : ""}`,
						this.truncated ? `${visible.length} shown (partial)` : `${visible.length}/${this.entries.length}`,
					),
				);
			if (this.notice && body > 2) add(this.theme.fg("error", this.notice));
			if (!visible.length)
				add(
					this.filter
						? "No matches. / changes the filter; n creates a profile."
						: "No profiles. Press n to create one.",
				);
			const room = Math.max(1, body - lines.length);
			const index = Math.max(
				0,
				visible.findIndex((entry) => entry.name === this.selected),
			);
			const start = Math.max(0, Math.min(index - Math.floor(room / 2), visible.length - room));
			for (const entry of visible.slice(start, start + room)) {
				const label = `${entry.name === this.selected ? ">" : " "} ${clean(entry.name)} · ${entry.ok ? (entry.enabled ? "enabled" : "disabled") : "broken"}`;
				add(entry.name === this.selected ? this.selectedLine(clipText(label, inner), inner) : label);
			}
			if (this.truncated) add("Partial list. Read an unlisted profile by exact name.");
			const selected = visible.find((entry) => entry.name === this.selected);
			if (selected && !selected.ok) add(this.theme.fg("error", clean(selected.error)));
		}
		const footer = footerLine(
			inner,
			[controls],
			{ key: "esc", label: exit },
			{
				key: (text) => this.theme.fg("accent", text),
				label: (text) => this.theme.fg("muted", text),
				rule: (text) => this.theme.fg("borderMuted", text),
			},
			this.notice && body < 3 ? this.notice : undefined,
		);
		lines.push(footer);
		const paint = (line: string) => this.background("customMessageBg", this.theme.fg("text", padded(line, width)));
		if (!framed) return lines.map(paint);
		const border = (text: string) => this.theme.fg("borderMuted", text);
		const row = (line: string) => paint(`${border("│ ")}${padded(line, inner)}${border(" │")}`);
		const title = " Profiles ";
		return [
			paint(
				`${border("┌─")}${this.theme.fg("accent", this.theme.bold(title))}${border(`${"─".repeat(width - title.length - 3)}┐`)}`,
			),
			...lines.slice(0, -1).map(row),
			paint(border(`├${"─".repeat(width - 2)}┤`)),
			row(footer),
			paint(border(`└${"─".repeat(width - 2)}┘`)),
		];
	}
	invalidate(): void {
		for (const input of this.draft?.inputs ?? []) input.invalidate();
		this.search?.invalidate();
		this.draft?.instructions.invalidate();
	}
	dispose(): void {
		if (this.closed) return;
		this.closed = true;
		this.focused = false;
	}
}

export function openProfilePanel(
	ctx: ExtensionCommandContext,
	deps: ProfilePanelDeps,
	initialFilter?: string,
): Promise<void> {
	return ctx.ui
		.custom<void>(
			(tui, theme, keys, done) => new ProfilePanel(deps, tui, theme, keys, () => done(undefined), initialFilter),
			{ overlay: true, overlayOptions: { width: "90%", minWidth: 100, maxHeight: "100%", margin: 1 } },
		)
		.then(() => undefined);
}
