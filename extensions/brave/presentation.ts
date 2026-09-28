/** Terminal cards for the brave tools: request identity and bounded outcome counts. */
import type { AgentToolResult, Theme, ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import { keyText } from "@earendil-works/pi-coding-agent";
import { Text, type Component } from "@earendil-works/pi-tui";

const RESULT_DISPLAY_LIMIT = 32_000;
const URL_LIMIT = 120;
const QUERY_LIMIT = 160;

interface CardContext {
	expanded: boolean;
	isError: boolean;
	args?: unknown;
	lastComponent?: Component;
}

function asRecord(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

function stringField(value: unknown, key: string): string {
	const field = asRecord(value)[key];
	return typeof field === "string" ? field : "";
}

function numberField(value: unknown, key: string): number | undefined {
	const field = asRecord(value)[key];
	return typeof field === "number" && Number.isFinite(field) ? field : undefined;
}

function booleanField(value: unknown, key: string): boolean | undefined {
	const field = asRecord(value)[key];
	return typeof field === "boolean" ? field : undefined;
}

function clip(value: string, limit: number): string {
	const end = Math.min(value.length, limit);
	const bounded = value.slice(0, /[\uD800-\uDBFF]/u.test(value[end - 1] ?? "") ? end - 1 : end);
	return bounded.length < value.length ? `${bounded}…` : value;
}

/** Escape terminal controls, C1 bytes, and format characters. Newlines survive for multi-line text. */
function escapeControls(value: string, preserveNewlines = false): string {
	return value.replace(/[\p{Cc}\p{Cf}]/gu, (character) => {
		if (preserveNewlines && character === "\n") return character;
		if (character === "\n") return "\\n";
		if (character === "\t") return "\\t";
		const code = character.codePointAt(0) ?? 0;
		return code <= 0xff ? `\\x${code.toString(16).padStart(2, "0")}` : `\\u{${code.toString(16)}}`;
	});
}

/** Controls become text and whitespace collapses, so a summary stays on one row. */
function displayValue(value: string, limit: number): string {
	return clip(escapeControls(value).replace(/\s+/gu, " ").trim(), limit) || "(empty)";
}

function textContent(result: AgentToolResult<unknown>): string {
	return result.content
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

function firstLine(output: string): string {
	return output.split("\n").find((line) => line.trim().length > 0)?.trim() ?? "";
}

function textComponent(text: string, previous?: Component): Text {
	const component = previous instanceof Text ? previous : new Text("", 0, 0);
	component.setText(text);
	return component;
}

function expansionHint(subject: string): string {
	const key = keyText("app.tools.expand");
	return key ? `${key} to expand ${subject}` : `Expand for full ${subject}`;
}

function boundedDisplay(value: string): string {
	const escaped = escapeControls(value, true);
	const prefix = clip(escaped, RESULT_DISPLAY_LIMIT);
	return prefix.length < escaped.length
		? `${prefix}\n[Display limit. The full text remains in the native tool history.]`
		: escaped;
}

function expandedArguments(args: Record<string, unknown>, theme: Theme): string {
	return theme.fg("toolOutput", boundedDisplay(JSON.stringify(args, null, 2) ?? "(none)"));
}

function heading(name: string, subject: string, theme: Theme, limit: number): string {
	return subject
		? theme.fg("toolTitle", theme.bold(name)) + theme.fg("accent", ` · ${displayValue(subject, limit)}`)
		: theme.fg("toolTitle", theme.bold(name));
}

function countLabel(count: number, noun: string): string {
	return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** Read requests show the page identity and any continuation fields. */
function readQualifier(args: Record<string, unknown>): string[] {
	const parts: string[] = [];
	if (stringField(args, "view") === "links") parts.push("view links");
	const find = stringField(args, "find");
	if (find) parts.push(`find ${displayValue(find, 60)}`);
	const excerpt = numberField(args, "excerpt_offset");
	if (excerpt !== undefined) parts.push(`excerpt offset ${excerpt}`);
	const link = numberField(args, "link_offset");
	if (link !== undefined) parts.push(`link offset ${link}`);
	const source = stringField(args, "expected_source_id");
	if (source) parts.push(`source ${displayValue(source, 24)}`);
	const max = numberField(args, "max_bytes");
	if (max !== undefined) parts.push(`max bytes ${max}`);
	return parts;
}

export function renderReadCall(value: unknown, theme: Theme, context: CardContext): Component {
	const args = asRecord(value);
	const url = stringField(args, "url");
	const lines = [heading("web_read", url, theme, URL_LIMIT)];
	if (context.expanded) {
		lines.push(expandedArguments(args, theme));
		return textComponent(lines.join("\n"), context.lastComponent);
	}
	const parts = readQualifier(args);
	if (url.length > URL_LIMIT) parts.push(expansionHint("arguments"));
	if (parts.length > 0) lines.push(theme.fg("dim", parts.join(" · ")));
	return textComponent(lines.join("\n"), context.lastComponent);
}

/** Text reads report status, excerpt count, and coverage bounds. */
function textLead(details: Record<string, unknown>): string {
	if (stringField(details, "status") === "no-readable-text") return "no readable text";
	const parts = ["readable"];
	const count = numberField(details, "excerptCount") ?? 0;
	const offset = numberField(details, "excerptOffset") ?? 0;
	const find = asRecord(details.find);
	if (Object.keys(find).length > 0) {
		// Find results keep only matching chunks, so their labels are not a contiguous range.
		parts.push(countLabel(count, "matching excerpt"));
		const first = numberField(find, "firstMatchOffset");
		if (count > 0 && first !== undefined) parts.push(`first E${first + 1}`);
	} else if (count > 0) {
		const first = `E${offset + 1}`;
		parts.push(
			count === 1 ? `${countLabel(count, "excerpt")} (${first})` : `${countLabel(count, "excerpt")} (${first}..E${offset + count})`,
		);
	} else parts.push("0 excerpts");
	if (numberField(details, "nextOffset") !== undefined) parts.push("continuation");
	if (booleanField(details, "extractionTruncated") === true) parts.push("extraction truncated");
	if (booleanField(details, "outputTruncated") === true) parts.push("output truncated");
	return parts.join(" · ");
}

/** Link reads report the link count, page offset, and the budget the next record needs. */
function linksLead(details: Record<string, unknown>): string {
	const count = numberField(details, "linkCount") ?? 0;
	const parts = [countLabel(count, "link")];
	const offset = numberField(details, "linkOffset");
	if (offset !== undefined && offset > 0) parts.push(`offset ${offset}`);
	if (numberField(details, "nextOffset") !== undefined) parts.push("continuation");
	if (booleanField(details, "extractionTruncated") === true) parts.push("extraction truncated");
	if (booleanField(details, "outputTruncated") === true) parts.push("output truncated");
	const required = numberField(details, "requiredMaxBytes");
	if (required !== undefined) parts.push(`next record needs max_bytes ${required}`);
	return parts.join(" · ");
}

export function renderReadResult(
	result: AgentToolResult<unknown>,
	options: ToolRenderResultOptions,
	theme: Theme,
	context: CardContext,
): Component {
	if (options.isPartial) return textComponent(`\n${theme.fg("warning", "Reading the page...")}`, context.lastComponent);
	const output = textContent(result);
	if (context.isError)
		return textComponent(`\n${theme.fg("error", `web_read: ${displayValue(firstLine(output) || "read failed", 200)}`)}`, context.lastComponent);
	const details = asRecord(result.details);
	const lead = stringField(details, "view") === "links" ? linksLead(details) : textLead(details);
	let text = `\n${theme.fg("success", lead)}`;
	const finalUrl = stringField(details, "finalUrl");
	if (finalUrl && finalUrl !== stringField(details, "requestedUrl")) text += theme.fg("dim", ` → ${displayValue(finalUrl, URL_LIMIT)}`);
	if (options.expanded) text += `\n${theme.fg("toolOutput", boundedDisplay(output))}`;
	else text += `\n${theme.fg("dim", expansionHint("result"))}`;
	return textComponent(text, context.lastComponent);
}

/** Search requests show the query and any non-default search controls. */
function searchQualifier(args: Record<string, unknown>): string[] {
	const parts: string[] = [];
	const count = numberField(args, "count");
	if (count !== undefined) parts.push(`count ${count}`);
	const offset = numberField(args, "offset");
	if (offset !== undefined) parts.push(`offset ${offset}`);
	const country = stringField(args, "country");
	if (country) parts.push(`country ${displayValue(country, 4)}`);
	const language = stringField(args, "search_lang");
	if (language) parts.push(`lang ${displayValue(language, 10)}`);
	const freshness = stringField(args, "freshness");
	if (freshness) parts.push(`freshness ${displayValue(freshness, 30)}`);
	const safesearch = stringField(args, "safesearch");
	if (safesearch && safesearch !== "moderate") parts.push(`safesearch ${safesearch}`);
	if (booleanField(args, "extra_snippets") === true) parts.push("extra snippets");
	if (booleanField(args, "spellcheck") === false) parts.push("spellcheck off");
	return parts;
}

export function renderSearchCall(value: unknown, theme: Theme, context: CardContext): Component {
	const args = asRecord(value);
	const query = stringField(args, "query");
	const lines = [heading("web_search", query, theme, QUERY_LIMIT)];
	if (context.expanded) {
		lines.push(expandedArguments(args, theme));
		return textComponent(lines.join("\n"), context.lastComponent);
	}
	const parts = searchQualifier(args);
	if (query.length > QUERY_LIMIT) parts.push(expansionHint("arguments"));
	if (parts.length > 0) lines.push(theme.fg("dim", parts.join(" · ")));
	return textComponent(lines.join("\n"), context.lastComponent);
}

export function renderSearchResult(
	result: AgentToolResult<unknown>,
	options: ToolRenderResultOptions,
	theme: Theme,
	context: CardContext,
): Component {
	if (options.isPartial) return textComponent(`\n${theme.fg("warning", "Searching the web...")}`, context.lastComponent);
	const output = textContent(result);
	if (context.isError)
		return textComponent(`\n${theme.fg("error", `web_search: ${displayValue(firstLine(output) || "search failed", 200)}`)}`, context.lastComponent);
	const details = asRecord(result.details);
	const parts = [countLabel(numberField(details, "resultCount") ?? 0, "result")];
	if (booleanField(details, "moreResultsAvailable") === true) parts.push("more available");
	const altered = stringField(details, "alteredQuery");
	if (altered) parts.push(`altered query ${displayValue(altered, 80)}`);
	if (booleanField(details, "outputTruncated") === true) parts.push("output truncated");
	let text = `\n${theme.fg("success", parts.join(" · "))}`;
	if (options.expanded) text += `\n${theme.fg("toolOutput", boundedDisplay(output))}`;
	else text += `\n${theme.fg("dim", expansionHint("result"))}`;
	return textComponent(text, context.lastComponent);
}
