import type { AgentToolResult, KeybindingHints, Theme, ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { clipRow, clipsRow, expansionHint, oneLine, pathLabel, plural, record, safe, wrapBody } from "./card-text.ts";
import { parseFrontmatter } from "./format.ts";
import { readRedactionReport, redactSecrets } from "./redact.ts";

const DISPLAY_LIMIT = 32_000;
const PREVIEW_LINES = 5;
const REOPEN_NOTE = "Reopen this stash before pickup (browser Actions or /stash reopen).";

type Args = Record<string, unknown>;
interface CardState {
	stashHasResult?: boolean;
	stashCallDisclosure?: (width: number) => { hidden: number; other: boolean };
	stashCallLimit?: string;
}
export interface CallContext extends Partial<KeybindingHints> {
	expanded?: boolean;
	argsComplete?: boolean;
	state?: CardState;
	lastComponent?: Component;
}
export interface ResultContext extends Partial<KeybindingHints> {
	isError: boolean;
	args?: unknown;
	state?: CardState;
	lastComponent?: Component;
}

const string = (value: unknown) => (typeof value === "string" ? value : "");
const safeCopy = (text: string) => redactSecrets(safe(text));
const path = (value: unknown) => pathLabel(string(value));
const lines = (...parts: string[]) => parts.filter(Boolean).join("\n");
const argsText = (args: Args) =>
	Object.entries(args)
		.map(([key, value]) => {
			const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
			return `  ${key}: ${(text ?? "").replace(/\n/gu, "\n  ")}`;
		})
		.join("\n");
function characterCount(value: string): number {
	let count = 0;
	for (const _ of value) count++;
	return count;
}
const bodySize = (value: string) => plural(characterCount(value), "character", "characters");

function bounded(text: string): { text: string; limit?: string } {
	if (text.length <= DISPLAY_LIMIT) return { text };
	let count = 0;
	let end = 0;
	for (const point of text) {
		if (++count <= DISPLAY_LIMIT) end += point.length;
	}
	return count <= DISPLAY_LIMIT
		? { text }
		: { text: text.slice(0, end), limit: `[Truncated: showing ${DISPLAY_LIMIT} of ${count} characters]` };
}

function textContent(result: AgentToolResult<unknown>): string {
	return result.content
		.flatMap((block) => (block.type === "text" ? [block.text] : []))
		.join("\n")
		.trim();
}

function report(details: Args) {
	try {
		return readRedactionReport(details.redactions);
	} catch {
		return undefined;
	}
}

function redactionCount(details: Args): string {
	const count = report(details)?.count ?? 0;
	return count > 0 ? `${plural(count, "credential value", "credential values")} redacted` : "";
}

function redactionBody(details: Args): string {
	const redactions = report(details);
	if (!redactions?.count) return "";
	return lines(
		Object.entries(redactions.classes)
			.map(([kind, count]) => `${kind}: ${count}`)
			.join(", "),
		...redactions.contexts,
		redactions.count > redactions.contexts.length
			? `Contexts retained for ${redactions.contexts.length} of ${redactions.count} replacements.`
			: "",
	);
}

function component(render: (width: number) => string[], previous?: Component): Component {
	if (previous instanceof CardRows) {
		previous.render = render;
		return previous;
	}
	return new CardRows(render);
}
class CardRows implements Component {
	render: (width: number) => string[];
	constructor(render: (width: number) => string[]) {
		this.render = render;
	}
	invalidate(): void {}
}

function headingRows(flat: string, full: string, expanded: boolean, width: number): string[] {
	if (!flat) return [];
	return expanded ? wrapBody(full, width) : [clipRow(flat, width)];
}

function preResultHint(theme: Theme, context: CallContext, hidden: number, other: boolean): string {
	if (context.expanded || context.state?.stashHasResult || (!hidden && !other)) return "";
	return expansionHint(theme, context, hidden, false);
}

function callCard(
	name: string,
	subject: string,
	facts: string[],
	disclosure: string,
	body: string,
	theme: Theme,
	context: CallContext,
): Component {
	const target = oneLine(safeCopy(subject));
	const header = theme.fg("toolTitle", theme.bold(name)) + (target ? ` ${theme.fg("accent", target)}` : "");
	const factRow = oneLine(safeCopy(facts.join(" · ")));
	const prose = bounded(safeCopy(body));
	const args = bounded(safeCopy(disclosure));
	const hidden = (width: number) => Math.max(0, wrapBody(prose.text, width).length - PREVIEW_LINES);
	const other = (width: number) => !!args.text || clipsRow(header, width) || clipsRow(factRow, width);
	if (context.state) {
		context.state.stashHasResult = false;
		context.state.stashCallDisclosure = (width) => ({ hidden: hidden(width), other: other(width) });
		context.state.stashCallLimit = prose.limit ?? args.limit;
	}
	return component((width) => {
		const expanded = context.expanded === true;
		const limit = prose.limit ?? args.limit;
		const muted = factRow ? theme.fg("muted", factRow) : "";
		const rows = [
			...headingRows(header, header, expanded, width),
			...headingRows(muted, muted, expanded, width),
			...wrapBody(expanded ? args.text : "", width).map((row) => theme.fg("muted", row)),
			...wrapBody(prose.text, width)
				.slice(0, expanded ? undefined : PREVIEW_LINES)
				.map((row) => theme.fg("toolOutput", row)),
		];
		if (limit && !context.state?.stashHasResult) rows.push(clipRow(theme.fg("warning", limit), width));
		const hint = preResultHint(theme, context, hidden(width), other(width));
		if (hint) rows.push(clipRow(hint, width));
		return rows;
	}, context.lastComponent);
}

type Receipt = {
	outcome: string;
	body?: string;
	extra?: string;
	continuation?: string;
	retainedLimit?: string;
	partialCoverage?: boolean;
};

function resultCard(
	receipt: Receipt,
	options: ToolRenderResultOptions,
	theme: Theme,
	context: ResultContext,
): Component {
	if (context.state) context.state.stashHasResult = true;
	const outcomeBound = bounded(safeCopy(receipt.outcome));
	const outcome = oneLine(outcomeBound.text);
	const body = bounded(safeCopy(receipt.body ?? ""));
	const extra = bounded(safeCopy(receipt.extra ?? ""));
	const tone = context.isError ? "error" : options.isPartial ? "muted" : "toolOutput";
	const limit =
		outcomeBound.limit ??
		body.limit ??
		extra.limit ??
		context.state?.stashCallLimit ??
		receipt.retainedLimit ??
		(receipt.partialCoverage ? "[Partial coverage]" : undefined);
	const more = lines(extra.text, receipt.continuation ?? "");
	const flatOutcome = outcome ? theme.fg(tone, outcome) : "";
	const fullOutcome = theme.fg(tone, outcomeBound.text);
	return component((width) => {
		const expanded = options.expanded;
		const preview = wrapBody(body.text, width);
		const call = context.state?.stashCallDisclosure?.(width);
		const hidden = Math.max(0, preview.length - PREVIEW_LINES) + (call?.hidden ?? 0);
		const hasOther = !!more || clipsRow(outcome, width) || call?.other;
		const rows = [
			"",
			...headingRows(flatOutcome, fullOutcome, expanded, width),
			...preview.slice(0, expanded ? undefined : PREVIEW_LINES).map((row) => theme.fg(tone, row)),
			...wrapBody(expanded ? more : "", width).map((row) => theme.fg(tone, row)),
		];
		if (limit) rows.push(clipRow(theme.fg("warning", limit), width));
		if (!expanded && (hidden || hasOther)) rows.push(clipRow(expansionHint(theme, context, hidden), width));
		return rows;
	}, context.lastComponent);
}

function plainReceipt(text: string, failure = ""): Receipt {
	const [outcome, ...rest] = safeCopy(text).trim().split("\n");
	return { outcome: outcome || failure, body: rest.join("\n") };
}

type Tool = {
	name: string;
	progress: string;
	protectedFailure?: string;
	receipt(details: Args, text: string, context: ResultContext): Receipt;
};

function errorReceipt(tool: Tool, text: string): Receipt {
	// A write or edit error can quote an argument whose card shows only its size.
	if (tool.protectedFailure) return { outcome: tool.protectedFailure, extra: text };
	return plainReceipt(text, `${tool.name} failed without a diagnostic.`);
}
function renderer(tool: Tool) {
	return (
		result: AgentToolResult<unknown>,
		options: ToolRenderResultOptions,
		theme: Theme,
		context: ResultContext,
	): Component => {
		const text = textContent(result);
		const receipt = context.isError
			? errorReceipt(tool, text)
			: options.isPartial
				? { outcome: tool.progress }
				: tool.receipt(record(result.details), text, context);
		return resultCard(receipt, options, theme, context);
	};
}
const sized = (value: unknown) => (typeof value === "string" ? bodySize(value) : undefined);

export function renderWriteCall(input: unknown, theme: Theme, context: CallContext): Component {
	const args = record(input);
	const facts: string[] = args.checkpoint === true ? ["checkpoint"] : [];
	if (typeof args.summary === "string" && args.summary.length) facts.push(`summary ${bodySize(args.summary)}`);
	const display: Args = {};
	for (const key of ["decisions", "openLoops", "nextActions", "files", "tags"]) {
		const values = args[key];
		if (!Array.isArray(values) || !values.length) continue;
		facts.push(`${key} ${values.length}`);
		display[key] = values.map(sized);
	}
	return callCard("stash_write", string(args.title), facts, argsText(display), "", theme, context);
}

export const renderWriteResult = renderer({
	name: "stash_write",
	progress: "Saving stash…",
	protectedFailure: "The stash write failed.",
	receipt(details, text) {
		const id = string(details.id);
		if (!id && details.checkpoint !== true) return plainReceipt(text);
		const state = string(details.state);
		const count = redactionCount(details);
		return {
			outcome: `${details.checkpoint === true ? `Saved working checkpoint${id ? ` ${id}` : ""}` : `Saved ${state ? `${state} ` : ""}stash ${id}`}${count ? ` with ${count}` : ""}.`,
			body: path(details.path),
			extra: lines(
				details.checkpoint === true ? "Provisional working material; not a pickup handover." : `/stash get ${id}`,
				redactionBody(details),
			),
		};
	},
});

export function renderListCall(input: unknown, theme: Theme, context: CallContext): Component {
	const args = record(input);
	const query = string(args.query);
	const facts = [
		string(args.tag) ? `tag ${args.tag}` : "",
		args.collection === "checkpoints" ? "provisional checkpoints" : "",
		string(args.state) ? `state ${args.state}` : "",
		typeof args.limit === "number" ? `limit ${args.limit}` : "",
		string(args.cursor) ? "continuation page" : "",
	].filter(Boolean);
	const additional = {
		...(args.collection === "handovers" ? { collection: args.collection } : {}),
		...(typeof args.cursor === "string" ? { cursor: args.cursor } : {}),
	};
	return callCard(
		"stash_list",
		query ? `"${query}"` : context.argsComplete === false ? "" : "recent",
		facts,
		argsText(additional),
		"",
		theme,
		context,
	);
}

function listRow(item: Args): string {
	const state =
		item.state === "open" || item.state === "active" || item.state === "closed" || item.state === "provisional"
			? item.state
			: "";
	const facts = [
		state,
		string(item.title),
		...[item.source, item.workspace].map(string).filter((fact) => fact !== "unknown"),
	].filter(Boolean);
	return lines(string(item.id), facts.length ? `  ${facts.join(" · ")}` : "", string(item.excerpt));
}

function continuation(cursor: string, args: Args): string {
	if (typeof args.query !== "string") return "The original search arguments are not available in this view.";
	const { query, collection, tag, state, limit } = args;
	const call = JSON.stringify({ query, collection, tag, state, limit, cursor });
	if (redactSecrets(call) !== call) return "The continuation includes a credential and is withheld.";
	// Keep the exact JSON literal even when the terminal wraps it; escape terminal controls inside strings.
	return `Continue with stash_list:\n${call.replace(/[ \p{Cc}\p{Cf}]/gu, (char) =>
		char
			.split("")
			.map((unit) => `\\u${unit.charCodeAt(0).toString(16).padStart(4, "0")}`)
			.join(""),
	)}`;
}

function searchEvidence(coverage: Args, matches: unknown[], skips: unknown[]): string {
	const counts = Object.entries({
		candidates: "Candidates",
		visited: "Visited",
		searched: "Searched",
		filtered: "Filtered",
		deferred: "Deferred",
		skippedTotal: "Total skipped",
	});
	return lines(
		...counts.map(([key, label]) => (typeof coverage[key] === "number" ? `${label}: ${coverage[key]}` : "")),
		...matches.map((item) => {
			const match = record(item);
			return typeof match.id === "string" &&
				typeof match.field === "string" &&
				typeof match.start === "number" &&
				typeof match.end === "number"
				? `${match.id}: ${match.field} [${match.start}, ${match.end})`
				: "";
		}),
		...skips.map((item) => {
			const skip = record(item);
			const reason = string(skip.reason);
			return typeof skip.id === "string" ? `Skipped ${skip.id}${reason ? `: ${reason}` : ""}` : "";
		}),
	);
}

function searchReceipt(details: Args, matches: unknown[], args: unknown): Receipt {
	const coverage = record(details.coverage);
	const skips = Array.isArray(details.skipped) ? details.skipped : [];
	const cursor = string(details.nextCursor);
	const scope =
		typeof coverage.from === "number" && typeof coverage.next === "number"
			? `, candidates [${coverage.from}, ${coverage.next})`
			: "";
	return {
		outcome: `Found ${plural(matches.length, "match", "matches")} ${details.provisional === true ? "on this checkpoint page" : "on this page"}${scope}${skips.length ? `, ${skips.length} skipped` : ""}${cursor ? "; continuation available" : ""}.`,
		body: lines(...matches.map((item) => listRow(record(item)))),
		extra: searchEvidence(coverage, matches, skips),
		continuation: cursor ? continuation(cursor, record(args)) : undefined,
		partialCoverage: coverage.complete === false && !cursor,
	};
}

export const renderListResult = renderer({
	name: "stash_list",
	progress: "Listing stashes…",
	receipt(details, text, context) {
		if (Array.isArray(details.matches)) return searchReceipt(details, details.matches, context.args);
		if (typeof details.count === "number") {
			const label =
				details.provisional === true
					? plural(details.count, "recent checkpoint", "recent checkpoints")
					: plural(details.count, "recent stash", "recent stashes");
			return {
				outcome: `${label[0]?.toUpperCase()}${label.slice(1)} listed.`,
				body: Array.isArray(details.records) ? lines(...details.records.map((item) => listRow(record(item)))) : "",
				retainedLimit:
					typeof details.omittedRecords === "number" && details.omittedRecords > 0
						? `[Excerpt: ${plural(details.omittedRecords, "selected record", "selected records")} not retained in the list]`
						: undefined,
			};
		}
		return plainReceipt(text);
	},
});

export interface ReadDisplayArgs {
	collection?: string;
	id: string;
}
export function renderReadCall(input: unknown, theme: Theme, context: CallContext): Component {
	const args = record(input);
	return callCard(
		"stash_read",
		string(args.id),
		args.collection === "checkpoints" ? ["provisional checkpoint"] : [],
		"",
		"",
		theme,
		context,
	);
}

export const renderReadResult = renderer({
	name: "stash_read",
	progress: "Reading stash…",
	receipt(details, text) {
		if (!string(details.id)) return plainReceipt(text);
		const meta = details.provisional === true ? undefined : parseFrontmatter(text).meta;
		const state = meta?.state === "open" || meta?.state === "active" || meta?.state === "closed" ? meta.state : "";
		const label = details.provisional === true ? "provisional checkpoint" : `${state ? `${state} ` : ""}stash`;
		const title = typeof meta?.title === "string" && meta.title ? ` “${meta.title}”` : "";
		const size =
			typeof details.totalLines === "number"
				? ` (${plural(details.totalLines, "line", "lines")}${details.truncated === true ? " before output bounds" : ""})`
				: "";
		return {
			outcome: `Read ${label}${title}${size}.`,
			body: text,
			extra: lines(path(details.path), state === "closed" ? REOPEN_NOTE : ""),
			retainedLimit:
				details.truncated === true
					? "[Excerpt: read output is bounded; the full artifact remains in the file]"
					: undefined,
		};
	},
});

export function renderEditCall(input: unknown, theme: Theme, context: CallContext): Component {
	const { id, edits, ...args } = record(input);
	const replacementSizes = Array.isArray(edits)
		? edits.map((edit) => {
				const { oldText, newText } = record(edit);
				return { oldText: sized(oldText), newText: sized(newText) };
			})
		: undefined;
	return callCard(
		"stash_edit",
		string(id),
		[
			...(replacementSizes?.length ? [plural(replacementSizes.length, "replacement", "replacements")] : []),
			...(args.allowActive === true ? ["active edit acknowledged"] : []),
		],
		argsText({
			...(typeof args.expectedDigest === "string" ? { expectedDigest: args.expectedDigest } : {}),
			...(typeof args.allowActive === "boolean" ? { allowActive: args.allowActive } : {}),
			...(replacementSizes ? { edits: replacementSizes } : {}),
		}),
		"",
		theme,
		context,
	);
}

export const renderEditResult = renderer({
	name: "stash_edit",
	progress: "Editing stash…",
	protectedFailure: "The stash edit failed.",
	receipt(details, text) {
		if (typeof details.changed !== "boolean") return plainReceipt(text);
		const count = redactionCount(details);
		const state = string(details.state);
		return {
			outcome: `${details.changed ? "Updated the stash" : "The stash did not change"}${state ? `; state remains ${state}` : ""}${count ? `; ${count}` : ""}.`,
			extra: lines(
				path(details.path),
				string(details.digest) ? `Digest: ${details.digest}` : "",
				redactionBody(details),
			),
		};
	},
});

export function renderCompleteCall(input: unknown, theme: Theme, context: CallContext): Component {
	const args = record(input);
	return callCard("stash_complete", string(args.id), [], "", string(args.outcome), theme, context);
}

export const renderCompleteResult = renderer({
	name: "stash_complete",
	progress: "Closing stash…",
	receipt(details, text, context) {
		const id = string(details.id);
		if (!id && details.state !== "closed") return plainReceipt(text);
		const count = redactionCount(details);
		return {
			outcome: `Closed the stash${count ? ` with ${count}` : ""}; the artifact remains.`,
			body: string(details.outcome),
			extra: lines(
				id && id !== record(context.args).id ? `Stash: ${id}` : "",
				path(details.path),
				REOPEN_NOTE,
				redactionBody(details),
			),
		};
	},
});

export function renderRotateCall(input: unknown, theme: Theme, context: CallContext): Component {
	return callCard("stash_rotate", string(record(input).id), [], "", "", theme, context);
}

export const renderRotateResult = renderer({
	name: "stash_rotate",
	progress: "Archiving stash…",
	receipt(details, text) {
		if (!string(details.archivePath)) return plainReceipt(text);
		return { outcome: "Archived the stash; the artifact remains recoverable.", extra: path(details.archivePath) };
	},
});
