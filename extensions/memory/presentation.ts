/**
 * Terminal cards for the memory tools.
 *
 * A collapsed card shows the request on its heading row and at most one
 * qualifier row, then the outcome on one or two summary rows. The expansion
 * hint appears only when the collapsed view hides or clips content, and it
 * rides the row it belongs to. An expanded card shows the full arguments or
 * result text with controls escaped and a display bound.
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
const WITHHOLD_THRESHOLD = 120;
const WRITE_ERROR_PREFIX = "Memory write incomplete: ";
const WITHHELD_KEYS = new Set(["summary", "details", "sources", "title"]);

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
	const lines = [`\n${theme.fg(outcome.color, rowSafe(outcome.line))}`];
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
	const index = numberField(fields.index);
	if (index !== null && index > 0) detail.push(`from ${index}`);
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
	const hasContinuation =
		details.hasMore === true || textField(details.nextIndex) !== null || numberField(details.nextIndex) !== null;
	return joinedParts([
		issues !== null && issues > 0 ? `${issues} scan issues` : "",
		unavailable !== null && unavailable > 0 ? `${unavailable} unavailable notes` : "",
		hasContinuation ? "continuation available" : "",
	]);
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
	const returned = numberField(details.returned) ?? notes.length;
	const query = isQueryPage(details.query);
	const { complete, total } = pageCoverage(details, query);
	const scope = query ? "coverage" : "directory scan";
	const clean = complete && (query || record(details.scan).issueCount === 0);
	const color: OutcomeColor = clean ? (returned > 0 ? "success" : "muted") : "warning";
	const noun = query ? "matches" : "notes";
	const counted = total > 0 ? total : returned;
	const count = details.corpusEmpty === true ? "corpus empty" : `${returned} of ${counted} ${noun}`;
	return resultCard(
		{ color, line: `${count} · ${scope} ${complete ? "complete" : "partial"}` },
		pageQualifiers(details, record(details.search), record(details.scan)),
		returned > 0,
		textContent(result),
		options,
		theme,
		context,
	);
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
	const contract = details.source === "contract" ? "contract source" : "";
	const line = joinedParts([slug !== null ? previewMark(slug, SLUG_LIMIT).text : "note", size ?? ""]).concat(more);
	return resultCard(
		{ color: "success", line },
		contract,
		true,
		textContent(result) || (typeof details.content === "string" ? details.content : stringifySafe(details)),
		options,
		theme,
		context,
	);
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
	};
}

function receiptOutcome(receipt: Record<string, unknown>): ReceiptOutcome {
	const view = receiptView(receipt);
	if (receipt.ok === true) {
		return {
			color: view.notWritten.length > 0 ? "warning" : "success",
			line: `${view.slugText || "note"} written${receipt.initialized === true ? " · corpus initialized" : ""}`,
			second: joinedParts([view.digestPart, view.notWritten.length > 0 ? view.counts : ""]),
			hint: view.notWritten.length > 0,
		};
	}
	if (view.written.length > 0) {
		return {
			color: "warning",
			line: `${view.slugText ? `${view.slugText} ` : ""}write incomplete · ${view.counts}`,
			second: joinedParts([view.digestPart, view.errorText]),
			hint: true,
		};
	}
	return {
		color: "error",
		line: `write failed${view.slugText ? ` · ${view.slugText}` : ""}${view.errorText ? ` · ${view.errorText}` : ""}`,
		second: view.digestPart,
		hint: false,
	};
}

function writeResult(
	result: AgentToolResult<unknown>,
	options: ToolRenderResultOptions,
	theme: Theme,
	context: ResultContext,
): Component {
	if (options.isPartial) return partialCard("Writing note...", theme, context);
	const details = record(result.details);
	const text = textContent(result);
	if (isReceipt(details)) {
		const outcome = receiptOutcome(details);
		return resultCard(outcome, outcome.second, outcome.hint, text, options, theme, context);
	}
	if (context.isError) {
		const receipt = receiptFromMessage(text);
		if (receipt !== null && isReceipt(receipt)) {
			const outcome = receiptOutcome(receipt);
			return resultCard(outcome, outcome.second, outcome.hint, text, options, theme, context);
		}
		const display = text.startsWith(WRITE_ERROR_PREFIX) ? text.slice(WRITE_ERROR_PREFIX.length) : text;
		const message = previewMark(display, ERROR_LIMIT).text;
		return resultCard(
			{ color: "error", line: message ? `write incomplete · ${message}` : "write incomplete" },
			"",
			text !== "",
			text,
			options,
			theme,
			context,
		);
	}
	return fallbackCard("memory_write", result, options, theme, context);
}

/** Render a memory tool call card by tool name. */
export function renderCall(name: string, args: unknown, theme: Theme, context: CallContext): Component {
	switch (name) {
		case "memory_search":
			return searchCall(args, theme, context);
		case "memory_read":
			return readCall(args, theme, context);
		case "memory_write":
			return writeCall(args, theme, context);
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
		case "memory_write":
			return writeResult(result, options, theme, context);
		default:
			return fallbackCard(name, result, options, theme, context);
	}
}
