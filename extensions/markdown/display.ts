import type { AgentToolResult, Theme, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text, type Component } from "@earendil-works/pi-tui";

type Publication = {
	version: 1;
	tools: Array<Pick<ToolDefinition, "name" | "renderCall" | "renderResult" | "renderShell">>;
};
type Call = NonNullable<ToolDefinition["renderCall"]>;
type Result = NonNullable<ToolDefinition["renderResult"]>;
type ToolName = "markdown_publish" | "markdown_read" | "markdown_live";
const DISPLAY_LIMIT = 32_000;
function record(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
function string(value: unknown): string {
	return typeof value === "string" ? value : "";
}
function number(value: unknown): number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}
function prefix(value: string, limit: number): string {
	let end = Math.min(value.length, limit);
	if (/[\uD800-\uDBFF]/u.test(value[end - 1] ?? "")) end--;
	return value.slice(0, end);
}
function escaped(value: string): string {
	return value.replace(/[\p{Cc}\p{Cf}]/gu, (char) =>
		char === "\n" ? char : char === "\t" ? "\\t" : `\\u{${char.codePointAt(0)?.toString(16)}}`,
	);
}
function row(value: string): string {
	return escaped(prefix(value, 240)).replace(/\s+/gu, " ").trim();
}
function body(value: string): string {
	const safe = escaped(prefix(value, DISPLAY_LIMIT));
	return (
		prefix(safe, DISPLAY_LIMIT) +
		(safe.length > DISPLAY_LIMIT || value.length > DISPLAY_LIMIT
			? "\n[Display limit. Full content remains in tool history.]"
			: "")
	);
}
function json(value: unknown): string {
	try {
		return JSON.stringify(value, null, 2) ?? "";
	} catch {
		return "Details unavailable.";
	}
}
function component(value: string, previous?: Component): Text {
	const text = previous instanceof Text ? previous : new Text("", 0, 0);
	text.setText(value);
	return text;
}
function hint(context: Parameters<Call>[2], subject: string): string {
	const key = context.keyText?.("app.tools.expand");
	return key ? `${key} to expand ${subject}` : `Expand for ${subject}`;
}
function retained(result: AgentToolResult<unknown>): string {
	let text = "";
	for (const block of result.content) {
		if (block.type === "text") text += prefix(block.text, DISPLAY_LIMIT - text.length);
		if (text.length >= DISPLAY_LIMIT) break;
	}
	return text;
}
function details(result: AgentToolResult<unknown>): Record<string, unknown> {
	if (Object.keys(record(result.details)).length) return record(result.details);
	try {
		return record(JSON.parse(retained(result)));
	} catch {
		return {};
	}
}
function subject(name: ToolName, args: Record<string, unknown>): string {
	if (name === "markdown_publish")
		return (
			string(args.title) ||
			string(args.file) ||
			(args.response === "previous" ? "previous response" : string(args.document))
		);
	if (name === "markdown_live") return `${string(args.op)}${args.handle ? ` ${string(args.handle)}` : ""}`;
	if (args.document)
		return `${string(args.document)}${args.revision === undefined ? "" : ` · revision ${number(args.revision)}`}`;
	return `find ${string(args.kind) || "published"}${args.query ? ` · ${string(args.query)}` : ""}`;
}
function call(name: ToolName): Call {
	return (args, theme, context) => {
		const input = record(args),
			selected = row(subject(name, input));
		const heading = theme.fg("toolTitle", theme.bold(name)) + (selected ? theme.fg("accent", ` · ${selected}`) : "");
		const qualifier = context.expanded
			? theme.fg("toolOutput", body(json(input)))
			: theme.fg("dim", `${context.argsComplete === false ? "Arguments pending · " : ""}${hint(context, "arguments")}`);
		return component(`${heading}\n${qualifier}`, context.lastComponent);
	};
}
function publishedSummary(value: Record<string, unknown>): string {
	return value.ok === true
		? `${value.replayed ? "Already saved" : "Saved"} ${string(value.documentId)} · revision ${number(value.revision)} · ${number(value.bytes)} bytes`
		: "Publication result available";
}
function storedSummary(value: Record<string, unknown>): string {
	if (value.op === "find")
		return `${number(value.matched)} matched · ${number(value.scanned)} scanned${value.bounded === true ? " · scan bounded" : ""}${number(value.unreadable) ? ` · ${number(value.unreadable)} unreadable` : ""}`;
	if (value.op === "read")
		return `Read ${string(value.documentId)} · revision ${number(value.revision)} of ${number(value.currentRevision)} · offset ${number(value.offset)}`;
	return "Read result available";
}
function liveSummary(value: Record<string, unknown>): string {
	if (Array.isArray(value.panes))
		return `${value.panes.length} connected ${value.panes.length === 1 ? "pane" : "panes"}`;
	if (value.status === "ok")
		return `Read live source · generation ${number(value.generation)} · offset ${number(value.offset)}${typeof value.nextOffset === "number" ? ` · next ${value.nextOffset}` : ""}`;
	if (value.status === "applied")
		return `Applied · generation ${number(value.generation)}${value.retained === true ? " · recovery retained" : ""}`;
	return typeof value.status === "string" ? `${value.status}: ${string(value.message)}` : "Live result available";
}
const summaries = { markdown_publish: publishedSummary, markdown_read: storedSummary, markdown_live: liveSummary };
function result(name: ToolName): Result {
	return (output, options, theme: Theme, context) => {
		const value = details(output);
		const failed = context.isError || value.ok === false || value.status === "error";
		const warning = ["stale", "busy", "closed", "uncertain"].includes(string(value.status));
		const message = failed
			? string(record(value.error).message) ||
				string(value.message) ||
				retained(output).split("\n", 1)[0] ||
				"Operation failed"
			: summaries[name](value);
		const heading = theme.fg(failed ? "error" : warning ? "warning" : "muted", row(message));
		const evidence = options.expanded
			? theme.fg("toolOutput", body(Object.keys(value).length ? json(value) : retained(output)))
			: theme.fg("dim", hint(context, "result"));
		return component(`\n${heading}\n${evidence}`, context.lastComponent);
	};
}
const cards = (["markdown_publish", "markdown_read", "markdown_live"] as const).map((name) => ({
	name,
	renderCall: call(name),
	renderResult: result(name),
}));
export function toolDisplay(): Publication {
	return { version: 1, tools: cards.map((card) => ({ ...card })) };
}
