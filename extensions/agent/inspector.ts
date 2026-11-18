/**
 * The agent work view's inspector: one view under its title, for a form, a reader or an owner view
 * bound to one captured conversation, with nested views above it. The last row is the key row: the
 * view's own keys, its keyed actions, More and the way out. A click on a key-row control runs what
 * its key runs. Escape closes More, then lets the view leave an edit, then runs the view's Cancel,
 * then leaves a nested view, then the inspector.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	type Focusable,
	matchesKey,
	type TuiMouseEvent,
	type TuiMouseEventResult,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { actionControl, actionLabel, type Control, KeyRow, menuControl } from "./key-row.ts";
import { HitMap } from "./view-hits.ts";
import { keyInput, keyMatches, keyText, MORE_CHORD, MORE_KEY } from "./view-keys.ts";
import type { Action, KeyHint, Notice, NoticeKind, View, ViewHost, ViewTarget } from "./view-model.ts";
import { fitCells, plainLine, wrap } from "./view-text.ts";

export interface InspectorOptions {
	readonly theme: Theme;
	readonly target: ViewTarget;
	/** The title row's label: the action, form or owner view the inspector shows. */
	readonly title: string;
	open(host: ViewHost): View;
	/** Rows the inspector occupies on the next render. Read on every render. */
	rows(): number;
	requestRender(): void;
	/** Leave the inspector. The host restores its own focus, then runs `then` when given. */
	close(then?: () => unknown): void;
	/** Key-row wording of the way out of the first view, for example "close configure". */
	readonly closeLabel?: string;
	/**
	 * Draw the key row as the inspector's last row. A host that draws one key row for its whole
	 * screen passes false and draws `renderFooter` itself. Default true.
	 */
	readonly footer?: boolean;
}

interface Layer {
	readonly view: View;
	readonly controller: AbortController;
}

const failureText = (error: unknown) => plainLine(error instanceof Error ? error.message : String(error)).slice(0, 240);

/** The reason a view could not open, or failed while drawing or answering, at the same depth. */
function failureView(title: string, text: string, theme: Theme): View {
	return {
		title,
		render: (width, height) => {
			const lines = [
				theme.fg("warning", `${plainLine(title)} is unavailable here.`),
				...wrap(plainLine(text), width).map((line) => theme.fg("muted", line)),
			];
			return Array.from({ length: height }, (_, row) => fitCells(lines[row] ?? "", width));
		},
		handleInput: () => false,
	};
}

export class Inspector implements Component, Focusable {
	focused = true;
	private readonly options: InspectorOptions;
	private readonly layers: Layer[] = [];
	private readonly hits = new HitMap();
	private readonly bar = new KeyRow();
	private notice?: Notice;
	private closed = false;
	private bodyY = 1;
	private bodyHeight = 1;
	/** Size of the last render: a pointer event drawn for another size acts on nothing. */
	private size = { width: 0, height: 0 };

	constructor(options: InspectorOptions) {
		this.options = options;
		const controller = new AbortController();
		try {
			const view = options.open(this.host(controller));
			this.layers.push({ view, controller });
			view.focusEdge?.(false);
		} catch (error) {
			this.layers.push({ view: failureView(options.title, failureText(error), options.theme), controller });
		}
	}

	/** The title of the view the operator reads now, for example a form opened from a reader. */
	get viewTitle(): string | undefined {
		return this.top()?.view.title;
	}

	/** The labelled actions of the view the operator reads now. */
	get viewActions(): readonly Action[] {
		return this.actions();
	}

	/** True while a text field of the view has focus, so printable keys are text. */
	get editing(): boolean {
		return !this.bar.menuShown && (this.top()?.view.editing?.() ?? false);
	}

	private show(notice: Notice): void {
		this.notice = notice;
		this.options.requestRender();
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
			notify: (text: string, kind: NoticeKind = "info") => {
				if (live()) this.show({ text: plainLine(text), kind });
			},
			push: (open) => this.push(controller, open),
			back: () => this.leave(controller),
			close: (then?: () => unknown) => {
				if (live()) this.close(then);
			},
		};
	}

	private push(parent: AbortController, open: (host: ViewHost) => View): void {
		if (this.closed || parent.signal.aborted || this.top()?.controller !== parent) return;
		const controller = new AbortController();
		try {
			const view = open(this.host(controller));
			this.layers.push({ view, controller });
			this.notice = undefined;
			this.bar.closeMenu();
			view.focusEdge?.(false);
		} catch (error) {
			controller.abort();
			this.notice = { text: failureText(error), kind: "error" };
		}
		this.options.requestRender();
	}

	/** Leave the view owning `controller` and every view above it. The first view leaves the inspector. */
	private leave(controller: AbortController): void {
		if (this.closed || controller.signal.aborted) return;
		const index = this.layers.findIndex((layer) => layer.controller === controller);
		if (index < 0) return;
		if (index === 0) {
			this.close();
			return;
		}
		for (const layer of this.layers.splice(index).reverse()) disposeLayer(layer);
		this.bar.closeMenu();
		this.options.requestRender();
	}

	private top(): Layer | undefined {
		return this.layers.at(-1);
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

	private fail(error: unknown): void {
		const layer = this.top();
		if (!layer) return;
		disposeLayer(layer);
		this.layers[this.layers.length - 1] = {
			view: failureView(layer.view.title, failureText(error), this.options.theme),
			controller: new AbortController(),
		};
	}

	close(then?: () => unknown): void {
		if (this.closed) return;
		this.dispose();
		this.options.close(then);
	}

	/** Run a view action by identity after re-reading the current list; a disabled one explains itself. */
	private invoke(id: string): void {
		const action = this.actions().find((candidate) => candidate.id === id);
		if (!action) return;
		this.bar.closeMenu();
		if (action.disabled) this.show({ text: action.disabled, kind: "warning" });
		else action.run();
	}

	/** Send one key through the route a key press takes; key-row clicks use this. */
	private sendKey(key: string): void {
		const data = keyInput(key);
		if (data === undefined) this.show({ text: `The ${keyText(key)} key has no clickable form here.`, kind: "warning" });
		else this.handleInput(data);
	}

	/** The title on a rule, emphasised, and the bound target on the right while it fits. */
	private renderHeader(width: number): string {
		const theme = this.options.theme;
		const rule = (text: string) => theme.fg("borderMuted", text);
		const title = plainLine(this.options.title);
		const target = theme.fg("muted", ` ${plainLine(this.options.target.label)} `);
		const natural = visibleWidth(title) + 4;
		const rightWidth = Math.max(0, Math.min(visibleWidth(target), Math.floor(width / 2), width - natural - 2));
		const room = Math.max(0, width - (rightWidth ? rightWidth + 2 : 0));
		const label = ` ${truncateToWidth(title, Math.max(1, room - 4), "…")} `;
		const head = fitCells(
			`${rule("─")}${theme.bold(theme.fg("accent", label))}${rule("─".repeat(Math.max(0, room - visibleWidth(label) - 1)))}`,
			room,
		);
		return rightWidth ? fitCells(`${head} ${truncateToWidth(target, rightWidth)}${rule("─")}`, width) : head;
	}

	/** The trail of nested views; Escape goes back one step. */
	private renderCrumb(width: number): string | undefined {
		if (this.layers.length < 2) return undefined;
		const trail = this.layers.map((layer) => plainLine(layer.view.title)).join(" › ");
		return fitCells(this.options.theme.fg("muted", ` ${trail}`), width);
	}

	private noticeText(): string {
		const notice = this.notice;
		if (!notice) return "";
		const colour =
			notice.kind === "error"
				? "error"
				: notice.kind === "warning"
					? "warning"
					: notice.kind === "success"
						? "success"
						: "muted";
		return this.options.theme.fg(colour, ` ${plainLine(notice.text)}`);
	}

	/** The way out for the current state: the view's own Escape, its Cancel, back, or close. */
	private exitControl(hint: KeyHint | undefined, actions: readonly Action[]): Control {
		const cancel = actions.find((action) => action.key === "escape");
		const label =
			hint?.label ??
			(cancel ? actionLabel(cancel) : this.layers.length > 1 ? "back" : (this.options.closeLabel ?? "close"));
		return { id: "\u0000exit", keys: ["escape"], label, priority: 0, run: () => this.sendKey("escape") };
	}

	/** Key-row controls for the current focus: the view's keys, its keyed actions, then the way out. */
	private footerControls(): { controls: Control[]; menu: Control[] } {
		const send = (key: string) => this.sendKey(key);
		if (this.bar.menuShown) return { controls: KeyRow.menuControls(this.bar, send), menu: [] };
		const hints = this.hints();
		const escapeHint = hints.find((hint) => hint.keys.includes("escape"));
		const controls: Control[] = hints
			.filter((hint) => hint !== escapeHint)
			.map((hint, index) => ({
				id: `\u0000key${index}`,
				keys: hint.keys,
				label: hint.label,
				priority: hint.priority ?? (index === 0 ? 0 : 2),
				run: send,
			}));
		const actions = this.actions();
		// A focused text field takes every key but Escape, Tab and the chords, so the row then shows
		// only the view's own keys: action keys and More would be text.
		const menu = this.editing ? [] : this.actionControls(actions, controls, hints);
		controls.push(this.exitControl(escapeHint, actions));
		return { controls, menu };
	}

	/**
	 * Primary keyed actions join the row; every other action is listed in More. A key the view's
	 * current hints claim belongs to the view, so that action lists in More without the key: one key
	 * never means two things in one focus. Returns the More entries.
	 */
	private actionControls(actions: readonly Action[], controls: Control[], hints: readonly KeyHint[]): Control[] {
		const menu: Control[] = [];
		const invoke = (id: string) => this.invoke(id);
		const claimed = (key: string | undefined) =>
			key !== undefined && key !== "escape" && hints.some((hint) => hint.keys.includes(key));
		for (const action of actions) {
			if (action.key === "escape") continue;
			const control = !claimed(action.key) && action.primary ? actionControl(action, invoke) : undefined;
			if (control) controls.push(control);
			else menu.push(claimed(action.key) ? { ...menuControl(action, invoke), keys: [] } : menuControl(action, invoke));
		}
		return menu;
	}

	/** Draw the key row at `y` and register its targets in `hits` (the host's map when embedded). */
	renderFooter(width: number, hits: HitMap, y: number, x0 = 0): string {
		const { controls, menu } = this.footerControls();
		return this.bar.render(controls, width, this.options.theme, hits, y, x0, menu, this.editing);
	}

	render(width: number): string[] {
		const height = Math.max(4, Math.floor(this.options.rows()));
		this.size = { width, height };
		this.hits.begin(width, height);
		const header = this.renderHeader(width);
		const crumb = this.renderCrumb(width);
		this.bodyY = crumb ? 2 : 1;
		const notice = this.noticeText();
		const footerRows = this.options.footer === false ? 0 : 1;
		const bodyHeight = Math.max(1, height - this.bodyY - footerRows - (notice ? 1 : 0));
		this.bodyHeight = bodyHeight;
		const body = this.renderBody(width, bodyHeight);
		// The view has laid itself out for this size, so its keys are current; the key row then
		// decides what More lists, so it is laid out before the menu.
		const footer = footerRows ? this.renderFooter(width, this.hits, height - 1) : undefined;
		if (this.bar.menuShown) this.overlayMenu(body, width, height, bodyHeight);
		return [
			header,
			...(crumb ? [crumb] : []),
			...body,
			...(notice ? [fitCells(notice, width)] : []),
			...(footer === undefined ? [] : [footer]),
		].slice(0, height);
	}

	private overlayMenu(body: string[], width: number, height: number, bodyHeight: number): void {
		const menuHits = new HitMap();
		menuHits.begin(width, height);
		const menuRows = Math.min(bodyHeight, Math.max(2, this.bar.menuRows));
		const menu = this.bar.renderMenu(width, menuRows, this.options.theme, menuHits, this.bodyY + bodyHeight - menuRows);
		body.splice(bodyHeight - menu.length, menu.length, ...menu.map((line) => fitCells(line, width)));
		this.hits.include(menuHits, 0, 0);
	}

	/** The view's rows; a view that fails while drawing is replaced by its reason, at the same size. */
	private renderBody(width: number, height: number): string[] {
		const layer = this.top();
		let body: string[] = [];
		if (layer) {
			layer.view.focused = this.focused && !this.bar.menuShown;
			try {
				body = layer.view.render(width, height);
			} catch (error) {
				this.fail(error);
				body = this.top()?.view.render(width, height) ?? [];
			}
		}
		return Array.from({ length: height }, (_, row) => fitCells(body[row] ?? "", width));
	}

	/** Move focus one step inside the inspector; false at its edge, so the embedding view moves on. */
	focusNext(backward: boolean): boolean {
		this.bar.closeMenu();
		return this.top()?.view.focusNext?.(backward) ?? false;
	}

	/** Focus enters the inspector: the view's first region, or its last going backward. */
	focusEdge(backward: boolean): void {
		this.bar.closeMenu();
		this.top()?.view.focusEdge?.(backward);
	}

	private escape(): void {
		if (this.bar.menuShown) {
			this.bar.closeMenu();
			return;
		}
		const layer = this.top();
		if (layer?.view.escape?.()) return;
		const cancel = this.actions().find((action) => action.key === "escape");
		if (cancel) this.invoke(cancel.id);
		else if (layer && this.layers.length > 1) this.leave(layer.controller);
		else this.close();
	}

	handleInput(data: string): void {
		if (this.closed) return;
		this.route(data);
		if (!this.closed) this.options.requestRender();
	}

	private route(data: string): void {
		if (matchesKey(data, "escape")) this.escape();
		else if (this.bar.menuShown) this.bar.menuInput(data);
		else if (matchesKey(data, "tab") || matchesKey(data, "shift+tab")) this.traverse(matchesKey(data, "shift+tab"));
		else if (keyMatches(data, MORE_CHORD) && this.bar.hasMore) this.bar.toggleMenu();
		else this.viewInput(data);
	}

	/** Tab moves through the view's regions and wraps at its edge. */
	private traverse(backward: boolean): void {
		const view = this.top()?.view;
		this.bar.closeMenu();
		if (view && !view.focusNext?.(backward)) view.focusEdge?.(backward);
	}

	/**
	 * While a text field has focus the view takes every key, so letters stay text and the row lists
	 * no action keys. Otherwise a key of the view's current hints is the view's binding and never
	 * reaches an action; only unclaimed keys run actions, open More, or reach the view.
	 */
	private viewInput(data: string): void {
		const view = this.top()?.view;
		if (!view) return;
		try {
			if (view.editing?.() || this.hints().some((hint) => hint.keys.some((key) => keyMatches(data, key))))
				view.handleInput(data);
			else if (this.actionKey(data)) return;
			else if (keyMatches(data, MORE_KEY) && this.bar.hasMore) this.bar.toggleMenu();
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

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (this.closed) return undefined;
		if (event.width !== this.size.width || event.height !== this.size.height) return undefined;
		const own = this.hits.handle(event);
		if (own) {
			this.options.requestRender();
			return own;
		}
		const view = this.top()?.view;
		if (!view?.handleMouse || event.y < this.bodyY || event.y >= this.bodyY + this.bodyHeight) return undefined;
		try {
			const result = view.handleMouse({ ...event, y: event.y - this.bodyY, height: this.bodyHeight });
			if (result) {
				this.bar.closeMenu();
				this.options.requestRender();
			}
			return result;
		} catch (error) {
			this.fail(error);
			return { handled: true };
		}
	}

	invalidate(): void {
		this.hits.clear();
		for (const layer of this.layers) layer.view.invalidate?.();
	}

	dispose(): void {
		if (this.closed) return;
		this.closed = true;
		for (const layer of this.layers.splice(0).reverse()) disposeLayer(layer);
	}
}

function disposeLayer(layer: Layer): void {
	layer.controller.abort();
	try {
		layer.view.dispose?.();
	} catch {
		// A failing disposal must not strand the inspector.
	}
}
