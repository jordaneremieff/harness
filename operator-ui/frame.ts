import type { Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, type Component, type Focusable, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";
import { ActionBar, renderTabs } from "./controls.ts";
import { HitMap } from "./hits.ts";
import { fitLine, plainLine, visibleWidth, wrap } from "./text.ts";
import type { Action, Notice, NoticeKind, OperatorView, ViewHost, ViewTarget } from "./view.ts";

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
	/** Frame controls beside the target, for example Expand. */
	controls?(): readonly Action[];
	/** Label of the way out, for example "Close" or "Back to conversation". */
	readonly closeLabel?: string;
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
 * selection and reading position while the frame is open. Escape closes a local popup, then
 * leaves a nested view, then leaves the frame. One destination's failure costs only that view.
 */
export class NavigationFrame implements Component, Focusable {
	focused = true;
	private readonly options: FrameOptions;
	private readonly mounted = new Map<string, Mounted>();
	private readonly hits = new HitMap();
	private readonly bar: ActionBar;
	private active?: string;
	private zone: "view" | "actions" | "tabs" = "view";
	private tabFocus?: string;
	private frameNotice?: Notice;
	private closed = false;
	private bodyY = 1;

	constructor(options: FrameOptions) {
		this.options = options;
		this.bar = new ActionBar((reason) => this.show({ text: reason, kind: "warning" }));
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

	/** The labelled actions of the view the operator reads now, as the action bar offers them. */
	get viewActions(): readonly Action[] {
		return this.actions();
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
			focusActions: () => {
				if (controller.signal.aborted || this.active !== key) return;
				this.zone = "actions";
				this.bar.focusEdge(false);
				this.options.requestRender();
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

	private frameControls(): Action[] {
		const controls = [...(this.options.controls?.() ?? [])];
		controls.push({ id: "close", label: this.options.closeLabel ?? "Close", primary: true, run: () => this.close() });
		return controls;
	}

	private renderHeader(width: number): string {
		const theme = this.options.theme;
		const tabs = this.options.destinations().map((destination) => ({ key: destination.key, label: destination.label, unavailable: destination.unavailable }));
		const controls = this.frameControls();
		const controlText = controls.map((control) => ` ${plainLine(control.label)} `);
		const target = theme.fg("muted", ` ${plainLine(this.options.target.label)} `);
		// The way out and the frame's controls always show; the target label gives way first.
		const separator = theme.fg("borderMuted", "─");
		const fixed = controlText.map((text) => theme.fg("accent", text)).join(separator) + separator;
		const { line, fixedX } = renderTabs(tabs, this.active, this.zone === "tabs" ? this.tabFocus : undefined, width, theme, this.hits, 0, (key) => this.navigate(key), target, fixed);
		let x = fixedX;
		controls.forEach((control, index) => {
			const w = visibleWidth(controlText[index] ?? "");
			if (x + w <= width) this.hits.add({ x, y: 0, width: w, height: 1, click: () => control.run() });
			x += w + 1;
		});
		return line;
	}

	private renderCrumb(width: number, mounted: Mounted): string | undefined {
		if (mounted.layers.length < 2) return undefined;
		const theme = this.options.theme;
		const back = " ‹ Back ";
		const trail = mounted.layers.map((layer) => plainLine(layer.view.title)).join(" › ");
		const top = mounted.layers.at(-1);
		if (top) this.hits.add({ x: 0, y: 1, width: visibleWidth(back), height: 1, click: () => this.leave(mounted.destination.key, top.controller) });
		return fitLine(theme.fg("accent", back) + theme.fg("muted", ` ${trail}`), width);
	}

	private noticeText(mounted: Mounted | undefined): string {
		const notice = mounted?.notice ?? this.frameNotice;
		if (!notice) return "";
		const colour = notice.kind === "error" ? "error" : notice.kind === "warning" ? "warning" : notice.kind === "success" ? "success" : "muted";
		return this.options.theme.fg(colour, plainLine(notice.text));
	}

	render(width: number): string[] {
		const height = Math.max(4, Math.floor(this.options.rows()));
		this.hits.begin(width, height);
		const header = this.renderHeader(width);
		const mounted = this.active ? this.mounted.get(this.active) : undefined;
		const crumb = mounted ? this.renderCrumb(width, mounted) : undefined;
		this.bodyY = crumb ? 2 : 1;
		const bodyHeight = Math.max(1, height - this.bodyY - 1);
		const layer = this.top();
		let body: string[] = [];
		if (layer) {
			layer.view.focused = this.focused && this.zone === "view";
			try {
				body = layer.view.render(width, bodyHeight);
			} catch (error) {
				this.fail(error);
				body = this.top()?.view.render(width, bodyHeight) ?? [];
			}
		} else body = [this.options.theme.fg("muted", "Nothing to show here.")];
		body = Array.from({ length: bodyHeight }, (_, row) => fitLine(body[row] ?? "", width));
		const actions = this.actions();
		if (this.bar.menuShown) {
			const menuHits = new HitMap();
			menuHits.begin(width, height);
			const menuRows = Math.max(2, Math.min(bodyHeight, actions.length + 1));
			const menu = this.bar.renderMenu(actions, width, menuRows, this.options.theme, menuHits, this.bodyY + bodyHeight - menuRows);
			body.splice(bodyHeight - menu.length, menu.length, ...menu.map((line) => fitLine(line, width)));
			this.hits.include(menuHits, 0, 0);
		}
		this.bar.focused = this.focused && this.zone === "actions";
		const bar = this.bar.render(actions, width, this.options.theme, this.hits, height - 1, this.noticeText(mounted));
		return [header, ...(crumb ? [crumb] : []), ...body, bar].slice(0, height);
	}

	private tabInput(data: string): void {
		const keys = this.options.destinations().map((destination) => destination.key);
		const index = Math.max(0, keys.indexOf(this.tabFocus ?? this.active ?? ""));
		if (matchesKey(data, "left") || matchesKey(data, "right")) this.tabFocus = keys[Math.max(0, Math.min(keys.length - 1, index + (matchesKey(data, "left") ? -1 : 1)))];
		else if (matchesKey(data, "enter") && this.tabFocus) this.navigate(this.tabFocus);
	}

	/**
	 * Move focus one step inside a frame embedded in a larger view: the view's regions, then the
	 * action bar. Returns false at either edge so the embedding view moves focus on.
	 */
	focusNext(backward: boolean): boolean {
		const view = this.top()?.view;
		this.bar.closeMenu();
		if (this.zone === "view") {
			if (view?.focusNext?.(backward)) return true;
			if (backward) return false;
			this.zone = "actions";
			this.bar.focusEdge(false);
			return true;
		}
		if (this.zone === "actions" && !backward) return false;
		this.zone = "view";
		view?.focusEdge?.(true);
		return true;
	}

	/** Focus enters an embedded frame: the view's first region, or the action bar going backward. */
	focusEdge(backward: boolean): void {
		this.bar.closeMenu();
		if (backward) {
			this.zone = "actions";
			this.bar.focusEdge(true);
		} else {
			this.zone = "view";
			this.top()?.view.focusEdge?.(false);
		}
	}

	/** Tab moves through the view's regions, then the action bar, then the destination row. */
	private traverse(backward: boolean): void {
		const view = this.top()?.view;
		this.bar.closeMenu();
		if (this.zone === "view" && view?.focusNext?.(backward)) return;
		const ring = ["view", "actions", "tabs"] as const;
		const next = ring[(ring.indexOf(this.zone) + (backward ? ring.length - 1 : 1)) % ring.length] ?? "view";
		this.zone = next;
		if (next === "actions") this.bar.focusEdge(backward);
		else if (next === "tabs") this.tabFocus = this.active;
		else view?.focusEdge?.(backward);
	}

	private escape(): void {
		if (this.bar.menuShown) {
			this.bar.closeMenu();
			return;
		}
		const layer = this.top();
		if (layer && this.zone === "view" && layer.view.escape?.()) return;
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
		else if (this.bar.menuShown) this.bar.handleInput(data, this.actions());
		else if (matchesKey(data, "tab") || matchesKey(data, "shift+tab")) this.traverse(matchesKey(data, "shift+tab"));
		else if (this.zone === "tabs") this.tabInput(data);
		else if (this.zone === "view") this.viewInput(data);
		else if (!this.bar.handleInput(data, this.actions()) && (matchesKey(data, "up") || matchesKey(data, "down"))) this.zone = "view";
	}

	private viewInput(data: string): void {
		const view = this.top()?.view;
		if (!view) return;
		let consumed = false;
		try {
			consumed = view.handleInput(data);
		} catch (error) {
			this.fail(error);
			return;
		}
		if (!consumed && matchesKey(data, "enter")) {
			this.zone = "actions";
			this.bar.focusEdge(false);
		}
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (this.closed) return undefined;
		const own = this.hits.handle(event);
		if (own) {
			this.options.requestRender();
			return own;
		}
		const layer = this.top();
		if (!layer?.view.handleMouse || event.y < this.bodyY || event.y >= event.height - 1) return undefined;
		try {
			const result = layer.view.handleMouse({ ...event, y: event.y - this.bodyY, height: Math.max(1, event.height - this.bodyY - 1) });
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
