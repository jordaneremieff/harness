import { getMarkdownTheme, type MessageRenderer, type MessageRenderOptions, type Theme } from "@earendil-works/pi-coding-agent";
import { Box, Markdown, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";
import { stripVTControlCharacters } from "node:util";
import { displayText } from "./completion.ts";
import { seconds } from "./presentation.ts";

/** Collapsed completion cards show at most this many visual body lines under the header. */
export const COMPLETION_PREVIEW_LINES = 3;

interface CompletionFacts {
	status?: unknown;
	exitCode?: unknown;
	startedAt?: unknown;
	endedAt?: unknown;
	error?: unknown;
}

/** One styled run of a card line; `text` is plain display text. */
interface Run {
	text: string;
	style: (text: string) => string;
}

function record(value: unknown): Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function oneLine(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	return displayText(value).replace(/\s+/gu, " ").trim() || undefined;
}

function outcome(status: unknown): string {
	switch (status) {
		case "succeeded": return "Job succeeded";
		case "failed": return "Job failed";
		case "timed_out": return "Job timed out";
		case "lost": return "Job lost";
		case "cancelled": return "Job cancelled";
		default: return "Job settled";
	}
}

/** What happened, then the known facts: exit code, settled duration and, last, the command preview. */
export function completionHeader(details: unknown): { label: string; facts: string[] } {
	const data = record(details);
	const job = record(data.job) as CompletionFacts;
	const facts: string[] = [];
	if (typeof job.exitCode === "number") facts.push(`exit ${job.exitCode}`);
	if (typeof job.startedAt === "number" && typeof job.endedAt === "number") facts.push(seconds(job.startedAt, job.endedAt));
	const command = oneLine(data.command);
	if (command) facts.push(command);
	return { label: outcome(job.status), facts };
}

/** The body preview: the backend error or the host-loss outcome as prose, and the last output lines. */
export function completionPreview(details: unknown): { prose: string[]; output: string[] } {
	const data = record(details);
	const job = record(data.job) as CompletionFacts;
	const tail = record(data.tail);
	const prose: string[] = [];
	const error = oneLine(job.error);
	if (error) prose.push(error);
	if (job.status === "lost") return { prose: [...prose, "Output is unavailable after host loss."], output: [] };
	if (tail.outputBytes === 0) return { prose: [...prose, "No output."], output: [] };
	const output = typeof tail.text === "string" ? displayText(tail.text).replace(/\n+$/u, "").split("\n").filter((line) => line.trim() !== "") : [];
	return { prose, output: output.slice(-COMPLETION_PREVIEW_LINES) };
}

function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.flatMap((part) => (record(part).type === "text" && typeof record(part).text === "string" ? [record(part).text as string] : [])).join("\n");
}

/** Runs on one row; a clipped row ends in `…` in the style of the run it cuts. */
function fitRow(runs: readonly Run[], width: number): string {
	if (runs.reduce((total, run) => total + visibleWidth(run.text), 0) <= width) return runs.map((run) => run.style(run.text)).join("");
	let used = 0;
	let line = "";
	for (const run of runs) {
		const size = visibleWidth(run.text);
		if (used + size < width) {
			line += run.style(run.text);
			used += size;
			continue;
		}
		const kept = stripVTControlCharacters(truncateToWidth(run.text, Math.max(0, width - used - 1), ""));
		return width > used ? line + run.style(`${kept}…`) : line;
	}
	return line;
}

/** Pi's tool-card hint: `... (2 more lines, ctrl+o to expand)`, or `... (ctrl+o to expand)` when no line count applies. */
function hintRuns(theme: Theme, options: MessageRenderOptions, hidden: number): Run[] {
	const muted = (text: string) => theme.fg("muted", text);
	const key = typeof options.keyText === "function" ? options.keyText("app.tools.expand") : "";
	const more = hidden > 0 ? `${hidden} more line${hidden === 1 ? "" : "s"}, ` : "";
	if (!key) return [{ text: `... (${more}expand for full details)`, style: muted }];
	return [{ text: `... (${more}`, style: muted }, { text: key, style: (text) => theme.fg("dim", text) }, { text: " to expand)", style: muted }];
}

function trimBlank(lines: string[]): string[] {
	let start = 0;
	let end = lines.length;
	while (start < end && stripVTControlCharacters(lines[start] ?? "").trim() === "") start++;
	while (end > start && stripVTControlCharacters(lines[end - 1] ?? "").trim() === "") end--;
	return lines.slice(start, end);
}

/**
 * The completion card body: the `[jobs]` header and its facts line, a blank line, then the preview with Pi's
 * expansion hint, or the whole message text as Markdown, as Pi shows a custom message without a renderer.
 */
class CompletionBody implements Component {
	private readonly markdown: Markdown;
	private cache: { width: number; lines: string[] } | undefined;
	private readonly details: unknown;
	private readonly theme: Theme;
	private readonly options: MessageRenderOptions;
	constructor(details: unknown, content: string, theme: Theme, options: MessageRenderOptions) {
		this.details = details;
		this.theme = theme;
		this.options = options;
		this.markdown = new Markdown(displayText(content).trim() || "(no text)", 0, 0, getMarkdownTheme(), { color: (value) => theme.fg("text", value) });
	}
	private header(width: number): string[] {
		const theme = this.theme;
		const { label, facts } = completionHeader(this.details);
		const title = fitRow([{ text: "[jobs]", style: (text) => theme.fg("customMessageLabel", theme.bold(text)) }, { text: ` ${label}`, style: (text) => theme.fg("text", theme.bold(text)) }], width);
		return facts.length ? [title, fitRow([{ text: facts.join(" · "), style: (text) => theme.fg("muted", text) }], width)] : [title];
	}
	private preview(width: number): string[] {
		const text = (value: string) => this.theme.fg("text", value);
		const { prose, output } = completionPreview(this.details);
		const lines = prose.flatMap((paragraph) => wrapTextWithAnsi(paragraph, width)).map(text);
		const room = Math.max(0, COMPLETION_PREVIEW_LINES - lines.length);
		const tail = room > 0 ? output.slice(-room).map((line) => fitRow([{ text: line, style: text }], width)) : [];
		return [...lines, ...tail].slice(0, COMPLETION_PREVIEW_LINES);
	}
	render(width: number): string[] {
		if (this.cache?.width === width) return this.cache.lines;
		const full = trimBlank(this.markdown.render(width));
		const head = [...this.header(width), ""];
		let lines: string[];
		if (this.options.expanded) lines = [...head, ...full];
		else {
			const preview = this.preview(width);
			lines = [...head, ...preview, fitRow(hintRuns(this.theme, this.options, Math.max(0, full.length - preview.length)), width)];
		}
		this.cache = { width, lines };
		return lines;
	}
	invalidate(): void {
		this.cache = undefined;
		this.markdown.invalidate();
	}
}

/** The `jobs.completion` card: `[jobs] Job succeeded`, then `exit 0 · 10s · npm test`, then the last output lines. */
export const renderJobCompletionMessage: MessageRenderer = (message, options, theme) => {
	const background = theme.getBgAnsi("customMessageBg");
	const box = new Box(options.outputPad, 1, (line) => theme.bg("customMessageBg", line.replace(/\x1b\[(?:0|49)?m/gu, (reset) => reset + background)));
	box.addChild(new CompletionBody(message.details, contentText(message.content), theme, options));
	return box;
};
