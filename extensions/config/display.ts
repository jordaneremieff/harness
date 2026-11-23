import { homedir } from "node:os";
import { type Theme, type ToolDefinition, truncateToVisualLines } from "@earendil-works/pi-coding-agent";
import { type Component, stripTerminalSequences, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { EditResult } from "./protocol.ts";

export const EDIT_TOOL_NAME = "config_edit";
export type ConfigDisplayDetails = {
	edit?: { mode: EditResult["mode"]; outcome: EditResult["outcome"]; lines: string[] };
	diagnostic?: string;
	outputLimited?: true;
};

const TOOL_NAMES = ["config_find", "config_get", EDIT_TOOL_NAME, "config_tools"] as const;
type ToolName = (typeof TOOL_NAMES)[number];
type Readback = { outcome: string; lines?: string[]; extra?: string[]; continuation?: string; warning?: string };

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

function callHeading(name: ToolName, theme: Theme, subject: string, width: number): string {
	const colorTitle = (text: string) => theme.fg("toolTitle", theme.bold(text));
	if (!subject) return colorTitle(clipLine(name, width));
	const room = width - name.length - 1;
	if (room < 1) return colorTitle(clipLine(`${name} ${subject}`, width));
	return `${colorTitle(name)} ${theme.fg("accent", clipLine(subject, room))}`;
}

function list(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}

function strings(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((item) => typeof item === "string");
}

const names = (value: unknown) => (strings(value) ? value.map(oneLine).filter(Boolean) : []);
const string = (value: unknown) => (typeof value === "string" ? oneLine(value) : "");
const pathText = (path: string) => (path.startsWith(`${homedir()}/`) ? `~${path.slice(homedir().length)}` : path);
const countOf = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;
const numberFact = (label: string, value: unknown) => (Number.isSafeInteger(value) ? `${label} ${value}` : "");

function editCall(args: Record<string, unknown>) {
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
	const safeChanges = changes.map((value) => {
		const change = record(value);
		const allowed = ["id", "action", "scope", "schema", "type"].filter((key) => typeof change[key] === "string");
		return {
			...Object.fromEntries(allowed.map((key) => [key, change[key]])),
			...(typeof change.raw === "boolean" ? { raw: change.raw } : {}),
			...withheld(change),
		};
	});
	const revisions = Object.fromEntries(
		Object.entries(record(args.revisions)).filter(
			([key, revision]) =>
				["harness", "pi-global", "pi-project"].includes(key) && (typeof revision === "string" || revision === null),
		),
	);
	const requestId = typeof args.requestId === "string" ? args.requestId : undefined;
	return {
		subject,
		facts,
		extra: {
			...(mode ? { mode } : {}),
			...(changes.length ? { changes: safeChanges } : {}),
			...(Object.keys(revisions).length ? { revisions } : {}),
			...(requestId ? { requestId } : {}),
		},
	};
}

function withheld(change: Record<string, unknown>) {
	return Object.fromEntries(
		["value", "base", "description"].filter((key) => Object.hasOwn(change, key)).map((key) => [key, "[withheld]"]),
	);
}

function callDetails(
	name: ToolName,
	args: Record<string, unknown>,
): { subject: string; facts: string; extra?: Record<string, unknown> } {
	switch (name) {
		case EDIT_TOOL_NAME:
			return editCall(args);
		case "config_find":
			return {
				subject: string(args.query) || "settings",
				facts: [string(args.group), numberFact("limit", args.limit), numberFact("offset", args.offset)]
					.filter(Boolean)
					.join(" · "),
			};
		case "config_get":
			return { subject: names(args.ids).join(", "), facts: "" };
		case "config_tools": {
			const activate = names(args.activate);
			const deactivate = names(args.deactivate);
			const actions = [
				activate.length ? `activate ${activate.join(", ")}` : "",
				deactivate.length ? `deactivate ${deactivate.join(", ")}` : "",
			];
			return { subject: actions.filter(Boolean).join("; ") || "session tools", facts: "" };
		}
	}
}

function callRenderer(name: ToolName): NonNullable<ToolDefinition["renderCall"]> {
	return (value, theme, context: CardContext) => {
		const { subject, facts, extra } = callDetails(name, record(value));
		const fullArgs = name === EDIT_TOOL_NAME ? (extra ?? {}) : record(value);
		const hiddenArgs = Boolean(extra && Object.keys(extra).length);
		// Pi builds the call first, then paints it before the result with the same state.
		context.state.hasResult = false;
		return sized((width) => {
			const subjectClipped = Object.keys(fullArgs).length > 0 && visibleWidth(`${name} ${subject}`) > width;
			const factsClipped = visibleWidth(facts) > width;
			context.state.hasArguments = Boolean(hiddenArgs || subjectClipped || factsClipped);
			const rows = [callHeading(name, theme, subject, width)];
			if (facts) rows.push(theme.fg("muted", clipLine(facts, width)));
			if (context.expanded && context.state.hasArguments) rows.push(...paintArguments(theme, width, fullArgs));
			if (!context.expanded && context.state.hasArguments && !context.state.hasResult && context.keyText(EXPAND))
				rows.push(hint(theme, context, width));
			return rows;
		});
	};
}

function paintArguments(theme: Theme, width: number, args: Record<string, unknown>): string[] {
	const shown = bounded(argumentText(args));
	const rows = wrapped(shown.body, width).map((line) => theme.fg("muted", line));
	if (shown.limit) rows.push(theme.fg("warning", clipLine(shown.limit, width)));
	return rows;
}

function wrapped(text: string, width: number): readonly string[] {
	return truncateToVisualLines(text, Number.POSITIVE_INFINITY, width).visualLines;
}

function bounded(text: string): { body: string; limit?: string } {
	if (text.length <= DISPLAY_LIMIT) return { body: text };
	const end = /[\uD800-\uDBFF]/u.test(text[DISPLAY_LIMIT - 1]) ? DISPLAY_LIMIT - 1 : DISPLAY_LIMIT;
	return { body: text.slice(0, end), limit: `[Truncated: showing ${end} of ${text.length} characters]` };
}

function editOutcome(value: Record<string, unknown>): string | undefined {
	const { mode, outcome } = value;
	if ((mode !== "commit" && mode !== "preview") || typeof outcome !== "string" || !Object.hasOwn(outcomes, outcome))
		return undefined;
	return mode === "preview" && outcome === "rejected"
		? "Preview failed validation; no settings were saved."
		: outcomes[outcome as EditResult["outcome"]];
}

function editDocument(value: unknown, mode: unknown): { lines: string[]; extra: string[] } {
	const document = record(value);
	const committed = mode === "commit" && document.outcome === "committed";
	const error = string(document.error);
	const lines = committed && error ? [error] : [];
	for (const item of list(document.changes)) {
		const { id, problems, status, apply } = record(item);
		if (typeof id !== "string" || !strings(problems)) continue;
		lines.push(...problems.map((problem) => `${oneLine(id)}: ${problem}`));
		if (committed && !error && status === "ok")
			lines.push(`${oneLine(id)}: ${applicationText(record(apply)) || "The session effect was not verified."}`);
	}
	const file = pathText(string(document.path));
	const scope = string(document.scope);
	const outcome = string(document.outcome);
	const extra = file && scope && outcome ? [`${scope}: ${file} (${outcome})${error ? `: ${error}` : ""}`] : [];
	return { lines, extra };
}

function applicationText(apply: Record<string, unknown>) {
	return apply.state === "applied"
		? "The loaded session value matches the resolved value. Some Pi settings take effect only in a new process."
		: string(apply.text);
}

function editLines(summary: unknown, docs: ReturnType<typeof editDocument>[]): string[] {
	return [
		...new Set([typeof summary === "string" ? summary : "", ...docs.flatMap((doc) => doc.lines)].filter(Boolean)),
	];
}

export function describeConfigEdit(result: EditResult): NonNullable<ConfigDisplayDetails["edit"]> {
	const docs = result.documents.map((document) => editDocument(document, result.mode));
	return { mode: result.mode, outcome: result.outcome, lines: editLines(result.summary, docs) };
}

function editReadback(details: Record<string, unknown>, value: Record<string, unknown>): Readback | undefined {
	const edit = record(details.edit);
	const envelope = typeof value.summary === "string" && Array.isArray(value.documents) ? value : {};
	const outcome = (strings(edit.lines) ? editOutcome(edit) : undefined) ?? editOutcome(envelope);
	if (!outcome) return undefined;
	const docs = list(envelope.documents).map((document) => editDocument(document, envelope.mode));
	const lines = strings(edit.lines) && editOutcome(edit) ? edit.lines : editLines(envelope.summary, docs);
	return { outcome, lines, extra: docs.flatMap((doc) => doc.extra) };
}

function findReadback(value: Record<string, unknown>, args: Record<string, unknown>): Readback | undefined {
	const { total, offset, rows, next, coverage } = value;
	if (!Array.isArray(rows) || typeof total !== "number" || typeof offset !== "number") return undefined;
	const page = rows.length
		? `Returned matches ${offset + 1}–${offset + rows.length} of ${total}.`
		: total
			? `No matches at offset ${offset}; ${countOf(total, "match")} in the catalogue.`
			: "No settings matched the search.";
	const continued = typeof next === "number";
	const lines = rows.map((item: unknown) => {
		const { id, label, source } = record(item);
		return [string(id), string(label), string(source)].filter(Boolean).join(" · ");
	});
	const limitations = names(coverage);
	const { query, group, limit } = args;
	return {
		outcome: continued ? `${page} More matches are available.` : page,
		lines,
		extra: limitations,
		...(continued
			? { continuation: `Next call: config_find ${JSON.stringify({ query, group, limit, offset: next })}` }
			: {}),
		...(limitations.length ? { warning: "[Discovery coverage is partial.]" } : {}),
	};
}

function settingState(entry: Record<string, unknown>): string {
	const env = record(entry.env);
	const resolved = record(entry.resolved);
	const session = record(entry.session);
	const source = string(resolved.source);
	const id = string(entry.id);
	if (env.secret === true) {
		const state = env.set === true ? "set" : env.set === false ? "not set" : "set state not observed";
		return `${id}: ${state} in the environment; value withheld.`;
	}
	const state =
		source === "env" ? "environment value" : source === "unset" ? "no resolved value" : `resolved from ${source}`;
	const active = session.differs === true ? "; loaded value differs" : "";
	return `${id}: ${state}${active}.`;
}

const valueLimit = "The value exceeds 32768 bytes; open it in /config.";
function settingValue(value: unknown): string {
	if (record(value).omitted === valueLimit && Object.keys(record(value)).length === 1) return "[Value not retained]";
	return JSON.stringify(value) ?? "[Value not observed]";
}

function savedValues(entry: Record<string, unknown>): string[] {
	return Object.entries(record(entry.saved)).flatMap(([scope, value]) => {
		const saved = record(value);
		if (saved.present === false) return [`  ${scope}: no saved override`];
		return saved.present === true ? [`  ${scope}: ${settingValue(saved.value)}`] : [];
	});
}

function settingDetails(entry: Record<string, unknown>): string[] {
	const id = string(entry.id);
	const resolved = record(entry.resolved);
	const session = record(entry.session);
	const env = record(entry.env);
	const base = [`${id}: ${string(entry.label) || "Setting details"}`];
	if (typeof env.name === "string") base.push(`  environment: ${oneLine(env.name)}`);
	if (env.secret !== true) {
		base.push(...savedValues(entry));
		if (Object.hasOwn(resolved, "value")) base.push(`  resolved: ${settingValue(resolved.value)}`);
		if (Object.hasOwn(session, "value")) base.push(`  loaded: ${settingValue(session.value)}`);
		const defaults = record(entry.default);
		if (Object.hasOwn(defaults, "value")) base.push(`  default: ${settingValue(defaults.value)}`);
	}
	return [...base, ...[resolved.note, entry.readOnly, ...list(entry.diagnostics)].map(string).filter(Boolean)];
}

function getReadback(value: Record<string, unknown>): Readback | undefined {
	if (!Array.isArray(value.entries) || !strings(value.missing)) return undefined;
	const entries = value.entries.map(record).filter((entry) => typeof entry.id === "string");
	const missing = value.missing.map(oneLine);
	const lines = entries.flatMap((entry) => {
		const application = applicationText(record(entry.applyState));
		return [settingState(entry), ...(application ? [`  ${application}`] : [])];
	});
	lines.push(...missing.map((id) => `${id}: not found.`));
	const extra = entries.flatMap(settingDetails);
	for (const item of list(record(value.context).documents)) {
		const { document, path, revision } = record(item);
		if (typeof document === "string" && typeof path === "string" && typeof revision === "string")
			extra.push(`${oneLine(document)}: ${pathText(oneLine(path))} · revision ${oneLine(revision)}`);
	}
	for (const item of list(value.owners)) {
		const { owner, state, detail } = record(item);
		if (typeof owner === "string" && typeof state === "string")
			extra.push([owner, state, string(detail)].filter(Boolean).join(" · "));
	}
	const matched = entries.length
		? `Read ${countOf(entries.length, "setting")}.`
		: "None of the requested settings were found.";
	return {
		outcome:
			missing.length && entries.length ? `${matched} ${countOf(missing.length, "requested ID")} not found.` : matched,
		lines,
		extra,
		...(extra.some((line) => line.endsWith(": [Value not retained]"))
			? { warning: "[Values over 32768 bytes were not retained. Open them in /config.]" }
			: {}),
	};
}

function toolChangeOutcome(change: Record<string, unknown>, rejected: number): string | undefined {
	if (typeof change.applied !== "boolean") return undefined;
	const activated = names(change.activated).length;
	const deactivated = names(change.deactivated).length;
	if (!change.applied) return "Pi did not confirm the full session selection.";
	if (activated || deactivated) {
		const applied = [activated ? `activated ${activated}` : "", deactivated ? `deactivated ${deactivated}` : ""]
			.filter(Boolean)
			.join(", ");
		return `Pi ${applied}${rejected ? `; rejected ${rejected}` : ""}.`;
	}
	return rejected
		? `Pi rejected ${countOf(rejected, "tool name")}; no selection changed.`
		: "The session tool selection already matched the request.";
}

function toolsReadback(value: Record<string, unknown>): Readback | undefined {
	if (typeof value.session !== "boolean" || !Array.isArray(value.tools) || !strings(value.active)) return undefined;
	const defaults = names(record(value.defaults).resolved);
	const change = record(value.change);
	const rejected = list(change.rejected).map(record);
	const active = value.active.map(oneLine);
	const lines = [
		...rejected.map(({ name, reason }) => `${string(name)}: ${string(reason)}`),
		...names(change.activated).map((tool) => `Activated: ${tool}`),
		...names(change.deactivated).map((tool) => `Deactivated: ${tool}`),
		...(value.session && active.length ? [`Selected in this session: ${active.join(", ")}`] : []),
		...(defaults.length
			? [`Configured for new sessions: ${defaults.join(", ")}`]
			: ["No tools are configured for new sessions."]),
	];
	const extra = value.tools.map((row: unknown) => {
		const { name, exposure, source, active } = record(row);
		return [string(name), active === true ? "selected" : "not selected", string(exposure), pathText(string(source))]
			.filter(Boolean)
			.join(" · ");
	});
	const outcome = value.session
		? (toolChangeOutcome(change, rejected.length) ??
			`This session selects ${active.length} of ${value.tools.length} available tools.`)
		: string(value.reason) || "This host exposes no current-session tool controls.";
	return {
		outcome,
		lines,
		extra,
		...(value.session && change.applied === false ? { warning: "[Some requested effects were not confirmed.]" } : {}),
	};
}

function parseBody(raw: string): Record<string, unknown> {
	try {
		return record(JSON.parse(raw));
	} catch {
		return {};
	}
}

function readbackFor(
	name: ToolName,
	details: Record<string, unknown>,
	value: Record<string, unknown>,
	args: Record<string, unknown>,
) {
	switch (name) {
		case EDIT_TOOL_NAME:
			return editReadback(details, value);
		case "config_find":
			return findReadback(value, args);
		case "config_get":
			return getReadback(value);
		case "config_tools":
			return toolsReadback(value);
	}
}

function statusText(name: ToolName, args: Record<string, unknown>): string {
	if (name === "config_find") return "Searching settings…";
	if (name === "config_get") return "Reading settings…";
	if (name === "config_tools")
		return list(args.activate).length || list(args.deactivate).length
			? "Changing the session tool selection…"
			: "Reading the session tool selection…";
	if (args.mode === "preview") return "Validating settings…";
	if (args.mode === "commit") return "Saving settings…";
	return "Editing settings…";
}

function resultReadback(
	name: ToolName,
	raw: string,
	details: Record<string, unknown>,
	args: Record<string, unknown>,
	error: boolean,
): Readback {
	const value = parseBody(raw);
	if (error || typeof value.error === "string") return errorReadback(name, details, value.error, raw);
	const unrecognised = name === EDIT_TOOL_NAME || Object.keys(value).length > 0;
	return (
		readbackFor(name, details, value, args) ?? {
			outcome: unrecognised
				? "Config returned an unrecognised receipt."
				: raw.split("\n").map(oneLine).find(Boolean) || "Config returned no result text.",
		}
	);
}

function errorReadback(name: ToolName, details: Record<string, unknown>, error: unknown, raw: string): Readback {
	const owned = typeof details.diagnostic === "string" ? details.diagnostic : error;
	// Pi's pre-execution validation error can include the entire edit input, even in its first line.
	if (name === EDIT_TOOL_NAME && (details.summary !== name || typeof owned !== "string"))
		return { outcome: "Config edit returned an error; the diagnostic is withheld to protect edit inputs." };
	const diagnostic = typeof owned === "string" ? owned : raw;
	const [first, ...tail] = bodyText(diagnostic).split("\n");
	const limited = details.outputLimited === true;
	const effect = limited && name === EDIT_TOOL_NAME ? editOutcome(record(details.edit)) : undefined;
	return {
		outcome: oneLine(first) || "Config did not return an error message.",
		lines: [...(effect ? [effect] : []), ...tail],
		...(limited ? { warning: "[Result exceeded the output limit; complete details were not retained.]" } : {}),
	};
}

function paintResult(
	theme: Theme,
	context: CardContext,
	expanded: boolean,
	color: Color,
	readback: Readback,
): Component {
	const outcome = bounded(oneLine(readback.outcome));
	const text = bodyText((readback.lines ?? []).join("\n"));
	const preview = bounded(text);
	const extra = bodyText((readback.extra ?? []).join("\n"));
	const full = bounded([readback.continuation, text, extra].filter(Boolean).join("\n"));
	const bodyColor = color === "error" && !readback.warning ? "error" : "toolOutput";
	return sized((width) => {
		const outcomeRows = expanded ? wrapped(outcome.body, width) : [clipLine(outcome.body, width)];
		const rows = ["", ...outcomeRows.map((line) => theme.fg(color, line))];
		const body = expanded ? full : preview;
		const shown = expanded
			? { visualLines: wrapped(body.body, width), skippedCount: 0 }
			: truncateToVisualLines(body.body, BODY_LINES, width, 0, "start");
		rows.push(...shown.visualLines.map((line) => theme.fg(bodyColor, line)));
		const limit = outcome.limit ?? body.limit ?? readback.warning;
		if (limit) rows.push(theme.fg("warning", clipLine(limit, width)));
		if (
			!expanded &&
			(shown.skippedCount ||
				full.body !== preview.body ||
				visibleWidth(outcome.body) > width ||
				context.state.hasArguments)
		)
			rows.push(hint(theme, context, width, shown.skippedCount));
		return rows;
	});
}

function resultRenderer(name: ToolName): NonNullable<ToolDefinition["renderResult"]> {
	return (result, options, theme, context: CardContext) => {
		context.state.hasResult = true;
		const details = record(result.details);
		const args = record(context.args);
		const raw = result.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
		const readback = options.isPartial
			? { outcome: statusText(name, args) }
			: resultReadback(name, raw, details, args, context.isError);
		const color: Color = options.isPartial ? "muted" : context.isError ? "error" : "toolOutput";
		return paintResult(theme, context, options.expanded, color, readback);
	};
}

const renderers: DisplayRecord[] = TOOL_NAMES.map((name) => ({
	name,
	renderCall: callRenderer(name),
	renderResult: resultRenderer(name),
}));
export function toolDisplay(): { version: 1; tools: DisplayRecord[] } {
	return { version: 1, tools: renderers.map((renderer) => ({ ...renderer })) };
}
