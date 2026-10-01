import type { ExtensionContext, KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { SelectList, truncateToWidth, wrapTextWithAnsi, type Component, type TUI } from "@earendil-works/pi-tui";

export interface DashboardActionChoice { name: string; description: string }

/** Native selection with a viewport bounded by the current terminal height. */
export class AgentActionPicker implements Component {
	private list?: SelectList;
	private visible = 0;
	private selected = 0;
	private cramped = false;
	private readonly choices: DashboardActionChoice[];
	private readonly tui: Pick<TUI, "terminal" | "requestRender">;
	private readonly theme: Theme;
	private readonly keys: KeybindingsManager;
	private readonly done: (choice?: string) => void;
	constructor(choices: DashboardActionChoice[], tui: Pick<TUI, "terminal" | "requestRender">, theme: Theme, keys: KeybindingsManager, done: (choice?: string) => void) {
		this.choices = choices; this.tui = tui; this.theme = theme; this.keys = keys; this.done = done;
	}
	private selection(visible: number): SelectList {
		if (this.list && this.visible === visible) return this.list;
		this.visible = visible;
		this.list = new SelectList(this.choices.map((choice) => ({ value: choice.name, label: choice.name })), visible, {
			selectedPrefix: (text) => this.theme.fg("accent", text),
			selectedText: (text) => this.theme.fg("accent", text),
			description: (text) => this.theme.fg("muted", text),
			scrollInfo: (text) => this.theme.fg("dim", text),
			noMatch: (text) => this.theme.fg("muted", text),
		});
		this.list.setSelectedIndex(this.selected);
		this.list.onSelectionChange = (item) => { this.selected = this.choices.findIndex((choice) => choice.name === item.value); };
		this.list.onSelect = (item) => this.done(item.value);
		this.list.onCancel = () => this.done();
		return this.list;
	}
	handleInput(data: string): void {
		if (this.keys.matches(data, "tui.select.cancel")) { this.done(); return; }
		if (!this.cramped) this.list?.handleInput(data);
		this.tui.requestRender();
	}
	render(width: number): string[] {
		const height = Math.max(1, this.tui.terminal.rows - 2);
		width = Math.max(1, width);
		this.cramped = height < 8 || width < 24;
		const label = (action: string) => this.keys.getKeys(action).slice(0, 1).map((key) => key === "up" ? "↑" : key === "down" ? "↓" : key === "enter" ? "Enter" : key === "escape" ? "Esc" : key).join("/");
		const cancel = label("tui.select.cancel");
		if (this.cramped) return [truncateToWidth(`Resize for actions${cancel ? ` · ${cancel} back` : ""}`, width)];
		const description = wrapTextWithAnsi(this.choices[this.selected]?.description ?? "No actions", width).slice(0, Math.min(3, height - 6));
		const list = this.selection(Math.max(1, height - 5 - description.length));
		const confirm = label("tui.select.confirm");
		const navigation = [label("tui.select.up"), label("tui.select.down")].filter(Boolean).join("/");
		return [this.theme.bold("Agent actions"), "", ...list.render(width), "", ...description.map((line) => this.theme.fg("muted", line)), truncateToWidth(`${navigation ? `${navigation} select` : ""}${confirm ? ` · ${confirm} choose` : ""}${cancel ? ` · ${cancel} back` : ""}`, width)];
	}
	invalidate(): void { this.list?.invalidate(); }
}

export async function selectDashboardAction(choices: DashboardActionChoice[], ctx: ExtensionContext): Promise<string | undefined> {
	if (ctx.mode !== "tui") {
		const labels = choices.map((choice) => `${choice.name}: ${choice.description}`);
		const selected = await ctx.ui.select("Agent actions", labels);
		return choices[labels.indexOf(selected ?? "")]?.name;
	}
	return ctx.ui.custom<string | undefined>((tui, theme, keys, done) => new AgentActionPicker(choices, tui, theme, keys, done), {
		overlay: true, overlayOptions: { width: "100%", maxHeight: "100%", margin: { top: 1, bottom: 1 } },
	});
}
