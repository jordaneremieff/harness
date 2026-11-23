import {
	type AgentToolResult,
	type KeybindingHints,
	type Theme,
	type ToolRenderResultOptions,
	truncateToVisualLines,
} from "@earendil-works/pi-coding-agent";
import { type Component, stripTerminalSequences, Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const DISPLAY_LIMIT = 32_000;
const EVIDENCE_MATCHES = 3;

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
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
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

interface ReadCardState {
	readResultArrived?: boolean;
}

export interface CallContext extends Hints {
	expanded?: boolean;
	argsComplete?: boolean;
	lastComponent?: Component;
	state?: ReadCardState;
}

export interface ResultContext extends Hints {
	isError: boolean;
	args?: unknown;
	lastComponent?: Component;
	state?: ReadCardState;
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
	const toolName =
		typeof value.toolName === "string" && value.toolName ? `(${previewMark(value.toolName, 60).text})` : "";
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
	return [kind, actor, error, time]
		.filter(Boolean)
		.map((part) => rowSafe(part))
		.join(" · ");
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
	if (
		args?.maxVisits !== undefined ||
		args?.maxScanBytes !== undefined ||
		args?.maxMatches !== undefined ||
		args?.maxOutputBytes !== undefined
	) {
		hint = true;
	}
	return callCard("history_search", subject, qualifiers, hint, input, theme, context);
}

/** A continuation position: native message index, content block, and argument index path. */
function positionLabel(position: Record<string, unknown>): string {
	const message = numberField(position, "message");
	const block = numberField(position, "block");
	const path = Array.isArray(position.path) ? position.path.filter((item) => typeof item === "number") : [];
	return (
		[
			message !== undefined ? `message ${message}` : "",
			block !== undefined ? `block ${block}` : "",
			path.length > 0 ? previewMark(`path ${path.join("/")}`, 48).text : "",
		]
			.filter(Boolean)
			.join(" ") || "position"
	);
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
	const shown = entries
		.slice(0, 4)
		.map(([type, count]) => countNoun(count, type, pluralType(type)))
		.join(", ");
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
	if (matches.length > EVIDENCE_MATCHES)
		lines.push(`(+${matches.length - EVIDENCE_MATCHES} more matches in the raw payload)`);
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
	const unexamined =
		(skipped ? (numberField(skipped, "depth") ?? 0) : 0) + (skipped ? (numberField(skipped, "pointerLength") ?? 0) : 0);
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
		{
			color: searchColor(status, matches.length),
			line: `${countNoun(matches.length, "match", "matches")} · ${countNoun(visited, "entry visited", "entries visited")} · ${statusWord}`,
		},
		[typeTally(matches), continuation].filter(Boolean).join(" · "),
		matches.length > 0,
		expandedBody,
		options,
		theme,
		context,
	);
}

const READ_NAME = "history_read";
const PREVIEW_LINES = 5;

class ReadCard implements Component {
	#layout: (width: number) => string[] = () => [];
	#width?: number;
	#lines: string[] = [];

	update(layout: (width: number) => string[]): this {
		this.#layout = layout;
		this.invalidate();
		return this;
	}

	invalidate(): void {
		this.#width = undefined;
	}

	render(width: number): string[] {
		if (this.#width !== width) {
			this.#lines = this.#layout(width);
			this.#width = width;
		}
		return this.#lines;
	}
}

function readCard(previous: Component | undefined, layout: (width: number) => string[]): Component {
	return (previous instanceof ReadCard ? previous : new ReadCard()).update(layout);
}

function safeReadText(value: string): string {
	return stripTerminalSequences(value).replace(/[\p{Cc}\p{Cf}]/gu, (char) =>
		char === "\n" || char === "\t" ? char : "",
	);
}

function readLine(value: string): string {
	return safeReadText(value).replace(/\s+/gu, " ").trim();
}

function readRequest(input: unknown) {
	const { entryId, pointer, offset, ...extra } = asRecord(input) ?? {};
	const subject =
		typeof entryId === "number" && Number.isSafeInteger(entryId) && entryId > 0
			? `#${entryId}`
			: typeof entryId === "string"
				? readLine(entryId)
				: "";
	const facts = [
		typeof pointer === "string" ? readLine(pointer) : "",
		typeof offset === "number" && offset > 0 ? `offset ${offset}` : "",
	]
		.filter(Boolean)
		.join(" · ");
	return { subject, facts, extra };
}

function requestHasMore({ subject, facts, extra }: ReturnType<typeof readRequest>, width: number): boolean {
	return (
		Object.keys(extra).length > 0 ||
		(subject !== "" && READ_NAME.length + 1 + visibleWidth(subject) > width) ||
		visibleWidth(facts) > width
	);
}

function characterCount(value: string): number {
	return value.length - (value.match(/[\u{10000}-\u{10FFFF}]/gu)?.length ?? 0);
}

function readLimit(shown: string, total: string): string {
	return `[Truncated: showing ${characterCount(shown)} of ${characterCount(total)} characters]`;
}

export function renderReadCall(input: unknown, theme: Theme, context: CallContext): Component {
	const request = readRequest(input);
	const { subject, facts, extra } = request;
	const title = theme.fg("toolTitle", theme.bold(READ_NAME));
	if (context.expanded) {
		const heading = title + (subject ? ` ${theme.fg("accent", subject)}` : "");
		const full = safeReadText(
			Object.entries(extra)
				.map(([key, value]) => `  ${readLine(key)}: ${JSON.stringify(value, null, 2)}`)
				.join("\n"),
		);
		const shown = clip(full, DISPLAY_LIMIT);
		const limit = shown.length < full.length ? readLimit(shown, full) : "";
		const text = new Text(
			[heading, facts ? theme.fg("muted", facts) : "", shown ? theme.fg("muted", shown) : ""]
				.filter(Boolean)
				.join("\n"),
			0,
			0,
		);
		return readCard(context.lastComponent, (width) => [
			...text.render(width),
			...(limit ? [theme.fg("warning", truncateToWidth(limit, width, "…"))] : []),
		]);
	}
	return readCard(context.lastComponent, (width) => {
		const room = width - READ_NAME.length - 1;
		// Pi runs both renderer factories before draw, including on replay.
		const hint =
			context.state &&
			!context.state.readResultArrived &&
			requestHasMore(request, width) &&
			context.keyText?.("app.tools.expand")
				? [truncateToWidth(readHint(theme, context, 0), width, "…")]
				: [];
		return [
			width < READ_NAME.length
				? theme.fg("toolTitle", theme.bold(truncateToWidth(READ_NAME, width, "…")))
				: title + (subject && room > 0 ? ` ${theme.fg("accent", truncateToWidth(subject, room, "…"))}` : ""),
			...(facts ? [theme.fg("muted", truncateToWidth(facts, width, "…"))] : []),
			...hint,
		];
	});
}

const READ_STATUS: Record<string, string> = {
	complete: "Read the field",
	page: "Returned a page",
	unknown_entry: "Entry not found",
	withheld: "Withheld content",
	field_absent: "Field absent",
	structured_omitted: "Structured value omitted",
};

function readPayload(result: AgentToolResult<unknown>): Record<string, unknown> | undefined {
	const evidence = (value: unknown) => {
		const record = asRecord(value);
		if (!record || !Object.hasOwn(READ_STATUS, stringField(record, "status"))) return undefined;
		if ([record.text, record.action, record.reason].some((field) => field !== undefined && typeof field !== "string"))
			return undefined;
		return record.items === undefined || Array.isArray(record.items) ? record : undefined;
	};
	// Both history hosts currently publish the bounded read envelope as JSON text with empty details.
	return evidence(result.details) ?? evidence(payload(result));
}

function readCount(value: Record<string, unknown>): string {
	if (Array.isArray(value.items)) return countNoun(value.items.length, "item", "items");
	if (typeof value.text === "string") {
		const total = numberField(value, "totalCodeUnits");
		const end = numberField(value, "endOffset");
		const start = numberField(value, "offset");
		if (total !== undefined && end !== undefined && start !== undefined && end >= start)
			return `${end - start} of ${countNoun(total, "code unit", "code units")}`;
		const bytes = numberField(value, "bytes");
		if (bytes !== undefined) return countNoun(bytes, "byte", "bytes");
	}
	return "";
}

function readItem(item: unknown): string {
	const record = asRecord(item);
	if (!record) return JSON.stringify(item) ?? "";
	const { pointer, kind, ...extra } = record;
	const selector = typeof pointer === "string" ? safeReadText(pointer) : "";
	return [
		selector === readLine(selector) ? selector : JSON.stringify(selector),
		typeof kind === "string" ? readLine(kind) : "",
		Object.keys(extra).length ? JSON.stringify(extra) : "",
	]
		.filter(Boolean)
		.join(" · ");
}

function readStructured(value: Record<string, unknown>) {
	const { status, text, items, action, reason, value: scalar, ...metadata } = value;
	const count = readCount(value);
	const next = asRecord(value.next);
	const offset = next ? numberField(next, "offset") : undefined;
	const continued = offset === undefined ? "" : ` Continue at offset ${offset}.`;
	const outcome = `${READ_STATUS[String(status)]}${count ? `: ${count}` : ""}.${continued}`;
	const body = [
		typeof text === "string" ? text : "",
		Array.isArray(items) ? items.map(readItem).join("\n") : "",
		scalar === undefined ? "" : JSON.stringify(scalar),
		typeof reason === "string" ? reason : "",
		typeof action === "string" ? action : "",
	]
		.filter(Boolean)
		.join("\n");
	if (metadata.next === null) delete metadata.next;
	return {
		outcome,
		body,
		details: Object.keys(metadata).length ? `Result details:\n${JSON.stringify(metadata, null, 2)}` : "",
		countLines: !Array.isArray(items),
	};
}

function readHint(theme: Theme, context: Hints, skipped: number): string {
	const key = context.keyText?.("app.tools.expand");
	const action = key
		? (context.keyHint?.("app.tools.expand", "to expand") ?? theme.fg("dim", key) + theme.fg("muted", " to expand"))
		: theme.fg("muted", "click to expand");
	return (
		theme.fg("muted", skipped ? `... (${countNoun(skipped, "more line", "more lines")}, ` : "... (") +
		action +
		theme.fg("muted", ")")
	);
}

export function renderReadResult(
	result: AgentToolResult<unknown>,
	options: ToolRenderResultOptions,
	theme: Theme,
	context: ResultContext,
): Component {
	if (context.state) context.state.readResultArrived = true;
	const request = readRequest(context.args);
	if (options.isPartial && !context.isError) {
		return readCard(context.lastComponent, (width) => [
			"",
			theme.fg("muted", truncateToWidth("Reading entry…", width, "…")),
			...(!options.expanded && requestHasMore(request, width)
				? [truncateToWidth(readHint(theme, context, 0), width, "…")]
				: []),
		]);
	}
	const value = context.isError ? undefined : readPayload(result);
	const fallback = value ? "" : safeReadText(textContent(result)).trimStart();
	const firstBreak = fallback.indexOf("\n");
	const first = firstBreak === -1 ? fallback : fallback.slice(0, firstBreak);
	const { outcome, body, details, countLines } = value
		? readStructured(value)
		: {
				outcome: first || (context.isError ? "History read failed." : "No read output."),
				body: "",
				details: firstBreak === -1 ? "" : fallback.slice(firstBreak + 1),
				countLines: false,
			};
	const color = context.isError ? "error" : "toolOutput";
	const safeOutcome = readLine(outcome);
	const safeBody = safeReadText(body);
	const safeDetails = safeReadText(details);
	const total = safeOutcome.length + safeBody.length + safeDetails.length;
	const shownOutcome = clip(safeOutcome, DISPLAY_LIMIT);
	const shownBody = clip(safeBody, DISPLAY_LIMIT - shownOutcome.length);
	const shownDetails = clip(safeDetails, DISPLAY_LIMIT - shownOutcome.length - shownBody.length);
	const shown = shownOutcome.length + shownBody.length + shownDetails.length;
	const limit =
		shown < total ? readLimit(shownOutcome + shownBody + shownDetails, safeOutcome + safeBody + safeDetails) : "";
	return readCard(context.lastComponent, (width) => {
		const limited = limit ? [theme.fg("warning", truncateToWidth(limit, width, "…"))] : [];
		if (options.expanded) {
			const expanded = [shownOutcome, shownBody, shownDetails].filter(Boolean).join("\n");
			return ["", ...new Text(theme.fg(color, expanded), 0, 0).render(width), ...limited];
		}
		const preview = truncateToVisualLines(theme.fg(color, shownBody), PREVIEW_LINES, width, 0, "start");
		const hidden =
			preview.skippedCount > 0 ||
			shownDetails.trim() !== "" ||
			visibleWidth(shownOutcome) > width ||
			requestHasMore(request, width);
		return [
			"",
			theme.fg(color, truncateToWidth(shownOutcome, width, "…")),
			...preview.visualLines,
			...limited,
			...(hidden ? [truncateToWidth(readHint(theme, context, countLines ? preview.skippedCount : 0), width, "…")] : []),
		];
	});
}
