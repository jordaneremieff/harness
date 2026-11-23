import { stripVTControlCharacters } from "node:util";
import {
	getMarkdownTheme,
	type MessageRenderer,
	type MessageRenderOptions,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import { Box, type Component, Markdown, MouseRegion } from "@earendil-works/pi-tui";
import { BUDGET_NOTICE } from "./budget.ts";
import { CAPACITY_REQUEST } from "./capacity.ts";
import { clipRow, clipsRow, expansionHint, oneLine, plural, record, safe, wrapBody } from "./card-text.ts";
import { readRedactionReport, redactSecrets } from "./redact.ts";
import { formatTokenCount } from "./text.ts";

export const STASH_MESSAGES = Object.freeze({
	redaction: "stash-redaction",
	budget: "stash-budget",
	budgetStatus: "stash-budget-status",
	capacity: CAPACITY_REQUEST,
});
export const MESSAGE_PREVIEW_LINES = 3;

type CardFacts = { label: string; facts?: string[]; body?: string; expandedOnly?: string; alternateBody?: string };

function contentText(content: Parameters<MessageRenderer>[0]["content"]): string {
	return typeof content === "string"
		? content
		: content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
}

const percent = (value: number, limit: number) => `${Math.round((value / limit) * 100)}%`;
const number = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

function redactionFacts(details: unknown): CardFacts {
	try {
		const report = readRedactionReport(record(details).redactions);
		if (report.count === 0) return { label: "Redaction notice" };
		const classes = Object.entries(report.classes)
			.map(([kind, amount]) => `${kind} ${amount}`)
			.join(", ");
		return {
			label: "Credentials redacted",
			facts: [plural(report.count, "value", "values"), classes],
			body: [
				...report.contexts,
				...(report.count > report.contexts.length
					? [`Contexts retained for ${report.contexts.length} of ${report.count} replacements.`]
					: []),
			].join("\n"),
		};
	} catch {
		return { label: "Redaction notice" };
	}
}

function budgetFacts(details: unknown, text: string): CardFacts {
	const data = record(details);
	const budget = record(data.budget);
	const tokens = record(data.context).tokens;
	const usd = record(data.cost).usd;
	const contextTokens = number(budget.contextTokens) && budget.contextTokens > 0 ? budget.contextTokens : undefined;
	const costUsd = number(budget.costUsd) && budget.costUsd > 0 ? budget.costUsd : undefined;
	const facts: string[] = [];
	let reached = false;
	if (number(tokens) && contextTokens !== undefined) {
		facts.push(`context ${percent(tokens, contextTokens)} of ${formatTokenCount(contextTokens)}`);
		reached ||= tokens >= contextTokens;
	}
	if (number(usd) && costUsd !== undefined) {
		facts.push(`cost ${percent(usd, costUsd)} of USD ${costUsd}`);
		reached ||= usd >= costUsd;
	}
	return {
		label: reached ? "Budget reached" : "Budget notice",
		facts,
		body: text.startsWith(`${BUDGET_NOTICE}\n`) ? text.slice(BUDGET_NOTICE.length + 1) : text,
	};
}

function budgetStatusCardFacts(details: unknown, text: string): CardFacts {
	const data = record(details);
	const budget = record(data.budget);
	return {
		label: data.state === "disabled" ? "Budget off" : data.state === "enabled" ? "Budget notices on" : "Budget status",
		facts:
			number(budget.contextTokens) && number(budget.costUsd)
				? [`${formatTokenCount(budget.contextTokens)} tokens`, `USD ${budget.costUsd}`]
				: [],
		body: text,
	};
}

function capacityFacts(details: unknown, text: string): CardFacts {
	const data = record(details);
	const usage = record(data.usage);
	const decision = data.request === "decision" || (data.request === undefined && data.decisionRequested === true);
	return {
		label: decision ? "Continuity decision requested" : "Capacity checkpoint requested",
		facts: usage.kind === "host_estimate" && number(usage.percent) ? [`context ${Math.round(usage.percent)}%`] : [],
		alternateBody: typeof data.observation === "string" ? data.observation : "",
		expandedOnly: text,
	};
}

function trimBlank(lines: readonly string[]): string[] {
	let start = 0;
	let end = lines.length;
	while (start < end && stripVTControlCharacters(lines[start] ?? "").trim() === "") start++;
	while (end > start && stripVTControlCharacters(lines[end - 1] ?? "").trim() === "") end--;
	return lines.slice(start, end);
}

const markdown = (text: string, theme: Theme) =>
	new Markdown(redactSecrets(safe(text)).replace(/\t/gu, "   ").trim(), 0, 0, getMarkdownTheme(), {
		color: (value) => theme.fg("customMessageText", value),
	});

const disclosures = new WeakMap<object, { expanded: boolean; under: boolean }>();

class MessageCardBody implements Component {
	private readonly full: Markdown;
	private readonly preview?: Markdown;
	private cache: { width: number; lines: string[] } | undefined;
	private expanded: boolean;
	private readonly message: object;
	private readonly facts: CardFacts;
	private readonly theme: Theme;
	private readonly options: MessageRenderOptions;
	constructor(message: object, facts: CardFacts, theme: Theme, options: MessageRenderOptions) {
		this.message = message;
		this.facts = facts;
		this.theme = theme;
		this.options = options;
		const choice = disclosures.get(message);
		if (choice && choice.under !== options.expanded) disclosures.delete(message);
		this.expanded = disclosures.get(message)?.expanded ?? options.expanded;
		this.full = markdown(facts.expandedOnly ?? facts.body ?? "", theme);
		if (facts.alternateBody !== undefined) this.preview = markdown(facts.alternateBody, theme);
	}
	toggle(): void {
		this.expanded = !this.expanded;
		disclosures.set(this.message, { expanded: this.expanded, under: this.options.expanded });
		this.cache = undefined;
	}
	private header(): string[] {
		const theme = this.theme;
		const title = `${theme.fg("customMessageLabel", theme.bold("[stash]"))} ${theme.fg("customMessageText", theme.bold(oneLine(this.facts.label)))}`;
		const facts = this.facts.facts?.map(oneLine).filter(Boolean).join(" · ");
		return facts ? [title, theme.fg("muted", facts)] : [title];
	}
	private hint(width: number, header: string[], full: number, shown: number): string {
		if (this.expanded) return "";
		const hidden = this.preview ? 0 : full - shown;
		const other = !!(this.preview && full) || header.some((row) => clipsRow(row, width));
		return hidden || other ? clipRow(expansionHint(this.theme, this.options, hidden), width) : "";
	}
	render(width: number): string[] {
		if (this.cache?.width === width) return this.cache.lines;
		const header = this.header();
		const full = trimBlank(this.full.render(width));
		const body = this.expanded
			? full
			: trimBlank((this.preview ? trimBlank(this.preview.render(width)) : full).slice(0, MESSAGE_PREVIEW_LINES));
		const rows = this.expanded
			? header.flatMap((row) => wrapBody(row, width))
			: header.map((row) => clipRow(row, width));
		if (body.length) rows.push("", ...body);
		const hint = this.hint(width, header, full.length, body.length);
		if (hint) rows.push(hint);
		this.cache = { width, lines: rows };
		return rows;
	}
	invalidate(): void {
		this.cache = undefined;
		this.full.invalidate();
		this.preview?.invalidate();
	}
}

function card(message: object, facts: CardFacts, options: MessageRenderOptions, theme: Theme): Component {
	const background = theme.getBgAnsi("customMessageBg");
	const box = new Box(options.outputPad, 1, (line) =>
		theme.bg(
			"customMessageBg",
			line.replace(/\x1b\[(?:0|49)?m/gu, (reset) => reset + background),
		),
	);
	const body = new MessageCardBody(message, facts, theme, options);
	box.addChild(
		new MouseRegion(body, (event) => {
			if (event.type !== "click" || event.button !== "left") return undefined;
			body.toggle();
			return { handled: true };
		}),
	);
	return box;
}

export const renderRedactionMessage: MessageRenderer = (message, options, theme) =>
	card(message, redactionFacts(message.details), options, theme);
export const renderBudgetMessage: MessageRenderer = (message, options, theme) =>
	card(message, budgetFacts(message.details, contentText(message.content)), options, theme);
export const renderBudgetStatusMessage: MessageRenderer = (message, options, theme) =>
	card(message, budgetStatusCardFacts(message.details, contentText(message.content)), options, theme);
export const renderCapacityMessage: MessageRenderer = (message, options, theme) =>
	card(message, capacityFacts(message.details, contentText(message.content)), options, theme);
