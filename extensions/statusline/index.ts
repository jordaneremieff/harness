/**
 * Statusline: a quiet two-line session footer.
 *
 * Line 1: provider/model [<level>] (<outcome>) │ context bar │ tokens │ cost │ duration │ cache telemetry
 * Line 2: folder (branch) │ extension statuses │ +N
 *
 * The footer carries status only; it adds no navigation labels. In fullscreen the model, the
 * level and the +N cell are click targets for the Model and Statuses views; regular mode leaves
 * the mouse to the terminal. Commands, Model and Statuses open independently in the editor slot.
 * Installed only in TUI mode; setFooter is a documented no-op elsewhere. One unref'd 5s tick owns wall-clock
 * freshness for duration while idle.
 */

import type {
	ExtensionAPI,
	ExtensionContext,
	ReadonlyFooterDataProvider,
	ThemeColor,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";
import {
	buildBar,
	composeLine1,
	composeLine2,
	formatDuration,
	formatTokens,
	folderLabel,
	hitRatePercent,
	sanitizeDisplay,
	viewFailure,
	type Fg,
	type Line1Parts,
	type Line2Layout,
} from "./format.ts";
import type { Frame } from "./frame.ts";
import { MetricsCache, type SessionMetrics } from "./metrics.ts";
import type { CommandsState } from "./views.ts";

const TICK_MS = 5_000;
const PRESENCE_EVENT = "harness:composer:presence";
const PRESENCE_REQUEST = "harness:composer:presence-request";
/** Full reset bounds each label and status cell's own SGR state. */
const RESET = "\x1b[0m";

function thinkingColorKey(level: string): ThemeColor {
	return `thinking${level.charAt(0).toUpperCase()}${level.slice(1)}` as ThemeColor;
}

/** Column spans of the two session controls on line 1; the model identity leads, the level follows it. */
interface Line1Spans {
	model: { x: number; width: number };
	level?: { x: number; width: number };
}

/** How the session's last run ended, when it ended without an answer: Esc stopped it, or Pi gave up on an error. */
type RunOutcome = "stopped" | "failed";

/** The outcome that the newest assistant message of the current branch records, read back from the leaf. */
function branchOutcome(
	session: Pick<ExtensionContext["sessionManager"], "getLeafId" | "getEntry">,
): RunOutcome | undefined {
	let id = session.getLeafId();
	for (let steps = 0; id && steps < 64; steps++) {
		const entry = session.getEntry(id);
		if (!entry) return undefined;
		if (entry.type === "message" && entry.message.role === "assistant") {
			const reason = entry.message.stopReason;
			return reason === "aborted" ? "stopped" : reason === "error" ? "failed" : undefined;
		}
		id = entry.parentId;
	}
	return undefined;
}

/** The outcome follows the level and stays until the next run starts. */
function outcomeText(fg: Fg, outcome: RunOutcome | undefined): string {
	return outcome ? fg(outcome === "failed" ? "error" : "muted", ` (${outcome})`) : "";
}

/** The exact route identity: provider and model id, with no label. */
function modelIdentity(ctx: ExtensionContext): string {
	const model = ctx.model;
	return sanitizeDisplay(model ? `${model.provider}/${model.id}` : "no-model");
}

function buildLine1(
	ctx: ExtensionContext,
	fg: Fg,
	sep: string,
	width: number,
	attachedAt: number,
	metrics: SessionMetrics,
	usage: ReturnType<ExtensionContext["getContextUsage"]>,
	outcome?: RunOutcome,
): { line: string; spans: Line1Spans } {
	const model = ctx.model;
	const identity = modelIdentity(ctx);
	let modelSeg = `${fg("accent", identity)}${RESET}`;
	const spans: Line1Spans = { model: { x: 0, width: visibleWidth(identity) } };
	// The thinking bracket follows the model's declared reasoning capability,
	// not a provider-name check: providers whose Pi thinking level is inert
	// register reasoning: false and the bracket disappears on its own.
	const level = ctx.thinkingLevel;
	if (model?.reasoning === true && level) {
		const bracket = ` [${level}]`;
		spans.level = { x: spans.model.width + 1, width: visibleWidth(bracket) - 1 };
		modelSeg += fg(thinkingColorKey(level), bracket);
	}
	modelSeg += outcomeText(fg, outcome);

	const parts: Line1Parts = { model: modelSeg };
	if (usage) {
		const percent = usage.percent;
		const tokens = usage.tokens;
		if (percent !== null && tokens !== null) {
			parts.contextBar = buildBar(percent, fg);
			parts.tokens = fg("dim", `${formatTokens(tokens)}/${formatTokens(usage.contextWindow)}`);
		} else {
			parts.contextBar = fg("dim", "context ?");
			parts.tokens = fg("dim", `?/${formatTokens(usage.contextWindow)}`);
		}
	} else {
		parts.contextBar = fg("dim", "context unavailable");
	}
	if (metrics.cost >= 0.005) {
		parts.cost = fg("dim", `~$${metrics.cost.toFixed(2)}`);
	}
	parts.duration = fg("dim", formatDuration(Date.now() - attachedAt));

	// Cache telemetry comes only from observed session usage.
	if (metrics.lastTurnCacheHit !== null) {
		parts.cacheDot = fg(metrics.lastTurnCacheHit ? "success" : "error", "●");
	}
	const rate = hitRatePercent(metrics.cacheRead, metrics.cacheWrite, metrics.inputTokens);
	if (rate !== null && metrics.sawCacheUsage) {
		parts.cacheRate = fg("dim", `${rate}% hit`);
	}

	return { line: composeLine1(parts, sep, width, visibleWidth), spans };
}

function buildLine2(
	ctx: ExtensionContext,
	footerData: ReadonlyFooterDataProvider,
	fg: Fg,
	sep: string,
	width: number,
): Line2Layout {
	const branch = footerData.getGitBranch();
	const project = {
		folder: sanitizeDisplay(folderLabel(ctx.cwd || process.cwd(), process.env.HOME)),
		branch: branch ? sanitizeDisplay(branch) : undefined,
	};
	// Each status is bracketed by the reset so a kept SGR sequence cannot bleed
	// its color into the next cell or the rest of the footer.
	const statuses: string[] = [];
	for (const text of footerData.getExtensionStatuses().values()) {
		const clean = sanitizeDisplay(text);
		if (clean) statuses.push(`${RESET}${clean}${RESET}`);
	}
	const layout = composeLine2(project, statuses, sep, width, visibleWidth, fg);

	// truncateToWidth is ANSI-aware and carries whole sequences, so a sanitized
	// line cannot come back cut in half; it only needs a closing reset when it
	// did not truncate and add one itself.
	const body = truncateToWidth(layout.line, width);
	return { ...layout, line: body.endsWith(RESET) ? body : `${body}${RESET}` };
}

/** Whether a line-1 click lands on the model identity or its level bracket. */
function onModel(spans: Line1Spans | undefined, x: number): boolean {
	if (!spans) return false;
	const { model, level } = spans;
	return (
		(x >= model.x && x < model.x + model.width) || (level !== undefined && x >= level.x && x < level.x + level.width)
	);
}

function overflowHit(layout: Line2Layout, x: number): boolean {
	const overflow = layout.overflow;
	return overflow !== undefined && x >= overflow.x && x < overflow.x + overflow.width;
}

/**
 * The view under a plain left click: the model identity or its level bracket opens Model, and the
 * hidden-status count opens Statuses. Anything else stays with Pi, so drag selection keeps working.
 */
function clickTarget(
	event: TuiMouseEvent,
	spans: Line1Spans | undefined,
	layout: Line2Layout,
): "model" | "statuses" | undefined {
	if (event.type !== "click" || event.button !== "left" || event.shift || event.alt || event.ctrl) return undefined;
	if (event.y === 0) return onModel(spans, event.x) ? "model" : undefined;
	return event.y === 1 && overflowHit(layout, event.x) ? "statuses" : undefined;
}

export default function registerStatusline(pi: ExtensionAPI) {
	let enabled = true;
	let attachedAt = Date.now();
	let tick: ReturnType<typeof setInterval> | null = null;
	let catchup: ReturnType<typeof setImmediate> | undefined;
	let current: ExtensionContext | undefined;
	const metrics = new MetricsCache();
	let contextUsage: ReturnType<ExtensionContext["getContextUsage"]>;
	let requestRender = () => {};
	let runOutcome: RunOutcome | undefined;
	let composerPresent = false;
	let stopPresence: (() => void) | undefined;
	function observePresence(payload: unknown): void {
		if (
			!payload ||
			typeof payload !== "object" ||
			Array.isArray(payload) ||
			!("version" in payload) ||
			payload.version !== 1 ||
			!("present" in payload) ||
			typeof payload.present !== "boolean"
		)
			return;
		if (payload.present === composerPresent) return;
		composerPresent = payload.present;
		requestRender();
	}
	/** The installed footer's status provider; the Statuses view reads through it. */
	let readStatuses: (() => ReadonlyMap<string, string>) | undefined;

	let commandState: CommandsState | undefined;
	let activeView: { frame?: Frame } | undefined;
	const loadViews = () => Promise.all([import("./frame.ts"), import("./views.ts")]);

	const viewNames = { commands: "Commands", model: "Model", statuses: "Statuses" };
	/** Commands wait for the view; footer clicks use the same path without waiting. */
	async function openOwn(ctx: ExtensionContext, id: keyof typeof viewNames): Promise<void> {
		if (ctx.mode !== "tui") {
			if (ctx.hasUI) ctx.ui.notify(`The ${viewNames[id]} view requires an interactive Pi terminal.`, "warning");
			return;
		}
		if (activeView) return;
		const opening: { frame?: Frame } = {};
		activeView = opening;
		try {
			const [{ openFrame }, views] = await loadViews();
			if (activeView !== opening) return;
			await openFrame(
				ctx,
				(host) => {
					if (id === "model") return views.modelView(pi, ctx, host, () => requestRender());
					if (id === "statuses") return views.statusesView(host, readStatuses);
					commandState ??= views.createCommandsState();
					return views.commandsView(pi, ctx, host, commandState);
				},
				(frame) => {
					opening.frame = frame;
					// Release the editor slot before a close continuation dispatches another command.
					if (!frame && activeView === opening) activeView = undefined;
				},
			);
		} finally {
			if (activeView === opening) activeView = undefined;
		}
	}

	/** Read current usage and catch the metrics up; false when no session is attached. */
	function update(): boolean {
		if (!current || !enabled) return false;
		contextUsage = current.getContextUsage();
		if (!metrics.refresh(current.sessionManager) && catchup === undefined) {
			catchup = setImmediate(() => {
				catchup = undefined;
				refresh();
			});
		}
		return true;
	}

	function refresh(): void {
		if (update()) requestRender();
	}

	const stopTick = () => {
		if (catchup !== undefined) {
			clearImmediate(catchup);
			catchup = undefined;
		}
		if (tick) {
			clearInterval(tick);
			tick = null;
		}
	};

	function install(ctx: ExtensionContext) {
		if (ctx.mode !== "tui") return;
		current = ctx;
		metrics.reset(ctx.sessionManager);
		contextUsage = ctx.getContextUsage();
		ctx.ui.setFooter((tui, theme, footerData) => {
			const fg: Fg = (color, text) => theme.fg(color as ThemeColor, text);
			const sep = theme.fg("dim", " │ ");
			const pointer = tui.mode === "fullscreen";
			const unsub = footerData.onBranchChange(() => tui.requestRender());
			// Pi disposes a replaced footer, but own the tick at every boundary so
			// a reload or rapid toggle can never accumulate intervals.
			stopTick();
			requestRender = () => tui.requestRender();
			readStatuses = () => footerData.getExtensionStatuses();
			let layout: Line2Layout | undefined;
			let spans: Line1Spans | undefined;
			let renderedWidth = -1;
			let renderedLine1: string | undefined;
			const session = () => current ?? ctx;
			// The tick advances the duration and catches usage up between events. A render recomputes the
			// lines of every component in the session view, so the tick requests one only when line 1
			// would show different text; line 2 changes arrive with branch and status events that render
			// on their own.
			tick = setInterval(() => {
				if (!update() || composerPresent) return;
				const next =
					renderedWidth < 0
						? undefined
						: buildLine1(session(), fg, sep, renderedWidth, attachedAt, metrics.value, contextUsage, runOutcome).line;
				if (next === undefined || next !== renderedLine1) requestRender();
			}, TICK_MS);
			tick.unref?.();
			return {
				dispose() {
					unsub();
					stopTick();
					requestRender = () => {};
					readStatuses = undefined;
					layout = undefined;
				},
				invalidate() {
					layout = undefined;
					renderedWidth = -1;
				},
				render(width: number): string[] {
					if (composerPresent) return [];
					renderedWidth = width;
					layout = buildLine2(session(), footerData, fg, sep, width);
					const first = buildLine1(session(), fg, sep, width, attachedAt, metrics.value, contextUsage, runOutcome);
					renderedLine1 = first.line;
					spans = first.spans;
					return [truncateToWidth(first.line, width), layout.line];
				},
				handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
					const target =
						!composerPresent && pointer && layout && event.width === renderedWidth
							? clickTarget(event, spans, layout)
							: undefined;
					if (!target) return undefined;
					const ctx = session();
					void openOwn(ctx, target).catch((error: unknown) =>
						ctx.ui.notify(viewFailure(viewNames[target], error), "error"),
					);
					return { handled: true };
				},
			};
		});
	}

	pi.on("session_start", async (_event, ctx) => {
		attachedAt = Date.now();
		if (ctx.mode !== "tui") return;
		runOutcome = branchOutcome(ctx.sessionManager);
		composerPresent = false;
		stopPresence ??= pi.events.on(PRESENCE_EVENT, observePresence);
		if (enabled) install(ctx);
		pi.events.emit(PRESENCE_REQUEST, { version: 1 });
	});

	pi.on("session_shutdown", async () => {
		const closing = activeView;
		activeView = undefined;
		closing?.frame?.close();
		commandState = undefined;
		stopPresence?.();
		stopPresence = undefined;
		composerPresent = false;
		stopTick();
		current = undefined;
		requestRender = () => {};
		readStatuses = undefined;
	});

	const observe = (ctx: ExtensionContext) => {
		if (ctx.mode === "tui") {
			current = ctx;
			refresh();
		}
	};
	pi.on("turn_end", (_event, ctx) => observe(ctx));
	/** A changed outcome renders at once; the metrics refresh renders only when its own figures change. */
	const settleOutcome = (next: RunOutcome | undefined) => {
		if (next === runOutcome) return;
		runOutcome = next;
		requestRender();
	};
	pi.on("agent_start", (_event, ctx) => {
		observe(ctx);
		settleOutcome(undefined);
	});
	pi.on("agent_end", (_event, ctx) => observe(ctx));
	pi.on("agent_settled", (event, ctx) => {
		observe(ctx);
		settleOutcome(event.aborted ? "stopped" : branchOutcome(ctx.sessionManager));
	});
	pi.on("model_select", (_event, ctx) => observe(ctx));
	pi.on("thinking_level_select", (_event, ctx) => observe(ctx));
	pi.on("session_compact", (_event, ctx) => observe(ctx));
	pi.on("session_tree", (_event, ctx) => {
		if (ctx.mode !== "tui" || !enabled) return;
		current = ctx;
		metrics.reset(ctx.sessionManager);
		contextUsage = ctx.getContextUsage();
		runOutcome = branchOutcome(ctx.sessionManager);
		requestRender();
	});

	pi.registerCommand("statusline", {
		description: "Toggle the two-line session statusline",
		handler: async (_args, ctx) => {
			enabled = !enabled;
			if (ctx.mode === "tui") {
				if (enabled) install(ctx);
				else ctx.ui.setFooter(undefined);
			}
			if (ctx.hasUI) {
				const notice = enabled
					? "Statusline is enabled."
					: ctx.mode === "tui"
						? "Statusline is disabled and Pi's default footer is restored."
						: "Statusline is disabled.";
				ctx.ui.notify(notice, "info");
			}
		},
	});

	pi.registerCommand("commands", {
		description: "Browse every command, prompt and skill, and run or prepare one",
		handler: async (_args, ctx) => openOwn(ctx, "commands"),
	});

	pi.registerCommand("statuses", {
		description: "Read the complete extension status map behind the footer",
		handler: async (_args, ctx) => openOwn(ctx, "statuses"),
	});
}
