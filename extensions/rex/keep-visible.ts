import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { RexSettings } from "./settings.ts";
import { CliTransport, type CliResult, type RexTransport } from "./transport.ts";

type Settings = Pick<RexSettings, "executable" | "maxOutputBytes" | "maxWaitMs">;
type Rect = [number, number, number, number];
type Direction = "horizontal" | "vertical";

/** Share of the conversation pane that a floating pane must cover before it moves. */
export const MIN_COVERED_SHARE = 0.05;
/** Largest difference, in window fractions, between creation bounds and current bounds that counts as unchanged. */
const BOUNDS_TOLERANCE = 0.01;
const MAX_PENDING = 64;
/** Failed moves after which a pane stays where it is. */
export const MAX_FAILED_MOVES = 3;

/** A floating pane that this conversation created, with the bounds that the creation requested. */
export interface FloatedPane {
	blockId: string;
	bounds?: readonly number[];
}

/**
 * What one view shows about a pane that this conversation created:
 * - `covering`: it floats unchanged in front of the conversation and covers at least the minimum share;
 * - `focused`: it has the focus of its window, so somebody works in it, and it waits for a later moment;
 * - `clear`: it floats unchanged but leaves the conversation visible, so it stays where it is;
 * - `arranged`: it was moved, resized, tiled or taken to another window, so it stays where it is;
 * - `missing`: it no longer exists.
 */
export type PaneState =
	| { kind: "covering"; share: number }
	| { kind: "focused" | "clear" | "arranged" | "missing" };

/** The conversation's window as one view shows it, while the window's arrangement allows a move. */
export interface ConversationWindow {
	/** The block with the focus of the window, when the view names one. */
	focus?: string;
	/** The conversation's rectangle in window fractions. */
	pane: Rect;
	layers: unknown[];
	/** Blocks of the window's tiled layer. */
	tiled: ReadonlySet<string>;
}

export interface ConversationKeeper {
	start(ctx: ExtensionContext): void;
	/** Floating panes that this conversation created; each waits for a moment that needs the operator. */
	floated(panes: readonly FloatedPane[]): void;
	/** A moment that needs the operator: the run ended with an answer or an error, or a dialog waits. */
	attention(ctx: ExtensionContext): void;
	idle(): Promise<void>;
	shutdown(): Promise<void>;
}

export interface ConversationKeeperOptions {
	settings: Settings;
	env?: NodeJS.ProcessEnv;
	pid?: number;
	createTransport?: () => RexTransport;
}

function object(value: unknown): Record<string, unknown> {
	return value !== null && typeof value === "object" ? value as Record<string, unknown> : {};
}

function rect(value: unknown): Rect | undefined {
	if (!Array.isArray(value) || value.length !== 4 || !value.every((n) => typeof n === "number" && Number.isFinite(n))) return undefined;
	return value.map((n: number) => Math.min(1, Math.max(0, n))) as Rect;
}

function leaves(layout: unknown): { blockId: string; rect: Rect }[] {
	const found: { blockId: string; rect: Rect }[] = [];
	const pending = [layout];
	while (pending.length && found.length < 256) {
		const node = object(pending.pop());
		const bounds = rect(node.rect);
		if (typeof node.block_id === "string" && bounds) found.push({ blockId: node.block_id, rect: bounds });
		const split = object(node.split);
		if (split.before) pending.push(split.before);
		if (split.after) pending.push(split.after);
	}
	return found;
}

function overlap(a: Rect, b: Rect): number {
	const width = Math.min(a[0] + a[2], b[0] + b[2]) - Math.max(a[0], b[0]);
	const height = Math.min(a[1] + a[3], b[1] + b[3]) - Math.max(a[1], b[1]);
	return width > 0 && height > 0 ? width * height : 0;
}

function windows(view: unknown): Record<string, unknown>[] {
	const list = object(view).windows;
	return Array.isArray(list) ? list.map(object) : [];
}

function layersOf(window: Record<string, unknown>): unknown[] {
	return Array.isArray(window.layers) ? window.layers : [];
}

function holds(window: Record<string, unknown>, blockId: string): boolean {
	return layersOf(window).some((layer) => leaves(object(layer).layout).some((leaf) => leaf.blockId === blockId));
}

/**
 * The conversation's window when a move may happen there. Undefined when the view does not hold the
 * conversation, when any block of its window is zoomed (a move ends every zoom in the window), and when
 * the conversation is not in the window's tiled layer: then the operator's arrangement decides what shows.
 */
export function conversationWindow(view: unknown, conversationBlockId: string): ConversationWindow | undefined {
	const window = windows(view).find((candidate) => holds(candidate, conversationBlockId));
	if (!window || (typeof window.zoomed_block_id === "string" && window.zoomed_block_id)) return undefined;
	const layers = layersOf(window);
	const tiledLayer = layers.map(object).find((layer) => layer.kind === "tiled");
	const tiled = leaves(tiledLayer?.layout);
	const pane = tiled.find((leaf) => leaf.blockId === conversationBlockId)?.rect;
	if (!pane || pane[2] <= 0 || pane[3] <= 0) return undefined;
	return {
		...(typeof window.focused_block_id === "string" ? { focus: window.focused_block_id } : {}),
		pane,
		layers,
		tiled: new Set(tiled.map((leaf) => leaf.blockId)),
	};
}

/** True when the layer still has the bounds that its creation requested, so nobody has moved or resized it. */
function unchanged(layer: Record<string, unknown>, created: readonly number[] | undefined): boolean {
	if (created === undefined) return true;
	const current = rect(layer.bounds);
	return current !== undefined && created.length === 4 && current.every((value, index) => Math.abs(value - (created[index] ?? Number.NaN)) <= BOUNDS_TOLERANCE);
}

/** The state of one pane that this conversation created, from one view of the conversation's window. */
export function paneState(view: unknown, window: ConversationWindow, blockId: string, created: readonly number[] | undefined): PaneState {
	if (window.tiled.has(blockId)) return { kind: "arranged" };
	for (const value of window.layers) {
		const layer = object(value);
		if (layer.kind === "tiled") continue;
		const leaf = leaves(layer.layout).find((candidate) => candidate.blockId === blockId);
		if (!leaf) continue;
		// A layer kind other than floating is a presentation that this extension does not know, so it stays.
		if (layer.kind !== "floating" || !unchanged(layer, created)) return { kind: "arranged" };
		if (window.focus === blockId) return { kind: "focused" };
		const share = overlap(window.pane, leaf.rect) / (window.pane[2] * window.pane[3]);
		return share >= MIN_COVERED_SHARE ? { kind: "covering", share } : { kind: "clear" };
	}
	return windows(view).some((other) => holds(other, blockId)) ? { kind: "arranged" } : { kind: "missing" };
}

/** Side by side when the conversation's pixels are at least as wide as tall, otherwise one above the other. */
export function dockDirection(size: unknown): Direction {
	const terminal = object(size);
	const width = Number(terminal.columns) * Number(terminal.cell_width_px);
	const height = Number(terminal.rows) * Number(terminal.cell_height_px);
	return Number.isFinite(width) && Number.isFinite(height) && height > width ? "vertical" : "horizontal";
}

function textOf(content: unknown): boolean {
	return Array.isArray(content) && content.some((part) => {
		const value = object(part);
		return value.type === "text" && typeof value.text === "string" && value.text.trim().length > 0;
	});
}

/**
 * Whether a settled run left something for the operator: its last model message is an answer with text
 * or an error. A run that ended in a tool call, such as a quiet state note, or that was aborted, did not.
 */
export function runAnswered(branch: readonly unknown[], aborted: boolean): boolean {
	if (aborted) return false;
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = object(branch[index]);
		if (entry.type !== "message") continue;
		const message = object(entry.message);
		if (message.role === "assistant") return message.stopReason === "error" || (message.stopReason !== "aborted" && textOf(message.content));
		if (message.role === "user" || message.role === "toolResult") return false;
	}
	return false;
}

export function createConversationKeeper(options: ConversationKeeperOptions): ConversationKeeper {
	return new Keeper(options);
}

class CliCallError extends Error {}

interface Waiting {
	bounds?: readonly number[];
	failures: number;
}

/** One move request: the pane, and the anchor and direction that placed it. */
interface Attempt {
	paneId: string;
	anchor: string;
	direction: Direction;
}

class Keeper implements ConversationKeeper {
	private readonly env: NodeJS.ProcessEnv;
	private readonly pid: number;
	private readonly createTransport: () => RexTransport;
	private readonly pending = new Map<string, Waiting>();
	/** The last pane that this keeper docked, and the direction in which later panes stack beside it. */
	private docked: { blockId: string; direction: Direction } | undefined;
	private active = false;
	private ctx: ExtensionContext | undefined;
	private controller: AbortController | undefined;
	private transport: RexTransport | undefined;
	private running: Promise<void> | undefined;
	private requested = false;
	private warned = false;
	private readonly options: ConversationKeeperOptions;

	constructor(options: ConversationKeeperOptions) {
		this.options = options;
		this.env = options.env ?? process.env;
		this.pid = options.pid ?? process.pid;
		this.createTransport = options.createTransport ?? (() => new CliTransport(options.settings.executable, this.env));
	}

	start(ctx: ExtensionContext): void {
		this.stop();
		this.active = true;
		this.ctx = ctx;
		this.controller = new AbortController();
		this.transport = this.createTransport();
	}

	floated(panes: readonly FloatedPane[]): void {
		if (!this.active) return;
		for (const pane of panes) {
			if (this.pending.size >= MAX_PENDING) break;
			this.pending.set(pane.blockId, { ...(pane.bounds ? { bounds: pane.bounds } : {}), failures: 0 });
		}
	}

	attention(ctx: ExtensionContext): void {
		if (!this.active || this.pending.size === 0) return;
		this.ctx = ctx;
		this.requested = true;
		if (!this.running) this.running = this.pump().finally(() => { this.running = undefined; });
	}

	async idle(): Promise<void> {
		while (this.running) await this.running;
	}

	async shutdown(): Promise<void> {
		const running = this.running;
		this.stop();
		await running?.catch(() => undefined);
	}

	private stop(): void {
		this.active = false;
		this.controller?.abort();
		this.transport?.dispose();
		this.controller = undefined;
		this.transport = undefined;
		this.pending.clear();
		this.docked = undefined;
		this.requested = false;
	}

	private async pump(): Promise<void> {
		while (this.requested && this.active) {
			this.requested = false;
			const controller = this.controller;
			const transport = this.transport;
			const ctx = this.ctx;
			if (!controller || !transport || !ctx) return;
			try {
				await this.place(ctx, transport, controller.signal);
			} catch (error) {
				// A failed read changes nothing, so every pane keeps waiting for a later moment.
				if (!controller.signal.aborted) this.warn(ctx, error);
			}
		}
	}

	/**
	 * Moves the waiting panes that cover the conversation, one at a time. Each move follows its own view of
	 * the window with no other request between them, and a pane is decided only from the latest view: Rex
	 * offers no conditional move, so an arrangement that changes between that view and the move can still
	 * lose to the move. A change of the window's focus during the decision stops it.
	 */
	private async place(ctx: ExtensionContext, transport: RexTransport, signal: AbortSignal): Promise<void> {
		const sessionId = this.env.REX_SESSION;
		const blockId = this.env.REX_BLOCK;
		if (ctx.mode !== "tui" || !sessionId || !blockId) return;
		const block = { session_id: sessionId, block_id: blockId, args: {} };
		const processes = object(await this.api(ctx, transport, signal, "com.superlogical.terminal.process", block));
		if (object(processes.foreground).pid !== this.pid) return;
		const size = await this.api(ctx, transport, signal, "com.superlogical.terminal.size", block);
		const attempted = new Set<string>();
		let focus: string | undefined;
		let unconfirmed: Attempt | undefined;
		for (let first = true; ; first = false) {
			const view = await this.api(ctx, transport, signal, "session.view", { session_id: sessionId });
			const window = conversationWindow(view, blockId);
			if (!window || (!first && window.focus !== focus)) return;
			focus = window.focus;
			if (unconfirmed) this.reconcile(unconfirmed, blockId, window);
			unconfirmed = undefined;
			const next = this.next(view, window, attempted);
			if (next === undefined) return;
			attempted.add(next);
			const attempt = { paneId: next, ...this.placement(blockId, size, window) };
			const response = await this.call(ctx, transport, signal, "session.move_block", { session_id: sessionId, block_id: next, anchor_block_id: attempt.anchor, direction: attempt.direction, side: "after", ratio: 0.5 });
			if (succeeded(response)) this.dock(blockId, attempt);
			else {
				this.warn(ctx, new CliCallError(cliError("session.move_block", response)));
				unconfirmed = attempt;
			}
		}
	}

	/** Settles the waiting panes that this view decides, and returns the first covering pane not yet attempted. */
	private next(view: unknown, window: ConversationWindow, attempted: ReadonlySet<string>): string | undefined {
		let next: string | undefined;
		for (const [paneId, waiting] of [...this.pending]) {
			const state = paneState(view, window, paneId, waiting.bounds);
			if (state.kind === "covering") next ??= attempted.has(paneId) ? undefined : paneId;
			else if (state.kind !== "focused") this.pending.delete(paneId);
		}
		return next;
	}

	/** A move that failed or got no answer counts as made only when the new view shows the pane tiled. */
	private reconcile(attempt: Attempt, conversationBlockId: string, window: ConversationWindow): void {
		if (window.tiled.has(attempt.paneId)) {
			this.dock(conversationBlockId, attempt);
			return;
		}
		const waiting = this.pending.get(attempt.paneId);
		if (waiting && ++waiting.failures >= MAX_FAILED_MOVES) this.pending.delete(attempt.paneId);
	}

	/** Beside the pane that this keeper docked last when it is still tiled here, otherwise beside the conversation. */
	private placement(conversationBlockId: string, size: unknown, window: ConversationWindow): { anchor: string; direction: Direction } {
		if (this.docked && window.tiled.has(this.docked.blockId)) return { anchor: this.docked.blockId, direction: this.docked.direction };
		return { anchor: conversationBlockId, direction: dockDirection(size) };
	}

	/** Records a docked pane; later panes stack in its space, so the conversation keeps its share. */
	private dock(conversationBlockId: string, attempt: Attempt): void {
		this.pending.delete(attempt.paneId);
		const direction = attempt.anchor === conversationBlockId ? (attempt.direction === "horizontal" ? "vertical" : "horizontal") : attempt.direction;
		this.docked = { blockId: attempt.paneId, direction };
	}

	private call(ctx: ExtensionContext, transport: RexTransport, signal: AbortSignal, method: string, args: Record<string, unknown>): Promise<CliResult> {
		signal.throwIfAborted();
		const prefix = ["--autostart=false", "--color=never", "--timeout=10s", ...(this.env.REX_SERVER ? ["--server", this.env.REX_SERVER] : [])];
		return transport.run([...prefix, "api", "call", method, JSON.stringify(args)], {
			cwd: ctx.cwd,
			signal,
			timeoutMs: this.options.settings.maxWaitMs,
			maxOutputBytes: this.options.settings.maxOutputBytes,
		});
	}

	private async api(ctx: ExtensionContext, transport: RexTransport, signal: AbortSignal, method: string, args: Record<string, unknown>): Promise<unknown> {
		const response = await this.call(ctx, transport, signal, method, args);
		if (!succeeded(response)) throw new CliCallError(cliError(method, response));
		try {
			return JSON.parse(response.stdout);
		} catch {
			throw new Error(`Rex did not return complete JSON for ${method}.`);
		}
	}

	private warn(ctx: ExtensionContext, error: unknown): void {
		if (this.warned || !ctx.hasUI) return;
		this.warned = true;
		const detail = (error instanceof Error ? error.message : String(error)).replace(/[\p{Cc}\p{Cf}]/gu, " ").replace(/\s+/gu, " ").trim().slice(0, 300);
		ctx.ui.notify(`Rex could not move a floating pane off this conversation: ${detail || "Unknown error"}`, "warning");
	}
}

function succeeded(response: CliResult): boolean {
	return response.outcome === "exited" && response.exitCode === 0 && !response.truncated;
}

function cliError(method: string, response: CliResult): string {
	const stderr = response.stderr.replace(/\s+/gu, " ").trim().slice(0, 200);
	if (response.outcome !== "exited") return `${method}: ${response.outcome}`;
	if (response.truncated) return `${method}: output limit`;
	return `${method}: exit ${response.exitCode}${stderr ? `: ${stderr}` : ""}`;
}
