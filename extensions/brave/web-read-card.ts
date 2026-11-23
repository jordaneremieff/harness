import {
	type AgentToolResult,
	type KeybindingHints,
	type Theme,
	type ToolRenderResultOptions,
	truncateToVisualLines,
} from "@earendil-works/pi-coding-agent";
import { type Component, stripTerminalSequences, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const DISPLAY_LIMIT = 32_000;
const PREVIEW_ROWS = 5;

interface ReadCardContext extends Partial<KeybindingHints> {
	expanded: boolean;
	isError: boolean;
	args?: unknown;
	state?: { read?: { sourceFacts: string[] } };
}

function record(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function safeText(text: string): string {
	return stripTerminalSequences(text)
		.replace(/\r\n/g, "\n")
		.replace(/[\p{Cc}\p{Cf}]/gu, (char) => (char === "\n" || char === "\t" ? char : ""));
}

function oneLine(text: string): string {
	return safeText(text).replace(/\s+/gu, " ").trim();
}

function field(values: Record<string, unknown>, name: string): string {
	const value = values[name];
	return typeof value === "string" ? oneLine(value) : "";
}

function count(values: Record<string, unknown>, name: string): number | undefined {
	const value = values[name];
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function wordCount(n: number, noun: string): string {
	return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

function clipRow(text: string, width: number): string {
	// Pi's box owns the background. End only the row's text styles after a clipped ellipsis.
	return truncateToWidth(text, width, "…").replace(/\x1b\[0m…\x1b\[0m$/u, "…\x1b[22;23;24;25;27;28;29;39m");
}

function hint(theme: Theme, keys: Partial<KeybindingHints>, skipped = 0): string {
	const key = keys.keyText?.("app.tools.expand");
	const action = key
		? (keys.keyHint?.("app.tools.expand", "to expand") ?? theme.fg("dim", key) + theme.fg("muted", " to expand"))
		: theme.fg("muted", "click to expand");
	return (
		theme.fg("muted", `... (${skipped ? `${wordCount(skipped, "more line")}, ` : ""}`) + action + theme.fg("muted", ")")
	);
}

/** Pi builds the two components before it draws either; resolve their rows at the content width. */
function atWidth(draw: (width: number) => string[]): Component {
	let previousWidth: number | undefined;
	let rows: string[] = [];
	return {
		render(width) {
			if (width !== previousWidth) {
				rows = draw(width);
				previousWidth = width;
			}
			return rows;
		},
		invalidate() {
			previousWidth = undefined;
		},
	};
}

function requestFacts(args: Record<string, unknown>): string[] {
	const facts: string[] = [];
	if (args.view === "links") facts.push("view links");
	const find = field(args, "find");
	if (find) facts.push(`find ${find}`);
	for (const [key, label] of [
		["excerpt_offset", "excerpt offset"],
		["link_offset", "link offset"],
		["max_bytes", "max bytes"],
	] as const) {
		const value = count(args, key);
		if (value !== undefined) facts.push(`${label} ${value}`);
	}
	const source = field(args, "expected_source_id");
	if (source) facts.push(`expected source ${source}`);
	return facts;
}

function callDisclosure(args: Record<string, unknown>, facts: string, width: number): boolean {
	return (
		visibleWidth(`web_read ${field(args, "url")}`.trimEnd()) > width ||
		visibleWidth(facts) > width ||
		Object.keys(args).some((key) => key !== "url")
	);
}

function enteredArguments(args: Record<string, unknown>): string {
	return Object.entries(args)
		.map(([key, value]) => {
			const readable = typeof value === "string" ? safeText(value) : JSON.stringify(value, null, 2);
			return `  ${oneLine(key)}: ${(readable ?? "").replace(/\n/g, "\n    ")}`;
		})
		.join("\n")
		.replace(/\t/g, "   ");
}

function fieldRows(text: string, width: number, expanded: boolean): readonly string[] {
	if (!text) return [];
	return expanded ? truncateToVisualLines(text, Infinity, width, 0, "start").visualLines : [clipRow(text, width)];
}

export function renderReadCall(value: unknown, theme: Theme, context: ReadCardContext): Component {
	const args = record(value);
	const subject = field(args, "url");
	const title = theme.fg("toolTitle", theme.bold("web_read"));
	const request = requestFacts(args);
	return atWidth((width) => {
		const source = context.state?.read?.sourceFacts ?? [];
		const facts = [...source, ...request].join(" · ");
		const rows = [clipRow(subject ? `${title} ${theme.fg("accent", subject)}` : title, width)];
		rows.push(...fieldRows(facts, width, context.expanded).map((line) => theme.fg("muted", line)));
		if (!callDisclosure(args, facts, width)) return rows;
		if (context.expanded)
			rows.push(...fieldRows(enteredArguments(args), width, true).map((line) => theme.fg("muted", line)));
		else if (!context.state?.read && context.keyText?.("app.tools.expand"))
			rows.push(clipRow(hint(theme, context), width));
		return rows;
	});
}

function sourceFacts(details: Record<string, unknown>): string[] {
	const title = field(details, "title");
	const source = field(details, "sourceId");
	const finalUrl = field(details, "finalUrl");
	const requested = field(details, "requestedUrl");
	return [
		finalUrl && finalUrl !== requested ? `final URL ${finalUrl}` : "",
		title,
		source && `source ${source}`,
	].filter(Boolean);
}

function excerptOutcome(details: Record<string, unknown>, matching: boolean): string | undefined {
	if (details.status === "no-readable-text") return "No readable text in the retained page";
	const n = count(details, "excerptCount");
	if (details.status !== "readable" || n === undefined) return undefined;
	const unit = matching ? "matching excerpt" : "excerpt";
	if (!n) return `No ${unit}s in this page of retained results`;
	const outcome = `Returned ${wordCount(n, unit)}`;
	if (matching) {
		const first = count(record(details.find), "firstMatchOffset");
		return first === undefined ? outcome : `${outcome} (first E${first + 1})`;
	}
	const offset = count(details, "excerptOffset");
	if (offset === undefined) return outcome;
	return n === 1 ? `${outcome} (E${offset + 1})` : `${outcome} (E${offset + 1}..E${offset + n})`;
}

function linkOutcome(details: Record<string, unknown>, matching: boolean): string | undefined {
	const n = count(details, "linkCount");
	if (n === undefined) return undefined;
	const unit = matching ? "matching link" : "link";
	if (!n)
		return count(details, "requiredMaxBytes") === undefined
			? `No ${unit}s in this page of retained results`
			: "No complete link returned";
	const offset = count(details, "linkOffset");
	const origin = offset ? ` from link offset ${offset}` : "";
	return `Returned ${wordCount(n, unit)}${origin}`;
}

function readOutcome(details: Record<string, unknown>): string | undefined {
	const links = details.view === "links";
	const matching = typeof record(details.find).query === "string";
	const outcome = links ? linkOutcome(details, matching) : excerptOutcome(details, matching);
	if (!outcome) return undefined;
	const required = links ? count(details, "requiredMaxBytes") : undefined;
	if (required !== undefined) return `${outcome}; retry with max_bytes ${required}.`;
	return count(details, "nextOffset") === undefined ? `${outcome}.` : `${outcome}; more retained results follow.`;
}

function continuationCall(details: Record<string, unknown>, args: Record<string, unknown>): string {
	const next = count(details, "nextOffset");
	const url = field(details, "requestedUrl") || field(args, "url");
	const source = field(details, "sourceId");
	if (next === undefined || !url || !source) return "";
	const links = details.view === "links";
	const find = record(details.find).query;
	const budget = count(details, "requiredMaxBytes") ?? count(args, "max_bytes");
	return `web_read ${safeText(
		JSON.stringify({
			url,
			...(links ? { view: "links", link_offset: next } : { excerpt_offset: next }),
			expected_source_id: source,
			...(typeof find === "string" ? { find } : {}),
			...(budget === undefined ? {} : { max_bytes: budget }),
		}),
	)}`;
}

function bodyText(text: string): string {
	return safeText(text).replace(/\t/g, "   ");
}

function splitDiagnostic(text: string): { outcome: string; body: string } {
	const lines = text.split("\n");
	const first = lines.findIndex((line) => line.trim());
	return first < 0
		? { outcome: "", body: "" }
		: {
				outcome: oneLine(lines[first] ?? ""),
				body: lines
					.slice(first + 1)
					.join("\n")
					.trim(),
			};
}

function displayBound(text: string): { text: string; limit?: string } {
	if (text.length <= DISPLAY_LIMIT) return { text };
	const chars = Array.from(text);
	return chars.length > DISPLAY_LIMIT
		? {
				text: chars.slice(0, DISPLAY_LIMIT).join(""),
				limit: `Truncated: showing ${DISPLAY_LIMIT} of ${chars.length} characters`,
			}
		: { text };
}

function expandedFetchFacts(details: Record<string, unknown>): string {
	const redirects = count(details, "redirectCount");
	const bytes = count(details, "downloadedBytes");
	return [
		redirects === undefined ? "" : wordCount(redirects, "redirect"),
		bytes === undefined ? "" : `${wordCount(bytes, "byte")} downloaded`,
	]
		.filter(Boolean)
		.join(" · ");
}

function limitText(details: Record<string, unknown>, displayLimit?: string): string {
	const limits: string[] = [];
	if (details.extractionTruncated === true) limits.push("Partial coverage: extraction truncated");
	else if (details.outputTruncated === true && count(details, "nextOffset") === undefined)
		limits.push("Partial coverage: output truncated");
	if (displayLimit) limits.push(displayLimit);
	return limits.length ? `[${limits.join("; ")}]` : "";
}

export function renderReadResult(
	result: AgentToolResult<unknown>,
	options: ToolRenderResultOptions,
	theme: Theme,
	context: ReadCardContext,
): Component {
	const details = record(result.details);
	const source = options.isPartial ? [] : sourceFacts(details);
	if (context.state) context.state.read = { sourceFacts: source };
	const args = record(context.args);
	const facts = [...source, ...requestFacts(args)].join(" · ");
	const needsCallHint = (width: number) => callDisclosure(args, facts, width);
	if (options.isPartial)
		return atWidth((width) => [
			"",
			theme.fg("muted", clipRow("Reading the page…", width)),
			...(!options.expanded && needsCallHint(width) ? [clipRow(hint(theme, context), width)] : []),
		]);

	const output = result.content.flatMap((entry) => (entry.type === "text" ? [entry.text] : [])).join("\n");
	const fromDetails = context.isError ? undefined : readOutcome(details);
	const bounded = displayBound(bodyText(output).trimEnd());
	const { outcome, body } = fromDetails ? { outcome: fromDetails, body: bounded.text } : splitDiagnostic(bounded.text);
	const offset = fromDetails ? count(details, "previewOffset") : undefined;
	// The producer locates records in the raw result, before display sanitisation changes its length.
	const start = offset !== undefined && offset <= output.length ? bodyText(output.slice(0, offset)).length : 0;
	const bodyToDraw = options.expanded ? body : body.slice(start);
	const supplemental = [expandedFetchFacts(details), continuationCall(details, args)].filter(Boolean).join("\n");
	const limit = limitText(details, bounded.limit);
	const color = context.isError ? "error" : "toolOutput";
	return atWidth((width) => {
		const preview = truncateToVisualLines(bodyToDraw, options.expanded ? Infinity : PREVIEW_ROWS, width, 0, "start");
		const rows = [
			"",
			...fieldRows(outcome, width, options.expanded).map((line) => theme.fg(color, line)),
			...preview.visualLines.map((line) => theme.fg(color, line)),
			...fieldRows(options.expanded ? supplemental : "", width, true).map((line) => theme.fg("muted", line)),
			...fieldRows(limit, width, options.expanded).map((line) => theme.fg("warning", line)),
		];
		if (options.expanded) return rows;
		if (
			preview.skippedCount ||
			start > 0 ||
			supplemental ||
			needsCallHint(width) ||
			visibleWidth(outcome) > width ||
			visibleWidth(limit) > width
		)
			rows.push(clipRow(hint(theme, context, preview.skippedCount), width));
		return rows;
	});
}
