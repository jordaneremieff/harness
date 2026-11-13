import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Component, type Focusable, matchesKey, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";
import { actionControl, actionLabel, type Control, Footer, MORE_CHORD, MORE_KEY, menuControl, renderTabs } from "./controls.ts";
import { HitMap } from "./hits.ts";
import { keyInput, keyMatches, keyText } from "./keys.ts";
import { fitLine, plainLine, wrap } from "./text.ts";
import type { Action, KeyHint, Notice, NoticeKind, OperatorView, ViewHost, ViewTarget } from "./view.ts";

/** One place the frame can show: an owner's content view, or the reason it is unavailable. */
export interface Destination {
	/** Unique inside the frame; owner-qualified for published views. */
	readonly key: string;
	readonly label: string;
	/** Why this destination cannot open here. It stays listed and explains itself. */
	readonly unavailable?: string;
	open(host: ViewHost): OperatorView;
}

export interface FrameOptions {
	readonly theme: Theme;
	readonly target: ViewTarget;
	destinations(): readonly Destination[];
	readonly initial?: string;
	/** Rows the frame occupies on the next render. Read on every render. */
	rows(): number;
	requestRender(): void;
	/** Leave the frame. The host restores the conversation, then runs `then` when given. */
	close(then?: () => unknown): void;
	/** Frame controls with chord keys, for example Expand. They act whatever the view's focus. */
	controls?(): readonly Action[];
	/** Footer wording of the way out of a destination's first view, for example "close" or "back". */
	readonly closeLabel?: string;
	/** Show every destination as a tab. False shows only the active destination's title. Default true. */
	readonly tabs?: boolean;
	/**
	 * Draw the key footer as the frame's last row. A host that draws one footer for its whole screen
	 * passes false and draws `renderFooter` itself. Default true.
	 */
	readonly footer?: boolean;
}

interface Layer {
	readonly view: OperatorView;
	readonly controller: AbortController;
}

interface Mounted {
	readonly destination: Destination;
	readonly layers: Layer[];
	notice?: Notice;
	failure?: string;
}

const failureText = (error: unknown) => plainLine(error instanceof Error ? error.message : String(error)).slice(0, 240);

/** A placeholder for a destination whose view could not open or failed while drawing. */
class FailureView implements OperatorView {
	readonly title: string;
	private readonly text: string;
	private readonly theme: Theme;
	constructor(title: string, text: string, theme: Theme) {
		this.title = title;
		this.text = text;
		this.theme = theme;
	}
	render(width: number, height: number): string[] {
		const lines = [this.theme.fg("warning", `${plainLine(this.title)} is unavailable here.`), ...wrap(plainLine(this.text), width).map((line) => this.theme.fg("muted", line))];
		return Array.from({ length: height }, (_, row) => fitLine(lines[row] ?? "", width));
	}
	handleInput(): boolean {
		return false;
	}
}

/**
 * The temporary browsing surface. Destinations sit in one row; each keeps its own views, query,
 * selection and reading position while the frame is open. The last row is the key footer: the
 * view's own keys, its actions with their keys, More, and the way out. A click on a footer control
 * runs exactly what its key runs. Escape closes the menu, then lets the view leave an edit, then
 * runs the view's Cancel, then leaves a nested view, then the frame.
 */
export class NavigationFrame implements Component, Focusable {
	focused = true;
	private readonly options: FrameOptions;
	private readonly mounted = new Map<string, Mounted>();
	private readonly hits = new HitMap();
	private readonly bar = new Footer();
	private active?: string;
	private zone: "view" | "tabs" = "view";
	private tabFocus?: string;
	private frameNotice?: Notice;
	private closed = false;
	private bodyY = 1;
	private bodyHeight = 1;
	/** Size of the last render: a pointer event drawn for another size acts on nothing. */
	private size = { width: 0, height: 0 };

	constructor(options: FrameOptions) {
		this.options = options;
		const first = options.destinations().find((destination) => destination.key === options.initial) ?? options.destinations()[0];
		if (first) this.navigate(first.key);
	}

	get activeKey(): string | undefined {
		return this.active;
	}

	/** The title of the view the operator reads now, for example a form opened from a list. */
	get viewTitle(): string | undefined {
		return this.top()?.view.title;
	}

	/** The labelled actions of the view the operator reads now. */
	get viewActions(): readonly Action[] {
		return this.actions();
	}

	/** True while a text field of the view has focus, so printable keys are text. */
	get editing(): boolean {
		return this.zone === "view" && !this.bar.menuShown && (this.top()?.view.editing?.() ?? false);
	}

	private show(notice: Notice): void {
		const mounted = this.active ? this.mounted.get(this.active) : undefined;
		if (mounted) mounted.notice = notice;
		else this.frameNotice = notice;
		this.options.requestRender();
	}

	private host(key: string, controller: AbortController): ViewHost {
		const frame = this;
		return {
			theme: this.options.theme,
			target: this.options.target,
			signal: controller.signal,
			requestRender: () => {
				if (!controller.signal.aborted) this.options.requestRender();
			},
			notify: (text: string, kind: NoticeKind = "info") => {
				if (controller.signal.aborted) return;
				const mounted = this.mounted.get(key);
				if (mounted) mounted.notice = { text: plainLine(text), kind };
				this.options.requestRender();
			},
			push(open) {
				frame.push(key, controller, open);
			},
			back() {
				frame.leave(key, controller);
			},
			close: (then?: () => unknown) => {
				if (!controller.signal.aborted) this.close(then);
			},
		};
	}

	private push(key: string, parent: AbortController, open: (host: ViewHost) => OperatorView): void {
		const mounted = this.mounted.get(key);
		if (!mounted || parent.signal.aborted || mounted.layers.at(-1)?.controller !== parent) return;
		const controller = new AbortController();
		try {
			const view = open(this.host(key, controller));
			mounted.layers.push({ view, controller });
			mounted.notice = undefined;
			this.bar.closeMenu();
			this.zone = "view";
			view.focusEdge?.(false);
		} catch (error) {
			controller.abort();
			mounted.notice = { text: failureText(error), kind: "error" };
		}
		this.options.requestRender();
	}

	/** Leave the view owning `controller` and every view above it. A root view leaves the frame. */
	private leave(key: string, controller: AbortController): void {
		const mounted = this.mounted.get(key);
		if (!mounted || controller.signal.aborted) return;
		const index = mounted.layers.findIndex((layer) => layer.controller === controller);
		if (index <= 0) {
			if (index === 0) this.close();
			return;
		}
		for (const layer of mounted.layers.splice(index)) this.disposeLayer(layer);
		this.bar.closeMenu();
		this.zone = "view";
		this.options.requestRender();
	}

	private disposeLayer(layer: Layer): void {
		layer.controller.abort();
		try {
			layer.view.dispose?.();
		} catch {
			// A failing disposal must not strand the frame.
		}
	}

	/** Show a destination, opening it on first use. Opening another keeps this one's state. */
	navigate(key: string): void {
		if (this.closed) return;
		const destination = this.options.destinations().find((candidate) => candidate.key === key);
		if (!destination) return;
		this.bar.closeMenu();
		this.zone = "view";
		this.active = key;
		this.frameNotice = undefined;
		if (!this.mounted.has(key)) this.mount(destination);
		this.options.requestRender();
	}

	private mount(destination: Destination): void {
		const controller = new AbortController();
		const mounted: Mounted = { destination, layers: [] };
		this.mounted.set(destination.key, mounted);
		if (destination.unavailable) {
			mounted.layers.push({ view: new FailureView(destination.label, destination.unavailable, this.options.theme), controller });
			return;
		}
		try {
			const view = destination.open(this.host(destination.key, controller));
			mounted.layers.push({ view, controller });
			view.focusEdge?.(false);
		} catch (error) {
			mounted.failure = failureText(error);
			mounted.layers.push({ view: new FailureView(destination.label, mounted.failure, this.options.theme), controller });
		}
	}

	private top(): Layer | undefined {
		return this.active ? this.mounted.get(this.active)?.layers.at(-1) : undefined;
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
		const mounted = this.active ? this.mounted.get(this.active) : undefined;
		if (!mounted) return;
		for (const layer of mounted.layers.splice(0)) this.disposeLayer(layer);
		mounted.failure = failureText(error);
		mounted.layers.push({ view: new FailureView(mounted.destination.label, mounted.failure, this.options.theme), controller: new AbortController() });
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
		if (action.disabled) {
			this.show({ text: action.disabled, kind: "warning" });
			return;
		}
		action.run();
	}

	private invokeFrame(id: string): void {
		const action = (this.options.controls?.() ?? []).find((candidate) => candidate.id === id);
		if (!action) return;
		if (action.disabled) this.show({ text: action.disabled, kind: "warning" });
		else action.run();
	}

	/** Send one key through the same route a key press takes; footer clicks use this. */
	private sendKey(key: string): void {
		const data = keyInput(key);
		if (data === undefined) {
			this.show({ text: `The ${keyText(key)} key has no clickable form here.`, kind: "warning" });
			return;
		}
		this.handleInput(data);
	}

	private renderHeader(width: number): string {
		const theme = this.options.theme;
		const shown = this.options.destinations().filter((destination) => this.options.tabs !== false || destination.key === this.active);
		const tabs = shown.map((destination) => ({ key: destination.key, label: destination.label, unavailable: destination.unavailable }));
		const target = theme.fg("muted", ` ${plainLine(this.options.target.label)} `);
		return renderTabs(tabs, this.active, this.zone === "tabs" ? this.tabFocus : undefined, width, theme, this.hits, 0, (key) => this.navigate(key), target);
	}

	/** The trail of nested views; Escape (in the footer) goes back one step. */
	private renderCrumb(width: number, mounted: Mounted): string | undefined {
		if (mounted.layers.length < 2) return undefined;
		const trail = mounted.layers.map((layer) => plainLine(layer.view.title)).join(" › ");
		return fitLine(this.options.theme.fg("muted", ` ${trail}`), width);
	}

	private noticeText(mounted: Mounted | undefined): string {
		const notice = mounted?.notice ?? this.frameNotice;
		if (!notice) return "";
		const colour = notice.kind === "error" ? "error" : notice.kind === "warning" ? "warning" : notice.kind === "success" ? "success" : "muted";
		return this.options.theme.fg(colour, ` ${plainLine(notice.text)}`);
	}

	/** The way out for the current state: the view's own Escape, its Cancel, back, or close. */
	private exitControl(hint: KeyHint | undefined, actions: readonly Action[]): Control {
		const cancel = actions.find((action) => action.key === "escape");
		const mounted = this.active ? this.mounted.get(this.active) : undefined;
		const nested = (mounted?.layers.length ?? 0) > 1;
		const label = hint?.label ?? (cancel ? actionLabel(cancel) : nested ? "back" : (this.options.closeLabel ?? "close"));
		return { id: "\u0000exit", keys: ["escape"], label, priority: 0, run: () => this.sendKey("escape") };
	}

	/** Footer controls for the current focus: the view's keys, its keyed actions, frame controls, then the way out. */
	private footerControls(): { controls: Control[]; menu: Control[] } {
		const send = (key: string) => this.sendKey(key);
		if (this.bar.menuShown) return { controls: Footer.menuControls(this.bar, send), menu: [] };
		if (this.zone === "tabs") return { controls: this.tabControls(send), menu: [] };
		const hints = this.hints();
		const escapeHint = hints.find((hint) => hint.keys.includes("escape"));
		const controls: Control[] = hints
			.filter((hint) => hint !== escapeHint)
			.map((hint, index) => ({ id: `\u0000key${index}`, keys: hint.keys, label: hint.label, priority: hint.priority ?? (index === 0 ? 0 : 2), run: send }));
		const actions = this.actions();
		// A focused text field takes every key but Escape, Tab and the frame's chords, so the row then
		// shows only the view's own keys: action keys and More would be text.
		const menu = this.editing ? [] : this.actionControls(actions, controls, hints);
		for (const action of this.options.controls?.() ?? []) {
			const control = actionControl(action, (id) => this.invokeFrame(id), 3);
			if (control) controls.push(control);
		}
		controls.push(this.exitControl(escapeHint, actions));
		return { controls, menu };
	}

	/**
	 * Primary keyed actions join the row; every other action is listed in More. A key the view's
	 * current hints already claims belongs to the view, so that action lists in More without the
	 * key: one key never means two things in one focus. Returns the More entries.
	 */
	private actionControls(actions: readonly Action[], controls: Control[], hints: readonly KeyHint[]): Control[] {
		const menu: Control[] = [];
		const invoke = (id: string) => this.invoke(id);
		const claimed = (key: string | undefined) => key !== undefined && key !== "escape" && hints.some((hint) => hint.keys.includes(key));
		for (const action of actions) {
			if (action.key === "escape") continue;
			const control = !claimed(action.key) && action.primary ? actionControl(action, invoke) : undefined;
			if (control) controls.push(control);
			else menu.push(claimed(action.key) ? { ...menuControl(action, invoke), keys: [] } : menuControl(action, invoke));
		}
		return menu;
	}

	private tabControls(send: (key: string) => void): Control[] {
		return [
			{ id: "tabs-move", keys: ["left", "right"], label: "choose", priority: 0, run: send },
			{ id: "tabs-open", keys: ["enter"], label: "open", priority: 0, run: send },
			{ id: "\u0000exit", keys: ["escape"], label: "back", priority: 0, run: send },
		];
	}

	/** Draw the key footer row at `y` and register its targets in `hits` (the host's map when embedded). */
	renderFooter(width: number, hits: HitMap, y: number, x0 = 0): string {
		const { controls, menu } = this.footerControls();
		return this.bar.render(controls, width, this.options.theme, hits, y, x0, menu, this.editing);
	}

	render(width: number): string[] {
		const height = Math.max(4, Math.floor(this.options.rows()));
		const theme = this.options.theme;
		this.size = { width, height };
		this.hits.begin(width, height);
		const header = this.renderHeader(width);
		const mounted = this.active ? this.mounted.get(this.active) : undefined;
		const crumb = mounted ? this.renderCrumb(width, mounted) : undefined;
		this.bodyY = crumb ? 2 : 1;
		const notice = this.noticeText(mounted);
		const footerRows = this.options.footer === false ? 0 : 1;
		const bodyHeight = Math.max(1, height - this.bodyY - footerRows - (notice ? 1 : 0));
		this.bodyHeight = bodyHeight;
		const body = this.renderBody(width, bodyHeight);
		// The view has laid itself out for this size, so its keys are current; the footer row then
		// decides what the More menu lists, so it is laid out before the menu.
		const footer = footerRows ? this.renderFooter(width, this.hits, height - 1) : undefined;
		if (this.bar.menuShown) {
			const menuHits = new HitMap();
			menuHits.begin(width, height);
			const menuRows = Math.min(bodyHeight, Math.max(2, this.bar.menuRows));
			const menu = this.bar.renderMenu(width, menuRows, theme, menuHits, this.bodyY + bodyHeight - menuRows);
			body.splice(bodyHeight - menu.length, menu.length, ...menu.map((line) => fitLine(line, width)));
			this.hits.include(menuHits, 0, 0);
		}
		return [header, ...(crumb ? [crumb] : []), ...body, ...(notice ? [fitLine(notice, width)] : []), ...(footer === undefined ? [] : [footer])].slice(0, height);
	}

	/** The view's rows; a view that fails while drawing is replaced by its failure, at the same size. */
	private renderBody(width: number, height: number): string[] {
		const layer = this.top();
		let body: string[] = [];
		if (layer) {
			layer.view.focused = this.focused && this.zone === "view" && !this.bar.menuShown;
			try {
				body = layer.view.render(width, height);
			} catch (error) {
				this.fail(error);
				body = this.top()?.view.render(width, height) ?? [];
			}
		} else body = [this.options.theme.fg("muted", "Nothing to show here.")];
		return Array.from({ length: height }, (_, row) => fitLine(body[row] ?? "", width));
	}

	private tabInput(data: string): void {
		const keys = this.options.destinations().map((destination) => destination.key);
		const index = Math.max(0, keys.indexOf(this.tabFocus ?? this.active ?? ""));
		if (matchesKey(data, "left") || matchesKey(data, "right")) this.tabFocus = keys[Math.max(0, Math.min(keys.length - 1, index + (matchesKey(data, "left") ? -1 : 1)))];
		else if (matchesKey(data, "enter") && this.tabFocus) this.navigate(this.tabFocus);
	}

	/**
	 * Move focus one step inside a frame embedded in a larger view: through the view's regions, then
	 * the destination row when it offers a choice. Returns false at the frame's edge so the embedding
	 * view moves focus on.
	 */
	focusNext(backward: boolean): boolean {
		this.bar.closeMenu();
		const view = this.top()?.view;
		if (this.zone === "tabs") {
			this.zone = "view";
			if (!backward) return false;
			view?.focusEdge?.(true);
			return true;
		}
		if (view?.focusNext?.(backward)) return true;
		if (backward || !this.offersDestinations()) return false;
		this.zone = "tabs";
		this.tabFocus = this.active;
		return true;
	}

	/**
	 * Focus enters an embedded frame: the view's first region, or going backward the destination row
	 * when it offers a choice, else the view's last region.
	 */
	focusEdge(backward: boolean): void {
		this.bar.closeMenu();
		if (backward && this.offersDestinations()) {
			this.zone = "tabs";
			this.tabFocus = this.active;
			return;
		}
		this.zone = "view";
		this.top()?.view.focusEdge?.(backward);
	}

	/** An embedded frame gives its destination row to the keyboard only when there is another destination to choose. */
	private offersDestinations(): boolean {
		return this.options.tabs !== false && this.options.destinations().length > 1;
	}

	/** Tab moves through the view's regions, then the destination row when the frame shows tabs. */
	private traverse(backward: boolean): void {
		const view = this.top()?.view;
		this.bar.closeMenu();
		if (this.zone === "view" && view?.focusNext?.(backward)) return;
		if (this.options.tabs === false || this.zone === "tabs") {
			this.zone = "view";
			view?.focusEdge?.(backward);
			return;
		}
		this.zone = "tabs";
		this.tabFocus = this.active;
	}

	private escape(): void {
		if (this.bar.menuShown) {
			this.bar.closeMenu();
			return;
		}
		if (this.zone === "tabs") {
			this.zone = "view";
			return;
		}
		const layer = this.top();
		if (layer?.view.escape?.()) return;
		const cancel = this.actions().find((action) => action.key === "escape");
		if (cancel) {
			this.invoke(cancel.id);
			return;
		}
		const mounted = this.active ? this.mounted.get(this.active) : undefined;
		if (mounted && layer && mounted.layers.length > 1) this.leave(mounted.destination.key, layer.controller);
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
		else if (this.zone === "tabs") this.tabInput(data);
		else if (keyMatches(data, MORE_CHORD) && this.bar.hasMore) this.bar.toggleMenu();
		else if (!this.frameKey(data)) this.viewInput(data);
	}

	/** Frame controls such as Expand act from every focus; their keys are chords, never text. */
	private frameKey(data: string): boolean {
		const control = (this.options.controls?.() ?? []).find((action) => action.key && keyMatches(data, action.key));
		if (!control) return false;
		this.invokeFrame(control.id);
		return true;
	}

	/**
	 * While a text field has focus the view takes every key, so letters stay text and the footer
	 * lists no action keys. Otherwise a key of the view's current hints is the view's binding and
	 * never reaches an owner action; only unclaimed keys run actions, open More, or reach the view.
	 */
	private viewInput(data: string): void {
		const view = this.top()?.view;
		if (!view) return;
		try {
			if (view.editing?.() || this.hintKey(data)) view.handleInput(data);
			else if (this.actionKey(data)) return;
			else if (keyMatches(data, MORE_KEY) && this.bar.hasMore) this.bar.toggleMenu();
			else view.handleInput(data);
		} catch (error) {
			this.fail(error);
		}
	}

	/** True when one of the view's current hints claims this key: that key is the view's binding. */
	private hintKey(data: string): boolean {
		return this.hints().some((hint) => hint.keys.some((key) => keyMatches(data, key)));
	}

	private actionKey(data: string): boolean {
		const action = this.actions().find((candidate) => candidate.key !== undefined && candidate.key !== "escape" && keyMatches(data, candidate.key));
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
		const layer = this.top();
		if (!layer?.view.handleMouse || event.y < this.bodyY || event.y >= this.bodyY + this.bodyHeight) return undefined;
		try {
			const result = layer.view.handleMouse({ ...event, y: event.y - this.bodyY, height: this.bodyHeight });
			if (result) {
				this.zone = "view";
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
		for (const mounted of this.mounted.values()) for (const layer of mounted.layers) layer.view.invalidate?.();
	}

	dispose(): void {
		if (this.closed) return;
		this.closed = true;
		for (const mounted of this.mounted.values()) for (const layer of mounted.layers.splice(0).reverse()) this.disposeLayer(layer);
		this.mounted.clear();
	}
}
