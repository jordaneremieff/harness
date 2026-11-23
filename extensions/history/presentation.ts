import {
	type AgentToolResult,
	type KeybindingHints,
	type Theme,
	type ToolRenderResultOptions,
	truncateToVisualLines,
} from "@earendil-works/pi-coding-agent";
import { type Component, stripTerminalSequences, Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const DISPLAY_LIMIT = 32_000;
const PREVIEW_LINES = 5;

type RecordValue = Record<string, unknown>;
type Hints = Partial<Pick<KeybindingHints, "keyText" | "keyHint">>;

interface CardState {
	resultArrived?: boolean;
}

export interface CallContext extends Hints {
	expanded?: boolean;
	argsComplete?: boolean;
	lastComponent?: Component;
	state?: CardState;
}

export interface ResultContext extends Hints {
	isError: boolean;
	args?: unknown;
	lastComponent?: Component;
	state?: CardState;
}

class HistoryCard implements Component {
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

function card(previous: Component | undefined, layout: (width: number) => string[]): Component {
	return (previous instanceof HistoryCard ? previous : new HistoryCard()).update(layout);
}

function safeText(value: string): string {
	return stripTerminalSequences(value).replace(/[\p{Cc}\p{Cf}]/gu, (char) =>
		char === "\n" || char === "\t" ? char : "",
	);
}

function oneLine(value: string): string {
	return safeText(value).replace(/\s+/gu, " ").trim();
}

/** A copyable selector must preserve characters that cannot be drawn literally. */
function json(value: unknown, indent?: number): string {
	return (JSON.stringify(value, null, indent) ?? "").replace(/[\u007f-\u009f\p{Cf}\u2028\u2029]/gu, (char) => {
		return char
			.split("")
			.map((unit) => `\\u${unit.charCodeAt(0).toString(16).padStart(4, "0")}`)
			.join("");
	});
}

function exactLine(value: string): string {
	return value === oneLine(value) ? value : json(value);
}

function clip(value: string, limit: number): string {
	const end = Math.min(value.length, limit);
	return value.slice(0, /[\uD800-\uDBFF]/u.test(value[end - 1] ?? "") ? end - 1 : end);
}

function characterCount(value: string): number {
	return value.length - (value.match(/[\u{10000}-\u{10FFFF}]/gu)?.length ?? 0);
}

function displayLimit(shown: string, total: string): string {
	return shown.length < total.length
		? `[Truncated: showing ${characterCount(shown)} of ${characterCount(total)} characters]`
		: "";
}

function asRecord(value: unknown): RecordValue | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as RecordValue) : undefined;
}

function stringField(value: RecordValue, key: string): string {
	return typeof value[key] === "string" ? value[key] : "";
}

function numberField(value: RecordValue, key: string): number | undefined {
	const item = value[key];
	return typeof item === "number" && Number.isFinite(item) ? item : undefined;
}

function countNoun(n: number, singular: string, plural: string): string {
	return `${n} ${n === 1 ? singular : plural}`;
}

function entryId(id: unknown): string {
	if (typeof id === "number" && Number.isSafeInteger(id) && id > 0) return String(id);
	return typeof id === "string" ? exactLine(id) : "";
}

function parts(values: string[]): string {
	return values.filter(Boolean).join(" · ");
}

function hintLine(theme: Theme, context: Hints, width: number, skipped = 0): string {
	const key = context.keyText?.("app.tools.expand");
	const action = key
		? (context.keyHint?.("app.tools.expand", "to expand") ?? theme.fg("dim", key) + theme.fg("muted", " to expand"))
		: theme.fg("muted", "click to expand");
	const lead = skipped ? `... (${countNoun(skipped, "more line", "more lines")}, ` : "... (";
	return truncateToWidth(theme.fg("muted", lead) + action + theme.fg("muted", ")"), width, "…");
}

function limitRows(theme: Theme, width: number, limit: string): string[] {
	return limit ? [theme.fg("warning", truncateToWidth(limit, width, "…"))] : [];
}

interface Request {
	name: "history_read" | "history_search";
	subject: string;
	facts: string;
	extra: RecordValue;
}

function requestHasMore({ name, subject, facts, extra }: Request, width: number): boolean {
	return (
		Object.keys(extra).length > 0 ||
		(subject !== "" && name.length + 1 + visibleWidth(subject) > width) ||
		visibleWidth(facts) > width
	);
}

function renderCall(request: Request, theme: Theme, context: CallContext): Component {
	const { name, subject, facts, extra } = request;
	const title = theme.fg("toolTitle", theme.bold(name));
	if (context.expanded) {
		const heading = title + (subject ? ` ${theme.fg("accent", subject)}` : "");
		const args = Object.entries(extra)
			.map(([key, value]) => `  ${exactLine(key)}: ${json(value, 2)}`)
			.join("\n");
		const shown = clip(args, DISPLAY_LIMIT);
		const limit = displayLimit(shown, args);
		const rows = [heading, facts ? theme.fg("muted", facts) : "", shown ? theme.fg("muted", shown) : ""];
		const text = new Text(rows.filter(Boolean).join("\n"), 0, 0);
		return card(context.lastComponent, (width) => [...text.render(width), ...limitRows(theme, width, limit)]);
	}
	return card(context.lastComponent, (width) => {
		const room = width - name.length - 1;
		// Pi runs both renderer factories before draw, including on replay.
		const hint =
			context.state &&
			!context.state.resultArrived &&
			requestHasMore(request, width) &&
			context.keyText?.("app.tools.expand");
		return [
			width < name.length
				? theme.fg("toolTitle", theme.bold(truncateToWidth(name, width, "…")))
				: title + (subject && room > 0 ? ` ${theme.fg("accent", truncateToWidth(subject, room, "…"))}` : ""),
			...(facts ? [theme.fg("muted", truncateToWidth(facts, width, "…"))] : []),
			...(hint ? [hintLine(theme, context, width)] : []),
		];
	});
}

function readRequest(input: unknown): Request {
	const { entryId: id, pointer, offset, ...extra } = asRecord(input) ?? {};
	return {
		name: "history_read",
		subject: entryId(id),
		facts: parts([
			typeof pointer === "string" ? exactLine(pointer) : "",
			typeof offset === "number" && offset > 0 ? `offset ${offset}` : "",
		]),
		extra,
	};
}

export function renderReadCall(input: unknown, theme: Theme, context: CallContext): Component {
	return renderCall(readRequest(input), theme, context);
}

function filterLabel(value: unknown): string {
	const filter = asRecord(value);
	if (!filter) return "";
	const { source, toolName, errorsOnly } = filter;
	if (typeof source !== "string" || !source) return "";
	const tool = typeof toolName === "string" && toolName ? `(${exactLine(toolName)})` : "";
	return `filter ${oneLine(source)}${tool}${errorsOnly === true ? " errors only" : ""}`;
}

function searchPosition(position: unknown, slot: unknown, offset: unknown): string {
	const cursor = asRecord(position);
	const path = Array.isArray(cursor?.path) ? cursor.path.filter((item) => typeof item === "number") : [];
	return [
		typeof cursor?.message === "number" ? `message ${cursor.message}` : "",
		typeof cursor?.block === "number" ? `block ${cursor.block}` : "",
		path.length ? `path ${path.join("/")}` : "",
		typeof slot === "number" ? `slot ${slot}` : "",
		typeof offset === "number" ? `offset ${offset}` : "",
	]
		.filter(Boolean)
		.join(" ");
}

function searchRequest(input: unknown, argsComplete?: boolean): Request {
	const { query, fromId, mode, filter, position, slot, offset, ...extra } = asRecord(input) ?? {};
	const id = entryId(fromId);
	const cursor = searchPosition(position, slot, offset);
	return {
		name: "history_search",
		subject: typeof query === "string" && query ? json(query) : argsComplete === false ? "" : "listing",
		facts: parts([
			mode === "arguments" ? "in tool arguments" : "",
			filterLabel(filter),
			id ? `from ${id}` : "",
			cursor ? `continuation ${cursor}` : "",
		]),
		extra,
	};
}

export function renderSearchCall(input: unknown, theme: Theme, context: CallContext): Component {
	return renderCall(searchRequest(input, context.argsComplete), theme, context);
}

interface ResultView {
	outcome: string;
	body: string;
	details: string;
	literalOutcome?: string;
	continuation?: string;
	limit?: string;
	countLines?: boolean;
}

function textContent(result: AgentToolResult<unknown>): string {
	return result.content
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

/** Both history hosts currently publish their bounded result envelope as JSON text with empty details. */
function resultPayload(
	result: AgentToolResult<unknown>,
	accepts: (value: RecordValue) => boolean,
): RecordValue | undefined {
	const evidence = (value: unknown) => {
		const record = asRecord(value);
		return record && accepts(record) ? record : undefined;
	};
	const typed = evidence(result.details);
	if (typed) return typed;
	try {
		return evidence(JSON.parse(textContent(result)));
	} catch {
		return undefined;
	}
}

function fallbackResult(result: AgentToolResult<unknown>, error: boolean, name: string): ResultView {
	const text = safeText(textContent(result));
	const visible = text.trimStart();
	const end = visible.indexOf("\n");
	const first = end === -1 ? visible : visible.slice(0, end);
	return {
		outcome: first || (error ? `${name} failed.` : "No history output."),
		body: "",
		literalOutcome: first ? text.slice(0, text.length - visible.length + first.length) : undefined,
		details: end === -1 ? "" : visible.slice(end + 1),
	};
}

function renderResult(
	request: Request,
	view: ResultView,
	options: ToolRenderResultOptions,
	theme: Theme,
	context: ResultContext,
): Component {
	const color = context.isError ? "error" : options.isPartial ? "muted" : "toolOutput";
	const outcome = view.literalOutcome ?? oneLine(view.outcome);
	const body = safeText(view.body);
	const details = safeText(view.details);
	const continuation = safeText(view.continuation ?? "");
	// Reserve space for the copyable cursor ahead of optional evidence and metadata.
	const shownContinuation = clip(continuation, DISPLAY_LIMIT);
	const shownOutcome = clip(outcome, DISPLAY_LIMIT - shownContinuation.length);
	const shownBody = clip(body, DISPLAY_LIMIT - shownContinuation.length - shownOutcome.length);
	const shownDetails = clip(details, DISPLAY_LIMIT - shownContinuation.length - shownOutcome.length - shownBody.length);
	const limit =
		displayLimit(
			shownOutcome + shownBody + shownContinuation + shownDetails,
			outcome + body + continuation + details,
		) ||
		view.limit ||
		"";
	if (options.expanded) {
		const expanded = [shownOutcome, shownBody, shownContinuation, shownDetails].filter(Boolean).join("\n");
		const text = new Text(theme.fg(color, expanded), 0, 0);
		return card(context.lastComponent, (width) => ["", ...text.render(width), ...limitRows(theme, width, limit)]);
	}
	const collapsedOutcome = oneLine(shownOutcome);
	return card(context.lastComponent, (width) => {
		const preview = shownBody
			? truncateToVisualLines(theme.fg(color, shownBody), PREVIEW_LINES, width, 0, "start")
			: { visualLines: [], skippedCount: 0 };
		const hidden =
			preview.skippedCount > 0 ||
			shownContinuation !== "" ||
			shownDetails.trim() !== "" ||
			visibleWidth(collapsedOutcome) > width ||
			requestHasMore(request, width);
		return [
			"",
			theme.fg(color, truncateToWidth(collapsedOutcome, width, "…")),
			...preview.visualLines,
			...limitRows(theme, width, limit),
			...(hidden ? [hintLine(theme, context, width, view.countLines ? preview.skippedCount : 0)] : []),
		];
	});
}

function partsOf<T extends string>(args: RecordValue, keys: readonly T[]): RecordValue {
	return Object.fromEntries(keys.filter((key) => Object.hasOwn(args, key)).map((key) => [key, args[key]]));
}

function continuationCall(
	name: string,
	next: RecordValue | undefined,
	args: unknown,
	repeat: readonly string[],
): string {
	if (!next) return "";
	const input = asRecord(args);
	if (!input && name === "history_search") return `Continuation cursor:\n${json(next, 2)}`;
	const same = input ? partsOf(input, repeat) : {};
	return `Continue with ${name}:\n${json({ ...same, ...next }, 2)}`;
}

function resultDetails(value: RecordValue): string {
	return Object.keys(value).length ? `Result details:\n${json(value, 2)}` : "";
}

const READ_STATUS: Record<string, string> = {
	complete: "Read the field",
	page: "Returned a page",
	unknown_entry: "Entry not found",
	withheld: "Withheld content",
	field_absent: "Field absent",
	structured_omitted: "Structured value omitted",
};

function acceptsRead(value: RecordValue): boolean {
	return (
		Object.hasOwn(READ_STATUS, stringField(value, "status")) &&
		[value.text, value.action, value.reason].every((field) => field === undefined || typeof field === "string") &&
		(value.items === undefined || Array.isArray(value.items))
	);
}

function readCount(value: RecordValue): string {
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

function readItem(item: unknown) {
	const { pointer, kind, text, value, reason, ...details } = asRecord(item) ?? {};
	const content = typeof text === "string" ? json(text) : value === undefined ? "" : json(value);
	return {
		body: parts([
			typeof pointer === "string" ? exactLine(pointer) : "",
			typeof kind === "string" ? oneLine(kind) : "",
			content,
			typeof reason === "string" ? (reason === "pointerLength" ? "pointer too long" : oneLine(reason)) : "",
		]),
		details,
	};
}

function readView(value: RecordValue, args: unknown): ResultView {
	const { status, text, items, action, reason, value: scalar, next, ...metadata } = value;
	const cursor = asRecord(next);
	const offset = cursor ? numberField(cursor, "offset") : undefined;
	const count = readCount(value);
	const continued = offset === undefined ? "" : `; continuation at offset ${offset}`;
	const entries = Array.isArray(items) ? items.map(readItem) : [];
	const itemDetails = entries.flatMap(({ details }, index) =>
		Object.keys(details).length ? [{ item: index + 1, ...details }] : [],
	);
	const guide = typeof action === "string" ? action : "";
	return {
		outcome: `${READ_STATUS[String(status)]}${count ? `: ${count}` : ""}${continued}.`,
		body: [
			typeof text === "string" ? text : "",
			...entries.map(({ body }) => body),
			scalar === undefined ? "" : json(scalar),
			typeof reason === "string" ? reason : "",
		]
			.filter(Boolean)
			.join("\n"),
		continuation: continuationCall("history_read", cursor, args, ["maxBytes", "maxItems", "maxOutputBytes"]),
		details: resultDetails({
			...metadata,
			...(itemDetails.length ? { items: itemDetails } : {}),
			...(guide ? { action: guide } : {}),
		}),
		limit: asRecord(value.entry)?.truncated === true ? "[Stored source was truncated]" : undefined,
		countLines: !Array.isArray(items),
	};
}

export function renderReadResult(
	result: AgentToolResult<unknown>,
	options: ToolRenderResultOptions,
	theme: Theme,
	context: ResultContext,
): Component {
	if (context.state) context.state.resultArrived = true;
	const request = readRequest(context.args);
	const value = !context.isError && !options.isPartial ? resultPayload(result, acceptsRead) : undefined;
	const view =
		options.isPartial && !context.isError
			? { outcome: "Reading entry…", body: "", details: "" }
			: value
				? readView(value, context.args)
				: fallbackResult(result, context.isError, request.name);
	return renderResult(request, view, options, theme, context);
}

const SEARCH_STATUS: Record<string, string> = {
	ancestry_exhausted: "reached the end of the selected ancestry",
	visit_limit: "entry visit limit",
	node_limit: "argument node limit",
	scan_limit: "scan byte limit",
	slot_limit: "text slot limit",
	candidate_limit: "physical candidate limit",
	match_limit: "match limit",
	output_limit: "output limit",
	unknown_entry: "start entry not found",
	missing_parent: "parent entry missing",
	cycle: "parent cycle",
};

function acceptsSearch(value: RecordValue): boolean {
	return (
		Object.hasOwn(SEARCH_STATUS, stringField(value, "status")) &&
		(value.matches === undefined || Array.isArray(value.matches))
	);
}

function searchOutcome(value: RecordValue, args: unknown): string {
	const status = stringField(value, "status");
	const count = Array.isArray(value.matches) ? value.matches.length : undefined;
	const visited = numberField(value, "visited");
	const call = asRecord(args);
	const listing = call !== undefined && call.query === undefined;
	const returned =
		count === undefined
			? ""
			: listing
				? countNoun(count, "entry returned", "entries returned")
				: countNoun(count, "match", "matches");
	const scope = visited === undefined ? "" : countNoun(visited, "entry visited", "entries visited");
	const stop = SEARCH_STATUS[status];
	const fields = [returned, scope, stop, asRecord(value.next) ? "continuation available" : ""]
		.filter(Boolean)
		.join("; ");
	return `${fields.charAt(0).toUpperCase()}${fields.slice(1)}.`;
}

function matchIdentity(entry: unknown, call: unknown) {
	const { id, kind, type, role, toolName, isError, truncated, ...entryDetails } = asRecord(entry) ?? {};
	const { name, ...callDetails } = asRecord(call) ?? {};
	const line = parts([
		entryId(id),
		oneLine(typeof kind === "string" ? kind : typeof type === "string" ? type : ""),
		typeof toolName === "string" ? `tool ${oneLine(toolName)}` : typeof role === "string" ? oneLine(role) : "",
		isError === true ? "stored error" : "",
		truncated === true ? "stored source truncated" : "",
		typeof name === "string" ? `call ${oneLine(name)}` : "",
	]);
	return {
		line,
		details: {
			...(Object.keys(entryDetails).length ? { entry: entryDetails } : {}),
			...(Object.keys(callDetails).length ? { call: callDetails } : {}),
		},
	};
}

function matchView(value: unknown) {
	const { entry, call, pointer, offset, endOffset, excerpt, excerptEndOffset, ...more } = asRecord(value) ?? {};
	const identity = matchIdentity(entry, call);
	const span =
		typeof offset === "number" && typeof endOffset === "number" ? `match offsets ${offset}..${endOffset}` : "";
	const excerptSpan =
		typeof offset === "number" && typeof excerptEndOffset === "number" ? ` offsets ${offset}..${excerptEndOffset}` : "";
	return {
		body: [
			identity.line,
			parts([typeof pointer === "string" ? exactLine(pointer) : "", span]),
			typeof excerpt === "string" ? `Retained excerpt${excerptSpan}:\n${excerpt}` : "",
		]
			.filter(Boolean)
			.join("\n"),
		details: { ...identity.details, ...more },
	};
}

function skippedValues(skipped: unknown): string {
	const counts = asRecord(skipped);
	if (!counts) return "";
	const count = (numberField(counts, "depth") ?? 0) + (numberField(counts, "pointerLength") ?? 0);
	return count > 0 ? `[${countNoun(count, "argument value skipped", "argument values skipped")}]` : "";
}

function searchView(value: RecordValue, args: unknown): ResultView {
	const { status: _status, matches, next, gap, visited: _visited, ...metadata } = value;
	const records = Array.isArray(matches) ? matches.map(matchView) : [];
	const notes = records.flatMap(({ details }, index) =>
		Object.keys(details).length ? [{ record: index + 1, ...details }] : [],
	);
	const gapRecord = asRecord(gap);
	const gapId = gapRecord ? entryId(gapRecord.entryId) : "";
	const gapAction = gapRecord ? stringField(gapRecord, "action") : "";
	return {
		outcome: searchOutcome(value, args),
		body: [gapId, ...records.map(({ body }) => body)].filter(Boolean).join("\n"),
		continuation: continuationCall("history_search", asRecord(next), args, [
			"query",
			"mode",
			"filter",
			"maxVisits",
			"maxScanBytes",
			"maxMatches",
			"maxOutputBytes",
		]),
		limit: skippedValues(value.skipped),
		details: resultDetails({
			...metadata,
			...(gapAction ? { action: gapAction } : {}),
			...(notes.length ? { records: notes } : {}),
		}),
	};
}

export function renderSearchResult(
	result: AgentToolResult<unknown>,
	options: ToolRenderResultOptions,
	theme: Theme,
	context: ResultContext,
): Component {
	if (context.state) context.state.resultArrived = true;
	const request = searchRequest(context.args);
	const value = !context.isError && !options.isPartial ? resultPayload(result, acceptsSearch) : undefined;
	const view =
		options.isPartial && !context.isError
			? { outcome: "Searching history…", body: "", details: "" }
			: value
				? searchView(value, context.args)
				: fallbackResult(result, context.isError, request.name);
	return renderResult(request, view, options, theme, context);
}
