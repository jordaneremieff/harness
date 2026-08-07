/**
 * Statusline: a two-line session footer.
 *
 * Line 1: model [<level>] │ context bar │ tokens │ cost │ duration │ cache telemetry
 * Line 2: folder (branch) │ extension statuses
 *
 * Installed only in TUI mode; setFooter is a documented no-op elsewhere.
 * One unref'd 5s tick owns wall-clock freshness for duration while idle; it is
 * cleared on dispose, on session_shutdown, and before any reinstall. Toggle
 * with /statusline.
 */

import type { ExtensionAPI, ExtensionContext, ReadonlyFooterDataProvider, ThemeColor } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
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
} from "./format.ts";
import { scanSession } from "./metrics.ts";

const TICK_MS = 5_000;

function thinkingColorKey(level: string): ThemeColor {
	return `thinking${level.charAt(0).toUpperCase()}${level.slice(1)}` as ThemeColor;
}

function renderLines(
	width: number,
	ctx: ExtensionContext,
	footerData: ReadonlyFooterDataProvider,
	fg: Fg,
	sep: string,
	attachedAt: number,
): string[] {
	const metrics = scanSession(ctx.sessionManager.getBranch());
	const usage = ctx.getContextUsage();
	const model = ctx.model;

	// --- Line 1: session metrics ---
	const modelName = model?.name || model?.id || "no-model";
	let modelSeg = fg("accent", modelName);
	// The thinking bracket follows the model's declared reasoning capability,
	// not a provider-name check: providers whose Pi thinking level is inert
	// register reasoning: false and the bracket disappears on its own.
	const level = ctx.thinkingLevel;
	if (model?.reasoning === true && level) {
		modelSeg += fg(thinkingColorKey(level), ` [${level}]`);
	}

	const parts: Line1Parts = { model: modelSeg };
	if (usage && usage.percent !== null && usage.percent > 0) {
		parts.contextBar = buildBar(usage.percent, fg);
		parts.tokens = fg("dim", `${formatTokens(usage.tokens ?? 0)}/${formatTokens(usage.contextWindow)}`);
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

	const line1 = composeLine1(parts, sep, width, visibleWidth);

	// --- Line 2: project + git + extension statuses ---
	let project = fg("muted", folderLabel(ctx.cwd || process.cwd(), process.env.HOME));
	const branch = footerData.getGitBranch();
	if (branch) {
		project += fg("dim", ` (${sanitizeDisplay(branch)})`);
	}
	const statuses: string[] = [];
	for (const text of footerData.getExtensionStatuses().values()) {
		const clean = sanitizeDisplay(text);
		if (clean) statuses.push(clean);
	}
	const line2 = composeLine2(project, statuses, sep, width, visibleWidth);

	return [truncateToWidth(line1, width), truncateToWidth(line2, width)];
}

export default function registerStatusline(pi: ExtensionAPI) {
	let enabled = true;
	let attachedAt = Date.now();
	let tick: ReturnType<typeof setInterval> | null = null;

	const stopTick = () => {
		if (tick) {
			clearInterval(tick);
			tick = null;
		}
	};

	function install(ctx: ExtensionContext) {
		if (ctx.mode !== "tui") return;
		ctx.ui.setFooter((tui, theme, footerData) => {
			const fg: Fg = (color, text) => theme.fg(color as ThemeColor, text);
			const sep = theme.fg("dim", " │ ");
			const unsub = footerData.onBranchChange(() => tui.requestRender());
			// Pi disposes a replaced footer, but own the tick at every boundary so
			// a reload or rapid toggle can never accumulate intervals.
			stopTick();
			tick = setInterval(() => tui.requestRender(), TICK_MS);
			tick.unref?.();
			return {
				dispose() {
					unsub();
					stopTick();
				},
				invalidate() {},
				render(width: number): string[] {
					return renderLines(width, ctx, footerData, fg, sep, attachedAt);
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
				ctx.ui.notify(
					enabled ? "Statusline enabled" : "Statusline disabled (default footer restored)",
					"info",
				);
			}
		},
	});
}
