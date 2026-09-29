/**
 * Terminal cards for the memory tools.
 *
 * A collapsed card shows the request on its heading row and at most one
 * qualifier row, then the outcome and coverage. Search results also preview
 * a few subjects. The expansion hint appears when the collapsed view hides
 * or clips content. Expanded retrieval cards show labeled evidence and source
 * text with controls escaped and a display bound.
 *
 * Evidence semantics: a bounded page is not proof of absence, so coverage
 * words travel with every page count. A write receipt reports which files
 * changed; a thrown write error may carry the receipt only inside its message
 * text, so the error card recovers it when it parses and otherwise states the
 * write as incomplete rather than guessing. Write call previews never print
 * note payloads: tool argument history cannot be erased after a rejected
 * credential, so payload fields are summarized as withheld lengths.
 */

import {
	type AgentToolResult,
	keyText,
	type Theme,
	type ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { type Component, Text } from "@earendil-works/pi-tui";

const DISPLAY_LIMIT = 32_000;
const QUERY_LIMIT = 64;
const SLUG_LIMIT = 72;
const ERROR_LIMIT = 300;
const DIGEST_PREFIX = 8;
const PREVIEW_ARRAY_LIMIT = 20;
const SEARCH_PREVIEW_LIMIT = 3;
const WITHHOLD_THRESHOLD = 120;
const WRITE_ERROR_PREFIX = "Memory write incomplete: ";
const WITHHELD_KEYS = new Set(["summary", "details", "sources", "reason", "title", "oldText", "newText"]);

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

function expandHint(subject: string): string {
	const key = keyText("app.tools.expand");
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
		? theme.fg("muted", rowSafe(detail)) + (hint ? theme.fg("dim", ` · ${expandHint("arguments")}`) : "")
		: hint
			? theme.fg("dim", expandHint("arguments"))
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
		const hintSuffix = hint ? theme.fg("dim", `${second ? " · " : ""}${expandHint("result")}`) : "";
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

/** Query subjects: one formulation, or the first of several, quoted. */
function querySubject(
	query: unknown,
	argsComplete: boolean | undefined,
): { subject: string; qualifiers: string[]; hint: boolean } {
	if (typeof query === "string") {
		const preview = previewMark(query, QUERY_LIMIT);
		return { subject: preview.text ? `"${preview.text}"` : "", qualifiers: [], hint: preview.clipped };
	}
	if (Array.isArray(query)) {
		const parts = query.filter((part): part is string => typeof part === "string" && part !== "");
		if (parts.length === 0) return { subject: "", qualifiers: [], hint: false };
		const first = previewMark(parts[0], QUERY_LIMIT);
		const qualifiers = parts.length > 1 ? [`${parts.length} queries`] : [];
		return { subject: `"${first.text}"`, qualifiers, hint: first.clipped || parts.length > 1 };
	}
	return { subject: argsComplete === false ? "" : "browse", qualifiers: [], hint: false };
}

function searchCall(args: unknown, theme: Theme, context: CallContext): Component {
	const fields = record(args);
	const { subject, qualifiers, hint } = querySubject(fields.query, context.argsComplete);
	const detail = [...qualifiers];
	if (textField(fields.cursor)) detail.push("continuation");
	if (fields.includeRetired === true) detail.push("includes retired");
	const limit = numberField(fields.limit);
	if (limit !== null && limit > 0) detail.push(`limit ${limit}`);
	else if (fields.query === undefined && context.argsComplete !== false) detail.push("byte-bounded cues");
	return callCard("memory_search", subject, detail, hint, stringifySafe(args), theme, context);
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

/** Coverage word for a page: an absent flag reads as partial, never as proof. */
function pageCoverage(details: Record<string, unknown>, query: boolean): { complete: boolean; total: number } {
	const complete = query ? record(details.search).complete === true : record(details.scan).complete === true;
	const total = numberField(query ? details.totalMatches : details.totalNotes);
	return { complete, total: total ?? 0 };
}

/** The qualifier row names what the page left out: scan issues and continuations. */
function pageQualifiers(
	details: Record<string, unknown>,
	search: Record<string, unknown>,
	scan: Record<string, unknown>,
): string {
	const issues = numberField(scan.issueCount);
	const unavailable = numberField(search.unavailableNotes) ?? numberField(scan.unavailableNotes);
	const hasContinuation = details.hasMore === true || textField(details.nextCursor) !== null;
	return joinedParts([
		issues !== null && issues > 0 ? `${issues} scan issues` : "",
		unavailable !== null && unavailable > 0 ? `${unavailable} unavailable notes` : "",
		numberField(details.excludedRetired) ? `${details.excludedRetired} retired notes excluded in this window` : "",
		hasContinuation ? "continuation available" : "",
	]);
}

function noteHeading(note: Record<string, unknown>, compact = false): string {
	const slug = textField(note.slug) ?? "unknown subject";
	const title = textField(note.title);
	return joinedParts([
		compact ? previewMark(slug, SLUG_LIMIT).text : slug,
		title && title !== slug ? (compact ? previewMark(title, 96).text : title) : "",
	]);
}

function matchedTerms(value: unknown): string {
	if (!Array.isArray(value)) return "";
	return value
		.map(record)
		.map((match) => {
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
	return [
		`Source coverage: ${scan.complete === true ? "complete in this window" : "partial or unknown"}`,
		`Filename inventory: ${scan.inventoryComplete === true ? "complete" : "unknown"}`,
		...numberLines([
			["Entries visited", scan.visited],
			["Visit limit", scan.visitCap],
			["Candidate notes", scan.totalCandidates],
			["Window start", scan.windowStart],
			["Window end", scan.windowEnd],
			["Window source bytes", scan.sourceBytes],
			["Unavailable notes", record(details.search).unavailableNotes ?? scan.unavailableNotes],
			["Retired notes in this window", scan.retiredNotes],
			["Retired notes excluded in this window", details.excludedRetired],
			["Scan issues", scan.issueCount],
			["Scan issues shown", scan.issuesShown],
		]),
		...issues.map(
			(issue) => `Scan issue: ${joinedParts([textField(issue.code) ?? "unknown", textField(issue.message) ?? ""])}`,
		),
	];
}

function queryCoverage(details: Record<string, unknown>): string[] {
	if (!isQueryPage(details.query)) return [];
	const search = record(details.search);
	const summaries = Array.isArray(search.formulations) ? search.formulations.map(record) : [search];
	return [
		`Query coverage: ${search.complete === true ? "complete" : "partial or unknown"}`,
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
	if (details.hasMore === true)
		return `Continue with the same query and includeRetired filter and nextCursor: ${textField(details.nextCursor) ?? "unknown"}`;
	return details.hasMore === false ? "End of this result set; coverage limits still apply." : "Continuation: unknown.";
}

function passageEvidence(value: unknown, query: boolean): string[] {
	const passage = record(value);
	const excerpt = textField(passage.excerpt);
	if (excerpt === null) return query ? ["No source passage in this record."] : [];
	return [
		`Match [${numberField(passage.offset) ?? "?"}, ${numberField(passage.endOffset) ?? "?"}) code points`,
		`Source excerpt [${numberField(passage.excerptOffset) ?? "?"}, ${numberField(passage.excerptEndOffset) ?? "?"}) code points:`,
		excerpt,
	];
}

function formulationLines(formulation: Record<string, unknown>): string[] {
	return [
		`Formulation: ${textField(formulation.query) ?? "unknown"} · ${numberField(formulation.rank) === null ? "no ranked match" : `rank ${formulation.rank}`}`,
		...formulationEvidence(formulation),
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
		...(lifecycle ? [lifecycle.label] : []),
		...(lifecycle?.problem ? [`Lifecycle problem: ${lifecycle.problem}`] : []),
		...freshnessEvidence(note.freshness),
		...(textField(note.cueProblem) ? [`Cue problem: ${note.cueProblem}`] : []),
		...(textField(note.digest) ? [`Digest: ${note.digest}`] : []),
		...formulationEvidence(note),
		...formulations.flatMap(formulationLines),
		...passageEvidence(note.sourceMatch, query),
	];
}

function searchBody(details: Record<string, unknown>, notes: Record<string, unknown>[]): string {
	const query = details.query;
	const querying = isQueryPage(query);
	const header = [
		querying ? `Query: ${typeof query === "string" ? query : stringList(query).join(" | ")}` : "",
		...scanEvidence(details),
		...queryCoverage(details),
		typeof details.includeRetired === "boolean" ? `Includes retired notes: ${details.includeRetired}` : "",
		...numberLines([["Page starts at window offset", details.pageOffset]]),
		textField(record(details.coverage).meaning) ?? "",
		searchContinuation(details),
		textField(details.guidance) ?? "",
		"Cues and excerpts are discovery evidence. Read selected notes from offset 0 with their digests.",
	].filter(Boolean);
	return [...header, ...notes.flatMap((note) => noteEvidence(note, querying))].join("\n");
}

/** A bounded page is not proof of absence: counts travel with a coverage word. */
function searchResult(
	result: AgentToolResult<unknown>,
	options: ToolRenderResultOptions,
	theme: Theme,
	context: ResultContext,
): Component {
	if (options.isPartial) return partialCard("Searching memory...", theme, context);
	if (context.isError) return errorCard("memory_search", result, options, theme, context);
	const details = record(result.details);
	const notes = Array.isArray(details.notes) ? details.notes.map(record) : null;
	if (notes === null) return fallbackCard("memory_search", result, options, theme, context);
	const { outcome, qualifiers } = searchOverview(details, notes);
	return resultCard(
		outcome,
		qualifiers,
		true,
		options.expanded ? searchBody(details, notes) : "",
		options,
		theme,
		context,
		searchPreviews(notes),
	);
}

function searchPreviews(notes: Record<string, unknown>[]): string[] {
	const previews = notes
		.slice(0, SEARCH_PREVIEW_LIMIT)
		.map((note) =>
			joinedParts([
				`• ${noteHeading(note, true)}${textField(note.cueProblem) ? " [cue problem]" : ""}`,
				note.lifecycle ? lifecycleView(note).label : "",
				freshnessSummary(note.freshness),
			]),
		);
	if (notes.length > previews.length) previews.push(`+ ${notes.length - previews.length} more subjects on this page`);
	return previews;
}

function searchOverview(details: Record<string, unknown>, notes: Record<string, unknown>[]) {
	const returned = numberField(details.returned) ?? notes.length;
	const query = isQueryPage(details.query);
	const { complete, total } = pageCoverage(details, query);
	const scope = "source coverage";
	const clean = complete && (query || record(details.scan).issueCount === 0);
	const color: OutcomeColor = clean ? (returned > 0 ? "success" : "muted") : "warning";
	const noun = query ? "matches" : "notes";
	const counted = total > 0 ? total : returned;
	const count = details.corpusEmpty === true ? "corpus empty" : `${returned} of ${counted} window ${noun}`;
	const cueProblems = notes.filter((note) => textField(note.cueProblem)).length;
	return {
		outcome: { color, line: `${count} · ${scope} ${complete ? "complete" : "partial"}` },
		qualifiers: joinedParts([
			pageQualifiers(details, record(details.search), record(details.scan)),
			cueProblems ? `${cueProblems} cue problems` : "",
			textField(details.guidance) ?? "",
		]),
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
	const line = joinedParts([slug !== null ? previewMark(slug, SLUG_LIMIT).text : "note", size ?? ""]).concat(more);
	return resultCard(
		{ color: freshnessWarning(details.freshness) ? "warning" : lifecycle.color, line },
		joinedParts([
			previewMark(lifecycle.label, 200).text,
			freshnessSummary(details.freshness),
			textField(details.revision) ? `revision ${details.revision}` : "",
			lifecycle.problem ? `Lifecycle problem: ${previewMark(lifecycle.problem, ERROR_LIMIT).text}` : "",
		]),
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

function freshnessSummary(value: unknown): string {
	const freshness = record(value);
	if (Object.keys(freshness).length === 0) return "";
	return joinedParts([
		`policy ${textField(freshness.policy) ?? "unknown"}`,
		`review ${textField(freshness.deadline) ?? "unknown"}`,
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

function freshnessRecord(label: string, value: unknown): string[] {
	const evidence = record(value);
	if (!Object.keys(evidence).length) return [];
	return [
		`${label}: ${textField(evidence.date) ?? "unknown date"}`,
		...["digest", "reason", "sources"].flatMap((field) =>
			textField(evidence[field]) ? [`${label} ${field}: ${evidence[field]}`] : [],
		),
	];
}

function freshnessEvidence(value: unknown): string[] {
	const freshness = record(value);
	if (Object.keys(freshness).length === 0) return [];
	const lines = [
		`Freshness evaluated on: ${textField(freshness.evaluatedOn) ?? "unknown"}`,
		`Declared verified: ${typeof freshness.verified === "boolean" ? freshness.verified : "unknown"}`,
		`Declared verification date: ${textField(freshness.verifiedDate) ?? "none or unknown"}`,
		`Review policy: ${textField(freshness.policy) ?? "unknown"}`,
		`Review deadline: ${textField(freshness.deadline) ?? "unknown"}`,
		`Review after: ${textField(freshness.reviewAfter) ?? "none or unknown"}`,
	];
	lines.push(
		...freshnessRecord("Unresolved concern", freshness.concern),
		...freshnessRecord("Last review", freshness.lastReview),
		...freshnessRecord("Retirement", freshness.retirement),
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
