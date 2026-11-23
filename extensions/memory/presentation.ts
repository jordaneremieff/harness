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
const PREVIEW_ARRAY_LIMIT = 20;
const PREVIEW_LINES = 5;
const WITHHOLD_THRESHOLD = 120;
const WITHHELD_KEYS = new Set(["summary", "details", "sources", "reason", "title", "oldText", "newText"]);

type CardDisclosure = { hasResult: boolean; hidesArgs: (width: number) => boolean };
type MemoryRenderState = { disclosure?: CardDisclosure };

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

/** Longest prefix that never splits a surrogate pair. */
function clip(value: string, limit: number): string {
	const end = Math.min(value.length, limit);
	return value.slice(0, /[\uD800-\uDBFF]/u.test(value[end - 1] ?? "") ? end - 1 : end);
}

/** Join non-empty parts with the card separator. */
function joinedParts(parts: string[]): string {
	return parts.filter((part) => part !== "").join(" · ");
}

function textContent(result: AgentToolResult<unknown>): string {
	return result.content
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("\n");
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

function withheldSize(value: unknown): string {
	if (typeof value === "string") return counted([...value].length, "character");
	if (Array.isArray(value)) return counted(value.length, "item");
	return "withheld";
}

function safeArgument(value: unknown, key = ""): unknown {
	if (WITHHELD_KEYS.has(key)) return withheldSize(value);
	if (typeof value === "string") return value.length > WITHHOLD_THRESHOLD ? withheldSize(value) : value;
	if (Array.isArray(value)) {
		const kept = value.slice(0, PREVIEW_ARRAY_LIMIT).map((item) => safeArgument(item));
		return value.length > kept.length ? [...kept, counted(value.length - kept.length, "omitted item")] : kept;
	}
	if (value !== null && typeof value === "object")
		return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, safeArgument(item, key)]));
	return value;
}

function argumentLines(fields: Record<string, unknown>, withhold: boolean): string {
	return Object.entries(fields)
		.map(([key, value]) => {
			const safe = withhold ? safeArgument(value, key) : value;
			const text = withhold && WITHHELD_KEYS.has(key) ? String(safe) : (JSON.stringify(safe, null, 2) ?? String(safe));
			return `  ${rowText(key)}: ${text.replaceAll("\n", "\n  ")}`;
		})
		.join("\n");
}

function cardCall(
	name: string,
	subject: string,
	facts: string,
	fields: Record<string, unknown>,
	shown: string[],
	withhold: boolean,
	theme: Theme,
	context: CallContext,
): Component {
	const heading = theme.fg("toolTitle", theme.bold(name)) + (subject ? theme.fg("accent", ` ${rowText(subject)}`) : "");
	const factsLine = rowText(facts);
	const extra = Object.keys(fields).some((key) => !shown.includes(key));
	const disclosure: CardDisclosure = {
		hasResult: false,
		hidesArgs: (width) => extra || visibleWidth(heading) > width || visibleWidth(factsLine) > width,
	};
	if (context.state) context.state.disclosure = disclosure;
	const body = context.expanded ? argumentLines(fields, withhold) : "";
	if (context.expanded)
		return textComponent(body ? `${heading}\n${limitBody(body, theme, "muted")}` : heading, context.lastComponent);
	const hint = expansionHint(theme, context, false);
	return widthAware((width) => {
		const rows = [truncateToWidth(heading, width, "…")];
		if (factsLine) rows.push(truncateToWidth(theme.fg("muted", factsLine), width, "…"));
		if (hint && !disclosure.hasResult && disclosure.hidesArgs(width)) rows.push(truncateToWidth(hint, width, "…"));
		return rows;
	});
}

function terminalText(value: string): string {
	return stripVTControlCharacters(value).replace(/[\p{Cc}\p{Cf}]/gu, (char) =>
		char === "\n" || char === "\t" ? char : "",
	);
}

function rowText(value: string): string {
	return terminalText(value).replace(/\s+/gu, " ").trim();
}

function widthAware(draw: (width: number) => string[]): Component {
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

function expansionHint(theme: Theme, context: Partial<KeybindingHints>, allowClick: boolean, hiddenLines = 0): string {
	const binding = context.keyText?.("app.tools.expand");
	if (!binding && !allowClick) return "";
	const action = binding
		? (context.keyHint?.("app.tools.expand", "to expand") ?? theme.fg("dim", binding) + theme.fg("muted", " to expand"))
		: theme.fg("muted", "click to expand");
	return (
		theme.fg("muted", `... (${hiddenLines ? `${counted(hiddenLines, "more line")}, ` : ""}`) +
		action +
		theme.fg("muted", ")")
	);
}

function limitBody(value: string, theme: Theme, color: "muted" | "toolOutput" | "error"): string {
	const safe = terminalText(value);
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
		.flatMap((value) => (typeof value === "string" && rowText(value) ? [value] : []));
	const first = terminalText(queries[0] ?? "");
	const query = rowText(first);
	const subject = query ? ` "${query}"` : context.argsComplete === false ? "" : " browse";
	const heading = theme.fg("toolTitle", theme.bold("memory_search")) + (subject ? theme.fg("accent", subject) : "");
	const factLine = searchCallFacts(fields, queries.length, context.argsComplete);
	const disclosure: CardDisclosure = {
		hasResult: false,
		hidesArgs: (width) =>
			queries.length > 1 ||
			!!textField(fields.cursor) ||
			query !== first ||
			visibleWidth(heading) > width ||
			visibleWidth(factLine) > width,
	};
	if (context.state) context.state.disclosure = disclosure;
	if (context.expanded) {
		const body = Object.entries(fields)
			.map(
				([key, value]) =>
					`  ${rowText(key)}: ${(value === null ? "null" : stringifySafe(value)).replaceAll("\n", "\n  ")}`,
			)
			.join("\n");
		return textComponent(body ? `${heading}\n${limitBody(body, theme, "muted")}` : heading, context.lastComponent);
	}
	const hint = expansionHint(theme, context, false);
	return widthAware((width) => {
		const rows = [truncateToWidth(heading, width, "…")];
		if (factLine) rows.push(truncateToWidth(theme.fg("muted", factLine), width, "…"));
		if (hint && !disclosure.hasResult && disclosure.hidesArgs(width)) rows.push(truncateToWidth(hint, width, "…"));
		return rows;
	});
}

function readCall(args: unknown, theme: Theme, context: CallContext): Component {
	const fields = record(args);
	const digest = textField(fields.digest);
	const revision = textField(fields.revision);
	const offset = countField(fields.offset);
	const facts = joinedParts([
		revision ? `revision ${revision}` : "",
		offset !== null ? `offset ${offset}` : "",
		digest ? `digest ${digest}` : "",
	]);
	return cardCall(
		"memory_read",
		textField(fields.slug) ?? "",
		facts,
		fields,
		["slug", "offset", "digest", "revision"],
		false,
		theme,
		context,
	);
}

function historyCall(args: unknown, theme: Theme, context: CallContext): Component {
	const fields = record(args);
	const limit = countField(fields.limit);
	const facts = joinedParts([
		textField(fields.cursor) ? "continuation" : "",
		fields.plan ? "read-only plan" : "",
		limit === null ? "" : `limit ${limit}`,
	]);
	return cardCall(
		"memory_history",
		textField(fields.slug) ?? "",
		facts,
		fields,
		["slug", "limit"],
		false,
		theme,
		context,
	);
}

function mutationCall(name: string, args: unknown, theme: Theme, context: CallContext): Component {
	const fields = record(args);
	const facts: string[] = [];
	if (name === "memory_write") {
		facts.push(textField(fields.expectedDigest) ? "update" : "create");
	} else if (name === "memory_edit" && Array.isArray(fields.edits)) {
		facts.push(counted(fields.edits.length, "edit"));
	} else if (name === "memory_review") {
		if (fields.outcome === "unresolved" || fields.outcome === "confirmed") facts.push(fields.outcome);
		if (fields.reactivate === true) facts.push("reactivation requested");
	}
	return cardCall(
		name,
		textField(fields.slug) ?? "",
		joinedParts(facts),
		fields,
		["slug", "outcome", "reactivate"],
		true,
		theme,
		context,
	);
}

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
		...freshnessEvidence(note.freshness),
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

function unstructuredResult(
	result: AgentToolResult<unknown>,
	options: ToolRenderResultOptions,
	theme: Theme,
	context: ResultContext,
	progress = "Search in progress",
): Component {
	const partial = options.isPartial;
	const color = partial ? "muted" : context.isError ? "error" : "toolOutput";
	const safe = partial ? "" : terminalText(textContent(result)).trim();
	const first =
		safe
			.split("\n")
			.map(rowText)
			.find((line) => line !== "" && line !== "<harness>" && line !== "</harness>") ?? "";
	const outcome = partial ? progress : first || (context.isError ? "Memory tool failed" : "No displayable result");
	if (safe && options.expanded) return textComponent(`\n${limitBody(safe, theme, color)}`, context.lastComponent);
	const hint = options.expanded ? "" : expansionHint(theme, context, true);
	return widthAware((width) => {
		const rows = ["", truncateToWidth(theme.fg(color, outcome), width, "…")];
		const hidden = safe !== first || (!!safe && visibleWidth(first) > width);
		if (hint && (hidden || context.state?.disclosure?.hidesArgs(width))) rows.push(truncateToWidth(hint, width, "…"));
		return rows;
	});
}

function searchPreview(details: Record<string, unknown>, notes: Record<string, unknown>[]): string {
	const retired = countField(details.excludedRetired);
	return terminalText(
		[
			...notes.map((note) =>
				rowText(
					joinedParts([
						`• ${noteHeading(note, true)}${textField(note.cueProblem) ? " [cue problem]" : ""}`,
						note.lifecycle ? searchLifecycle(note, lifecycleView(note)) : "",
						freshnessFlag(note.freshness),
					]),
				),
			),
			retired ? `${counted(retired, "retired note")} excluded in this window` : "",
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
	const details = context.isError ? {} : resultDetails(result, "index");
	const notes = Array.isArray(details.notes) ? details.notes.map(record) : null;
	if (options.isPartial || context.isError || !notes || notes.some((note) => !textField(note.slug)))
		return unstructuredResult(result, options, theme, context);
	const { outcome, warning } = searchOverview(details, notes.length);
	const heading = theme.fg("toolOutput", outcome);
	if (options.expanded) {
		return textComponent(
			[
				"",
				heading,
				warning ? theme.fg("warning", warning) : "",
				limitBody(searchBody(details, notes), theme, "toolOutput"),
			]
				.filter((line, index) => index === 0 || line !== "")
				.join("\n"),
			context.lastComponent,
		);
	}
	const hint = expansionHint(theme, context, true);
	const preview = searchPreview(details, notes);
	return widthAware((width) => {
		const rows = [
			"",
			truncateToWidth(heading, width, "…"),
			...truncateToVisualLines(preview, PREVIEW_LINES, width, 0, "start").visualLines.map((line) =>
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

type CardBody = {
	outcome: string;
	preview?: string;
	body?: string;
	warning?: string;
	samePreview?: boolean;
};

function cardResult(view: CardBody, options: ToolRenderResultOptions, theme: Theme, context: ResultContext): Component {
	const color = options.isPartial ? "muted" : context.isError ? "error" : "toolOutput";
	const heading = theme.fg(color, rowText(view.outcome));
	const warning = view.warning ? theme.fg("warning", `[${rowText(view.warning)}]`) : "";
	if (options.expanded) {
		const body = view.body ? limitBody(view.body, theme, color) : "";
		return textComponent(["", heading, ...[warning, body].filter(Boolean)].join("\n"), context.lastComponent);
	}
	const safe = terminalText(view.preview ?? "");
	return widthAware((width) => {
		const preview = truncateToVisualLines(safe, PREVIEW_LINES, width, 0, "start");
		const rows = [
			"",
			truncateToWidth(heading, width, "…"),
			...preview.visualLines.map((line) => theme.fg("toolOutput", line)),
		];
		if (warning) rows.push(truncateToWidth(warning, width, "…"));
		if (view.body || visibleWidth(heading) > width || context.state?.disclosure?.hidesArgs(width)) {
			const hint = expansionHint(theme, context, true, view.samePreview ? preview.skippedCount : 0);
			rows.push(truncateToWidth(hint, width, "…"));
		}
		return rows;
	});
}

function resultDetails(result: AgentToolResult<unknown>, kind: string): Record<string, unknown> {
	if (Object.keys(record(result.details)).length > 0) return record(result.details);
	try {
		const candidate = record(JSON.parse(textContent(result)));
		if (candidate.kind === kind && candidate.ok === true) return candidate;
	} catch {
		// Unstructured text is displayed as text, not interpreted as a receipt.
	}
	return {};
}

function captureClock(value: unknown): string {
	if (typeof value !== "string") return "";
	const date = new Date(value);
	if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) return "";
	const today = new Date();
	const time = date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });
	if (date.toDateString() === today.toDateString()) return time;
	const day = date.toLocaleDateString("en-GB", {
		day: "numeric",
		month: "short",
		...(date.getFullYear() === today.getFullYear() ? {} : { year: "numeric" }),
	});
	return `${day} ${time}`;
}

function knownLabel(label: string, value: unknown): string {
	const text = textField(value);
	return text ? `${label}: ${text}` : "";
}

function readContinuation(details: Record<string, unknown>): string {
	const { slug, digest, revision } = details;
	const offset = countField(details.nextOffset);
	if (textField(slug) && textField(digest) && offset !== null) {
		return (
			"Continue with memory_read:\n" +
			JSON.stringify({ slug, offset, digest, ...(textField(revision) ? { revision } : {}) }, null, 2)
		);
	}
	if (details.hasMore === true)
		return "This page reports more source, but does not give a complete continuation identity.";
	return details.hasMore === false && details.nextOffset === null ? "End of source." : "";
}

function readReferenceEvidence(details: Record<string, unknown>) {
	const refs = Array.isArray(details.staleReferences) ? details.staleReferences.map(record) : [];
	const coverage = record(details.staleReferenceCoverage);
	const warning = joinedParts([
		refs.length ? counted(refs.length, "stale reference") : "",
		coverage.complete === false ? "reference coverage partial" : "",
		countField(coverage.count) !== null && Number(coverage.count) > refs.length
			? "some stale references not listed"
			: "",
	]);
	return {
		warning,
		evidence: [
			...refs.map(
				(ref) =>
					"Stale reference: " +
					joinedParts([
						textField(ref.slug) ?? "",
						textField(ref.status) ?? "",
						knownLabel("Replacement", ref.supersededBy),
					]),
			),
			...numberLines([
				["Reference matches observed", coverage.count],
				["Reference entries visited", coverage.entriesVisited],
				["Reference notes checked", coverage.notesChecked],
			]),
			textField(details.staleReferenceGuidance) ?? "",
		],
	};
}

function readResult(
	result: AgentToolResult<unknown>,
	options: ToolRenderResultOptions,
	theme: Theme,
	context: ResultContext,
): Component {
	const details = resultDetails(result, "note");
	if (options.isPartial || context.isError || typeof details.content !== "string")
		return unstructuredResult(result, options, theme, context, "Read in progress");
	const chars = countField(details.contentCodePoints) ?? [...details.content].length;
	const total = countField(details.totalCodePoints);
	const offset = countField(details.offset);
	const end = offset === null ? null : offset + chars;
	const continuation = readContinuation(details);
	const more = details.hasMore === true || countField(details.nextOffset) !== null;
	const lifecycle = lifecycleView(details);
	const refs = readReferenceEvidence(details);
	const size = total === null ? counted(chars, "character") : `${chars} of ${counted(total, "character")}`;
	const scope = details.source === "history" ? " on this historical page" : " on this page";
	const warning = joinedParts([lifecycle.warning, freshnessFlag(details.freshness), refs.warning]);
	const evidence = [
		continuation,
		offset !== null && end !== null ? `Source range: [${offset}, ${end}) code points` : "",
		knownLabel("Digest", details.digest),
		knownLabel("Revision", details.revision),
		knownLabel("Captured", captureClock(details.capturedAt)),
		lifecycle.label,
		knownLabel("Lifecycle problem", lifecycle.problem),
		textField(details.authority) ?? "",
		...freshnessEvidence(details.freshness),
		...refs.evidence,
	]
		.filter(Boolean)
		.join("\n");
	return cardResult(
		{
			outcome: size + scope + (more ? "; more source follows" : ""),
			preview: details.content,
			body: [evidence, details.content].filter(Boolean).join("\n\n"),
			warning,
			samePreview: terminalText(`${evidence}\n\n${details.content}`).length <= DISPLAY_LIMIT,
		},
		options,
		theme,
		context,
	);
}

type LifecycleView = { label: string; problem: string | null; warning: string };

function lifecycleView(details: Record<string, unknown>): LifecycleView {
	if (details.source === "contract") return { label: "Contract source", problem: null, warning: "" };
	const lifecycle = record(details.lifecycle);
	const status = ["active", "superseded", "retired"].includes(String(lifecycle.status)) ? String(lifecycle.status) : "";
	const prefix = details.source === "history" ? "Historical evidence · prior " : "";
	const label = joinedParts([
		status ? `${prefix}status ${status}` : "Lifecycle not established",
		textField(lifecycle.supersededBy) ? `replacement ${lifecycle.supersededBy}` : "",
	]);
	const problem = textField(lifecycle.problem);
	return { label, problem, warning: status === "retired" || status === "superseded" || problem ? label : "" };
}

/** Exceptional freshness only: policy and deadline details stay in the expanded evidence. */
function freshnessFlag(value: unknown): string {
	const freshness = record(value);
	const problems = stringList(freshness.problems).length;
	return joinedParts([
		freshness.deadline === "due" ? "review due" : "",
		Object.keys(record(freshness.concern)).length ? "unresolved concern" : "",
		problems ? counted(problems, "freshness problem") : "",
	]);
}

function freshnessRecord(label: string, value: unknown): string[] {
	const evidence = record(value);
	return [
		knownLabel(label, evidence.date),
		...["digest", "reason", "sources"].map((field) => knownLabel(`${label} ${field}`, evidence[field])),
	].filter(Boolean);
}

function freshnessEvidence(value: unknown): string[] {
	const freshness = record(value);
	if (!Object.keys(freshness).length) return [];
	return [
		knownLabel("Freshness evaluated on", freshness.evaluatedOn),
		typeof freshness.verified === "boolean" ? `Declared verified: ${freshness.verified}` : "",
		knownLabel("Declared verification date", freshness.verifiedDate),
		freshness.policy === "unknown" ? "Review policy not established" : knownLabel("Review policy", freshness.policy),
		freshness.deadline === "unknown"
			? "Review deadline not established"
			: knownLabel("Review deadline", freshness.deadline),
		knownLabel("Review after", freshness.reviewAfter),
		...freshnessRecord("Unresolved concern", freshness.concern),
		...freshnessRecord("Last review", freshness.lastReview),
		...freshnessRecord("Retirement", freshness.retirement),
		...stringList(freshness.problems).map((problem) => `Freshness problem: ${problem}`),
		"Metadata records declarations, not proof of current truth.",
	].filter(Boolean);
}

type MutationOperation = "write" | "edit" | "review" | "retire";
const MUTATION_OPERATIONS: Record<string, MutationOperation> = {
	memory_write: "write",
	memory_edit: "edit",
	memory_review: "review",
	memory_retire: "retire",
};

function files(value: unknown): string[] | undefined {
	return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : undefined;
}

function mutationOutcome(receipt: Record<string, unknown>, operation: MutationOperation) {
	const slug = textField(receipt.slug);
	const target = slug ? ` ${slug}` : "";
	const written = files(receipt.written)?.length;
	const remaining = files(receipt.notWritten)?.length;
	const verb = { write: "Wrote", edit: "Edited", review: "Reviewed", retire: "Retired" }[operation];
	if (receipt.ok === true && !remaining)
		return verb + (target || " note") + (receipt.initialized === true ? "; initialised the corpus" : "");
	if (written === 0) return `No live files were written${slug ? ` for ${slug}` : ""}`;
	if (written === undefined) return `Memory ${operation} failed${slug ? ` for ${slug}` : ""}`;
	if (remaining === undefined) return `Published ${counted(written, "live file")} before failure`;
	if (remaining === 0) return "Published all live files; cleanup failed";
	return `Published ${counted(written, "live file")}; ${counted(remaining, "file")} not written`;
}

function mutationHistory(receipt: Record<string, unknown>): string[] {
	const captures = Array.isArray(receipt.captured) ? receipt.captured : [];
	const omitted = Array.isArray(receipt.historyOmitted) ? receipt.historyOmitted : [];
	return [
		captures.length ? `${counted(captures.length, "prior capture")} (not proof of publication)` : "",
		omitted.length ? `${counted(omitted.length, "history omission")} (credential policy)` : "",
	].filter(Boolean);
}

function mutationEvidence(receipt: Record<string, unknown>): string[] {
	const written = files(receipt.written) ?? [];
	const remaining = files(receipt.notWritten) ?? [];
	const captures = Array.isArray(receipt.captured) ? receipt.captured.map(record) : [];
	const omissions = Array.isArray(receipt.historyOmitted) ? receipt.historyOmitted.map(record) : [];
	const refs = record(receipt.affectedReferences);
	const coverage = record(refs.coverage);
	return [
		knownLabel("Subject", receipt.slug),
		knownLabel("Digest", receipt.digest),
		...written.map((file) => `Written: ${file}`),
		...remaining.map((file) => `Not written: ${file}`),
		...mutationHistory(receipt),
		...captures.map(
			(capture) =>
				"Prior capture: " +
				joinedParts([
					textField(capture.slug) ?? "",
					textField(capture.revision) ?? "",
					captureClock(capture.capturedAt),
					textField(capture.digest) ?? "",
					...numberLines([["Bytes", capture.bytes]]),
				]),
		),
		...omissions.map(
			(omission) =>
				`History omission: ${joinedParts([textField(omission.file) ?? "", textField(omission.reason) ?? ""])}`,
		),
		...stringList(refs.notes).map((slug) => `Affected reference in: ${slug}`),
		...numberLines([
			["References observed", refs.count],
			["Reference entries visited", coverage.entriesVisited],
			["Reference notes checked", coverage.notesChecked],
		]),
		coverage.complete === false ? "Affected reference coverage is partial." : "",
		textField(refs.guidance) ?? "",
	].filter(Boolean);
}

function writeResult(
	name: string,
	result: AgentToolResult<unknown>,
	options: ToolRenderResultOptions,
	theme: Theme,
	context: ResultContext,
): Component {
	const operation = MUTATION_OPERATIONS[name];
	if (options.isPartial) return cardResult({ outcome: `Memory ${operation} in progress` }, options, theme, context);
	const receipt = record(result.details);
	const text = textContent(result);
	if (typeof receipt.ok !== "boolean" || !(textField(receipt.slug) || files(receipt.written))) {
		if (!context.isError || (options.expanded && terminalText(text).trim()))
			return unstructuredResult(result, options, theme, context);
		return cardResult({ outcome: `Memory ${operation} failed`, body: text }, options, theme, context);
	}
	const diagnostic = context.isError || receipt.ok === false ? text || textField(receipt.error) || "" : "";
	return cardResult(
		{
			outcome: mutationOutcome(receipt, operation),
			preview: mutationHistory(receipt).join("\n"),
			body: [...mutationEvidence(receipt), diagnostic].filter(Boolean).join("\n"),
		},
		options,
		theme,
		context,
	);
}

function historyPlanEvidence(plan: Record<string, unknown>): string[] {
	if (Object.keys(plan).length === 0) return [];
	return [
		"Read-only history plan",
		knownLabel("Captured before", captureClock(plan.capturedBefore)),
		...numberLines([
			["Keep newest", plan.keepNewest],
			["Available bytes on this metadata page", plan.availableBytes],
			["Keep bytes on this metadata page", plan.keepBytes],
			["Candidate bytes on this metadata page", plan.candidateBytes],
			["Kept revisions on this page", plan.kept],
			["Candidate revisions on this page", plan.candidates],
			["Unavailable revisions on this page", plan.unavailable],
		]),
		knownLabel("Plan scope", plan.meaning),
		"Capture-name digests are unverified. This plan authorises no removal and imposes no retained-storage bound.",
	].filter(Boolean);
}

function historyContinuation(details: Record<string, unknown>, slug: string, plan: Record<string, unknown>): string {
	const cursor = textField(details.nextCursor);
	if (!cursor) return details.nextCursor === null ? "End of the capture inventory; coverage limits still apply." : "";
	const { capturedBefore, keepNewest } = plan;
	if (Object.keys(plan).length && (!textField(capturedBefore) || countField(keepNewest) === null))
		return `More capture metadata follows; reuse the original plan with cursor:\n${cursor}`;
	const args = { slug, ...(capturedBefore ? { plan: { capturedBefore, keepNewest } } : {}), cursor };
	return `Continue with memory_history:\n${JSON.stringify(args, null, 2)}`;
}

function historyCoverage(coverage: Record<string, unknown>): string[] {
	return [
		coverage.inventoryComplete === true ? "Capture name inventory: complete" : "",
		coverage.bodiesRead === false ? "Historical bodies were not read." : "",
		...numberLines([
			["Capture names in inventory", coverage.totalRevisions],
			["Entries visited", coverage.visited],
			["Excluded entries", coverage.excludedEntries],
			["Window start", coverage.start],
			["Window end", coverage.end],
			["Unavailable revisions on this page", coverage.unavailable],
		]),
		...(Array.isArray(coverage.issues)
			? coverage.issues.map((issue) => knownLabel("Inventory issue", record(issue).message))
			: []),
	].filter(Boolean);
}

function revisionEvidence(revision: Record<string, unknown>): string {
	return [
		knownLabel("Revision", revision.revision),
		knownLabel("Captured", captureClock(revision.capturedAt)),
		knownLabel("Digest", revision.digest),
		...numberLines([["Bytes", revision.bytes]]),
		knownLabel("Selection", revision.selection),
		knownLabel("Reason", revision.reason),
	]
		.filter(Boolean)
		.join("\n");
}

function historyResult(
	result: AgentToolResult<unknown>,
	options: ToolRenderResultOptions,
	theme: Theme,
	context: ResultContext,
): Component {
	const details = resultDetails(result, "history");
	const slug = textField(details.slug);
	if (options.isPartial || context.isError || !slug || !Array.isArray(details.revisions))
		return unstructuredResult(result, options, theme, context, "History read in progress");
	const revisions = details.revisions.map(record);
	const coverage = record(details.coverage);
	const plan = record(details.plan);
	const unavailable = countField(coverage.unavailable);
	const available = revisions.length ? counted(revisions.length, "prior capture") : "No prior captures returned";
	const continuation = historyContinuation(details, slug, plan);
	const body = [
		continuation,
		textField(details.authority) ?? "Historical evidence, not current authority.",
		...historyCoverage(coverage),
		...historyPlanEvidence(plan),
		...revisions.map(revisionEvidence),
	]
		.filter(Boolean)
		.join("\n");
	const outcome = `${available} on this metadata page${textField(details.nextCursor) ? "; more pages available" : ""}`;
	const warning = joinedParts([
		coverage.inventoryComplete === false ? "partial capture inventory" : "",
		unavailable ? counted(unavailable, "unavailable revision") : "",
	]);
	const preview = revisions.map((revision) =>
		rowText(joinedParts([textField(revision.revision) ?? "", textField(revision.selection) ?? ""])),
	);
	if (Object.keys(plan).length)
		preview.unshift(
			joinedParts([
				"Read-only plan",
				countField(plan.candidates) === null ? "" : counted(Number(plan.candidates), "candidate"),
			]),
		);
	return cardResult({ outcome, warning, body, preview: preview.filter(Boolean).join("\n") }, options, theme, context);
}

/** Render a memory tool call card by tool name. */
export function renderCall(name: string, args: unknown, theme: Theme, context: CallContext): Component {
	switch (name) {
		case "memory_search":
			return searchCall(args, theme, context);
		case "memory_read":
			return readCall(args, theme, context);
		case "memory_history":
			return historyCall(args, theme, context);
		case "memory_write":
		case "memory_edit":
		case "memory_review":
		case "memory_retire":
			return mutationCall(name, args, theme, context);
		default:
			return cardCall(name, "", "", {}, [], false, theme, context);
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
	const disclosure = context.state?.disclosure;
	if (disclosure) disclosure.hasResult = true;
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
			return unstructuredResult(result, options, theme, context);
	}
}
