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
 * A status is one footer cell. Anything longer is hostile or broken, and
 * without a cap a zero-width SGR run of unbounded length survives sanitize and
 * width shedding alike, so the footer would ship megabytes to the terminal on
 * every tick.
 */
export const MAX_STATUS_LENGTH = 512;

const SGR_RE = /^\x1b\[[0-9;:]*m/; // complete SGR (graphics-only final "m") — the only kept sequence
const CSI_RE = /^\x1b\[[0-?]*[ -/]*[@-~]/; // any other complete CSI — DROP
const ESC_SEQ_RE = /^\x1b[\x20-\x2f]*[\x30-\x7e]/; // generic ESC sequence, any intermediates — DROP
const C1_CSI_RE = /^\x9b[0-?]*[ -/]*[@-~]?/; // C1 CSI (0x9B) — DROP
const CSI_PARAM_RE = /[\x20-\x3f]/; // parameter/intermediate bytes of a cut CSI
const ST_RE = /\x07|\x9c|\x1b\\/; // string terminators: BEL, C1 ST, ESC backslash

// Control-string introducers (OSC, DCS, SOS, PM, APC) in both encodings. Their
// payload is arbitrary, so they are only safe to drop whole once terminated.
const ESC_STRING_OPENERS = "]PX^_";
const C1_STRING_OPENERS = "\x9d\x90\x98\x9e\x9f";

/**
 * End of a control string whose payload starts at `payloadStart`, or null when
 * it is never terminated. An unterminated string is not consumed to end of
 * input: that would let a single stray introducer swallow every legitimate
 * character after it. Dropping just the introducer already removes the control
 * action and leaves the payload to be sanitized as ordinary text.
 */
function endOfControlString(text: string, payloadStart: number): number | null {
	const match = ST_RE.exec(text.slice(payloadStart));
	return match ? payloadStart + match.index + match[0].length : null;
}

/**
 * Single-line display sanitize with an SGR allowlist: complete color sequences
 * survive so a pre-colored extension status renders as its author intended,
 * while every other escape sequence is removed — whole when it is complete or
 * terminated, introducer-and-parameters when it is truncated, because a
 * half-consumed sequence paints its remaining bytes as literal text.
 * Remaining C0/C1/DEL bytes blank, whitespace runs collapse, the result is
 * trimmed, and over-long input is cut to MAX_STATUS_LENGTH first.
 *
 * Callers must anchor each status with a reset so kept SGR cannot bleed past
 * its own cell.
 */
export function sanitizeDisplay(input: string): string {
	// The sequence matchers read forward from the cursor, so the cap has to bound
	// the string itself; a loop bound alone leaves them free to run past it.
	const text = input.length > MAX_STATUS_LENGTH ? input.slice(0, MAX_STATUS_LENGTH) : input;
	let out = "";
	let i = 0;
	const n = text.length;
	while (i < n) {
		const c = text[i];
		if (c === "\x1b") {
			const rest = text.slice(i);
			const sgr = SGR_RE.exec(rest);
			if (sgr) {
				out += sgr[0];
				i += sgr[0].length;
				continue;
			}
			if (text[i + 1] === "[") {
				const csi = CSI_RE.exec(rest);
				if (csi) {
					i += csi[0].length;
				} else {
					// Truncated CSI: drop ESC [ and its parameter run, leaving no residue.
					i += 2;
					while (i < n && CSI_PARAM_RE.test(text[i])) i++;
				}
				continue;
			}
			const opener = text[i + 1];
			if (opener !== undefined && ESC_STRING_OPENERS.includes(opener)) {
				i = endOfControlString(text, i + 2) ?? i + 2;
				continue;
			}
			// Any other escape sequence: ESC, optional intermediates, one final
			// byte. Covers charset designators (ESC ( B), cursor save/restore
			// (ESC 7 / ESC 8), keypad modes, and the single-byte Fe controls.
			const esc = ESC_SEQ_RE.exec(rest);
			if (esc) {
				i += esc[0].length;
				continue;
			}
			i += 1; // lone ESC at end of input
			continue;
		}
		if (c === "\x9b") {
			const m = C1_CSI_RE.exec(text.slice(i));
			i += m ? m[0].length : 1;
			continue;
		}
		if (C1_STRING_OPENERS.includes(c)) {
			i = endOfControlString(text, i + 1) ?? i + 1;
			continue;
		}
		// ESC and the C1 introducers are consumed above; the rest of C0/DEL/C1 blanks.
		const code = c.charCodeAt(0);
		if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) {
			out += " ";
			i++;
			continue;
		}
		out += c;
		i++;
	}
	return out.replace(/ +/g, " ").trim();
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
	const shedOrder: (keyof Line1Parts)[] = ["cacheRate", "cacheDot", "duration", "tokens", "cost"];
	const current: Line1Parts = { ...parts };
	for (;;) {
		const cache = [current.cacheDot, current.cacheRate].filter(Boolean).join(" ");
		const segs = [current.model, current.contextBar, current.tokens, current.cost, current.duration, cache].filter(
			(s): s is string => !!s,
		);
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
