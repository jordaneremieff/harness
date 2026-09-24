import type { AgentToolResult, MessageRenderer, Theme, ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import { keyText } from "@earendil-works/pi-coding-agent";
import { Box, Text, truncateToWidth, type Component } from "@earendil-works/pi-tui";

const MESSAGE_DISPLAY_LIMIT = 32_000;

/** Show controls as text, never as terminal commands. Newlines retain message structure. */
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

function boundedMessage(value: string): string {
	const prefix = displayPrefix(value, MESSAGE_DISPLAY_LIMIT);
	return displayText(prefix) + (value.length > prefix.length ? `\n[Display limit: ${value.length - prefix.length} more UTF-16 code units. Full text remains in the native tool-call arguments.]` : "");
}

function textComponent(text: string, previous?: Component): Text {
	const component = previous instanceof Text ? previous : new Text("", 0, 0);
	component.setText(text);
	return component;
}

function peerField(details: Record<string, unknown>, key: string): string {
	return typeof details[key] === "string" ? details[key] : "";
}

/** Identity is never silently shortened into a different source. */
function peerIdentity(value: string): string {
	return /^[\w.:-]{1,128}$/u.test(value) ? value : "source unavailable";
}

function peerRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function peerOutcomes(details: Record<string, unknown>): Record<string, unknown>[] {
	return Array.isArray(details.outcomes) ? details.outcomes.map(peerRecord) : [];
}

function peerHeading(details: Record<string, unknown>): { title: string; source: string; failed: boolean } {
	const kind = peerField(details, "kind");
	if (kind === "operation") {
		const status = peerField(details, "status");
		const outcome = ["completed", "failed", "aborted"].includes(status) ? status : "outcome unavailable";
		return { title: `Peer operation: ${outcome}`, source: peerIdentity(peerField(details, "sessionId")), failed: status === "failed" || status === "aborted" };
	}
	if (kind === "runs") {
		const outcomes = peerOutcomes(details);
		const unsuccessful = outcomes.filter((item) => item.status === "failed" || item.status === "abandoned").length;
		const known = outcomes.length > 0 && outcomes.every((item) => ["finished", "failed", "abandoned"].includes(peerField(item, "status")));
		return { title: known ? `Detached runs: ${outcomes.length}; unsuccessful: ${unsuccessful}` : "Detached runs: outcome unavailable", source: "Sources: expand for run/session IDs", failed: unsuccessful > 0 };
	}
	return { title: kind === "message" ? "Agent peer message" : "Agent peer: kind unavailable", source: peerIdentity(peerField(details, "fromSessionId")), failed: false };
}

function addPeerEvidence(box: Box, content: string, details: Record<string, unknown>, theme: Theme): void {
	for (const key of ["fromSessionId", "toSessionId", "messageId", "replyTo", "sessionId", "operationId"]) {
		const value = peerField(details, key);
		if (value) box.addChild(new Text(theme.fg("muted", `${key}: ${displayPreview(value, 512)}`), 0, 0));
	}
	for (const item of peerOutcomes(details)) {
		box.addChild(new Text(theme.fg("muted", ["runId", "sessionId", "status"].map((key) => `${key}: ${displayPreview(peerField(item, key), 128)}`).join(" · ")), 0, 0));
	}
	const prefix = displayPrefix(content, MESSAGE_DISPLAY_LIMIT);
	box.addChild(new Text(theme.fg("customMessageText", displayText(prefix)), 0, 0));
	if (prefix.length < content.length) box.addChild(new Text("Display limit; full notification remains in native history.", 0, 0));
	if (details.kind === "operation") box.addChild(new Text("agent_inspect: stored operation outcome", 0, 0));
	if (details.kind === "runs") box.addChild(new Text("agent_runs: stored run outcomes", 0, 0));
}

/** Presentation does not alter message content, queue custody, or primary state. */
export const renderPeerMessage: MessageRenderer = (message, { expanded }, theme) => {
	const details = peerRecord(message.details);
	const { title, source, failed } = peerHeading(details);
	const content = typeof message.content === "string" ? message.content : message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
	const box = new Box(1, 0, (line) => theme.bg("customMessageBg", line.replace(/\x1b\[(?:0|49)?m/g, (reset) => reset + theme.getBgAnsi("customMessageBg"))));
	box.addChild(new Text(theme.fg(failed ? "error" : "customMessageLabel", title), 0, 0));
	box.addChild(new Text(theme.fg("accent", source), 0, 0));
	if (expanded) {
		addPeerEvidence(box, content, details, theme);
	} else {
		const preview = theme.fg("customMessageText", `↳ ${displayPreview(content, 220) || "(no text)"}`);
		box.addChild({ render: (width) => [truncateToWidth(preview, Math.max(1, width))], invalidate() {} });
	}
	box.addChild(new Text(theme.fg("muted", "Peer evidence · unverified"), 0, 0));
	if (!expanded) box.addChild(new Text(theme.fg("dim", keyText("app.tools.expand") ? `${keyText("app.tools.expand")} to expand` : "Native expansion: more details"), 0, 0));
	return box;
};

function requestedConfiguration(name: string, args: Record<string, unknown>): string {
	const retained = name !== "agent_spawn" && (name !== "agent_detach" || Boolean(peerField(args, "sessionId")));
	const unresolved = name === "agent_place" ? "bound session or inherited" : retained ? "retained session" : "inherited";
	const model = peerField(args, "model");
	const thinking = peerField(args, "thinkingLevel");
	if (!model && !thinking) return `Requested model and thinking: ${unresolved} (unresolved)`;
	return `Requested: ${model ? displayPreview(model, 240) : `${unresolved} (unresolved)`} · thinking ${thinking ? displayPreview(thinking, 40) : "unresolved"}`;
}
function toolExpansionHint(subject: string): string {
	const key = keyText("app.tools.expand");
	return key ? `${key} to expand ${subject}` : `Expand for full ${subject}`;
}

/** Requests and status snapshots are separate evidence; rendering never opens a session. */
export function renderAgentCall(name: string, value: unknown, theme: Theme, context: { expanded: boolean; argsComplete: boolean; lastComponent?: Component }): Component {
	const args = peerRecord(value);
	const subject = peerField(args, "name") || peerField(args, "topic") || peerField(args, "prompt") || peerField(args, "correction") || peerField(args, "sessionId") || peerField(args, "runId");
	const lines = [theme.fg("toolTitle", theme.bold(name)) + (subject ? theme.fg("accent", ` · ${displayPreview(subject, 120)}`) : "")];
	if (["agent_spawn", "agent_detach", "agent_attach", "agent_place", "agent_fork", "agent_rewind"].includes(name)) {
		lines.push(theme.fg("muted", requestedConfiguration(name, args)));
	}
	if (context.expanded) lines.push(theme.fg("toolOutput", boundedMessage(JSON.stringify(args, null, 2))));
	else lines.push(theme.fg("dim", toolExpansionHint("arguments")));
	return textComponent(lines.join("\n"), context.lastComponent);
}

function snapshotLines(preview: Record<string, unknown>, theme: Theme): string[] {
	const model = peerRecord(preview.model);
	const provider = peerField(model, "provider");
	const modelId = peerField(model, "modelId");
	const thinking = peerField(model, "thinkingLevel");
	const phase = peerField(preview, "phase");
	const name = peerField(preview, "name");
	const lines = name ? [theme.fg("accent", displayPreview(name, 120))] : [];
	lines.push(theme.fg("muted", `${phase === "session snapshot" ? "Session snapshot" : "Selected before transfer"}: ${provider && modelId ? displayPreview(`${provider}/${modelId}`, 300) : "model unknown"} · thinking ${thinking ? displayPreview(thinking, 40) : "unknown"}`));
	if (phase === "selected before transfer") lines.push(theme.fg("dim", "Child runtime selection is not confirmed by this snapshot"));
	return lines;
}

function resultPreview(value: string, limit: number): string {
	const prefix = displayPrefix(value, limit);
	const lines = prefix.split("\n").slice(0, 3).join("\n");
	return displayText(lines) + (lines.length < value.length ? "\n…" : "");
}

function boundedResult(value: string): string {
	const prefix = displayPrefix(value, MESSAGE_DISPLAY_LIMIT);
	return displayText(prefix) + (prefix.length < value.length ? "\n[Display limit; full result remains in native tool history.]" : "");
}

export function renderAgentResult(result: AgentToolResult<unknown>, options: ToolRenderResultOptions, theme: Theme, context: { isError: boolean; lastComponent?: Component }): Component {
	const preview = peerRecord(peerRecord(result.details).preview);
	const phase = peerField(preview, "phase");
	const knownPhase = phase === "session snapshot" || phase === "selected before transfer";
	const lines: string[] = [];
	if (context.isError) lines.push(theme.fg("error", "Tool error"));
	else if (options.isPartial) lines.push(theme.fg("muted", "Partial result"));
	if (knownPhase) lines.push(...snapshotLines(preview, theme));
	const output = result.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
	if (options.expanded) {
		lines.push(theme.fg("toolOutput", boundedResult(output)));
		if (knownPhase) lines.push(theme.fg("dim", boundedResult(JSON.stringify(preview, null, 2))));
	} else {
		lines.push(theme.fg(context.isError ? "error" : "toolOutput", resultPreview(output, knownPhase ? 240 : 600)));
		if (knownPhase || output.length > 600 || output.includes("\n")) lines.push(theme.fg("dim", toolExpansionHint("result and identifiers")));
	}
	return textComponent(lines.join("\n"), context.lastComponent);
}

interface SendDisplayArgs { sessionId: string; message: string; replyTo?: string }

export function renderSendCall(args: Partial<SendDisplayArgs>, theme: Theme, context: { expanded: boolean; argsComplete: boolean; lastComponent?: Component }): Component {
	const target = typeof args.sessionId === "string" ? displayPreview(args.sessionId, 300) : "(target pending)";
	const message = typeof args.message === "string" ? args.message : "";
	const lines = [theme.fg("toolTitle", theme.bold("agent_send")) + theme.fg("accent", ` → ${target}`)];
	if (typeof args.replyTo === "string" && args.replyTo) lines.push(theme.fg("muted", `Reply to: ${displayPreview(args.replyTo, 300)}`));
	if (context.expanded) {
		lines.push(theme.fg("muted", context.argsComplete ? "Submitted message (controls escaped):" : "Message so far (controls escaped):"));
		lines.push(theme.fg("toolOutput", boundedMessage(message)));
	} else {
		lines.push(theme.fg("toolOutput", displayPreview(message, 180) || (context.argsComplete ? "(empty or whitespace-only message)" : "(message pending)")));
		const expandKey = keyText("app.tools.expand");
		lines.push(theme.fg("muted", expandKey ? `${expandKey} to expand message` : "Full message is in the tool-call arguments."));
	}
	return textComponent(lines.join("\n"), context.lastComponent);
}

export function renderSendResult(result: AgentToolResult<unknown>, options: ToolRenderResultOptions, theme: Theme, context: { isError: boolean; lastComponent?: Component }): Component {
	const output = result.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
	const label = context.isError ? "Send error" : options.isPartial ? "Admission pending" : "Admission receipt (not proof of delivery or action)";
	return textComponent(theme.fg(context.isError ? "error" : "muted", `${label}:\n`) + theme.fg("toolOutput", options.expanded ? boundedMessage(output) : displayPreview(output, 300)), context.lastComponent);
}
