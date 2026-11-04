/**
 * Statusline: a two-line session footer with command discovery.
 *
 * Line 1: model [<level>] │ context bar │ tokens │ cost │ duration │ cache telemetry
 * Line 2: Commands │ folder (branch) │ extension statuses │ +N
 *
 * Installed only in TUI mode; setFooter is a documented no-op elsewhere.
 * One unref'd 5s tick owns wall-clock freshness for duration while idle; it is
 * cleared on dispose, on session_shutdown, and before any reinstall. Toggle
 * with /statusline. In fullscreen the Commands cell and the +N cell are click
 * targets; /commands and /statuses are the keyboard routes in every TUI mode.
 */

import type {
	ExtensionAPI,
	ExtensionContext,
	ReadonlyFooterDataProvider,
	SlashCommandInfo,
	ThemeColor,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";
import {
	CommandsPanel,
	commandLine,
	createSelectorState,
	dispatchExtensionCommand,
	prepareDraft,
	restoreDraft,
	type CommandsPanelResult,
} from "./commands.ts";
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
import { StatusPanel } from "./statuses.ts";

const TICK_MS = 5_000;
/** Full reset bounds each label and status cell's own SGR state. */
const RESET = "\x1b[0m";

function thinkingColorKey(level: string): ThemeColor {
	return `thinking${level.charAt(0).toUpperCase()}${level.slice(1)}` as ThemeColor;
}

function buildLine1(
	ctx: ExtensionContext,
	fg: Fg,
	sep: string,
	width: number,
	attachedAt: number,
	metrics: SessionMetrics,
	usage: ReturnType<ExtensionContext["getContextUsage"]>,
): string {
	const model = ctx.model;

	const modelName = sanitizeDisplay(model?.name || model?.id || "no-model");
	let modelSeg = `${fg("accent", modelName)}${RESET}`;
	// The thinking bracket follows the model's declared reasoning capability,
	// not a provider-name check: providers whose Pi thinking level is inert
	// register reasoning: false and the bracket disappears on its own.
	const level = ctx.thinkingLevel;
	if (model?.reasoning === true && level) {
		modelSeg += fg(thinkingColorKey(level), ` [${level}]`);
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

	return composeLine1(parts, sep, width, visibleWidth);
}

function buildLine2(
	ctx: ExtensionContext,
	footerData: ReadonlyFooterDataProvider,
	fg: Fg,
	sep: string,
	width: number,
	pointer: boolean,
): Line2Layout {
	// --- Line 2: command control + project + git + extension statuses ---
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
	// Fullscreen delivers clicks to the footer, so the cell reads as a control;
	// regular mode leaves the mouse to the terminal, so it names the command.
	const control = pointer ? fg("accent", "[Commands]") : fg("dim", "/commands");
	const layout = composeLine2(project, statuses, sep, width, visibleWidth, fg, control);

	// truncateToWidth is ANSI-aware and carries whole sequences, so a sanitized
	// line cannot come back cut in half; it only needs a closing reset when it
	// did not truncate and add one itself.
	const body = truncateToWidth(layout.line, width);
	return { ...layout, line: body.endsWith(RESET) ? body : `${body}${RESET}` };
}

/** Which footer target a line-2 click lands on, if any. */
function footerTarget(layout: Line2Layout, x: number): "commands" | "statuses" | undefined {
	const { control, overflow } = layout;
	if (control && x >= control.x && x < control.x + control.width) return "commands";
	if (overflow && x >= overflow.x && x < overflow.x + overflow.width) return "statuses";
	return undefined;
}

function isFooterClick(event: TuiMouseEvent): boolean {
	return event.type === "click" && event.button === "left" && event.y === 1;
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
	/** The installed footer's status provider; the keyboard route reads through it. */
	let readStatuses: (() => ReadonlyMap<string, string>) | undefined;
	const selector = createSelectorState();
	let replacedDraft: string | undefined;
	/** Open panels, closed on session shutdown so no callback outlives its session. */
	const openPanels = new Set<() => void>();
	let generation = 0;

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

	function closePanels(): void {
		for (const close of [...openPanels]) close();
		openPanels.clear();
	}

	/** Show the selector as an overlay and resolve with the operator's choice. */
	async function showSelector(ctx: ExtensionContext, commands: SlashCommandInfo[]): Promise<CommandsPanelResult> {
		let close: (() => void) | undefined;
		const result = await ctx.ui.custom<CommandsPanelResult>(
			(tui, theme, _keybindings, done) => {
				const panel = new CommandsPanel({
					commands,
					theme,
					rows: tui.terminal.rows,
					state: selector,
					draftPresent: () => ctx.ui.getEditorText().length > 0,
					replacedDraftPresent: () => replacedDraft !== undefined,
					done,
				});
				close = () => panel.close();
				openPanels.add(close);
				return panel;
			},
			{ overlay: true, overlayOptions: { width: "80%", minWidth: 40, maxHeight: "85%", anchor: "center" } },
		);
		if (close) openPanels.delete(close);
		return result;
	}

	/** Act on a selection; "retry" reopens the selector with a refreshed inventory. */
	function settleSelection(ctx: ExtensionContext, result: NonNullable<CommandsPanelResult>): "done" | "retry" {
		if (result.kind === "restore-draft") {
			if (replacedDraft !== undefined) restoreDraft(ctx.ui, replacedDraft);
			replacedDraft = undefined;
			return "done";
		}
		if (result.kind === "prepare") {
			const outcome = prepareDraft(ctx.ui, commandLine(result.command.name, result.args), result.placement);
			if (outcome.replaced !== undefined && outcome.replaced.length > 0) {
				replacedDraft = outcome.replaced;
				ctx.ui.notify("Draft replaced. Commands offers Restore replaced draft.", "info");
			}
			return "done";
		}
		if (dispatchExtensionCommand(pi, result.command, result.args).kind === "sent") return "done";
		ctx.ui.notify(`/${result.command.name} is no longer registered as selected. The list was refreshed.`, "warning");
		return "retry";
	}

	/**
	 * Open the selector, dispatch the chosen action, and reopen on a refused
	 * dispatch so the operator sees the refreshed inventory. Every dispatch
	 * happens after the panel has resolved, so a command's own UI can open.
	 */
	async function openCommands(ctx: ExtensionContext): Promise<void> {
		if (ctx.mode !== "tui") {
			if (ctx.hasUI) ctx.ui.notify("Commands needs the terminal UI.", "info");
			return;
		}
		const started = generation;
		for (;;) {
			const commands = pi.getCommands().map((command) => ({ ...command, sourceInfo: { ...command.sourceInfo } }));
			const result = await showSelector(ctx, commands);
			if (result === undefined || started !== generation) return;
			if (settleSelection(ctx, result) === "done") return;
		}
	}

	async function openStatuses(ctx: ExtensionContext): Promise<void> {
		if (ctx.mode !== "tui") {
			if (ctx.hasUI) ctx.ui.notify("Statuses needs the terminal UI.", "info");
			return;
		}
		const read = readStatuses;
		if (!read) {
			ctx.ui.notify("Enable the statusline (/statusline) to read extension statuses.", "info");
			return;
		}
		let close: (() => void) | undefined;
		await ctx.ui.custom<void>(
			(tui, theme, _keybindings, done) => {
				const panel = new StatusPanel({ theme, rows: tui.terminal.rows, read, done });
				close = () => panel.close();
				openPanels.add(close);
				return panel;
			},
			{ overlay: true, overlayOptions: { width: "80%", minWidth: 30, maxHeight: "85%", anchor: "center" } },
		);
		if (close) openPanels.delete(close);
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
			let renderedWidth = -1;
			const open = (target: "commands" | "statuses") => {
				const context = current ?? ctx;
				void (target === "commands" ? openCommands(context) : openStatuses(context));
			};
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
					layout = buildLine2(ctx, footerData, fg, sep, width, pointer);
					return [
						truncateToWidth(buildLine1(ctx, fg, sep, width, attachedAt, metrics.value, contextUsage), width),
						layout.line,
					];
				},
				handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
					if (!pointer || !layout || event.width !== renderedWidth || !isFooterClick(event)) return undefined;
					const target = footerTarget(layout, event.x);
					if (!target) return undefined;
					open(target);
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
		generation += 1;
		closePanels();
		stopTick();
		current = undefined;
		requestRender = () => {};
		readStatuses = undefined;
	});

	pi.on("turn_end", (_event, ctx) => { if (ctx.mode === "tui") { current = ctx; refresh(); } });
	pi.on("agent_end", (_event, ctx) => { if (ctx.mode === "tui") { current = ctx; refresh(); } });
	pi.on("session_compact", (_event, ctx) => { if (ctx.mode === "tui") { current = ctx; refresh(); } });
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
		description: "Find a command by name or description, read it, then run it or prepare it as a draft",
		handler: async (_args, ctx) => {
			await openCommands(ctx);
		},
	});

	pi.registerCommand("statuses", {
		description: "Read the complete extension status map behind the footer",
		handler: async (_args, ctx) => {
			await openStatuses(ctx);
		},
	});
}
