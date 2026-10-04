/**
 * Terminal cards for the stash tools.
 *
 * A collapsed card shows the request on its heading row and at most one
 * qualifier row, then the outcome on one or two summary rows. The expansion
 * hint appears only when the collapsed view hides or clips content, and it
 * rides the row it belongs to instead of taking a row of its own. An expanded
 * card shows the full arguments or result text with controls escaped and a
 * display bound. The cards keep the store's evidence semantics: a written stash
 * is a handover record, and a partial or empty bounded page is not proof of
 * absence.
 */

import {
	type AgentToolResult,
	keyText,
	type Theme,
	type ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { type Component, Text } from "@earendil-works/pi-tui";
import { parseFrontmatter } from "./format.ts";

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

/** Join non-empty parts with the card separator. */
function joinedParts(parts: string[]): string {
	return parts.filter((part) => part !== "").join(" · ");
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
	return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
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
	const heading =
		theme.fg("toolTitle", theme.bold(name)) + (subject ? theme.fg("accent", ` · ${rowSafe(subject)}`) : "");
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

function errorCard(
	name: string,
	result: AgentToolResult<unknown>,
	options: ToolRenderResultOptions,
	theme: Theme,
	context: ResultContext,
): Text {
	const message = previewMark(textContent(result), 300).text || `${name} did not complete`;
	return resultCard({ color: "error", line: message }, "", false, "", options, theme, context);
}

function partialCard(line: string, theme: Theme, context: ResultContext): Text {
	return textComponent(`\n${theme.fg("warning", line)}`, context.lastComponent);
}

export interface WriteDisplayArgs {
	checkpoint?: boolean;
	title?: string;
	summary?: string;
	decisions?: string[];
	openLoops?: string[];
	nextActions?: string[];
	files?: string[];
	tags?: string[];
}

function listLength(value: unknown): number {
	return Array.isArray(value) ? value.length : 0;
}

/** "1 file" / "2 files": the count list reads as prose. */
function countLabel(n: number, singular: string, plural: string): string {
	return `${n} ${n === 1 ? singular : plural}`;
}

/** The request row names what will be stashed and the payload's shape. */
export function renderWriteCall(
	args: Partial<WriteDisplayArgs> | null | undefined,
	theme: Theme,
	context: CallContext,
): Component {
	const title = typeof args?.title === "string" ? previewMark(args.title, 64).text : "";
	const subject = title || (context.argsComplete === false ? "" : "(untitled)");
	const qualifiers: string[] = [];
	if (args?.checkpoint === true) qualifiers.push("checkpoint");
	if (typeof args?.summary === "string") qualifiers.push(`summary ${args.summary.length} chars`);
	if (args) {
		const counts: Array<[number, string, string]> = [
			[listLength(args.decisions), "decision", "decisions"],
			[listLength(args.openLoops), "loop", "loops"],
			[listLength(args.nextActions), "action", "actions"],
			[listLength(args.files), "file", "files"],
			[listLength(args.tags), "tag", "tags"],
		];
		for (const [n, singular, plural] of counts) if (n > 0) qualifiers.push(countLabel(n, singular, plural));
	}
	return callCard("stash_write", subject, qualifiers, true, args, theme, context);
}

/** A write receipt names the stored artifact; it never states the effort is complete. */
export function renderWriteResult(
	result: AgentToolResult<unknown>,
	options: ToolRenderResultOptions,
	theme: Theme,
	context: ResultContext,
): Component {
	if (options.isPartial) return partialCard("Saving stash...", theme, context);
	if (context.isError) return errorCard("stash_write", result, options, theme, context);
	const details = record(result.details);
	const path = typeof details.path === "string" ? previewMark(details.path, 160).text : "";
	if (details.checkpoint === true) {
		return resultCard(
			{ color: "success", line: "checkpoint saved · not listed for pickup" },
			path,
			false,
			textContent(result),
			options,
			theme,
			context,
		);
	}
	const id = typeof details.id === "string" ? previewMark(details.id, 100).text : "";
	if (!id) {
		return resultCard(
			{ color: "muted", line: previewMark(textContent(result), 160).text || "stash_write" },
			"",
			false,
			textContent(result),
			options,
			theme,
			context,
		);
	}
	const state = typeof details.state === "string" ? previewMark(details.state, 40).text : "";
	return resultCard(
		{ color: "success", line: `${id} written${state ? ` · ${state}` : ""}` },
		"",
		false,
		textContent(result),
		options,
		theme,
		context,
	);
}

export interface ListDisplayArgs {
	limit?: number;
	tag?: string;
	state?: string;
	query?: string;
	cursor?: string;
}

/** The subject is the remembered phrase when searching, otherwise the recent list. */
export function renderListCall(
	args: Partial<ListDisplayArgs> | null | undefined,
	theme: Theme,
	context: CallContext,
): Component {
	const query = typeof args?.query === "string" ? previewMark(args.query, 64) : { text: "", clipped: false };
	const subject = query.text ? `"${query.text}"` : "recent";
	const qualifiers: string[] = [];
	let hint = query.clipped;
	if (typeof args?.tag === "string" && args.tag) {
		const tag = previewMark(args.tag, 60);
		qualifiers.push(`tag ${tag.text}`);
		hint = hint || tag.clipped;
	}
	if (typeof args?.state === "string" && args.state) qualifiers.push(`state ${args.state}`);
	if (typeof args?.limit === "number") qualifiers.push(`limit ${args.limit}`);
	if (typeof args?.cursor === "string" && args.cursor) hint = true;
	return callCard("stash_list", subject, qualifiers, hint, args, theme, context);
}

/** Count the match states the search page already reports. */
function stateTally(states: string[]): string {
	const counts = new Map<string, number>();
	for (const state of states) counts.set(state, (counts.get(state) ?? 0) + 1);
	const entries = [...counts.entries()];
	const shown = entries
		.slice(0, 4)
		.map(([state, count]) => `${state} ${count}`)
		.join(", ");
	const omitted = entries.length - 4;
	if (omitted > 0) return `${shown}, +${omitted} more`;
	return shown;
}

function searchPageCard(
	details: Record<string, unknown>,
	result: AgentToolResult<unknown>,
	options: ToolRenderResultOptions,
	theme: Theme,
	context: ResultContext,
): Text {
	const matches = Array.isArray(details.matches) ? details.matches.map(record) : [];
	const skipped = Array.isArray(details.skipped) ? details.skipped.length : 0;
	const complete = record(details.coverage).complete === true;
	const states = matches
		.map((match) => (typeof match.state === "string" ? match.state : ""))
		.filter((state) => state !== "");
	const tally = stateTally(states);
	const continuation = typeof details.nextCursor === "string" && details.nextCursor ? "continuation available" : "";
	const color: OutcomeColor = complete ? (matches.length === 0 ? "muted" : "success") : "warning";
	return resultCard(
		{
			color,
			line: `${countLabel(matches.length, "match", "matches")} · ${skipped} skipped · coverage ${complete ? "complete" : "partial"}`,
		},
		[tally, continuation].filter(Boolean).join(" · "),
		matches.length > 0,
		textContent(result),
		options,
		theme,
		context,
	);
}

function listingCard(
	details: Record<string, unknown>,
	result: AgentToolResult<unknown>,
	options: ToolRenderResultOptions,
	theme: Theme,
	context: ResultContext,
): Text {
	const count = typeof details.count === "number" ? details.count : 0;
	const states = Array.isArray(details.states)
		? details.states.filter((state) => typeof state === "string").map(String)
		: [];
	const tally = stateTally(states);
	const second = details.truncated === true ? `${tally ? `${tally} · ` : ""}list truncated` : tally;
	return resultCard(
		{ color: count > 0 ? "success" : "muted", line: `${countLabel(count, "stash", "stashes")} listed` },
		second,
		count > 0,
		textContent(result),
		options,
		theme,
		context,
	);
}

/**
 * Search pages state matches, skips, and coverage; an empty page inherits the
 * coverage word rather than reading as proof nothing exists.
 */
export function renderListResult(
	result: AgentToolResult<unknown>,
	options: ToolRenderResultOptions,
	theme: Theme,
	context: ResultContext,
): Component {
	if (options.isPartial) return partialCard("Listing stashes...", theme, context);
	if (context.isError) return errorCard("stash_list", result, options, theme, context);
	const details = record(result.details);
	if (Array.isArray(details.matches)) return searchPageCard(details, result, options, theme, context);
	if (typeof details.count === "number") return listingCard(details, result, options, theme, context);
	return resultCard(
		{ color: "muted", line: previewMark(textContent(result), 160).text || "stash_list" },
		"",
		false,
		textContent(result),
		options,
		theme,
		context,
	);
}

export interface ReadDisplayArgs {
	id: string;
}

export function renderReadCall(
	args: Partial<ReadDisplayArgs> | null | undefined,
	theme: Theme,
	context: CallContext,
): Component {
	const id = typeof args?.id === "string" ? previewMark(args.id, 72) : { text: "", clipped: false };
	const subject = id.text || (context.argsComplete === false ? "" : "(id pending)");
	return callCard("stash_read", subject, [], false, args, theme, context);
}

/** The outcome row separates the returned page from the artifact that remains on disk. */
export function renderReadResult(
	result: AgentToolResult<unknown>,
	options: ToolRenderResultOptions,
	theme: Theme,
	context: ResultContext,
): Component {
	if (options.isPartial) return partialCard("Reading stash...", theme, context);
	if (context.isError) return errorCard("stash_read", result, options, theme, context);
	const details = record(result.details);
	const text = textContent(result);
	const meta = parseFrontmatter(text).meta;
	const state = typeof meta.state === "string" ? previewMark(meta.state, 40).text : "";
	const title = typeof meta.title === "string" ? previewMark(meta.title, 80).text : "";
	const lines = typeof details.totalLines === "number" ? `${details.totalLines} lines` : "";
	const truncated = details.truncated === true ? " · truncated, full artifact remains in the file" : "";
	const path = typeof details.path === "string" ? previewMark(details.path, 160).text : "";
	const line =
		state || title
			? joinedParts([state, title, lines]).concat(truncated)
			: `artifact read${lines ? ` · ${lines}` : ""}${truncated}`;
	return resultCard(
		{ color: "success", line },
		"",
		true,
		path ? `path: ${path}\n\n${text}` : text,
		options,
		theme,
		context,
	);
}

export interface EditDisplayArgs {
	id: string;
	expectedDigest: string;
	edits: { oldText: string; newText: string }[];
	allowActive?: boolean;
}

export function renderEditCall(
	args: Partial<EditDisplayArgs> | null | undefined,
	theme: Theme,
	context: CallContext,
): Component {
	const id = typeof args?.id === "string" ? previewMark(args.id, 72).text : "";
	const qualifiers: string[] = [];
	if (Array.isArray(args?.edits)) {
		qualifiers.push(`${args.edits.length} replacement${args.edits.length === 1 ? "" : "s"}`);
	}
	if (args?.allowActive === true) qualifiers.push("active edit acknowledged");
	return callCard("stash_edit", id, qualifiers, true, args, theme, context);
}

export function renderEditResult(
	result: AgentToolResult<unknown>,
	options: ToolRenderResultOptions,
	theme: Theme,
	context: ResultContext,
): Component {
	if (options.isPartial) return partialCard("Editing stash...", theme, context);
	if (context.isError) return errorCard("stash_edit", result, options, theme, context);
	const details = record(result.details);
	const outcome = details.changed === true ? "updated" : details.changed === false ? "unchanged" : "edit result";
	const state = typeof details.state === "string" ? `state: ${previewMark(details.state, 40).text} (unchanged)` : "";
	return resultCard({ color: "success", line: outcome }, state, true, textContent(result), options, theme, context);
}

export interface CompleteDisplayArgs {
	id: string;
	outcome: string;
}

export function renderCompleteCall(
	args: Partial<CompleteDisplayArgs> | null | undefined,
	theme: Theme,
	context: CallContext,
): Component {
	const id = typeof args?.id === "string" ? previewMark(args.id, 72) : { text: "", clipped: false };
	const subject = id.text || (context.argsComplete === false ? "" : "(id pending)");
	const qualifiers: string[] = [];
	let hint = false;
	if (typeof args?.outcome === "string" && args.outcome) {
		const outcome = previewMark(args.outcome, 96);
		qualifiers.push(`outcome: ${outcome.text}`);
		hint = outcome.clipped;
	}
	return callCard("stash_complete", subject, qualifiers, hint, args, theme, context);
}

/** Closing records the terminal outcome; the artifact itself is retained. */
export function renderCompleteResult(
	result: AgentToolResult<unknown>,
	options: ToolRenderResultOptions,
	theme: Theme,
	context: ResultContext,
): Component {
	if (options.isPartial) return partialCard("Closing stash...", theme, context);
	if (context.isError) return errorCard("stash_complete", result, options, theme, context);
	return resultCard(
		{ color: "success", line: "closed · artifact retained" },
		"",
		false,
		textContent(result),
		options,
		theme,
		context,
	);
}

export interface RotateDisplayArgs {
	id: string;
}

export function renderRotateCall(
	args: Partial<RotateDisplayArgs> | null | undefined,
	theme: Theme,
	context: CallContext,
): Component {
	const id = typeof args?.id === "string" ? previewMark(args.id, 72) : { text: "", clipped: false };
	const subject = id.text || (context.argsComplete === false ? "" : "(id pending)");
	return callCard("stash_rotate", subject, [], false, args, theme, context);
}

/** Rotation archives the artifact; the file stays recoverable in the store's trash. */
export function renderRotateResult(
	result: AgentToolResult<unknown>,
	options: ToolRenderResultOptions,
	theme: Theme,
	context: ResultContext,
): Component {
	if (options.isPartial) return partialCard("Rotating stash...", theme, context);
	if (context.isError) return errorCard("stash_rotate", result, options, theme, context);
	const details = record(result.details);
	const archivePath = typeof details.archivePath === "string" ? previewMark(details.archivePath, 160).text : "";
	return resultCard(
		{ color: "success", line: "rotated · recoverable" },
		archivePath,
		false,
		textContent(result),
		options,
		theme,
		context,
	);
}
