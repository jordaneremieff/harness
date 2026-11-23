import { homedir } from "node:os";
import { sep } from "node:path";
import { type Theme, type ToolDefinition, truncateToVisualLines } from "@earendil-works/pi-coding-agent";
import { compile } from "@earendil-works/pi-schema";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { catalogPreviewRows, CheckParams, RecordParams, ViewParams } from "./tool-contract.ts";
import { idPattern, proseKinds, scopes } from "./vocabulary.ts";
import { bodyText, singleLine } from "./presentation-text.ts";

export type SlopTool = "slop" | "slop_check" | "slop_record";
type Call = NonNullable<ToolDefinition["renderCall"]>;
type Result = NonNullable<ToolDefinition["renderResult"]>;
type Hints = Pick<Parameters<Call>[2], "keyText" | "keyHint">;
const expand = "app.tools.expand";
const idRegex = new RegExp(idPattern);
const actions = ["save", "remove", "disable", "enable", "import"];
const recordText = ["title", "operator", "recognition", "cost", "repair", "excerpt", "note", "reason"];
const object = (value: unknown): Record<string, unknown> =>
	value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
const member = (values: readonly string[], value: unknown) => values.find((item) => item === value);
const id = (value: unknown) =>
	typeof value === "string" && value.length <= 128 && idRegex.test(value) ? value : undefined;
function path(value: unknown): string | undefined {
	if (typeof value !== "string" || /[\r\n]/u.test(value)) return undefined;
	const home = homedir();
	return (
		singleLine(value === home || value.startsWith(home + sep) ? `~${value.slice(home.length)}` : value) || undefined
	);
}
function list(value: unknown, item: (value: unknown) => string | undefined): string[] {
	return Array.isArray(value) ? value.map(item).filter((value) => value !== undefined) : [];
}
const count = (n: number, word: string, plural = `${word}s`) => `${n} ${n === 1 ? word : plural}`;
function size(value: string): string {
	let characters = 0;
	for (const _ of value) characters++;
	return count(characters, "character");
}

interface Target {
	subject?: string;
	facts?: string[];
	more?: (() => string)[];
}

function catalog(args: Record<string, unknown>): Target {
	const entry = id(args.entry);
	const scope = member(scopes, args.scope);
	const query = typeof args.query === "string" && args.query.length > 0 ? args.query : undefined;
	if (entry) return { subject: `read ${entry}`, facts: args.starter === true ? ["starter set"] : [] };
	if (args.starter === true) return { subject: "compare starter set" };
	return {
		subject: query ? "search catalog" : "list catalog",
		facts: scope ? [scope] : [],
		more: query ? [() => `query: ${size(query)}`] : [],
	};
}

function check(args: Record<string, unknown>): Target {
	const entries = list(args.entries, id);
	const facts = entries.length ? [`entries ${entries.join(", ")}`] : [];
	const more: (() => string)[] = [];
	if ([args.path, args.diff, args.text].filter((input) => input !== undefined).length !== 1) return { facts };
	const text = args.text;
	if (typeof text === "string") {
		const kind = member(proseKinds, args.kind);
		if (kind) facts.unshift(kind);
		return { subject: "check text", facts, more: [() => `text: ${size(text)}`] };
	}
	const file = path(args.path);
	if (file) return { subject: `check ${file}`, facts };
	if (!args.diff || typeof args.diff !== "object" || Array.isArray(args.diff)) return { facts };
	const diff = object(args.diff);
	const range = path(diff.range);
	const paths = list(diff.paths, path);
	if (paths.length === 1) facts.unshift(paths[0]);
	if (paths.length > 1) {
		facts.unshift(count(paths.length, "path"));
		more.push(() => `paths: ${JSON.stringify(paths)}`);
	}
	const subject = diff.staged === true ? "check staged diff" : range ? `check ${range}` : "check uncommitted diff";
	return { subject, facts, more };
}

function record(args: Record<string, unknown>): Target {
	const action = member(actions, args.action);
	const entry = id(args.id);
	if (action === "import") {
		const entries = list(args.ids, id);
		return entries.length
			? { subject: "import starter entries", facts: entries }
			: { subject: "import new starter entries" };
	}
	const more = recordText.flatMap((key) => {
		const value = args[key];
		return typeof value === "string" ? [() => `${key}: ${size(value)}`] : [];
	});
	for (const [key, noun] of [
		["detectors", "detector"],
		["examples", "example"],
	] as const) {
		const value = args[key];
		if (Array.isArray(value)) more.push(() => `${key}: ${count(value.length, noun)}`);
	}
	return { subject: [action, entry].filter(Boolean).join(" "), more };
}

const targets = { slop: catalog, slop_check: check, slop_record: record };

export function clipRow(line: string, width: number): string {
	return truncateToWidth(line, Math.max(0, width), "…").replace(
		/\x1b\[0m…\x1b\[0m$/u,
		"…\x1b[22;23;24;25;27;28;29;39m",
	);
}

export function expansionHint(theme: Theme, context: Hints, width: number, clickable: boolean, hidden = 0): string[] {
	const hasKey = Boolean(context.keyText?.(expand));
	if (!hasKey && !clickable) return [];
	const action = hasKey ? context.keyHint(expand, "to expand") : theme.fg("muted", "click to expand");
	return [
		clipRow(
			theme.fg("muted", `... (${hidden ? `${count(hidden, "more line")}, ` : ""}`) + action + theme.fg("muted", ")"),
			width,
		),
	];
}

function rows(render: (width: number) => string[]) {
	let cached: { width: number; lines: string[] } | undefined;
	return {
		render(width: number) {
			if (cached?.width !== width) cached = { width, lines: render(width) };
			return cached.lines;
		},
		invalidate() {
			cached = undefined;
		},
	};
}

const callLines = (name: SlopTool, target: Target, theme: Theme) => [
	theme.fg("toolTitle", theme.bold(name)) + (target.subject ? ` ${theme.fg("accent", target.subject)}` : ""),
	...(target.facts?.length ? [theme.fg("muted", target.facts.join(" · "))] : []),
];

function callAddsDetail(target: Target, lines: string[], width: number): boolean {
	return Boolean(target.more?.length) || lines.some((line) => visibleWidth(line) > width);
}

function expandedCall(lines: string[], target: Target, theme: Theme, width: number): string[] {
	const output = lines.flatMap((line) => wrapTextWithAnsi(line, width));
	for (const field of target.more ?? []) output.push(...wrapTextWithAnsi(theme.fg("muted", `  ${field()}`), width));
	return output;
}

export function callCard(name: SlopTool): Call {
	return (args, theme, context) => {
		const state = context.state as { hasResult?: boolean };
		state.hasResult = false;
		const target = targets[name](object(args));
		const lines = callLines(name, target, theme);
		return rows((width) => {
			if (width <= 0) return [];
			if (context.expanded) return expandedCall(lines, target, theme, width);
			const display = lines.map((line) => clipRow(line, width));
			if (!state.hasResult && callAddsDetail(target, lines, width)) {
				display.push(...expansionHint(theme, context, width, false));
			}
			return display;
		});
	};
}

const failures: Record<SlopTool, string> = {
	slop: "The catalog request failed.",
	slop_check: "The slop check failed.",
	slop_record: "The catalog change failed.",
};
const schemas = { slop: compile(ViewParams), slop_check: compile(CheckParams), slop_record: compile(RecordParams) };

// Host validation can quote invalid values; Slop validation can quote detector and example fields.
function diagnosticNeedsDisclosure(name: SlopTool, value: unknown): boolean {
	if (!schemas[name].check(value)) return true;
	const args = object(value);
	if (name === "slop") return Boolean(args.query);
	if (name === "slop_record") return [...recordText, "detectors", "examples"].some((key) => args[key] !== undefined);
	const diff = object(args.diff);
	return (
		args.text !== undefined ||
		[args.path, diff.range, ...list(diff.paths, (v) => (typeof v === "string" ? v : undefined))].some(
			(value) => typeof value === "string" && !path(value),
		)
	);
}

const nonnegative = (value: unknown): number | undefined =>
	typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;

function checkOutcome(details: Record<string, unknown>) {
	const findings = nonnegative(details.findingCount);
	const skipped = nonnegative(details.skippedCount);
	if (findings === undefined || skipped === undefined) return undefined;
	const outcome = `${findings ? count(findings, "slop detector finding") : "No slop findings"}.`;
	const limits: string[] = [];
	if (skipped) limits.push(`${count(skipped, "input")} skipped`);
	if (details.reportLimited === true) limits.push("8 KiB report limit reached");
	if (details.locationsLimited === true) limits.push("at most 20 locations per detector");
	return { outcome, limits };
}

const summaryOf = (details: Record<string, unknown>) =>
	typeof details.summary === "string" ? singleLine(details.summary) : "";

function outcomeOf(name: SlopTool, details: Record<string, unknown>, fallback: string) {
	if (name === "slop_check") return checkOutcome(details) ?? { outcome: fallback, limits: [] };
	const limits: string[] = [];
	if (name === "slop_record") {
		const imported = nonnegative(details.importedCount);
		if (imported) return { outcome: `Imported ${count(imported, "starter entry", "starter entries")}.`, limits };
		const unmatched = nonnegative(details.unmatchedCount);
		if (unmatched) limits.push(`No detector matched ${count(unmatched, "Slop example")}`);
	}
	return { outcome: summaryOf(details) || fallback, limits };
}

function catalogOutcome(kind: "catalog" | "starter", total: number, list: Record<string, unknown>): string {
	if (kind === "starter") return total ? `${count(total, "starter entry", "starter entries")}.` : "No starter entries.";
	const entries = total ? count(total, "slop entry", "slop entries") : "No matching slop entries";
	const fresh = nonnegative(list.fresh);
	const updated = nonnegative(list.updated);
	const availability = [
		fresh ? count(fresh, "new starter entry", "new starter entries") : "",
		updated ? `${count(updated, "starter update")} available` : "",
	].filter(Boolean);
	return `${[entries, ...availability].join("; ")}.`;
}

function catalogListView(list: Record<string, unknown>) {
	const { kind, rows, hasGuidance } = list;
	const total = nonnegative(list.count);
	if (kind !== "catalog" && kind !== "starter") return undefined;
	if (total === undefined || typeof hasGuidance !== "boolean" || !Array.isArray(rows)) return undefined;
	if (rows.length !== Math.min(total, catalogPreviewRows) || !rows.every((row) => typeof row === "string"))
		return undefined;
	return {
		outcome: catalogOutcome(kind, total, list),
		preview: bodyText(rows.join("\n")),
		hasMore: hasGuidance || total > rows.length,
	};
}

function withoutDuplicateOutcome(body: string, outcome: string): string {
	if (body === outcome) return "";
	return body.startsWith(`${outcome}\n`) ? body.slice(outcome.length + 1) : body;
}

interface ResultRows {
	outcome: string;
	body: string;
	rest: string;
	limit: string;
	error: boolean;
	preview: string;
	hasMore: boolean;
	catalogList: boolean;
}

function expandedResult(result: ResultRows, theme: Theme, width: number): string[] {
	const { outcome, body, rest, limit, error, catalogList } = result;
	if (error) return ["", ...styledBody(body || outcome, width, (line) => theme.fg("error", line))];
	if (catalogList && body) return ["", ...styledBody(body, width, (line) => theme.fg("toolOutput", line))];
	return [
		"",
		...styledBody(outcome, width, (line) => theme.fg("toolOutput", line)),
		...styledBody(rest, width, (line) => theme.fg("toolOutput", line)),
		...(limit ? wrapTextWithAnsi(limit, width) : []),
	];
}

function styledBody(text: string, width: number, style: (line: string) => string): string[] {
	return text ? wrapTextWithAnsi(text, width).map(style) : [];
}

function collapsedResult(
	result: ResultRows,
	theme: Theme,
	context: Hints,
	width: number,
	extraCall: boolean,
): string[] {
	const { outcome, limit, error, hasMore, catalogList } = result;
	const preview = truncateToVisualLines(result.preview, catalogPreviewRows, width, 0, "start");
	const lines = [""];
	if (outcome) lines.push(clipRow(theme.fg(error ? "error" : "toolOutput", outcome), width));
	for (const line of preview.visualLines) lines.push(theme.fg("toolOutput", line));
	if (limit) lines.push(clipRow(limit, width));
	const clipped = visibleWidth(outcome) > width || visibleWidth(limit) > width;
	if (extraCall || hasMore || clipped || preview.skippedCount) {
		lines.push(...expansionHint(theme, context, width, true, catalogList ? 0 : preview.skippedCount));
	}
	return lines;
}

export function resultCard(name: SlopTool): Result {
	return (result, options, theme, context) => {
		(context.state as { hasResult?: boolean }).hasResult = true;
		const body = bodyText(
			result.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n"),
		).trimEnd();
		const args = object(context.args);
		const display = resultRows(name, context.args, object(result.details), body, context.isError, theme);
		const target = targets[name](args);
		const header = callLines(name, target, theme);
		return rows((width) => {
			if (width <= 0) return [];
			if (options.expanded) return expandedResult(display, theme, width);
			return collapsedResult(display, theme, context, width, callAddsDetail(target, header, width));
		});
	};
}

function resultRows(
	name: SlopTool,
	args: unknown,
	details: Record<string, unknown>,
	body: string,
	error: boolean,
	theme: Theme,
): ResultRows {
	if (name === "slop" && !error && !id(object(args).entry)) {
		const list = catalogListView(object(details.list));
		return {
			outcome:
				list?.outcome ??
				(summaryOf(details).replace(/^1 (slop|starter) entries$/u, "1 $1 entry.") || "Catalog list returned."),
			body,
			rest: "",
			limit: "",
			error: false,
			preview: list?.preview ?? "",
			hasMore: list?.hasMore ?? Boolean(body),
			catalogList: true,
		};
	}
	const firstLine = body.split("\n").map(singleLine).find(Boolean) ?? "";
	const { outcome, limits } = error
		? { outcome: errorOutcome(name, args, firstLine), limits: [] }
		: outcomeOf(name, details, firstLine);
	const rest = withoutDuplicateOutcome(body, outcome);
	const previewEntry = name === "slop" && !error;
	return {
		outcome,
		body,
		rest,
		limit: limits.length ? theme.fg("warning", `[${limits.join("; ")}]`) : "",
		error,
		preview: previewEntry ? rest : "",
		hasMore: !previewEntry && Boolean(rest),
		catalogList: false,
	};
}

function errorOutcome(name: SlopTool, args: unknown, diagnostic: string): string {
	return diagnosticNeedsDisclosure(name, args) ? failures[name] : diagnostic || failures[name];
}
