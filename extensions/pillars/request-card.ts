import { getMarkdownTheme, type EntryRenderer, type MessageRenderer, type MessageRenderOptions, type Theme } from "@earendil-works/pi-coding-agent";
import { Box, Markdown, truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import { stripVTControlCharacters } from "node:util";
import { judgmentRequestOf, type JudgmentRequest } from "./commands.ts";

/** Message type of the task that `/pillars check`, `derive` or `review` sends to the model. */
export const JUDGMENT_REQUEST_MESSAGE = "pillars-request";
/** Entry type of the command output that `/pillars` shows in the transcript without model context. */
export const VIEW_ENTRY = "pillars-view";
/** Collapsed request cards show at most this many visual body lines under the header. */
export const REQUEST_PREVIEW_LINES = 3;

/** A `pillars-view` entry: the Markdown body and what the command showed. */
export interface ViewEntryData {
	text: string;
	title?: string;
	subject?: string;
	facts?: string[];
}

const TITLES: Record<JudgmentRequest["action"], string> = {
	check: "Alignment check requested",
	derive: "Candidate derivation requested",
	review: "Guidance review requested",
};

/** One styled run of a card line; `text` is plain display text. */
interface Run {
	text: string;
	style: (text: string) => string;
}

/** Displayed text keeps newlines and drops terminal controls and other control or format characters. */
function displayText(text: string): string {
	return stripVTControlCharacters(text).replace(/[\p{Cc}\p{Cf}]/gu, (character) => (character === "\n" ? character : character === "\t" ? " " : ""));
}

const oneLine = (text: string) => displayText(text).replace(/\s+/gu, " ").trim();

function contentText(content: Parameters<MessageRenderer>[0]["content"]): string {
	return typeof content === "string" ? content : content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
}

/** The card header and the body text a collapsed request previews: the operator hint, or how the subject is found. */
export function requestSummary(text: string): { label: string; facts: string[]; preview: string } {
	const request = judgmentRequestOf(text);
	if (!request) return { label: "Request", facts: [], preview: text };
	return {
		label: TITLES[request.action],
		facts: [`/pillars ${request.action}`],
		preview: request.hint || (text.split("\n\n")[1] ?? ""),
	};
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

const markdown = (text: string, theme: Theme) => new Markdown(displayText(text).trim() || "(no text)", 0, 0, getMarkdownTheme(), { color: (value) => theme.fg("text", value) });

interface Header {
	label: string;
	subject?: string;
	facts: readonly string[];
}

/** The `[pillars]` line, the muted facts line when facts are known, and a blank line. */
function headerLines(header: Header, theme: Theme, width: number): string[] {
	const title = fitRow([
		{ text: "[pillars]", style: (text) => theme.fg("customMessageLabel", theme.bold(text)) },
		{ text: ` ${oneLine(header.label)}`, style: (text) => theme.fg("text", theme.bold(text)) },
		...(header.subject ? [{ text: ` · ${oneLine(header.subject)}`, style: (text: string) => theme.fg("text", text) }] : []),
	], width);
	const facts = header.facts.map(oneLine).filter(Boolean);
	return [title, ...(facts.length ? [fitRow([{ text: facts.join(" · "), style: (text) => theme.fg("muted", text) }], width)] : []), ""];
}

/** The header, then at most three body lines with Pi's expansion hint, or the whole task text when expanded. */
class RequestBody implements Component {
	private readonly full: Markdown;
	private readonly preview: Markdown;
	private cache: { width: number; lines: string[] } | undefined;
	private readonly header: Header;
	private readonly theme: Theme;
	private readonly options: MessageRenderOptions;
	constructor(header: Header, preview: string, content: string, theme: Theme, options: MessageRenderOptions) {
		this.header = header;
		this.theme = theme;
		this.options = options;
		this.full = markdown(content, theme);
		this.preview = markdown(preview, theme);
	}
	render(width: number): string[] {
		if (this.cache?.width === width) return this.cache.lines;
		const head = headerLines(this.header, this.theme, width);
		const full = trimBlank(this.full.render(width));
		let lines: string[];
		if (this.options.expanded) lines = [...head, ...full];
		else {
			const preview = trimBlank(trimBlank(this.preview.render(width)).slice(0, REQUEST_PREVIEW_LINES));
			const hidden = Math.max(0, full.length - preview.length);
			lines = [...head, ...preview, ...(hidden > 0 ? [fitRow(hintRuns(this.theme, this.options, hidden), width)] : [])];
		}
		this.cache = { width, lines };
		return lines;
	}
	invalidate(): void {
		this.cache = undefined;
		this.full.invalidate();
		this.preview.invalidate();
	}
}

/** The header and the whole Markdown body of a command output entry. */
class ViewBody implements Component {
	private readonly body: Markdown;
	private readonly header: Header;
	private readonly theme: Theme;
	constructor(header: Header, text: string, theme: Theme) {
		this.header = header;
		this.theme = theme;
		this.body = markdown(text, theme);
	}
	render(width: number): string[] {
		return [...headerLines(this.header, this.theme, width), ...trimBlank(this.body.render(width))];
	}
	invalidate(): void {
		this.body.invalidate();
	}
}

function messageBox(theme: Theme, padding: number, child: Component): Box {
	const background = theme.getBgAnsi("customMessageBg");
	const box = new Box(padding, 1, (line) => theme.bg("customMessageBg", line.replace(/\x1b\[(?:0|49)?m/gu, (reset) => reset + background)));
	box.addChild(child);
	return box;
}

/** The `pillars-request` card: `[pillars] Alignment check requested`, then `/pillars check`, then the operator hint. */
export const renderJudgmentRequestMessage: MessageRenderer = (message, options, theme) => {
	const content = contentText(message.content);
	const { label, facts, preview } = requestSummary(content);
	return messageBox(theme, options.outputPad, new RequestBody({ label, facts }, preview, content, theme, options));
};

/** A `pillars-view` entry: `[pillars] Source · governance`, then the command's Markdown output. */
export const renderViewEntry: EntryRenderer<ViewEntryData> = (entry, _options, theme) => {
	const data = entry.data;
	const facts = Array.isArray(data?.facts) ? data.facts.filter((fact): fact is string => typeof fact === "string") : [];
	const header: Header = {
		label: typeof data?.title === "string" && data.title.trim() ? data.title : "Command output",
		...(typeof data?.subject === "string" && data.subject.trim() ? { subject: data.subject } : {}),
		facts,
	};
	return messageBox(theme, 1, new ViewBody(header, typeof data?.text === "string" ? data.text : "Pillars view unavailable.", theme));
};
