import {
	type AgentToolResult,
	type KeybindingHints,
	type Theme,
	type ToolRenderResultOptions,
	truncateToVisualLines,
} from "@earendil-works/pi-coding-agent";
import { type Component, visibleWidth } from "@earendil-works/pi-tui";
import {
	atWidth,
	bodyText,
	callJson,
	clipRow,
	count,
	displayBound,
	enteredArguments,
	field,
	fieldRows,
	hint,
	record,
	splitDiagnostic,
} from "./web-read-card.ts";

export { renderReadCall, renderReadResult } from "./web-read-card.ts";

interface CardContext extends Partial<KeybindingHints> {
	expanded: boolean;
	isError: boolean;
	args?: unknown;
	state?: { search?: { correctedQuery: string } };
}

function searchFacts(args: Record<string, unknown>, correctedQuery = ""): string {
	const facts: string[] = [];
	if (correctedQuery) facts.push(`corrected query ${correctedQuery}`);
	for (const [key, label] of [
		["count", "count"],
		["offset", "offset"],
		["country", "country"],
		["search_lang", "language"],
		["freshness", "freshness"],
		["safesearch", "safe search"],
	] as const) {
		const value = count(args, key) ?? field(args, key);
		if (value !== "" && !(key === "safesearch" && value === "moderate")) facts.push(`${label} ${value}`);
	}
	if (args.extra_snippets === true) facts.push("extra snippets");
	if (args.spellcheck === false) facts.push("spellcheck off");
	return facts.join(" · ");
}

function callDisclosure(args: Record<string, unknown>, facts: string, width: number): boolean {
	return visibleWidth(`web_search ${field(args, "query")}`.trimEnd()) > width || visibleWidth(facts) > width;
}

export function renderSearchCall(value: unknown, theme: Theme, context: CardContext): Component {
	const args = record(value);
	const query = field(args, "query");
	const title = theme.fg("toolTitle", theme.bold("web_search"));
	const subject = query ? `${title} ${theme.fg("accent", query)}` : title;
	return atWidth((width) => {
		const facts = searchFacts(args, context.state?.search?.correctedQuery);
		const rows = [
			clipRow(subject, width),
			...fieldRows(facts, width, context.expanded).map((line) => theme.fg("muted", line)),
		];
		if (!callDisclosure(args, facts, width)) return rows;
		if (context.expanded)
			rows.push(...fieldRows(enteredArguments(args), width, true).map((line) => theme.fg("muted", line)));
		else if (!context.state?.search && context.keyText?.("app.tools.expand"))
			rows.push(clipRow(hint(theme, context), width));
		return rows;
	});
}

function searchOutcome(details: Record<string, unknown>): string | undefined {
	const n = count(details, "resultCount");
	if (n === undefined) return undefined;
	const page = count(details, "offset");
	const where = page === undefined ? "on this search page" : `on search page ${page + 1}`;
	const continuation = count(details, "nextOffset") !== undefined ? "; more results follow" : "";
	const limit =
		!continuation && page === 9 && details.moreResultsAvailable === true ? "; search page limit reached" : "";
	const outcome = n === 0 ? "No matches" : `Found ${n} ${n === 1 ? "match" : "matches"}`;
	return `${outcome} ${where}${continuation}${limit}.`;
}

function nextCall(details: Record<string, unknown>, args: Record<string, unknown>): string {
	const offset = count(details, "nextOffset");
	const query = details.query ?? args.query;
	if (offset === undefined || typeof query !== "string") return "";
	const params = { ...args, query, offset, count: count(details, "count") ?? args.count };
	return `web_search ${callJson(params)}`;
}

function matchPreview(text: string): string {
	// The search formatter emits numbered records with indented fields. Its header and notices are outside that frame.
	const start = text.search(/^[1-9]\d*\. /m);
	if (start === -1) return "";
	const lines = text.slice(start).split("\n");
	const end = lines.findIndex((line) => line && !/^(?:[1-9]\d*\. | {3})/.test(line));
	return lines
		.slice(0, end === -1 ? undefined : end)
		.filter((line) => line !== "   Additional excerpts:")
		.map((line) => line.replace(/^( {3})(?:URL|Published|Snippet): /, "$1"))
		.join("\n")
		.trimEnd();
}

function resultData(result: AgentToolResult<unknown>, details: Record<string, unknown>, isError: boolean) {
	const raw = result.content.flatMap((entry) => (entry.type === "text" ? [entry.text] : [])).join("\n");
	const bounded = displayBound(bodyText(raw).trimEnd());
	const preview = isError ? "" : matchPreview(bounded.text);
	const outcome = isError
		? undefined
		: (searchOutcome(details) ?? (preview ? "Search records are available." : undefined));
	if (!outcome) {
		const diagnostic = splitDiagnostic(bounded.text);
		return { ...diagnostic, preview: diagnostic.body, hidden: false, limit: bounded.limit };
	}
	const limits = [
		details.outputTruncated === true ? "Partial coverage: search output shortened" : "",
		bounded.limit,
	].filter(Boolean);
	const hidden = details.outputTruncated === true || (!preview && (count(details, "resultCount") ?? 0) > 0);
	return { outcome, body: bounded.text, preview, hidden, limit: limits.join("; ") };
}

export function renderSearchResult(
	result: AgentToolResult<unknown>,
	{ expanded, isPartial }: ToolRenderResultOptions,
	theme: Theme,
	context: CardContext,
): Component {
	const details = record(result.details);
	const correctedQuery = isPartial ? "" : field(details, "alteredQuery");
	if (context.state) context.state.search = { correctedQuery };
	const args = record(context.args);
	const facts = searchFacts(args, correctedQuery);
	if (isPartial)
		return atWidth((width) => [
			"",
			theme.fg("muted", clipRow("Searching the web…", width)),
			...(!expanded && callDisclosure(args, facts, width) ? [clipRow(hint(theme, context), width)] : []),
		]);
	const view = resultData(result, details, context.isError);
	const next = nextCall(details, args);
	const color = context.isError ? "error" : "toolOutput";
	const limit = view.limit ? `[${view.limit}]` : "";
	return atWidth((width) => {
		const preview = truncateToVisualLines(
			expanded ? view.body : view.preview,
			expanded ? Infinity : 5,
			width,
			0,
			"start",
		);
		const rows = [
			"",
			...fieldRows(view.outcome, width, expanded).map((line) => theme.fg(color, line)),
			...preview.visualLines.map((line) => theme.fg(color, line)),
			...fieldRows(expanded ? next : "", width, true).map((line) => theme.fg("muted", line)),
			...fieldRows(limit, width, expanded).map((line) => theme.fg("warning", line)),
		];
		if (expanded) return rows;
		if (
			preview.skippedCount ||
			view.hidden ||
			next ||
			callDisclosure(args, facts, width) ||
			visibleWidth(view.outcome) > width ||
			visibleWidth(limit) > width
		)
			rows.push(clipRow(hint(theme, context, preview.skippedCount), width));
		return rows;
	});
}
