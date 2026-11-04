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
	/** The client's current notice; the panel shows it on its own row above the footer. */
	notice?(): string;
	/** The client's way out of the panel. */
	onClose(): void;
	/** The client's way out of the terminal; stays reachable beside Back. */
	detach(): void;
}

/** Settle with the request, or with a refusal as soon as the signal withdraws it. */
function withdrawable<T>(request: Promise<T>, signal: AbortSignal): Promise<T> {
	if (signal.aborted) {
		request.catch(() => {});
		return Promise.reject(new Error("The browser closed before the answer arrived", { cause: signal.reason }));
	}
	return new Promise<T>((resolve, reject) => {
		const withdraw = () => reject(new Error("The browser closed before the answer arrived", { cause: signal.reason }));
		signal.addEventListener("abort", withdraw, { once: true });
		request.then(
			(value) => { signal.removeEventListener("abort", withdraw); resolve(value); },
			(error: unknown) => { signal.removeEventListener("abort", withdraw); reject(error); },
		);
	});
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
	/** Rows the owner body gets: the terminal minus the footer, and minus the notice row while one shows. */
	private rows(): number { return Math.max(1, this.options.tui.terminal.rows - 1 - (this.options.notice?.() ? 1 : 0)); }
	/**
	 * One owner request. Closing the browser or the owner's own signal withdraws it: the request settles
	 * at once with a refusal and a later answer is dropped. The withdrawal travels with the request to the
	 * host connection; work the host already admitted still runs and is never replayed.
	 */
	private async request(data: JsonValue, signal?: AbortSignal): Promise<{ text: string; data?: JsonValue }> {
		if (this.closed) throw new Error("The browser is closed");
		const controller = new AbortController();
		const forward = () => controller.abort(signal?.reason);
		if (signal?.aborted) forward(); else signal?.addEventListener("abort", forward, { once: true });
		this.outstanding.add(controller);
		try {
			const answer = await withdrawable(this.options.request(data, controller.signal), controller.signal);
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
		const notice = this.options.notice?.() ?? "";
		const rows = this.rows();
		this.hits.reset(width, rows + (notice ? 2 : 1));
		const body = this.closed ? [] : this.instance.render(width).slice(0, rows);
		this.body = { height: body.length, width };
		while (body.length < rows) body.push("");
		const footerY = rows + (notice ? 1 : 0);
		const back = "Back"; const detach = "Detach";
		this.hits.add({ x: 0, y: footerY, width: visibleWidth(back), height: 1, click: () => this.close() });
		this.hits.add({ x: visibleWidth(back) + 3, y: footerY, width: visibleWidth(detach), height: 1, click: () => this.options.detach() });
		return [...body, ...(notice ? [fitLine(notice, width)] : []), fitLine(this.options.theme.fg("muted", `${back} · ${detach}`), width)];
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
