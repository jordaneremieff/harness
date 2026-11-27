import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

type Call = NonNullable<ToolDefinition["renderCall"]>;
type Result = NonNullable<ToolDefinition["renderResult"]>;
type Fields = Record<string, unknown>;
const expand = "app.tools.expand";
const record = (value: unknown): Fields =>
	value && typeof value === "object" && !Array.isArray(value) ? (value as Fields) : {};
const clean = (text: string) =>
	stripTerminalSequences(text).replace(/[\p{Cc}\p{Cf}]/gu, (char) => (char === "\n" || char === "\t" ? char : ""));
const line = (value: unknown) => (typeof value === "string" ? clean(value).replace(/\s+/gu, " ").trim() : "");
const clip = (text: string, width: number) =>
	truncateToWidth(text, width, "…").replace(/\x1b\[0m…\x1b\[0m$/u, "…\x1b[22;23;24;25;27;28;29;39m");
const number = (value: unknown) =>
	typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
const count = (n: number, noun: string, plural = `${noun}s`) => `${n} ${n === 1 ? noun : plural}`;
function callSubject(args: Fields): string {
	return [
		line(args.op),
		line(args.doc) || line(args.path) || line(args.id) || line(args.title) || line(record(args.target).key),
	]
		.filter(Boolean)
		.join(" ");
}

const privateFields = new Set(["text", "message", "find", "replace", "query", "replacement", "blocks"]);
function callDetails(args: Fields): string[] {
	return Object.entries(args).flatMap(([key, value]) => {
		if (key === "op" || value === undefined) return [];
		const text = privateFields.has(key)
			? typeof value === "string"
				? count(value.length, "UTF-16 unit")
				: Array.isArray(value)
					? count(value.length, "block")
					: ""
			: line(JSON.stringify(value));
		return text ? [`  ${line(key)}: ${text}`] : [];
	});
}

const renderCall: Call = (value, theme, context) => {
	const args = record(value);
	const subject = callSubject(args);
	const title = theme.fg("toolTitle", theme.bold("editor")) + (subject ? ` ${theme.fg("accent", subject)}` : "");
	const extra = callDetails(args);
	context.state.hasEditorResult = false;
	return {
		invalidate() {},
		render(width) {
			if (width < 1) return [];
			if (context.expanded)
				return [
					...wrapTextWithAnsi(title, width),
					...extra.flatMap((row) => wrapTextWithAnsi(row, width).map((part) => theme.fg("muted", part))),
				];
			const rows = [clip(title, width)];
			if (!context.state.hasEditorResult && (extra.length || visibleWidth(title) > width) && context.keyText(expand))
				rows.push(
					clip(theme.fg("muted", "... (") + context.keyHint(expand, "to expand") + theme.fg("muted", ")"), width),
				);
			return rows;
		},
	};
};

function page(data: Fields, field: string, noun: string, plural?: string): string | undefined {
	const items = data[field];
	if (!Array.isArray(items)) return undefined;
	const lead = items.length ? `Found ${count(items.length, noun, plural)}` : `No ${plural ?? `${noun}s`} found`;
	const scope =
		data.limited === true ? "; partial scan" : number(data.next) !== undefined ? "; more entries follow" : "";
	return `${lead}${scope}.`;
}

function revision(data: Fields): string {
	const rev = number(data.rev);
	return rev === undefined ? "" : ` (revision ${rev})`;
}
const hasDraft = (data: Fields) => typeof data.doc === "string" && number(data.rev) !== undefined;

function workspaceOutcome(data: Fields): string | undefined {
	const total = number(data.total);
	if (total === undefined) return undefined;
	return `Workspace has ${count(total, "draft, view or thread", "drafts, views and threads total")}${number(data.nextOffset) === undefined ? "" : "; more rows follow"}.`;
}

function gitOutcome(data: Fields, args: Fields): string | undefined {
	if (args.base === true) {
		if (data.limited === true) return "HEAD text exceeded the result limit.";
		return typeof data.text === "string" ? "Read the file at HEAD." : undefined;
	}
	if (!Array.isArray(data.files)) return undefined;
	const lead = data.files.length ? `Reported ${count(data.files.length, "changed file")}` : "No changed files";
	return `${lead}${data.limited === true ? "; result bounded" : ""}.`;
}

function readOutcome(data: Fields): string | undefined {
	if (data.unchanged === true) return `Draft unchanged${revision(data)}.`;
	if (typeof data.text !== "string") return undefined;
	const kind = data.dirty === true ? "unsaved draft" : "draft";
	const more = number(data.nextOffset) === undefined ? "" : "; more text follows";
	return `Read ${kind}${revision(data)}${more}.`;
}

function editOutcome(data: Fields, args: Fields): string | undefined {
	if (!hasDraft(data)) return undefined;
	return data.rev === args.rev
		? `Draft unchanged${revision(data)}.`
		: `Updated the draft${revision(data)}; nothing saved to disk.`;
}

function replaceOutcome(data: Fields): string | undefined {
	if (!Array.isArray(data.changed)) return undefined;
	const lead = data.changed.length
		? `Updated ${count(data.changed.length, "draft")}; nothing saved to disk`
		: "No drafts changed";
	const skipped = Array.isArray(data.skipped) && data.skipped.length ? `; ${data.skipped.length} skipped` : "";
	return `${lead}${skipped}${data.limited === true ? "; partial scan" : ""}.`;
}

const summaries: Record<string, (data: Fields, args: Fields) => string | undefined> = {
	join: (data) => (typeof data.folder === "string" ? `Joined ${line(data.folder)}.` : undefined),
	state: workspaceOutcome,
	members: (data) => page(data, "members", "participant"),
	tree: (data) => page(data, "entries", "entry", "entries"),
	files: (data) => page(data, "files", "file"),
	search: (data) => page(data, "hits", "match", "matches"),
	git: gitOutcome,
	read: readOutcome,
	new: (data) => (hasDraft(data) ? `Created a draft${revision(data)}; nothing saved to disk.` : undefined),
	edit: editOutcome,
	patch: editOutcome,
	save: (data) =>
		hasDraft(data) && data.dirty === false ? `Draft matches the saved file${revision(data)}.` : undefined,
	revert: (data, args) => {
		if (data.discarded === true) return "Discarded the draft.";
		if (!hasDraft(data)) return undefined;
		return data.rev === args.rev
			? `Draft matches disk${revision(data)}.`
			: `Restored the draft from disk${revision(data)}.`;
	},
	replace: replaceOutcome,
	show: (data) => {
		const panes = number(data.panes);
		return panes === undefined ? undefined : `Sent the reveal request to ${count(panes, "Editor pane")}.`;
	},
	note: (data) => (typeof data.id === "string" ? "Created a note thread." : undefined),
	reply: (data) => (typeof data.id === "string" ? "Added a reply." : undefined),
	thread: (data) => (typeof data.id === "string" || Array.isArray(data.messages) ? "Read the thread." : undefined),
	compose: (data, args) =>
		typeof data.id === "string" ? `${args.id ? "Updated" : "Created"} the composed view${revision(data)}.` : undefined,
	view: (data) => (typeof data.id === "string" ? `Read the composed view${revision(data)}.` : undefined),
};

function summary(args: Fields, data: Fields): string | undefined {
	return typeof args.op === "string" && Object.hasOwn(summaries, args.op) ? summaries[args.op](data, args) : undefined;
}

function resultData(raw: string, structured: unknown): Fields {
	if (structured !== undefined) return record(structured);
	if (!raw.startsWith("{")) return {};
	try {
		return record(JSON.parse(raw));
	} catch {
		return {};
	}
}

const renderResult: Result = (result, options, theme, context) => {
	context.state.hasEditorResult = true;
	const args = record(context.args);
	const raw = clean(result.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n")).trim();
	const data = resultData(raw, result.structuredContent);
	const structured = Object.keys(data).length > 0;
	const diagnostic = line(raw.split("\n", 1)[0]);
	const withheld = Object.keys(args).some((key) => privateFields.has(key));
	const outcome = options.isPartial
		? "Editor request in progress…"
		: context.isError
			? (!withheld && diagnostic) || "The Editor request failed."
			: (summary(args, data) ?? ((!structured && diagnostic) || "Editor returned result details."));
	const color = options.isPartial ? "muted" : context.isError ? "error" : "toolOutput";
	const remainder =
		options.isPartial || raw === outcome ? "" : raw.startsWith(`${outcome}\n`) ? raw.slice(outcome.length + 1) : raw;
	const extra = callDetails(args);
	return {
		invalidate() {},
		render(width) {
			if (width < 1) return [];
			if (options.expanded) {
				const body = !context.isError && structured ? clean(JSON.stringify(data, null, 2)) : remainder;
				return [
					"",
					...wrapTextWithAnsi([outcome, body].filter(Boolean).join("\n"), width).map((row) => theme.fg(color, row)),
				];
			}
			const rows = ["", theme.fg(color, clip(outcome, width))];
			if (
				remainder ||
				(structured && !options.isPartial && !context.isError) ||
				extra.length ||
				visibleWidth(`editor ${callSubject(args)}`) > width ||
				visibleWidth(outcome) > width
			) {
				const action = context.keyText(expand)
					? context.keyHint(expand, "to expand")
					: theme.fg("muted", "click to expand");
				rows.push(clip(theme.fg("muted", "... (") + action + theme.fg("muted", ")"), width));
			}
			return rows;
		},
	};
};

export function toolDisplay(): { version: 1; tools: Pick<ToolDefinition, "name" | "renderCall" | "renderResult">[] } {
	return { version: 1, tools: [{ name: "editor", renderCall, renderResult }] };
}
