import type { JsonValue } from "@earendil-works/chord";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";
import { DashboardMouse } from "./dashboard-mouse.ts";
import { fitLine } from "./dashboard-layout.ts";
import type { OperatorPanelHost, OperatorPanelInstance, OperatorPanelModule } from "./panel-modules.ts";

export interface PanelScreenOptions {
	readonly module: OperatorPanelModule;
	readonly title: string;
	readonly target: { readonly id: string; readonly name?: string };
	readonly tui: { requestRender(): void; readonly terminal: { readonly rows: number } };
	readonly theme: Theme;
	readonly dialogs: OperatorPanelHost["dialogs"];
	/** The owner command bound to this panel, against the captured target. */
	request(data: JsonValue, signal: AbortSignal): Promise<{ text: string; data?: JsonValue }>;
	/** The client's way out of the panel. */
	onClose(): void;
	/** The client's way out of the terminal; stays reachable beside Back. */
	detach(): void;
}

/**
 * Generic mount for one owner browser over the attached conversation. The owner module owns the
 * body, its keys and its hit geometry; this screen owns the footer, size, request binding,
 * cancellation and disposal. Requests settle only while the panel is open: a late answer is dropped.
 */
export class PanelScreen {
	readonly title: string;
	private readonly options: PanelScreenOptions;
	private readonly instance: OperatorPanelInstance;
	private readonly hits = new DashboardMouse();
	private readonly outstanding = new Set<AbortController>();
	private closed = false;
	private body = { height: 0, width: 0 };
	constructor(options: PanelScreenOptions) {
		this.options = options;
		this.title = options.title;
		const host: OperatorPanelHost = {
			target: options.target,
			theme: options.theme,
			tui: { requestRender: () => options.tui.requestRender() },
			rows: () => this.rows(),
			request: (data, signal) => this.request(data, signal),
			dialogs: options.dialogs,
			close: () => this.close(),
		};
		this.instance = options.module.open(host);
	}
	private rows(): number { return Math.max(1, this.options.tui.terminal.rows - 1); }
	private async request(data: JsonValue, signal?: AbortSignal): Promise<{ text: string; data?: JsonValue }> {
		if (this.closed) throw new Error("The browser is closed");
		const controller = new AbortController();
		const forward = () => controller.abort(signal?.reason);
		if (signal?.aborted) forward(); else signal?.addEventListener("abort", forward, { once: true });
		this.outstanding.add(controller);
		try {
			const answer = await this.options.request(data, controller.signal);
			if (this.closed) throw new Error("The browser closed before the answer arrived");
			return answer;
		} finally {
			this.outstanding.delete(controller);
			signal?.removeEventListener("abort", forward);
		}
	}
	close(): void {
		if (this.closed) return;
		this.dispose();
		this.options.onClose();
	}
	render(width: number): string[] {
		const rows = this.rows();
		this.hits.reset(width, rows + 1);
		const body = this.closed ? [] : this.instance.render(width).slice(0, rows);
		this.body = { height: body.length, width };
		while (body.length < rows) body.push("");
		const back = "Back"; const detach = "Detach";
		this.hits.add({ x: 0, y: rows, width: visibleWidth(back), height: 1, click: () => this.close() });
		this.hits.add({ x: visibleWidth(back) + 3, y: rows, width: visibleWidth(detach), height: 1, click: () => this.options.detach() });
		return [...body, fitLine(this.options.theme.fg("muted", `${back} · ${detach}`), width)];
	}
	handleInput(data: string): void {
		if (!this.closed) this.instance.handleInput(data);
	}
	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (this.closed) return undefined;
		const footer = this.hits.handle(event);
		if (footer) return footer;
		if (event.y >= this.body.height || event.width !== this.body.width) return undefined;
		return this.instance.handleMouse?.({ ...event, height: this.body.height });
	}
	invalidate(): void {
		this.hits.reset();
		this.instance.invalidate?.();
	}
	dispose(): void {
		if (this.closed) return;
		this.closed = true;
		for (const controller of this.outstanding) controller.abort(new Error("The browser closed"));
		this.outstanding.clear();
		this.instance.dispose();
	}
}
