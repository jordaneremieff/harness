import { getMarkdownTheme, type MessageRenderer, type MessageRenderOptions, type Theme } from "@earendil-works/pi-coding-agent";
import { Box, Markdown, truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import { stripVTControlCharacters } from "node:util";
import { BUDGET_NOTICE, budgetNoticeFacts, budgetStatusFacts } from "./budget.ts";
import { CAPACITY_NOTICE_HEADER, CAPACITY_REQUEST, type CapacityState } from "./capacity.ts";
import type { RedactionReport } from "./redact.ts";
import { formatTokenCount, sanitizeTerminalText } from "./text.ts";

/** Displayed stash messages, by type. */
export const STASH_MESSAGES = Object.freeze({
	redaction: "stash-redaction",
	budget: "stash-budget",
	budgetStatus: "stash-budget-status",
	capacity: CAPACITY_REQUEST,
});
/** Collapsed stash message cards show at most this many visual body lines under the header. */
export const MESSAGE_PREVIEW_LINES = 3;

interface CardFacts {
	/** What happened, after the `[stash]` label. */
	label: string;
	/** Known facts for the muted second line; an unknown fact is left out. */
	facts: string[];
	/** The body text the expanded card shows. */
	body: string;
	/** The part of the body a collapsed card previews. */
	preview: string;
}

/** One styled run of a card line; `text` is plain display text. */
interface Run {
	text: string;
	style: (text: string) => string;
}

const safe = (value: string) => sanitizeTerminalText(value).text;
const oneLine = (value: string) => safe(value).replace(/\s+/gu, " ").trim();

function record(value: unknown): Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function contentText(content: Parameters<MessageRenderer>[0]["content"]): string {
	return typeof content === "string" ? content : content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
}

/** The text after its first line, or after its first paragraph. */
const afterLine = (text: string) => text.split("\n").slice(1).join("\n");
const afterParagraph = (text: string) => text.split("\n\n").slice(1).join("\n\n");

const percent = (value: number, limit: number) => `${Math.round((value / limit) * 100)}%`;
const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

export function redactionFacts(details: unknown, text: string): CardFacts {
	const report = record(record(details).redactions) as Partial<RedactionReport>;
	const count = typeof report.count === "number" ? report.count : undefined;
	const classes = Object.entries(record(report.classes)).flatMap(([kind, amount]) => (typeof amount === "number" ? [`${safe(kind)} ${amount}`] : []));
	return {
		label: "Credentials redacted",
		facts: [...(count === undefined ? [] : [plural(count, "value", "values")]), ...(classes.length ? [classes.join(", ")] : [])],
		body: text,
		preview: afterLine(text).split("\n").map((line) => line.trim()).join("\n"),
	};
}

/** The model-facing tag line stays in the message text and is not displayed. */
export function budgetFacts(text: string): CardFacts {
	const facts = budgetNoticeFacts(text);
	const reached = (facts?.context !== undefined && facts.context.tokens >= facts.context.budget) || (facts?.cost !== undefined && facts.cost.usd >= facts.cost.budget);
	const body = text.startsWith(`${BUDGET_NOTICE}\n`) ? afterLine(text) : text;
	return {
		label: reached ? "Budget reached" : "Budget notice",
		facts: [
			...(facts?.context ? [`context ${percent(facts.context.tokens, facts.context.budget)} of ${formatTokenCount(facts.context.budget)}`] : []),
			...(facts?.cost ? [`cost ${percent(facts.cost.usd, facts.cost.budget)} of USD ${facts.cost.budget}`] : []),
		],
		body,
		preview: body,
	};
}

export function budgetStatusCardFacts(text: string): CardFacts {
	const facts = budgetStatusFacts(text);
	const label = facts?.state === "disabled" ? "Budget off" : facts?.state === "enabled" ? "Budget notices on" : facts?.state === "selected" ? "Budget selected" : "Budget status";
	return {
		label,
		facts: facts?.budget ? [`${formatTokenCount(facts.budget.contextTokens)} tokens`, `USD ${facts.budget.costUsd}`] : [],
		body: text,
		preview: text,
	};
}

export function capacityFacts(details: unknown, text: string): CardFacts {
	const state = record(details) as Partial<CapacityState>;
	const usage = record(state.usage);
	return {
		label: state.decisionRequested === true ? "Continuity decision requested" : state.checkpointRequested === true ? "Capacity checkpoint requested" : "Capacity notice",
		facts: usage.kind === "host_estimate" && typeof usage.percent === "number" ? [`context ${Math.round(usage.percent)}%`] : [],
		body: text,
		preview: text.startsWith(`${CAPACITY_NOTICE_HEADER}\n\n`) ? afterParagraph(text) : text,
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

/** Pi's tool-card hint: `... (2 more lines, ctrl+o to expand)`. */
function hintRuns(theme: Theme, options: MessageRenderOptions, hidden: number): Run[] {
	const muted = (text: string) => theme.fg("muted", text);
	const key = typeof options.keyText === "function" ? options.keyText("app.tools.expand") : "";
	const more = `${hidden} more line${hidden === 1 ? "" : "s"}, `;
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

const markdown = (text: string, theme: Theme) => new Markdown(safe(text).trim() || "(no text)", 0, 0, getMarkdownTheme(), { color: (value) => theme.fg("text", value) });

/**
 * The `[stash]` header and its facts line, a blank line, then at most three body lines with Pi's expansion
 * hint when text is hidden, or the whole body as Markdown when expanded.
 */
class MessageCardBody implements Component {
	private readonly full: Markdown;
	private readonly preview: Markdown;
	private cache: { width: number; lines: string[] } | undefined;
	private readonly facts: CardFacts;
	private readonly theme: Theme;
	private readonly options: MessageRenderOptions;
	constructor(facts: CardFacts, theme: Theme, options: MessageRenderOptions) {
		this.facts = facts;
		this.theme = theme;
		this.options = options;
		this.full = markdown(facts.body, theme);
		this.preview = markdown(facts.preview, theme);
	}
	private header(width: number): string[] {
		const theme = this.theme;
		const title = fitRow([{ text: "[stash]", style: (text) => theme.fg("customMessageLabel", theme.bold(text)) }, { text: ` ${oneLine(this.facts.label)}`, style: (text) => theme.fg("text", theme.bold(text)) }], width);
		const facts = this.facts.facts.map(oneLine).filter(Boolean);
		return [title, ...(facts.length ? [fitRow([{ text: facts.join(" · "), style: (text) => theme.fg("muted", text) }], width)] : []), ""];
	}
	render(width: number): string[] {
		if (this.cache?.width === width) return this.cache.lines;
		const full = trimBlank(this.full.render(width));
		let lines: string[];
		if (this.options.expanded) lines = [...this.header(width), ...full];
		else {
			const preview = trimBlank(trimBlank(this.preview.render(width)).slice(0, MESSAGE_PREVIEW_LINES));
			const hidden = Math.max(0, full.length - preview.length);
			lines = [...this.header(width), ...preview, ...(hidden > 0 ? [fitRow(hintRuns(this.theme, this.options, hidden), width)] : [])];
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

function card(facts: CardFacts, options: MessageRenderOptions, theme: Theme): Component {
	const background = theme.getBgAnsi("customMessageBg");
	const box = new Box(options.outputPad, 1, (line) => theme.bg("customMessageBg", line.replace(/\x1b\[(?:0|49)?m/gu, (reset) => reset + background)));
	box.addChild(new MessageCardBody(facts, theme, options));
	return box;
}

/** `[stash] Credentials redacted`, then `2 values · JWT 1, Bearer 1`, then the redaction contexts. */
export const renderRedactionMessage: MessageRenderer = (message, options, theme) => {
	const content = contentText(message.content);
	return card(redactionFacts(message.details, content), options, theme);
};

/** `[stash] Budget reached`, then `context 105% of 200k` and the cost share when it is known, then the budget lines. */
export const renderBudgetMessage: MessageRenderer = (message, options, theme) => {
	const content = contentText(message.content);
	return card(budgetFacts(content), options, theme);
};

/** `[stash] Budget notices on`, then `200k tokens · USD 5`, after `/stash budget`. */
export const renderBudgetStatusMessage: MessageRenderer = (message, options, theme) => {
	const content = contentText(message.content);
	return card(budgetStatusCardFacts(content), options, theme);
};

/** `[stash] Capacity checkpoint requested`, then `context 85%` when Pi estimates it, then the request text. */
export const renderCapacityMessage: MessageRenderer = (message, options, theme) => {
	const content = contentText(message.content);
	return card(capacityFacts(message.details, content), options, theme);
};
