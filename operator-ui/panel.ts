import type { JsonValue, OperatorView, ViewHost } from "./view.ts";

/** The host of a native panel: the common view host plus one owner request route. */
export interface PanelHost extends ViewHost {
	/**
	 * One owner request through the panel's bound command, to the conversation captured when the
	 * panel opened. Rejects after the view closed or the target changed; aborting `signal`, or
	 * leaving the view, withdraws the wait. An admitted request is never resent.
	 */
	request(data: JsonValue, signal?: AbortSignal): Promise<{ text: string; data?: JsonValue }>;
}

/** A pure presentation module an owner advertises for native hosts. */
export interface OperatorPanelModule {
	readonly version: 2;
	/** Short destination label, plain text. */
	readonly title: string;
	open(host: PanelHost): OperatorView;
}

/** Accept a module export only in the current shape; any other value is refused, never adapted. */
export function readPanelModule(exported: unknown): OperatorPanelModule {
	if (typeof exported !== "function") throw new Error("operatorPanel is not a function");
	const module: unknown = exported();
	if (typeof module !== "object" || module === null) throw new Error("operatorPanel returned no module");
	const candidate = module as Partial<OperatorPanelModule>;
	if (candidate.version !== 2) throw new Error(`unsupported panel module version ${String(candidate.version)}`);
	if (typeof candidate.title !== "string" || !candidate.title.trim()) throw new Error("panel module has no title");
	if (typeof candidate.open !== "function") throw new Error("panel module has no open function");
	return candidate as OperatorPanelModule;
}
