/** Terminal cards for source identity, retained evidence, and coverage bounds. */
import type { AgentToolResult, Theme, ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import type { KeybindingHints } from "@earendil-works/pi-coding-agent";
import { Text, type Component } from "@earendil-works/pi-tui";

export { renderReadCall, renderReadResult } from "./web-read-card.ts";

const RESULT_DISPLAY_LIMIT = 32_000;
const QUERY_LIMIT = 160;

interface CardContext extends Partial<KeybindingHints> {
	expanded: boolean;
	isError: boolean;
	args?: unknown;
	lastComponent?: Component;
}

function asRecord(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
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
	return (
		output
			.split("\n")
			.find((line) => line.trim().length > 0)
			?.trim() ?? ""
	);
}

function textComponent(text: string, previous?: Component): Text {
	const component = previous instanceof Text ? previous : new Text("", 0, 0);
	component.setText(text);
	return component;
}

/** The host injects keyText with the operator's configured bindings; without it the hint names no key. */
function expansionHint(subject: string, keys: Partial<KeybindingHints>): string {
	const key = keys.keyText?.("app.tools.expand");
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

function errorResult(
	name: string,
	output: string,
	options: ToolRenderResultOptions,
	theme: Theme,
	context: CardContext,
): Component {
	const summary = `${name}: ${displayValue(firstLine(output) || "request failed", 200)}`;
	return textComponent(
		`\n${theme.fg("error", summary)}${options.expanded ? `\n${theme.fg("toolOutput", boundedDisplay(output))}` : ""}`,
		context.lastComponent,
	);
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
	if (query.length > QUERY_LIMIT) parts.push(expansionHint("arguments", context));
	if (parts.length > 0) lines.push(theme.fg("dim", parts.join(" · ")));
	return textComponent(lines.join("\n"), context.lastComponent);
}

export function renderSearchResult(
	result: AgentToolResult<unknown>,
	options: ToolRenderResultOptions,
	theme: Theme,
	context: CardContext,
): Component {
	if (options.isPartial)
		return textComponent(`\n${theme.fg("warning", "Searching the web...")}`, context.lastComponent);
	const output = textContent(result);
	if (context.isError) return errorResult("web_search", output, options, theme, context);
	const details = asRecord(result.details);
	const parts = [countLabel(numberField(details, "resultCount") ?? 0, "result")];
	if (booleanField(details, "moreResultsAvailable") === true) parts.push("more available");
	const altered = stringField(details, "alteredQuery");
	if (altered) parts.push(`altered query ${displayValue(altered, 80)}`);
	if (booleanField(details, "outputTruncated") === true) parts.push("output truncated");
	const sources = Array.isArray(details.sources) ? details.sources.slice(0, 3) : [];
	const identities = sources
		.map((source) => {
			const value = asRecord(source);
			return [
				numberField(value, "rank") !== undefined ? `#${numberField(value, "rank")}` : "",
				stringField(value, "title"),
				stringField(value, "domain"),
			]
				.filter(Boolean)
				.map((part) => displayValue(part, 120))
				.join(" · ");
		})
		.filter(Boolean);
	const omitted = Math.max(0, (numberField(details, "resultCount") ?? 0) - identities.length);
	if (omitted > 0 && identities.length > 0) parts.push(`${omitted} more sources in detail`);
	const offset = numberField(details, "offset");
	if (offset !== undefined && offset > 0) parts.push(`page ${offset + 1}`);
	let text = `\n${identities.map((identity) => theme.fg("accent", identity)).join("\n")}${identities.length ? "\n" : ""}${theme.fg("success", parts.join(" · "))}`;
	if (options.expanded) text += `\n${theme.fg("toolOutput", boundedDisplay(output))}`;
	else text += `\n${theme.fg("dim", expansionHint("result", context))}`;
	return textComponent(text, context.lastComponent);
}
