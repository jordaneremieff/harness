import type { AgentToolResult, Theme, ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import { keyText } from "@earendil-works/pi-coding-agent";
import { Text, type Component } from "@earendil-works/pi-tui";

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
