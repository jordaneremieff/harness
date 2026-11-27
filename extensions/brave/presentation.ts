import type { AgentToolResult, KeybindingHints, Theme, ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
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
	outcomeRow,
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

function clippedCall(args: Record<string, unknown>, width: number): boolean {
	return visibleWidth(`web_search ${field(args, "query")}`.trimEnd()) > width;
}

export function renderSearchCall(value: unknown, theme: Theme, context: CardContext): Component {
	const args = record(value);
	const query = field(args, "query");
	const title = theme.fg("toolTitle", theme.bold("web_search"));
	const subject = query ? `${title} ${theme.fg("accent", query)}` : title;
	return atWidth((width) => {
		const facts = searchFacts(args, context.state?.search?.correctedQuery);
		const rows = [clipRow(subject, width)];
		const clipped = clippedCall(args, width);
		if (context.expanded) {
			rows.push(...fieldRows(facts, width, true).map((line) => theme.fg("muted", line)));
			if (clipped || visibleWidth(facts) > width)
				rows.push(...fieldRows(enteredArguments(args), width, true).map((line) => theme.fg("muted", line)));
		} else if ((facts || clipped) && !context.state?.search && context.keyText?.("app.tools.expand")) {
			rows.push(clipRow(hint(theme, context), width));
		}
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

function resultData(result: AgentToolResult<unknown>, details: Record<string, unknown>, isError: boolean) {
	const raw = result.content.flatMap((entry) => (entry.type === "text" ? [entry.text] : [])).join("\n");
	const bounded = displayBound(bodyText(raw).trimEnd());
	const outcome = isError
		? undefined
		: (searchOutcome(details) ?? (/^[1-9]\d*\. /m.test(bounded.text) ? "Search records are available." : undefined));
	if (!outcome) return { ...splitDiagnostic(bounded.text), coverage: "", limit: bounded.limit };
	const coverage = details.outputTruncated === true ? "search output shortened" : "";
	const limit = [coverage && `Partial coverage: ${coverage}`, bounded.limit].filter(Boolean).join("; ");
	// A complete empty page contains no ranked records to disclose.
	const body = count(details, "resultCount") === 0 && !coverage ? "" : bounded.text;
	return { outcome, body, coverage, limit };
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
	const needsCallHint = (width: number) => facts || clippedCall(args, width);
	if (isPartial)
		return atWidth((width) => [
			"",
			theme.fg("muted", clipRow("Searching the web…", width)),
			...(!expanded && needsCallHint(width) ? [clipRow(hint(theme, context), width)] : []),
		]);
	const view = resultData(result, details, context.isError);
	const next = nextCall(details, args);
	const color = context.isError ? "error" : "toolOutput";
	const limit = view.limit ? `[${view.limit}]` : "";
	return atWidth((width) => {
		if (!expanded) {
			const hidden = view.body || next || limit || needsCallHint(width) || visibleWidth(view.outcome) > width;
			return [
				"",
				...(view.outcome ? [outcomeRow(view.outcome, view.coverage, width, theme, context.isError)] : []),
				...(hidden ? [clipRow(hint(theme, context), width)] : []),
			];
		}
		return [
			"",
			...fieldRows(view.outcome, width, true).map((line) => theme.fg(color, line)),
			...fieldRows(view.body, width, true).map((line) => theme.fg(color, line)),
			...fieldRows(next, width, true).map((line) => theme.fg("muted", line)),
			...fieldRows(limit, width, true).map((line) => theme.fg("warning", line)),
		];
	});
}
