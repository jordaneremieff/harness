/**
 * Terminal cards for the memory tools.
 *
 * Evidence semantics: a bounded page is not proof of absence, so coverage
 * words travel with every page count. A write receipt reports which files
 * changed; a thrown write error may carry the receipt only inside its message
 * text, so the error card recovers it when it parses and otherwise states the
 * write as incomplete rather than guessing. Write call previews never print
 * note payloads: tool argument history cannot be erased after a rejected
 * credential, so payload fields are summarized as withheld lengths.
 */

import { stripVTControlCharacters } from "node:util";
import {
	type AgentToolResult,
	type KeybindingHints,
	type Theme,
	type ToolRenderResultOptions,
	truncateToVisualLines,
} from "@earendil-works/pi-coding-agent";
import { type Component, Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const DISPLAY_LIMIT = 32_000;
const SLUG_LIMIT = 72;
const COMPACT_LIFECYCLE_LIMIT = 80;
/** Timestamp plus the first identifier group; the exact revision stays in the expanded evidence. */
const REVISION_PREVIEW_LIMIT = 28;
const ROW_BUDGET = 100;
const ERROR_LIMIT = 300;
const DIGEST_PREFIX = 8;
const PREVIEW_ARRAY_LIMIT = 20;
const SEARCH_PREVIEW_LINES = 5;
const WITHHOLD_THRESHOLD = 120;
const WRITE_ERROR_PREFIX = "Memory write incomplete: ";
const WITHHELD_KEYS = new Set(["summary", "details", "sources", "reason", "title", "oldText", "newText"]);

type SearchDisclosure = { hasResult: boolean; hidesArgs: (width: number) => boolean };
type MemoryRenderState = { searchDisclosure?: SearchDisclosure };

export interface CallContext extends Partial<KeybindingHints> {
	expanded?: boolean;
	argsComplete?: boolean;
	lastComponent?: Component;
	state?: MemoryRenderState;
}

export interface ResultContext extends Partial<KeybindingHints> {
	isError: boolean;
	lastComponent?: Component;
	state?: MemoryRenderState;
}

type OutcomeColor = "success" | "muted" | "warning" | "error";

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

/**
 * Dense-row bound: include parts while the row fits the budget, highest
 * priority first; the leading part always shows, clipped if it alone exceeds
 * the budget. Rows at or under 100 characters render on one line at 100
 * columns and at most two at 60.
 */
function budgetedRow(parts: string[], budget: number): string {
	const kept: string[] = [];
	let used = 0;
	for (const part of parts) {
		if (part === "") continue;
		const width = part.length + (kept.length ? 3 : 0);
		if (kept.length && used + width > budget) break;
		kept.push(part);
		used += width;
	}
	if (kept.length === 0) return previewMark(parts.find((part) => part !== "") ?? "", budget).text;
	if (kept.length === 1 && used > budget) kept[0] = previewMark(kept[0], budget).text;
	return kept.join(" · ");
}

/** Escaped body with a display bound; the full text stays in native tool history. */
function boundedBody(value: string): string {
	const prefix = clip(value, DISPLAY_LIMIT);
	const escaped = escapeControls(prefix);
	if (value.length === prefix.length && escaped.length <= DISPLAY_LIMIT) return escaped;
	const notice = "\n[Display limit; full text remains in native tool history.]";
	return `${clip(escaped, DISPLAY_LIMIT - notice.length)}${notice}`;
}

function textContent(result: AgentToolResult<unknown>): string {
	return result.content
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

/** The host injects keyText with the operator's configured bindings; without it the hint names no key. */
function expandHint(subject: string, keys: Partial<KeybindingHints>): string {
	const key = keys.keyText?.("app.tools.expand");
	return key ? `${key} to expand ${subject}` : `Expand for ${subject}`;
}

function record(value: unknown): Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function stringList(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function numberField(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function textField(value: unknown): string | null {
	return typeof value === "string" && value !== "" ? value : null;
}

function textComponent(text: string, previous?: Component): Text {
	const component = previous instanceof Text ? previous : new Text("", 0, 0);
	component.setText(text);
	return component;
}

function stringifySafe(value: unknown): string {
	try {
		return JSON.stringify(value ?? {}, null, 2);
	} catch {
		return String(value);
	}
}

/** Withheld marker for any value shape: char count for text, item count for lists. */
function withheldMarker(value: unknown): string {
	if (typeof value === "string") return `<withheld: ${value.length} chars>`;
	if (Array.isArray(value)) return `<withheld: ${value.length} items>`;
	return "<withheld>";
}

/**
 * Replace body fields with withheld markers regardless of length, and bound
 * any other value: strings above the threshold are withheld too, so an
 * unknown long value cannot leak through the preview. Non-body keys are
 * bounded by shape only, never interpreted.
 */
function sanitizeForPreview(value: unknown, key: string | null): unknown {
	if (key !== null && WITHHELD_KEYS.has(key)) return withheldMarker(value);
	if (typeof value === "string") {
		return value.length > WITHHOLD_THRESHOLD ? withheldMarker(value) : value;
	}
	if (Array.isArray(value)) {
		const kept = value.slice(0, PREVIEW_ARRAY_LIMIT).map((item) => sanitizeForPreview(item, null));
		const omitted = value.length - PREVIEW_ARRAY_LIMIT;
		return omitted > 0 ? [...kept, `(+${omitted} more)`] : kept;
	}
	if (value !== null && typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const [entryKey, entryValue] of Object.entries(value)) {
			out[entryKey] = sanitizeForPreview(entryValue, entryKey);
		}
		return out;
	}
	return value;
}

/** Heading row plus one qualifier row; the hint rides the qualifier row. */
function callCard(
	name: string,
	subject: string,
	qualifiers: string[],
	hint: boolean,
	body: string,
	theme: Theme,
	context: CallContext,
): Text {
	const heading =
		theme.fg("toolTitle", theme.bold(name)) + (subject ? theme.fg("accent", ` · ${rowSafe(subject)}`) : "");
	if (context.expanded) {
		return textComponent([heading, theme.fg("toolOutput", boundedBody(body))].join("\n"), context.lastComponent);
	}
	const detail = qualifiers.join(" · ");
	const line = detail
		? theme.fg("muted", rowSafe(detail)) + (hint ? theme.fg("dim", ` · ${expandHint("arguments", context)}`) : "")
		: hint
			? theme.fg("dim", expandHint("arguments", context))
			: "";
	return textComponent(line ? `${heading}\n${line}` : heading, context.lastComponent);
}

/** Outcome and qualification rows, with optional bounded subject previews. */
function resultCard(
	outcome: { color: OutcomeColor; line: string },
	second: string,
	hint: boolean,
	body: string,
	options: ToolRenderResultOptions,
	theme: Theme,
	context: ResultContext,
	previews: string[] = [],
): Text {
	const lines = [`\n${theme.fg(outcome.color, rowSafe(outcome.line))}`];
	if (options.expanded) {
		if (body) lines.push(theme.fg("toolOutput", boundedBody(body)));
	} else {
		const hintSuffix = hint ? theme.fg("dim", `${second ? " · " : ""}${expandHint("result", context)}`) : "";
		const row = second ? theme.fg("muted", rowSafe(second)) + hintSuffix : hintSuffix;
		if (row) lines.push(row);
		for (const preview of previews) lines.push(theme.fg("toolOutput", rowSafe(preview)));
	}
	return textComponent(lines.join("\n"), context.lastComponent);
}

function partialCard(line: string, theme: Theme, context: ResultContext): Text {
	return textComponent(`\n${theme.fg("muted", line)}`, context.lastComponent);
}

function fallbackCard(
	name: string,
	result: AgentToolResult<unknown>,
	options: ToolRenderResultOptions,
	theme: Theme,
	context: ResultContext,
): Text {
	return resultCard(
		{ color: "muted", line: previewMark(textContent(result), ERROR_LIMIT).text || name },
		"",
		false,
		textContent(result),
		options,
		theme,
		context,
	);
}

function errorCard(
	name: string,
	result: AgentToolResult<unknown>,
	options: ToolRenderResultOptions,
	theme: Theme,
	context: ResultContext,
): Text {
	const message = previewMark(textContent(result), ERROR_LIMIT).text || `${name} did not complete`;
	return resultCard(
		{ color: "error", line: message },
		"",
		!!textContent(result),
		textContent(result),
		options,
		theme,
		context,
	);
}

function searchText(value: string): string {
	return stripVTControlCharacters(value).replace(/[\p{Cc}\p{Cf}]/gu, (char) =>
		char === "\n" || char === "\t" ? char : "",
	);
}

function searchRow(value: string): string {
	return searchText(value).replace(/\s+/gu, " ").trim();
}

function searchRows(draw: (width: number) => string[]): Component {
	let cache: { width: number; lines: string[] } | undefined;
	return {
		render(width) {
			if (cache?.width !== width) cache = { width, lines: draw(width) };
			return cache.lines;
		},
		invalidate() {
			cache = undefined;
		},
	};
}

function searchHint(theme: Theme, context: Partial<KeybindingHints>, allowClick: boolean): string {
	const binding = context.keyText?.("app.tools.expand");
	if (!binding && !allowClick) return "";
	const action = binding
		? (context.keyHint?.("app.tools.expand", "to expand") ?? theme.fg("dim", binding) + theme.fg("muted", " to expand"))
		: theme.fg("muted", "click to expand");
	return theme.fg("muted", "... (") + action + theme.fg("muted", ")");
}

function searchLimitBody(value: string, theme: Theme, color: "muted" | "toolOutput" | "error"): string {
	const safe = searchText(value);
	const prefix = clip(safe, DISPLAY_LIMIT);
	return safe.length === prefix.length
		? theme.fg(color, safe)
		: `${theme.fg(color, prefix)}\n${theme.fg("warning", `[Truncated: showing ${[...prefix].length} of ${[...safe].length} characters]`)}`;
}

function searchCallFacts(fields: Record<string, unknown>, queries: number, argsComplete: boolean | undefined): string {
	const facts: string[] = [];
	if (queries > 1) facts.push(`${queries} queries`);
	if (textField(fields.cursor)) facts.push("continuation");
	if (fields.includeRetired === true) facts.push("includes retired");
	if (fields.detail === true) facts.push("full evidence");
	const limit = numberField(fields.limit);
	if (limit !== null && limit > 0) facts.push(`limit ${limit}`);
	else if (fields.query === undefined && argsComplete !== false) facts.push("byte-bounded cues");
	return facts.join(" · ");
}

function searchCall(args: unknown, theme: Theme, context: CallContext): Component {
	const fields = record(args);
	const queries = [fields.query]
		.flat()
		.flatMap((value) => (typeof value === "string" && searchRow(value) ? [value] : []));
	const first = searchText(queries[0] ?? "");
	const query = searchRow(first);
	const subject = query ? ` "${query}"` : context.argsComplete === false ? "" : " browse";
	const heading = theme.fg("toolTitle", theme.bold("memory_search")) + (subject ? theme.fg("accent", subject) : "");
	const factLine = searchCallFacts(fields, queries.length, context.argsComplete);
	const disclosure: SearchDisclosure = {
		hasResult: false,
		hidesArgs: (width) =>
			queries.length > 1 ||
			!!textField(fields.cursor) ||
			query !== first ||
			visibleWidth(heading) > width ||
			visibleWidth(factLine) > width,
	};
	if (context.state) context.state.searchDisclosure = disclosure;
	if (context.expanded) {
		const body = Object.entries(fields)
			.map(
				([key, value]) =>
					`  ${searchRow(key)}: ${(value === null ? "null" : stringifySafe(value)).replaceAll("\n", "\n  ")}`,
			)
			.join("\n");
		return textComponent(
			body ? `${heading}\n${searchLimitBody(body, theme, "muted")}` : heading,
			context.lastComponent,
		);
	}
	const hint = searchHint(theme, context, false);
	return searchRows((width) => {
		const rows = [truncateToWidth(heading, width, "…")];
		if (factLine) rows.push(truncateToWidth(theme.fg("muted", factLine), width, "…"));
		if (hint && !disclosure.hasResult && disclosure.hidesArgs(width)) rows.push(truncateToWidth(hint, width, "…"));
		return rows;
	});
}

function readCall(args: unknown, theme: Theme, context: CallContext): Component {
	const fields = record(args);
	const slugRaw = textField(fields.slug);
	const slug = slugRaw !== null ? previewMark(slugRaw, SLUG_LIMIT) : null;
	const subject = slug ? slug.text : context.argsComplete === false ? "" : "(slug pending)";
	const detail: string[] = [];
	const offset = numberField(fields.offset);
	if (offset !== null && offset > 0) detail.push(`offset ${offset}`);
	const digest = textField(fields.digest);
	if (digest !== null) detail.push(`digest ${previewMark(digest, DIGEST_PREFIX).text}`);
	if (textField(fields.revision)) detail.push(`historical revision ${fields.revision}`);
	return callCard("memory_read", subject, detail, slug?.clipped ?? false, stringifySafe(args), theme, context);
}

/** Total length of the body fields, counted without printing them. */
function payloadChars(fields: Record<string, unknown>): number {
	let total = 0;
	for (const key of WITHHELD_KEYS) {
		const value = fields[key];
		if (typeof value === "string") total += value.length;
		else if (Array.isArray(value)) {
			for (const item of value) {
				if (typeof item === "string") total += item.length;
			}
		}
	}
	return total;
}

/** The write card names the target and mode; body fields stay withheld in every view. */
function writeCall(args: unknown, theme: Theme, context: CallContext): Component {
	const fields = record(args);
	const slugRaw = textField(fields.slug);
	const slug = slugRaw !== null ? previewMark(slugRaw, SLUG_LIMIT) : null;
	const subject = slug ? slug.text : context.argsComplete === false ? "" : "(slug pending)";
	const mode = textField(fields.expectedDigest) !== null ? "update" : "create";
	const chars = payloadChars(fields);
	const detail = chars > 0 ? [mode, `payload ${chars} chars`] : [mode];
	return callCard("memory_write", subject, detail, true, stringifySafe(sanitizeForPreview(args, null)), theme, context);
}

function editCall(args: unknown, theme: Theme, context: CallContext): Component {
	const fields = record(args);
	const slug = textField(fields.slug);
	const subject =
		slug !== null ? previewMark(slug, SLUG_LIMIT).text : context.argsComplete === false ? "" : "(slug pending)";
	const count = Array.isArray(fields.edits) ? fields.edits.length : null;
	const detail = count === null ? ["edit"] : [`${count} ${count === 1 ? "edit" : "edits"}`];
	return callCard("memory_edit", subject, detail, true, stringifySafe(sanitizeForPreview(args, null)), theme, context);
}

function reviewCall(name: string, args: unknown, theme: Theme, context: CallContext): Component {
	const fields = record(args);
	const slug = textField(fields.slug);
	const subject =
		slug !== null ? previewMark(slug, SLUG_LIMIT).text : context.argsComplete === false ? "" : "(slug pending)";
	const detail = [name === "memory_retire" ? "retire" : (textField(fields.outcome) ?? "review")];
	if (fields.reactivate === true) detail.push("reactivation requested");
	return callCard(name, subject, detail, true, stringifySafe(sanitizeForPreview(args, null)), theme, context);
}

/** A page is a query page when the query field holds a formulation, not null. */
function isQueryPage(query: unknown): boolean {
	if (typeof query === "string") return query !== "";
	if (Array.isArray(query)) return query.some((part) => typeof part === "string" && part !== "");
	return false;
}

function countField(value: unknown): number | null {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function counted(count: number, noun: string, plural = `${noun}s`): string {
	return `${count} ${count === 1 ? noun : plural}`;
}

function searchCoverage(details: Record<string, unknown>) {
	const scan = record(details.scan);
	const search = record(details.search);
	const querying = isQueryPage(details.query);
	const issues = countField(scan.issueCount);
	const scanUnavailable = countField(scan.unavailableNotes);
	const queryUnavailable = countField(search.unavailableNotes);
	const unavailable = Math.max(scanUnavailable ?? 0, queryUnavailable ?? 0);
	// scan.complete means this scan visited the whole inventory, not that every source was readable.
	const complete =
		scan.inventoryComplete === true &&
		scan.complete === true &&
		issues === 0 &&
		scanUnavailable === 0 &&
		(!querying || (search.complete === true && queryUnavailable === 0));
	return { complete, issues, unavailable: scanUnavailable === null && queryUnavailable === null ? null : unavailable };
}

function noteHeading(note: Record<string, unknown>, preview = false): string {
	const slug = textField(note.slug) ?? "";
	const title = textField(note.title) ?? "";
	return preview && title !== slug ? joinedParts([title, slug]) : joinedParts([slug, title !== slug ? title : ""]);
}

function matchedTerms(value: unknown): string {
	if (!Array.isArray(value)) return "";
	return value
		.map((value) => {
			if (typeof value === "string") return textField(value) ?? "";
			const match = record(value);
			const term = textField(match.term);
			const fields = stringList(match.fields);
			return term ? `${term}${fields.length ? ` (${fields.join(", ")})` : ""}` : "";
		})
		.filter(Boolean)
		.join("; ");
}

function formulationEvidence(evidence: Record<string, unknown>): string[] {
	const matched = matchedTerms(evidence.matched);
	const missing = stringList(evidence.missing);
	return [matched ? `Matched: ${matched}` : "", missing.length ? `Missing: ${missing.join(", ")}` : ""].filter(Boolean);
}

function numberLines(fields: Array<[string, unknown]>): string[] {
	return fields.flatMap(([label, value]) => (numberField(value) === null ? [] : [`${label}: ${value}`]));
}

function scanEvidence(details: Record<string, unknown>): string[] {
	const scan = record(details.scan);
	const issues = Array.isArray(scan.issues) ? scan.issues.map(record) : [];
	const coverage = searchCoverage(details);
	const traversal = record(details.coverage);
	return [
		`Source coverage: ${coverage.complete ? "complete for this operation" : "partial"}`,
		...(scan.inventoryComplete === true ? ["Filename inventory: complete"] : []),
		...(typeof scan.complete === "boolean"
			? [`Candidates visited by this scan: ${scan.complete ? "all" : "bounded to this window"}`]
			: []),
		...(typeof traversal.traversalComplete === "boolean"
			? [
					`Cursor traversal: ${traversal.traversalComplete ? "reached the end of the inventory" : "has not reached the end of the inventory"}`,
				]
			: []),
		...numberLines([
			["Entries visited", scan.visited],
			["Visit limit", scan.visitCap],
			["Candidate notes", scan.totalCandidates],
			["Window start", scan.windowStart],
			["Window end", scan.windowEnd],
			["Window source bytes", scan.sourceBytes],
			["Unavailable notes", coverage.unavailable],
			["Retired notes in this window", scan.retiredNotes],
			["Retired notes excluded in this window", details.excludedRetired],
			["Scan issues", scan.issueCount],
			["Scan issues shown", scan.issuesShown],
		]),
		...issues
			.map((issue) => joinedParts([textField(issue.code) ?? "", textField(issue.message) ?? ""]))
			.filter(Boolean)
			.map((issue) => `Scan issue: ${issue}`),
	];
}

function queryCoverage(details: Record<string, unknown>): string[] {
	if (!isQueryPage(details.query)) return [];
	const search = record(details.search);
	const summaries = Array.isArray(search.formulations) ? search.formulations.map(record) : [search];
	return [
		`Query coverage: ${searchCoverage(details).complete ? "complete" : "partial"}`,
		...numberLines([
			["Notes searched", search.notesSearched],
			["Source byte limit", search.maxSourceBytes],
		]),
		...(textField(search.ranking) ? [`Ranking: ${search.ranking}; rank is not confidence`] : []),
		...summaries.flatMap((summary) => {
			const ignored = stringList(summary.ignored);
			return ignored.length
				? [`Ignored words${textField(summary.query) ? ` in ${summary.query}` : ""}: ${ignored.join(", ")}`]
				: [];
		}),
	];
}

function searchContinuation(details: Record<string, unknown>): string {
	const cursor = textField(details.nextCursor);
	if (cursor) {
		const args: Record<string, unknown> = {};
		if (isQueryPage(details.query)) args.query = details.query;
		if (typeof details.includeRetired === "boolean") args.includeRetired = details.includeRetired;
		args.cursor = cursor;
		return `Continue with memory_search:\n${JSON.stringify(args, null, 2)}`;
	}
	if (details.hasMore === true) return "This page reports more results but has no continuation cursor.";
	return details.hasMore === false ? "End of this result set; coverage limits still apply." : "";
}

function passageEvidence(value: unknown, query: boolean): string[] {
	const passage = record(value);
	const excerpt = textField(passage.excerpt);
	if (excerpt === null) return query ? ["No source passage in this record."] : [];
	const start = countField(passage.offset);
	const end = countField(passage.endOffset);
	const excerptStart = countField(passage.excerptOffset);
	const excerptEnd = countField(passage.excerptEndOffset);
	return [
		...(start !== null && end !== null ? [`Match [${start}, ${end}) code points`] : []),
		excerptStart !== null && excerptEnd !== null
			? `Source excerpt [${excerptStart}, ${excerptEnd}) code points:`
			: "Source excerpt:",
		excerpt,
	];
}

function formulationLines(formulation: Record<string, unknown>): string[] {
	return [
		...(textField(formulation.query)
			? [
					`Formulation: ${formulation.query}${countField(formulation.rank) === null ? "" : ` · rank ${formulation.rank}`}`,
				]
			: []),
		...formulationEvidence(formulation),
	];
}

function replacementEvidence(note: Record<string, unknown>): string[] {
	if (!Array.isArray(note.replacedMatches) || !note.replacedMatches.length) return [];
	const omitted = numberField(note.omittedReplacedMatches) ?? 0;
	return [
		"Replaced matches:",
		...note.replacedMatches.map((member) => `  - ${noteHeading(record(member))}`),
		...(omitted > 0 ? [`  ${omitted} more replaced ${omitted === 1 ? "match" : "matches"} omitted.`] : []),
	];
}

function noteEvidence(note: Record<string, unknown>, query: boolean): string[] {
	const cues = ["status", "tags", "supersedes", "superseded_by"].flatMap((key) =>
		textField(note[key]) ? [`${key} cue: ${note[key]}`] : [],
	);
	const formulations = Array.isArray(note.formulations) ? note.formulations.map(record) : [];
	const lifecycle = note.lifecycle ? lifecycleView(note) : undefined;
	return [
		"",
		`${numberField(note.rank) !== null ? `${note.rank}. ` : ""}${noteHeading(note)}`,
		...cues,
		...(lifecycle ? [searchLifecycle(note, lifecycle)] : []),
		...(lifecycle?.problem ? [`Lifecycle problem: ${lifecycle.problem}`] : []),
		...freshnessEvidence(note.freshness, true),
		...(textField(note.cueProblem) ? [`Cue problem: ${note.cueProblem}`] : []),
		...(textField(note.digest) ? [`Digest: ${note.digest}`] : []),
		...formulationEvidence(note),
		...formulations.flatMap(formulationLines),
		...passageEvidence(note.sourceMatch, query),
		...(query ? replacementEvidence(note) : []),
	];
}

function searchBody(details: Record<string, unknown>, notes: Record<string, unknown>[]): string {
	const query = details.query;
	const querying = isQueryPage(query);
	const header = [
		querying ? `Query: ${typeof query === "string" ? query : stringList(query).join(" | ")}` : "",
		searchContinuation(details),
		...scanEvidence(details),
		...queryCoverage(details),
		typeof details.includeRetired === "boolean" ? `Includes retired notes: ${details.includeRetired}` : "",
		...numberLines([["Page starts at window offset", details.pageOffset]]),
		textField(record(details.coverage).meaning) ?? "",
		textField(details.guidance) ?? "",
		"Cues and excerpts are discovery evidence. Read selected notes from offset 0 with their digests.",
	].filter(Boolean);
	return [...header, ...notes.flatMap((note) => noteEvidence(note, querying))].join("\n");
}

function searchLifecycle(note: Record<string, unknown>, lifecycle: LifecycleView): string {
	const status = record(note.lifecycle).status;
	return status === "active" || status === "retired" || status === "superseded"
		? lifecycle.label
		: "lifecycle not established";
}

function searchUnstructured(
	result: AgentToolResult<unknown>,
	options: ToolRenderResultOptions,
	theme: Theme,
	context: ResultContext,
): Component {
	const partial = options.isPartial;
	const color = partial ? "muted" : context.isError ? "error" : "toolOutput";
	const safe = partial ? "" : searchText(textContent(result)).trim();
	const first = searchRow(safe.split("\n", 1)[0] ?? "");
	const outcome = partial
		? "Search in progress"
		: first || (context.isError ? "Memory search failed" : "No displayable result");
	if (safe && options.expanded) return textComponent(`\n${searchLimitBody(safe, theme, color)}`, context.lastComponent);
	const hint = options.expanded ? "" : searchHint(theme, context, true);
	return searchRows((width) => {
		const rows = ["", truncateToWidth(theme.fg(color, outcome), width, "…")];
		const hidden = safe !== first || (!!safe && visibleWidth(first) > width);
		if (hint && (hidden || context.state?.searchDisclosure?.hidesArgs(width)))
			rows.push(truncateToWidth(hint, width, "…"));
		return rows;
	});
}

function searchPreview(details: Record<string, unknown>, notes: Record<string, unknown>[]): string {
	const retired = countField(details.excludedRetired);
	return searchText(
		[
			...notes.map((note) =>
				searchRow(
					joinedParts([
						`• ${noteHeading(note, true)}${textField(note.cueProblem) ? " [cue problem]" : ""}`,
						note.lifecycle ? searchLifecycle(note, lifecycleView(note)) : "",
						freshnessFlag(note.freshness),
					]),
				),
			),
			retired ? `${counted(retired, "retired note")} excluded in this window` : "",
			textField(details.guidance) ?? "",
		]
			.filter(Boolean)
			.join("\n"),
	);
}

function searchResult(
	result: AgentToolResult<unknown>,
	options: ToolRenderResultOptions,
	theme: Theme,
	context: ResultContext,
): Component {
	const disclosure = context.state?.searchDisclosure;
	if (disclosure) disclosure.hasResult = true;
	const details = record(result.details);
	const notes = Array.isArray(details.notes) ? details.notes.map(record) : null;
	if (options.isPartial || context.isError || !notes || notes.some((note) => !textField(note.slug)))
		return searchUnstructured(result, options, theme, context);
	const { outcome, warning } = searchOverview(details, notes.length);
	const heading = theme.fg("toolOutput", outcome);
	if (options.expanded) {
		return textComponent(
			["", heading, searchLimitBody(searchBody(details, notes), theme, "toolOutput")].join("\n"),
			context.lastComponent,
		);
	}
	const hint = searchHint(theme, context, true);
	const preview = searchPreview(details, notes);
	return searchRows((width) => {
		const rows = [
			"",
			truncateToWidth(heading, width, "…"),
			...truncateToVisualLines(preview, SEARCH_PREVIEW_LINES, width, 0, "start").visualLines.map((line) =>
				theme.fg("toolOutput", line),
			),
		];
		if (warning) rows.push(truncateToWidth(theme.fg("warning", warning), width, "…"));
		// The expanded evidence is not the rest of this preview, so the hint has no line count.
		if (hint) rows.push(truncateToWidth(hint, width, "…"));
		return rows;
	});
}

function searchCount(details: Record<string, unknown>, returned: number, complete: boolean): string {
	const query = isQueryPage(details.query);
	const noun = query ? "match" : countField(details.excludedRetired) ? "eligible note" : "note";
	const plural = query ? "matches" : `${noun}s`;
	const total = countField(query ? details.totalMatches : details.totalNotes);
	if (returned === 0 && total === 0) {
		if (complete && details.corpusEmpty === true) return "The memory corpus is empty";
		return `No ${plural} returned from this source window`;
	}
	if (total === null || total < returned) return `${counted(returned, noun, plural)} on this page`;
	return `${returned} of ${counted(total, noun, plural)} in this source window`;
}

function searchOverview(details: Record<string, unknown>, returned: number) {
	const coverage = searchCoverage(details);
	const hasCursor = !!textField(details.nextCursor);
	const missingCursor = details.hasMore === true && !hasCursor;
	const more = hasCursor ? "; more pages available" : "";
	const warning = joinedParts([
		coverage.complete ? "" : "Partial source coverage",
		coverage.unavailable ? counted(coverage.unavailable, "unavailable note") : "",
		coverage.issues ? counted(coverage.issues, "scan issue") : "",
		missingCursor ? "Continuation cursor not supplied" : "",
	]);
	return {
		outcome: `${searchCount(details, returned, coverage.complete)}${more}`,
		warning: warning ? `[${warning}]` : "",
	};
}

/** The outcome row separates the returned page from the source that remains on disk. */
function readResult(
	result: AgentToolResult<unknown>,
	options: ToolRenderResultOptions,
	theme: Theme,
	context: ResultContext,
): Component {
	if (options.isPartial) return partialCard("Reading note...", theme, context);
	if (context.isError) return errorCard("memory_read", result, options, theme, context);
	const details = record(result.details);
	const slug = textField(details.slug);
	if (slug === null && typeof details.content !== "string") {
		return fallbackCard("memory_read", result, options, theme, context);
	}
	const shown = numberField(details.contentCodePoints);
	const total = numberField(details.totalCodePoints);
	const size = shown !== null && total !== null ? `${shown} of ${total} chars` : null;
	const more = details.hasMore === true ? " · more" : "";
	const lifecycle = lifecycleView(details);
	const revision = textField(details.revision);
	const line = joinedParts([slug !== null ? previewMark(slug, SLUG_LIMIT).text : "note", size ?? ""]).concat(more);
	return resultCard(
		{ color: freshnessWarning(details.freshness) ? "warning" : lifecycle.color, line },
		budgetedRow(
			[
				previewMark(lifecycle.label, COMPACT_LIFECYCLE_LIMIT).text,
				freshnessFlag(details.freshness),
				revision ? `revision ${previewMark(revision, REVISION_PREVIEW_LIMIT).text}` : "",
				lifecycle.problem ? `Lifecycle problem: ${previewMark(lifecycle.problem, 80).text}` : "",
			],
			ROW_BUDGET,
		),
		true,
		readBody(details, lifecycle, textContent(result)),
		options,
		theme,
		context,
	);
}

type LifecycleView = { label: string; problem: string | null; color: OutcomeColor };

function lifecycleView(details: Record<string, unknown>): LifecycleView {
	const lifecycle = record(details.lifecycle);
	const problem = textField(lifecycle.problem);
	if (details.source === "contract") return { label: "contract source", problem, color: "success" };
	const status =
		lifecycle.status === "active" || lifecycle.status === "superseded" || lifecycle.status === "retired"
			? lifecycle.status
			: "unknown";
	const replacement = textField(lifecycle.supersededBy);
	return {
		label: `${details.source === "history" ? "historical evidence · prior " : ""}status ${status}${replacement ? ` · replacement ${replacement}` : ""}`,
		problem,
		color: details.source === "history" || status !== "active" || problem ? "warning" : "success",
	};
}

/** Exceptional freshness only: policy and deadline details stay in the expanded evidence. */
function freshnessFlag(value: unknown): string {
	const freshness = record(value);
	return joinedParts([
		freshness.deadline === "due" ? "review due" : "",
		Object.keys(record(freshness.concern)).length ? "unresolved concern" : "",
		stringList(freshness.problems).length ? `${stringList(freshness.problems).length} freshness problems` : "",
	]);
}

function freshnessWarning(value: unknown): boolean {
	const freshness = record(value);
	return (
		freshness.deadline === "due" ||
		Object.keys(record(freshness.concern)).length > 0 ||
		stringList(freshness.problems).length > 0
	);
}

function freshnessRecord(label: string, value: unknown, omitMissing: boolean): string[] {
	const evidence = record(value);
	if (!Object.keys(evidence).length) return [];
	const date = textField(evidence.date);
	return [
		...(date || !omitMissing ? [`${label}: ${date ?? "unknown date"}`] : []),
		...["digest", "reason", "sources"].flatMap((field) =>
			textField(evidence[field]) ? [`${label} ${field}: ${evidence[field]}`] : [],
		),
	];
}

function freshnessEvidence(value: unknown, omitMissing = false): string[] {
	const freshness = record(value);
	if (Object.keys(freshness).length === 0) return [];
	const declarations = [
		["evaluatedOn", `Freshness evaluated on: ${textField(freshness.evaluatedOn) ?? "unknown"}`],
		["verified", `Declared verified: ${typeof freshness.verified === "boolean" ? freshness.verified : "unknown"}`],
		["verifiedDate", `Declared verification date: ${textField(freshness.verifiedDate) ?? "none or unknown"}`],
		["policy", `Review policy: ${textField(freshness.policy) ?? "unknown"}`],
		["deadline", `Review deadline: ${textField(freshness.deadline) ?? "unknown"}`],
		["reviewAfter", `Review after: ${textField(freshness.reviewAfter) ?? "none or unknown"}`],
	] as const;
	const lines: string[] = declarations
		.filter(([field]) =>
			omitMissing
				? field === "verified"
					? typeof freshness[field] === "boolean"
					: textField(freshness[field]) !== null
				: Object.hasOwn(freshness, field),
		)
		.map(([, line]) => line);
	lines.push(
		...freshnessRecord("Unresolved concern", freshness.concern, omitMissing),
		...freshnessRecord("Last review", freshness.lastReview, omitMissing),
		...freshnessRecord("Retirement", freshness.retirement, omitMissing),
	);
	lines.push(...stringList(freshness.problems).map((problem) => `Freshness problem: ${problem}`));
	lines.push("Metadata records declarations, not proof of current truth.");
	return lines;
}

function readBody(details: Record<string, unknown>, lifecycle: LifecycleView, fallback: string): string {
	const end = numberField(details.nextOffset);
	const continuation =
		details.hasMore === true
			? `Continue at offset ${end ?? "unknown"} with the same digest${textField(details.revision) ? " and revision" : ""}.`
			: details.hasMore === false
				? "End of source."
				: "Continuation: unknown.";
	const header = [
		lifecycle.label,
		textField(details.revision) ? `Revision: ${details.revision}` : "",
		textField(details.capturedAt) ? `Captured: ${details.capturedAt}` : "",
		textField(details.authority) ?? "",
		lifecycle.problem ? `Lifecycle problem: ${lifecycle.problem}` : "",
		...freshnessEvidence(details.freshness),
		`Digest: ${textField(details.digest) ?? "unknown"}`,
		`Source range: [${numberField(details.offset) ?? "?"}, ${end ?? "?"}) code points`,
		continuation,
	]
		.filter(Boolean)
		.join("\n");
	return `${header}\n\n${typeof details.content === "string" ? details.content : fallback}`;
}

/** Receipt shape written by the memory store. */
function isReceipt(details: Record<string, unknown>): boolean {
	return (
		typeof details.ok === "boolean" ||
		Array.isArray(details.written) ||
		Array.isArray(details.notWritten) ||
		typeof details.initialized === "boolean"
	);
}

/** Recover a receipt thrown inside a MemoryWriteError message; bounded text may not parse. */
function receiptFromMessage(text: string): Record<string, unknown> | null {
	const at = text.indexOf(WRITE_ERROR_PREFIX);
	if (at === -1) return null;
	try {
		return record(JSON.parse(text.slice(at + WRITE_ERROR_PREFIX.length)));
	} catch {
		return null;
	}
}

type ReceiptOutcome = { color: OutcomeColor; line: string; second: string; hint: boolean };

type ReceiptView = {
	written: string[];
	notWritten: string[];
	slugText: string;
	digestPart: string;
	errorText: string;
	counts: string;
	history: string;
};

function receiptView(receipt: Record<string, unknown>): ReceiptView {
	const written = stringList(receipt.written);
	const notWritten = stringList(receipt.notWritten);
	const slug = textField(receipt.slug);
	const digest = textField(receipt.digest);
	const error = textField(receipt.error);
	return {
		written,
		notWritten,
		slugText: slug !== null ? previewMark(slug, SLUG_LIMIT).text : "",
		digestPart: digest !== null ? `digest ${previewMark(digest, DIGEST_PREFIX).text}` : "",
		errorText: error !== null ? previewMark(error, ERROR_LIMIT).text : "",
		counts: `${written.length} written · ${notWritten.length} not written`,
		history: joinedParts([
			Array.isArray(receipt.captured) && receipt.captured.length
				? `${receipt.captured.length} prior captures (not proof of write success)`
				: "",
			Array.isArray(receipt.historyOmitted) && receipt.historyOmitted.length
				? `${receipt.historyOmitted.length} history omissions (credential policy)`
				: "",
		]),
	};
}

type MutationOperation = "write" | "edit" | "review" | "retire";
const MUTATION_OPERATIONS: Record<string, MutationOperation> = {
	memory_write: "write",
	memory_edit: "edit",
	memory_review: "review",
	memory_retire: "retire",
};

function receiptOutcome(receipt: Record<string, unknown>, operation: MutationOperation): ReceiptOutcome {
	const view = receiptView(receipt);
	const verb = { write: "written", edit: "edited", review: "reviewed", retire: "retired" }[operation];
	const initialization = receipt.initialized === true ? " · corpus initialized" : "";
	if (receipt.ok === true) {
		return {
			color: view.notWritten.length > 0 ? "warning" : "success",
			line: `${view.slugText || "note"} ${verb}${initialization}`,
			second: joinedParts([view.digestPart, view.notWritten.length > 0 ? view.counts : "", view.history]),
			hint: view.notWritten.length > 0 || view.history !== "",
		};
	}
	if (view.written.length > 0) {
		return {
			color: "warning",
			line: `${view.slugText ? `${view.slugText} ` : ""}${operation} incomplete · ${view.counts}`,
			second: joinedParts([view.digestPart, view.errorText, view.history]),
			hint: true,
		};
	}
	return {
		color: "error",
		line: `${operation} failed${view.slugText ? ` · ${view.slugText}` : ""}${view.errorText ? ` · ${view.errorText}` : ""}`,
		second: joinedParts([view.digestPart, view.history]),
		hint: view.history !== "",
	};
}

function writeResult(
	name: string,
	result: AgentToolResult<unknown>,
	options: ToolRenderResultOptions,
	theme: Theme,
	context: ResultContext,
): Component {
	const operation = MUTATION_OPERATIONS[name] ?? "write";
	if (options.isPartial) {
		const state = { write: "Writing", edit: "Editing", review: "Reviewing", retire: "Retiring" }[operation];
		return partialCard(`${state} note...`, theme, context);
	}
	const details = record(result.details);
	const text = textContent(result);
	if (isReceipt(details)) {
		const outcome = receiptOutcome(details, operation);
		return resultCard(outcome, outcome.second, outcome.hint, text, options, theme, context);
	}
	if (context.isError) {
		const receipt = receiptFromMessage(text);
		if (receipt !== null && isReceipt(receipt)) {
			const outcome = receiptOutcome(receipt, operation);
			return resultCard(outcome, outcome.second, outcome.hint, text, options, theme, context);
		}
		const display = text.startsWith(WRITE_ERROR_PREFIX) ? text.slice(WRITE_ERROR_PREFIX.length) : text;
		const message = previewMark(display, ERROR_LIMIT).text;
		return resultCard(
			{ color: "error", line: message ? `${operation} incomplete · ${message}` : `${operation} incomplete` },
			"",
			text !== "",
			text,
			options,
			theme,
			context,
		);
	}
	return fallbackCard(name, result, options, theme, context);
}

function historyPlanEvidence(value: unknown): string[] {
	const plan = record(value);
	if (Object.keys(plan).length === 0) return [];
	return [
		`Read-only history plan: captured before ${textField(plan.capturedBefore) ?? "unknown"}; keep newest ${numberField(plan.keepNewest) ?? "unknown"}`,
		...numberLines([
			["Available bytes on this metadata page", plan.availableBytes],
			["Keep bytes on this metadata page", plan.keepBytes],
			["Candidate bytes on this metadata page", plan.candidateBytes],
			["Kept revisions on this page", plan.kept],
			["Candidate revisions on this page", plan.candidates],
			["Unavailable revisions on this page", plan.unavailable],
		]),
		...(textField(plan.meaning) ? [`Plan scope: ${plan.meaning}`] : []),
		"Capture-name digests are unverified. This plan authorizes no removal and imposes no retained-storage bound.",
	];
}

function historyResult(
	result: AgentToolResult<unknown>,
	options: ToolRenderResultOptions,
	theme: Theme,
	context: ResultContext,
): Component {
	if (options.isPartial) return partialCard("Reading history...", theme, context);
	if (context.isError) return errorCard("memory_history", result, options, theme, context);
	const details = record(result.details);
	const revisions = Array.isArray(details.revisions) ? details.revisions.map(record) : [];
	const coverage = record(details.coverage);
	const body = [
		textField(details.authority) ?? "",
		`Coverage: ${stringifySafe(coverage)}`,
		...historyPlanEvidence(details.plan),
		...revisions.map(
			(revision) =>
				`Revision: ${revision.revision}\nCaptured: ${revision.capturedAt}\nDigest: ${revision.digest}\nBytes: ${revision.bytes}${textField(revision.selection) ? `\nSelection: ${revision.selection}\nReason: ${textField(revision.reason) ?? "unknown"}` : ""}`,
		),
		textField(details.nextCursor)
			? `Repeat slug${details.plan ? " and plan" : ""} with nextCursor: ${details.nextCursor}`
			: "End of captured revision inventory.",
	].join("\n");
	return resultCard(
		{ color: "muted", line: `${textField(details.slug) ?? "subject"} · ${revisions.length} prior captures` },
		joinedParts([
			"historical evidence, not current authority",
			details.plan
				? `${numberField(record(details.plan).candidates) ?? "unknown"} candidates on this page; read-only plan`
				: "",
			textField(details.nextCursor) ? "continuation available" : "",
			numberField(coverage.unavailable) ? `${coverage.unavailable} unavailable revisions` : "",
		]),
		true,
		body,
		options,
		theme,
		context,
	);
}

/** Render a memory tool call card by tool name. */
export function renderCall(name: string, args: unknown, theme: Theme, context: CallContext): Component {
	switch (name) {
		case "memory_search":
			return searchCall(args, theme, context);
		case "memory_read":
			return readCall(args, theme, context);
		case "memory_history":
			return callCard(
				name,
				textField(record(args).slug) ?? "",
				[textField(record(args).cursor) ? "continuation" : "", record(args).plan ? "read-only plan" : ""].filter(
					Boolean,
				),
				true,
				stringifySafe(args),
				theme,
				context,
			);
		case "memory_write":
			return writeCall(args, theme, context);
		case "memory_edit":
			return editCall(args, theme, context);
		case "memory_review":
		case "memory_retire":
			return reviewCall(name, args, theme, context);
		default:
			return callCard(name, "", [], false, "", theme, context);
	}
}

/** Render a memory tool result card by tool name. */
export function renderResult(
	name: string,
	result: AgentToolResult<unknown>,
	options: ToolRenderResultOptions,
	theme: Theme,
	context: ResultContext,
): Component {
	switch (name) {
		case "memory_search":
			return searchResult(result, options, theme, context);
		case "memory_read":
			return readResult(result, options, theme, context);
		case "memory_history":
			return historyResult(result, options, theme, context);
		case "memory_write":
		case "memory_edit":
		case "memory_review":
		case "memory_retire":
			return writeResult(name, result, options, theme, context);
		default:
			return fallbackCard(name, result, options, theme, context);
	}
}
