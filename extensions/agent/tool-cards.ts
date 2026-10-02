/**
 * Agent cards render tool call arguments and retained results from native
 * Durable observation values, plus the `agent.peer` message notices the
 * manager returns to the primary. Cards read only the values the owner
 * returned; rendering opens no storage and changes no execution behavior.
 */
import type { AgentToolResult, MessageRenderer, Theme, ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme, keyText } from "@earendil-works/pi-coding-agent";
import { Box, Markdown, Spacer, Text, type Component } from "@earendil-works/pi-tui";

/** Bytes/units bounds for one expanded display block. */
export const SOURCE_DISPLAY_LIMIT = 32_000;
const MESSAGE_DISPLAY_LIMIT = 32_000;
const PREVIEW_UNITS = 600;
const PREVIEW_CHARS = 600;

/** Card context: the subset of `ToolRenderContext` these renderers read. */
export interface AgentCardContext {
	readonly args?: unknown;
	readonly expanded: boolean;
	readonly argsComplete?: boolean;
	readonly isError?: boolean;
	readonly lastComponent?: Component;
}

export interface AgentToolCard {
	renderCall(args: unknown, theme: Theme, context: AgentCardContext): Component;
	renderResult(result: AgentToolResult<unknown>, options: ToolRenderResultOptions, theme: Theme, context: AgentCardContext): Component;
}

/**
 * Show controls as text, never as terminal commands. Newlines retain message
 * structure.
 */
export function displayText(value: string): string {
	return value.replace(/[\p{Cc}\p{Cf}]/gu, (char) => {
		if (char === "\n") return char;
		if (char === "\t") return "\\t";
		if (char === "\r") return "\\r";
		return `\\u{${char.codePointAt(0)?.toString(16)}}`;
	});
}

function displayPrefix(value: string, limit: number): string {
	const end = Math.min(value.length, limit);
	return value.slice(0, end < value.length && /[\uD800-\uDBFF]/u.test(value[end - 1] ?? "") ? end - 1 : end);
}

export function displayPreview(value: string, limit: number): string {
	const prefix = displayPrefix(value, limit);
	return displayText(prefix).replace(/\s+/gu, " ").trim() + (value.length > prefix.length ? "…" : "");
}

/** Escape the source prefix; the truncation notice sits outside the display bound. */
function boundedSource(value: string, limit = SOURCE_DISPLAY_LIMIT): string {
	const prefix = displayPrefix(value, limit);
	return displayText(prefix) + (value.length > prefix.length ? `\n[Display limit: ${value.length - prefix.length} more UTF-16 code units. Full text remains in native history.]` : "");
}

function textComponent(text: string, previous?: Component): Text {
	const component = previous instanceof Text ? previous : new Text("", 0, 0);
	component.setText(text);
	return component;
}

function expansionHint(subject: string): string {
	const key = keyText("app.tools.expand");
	return key ? `${key} to expand ${subject}` : `Expand for full ${subject}`;
}

function messageHint(): string {
	const key = keyText("app.tools.expand");
	return key ? `${key} to expand message` : "Full message is in the tool-call arguments.";
}

export function record(value: unknown): Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function text(value: unknown): string {
	return typeof value === "string" ? value : "";
}

function count(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Entry, task, and submission identities are numbers in native data; render them as text. */
function identifier(value: unknown): string {
	if (typeof value === "string") return value;
	if (typeof value === "number" && Number.isFinite(value)) return String(value);
	return "";
}

function array(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}

function firstDefined(...values: unknown[]): unknown {
	for (const value of values) if (value !== undefined) return value;
	return undefined;
}

function resultText(result: AgentToolResult<unknown>): string {
	return result.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
}

function resultDetails(result: AgentToolResult<unknown>): Record<string, unknown> {
	return record(firstDefined(result.details, result.structuredContent));
}

function resultPreview(value: string, limit = PREVIEW_UNITS): string {
	const prefix = displayPrefix(value, limit);
	const lines = prefix.split("\n").slice(0, 3).join("\n");
	return displayText(lines) + (lines.length < value.length ? "\n…" : "");
}

// --- Call cards ------------------------------------------------------------------

const SUBJECT_KEYS = ["name", "topic", "area", "prompt", "correction", "sessionId"] as const;
const MODEL_CALLS = new Set(["agent_spawn", "agent_attach", "agent_place", "agent_fork", "agent_rewind", "agent_configure"]);
const RETAINED_MODEL_CALLS = new Set(["agent_attach", "agent_fork", "agent_rewind", "agent_configure"]);

/** Requested configuration stays distinct from a resolved session snapshot. */
function requestedConfiguration(name: string, args: Record<string, unknown>): string | undefined {
	if (!MODEL_CALLS.has(name)) return undefined;
	const unresolved = name === "agent_place" ? "bound session or inherited" : RETAINED_MODEL_CALLS.has(name) ? "retained session" : "inherited";
	const model = text(args.model);
	const thinking = text(args.thinkingLevel);
	if (!model && !thinking) return `Requested model and thinking: ${unresolved} (unresolved)`;
	return `Requested: ${model ? displayPreview(model, 240) : `${unresolved} (unresolved)`} · thinking ${thinking ? displayPreview(thinking, 40) : "unresolved"}`;
}

/** True when a collapsed call hides or clips an argument. */
function argsHidden(args: Record<string, unknown>, subjectKey: string, subjectValue: string): boolean {
	if (subjectValue.length > 120) return true;
	const shown = new Set([subjectKey, "model", "thinkingLevel"].filter(Boolean));
	return Object.entries(args).some(([key, item]) => item !== undefined && !shown.has(key));
}

function argumentCard(name: string, subject: string, qualifier: string | undefined, args: Record<string, unknown>, theme: Theme, context: AgentCardContext, hidden: boolean): Component {
	const lines = [theme.fg("toolTitle", theme.bold(name)) + (subject ? theme.fg("accent", ` · ${subject}`) : "")];
	if (qualifier) lines.push(theme.fg("muted", qualifier));
	if (context.expanded) lines.push(theme.fg("toolOutput", boundedSource(JSON.stringify(args, null, 2))));
	else if (hidden) lines.push(theme.fg("dim", expansionHint("arguments")));
	return textComponent(lines.join("\n"), context.lastComponent);
}

/** Generic call card for snapshot and control tools. */
export function renderAgentCall(name: string, value: unknown, theme: Theme, context: AgentCardContext): Component {
	const args = record(value);
	const subjectKey = SUBJECT_KEYS.find((key) => text(args[key]) !== "") ?? "";
	const subjectValue = subjectKey ? text(args[subjectKey]) : "";
	const lines = [theme.fg("toolTitle", theme.bold(name)) + (subjectValue ? theme.fg("accent", ` · ${displayPreview(subjectValue, 120)}`) : "")];
	const configuration = requestedConfiguration(name, args);
	if (configuration) lines.push(theme.fg("muted", configuration));
	if (context.expanded) lines.push(theme.fg("toolOutput", boundedSource(JSON.stringify(args, null, 2))));
	else if (argsHidden(args, subjectKey, subjectValue)) lines.push(theme.fg("dim", expansionHint("arguments")));
	return textComponent(lines.join("\n"), context.lastComponent);
}

function renderMessageCall(name: string, value: unknown, theme: Theme, context: AgentCardContext): Component {
	const args = record(value);
	const target = text(args.sessionId) ? displayPreview(text(args.sessionId), 300) : "(target pending)";
	const message = text(args.message);
	const reply = text(args.replyTo) ? displayPreview(text(args.replyTo), 300) : "";
	const lines = [theme.fg("toolTitle", theme.bold(name)) + theme.fg("accent", ` → ${target}`) + (reply ? theme.fg("muted", ` · reply to ${reply}`) : "")];
	if (context.expanded) {
		lines.push(theme.fg("muted", context.argsComplete === false ? "Message so far (controls escaped):" : "Submitted message (controls escaped):"));
		lines.push(theme.fg("toolOutput", boundedSource(message, MESSAGE_DISPLAY_LIMIT)));
	} else {
		const preview = displayPreview(message, 180);
		lines.push(theme.fg("toolOutput", preview || (context.argsComplete === false ? "(message pending)" : "(empty or whitespace-only message)")));
		if (preview !== message && message !== "") lines.push(theme.fg("dim", messageHint()));
	}
	return textComponent(lines.join("\n"), context.lastComponent);
}

export function renderSendCall(value: unknown, theme: Theme, context: AgentCardContext): Component {
	return renderMessageCall("agent_send", value, theme, context);
}

export function renderSteerCall(value: unknown, theme: Theme, context: AgentCardContext): Component {
	return renderMessageCall("agent_steer", value, theme, context);
}

/** The summary argument selects the self path; execution refuses a mismatched session ID. */
export function renderCompactCall(value: unknown, theme: Theme, context: AgentCardContext): Component {
	const args = record(value);
	const target = text(args.sessionId) ? displayPreview(text(args.sessionId), 300) : "(target pending)";
	const summary = text(args.summary);
	const lines = [theme.fg("toolTitle", theme.bold("agent_compact")) + theme.fg("accent", summary ? ` · self · ${target}` : ` · ${target}`)];
	if (summary) lines.push(theme.fg("muted", `Native compaction entry with the agent-authored summary (${summary.length} chars) at this tool batch's end`));
	else {
		lines.push(theme.fg("muted", "Native summarization of the named conversation; it aborts active work and does not resume"));
		lines.push(theme.fg("muted", `Summarizer instructions: ${text(args.instructions) ? "present" : "none"}`));
	}
	if (context.expanded) lines.push(theme.fg("toolOutput", boundedSource(JSON.stringify(args, null, 2))));
	else if (summary || text(args.instructions)) lines.push(theme.fg("dim", expansionHint("arguments")));
	return textComponent(lines.join("\n"), context.lastComponent);
}

export function renderListCall(value: unknown, theme: Theme, context: AgentCardContext): Component {
	const args = record(value);
	const query = text(args.query);
	const cwd = text(args.cwd);
	const subject = query ? `query ${displayPreview(query, 160)}` : cwd ? `cwd ${displayPreview(cwd, 160)}` : "stored conversations";
	const qualifiers: string[] = [];
	if (query && cwd) qualifiers.push(`cwd ${displayPreview(cwd, 160)}`);
	const limit = count(args.limit);
	if (limit !== undefined) qualifiers.push(`limit ${limit}`);
	if (text(args.cursor)) qualifiers.push("continuation page");
	return argumentCard("agent_list", subject, qualifiers.join(" · ") || undefined, args, theme, context, query.length > 160 || cwd.length > 160);
}

export function renderAbortCall(value: unknown, theme: Theme, context: AgentCardContext): Component {
	const args = record(value);
	const target = text(args.sessionId);
	return argumentCard("agent_abort", target ? displayPreview(target, 300) : "(target pending)", undefined, args, theme, context, target.length > 300 || args.trust !== undefined);
}

export function renderCommandCall(value: unknown, theme: Theme, context: AgentCardContext): Component {
	const args = record(value);
	const name = text(args.name);
	const target = text(args.sessionId);
	const subject = `${name ? displayPreview(name, 120) : "(command pending)"} → ${target ? displayPreview(target, 300) : "(target pending)"}`;
	const commandArgs = text(args.args);
	return argumentCard("agent_command", subject, commandArgs ? `args ${displayPreview(commandArgs, 200)}` : undefined, args, theme, context, name.length > 120 || target.length > 300 || commandArgs.length > 200);
}

function inspectQualifier(args: Record<string, unknown>): { qualifier: string; hidden: boolean } {
	const parts = [`view ${text(args.view) || "history"}`];
	let hidden = false;
	const push = (label: string, key: string, limit: number) => {
		const value = text(args[key]);
		if (!value) return;
		parts.push(`${label} ${displayPreview(value, limit)}`);
		hidden ||= value.length > limit;
	};
	push("entry", "entryId", 120);
	push("query", "query", 120);
	push("submission", "submissionId", 120);
	push("operation", "operationId", 120);
	push("source", "source", 40);
	push("from", "fromId", 120);
	for (const key of ["offset", "cursor", "limit"] as const) {
		const value = count(args[key]);
		if (value !== undefined) parts.push(`${key} ${value}`);
		else if (key === "limit" && args.view === "activity" && args.limit === undefined) parts.push("limit 4 (default)");
	}
	if (text(args.continuation)) parts.push("continuation");
	return { qualifier: parts.join(" · "), hidden };
}

export function renderInspectCall(value: unknown, theme: Theme, context: AgentCardContext): Component {
	const args = record(value);
	const target = text(args.sessionId);
	const { qualifier, hidden } = inspectQualifier(args);
	return argumentCard("agent_inspect", target ? displayPreview(target, 300) : "(target pending)", qualifier, args, theme, context, hidden || target.length > 300);
}

// --- Result cards ----------------------------------------------------------------

function outcomeCard(result: AgentToolResult<unknown>, options: ToolRenderResultOptions, theme: Theme, context: AgentCardContext, labels: { error: string; partial: string }, summarize: (details: Record<string, unknown>, theme: Theme) => string[] | undefined): Component {
	const details = resultDetails(result);
	const output = resultText(result);
	const lines: string[] = [];
	if (context.isError === true) lines.push(theme.fg("error", labels.error));
	else if (options.isPartial) lines.push(theme.fg("muted", labels.partial));
	if (options.expanded) lines.push(theme.fg("toolOutput", boundedSource(output)));
	else {
		const summary = summarize(details, theme);
		if (summary) lines.push(...summary);
		else lines.push(theme.fg(context.isError === true ? "error" : "toolOutput", resultPreview(output)));
		if (summary || output.length > PREVIEW_UNITS || output.includes("\n")) lines.push(theme.fg("dim", expansionHint("result")));
	}
	return textComponent(lines.join("\n"), context.lastComponent);
}

function muted(theme: Theme, value: string): string {
	return theme.fg("muted", value);
}

function controlReceiptLines(details: Record<string, unknown>, theme: Theme, subject: string): string[] | undefined {
	const identity = text(details.identity);
	const conversationId = count(details.conversationId);
	if (!identity && conversationId === undefined) return undefined;
	const lines = [theme.fg("toolOutput", `${subject}${identity ? ` · ${displayPreview(identity, 300)}` : conversationId !== undefined ? ` · conversation ${conversationId}` : ""}`)];
	const submission = count(details.submissionId);
	if (submission !== undefined) lines.push(muted(theme, `submission ${submission}`));
	if (details.deduped === true) lines.push(muted(theme, "Deduplicated against the retained request ID"));
	return lines;
}

function receiptLines(details: Record<string, unknown>, theme: Theme): string[] | undefined {
	if (count(details.submissionId) === undefined || text(details.identity) === "") return undefined;
	return controlReceiptLines(details, theme, "Admission receipt");
}

function forkLines(details: Record<string, unknown>, theme: Theme): string[] | undefined {
	if (text(details.identity) === "" || details.deduped === undefined || count(details.conversationId) === undefined || count(details.submissionId) !== undefined) return undefined;
	return controlReceiptLines(details, theme, "Fork created");
}

function rewindLines(details: Record<string, unknown>, theme: Theme): string[] | undefined {
	if (count(details.predecessorEntryId) === undefined || text(details.identity) === "") return undefined;
	const lines = controlReceiptLines(details, theme, "Rewind submitted") ?? [];
	const predecessor = count(details.predecessorEntryId);
	if (predecessor !== undefined) lines.push(muted(theme, `forked before entry ${predecessor}`));
	return lines;
}

function configureLines(details: Record<string, unknown>, theme: Theme): string[] | undefined {
	if (text(details.identity) === "" || count(details.conversationId) === undefined) return undefined;
	return [theme.fg("toolOutput", `Configuration applied · ${displayPreview(text(details.identity), 300)}`)];
}

function abortLines(details: Record<string, unknown>, theme: Theme): string[] | undefined {
	if (text(details.identity) === "" || details.background === undefined) return undefined;
	const lines = [theme.fg("toolOutput", `Abort requested · ${displayPreview(text(details.identity), 300)}`)];
	if (details.background === true) lines.push(muted(theme, "Includes background task trees"));
	return lines;
}

function commandLines(details: Record<string, unknown>, theme: Theme): string[] | undefined {
	const reloaded = details.reloaded === true;
	const textValue = text(details.text);
	const identity = text(details.identity);
	const name = text(details.name);
	if (!reloaded && !textValue && !identity && !name) return undefined;
	const lines = [theme.fg("toolOutput", reloaded ? "Host registrations reloaded" : displayPreview(textValue || "(no command output text)", 240))];
	const inventory = record(details.inventory);
	const capabilities = array(inventory.contributions).length;
	if (reloaded && capabilities > 0) lines.push(muted(theme, `${capabilities} native contribution${capabilities === 1 ? "" : "s"} installed`));
	if (name) lines.push(muted(theme, `command ${displayPreview(name, 120)}${identity ? ` · ${displayPreview(identity, 300)}` : ""}`));
	else if (identity) lines.push(muted(theme, displayPreview(identity, 300)));
	return lines;
}

function sessionSummaryLines(sessions: Record<string, unknown>[], theme: Theme): string[] {
	const working = sessions.filter((row) => row.state === "working").length;
	const cost = sessions.reduce((sum, row) => sum + (count(row.cost) ?? 0), 0);
	const partial = sessions.some((row) => row.partial === true);
	const lines = [theme.fg("toolOutput", `${sessions.length} conversation${sessions.length === 1 ? "" : "s"} · ${working} working · $${cost.toFixed(2)}${partial ? "+?" : ""}`)];
	for (const row of sessions.slice(0, 4)) lines.push(muted(theme, `${displayPreview(text(row.name) || text(row.id), 120) || "conversation"} · ${text(row.state) || "unknown state"}`));
	if (sessions.length > 4) lines.push(muted(theme, `${sessions.length - 4} more conversation records; expand for details`));
	return lines;
}

function conversationListLines(conversations: Record<string, unknown>[], theme: Theme): string[] {
	const busy = conversations.filter((row) => row.busy === true || Object.keys(record(record(row.live).run)).length > 0).length;
	const lines = [theme.fg("toolOutput", `${conversations.length} conversation${conversations.length === 1 ? "" : "s"} · ${busy} working`)];
	for (const row of conversations.slice(0, 4)) lines.push(muted(theme, `${displayPreview(text(row.name) || text(row.identity), 120) || "conversation"} · ${row.busy === true ? "working" : "idle"}`));
	if (conversations.length > 4) lines.push(muted(theme, `${conversations.length - 4} more conversation records; expand for details`));
	return lines;
}

function statusOverviewLines(details: Record<string, unknown>, theme: Theme): string[] | undefined {
	if (Array.isArray(details.sessions)) {
		const lines = sessionSummaryLines(details.sessions.map(record), theme);
		const failures = array(details.failures).length;
		if (failures) lines.push(theme.fg("warning", `${failures} storage${failures === 1 ? "" : "s"} unavailable (unknown, not absent)`));
		lines.push(muted(theme, "agent_list discovers stored conversations"));
		return lines;
	}
	if (Array.isArray(details.conversations)) {
		const lines = conversationListLines(details.conversations.map(record), theme);
		lines.push(muted(theme, "agent_list discovers stored conversations"));
		return lines;
	}
	return undefined;
}

function summarizeGeneric(details: Record<string, unknown>, theme: Theme): string[] | undefined {
	return statusOverviewLines(details, theme)
		?? rewindLines(details, theme)
		?? forkLines(details, theme)
		?? receiptLines(details, theme)
		?? abortLines(details, theme)
		?? configureLines(details, theme)
		?? commandLines(details, theme);
}

function snapshotStatus(details: Record<string, unknown>): Record<string, unknown> | undefined {
	const direct = record(details.conversation);
	if (Object.keys(direct).length > 0) return direct;
	const nested = record(details.status);
	if (count(nested.conversationId) !== undefined && nested.agent !== undefined) return nested;
	const wrapper = record(nested.conversation);
	return Object.keys(wrapper).length > 0 ? wrapper : undefined;
}

function readOnlySnapshot(details: Record<string, unknown>): boolean {
	return details.live === false || record(details.status).live === false;
}

function runningSlots(live: Record<string, unknown>): Record<string, unknown>[] {
	return array(live.tools).map(record).filter((slot) => slot.status === "running" || slot.status === "pending");
}

function runningSlotLine(slot: Record<string, unknown>): string {
	const parts = [`Running: ${displayPreview(text(slot.name) || "tool", 100)}`, `call ${displayPreview(text(slot.callId) || "unknown", 160)}`];
	if (slot.status === "pending") parts.push("pending");
	return parts.join(" · ");
}

function latestSavedResult(submissions: unknown): string | undefined {
	const rows = array(submissions).map(record).filter((row) => row.type === "input" && (row.status === "done" || row.status === "unanswered"));
	const last = rows.at(-1);
	if (!last) return undefined;
	const id = count(last.id);
	return `Last saved result: ${text(last.status)}${id === undefined ? "" : ` · submission ${id}`} · not task acceptance`;
}

function retryLines(live: Record<string, unknown>, theme: Theme): string[] {
	const lines: string[] = [];
	const generation = record(record(live.generation).retry);
	if (Object.keys(generation).length > 0) lines.push(theme.fg("warning", `Provider retry${text(generation.error) ? `: ${displayPreview(text(generation.error), 200)}` : ""}`));
	for (const value of array(live.compactions)) {
		const retry = record(record(value).retry);
		if (Object.keys(retry).length > 0) lines.push(theme.fg("warning", `Compaction retry${text(retry.error) ? `: ${displayPreview(text(retry.error), 200)}` : ""}`));
	}
	return lines;
}

/** The newest text is named by its author: the agent's reply or the input it received. */
function newestTextLabel(working: boolean, role: string | undefined): string {
	if (role === "assistant") return working ? "Replying" : "Latest reply";
	if (role === "user") return working ? "Working on input" : "Latest input";
	return working ? "Working on the task" : "Latest message";
}

function activityLines(status: Record<string, unknown>, readOnly: boolean, theme: Theme): string[] {
	const live = record(status.live);
	const working = status.busy === true || Object.keys(record(live.run)).length > 0;
	const running = runningSlots(live);
	const current = running.find((slot) => slot.status === "running");
	const inbox = record(status.inbox);
	const pending = Array.isArray(inbox.items) ? inbox.items.length : undefined;
	const parts = [`Activity: ${working ? "working" : "idle"}`, current ? `tool ${displayPreview(text(current.name), 100)}` : undefined, pending === undefined ? "pending unknown" : `${pending} pending`];
	const lines = [muted(theme, parts.filter(Boolean).join(" · "))];
	if (readOnly) lines.unshift(theme.fg("muted", "Read-only snapshot; live owner state unavailable"));
	for (const slot of running.slice(0, 4)) lines.push(muted(theme, runningSlotLine(slot)));
	if (running.length > 4) lines.push(muted(theme, `${running.length - 4} more running tools; expand for details`));
	// The status contract carries no role for this text, so the label reports the state only.
	const lastText = text(status.lastText);
	if (lastText) lines.push(theme.fg("toolOutput", `${newestTextLabel(working, text(status.lastTextRole))}: ${displayPreview(lastText, 240)}`));
	const saved = latestSavedResult(status.submissions);
	if (saved) lines.push(muted(theme, saved));
	lines.push(...retryLines(live, theme));
	return lines;
}

function snapshotLines(status: Record<string, unknown>, details: Record<string, unknown>, theme: Theme): string[] {
	const agent = record(status.agent);
	const model = record(agent.model);
	const provider = text(model.provider);
	const modelId = text(model.modelId);
	const thinking = text(agent.thinkingLevel);
	const name = text(status.name);
	const identity = text(status.identity) || text(status.sessionId);
	const lines: string[] = [];
	if (name || identity) lines.push(theme.fg("accent", displayPreview(name || identity, 120)));
	lines.push(muted(theme, `Model: ${provider && modelId ? displayPreview(`${provider}/${modelId}`, 300) : "model unknown"} · thinking ${thinking ? displayPreview(thinking, 40) : "unknown"}`));
	if (status.live === undefined && typeof status.state === "string") lines.push(muted(theme, `State: ${displayPreview(status.state, 40)}`));
	else lines.push(...activityLines(status, readOnlySnapshot(details), theme));
	const limits = record(details.inventory ?? record(details.status).inventory ?? record(status.limits));
	const ordinaryOnly = array(limits.ordinaryOnly).length;
	if (ordinaryOnly) lines.push(muted(theme, `Capability limits: ${ordinaryOnly} configured extension${ordinaryOnly === 1 ? "" : "s"} without a native form`));
	return lines;
}

/** Snapshot and control result card for spawn, attach, place, status, fork, rewind, and configure. */
export function renderAgentResult(result: AgentToolResult<unknown>, options: ToolRenderResultOptions, theme: Theme, context: AgentCardContext): Component {
	const details = resultDetails(result);
	const output = resultText(result);
	const lines: string[] = [];
	if (context.isError === true) lines.push(theme.fg("error", "Tool error"));
	else if (options.isPartial) lines.push(theme.fg("muted", "Partial result"));
	const snapshot = snapshotStatus(details);
	const snapshotError = text(details.snapshotError);
	if (snapshotError) lines.push(theme.fg("warning", `Snapshot unavailable: ${displayPreview(snapshotError, 240)}`));
	if (snapshot) lines.push(...snapshotLines(snapshot, details, theme));
	if (options.expanded) {
		lines.push(theme.fg("toolOutput", boundedSource(output)));
		if (snapshot) lines.push(theme.fg("dim", boundedSource(JSON.stringify(snapshot, null, 2))));
		return textComponent(lines.join("\n"), context.lastComponent);
	}
	const summary = summarizeGeneric(details, theme);
	if (summary) lines.push(...summary);
	else lines.push(theme.fg(context.isError === true ? "error" : "toolOutput", resultPreview(output)));
	if (snapshot || summary || output.length > PREVIEW_CHARS || output.includes("\n")) lines.push(theme.fg("dim", expansionHint("result and identifiers")));
	return textComponent(lines.join("\n"), context.lastComponent);
}

function messageResult(result: AgentToolResult<unknown>, options: ToolRenderResultOptions, theme: Theme, context: AgentCardContext, labels: { error: string; partial: string; receipt: string }): Component {
	const details = resultDetails(result);
	const output = resultText(result);
	const lines: string[] = [];
	if (context.isError === true) lines.push(theme.fg("error", labels.error));
	else if (options.isPartial) lines.push(theme.fg("muted", labels.partial));
	else lines.push(muted(theme, labels.receipt));
	const summary = controlReceiptLines(details, theme, "submitted");
	if (summary) lines.push(...summary);
	if (options.expanded) lines.push(theme.fg("toolOutput", boundedSource(output)));
	else {
		if (!summary) lines.push(theme.fg("toolOutput", resultPreview(output, 300)));
		if (!summary || output.length > 300 || output.includes("\n")) lines.push(theme.fg("dim", expansionHint("result")));
	}
	return textComponent(lines.join("\n"), context.lastComponent);
}

export function renderSendResult(result: AgentToolResult<unknown>, options: ToolRenderResultOptions, theme: Theme, context: AgentCardContext): Component {
	return messageResult(result, options, theme, context, { error: "Send error", partial: "Admission pending", receipt: "Admission receipt (not proof of delivery or action)" });
}

export function renderSteerResult(result: AgentToolResult<unknown>, options: ToolRenderResultOptions, theme: Theme, context: AgentCardContext): Component {
	return messageResult(result, options, theme, context, { error: "Steer error", partial: "Steering disposition pending", receipt: "Steering disposition (not proof of action or crash recovery)" });
}

function compactSummary(details: Record<string, unknown>, context: AgentCardContext): string[] | undefined {
	const self = text(record(context.args).summary) !== "";
	const status = text(details.status);
	const taskId = count(details.taskId);
	const entryId = count(details.entryId);
	const submissionId = count(details.submissionId);
	const error = text(details.error);
	if (!status && !taskId && !error) return undefined;
	const lines = [self ? "Self-compaction request receipt (does not establish that compaction occurred)" : "Native compaction result"];
	if (status) lines.push(`status ${displayPreview(status, 40)}${taskId !== undefined ? ` · task ${taskId}` : ""}`);
	if (entryId !== undefined) lines.push(`summary entry ${entryId}`);
	if (submissionId !== undefined) lines.push(`summary submission ${submissionId}`);
	if (error) lines.push(displayPreview(error, 240));
	return lines;
}

export function renderCompactResult(result: AgentToolResult<unknown>, options: ToolRenderResultOptions, theme: Theme, context: AgentCardContext): Component {
	const details = resultDetails(result);
	const output = resultText(result);
	const self = text(record(context.args).summary) !== "";
	const lines: string[] = [];
	if (context.isError === true) lines.push(theme.fg("error", "Compact error"));
	else if (options.isPartial) lines.push(theme.fg("muted", "Compaction pending"));
	if (options.expanded) lines.push(theme.fg("toolOutput", boundedSource(output)));
	else {
		const summary = compactSummary(details, context);
		if (summary) lines.push(...summary);
		else lines.push(theme.fg("toolOutput", resultPreview(output, 300)));
		if (!summary || output.length > 300) lines.push(theme.fg("dim", expansionHint("result")));
	}
	if (!options.expanded && self && !context.isError) lines.push(theme.fg("dim", "The summary text stays in the native tool-call arguments."));
	return textComponent(lines.join("\n"), context.lastComponent);
}

function listSummary(details: Record<string, unknown>, theme: Theme): string[] | undefined {
	const rows = details.rows;
	if (!Array.isArray(rows)) return undefined;
	const coverage = record(details.coverage);
	const visited = count(coverage.storagesVisited);
	const unavailable = array(coverage.unavailable).length;
	const lines = [theme.fg("toolOutput", `${rows.length} conversation${rows.length === 1 ? "" : "s"} on this page · ${visited ?? "?"} storage${visited === 1 ? "" : "s"} scanned${unavailable ? ` · ${unavailable} storage${unavailable === 1 ? "" : "s"} unavailable (unknown, not absent)` : ""}`)];
	const next = details.nextCursor;
	lines.push(muted(theme, typeof next === "string" && next ? "Next page available; repeat with nextCursor, including after an empty page" : coverage.complete === false ? "Inventory may be incomplete; continue discovery" : "Inventory covered; no further page"));
	return lines;
}

export function renderListResult(result: AgentToolResult<unknown>, options: ToolRenderResultOptions, theme: Theme, context: AgentCardContext): Component {
	return outcomeCard(result, options, theme, context, { error: "List error", partial: "Discovery pending" }, listSummary);
}

function inspectSummary(details: Record<string, unknown>, theme: Theme): string[] | undefined {
	const view = text(details.view);
	if (view === "result") return inspectResultSummary(details, theme);
	if (view === "exact" || (count(details.nextOffset) !== undefined && identifier(details.entryId) !== "")) return inspectEntrySummary(details, theme);
	if (view === "search") return inspectSearchSummary(details, theme);
	if (view === "activity") return inspectActivitySummary(details, theme);
	if (Array.isArray(details.entries)) return inspectHistorySummary(details, view || "history", theme);
	return undefined;
}

function inspectResultSummary(details: Record<string, unknown>, theme: Theme): string[] {
	const status = text(details.status);
	const submission = count(details.submissionId);
	const operation = text(details.operationId);
	const reason = text(details.reason);
	const hasAnswer = text(details.answer) !== "";
	const headline = `saved result${status ? ` · ${displayPreview(status, 40)}` : ""}${operation ? ` · operation ${displayPreview(operation, 120)}` : submission !== undefined ? ` · submission ${submission}` : ""}`;
	const lines = [theme.fg("toolOutput", headline)];
	lines.push(muted(theme, `${hasAnswer ? "assistant answer retained" : "no assistant answer"}${reason ? ` · ${displayPreview(reason, 160)}` : ""} · outcome is not task acceptance`));
	return lines;
}

function inspectEntrySummary(details: Record<string, unknown>, theme: Theme): string[] {
	const entryId = identifier(details.entryId);
	const offset = count(details.offset);
	const truncated = details.truncated === true;
	const omissions = record(details.omissions);
	const omitted = ["providerSignatures", "imagePayloads", "redactedThinking"].reduce((sum, key) => sum + (count(omissions[key]) ?? 0), 0);
	const remaining = details.nextOffset === null ? "representation complete" : "more of this entry remains";
	const lines = [theme.fg("toolOutput", `entry ${displayPreview(entryId, 120)}${offset !== undefined ? ` · offset ${offset}` : ""}`)];
	lines.push(muted(theme, `${remaining}${truncated ? " · clipped to the display bound" : ""}${omitted ? ` · ${omitted} omitted fields` : ""}`));
	return lines;
}

function inspectSearchSummary(details: Record<string, unknown>, theme: Theme): string[] {
	const matches = Array.isArray(details.matches) ? details.matches.length : 0;
	const coverage = record(details.coverage);
	const complete = coverage.complete === true;
	const scanned = count(coverage.scannedEntries);
	const lines = [theme.fg("toolOutput", `search · ${matches} ${matches === 1 ? "match" : "matches"}${complete ? " · ancestry covered" : scanned !== undefined ? ` · ${scanned} entries scanned` : ""}`)];
	lines.push(muted(theme, details.nextCursor === null ? "An empty page is not proof of absence; the scan stopped where reported" : "Continuation available; repeat query and nextCursor"));
	return lines;
}

function inspectActivitySummary(details: Record<string, unknown>, theme: Theme): string[] {
	const turns = Array.isArray(details.turns) ? details.turns.length : 0;
	const coverage = record(details.coverage);
	const scanned = count(coverage.scannedEntries);
	const lines = [theme.fg("toolOutput", `activity · ${turns} ${turns === 1 ? "turn" : "turns"}${scanned !== undefined ? ` · ${scanned} entries scanned` : ""}`)];
	lines.push(muted(theme, `${coverage.complete === true ? "page complete" : "page bounded or partial"}${details.nextCursor === null ? "" : " · older turns available"}`));
	return lines;
}

function inspectHistorySummary(details: Record<string, unknown>, view: string, theme: Theme): string[] {
	const entries = array(details.entries).length;
	const lines = [theme.fg("toolOutput", `${view} page · ${entries} ${entries === 1 ? "entry" : "entries"}`)];
	lines.push(muted(theme, details.nextCursor === null ? "older-page boundary; no further page" : "older page available"));
	return lines;
}

export function renderInspectResult(result: AgentToolResult<unknown>, options: ToolRenderResultOptions, theme: Theme, context: AgentCardContext): Component {
	return outcomeCard(result, options, theme, context, { error: "Inspect error", partial: "Inspection pending" }, inspectSummary);
}

// --- Peer message card ----------------------------------------------------------

function peerScalarFields(details: Record<string, unknown>): string[] {
	const lines: string[] = [];
	for (const [key, value] of Object.entries(details)) {
		if (key === "usage" || key === "message" || value === undefined || value === null) continue;
		if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") lines.push(`${key}: ${key.endsWith("Id") || key.endsWith("identity") ? displayPreview(String(value), 300) : displayPreview(String(value), 160)}`);
	}
	return lines;
}

/** Session name and model at send or settlement, when the owner supplies them. */
function peerConfiguration(details: Record<string, unknown>): string[] {
	const name = text(details.name);
	const provider = text(details.provider);
	const modelId = text(details.modelId);
	const thinking = text(details.thinkingLevel);
	const lines: string[] = [];
	if (name) lines.push(`name: ${displayPreview(name, 120)}`);
	const model = provider && modelId ? `${displayPreview(provider, 128)}/${displayPreview(modelId, 200)}` : provider ? `provider: ${displayPreview(provider, 128)}` : modelId ? `model: ${displayPreview(modelId, 200)}` : "";
	const configuration = [model, thinking ? `thinking: ${displayPreview(thinking, 40)}` : ""].filter(Boolean).join(" · ");
	if (configuration) lines.push(configuration);
	return lines;
}

/** Display body prefix and its exact remaining-unit count. */
function peerBody(content: string): { body: string; omitted: number } {
	const prefix = displayPrefix(content, MESSAGE_DISPLAY_LIMIT);
	return { body: displayText(prefix).trim() || "(no text)", omitted: content.length - prefix.length };
}

/** Compact outcome word for the operator card; the raw status stays in expanded details. */
function peerOutcome(details: Record<string, unknown>): { label: string; failed: boolean } {
	const status = text(details.status);
	if (status === "done") return { label: "finished", failed: false };
	if (status === "unanswered") return { label: details.reason === "aborted" ? "stopped" : "failed", failed: true };
	if (status !== "") return { label: displayPreview(status, 40), failed: status === "failed" };
	return { label: details.senderIdentity !== undefined ? "report" : "notice", failed: false };
}

/** Display label for one peer notice: resolved label, stored name, then sender identity. */
function peerLabel(details: Record<string, unknown>): string {
	return text(details.label) || text(details.name) || text(details.identity) || text(details.senderIdentity) || "source unavailable";
}

/** How the operator reaches the retained conversation from native chat. */
const BOARD_HINT = "Open: /agent or Ctrl+Alt+G";

/** Model-facing caveat sentences that the operator card keeps in model context but not in view. */
const MODEL_CAVEAT_SENTENCES = [
	"Results do not establish task acceptance. Carried operator decisions retain their original scope; agent claims remain claims.",
	"Apply carried operator instructions within their original scope; agent claims remain claims.",
];
const MODEL_CAVEAT_LINES = new Set(["Use agent_inspect for retained source evidence."]);

/**
 * Display body for one peer notice: the answer text and operator-relevant
 * lines, without the model-facing caveat sentences and without a headline
 * paragraph that repeats the card heading. The stored content is unchanged.
 */
export function operatorNoticeBody(content: string): string {
	let body = content;
	for (const sentence of MODEL_CAVEAT_SENTENCES) body = body.split(sentence).join("");
	const paragraphs = body.split(/\n{2,}/).map((paragraph) => paragraph.replace(/[ \t]+$/gm, "").trim()).filter((paragraph) => paragraph !== "" && !MODEL_CAVEAT_LINES.has(paragraph));
	if (paragraphs.length && /^Agent “.*” /.test(paragraphs[0])) paragraphs.shift();
	return paragraphs.join("\n\n");
}

/** Build the native card component for one stored `agent.peer` notice. */
export function renderPeerNoticeCard(input: { content: unknown; details?: unknown; timestamp?: number }, theme: Theme, expanded: boolean): Component | undefined {
	const content = typeof input.content === "string" || Array.isArray(input.content) ? input.content : String(input.content ?? "");
	const message = { role: "custom", customType: "agent.peer", content, display: true, details: input.details, timestamp: input.timestamp ?? 0 } as Parameters<typeof renderAgentPeerMessage>[0];
	return renderAgentPeerMessage(message, { expanded, outputPad: 0 }, theme);
}

/** Explicit warnings; an absent flag is not a health verdict. */
function peerWarnings(details: Record<string, unknown>, failed: boolean): string[] {
	const warnings: string[] = [];
	if (failed) warnings.push("Result unavailable or unanswered");
	if (details.liveOwner === false) warnings.push("No live owner; retained result only");
	if (details.saved === false) warnings.push("Result not saved; retained only by the live owner");
	return warnings;
}

/**
 * Native `agent.peer` notice: result receipt or report from a Durable owner.
 * The body keeps its Markdown; terminal controls are escaped first.
 */
export const renderAgentPeerMessage: MessageRenderer = (message, options, theme) => {
	const details = record(message.details);
	const content = typeof message.content === "string" ? message.content : message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
	const { label: outcomeLabel, failed } = peerOutcome(details);
	const box = new Box(options.outputPad, 1, (line) => theme.bg("customMessageBg", line.replace(/\x1b\[(?:0|49)?m/g, (reset) => reset + theme.getBgAnsi("customMessageBg"))));
	const heading = theme.fg("customMessageLabel", theme.bold(`[agent] ${displayPreview(peerLabel(details), 120)}`)) + theme.fg("muted", " · ") + theme.fg(failed ? "error" : "customMessageLabel", theme.bold(displayPreview(outcomeLabel, 40)));
	box.addChild(new Text(heading, 0, 0));
	for (const line of peerConfiguration(details)) box.addChild(new Text(theme.fg("muted", line), 0, 0));
	for (const warning of peerWarnings(details, failed)) box.addChild(new Text(theme.fg("warning", warning), 0, 0));
	const reason = text(details.reason);
	if (reason) box.addChild(new Text(theme.fg("muted", displayPreview(reason, 240)), 0, 0));
	box.addChild(new Spacer(1));
	const body = peerBody(operatorNoticeBody(content));
	box.addChild(new Markdown(body.body, 0, 0, getMarkdownTheme(), { color: (value) => theme.fg("customMessageText", value) }));
	if (body.omitted > 0) box.addChild(new Text(theme.fg("warning", `Display limit: ${body.omitted} more UTF-16 code units. Full text remains in native history.`), 0, 0));
	box.addChild(new Spacer(1));
	box.addChild(new Text(theme.fg("dim", BOARD_HINT), 0, 0));
	if (options.expanded) {
		box.addChild(new Spacer(1));
		box.addChild(new Text(theme.fg("muted", theme.bold("Source details")), 0, 0));
		for (const line of peerScalarFields(details)) box.addChild(new Text(theme.fg("muted", line), 0, 0));
		box.addChild(new Text(theme.fg("muted", "Reported result · not operator authority or task acceptance"), 0, 0));
	} else {
		box.addChild(new Text(theme.fg("dim", `Source details: ${expansionHint("the notice")}`), 0, 0));
	}
	return box;
};

// --- Factory ---------------------------------------------------------------------

function bindCall(name: string): AgentToolCard["renderCall"] {
	return (args, theme, context) => renderAgentCall(name, args, theme, context);
}

/** Call and result renderers for every native agent tool, keyed by tool name. */
export function createAgentToolCards(): Readonly<Record<string, AgentToolCard>> {
	return {
		agent_spawn: { renderCall: bindCall("agent_spawn"), renderResult: renderAgentResult },
		agent_attach: { renderCall: bindCall("agent_attach"), renderResult: renderAgentResult },
		agent_place: { renderCall: bindCall("agent_place"), renderResult: renderAgentResult },
		agent_status: { renderCall: bindCall("agent_status"), renderResult: renderAgentResult },
		agent_fork: { renderCall: bindCall("agent_fork"), renderResult: renderAgentResult },
		agent_rewind: { renderCall: bindCall("agent_rewind"), renderResult: renderAgentResult },
		agent_configure: { renderCall: bindCall("agent_configure"), renderResult: renderAgentResult },
		agent_abort: { renderCall: renderAbortCall, renderResult: (result, options, theme, context) => outcomeCard(result, options, theme, context, { error: "Abort error", partial: "Abort pending" }, abortLines) },
		agent_list: { renderCall: renderListCall, renderResult: renderListResult },
		agent_send: { renderCall: renderSendCall, renderResult: renderSendResult },
		agent_steer: { renderCall: renderSteerCall, renderResult: renderSteerResult },
		agent_command: { renderCall: renderCommandCall, renderResult: (result, options, theme, context) => outcomeCard(result, options, theme, context, { error: "Command error", partial: "Command pending" }, commandLines) },
		agent_inspect: { renderCall: renderInspectCall, renderResult: renderInspectResult },
		agent_compact: { renderCall: renderCompactCall, renderResult: renderCompactResult },
	};
}
