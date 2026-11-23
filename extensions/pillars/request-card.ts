import {
	getMarkdownTheme,
	type EntryRenderer,
	type MessageRenderer,
	type MessageRenderOptions,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import { Box, Markdown, MouseRegion, type Component } from "@earendil-works/pi-tui";
import { stripVTControlCharacters } from "node:util";
import type { JudgmentRequest } from "./commands.ts";
import type { ExportResult } from "./export.ts";
import { clipRow, disclosureHint, displayText, exportMarkdown, oneLine } from "./presentation.ts";

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
	receipt?: ExportResult;
}

const TITLES: Record<JudgmentRequest["action"], string> = {
	check: "Alignment check requested",
	derive: "Candidate derivation requested",
	review: "Guidance review requested",
};

function contentText(content: Parameters<MessageRenderer>[0]["content"]): string {
	return typeof content === "string"
		? content
		: content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
}

function requestSummary(details: unknown): { label: string; facts: string[]; preview: string } {
	const request = details as Partial<JudgmentRequest> | undefined;
	if (request?.action !== "check" && request?.action !== "derive" && request?.action !== "review")
		return { label: "Judgment requested", facts: [], preview: "" };
	return {
		label: TITLES[request.action],
		facts: [`/pillars ${request.action}`],
		preview: typeof request.hint === "string" ? request.hint : "",
	};
}

/** Blank lines at the start and the end of a run of lines are dropped; blank lines inside it stay. */
function trimBlank(lines: readonly string[]): string[] {
	let start = 0;
	let end = lines.length;
	while (start < end && stripVTControlCharacters(lines[start] ?? "").trim() === "") start++;
	while (end > start && stripVTControlCharacters(lines[end - 1] ?? "").trim() === "") end--;
	return lines.slice(start, end);
}

const markdown = (text: string, theme: Theme) =>
	new Markdown(displayText(text).trim(), 0, 0, getMarkdownTheme(), {
		color: (value) => theme.fg("customMessageText", value),
	});

interface Header {
	label: string;
	subject?: string;
	facts: readonly string[];
}

/** The `[pillars]` line, the muted facts line when facts are known, and a blank line. */
function headerLines(header: Header, theme: Theme, width: number): string[] {
	const subject = header.subject ? theme.fg("customMessageText", ` · ${oneLine(header.subject)}`) : "";
	const title = clipRow(
		`${theme.fg("customMessageLabel", theme.bold("[pillars]"))} ${theme.fg("customMessageText", theme.bold(oneLine(header.label)))}${subject}`,
		width,
	);
	const facts = header.facts.map(oneLine).filter(Boolean);
	return [title, ...(facts.length ? [clipRow(theme.fg("muted", facts.join(" · ")), width)] : []), ""];
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

/** The header, then at most three body lines with Pi's expansion hint, or the whole task text when expanded. */
class RequestBody implements Component {
	private readonly full: Markdown;
	private readonly preview: Markdown;
	private cache: { width: number; lines: string[] } | undefined;
	private readonly header: Header;
	private readonly theme: Theme;
	private readonly options: MessageRenderOptions;
	private readonly message: object;
	private expanded: boolean;
	constructor(
		message: object,
		header: Header,
		preview: string,
		content: string,
		theme: Theme,
		options: MessageRenderOptions,
	) {
		this.message = message;
		this.header = header;
		this.theme = theme;
		this.options = options;
		this.expanded = disclosedExpansion(message, options.expanded);
		this.full = markdown(content, theme);
		this.preview = markdown(preview, theme);
	}
	/** Shows the other form of this card and keeps the choice under the current global expansion. */
	toggle(): void {
		this.expanded = !this.expanded;
		disclosures.set(this.message, { expanded: this.expanded, under: this.options.expanded });
		this.cache = undefined;
	}
	render(width: number): string[] {
		if (this.cache?.width === width) return this.cache.lines;
		const head = headerLines(this.header, this.theme, width);
		const full = trimBlank(this.full.render(width));
		let lines: string[];
		if (this.expanded) lines = [...head, ...full];
		else {
			const preview = trimBlank(trimBlank(this.preview.render(width)).slice(0, REQUEST_PREVIEW_LINES));
			const addsContent = full.length > preview.length || full.some((row, i) => row !== preview[i]);
			lines = [...head, ...preview, ...(addsContent ? [clipRow(disclosureHint(this.theme, this.options), width)] : [])];
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
	const box = new Box(padding, 1, (line) =>
		theme.bg(
			"customMessageBg",
			line.replace(/\x1b\[(?:0|49)?m/gu, (reset) => reset + background),
		),
	);
	box.addChild(child);
	return box;
}

/** The `pillars-request` card: `[pillars] Alignment check requested`, then `/pillars check`, then the operator hint. */
export const renderJudgmentRequestMessage: MessageRenderer = (message, options, theme) => {
	const content = contentText(message.content);
	const { label, facts, preview } = requestSummary(message.details);
	return messageBox(
		theme,
		options.outputPad,
		clickToggle(new RequestBody(message, { label, facts }, preview, content, theme, options)),
	);
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
	return messageBox(
		theme,
		1,
		new ViewBody(
			header,
			data?.receipt
				? exportMarkdown(data.receipt)
				: typeof data?.text === "string"
					? data.text
					: "Pillars view unavailable.",
			theme,
		),
	);
};
