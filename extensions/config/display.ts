import { type Theme, type ToolDefinition, truncateToVisualLines } from "@earendil-works/pi-coding-agent";
import { type Component, stripTerminalSequences, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { EditResult } from "./protocol.ts";

export const EDIT_TOOL_NAME = "config_edit";
export type EditDisplayDetails = {
	edit?: { mode: EditResult["mode"]; outcome: EditResult["outcome"]; lines: string[] };
	diagnostic?: string;
	outputLimited?: true;
};

type DisplayRecord = Pick<ToolDefinition, "name" | "renderCall" | "renderResult" | "renderShell">;
type Color = Parameters<Theme["fg"]>[0];
type CardState = { hasResult?: boolean; hasArguments?: boolean };
type CardContext = Parameters<NonNullable<ToolDefinition["renderCall"]>>[2] & { state: CardState };
const EXPAND = "app.tools.expand";
const BODY_LINES = 5;
const DISPLAY_LIMIT = 32_000;

const outcomes: Record<EditResult["outcome"], string> = {
	previewed: "Preview passed validation; no settings were saved.",
	committed: "Saved the settings.",
	partial: "Saved only some of the changes.",
	unchanged: "The settings already held these values. No changes were saved.",
	rejected: "Settings changes did not pass validation. Nothing was saved.",
	conflict: "Settings changed elsewhere. Nothing was saved by this request.",
	failed: "Could not save the settings.",
};

function record(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function safeText(text: string): string {
	return stripTerminalSequences(text).replace(/[\p{Cc}\p{Cf}]/gu, (c) => (c === "\n" || c === "\t" ? c : ""));
}

function oneLine(text: string): string {
	return safeText(text).replace(/\s+/gu, " ").trim();
}

function bodyText(text: string): string {
	return safeText(text).replaceAll("\t", "   ");
}

function clipLine(text: string, width: number): string {
	// Apply the colour after clipping so the ellipsis and the rest of the row share the Pi box background.
	return stripTerminalSequences(truncateToWidth(text, width, "…"));
}

function sized(draw: (width: number) => string[]): Component {
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

function hint(theme: Theme, context: CardContext, width: number, hidden = 0): string {
	const prefix = hidden ? `... (${hidden} more lines, ` : "... (";
	const key = context.keyText(EXPAND);
	const plain = `${prefix}${key ? `${key} to expand` : "click to expand"})`;
	if (!key || visibleWidth(plain) > width) return theme.fg("muted", clipLine(plain, width));
	return theme.fg("muted", prefix) + context.keyHint(EXPAND, "to expand") + theme.fg("muted", ")");
}

function argumentText(args: Record<string, unknown>): string {
	return Object.entries(args)
		.map(([key, value]) => {
			const text = typeof value === "string" ? value : (JSON.stringify(value, null, 2) ?? String(value));
			return `  ${oneLine(key)}: ${bodyText(text).split("\n").join("\n    ")}`;
		})
		.join("\n");
}

function settingIds(changes: unknown[]): string[] {
	return [
		...new Set(
			changes.flatMap((change) => {
				const { id } = record(change);
				return typeof id === "string" && oneLine(id) ? [oneLine(id)] : [];
			}),
		),
	];
}

function callHeading(theme: Theme, subject: string, width: number): string {
	const colorTitle = (text: string) => theme.fg("toolTitle", theme.bold(text));
	if (!subject) return colorTitle(clipLine(EDIT_TOOL_NAME, width));
	const room = width - EDIT_TOOL_NAME.length - 1;
	if (room < 1) return colorTitle(clipLine(`${EDIT_TOOL_NAME} ${subject}`, width));
	return `${colorTitle(EDIT_TOOL_NAME)} ${theme.fg("accent", clipLine(subject, room))}`;
}

const renderCall: NonNullable<ToolDefinition["renderCall"]> = (value, theme, context: CardContext) => {
	const args = record(value);
	const changes = Array.isArray(args.changes) ? args.changes : [];
	const ids = settingIds(changes);
	const mode = args.mode === "commit" || args.mode === "preview" ? args.mode : "";
	const count = changes.length;
	const subject = ids.join(", ");
	const scopes = [
		...new Set(
			changes.flatMap((change) => {
				const { scope } = record(change);
				return scope === "global" || scope === "project" || scope === "machine" ? [scope] : [];
			}),
		),
	];
	const facts = [
		mode === "commit" ? "save" : mode,
		count ? `${count} ${count === 1 ? "change" : "changes"}` : "",
		...scopes,
	]
		.filter(Boolean)
		.join(" · ");
	context.state.hasArguments = Object.keys(args).length > 0;
	// Pi constructs the call before the result, then paints them with the same card state.
	context.state.hasResult = false;
	const expandedArgs = context.expanded ? argumentText(args) : "";
	return sized((width) => [
		callHeading(theme, subject, width),
		...(facts ? [theme.fg("muted", clipLine(facts, width))] : []),
		...(expandedArgs ? wrapped(expandedArgs, width).map((line) => theme.fg("muted", line)) : []),
		...(!context.expanded && context.state.hasArguments && !context.state.hasResult && context.keyText(EXPAND)
			? [hint(theme, context, width)]
			: []),
	]);
};

function wrapped(text: string, width: number): readonly string[] {
	return truncateToVisualLines(text, Number.POSITIVE_INFINITY, width).visualLines;
}

function bounded(text: string): { body: string; limit?: string } {
	if (text.length <= DISPLAY_LIMIT) return { body: text };
	const end = /[\uD800-\uDBFF]/u.test(text[DISPLAY_LIMIT - 1]) ? DISPLAY_LIMIT - 1 : DISPLAY_LIMIT;
	return { body: text.slice(0, end), limit: `[Truncated: showing ${end} of ${text.length} characters]` };
}

function editReadback(details: Record<string, unknown>): { outcome: string; body: string } | undefined {
	const { mode, outcome, lines } = record(details.edit);
	if ((mode !== "commit" && mode !== "preview") || typeof outcome !== "string" || !Object.hasOwn(outcomes, outcome))
		return undefined;
	if (!Array.isArray(lines) || !lines.every((line) => typeof line === "string")) return undefined;
	const sentence =
		mode === "preview" && outcome === "rejected"
			? "Preview failed validation; no settings were saved."
			: outcomes[outcome as EditResult["outcome"]];
	return { outcome: sentence, body: bodyText(lines.join("\n")) };
}

function statusText(mode: unknown): string {
	if (mode === "preview") return "Validating settings…";
	if (mode === "commit") return "Saving settings…";
	return "Editing settings…";
}

function resultText(details: Record<string, unknown>, raw: string, error: boolean): string {
	if (typeof details.diagnostic === "string" && oneLine(details.diagnostic)) return oneLine(details.diagnostic);
	const first = raw
		.split("\n")
		.map(oneLine)
		.find((line) => line && line !== "{" && line !== "[");
	return first ?? (error ? "Config did not return an error message." : "Config returned no result text.");
}

const renderResult: NonNullable<ToolDefinition["renderResult"]> = (result, options, theme, context: CardContext) => {
	context.state.hasResult = true;
	const details = record(result.details);
	const raw = bodyText(result.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n"));
	const readback = !context.isError && !options.isPartial ? editReadback(details) : undefined;
	const outcome = options.isPartial
		? statusText(record(context.args).mode)
		: (readback?.outcome ?? resultText(details, raw, context.isError));
	const color: Color = options.isPartial ? "muted" : context.isError ? "error" : "toolOutput";
	const outcomeText = bounded(outcome);
	const description = readback?.body ?? (context.isError && raw.includes("\n") ? raw : "");
	const preview = bounded(description);
	const full = bounded([description, raw !== outcome && raw !== description ? raw : ""].filter(Boolean).join("\n\n"));
	const outputLimit =
		details.outputLimited === true
			? "[Result exceeded the output limit; complete details were not retained.]"
			: undefined;
	return sized((width) => {
		const outcomeLines = options.expanded ? wrapped(outcomeText.body, width) : [clipLine(outcomeText.body, width)];
		const rows = ["", ...outcomeLines.map((line) => theme.fg(color, line))];
		const bodyColor = context.isError ? "error" : "toolOutput";
		const body = options.expanded ? full : preview;
		const shown = options.expanded
			? { visualLines: wrapped(body.body, width), skippedCount: 0 }
			: truncateToVisualLines(body.body, BODY_LINES, width, 0, "start");
		rows.push(...shown.visualLines.map((line) => theme.fg(bodyColor, line)));
		const limit = outputLimit ?? outcomeText.limit ?? body.limit;
		if (limit) rows.push(theme.fg("warning", clipLine(limit, width)));
		if (
			!options.expanded &&
			(shown.skippedCount ||
				full.body !== preview.body ||
				visibleWidth(outcomeText.body) > width ||
				context.state.hasArguments)
		)
			rows.push(hint(theme, context, width, shown.skippedCount));
		return rows;
	});
};

const edit = { name: EDIT_TOOL_NAME, renderCall, renderResult } satisfies DisplayRecord;

export function toolDisplay(): { version: 1; tools: DisplayRecord[] } {
	return { version: 1, tools: [{ ...edit }] };
}
