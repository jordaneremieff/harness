import type { AgentToolResult, KeybindingHints, Theme, ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";
import { stripVTControlCharacters } from "node:util";
import type { AccessError, AccessPage } from "./access.ts";
import { characterCount } from "./draft.ts";
import type { ExportResult } from "./export.ts";
import type { ErrorCode, Response } from "./readback.ts";

interface RenderContext extends Partial<KeybindingHints> {
	isError: boolean;
	expanded?: boolean;
	state?: { hasResult?: boolean; callAddsContent?: (width: number) => boolean; withholdsInput?: boolean };
}

export function displayText(text: string): string {
	return stripVTControlCharacters(text).replace(/[\p{Cc}\p{Cf}]/gu, (character) =>
		character === "\n" || character === "\t" ? character : "",
	);
}

export const oneLine = (text: string) => displayText(text).replace(/\s+/gu, " ").trim();

export function clipRow(line: string, width: number): string {
	return truncateToWidth(line, Math.max(0, width), "…").replace(
		/\x1b\[0m…\x1b\[0m$/u,
		"…\x1b[22;23;24;25;27;28;29;39m",
	);
}

export function disclosureHint(theme: Theme, keys: Partial<KeybindingHints>, hidden = 0, clickable = true): string {
	const key = keys.keyText?.("app.tools.expand");
	if (!key && !clickable) return "";
	const action = key
		? (keys.keyHint?.("app.tools.expand", "to expand") ?? theme.fg("dim", key) + theme.fg("muted", " to expand"))
		: theme.fg("muted", "click to expand");
	return (
		theme.fg("muted", `... (${hidden ? `${hidden} more line${hidden === 1 ? "" : "s"}, ` : ""}`) +
		action +
		theme.fg("muted", ")")
	);
}

function wrap(text: string, width: number): string[] {
	return displayText(text)
		.replace(/\t/gu, "   ")
		.split("\n")
		.flatMap((line) => wrapTextWithAnsi(line, Math.max(1, width)));
}

function textContent(result: AgentToolResult<unknown>): string {
	return result.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
}

function firstLine(text: string): string | undefined {
	return text.split("\n").map(oneLine).find(Boolean);
}

function object(value: unknown): Record<string, unknown> {
	return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function ownError<T>(
	result: AgentToolResult<unknown>,
	context: RenderContext,
	matches: (value: unknown) => value is T,
): T | undefined {
	if (matches(result.details)) return result.details;
	if (!context.isError || result.content.length !== 1 || result.content[0]?.type !== "text") return;
	try {
		const value: unknown = JSON.parse(result.content[0].text);
		return matches(value) ? value : undefined;
	} catch {
		return undefined;
	}
}

function isAccessError(value: unknown): value is AccessError {
	const error = object(value);
	return (
		error.schema === "pillars-source-error" &&
		(error.code === "invalid_input" || error.code === "source_unavailable" || error.code === "source_changed") &&
		(error.message === undefined || typeof error.message === "string")
	);
}

const usageRefusals: Record<ErrorCode, string> = {
	invalid_input: "The access-evidence request is invalid.",
	store_unreadable: "The retained aggregate store is unreadable.",
	store_corrupt: "The retained aggregate store is invalid.",
	cursor_expired: "The frozen access-evidence capture expired or was replaced.",
	cursor_invalid: "The access-evidence cursor is invalid.",
	response_overflow: "The capture exceeded its row, byte or memory limit.",
};

function isUsageError(value: unknown): value is Extract<Response, { kind: "error" }> {
	const error = object(value);
	return (
		error.schema === "pillars-usage-response" &&
		error.schemaVersion === 2 &&
		error.kind === "error" &&
		typeof error.code === "string" &&
		Object.hasOwn(usageRefusals, error.code) &&
		typeof error.message === "string"
	);
}

function callCard(
	name: string,
	subject: string,
	facts: string[],
	args: string[],
	withholdsInput: boolean,
	theme: Theme,
	context: RenderContext,
): Component {
	const header =
		theme.fg("toolTitle", theme.bold(name)) +
		(subject ? ` ${theme.fg("accent", subject)}` : "") +
		(facts.length ? theme.fg("muted", ` (${facts.join(", ")})`) : "");
	const addsContent = (width: number) => args.length > 0 || visibleWidth(header) > width;
	if (context.state) {
		context.state.callAddsContent = addsContent;
		context.state.withholdsInput = withholdsInput;
	}
	return {
		invalidate() {},
		render(width) {
			if (context.expanded)
				return [
					...wrapTextWithAnsi(header, Math.max(1, width)),
					...args.flatMap((arg) => wrap(arg, width)).map((line) => theme.fg("muted", line)),
				];
			const lines = [clipRow(header, width)];
			if (addsContent(width) && !context.state?.hasResult) {
				const hint = disclosureHint(theme, context, 0, false);
				if (hint) lines.push(clipRow(hint, width));
			}
			return lines;
		},
	};
}

function resultCard(
	copy: ResultCopy,
	options: ToolRenderResultOptions,
	theme: Theme,
	context: RenderContext,
): Component {
	if (context.state) context.state.hasResult = true;
	const color = options.isPartial ? "muted" : context.isError ? "error" : "toolOutput";
	return {
		invalidate() {},
		render(width) {
			const paint = (text: string) => wrap(text, width).map((line) => theme.fg(color, line));
			const body = copy.body ? wrap(copy.body, width).map((line) => theme.fg("toolOutput", line)) : [];
			if (options.expanded) {
				const details = copy.extra ? ["", ...wrap(copy.extra, width).map((line) => theme.fg("muted", line))] : [];
				return ["", ...paint(copy.diagnostic ?? copy.outcome), ...body, ...details];
			}
			const outcome = theme.fg(color, copy.outcome);
			const lines = ["", clipRow(outcome, width)];
			if (
				body.length ||
				copy.extra ||
				copy.diagnostic ||
				visibleWidth(outcome) > width ||
				context.state?.callAddsContent?.(width)
			)
				lines.push(clipRow(disclosureHint(theme, context, body.length), width));
			return lines;
		},
	};
}

const digestPattern = /^[a-f0-9]{64}$/;
const resourcePattern = /^[a-z0-9][a-z0-9-]{0,63}$/;
const cursorPattern = /^[-_A-Za-z0-9]{4,256}$/;
const quoted = JSON.stringify;

function withheldArgument(name: string, count: number): string {
	return `  ${name}: ${count} ${count === 1 ? "character" : "characters"}`;
}

function accessRefusal(code: AccessError["code"]): string {
	switch (code) {
		case "source_changed":
			return "The Pillars source revision changed.";
		case "source_unavailable":
			return "The Pillars source is unavailable.";
		case "invalid_input":
			return "The Pillars source request is invalid.";
	}
}

function matchingString(value: unknown, pattern: RegExp): string | undefined {
	return typeof value === "string" && pattern.test(value) ? value : undefined;
}

function integer(value: unknown): number | undefined {
	return typeof value === "number" && Number.isSafeInteger(value) ? value : undefined;
}

function sourceCall(input: unknown, theme: Theme, context: RenderContext): Component {
	const args = object(input);
	const resource = matchingString(args.resource, resourcePattern);
	const offset = integer(args.offset);
	const digest = matchingString(args.referenceBodyDigest, digestPattern);
	const facts: string[] = [];
	const expanded: string[] = [];
	if (offset !== undefined) facts.push(`offset ${offset}`);

	if (digest) expanded.push(withheldArgument("referenceBodyDigest", digest.length));
	if (typeof args.draft === "string") expanded.push(withheldArgument("draft", characterCount(args.draft)));
	return callCard(
		"pillars",
		args.draft !== undefined ? "assess draft" : (resource ?? (args.resource === undefined ? "inventory" : "")),
		facts,
		expanded,
		args.draft !== undefined || args.referenceBodyDigest !== undefined,
		theme,
		context,
	);
}

function isSourcePage(page: AccessPage | AccessError | undefined): page is AccessPage {
	return (
		page?.schema === "pillars-source" &&
		typeof page.text === "string" &&
		typeof page.resource === "string" &&
		typeof page.referenceBodyDigest === "string" &&
		(page.nextOffset === undefined || Number.isSafeInteger(page.nextOffset)) &&
		[page.bodyBytes, page.offset, page.endOffset].every(Number.isSafeInteger)
	);
}

function sourcePageFacts(page: AccessPage): string {
	const lines = [`Offset ${page.offset} to ${page.endOffset} (exclusive) · SHA-256 ${page.referenceBodyDigest}`];
	if (
		Array.isArray(page.resources) &&
		page.resources.length > 0 &&
		page.resources.every((id) => typeof id === "string")
	)
		lines.push(`Resources: ${page.resources.join(", ")}`);
	if (page.nextOffset !== undefined)
		lines.push(
			`Continue: pillars ${quoted({ resource: page.resource, offset: page.nextOffset, referenceBodyDigest: page.referenceBodyDigest })}`,
		);
	return lines.join("\n");
}

interface ResultCopy {
	outcome: string;
	body?: string;
	extra?: string;
	diagnostic?: string;
}

function refusalCopy(code: string, message: string | undefined, fallback: string): ResultCopy {
	const outcome = oneLine(message ?? "") || fallback;
	return { outcome, diagnostic: message !== outcome ? message : undefined, extra: `Code: ${code}` };
}

function fallbackCopy(result: AgentToolResult<unknown>, context: RenderContext, fallback: string): ResultCopy {
	const text = displayText(textContent(result));
	// Pi may echo withheld arguments on any row of its diagnostic, including the first.
	const outcome = (!context.isError || !context.state?.withholdsInput ? firstLine(text) : undefined) ?? fallback;
	return { outcome, diagnostic: context.isError && text.trim() && text !== outcome ? text : undefined };
}

function sourceOutcome(page: AccessPage): string {
	const bytes = page.endOffset - page.offset;
	const continuation = page.nextOffset !== undefined ? "; more content follows" : "";
	const summary = Array.isArray(page.resources)
		? `Inventory lists ${page.resources.length} ${page.resources.length === 1 ? "resource" : "resources"}`
		: `Read ${bytes}${bytes !== page.bodyBytes ? ` of ${page.bodyBytes}` : ""} bytes from ${oneLine(page.resource)}`;
	return `${summary}${continuation}.`;
}

/** Terminal rendering for the source page; continuation stays within the source revision. */
export function accessRenderers() {
	return {
		renderCall: sourceCall,
		renderResult(
			result: AgentToolResult<AccessPage | AccessError | undefined>,
			options: ToolRenderResultOptions,
			theme: Theme,
			context: RenderContext,
		) {
			const card = (copy: ResultCopy) => resultCard(copy, options, theme, context);
			if (options.isPartial) return card({ outcome: "Reading the corpus…" });
			const error = ownError(result, context, isAccessError);
			if (error) return card(refusalCopy(error.code, error.message, accessRefusal(error.code)));
			const page = result.details;
			if (context.isError || !isSourcePage(page))
				return card(fallbackCopy(result, context, "The Pillars source read did not complete."));
			return card({
				outcome: sourceOutcome(page),
				body: page.text,
				extra: sourcePageFacts(page),
			});
		},
	};
}

function usageCall(input: unknown, theme: Theme, context: RenderContext): Component {
	const args = object(input);
	const cursor = matchingString(args.cursor, cursorPattern);
	const view = matchingString(args.view, /^(overview|revisions)$/);
	const days = integer(args.windowDays);
	const facts: string[] = [];
	const expanded: string[] = [];
	if (cursor && view) facts.push(view);
	if (days !== undefined) facts.push(`${days} ${days === 1 ? "day" : "days"}`);
	if (cursor) expanded.push(withheldArgument("cursor", cursor.length));
	const subject = cursor ? "continuation" : (view ?? (args.view === undefined ? "overview" : ""));
	return callCard("pillars_usage", subject, facts, expanded, args.cursor !== undefined, theme, context);
}

function usagePageCopy(page: Extract<Response, { kind: "page" }>): ResultCopy | undefined {
	try {
		const { pageNumber, pageCount, nextCursor } = page.pagination;
		const { fromDay, toDay } = page.window;
		const n = page.totals.readRequests;
		if (
			page.schema !== "pillars-usage-response" ||
			page.schemaVersion !== 2 ||
			!matchingString(page.view, /^(overview|revisions)$/) ||
			![pageNumber, pageCount, n].every(Number.isSafeInteger) ||
			typeof fromDay !== "string" ||
			typeof toDay !== "string" ||
			(nextCursor !== undefined && !matchingString(nextCursor, cursorPattern))
		)
			return undefined;
		return {
			outcome: `${n} retained ${n === 1 ? "read" : "reads"} from ${fromDay} to ${toDay}${pageCount > 1 ? ` (page ${pageNumber} of ${pageCount})` : ""}.`,
			body: usageMarkdown(page, "card"),
			extra: nextCursor ? `Continue: pillars_usage ${quoted({ cursor: nextCursor })}` : undefined,
		};
	} catch {
		return undefined;
	}
}

/** Terminal rendering for one page of retained access evidence, not an alignment verdict. */
export function usageRenderers() {
	return {
		renderCall: usageCall,
		renderResult(
			result: AgentToolResult<Response | undefined>,
			options: ToolRenderResultOptions,
			theme: Theme,
			context: RenderContext,
		) {
			const card = (copy: ResultCopy) => resultCard(copy, options, theme, context);
			if (options.isPartial) return card({ outcome: "Reading access evidence…" });
			const error = ownError(result, context, isUsageError);
			if (error) return card(refusalCopy(error.code, error.message, usageRefusals[error.code]));
			const page = !context.isError && result.details?.kind === "page" ? usagePageCopy(result.details) : undefined;
			return card(page ?? fallbackCopy(result, context, "The Pillars access-evidence read did not complete."));
		},
	};
}

export function exportTitle(result: ExportResult): string {
	return !result.published
		? "Access evidence export did not publish"
		: result.durability === "confirmed"
			? "Access evidence export published"
			: "Access evidence export published without durability confirmation";
}

export function exportMarkdown(result: ExportResult): string {
	return `${result.message}\n\n- Code: \`${result.code}\`\n- Published: ${result.published ? "Yes" : "No"}\n- Durability: ${result.durability === "not_published" ? "Not published" : result.durability === "confirmed" ? "Confirmed" : "Unconfirmed"}`;
}

function expiryClock(value: string): string {
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

export function usageMarkdown(response: Response, target: "command" | "card" = "command"): string {
	if (response.kind === "error")
		return `# Pillars access evidence\n\n${response.message}\n\n${Object.values(response.meaning).join("\n\n")}`;
	const lines = [
		"# Pillars access evidence",
		`${response.window.fromDay} through ${response.window.toDay}. Page ${response.pagination.pageNumber} of ${response.pagination.pageCount}.`,
		`Retained shards: ${response.coverage.retainedDayShards}. Collector enabled here: ${response.enabled}.`,
		`Storage assessment: ${response.storageEvidence.assessment}. Live collectors, whole-window coverage, and unpersisted loss: unknown.`,
		"## Totals",
		...Object.entries(response.totals).map(([name, count]) => `- ${name}: ${count}`),
		"## Recorded storage evidence",
		...Object.entries(response.storageEvidence).map(([name, value]) => `- ${name}: ${value}`),
		`Capture omissions: ${response.coverage.captureOmissions.join(", ") || "none recorded; not complete collection"}.`,
		`Revision rows: ${response.summary.revisionRows}. Additional resource identities folded in this overview: ${response.summary.foldedResourceIdentities}.`,
		"## Rows",
	];
	const rows = response.view === "revisions" ? response.rows : response.byResource;
	for (const row of rows) {
		lines.push(`### ${row.resourceClass}: ${row.resourceId}`);
		if ("observationStage" in row)
			lines.push(
				`Day: ${row.day}; stage: ${row.observationStage}.`,
				`Model: ${row.model}; reasoning: ${row.reasoning}.`,
				`Reference SHA-256: ${row.referenceBodyDigest}.`,
				`Observer version: ${row.observerVersion}; Pi version: ${row.piVersion}.`,
			);
		else lines.push(`Last observed day: ${row.lastSeenDay}.`);
		lines.push(
			Object.entries(row.counters)
				.map(([name, count]) => `${name}: ${count}`)
				.join("; "),
		);
	}
	lines.push("## Interpretation", ...Object.values(response.meaning));
	const { nextCursor, cursorExpiresAt } = response.pagination;
	if (nextCursor) {
		if (target === "command") lines.push(`Next page: /pillars next ${nextCursor}`);
		const expiry = cursorExpiresAt && (target === "card" ? expiryClock(cursorExpiresAt) : cursorExpiresAt);
		if (expiry) lines.push(`Capture expires at ${expiry}.`);
	}
	return lines.join("\n\n");
}
