import { homedir } from "node:os";
import { sep } from "node:path";
import type { Theme, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { compile } from "@earendil-works/pi-schema";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { bodyText, singleLine } from "./presentation-text.ts";
import { CheckParams, RecordParams, ViewParams } from "./tool-contract.ts";
import { idPattern, proseKinds, scopes } from "./vocabulary.ts";

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
	const kind = member(proseKinds, args.kind);
	if (kind) facts.unshift(kind);
	const text = args.text;
	if (typeof text === "string") return { subject: "check text", facts, more: [() => `text: ${size(text)}`] };
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

export function expansionHint(theme: Theme, context: Hints, width: number, clickable: boolean): string[] {
	const hasKey = Boolean(context.keyText?.(expand));
	if (!hasKey && !clickable) return [];
	const action = hasKey ? context.keyHint(expand, "to expand") : theme.fg("muted", "click to expand");
	return [clipRow(theme.fg("muted", "... (") + action + theme.fg("muted", ")"), width)];
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

const callLine = (name: SlopTool, target: Target, theme: Theme) =>
	theme.fg("toolTitle", theme.bold(name)) + (target.subject ? ` ${theme.fg("accent", target.subject)}` : "");

function callAddsDetail(target: Target, line: string, width: number): boolean {
	return Boolean(target.more?.length || target.facts?.length) || visibleWidth(line) > width;
}

function expandedCall(line: string, target: Target, theme: Theme, width: number): string[] {
	const output = wrapTextWithAnsi(line, width);
	if (target.facts?.length) output.push(...wrapTextWithAnsi(theme.fg("muted", target.facts.join(" · ")), width));
	for (const field of target.more ?? []) output.push(...wrapTextWithAnsi(theme.fg("muted", `  ${field()}`), width));
	return output;
}

export function callCard(name: SlopTool): Call {
	return (args, theme, context) => {
		const state = context.state as { hasResult?: boolean };
		state.hasResult = false;
		const target = targets[name](object(args));
		const line = callLine(name, target, theme);
		return rows((width) => {
			if (width <= 0) return [];
			if (context.expanded) return expandedCall(line, target, theme, width);
			const display = [clipRow(line, width)];
			if (!state.hasResult && callAddsDetail(target, line, width)) {
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
	const summary = findings ? count(findings, "slop detector finding") : "No slop detector findings";
	const outcome = `${summary}${skipped ? " in checked inputs" : ""}.`;
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

function catalogListOutcome(list: Record<string, unknown>): string {
	const kind = list.kind;
	const total = nonnegative(list.count);
	return (kind === "catalog" || kind === "starter") && total !== undefined ? catalogOutcome(kind, total, list) : "";
}

function withoutDuplicateOutcome(body: string, outcome: string): string {
	if (body === outcome) return "";
	return body.startsWith(`${outcome}\n`) ? body.slice(outcome.length + 1) : body;
}

interface ResultView {
	outcome: string;
	expanded: string;
	limit: string;
}

function resultLines(view: ResultView, theme: Theme, width: number, expanded: boolean, error: boolean): string[] {
	const color = error ? "error" : "toolOutput";
	const { outcome, limit } = view;
	const warning = limit ? theme.fg("warning", limit) : "";
	if (expanded) {
		return [
			"",
			...wrapTextWithAnsi(view.expanded, width).map((line) => theme.fg(color, line)),
			...(warning ? wrapTextWithAnsi(warning, width) : []),
		];
	}
	const lead = theme.fg(color, outcome);
	if (warning && visibleWidth(`${lead} ${warning}`) > width) {
		return ["", clipRow(lead, width), clipRow(warning, width)];
	}
	return ["", warning ? `${lead} ${warning}` : clipRow(lead, width)];
}

export function resultCard(name: SlopTool): Result {
	return (result, options, theme, context) => {
		(context.state as { hasResult?: boolean }).hasResult = true;
		const body = bodyText(
			result.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n"),
		).trimEnd();
		const args = object(context.args);
		const view = resultView(name, context.args, object(result.details), body, context.isError);
		const target = targets[name](args);
		const header = callLine(name, target, theme);
		return rows((width) => {
			if (width <= 0) return [];
			const output = resultLines(view, theme, width, options.expanded, context.isError);
			if (
				!options.expanded &&
				(view.expanded !== view.outcome ||
					visibleWidth(view.outcome) > width ||
					visibleWidth(view.limit) > width ||
					callAddsDetail(target, header, width))
			) {
				output.push(...expansionHint(theme, context, width, true));
			}
			return output;
		});
	};
}

function resultView(
	name: SlopTool,
	args: unknown,
	details: Record<string, unknown>,
	body: string,
	error: boolean,
): ResultView {
	if (name === "slop" && !error && !id(object(args).entry)) {
		const outcome =
			catalogListOutcome(object(details.list)) ||
			summaryOf(details).replace(/^1 (slop|starter) entries$/u, "1 $1 entry.") ||
			"Catalog list returned.";
		return { outcome, expanded: body || outcome, limit: "" };
	}
	const firstLine = body.split("\n").map(singleLine).find(Boolean) ?? "";
	if (error) {
		const outcome = errorOutcome(name, args, firstLine);
		return { outcome, expanded: body || outcome, limit: "" };
	}
	const { outcome, limits } = outcomeOf(name, details, firstLine || "No result text.");
	return {
		outcome,
		expanded: [outcome, withoutDuplicateOutcome(body, outcome)].filter(Boolean).join("\n"),
		limit: limits.length ? `[${limits.join("; ")}]` : "",
	};
}

function errorOutcome(name: SlopTool, args: unknown, diagnostic: string): string {
	return diagnosticNeedsDisclosure(name, args) ? failures[name] : diagnostic || failures[name];
}
