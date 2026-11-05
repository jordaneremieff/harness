import type { Theme } from "@earendil-works/pi-coding-agent";
import type { TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";

export type NoticeKind = "info" | "success" | "warning" | "error" | "pending";

/** One outcome or state line, shown near the work that produced it. */
export interface Notice {
	readonly text: string;
	readonly kind: NoticeKind;
}

/** The object a view acts on, as the operator recognises it. Exact identities belong in details. */
export interface ViewTarget {
	/** Exact identity of the bound session or conversation. */
	readonly id: string;
	/** Recognisable name, for example "This session · harness" or "Parser review · harness". */
	readonly label: string;
}

/**
 * One operator action. The label names the effect; selection and focus never run it.
 * Every route that invokes it (its key, a click on its footer control, the More menu) calls `run`.
 */
export interface Action {
	readonly id: string;
	readonly label: string;
	readonly description?: string;
	/** Why the action cannot run now. The control stays listed and explains itself. */
	readonly disabled?: string;
	/**
	 * The key that runs this action while no text field has focus: a pi-tui key id such as "enter",
	 * "escape" or "ctrl+o", or one printable character such as "a" or "?". The footer shows it before
	 * the label.
	 */
	readonly key?: string;
	/** Footer wording when the label is long, for example "note" for "Pick up with note…". */
	readonly short?: string;
	/** Shown in the footer while it fits. An action without a key, or one that does not fit, is listed under More. */
	readonly primary?: boolean;
	readonly tone?: "accent" | "danger";
	run(): void;
}

/**
 * A key the focused view handles itself, shown in the footer before the actions. Each key id gets
 * its own click target, which sends that key, so a click and the key always do the same thing.
 */
export interface KeyHint {
	/** pi-tui key ids or printable characters, for example ["up", "down"] for "↑↓ select". */
	readonly keys: readonly string[];
	readonly label: string;
	/**
	 * Lower numbers stay on a short footer row longer; 0 never leaves it. Default: 0 for a view's
	 * first key, 2 for the others. Actions on the selected item have 1.
	 */
	readonly priority?: number;
}

/** What a mounted view receives from the frame that hosts it. */
export interface ViewHost {
	readonly theme: Theme;
	/** The session or conversation every effect of this view is bound to. It never changes. */
	readonly target: ViewTarget;
	/** Aborted when this view is disposed. Reads and requests pass it so late answers are dropped. */
	readonly signal: AbortSignal;
	requestRender(): void;
	/** Show a notice on the frame's outcome line. */
	notify(text: string, kind?: NoticeKind): void;
	/**
	 * Open a nested view (detail, reader, form) above this one. The nested view gets its own host and
	 * signal, aborted when it is left, so its late answers cannot reach the view beneath it.
	 */
	push(open: (host: ViewHost) => OperatorView): void;
	/** Leave this view: a nested view returns to the one beneath it; a destination's root leaves the frame. */
	back(): void;
	/**
	 * Return to the conversation. `then` runs after the frame is gone and the host restored its own
	 * editor, for effects that need it: a command whose own UI opens, or text placed in the editor.
	 */
	close(then?: () => unknown): void;
}

/**
 * A content view inside a frame. It renders exactly the rows it is given and consumes only the
 * keys and pointer events it owns. Focus moves between its regions on Tab; at the last region
 * it returns false so the frame moves focus on.
 */
export interface OperatorView {
	readonly title: string;
	render(width: number, height: number): string[];
	/** Returns true when the key was consumed. */
	handleInput(data: string): boolean;
	handleMouse?(event: TuiMouseEvent): TuiMouseEventResult | undefined;
	/** Actions for the frame's footer and More menu, re-read at every render and every invocation. */
	actions?(): readonly Action[];
	/** The keys this view handles itself in its current focus, for the footer. Read at every render. */
	keys?(): readonly KeyHint[];
	/** True while a text field has focus: printable keys are text, never action keys. */
	editing?(): boolean;
	/** Escape: close a local popup or cancel an edit. Return false to let the frame go back. */
	escape?(): boolean;
	/** Move focus to the next or previous region. Return false at the edge. */
	focusNext?(backward: boolean): boolean;
	/** Focus enters the view from the frame: the first region, or the last when backward. */
	focusEdge?(backward: boolean): void;
	/** True while the frame's focus is inside the view. Views propagate it to text fields. */
	focused?: boolean;
	invalidate?(): void;
	dispose?(): void;
}

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
