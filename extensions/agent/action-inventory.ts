import type { Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";
import { DashboardMouse } from "./dashboard-mouse.ts";
import { dashboardHeading, dashboardSelection, fitLine } from "./dashboard-layout.ts";

/**
 * One operator action of a screen. A screen owns its identities, availability, shortcuts and effects
 * together, so the footer, the menu, the keyboard and the pointer all dispatch the same record.
 */
export interface ScreenAction {
	id: string;
	label: string;
	/** Shown beside the label in the menu. */
	description?: string;
	/** Why the action cannot run now. The action stays listed and explains itself. */
	disabled?: string;
	/** Exact key strings: a printable character, or a pi-tui key name such as "enter" or "ctrl+j". */
	keys?: readonly string[];
	/** Offered as a footer control while it fits. Actions without it live in the menu. */
	main?: boolean;
	/**
	 * A destination rather than an action on the selected item. Destinations stay in the footer at every
	 * supported width, in their own group after the item actions.
	 */
	navigation?: boolean;
	run(): void;
}

const MENU_KEY = "x";
/** Separates the fixed group (destinations, menu, way out) from the item actions. Same width as the item separator. */
const GROUP_SEPARATOR = " │ ";
const MENU_FOOTER = { choose: "Choose (Enter)", back: "Back (Esc)" } as const;
const keyMatches = (data: string, key: string) => key.length === 1 ? data === key : matchesKey(data, key as "enter");
const keyLabel = (key: string) => key === "enter" ? "Enter" : key === "tab" ? "Tab" : key === "escape" ? "Esc" : key.replace(/^ctrl\+/u, "Ctrl+");

/**
 * Footer controls and the complete action menu for one screen. Actions are re-read from `provide`
 * at the moment of every click or key, so a stale render can never run a replaced action.
 * The menu never changes the underlying selection, recipient, input mode or draft.
 */
export class ActionInventory {
	private readonly mouse = new DashboardMouse();
	private selected?: string;
	private index = 0;
	private opened = false;
	private context = "";
	private notice = "";
	private readonly provide: () => readonly ScreenAction[];
	private readonly refused?: (reason: string) => void;
	/** `refused` receives the reason when the operator chooses an action that cannot run now. */
	constructor(provide: () => readonly ScreenAction[], refused?: (reason: string) => void) { this.provide = provide; this.refused = refused; }
	get open(): boolean { return this.opened; }
	/** Drop pointer geometry after a resize or a screen change. */
	invalidate(): void { this.mouse.reset(); }
	close(): void { this.opened = false; this.mouse.reset(); }
	private show(): void { this.opened = true; this.notice = ""; this.mouse.reset(); }
	private invoke(id: string): void {
		const action = this.provide().find((item) => item.id === id);
		if (action) this.perform(action);
		else this.mouse.reset();
	}
	private perform(action: ScreenAction): void {
		this.mouse.reset();
		if (action.disabled) { this.notice = action.disabled; this.refused?.(action.disabled); return; }
		this.close();
		action.run();
	}
	/** Keyboard dispatch. `editing` is true while printable keys belong to a text field. */
	handleInput(data: string, editing = false): boolean {
		const actions = this.provide();
		this.mouse.reset();
		if (this.opened) return this.menuInput(data, actions);
		if (editing) return false;
		if (data === MENU_KEY) { this.show(); return true; }
		const action = actions.find((item) => item.keys?.some((key) => keyMatches(data, key)));
		if (!action) return false;
		this.invoke(action.id);
		return true;
	}
	private menuInput(data: string, actions: readonly ScreenAction[]): boolean {
		if (matchesKey(data, "escape") || data === MENU_KEY) { this.close(); return true; }
		const steps: Record<string, number> = { up: -1, down: 1, pageUp: -5, pageDown: 5 };
		for (const [key, delta] of Object.entries(steps)) if (matchesKey(data, key as "up")) this.index += delta;
		if (matchesKey(data, "home")) this.index = 0;
		if (matchesKey(data, "end")) this.index = actions.length - 1;
		this.index = Math.max(0, Math.min(actions.length - 1, this.index));
		this.selected = actions[this.index]?.id;
		if (matchesKey(data, "enter") && this.selected) this.invoke(this.selected);
		return true;
	}
	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined { return this.mouse.handle(event); }
	private control(owner: DashboardMouse, x: number, y: number, width: number, run: () => void): void {
		owner.add({ x, y, width, height: 1, click: () => { this.mouse.reset(); run(); } });
	}
	/**
	 * One footer row: the main item actions that fit, then the fixed group: destinations, the menu and the
	 * way out. Controls read as labels; the menu lists every shortcut. The fixed group always stays; item
	 * actions drop from the end first.
	 */
	footer(owner: DashboardMouse, y: number, width: number, back: ScreenAction, theme: Theme, menu = true, lead = ""): string {
		const actions = this.provide();
		const tail: Array<{ text: string; run: () => void }> = [
			...actions.filter((item) => item.navigation).map((action) => ({ text: action.label, run: () => this.invoke(action.id) })),
			...(menu ? [{ text: `More (${MENU_KEY})`, run: () => this.show() }] : []),
			{ text: `${back.label} (Esc)`, run: () => this.perform(back) },
		];
		const start = lead ? visibleWidth(lead) + 3 : 0;
		const fixed = start + tail.reduce((total, item) => total + visibleWidth(item.text) + 3, 0);
		const parts: Array<{ text: string; run: () => void }> = [];
		let used = fixed;
		for (const action of actions.filter((item) => item.main && !item.navigation)) {
			const text = action.label;
			if (used + visibleWidth(text) > width) break;
			parts.push({ text, run: () => this.invoke(action.id) });
			used += visibleWidth(text) + 3;
		}
		const groupAt = parts.length;
		parts.push(...tail);
		let x = start;
		for (const part of parts) {
			this.control(owner, x, y, Math.max(0, Math.min(visibleWidth(part.text), width - x)), part.run);
			x += visibleWidth(part.text) + 3;
		}
		const row = parts.map((part, index) => `${index === 0 ? "" : index === groupAt && groupAt > 0 ? GROUP_SEPARATOR : " · "}${part.text}`).join("");
		return fitLine(theme.fg("muted", lead ? `${lead} · ${row}` : row), width);
	}
	/** The complete menu as a screen body. Selecting a row only highlights it; Enter or Choose runs it. */
	render(width: number, height: number, title: string, context: string, theme: Theme): string[] {
		const actions = this.provide();
		if (context !== this.context) { this.context = context; this.selected = undefined; this.index = 0; }
		const retained = actions.findIndex((action) => action.id === this.selected);
		if (retained >= 0) this.index = retained;
		this.index = Math.max(0, Math.min(actions.length - 1, this.index));
		this.selected = actions[this.index]?.id;
		this.mouse.reset(width, height);
		// One line per action when two lines each would hide some; every action then stays on screen.
		const lines = actions.length * 2 <= Math.max(0, height - 3) ? 2 : 1;
		const capacity = Math.max(1, Math.floor(Math.max(0, height - 3) / lines));
		const start = Math.max(0, Math.min(Math.max(0, actions.length - capacity), this.index - Math.floor(capacity / 2)));
		const rows = actions.slice(start, start + capacity).flatMap((action, offset) => {
			const index = start + offset;
			const shortcut = action.keys?.length ? ` · ${action.keys.map(keyLabel).join(" / ")}` : "";
			const note = action.disabled ?? action.description ?? "";
			this.mouse.add({ x: 0, y: 1 + offset * lines, width, height: lines, click: () => { this.index = index; this.selected = action.id; } });
			const head = `${index === this.index ? "›" : " "} ${action.label}${shortcut}${action.disabled ? " · unavailable" : ""}`;
			if (lines === 1) return [dashboardSelection(truncateToWidth(`${head}${note ? ` · ${note}` : ""}`, width), width, index === this.index, theme)];
			return [dashboardSelection(truncateToWidth(head, width), width, index === this.index, theme), theme.fg("muted", truncateToWidth(`  ${note}`, width))];
		});
		const chosen = actions[this.index];
		const detail = wrapTextWithAnsi(this.notice || chosen?.disabled || "", Math.max(1, width)).slice(0, 1);
		const footerY = height - 1;
		this.control(this.mouse, 0, footerY, MENU_FOOTER.choose.length, () => { if (chosen) this.invoke(chosen.id); });
		this.control(this.mouse, MENU_FOOTER.choose.length + 3, footerY, MENU_FOOTER.back.length, () => this.close());
		this.mouse.add({ x: 0, y: 1, width, height: Math.max(0, height - 3), wheel: (delta) => { this.index = Math.max(0, Math.min(actions.length - 1, this.index + delta)); this.selected = actions[this.index]?.id; } });
		const body = Array.from({ length: Math.max(0, height - 3) }, (_, index) => rows[index] ?? "");
		return [dashboardHeading(`${title} > More`, `${actions.length ? this.index + 1 : 0}/${actions.length}`, width, theme), ...body, detail[0] ?? "", theme.fg("muted", `${MENU_FOOTER.choose} · ${MENU_FOOTER.back}`)].slice(0, height).map((line) => fitLine(line, width));
	}
}
