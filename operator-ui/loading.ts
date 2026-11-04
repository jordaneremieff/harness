import type { TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";
import { plainLine } from "./text.ts";
import type { Action, OperatorView, ViewHost } from "./view.ts";

/**
 * A view whose content needs one read first, for example a form that lists a host's models.
 * Paint performs no read: the read starts once, and its result builds the view. A failure shows
 * the reason in place; leaving the view abandons a late answer.
 */
export class LoadingView implements OperatorView {
	readonly title: string;
	focused = false;
	private inner?: OperatorView;
	private error?: string;
	private readonly host: ViewHost;

	constructor(title: string, host: ViewHost, load: () => Promise<OperatorView>) {
		this.title = title;
		this.host = host;
		load().then(
			(view) => {
				if (host.signal.aborted) return view.dispose?.();
				this.inner = view;
				view.focusEdge?.(false);
				host.requestRender();
			},
			(error: unknown) => {
				if (host.signal.aborted) return;
				this.error = plainLine(error instanceof Error ? error.message : String(error));
				host.requestRender();
			},
		);
	}

	render(width: number, height: number): string[] {
		if (this.inner) {
			this.inner.focused = this.focused;
			return this.inner.render(width, height);
		}
		const theme = this.host.theme;
		const lines = this.error ? [theme.fg("error", `Could not read what this view needs: ${this.error}`), theme.fg("muted", "Back returns; open it again to retry.")] : [theme.fg("muted", "Reading…")];
		return Array.from({ length: height }, (_, row) => lines[row] ?? "");
	}
	handleInput(data: string): boolean {
		return this.inner?.handleInput(data) ?? false;
	}
	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		return this.inner?.handleMouse?.(event);
	}
	actions(): readonly Action[] {
		return this.inner?.actions?.() ?? [];
	}
	escape(): boolean {
		return this.inner?.escape?.() ?? false;
	}
	focusNext(backward: boolean): boolean {
		return this.inner?.focusNext?.(backward) ?? false;
	}
	focusEdge(backward: boolean): void {
		this.inner?.focusEdge?.(backward);
	}
	invalidate(): void {
		this.inner?.invalidate?.();
	}
	dispose(): void {
		this.inner?.dispose?.();
	}
}
