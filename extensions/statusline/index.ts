/**
 * Statusline: a quiet two-line session footer.
 *
 * Line 1: provider/model [<level>] │ context bar │ tokens │ cost │ duration │ cache telemetry
 * Line 2: folder (branch) │ extension statuses │ +N
 *
 * The footer carries status only; it adds no navigation labels. In fullscreen the model, the
 * level and the +N cell are click targets for the Model and Statuses views; regular mode leaves
 * the mouse to the terminal. This owner publishes Commands, Model and Statuses as views of the
 * shared frame (docs/conventions/operator-panels.md); each has its own command, and /dashboard
 * shows every published view as tabs. Installed only in
 * TUI mode; setFooter is a documented no-op elsewhere. One unref'd 5s tick owns wall-clock
 * freshness for duration while idle.
 */

import { fileURLToPath } from "node:url";
import type {
	ExtensionAPI,
	ExtensionContext,
	ReadonlyFooterDataProvider,
	ThemeColor,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";
import { LoadingView, openOperatorFrame, publishOperatorViews } from "../../operator-ui/registration.ts";
import {
	buildBar,
	composeLine1,
	composeLine2,
	formatDuration,
	formatTokens,
	folderLabel,
	hitRatePercent,
	sanitizeDisplay,
	type Fg,
	type Line1Parts,
	type Line2Layout,
} from "./format.ts";
import { MetricsCache, type SessionMetrics } from "./metrics.ts";
import type { CommandsState } from "./views.ts";

const OWNER = fileURLToPath(import.meta.url);
const TICK_MS = 5_000;
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

function buildLine2(ctx: ExtensionContext, footerData: ReadonlyFooterDataProvider, fg: Fg, sep: string, width: number): Line2Layout {
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
	return (x >= model.x && x < model.x + model.width) || (level !== undefined && x >= level.x && x < level.x + level.width);
}

function overflowHit(layout: Line2Layout, x: number): boolean {
	const overflow = layout.overflow;
	return overflow !== undefined && x >= overflow.x && x < overflow.x + overflow.width;
}

/**
 * The view under a plain left click: the model identity or its level bracket opens Model, and the
 * hidden-status count opens Statuses. Anything else stays with Pi, so drag selection keeps working.
 */
function clickTarget(event: TuiMouseEvent, spans: Line1Spans | undefined, layout: Line2Layout): "model" | "statuses" | undefined {
	if (event.type !== "click" || event.button !== "left") return undefined;
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
	/** The installed footer's status provider; the Statuses view reads through it. */
	let readStatuses: (() => ReadonlyMap<string, string>) | undefined;

	/** Browsing state of the command list; the views module loads when a destination opens. */
	let commandState: CommandsState | undefined;
	let viewsPromise: Promise<typeof import("./views.ts")> | undefined;
	const loadViews = () => (viewsPromise ??= import("./views.ts"));

	publishOperatorViews(pi, {
		version: 2,
		owner: OWNER,
		views: [
			{
				id: "commands",
				label: "Commands",
				command: { name: "commands" },
				order: 80,
				view: (ctx, host) =>
					new LoadingView("Commands", host, async () => {
						const module = await loadViews();
						commandState ??= module.createCommandsState();
						return module.commandsView(pi, ctx, host, commandState);
					}),
			},
			// Model has no command of its own: the footer's model and level segments and /dashboard open it.
			{
				id: "model",
				label: "Model",
				command: { name: "dashboard" },
				order: 85,
				view: (ctx, host) =>
					new LoadingView("Model", host, async () => (await loadViews()).modelView(pi, ctx, host, () => requestRender())),
			},
			{
				id: "statuses",
				label: "Statuses",
				command: { name: "statuses" },
				order: 90,
				view: (_ctx, host) => new LoadingView("Statuses", host, async () => (await loadViews()).statusesView(host, readStatuses)),
			},
		],
	});

	function refresh(): void {
		if (!current || !enabled) return;
		contextUsage = current.getContextUsage();
		if (!metrics.refresh(current.sessionManager) && catchup === undefined) {
			catchup = setImmediate(() => { catchup = undefined; refresh(); });
		}
		requestRender();
	}

	const stopTick = () => {
		if (catchup !== undefined) { clearImmediate(catchup); catchup = undefined; }
		if (tick) {
			clearInterval(tick);
			tick = null;
		}
	};

	/** Open one of this owner's views; the commands wait for the frame, footer clicks do not. */
	function openOwn(ctx: ExtensionContext, id: string): Promise<void> {
		return openOperatorFrame(pi, ctx, { owner: OWNER, id });
	}

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
			tick = setInterval(refresh, TICK_MS);
			tick.unref?.();
			let layout: Line2Layout | undefined;
			let spans: Line1Spans | undefined;
			let renderedWidth = -1;
			const session = () => current ?? ctx;
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
					renderedWidth = width;
					layout = buildLine2(session(), footerData, fg, sep, width);
					const first = buildLine1(session(), fg, sep, width, attachedAt, metrics.value, contextUsage);
					spans = first.spans;
					return [truncateToWidth(first.line, width), layout.line];
				},
				handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
					const target = pointer && layout && event.width === renderedWidth ? clickTarget(event, spans, layout) : undefined;
					if (!target) return undefined;
					void openOwn(session(), target);
					return { handled: true };
				},
			};
		});
	}

	pi.on("session_start", async (_event, ctx) => {
		attachedAt = Date.now();
		if (enabled) install(ctx);
	});

	pi.on("session_shutdown", async () => {
		stopTick();
		current = undefined;
		requestRender = () => {};
		readStatuses = undefined;
	});

	const observe = (ctx: ExtensionContext) => { if (ctx.mode === "tui") { current = ctx; refresh(); } };
	pi.on("turn_end", (_event, ctx) => observe(ctx));
	pi.on("agent_start", (_event, ctx) => observe(ctx));
	pi.on("agent_end", (_event, ctx) => observe(ctx));
	pi.on("agent_settled", (_event, ctx) => observe(ctx));
	pi.on("model_select", (_event, ctx) => observe(ctx));
	pi.on("thinking_level_select", (_event, ctx) => observe(ctx));
	pi.on("session_compact", (_event, ctx) => observe(ctx));
	pi.on("session_tree", (_event, ctx) => {
		if (ctx.mode !== "tui" || !enabled) return;
		current = ctx;
		metrics.reset(ctx.sessionManager);
		contextUsage = ctx.getContextUsage();
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
				ctx.ui.notify(enabled ? "Statusline enabled" : "Statusline disabled (default footer restored)", "info");
			}
		},
	});

	pi.registerCommand("commands", {
		description: "Browse every command, prompt and skill, and run or prepare one",
		handler: async (_args, ctx) => openOwn(ctx, "commands"),
	});

	pi.registerCommand("dashboard", {
		description: "Show every view (stashes, clipboard, policy, pillars, commands and more) as tabs of one frame",
		handler: async (_args, ctx) => openOperatorFrame(pi, ctx, undefined, { tabs: true }),
	});

	pi.registerCommand("statuses", {
		description: "Read the complete extension status map behind the footer",
		handler: async (_args, ctx) => openOwn(ctx, "statuses"),
	});
}
