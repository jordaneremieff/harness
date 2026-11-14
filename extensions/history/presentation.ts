/**
 * Terminal cards for the history tools.
 *
 * The history tools return one JSON object as their text; the renderers read
 * structured fields from that payload. A collapsed card shows the request on
 * its heading row and at most one qualifier row, then one or two outcome rows.
 * An expanded card leads with readable evidence (entry kind, role or tool,
 * time, excerpt or returned text, error flag), then the exact identity, scope,
 * and continuation, then a raw section with the retained payload. Terminal
 * controls render as text. An exhausted empty page is absence only within the
 * walked scope, and a bounded page never reads as the end of the ancestry.
 */

import type {
	AgentToolResult,
	KeybindingHints,
	Theme,
	ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { type Component, Text } from "@earendil-works/pi-tui";

const DISPLAY_LIMIT = 32_000;
const EVIDENCE_MATCHES = 3;
const EVIDENCE_ITEMS = 8;

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

/** The tool text is one JSON object; a malformed payload falls back to a preview. */
function payload(result: AgentToolResult<unknown>): Record<string, unknown> | undefined {
	try {
		const parsed: unknown = JSON.parse(textContent(result));
		if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
			return parsed as Record<string, unknown>;
		}
	} catch {
		// Malformed or truncated text uses the bounded preview instead.
	}
	return undefined;
}

type Hints = Partial<Pick<KeybindingHints, "keyText" | "keyHint">>;

/** The host injects keyText with the operator's configured bindings; without it the hint names no key. */
function expandHint(subject: string, hints: Hints): string {
	const key = hints.keyText?.("app.tools.expand");
	return key ? `${key} to expand ${subject}` : `Expand for ${subject}`;
}

/** "1 match" / "2 matches": the count agrees with its noun. */
function countNoun(n: number, singular: string, plural: string): string {
	return `${n} ${n === 1 ? singular : plural}`;
}

function pluralType(type: string): string {
	if (type.endsWith("y")) return `${type.slice(0, -1)}ies`;
	if (type.endsWith("s")) return type;
	return `${type}s`;
}

function textComponent(text: string, previous?: Component): Text {
	const component = previous instanceof Text ? previous : new Text("", 0, 0);
	component.setText(text);
	return component;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function field(value: Record<string, unknown>, key: string): unknown {
	return value[key];
}

function stringField(value: Record<string, unknown>, key: string): string {
	const item = field(value, key);
	return typeof item === "string" ? item : "";
}

function numberField(value: Record<string, unknown>, key: string): number | undefined {
	const item = field(value, key);
	return typeof item === "number" && Number.isFinite(item) ? item : undefined;
}

export interface CallContext extends Hints {
	expanded?: boolean;
	argsComplete?: boolean;
	lastComponent?: Component;
}

export interface ResultContext extends Hints {
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
		? theme.fg("muted", rowSafe(detail)) + (hint ? theme.fg("dim", ` · ${expandHint("arguments", context)}`) : "")
		: hint
			? theme.fg("dim", expandHint("arguments", context))
			: "";
	return textComponent(line ? `${heading}\n${line}` : heading, context.lastComponent);
}

/** Outcome row, an optional summary row, and the expanded body; the hint rides the last collapsed row. */
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
		const hintSuffix = hint ? theme.fg("dim", `${second ? " · " : ""}${expandHint("result", context)}`) : "";
		const row = second ? theme.fg("muted", rowSafe(second)) + hintSuffix : hintSuffix;
		if (row) lines.push(row);
	}
	return textComponent(lines.join("\n"), context.lastComponent);
}

/** Collapsed errors show one clipped line; the expanded card retains the full diagnostic. */
function errorCard(
	name: string,
	result: AgentToolResult<unknown>,
	options: ToolRenderResultOptions,
	theme: Theme,
	context: ResultContext,
): Text {
	const text = textContent(result);
	const first = previewMark(text.split(/\r?\n/, 1)[0] ?? "", 300).text || `${name} did not complete`;
	return resultCard({ color: "error", line: first }, "", false, text, options, theme, context);
}

function partialCard(line: string, theme: Theme, context: ResultContext): Text {
	return textComponent(`\n${theme.fg("warning", line)}`, context.lastComponent);
}

function filterLabel(filter: unknown): string {
	const value = asRecord(filter);
	if (!value) return "";
	const source = stringField(value, "source");
	if (!source) return "";
	const toolName = typeof value.toolName === "string" && value.toolName ? `(${previewMark(value.toolName, 60).text})` : "";
	const errorsOnly = value.errorsOnly === true ? " errors only" : "";
	return `filter ${source}${toolName}${errorsOnly}`;
}

/** Entry kind, role or tool, time, and error flag: the identity a reader needs first. */
function entryIdentity(entry: Record<string, unknown>): string {
	const kind = stringField(entry, "type") || stringField(entry, "kind");
	const role = stringField(entry, "role");
	const tool = stringField(entry, "toolName");
	const actor = tool ? `tool ${tool}` : role;
	const error = field(entry, "isError") === true ? "error" : "";
	const timestamp = stringField(entry, "timestamp");
	const time = timestamp ? previewMark(timestamp, 40).text : "";
	return [kind, actor, error, time].filter(Boolean).map((part) => rowSafe(part)).join(" · ");
}

/** Stored entry ID: native IDs are numbers and read as ranks; ordinary IDs stay verbatim. */
function entryLabel(id: unknown): string {
	if (typeof id === "number" && Number.isFinite(id)) return `#${id}`;
	return previewMark(String(id ?? ""), 48).text;
}

function continuationWord(value: Record<string, unknown>): string {
	const next = field(value, "next");
	return next !== null && next !== undefined ? "continuation available" : "";
}

export interface SearchDisplayArgs {
	query?: string;
	mode?: string;
	filter?: unknown;
	sessionId?: string;
	fromId?: string;
	slot?: number;
	position?: unknown;
	offset?: number;
	maxVisits?: number;
	maxScanBytes?: number;
	maxMatches?: number;
	maxOutputBytes?: number;
}

/** The subject is the literal query, or the bounded listing when the query is omitted. */
export function renderSearchCall(input: unknown, theme: Theme, context: CallContext): Component {
	const args = asRecord(input);
	const query = typeof args?.query === "string" ? previewMark(args.query, 64) : { text: "", clipped: false };
	const subject = query.text ? `"${query.text}"` : "listing";
	const qualifiers: string[] = [];
	let hint = query.clipped;
	if (args?.mode === "arguments") qualifiers.push("in tool arguments");
	const filter = filterLabel(args?.filter);
	if (filter) qualifiers.push(filter);
	if (typeof args?.fromId === "string" && args.fromId) {
		const from = previewMark(args.fromId, 48);
		qualifiers.push(`from ${from.text}`);
		hint = hint || from.clipped;
	}
	const position = asRecord(args?.position);
	if (position) {
		qualifiers.push(`continuation ${positionLabel(position)} offset ${args?.offset ?? 0}`);
	} else if (typeof args?.slot === "number" || typeof args?.offset === "number") {
		qualifiers.push(`continuation slot ${args?.slot ?? 0} offset ${args?.offset ?? 0}`);
	}
	if (args?.maxVisits !== undefined || args?.maxScanBytes !== undefined || args?.maxMatches !== undefined || args?.maxOutputBytes !== undefined) {
		hint = true;
	}
	return callCard("history_search", subject, qualifiers, hint, input, theme, context);
}

/** A continuation position: native message index, content block, and argument index path. */
function positionLabel(position: Record<string, unknown>): string {
	const message = numberField(position, "message");
	const block = numberField(position, "block");
	const path = Array.isArray(position.path) ? position.path.filter((item) => typeof item === "number") : [];
	return [
		message !== undefined ? `message ${message}` : "",
		block !== undefined ? `block ${block}` : "",
		path.length > 0 ? previewMark(`path ${path.join("/")}`, 48).text : "",
	]
		.filter(Boolean)
		.join(" ") || "position";
}

const SEARCH_STATUS: Record<string, string> = {
	ancestry_exhausted: "ancestry exhausted",
	visit_limit: "visit limit",
	node_limit: "node limit",
	scan_limit: "scan limit",
	slot_limit: "slot limit",
	match_limit: "match limit",
	output_limit: "output limit",
	unknown_entry: "unknown entry",
	missing_parent: "missing parent",
	cycle: "cycle",
};

function searchColor(status: string, matches: number): OutcomeColor {
	if (status === "ancestry_exhausted") return matches > 0 ? "success" : "muted";
	return "warning";
}

/** Count the entry types the search page already reports, and mark a bounded list. */
function typeTally(matches: unknown[]): string {
	const counts = new Map<string, number>();
	for (const match of matches) {
		const entry = asRecord(asRecord(match)?.entry);
		const type = entry ? stringField(entry, "type") || stringField(entry, "kind") : "";
		if (type) counts.set(type, (counts.get(type) ?? 0) + 1);
	}
	const entries = [...counts.entries()];
	const shown = entries.slice(0, 4).map(([type, count]) => countNoun(count, type, pluralType(type))).join(", ");
	const omitted = entries.length - 4;
	if (omitted > 0) return `${shown}, +${omitted} more`;
	return shown;
}

/** One match as readable evidence: identity, excerpt, then pointer and offsets. */
function matchEvidence(matchValue: unknown, index: number): string[] {
	const match = asRecord(matchValue) ?? {};
	const entry = asRecord(field(match, "entry")) ?? {};
	const callName = stringField(asRecord(field(match, "call")) ?? {}, "name");
	const call = callName ? `call ${rowSafe(previewMark(callName, 60).text)}` : "";
	const identity = [entryIdentity(entry), call, entryLabel(field(entry, "id"))].filter(Boolean).join(" · ");
	const lines = [`${index + 1} · ${identity || "entry"}`];
	const excerpt = stringField(match, "excerpt");
	if (excerpt) lines.push(`  "${previewMark(excerpt, 160).text}"`);
	const pointer = stringField(match, "pointer");
	const start = numberField(match, "offset");
	const end = numberField(match, "endOffset");
	const span = start !== undefined && end !== undefined ? `offsets ${start}..${end}` : "";
	if (pointer) lines.push(rowSafe(`${previewMark(pointer, 96).text}${span ? ` · ${span}` : ""}`));
	return lines;
}

/** Readable evidence rows for the shown matches; the scope and retained payload follow separately. */
function searchEvidence(matches: unknown[]): string {
	if (matches.length === 0) return "No matches in this page.";
	const lines = [`Matches (first ${Math.min(EVIDENCE_MATCHES, matches.length)} of ${matches.length}):`];
	for (const [index, match] of matches.slice(0, EVIDENCE_MATCHES).entries()) lines.push(...matchEvidence(match, index));
	if (matches.length > EVIDENCE_MATCHES) lines.push(`(+${matches.length - EVIDENCE_MATCHES} more matches in the raw payload)`);
	return lines.join("\n");
}

/** Identity, walked scope, and continuation for the page the response actually covers. */
function searchScope(value: Record<string, unknown>, statusWord: string): string {
	const parts = [
		`session ${previewMark(stringField(value, "sessionId") || "(unknown)", 48).text}`,
		`start ${entryLabel(field(value, "startId")) || "(current leaf)"}`,
		`${numberField(value, "visited") ?? 0} entries visited`,
		statusWord,
	];
	if (numberField(value, "excluded") !== undefined) parts.push(`${numberField(value, "excluded")} excluded by filter`);
	const skipped = asRecord(field(value, "skipped"));
	const unexamined = (skipped ? numberField(skipped, "depth") ?? 0 : 0) + (skipped ? numberField(skipped, "pointerLength") ?? 0 : 0);
	if (unexamined > 0) parts.push(countNoun(unexamined, "argument value skipped", "argument values skipped"));
	const next = continuationWord(value);
	if (next) parts.push(next);
	return parts.join(" · ");
}

/** The search card reports the walked scope and page status, never a global absence. */
export function renderSearchResult(
	result: AgentToolResult<unknown>,
	options: ToolRenderResultOptions,
	theme: Theme,
	context: ResultContext,
): Component {
	if (options.isPartial) return partialCard("Searching history...", theme, context);
	if (context.isError) return errorCard("history_search", result, options, theme, context);
	const value = payload(result);
	if (value === undefined) {
		return resultCard(
			{ color: "muted", line: previewMark(textContent(result), 160).text || "history_search" },
			"",
			false,
			textContent(result),
			options,
			theme,
			context,
		);
	}
	const status = typeof value.status === "string" ? value.status : "unknown";
	const matches = Array.isArray(value.matches) ? value.matches : [];
	const visited = typeof value.visited === "number" ? value.visited : 0;
	const statusWord = SEARCH_STATUS[status] ?? status;
	const continuation = continuationWord(value);
	const expandedBody = [
		searchEvidence(matches),
		`Scope: ${searchScope(value, statusWord)}`,
		"Raw payload (retained):",
		JSON.stringify(value, null, 2),
	].join("\n\n");
	return resultCard(
		{ color: searchColor(status, matches.length), line: `${countNoun(matches.length, "match", "matches")} · ${countNoun(visited, "entry visited", "entries visited")} · ${statusWord}` },
		[typeTally(matches), continuation].filter(Boolean).join(" · "),
		matches.length > 0,
		expandedBody,
		options,
		theme,
		context,
	);
}

export interface ReadDisplayArgs {
	entryId: string;
	sessionId?: string;
	pointer?: string;
	offset?: number;
	maxBytes?: number;
	maxItems?: number;
	maxOutputBytes?: number;
}

export function renderReadCall(input: unknown, theme: Theme, context: CallContext): Component {
	const args = asRecord(input);
	const entryId = typeof args?.entryId === "string" ? previewMark(args.entryId, 72) : { text: "", clipped: false };
	const subject = entryId.text || (context.argsComplete === false ? "" : "(entry pending)");
	const qualifiers: string[] = [];
	let hint = entryId.clipped;
	if (typeof args?.pointer === "string" && args.pointer) {
		const pointer = previewMark(args.pointer, 64);
		qualifiers.push(pointer.text);
		hint = hint || pointer.clipped;
	}
	if (typeof args?.offset === "number" && args.offset > 0) qualifiers.push(`offset ${args.offset}`);
	if (args?.maxBytes !== undefined || args?.maxItems !== undefined || args?.maxOutputBytes !== undefined) hint = true;
	return callCard("history_read", subject, qualifiers, hint, input, theme, context);
}

const READ_STATUS: Record<string, string> = {
	complete: "complete",
	page: "page",
	unknown_entry: "unknown entry",
	withheld: "withheld content",
	field_absent: "field absent",
	structured_omitted: "structured value omitted",
};

function readDescriptor(value: Record<string, unknown>): string {
	const total = typeof value.totalCodeUnits === "number" ? value.totalCodeUnits : undefined;
	const end = typeof value.endOffset === "number" ? value.endOffset : undefined;
	const start = typeof value.offset === "number" ? value.offset : 0;
	if (end !== undefined && total !== undefined) {
		const shown = Math.max(0, end - start);
		return `${shown} of ${total} ${total === 1 ? "code unit" : "code units"}`;
	}
	const bytes = typeof value.bytes === "number" ? value.bytes : undefined;
	if (bytes !== undefined) return `${bytes} ${bytes === 1 ? "byte" : "bytes"}`;
	return "";
}

function readItemLine(value: Record<string, unknown>): string {
	if (Array.isArray(value.items)) return countNoun(value.items.length, "item", "items");
	if (typeof value.kind === "string") return `value ${previewMark(value.kind, 40).text}`;
	return "";
}

function readColor(status: string): OutcomeColor {
	if (status === "complete") return "success";
	if (status === "page") return "warning";
	return "muted";
}

/** The returned text with its continuation, or the action or reason when there is none. */
function readSecondRow(value: Record<string, unknown>, continued: boolean): { text: string; hinted: boolean } {
	const preview = typeof value.text === "string" && value.text ? previewMark(value.text, 48).text : "";
	if (preview) return { text: [preview, continued ? "continuation available" : ""].filter(Boolean).join(" · "), hinted: true };
	const action = typeof value.action === "string" && value.action ? previewMark(value.action, 160).text : "";
	const reason = typeof value.reason === "string" && value.reason ? previewMark(value.reason, 160).text : "";
	const detail = action || reason;
	return { text: [detail, continued ? "continuation available" : ""].filter(Boolean).join(" · "), hinted: detail !== "" || continued };
}

/** The exact stored evidence this page returns: text first, then item pointers. */
function readEvidence(value: Record<string, unknown>): string {
	const lines: string[] = [];
	if (typeof value.text === "string" && value.text) {
		lines.push("Text (exact stored page):", escapeControls(clip(value.text, 4000)));
	} else if (Array.isArray(value.items)) {
		lines.push(`Items (first ${Math.min(EVIDENCE_ITEMS, value.items.length)} of ${value.items.length}):`);
		for (const itemValue of value.items.slice(0, EVIDENCE_ITEMS)) {
			const item = asRecord(itemValue) ?? {};
			const pointer = stringField(item, "pointer");
			const kind = stringField(item, "kind");
			lines.push(`  ${[pointer ? previewMark(pointer, 96).text : "", kind].filter(Boolean).join(" · ")}`);
		}
		if (value.items.length > EVIDENCE_ITEMS) lines.push(`(+${value.items.length - EVIDENCE_ITEMS} more items in the raw payload)`);
	} else {
		const action = stringField(value, "action");
		const reason = stringField(value, "reason");
		const detail = action || reason;
		if (detail) lines.push(previewMark(detail, 200).text);
	}
	return lines.join("\n");
}

/** Entry identity plus selectors, membership, and continuation for the read page. */
function readScope(value: Record<string, unknown>): string {
	const entry = asRecord(field(value, "entry")) ?? {};
	const identity = [entryIdentity(entry), entryLabel(field(entry, "id"))].filter(Boolean).join(" · ");
	const pointer = stringField(value, "pointer");
	const membership = stringField(value, "membership");
	const parts = [
		identity ? `entry ${identity}` : "",
		`session ${previewMark(stringField(value, "sessionId") || "(unknown)", 48).text}`,
		pointer ? `pointer ${previewMark(pointer, 96).text}` : "pointer (manifest)",
		membership ? `membership ${membership}` : "",
		continuationWord(value),
	].filter(Boolean);
	return parts.join(" · ");
}

/** The read card states the read status and returned page; the request already names the entry. */
export function renderReadResult(
	result: AgentToolResult<unknown>,
	options: ToolRenderResultOptions,
	theme: Theme,
	context: ResultContext,
): Component {
	if (options.isPartial) return partialCard("Reading entry...", theme, context);
	if (context.isError) return errorCard("history_read", result, options, theme, context);
	const value = payload(result);
	if (value === undefined) {
		return resultCard(
			{ color: "muted", line: previewMark(textContent(result), 160).text || "history_read" },
			"",
			false,
			textContent(result),
			options,
			theme,
			context,
		);
	}
	const status = typeof value.status === "string" ? value.status : "unknown";
	const descriptor = typeof value.text === "string" ? readDescriptor(value) : readItemLine(value);
	const statusWord = READ_STATUS[status] ?? status;
	const continued = value.next !== null && value.next !== undefined;
	const second = readSecondRow(value, continued);
	const expandedBody = [
		readEvidence(value),
		`Scope: ${readScope(value)}`,
		"Raw payload (retained):",
		JSON.stringify(value, null, 2),
	].join("\n\n");
	return resultCard(
		{ color: readColor(status), line: `${statusWord}${descriptor ? ` · ${descriptor}` : ""}` },
		second.text,
		second.hinted,
		expandedBody,
		options,
		theme,
		context,
	);
}
