/** The Markdown view in Pi's editor slot. The Agent terminal hosts the same view via the
 * view contract in docs/conventions/operator-panels.md.
 */

import { basename } from "node:path";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import {
	decodeKittyPrintable,
	type KeyId,
	matchesKey,
	SelectList,
	type TuiMouseEvent,
	type TuiMouseEventResult,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";

export type NoticeKind = "info" | "success" | "warning" | "error" | "pending";

export interface Notice {
	readonly text: string;
	readonly kind: NoticeKind;
}

/** The session or conversation a view acts on, as the operator recognises it. */
export interface ViewTarget {
	readonly id: string;
	readonly label: string;
}

/** One labelled effect. Its key, a click on its control and the More menu all call `run`. */
export interface Action {
	readonly id: string;
	readonly label: string;
	readonly description?: string;
	/** Why the action cannot run now; it stays listed and explains itself. */
	readonly disabled?: string;
	/** A pi-tui key id such as "enter" or one printable character, active while no text field has focus. */
	readonly key?: string;
	/** Key-row wording when the label is long. */
	readonly short?: string;
	/** On the key row while it fits; an action without a key, or one that does not fit, is in More. */
	readonly primary?: boolean;
	readonly tone?: "accent" | "danger";
	run(): void;
}

/** Keys the view handles itself, shown before its actions; a click on one sends that key. */
export interface KeyHint {
	readonly keys: readonly string[];
	readonly label: string;
	/** Lower numbers stay on a short row longer; 0 never leaves it. */
	readonly priority?: number;
}

export interface ViewHost {
	readonly theme: Theme;
	/** The session or conversation every effect of the view acts on. */
	readonly target: ViewTarget;
	/** Aborted when the view is left, so late answers are dropped. */
	readonly signal: AbortSignal;
	requestRender(): void;
	notify(text: string, kind?: NoticeKind): void;
	/** Open a nested view above this one, with its own host and signal. */
	push(open: (host: ViewHost) => View): void;
	/** Leave this view; the first view leaves the frame. */
	back(): void;
	/** Return to the conversation, then run `then`. */
	close(then?: () => unknown): void;
}

/** A view renders exactly the rows it is given and consumes only the keys and pointer events it owns. */
export interface View {
	readonly title: string;
	focused?: boolean;
	render(width: number, height: number): string[];
	/** True when the key was consumed. */
	handleInput(data: string): boolean;
	handleMouse?(event: TuiMouseEvent): TuiMouseEventResult | undefined;
	actions?(): readonly Action[];
	keys?(): readonly KeyHint[];
	/** True while a text field has focus: printable keys are text. */
	editing?(): boolean;
	/** Leave an edit or a region; false lets the frame continue the Escape order. */
	escape?(): boolean;
	/** Move focus to the next or previous region; false at the edge. */
	focusNext?(backward: boolean): boolean;
	focusEdge?(backward: boolean): void;
	invalidate?(): void;
	dispose?(): void;
}

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

/** The Agent terminal's host of an owner view: the view host plus one request through the owner's command. */
export interface PanelHost extends ViewHost {
	request(data: JsonValue, signal?: AbortSignal): Promise<{ text: string; data?: JsonValue }>;
}

export interface OperatorPanelModule {
	readonly version: 2;
	readonly title: string;
	open(host: PanelHost): View;
}

const CONTROL = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|[\p{Cc}\p{Cf}]/gu;

/** One line of untrusted text: controls removed and whitespace collapsed. */
export function plainLine(text: string): string {
	return text.replace(CONTROL, " ").replace(/\s+/g, " ").trim();
}

/** Exactly `width` columns: truncated, then padded. */
export function fitLine(text: string, width: number): string {
	const columns = Math.max(0, Math.floor(width));
	if (columns === 0) return "";
	const value = truncateToWidth(text, columns);
	return value + " ".repeat(Math.max(0, columns - visibleWidth(value)));
}

const KEY_NAMES: Readonly<Record<string, string>> = {
	escape: "esc",
	pageUp: "pgup",
	pageDown: "pgdn",
	up: "↑",
	down: "↓",
	left: "←",
	right: "→",
};

function keyText(key: string): string {
	const parts = key.split("+");
	const last = parts.pop() ?? key;
	return [...parts, KEY_NAMES[last] ?? last].join("+");
}

function keysText(keys: readonly string[]): string {
	const texts = keys.map(keyText);
	return texts.every((text) => /^[↑↓←→]$/u.test(text)) ? texts.join("") : texts.join("/");
}

/** True when the input is the key; a printable character also matches its Kitty encoding. */
export function keyMatches(data: string, key: string): boolean {
	if ([...key].length === 1) return (decodeKittyPrintable(data) ?? data) === key;
	return matchesKey(data, key as KeyId);
}

/** Input that a click on a key control sends, for the keys shown by the Markdown view. */
const KEY_INPUT: Readonly<Record<string, string>> = {
	up: "\u001b[A",
	down: "\u001b[B",
	right: "\u001b[C",
	left: "\u001b[D",
	home: "\u001b[H",
	end: "\u001b[F",
	pageUp: "\u001b[5~",
	pageDown: "\u001b[6~",
	enter: "\r",
	tab: "\t",
	"shift+tab": "\u001b[Z",
	escape: "\u001b",
	"ctrl+n": "\u000e",
};

const keyInput = (key: string): string | undefined => KEY_INPUT[key] ?? ([...key].length === 1 ? key : undefined);

/** The key that opens More, and the chord that opens it while a text field has focus. */
const MORE_KEY = "x";
const MORE_CHORD = "ctrl+n";
const SEPARATOR = " · ";

/** One key-row control; a click on it and its key run the same function. */
interface Control {
	readonly keys: readonly string[];
	readonly label: string;
	readonly description?: string;
	readonly disabled?: string;
	readonly tone?: "accent" | "danger";
	readonly priority: number;
	run(key: string): void;
}

const controlText = (control: Control) => `${keysText(control.keys)} ${plainLine(control.label)}`;

/** Key-row wording of an action: its short form, or its label with a lower-case first letter. */
function actionLabel(action: Pick<Action, "label" | "short">): string {
	const text = plainLine(action.short ?? action.label);
	return /^\p{Lu}\p{Ll}/u.test(text) ? `${text.charAt(0).toLocaleLowerCase()}${text.slice(1)}` : text;
}

/** The control that leaves a short row next: the highest priority number, the last of equals. */
function nextToDrop(shown: readonly Control[]): number {
	let drop = -1;
	let worst = 0;
	shown.forEach((control, index) => {
		if (control.priority > 0 && control.priority >= worst) {
			drop = index;
			worst = control.priority;
		}
	});
	return drop;
}

const failureText = (error: unknown) => plainLine(error instanceof Error ? error.message : String(error)).slice(0, 240);

interface Layer {
	readonly view: View;
	readonly controller: AbortController;
}

export interface FrameOptions {
	readonly theme: Theme;
	readonly target: ViewTarget;
	/** Rows the frame takes, read at every render. */
	rows(expanded: boolean): number;
	requestRender(): void;
	/** Leave the frame; the host restores the conversation, then runs `then`. */
	close(then?: () => unknown): void;
	/** Pi's expand key, which gives the frame most of the window. */
	readonly expandKey: string;
	open(host: ViewHost): View;
}

/**
 * One view under its title, with nested views above it. The last row is the key row: the view's
 * keys, its keyed actions, Expand, More and the way out. Escape closes More, then lets the view
 * leave an edit, then runs the view's Cancel, then leaves a nested view, then the frame.
 */
export class Frame {
	focused = true;
	/** In fullscreen mode Pi gives PageUp and PageDown to the transcript unless the focused component takes them. */
	readonly capturesViewportInput = true;
	private readonly options: FrameOptions;
	private readonly layers: Layer[] = [];
	private notice?: Notice;
	private expanded = false;
	private closed = false;
	/** The size of the last render: a pointer event drawn for another size acts on nothing. */
	private size = { width: 0, height: 0 };
	private body = { top: 1, height: 1 };
	private row = { y: 0, targets: [] as Array<{ x: number; width: number; run(): void }> };
	/** What More lists, from the last drawn key row. */
	private hidden: Control[] = [];
	private menu?: {
		list: SelectList;
		readonly entries: readonly Control[];
		limit: number;
		top: number;
		header: boolean;
	};

	constructor(options: FrameOptions) {
		this.options = options;
		this.mount(options.open);
	}

	/** True while a text field of the view has focus. */
	get editing(): boolean {
		return !this.menu && (this.top()?.view.editing?.() ?? false);
	}

	private top(): Layer | undefined {
		return this.layers.at(-1);
	}

	private host(controller: AbortController): ViewHost {
		const live = () => !controller.signal.aborted && !this.closed;
		return {
			theme: this.options.theme,
			target: this.options.target,
			signal: controller.signal,
			requestRender: () => {
				if (live()) this.options.requestRender();
			},
			notify: (text, kind = "info") => {
				if (!live()) return;
				this.notice = { text: plainLine(text), kind };
				this.options.requestRender();
			},
			push: (open) => {
				if (live() && this.top()?.controller === controller) this.mount(open);
			},
			back: () => this.leave(controller),
			close: (then) => {
				if (live()) this.close(then);
			},
		};
	}

	private mount(open: (host: ViewHost) => View): void {
		const controller = new AbortController();
		try {
			const view = open(this.host(controller));
			this.layers.push({ view, controller });
			if (this.layers.length > 1) this.notice = undefined;
			this.menu = undefined;
			view.focusEdge?.(false);
		} catch (error) {
			controller.abort();
			if (this.layers.length) this.notice = { text: failureText(error), kind: "error" };
			else this.layers.push({ view: this.failure(failureText(error)), controller });
		}
		this.options.requestRender();
	}

	/** Leave the view that owns `controller` and every view above it; the first view leaves the frame. */
	private leave(controller: AbortController): void {
		const index = this.layers.findIndex((layer) => layer.controller === controller);
		if (index < 0 || controller.signal.aborted || this.closed) return;
		if (index === 0) {
			this.close();
			return;
		}
		for (const layer of this.layers.splice(index).reverse()) dispose(layer);
		this.menu = undefined;
		this.options.requestRender();
	}

	/** A view that failed while drawing or answering is replaced by its reason, at the same depth. */
	private failure(text: string): View {
		const theme = this.options.theme;
		return {
			title: "Unavailable",
			render: (width, height) =>
				Array.from({ length: height }, (_, row) =>
					fitLine(row === 0 ? theme.fg("warning", `This view is unavailable: ${text}`) : "", width),
				),
			handleInput: () => false,
		};
	}

	private fail(error: unknown): void {
		const layer = this.top();
		if (!layer) return;
		dispose(layer);
		this.menu = undefined;
		this.layers[this.layers.length - 1] = { view: this.failure(failureText(error)), controller: new AbortController() };
	}

	private actions(): readonly Action[] {
		try {
			return this.top()?.view.actions?.() ?? [];
		} catch (error) {
			this.fail(error);
			return [];
		}
	}

	private hints(): readonly KeyHint[] {
		try {
			return this.top()?.view.keys?.() ?? [];
		} catch (error) {
			this.fail(error);
			return [];
		}
	}

	close(then?: () => unknown): void {
		if (this.closed) return;
		this.dispose();
		this.options.close(then);
	}

	dispose(): void {
		if (this.closed) return;
		this.closed = true;
		for (const layer of this.layers.splice(0).reverse()) dispose(layer);
	}

	/** Run a view action by identity from the current list; a disabled one explains itself. */
	private invoke(id: string): void {
		const action = this.actions().find((candidate) => candidate.id === id);
		this.menu = undefined;
		if (!action) return;
		if (action.disabled) this.notice = { text: plainLine(action.disabled), kind: "warning" };
		else action.run();
	}

	/** Send one key through the route a key press takes; key-row clicks use this. */
	private sendKey(key: string): void {
		const data = keyInput(key);
		if (data !== undefined) this.handleInput(data);
		else if (key === this.options.expandKey) this.handleInputForExpand();
	}

	private handleInputForExpand(): void {
		this.expanded = !this.expanded;
		this.options.requestRender();
	}

	/** The key row's controls for the current focus, the way out last, and the actions only More lists. */
	private controls(): { row: Control[]; menu: Control[] } {
		const send = (key: string) => this.sendKey(key);
		if (this.menu) {
			return {
				row: [
					{ keys: ["up", "down"], label: "choose", priority: 0, run: send },
					{ keys: ["enter"], label: "run", priority: 0, run: send },
					{ keys: ["escape"], label: "close menu", priority: 0, run: send },
				],
				menu: [],
			};
		}
		const hints = this.hints();
		const actions = this.actions();
		const escapeHint = hints.find((hint) => hint.keys.includes("escape"));
		const row: Control[] = hints
			.filter((hint) => hint !== escapeHint)
			.map((hint, index) => ({
				keys: hint.keys,
				label: hint.label,
				priority: hint.priority ?? (index === 0 ? 0 : 2),
				run: send,
			}));
		// A focused text field takes every printable key, so the row then shows no action keys.
		const menu = this.editing ? [] : this.actionControls(actions, hints, row);
		row.push({
			keys: [this.options.expandKey],
			label: this.expanded ? "shrink" : "expand",
			description: this.expanded ? "Give rows back to the conversation" : "Use most of the window",
			priority: 3,
			run: send,
		});
		const cancel = actions.find((action) => action.key === "escape");
		const exit = escapeHint?.label ?? (cancel ? actionLabel(cancel) : this.layers.length > 1 ? "back" : "close");
		row.push({ keys: ["escape"], label: exit, priority: 0, run: send });
		return { row, menu };
	}

	/**
	 * Primary keyed actions join the row; every other action is listed in More. A key the view's
	 * hints claim belongs to the view, so that action lists in More without its key: one key never
	 * means two things in one focus. Returns the More entries.
	 */
	private actionControls(actions: readonly Action[], hints: readonly KeyHint[], row: Control[]): Control[] {
		const menu: Control[] = [];
		const claimed = (key: string | undefined) => key !== undefined && hints.some((hint) => hint.keys.includes(key));
		for (const action of actions) {
			if (action.key === "escape") continue;
			const control = { ...action, run: () => this.invoke(action.id) };
			if (action.key && action.primary && !claimed(action.key))
				row.push({ ...control, keys: [action.key], label: actionLabel(action), priority: 1 });
			else menu.push({ ...control, keys: action.key && !claimed(action.key) ? [action.key] : [], priority: 2 });
		}
		return menu;
	}

	/** Draw the key row at `y`: controls leave a short row by priority into More, and each key gets its own click target. */
	private keyRow(width: number, y: number): string {
		const theme = this.options.theme;
		const { row: controls, menu } = this.controls();
		const exit = controls.pop();
		const hidden: Control[] = [];
		const more: Control = {
			keys: [this.editing ? MORE_CHORD : MORE_KEY],
			label: "more",
			priority: 0,
			run: (key) => this.sendKey(key),
		};
		const row = () => [...controls, ...(hidden.length || menu.length ? [more] : []), ...(exit ? [exit] : [])];
		const measure = () =>
			row().reduce(
				(total, control, index) => total + visibleWidth(controlText(control)) + (index ? SEPARATOR.length : 0),
				0,
			);
		for (let drop = nextToDrop(controls); measure() > width && drop >= 0; drop = nextToDrop(controls))
			hidden.unshift(...controls.splice(drop, 1));
		// While More shows, its entries stay as they were when it opened.
		if (!this.menu)
			this.hidden = [...hidden, ...menu].flatMap((control) =>
				control.keys.length > 1 ? control.keys.map((key) => ({ ...control, keys: [key] })) : [control],
			);
		this.row = { y, targets: [] };
		const parts: string[] = [];
		let x = 0;
		for (const control of row()) {
			const text = controlText(control);
			if (x + visibleWidth(text) <= width) this.target(control, x);
			const keys = keysText(control.keys);
			const label = plainLine(control.label);
			parts.push(
				control.disabled
					? theme.fg("dim", `${keys} ${label}`)
					: `${theme.fg("accent", keys)} ${theme.fg(control.tone === "danger" ? "error" : "muted", label)}`,
			);
			x += visibleWidth(text) + SEPARATOR.length;
		}
		return fitLine(parts.join(theme.fg("dim", SEPARATOR)), width);
	}

	private target(control: Control, x: number): void {
		if (control.keys.length <= 1) {
			this.row.targets.push({
				x,
				width: visibleWidth(controlText(control)),
				run: () => control.run(control.keys[0] ?? ""),
			});
			return;
		}
		const arrows = control.keys.every((key) => /^[↑↓←→]$/u.test(keyText(key)));
		for (const key of control.keys) {
			const width = visibleWidth(keyText(key));
			this.row.targets.push({ x, width, run: () => control.run(key) });
			x += width + (arrows ? 0 : 1);
		}
	}

	private toggleMenu(): void {
		if (this.menu) {
			this.menu = undefined;
			return;
		}
		const entries = this.hidden;
		if (!entries.length) return;
		const limit = this.menuLimit(entries.length, this.body.height);
		this.menu = { list: this.menuList(entries, limit), entries, limit, top: 0, header: false };
	}

	private menuLimit(length: number, height: number): number {
		const withoutHeader = height - 1;
		return Math.max(1, length <= withoutHeader ? withoutHeader : withoutHeader - 1);
	}

	private menuList(entries: readonly Control[], limit: number): SelectList {
		const theme = this.options.theme;
		const keyColumn = Math.min(14, Math.max(0, ...entries.map((entry) => visibleWidth(keysText(entry.keys)))));
		const items = entries.map((entry, index) => ({
			value: String(index),
			label: `${fitLine(theme.fg(entry.disabled ? "dim" : "accent", keysText(entry.keys)), keyColumn)}  ${theme.fg(entry.disabled ? "dim" : entry.tone === "danger" ? "error" : "text", plainLine(entry.label))}`,
			...((entry.disabled ?? entry.description)
				? {
						description: entry.disabled
							? `unavailable: ${plainLine(entry.disabled)}`
							: plainLine(entry.description ?? ""),
					}
				: {}),
		}));
		const list = new SelectList(
			items,
			limit,
			{
				selectedPrefix: (text) => theme.fg("accent", text),
				selectedText: (text) => theme.bg("selectedBg", text),
				description: (text) => theme.fg("muted", text),
				scrollInfo: (text) => theme.fg("dim", text),
				noMatch: (text) => theme.fg("dim", text),
			},
			{ minPrimaryColumnWidth: 16, maxPrimaryColumnWidth: 44 },
		);
		list.onSelect = (item) => this.choose(entries[Number(item.value)]);
		return list;
	}

	private renderMenu(body: string[], width: number, menu: NonNullable<Frame["menu"]>): void {
		const limit = this.menuLimit(menu.entries.length, this.body.height);
		if (menu.limit !== limit) {
			const selected = menu.list.getSelectedItem();
			menu.list = this.menuList(menu.entries, limit);
			if (selected) menu.list.setSelectedIndex(Number(selected.value));
			menu.limit = limit;
		}
		menu.header = this.body.height > 1;
		const header = menu.header ? [this.options.theme.fg("muted", "More")] : [];
		// Clip only the scroll indicator at the shortest heights, never an item the pointer can select.
		const lines = [...header, ...menu.list.render(width)].slice(0, this.body.height);
		const start = this.body.height - lines.length;
		menu.top = this.body.top + start + header.length;
		body.splice(start, lines.length, ...lines.map((line) => fitLine(line, width)));
	}

	private choose(entry: Control | undefined): void {
		this.menu = undefined;
		if (!entry) return;
		if (entry.disabled) this.notice = { text: plainLine(entry.disabled), kind: "warning" };
		else entry.run(entry.keys[0] ?? "");
		this.options.requestRender();
	}

	render(width: number): string[] {
		const theme = this.options.theme;
		const height = Math.max(4, Math.floor(this.options.rows(this.expanded)));
		this.size = { width, height };
		const lines = [this.titleRow(width)];
		if (this.layers.length > 1)
			lines.push(
				fitLine(theme.fg("muted", ` ${this.layers.map((layer) => plainLine(layer.view.title)).join(" › ")}`), width),
			);
		const notice = this.noticeRow(width);
		const bodyHeight = Math.max(1, height - lines.length - 1 - (notice ? 1 : 0));
		this.body = { top: lines.length, height: bodyHeight };
		const body = this.renderBody(width, bodyHeight);
		// The view has laid itself out at this size, so its keys are current when the row is drawn.
		const row = this.keyRow(width, height - 1);
		if (this.menu) this.renderMenu(body, width, this.menu);
		return [...lines, ...body, ...(notice ? [notice] : []), row].slice(0, height);
	}

	/** The view's title on a rule, and the bound target on the right while it fits. */
	private titleRow(width: number): string {
		const theme = this.options.theme;
		const rule = (text: string) => theme.fg("borderMuted", text);
		const head = `${rule("─")}${theme.bold(theme.fg("accent", ` ${plainLine(this.layers[0]?.view.title ?? "")} `))}${rule("─")}`;
		const target = ` ${plainLine(this.options.target.label)} `;
		const tail =
			visibleWidth(head) + visibleWidth(target) + 4 <= width ? ` ${theme.fg("muted", target)}${rule("─")}` : "";
		return fitLine(
			`${head}${rule("─".repeat(Math.max(0, width - visibleWidth(head) - visibleWidth(tail))))}${tail}`,
			width,
		);
	}

	private noticeRow(width: number): string | undefined {
		if (!this.notice) return undefined;
		const kind = this.notice.kind;
		const colour =
			kind === "error" ? "error" : kind === "warning" ? "warning" : kind === "success" ? "success" : "muted";
		return fitLine(this.options.theme.fg(colour, ` ${this.notice.text}`), width);
	}

	/** The view's rows; a view that fails while drawing shows its reason instead, at the same size. */
	private renderBody(width: number, height: number): string[] {
		const layer = this.top();
		let body: string[] = [];
		if (layer) {
			layer.view.focused = this.focused && !this.menu;
			try {
				body = layer.view.render(width, height);
			} catch (error) {
				this.fail(error);
				body = this.top()?.view.render(width, height) ?? [];
			}
		}
		return Array.from({ length: height }, (_, row) => fitLine(body[row] ?? "", width));
	}

	handleInput(data: string): void {
		if (this.closed) return;
		this.route(data);
		if (!this.closed) this.options.requestRender();
	}

	private route(data: string): void {
		if (matchesKey(data, "escape")) this.escape();
		else if (this.menu) this.menuInput(data);
		else if (matchesKey(data, "tab") || matchesKey(data, "shift+tab")) this.traverse(matchesKey(data, "shift+tab"));
		else if (keyMatches(data, MORE_CHORD)) this.toggleMenu();
		else if (keyMatches(data, this.options.expandKey)) this.expanded = !this.expanded;
		else this.viewInput(data);
	}

	/**
	 * While a text field has focus every key is text; otherwise a key of the view's hints is the
	 * view's binding, and only unclaimed keys run an action or open More.
	 */
	private viewInput(data: string): void {
		const view = this.top()?.view;
		if (!view) return;
		try {
			if (view.editing?.() || this.hints().some((hint) => hint.keys.some((key) => keyMatches(data, key))))
				view.handleInput(data);
			else if (keyMatches(data, MORE_KEY) && this.hidden.length) this.toggleMenu();
			else if (this.actionKey(data)) return;
			else view.handleInput(data);
		} catch (error) {
			this.fail(error);
		}
	}

	private actionKey(data: string): boolean {
		const action = this.actions().find(
			(candidate) => candidate.key !== undefined && candidate.key !== "escape" && keyMatches(data, candidate.key),
		);
		if (!action) return false;
		this.invoke(action.id);
		return true;
	}

	private menuInput(data: string): void {
		if (keyMatches(data, MORE_KEY) || keyMatches(data, MORE_CHORD)) this.menu = undefined;
		else this.menu?.list.handleInput(data);
	}

	/** Tab moves through the view's regions and wraps at its edge. */
	private traverse(backward: boolean): void {
		const view = this.top()?.view;
		if (view && !view.focusNext?.(backward)) view.focusEdge?.(backward);
	}

	private escape(): void {
		if (this.menu) {
			this.menu = undefined;
			return;
		}
		const layer = this.top();
		if (!layer) {
			this.close();
			return;
		}
		try {
			if (layer.view.escape?.()) return;
		} catch (error) {
			this.fail(error);
			return;
		}
		const cancel = this.actions().find((action) => action.key === "escape");
		if (cancel) this.invoke(cancel.id);
		else if (this.layers.length > 1) this.leave(layer.controller);
		else this.close();
	}

	/**
	 * Completed left clicks and wheel turns without modifiers act, and only at the size last drawn;
	 * presses and drags stay native text selection.
	 */
	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (this.closed || event.shift || event.alt || event.ctrl) return undefined;
		if (event.width !== this.size.width || event.height !== this.size.height) return undefined;
		if (event.type !== "wheel" && (event.type !== "click" || event.button !== "left")) return undefined;
		const result = this.pointer(event);
		if (result) this.options.requestRender();
		return result;
	}

	private pointer(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (this.menu && event.y !== this.row.y) return this.menuPointer(event);
		if (event.y === this.row.y) {
			if (event.type !== "click") return undefined;
			const target = this.row.targets.find(
				(candidate) => event.x >= candidate.x && event.x < candidate.x + candidate.width,
			);
			target?.run();
			return target ? { handled: true } : undefined;
		}
		const view = this.top()?.view;
		if (!view?.handleMouse || event.y < this.body.top || event.y >= this.body.top + this.body.height) return undefined;
		try {
			const result = view.handleMouse({ ...event, y: event.y - this.body.top, height: this.body.height });
			if (result) this.menu = undefined;
			return result;
		} catch (error) {
			this.fail(error);
			return { handled: true };
		}
	}

	private menuPointer(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		const menu = this.menu;
		const bottom = this.body.top + this.body.height;
		if (!menu || event.y < this.body.top || event.y >= bottom) return undefined;
		if (event.y >= menu.top || (menu.header && event.y === menu.top - 1 && event.type === "wheel")) {
			menu.list.handleMouse({ ...event, y: event.y - menu.top, height: bottom - menu.top });
		}
		return { handled: true };
	}

	invalidate(): void {
		for (const layer of this.layers) layer.view.invalidate?.();
	}
}

function dispose(layer: Layer): void {
	layer.controller.abort();
	try {
		layer.view.dispose?.();
	} catch {
		// A failing disposal must not strand the frame.
	}
}

/** Rows the frame takes: most of the window, with transcript rows kept above it. */
function frameRows(terminalRows: number, expanded: boolean): number {
	const rows = Math.max(8, Math.floor(terminalRows));
	if (expanded) return Math.max(8, rows - 4);
	return Math.max(8, Math.min(rows - 6, Math.round(rows * 0.6)));
}

/** The ordinary session as a view target. */
function ordinaryTarget(ctx: ExtensionContext): ViewTarget {
	return {
		id: ctx.sessionManager.getSessionId(),
		label: `This session · ${basename(ctx.cwd || process.cwd()) || "/"}`,
	};
}

/**
 * Show a view in the editor slot below the transcript until it closes. The editor and its draft
 * return when it closes; the close continuation runs after that, so it sees the real editor.
 */
export async function openFrame(
	ctx: ExtensionContext,
	open: (host: ViewHost) => View,
	track?: (frame: Frame | undefined) => void,
): Promise<void> {
	let frame: Frame | undefined;
	let after: (() => unknown) | undefined;
	try {
		await ctx.ui.custom<void>((tui, theme, keybindings, done) => {
			frame = new Frame({
				theme,
				target: ordinaryTarget(ctx),
				rows: (expanded) => frameRows(tui.terminal.rows, expanded),
				requestRender: () => tui.requestRender(),
				close: (then) => {
					after = then;
					done(undefined);
				},
				expandKey: keybindings.getKeys("app.tools.expand")[0] ?? "ctrl+o",
				open,
			});
			track?.(frame);
			return frame;
		});
	} finally {
		frame?.dispose();
		track?.(undefined);
	}
	await after?.();
}

/** Coarse relative age for a past instant: "now", "15m", "3h", "2d". */
export function age(at: number, now = Date.now()): string {
	const seconds = Math.max(0, Math.floor((now - at) / 1000));
	if (seconds < 60) return "now";
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	if (hours < 48) return `${hours}h`;
	return `${Math.floor(hours / 24)}d`;
}
