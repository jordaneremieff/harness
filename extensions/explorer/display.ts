import { homedir } from "node:os";
import { type Theme, type ToolDefinition, truncateToVisualLines } from "@earendil-works/pi-coding-agent";
import { type Component, stripTerminalSequences, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { isRecord } from "./live-protocol.ts";

type Card = Pick<ToolDefinition, "name" | "renderCall" | "renderResult">;
type CardContext = Parameters<NonNullable<ToolDefinition["renderCall"]>>[2];
const EXPAND = "app.tools.expand";
const DISPLAY_LIMIT = 32_000;
const PREVIEW_LINES = 5;

const record = (value: unknown) => (isRecord(value) ? value : {});
const array = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const string = (value: unknown) => (typeof value === "string" ? value : "");
const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;
const safe = (value: string) =>
	stripTerminalSequences(value).replace(/[\p{Cc}\p{Cf}\ud800-\udfff]/gu, (c) => (c === "\n" || c === "\t" ? c : ""));
const bodyText = (value: unknown) => safe(string(value)).replaceAll("\t", "   ");
const line = (value: unknown) => safe(string(value)).replace(/\s+/gu, " ").trim();
const firstLine = (value: string) => value.split("\n").map(line).find(Boolean) ?? "";

function receipt(details: unknown, content: string) {
	const retained = record(details);
	if (typeof retained.ok === "boolean" && typeof retained.op === "string") return retained;
	if (content.startsWith("{")) {
		try {
			const parsed = record(JSON.parse(content));
			if (typeof parsed.ok === "boolean" && typeof parsed.op === "string" && typeof parsed.summary === "string")
				return { ...retained, ...parsed };
		} catch {
			// A host result can instead be plain diagnostic text or a bounded excerpt.
		}
	}
	return retained;
}
const clip = (value: string, width: number) => stripTerminalSequences(truncateToWidth(value, width, "…"));

function pathLine(value: unknown) {
	const path = string(value);
	const home = homedir();
	return line(path === home || path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path);
}

function range(start: unknown, end: unknown) {
	return typeof start === "number" ? `:${start}${typeof end === "number" && end !== start ? `-${end}` : ""}` : "";
}

function review(value: unknown): string {
	const { scope, kind, commit, range, base, head } = record(value);
	return line(scope ?? range ?? commit) || (kind === "range" ? `${line(base)}..${line(head)}` : line(kind));
}

function bound(text: string) {
	if (text.length <= DISPLAY_LIMIT) return { text };
	const end = /[\ud800-\udbff]/u.test(text[DISPLAY_LIMIT - 1]) ? DISPLAY_LIMIT - 1 : DISPLAY_LIMIT;
	return {
		text: text.slice(0, end),
		limit: `[Truncated: showing ${end} of ${text.length} characters]`,
	};
}

function component(draw: (width: number) => string[]): Component {
	let cached: { width: number; rows: string[] } | undefined;
	return {
		render(width) {
			if (width < 1) return [];
			if (cached?.width !== width) cached = { width, rows: draw(width) };
			return cached.rows;
		},
		invalidate() {
			cached = undefined;
		},
	};
}

function hint(theme: Theme, ctx: CardContext, width: number, hidden: number) {
	const prefix = hidden ? `... (${hidden} more lines, ` : "... (";
	const key = ctx.keyText(EXPAND);
	const text = `${prefix}${key ? `${key} to expand` : "click to expand"})`;
	return !key || visibleWidth(text) > width
		? theme.fg("muted", clip(text, width))
		: theme.fg("muted", prefix) + ctx.keyHint(EXPAND, "to expand") + theme.fg("muted", ")");
}

function heading(theme: Theme, width: number, name: string, subject: string, suffix: string) {
	const title = theme.fg("toolTitle", theme.bold(clip(name, width)));
	const room = width - visibleWidth(name) - 1;
	if (!subject) return title;
	if (room < 1) return theme.fg("toolTitle", theme.bold(clip(`${name} ${subject}`, width)));
	return visibleWidth(subject + suffix) <= room
		? `${title} ${theme.fg("accent", subject)}${theme.fg("muted", suffix)}`
		: `${title} ${theme.fg("accent", clip(subject + suffix, room))}`;
}

function field(key: string, value: unknown): string {
	const text = typeof value === "string" ? bodyText(value) : safe(JSON.stringify(value, null, 2) ?? "");
	return `  ${key}: ${text.replaceAll("\n", "\n    ")}`;
}

function fields(value: Record<string, unknown>) {
	return Object.entries(value)
		.filter(([, datum]) => datum !== undefined)
		.map(([key, datum]) => field(line(key), datum))
		.join("\n");
}

function callParts(name: string, args: Record<string, unknown>) {
	const path = pathLine(args.path);
	const root = pathLine(args.root);
	const reviewRef = review(args.review);
	if (name === "explorer_show") {
		const note = record(args.note);
		return {
			subject: path || (reviewRef ? `Review ${reviewRef}` : "Working directory"),
			suffix: range(args.line, args.endLine),
			facts: [path && reviewRef && `review ${reviewRef}`, line(note.title)].filter(Boolean),
			body: bodyText(note.text),
			hidden:
				Object.keys(args).some((key) => !["path", "line", "endLine", "review", "note"].includes(key)) ||
				Object.keys(note).some((key) => key !== "title" && key !== "text"),
		};
	}
	const op = line(args.op);
	const ids = array(args.ids).map(line).filter(Boolean);
	const notes = array(args.notes);
	const comments = array(args.comments);
	const targets = [path, line(args.id), ids.join(", "), line(args.title), root].filter(Boolean);
	const [main, ...others] = targets;
	return {
		subject: [op, main].filter(Boolean).join(" "),
		suffix: range(args.start, args.end),
		facts: [
			...others,
			reviewRef && `review ${reviewRef}`,
			line(args.state),
			notes.length && count(notes.length, "note"),
			comments.length && count(comments.length, "comment"),
		].filter(Boolean),
		body: bodyText(args.text),
		hidden:
			notes.length > 0 ||
			Object.keys(args).some(
				(key) =>
					![
						"op",
						"path",
						"id",
						"ids",
						"title",
						"root",
						"start",
						"end",
						"side",
						"review",
						"state",
						"notes",
						"target",
						"text",
						"url",
						"expectedUpdatedAt",
					].includes(key),
			),
	};
}

function noteLocation(note: Record<string, unknown>) {
	const target = record(note.target);
	const where =
		target.kind === "file"
			? `${pathLine(target.path)}${line(target.side) ? ` (${line(target.side)})` : ""}`
			: target.kind === "commit"
				? `commit ${line(target.commit)}`
				: target.kind === "review"
					? `review ${review(target.review)}`
					: `${pathLine(note.path)}${range(note.start, note.end)}`;
	return [line(note.id), where, line(note.state), line(note.by)].filter(Boolean).join(" · ");
}

type Readout = {
	outcome: string;
	body?: string;
	expanded?: string;
	replacesBody?: boolean;
	facts?: string[];
	limits?: string[];
	warning?: boolean;
};

function showReadout(d: Record<string, unknown>): Readout {
	const target = record(d.target);
	const location = `${pathLine(target.path) || pathLine(target.root)}${range(target.line, target.end)}`;
	const unavailable = line(d.showUnavailable);
	const note = line(d.noteId);
	const summary = firstLine(bodyText(d.summary));
	let outcome = summary;
	if (d.moved === true) outcome = "The connected Explorer pane confirmed navigation.";
	else if (Array.isArray(d.show)) outcome = "Explorer prepared a pane command. No pane opened.";
	else if (unavailable) outcome = "Explorer did not prepare a pane command. No pane opened.";
	return {
		outcome,
		warning: Boolean(unavailable),
		facts: [
			unavailable && summary !== unavailable ? summary : "",
			unavailable,
			note ? `Saved note ${note}.` : "",
		].filter(Boolean),
		expanded: fields({
			location: location || undefined,
			root: target.path ? target.root : undefined,
			review: review(target.review) || undefined,
			view: target.view,
			"navigation status": d.navigation,
			"Launch argv": d.show,
			"Pane input": typeof d.paneInput === "string" ? JSON.stringify(d.paneInput) : undefined,
			"Build command": d.build,
			"Error code": record(d.error).code,
		}),
	};
}

function noteReadout(note: Record<string, unknown>, outcome: string, reading: boolean): Readout {
	const { text, textTruncated, quoteTruncated, threadOmitted, ...retained } = note;
	const omitted = typeof threadOmitted === "number" ? threadOmitted : 0;
	const limits = [
		textTruncated === true && "[Excerpt: note text limited to 4096 characters]",
		quoteTruncated === true && "[Excerpt: source quote limited to 8192 characters]",
		omitted > 0 && `[Excerpt: ${omitted} earlier ${omitted === 1 ? "reply" : "replies"} omitted]`,
		array(note.thread).some((reply) => record(reply).truncated === true) &&
			"[Excerpt: some replies limited to 512 characters each]",
	].filter((notice): notice is string => typeof notice === "string");
	return reading
		? { outcome, body: bodyText(text), expanded: fields(retained), limits }
		: { outcome, expanded: fields({ text, ...retained }), limits };
}

function listReadout(d: Record<string, unknown>): Readout {
	const notes = array(d.notes).map(record);
	const body = notes.map(noteLocation).join("\n");
	const totals = notes.length && count(notes.length, "note");
	const unreadable =
		typeof d.unreadable === "number" && d.unreadable > 0 ? ` · ${count(d.unreadable, "unreadable record")}` : "";
	const limited = d.limited === true;
	const listing = totals ? `Returned ${totals}` : "No notes were returned";
	const partialListing = totals ? `The partial list contains ${totals}` : "The partial list is empty";
	return {
		outcome: limited ? `${partialListing}${unreadable}; no continuation cursor.` : `${listing}${unreadable}.`,
		warning: limited || Boolean(unreadable),
		body,
		replacesBody: true,
		expanded: notes.map(fields).filter(Boolean).join("\n\n"),
		limits: notes.length ? ["[Excerpt: each note preview retains up to 256 characters]"] : [],
	};
}

function importedReadout(d: Record<string, unknown>): Readout {
	const notes = array(d.notes);
	const skipped = array(d.skipped);
	const changed = [
		typeof d.created === "number" && d.created > 0 && `${d.created} created`,
		typeof d.updated === "number" && d.updated > 0 && `${d.updated} updated`,
		skipped.length && `${skipped.length} skipped`,
	]
		.filter(Boolean)
		.join(" · ");
	return {
		outcome: changed ? `Import: ${changed}.` : "No remote comments imported.",
		warning: skipped.length > 0,
		expanded: fields({
			notes: notes.length ? notes : undefined,
			skipped: skipped.length ? skipped : undefined,
		}),
	};
}

function exportedReadout(d: Record<string, unknown>): Readout {
	const notes = array(d.notes).map(record);
	const outside = notes.filter(({ position }) => record(position).inDiff === false).length;
	const unplaced = notes.filter(({ position }) => position === null).length;
	return {
		outcome: notes.length ? `Exported ${count(notes.length, "operator note")}.` : "No operator notes to export.",
		facts: [
			line(record(d.review).label),
			outside && `${outside} outside the diff`,
			unplaced && `${unplaced} without a position`,
		].filter((fact): fact is string => typeof fact === "string" && !!fact),
		warning: outside > 0 || unplaced > 0,
		body: notes.map(noteLocation).join("\n"),
		replacesBody: true,
		expanded: [field("review", d.review), ...notes.map(fields)].join("\n\n"),
	};
}

function notesReadout(d: Record<string, unknown>): Readout {
	const outcome = firstLine(bodyText(d.summary));
	if (d.ok !== true) return { outcome, expanded: fields({ "Error code": record(d.error).code }) };
	switch (d.op) {
		case "list":
			return listReadout(d);
		case "import":
			return importedReadout(d);
		case "export":
			return exportedReadout(d);
		case "delete": {
			const ids = array(d.ids).map(line).filter(Boolean);
			return { outcome, body: ids.join("\n"), replacesBody: true, expanded: fields({ ids }) };
		}
	}
	const note = record(d.note);
	if (typeof note.text === "string") return noteReadout(note, outcome, d.op === "read");
	return noteRowsReadout(d, outcome);
}
function noteRowsReadout(d: Record<string, unknown>, outcome: string): Readout {
	const notes = array(d.notes).map(record);
	if (d.op === "resolve" || d.op === "reopen")
		outcome = `${d.op === "resolve" ? "Resolved" : "Reopened"} ${count(notes.length, "note")}.`;
	return {
		outcome,
		body: notes.map(noteLocation).join("\n"),
		replacesBody: true,
		expanded: notes.map(fields).join("\n\n"),
	};
}

function fallbackReadout(summary: string, raw: string, error: boolean): Readout {
	// Host diagnostics can echo the original arguments, even on their first line.
	if (error)
		return {
			outcome: "The Explorer tool returned an error.",
			expanded: raw || summary,
		};
	const [head, ...tail] = (summary || raw).trimStart().split("\n");
	const outcome = line(head) || "Explorer returned no result text.";
	if (summary && raw !== summary) return { outcome, expanded: raw };
	return { outcome, body: tail.join("\n") };
}

function resultReadout(
	name: string,
	details: Record<string, unknown>,
	raw: string,
	partial: boolean,
	error: boolean,
): Readout {
	if (partial)
		return {
			outcome: name === "explorer_show" ? "Preparing the Explorer location…" : "Processing Explorer notes…",
		};
	const summary = bodyText(details.summary);
	if (typeof details.ok !== "boolean" || typeof details.op !== "string") return fallbackReadout(summary, raw, error);
	const view = name === "explorer_show" ? showReadout(details) : notesReadout(details);
	if (error) view.body = summary.trimStart().split("\n").slice(1).join("\n");
	if (typeof details.diagnosticLength === "number") {
		view.limits = [
			...(view.limits ?? []),
			`[Excerpt: first ${string(details.summary).length} of ${details.diagnosticLength} diagnostic characters retained]`,
		];
	}
	return view;
}

function resultComponent(
	view: Readout,
	theme: Theme,
	ctx: CardContext,
	expanded: boolean,
	partial: boolean,
): Component {
	const body = bound(view.body ?? "");
	const full = bound([view.replacesBody ? "" : view.body, view.expanded].filter(Boolean).join("\n\n"));
	const outcome = bound(view.outcome);
	const content = expanded ? full : body;
	const limits = [
		...new Set(
			[...(view.limits ?? []), outcome.limit, body.limit, content.limit].filter((value): value is string =>
				Boolean(value),
			),
		),
	];
	const tone = partial ? "muted" : ctx.isError ? "error" : view.warning ? "warning" : "toolOutput";
	const hidesArguments = ctx.state.hidesArguments as ((width: number) => boolean) | undefined;
	return component((width) => {
		const { visualLines, skippedCount } = truncateToVisualLines(
			content.text,
			expanded ? Infinity : PREVIEW_LINES,
			width,
			0,
			"start",
		);
		const rows = (text: string) =>
			expanded ? truncateToVisualLines(text, Infinity, width, 0, "start").visualLines : [clip(text, width)];
		const extraFacts = [outcome.text, ...(view.facts ?? []), ...limits].some((text) => visibleWidth(text) > width);
		const disclose =
			!expanded && (skippedCount > 0 || extraFacts || full.text !== body.text || hidesArguments?.(width));
		return [
			"",
			...rows(outcome.text).map((row) => theme.fg(tone, row)),
			...visualLines.map((row) => theme.fg(ctx.isError ? "error" : "toolOutput", row)),
			...(view.facts ?? []).flatMap((text) => rows(text).map((row) => theme.fg("muted", row))),
			...limits.flatMap((text) => rows(text).map((row) => theme.fg("warning", row))),
			...(disclose ? [hint(theme, ctx, width, skippedCount)] : []),
		];
	});
}

function card(name: "explorer_show" | "explorer_notes"): Card {
	return {
		name,
		renderCall(args, theme, ctx) {
			const value = record(args);
			const parts = callParts(name, value);
			const callBody = bound(parts.body);
			const content = ctx.expanded ? bound(fields(value)) : callBody;
			const facts = parts.facts.join(" · ");
			const hidesArguments = (width: number) =>
				parts.hidden ||
				Boolean(callBody.limit) ||
				(visibleWidth(`${name} ${parts.subject}${parts.suffix}`) > width &&
					Boolean(parts.subject && Object.keys(value).length)) ||
				visibleWidth(facts) > width ||
				truncateToVisualLines(callBody.text, PREVIEW_LINES, width, 0, "start").skippedCount > 0;
			ctx.state.hidesArguments = hidesArguments;
			ctx.state.hasResult = false;
			return component((width) => {
				const { visualLines, skippedCount } = truncateToVisualLines(
					content.text,
					ctx.expanded ? Infinity : PREVIEW_LINES,
					width,
					0,
					"start",
				);
				return [
					heading(theme, width, name, parts.subject, parts.suffix),
					...(facts ? [theme.fg("muted", clip(facts, width))] : []),
					...visualLines.map((row) => theme.fg(ctx.expanded ? "muted" : "toolOutput", row)),
					...(content.limit ? [theme.fg("warning", clip(content.limit, width))] : []),
					...(!ctx.expanded && !ctx.state.hasResult && ctx.keyText(EXPAND) && hidesArguments(width)
						? [hint(theme, ctx, width, skippedCount)]
						: []),
				];
			});
		},
		renderResult(result, options, theme, ctx) {
			ctx.state.hasResult = true;
			const raw = result.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
			const details = receipt(result.details, raw);
			const view = resultReadout(name, details, bodyText(raw), options.isPartial, ctx.isError);
			return resultComponent(view, theme, ctx, options.expanded, options.isPartial);
		},
	};
}

export function toolDisplay() {
	return {
		version: 1 as const,
		tools: [card("explorer_show"), card("explorer_notes")],
	};
}
