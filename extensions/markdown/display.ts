import { homedir } from "node:os";
import {
	type AgentToolResult,
	type Theme,
	type ToolDefinition,
	truncateToVisualLines,
} from "@earendil-works/pi-coding-agent";
import { type Component, stripTerminalSequences, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

type Card = Pick<ToolDefinition, "name" | "renderCall" | "renderResult">;
type Call = NonNullable<Card["renderCall"]>;
type Result = NonNullable<Card["renderResult"]>;
type Context = Parameters<Call>[2];
const names = ["markdown_brief", "markdown_publish", "markdown_read", "markdown_live"] as const;
type Name = (typeof names)[number];
const DISPLAY_CHARS = 32_000;
const PREVIEW_ROWS = 5;

function record(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
function string(value: unknown): string {
	return typeof value === "string" ? value : "";
}
function number(value: unknown): number | undefined {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}
function safe(value: string): string {
	return stripTerminalSequences(value)
		.replace(/\r\n/g, "\n")
		.replace(/[\p{Cc}\p{Cf}]/gu, (c) => (c === "\n" ? c : c === "\t" ? "   " : ""));
}
function line(value: unknown): string {
	return safe(string(value)).replace(/\s+/gu, " ").trim();
}
function shortenHomePath(path: string): string {
	const home = homedir();
	return path === home || path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}
function fact(label: string, value: unknown): string {
	return number(value) === undefined ? "" : `${label} ${value}`;
}
function units(n: number, unit: string): string {
	return `${n} ${unit}${n === 1 ? "" : "s"}`;
}
function json(value: unknown, indent?: number): string {
	try {
		return JSON.stringify(value, null, indent) ?? "";
	} catch {
		return "Details could not be displayed.";
	}
}
function clip(styled: string, width: number): string {
	return truncateToWidth(styled, width, "…").replace(/\x1b\[0m…\x1b\[0m$/u, "…\x1b[22;23;24;25;27;28;29;39m");
}
function rows(text: string, width: number, limit = Infinity) {
	return truncateToVisualLines(text, limit, width, 0, "start");
}
function atWidth(draw: (width: number) => string[]): Component {
	let drawnWidth: number | undefined;
	let view: string[] = [];
	return {
		render(width) {
			if (drawnWidth !== width) {
				view = draw(Math.max(1, width));
				drawnWidth = width;
			}
			return view;
		},
		invalidate() {
			drawnWidth = undefined;
		},
	};
}
function hint(theme: Theme, context: Context, width: number, count = 0): string {
	const key = context.keyText?.("app.tools.expand");
	const action = key
		? (context.keyHint?.("app.tools.expand", "to expand") ?? theme.fg("dim", key) + theme.fg("muted", " to expand"))
		: theme.fg("muted", "click to expand");
	return clip(
		theme.fg("muted", `... (${count ? `${units(count, "more line")}, ` : ""}`) + action + theme.fg("muted", ")"),
		width,
	);
}
function bounded(text: string) {
	if (text.length <= DISPLAY_CHARS) return { text, limit: "" };
	const end = /[\uD800-\uDBFF]/u.test(text[DISPLAY_CHARS - 1] ?? "") ? DISPLAY_CHARS - 1 : DISPLAY_CHARS;
	return { text: text.slice(0, end), limit: `[Truncated: showing ${end} of ${text.length} characters]` };
}
function argumentsText(args: Record<string, unknown>, skip: readonly string[]): string {
	return Object.entries(args)
		.filter(([key]) => !skip.includes(key))
		.map(
			([key, value]) =>
				`  ${line(key)}: ${safe(typeof value === "string" ? value : json(value, 2)).replace(/\n/g, "\n    ")}`,
		)
		.join("\n");
}

type Fields = Record<string, unknown>;
function publishInput(args: Fields) {
	const title = line(args.title);
	const file = shortenHomePath(line(args.file));
	const document = line(args.document);
	const subject = title || file || (args.response === "previous" ? "previous response" : document);
	return {
		subject,
		facts: [
			file !== subject ? file : "",
			document !== subject ? document : "",
			fact("expected revision", args.expectedRevision),
		],
		body: safe(string(args.text)),
		skip: ["title", "file", "document", "expectedRevision", "response", "text"],
	};
}
function readInput(args: Fields) {
	const id = line(args.document);
	const kind = line(args.kind) || "published";
	const contains = line(args.contains);
	if (id)
		return {
			subject: id,
			facts: [fact("revision", args.revision), fact("offset", args.offset)],
			skip: ["document", "revision", "offset"],
		};
	const subject = line(args.query) || contains || kind;
	return {
		subject,
		facts: [kind !== subject ? kind : "", contains && contains !== subject ? `contains ${contains}` : ""],
		skip: ["query", "contains", "kind"],
	};
}
function liveInput(args: Fields) {
	const op = line(args.op);
	const show = op === "show";
	return {
		subject: [op, line(show ? args.document : args.handle)].filter(Boolean).join(" "),
		facts: [
			show ? line(args.handle) : "",
			fact("revision", args.revision),
			fact("offset", args.offset),
			line(args.commentState),
		],
		skip: ["op", "handle", "document", "revision", "offset", "commentState"],
	};
}
const inputs = {
	markdown_publish: publishInput,
	markdown_read: readInput,
	markdown_live: liveInput,
	markdown_brief: (args: Fields) => ({ subject: line(args.title), facts: [], skip: ["title"] }),
} satisfies Record<Name, (args: Fields) => { subject: string; facts: string[]; body?: string; skip: string[] }>;
function callInfo(name: Name, args: Fields) {
	const info: ReturnType<(typeof inputs)[Name]> & { body?: string } = inputs[name](args);
	return {
		subject: info.subject,
		facts: info.facts.filter(Boolean).join(" · "),
		body: bounded(info.body ?? ""),
		extra: bounded(argumentsText(args, info.skip)),
	};
}
type CallInfo = ReturnType<typeof callInfo>;
interface State {
	args?: Fields;
	call?: CallInfo;
	result?: boolean;
	hideCallBody?: boolean;
}
function cardState(context: Context): State {
	context.state.markdown ??= {};
	return context.state.markdown;
}
function discloseCall(name: Name, info: CallInfo, width: number, hideBody = false) {
	const clipped = visibleWidth(`${name} ${info.subject}`.trimEnd()) > width || visibleWidth(info.facts) > width;
	return {
		more: clipped || !!info.extra.text || (hideBody && !!info.body.text),
		count: hideBody ? 0 : rows(info.body.text, width, PREVIEW_ROWS).skippedCount,
	};
}
function colored(text: string, theme: Theme, color: Parameters<Theme["fg"]>[0], width: number): string[] {
	return rows(text, width).visualLines.map((row) => theme.fg(color, row));
}
function factRows(facts: string, theme: Theme, width: number, expanded: boolean): string[] {
	if (!facts) return [];
	return expanded ? colored(facts, theme, "muted", width) : [clip(theme.fg("muted", facts), width)];
}
function limits(theme: Theme, width: number, ...text: string[]): string[] {
	return [...new Set(text.filter(Boolean))].flatMap((item) => colored(item, theme, "warning", width));
}
function callDisclosure(
	name: Name,
	info: CallInfo,
	theme: Theme,
	context: Context,
	state: State,
	width: number,
): string[] {
	if (context.expanded || state.result || !context.keyText?.("app.tools.expand")) return [];
	const { more, count } = discloseCall(name, info, width);
	return more || count ? [hint(theme, context, width, more ? 0 : count)] : [];
}
function callBody(info: CallInfo, state: State, expanded: boolean, theme: Theme, width: number) {
	if (!expanded && state.hideCallBody) return [];
	return rows(info.body.text, width, expanded ? Infinity : PREVIEW_ROWS).visualLines.map((row) =>
		theme.fg("toolOutput", row),
	);
}
function call(name: Name): Call {
	return (input, theme, context) => {
		const args = record(input);
		const info = callInfo(name, args);
		const state = cardState(context);
		state.args = args;
		state.call = info;
		const title = theme.fg("toolTitle", theme.bold(name));
		const subject = info.subject ? ` ${theme.fg("accent", info.subject)}` : "";
		return atWidth((width) => {
			const expanded = context.expanded;
			const out = [clip(title + subject, width)];
			if (expanded && subject && visibleWidth(title + subject) > width)
				out.push(...colored(info.subject, theme, "accent", width));
			out.push(...factRows(info.facts, theme, width, expanded));
			if (expanded) out.push(...colored(info.extra.text, theme, "muted", width));
			out.push(...callBody(info, state, expanded, theme, width));
			out.push(...limits(theme, width, info.body.limit, expanded ? info.extra.limit : ""));
			out.push(...callDisclosure(name, info, theme, context, state, width));
			return out;
		});
	};
}

interface Copy {
	outcome: string;
	preview?: string;
	more?: string;
	continuation?: Record<string, unknown>;
}
function page(scope: string, v: Record<string, unknown>) {
	const offset = fact("offset", v.offset);
	return `${scope}${offset ? ` at ${offset}` : ""}${number(v.nextOffset) === undefined ? "; no continuation" : "; more follows"}.`;
}
function documentIdentity(v: Record<string, unknown>) {
	return [line(v.documentId), fact("revision", v.revision)].filter(Boolean).join(" · ");
}
function receipt(v: Fields, ...omit: string[]): string {
	const entries = Object.entries(v).filter(([key]) => !omit.includes(key));
	return entries.length ? json(Object.fromEntries(entries), 2) : "";
}
function nextLivePage(v: Fields, args: Fields) {
	const handle = string(args.handle) || string(record(v.pane).handle);
	const offset = number(v.nextOffset);
	return handle && offset !== undefined ? { handle, offset } : undefined;
}
function liveList(v: Fields): Copy | undefined {
	if (!Array.isArray(v.panes)) return;
	const pending = Array.isArray(v.pending) ? v.pending.length : 0;
	const count = v.panes.length;
	const preview = v.panes
		.map((item: unknown) => {
			const p = record(item);
			const view = record(p.view);
			return [line(p.handle), documentIdentity(view), line(view.title)].filter(Boolean).join(" · ");
		})
		.filter(Boolean)
		.join("\n");
	const connected = count ? `${count} connected ${count === 1 ? "pane" : "panes"}` : "No connected panes";
	return {
		outcome: `${connected}${pending ? `; ${units(pending, "outstanding launch")}` : ""}.`,
		preview,
		more: count || pending ? receipt(v) : "",
	};
}
function liveRead(v: Fields, args: Fields): Copy {
	const next = nextLivePage(v, args);
	const view = record(record(v.pane).view);
	const draft = view.conflict === true ? "; autosave conflict" : view.dirty === true ? "; unsaved" : "";
	const complete = v.status === "complete";
	const where = [fact("generation", v.generation), complete ? "" : fact("offset", v.offset)]
		.filter(Boolean)
		.join(" · ");
	const continuation = number(v.nextOffset) !== undefined ? "; more follows" : complete ? "" : "; no continuation";
	return {
		outcome: `Read ${complete ? "complete live source" : "live fragment"}${where ? ` at ${where}` : ""}${draft}${continuation}.`,
		more: [string(complete ? v.source : v.fragment), receipt(v, "source", "fragment")].filter(Boolean).join("\n\n"),
		continuation: next ? { op: "read", ...next, baseGeneration: v.generation, baseDigest: v.digest } : undefined,
	};
}
function liveComments(v: Fields, args: Fields): Copy {
	const next = nextLivePage(v, args);
	const state = line(v.commentState);
	const n = Array.isArray(v.comments) ? v.comments.length : undefined;
	const total = [number(v.total), state].filter((item) => item !== "" && item !== undefined).join(" ");
	const scope = n === undefined ? "Comment page" : `Read ${units(n, "comment")}${total ? ` of ${total}` : ""}`;
	return {
		outcome: page(scope, v),
		more: receipt(v),
		continuation:
			next && state ? { op: "comments", ...next, commentState: state, expectedVersion: v.version } : undefined,
	};
}
function liveCopy(v: Fields, args: Fields): Copy | undefined {
	switch (v.status) {
		case "ok":
			return liveList(v);
		case "navigated":
			return { outcome: `Reader confirmed ${documentIdentity(record(v.view))}.`, more: receipt(v) };
		case "launch":
			return { outcome: `Launch offered for ${documentIdentity(v)}; display unconfirmed.`, more: receipt(v) };
		case "pending":
			return { outcome: "Reader launch outstanding; display unconfirmed.", more: receipt(v) };
		case "complete":
		case "page":
			return liveRead(v, args);
		case "comments":
			return liveComments(v, args);
		case "commentSet":
			return { outcome: `Comment ${line(v.commentState)}.`, more: receipt(v) };
		case "applied":
			return liveApplied(v);
		case "claimed":
			return { outcome: "Claimed the passage.", more: receipt(v, "status") };
		case "released":
			return { outcome: "Released the claim.", more: receipt(v, "status") };
		case "stale":
		case "busy":
		case "closed":
		case "uncertain":
		case "error":
			return {
				outcome: line(v.message) || "The live operation did not complete.",
				more: receipt(v, "status", "message"),
			};
	}
}
function liveApplied(v: Fields): Copy {
	const generation = fact("generation", v.generation);
	return {
		outcome: `Applied to the live buffer${generation ? ` at ${generation}` : ""}${v.retained === true ? "; private recovery retained" : ""}.`,
		more: receipt(v, "status", "generation", "retained"),
	};
}
function findCoverage(v: Fields): string {
	return [
		v.bounded === true ? "scan stopped early" : "",
		number(v.unreadable) ? `${v.unreadable} unreadable` : "",
		record(v.search).complete === false ? "source search incomplete" : "",
	]
		.filter(Boolean)
		.join(" · ");
}
function findNext(v: Fields): Fields | undefined {
	if (typeof v.nextCursor !== "string" || !v.nextCursor) return;
	return { kind: v.kind, query: v.query, contains: record(v.search).contains, cursor: v.nextCursor };
}
function readFind(v: Fields, matches: unknown[]): Copy {
	const continuation = findNext(v);
	const scanned = number(v.scanned);
	const outcome = matches.length ? `Returned ${units(matches.length, "match")}` : "No matches in this page";
	const scope = scanned === undefined ? "" : `; scanned ${units(scanned, "document")}`;
	const coverage = findCoverage(v);
	const preview = matches
		.map((item) => {
			const row = record(item);
			return [documentIdentity({ documentId: row.id, revision: row.revision }), line(row.title)]
				.filter(Boolean)
				.join(" · ");
		})
		.filter(Boolean)
		.join("\n");
	return {
		outcome: `${outcome}${scope}${coverage ? `; ${coverage}` : ""}${continuation ? "; more results follow" : ""}.`,
		preview,
		more: matches.length ? json(matches, 2) : "",
		continuation,
	};
}
function readCopy(v: Fields, text: string[]): Copy | undefined {
	if (v.op === "find" && Array.isArray(v.rows)) return readFind(v, v.rows);
	if (v.op !== "read" || !line(v.documentId)) return;
	const offset = number(v.nextOffset);
	const identity = documentIdentity(v);
	return {
		outcome: v.status === "page" ? page(`Read a fragment of ${identity}`, v) : `Read complete source for ${identity}.`,
		preview: text.length > 1 ? text.slice(1).join("\n") : string(v.status === "page" ? v.fragment : v.text),
		more: text[0],
		continuation: offset === undefined ? undefined : { document: v.documentId, revision: v.revision, offset },
	};
}
function paneObservation(panes: Fields): string {
	if (panes.status !== "observed") return "reader state not observed";
	return Array.isArray(panes.showing) && panes.showing.length
		? "a reader reported this revision"
		: "no reader confirmed this revision";
}
function publishCopy(v: Fields, text: string[]): Copy | undefined {
	if (v.ok !== true || !line(v.documentId)) return;
	const panes = record(v.paneState);
	const observation = paneObservation(panes);
	return {
		outcome: `${v.replayed ? "Already saved" : "Saved"} ${documentIdentity(v)}; ${observation}.`,
		more: text.join("\n"),
	};
}
function copy(name: Name, value: Fields, args: Fields, text: string[]): Copy | undefined {
	const error = line(record(value.error).message);
	const retained = text.join("\n");
	if (value.ok === false && error) return { outcome: error, more: retained === error ? "" : retained };
	switch (name) {
		case "markdown_brief":
			return typeof value.reader === "string" && Array.isArray(value.checks)
				? { outcome: "Prepared the writing brief.", more: retained }
				: undefined;
		case "markdown_publish":
			return publishCopy(value, text);
		case "markdown_read":
			return readCopy(value, text);
		case "markdown_live":
			return liveCopy(value, args);
	}
}

function detail(name: Name, output: AgentToolResult<unknown>): Fields {
	const value = record(output.details);
	const block = output.content[0];
	if (Object.keys(value).length || name !== "markdown_live" || output.content.length !== 1 || block?.type !== "text")
		return value;
	try {
		return record(JSON.parse(block.text));
	} catch {
		return value;
	}
}
// Pi's validation diagnostics can echo the complete submitted arguments, even in their first line.
function bareArgumentDiagnostic(name: Name, value: Fields, text: string, failed: boolean): boolean {
	if (!failed || Object.keys(value).length) return false;
	return [`Invalid arguments for tool "${name}":`, `Validation failed for tool "${name}":`].some((prefix) =>
		text.trimStart().startsWith(prefix),
	);
}
function firstResultLine(text: string, validationFailed: boolean): string | undefined {
	if (validationFailed) return "The tool arguments did not pass validation.";
	return text.split("\n").find((row) => row.trim());
}
function extraResult(presentation: Copy | undefined, retained: string, outcome: string): string {
	if (presentation) return presentation.more ?? "";
	return retained === outcome ? "" : retained;
}
function resultView(name: Name, output: AgentToolResult<unknown>, state: State, partial: boolean, failed: boolean) {
	const text = output.content.flatMap((part) => (part.type === "text" ? [safe(part.text)] : []));
	const value = detail(name, output);
	state.hideCallBody = bareArgumentDiagnostic(name, value, text[0] ?? "", failed);
	const diagnostic = line(record(value.error).message) || line(value.message);
	const presentation = partial || (failed && !diagnostic) ? undefined : copy(name, value, state.args ?? {}, text);
	const retained = text.join("\n");
	const first = firstResultLine(retained, state.hideCallBody);
	const outcome = partial
		? "Working…"
		: presentation?.outcome || line(first) || (failed ? "The operation failed." : "No result text returned.");
	return {
		summary: bounded(outcome),
		preview: bounded(safe(presentation?.preview ?? "")),
		more: bounded(safe(extraResult(presentation, retained, outcome))),
		next: presentation?.continuation ? `Continue with ${name} ${json(presentation.continuation)}` : "",
	};
}
type ResultView = ReturnType<typeof resultView>;
function finalDisclosure(
	name: Name,
	state: State,
	view: ResultView,
	skipped: number,
	theme: Theme,
	context: Context,
	width: number,
): string[] {
	const call = state.call ? discloseCall(name, state.call, width, state.hideCallBody) : { more: false, count: 0 };
	const other = call.more || !!view.more.text || !!view.next || visibleWidth(view.summary.text) > width;
	if (!other && !call.count && !skipped) return [];
	if (skipped && !call.count) return [hint(theme, context, width, skipped)];
	return [hint(theme, context, width, other || skipped ? 0 : call.count)];
}
function expandedResult(view: ResultView, theme: Theme, width: number): string[] {
	return [view.more.text, view.next]
		.filter(Boolean)
		.flatMap((body) => ["", ...colored(body, theme, "toolOutput", width)]);
}
function result(name: Name): Result {
	return (output, options, theme, context) => {
		const state = cardState(context);
		state.result = true;
		const expanded = options.expanded;
		const color = options.isPartial ? "muted" : context.isError ? "error" : "toolOutput";
		const view = resultView(name, output, state, options.isPartial, context.isError);
		return atWidth((width) => {
			const outcome = view.summary.text;
			const shown = expanded ? colored(outcome, theme, color, width) : [clip(theme.fg(color, outcome), width)];
			const preview = rows(view.preview.text, width, expanded ? Infinity : PREVIEW_ROWS);
			const out = ["", ...shown, ...preview.visualLines.map((row) => theme.fg("toolOutput", row))];
			if (expanded) out.push(...expandedResult(view, theme, width));
			out.push(...limits(theme, width, view.summary.limit, view.preview.limit, expanded ? view.more.limit : ""));
			if (!expanded) out.push(...finalDisclosure(name, state, view, preview.skippedCount, theme, context, width));
			return out;
		});
	};
}

const cards = names.map((name) => ({ name, renderCall: call(name), renderResult: result(name) }));
export function toolDisplay(): { version: 1; tools: Card[] } {
	return { version: 1, tools: cards.map((card) => ({ ...card })) };
}
