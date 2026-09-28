import type { AgentToolResult, Theme, ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import { keyText } from "@earendil-works/pi-coding-agent";
import { Text, type Component } from "@earendil-works/pi-tui";

type Fields = Record<string, unknown>;
type CallContext = { expanded: boolean; argsComplete: boolean; lastComponent?: Component };
type ResultContext = { isError: boolean; lastComponent?: Component };
type ResultContextWithArgs = ResultContext & { args?: unknown };

function record(value: unknown): Fields {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Fields : {};
}
function field(value: Fields, key: string): string {
	return typeof value[key] === "string" ? value[key] : "";
}
function numeric(value: Fields, key: string): number | undefined {
	return typeof value[key] === "number" ? value[key] as number : undefined;
}
function booleanFlag(value: Fields, key: string): boolean | undefined {
	return typeof value[key] === "boolean" ? value[key] as boolean : undefined;
}
function textOutput(result: AgentToolResult<unknown>): string {
	return result.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
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

/** The heading carries the request subject; a message preview is request text, not a result. */
export function renderWorkerCall(name: string, args: unknown, theme: Theme, context: CallContext): Component {
	const input = record(args);
	const id = field(input, "id");
	const message = field(input, "message");
	const subject = id ? inline(id, 24) : context.argsComplete ? "" : "id pending";
	const lines = [theme.fg("toolTitle", theme.bold(name)) + (subject ? theme.fg("muted", ` · ${subject}`) : "")];
	if (context.expanded) lines.push(full(JSON.stringify(input, null, 2)));
	else if (message) {
		lines.push(theme.fg("toolOutput", inline(message)));
		if (message.length > 160 || message.includes("\n")) lines.push(theme.fg("dim", expansionHint("message")));
	}
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
	const output = textOutput(result);
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

// ---------------------------------------------------------------------------
// Worker controls and direct collaboration cards
// ---------------------------------------------------------------------------

function statusHead(context: ResultContext, options: ToolRenderResultOptions, theme: Theme): string[] {
	if (context.isError) return [theme.fg("error", "Tool error")];
	if (options.isPartial) return [theme.fg("muted", "Partial result")];
	return [];
}

export type ControlToolKind = "steer" | "interrupt" | "kill";

/** Structured detail rows are a separate evidence layer from the summary rows. */
function jsonLines(details: Fields, theme: Theme): string[] {
	if (!Object.keys(details).length) return [];
	return [theme.fg("dim", full(JSON.stringify(details, null, 2)))];
}

function controlActed(kind: ControlToolKind, details: Fields, output: string): boolean | undefined {
	if (kind === "steer") return booleanFlag(details, "ok");
	if (kind === "kill") return output ? field(details, "state") === "cancelled" : undefined;
	return output ? /^Interrupted /u.test(output) : undefined;
}

/** A successful control restates the request; the result row carries only the new outcome. */
function controlSuccessLine(kind: ControlToolKind, output: string): string {
	if (kind === "steer") {
		if (/^Resume queued/u.test(output)) return "Resume queued; not proof of worker action";
		if (/^Prompt started/u.test(output)) return "Prompt started for an idle worker; not proof of action";
		return "Queued for delivery; not proof of worker action";
	}
	if (kind === "interrupt") return "Interrupted; the worker stays resumable";
	return "Cancelled";
}

/**
 * A control tool returns its own refusal sentence without throwing, so the
 * shell color (set only from the thrown flag) cannot show whether the request
 * took effect. Classify from what the current result carries: the structured
 * `ok` or `state` the tool supplies, otherwise the sentence it returned.
 */
export function renderControlResult(
	kind: ControlToolKind,
	result: AgentToolResult<unknown>,
	options: ToolRenderResultOptions,
	theme: Theme,
	context: ResultContext,
): Component {
	const details = record(result.details);
	const output = textOutput(result);
	const acted = controlActed(kind, details, output);
	const lines = statusHead(context, options, theme);
	if (options.expanded)
		return component([...lines, theme.fg("toolOutput", full(output)), ...jsonLines(details, theme)], context.lastComponent);
	if (!context.isError && acted === true) {
		lines.push(theme.fg("success", controlSuccessLine(kind, output)));
		return component(lines, context.lastComponent);
	}
	const color = context.isError ? "error" : acted === false ? "warning" : "muted";
	if (output) lines.push(theme.fg(color, inline(output, 240)));
	else lines.push(theme.fg("muted", "No outcome text"));
	if (output.length > 240 || output.includes("\n")) lines.push(theme.fg("dim", expansionHint("result")));
	return component(lines, context.lastComponent);
}

/** The report message is the request subject; the card claims no acknowledgement. */
export function renderReportCall(args: unknown, theme: Theme, context: CallContext): Component {
	const input = record(args);
	const message = field(input, "message");
	const preview = inline(message);
	const lines = [theme.fg("toolTitle", theme.bold("subagent_report")) + (preview ? theme.fg("accent", ` · ${preview}`) : "")];
	if (context.expanded) {
		lines.push(full(JSON.stringify(input, null, 2)));
		return component(lines, context.lastComponent);
	}
	if (!preview) lines.push(theme.fg("muted", context.argsComplete ? "(no message)" : "message pending"));
	else if (message.length > 160 || message.includes("\n")) lines.push(theme.fg("dim", expansionHint("report text")));
	return component(lines, context.lastComponent);
}

/** A report receipt is sent_unconfirmed: the send call returned, nothing more. */
function reportSummaryLine(details: Fields, theme: Theme): string {
	const number = numeric(details, "reportNumber");
	if (field(details, "status") !== "sent_unconfirmed" || number === undefined) return theme.fg("muted", "Outcome unknown");
	const bytes = numeric(details, "messageBytes");
	const owner = field(details, "ownerSession");
	const summary = `Report #${number} sent${bytes === undefined ? "" : ` (${bytes} bytes)`}${owner ? ` to session ${inline(owner, 24)}` : ""}`;
	return theme.fg("success", summary) + theme.fg("dim", " · sent_unconfirmed (not proof of receipt or action)");
}

export function renderReportResult(
	result: AgentToolResult<unknown>,
	options: ToolRenderResultOptions,
	theme: Theme,
	context: ResultContext,
): Component {
	const details = record(result.details);
	const output = textOutput(result);
	const lines = statusHead(context, options, theme);
	if (options.expanded)
		return component([...lines, theme.fg("toolOutput", full(output)), ...jsonLines(details, theme)], context.lastComponent);
	if (!context.isError && !options.isPartial) lines.push(reportSummaryLine(details, theme));
	const summarised = !context.isError && field(details, "status") === "sent_unconfirmed" && numeric(details, "reportNumber") !== undefined;
	if (!summarised && output) lines.push(theme.fg(context.isError ? "error" : "toolOutput", inline(output, 300)));
	if (!summarised && output && (output.length > 300 || output.includes("\n")))
		lines.push(theme.fg("dim", expansionHint("result")));
	return component(lines, context.lastComponent);
}

export function renderPeersCall(args: unknown, theme: Theme, context: CallContext): Component {
	const input = record(args);
	const offset = numeric(input, "offset") ?? 0;
	const lines = [theme.fg("toolTitle", theme.bold("subagent_peers")) + (offset > 0 ? theme.fg("muted", ` · from entry ${offset}`) : "")];
	if (context.expanded) lines.push(full(JSON.stringify(input, null, 2)));
	return component(lines, context.lastComponent);
}

/** A bounded page lists its own peers; omission of others is not evidence of absence. */
function peerRowLines(peer: Fields, theme: Theme): string[] {
	const label = inline(field(peer, "label"), 60) || "peer";
	const id = inline(field(peer, "id"), 24) || "id unknown";
	return [theme.fg("toolOutput", `${label} · ${id} · parent ${inline(field(peer, "parent"), 24) || "root"}`)];
}

function peerContinuation(next: number | undefined): string {
	return next === undefined ? "" : ` · more at offset ${next}`;
}

export function renderPeersResult(
	result: AgentToolResult<unknown>,
	options: ToolRenderResultOptions,
	theme: Theme,
	context: ResultContext,
): Component {
	const details = record(result.details);
	const output = textOutput(result);
	const peers = Array.isArray(details.peers) ? details.peers.map(record) : [];
	const lines = statusHead(context, options, theme);
	if (!context.isError && !options.isPartial) {
		const total = numeric(details, "total") ?? peers.length;
		lines.push(
			theme.fg(
				"muted",
				`Self ${inline(field(details, "self"), 24) || "unknown"} · family of ${total} (self included)${peerContinuation(numeric(details, "nextOffset"))}`,
			),
		);
	}
	if (options.expanded) {
		lines.push(...peers.flatMap((peer) => peerRowLines(peer, theme)));
		if (output) lines.push(theme.fg("dim", full(output)));
		return component(lines, context.lastComponent);
	}
	if (context.isError && output) lines.push(theme.fg("error", inline(output, 300)));
	if (peers.length) lines.push(theme.fg("dim", expansionHint("peer addresses")));
	return component(lines, context.lastComponent);
}

function messageQualifier(message: string, replyTo: string, reference: boolean): string {
	return [message, replyTo ? `reply ${inline(replyTo, 24)}` : "", reference ? "reference" : ""].filter(Boolean).join(" · ");
}

/** A receipt read ({id}) is a distinct request from a send ({to,message}). */
export function renderMessageCall(args: unknown, theme: Theme, context: CallContext): Component {
	const input = record(args);
	const to = field(input, "to");
	const messageId = field(input, "id");
	const message = field(input, "message");
	const receiptRead = Boolean(messageId) && !to && !message;
	const lines: string[] = [];
	if (receiptRead) {
		lines.push(theme.fg("toolTitle", theme.bold("subagent_message")) + theme.fg("muted", ` · receipt ${inline(messageId, 24)}`));
		if (context.expanded) lines.push(full(JSON.stringify(input, null, 2)));
		return component(lines, context.lastComponent);
	}
	const target = to ? inline(to, 24) : context.argsComplete ? "no target" : "target pending";
	lines.push(theme.fg("toolTitle", theme.bold("subagent_message")) + theme.fg("accent", ` → ${target}`));
	if (context.expanded) {
		lines.push(full(JSON.stringify(input, null, 2)));
		return component(lines, context.lastComponent);
	}
	const qualifier = messageQualifier(
		inline(message) || (context.argsComplete ? "(no message)" : "message pending"),
		field(input, "replyTo"),
		input.reference !== undefined && input.reference !== null,
	);
	lines.push(theme.fg("toolOutput", qualifier));
	if (message.length > 160 || message.includes("\n")) lines.push(theme.fg("dim", expansionHint("message and metadata")));
	return component(lines, context.lastComponent);
}

const peerStatusNotes: Record<string, string> = {
	sent_unconfirmed: "the send call returned; not proof of receipt, persistence, or action",
	context_seen: "the receiving context hook observed the id; not proof of model understanding",
	target_closed: "the target endpoint closed before the id was observed in context",
};

function messageIdentity(receiptRead: boolean, id: string, status: string): string {
	const label = status || "status unknown";
	return receiptRead || !id ? label : `${inline(id, 24)} · ${label}`;
}

function messageStatusNote(status: string): string {
	if (!status) return "no retained status in this result";
	return peerStatusNotes[status] ?? "status not recognized; expand for the retained receipt";
}

function messageStatusLimit(status: string): string {
	if (status === "sent_unconfirmed") return "(not proof of receipt or action)";
	if (status === "context_seen") return "(context observed; not proof of model understanding)";
	if (status === "target_closed") return "(endpoint closed before context observation)";
	if (!status) return "(no retained status in this result)";
	return "(status not recognized; expand for the retained receipt)";
}

/** Receipt state stays exact: process-local evidence only, never delivery or action. */
export function renderMessageResult(
	result: AgentToolResult<unknown>,
	options: ToolRenderResultOptions,
	theme: Theme,
	context: ResultContextWithArgs,
): Component {
	const details = record(result.details);
	const output = textOutput(result);
	const args = record(context.args);
	const receiptRead = Boolean(field(args, "id")) && !field(args, "to") && !field(args, "message");
	const status = field(details, "status");
	const lines = statusHead(context, options, theme);
	if (options.expanded) {
		lines.push(theme.fg("toolOutput", full(output)));
		lines.push(theme.fg("dim", messageStatusNote(status)));
		lines.push(...jsonLines(details, theme));
		return component(lines, context.lastComponent);
	}
	if (context.isError) {
		if (output) lines.push(theme.fg("error", inline(output, 300)));
		if (output.length > 300 || output.includes("\n")) lines.push(theme.fg("dim", expansionHint("result")));
		return component(lines, context.lastComponent);
	}
	if (!options.isPartial) {
		const identity = messageIdentity(receiptRead, field(details, "id") || field(args, "id"), status);
		lines.push(theme.fg("accent", identity) + theme.fg("dim", ` ${messageStatusLimit(status)}`));
	}
	return component(lines, context.lastComponent);
}

function profileDefinitionSummary(definition: Fields): string {
	const parts: string[] = [];
	const model = field(definition, "model");
	if (model) parts.push(inline(model, 60));
	const thinking = field(definition, "thinking");
	if (thinking) parts.push(`thinking ${inline(thinking, 20)}`);
	const cwd = field(definition, "cwd");
	if (cwd) parts.push(`cwd ${inline(cwd, 40)}`);
	if (Array.isArray(definition.grounding))
		parts.push(`${definition.grounding.length} grounding pointer${definition.grounding.length === 1 ? "" : "s"}`);
	const instructions = field(definition, "instructions");
	if (instructions) parts.push(`${instructions.length} instruction chars`);
	return parts.join(" · ");
}

function profileCallQualifier(input: Fields, action: string): string {
	const parts: string[] = [];
	if (action === "create" || action === "update") {
		const summary = profileDefinitionSummary(record(input.definition));
		if (summary) parts.push(`definition: ${summary}`);
	}
	const digest = field(input, "expectedSha256");
	if (digest) parts.push(`digest ${inline(digest, 12)}`);
	return parts.join(" · ");
}

export function renderProfilesCall(args: unknown, theme: Theme, context: CallContext): Component {
	const input = record(args);
	const action = field(input, "action");
	const name = field(input, "name");
	const subject = action || (context.argsComplete ? "no action" : "action pending");
	const lines = [
		theme.fg("toolTitle", theme.bold("subagent_profiles")) +
			theme.fg("accent", ` · ${inline(subject, 40)}`) +
			(name ? theme.fg("muted", ` · ${inline(name, 64)}`) : ""),
	];
	if (context.expanded) {
		lines.push(full(JSON.stringify(input, null, 2)));
		return component(lines, context.lastComponent);
	}
	const qualifier = profileCallQualifier(input, action);
	if (qualifier) lines.push(theme.fg("muted", qualifier));
	if (action === "create" || action === "update" || field(input, "expectedSha256"))
		lines.push(theme.fg("dim", expansionHint("profile definition")));
	return component(lines, context.lastComponent);
}

function profileListHead(details: Fields, entries: Fields[], theme: Theme): string {
	const enabled = entries.filter((item) => item.ok !== false && item.enabled === true).length;
	const disabled = entries.filter((item) => item.ok !== false && item.enabled === false).length;
	const unreadable = entries.filter((item) => item.ok === false).length;
	const parts = [`${entries.length} profile${entries.length === 1 ? "" : "s"}`];
	if (enabled) parts.push(`${enabled} enabled`);
	if (disabled) parts.push(`${disabled} disabled`);
	if (unreadable) parts.push(`${unreadable} unreadable`);
	const filter = field(details, "filter");
	if (filter) parts.push(`filter ${inline(filter, 40)}`);
	if (details.truncated === true) parts.push("list truncated");
	return theme.fg("muted", parts.join(" · "));
}

function profileReadLines(entry: Fields, hasEntry: boolean, theme: Theme): string[] {
	if (!hasEntry) return [theme.fg("muted", "No readable entry in this result")];
	if (entry.ok === false) return [theme.fg("error", `unreadable · ${inline(field(entry, "error"), 240) || "no error detail"}`)];
	const state = entry.enabled === true ? "enabled" : entry.enabled === false ? "disabled" : "state unknown";
	const model = field(entry, "model");
	const lines = [theme.fg("accent", `${state}${model ? ` · ${inline(model, 60)}` : ""}`)];
	const digest = field(entry, "sha256");
	if (digest) lines.push(theme.fg("dim", `sha256 ${inline(digest, 12)}; retain for a later mutation`));
	return lines;
}

function profileMutationLines(action: string, entry: Fields, hasEntry: boolean, theme: Theme): string[] {
	const words: Record<string, string> = { create: "Created", update: "Replaced", remove: "Removed", enable: "Enabled", disable: "Disabled" };
	const ok = action === "remove" ? !hasEntry || entry.ok !== false : hasEntry && entry.ok !== false;
	const lines = [theme.fg(ok ? "success" : "muted", words[action] ?? action)];
	if (hasEntry && field(entry, "error")) lines.push(theme.fg("error", inline(field(entry, "error"), 240)));
	const digest = field(entry, "sha256");
	lines.push(theme.fg("dim", `${digest ? `new digest ${inline(digest, 12)} · ` : ""}existing worker snapshots are unchanged`));
	return lines;
}

function profileResultSummary(details: Fields, entries: Fields[] | undefined, theme: Theme): string[] {
	const action = field(details, "action");
	const entry = record(details.entry);
	const hasEntry = Object.keys(entry).length > 0;
	if (entries !== undefined) return [profileListHead(details, entries, theme)];
	if (action === "read") return profileReadLines(entry, hasEntry, theme);
	if (action) return profileMutationLines(action, entry, hasEntry, theme);
	return [theme.fg("muted", "Outcome unknown")];
}

export function renderProfilesResult(
	result: AgentToolResult<unknown>,
	options: ToolRenderResultOptions,
	theme: Theme,
	context: ResultContext,
): Component {
	const details = record(result.details);
	const output = textOutput(result);
	const entries = Array.isArray(details.entries) ? details.entries.map(record) : undefined;
	const lines = statusHead(context, options, theme);
	if (options.expanded)
		return component([...lines, theme.fg("toolOutput", full(output)), ...jsonLines(details, theme)], context.lastComponent);
	if (!context.isError && !options.isPartial) lines.push(...profileResultSummary(details, entries, theme));
	if (context.isError && output) lines.push(theme.fg("error", inline(output, 300)));
	if (entries?.length) lines.push(theme.fg("dim", expansionHint("profile names and records")));
	return component(lines, context.lastComponent);
}
