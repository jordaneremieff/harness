import {
	getMarkdownTheme,
	type MessageRenderer,
	type MessageRenderOptions,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import { Box, Markdown, MouseRegion, truncateToWidth, wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";
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

function record(value: unknown): Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function oneLine(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	return displayText(value).replace(/\s+/gu, " ").trim() || undefined;
}

function outcome(status: unknown): string {
	switch (status) {
		case "succeeded":
			return "Job succeeded";
		case "failed":
			return "Job failed";
		case "timed_out":
			return "Job timed out";
		case "lost":
			return "Job lost";
		case "cancelled":
			return "Job cancelled";
		default:
			return "Job settled";
	}
}

/** What happened, then the known facts: exit code, settled duration and, last, the command preview. */
export function completionHeader(details: unknown): { label: string; facts: string[] } {
	const data = record(details);
	const job = record(data.job) as CompletionFacts;
	const facts: string[] = [];
	if (typeof job.exitCode === "number") facts.push(`exit ${job.exitCode}`);
	if (typeof job.startedAt === "number" && typeof job.endedAt === "number")
		facts.push(seconds(job.startedAt, job.endedAt));
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
	const output = typeof tail.text === "string" ? trimBlank(displayText(tail.text).split("\n")) : [];
	return { prose, output: output.slice(-COMPLETION_PREVIEW_LINES) };
}

function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.flatMap((part) =>
			record(part).type === "text" && typeof record(part).text === "string" ? [record(part).text as string] : [],
		)
		.join("\n");
}

/** One row at most `width` wide; a clipped row ends in `…` in the colour of the text it cuts and keeps the row background. */
function clipRow(line: string, width: number): string {
	return truncateToWidth(line, Math.max(0, width), "…").replace(
		/\x1b\[0m…\x1b\[0m$/u,
		"…\x1b[22;23;24;25;27;28;29;39m",
	);
}

/** Pi's tool-card hint, `... (2 more lines, ctrl+o to expand)`, with the key from Pi's `keyHint` and the rest muted. */
function expansionHint(theme: Theme, options: MessageRenderOptions, hidden: number): string {
	const key = typeof options.keyText === "function" ? options.keyText("app.tools.expand") : "";
	const action = !key
		? theme.fg("muted", "click to expand")
		: typeof options.keyHint === "function"
			? options.keyHint("app.tools.expand", "to expand")
			: theme.fg("dim", key) + theme.fg("muted", " to expand");
	return theme.fg("muted", `... (${hidden} more line${hidden === 1 ? "" : "s"}, `) + action + theme.fg("muted", ")");
}

/** Blank lines at the start and the end of a run of lines are dropped; blank lines inside it stay. */
function trimBlank(lines: readonly string[]): string[] {
	let start = 0;
	let end = lines.length;
	while (start < end && stripVTControlCharacters(lines[start] ?? "").trim() === "") start++;
	while (end > start && stripVTControlCharacters(lines[end - 1] ?? "").trim() === "") end--;
	return lines.slice(start, end);
}

/**
 * A card's own disclosure, kept with the stored message object that Pi hands to every rebuild of the card. A
 * choice holds only under the global expansion it was made under; a change of Pi's global expansion discards it.
 */
const disclosures = new WeakMap<object, { expanded: boolean; under: boolean }>();

function disclosedExpansion(message: object, global: boolean): boolean {
	const choice = disclosures.get(message);
	if (choice && choice.under !== global) disclosures.delete(message);
	return disclosures.get(message)?.expanded ?? global;
}

/**
 * A left click on the card's content toggles it, as Pi's compaction and tool cards do with `MouseRegion`: Pi checks
 * only the click type and the left button. A drag still selects text, because Pi sends no click for it.
 */
function clickToggle(body: Component & { toggle(): void }): MouseRegion {
	return new MouseRegion(body, (event) => {
		if (event.type !== "click" || event.button !== "left") return undefined;
		body.toggle();
		return { handled: true };
	});
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
	private readonly message: object;
	private expanded: boolean;
	constructor(message: object, details: unknown, content: string, theme: Theme, options: MessageRenderOptions) {
		this.message = message;
		this.details = details;
		this.theme = theme;
		this.options = options;
		this.expanded = disclosedExpansion(message, options.expanded);
		this.markdown = new Markdown(displayText(content).trim() || "(no text)", 0, 0, getMarkdownTheme(), {
			color: (value) => theme.fg("text", value),
		});
	}
	private header(width: number): string[] {
		const theme = this.theme;
		const { label, facts } = completionHeader(this.details);
		const title = clipRow(
			`${theme.fg("customMessageLabel", theme.bold("[jobs]"))} ${theme.fg("text", theme.bold(label))}`,
			width,
		);
		return facts.length ? [title, clipRow(theme.fg("muted", facts.join(" · ")), width)] : [title];
	}
	private preview(width: number): string[] {
		const text = (value: string) => this.theme.fg("text", value);
		const { prose, output } = completionPreview(this.details);
		const lines = prose.flatMap((paragraph) => wrapTextWithAnsi(paragraph, width)).map(text);
		const room = Math.max(0, COMPLETION_PREVIEW_LINES - lines.length);
		// A tab draws as three spaces, as Pi's Text and Markdown components draw it.
		const tail =
			room > 0 ? trimBlank(output.slice(-room)).map((line) => clipRow(text(line.replace(/\t/gu, "   ")), width)) : [];
		return [...lines, ...tail].slice(0, COMPLETION_PREVIEW_LINES);
	}
	/** Shows the other form of this card and keeps the choice under the current global expansion. */
	toggle(): void {
		this.expanded = !this.expanded;
		disclosures.set(this.message, { expanded: this.expanded, under: this.options.expanded });
		this.cache = undefined;
	}
	render(width: number): string[] {
		if (this.cache?.width === width) return this.cache.lines;
		const full = trimBlank(this.markdown.render(width));
		const head = [...this.header(width), ""];
		let lines: string[];
		if (this.expanded) lines = [...head, ...full];
		else {
			const preview = this.preview(width);
			const hidden = Math.max(0, full.length - preview.length);
			lines = [
				...head,
				...preview,
				...(hidden > 0 ? [clipRow(expansionHint(this.theme, this.options, hidden), width)] : []),
			];
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
	const box = new Box(options.outputPad, 1, (line) =>
		theme.bg(
			"customMessageBg",
			line.replace(/\x1b\[(?:0|49)?m/gu, (reset) => reset + background),
		),
	);
	box.addChild(clickToggle(new CompletionBody(message, message.details, contentText(message.content), theme, options)));
	return box;
};
