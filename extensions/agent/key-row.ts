import type { Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, visibleWidth } from "@earendil-works/pi-tui";
import type { HitMap } from "./view-hits.ts";
import { keysText, keyText, MORE_CHORD, MORE_KEY } from "./view-keys.ts";
import type { Action } from "./view-model.ts";
import { fitCells, plainLine } from "./view-text.ts";

/**
 * One key-row control: its keys, its label, and what each key does. A key press and a click on the
 * control call the same `run`, so the two can never mean different things.
 */
export interface Control {
	readonly id: string;
	/** pi-tui key ids or printable characters. A control with several keys gets one click target per key. */
	readonly keys: readonly string[];
	readonly label: string;
	readonly description?: string;
	/** Why the control cannot run now. It stays listed, dimmed, and explains itself when used. */
	readonly disabled?: string;
	readonly tone?: "accent" | "danger";
	/** Run the control for one of its keys. */
	run(key: string): void;
	/**
	 * Lower numbers stay on the row longer when it is short. Priority 0 never leaves the row: basic
	 * navigation, More and the way out. Default 2.
	 */
	readonly priority?: number;
}

const SEPARATOR = " · ";

/** Key-row wording of an action: its short form, or its label with a lower-case first letter. */
export function actionLabel(action: Pick<Action, "label" | "short">): string {
	const text = plainLine(action.short ?? action.label);
	return /^\p{Lu}\p{Ll}/u.test(text) ? `${text.charAt(0).toLocaleLowerCase()}${text.slice(1)}` : text;
}

/** The key-row control of an action with a key; `invoke` re-reads the action by identity when it runs. */
export function actionControl(action: Action, invoke: (id: string) => void, priority = 1): Control | undefined {
	if (!action.key) return undefined;
	return {
		id: action.id,
		keys: [action.key],
		label: actionLabel(action),
		...(action.description ? { description: action.description } : {}),
		...(action.disabled ? { disabled: action.disabled } : {}),
		...(action.tone ? { tone: action.tone } : {}),
		priority,
		run: () => invoke(action.id),
	};
}

/** The More menu entry of an action without a key. */
export function menuControl(action: Action, invoke: (id: string) => void): Control {
	return {
		id: action.id,
		keys: action.key ? [action.key] : [],
		label: plainLine(action.label),
		...(action.description ? { description: action.description } : {}),
		...(action.disabled ? { disabled: action.disabled } : {}),
		...(action.tone ? { tone: action.tone } : {}),
		run: () => invoke(action.id),
	};
}

function controlWidth(control: Control): number {
	return visibleWidth(`${keysText(control.keys)} ${plainLine(control.label)}`);
}

function paintControl(control: Control, theme: Theme): string {
	const keys = keysText(control.keys);
	const label = plainLine(control.label);
	if (control.disabled) return theme.fg("dim", `${keys} ${label}`);
	return `${theme.fg("accent", keys)} ${theme.fg(control.tone === "danger" ? "error" : "muted", label)}`;
}

/** The index of the control that leaves a short row next: the highest priority number, the last of equals. Priority 0 stays. */
function nextToDrop(shown: readonly Control[]): number {
	let drop = -1;
	let worst = 0;
	shown.forEach((control, index) => {
		const priority = control.priority ?? 2;
		if (priority > 0 && priority >= worst) {
			drop = index;
			worst = priority;
		}
	});
	return drop;
}

/** One More menu row: marker, key column, label and the reason or description. */
function menuRow(item: Control, chosen: boolean, keyColumn: number, width: number, theme: Theme): string {
	const marker = chosen ? theme.fg("accent", "›") : " ";
	const keys = fitCells(
		item.keys.length ? theme.fg(item.disabled ? "dim" : "accent", keysText(item.keys)) : "",
		keyColumn,
	);
	const label = theme.fg(item.disabled ? "dim" : item.tone === "danger" ? "error" : "text", plainLine(item.label));
	const note = item.disabled ? `unavailable: ${item.disabled}` : (item.description ?? "");
	const text = `${marker} ${keys}  ${label}${note ? theme.fg("muted", `  ${plainLine(note)}`) : ""}`;
	return chosen ? theme.bg("selectedBg", fitCells(text, width)) : fitCells(text, width);
}

/** Menu moves by key: Up and Down one entry, PageUp and PageDown five, Home and End to either end. */
const MENU_MOVES: ReadonlyArray<readonly [string, (index: number, count: number) => number]> = [
	["up", (index) => index - 1],
	["down", (index) => index + 1],
	["pageUp", (index) => index - 5],
	["pageDown", (index) => index + 5],
	["home", () => 0],
	["end", (_index, count) => count - 1],
];

/** Column spans of each key token inside a control's key text, for one click target per key. */
function keySpans(keys: readonly string[]): Array<{ key: string; x: number; width: number }> {
	const arrows = keys.every((key) => /^[↑↓←→]$/u.test(keyText(key)));
	const spans: Array<{ key: string; x: number; width: number }> = [];
	let x = 0;
	for (const key of keys) {
		const width = visibleWidth(keyText(key));
		spans.push({ key, x, width });
		x += width + (arrows ? 0 : 1);
	}
	return spans;
}

/**
 * The key row of one view: controls as `key label` pairs on one row, the way out last. When the
 * row is short, the highest-numbered priority leaves first, into the More menu, which lists every
 * control the row does not show, one entry per key of a multi-key control, together with its key.
 * Click targets come from the row as drawn.
 */
export class KeyRow {
	private open = false;
	private index = 0;
	/** Controls of the last render that the More menu lists. */
	private listed: Control[] = [];

	get menuShown(): boolean {
		return this.open;
	}

	/** Whether the last render had anything for the More menu to list. */
	get hasMore(): boolean {
		return this.listed.length > 0;
	}

	/** Rows the open menu needs: a heading and one row per entry. */
	get menuRows(): number {
		return this.listed.length + 1;
	}

	closeMenu(): void {
		this.open = false;
	}

	toggleMenu(): void {
		this.open = !this.open;
		this.index = 0;
	}

	/**
	 * Draw the row and register its targets. The last control is the way out; More goes before it
	 * when the menu has entries. `menu` lists entries that never take a place on the row. While a
	 * text field has focus, More shows `MORE_CHORD`, because the plain More key would be text.
	 */
	render(
		controls: readonly Control[],
		width: number,
		theme: Theme,
		hits: HitMap,
		y: number,
		x0 = 0,
		menu: readonly Control[] = [],
		editing = false,
	): string {
		const exit = controls.at(-1);
		const shown = controls.slice(0, -1);
		const hidden: Control[] = [];
		const more: Control = {
			id: "\u0000more",
			keys: [editing ? MORE_CHORD : MORE_KEY],
			label: "more",
			priority: 0,
			description: "Every action and key this row does not show",
			run: () => this.toggleMenu(),
		};
		const row = () => [...shown, ...(hidden.length || menu.length ? [more] : []), ...(exit ? [exit] : [])];
		const measure = () =>
			row().reduce((total, control, index) => total + controlWidth(control) + (index ? SEPARATOR.length : 0), 0);
		for (let drop = nextToDrop(shown); measure() > width && drop >= 0; drop = nextToDrop(shown))
			hidden.unshift(...shown.splice(drop, 1));
		// While the menu shows, the row lists the menu's own keys and the menu keeps its entries.
		// A control with several keys lists one entry per key, so a choice runs exactly that key.
		if (!this.open)
			this.listed = [...hidden, ...menu].flatMap((control) =>
				control.keys.length > 1
					? control.keys.map((key) => ({ ...control, id: `${control.id}:${key}`, keys: [key] }))
					: [control],
			);
		let x = 0;
		const parts: string[] = [];
		for (const control of row()) {
			const w = controlWidth(control);
			if (x + w <= width) this.target(control, hits, x0 + x, y, w);
			parts.push(paintControl(control, theme));
			x += w + SEPARATOR.length;
		}
		return fitCells(parts.join(theme.fg("dim", SEPARATOR)), width);
	}

	private target(control: Control, hits: HitMap, x: number, y: number, width: number): void {
		if (control.keys.length <= 1) {
			hits.add({ x, y, width, height: 1, click: () => control.run(control.keys[0] ?? "") });
			return;
		}
		for (const span of keySpans(control.keys))
			hits.add({ x: x + span.x, y, width: span.width, height: 1, click: () => control.run(span.key) });
	}

	/** The open More menu over the lower body rows: every control the row does not show, with its key. */
	renderMenu(width: number, height: number, theme: Theme, hits: HitMap, y0: number, x0 = 0): string[] {
		const items = this.listed;
		this.index = Math.max(0, Math.min(items.length - 1, this.index));
		const room = Math.max(1, height - 1);
		const overflow = items.length > room;
		const rows = overflow ? Math.max(1, room - 1) : items.length;
		const start = Math.max(0, Math.min(items.length - rows, this.index - Math.floor(rows / 2)));
		const keyColumn = Math.min(14, Math.max(0, ...items.map((item) => visibleWidth(keysText(item.keys)))));
		const lines = [fitCells(theme.fg("muted", `More${start > 0 ? ` · ↑ ${start} more` : ""}`), width)];
		items.slice(start, start + rows).forEach((item, offset) => {
			const index = start + offset;
			lines.push(menuRow(item, index === this.index, keyColumn, width, theme));
			hits.add({ x: x0, y: y0 + 1 + offset, width, height: 1, click: () => this.choose(index) });
		});
		const below = items.length - start - rows;
		if (overflow)
			lines.push(fitCells(theme.fg("muted", below > 0 ? `↓ ${below} more` : `${items.length} entries`), width));
		hits.add({ x: x0, y: y0, width, height: lines.length, wheel: (delta) => this.move(delta, items.length) });
		return lines;
	}

	/** The keys of the open menu, for the key row while it shows. */
	static menuControls(footer: KeyRow, run: (key: string) => void): Control[] {
		return [
			{ id: "menu-move", keys: ["up", "down"], label: "choose", priority: 0, run },
			{ id: "menu-run", keys: ["enter"], label: "run", priority: 0, run },
			{ id: "menu-close", keys: ["escape"], label: "close menu", priority: 0, run: () => footer.closeMenu() },
		];
	}

	private move(delta: number, count: number): void {
		this.index = Math.max(0, Math.min(count - 1, this.index + delta));
	}

	private choose(index: number): void {
		const item = this.listed[index];
		this.index = index;
		if (!item) return;
		this.open = false;
		item.run(item.keys[0] ?? "");
	}

	/** Keys while the menu shows. Returns true when consumed; every key is consumed while it shows. */
	menuInput(data: string): boolean {
		if (!this.open) return false;
		const count = this.listed.length;
		const move = MENU_MOVES.find(([key]) => matchesKey(data, key as "up"));
		if (matchesKey(data, "escape") || data === MORE_KEY || matchesKey(data, MORE_CHORD)) this.open = false;
		else if (move) this.index = Math.max(0, Math.min(count - 1, move[1](this.index, count)));
		else if (matchesKey(data, "enter")) this.choose(this.index);
		return true;
	}
}
