import type { AgentToolResult, Theme, ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import { keyText } from "@earendil-works/pi-coding-agent";
import { Text, type Component } from "@earendil-works/pi-tui";

type Fields = Record<string, unknown>;
type CallContext = { expanded: boolean; argsComplete: boolean; lastComponent?: Component };
type ResultContext = { isError: boolean; lastComponent?: Component };

function record(value: unknown): Fields {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Fields : {};
}
function field(value: Fields, key: string): string {
	return typeof value[key] === "string" ? value[key] : "";
}
function safe(value: string): string {
	return value.replace(/[\p{Cc}\p{Cf}]/gu, (char) => char === "\n" ? char : `\\u{${char.codePointAt(0)?.toString(16)}}`);
}
function prefix(value: string, limit: number): string {
	const end = Math.min(value.length, limit);
	return value.slice(0, end < value.length && /[\uD800-\uDBFF]/u.test(value[end - 1] ?? "") ? end - 1 : end);
}
function inline(value: string, limit = 160): string {
	const part = prefix(value, limit);
	return safe(part).replace(/\s+/gu, " ").trim() + (part.length < value.length ? "…" : "");
}
function full(value: string): string {
	const part = prefix(value, 64_000);
	return safe(part) + (part.length < value.length ? "\n[Display limit; full text remains in native tool history.]" : "");
}
function expansionHint(subject: string): string {
	const key = keyText("app.tools.expand");
	return key ? `${key} to expand ${subject}` : `Expand for ${subject}`;
}
function component(lines: string[], previous?: Component): Text {
	const text = previous instanceof Text ? previous : new Text("", 0, 0);
	text.setText(lines.join("\n"));
	return text;
}
function requested(task: Fields, defaults: Fields): string {
	const profile = field(task, "profile") || field(defaults, "profile");
	const inherited = profile ? `profile ${inline(profile, 80)} or parent` : "parent (unresolved)";
	const model = inline(field(task, "model") || field(defaults, "model"));
	const thinking = inline(field(task, "thinking") || field(defaults, "thinking"), 40);
	if (!model && !thinking) return `Requested model and thinking: ${inherited}`;
	return `Requested: ${model || inherited} · thinking ${thinking || "unresolved"}`;
}

function toolsConfiguration(input: Fields): string {
	if (!Array.isArray(input.tools)) return "tools: inherit (parent active surface)";
	return `tools: ${input.tools.length ? input.tools.filter((tool) => typeof tool === "string").map((tool) => inline(tool)).join(", ") : "submit_result only"}`;
}
function dispatchTitle(input: Fields, members: unknown[] | undefined, complete: boolean): string {
	const name = field(record(input.plan), "name");
	if (name) return `${input.dryRun === true ? "plan preview" : "plan"}: ${inline(name, 100)}`;
	if (members) return `batch: ${members.length} tasks`;
	return inline(field(input, "task")) || (complete ? "no task" : "task pending");
}
function requestLines(input: Fields, members: unknown[] | undefined, expanded: boolean, theme: Theme): string[] {
	if (!members) return [theme.fg("muted", requested(input, {}))];
	const lines: string[] = [];
	for (const [index, member] of members.slice(0, expanded ? members.length : 4).entries()) {
		const task = record(member);
		lines.push(theme.fg("toolOutput", `${index + 1}. ${inline(field(task, "purpose") || field(task, "task"), 100) || "task pending"}`));
		lines.push(theme.fg("muted", requested(task, input)));
	}
	if (!expanded && members.length > 4) lines.push(theme.fg("dim", `${members.length - 4} more tasks; expand for all requests`));
	return lines;
}

/** Arguments describe a request, never a successfully resolved worker. */
export function renderDispatchCall(args: unknown, theme: Theme, context: CallContext, expandedNotes: string): Component {
	const input = record(args);
	const plan = record(input.plan);
	const members = Array.isArray(plan.members) ? plan.members : Array.isArray(input.tasks) ? input.tasks : undefined;
	const title = dispatchTitle(input, members, context.argsComplete);
	const lines = [theme.fg("toolTitle", theme.bold("subagent")) + theme.fg("accent", ` · ${title}`), ...requestLines(input, members, context.expanded, theme)];
	if (input.dryRun === true) lines.push(theme.fg("muted", "Preview only; no workers or model calls"));
	if (context.expanded) {
		lines.push(theme.fg("muted", context.argsComplete ? "Submitted arguments" : "Arguments so far"), full(JSON.stringify(input, null, 2)), theme.fg("muted", toolsConfiguration(input)), full(expandedNotes));
	} else lines.push(theme.fg("dim", expansionHint("task and configuration")));
	return component(lines, context.lastComponent);
}

export function renderWorkerCall(name: string, args: unknown, theme: Theme, context: CallContext): Component {
	const input = record(args);
	const id = field(input, "id");
	const lines = [theme.fg("toolTitle", theme.bold(name)) + (id ? theme.fg("muted", ` · ${inline(id, 24)}`) : "")];
	if (name === "subagent_continue") lines.push(theme.fg("muted", "Model and thinking: retained session; result reports resolved values"));
	if (context.expanded) lines.push(full(JSON.stringify(input, null, 2)));
	else if (field(input, "message")) lines.push(theme.fg("toolOutput", inline(field(input, "message"))));
	return component(lines, context.lastComponent);
}

function workers(details: Fields): Fields[] {
	const plan = record(details.plan);
	if (details.dryRun === true && Array.isArray(plan.members)) return plan.members.map(record);
	if (details.worker) return [record(details.worker)];
	if (Array.isArray(details.workers)) return details.workers.map(record);
	return [...(Array.isArray(details.live) ? details.live : []), ...(Array.isArray(details.terminal) ? details.terminal : [])].map(record);
}

function thinkingLabel(worker: Fields): string {
	const thinking = field(worker, "thinking");
	const wanted = field(worker, "thinkingRequested");
	return `${inline(thinking, 40) || "unknown"}${wanted && wanted !== thinking ? ` (requested ${inline(wanted, 40)})` : ""}`;
}
function workerLines(worker: Fields, preview: boolean, expanded: boolean, theme: Theme): string[] {
	const id = field(worker, "id");
	const state = preview ? "preview" : inline(field(worker, "state"), 50) || "state unknown";
	const lines = [
		theme.fg("accent", inline(field(worker, "label") || id || "Worker", 100)) + theme.fg("muted", ` · ${state}`),
		theme.fg("muted", `${preview ? "Preflight" : "Resolved"}: ${inline(field(worker, "model"), 240) || "model unknown"} · thinking ${thinkingLabel(worker)}`),
	];
	const fallback = record(worker.modelFallback);
	if (Array.isArray(fallback.events) && fallback.events.length) lines.push(theme.fg("muted", `Fallback${fallback.exhausted === true ? " exhausted" : ""}: requested ${inline(field(fallback, "requested"), 240) || "unknown"}; expand for history`));
	if (field(worker, "error")) lines.push(theme.fg("error", inline(field(worker, "error"), 240)));
	if (expanded && id) lines.push(theme.fg("dim", `Worker ID: ${safe(id)}`));
	return lines;
}
function evidencePreview(value: string, limit: number): string {
	const part = prefix(value, limit).split("\n").slice(0, 3).join("\n");
	return safe(part) + (part.length < value.length ? "\n…" : "");
}
function resultBody(result: AgentToolResult<unknown>, options: ToolRenderResultOptions, theme: Theme, isError: boolean, entries: Fields[]): string[] {
	const hasWorkers = entries.length > 0;
	const output = result.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
	if (options.expanded) {
		const lines = [theme.fg("toolOutput", full(output))];
		if (hasWorkers) lines.push(theme.fg("dim", full(JSON.stringify(result.details, null, 2))));
		return lines;
	}
	const limit = hasWorkers ? 280 : 800;
	const duplicatesError = entries.some((worker) => field(worker, "error").trim() === output.trim());
	const omitExcerpt = record(result.details).dryRun === true || duplicatesError;
	const lines = omitExcerpt ? [] : [theme.fg(isError ? "error" : "toolOutput", evidencePreview(output, limit))];
	if (hasWorkers || output.length > limit || output.includes("\n")) lines.push(theme.fg("dim", expansionHint("result and identifiers")));
	return lines;
}

/** Only structured worker records supply resolved identity and configuration. */
export function renderWorkerResult(result: AgentToolResult<unknown>, options: ToolRenderResultOptions, theme: Theme, context: ResultContext): Component {
	const details = record(result.details);
	const entries = workers(details);
	const preview = details.dryRun === true;
	const lines: string[] = [];
	if (preview) lines.push(theme.fg("muted", "Local preflight preview; no workers started"));
	if (context.isError) lines.push(theme.fg("error", "Tool error"));
	else if (options.isPartial) lines.push(theme.fg("muted", "Partial result"));
	for (const worker of entries.slice(0, options.expanded ? entries.length : 4)) lines.push(...workerLines(worker, preview, options.expanded, theme));
	if (!options.expanded && entries.length > 4) lines.push(theme.fg("dim", `${entries.length - 4} more workers; expand for all results`));
	lines.push(...resultBody(result, options, theme, context.isError, entries));
	return component(lines, context.lastComponent);
}
