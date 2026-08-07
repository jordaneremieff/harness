/**
 * Pure formatting for the statusline extension. No Pi imports: every function
 * takes plain values (plus a narrow `fg` colorizer) so tests need no harness.
 */

/** Narrow theme colorizer so pure segments stay testable without the TUI theme. */
export type Fg = (color: string, text: string) => string;

const BAR_WIDTH = 10;
/**
 * Context-bar color ramp, percent of the model's context window. Pi
 * auto-compacts when tokens exceed window - reserveTokens (default reserve
 * 16384, ~92% of a 200K window), so the failure event is an ill-timed
 * automatic compaction plus its cache rebuild, not a hard stop. Red above 80
 * leaves roughly a tenth of the window to choose the compaction moment
 * deliberately; warning above 60 is the plan-ahead band.
 */
export const BAND_WARNING_PERCENT = 60;
export const BAND_CRITICAL_PERCENT = 80;

/** Compact token counts matching Pi footer convention: 850, 9.5k, 42k, 1.2M, 12M. */
export function formatTokens(n: number): string {
	if (n < 1000) return `${n}`;
	if (n < 10_000) return `${(n / 1000).toFixed(1)}k`;
	if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
	if (n < 10_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	return `${Math.round(n / 1_000_000)}M`;
}

/** Wall-clock duration: "45s", "12m", "1h5m". */
export function formatDuration(ms: number): string {
	const sec = Math.max(0, Math.floor(ms / 1000));
	if (sec < 60) return `${sec}s`;
	const min = Math.floor(sec / 60);
	if (min < 60) return `${min}m`;
	return `${Math.floor(min / 60)}h${min % 60}m`;
}

/** Band tone for a context percentage. */
export function bandTone(percent: number): "success" | "warning" | "error" {
	if (percent > BAND_CRITICAL_PERCENT) return "error";
	if (percent > BAND_WARNING_PERCENT) return "warning";
	return "success";
}

/**
 * Ten-cell block bar with the tone on filled cells only: `██████░░░░ 62%`.
 * Foreground blocks instead of background ANSI so the bar follows the active
 * theme in both dark and light terminals.
 */
export function buildBar(percent: number, fg: Fg): string {
	const clamped = Math.max(0, Math.min(100, Math.round(percent)));
	const filled = Math.round((clamped * BAR_WIDTH) / 100);
	const tone = bandTone(clamped);
	const bar = fg(tone, "█".repeat(filled)) + fg("dim", "░".repeat(BAR_WIDTH - filled));
	return `${bar} ${fg(tone, `${clamped}%`)}`;
}

/** Share of prompt tokens served from cache; null before any usage. */
export function hitRatePercent(cacheRead: number, cacheWrite: number, input: number): number | null {
	const total = cacheRead + cacheWrite + input;
	if (total <= 0) return null;
	return Math.round((cacheRead / total) * 100);
}

/**
 * Single-line display sanitize, stricter than Pi's default footer: strips all
 * C0/DEL control characters (including ESC, so injected SGR cannot leak into
 * the statusline), collapses whitespace runs, trims.
 */
export function sanitizeDisplay(text: string): string {
	return text
		.replace(/[\x00-\x1f\x7f]/g, " ")
		.replace(/ +/g, " ")
		.trim();
}

/** Home-relative folder label, following Pi's footer convention ("~/work/app"). */
export function folderLabel(cwd: string, homeDir: string | undefined): string {
	if (homeDir) {
		const resolvedCwd = resolvePath(cwd);
		const resolvedHome = resolvePath(homeDir);
		if (resolvedCwd === resolvedHome) return "~";
		const prefix = resolvedHome.endsWith("/") ? resolvedHome : `${resolvedHome}/`;
		if (resolvedCwd.startsWith(prefix)) return `~/${resolvedCwd.slice(prefix.length)}`;
	}
	return cwd;
}

function resolvePath(p: string): string {
	// Normalize redundant separators and trailing slash without fs access.
	const parts = p.split("/").filter((s) => s.length > 0 && s !== ".");
	return `/${parts.join("/")}`;
}

export interface Line1Parts {
	model: string;
	contextBar?: string;
	tokens?: string;
	cost?: string;
	duration?: string;
	cacheDot?: string;
	cacheRate?: string;
}

/**
 * Compose line 1, shedding the least actionable segments until it fits
 * `width` (measured with the provided visible-width function). Shed order:
 * cache rate, cache dot, duration, token count, then cost; model and context
 * bar are never shed. Callers apply truncateToWidth as a final guard.
 */
export function composeLine1(
	parts: Line1Parts,
	sep: string,
	width: number,
	visibleWidth: (s: string) => number,
): string {
	const shedOrder: (keyof Line1Parts)[] = [
		"cacheRate",
		"cacheDot",
		"duration",
		"tokens",
		"cost",
	];
	const current: Line1Parts = { ...parts };
	for (;;) {
		const cache = [current.cacheDot, current.cacheRate].filter(Boolean).join(" ");
		const segs = [current.model, current.contextBar, current.tokens, current.cost, current.duration, cache]
			.filter((s): s is string => !!s);
		const line = segs.join(sep);
		if (visibleWidth(line) <= width) return line;
		const next = shedOrder.find((k) => current[k] !== undefined);
		if (!next) return line;
		delete current[next];
	}
}

/**
 * Compose line 2: project label plus extension statuses, dropping statuses
 * from the right until the line fits. The project label is never shed.
 */
export function composeLine2(
	project: string,
	statuses: string[],
	sep: string,
	width: number,
	visibleWidth: (s: string) => number,
): string {
	const kept = [...statuses];
	for (;;) {
		const line = [project, ...kept].join(sep);
		if (visibleWidth(line) <= width || kept.length === 0) return line;
		kept.pop();
	}
}
