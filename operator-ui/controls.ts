import type { Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import type { HitMap } from "./hits.ts";
import { clip, fitLine, plainLine, visibleWidth } from "./text.ts";
import type { Action } from "./view.ts";

const GAP = "   ";
const MORE_ID = "\u0000more";

interface Placed {
	readonly id: string;
	readonly label: string;
	readonly x: number;
	readonly width: number;
}

function controlText(action: Pick<Action, "label" | "disabled" | "tone">, focused: boolean, theme: Theme): string {
	const label = plainLine(action.label);
	if (focused) return theme.bg("selectedBg", theme.bold(theme.fg(action.disabled ? "dim" : "text", ` ${label} `)));
	if (action.disabled) return theme.fg("dim", ` ${label} `);
	return theme.fg(action.tone === "danger" ? "error" : "accent", ` ${label} `);
}

/**
 * The labelled controls for one view: primary actions in order, then More for the rest. Controls
 * that do not fit move into More, never out of reach. Actions are re-read on every render and
 * every invocation, so a stale render cannot run a replaced action.
 */
export class ActionBar {
	focused = false;
	private focusId?: string;
	private menuOpen = false;
	private menuIndex = 0;
	private placed: Placed[] = [];
	private readonly refused: (reason: string) => void;

	constructor(refused: (reason: string) => void) {
		this.refused = refused;
	}

	get menuShown(): boolean {
		return this.menuOpen;
	}

	closeMenu(): void {
		this.menuOpen = false;
	}

	/** Every primary control when all of them fit; otherwise the ones that fit before More. */
	private layout(actions: readonly Action[], room: number): Placed[] {
		const primary = actions.filter((action) => action.primary);
		const more = primary.length < actions.length || ActionBar.measure(actions) > room;
		const moreWidth = visibleWidth(" More… ");
		const placed: Placed[] = [];
		let x = 0;
		for (const action of primary) {
			const w = visibleWidth(` ${plainLine(action.label)} `);
			if (more && x + w + GAP.length + moreWidth > room) break;
			placed.push({ id: action.id, label: action.label, x, width: w });
			x += w + GAP.length;
		}
		if (more && x + moreWidth <= room) placed.push({ id: MORE_ID, label: "More…", x, width: moreWidth });
		return placed;
	}

	/** Columns the primary controls and More take when nothing has to overflow. */
	static measure(actions: readonly Action[]): number {
		const primary = actions.filter((action) => action.primary);
		const labels = primary.map((action) => visibleWidth(` ${plainLine(action.label)} `));
		if (primary.length < actions.length) labels.push(visibleWidth(" More… "));
		return labels.reduce((total, width) => total + width, 0) + Math.max(0, labels.length - 1) * GAP.length;
	}

	/** Lay out the bar and register its targets; `right` is a muted trailing segment such as a notice. */
	render(actions: readonly Action[], width: number, theme: Theme, hits: HitMap, y: number, right = ""): string {
		const rightWidth = right ? Math.min(visibleWidth(right), Math.floor(width / 2)) : 0;
		const room = Math.max(0, width - rightWidth - (rightWidth ? 1 : 0));
		const placed = this.layout(actions, room);
		this.placed = placed;
		if (this.focusId && !placed.some((item) => item.id === this.focusId)) this.focusId = placed[0]?.id;
		if (this.focused && !this.focusId) this.focusId = placed[0]?.id;
		let line = "";
		for (const item of placed) {
			const action = item.id === MORE_ID ? { label: "More…" } : actions.find((candidate) => candidate.id === item.id);
			if (!action) continue;
			line += (line ? GAP : "") + controlText(action, this.focused && this.focusId === item.id, theme);
			hits.add({ x: item.x, y, width: item.width, height: 1, click: () => this.invoke(item.id, actions) });
		}
		const left = fitLine(line, room);
		return rightWidth ? `${left} ${clip(right, rightWidth)}` : left;
	}

	/** The open More menu, drawn by the frame over the lower body rows. */
	renderMenu(actions: readonly Action[], width: number, height: number, theme: Theme, hits: HitMap, y0: number): string[] {
		const items = this.menuItems(actions);
		this.menuIndex = Math.max(0, Math.min(items.length - 1, this.menuIndex));
		// A menu taller than its rows keeps one row that says how many actions are below.
		const room = Math.max(1, height - 1);
		const overflow = items.length > room;
		const rows = overflow ? Math.max(1, room - 1) : items.length;
		const start = Math.max(0, Math.min(items.length - rows, this.menuIndex - Math.floor(rows / 2)));
		const above = start > 0 ? ` · ↑ ${start} more` : "";
		const lines = [fitLine(theme.fg("muted", `More actions${above} · Enter runs · Esc closes`), width)];
		if (above) hits.add({ x: 0, y: y0, width, height: 1, click: () => this.moveMenu(-rows, items.length) });
		items.slice(start, start + rows).forEach((action, offset) => {
			const index = start + offset;
			const note = action.disabled ? `unavailable: ${action.disabled}` : (action.description ?? "");
			const marker = index === this.menuIndex ? "›" : " ";
			const label = action.disabled ? theme.fg("dim", plainLine(action.label)) : theme.fg("text", plainLine(action.label));
			const text = `${marker} ${label}${note ? theme.fg("muted", `  ${plainLine(note)}`) : ""}`;
			lines.push(index === this.menuIndex ? theme.bg("selectedBg", fitLine(text, width)) : fitLine(text, width));
			hits.add({
				x: 0,
				y: y0 + 1 + offset,
				width,
				height: 1,
				click: () => {
					this.menuIndex = index;
					this.invoke(action.id, actions);
				},
			});
		});
		const below = items.length - start - rows;
		if (overflow) {
			lines.push(fitLine(theme.fg("muted", below > 0 ? `↓ ${below} more · click, ↓ or wheel` : `${items.length} actions`), width));
			if (below > 0) hits.add({ x: 0, y: y0 + lines.length - 1, width, height: 1, click: () => this.moveMenu(rows, items.length) });
		}
		hits.add({ x: 0, y: y0, width, height: lines.length, wheel: (delta) => this.moveMenu(delta, items.length) });
		return lines;
	}

	private menuItems(actions: readonly Action[]): Action[] {
		const shown = new Set(this.placed.map((item) => item.id));
		return actions.filter((action) => !shown.has(action.id));
	}

	private moveMenu(delta: number, count: number): void {
		this.menuIndex = Math.max(0, Math.min(count - 1, this.menuIndex + delta));
	}

	/** Run an action by identity after re-reading the current list. */
	invoke(id: string, actions: readonly Action[]): void {
		if (id === MORE_ID) {
			this.menuOpen = !this.menuOpen;
			this.menuIndex = 0;
			return;
		}
		const action = actions.find((candidate) => candidate.id === id);
		if (!action) return;
		this.menuOpen = false;
		if (action.disabled) {
			this.refused(action.disabled);
			return;
		}
		action.run();
	}

	/** Keys while the bar or its menu owns focus. Returns true when consumed. */
	handleInput(data: string, actions: readonly Action[]): boolean {
		if (this.menuOpen) return this.menuInput(data, actions);
		if (!this.focused) return false;
		const index = this.placed.findIndex((item) => item.id === this.focusId);
		if (matchesKey(data, "left") || matchesKey(data, "right")) {
			const next = index + (matchesKey(data, "left") ? -1 : 1);
			this.focusId = this.placed[Math.max(0, Math.min(this.placed.length - 1, next))]?.id;
			return true;
		}
		if (matchesKey(data, "home") || matchesKey(data, "end")) {
			this.focusId = (matchesKey(data, "home") ? this.placed[0] : this.placed.at(-1))?.id;
			return true;
		}
		if ((matchesKey(data, "enter") || data === " ") && this.focusId) {
			this.invoke(this.focusId, actions);
			return true;
		}
		return false;
	}

	private menuInput(data: string, actions: readonly Action[]): boolean {
		const items = this.menuItems(actions);
		if (matchesKey(data, "escape")) this.menuOpen = false;
		else if (matchesKey(data, "up") || matchesKey(data, "down")) this.moveMenu(matchesKey(data, "up") ? -1 : 1, items.length);
		else if (matchesKey(data, "enter")) {
			const action = items[this.menuIndex];
			if (action) this.invoke(action.id, actions);
		}
		return true;
	}

	/** Focus the first control (or the last, when entering backward). */
	focusEdge(backward: boolean): void {
		this.focused = true;
		this.focusId = (backward ? this.placed.at(-1) : this.placed[0])?.id;
	}
}

export interface Tab {
	readonly key: string;
	readonly label: string;
	readonly unavailable?: string;
}

/** One tab label: the active tab emphasised, an unavailable one dimmed, the focused one highlighted. */
function tabText(tab: Tab, label: string, active: boolean, focused: boolean, theme: Theme): string {
	const text = active ? theme.bold(theme.fg("accent", label)) : theme.fg(tab.unavailable ? "dim" : "muted", label);
	return focused ? theme.bg("selectedBg", text) : text;
}

/** The widest tab label that lets every tab fit in `room`; the longest labels shorten first. */
function tabCap(labels: readonly string[], room: number): number {
	const widths = labels.map((label) => visibleWidth(label));
	const total = (cap: number) => widths.reduce((sum, width) => sum + Math.min(width, cap) + 1, 1);
	let cap = Math.max(0, ...widths);
	while (cap > 3 && total(cap) > room) cap--;
	return cap;
}

/**
 * The destination row: every tab on the left, a muted segment that gives way first, and the
 * fixed controls at the right. Tabs shorten evenly before any drops out of reach. The active tab
 * is emphasised; a focused tab row highlights the tab that Enter would open.
 */
export function renderTabs(
	tabs: readonly Tab[],
	active: string | undefined,
	focusKey: string | undefined,
	width: number,
	theme: Theme,
	hits: HitMap,
	y: number,
	pick: (key: string) => void,
	right = "",
	fixed = "",
): { line: string; fixedX: number } {
	const space = Math.max(0, width - visibleWidth(fixed));
	const labels = tabs.map((tab) => ` ${plainLine(tab.label)} `);
	const natural = labels.reduce((sum, label) => sum + visibleWidth(label) + 1, 1);
	const rightWidth = right ? Math.max(0, Math.min(visibleWidth(right), Math.floor(space / 2), space - natural - 2)) : 0;
	const room = Math.max(0, space - (rightWidth ? rightWidth + 2 : 0));
	const cell = tabCap(labels, room);
	let x = 1;
	let line = theme.fg("borderMuted", "─");
	for (const [index, tab] of tabs.entries()) {
		const full = labels[index] ?? "";
		const label = visibleWidth(full) > cell ? ` ${truncateToWidth(plainLine(tab.label), Math.max(1, cell - 2), "\u2026")} ` : full;
		const w = visibleWidth(label);
		if (x + w + 1 > room) break;
		line += tabText(tab, label, tab.key === active, focusKey === tab.key, theme) + theme.fg("borderMuted", "─");
		hits.add({ x, y, width: w, height: 1, click: () => pick(tab.key) });
		x += w + 1;
	}
	const fill = theme.fg("borderMuted", "─".repeat(Math.max(0, room - x)));
	const head = fitLine(line + fill, room);
	const middle = rightWidth ? `${head} ${clip(right, rightWidth)}${theme.fg("borderMuted", "─")}` : head;
	return { line: fitLine(middle, space) + fixed, fixedX: space };
}
