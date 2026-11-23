import {
	type AgentToolResult,
	type KeybindingHints,
	type Theme,
	type ToolRenderResultOptions,
	truncateToVisualLines,
} from "@earendil-works/pi-coding-agent";
import { type Component, stripTerminalSequences, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const DISPLAY_LIMIT = 32_000;

type Tool = "clipboard_copy" | "clipboard_paste" | "clipboard_list" | "clipboard_get" | "clipboard_restore";
interface CardContext extends Partial<KeybindingHints> {
	expanded: boolean;
	isError: boolean;
	args?: unknown;
	argsComplete?: boolean;
	state?: { hasClipboardResult?: boolean };
}

type Fields = Record<string, unknown>;
function record(value: unknown): Fields {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Fields) : {};
}

function safeText(text: string): string {
	return stripTerminalSequences(text)
		.replace(/\r\n/g, "\n")
		.replace(/[\p{Cc}\p{Cf}]/gu, (char) => (char === "\n" || char === "\t" ? char : ""));
}

function oneLine(value: unknown): string {
	return typeof value === "string" ? safeText(value).replace(/\s+/gu, " ").trim() : "";
}

function count(fields: Fields, key: string): number | undefined {
	const value = fields[key];
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function tally(n: number, unit: string, plural = `${unit}s`): string {
	return `${n} ${n === 1 ? unit : plural}`;
}

function size(fields: Fields): string {
	const chars = count(fields, "chars");
	const lines = count(fields, "lines");
	return [chars === undefined ? "" : tally(chars, "character"), lines === undefined ? "" : tally(lines, "line")]
		.filter(Boolean)
		.join(" · ");
}

function characters(text: string): number {
	let n = 0;
	for (const _ of text) n++;
	return n;
}

function clip(text: string, width: number): string {
	// Pi owns the row background; close only the text styles after the ellipsis.
	return truncateToWidth(text, width, "…").replace(/\x1b\[0m…\x1b\[0m$/u, "…\x1b[22;23;24;25;27;28;29;39m");
}

function rows(text: string, width: number, expanded: boolean): readonly string[] {
	if (!text) return [];
	return expanded ? truncateToVisualLines(text, Infinity, width, 0, "start").visualLines : [clip(text, width)];
}

function hint(theme: Theme, context: Partial<KeybindingHints>): string {
	const key = context.keyText?.("app.tools.expand");
	const action = key
		? (context.keyHint?.("app.tools.expand", "to expand") ?? theme.fg("dim", key) + theme.fg("muted", " to expand"))
		: theme.fg("muted", "click to expand");
	return theme.fg("muted", "... (") + action + theme.fg("muted", ")");
}

/** The result renderer registers its presence before Pi draws the call. */
function atWidth(draw: (width: number) => string[]): Component {
	let previousWidth: number | undefined;
	let lines: string[] = [];
	return {
		render(width) {
			if (width !== previousWidth) {
				lines = draw(width);
				previousWidth = width;
			}
			return lines;
		},
		invalidate() {
			previousWidth = undefined;
		},
	};
}

function callSubject(tool: Tool, args: Fields): string {
	switch (tool) {
		case "clipboard_copy":
			return oneLine(args.label);
		case "clipboard_list":
			return oneLine(args.query) || oneLine(args.date);
		case "clipboard_get":
		case "clipboard_restore":
			return oneLine(args.id);
		case "clipboard_paste":
			return "";
	}
}

function copiedSize(args: Fields, complete: boolean): string {
	if (typeof args.content !== "string") return "";
	return complete ? tally(characters(args.content), "character") : "content still arriving";
}

function callFacts(tool: Tool, args: Fields, copySize: string): string {
	const date = tool !== "clipboard_list" || args.query !== undefined ? oneLine(args.date) : "";
	const source = oneLine(args.sourceId);
	const facts = [date && `date ${date}`, source && `source ${source}`];
	for (const [key, label] of [
		["limit", "limit"],
		["offset", "offset"],
		["max_chars", "max characters"],
	] as const) {
		const value = count(args, key);
		if (value !== undefined) facts.push(`${label} ${value}`);
	}
	if (oneLine(args.cursor)) facts.push("continuation");
	if (tool === "clipboard_copy") facts.push(copySize, args.archive === false ? "skip archive" : "");
	return facts.filter(Boolean).join(" · ");
}

function hiddenCall(tool: Tool, subject: string, facts: string, args: Fields, width: number): boolean {
	return (
		visibleWidth(`${tool} ${subject}`.trimEnd()) > width || visibleWidth(facts) > width || Boolean(oneLine(args.cursor))
	);
}

function expandedArguments(args: Fields, copySize: string): string {
	return Object.entries(args)
		.flatMap(([key, value]) => {
			// No clipboard content from a copy call is displayed, even when expanded.
			if (key === "content") return copySize ? [`  content: ${copySize}`] : [];
			const text = typeof value === "string" ? oneLine(value) : JSON.stringify(value, null, 2);
			return text === undefined ? [] : [`  ${oneLine(key)}: ${safeText(text).replace(/\n/g, "\n    ")}`];
		})
		.join("\n");
}

function renderCall(tool: Tool, value: unknown, theme: Theme, context: CardContext): Component {
	const args = record(value);
	const subject = callSubject(tool, args);
	const copySize = tool === "clipboard_copy" ? copiedSize(args, context.argsComplete !== false) : "";
	const facts = callFacts(tool, args, copySize);
	const title = theme.fg("toolTitle", theme.bold(tool));
	const heading = subject ? `${title} ${theme.fg("accent", subject)}` : title;
	return atWidth((width) => {
		const body = [clip(heading, width), ...rows(facts, width, context.expanded).map((row) => theme.fg("muted", row))];
		const hidden = hiddenCall(tool, subject, facts, args, width);
		if (context.expanded && (hidden || copySize))
			body.push(...rows(expandedArguments(args, copySize), width, true).map((row) => theme.fg("muted", row)));
		if (!context.expanded && hidden && !context.state?.hasClipboardResult && context.keyText?.("app.tools.expand"))
			body.push(clip(hint(theme, context), width));
		return body;
	});
}

/** Search's own model-facing envelope also carries page facts in retained results. */
function resultDetails(tool: Tool, details: unknown, text: string): Fields {
	const fields = record(details);
	if (tool !== "clipboard_list" || count(fields, "count") !== undefined) return fields;
	try {
		const page = record(JSON.parse(text));
		if (
			typeof page.query === "string" &&
			Array.isArray(page.matches) &&
			typeof page.hasMore === "boolean" &&
			typeof page.stop === "string"
		)
			return { ...page, count: page.matches.length };
	} catch {
		/* A recent-list receipt or malformed result is not a search page. */
	}
	return fields;
}

function listOutcome(details: Fields, args: Fields): string | undefined {
	const n = count(details, "count");
	if (n === undefined) return undefined;
	if (typeof args.query === "string" || typeof details.stop === "string") {
		const coverage = details.hasMore === true ? "; the scan has more pages" : "";
		return `${n ? `Found ${tally(n, "match", "matches")}` : "No matches"} on this clipboard archive page${coverage}.`;
	}
	return `${n ? `Returned ${tally(n, "clipboard history entry", "clipboard history entries")}` : "No clipboard history entries"}${details.hasMore === true ? "; more entries follow" : ""}.`;
}

export function restoreOutcome(details: Fields): string {
	const amount = size(details);
	return amount ? `Restored to the clipboard (${amount}).` : "Clipboard restore details are not available.";
}

function outcome(tool: Tool, details: Fields, args: Fields): string {
	const amount = size(details);
	const more = count(details, "nextOffset") === undefined ? "" : "; more content follows";
	switch (tool) {
		case "clipboard_list":
			return listOutcome(details, args) ?? "Clipboard history details are not available.";
		case "clipboard_copy":
			if (!amount) return "Clipboard copy details are not available.";
			return `Copied to the clipboard (${amount})${details.archived === false ? " without archiving" : ""}.`;
		case "clipboard_restore":
			return restoreOutcome(details);
		case "clipboard_paste":
			if (details.chars === 0) return "Clipboard is empty.";
			return amount ? `Read the clipboard (${amount})${more}.` : "Clipboard read details are not available.";
		case "clipboard_get":
			return amount ? `Read the archive entry (${amount})${more}.` : "Clipboard entry details are not available.";
	}
}

function callJson(value: Fields): string {
	return JSON.stringify(value).replace(/[\p{Cc}\p{Cf}]/gu, (char) =>
		char
			.split("")
			.map((unit) => `\\u${unit.charCodeAt(0).toString(16).padStart(4, "0")}`)
			.join(""),
	);
}

function nextCall(tool: Tool, args: Fields, details: Fields): string {
	const offset = count(details, "nextOffset");
	if (
		offset !== undefined &&
		(tool === "clipboard_get" || tool === "clipboard_paste") &&
		typeof details.sourceId === "string"
	) {
		return `${tool} ${callJson({ ...args, offset, sourceId: details.sourceId })}`;
	}
	if (tool === "clipboard_list" && typeof details.nextCursor === "string") {
		const query = args.query ?? details.query;
		if (typeof query === "string")
			return `${tool} ${callJson({ ...args, query, date: args.date ?? details.date, cursor: details.nextCursor })}`;
	}
	return "";
}

interface Receipt {
	outcome: string;
	body: string;
	warning: string;
}

function errorReceipt(tool: Tool, text: string): Receipt {
	// Host argument errors can echo private copy input, even in the first diagnostic line.
	if (tool === "clipboard_copy") return { outcome: "Clipboard copy failed.", body: text, warning: "" };
	const lines = text.split("\n");
	const first = lines.findIndex((line) => oneLine(line));
	return { outcome: oneLine(lines[first]), body: first < 0 ? "" : lines.slice(first + 1).join("\n"), warning: "" };
}

function receipt(tool: Tool, details: Fields, args: Fields, text: string, isError: boolean): Receipt {
	if (isError) return errorReceipt(tool, text);
	const archiveError = tool === "clipboard_copy" ? oneLine(details.archiveError) : "";
	const scan = record(details.scan);
	const warnings = [
		archiveError && `Clipboard history write failed: ${archiveError}`,
		details.retainedTruncated === true && "Retained result was truncated",
		(count(scan, "malformed") ?? 0) + (count(scan, "oversized") ?? 0) > 0 &&
			"Partial coverage: archive records skipped",
	].filter(Boolean);
	const id = !archiveError && tool === "clipboard_copy" ? oneLine(details.id) : "";
	const facts = [
		id && `Archive entry ${id}.`,
		details.controlsEscaped === true && "Terminal controls were escaped.",
	].filter(Boolean);
	const lead = [outcome(tool, details, args), ...facts].join(" ");
	const body = repeatsOutcome(tool, details, args) ? "" : text;
	return {
		outcome: lead,
		body: [body, nextCall(tool, args, details)].filter(Boolean).join("\n"),
		warning: warnings.join("; "),
	};
}

function repeatsOutcome(tool: Tool, details: Fields, args: Fields): boolean {
	if (tool === "clipboard_restore")
		return Boolean(size(details) && oneLine(args.id) && oneLine(args.id) === oneLine(details.id));
	return (
		tool === "clipboard_list" &&
		details.count === 0 &&
		details.hasMore === false &&
		typeof details.stop !== "string" &&
		typeof args.query !== "string"
	);
}

function bound(text: string): { text: string; warning: string } {
	if (text.length <= DISPLAY_LIMIT) return { text, warning: "" };
	const chars = Array.from(text);
	return chars.length > DISPLAY_LIMIT
		? {
				text: chars.slice(0, DISPLAY_LIMIT).join(""),
				warning: `Truncated: showing ${DISPLAY_LIMIT} of ${chars.length} characters`,
			}
		: { text, warning: "" };
}

const progress: Record<Tool, string> = {
	clipboard_copy: "Copying to the clipboard…",
	clipboard_paste: "Reading the clipboard…",
	clipboard_list: "Reading clipboard history…",
	clipboard_get: "Reading the clipboard entry…",
	clipboard_restore: "Restoring to the clipboard…",
};

function renderResult(
	tool: Tool,
	result: AgentToolResult<unknown>,
	options: ToolRenderResultOptions,
	theme: Theme,
	context: CardContext,
): Component {
	if (context.state) context.state.hasClipboardResult = true;
	const args = record(context.args);
	const subject = callSubject(tool, args);
	const copySize = tool === "clipboard_copy" ? copiedSize(args, context.argsComplete !== false) : "";
	const facts = callFacts(tool, args, copySize);
	const discloseCall = (width: number) => hiddenCall(tool, subject, facts, args, width);
	if (options.isPartial)
		return atWidth((width) => [
			"",
			theme.fg("muted", clip(progress[tool], width)),
			...(!options.expanded && discloseCall(width) ? [clip(hint(theme, context), width)] : []),
		]);
	const text = safeText(result.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n"))
		.replace(/\t/g, "   ")
		.trim();
	const details = resultDetails(tool, result.details, text);
	const bounded = bound(text);
	const view = receipt(tool, details, args, bounded.text, context.isError);
	const limit = [view.warning, bounded.warning].filter(Boolean).join("; ");
	const warning = limit ? `[${limit}]` : "";
	const color = context.isError ? "error" : "toolOutput";
	const preview = options.expanded ? view.body : "";
	return atWidth((width) => {
		const body = rows(preview, width, true);
		const lines = [
			"",
			...rows(view.outcome, width, options.expanded).map((row) => theme.fg(color, row)),
			...body.map((row) => theme.fg(color, row)),
			...rows(warning, width, options.expanded).map((row) => theme.fg("warning", row)),
		];
		if (options.expanded) return lines;
		if (view.body || discloseCall(width) || visibleWidth(view.outcome) > width || visibleWidth(warning) > width)
			lines.push(clip(hint(theme, context), width));
		return lines;
	});
}

function call(tool: Tool) {
	return (args: unknown, theme: Theme, context: CardContext) => renderCall(tool, args, theme, context);
}

function result(tool: Tool) {
	return (value: AgentToolResult<unknown>, options: ToolRenderResultOptions, theme: Theme, context: CardContext) =>
		renderResult(tool, value, options, theme, context);
}

export const renderCopyCall = call("clipboard_copy");
export const renderCopyResult = result("clipboard_copy");
export const renderPasteCall = call("clipboard_paste");
export const renderPasteResult = result("clipboard_paste");
export const renderListCall = call("clipboard_list");
export const renderListResult = result("clipboard_list");
export const renderGetCall = call("clipboard_get");
export const renderGetResult = result("clipboard_get");
export const renderRestoreCall = call("clipboard_restore");
export const renderRestoreResult = result("clipboard_restore");
