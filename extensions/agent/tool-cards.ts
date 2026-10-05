/**
 * Agent cards render tool call arguments and retained results from native
 * Durable observation values, plus the `agent.peer` message notices the
 * manager returns to the primary. Target labels use roster facts already
 * observed by the primary footer. Rendering opens no storage and changes
 * no execution behavior.
 */
import { stripVTControlCharacters } from "node:util";
import type { AgentConversationSummary } from "./dashboard-types.ts";
import { awaitFactLines, AwaitFactSchema } from "./await-facts.ts";
import { Value } from "typebox/value";
import type { AgentToolResult, MessageRenderer, Theme, ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme, keyText } from "@earendil-works/pi-coding-agent";
import { Box, Markdown, Spacer, Text, truncateToWidth, type Component } from "@earendil-works/pi-tui";

export type AgentCardLookup = () => readonly AgentConversationSummary[];

/** Bytes/units bounds for one expanded display block. */
export const SOURCE_DISPLAY_LIMIT = 32_000;
const MESSAGE_DISPLAY_LIMIT = 32_000;
const NOTICE_PREVIEW_LINES = 3;
const PREVIEW_UNITS = 600;

/** Card context: the subset of `ToolRenderContext` these renderers read. */
export interface AgentCardContext {
	readonly args?: unknown;
	readonly lookup?: AgentCardLookup;
	readonly state?: { callHint?: boolean; compaction?: Record<string, unknown>; compactFactsShown?: boolean; observation?: Record<string, unknown>; resultSeen?: unknown };
	readonly executionStarted?: boolean;
	readonly isPartial?: boolean;
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

/** Pi owns the row background; clipping must close text styles without ending it. */
function clipCardLine(line: string, width: number): string {
	return truncateToWidth(line, Math.max(0, width), "…")
		.replace(/\x1b\[0m…\x1b\[0m$/u, "…\x1b[22;23;24;25;27;28;29;39m");
}

class CardText extends Text {
	private source = "";
	expanded = false;
	override setText(value: string): void { this.source = value; super.setText(value); }
	override render(width: number): string[] {
		return this.expanded ? super.render(width) : this.source.split("\n").map((line) => clipCardLine(line, width));
	}
}

interface CardSections {
	readonly title?: string;
	readonly label?: string;
	readonly metadata?: readonly string[];
	readonly body?: readonly (string | Component)[];
	readonly outcome?: readonly string[];
	readonly hint?: string;
	readonly previewLines?: number;
}

interface CardLayoutOptions {
	readonly expanded: boolean;
	readonly previous?: Component;
	readonly peerPadding?: number;
}

/** Tool parts inherit Pi's Box(1,1); custom-message renderers must supply that inner vertical padding. */
function cardLayout(sections: CardSections, theme: Theme, options: CardLayoutOptions): Component {
	const header: string[] = [];
	const peer = options.peerPadding !== undefined;
	const labelColor = peer ? "text" : "accent";
	if (sections.title) header.push(theme.fg(peer ? "text" : "toolTitle", theme.bold(sections.title)) + (sections.label ? theme.fg(labelColor, ` · ${displayText(sections.label).replace(/\s+/gu, " ").trim()}`) : ""));
	const metadata = sections.metadata?.filter(Boolean).map((value) => displayText(value).replace(/\s+/gu, " ").trim()).join(" · ");
	if (metadata) header.push(theme.fg("muted", metadata));
	const content = sections.body ?? [];
	if (!peer) {
		const component = options.previous instanceof CardText ? options.previous : new CardText("", 0, 0);
		component.expanded = options.expanded;
		component.setText([...header, ...content.filter((line): line is string => typeof line === "string"), ...(sections.outcome ?? []), ...(sections.hint ? [theme.fg("muted", sections.hint)] : [])].join("\n"));
		return component;
	}
	const box = new Box(options.peerPadding, 1, (line) => theme.bg("customMessageBg", line.replace(/\x1b\[(?:0|49)?m/g, (reset) => reset + theme.getBgAnsi("customMessageBg"))));
	const body = {
		render(width: number) {
			const lines = content.flatMap((part) => typeof part === "string" ? new Text(part, 0, 0).render(width) : part.render(width));
			const limit = options.expanded ? lines.length : sections.previewLines ?? lines.length;
			const hidden = Math.max(0, lines.length - limit);
			return [...header.map((line) => clipCardLine(line, width)), ...(header.length ? [""] : []), ...lines.slice(0, limit), ...(sections.outcome ?? []), ...(hidden || sections.hint ? [clipCardLine(theme.fg("muted", sections.hint || expansionHint()), width)] : [])];
		},
		invalidate() { for (const part of content) if (typeof part !== "string") part.invalidate(); },
	};
	box.addChild(body);
	return box;
}

function expansionHint(): string {
	const key = keyText("app.tools.expand");
	return key ? `... (${key} to expand)` : "... (expand for full details)";
}

/** Calls own the hint before execution; results own it after execution starts. */
function cardHint(context: AgentCardContext, part: "call" | "result", _subject: string): string {
	if (context.expanded) return "";
	if (part === "call") {
		const shown = context.executionStarted !== true && context.argsComplete !== false;
		if (context.state) context.state.callHint = shown;
		return shown ? expansionHint() : "";
	}
	if (context.state?.callHint && context.executionStarted !== true) return "";
	return expansionHint();
}

function displayIdentity(identity: string): string {
	return displayText(identity);
}

function modelCaption(model: AgentConversationSummary["model"]): string {
	return model ? resolvedModelLine(model.provider, model.modelId, model.thinkingLevel ?? "") : "";
}

function targetConfiguration(identity: string, context: AgentCardContext): string {
	return displayText(modelCaption(findTarget(identity, context.lookup?.() ?? [])?.model));
}

function findTarget(identity: string, rows: readonly AgentConversationSummary[]): AgentConversationSummary | undefined {
	return rows.find((item) => item.id === identity || (identity.startsWith("@") && item.profile?.handle === identity));
}

function appendExpandedTarget(lines: string[], args: Record<string, unknown>, theme: Theme, context: AgentCardContext): void {
	if (!context.expanded) return;
	const identity = text(args.sessionId) || (text(args.handle) ? `@${text(args.handle).replace(/^@/u, "")}` : "");
	if (!identity) return;
	const fullIdentity = findTarget(identity, context.lookup?.() ?? [])?.id ?? identity;
	lines.push(theme.fg("dim", `Target: ${displayText(fullIdentity)}`));
}

function targetLabel(identity: string, context: AgentCardContext): string {
	if (!identity) return "";
	const rows = context.lookup?.() ?? [];
	const row = findTarget(identity, rows);
	if (!row) return displayIdentity(identity);
	const label = row.profile?.handle || row.name || row.id;
	const duplicate = !row.profile?.handle && row.name && rows.some((other) => other.id !== row.id && other.name === row.name && !other.profile?.handle && modelCaption(other.model) === modelCaption(row.model));
	return `${displayText(label)}${duplicate ? ` [${displayIdentity(row.id)}]` : ""}`;
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
	return record(firstDefined(record(result.details).structuredContent, result.structuredContent, result.details));
}

function resultPreview(value: string, limit = PREVIEW_UNITS): string {
	let output = value;
	try {
		const parsed = JSON.parse(value);
		if (parsed !== null && typeof parsed === "object") {
			const details = record(parsed);
			output = text(record(details.error).message) || text(details.error) || text(details.reason) || "Result received";
		}
	} catch { /* Plain output remains literal text. */ }
	return displayText(displayPrefix(output, limit).split("\n").slice(0, 3).join("\n"));
}

function callIdentity(context: AgentCardContext): string {
	const args = record(context.args);
	return text(args.sessionId) || (text(args.handle) ? `@${text(args.handle).replace(/^@/u, "")}` : "");
}

function sameTarget(identity: string, context: AgentCardContext): boolean {
	const requested = callIdentity(context);
	return identity !== "" && (identity === requested || identity === findTarget(requested, context.lookup?.() ?? [])?.id);
}

function targetSuffix(identity: string, context: AgentCardContext): string {
	const name = findTarget(identity, context.lookup?.() ?? [])?.name ?? "";
	return !context.expanded && (sameTarget(identity, context) || headerHasName(identity, name, context)) ? "" : ` · ${targetLabel(identity, context)}`;
}

function snapshotFacts(context: AgentCardContext, snapshot: Record<string, unknown> | undefined): AgentCardContext {
	if (!snapshot) return context;
	const identity = text(snapshot.identity) || text(snapshot.sessionId);
	if (!identity) return context;
	const agent = record(snapshot.agent);
	const model = record(agent.model);
	const previous = context.lookup?.() ?? [];
	const known = previous.find((row) => row.id === identity);
	const row: AgentConversationSummary = {
		id: identity, storageId: identity.split(":")[0], name: text(snapshot.name) || known?.name,
		profile: known?.profile, cwd: text(snapshot.cwd), modifiedAt: 0, owner: "unknown", state: "unavailable", cost: 0, partial: false,
		model: text(model.provider) && text(model.modelId) ? { provider: text(model.provider), modelId: text(model.modelId), thinkingLevel: text(agent.thinkingLevel) } : known?.model,
	};
	return { ...context, lookup: () => [row, ...previous.filter((item) => item.id !== identity)] };
}

function headerHasName(identity: string, name: string, context: AgentCardContext): boolean {
	const args = record(context.args);
	const observed = findTarget(callIdentity(context), context.lookup?.() ?? []);
	if (sameTarget(identity, context) && observed?.name === name) return true;
	return !callIdentity(context) && name !== "" && (args.name === name || args.topic === name);
}

function headerHasModel(identity: string, provider: string, modelId: string, thinking: string, context: AgentCardContext): boolean {
	if (!sameTarget(identity, context)) return false;
	const observed = findTarget(callIdentity(context), context.lookup?.() ?? [])?.model;
	return observed?.provider === provider && observed.modelId === modelId && observed.thinkingLevel === thinking;
}

// --- Call cards ------------------------------------------------------------------

const SUBJECT_KEYS = ["handle", "name", "topic", "area", "prompt", "correction", "sessionId"] as const;
const MODEL_CALLS = new Set(["agent_spawn", "agent_attach", "agent_place", "agent_fork", "agent_rewind", "agent_configure"]);

/** Requested configuration stays distinct from a resolved session snapshot. */
function requestedConfiguration(name: string, args: Record<string, unknown>, context: AgentCardContext): string | undefined {
	if (!MODEL_CALLS.has(name)) return undefined;
	const observed = findTarget(text(args.sessionId), context.lookup?.() ?? [])?.model;
	const model = text(args.model);
	const thinking = text(args.thinkingLevel);
	const parts: string[] = [];
	if (model && model !== `${observed?.provider}/${observed?.modelId}`) parts.push(displayText(model));
	if (thinking && thinking !== observed?.thinkingLevel) parts.push(displayPreview(thinking, 40));
	return parts.length ? `Requested: ${parts.join(" · ")}` : undefined;
}

/** True when a collapsed call hides or clips an argument. */
function argsHidden(args: Record<string, unknown>, subjectKey: string, subjectValue: string): boolean {
	if (subjectValue.length > 120) return true;
	const shown = new Set([subjectKey, "model", "thinkingLevel"].filter(Boolean));
	return Object.entries(args).some(([key, item]) => item !== undefined && !shown.has(key));
}

function argumentCard(name: string, subject: string, qualifier: string | undefined, args: Record<string, unknown>, theme: Theme, context: AgentCardContext, hidden: boolean): Component {
	const lines: string[] = [];
	appendExpandedTarget(lines, args, theme, context);
	if (context.expanded) lines.push(theme.fg("toolOutput", boundedSource(JSON.stringify(args, null, 2))));
	return cardLayout({ title: name, label: subject, metadata: [targetConfiguration(text(args.sessionId), context), qualifier ?? ""], body: lines, hint: hidden ? cardHint(context, "call", "arguments") : "" }, theme, { expanded: context.expanded, previous: context.lastComponent });
}

/** Generic call card for snapshot and control tools. */
export function renderAgentCall(name: string, value: unknown, theme: Theme, context: AgentCardContext): Component {
	const args = record(value);
	const subjectKey = text(args.sessionId) ? "sessionId" : SUBJECT_KEYS.find((key) => text(args[key]) !== "") ?? "";
	const subjectValue = subjectKey ? text(args[subjectKey]) : "";
	const identity = subjectKey === "handle" ? `@${subjectValue.replace(/^@/u, "")}` : subjectKey === "sessionId" ? subjectValue : "";
	const label = identity ? targetLabel(identity, context) : displayText(subjectValue);
	const lines: string[] = [];
	appendExpandedTarget(lines, args, theme, context);
	if (context.expanded) lines.push(theme.fg("toolOutput", boundedSource(JSON.stringify(args, null, 2))));
	return cardLayout({ title: name, label, metadata: [targetConfiguration(identity, context), requestedConfiguration(name, args, context) ?? ""], body: lines, hint: argsHidden(args, subjectKey, subjectValue) ? cardHint(context, "call", "arguments") : "" }, theme, { expanded: context.expanded, previous: context.lastComponent });
}

function renderAwaitCall(value: unknown, theme: Theme, context: AgentCardContext): Component {
	const args = record(value);
	const references = Array.isArray(args.results) ? args.results.slice(0, 16).map(record) : [];
	const lines = references.map((reference) => `${context.expanded ? displayText(text(reference.sessionId)) : targetLabel(text(reference.sessionId), context)} · submission ${String(reference.submissionId)}${text(reference.requestId) ? ` · request ${displayText(text(reference.requestId))}` : ""}`);
	return cardLayout({ title: "agent_await", label: targetLabel(text(references[0]?.sessionId), context), metadata: [targetConfiguration(text(references[0]?.sessionId), context)], body: lines.map((line) => theme.fg("toolOutput", line)), hint: cardHint(context, "call", "results") }, theme, { expanded: context.expanded, previous: context.lastComponent });
}

function messageMetadata(args: Record<string, unknown>, context: AgentCardContext): string[] {
	const reply = text(args.replyTo) ? targetLabel(text(args.replyTo), context) : "";
	return [targetConfiguration(text(args.sessionId), context), reply ? `reply to ${reply}` : "", text(args.mode) ? `mode ${displayText(text(args.mode))}` : ""];
}

function renderMessageCall(name: string, value: unknown, theme: Theme, context: AgentCardContext): Component {
	const args = record(value);
	const target = targetLabel(text(args.sessionId), context);
	const message = text(args.message);
	const lines: string[] = [];
	let hint = "";
	appendExpandedTarget(lines, args, theme, context);
	if (context.expanded) {
		lines.push(theme.fg("muted", context.argsComplete === false ? "Message so far:" : "Message:"));
		lines.push(theme.fg("toolOutput", boundedSource(message, MESSAGE_DISPLAY_LIMIT)));
		const metadata = { ...args, sessionId: undefined, message: undefined };
		if (Object.values(metadata).some((item) => item !== undefined)) lines.push(theme.fg("dim", boundedSource(JSON.stringify(metadata, null, 2))));
	} else {
		const preview = displayPreview(message, 180);
		lines.push(theme.fg("toolOutput", preview || (context.argsComplete === false ? "(message pending)" : "(empty or whitespace-only message)")));
		if ((preview !== message && message !== "") || target !== text(args.sessionId)) hint = cardHint(context, "call", "message");
	}
	return cardLayout({ title: name, label: target, metadata: messageMetadata(args, context), body: lines, hint }, theme, { expanded: context.expanded, previous: context.lastComponent });
}

export function renderSendCall(value: unknown, theme: Theme, context: AgentCardContext): Component {
	return renderMessageCall("agent_send", value, theme, context);
}

export function renderSteerCall(value: unknown, theme: Theme, context: AgentCardContext): Component {
	return renderMessageCall("agent_steer", value, theme, context);
}

function compactCallTarget(args: Record<string, unknown>, context: AgentCardContext): string {
	if (context.state?.compaction) return compactTarget(context.state.compaction);
	const target = text(args.sessionId) ? targetLabel(text(args.sessionId), context) : "(target pending)";
	return text(args.summary) ? `this session · ${target}` : target;
}

/** The summary argument selects the self path; execution refuses a mismatched session ID. */
export function renderCompactCall(value: unknown, theme: Theme, context: AgentCardContext): Component {
	const args = record(value);
	const facts = context.state?.compaction;
	const summary = text(args.summary);
	const lines: string[] = [];
	if (context.state) context.state.compactFactsShown = facts !== undefined;
	const configuration = facts ? compactConfiguration(facts) : targetConfiguration(text(args.sessionId), context);
	if (summary) lines.push(theme.fg("muted", context.expanded ? `Native compaction entry with the agent-authored summary (${summary.length} chars) at this tool batch's end` : `Summary: ${summary.length} chars`));
	else {
		lines.push(theme.fg("muted", context.expanded ? "Native summarization of the named conversation; it aborts active work and does not resume" : "Compacts after abort; leaves the agent idle"));
		lines.push(theme.fg("muted", `Summarizer instructions: ${text(args.instructions) ? "present" : "none"}`));
	}
	appendExpandedTarget(lines, args, theme, context);
	if (context.expanded) lines.push(theme.fg("toolOutput", boundedSource(JSON.stringify(args, null, 2))));
	return cardLayout({ title: "agent_compact", label: compactCallTarget(args, context), metadata: [configuration], body: lines, hint: summary || text(args.instructions) ? cardHint(context, "call", "arguments") : "" }, theme, { expanded: context.expanded, previous: context.lastComponent });
}

function intentObservation(details: Record<string, unknown>): Record<string, unknown> | undefined {
	const published = record(details.published);
	const identity = text(published.id);
	return identity ? { identity, name: published.name, agent: { model: published.model, thinkingLevel: published.thinkingLevel } } : undefined;
}

function renderIntentCall(value: unknown, theme: Theme, context: AgentCardContext): Component {
	const args = record(value);
	const identity = text(context.state?.observation?.identity);
	const lines: string[] = [];
	if (context.expanded) {
		if (identity) lines.push(theme.fg("dim", `Target: ${displayIdentity(identity)}`));
		lines.push(theme.fg("toolOutput", boundedSource(JSON.stringify(args, null, 2))));
	} else if (text(args.purpose)) lines.push(theme.fg("toolOutput", displayPreview(text(args.purpose), 180)));
	return cardLayout({ title: "agent_intent", label: identity ? targetLabel(identity, context) : "this session", metadata: [targetConfiguration(identity, context), text(args.action) ? `action ${displayText(text(args.action))}` : ""], body: lines, hint: cardHint(context, "call", "arguments") }, theme, { expanded: context.expanded, previous: context.lastComponent });
}

function intentLines(details: Record<string, unknown>, theme: Theme, context: AgentCardContext): string[] | undefined {
	const published = record(details.published);
	const identity = text(published.id);
	if (!identity || context.isError === true || context.isPartial === true) return undefined;
	const outcome = published.intentClaim === undefined ? "Intent cleared" : "Intent published";
	return [theme.fg("toolOutput", `${outcome} · ${displayIdentity(identity)}`)];
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
	const qualifier = count(args.timerId) !== undefined ? `timer ${args.timerId}` : args.background === true ? "background tasks" : undefined;
	return argumentCard("agent_abort", target ? targetLabel(target, context) : "(target pending)", qualifier, args, theme, context, target.length > 300 || args.trust !== undefined);
}

export function renderCommandCall(value: unknown, theme: Theme, context: AgentCardContext): Component {
	const args = record(value);
	const name = text(args.name);
	const target = text(args.sessionId);
	const subject = `${name ? displayPreview(name, 120) : "(command pending)"} → ${target ? targetLabel(target, context) : "(target pending)"}`;
	const commandArgs = text(args.args);
	return argumentCard("agent_command", subject, commandArgs ? `args ${displayPreview(commandArgs, 200)}` : undefined, args, theme, context, name.length > 120 || target.length > 300 || commandArgs.length > 200);
}

function inspectQualifier(args: Record<string, unknown>): { qualifier: string; hidden: boolean } {
	const parts = [`view ${text(args.view) || "history"}`];
	let hidden = false;
	const push = (label: string, key: string, limit: number) => {
		const value = text(args[key]);
		if (!value) return;
		parts.push(`${label} ${key.endsWith("Id") ? displayIdentity(value) : displayPreview(value, limit)}`);
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
	return argumentCard("agent_inspect", target ? targetLabel(target, context) : "(target pending)", qualifier, args, theme, context, hidden || target.length > 300);
}

// --- Result cards ----------------------------------------------------------------

function outcomeCard(result: AgentToolResult<unknown>, options: ToolRenderResultOptions, theme: Theme, context: AgentCardContext, labels: { error: string; partial: string }, summarize: (details: Record<string, unknown>, theme: Theme, context: AgentCardContext) => string[] | undefined): Component {
	const details = resultDetails(result);
	const output = resultText(result);
	const lines: string[] = [];
	if (context.isError === true) lines.push(theme.fg("error", labels.error));
	else if (options.isPartial) lines.push(theme.fg("muted", labels.partial));
	if (options.expanded) lines.push(theme.fg("toolOutput", boundedSource(output)));
	else {
		const summary = summarize(details, theme, context);
		if (summary) lines.push(...summary);
		else lines.push(theme.fg(context.isError === true ? "error" : "toolOutput", resultPreview(output)));
	}
	return cardLayout({ body: lines, hint: options.expanded ? "" : cardHint(context, "result", "result") }, theme, { expanded: options.expanded, previous: context.lastComponent });
}

function muted(theme: Theme, value: string): string {
	return theme.fg("muted", value);
}

function controlReceiptLines(details: Record<string, unknown>, theme: Theme, subject: string, context: AgentCardContext): string[] | undefined {
	const identity = text(details.identity);
	const conversationId = count(details.conversationId);
	if (!identity && conversationId === undefined) return undefined;
	const lines = [theme.fg("toolOutput", `${subject}${identity ? targetSuffix(identity, context) : conversationId !== undefined ? ` · conversation ${conversationId}` : ""}`)];
	const submission = count(details.submissionId);
	if (submission !== undefined) lines[0] += muted(theme, ` · submission ${submission}`);
	if (details.deduped === true) lines.push(muted(theme, "Already admitted"));
	return lines;
}

function receiptLines(details: Record<string, unknown>, theme: Theme, context: AgentCardContext): string[] | undefined {
	if (count(details.submissionId) === undefined || text(details.identity) === "") return undefined;
	return controlReceiptLines(details, theme, "Admitted", context);
}

function forkLines(details: Record<string, unknown>, theme: Theme, context: AgentCardContext): string[] | undefined {
	if (text(details.identity) === "" || details.deduped === undefined || count(details.conversationId) === undefined || count(details.submissionId) !== undefined) return undefined;
	return controlReceiptLines(details, theme, "Fork created", context);
}

function rewindLines(details: Record<string, unknown>, theme: Theme, context: AgentCardContext): string[] | undefined {
	if (count(details.predecessorEntryId) === undefined || text(details.identity) === "") return undefined;
	const lines = controlReceiptLines(details, theme, "Rewind submitted", context) ?? [];
	const predecessor = count(details.predecessorEntryId);
	if (predecessor !== undefined) lines.push(muted(theme, `forked before entry ${predecessor}`));
	return lines;
}

function configureLines(details: Record<string, unknown>, theme: Theme, context: AgentCardContext): string[] | undefined {
	if (text(details.identity) === "" || count(details.conversationId) === undefined) return undefined;
	return [theme.fg("toolOutput", `Configuration applied${targetSuffix(text(details.identity), context)}`)];
}

function timerLines(details: Record<string, unknown>, theme: Theme, context: AgentCardContext): string[] | undefined {
	const timer = count(details.timerId);
	if (timer === undefined) return undefined;
	const deadline = count(details.deadline);
	if (deadline !== undefined) {
		const date = new Date(deadline);
		const when = Number.isFinite(date.getTime()) ? date.toISOString() : "deadline unavailable";
		return [muted(theme, `Scheduled${text(details.identity) ? targetSuffix(text(details.identity), context) : ""} · timer ${timer} · ${when}`)];
	}
	const status = text(details.status);
	if (!status) return undefined;
	const label = record(context.args).timerId === timer ? "Timer" : `Timer ${timer}`;
	return [muted(theme, `${label} ${displayPreview(status, 40)}${details.outcome === "unchanged" ? " · unchanged" : ""}`)];
}

function abortLines(details: Record<string, unknown>, theme: Theme, context: AgentCardContext): string[] | undefined {
	const timer = timerLines(details, theme, context);
	if (timer) return timer;
	if (text(details.identity) === "" || details.background === undefined) return undefined;
	const lines = [theme.fg("toolOutput", `Abort requested${targetSuffix(text(details.identity), context)}`)];
	if (details.background === true && record(context.args).background !== true) lines.push(muted(theme, "Includes background task trees"));
	return lines;
}

function commandLines(details: Record<string, unknown>, theme: Theme, context: AgentCardContext): string[] | undefined {
	const reloaded = details.reloaded === true;
	const textValue = text(details.text);
	const identity = text(details.identity);
	const name = text(details.name);
	if (!reloaded && !textValue && !identity && !name) return undefined;
	const lines = [theme.fg("toolOutput", reloaded ? "Host registrations reloaded" : resultPreview(textValue || "(no command output text)", 240))];
	const inventory = record(details.inventory);
	const capabilities = array(inventory.contributions).length;
	if (reloaded && capabilities > 0) lines.push(muted(theme, `${capabilities} native contribution${capabilities === 1 ? "" : "s"} installed`));
	if (name && name !== record(context.args).name) lines.push(muted(theme, `command ${displayPreview(name, 120)}`));
	if (identity && !sameTarget(identity, context)) lines.push(muted(theme, targetLabel(identity, context)));
	return lines;
}

function sessionSummaryLines(sessions: Record<string, unknown>[], theme: Theme): string[] {
	const working = sessions.filter((row) => row.state === "working").length;
	const cost = sessions.reduce((sum, row) => sum + (count(row.cost) ?? 0), 0);
	const partial = sessions.some((row) => row.partial === true);
	const lines = [theme.fg("toolOutput", `${sessions.length} conversation${sessions.length === 1 ? "" : "s"} · ${working} working · $${cost.toFixed(2)}${partial ? "+" : ""}`)];
	for (const row of sessions.slice(0, 4)) lines.push(muted(theme, `${text(row.name) ? displayPreview(text(row.name), 120) : displayIdentity(text(row.id)) || "conversation"} · ${text(row.state) || "unknown state"}`));
	if (sessions.length > 4) lines.push(muted(theme, `${sessions.length - 4} more conversation records`));
	return lines;
}

function conversationListLines(conversations: Record<string, unknown>[], theme: Theme): string[] {
	const busy = conversations.filter((row) => row.busy === true || Object.keys(record(record(row.live).run)).length > 0).length;
	const lines = [theme.fg("toolOutput", `${conversations.length} conversation${conversations.length === 1 ? "" : "s"} · ${busy} working`)];
	for (const row of conversations.slice(0, 4)) lines.push(muted(theme, `${text(row.name) ? displayPreview(text(row.name), 120) : displayIdentity(text(row.identity)) || "conversation"} · ${row.busy === true ? "working" : "idle"}`));
	if (conversations.length > 4) lines.push(muted(theme, `${conversations.length - 4} more conversation records`));
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

function summarizeGeneric(details: Record<string, unknown>, theme: Theme, context: AgentCardContext): string[] | undefined {
	return resolveProfileLines(details, theme, context)
		?? statusOverviewLines(details, theme)
		?? rewindLines(details, theme, context)
		?? forkLines(details, theme, context)
		?? receiptLines(details, theme, context)
		?? abortLines(details, theme, context)
		?? configureLines(details, theme, context)
		?? commandLines(details, theme, context);
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
	const parts = [`Running: ${displayPreview(text(slot.name) || "tool", 100)}`, `call ${displayIdentity(text(slot.callId) || "unknown")}`];
	if (slot.status === "pending") parts.push("pending");
	return parts.join(" · ");
}

function latestSavedResult(submissions: unknown): string | undefined {
	const rows = array(submissions).map(record).filter((row) => row.type === "input" && (row.status === "done" || row.status === "unanswered"));
	const last = rows.at(-1);
	if (!last) return undefined;
	const id = count(last.id);
	return `Saved: ${text(last.status)}${id === undefined ? "" : ` · submission ${id}`}`;
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
	if (status.awaiting !== undefined) return Value.Check(AwaitFactSchema, status.awaiting) ? awaitFactLines(status.awaiting).map((line) => muted(theme, displayText(line))) : [muted(theme, "Await state unavailable: invalid native fact")];
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
	if (running.length > 4) lines.push(muted(theme, `${running.length - 4} more running tools`));
	// The status contract carries no role for this text, so the label reports the state only.
	const lastText = text(status.lastText);
	if (lastText) lines.push(theme.fg("toolOutput", `${newestTextLabel(working, text(status.lastTextRole))}: ${displayPreview(lastText, 240)}`));
	const saved = latestSavedResult(status.submissions);
	if (saved) lines.push(muted(theme, saved));
	lines.push(...retryLines(live, theme));
	return lines;
}

function snapshotLabel(identity: string, name: string, context: AgentCardContext): string {
	return name ? displayPreview(name, 120) : targetLabel(identity, context);
}

function resolvedModelLine(provider: string, modelId: string, thinking: string): string {
	const model = provider && modelId ? `${provider}/${modelId}` : provider || modelId;
	return [displayText(model), displayText(thinking)].filter(Boolean).join(" · ");
}

function snapshotIdentityLines(status: Record<string, unknown>, theme: Theme, context: AgentCardContext, namedByReceipt: boolean): string[] {
	const agent = record(status.agent);
	const model = record(agent.model);
	const provider = text(model.provider);
	const modelId = text(model.modelId);
	const thinking = text(agent.thinkingLevel);
	const name = text(status.name);
	const identity = text(status.identity) || text(status.sessionId);
	const lines: string[] = [];
	const hideName = !context.expanded && (namedByReceipt || headerHasName(identity, name, context));
	const hideModel = !context.expanded && headerHasModel(identity, provider, modelId, thinking, context);
	if ((name || identity) && !hideName) lines.push(theme.fg("accent", snapshotLabel(identity, name, context)));
	const configuration = resolvedModelLine(provider, modelId, thinking);
	if (!hideModel && configuration) lines.push(muted(theme, configuration));
	return lines;
}

function snapshotLines(status: Record<string, unknown>, details: Record<string, unknown>, theme: Theme, context: AgentCardContext, namedByReceipt = false): string[] {
	const lines = snapshotIdentityLines(status, theme, context, namedByReceipt);
	if (status.live === undefined && typeof status.state === "string") lines.push(muted(theme, `State: ${displayPreview(status.state, 40)}`));
	else lines.push(...activityLines(status, readOnlySnapshot(details), theme));
	const limits = record(details.inventory ?? record(details.status).inventory ?? record(status.limits));
	const ordinaryOnly = array(limits.ordinaryOnly).length;
	if (ordinaryOnly) lines.push(muted(theme, `Capability limits: ${ordinaryOnly} configured extension${ordinaryOnly === 1 ? "" : "s"} without a native form`));
	return lines;
}

/** Snapshot and control result card for spawn, attach, place, status, fork, rewind, and configure. */
function nestedReceiptLines(details: Record<string, unknown>, theme: Theme, context: AgentCardContext): string[] | undefined {
	const admission = record(details.admission);
	if (count(admission.submissionId) === undefined) return undefined;
	const snapshot = snapshotStatus(details);
	const identity = text(admission.identity) || text(details.sessionId) || text(snapshot?.identity);
	const receiptContext = identity === text(snapshot?.identity) ? { ...context, args: { ...record(context.args), sessionId: identity } } : context;
	return controlReceiptLines({ ...admission, identity }, theme, "Admitted", receiptContext);
}

function collapsedAgentLines(details: Record<string, unknown>, output: string, theme: Theme, context: AgentCardContext): string[] {
	const snapshot = snapshotStatus(details);
	const observed = snapshotFacts(context, snapshot);
	const summary = summarizeGeneric(details, theme, observed) ?? nestedReceiptLines(details, theme, observed);
	const identity = text(details.identity);
	const snapshotIdentity = text(snapshot?.identity) || text(snapshot?.sessionId);
	const namedByReceipt = summary !== undefined && identity !== "" && identity === snapshotIdentity && !sameTarget(identity, context) && !headerHasName(identity, text(snapshot?.name), context);
	const lines = snapshot ? snapshotLines(snapshot, details, theme, context, namedByReceipt) : [];
	if (summary) lines.push(...summary);
	else if (!snapshot) lines.push(theme.fg(context.isError === true ? "error" : "toolOutput", resultPreview(output)));
	return lines;
}
export function renderAgentResult(result: AgentToolResult<unknown>, options: ToolRenderResultOptions, theme: Theme, context: AgentCardContext): Component {
	const details = resultDetails(result);
	const output = resultText(result);
	const lines: string[] = [];
	if (context.isError === true) lines.push(theme.fg("error", "Tool error"));
	else if (options.isPartial) lines.push(theme.fg("muted", "Partial result"));
	const snapshot = snapshotStatus(details);
	const snapshotError = text(details.snapshotError);
	if (snapshotError) lines.push(theme.fg("warning", `Snapshot unavailable: ${displayPreview(snapshotError, 240)}`));
	const deliveryError = text(details.deliveryError) || text(record(details.status).deliveryError);
	if (deliveryError) lines.push(theme.fg("warning", `Delivery paused: ${displayPreview(deliveryError, 240)}`));
	if (options.expanded) {
		if (snapshot) lines.push(...snapshotLines(snapshot, details, theme, { ...context, expanded: true }));
		lines.push(theme.fg("toolOutput", boundedSource(output)));
		if (snapshot) lines.push(theme.fg("dim", boundedSource(JSON.stringify(snapshot, null, 2))));
		return cardLayout({ body: lines }, theme, { expanded: true, previous: context.lastComponent });
	}
	lines.push(...collapsedAgentLines(details, output, theme, context));
	return cardLayout({ body: lines, hint: cardHint(context, "result", "details") }, theme, { expanded: false, previous: context.lastComponent });
}

function primaryMessageLines(details: Record<string, unknown>, theme: Theme, context: AgentCardContext): string[] | undefined {
	if (details.admitted !== true || !text(details.sessionId)) return undefined;
	const kind = record(context.args).mode === "report" ? "Report" : "Message";
	return [theme.fg("toolOutput", `${kind} delivered to ${targetLabel(text(details.sessionId), context)}`)];
}

function messageResult(result: AgentToolResult<unknown>, options: ToolRenderResultOptions, theme: Theme, context: AgentCardContext, labels: { error: string; partial: string; receipt: string }): Component {
	const details = resultDetails(result);
	const output = resultText(result);
	const lines: string[] = [];
	if (context.isError === true) lines.push(theme.fg("error", labels.error));
	else if (options.isPartial) lines.push(theme.fg("muted", labels.partial));
	const summary = primaryMessageLines(details, theme, context) ?? timerLines(details, theme, context) ?? controlReceiptLines(details, theme, labels.receipt, context);
	if (summary) lines.push(...summary);
	if (options.expanded) lines.push(theme.fg("toolOutput", boundedSource(output)));
	else {
		if (!summary) lines.push(theme.fg("toolOutput", resultPreview(output, 300)));
	}
	const identity = text(details.identity) || text(details.sessionId);
	return cardLayout({ metadata: [sameTarget(identity, context) ? "" : targetConfiguration(identity, context)], outcome: lines, hint: options.expanded ? "" : cardHint(context, "result", "result") }, theme, { expanded: options.expanded, previous: context.lastComponent });
}

export function renderSendResult(result: AgentToolResult<unknown>, options: ToolRenderResultOptions, theme: Theme, context: AgentCardContext): Component {
	return messageResult(result, options, theme, context, { error: "Send error", partial: "Admission pending", receipt: "Admitted" });
}

export function renderSteerResult(result: AgentToolResult<unknown>, options: ToolRenderResultOptions, theme: Theme, context: AgentCardContext): Component {
	return messageResult(result, options, theme, context, { error: "Steer error", partial: "Steering disposition pending", receipt: "Steer admitted" });
}

function compactTarget(facts: Record<string, unknown>): string {
	const identity = text(facts.identity);
	const name = text(facts.name);
	return facts.self === true ? `this session${name ? ` · ${displayText(name)}` : ` · ${displayIdentity(identity)}`}` : displayText(name || identity);
}

function compactConfiguration(facts: Record<string, unknown>): string {
	return resolvedModelLine(text(facts.provider), text(facts.modelId), text(facts.thinkingLevel));
}

function compactFactLines(facts: Record<string, unknown>, showTarget: boolean): string[] {
	const lines: string[] = [];
	if (showTarget) {
		if (compactTarget(facts)) lines.push(`Target: ${compactTarget(facts)}`);
		const configuration = compactConfiguration(facts);
		if (configuration) lines.push(configuration);
	}
	const before = record(facts.before);
	const tokens = count(before.tokens), window = count(before.contextWindow), percent = count(before.percent);
	const parts = [tokens === undefined ? "" : `${tokens} tokens`, window === undefined ? "" : `${window} window`, percent === undefined ? "" : `${percent.toFixed(1)}%`].filter(Boolean);
	if (parts.length) lines.push(`Before: ${parts.join(" · ")}`);
	if (facts.self !== true && count(facts.summaryChars) !== undefined) lines.push(`Summary: ${facts.summaryChars} chars`);
	if (text(facts.metadataError)) lines.push(`Metadata read failed: ${displayPreview(text(facts.metadataError), 240)}`);
	return lines;
}

function compactSummary(details: Record<string, unknown>, context: AgentCardContext): string[] | undefined {
	const self = text(record(context.args).summary) !== "";
	const status = text(details.status);
	const taskId = count(details.taskId);
	const entryId = count(details.entryId);
	const submissionId = count(details.submissionId);
	const error = text(details.error);
	if (!status && !taskId && !error) return undefined;
	const lines = [`${self ? "Summary" : "Compaction"} ${displayPreview(status === "task" ? "admitted" : status || "pending", 40)}${taskId !== undefined ? ` · task ${taskId}` : ""}${submissionId !== undefined ? ` · submission ${submissionId}` : ""}`];
	if (entryId !== undefined) lines.push(`summary entry ${entryId}`);
	if (error) lines.push(displayPreview(error, 240));
	if (text(details.summarySizeError)) lines.push(`Summary size read failed: ${displayPreview(text(details.summarySizeError), 240)}`);
	return lines;
}

function rememberCompactionFacts(received: Record<string, unknown>, context: AgentCardContext): Record<string, unknown> {
	if (Object.keys(received).length && context.state && context.state.compaction === undefined) context.state.compaction = received;
	return context.state?.compaction ?? received;
}

export function renderCompactResult(result: AgentToolResult<unknown>, options: ToolRenderResultOptions, theme: Theme, context: AgentCardContext): Component {
	const details = resultDetails(result);
	const output = resultText(result);
	const received = record(details.compaction);
	const facts = rememberCompactionFacts(received, context);
	const lines: string[] = [];
	if (context.isError === true) lines.push(theme.fg("error", "Compact error"));
	else if (options.isPartial) lines.push(theme.fg("muted", "Compaction pending"));
	if (options.expanded) {
		lines.push(...compactFactLines(facts, true).map((line) => muted(theme, line)));
		lines.push(theme.fg("toolOutput", boundedSource(output)));
		if (Object.keys(received).length) lines.push(theme.fg("dim", boundedSource(JSON.stringify(received, null, 2))));
	} else {
		const summary = compactSummary(details, context);
		if (summary) lines.push(...summary);
		else lines.push(theme.fg("toolOutput", resultPreview(output, 300)));
		lines.push(...compactFactLines(facts, context.state?.compactFactsShown !== true).map((line) => muted(theme, line)));
	}
	return cardLayout({ outcome: lines, hint: options.expanded ? "" : cardHint(context, "result", "result") }, theme, { expanded: options.expanded, previous: context.lastComponent });
}

function listedProfiles(rows: unknown[], theme: Theme): string[] {
	const lines = rows.slice(0, 4).flatMap((value) => {
		const row = record(value);
		return [
			theme.fg("accent", text(row.handle) || text(row.name) ? displayPreview([text(row.handle), text(row.name)].filter(Boolean).join(" · "), 160) : displayIdentity(text(row.identity))),
			muted(theme, typeof row.role === "string" ? `Role: ${displayPreview(row.role, 180) || "(empty)"}` : "Role: unknown profile coverage"),
		];
	});
	if (rows.length > 4) lines.push(muted(theme, `${rows.length - 4} more rows`));
	return lines;
}
function listSummary(details: Record<string, unknown>, theme: Theme): string[] | undefined {
	const rows = details.rows;
	if (!Array.isArray(rows)) return undefined;
	const coverage = record(details.coverage);
	const visited = count(coverage.storagesVisited);
	const unavailable = array(coverage.unavailable).length;
	const lines = [theme.fg("toolOutput", `${rows.length} conversation${rows.length === 1 ? "" : "s"} on this page · ${visited ?? "?"} storage${visited === 1 ? "" : "s"} scanned${unavailable ? ` · ${unavailable} storage${unavailable === 1 ? "" : "s"} unavailable (unknown, not absent)` : ""}`)];
	const profiles = record(coverage.profileHints);
	if (profiles.complete === false) lines.push(theme.fg("warning", `Profile search incomplete · ${count(profiles.unknownStorages) ?? "?"} stores with unknown hints · ${count(profiles.omitted) ?? "?"} omitted hints`));
	lines.push(...listedProfiles(rows, theme));
	const next = details.nextCursor;
	lines.push(muted(theme, typeof next === "string" && next ? "Next page available; repeat with nextCursor, including after an empty page" : coverage.complete === false ? "Inventory may be incomplete; continue discovery" : "Inventory covered; no further page"));
	return lines;
}

function profileRouteLines(profile: Record<string, unknown>, theme: Theme): string[] {
	const omitted = count(profile.requestsOmitted) ?? 0;
	return [
		muted(theme, `Expertise: ${text(profile.expertise) ? "saved" : "empty"} · ${array(profile.requests).length} ${omitted > 0 ? "shown" : "active"} request routes`),
		...(omitted > 0 ? [theme.fg("warning", `Request routes omitted: ${omitted}`)] : []),
	];
}
function profileIdentityLines(details: Record<string, unknown>, profile: Record<string, unknown>, theme: Theme, context: AgentCardContext): string[] {
	const model = record(profile.model);
	const identity = text(profile.identity);
	const sameName = headerHasName(identity, text(profile.name), context);
	const sameModel = headerHasModel(identity, text(model.provider), text(model.modelId), text(profile.thinkingLevel), context);
	const configuration = resolvedModelLine(text(model.provider), text(model.modelId), text(profile.thinkingLevel));
	return [
		...(!sameName || details.outcome ? [theme.fg(details.outcome === "conflict" ? "warning" : "accent", `${details.outcome === "conflict" ? "Profile conflict; no change" : details.outcome === "applied" ? "Profile saved" : "Profile"} · ${text(profile.handle) || text(profile.name) ? displayPreview(text(profile.handle) || text(profile.name), 160) : displayIdentity(text(profile.identity))}`)] : []),
		...(!sameModel && configuration ? [muted(theme, configuration)] : []),
	];
}

function profileLines(details: Record<string, unknown>, theme: Theme, context: AgentCardContext): string[] | undefined {
	const profile = typeof details.outcome === "string" ? record(details.profile) : details;
	if (typeof profile.revision !== "string" || typeof profile.role !== "string") return undefined;
	return [
		...profileIdentityLines(details, profile, theme, context),
		muted(theme, `Role: ${displayPreview(text(profile.role), 240) || "(empty)"}`),
		muted(theme, `Revision: ${displayIdentity(text(profile.revision))} · ${profile.live === true ? "live host" : "retained"}`),
		...profileRouteLines(profile, theme),
	];
}
function resolveProfileLines(details: Record<string, unknown>, theme: Theme, context: AgentCardContext): string[] | undefined {
	if (typeof details.created !== "boolean") return undefined;
	const lines = profileLines(record(details.profile), theme, context) ?? profileLines(details, theme, context);
	return lines ? [theme.fg("toolOutput", details.created ? "Agent created" : "Agent reused"), ...lines] : undefined;
}
export function renderProfileResult(result: AgentToolResult<unknown>, options: ToolRenderResultOptions, theme: Theme, context: AgentCardContext): Component {
	return outcomeCard(result, options, theme, context, { error: "Profile error", partial: "Profile pending" }, profileLines);
}

export function renderListResult(result: AgentToolResult<unknown>, options: ToolRenderResultOptions, theme: Theme, context: AgentCardContext): Component {
	return outcomeCard(result, options, theme, context, { error: "List error", partial: "Discovery pending" }, listSummary);
}

function inspectSummary(details: Record<string, unknown>, theme: Theme, context: AgentCardContext): string[] | undefined {
	const view = text(details.view);
	if (view === "result") return inspectResultSummary(details, theme, context);
	if (view === "exact" || (count(details.nextOffset) !== undefined && identifier(details.entryId) !== "")) return inspectEntrySummary(details, theme);
	if (view === "search") return inspectSearchSummary(details, theme);
	if (view === "activity") return inspectActivitySummary(details, theme);
	if (Array.isArray(details.entries)) return inspectHistorySummary(details, view || "history", theme);
	return undefined;
}

function inspectResultSummary(details: Record<string, unknown>, theme: Theme, context: AgentCardContext): string[] {
	const status = text(details.status);
	const args = record(context.args);
	const submission = identifier(args.submissionId) === identifier(details.submissionId) ? undefined : count(details.submissionId);
	const operation = args.operationId === details.operationId ? "" : text(details.operationId);
	const reason = text(details.reason);
	const hasAnswer = text(details.answer) !== "";
	const headline = `saved result${status ? ` · ${displayPreview(status, 40)}` : ""}${operation ? ` · operation ${displayIdentity(operation)}` : submission !== undefined ? ` · submission ${submission}` : ""}`;
	const lines = [theme.fg("toolOutput", headline)];
	lines.push(muted(theme, `${hasAnswer ? "assistant answer retained" : "no assistant answer"}${reason ? ` · ${displayPreview(reason, 160)}` : ""}`));
	return lines;
}

function inspectEntrySummary(details: Record<string, unknown>, theme: Theme): string[] {
	const entryId = identifier(details.entryId);
	const offset = count(details.offset);
	const truncated = details.truncated === true;
	const omissions = record(details.omissions);
	const omitted = ["providerSignatures", "imagePayloads", "redactedThinking"].reduce((sum, key) => sum + (count(omissions[key]) ?? 0), 0);
	const remaining = details.nextOffset === null ? "representation complete" : "more of this entry remains";
	const lines = [theme.fg("toolOutput", `entry ${displayIdentity(entryId)}${offset !== undefined ? ` · offset ${offset}` : ""}`)];
	lines.push(muted(theme, `${remaining}${truncated ? " · clipped to the display bound" : ""}${omitted ? ` · ${omitted} omitted fields` : ""}`));
	return lines;
}

function inspectSearchSummary(details: Record<string, unknown>, theme: Theme): string[] {
	const matches = Array.isArray(details.matches) ? details.matches.length : 0;
	const coverage = record(details.coverage);
	const complete = coverage.complete === true;
	const scanned = count(coverage.scannedEntries);
	const lines = [theme.fg("toolOutput", `search · ${matches} ${matches === 1 ? "match" : "matches"}${complete ? " · ancestry covered" : scanned !== undefined ? ` · ${scanned} entries scanned` : ""}`)];
	lines.push(muted(theme, details.nextCursor === null ? "No continuation" : "Continuation available"));
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

function renderCollaborateCall(value: unknown, theme: Theme, context: AgentCardContext): Component {
	const args = record(value);
	const thread = text(args.threadId);
	const source = text(args.sessionId) || thread.split("/")[0];
	const topic = text(args.title) ? displayPreview(text(args.title), 100) : thread ? `thread ${displayIdentity(thread)}` : "";
	const subject = [text(args.action), topic, source ? targetLabel(source, context) : ""].filter(Boolean).join(" · ");
	const message = text(args.message);
	return argumentCard("agent_collaborate", subject, message ? displayPreview(message, 180) : undefined, args, theme, context, true);
}

function collaborationReceiptLines(details: Record<string, unknown>, theme: Theme, context: AgentCardContext): string[] | undefined {
	const args = record(context.args);
	const threadId = text(details.threadId);
	if (threadId) {
		const actions: Record<string, string> = { create: "Thread created", join: "Joined", leave: "Left", post: "Posted", revise: "Frame revised", close: "Thread closed" };
		const sequence = count(details.sequence);
		return [muted(theme, `${actions[text(args.action)] || "Recorded"}${sequence !== undefined ? ` · event ${sequence}` : ""}${args.threadId === threadId ? "" : ` · thread ${displayIdentity(threadId)}`}${details.deduped === true ? " · replay" : ""}`)];
	}
	return undefined;
}

function collaborationLines(details: Record<string, unknown>, theme: Theme, context: AgentCardContext): string[] | undefined {
	const receipt = collaborationReceiptLines(details, theme, context);
	if (receipt) return receipt;
	const thread = record(details.thread);
	if (text(thread.title)) return [
		muted(theme, `${displayPreview(text(thread.title), 100)} · ${thread.closed === true ? "closed" : "open"} · ${array(thread.members).length} members`),
		muted(theme, `${array(details.events).length} events · ${count(details.pending) ?? "?"} pending notices${record(details.coverage).complete === false ? " · bounded page" : ""}`),
	];
	if (!Array.isArray(details.items)) return undefined;
	return [
		muted(theme, `${details.items.length} threads${record(details.coverage).complete === false ? " · incomplete coverage" : ""}`),
		...details.items.slice(0, 3).map((value) => muted(theme, displayPreview(text(record(value).title), 100))),
		...(details.nextCursor ? [muted(theme, "Next page available")] : []),
	];
}

function renderResetCall(value: unknown, theme: Theme, context: AgentCardContext): Component {
	const args = record(value);
	const handoff = text(args.handoff);
	return argumentCard("agent_reset", targetLabel(text(args.sessionId), context), handoff ? `Handoff: ${displayPreview(handoff, 180)}` : undefined, args, theme, context, true);
}

function resetLines(details: Record<string, unknown>, theme: Theme, context: AgentCardContext): string[] | undefined {
	const source = text(details.text);
	if (!source) return undefined;
	const placed = /^Reset (placed|queued) for “(.*?)”[;.]/u.exec(source);
	if (placed) {
		const known = findTarget(callIdentity(context), context.lookup?.() ?? []);
		return [muted(theme, `Reset ${placed[1]}${known?.name === placed[2] ? "" : ` · ${displayPreview(placed[2], 100)}`}`)];
	}
	const failure = /^Reset did not place for “.*?”: (.*).$/u.exec(source);
	return [muted(theme, failure ? `Reset not placed: ${displayPreview(failure[1], 240)}` : displayPreview(source, 240))];
}

// --- Peer message card ----------------------------------------------------------

function peerScalarFields(details: Record<string, unknown>): string[] {
	const lines: string[] = [];
	for (const [key, value] of Object.entries(details)) {
		if (key === "usage" || key === "message" || key === "operatorMessage" || value === undefined || value === null) continue;
		if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") lines.push(`${key}: ${/(?:Id|identity)$/iu.test(key) ? displayText(String(value)) : displayPreview(String(value), 160)}`);
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
	const configuration = resolvedModelLine(provider, modelId, thinking);
	if (configuration) lines.push(configuration);
	return lines;
}

/** Compact outcome word for the operator card; the raw status stays in expanded details. */
function peerOutcome(details: Record<string, unknown>): { label: string; failed: boolean } {
	if (details.checkIn !== undefined) return { label: "still working", failed: false };
	const status = text(details.status);
	if (details.threadId !== undefined) return { label: "thread notice", failed: false };
	if (status !== "" || details.kind === "receipt") return { label: "result", failed: status === "unanswered" || status === "failed" };
	return { label: details.kind === "report" || (details.senderIdentity !== undefined && details.senderKind !== "session") ? "report" : "message from another session", failed: false };
}

/** Source names and observed session purposes precede identity-only labels. */
function peerLabel(details: Record<string, unknown>): string {
	const named = text(details.handle) || text(details.name) || text(details.label) || text(details.observedPurpose);
	if (named) return named;
	const identity = text(details.identity) || text(details.senderIdentity);
	return identity;
}

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
	if (details.saved === false && details.kind !== "report" && details.kind !== "message") warnings.push("Result not saved; retained only by the live owner");
	return warnings;
}

/** Check-in elapsed time keeps minutes below an hour and pads the remainder above it. */
function checkInElapsed(value: unknown): string {
	const milliseconds = count(value);
	if (milliseconds === undefined || milliseconds < 0) return "";
	const seconds = Math.floor(milliseconds / 1000);
	if (seconds < 60) return `${seconds}s elapsed`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m elapsed`;
	return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m elapsed`;
}

function peerMetadata(details: Record<string, unknown>): string[] {
	const checkIn = record(details.checkIn);
	const cost = count(checkIn.cost);
	const sender = details.threadId !== undefined ? peerLabel(details) : "";
	return [sender ? `from ${sender}` : "", resolvedModelLine(text(details.provider), text(details.modelId), text(details.thinkingLevel)), checkInElapsed(checkIn.elapsedMs), cost === undefined ? "" : `$${cost.toFixed(3)} conversation total`];
}

/** Native Markdown determines body wrapping; the shared layout owns its preview and hint. */
function noticeBody(content: string, theme: Theme): Component {
	const markdown = new Markdown(displayText(content).trim() || "(no text)", 0, 0, getMarkdownTheme(), { color: (value) => theme.fg("text", value) });
	let cache: { width: number; lines: string[] } | undefined;
	return {
		render(width) {
			if (cache?.width === width) return cache.lines;
			const rendered = markdown.render(width);
			const first = rendered.findIndex((line) => stripVTControlCharacters(line).trim() !== "");
			let end = rendered.length;
			while (end > first && stripVTControlCharacters(rendered[end - 1] ?? "").trim() === "") end--;
			const lines = first < 0 ? [] : rendered.slice(first, end);
			cache = { width, lines };
			return lines;
		},
		invalidate() { cache = undefined; markdown.invalidate(); },
	};
}

/** Native notices keep full retained content; only the collapsed presentation is short. */
export const renderAgentPeerMessage: MessageRenderer = (message, options, theme) => {
	const details = record(message.details);
	const content = typeof message.content === "string" ? message.content : message.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("\n");
	const { label, failed } = peerOutcome(details);
	const body: (string | Component)[] = peerWarnings(details, failed).map((warning) => theme.fg("warning", warning));
	const reason = text(details.reason);
	if (reason) body.push(theme.fg("text", displayPreview(reason, 240)));
	const checkIn = details.checkIn === undefined ? undefined : record(details.checkIn);
	body.push(noticeBody(checkIn === undefined ? (typeof details.operatorMessage === "string" ? details.operatorMessage : operatorNoticeBody(content)) : boundedSource(text(details.message)), theme));
	if (options.expanded) {
		body.push(new Spacer(1), theme.fg("muted", theme.bold("Source details")));
		for (const line of peerConfiguration(details)) body.push(theme.fg("muted", line));
		for (const line of peerScalarFields(details)) body.push(theme.fg("muted", line));
		body.push(theme.fg("muted", checkIn === undefined ? "Reported result · not operator authority or task acceptance" : "Check-in · task not finished · not operator authority or task acceptance"));
		body.push(theme.fg("dim", "/agent opens the dashboard"));
	}
	const subject = details.threadId !== undefined ? text(details.threadTitle) || text(details.threadId) : peerLabel(details);
	return cardLayout({ title: `[agent] ${label}`, label: subject, metadata: peerMetadata(details), body, previewLines: NOTICE_PREVIEW_LINES }, theme, { expanded: options.expanded, peerPadding: options.outputPad });
};

// --- Factory ---------------------------------------------------------------------

function bindCall(name: string): AgentToolCard["renderCall"] {
	return (args, theme, context) => renderAgentCall(name, args, theme, context);
}

function observeResult(result: AgentToolResult<unknown>, context: AgentCardContext, name: string): AgentCardContext {
	const details = resultDetails(result);
	const snapshot = name === "agent_intent" ? intentObservation(details) : snapshotStatus(details);
	const state = context.state;
	const token = firstDefined(result.details, result.structuredContent, result.content);
	if (state && state.resultSeen !== token) {
		state.resultSeen = token;
		state.observation = snapshot;
		const compaction = record(details.compaction);
		if (Object.keys(compaction).length && !state.compaction) state.compaction = compaction;
		if (state.compaction && state.callHint !== undefined) state.compactFactsShown = true;
	}
	return snapshotFacts(context, snapshot);
}

function awaitReplyLines(value: Record<string, unknown>): string[] {
	const lines = [text(value.decision) ? `Wait ${displayText(text(value.decision))} · ${array(value.results).length} results · ${array(value.unresolved).length} unresolved` : "Await result"];
	if (typeof value.queuedInputCount === "number") lines.push(`${value.queuedInputCount} queued inputs · committed InboxDoc`);
	if (text(value.releaseReason)) lines.push(displayText(text(value.releaseReason)));
	return lines;
}

/** Call and result renderers for every registered agent tool, keyed by tool name. */
export function createAgentToolCards(lookup: AgentCardLookup = () => []): Readonly<Record<string, AgentToolCard>> {
	const cards: Record<string, AgentToolCard> = {
		agent_spawn: { renderCall: bindCall("agent_spawn"), renderResult: renderAgentResult },
		agent_await: { renderCall: renderAwaitCall, renderResult: (result, options, theme, context) => outcomeCard(result, options, theme, context, { error: "Await error", partial: "Awaiting results" }, awaitReplyLines) },
		agent_attach: { renderCall: bindCall("agent_attach"), renderResult: renderAgentResult },
		agent_place: { renderCall: bindCall("agent_place"), renderResult: renderAgentResult },
		agent_intent: { renderCall: renderIntentCall, renderResult: (result, options, theme, context) => outcomeCard(result, options, theme, { ...context, isPartial: options.isPartial }, { error: "Intent error", partial: "Intent pending" }, intentLines) },
		agent_collaborate: { renderCall: renderCollaborateCall, renderResult: (result, options, theme, context) => outcomeCard(result, options, theme, context, { error: "Collaboration error", partial: "Collaboration pending" }, collaborationLines) },
		agent_status: { renderCall: bindCall("agent_status"), renderResult: renderAgentResult },
		agent_fork: { renderCall: bindCall("agent_fork"), renderResult: renderAgentResult },
		agent_rewind: { renderCall: bindCall("agent_rewind"), renderResult: renderAgentResult },
		agent_configure: { renderCall: bindCall("agent_configure"), renderResult: renderAgentResult },
		agent_profile: { renderCall: bindCall("agent_profile"), renderResult: renderProfileResult },
		agent_abort: { renderCall: renderAbortCall, renderResult: (result, options, theme, context) => outcomeCard(result, options, theme, context, { error: "Abort error", partial: "Abort pending" }, abortLines) },
		agent_list: { renderCall: renderListCall, renderResult: renderListResult },
		agent_send: { renderCall: renderSendCall, renderResult: renderSendResult },
		agent_steer: { renderCall: renderSteerCall, renderResult: renderSteerResult },
		agent_command: { renderCall: renderCommandCall, renderResult: (result, options, theme, context) => outcomeCard(result, options, theme, context, { error: "Command error", partial: "Command pending" }, commandLines) },
		agent_inspect: { renderCall: renderInspectCall, renderResult: renderInspectResult },
		agent_compact: { renderCall: renderCompactCall, renderResult: renderCompactResult },
		agent_reset: { renderCall: renderResetCall, renderResult: (result, options, theme, context) => outcomeCard(result, options, theme, context, { error: "Reset error", partial: "Reset pending" }, resetLines) },
	};
	return Object.fromEntries(Object.entries(cards).map(([name, card]) => [name, {
		renderCall(args: unknown, theme: Theme, context: AgentCardContext) {
			if (context.state) context.state.callHint = false;
			const observed = { ...context, lookup };
			let component = card.renderCall(args, theme, snapshotFacts(observed, context.state?.observation));
			if (!context.state) return component;
			return {
				render(width: number) {
					component = card.renderCall(args, theme, snapshotFacts({ ...observed, lastComponent: component }, context.state?.observation));
					return component.render(width);
				},
				invalidate() { component.invalidate(); },
			};
		},
		renderResult(result: AgentToolResult<unknown>, options: ToolRenderResultOptions, theme: Theme, context: AgentCardContext) {
			const observed = observeResult(result, { ...context, lookup }, name);
			return card.renderResult(result, options, theme, observed);
		},
	}]));
}
