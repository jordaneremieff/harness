/**
 * The view shape of the agent work view's inspector and of the owner views it hosts. Owner panel
 * modules return a `View` from `open(host: PanelHost)`, as docs/conventions/operator-panels.md
 * describes; this file states that shape in the agent extension's own terms.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import type { TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";

export type NoticeKind = "info" | "success" | "warning" | "error" | "pending";

/** One outcome or state line, shown near the work that produced it. */
export interface Notice {
	readonly text: string;
	readonly kind: NoticeKind;
}

/** The conversation a view acts on, as the operator recognises it. */
export interface ViewTarget {
	readonly id: string;
	readonly label: string;
}

/**
 * One labelled effect. Selection and focus never run it; its key, a click on its key-row control
 * and its More entry all call `run`.
 */
export interface Action {
	readonly id: string;
	readonly label: string;
	readonly description?: string;
	/** Why the action cannot run now. It stays listed and explains itself. */
	readonly disabled?: string;
	/** A pi-tui key id such as "enter" or "ctrl+o", or one printable character, active while no text field has focus. */
	readonly key?: string;
	/** Key-row wording when the label is long. */
	readonly short?: string;
	/** On the key row while it fits; an action without a key, or one that does not fit, is in More. */
	readonly primary?: boolean;
	readonly tone?: "accent" | "danger";
	run(): void;
}

/** Keys the focused view handles itself, shown before its actions; a click on one sends that key. */
export interface KeyHint {
	readonly keys: readonly string[];
	readonly label: string;
	/** Lower numbers stay on a short row longer; 0 never leaves it. */
	readonly priority?: number;
}

/** What a mounted view receives from the frame that hosts it. */
export interface ViewHost {
	readonly theme: Theme;
	/** The conversation every effect of this view acts on. It never changes. */
	readonly target: ViewTarget;
	/** Aborted when this view is left, so late answers are dropped. */
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
	/** Actions for the key row and More, re-read at every render and every invocation. */
	actions?(): readonly Action[];
	/** The keys the view handles itself in its current focus. */
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

/** The host of an owner view: the view host plus one request through the owner's bound command. */
export interface PanelHost extends ViewHost {
	/**
	 * One request to the conversation captured when the view opened. Aborting `signal`, or leaving
	 * the view, withdraws the wait; an admitted request is never resent.
	 */
	request(data: JsonValue, signal?: AbortSignal): Promise<{ text: string; data?: JsonValue }>;
}

/** The presentation module an owner advertises for native hosts. */
export interface OperatorPanelModule {
	readonly version: 2;
	readonly title: string;
	open(host: PanelHost): View;
}
