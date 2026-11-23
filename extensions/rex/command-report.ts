import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, stripTerminalSequences, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

export type ReportLine = { text: string; level: "info" | "warning" | "error" };
const REPORT_LIMIT = 32_000;

function plain(text: string): string {
	return stripTerminalSequences(text)
		.replace(/\r\n/g, "\n")
		.replace(/[\p{Cc}\p{Cf}\p{Cs}\u2028\u2029]/gu, (ch) => (ch === "\n" ? ch : " "));
}

export function noticeText(text: string): string {
	return plain(text).replace(/\s+/gu, " ").trim();
}

function scrollBy(input: string, page: number): number {
	if (matchesKey(input, Key.up)) return -1;
	if (matchesKey(input, Key.down)) return 1;
	if (matchesKey(input, Key.pageUp)) return -page;
	return matchesKey(input, Key.pageDown) ? page : 0;
}

export async function showCommandReport(
	ctx: ExtensionCommandContext,
	title: string,
	lines: ReportLine[],
): Promise<void> {
	if (ctx.mode !== "tui" || !ctx.hasUI) {
		for (const { text, level } of lines) ctx.ui.notify(text, level);
		return;
	}
	if (!lines.length) return;
	if (lines.length === 1 && !/\r|\n/.test(lines[0].text)) {
		ctx.ui.notify(noticeText(lines[0].text), lines[0].level);
		return;
	}
	let remaining = REPORT_LIMIT;
	const report: ReportLine[] = [];
	for (const line of lines) {
		const text = Array.from(plain(line.text));
		report.push({ ...line, text: text.slice(0, remaining).join("") });
		if (text.length > remaining) {
			report.push({ text: `[Report display limited to ${REPORT_LIMIT} characters]`, level: "warning" });
			break;
		}
		remaining -= text.length;
	}
	await ctx.ui.custom<void>((tui, theme, _keys, done) => {
		let offset = 0;
		let length = 0;
		const page = () => Math.max(1, Math.min(16, tui.terminal.rows - 4));
		return {
			invalidate() {},
			handleInput(input: string) {
				if (matchesKey(input, Key.escape) || matchesKey(input, Key.enter)) return done();
				const movement = scrollBy(input, page());
				if (!movement) return;
				offset = Math.max(0, Math.min(Math.max(0, length - page()), offset + movement));
				tui.requestRender();
			},
			render(width: number) {
				if (width <= 0) return [];
				const rows = report.flatMap(({ text, level }) =>
					wrapTextWithAnsi(text, width).map((row) => theme.fg(level === "info" ? "text" : level, row)),
				);
				length = rows.length;
				const height = page();
				offset = Math.min(offset, Math.max(0, length - height));
				return [
					theme.fg("accent", theme.bold(truncateToWidth(title, width))),
					...rows.slice(offset, offset + height),
					theme.fg("muted", truncateToWidth("↑↓ Scroll · PgUp/PgDn Page · Esc Close", width)),
				];
			},
		};
	});
}
