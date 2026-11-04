/**
 * The footer menu and command discovery for the ordinary Pi footer.
 *
 * The first screen is the menu: announced browser destinations, the session
 * controls, then command search. Search lists `pi.getCommands()` (extension
 * commands, prompt templates, and skills) under their exact invocation names
 * with Pi's `sourceInfo` provenance. Choosing an entry opens its detail. Only
 * the labelled primary action acts: an extension command is dispatched through
 * `pi.sendUserMessage` with command expansion, after the panel has closed and
 * the exact registration has been re-read; a prompt template or skill is
 * prepared into the editor draft and never sent. A disappeared or changed
 * registration is refused rather than sent, so a stale selection cannot reach
 * model input. Every screen sizes itself from the live row budget on each
 * render, so a resize never leaves a control outside the overlay.
 */

import type { SlashCommandInfo } from "@earendil-works/pi-coding-agent";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { ResolvedDestination } from "./destinations.ts";
import {
	Input,
	SelectList,
	matchesKey,
	replaceControlCharacters,
	stripTerminalSequences,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
	type Component,
	type SelectListTheme,
	type TuiMouseEvent,
	type TuiMouseEventResult,
} from "@earendil-works/pi-tui";

/** Exact registration identity: invocation name, kind, and every provenance field. */
export function commandIdentity(command: SlashCommandInfo): string {
	const info = command.sourceInfo;
	return JSON.stringify([
		command.name,
		command.source,
		info.path,
		info.source,
		info.scope,
		info.origin,
		info.baseDir ?? null,
		info.changelogPath ?? null,
	]);
}

/** Single-line reader text: terminal sequences removed, control characters spaced. */
export function readerText(text: string): string {
	return replaceControlCharacters(stripTerminalSequences(text)).replace(/ +/g, " ").trim();
}

/** Match every whitespace-separated query word against the name or description. */
export function filterCommands(commands: readonly SlashCommandInfo[], query: string): SlashCommandInfo[] {
	const words = query.toLowerCase().split(/\s+/).filter((word) => word.length > 0);
	if (words.length === 0) return [...commands];
	return commands.filter((command) => {
		const haystack = `${command.name}\n${command.description ?? ""}`.toLowerCase();
		return words.every((word) => haystack.includes(word));
	});
}

/** The exact text that Pi receives for one invocation. */
export function commandLine(name: string, args: string): string {
	const trimmed = args.trim();
	return trimmed ? `/${name} ${trimmed}` : `/${name}`;
}

export interface CommandDispatchHost {
	getCommands(): SlashCommandInfo[];
	sendUserMessage(content: string, options?: { expandPromptTemplates?: boolean }): unknown;
}

export type DispatchOutcome = { kind: "sent"; line: string } | { kind: "changed" } | { kind: "not-extension" };

/**
 * Dispatch one extension command. The inventory is re-read synchronously and
 * the send follows immediately, so nothing can change in between. A
 * registration that disappeared or changed provenance is refused.
 */
export function dispatchExtensionCommand(
	host: CommandDispatchHost,
	command: SlashCommandInfo,
	args: string,
): DispatchOutcome {
	if (command.source !== "extension") return { kind: "not-extension" };
	const identity = commandIdentity(command);
	const current = host.getCommands().find((candidate) => commandIdentity(candidate) === identity);
	if (!current) return { kind: "changed" };
	const line = commandLine(current.name, args);
	host.sendUserMessage(line, { expandPromptTemplates: true });
	return { kind: "sent", line };
}

export interface DraftEditor {
	getEditorText(): string;
	setEditorText(text: string): void;
	pasteToEditor(text: string): void;
}

export type DraftPlacement = "insert" | "replace";

/**
 * Prepare a prompt template or skill invocation as editor text. An empty
 * editor simply receives the line. Otherwise `insert` pastes at the cursor
 * through Pi's paste handling, and `replace` returns the replaced draft so the
 * caller can offer recovery.
 */
export function prepareDraft(editor: DraftEditor, line: string, placement: DraftPlacement): { replaced?: string } {
	const existing = editor.getEditorText();
	if (existing.length === 0) {
		editor.setEditorText(line);
		return {};
	}
	if (placement === "insert") {
		editor.pasteToEditor(line);
		return {};
	}
	editor.setEditorText(line);
	return { replaced: existing };
}

/** Put a replaced draft back: whole when the editor is empty, else at the cursor. */
export function restoreDraft(editor: DraftEditor, text: string): void {
	if (editor.getEditorText().length === 0) editor.setEditorText(text);
	else editor.pasteToEditor(text);
}

/** Selector state that survives Back, Close, and reopening within one session. */
export interface SelectorState {
	query: string;
	/** Unsent argument or direction text per registration identity. */
	args: Map<string, string>;
	/** Identity of the last opened detail, reselected on reopen when it still exists. */
	selected?: string;
}

export function createSelectorState(): SelectorState {
	return { query: "", args: new Map() };
}

export type MenuControlId = "model" | "reasoning" | "statuses";

export interface MenuControl {
	id: MenuControlId;
	label: string;
	/** Current value or availability, shown beside the label. */
	description: string;
}

export type CommandsPanelResult =
	| { kind: "run"; command: SlashCommandInfo; args: string }
	| { kind: "prepare"; command: SlashCommandInfo; args: string; placement: DraftPlacement }
	| { kind: "control"; id: MenuControlId }
	| { kind: "restore-draft" }
	| undefined;

export interface CommandsPanelOptions {
	commands: readonly SlashCommandInfo[];
	/** Browser destinations resolved against the current inventory, in announcement order. */
	destinations: readonly ResolvedDestination[];
	controls: readonly MenuControl[];
	theme: Theme;
	/** Rows the overlay can show right now; read on every render. */
	rows: () => number;
	state: SelectorState;
	/** Whether the editor currently holds a draft; decides whether placement is asked. */
	draftPresent: () => boolean;
	/** Whether a replaced draft waits for recovery. */
	replacedDraftPresent: () => boolean;
	done: (result: CommandsPanelResult) => void;
}

type Screen = "menu" | "list" | "detail" | "placement";

interface Region {
	y: number;
	height: number;
	component?: Component;
	buttons?: Array<{ x: number; width: number; action: () => void }>;
}

const RESTORE_VALUE = "\u0000restore-draft";
const SEARCH_VALUE = "\u0000search";

/** Lines to scroll for a navigation key, or undefined for any other input. */
function detailScrollDelta(data: string, page: number): number | undefined {
	if (matchesKey(data, "up")) return -1;
	if (matchesKey(data, "down")) return 1;
	if (matchesKey(data, "pageUp")) return -page;
	if (matchesKey(data, "pageDown")) return page;
	return undefined;
}

/** Seed an input through bracketed paste so the cursor lands after the text. */
function seedInput(input: Input, value: string): void {
	if (value.length > 0) input.handleInput(`\x1b[200~${value}\x1b[201~`);
}
const MIN_WIDTH = 24;
const MIN_ROWS = 8;

function selectTheme(theme: Theme): SelectListTheme {
	return {
		selectedPrefix: (text) => theme.fg("accent", text),
		selectedText: (text) => theme.fg("accent", text),
		description: (text) => theme.fg("dim", text),
		scrollInfo: (text) => theme.fg("dim", text),
		noMatch: (text) => theme.fg("dim", text),
	};
}

function kindLabel(command: SlashCommandInfo): string {
	if (command.source === "extension") return "extension command";
	if (command.source === "prompt") return "prompt template";
	return "skill";
}

/**
 * Two-screen selector: a filtered list, then a detail view with an argument
 * editor and labelled actions. Hit regions are rebuilt on every render and
 * ignored when the event width differs from the rendered width, so a click
 * after a resize cannot act on a stale row.
 */
export class CommandsPanel implements Component {
	readonly capturesViewportInput = true;
	private screen: Screen = "menu";
	private readonly commands: SlashCommandInfo[];
	private readonly theme: Theme;
	private readonly listTheme: SelectListTheme;
	private readonly state: SelectorState;
	private readonly options: CommandsPanelOptions;
	private readonly find: Input;
	private args: Input;
	private list!: SelectList;
	private menu!: SelectList;
	private menuHeight = 0;
	private menuItemCount = 0;
	private listHeightUsed = 0;
	private placement: SelectList | undefined;
	private selected: SlashCommandInfo | undefined;
	private detailLines: string[] = [];
	private detailWidth = -1;
	private detailOffset = 0;
	private regions: Region[] = [];
	private renderedWidth = -1;
	private closed = false;

	constructor(options: CommandsPanelOptions) {
		this.options = options;
		this.commands = [...options.commands];
		this.theme = options.theme;
		this.listTheme = selectTheme(options.theme);
		this.state = options.state;
		this.find = new Input({ prompt: "Find: ", placeholder: "name or description" });
		seedInput(this.find, this.state.query);
		this.args = new Input({ prompt: "Arguments: " });
		this.rebuildMenu();
		this.rebuildList();
		const remembered = this.state.selected ? this.commands.find((c) => commandIdentity(c) === this.state.selected) : undefined;
		if (remembered) {
			const index = this.visibleCommands().findIndex((c) => commandIdentity(c) === this.state.selected);
			if (index >= 0) this.list.setSelectedIndex(index + this.restoreOffset());
		}
	}

	private restoreOffset(): number {
		return this.options.replacedDraftPresent() ? 1 : 0;
	}

	private visibleCommands(): SlashCommandInfo[] {
		return filterCommands(this.commands, this.state.query);
	}

	/**
	 * Rows for the menu list after its heading, hint and Close row. An overflowing Pi list emits one
	 * more row for its position, so that row is reserved whenever the items exceed the space.
	 */
	private menuRows(): number {
		const available = Math.max(2, this.options.rows() - 3);
		return this.menuItemCount > available ? Math.max(2, available - 1) : available;
	}

	private listHeight(): number {
		return Math.max(3, Math.min(14, this.options.rows() - 7));
	}

	private detailHeight(): number {
		return Math.max(2, Math.min(10, this.options.rows() - 9));
	}

	/** Destinations first, then session controls, then the full inventory behind search. */
	private rebuildMenu(): void {
		const items: Array<{ value: string; label: string; description: string }> = [];
		if (this.options.replacedDraftPresent()) items.push({ value: RESTORE_VALUE, label: "Restore replaced draft", description: "puts the draft that Replace removed back into the editor" });
		for (const destination of this.options.destinations) {
			const command = `/${destination.registration?.name ?? destination.command.name}${destination.command.args ? ` ${destination.command.args}` : ""}`;
			items.push({ value: `destination:${destination.id}`, label: readerText(destination.label), description: destination.unavailable ? readerText(`unavailable: ${destination.unavailable}`) : readerText(`opens ${command}`) });
		}
		for (const control of this.options.controls) items.push({ value: `control:${control.id}`, label: readerText(control.label), description: readerText(control.description) });
		items.push({ value: SEARCH_VALUE, label: "Search commands…", description: `find any of ${this.commands.length} commands, prompt templates and skills` });
		const selected = this.menu?.getSelectedItem()?.value;
		this.menuItemCount = items.length;
		this.menuHeight = this.menuRows();
		this.menu = new SelectList(items, this.menuHeight, this.listTheme);
		const index = selected === undefined ? -1 : items.findIndex((item) => item.value === selected);
		if (index >= 0) this.menu.setSelectedIndex(index);
		this.menu.onSelect = (item) => this.chooseMenu(item.value);
		this.menu.onCancel = () => this.close();
		this.regions = [];
	}

	/** Open command search over the full inventory, as choosing the menu's search item does. */
	search(): void {
		if (this.closed) return;
		this.screen = "list";
		this.regions = [];
	}

	private chooseMenu(value: string): void {
		if (value === SEARCH_VALUE) { this.search(); return; }
		if (value === RESTORE_VALUE) { this.finish({ kind: "restore-draft" }); return; }
		if (value.startsWith("control:")) { this.finish({ kind: "control", id: value.slice("control:".length) as MenuControlId }); return; }
		const destination = this.options.destinations.find((candidate) => `destination:${candidate.id}` === value);
		if (!destination?.registration) return;
		this.finish({ kind: "run", command: destination.registration, args: destination.command.args ?? "" });
	}

	private rebuildList(): void {
		const items = this.visibleCommands().map((command) => ({
			value: commandIdentity(command),
			label: `/${readerText(command.name)}`,
			description: readerText(command.description ?? `${kindLabel(command)} · ${command.sourceInfo.source}`),
		}));
		if (this.options.replacedDraftPresent()) {
			items.unshift({ value: RESTORE_VALUE, label: "Restore replaced draft", description: "puts the draft that Replace removed back into the editor" });
		}
		this.listHeightUsed = this.listHeight();
		this.list = new SelectList(items, this.listHeightUsed, this.listTheme);
		this.list.onSelect = (item) => {
			if (item.value === RESTORE_VALUE) {
				this.finish({ kind: "restore-draft" });
				return;
			}
			const command = this.commands.find((c) => commandIdentity(c) === item.value);
			if (command) this.openDetail(command);
		};
		this.list.onCancel = () => this.close();
		this.regions = [];
	}

	private openDetail(command: SlashCommandInfo): void {
		this.selected = command;
		this.state.selected = commandIdentity(command);
		this.screen = "detail";
		this.detailOffset = 0;
		this.detailWidth = -1;
		this.args = new Input({
			prompt: command.name === "evo" ? "Direction: " : "Arguments: ",
			placeholder: command.name === "evo" ? "optional; empty starts autonomous work" : "optional",
		});
		seedInput(this.args, this.state.args.get(this.state.selected) ?? "");
		this.regions = [];
	}

	private rememberArgs(): void {
		if (this.selected) this.state.args.set(commandIdentity(this.selected), this.args.getValue());
	}

	private back(): void {
		if (this.screen === "placement") {
			this.placement = undefined;
			this.screen = "detail";
			this.regions = [];
			return;
		}
		if (this.screen === "list") {
			this.screen = "menu";
			this.rebuildMenu();
			return;
		}
		this.rememberArgs();
		this.selected = undefined;
		this.screen = "list";
		this.rebuildList();
		const index = this.visibleCommands().findIndex((c) => commandIdentity(c) === this.state.selected);
		if (index >= 0) this.list.setSelectedIndex(index + this.restoreOffset());
	}

	private primary(): void {
		if (!this.selected) return;
		this.rememberArgs();
		const args = this.args.getValue();
		if (this.selected.source === "extension") {
			this.finish({ kind: "run", command: this.selected, args });
			return;
		}
		if (!this.options.draftPresent()) {
			this.finish({ kind: "prepare", command: this.selected, args, placement: "insert" });
			return;
		}
		this.placement = new SelectList(
			[
				{ value: "insert", label: "Insert at cursor", description: "keeps the draft; pastes the command where the cursor is" },
				{ value: "replace", label: "Replace draft", description: "the removed draft stays recoverable from Commands" },
				{ value: "back", label: "Keep draft", description: "returns to the command" },
			],
			3,
			this.listTheme,
		);
		this.placement.onSelect = (item) => {
			if (!this.selected) return;
			if (item.value === "back") this.back();
			else this.finish({ kind: "prepare", command: this.selected, args, placement: item.value as DraftPlacement });
		};
		this.placement.onCancel = () => this.back();
		this.screen = "placement";
		this.regions = [];
	}

	private finish(result: CommandsPanelResult): void {
		if (this.closed) return;
		this.rememberArgs();
		this.closed = true;
		this.regions = [];
		this.options.done(result);
	}

	close(): void {
		this.finish(undefined);
	}

	dispose(): void {
		this.closed = true;
		this.regions = [];
	}

	invalidate(): void {
		this.regions = [];
		this.renderedWidth = -1;
		this.detailWidth = -1;
		this.find.invalidate();
		this.args.invalidate();
		this.menu.invalidate();
		this.list.invalidate();
		this.placement?.invalidate();
	}

	handleInput(data: string): void {
		if (this.closed) return;
		if (matchesKey(data, "ctrl+c")) {
			this.close();
			return;
		}
		if (matchesKey(data, "escape")) {
			if (this.screen === "menu") this.close();
			else this.back();
			return;
		}
		if (this.screen === "menu") this.menu.handleInput(data);
		else if (this.screen === "placement") this.placement?.handleInput(data);
		else if (this.screen === "detail") this.handleDetailInput(data);
		else this.handleListInput(data);
	}

	private handleDetailInput(data: string): void {
		if (matchesKey(data, "enter")) {
			this.primary();
			return;
		}
		const scroll = detailScrollDelta(data, this.detailHeight());
		if (scroll !== undefined) {
			this.scrollDetail(scroll);
			return;
		}
		this.args.handleInput(data);
	}

	private handleListInput(data: string): void {
		if (matchesKey(data, "enter") || detailScrollDelta(data, 1) !== undefined) {
			this.list.handleInput(data);
			return;
		}
		this.find.handleInput(data);
		const query = this.find.getValue();
		if (query !== this.state.query) {
			this.state.query = query;
			this.rebuildList();
		}
	}

	private scrollDetail(delta: number): void {
		const max = Math.max(0, this.detailLines.length - this.detailHeight());
		this.detailOffset = Math.max(0, Math.min(max, this.detailOffset + delta));
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (this.closed || event.width !== this.renderedWidth) return undefined;
		const region = this.regions.find((candidate) => event.y >= candidate.y && event.y < candidate.y + candidate.height);
		if (event.type === "wheel" && this.screen === "detail" && !region?.component) {
			this.scrollDetail(event.wheelDelta ?? 0);
			return { handled: true };
		}
		if (!region) return undefined;
		if (region.buttons) {
			if (event.type !== "click" || event.button !== "left") return undefined;
			const button = region.buttons.find((candidate) => event.x >= candidate.x && event.x < candidate.x + candidate.width);
			if (!button) return undefined;
			button.action();
			return { handled: true };
		}
		if (!region.component?.handleMouse) return undefined;
		const result = region.component.handleMouse({ ...event, y: event.y - region.y, height: region.height });
		return result ? { handled: true, render: result.render } : undefined;
	}

	/** A changed row budget resizes the lists before they draw, so Close stays inside the overlay. */
	private fitLists(): void {
		if (this.menuHeight !== this.menuRows()) this.rebuildMenu();
		if (this.listHeightUsed === this.listHeight()) return;
		const selected = this.list.getSelectedItem()?.value;
		this.rebuildList();
		const index = selected === undefined ? -1 : this.visibleCommands().findIndex((c) => commandIdentity(c) === selected);
		if (index >= 0) this.list.setSelectedIndex(index + this.restoreOffset());
	}

	private renderMenu(width: number, lines: string[], push: (line: string) => void): string[] {
		push(this.theme.bold("Menu"));
		push(this.theme.fg("dim", "Enter or click opens · Escape closes"));
		const menuLines = this.menu.render(width);
		this.regions.push({ y: lines.length, height: menuLines.length, component: this.menu });
		lines.push(...menuLines);
		const closeRow = this.buttonRow(width, [{ label: "Close", action: () => this.close() }]);
		this.regions.push({ y: lines.length, height: 1, buttons: closeRow.hits });
		lines.push(closeRow.line);
		return lines;
	}

	private renderList(width: number, lines: string[], push: (line: string) => void): string[] {
		push(this.theme.bold("Commands"));
		push(this.theme.fg("dim", "Type to find · Enter or click opens · Escape returns to the menu"));
		this.find.focused = true;
		const findLines = this.find.render(width);
		this.regions.push({ y: lines.length, height: findLines.length, component: this.find });
		lines.push(...findLines);
		const listLines = this.list.render(width);
		this.regions.push({ y: lines.length, height: listLines.length, component: this.list });
		lines.push(...listLines);
		const closeRow = this.buttonRow(width, [{ label: "Menu", action: () => this.back() }, { label: "Close", action: () => this.close() }]);
		this.regions.push({ y: lines.length, height: 1, buttons: closeRow.hits });
		lines.push(closeRow.line);
		return lines;
	}

	private buildDetail(width: number): void {
		if (!this.selected || this.detailWidth === width) return;
		const command = this.selected;
		const info = command.sourceInfo;
		const text = [
			readerText(command.description ?? "No description."),
			"",
			`${kindLabel(command)} · ${readerText(info.source)} · ${info.scope} · ${info.origin}`,
			readerText(info.path),
		].join("\n");
		this.detailLines = wrapTextWithAnsi(text, Math.max(1, width));
		this.detailWidth = width;
		this.scrollDetail(0);
	}

	private buttonRow(width: number, buttons: Array<{ label: string; action: () => void }>): { line: string; hits: Region["buttons"] } {
		let line = "";
		let x = 0;
		const hits: NonNullable<Region["buttons"]> = [];
		for (const button of buttons) {
			const cell = `[${button.label}]`;
			const cellWidth = visibleWidth(cell);
			if (x + cellWidth > width) break;
			hits.push({ x, width: cellWidth, action: button.action });
			line += `${this.theme.fg("accent", cell)}  `;
			x += cellWidth + 2;
		}
		return { line: truncateToWidth(line, width), hits };
	}

	render(width: number): string[] {
		this.regions = [];
		this.renderedWidth = width;
		if (this.closed) return [];
		const rows = this.options.rows();
		if (width < MIN_WIDTH || rows < MIN_ROWS) {
			return [truncateToWidth("Terminal too small for the menu. Escape closes.", width)];
		}
		this.fitLists();
		const lines: string[] = [];
		const push = (line: string) => lines.push(truncateToWidth(line, width));
		if (this.screen === "menu") return this.renderMenu(width, lines, push).slice(0, rows);
		if (this.screen === "list") return this.renderList(width, lines, push).slice(0, rows);
		const command = this.selected;
		if (!command) return [];
		push(`${this.theme.bold(`/${readerText(command.name)}`)} ${this.theme.fg("dim", kindLabel(command))}`);
		this.buildDetail(width);
		const detailTop = lines.length;
		for (const line of this.detailLines.slice(this.detailOffset, this.detailOffset + this.detailHeight())) push(line);
		if (this.detailLines.length > this.detailHeight()) {
			push(this.theme.fg("dim", `${this.detailOffset + 1}-${Math.min(this.detailLines.length, this.detailOffset + this.detailHeight())} of ${this.detailLines.length} lines · wheel or arrows scroll`));
		}
		this.regions.push({ y: detailTop, height: lines.length - detailTop });
		if (this.screen === "placement" && this.placement) {
			push(this.theme.fg("warning", "The editor already holds a draft."));
			const placementLines = this.placement.render(width);
			this.regions.push({ y: lines.length, height: placementLines.length, component: this.placement });
			lines.push(...placementLines);
			const row = this.buttonRow(width, [{ label: "Back", action: () => this.back() }, { label: "Close", action: () => this.close() }]);
			this.regions.push({ y: lines.length, height: 1, buttons: row.hits });
			lines.push(row.line);
			return lines;
		}
		this.args.focused = true;
		const argLines = this.args.render(width);
		this.regions.push({ y: lines.length, height: argLines.length, component: this.args });
		lines.push(...argLines);
		const primaryLabel = command.source === "extension" ? "Run" : "Insert into draft";
		const row = this.buttonRow(width, [
			{ label: primaryLabel, action: () => this.primary() },
			{ label: "Back", action: () => this.back() },
			{ label: "Close", action: () => this.close() },
		]);
		this.regions.push({ y: lines.length, height: 1, buttons: row.hits });
		lines.push(row.line);
		push(this.theme.fg("dim", command.source === "extension" ? "Enter runs · Escape goes back" : "Enter prepares the draft · Escape goes back"));
		return lines.slice(0, rows);
	}
}
