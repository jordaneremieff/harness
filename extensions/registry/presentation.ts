/**
 * Terminal cards for the registry tool.
 *
 * The registry tool returns a human-readable text block plus structured
 * details. A collapsed card shows the request on its heading row and at most
 * one qualifier row, then one or two outcome rows built from those details
 * (outcome, counts, continuation, bounds). The expansion hints appear only when
 * the collapsed view hides or clips content, and each rides the row it belongs
 * to. An expanded card shows the full arguments or the bounded result text.
 * Counts never read as a complete inventory: the result text carries the
 * evidence boundaries.
 */

import {
	type AgentToolResult,
	keyText,
	type Theme,
	type ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { type Component, Text } from "@earendil-works/pi-tui";

const DISPLAY_LIMIT = 32_000;

/** Controls render as text, never as terminal commands; newlines keep structure. */
function escapeControls(value: string): string {
	return value.replace(/[\p{Cc}\p{Cf}]/gu, (char) => {
		if (char === "\n") return char;
		if (char === "\t") return "\\t";
		if (char === "\r") return "\\r";
		return `\\u{${(char.codePointAt(0) ?? 0).toString(16)}}`;
	});
}

/** Final card-row text: escape every value and keep the row on one line. */
function rowSafe(value: string): string {
	return escapeControls(value).replace(/\s+/gu, " ").trim();
}

/** Longest prefix that never splits a surrogate pair. */
function clip(value: string, limit: number): string {
	const end = Math.min(value.length, limit);
	return value.slice(0, /[\uD800-\uDBFF]/u.test(value[end - 1] ?? "") ? end - 1 : end);
}

/** Single-line preview plus whether content was dropped. */
function previewMark(value: string, limit: number): { text: string; clipped: boolean } {
	const prefix = clip(value, limit);
	const flat = escapeControls(prefix).replace(/\s+/gu, " ").trim();
	const clipped = value.length > prefix.length;
	return { text: clipped ? `${flat}…` : flat, clipped };
}

/** Escaped body with a display bound; the full text stays in native tool history. */
function boundedBody(value: string): string {
	const prefix = clip(value, DISPLAY_LIMIT);
	return `${escapeControls(prefix)}${value.length > prefix.length ? "\n[Display limit; full text remains in native tool history.]" : ""}`;
}

function textContent(result: AgentToolResult<unknown>): string {
	return result.content
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

function expandHint(subject: string): string {
	const key = keyText("app.tools.expand");
	return key ? `${key} to expand ${subject}` : `Expand for ${subject}`;
}

function record(value: unknown): Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

function textComponent(text: string, previous?: Component): Text {
	const component = previous instanceof Text ? previous : new Text("", 0, 0);
	component.setText(text);
	return component;
}

export interface CallContext {
	expanded?: boolean;
	argsComplete?: boolean;
	lastComponent?: Component;
}

export interface ResultContext {
	isError: boolean;
	lastComponent?: Component;
}

type OutcomeColor = "success" | "muted" | "warning" | "error";

/** Heading row plus one qualifier row; the hint rides the qualifier row. */
function callCard(
	name: string,
	subject: string,
	qualifiers: string[],
	hint: boolean,
	args: unknown,
	theme: Theme,
	context: CallContext,
): Text {
	const heading = theme.fg("toolTitle", theme.bold(name)) + (subject ? theme.fg("accent", ` · ${rowSafe(subject)}`) : "");
	if (context.expanded) {
		return textComponent(
			[heading, theme.fg("toolOutput", boundedBody(JSON.stringify(args ?? {}, null, 2)))].join("\n"),
			context.lastComponent,
		);
	}
	const detail = qualifiers.join(" · ");
	const line = detail
		? theme.fg("muted", rowSafe(detail)) + (hint ? theme.fg("dim", ` · ${expandHint("arguments")}`) : "")
		: hint
			? theme.fg("dim", expandHint("arguments"))
			: "";
	return textComponent(line ? `${heading}\n${line}` : heading, context.lastComponent);
}

/** Outcome row plus at most one summary row; the hint rides the last row. */
function resultCard(
	outcome: { color: OutcomeColor; line: string },
	second: string,
	hint: boolean,
	body: string,
	options: ToolRenderResultOptions,
	theme: Theme,
	context: ResultContext,
): Text {
	const lines = [`\n${theme.fg(context.isError ? "error" : outcome.color, rowSafe(outcome.line))}`];
	if (options.expanded) {
		if (body) lines.push(theme.fg("toolOutput", boundedBody(body)));
	} else {
		const hintSuffix = hint ? theme.fg("dim", `${second ? " · " : ""}${expandHint("result")}`) : "";
		const row = second ? theme.fg("muted", rowSafe(second)) + hintSuffix : hintSuffix;
		if (row) lines.push(row);
	}
	return textComponent(lines.join("\n"), context.lastComponent);
}

function partialCard(line: string, theme: Theme, context: ResultContext): Text {
	return textComponent(`\n${theme.fg("warning", line)}`, context.lastComponent);
}

const OUTCOME_WORD: Record<string, string> = {
	ok: "ok",
	host_summary: "session overview",
	missing: "no match",
	ambiguous: "ambiguous",
	unavailable: "unavailable",
	partial: "partial scan",
	cancelled: "cancelled",
	stale_cursor: "stale cursor",
	io_error: "read error",
	invalid_arguments: "invalid arguments",
};

const OUTCOME_COLOR: Record<string, OutcomeColor> = {
	ok: "success",
	host_summary: "success",
	missing: "muted",
	ambiguous: "warning",
	unavailable: "warning",
	partial: "warning",
	cancelled: "warning",
	stale_cursor: "warning",
	io_error: "error",
	invalid_arguments: "error",
};

function outcomeWord(details: Record<string, unknown>): string {
	const outcome = typeof details.outcome === "string" ? details.outcome : "unknown";
	if (outcome === "partial" && details.settingsCoverage !== undefined) return "partial configuration";
	return OUTCOME_WORD[outcome] ?? outcome;
}

function outcomeColor(details: Record<string, unknown>, isError: boolean): OutcomeColor {
	if (isError) return "error";
	const outcome = typeof details.outcome === "string" ? details.outcome : "";
	return OUTCOME_COLOR[outcome] ?? "muted";
}

function numberField(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/** Count the resource kinds the returned records already carry. */
function kindTally(records: unknown[]): string {
	const counts = new Map<string, number>();
	for (const entry of records) {
		const kind = record(entry).kind;
		if (typeof kind === "string") counts.set(kind, (counts.get(kind) ?? 0) + 1);
	}
	const entries = [...counts.entries()];
	const shown = entries.slice(0, 6).map(([kind, count]) => `${kind} ${count}`).join(", ");
	const omitted = entries.length - 6;
	if (omitted > 0) return `${shown}, +${omitted} more`;
	return shown;
}

function continuationOf(details: Record<string, unknown>): string {
	return typeof details.cursor === "string" && details.cursor ? "continuation available" : "";
}

/** Compact count: 128K, 1M. */
function compactCount(value: number): string {
	if (value >= 1_000_000) return `${Math.round(value / 100_000) / 10}M`;
	if (value >= 1000) return `${Math.round(value / 1000)}K`;
	return String(value);
}

function modelFacts(entry: Record<string, unknown>): string {
	const parts: string[] = [];
	if (entry.available === true) parts.push("available (cached)");
	else if (entry.available === false) parts.push("unavailable (cached)");
	else parts.push("availability unknown");
	if (entry.configuredAuth === true) parts.push("auth configured");
	else if (entry.configuredAuth === false) parts.push("no configured auth");
	if (typeof entry.contextWindow === "number" && entry.contextWindow > 0) parts.push(`${compactCount(entry.contextWindow)} context`);
	if (Array.isArray(entry.supportedThinkingLevels) && entry.supportedThinkingLevels.length > 0) {
		const levels = entry.supportedThinkingLevels.filter((level) => typeof level === "string");
		if (levels.length > 0) parts.push(`thinking ${levels.join(", ")}`);
	}
	return parts.join(" · ");
}

function toolFacts(entry: Record<string, unknown>): string {
	const configured = entry.configured === true ? "configured" : entry.configured === false ? "not configured" : "configured unknown";
	const active = entry.active === true ? "active" : entry.active === false ? "inactive" : "active unknown";
	return `${configured} · ${active}`;
}

/** A one-record page shows that record's key facts instead of a tally of one. */
function singleRecordFacts(records: unknown[]): string {
	if (records.length !== 1) return "";
	const entry = record(records[0]);
	if (entry.kind === "model") return modelFacts(entry);
	if (entry.kind === "tool") return toolFacts(entry);
	return "";
}

function boundsOf(details: Record<string, unknown>): string {
	if (details.pageBlocked === true) return "first record exceeds the result bound";
	const omitted = numberField(details.omittedRecordBlocks, 0);
	if (details.resultBounded === true) return `${omitted} omitted from this page`;
	return "";
}

function joined(parts: string[]): string {
	return parts.filter((part) => part !== "").join(" · ");
}

interface Summary {
	line: string;
	second: string;
	hint: boolean;
}

function hostSummary(details: Record<string, unknown>): Summary {
	const context = record(details.context);
	const parts: string[] = [];
	const model = typeof context.model === "string" ? context.model : "";
	if (model) parts.push(`model ${previewMark(model, 90).text}`);
	if (typeof context.percent === "number") parts.push(`context ${Math.round(context.percent)}%`);
	else if (typeof context.state === "string" && context.state !== "available") parts.push(`context ${context.state}`);
	const counts = record(details.counts);
	const tally = (["tool", "command", "skill", "prompt"] as const)
		.map((kind) => `${kind} ${numberField(counts[kind], 0)}`)
		.join(" · ");
	return { line: joined(["session overview", ...parts]), second: tally, hint: true };
}

function listingSummary(details: Record<string, unknown>): Summary {
	const records = Array.isArray(details.records) ? details.records : [];
	const total = numberField(details.total, records.length);
	const shown = numberField(details.returnedRecords, records.length);
	const chatOnly = typeof details.catalogBoundary === "string";
	const tally = singleRecordFacts(records) || kindTally(records);
	return {
		line: `${outcomeWord(details)} · ${shown} shown of ${total}${chatOnly ? " · chat models only" : ""}`,
		second: joined([tally, chatOnly && total === 0 ? "Classifier/image discovery: codemode models.*" : "",
			details.settingsCoverage !== undefined ? "configured snapshot · responding publishers only" : "", boundsOf(details), continuationOf(details)]),
		hint: total > 0 || chatOnly || details.settingsCoverage !== undefined,
	};
}

function scannedSummary(details: Record<string, unknown>): Summary {
	const resolved = record(details.resolved);
	const kind = typeof resolved.kind === "string" ? resolved.kind : "";
	const name = typeof resolved.name === "string" ? previewMark(resolved.name, 80).text : "";
	const target = [kind, name].filter(Boolean).join(" ");
	const total = numberField(details.total, 0);
	const shown = numberField(details.returnedRecords, total);
	const scan = details.partialScan === true ? "scan partial · absence not established" : "whole file scanned";
	return {
		line: joined([outcomeWord(details), `${shown} of ${total} matches`, target ? `in ${target}` : ""]),
		second: joined([scan, boundsOf(details), continuationOf(details)]),
		hint: total > 0,
	};
}

function simpleSummary(details: Record<string, unknown>): Summary {
	const raw = typeof details.reason === "string" ? details.reason : typeof details.ioError === "string" ? details.ioError : "";
	const reason = raw && raw !== details.outcome ? previewMark(raw, 140).text : "";
	const records = Array.isArray(details.records) ? details.records : [];
	return {
		line: joined([outcomeWord(details), reason]),
		second: joined([boundsOf(details), continuationOf(details)]),
		hint: records.length > 0,
	};
}

export interface RegistryDisplayArgs {
	name?: string;
	match?: string;
	kind?: string;
	search?: string;
	detail?: boolean;
	provider?: string;
	available?: boolean;
	health?: boolean;
	contains?: string;
	limit?: number;
	cursor?: string;
}

/** The subject names the primary lookup argument. */
function subjectOf(args: Partial<RegistryDisplayArgs> | null | undefined): { subject: string; hint: boolean } {
	if (typeof args?.name === "string" && args.name) {
		const name = previewMark(args.name, 80);
		return { subject: name.text, hint: name.clipped };
	}
	if (typeof args?.search === "string" && args.search) {
		const search = previewMark(args.search, 64);
		return { subject: `search "${search.text}"`, hint: search.clipped };
	}
	if (typeof args?.contains === "string" && args.contains) {
		const contains = previewMark(args.contains, 64);
		return { subject: `contains "${contains.text}"`, hint: contains.clipped };
	}
	if (typeof args?.kind === "string" && args.kind) return { subject: args.kind, hint: false };
	if (typeof args?.cursor === "string" && args.cursor) return { subject: "continuation", hint: false };
	return { subject: "session overview", hint: false };
}

function modeQualifiers(args: Partial<RegistryDisplayArgs> | null | undefined): string[] {
	const qualifiers: string[] = [];
	if (args?.match === "substring") qualifiers.push("substring");
	if (args?.detail === true) qualifiers.push("detail");
	if (typeof args?.provider === "string" && args.provider) qualifiers.push(`provider ${previewMark(args.provider, 48).text}`);
	if (args?.available === true) qualifiers.push("available only");
	if (args?.health === true) qualifiers.push("catalog health");
	if (typeof args?.limit === "number") qualifiers.push(`limit ${args.limit}`);
	return qualifiers;
}

function queryQualifiers(args: Partial<RegistryDisplayArgs> | null | undefined, subject: string): string[] {
	const qualifiers: string[] = [];
	if (typeof args?.kind === "string" && args.kind && subject !== args.kind) qualifiers.push(args.kind);
	if (typeof args?.contains === "string" && args.contains && !subject.startsWith("contains ")) {
		qualifiers.push(`contains "${previewMark(args.contains, 48).text}"`);
	}
	if (typeof args?.cursor === "string" && args.cursor) qualifiers.push("continuation");
	return qualifiers;
}

/** The subject names the lookup; the qualifier row carries the mode switches. */
export function renderRegistryCall(
	args: Partial<RegistryDisplayArgs> | null | undefined,
	theme: Theme,
	context: CallContext,
): Component {
	const { subject, hint } = subjectOf(args);
	const qualifiers = [...queryQualifiers(args, subject), ...modeQualifiers(args)];
	return callCard("registry", subject, qualifiers, hint, args, theme, context);
}

/** A collapsed result states the outcome and one summary row of counts or bounds. */
export function renderRegistryResult(
	result: AgentToolResult<unknown>,
	options: ToolRenderResultOptions,
	theme: Theme,
	context: ResultContext,
): Component {
	if (options.isPartial) return partialCard("Reading the registry...", theme, context);
	const details = record(result.details);
	if (Object.keys(details).length === 0) {
		return resultCard(
			{ color: context.isError ? "error" : "muted", line: previewMark(textContent(result), 200).text || "registry" },
			"",
			false,
			textContent(result),
			options,
			theme,
			context,
		);
	}
	const summary = details.host === true
		? hostSummary(details)
		: details.scanned === true
			? scannedSummary(details)
			: Array.isArray(details.records)
				? listingSummary(details)
				: simpleSummary(details);
	return resultCard(
		{ color: outcomeColor(details, context.isError), line: summary.line },
		summary.second,
		summary.hint,
		textContent(result),
		options,
		theme,
		context,
	);
}
