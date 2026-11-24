import { stripVTControlCharacters } from "node:util";
import type { AgentToolResult, KeybindingHints, Theme, ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";

const DISPLAY_LIMIT = 32_000;
const PREVIEW_ROWS = 5;

type Disclosure = { extra: boolean; lines: number; limit?: string };

export interface ToolCardGrammarContext
	extends Pick<KeybindingHints, "keyText">,
		Partial<Pick<KeybindingHints, "keyHint">> {
	readonly expanded: boolean;
	readonly isError?: boolean;
	readonly state?: {
		grammarCall?: (width: number) => Disclosure;
		grammarHasResult?: boolean;
	};
}

export interface ToolCallPresentation {
	name: string;
	subject?: string;
	facts?: readonly string[];
	/** Actual supplied arguments. Substitute a size description for anything the card must withhold. */
	args: Readonly<Record<string, unknown>>;
	/** Argument values that the subject or facts line already identifies. */
	shownArgs?: readonly string[];
	/** A prose/code argument shown on the call in addition to its labelled form in expansion. */
	body?: { key: string; text: string };
	/** Additional observed facts, distinct from supplied arguments. */
	expanded?: string;
}

export interface ToolResultPresentation {
	outcome?: string;
	/** Readable preview and expanded body. Omit for Dispatch and Show results. */
	body?: string;
	/** Additional readable facts or exact continuation, placed ahead of source in expansion. */
	expanded?: string;
	/** Retained or coverage bound, without brackets. */
	limit?: string;
	partial?: string;
	keep?: "start" | "end";
	/** Complete safe result text. Defaults to model text; omit redundant source with an empty string. */
	source?: string;
}

function safe(value: string): string {
	return stripVTControlCharacters(value).replace(/[\p{Cc}\p{Cf}]/gu, (char) =>
		char === "\n" ? char : char === "\t" ? "   " : "",
	);
}

function oneLine(value: string): string {
	return safe(value).replace(/\s+/gu, " ").trim();
}

function bounded(value: string): { text: string; limit?: string } {
	const clean = safe(value).trimEnd();
	if (clean.length <= DISPLAY_LIMIT) return { text: clean };
	// Count the characters in place: a copy of each one would cost many times the size of a large value.
	let points = 0;
	let end = clean.length;
	for (let index = 0; index < clean.length; points++) {
		if (points === DISPLAY_LIMIT) end = index;
		index += (clean.codePointAt(index) ?? 0) > 0xffff ? 2 : 1;
	}
	if (points <= DISPLAY_LIMIT) return { text: clean };
	return { text: clean.slice(0, end), limit: `Truncated: showing ${DISPLAY_LIMIT} of ${points} characters` };
}

function clip(value: string, width: number): string {
	// The input has no styles. Remove clipping resets before applying the row colour inside Pi's background.
	return stripVTControlCharacters(truncateToWidth(value, width, "…"));
}

function rows(value: string, width: number): string[] {
	return value ? wrapTextWithAnsi(value, Math.max(1, width)).map((row) => clip(row, width)) : [];
}

type Role = Parameters<Theme["fg"]>[0];

function paint(theme: Theme, role: Role, value: string, width: number, expanded = false): string[] {
	const rendered = expanded ? rows(value, width) : value ? [clip(value, width)] : [];
	return rendered.map((row) => theme.fg(role, row));
}

function preview(lines: string[], keep: "start" | "end" = "start") {
	const hidden = Math.max(0, lines.length - PREVIEW_ROWS);
	const shown = keep === "start" ? lines.slice(0, PREVIEW_ROWS) : lines.slice(-PREVIEW_ROWS);
	return { shown, hidden };
}

type Keys = Pick<ToolCardGrammarContext, "keyText" | "keyHint">;

function hint(theme: Theme, keys: Keys, disclosure: Disclosure, width: number, clickable: boolean): string[] {
	if (!disclosure.extra && !disclosure.lines) return [];
	const key = keys.keyText("app.tools.expand");
	if (!key && !clickable) return [];
	const n = disclosure.lines;
	const prefix = `... (${n ? `${n} more line${n === 1 ? "" : "s"}, ` : ""}`;
	const action = key ? `${key} to expand` : "click to expand";
	if (visibleWidth(`${prefix}${action})`) > width) return paint(theme, "muted", `${prefix}${action})`, width);
	return [
		theme.fg("muted", prefix) +
			(key
				? (keys.keyHint?.("app.tools.expand", "to expand") ?? theme.fg("dim", key) + theme.fg("muted", " to expand"))
				: theme.fg("muted", action)) +
			theme.fg("muted", ")"),
	];
}

function argumentText(value: unknown): string {
	return typeof value === "string"
		? safe(value)
		: (JSON.stringify(
				value,
				(_key, item: unknown) =>
					typeof item === "string" ? safe(item) : typeof item === "bigint" ? String(item) : item,
				2,
			) ?? String(value));
}

function argumentsText(args: Readonly<Record<string, unknown>>): string {
	return Object.entries(args)
		.flatMap(([key, value]) =>
			value === undefined ? [] : [`  ${oneLine(key)}: ${argumentText(value).replace(/\n/gu, "\n    ")}`],
		)
		.join("\n");
}

/**
 * A card that draws once per width and per value of the state that the other card of its tool shares with it.
 * An unchanged frame returns the same line array, so Pi's containers keep their own lines too.
 */
function component(draw: (width: number) => string[], shared: () => unknown): Component {
	let cached: { width: number; shared: unknown; lines: string[] } | undefined;
	return {
		render(width) {
			const current = shared();
			if (cached?.width !== width || cached.shared !== current)
				cached = { width, shared: current, lines: width > 0 ? draw(width) : draw(1).map(() => "") };
			return cached.lines;
		},
		invalidate() {
			cached = undefined;
		},
	};
}

function heading(name: string, subject: string, width: number, theme: Theme, expanded: boolean): string[] {
	const left = width - visibleWidth(name) - 1;
	const label = !expanded && subject && left <= 0 ? `${name} ${subject}` : name;
	const title = theme.fg("toolTitle", theme.bold(clip(label, width)));
	if (!subject) return [title];
	if (expanded && visibleWidth(subject) > left) return [title, ...paint(theme, "accent", subject, width, true)];
	if (left <= 0) return [title];
	return [`${title} ${paint(theme, "accent", subject, left)[0]}`];
}

function limitRows(theme: Theme, width: number, expanded: boolean, bounds: (string | undefined)[]): string[] {
	const value = [...new Set(bounds.filter(Boolean))].join("; ");
	return value ? paint(theme, "warning", `[${value}]`, width, expanded) : [];
}

export function toolCallCard(call: ToolCallPresentation, theme: Theme, context: ToolCardGrammarContext): Component {
	// The card keeps these fields and not the context: Pi's context refers to the component of the previous
	// display update, so a retained context would keep every earlier card of the tool alive.
	const { expanded, state } = context;
	const keys: Keys = { keyText: context.keyText, keyHint: context.keyHint };
	const name = oneLine(call.name);
	const subject = oneLine(call.subject ?? "");
	const facts = call.facts?.map(oneLine).filter(Boolean).join(" · ") ?? "";
	const body = bounded(call.body ? argumentText(call.args[call.body.key] ?? call.body.text) : "");
	// Only the expanded card shows the labelled arguments, so a collapsed card never serialises them.
	let labelled: ReturnType<typeof bounded> | undefined;
	const args = () => (labelled ??= bounded(argumentsText(call.args)));
	const extra = bounded(call.expanded ?? "");
	const shown = new Set(call.shownArgs);
	if (call.body) shown.add(call.body.key);
	const hiddenArgs = Object.entries(call.args).some(([key, value]) => value !== undefined && !shown.has(key));
	let wrapped: { width: number; rows: string[] } | undefined;
	const bodyRows = (width: number): string[] => {
		if (wrapped?.width !== width) wrapped = { width, rows: rows(body.text, width) };
		return wrapped.rows;
	};
	const disclosure = (width: number): Disclosure => ({
		extra:
			hiddenArgs ||
			Boolean(body.limit) ||
			extra.text !== "" ||
			visibleWidth(name + (subject ? ` ${subject}` : "")) > width ||
			visibleWidth(facts) > width,
		lines: body.limit ? 0 : preview(bodyRows(width)).hidden,
		limit:
			[expanded ? args().limit : body.limit, expanded ? extra.limit : undefined].filter(Boolean).join("; ") ||
			undefined,
	});
	if (state) state.grammarCall = disclosure;
	// Pi constructs the call first, then the result (if present), and only then measures the card.
	const owned = () => !state?.grammarHasResult;
	return component((width) => {
		const lines = heading(name, subject, width, theme, expanded);
		lines.push(...paint(theme, "muted", facts, width, expanded));
		if (expanded)
			lines.push(...paint(theme, "muted", args().text, width, true), ...paint(theme, "muted", extra.text, width, true));
		else lines.push(...preview(bodyRows(width)).shown.map((row) => theme.fg("toolOutput", row)));
		if (!owned()) return lines;
		const hidden = disclosure(width);
		lines.push(...limitRows(theme, width, expanded, [hidden.limit]));
		if (!expanded) lines.push(...hint(theme, keys, hidden, width, false));
		return lines;
	}, owned);
}

function resultDisclosure(
	call: Disclosure | undefined,
	resultLines: number,
	displayBound: boolean,
	extra: boolean,
): Disclosure {
	const callLines = call?.lines ?? 0;
	return {
		extra: Boolean(call?.extra || extra || resultLines || callLines),
		lines: displayBound || (resultLines > 0 && callLines > 0) ? 0 : resultLines || callLines,
	};
}

function resultOutcome(
	presentation: ToolResultPresentation,
	fallback: string | undefined,
	error: boolean,
	partial: boolean,
): string {
	if (error) return presentation.outcome ?? fallback ?? "Tool error";
	if (partial) return presentation.partial ?? fallback ?? "Partial result";
	return presentation.outcome ?? fallback ?? "No result text";
}

export function toolResultCard(
	result: AgentToolResult<unknown>,
	options: ToolRenderResultOptions,
	theme: Theme,
	context: ToolCardGrammarContext,
	presentation: ToolResultPresentation,
): Component {
	// As for the call card, the result card keeps fields and not the context, the options or the presentation.
	const { state } = context;
	const keys: Keys = { keyText: context.keyText, keyHint: context.keyHint };
	const { expanded } = options;
	const { keep, limit } = presentation;
	if (state) state.grammarHasResult = true;
	const content = result.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
	const fallback = safe(content).split("\n").map(oneLine).find(Boolean);
	const error = context.isError === true;
	const partial = options.isPartial && !error;
	const outcome = bounded(oneLine(resultOutcome(presentation, fallback, error, partial)));
	const source = bounded(presentation.source ?? content);
	const [first, ...following] = source.text.trimStart().split("\n");
	const hasOutcome = oneLine(first ?? "") === outcome.text;
	const remainder = hasOutcome ? following.join("\n") : source.text;
	const body = bounded(partial ? "" : error && hasOutcome ? remainder : (presentation.body ?? ""));
	const extra = bounded(partial ? "" : (presentation.expanded ?? ""));
	const extraText = extra.text !== outcome.text && extra.text.trim() !== body.text.trim() ? extra.text : "";
	const showSource = !["", body.text, extraText].some((part) => part.trim() === remainder.trim());
	const sourceRole = error ? "error" : "toolOutput";
	// The call card can be built again after this card; its disclosure then replaces the earlier one.
	const callDisclosure = () => state?.grammarCall;
	return component((width) => {
		const lines = [
			"",
			...paint(theme, error ? "error" : partial ? "muted" : "toolOutput", outcome.text, width, expanded),
		];
		const bodyRows = rows(body.text, width);
		const view = preview(bodyRows, keep);
		const call = callDisclosure()?.(width);
		const bounds = limitRows(theme, width, expanded, [
			call?.limit,
			limit,
			outcome.limit,
			body.limit,
			extra.limit,
			source.limit,
		]);
		if (expanded)
			return [
				...lines,
				...bodyRows.map((line) => theme.fg(sourceRole, line)),
				...paint(theme, sourceRole, extraText, width, true),
				...paint(theme, sourceRole, showSource ? remainder : "", width, true),
				...bounds,
			];
		const disclosure = resultDisclosure(
			call,
			view.hidden,
			Boolean(body.limit),
			showSource || extraText !== "" || visibleWidth(outcome.text) > width,
		);
		return [
			...lines,
			...view.shown.map((line) => theme.fg(sourceRole, line)),
			...bounds,
			...hint(theme, keys, disclosure, width, true),
		];
	}, callDisclosure);
}
