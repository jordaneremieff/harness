import type { Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, wrapTextWithAnsi, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";
import { DashboardMouse } from "./dashboard-mouse.ts";
import { dashboardHeading, dashboardSelection, fitLine } from "./dashboard-layout.ts";

/** A screen owns its identities, availability, shortcuts and effects together. */
export interface ScreenAction {
	id: string;
	label: string;
	description?: string;
	disabled?: string;
	keys?: readonly string[];
	main?: boolean;
	run(): void;
}
const keyMatches = (data: string, key: string) => key.length === 1 ? data === key : matchesKey(data, key as "enter");

/** The menu never changes the underlying recipient, input mode or draft. */
export class ActionInventory {
	private readonly mouse = new DashboardMouse();
	private selected?: string;
	private index = 0;
	private opened = false;
	private context = "";
	private notice = "";
	get open(): boolean { return this.opened; }
	invalidate(): void { this.mouse.reset(); }
	close(): void { this.opened = false; this.mouse.reset(); }
	private invoke(action: ScreenAction): void {
		this.mouse.reset();
		if (action.disabled) { this.notice = action.disabled; return; }
		this.close();
		action.run();
	}
	handleInput(data: string, actions: readonly ScreenAction[], editing = false): boolean {
		this.mouse.reset();
		if (this.opened) {
			if (matchesKey(data, "escape")) { this.close(); return true; }
			if (matchesKey(data, "up")) this.index--;
			if (matchesKey(data, "down")) this.index++;
			if (matchesKey(data, "pageUp")) this.index -= 5;
			if (matchesKey(data, "pageDown")) this.index += 5;
			if (matchesKey(data, "home")) this.index = 0;
			if (matchesKey(data, "end")) this.index = actions.length - 1;
			this.index = Math.max(0, Math.min(actions.length - 1, this.index));
			this.selected = actions[this.index]?.id;
			if (matchesKey(data, "enter") && actions[this.index]) this.invoke(actions[this.index]);
			return true;
		}
		if (editing) return false;
		if (data === "a") { this.opened = true; this.notice = ""; return true; }
		const action = actions.find((item) => item.keys?.some((key) => keyMatches(data, key)));
		if (!action) return false;
		this.invoke(action);
		return true;
	}
	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined { return this.mouse.handle(event); }
	private control(mouse: DashboardMouse, x: number, y: number, label: string, width: number, run: () => void): void {
		mouse.add({ x, y, width, height: 1, click: () => { this.mouse.reset(); run(); } });
	}
	footer(mouse: DashboardMouse, y: number, width: number, actions: readonly ScreenAction[], back: ScreenAction, theme: Theme): string {
		const more = "a actions";
		const end = back.label.toLowerCase();
		const main = actions.filter((action) => action.main);
		const parts = [more];
		let x = more.length + 3;
		this.control(mouse, 0, y, more, more.length, () => { this.opened = true; this.notice = ""; });
		for (const action of main) {
			const label = action.label.toLowerCase();
			if (x + label.length + 3 + end.length > width) continue;
			parts.push(label);
			this.control(mouse, x, y, label, label.length, () => this.invoke(action));
			x += label.length + 3;
		}
		parts.push(end);
		this.control(mouse, x, y, end, Math.min(end.length, width - x), () => this.invoke(back));
		return fitLine(theme.fg("muted", parts.join(" · ")), width);
	}
	render(width: number, height: number, title: string, context: string, actions: readonly ScreenAction[], theme: Theme): string[] {
		if (context !== this.context) { this.context = context; this.selected = undefined; this.index = 0; }
		const retained = actions.findIndex((action) => action.id === this.selected);
		if (retained >= 0) this.index = retained;
		this.index = Math.max(0, Math.min(actions.length - 1, this.index));
		this.selected = actions[this.index]?.id;
		this.mouse.reset(width, height);
		const capacity = Math.max(1, Math.floor((height - 6) / 2));
		const start = Math.max(0, Math.min(actions.length - capacity, this.index - Math.floor(capacity / 2)));
		const rows = actions.slice(start, start + capacity).flatMap((action, offset) => {
			const index = start + offset;
			this.mouse.add({ x: 0, y: 1 + offset * 2, width, height: 2, click: () => { this.index = index; this.selected = action.id; } });
			return [dashboardSelection(`${index === this.index ? "›" : " "} ${action.label}${action.disabled ? ` · ${action.disabled}` : ""}`, width, index === this.index, theme), theme.fg("muted", `  ${action.description ?? ""}`)];
		});
		const chosen = actions[this.index];
		const detail = wrapTextWithAnsi(this.notice || chosen?.disabled || chosen?.description || "Select an action, then choose.", width).slice(0, 2);
		const body = Array.from({ length: Math.max(0, height - 5) }, (_, index) => rows[index] ?? "");
		const choose: ScreenAction = { id: "choose", label: "enter choose", main: true, run: () => { if (chosen) this.invoke(chosen); } };
		const back: ScreenAction = { id: "back", label: "esc back", run: () => this.close() };
		const footer = this.menuFooter(width, height - 1, choose, back, theme);
		this.mouse.add({ x: 0, y: 1, width, height: Math.max(0, height - 5), wheel: (delta) => { this.index = Math.max(0, Math.min(actions.length - 1, this.index + delta)); this.selected = actions[this.index]?.id; } });
		return [dashboardHeading(`${title} > Actions`, `${actions.length ? this.index + 1 : 0}/${actions.length}`, width, theme), ...body, detail[0] ?? "", detail[1] ?? "", "", footer].slice(0, height).map((line) => fitLine(line, width));
	}
	private menuFooter(width: number, y: number, choose: ScreenAction, back: ScreenAction, theme: Theme): string {
		this.control(this.mouse, 0, y, choose.label, choose.label.length, choose.run);
		this.control(this.mouse, choose.label.length + 3, y, back.label, back.label.length, back.run);
		return fitLine(theme.fg("muted", `${choose.label} · ${back.label}`), width);
	}
}
