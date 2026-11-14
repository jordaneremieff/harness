import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { RexSettings } from "./settings.ts";
import { CliTransport, type CliResult, type RexTransport } from "./transport.ts";

type Settings = Pick<RexSettings, "executable" | "maxOutputBytes" | "maxWaitMs">;
type Rect = [number, number, number, number];

/** Share of the conversation pane that a floating pane must cover before it moves. */
export const MIN_COVERED_SHARE = 0.05;
/** Largest difference, in window fractions, between creation bounds and current bounds that counts as unchanged. */
const BOUNDS_TOLERANCE = 0.01;
const MAX_PENDING = 64;

/** A floating pane that this conversation created, with the bounds that the creation requested. */
export interface FloatedPane {
	blockId: string;
	bounds?: readonly number[];
}

export interface CoveringPane {
	blockId: string;
	/** Fraction of the conversation pane's area that this pane covers. */
	share: number;
}

export interface ConversationKeeper {
	start(ctx: ExtensionContext): void;
	/** Floating panes that this conversation created; each is placed at the next attention moment. */
	floated(panes: readonly FloatedPane[]): void;
	/** The run settled or a dialog waits for the operator. */
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

/** The conversation's tiled pane in this window, `null` when the window's arrangement leaves it alone. */
function conversationPane(window: Record<string, unknown>, layers: unknown[], blockId: string): { index: number; pane: Rect } | null | undefined {
	const index = layers.findIndex((layer) => object(layer).kind === "tiled" && leaves(object(layer).layout).some((leaf) => leaf.blockId === blockId));
	if (index < 0) return layers.some((layer) => leaves(object(layer).layout).some((leaf) => leaf.blockId === blockId)) ? null : undefined;
	// A zoom is the operator's arrangement, and moving a block ends every zoom in its window.
	if (typeof window.zoomed_block_id === "string") return null;
	const pane = leaves(object(layers[index]).layout).find((leaf) => leaf.blockId === blockId)?.rect;
	return pane && pane[2] > 0 && pane[3] > 0 ? { index, pane } : null;
}

/** True when the layer still has the bounds that its creation requested, so nobody has moved or resized it. */
function unchanged(layer: Record<string, unknown>, created: readonly number[] | undefined): boolean {
	if (created === undefined) return true;
	const current = rect(layer.bounds);
	return current !== undefined && created.length === 4 && current.every((value, index) => Math.abs(value - (created[index] ?? Number.NaN)) <= BOUNDS_TOLERANCE);
}

function coveringIn(layers: unknown[], from: number, pane: Rect, candidates: ReadonlyMap<string, readonly number[] | undefined>): CoveringPane[] {
	const area = pane[2] * pane[3];
	const covering: CoveringPane[] = [];
	for (const value of layers.slice(from)) {
		const layer = object(value);
		if (layer.kind === "tiled") continue;
		for (const leaf of leaves(layer.layout)) {
			const share = candidates.has(leaf.blockId) && unchanged(layer, candidates.get(leaf.blockId)) ? overlap(pane, leaf.rect) / area : 0;
			if (share >= MIN_COVERED_SHARE) covering.push({ blockId: leaf.blockId, share });
		}
	}
	return covering;
}

/**
 * The candidate panes in floating layers in front of the conversation pane, with the share of the
 * conversation that each covers. A candidate whose layer no longer has its creation bounds was moved
 * or resized, and stays. Undefined when the conversation is not in a window's tiled layout or a block
 * of that window is zoomed: then the operator's arrangement decides what shows.
 */
export function coveringPanes(view: unknown, conversationBlockId: string, candidates: ReadonlyMap<string, readonly number[] | undefined>): CoveringPane[] | undefined {
	const windows = object(view).windows;
	if (!Array.isArray(windows)) return undefined;
	for (const value of windows) {
		const window = object(value);
		const layers = Array.isArray(window.layers) ? window.layers : [];
		const found = conversationPane(window, layers, conversationBlockId);
		if (found === null) return undefined;
		if (found) return coveringIn(layers, found.index + 1, found.pane, candidates);
	}
	return undefined;
}

/** Side by side when the conversation's pixels are at least as wide as tall, otherwise one above the other. */
export function dockDirection(size: unknown): "horizontal" | "vertical" {
	const terminal = object(size);
	const width = Number(terminal.columns) * Number(terminal.cell_width_px);
	const height = Number(terminal.rows) * Number(terminal.cell_height_px);
	return Number.isFinite(width) && Number.isFinite(height) && height > width ? "vertical" : "horizontal";
}

export function createConversationKeeper(options: ConversationKeeperOptions): ConversationKeeper {
	return new Keeper(options);
}

class CliCallError extends Error {}

class Keeper implements ConversationKeeper {
	private readonly env: NodeJS.ProcessEnv;
	private readonly pid: number;
	private readonly createTransport: () => RexTransport;
	private readonly pending = new Map<string, readonly number[] | undefined>();
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
			this.pending.set(pane.blockId, pane.bounds);
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
		this.requested = false;
	}

	private async pump(): Promise<void> {
		while (this.requested && this.active) {
			this.requested = false;
			const controller = this.controller;
			const transport = this.transport;
			const ctx = this.ctx;
			if (!controller || !transport || !ctx) return;
			// Each floating pane gets one decision: the run that created it ends, or a dialog needs the
			// operator. Later arrangement belongs to the operator.
			const candidates = new Map(this.pending);
			this.pending.clear();
			try {
				await this.place(ctx, transport, controller.signal, candidates);
			} catch (error) {
				if (!controller.signal.aborted) this.warn(ctx, error);
			}
		}
	}

	private async place(ctx: ExtensionContext, transport: RexTransport, signal: AbortSignal, candidates: ReadonlyMap<string, readonly number[] | undefined>): Promise<void> {
		if (ctx.mode !== "tui") return;
		const sessionId = this.env.REX_SESSION;
		const blockId = this.env.REX_BLOCK;
		if (!sessionId || !blockId) return;
		const processes = object(await this.api(ctx, transport, signal, "com.superlogical.terminal.process", { session_id: sessionId, block_id: blockId, args: {} }));
		if (object(processes.foreground).pid !== this.pid) return;
		const view = await this.api(ctx, transport, signal, "session.view", { session_id: sessionId });
		const covering = coveringPanes(view, blockId, candidates);
		if (!covering?.length) return;
		const size = await this.api(ctx, transport, signal, "com.superlogical.terminal.size", { session_id: sessionId, block_id: blockId, args: {} });
		let anchor = blockId;
		let direction = dockDirection(size);
		for (const pane of covering) {
			await this.api(ctx, transport, signal, "session.move_block", { session_id: sessionId, block_id: pane.blockId, anchor_block_id: anchor, direction, side: "after", ratio: 0.5 });
			// Later panes stack in the space of the first one, so the conversation keeps its share.
			if (anchor === blockId) direction = direction === "horizontal" ? "vertical" : "horizontal";
			anchor = pane.blockId;
		}
	}

	private async api(ctx: ExtensionContext, transport: RexTransport, signal: AbortSignal, method: string, args: Record<string, unknown>): Promise<unknown> {
		signal.throwIfAborted();
		const prefix = ["--autostart=false", "--color=never", "--timeout=10s", ...(this.env.REX_SERVER ? ["--server", this.env.REX_SERVER] : [])];
		const response = await transport.run([...prefix, "api", "call", method, JSON.stringify(args)], {
			cwd: ctx.cwd,
			signal,
			timeoutMs: this.options.settings.maxWaitMs,
			maxOutputBytes: this.options.settings.maxOutputBytes,
		});
		if (response.outcome !== "exited" || response.exitCode !== 0 || response.truncated) throw new CliCallError(cliError(method, response));
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

function cliError(method: string, response: CliResult): string {
	const stderr = response.stderr.replace(/\s+/gu, " ").trim().slice(0, 200);
	if (response.outcome !== "exited") return `${method}: ${response.outcome}`;
	if (response.truncated) return `${method}: output limit`;
	return `${method}: exit ${response.exitCode}${stderr ? `: ${stderr}` : ""}`;
}
