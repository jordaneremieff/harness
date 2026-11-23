import type { MessageRenderer, MessageRenderOptions, Theme } from "@earendil-works/pi-coding-agent";
import {
	Box,
	MouseRegion,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
	type Component,
} from "@earendil-works/pi-tui";
import { displayText } from "./completion.ts";
import { formatDuration } from "./presentation.ts";

/** Collapsed completion cards show at most this many visual body lines under the header. */
export const COMPLETION_PREVIEW_LINES = 3;

function record(value: unknown): Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function oneLine(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	return displayText(value).replace(/\s+/gu, " ").trim() || undefined;
}

function outcome(status: unknown): string | undefined {
	switch (status) {
		case "succeeded":
		case "failed":
		case "lost":
		case "cancelled":
			return status;
		case "timed_out":
			return "timed out";
		default:
			return undefined;
	}
}

function finite(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

/** What happened, then the known facts: exit code, settled duration and, last, the command preview. */
export function completionHeader(details: unknown): { label: string; facts: string[] } {
	const data = record(details);
	const job = record(data.job);
	const id = oneLine(job.id);
	const result = outcome(job.status);
	const label = result ? `Job${id ? ` ${id}` : ""} ${result}` : `Completion notice${id ? ` for job ${id}` : ""}`;
	const facts: string[] = [];
	if (finite(job.exitCode)) facts.push(`exit ${job.exitCode}`);
	if (finite(job.startedAt) && finite(job.endedAt) && job.endedAt >= job.startedAt)
		facts.push(formatDuration(job.endedAt - job.startedAt));
	const command = oneLine(data.command);
	if (command) facts.push(`command preview ${command}`);
	return { label, facts };
}

function bodyLines(text: string): string[] {
	return trimBlank(displayText(text).replace(/\t/gu, "   ").split("\n"));
}

function completionPreview(details: unknown): { prose: string[]; output: string[]; omitted: boolean } {
	const data = record(details);
	const job = record(data.job);
	const tail = record(data.tail);
	const prose: string[] = [];
	const error = oneLine(job.error);
	if (error) prose.push(error);
	if (job.status === "lost")
		return { prose: [...prose, "Output is unavailable after host loss."], output: [], omitted: false };
	if (tail.outputBytes === 0) return { prose: [...prose, "No output."], output: [], omitted: false };
	const output = typeof tail.text === "string" ? bodyLines(tail.text) : [];
	return { prose, output, omitted: tail.omitted === true };
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
function expansionHint(theme: Theme, options: MessageRenderOptions, hidden: number | "details"): string {
	const key = typeof options.keyText === "function" ? options.keyText("app.tools.expand") : "";
	const action = !key
		? theme.fg("muted", "click to expand")
		: typeof options.keyHint === "function"
			? options.keyHint("app.tools.expand", "to expand")
			: theme.fg("dim", key) + theme.fg("muted", " to expand");
	const count = hidden === "details" ? "" : `${hidden} more line${hidden === 1 ? "" : "s"}, `;
	return theme.fg("muted", `... (${count}`) + action + theme.fg("muted", ")");
}

/** Blank lines at the start and the end of a run of lines are dropped; blank lines inside it stay. */
function trimBlank(lines: readonly string[]): string[] {
	let start = 0;
	let end = lines.length;
	while (start < end && lines[start]?.trim() === "") start++;
	while (end > start && lines[end - 1]?.trim() === "") end--;
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

/** The preview uses the receipt; the expanded view shows the full safe copy, including literal command output. */
class CompletionBody implements Component {
	private readonly content: string[];
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
		this.content = bodyLines(content);
	}
	private header(): string[] {
		const theme = this.theme;
		const { label, facts } = completionHeader(this.details);
		const title = `${theme.fg("customMessageLabel", theme.bold("[jobs]"))} ${theme.fg("customMessageText", theme.bold(label))}`;
		return facts.length ? [title, theme.fg("muted", facts.join(" · "))] : [title];
	}
	private preview(
		width: number,
		full: string[],
		prose: string[],
		output: string[],
	): { lines: string[]; hidden?: number | "details" } {
		if (prose.length === 0 && output.length === 0) {
			const first = this.content[0];
			const lines = first ? wrapTextWithAnsi(first, width).slice(0, COMPLETION_PREVIEW_LINES) : [];
			return { lines, hidden: full.length - lines.length || undefined };
		}
		if ([...prose, ...output].join("\n") === this.content.join("\n")) {
			const lines = full.slice(-COMPLETION_PREVIEW_LINES);
			return { lines, hidden: full.length - lines.length || undefined };
		}
		const lines = prose.flatMap((paragraph) => wrapTextWithAnsi(paragraph, width)).slice(0, COMPLETION_PREVIEW_LINES);
		const room = COMPLETION_PREVIEW_LINES - lines.length;
		if (room > 0 && output.length > 0)
			lines.push(...trimBlank(wrapTextWithAnsi(output.join("\n"), width).slice(-room)));
		const sameRows = full.length === lines.length && full.every((line, i) => line.trimEnd() === lines[i]?.trimEnd());
		return { lines, hidden: full.length > 0 && !sameRows ? "details" : undefined };
	}
	/** Shows the other form of this card and keeps the choice under the current global expansion. */
	toggle(): void {
		this.expanded = !this.expanded;
		disclosures.set(this.message, { expanded: this.expanded, under: this.options.expanded });
		this.cache = undefined;
	}
	render(width: number): string[] {
		if (this.cache?.width === width) return this.cache.lines;
		const full = this.content.length > 0 ? wrapTextWithAnsi(this.content.join("\n"), width) : [];
		const { prose, output, omitted } = completionPreview(this.details);
		const body = this.expanded ? { lines: full, hidden: undefined } : this.preview(width, full, prose, output);
		const header = this.header();
		const limit = omitted ? [this.theme.fg("warning", "[Excerpt: earlier output omitted]")] : [];
		const format = (rows: string[]) =>
			this.expanded ? rows.flatMap((row) => wrapTextWithAnsi(row, width)) : rows.map((row) => clipRow(row, width));
		const clipped = !this.expanded && [...header, ...limit].some((row) => visibleWidth(row) > width);
		const hidden = body.hidden ?? (clipped ? "details" : undefined);
		const lines = [
			...format(header),
			...(body.lines.length || omitted ? [""] : []),
			...body.lines.map((line) => clipRow(this.theme.fg("customMessageText", line), width)),
			...format(limit),
			...(hidden === undefined ? [] : [clipRow(expansionHint(this.theme, this.options, hidden), width)]),
		];
		this.cache = { width, lines };
		return lines;
	}
	invalidate(): void {
		this.cache = undefined;
	}
}

/** The `jobs.completion` card: outcome and identity, known facts, then the preview or the full completion text. */
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
