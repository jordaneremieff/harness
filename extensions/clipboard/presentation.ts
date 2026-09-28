/** Terminal cards for the clipboard tools: sizes, ids, and outcomes without archived content. */
import type { AgentToolResult, Theme, ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import { keyText } from "@earendil-works/pi-coding-agent";
import { Text, type Component } from "@earendil-works/pi-tui";
import { sanitizeTerminalText } from "./text.ts";

const RESULT_DISPLAY_LIMIT = 32_000;

interface CardContext {
	expanded: boolean;
	isError: boolean;
	args?: unknown;
	argsComplete?: boolean;
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

/** Controls become text and whitespace collapses, so a summary stays on one row. */
function displayValue(value: string, limit: number): string {
	return clip(sanitizeTerminalText(value).text.replace(/\s+/gu, " ").trim(), limit) || "(empty)";
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
	const safe = sanitizeTerminalText(value).text;
	const prefix = clip(safe, RESULT_DISPLAY_LIMIT);
	return prefix.length < safe.length
		? `${prefix}\n[Display limit. The full text remains in the native tool history.]`
		: safe;
}

function expandedArguments(args: Record<string, unknown>, theme: Theme): string {
	return theme.fg("toolOutput", boundedDisplay(JSON.stringify(args, null, 2) ?? "(none)"));
}

function heading(name: string, subject: string, theme: Theme, limit = 100): string {
	return subject
		? theme.fg("toolTitle", theme.bold(name)) + theme.fg("accent", ` · ${displayValue(subject, limit)}`)
		: theme.fg("toolTitle", theme.bold(name));
}

function sizeLine(lines: number | undefined, chars: number | undefined): string {
	const parts: string[] = [];
	if (chars !== undefined) parts.push(`${chars} chars`);
	if (lines !== undefined) parts.push(`${lines} lines`);
	return parts.join(" · ");
}

function continuationNote(next: number | undefined): string {
	return next === undefined ? "" : `continuation offset ${next}`;
}

function archiveNote(details: Record<string, unknown>, theme: Theme): string {
	const error = details.archiveError;
	return typeof error === "string" && error
		? theme.fg("warning", ` · archive write failed: ${displayValue(error, 160)}`)
		: "";
}

/** Copy requests show the label and content size; the content itself stays out of the card. */
export function renderCopyCall(value: unknown, theme: Theme, context: CardContext): Component {
	const args = asRecord(value);
	const lines = [heading("clipboard_copy", stringField(args, "label"), theme)];
	if (context.expanded) {
		lines.push(expandedArguments(args, theme));
		return textComponent(lines.join("\n"), context.lastComponent);
	}
	const content = stringField(args, "content");
	if (content) {
		const size = context.argsComplete === false ? "content pending" : `${content.length} UTF-16 code units`;
		lines.push(theme.fg("dim", `${size} · ${expansionHint("arguments")}`));
	}
	return textComponent(lines.join("\n"), context.lastComponent);
}

export function renderCopyResult(
	result: AgentToolResult<unknown>,
	options: ToolRenderResultOptions,
	theme: Theme,
	context: CardContext,
): Component {
	if (options.isPartial) return textComponent(`\n${theme.fg("warning", "Copying to the clipboard...")}`, context.lastComponent);
	const output = textContent(result);
	if (context.isError)
		return textComponent(`\n${theme.fg("error", `clipboard_copy: ${displayValue(firstLine(output) || "copy failed", 200)}`)}`, context.lastComponent);
	const details = asRecord(result.details);
	let text = `\n${theme.fg("success", `copied ${sizeLine(numberField(details, "lines"), numberField(details, "chars"))}`)}`;
	const id = stringField(details, "id");
	if (id) text += theme.fg("dim", ` · id ${displayValue(id, 80)}`);
	text += archiveNote(details, theme);
	text += options.expanded ? `\n${theme.fg("toolOutput", boundedDisplay(output))}` : `\n${theme.fg("dim", expansionHint("result"))}`;
	return textComponent(text, context.lastComponent);
}

/** Paste requests name only their page bounds; the clipboard text stays out of the card. */
export function renderPasteCall(value: unknown, theme: Theme, context: CardContext): Component {
	const args = asRecord(value);
	const lines = [heading("clipboard_paste", "", theme)];
	const parts: string[] = [];
	const offset = numberField(args, "offset");
	const max = numberField(args, "max_chars");
	if (offset !== undefined && offset > 0) parts.push(`offset ${offset}`);
	if (max !== undefined) parts.push(`max ${max}`);
	if (parts.length > 0) lines.push(theme.fg("dim", parts.join(" · ")));
	if (context.expanded) lines.push(expandedArguments(args, theme));
	return textComponent(lines.join("\n"), context.lastComponent);
}

export function renderPasteResult(
	result: AgentToolResult<unknown>,
	options: ToolRenderResultOptions,
	theme: Theme,
	context: CardContext,
): Component {
	if (options.isPartial) return textComponent(`\n${theme.fg("warning", "Reading the clipboard...")}`, context.lastComponent);
	const output = textContent(result);
	if (context.isError)
		return textComponent(`\n${theme.fg("error", `clipboard_paste: ${displayValue(firstLine(output) || "paste failed", 200)}`)}`, context.lastComponent);
	const details = asRecord(result.details);
	const chars = numberField(details, "chars");
	if (chars === 0) return textComponent(`\n${theme.fg("success", "clipboard is empty")}`, context.lastComponent);
	const page = continuationNote(numberField(details, "nextOffset"));
	let text = `\n${theme.fg("success", `clipboard ${sizeLine(numberField(details, "lines"), chars)}${page ? ` · ${page}` : ""}`)}`;
	if (booleanField(details, "controlsEscaped") === true) text += theme.fg("dim", " · controls escaped");
	text += options.expanded ? `\n${theme.fg("toolOutput", boundedDisplay(output))}` : `\n${theme.fg("dim", expansionHint("result"))}`;
	return textComponent(text, context.lastComponent);
}

/** List requests name the query or date; archive previews stay out of the collapsed card. */
export function renderListCall(value: unknown, theme: Theme, context: CardContext): Component {
	const args = asRecord(value);
	const query = stringField(args, "query");
	const date = stringField(args, "date");
	const lines = [heading("clipboard_list", query ? `query ${displayValue(query, 120)}` : date, theme)];
	const parts: string[] = [];
	if (query && date) parts.push(`date ${displayValue(date, 20)}`);
	const limit = numberField(args, "limit");
	if (limit !== undefined) parts.push(`limit ${limit}`);
	if (stringField(args, "cursor")) parts.push("continuation");
	if (parts.length > 0) lines.push(theme.fg("dim", parts.join(" · ")));
	if (context.expanded) lines.push(expandedArguments(args, theme));
	return textComponent(lines.join("\n"), context.lastComponent);
}

export function renderListResult(
	result: AgentToolResult<unknown>,
	options: ToolRenderResultOptions,
	theme: Theme,
	context: CardContext,
): Component {
	if (options.isPartial) return textComponent(`\n${theme.fg("warning", "Listing clipboard history...")}`, context.lastComponent);
	const output = textContent(result);
	if (context.isError)
		return textComponent(`\n${theme.fg("error", `clipboard_list: ${displayValue(firstLine(output) || "list failed", 200)}`)}`, context.lastComponent);
	const searching = stringField(context.args, "query") !== "";
	const details = asRecord(result.details);
	const count = numberField(details, "count") ?? 0;
	const noun = count === 1 ? (searching ? "match" : "entry") : searching ? "matches" : "entries";
	let lead = `${count} ${noun}`;
	if (booleanField(details, "hasMore") === true)
		lead += searching ? " · more available (not absence)" : " · more available";
	else if (searching) lead += " · end of scan";
	let text = `\n${theme.fg("success", lead)}`;
	if (stringField(details, "nextCursor")) text += theme.fg("dim", " · continuation");
	text += options.expanded ? `\n${theme.fg("toolOutput", boundedDisplay(output))}` : `\n${theme.fg("dim", expansionHint("result"))}`;
	return textComponent(text, context.lastComponent);
}

/** Get requests name the entry id and page; entry text stays out of the collapsed card. */
export function renderGetCall(value: unknown, theme: Theme, context: CardContext): Component {
	const args = asRecord(value);
	const lines = [heading("clipboard_get", stringField(args, "id"), theme)];
	const parts: string[] = [];
	const date = stringField(args, "date");
	if (date) parts.push(`date ${displayValue(date, 20)}`);
	const offset = numberField(args, "offset");
	if (offset !== undefined && offset > 0) parts.push(`offset ${offset}`);
	const max = numberField(args, "max_chars");
	if (max !== undefined) parts.push(`max ${max}`);
	if (parts.length > 0) lines.push(theme.fg("dim", parts.join(" · ")));
	if (context.expanded) lines.push(expandedArguments(args, theme));
	return textComponent(lines.join("\n"), context.lastComponent);
}

export function renderGetResult(
	result: AgentToolResult<unknown>,
	options: ToolRenderResultOptions,
	theme: Theme,
	context: CardContext,
): Component {
	if (options.isPartial) return textComponent(`\n${theme.fg("warning", "Reading the entry...")}`, context.lastComponent);
	const output = textContent(result);
	if (context.isError)
		return textComponent(`\n${theme.fg("error", `clipboard_get: ${displayValue(firstLine(output) || "read failed", 200)}`)}`, context.lastComponent);
	const details = asRecord(result.details);
	const page = continuationNote(numberField(details, "nextOffset"));
	let text = `\n${theme.fg(
		"success",
		`${sizeLine(numberField(details, "lines"), numberField(details, "chars"))}${page ? ` · ${page}` : ""}`,
	)}`;
	if (booleanField(details, "controlsEscaped") === true) text += theme.fg("dim", " · controls escaped");
	text += options.expanded ? `\n${theme.fg("toolOutput", boundedDisplay(output))}` : `\n${theme.fg("dim", expansionHint("result"))}`;
	return textComponent(text, context.lastComponent);
}

/** Restore requests name the entry id; the result states size and any archive warning. */
export function renderRestoreCall(value: unknown, theme: Theme, context: CardContext): Component {
	const args = asRecord(value);
	const lines = [heading("clipboard_restore", stringField(args, "id"), theme)];
	const date = stringField(args, "date");
	if (date) lines.push(theme.fg("dim", `date ${displayValue(date, 20)}`));
	if (context.expanded) lines.push(expandedArguments(args, theme));
	return textComponent(lines.join("\n"), context.lastComponent);
}

export function renderRestoreResult(
	result: AgentToolResult<unknown>,
	options: ToolRenderResultOptions,
	theme: Theme,
	context: CardContext,
): Component {
	if (options.isPartial)
		return textComponent(`\n${theme.fg("warning", "Restoring to the clipboard...")}`, context.lastComponent);
	const output = textContent(result);
	if (context.isError)
		return textComponent(`\n${theme.fg("error", `clipboard_restore: ${displayValue(firstLine(output) || "restore failed", 200)}`)}`, context.lastComponent);
	const details = asRecord(result.details);
	let text = `\n${theme.fg("success", `restored · ${sizeLine(numberField(details, "lines"), numberField(details, "chars"))}`)}`;
	text += archiveNote(details, theme);
	if (options.expanded) text += `\n${theme.fg("toolOutput", boundedDisplay(output))}`;
	return textComponent(text, context.lastComponent);
}
