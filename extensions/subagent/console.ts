/** Readable worker transcripts. Expansion changes presentation, never the retained source. */
import type { Theme } from "@earendil-works/pi-coding-agent";
import { Markdown, type MarkdownTheme, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

export interface ConsoleTextPart {
	type: "text";
	text: string;
}
export interface ConsoleThinkingPart {
	type: "thinking";
	thinking: string;
}
export interface ConsoleToolCallPart {
	type: "toolCall";
	id: string;
	name: string;
	arguments: Record<string, unknown>;
}
export type ConsolePart = ConsoleTextPart | ConsoleThinkingPart | ConsoleToolCallPart;
export interface ConsoleUserMessage {
	role: "user";
	content: string | ConsoleTextPart[];
}
export interface ConsoleAssistantMessage {
	role: "assistant";
	content: ConsolePart[];
	stopReason?: string;
	errorMessage?: string;
}
export interface ConsoleToolResultMessage {
	role: "toolResult";
	toolCallId: string;
	toolName: string;
	content: ConsoleTextPart[];
	isError: boolean;
	status?: "running" | "complete" | "error";
}
export interface ConsoleCustomMessage {
	role: "custom";
	customType: string;
	content: ConsoleTextPart[];
}
export type ConsoleMessage = (
	| ConsoleUserMessage
	| ConsoleAssistantMessage
	| ConsoleToolResultMessage
	| ConsoleCustomMessage
) & { id?: string };

export interface RenderOpts {
	width: number;
	theme: Theme;
	expandedTools?: boolean;
	showThinking?: boolean;
	sectionExpansion?: ReadonlyMap<string, boolean>;
	selectedSectionId?: string | null;
	toolHint?: string;
	thinkingHint?: string;
}
export interface TranscriptSection {
	id: string;
	label: string;
	start: number;
	end: number;
	expanded?: boolean;
	kind: "message" | "tool" | "reasoning";
}
export interface TranscriptDocument {
	lines: string[];
	sections: TranscriptSection[];
}

const ANSI_PASSES: RegExp[] = [
	/(?:\u001b\]|\u009d)(?:[^\u0007\u001b]|\u001b(?!\\))*(?:\u0007|\u001b\\)/g,
	/\u001b[P_X^](?:[^\u001b]|\u001b(?!\\))*\u001b\\/g,
	/(?:\u001b\[|\u009b)[0-?]*[ -/]*[@-~]/g,
	/\u001bO[ -~]/g,
	/\u001b[ -/]*[0-~]/g,
];
export function stripTerminalSequences(text: string): string {
	let stripped = text;
	for (const pass of ANSI_PASSES) stripped = stripped.replace(pass, "");
	return stripped;
}
export function cleanConsoleText(text: string): string {
	return stripTerminalSequences(text)
		.replace(/\t/g, "   ")
		.replace(/[\r\v\f]/g, " ")
		.replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "");
}

/** The callback theme owns every style; no global theme or foreign tool renderer is invoked. */
export function transcriptMarkdownTheme(theme: Theme): MarkdownTheme {
	return {
		heading: (text) => theme.fg("mdHeading", theme.bold(text)),
		link: (text) => theme.fg("mdLink", text),
		linkUrl: (text) => theme.fg("mdLinkUrl", text),
		code: (text) => theme.fg("mdCode", text),
		codeBlock: (text) => theme.fg("mdCodeBlock", text),
		codeBlockBorder: (text) => theme.fg("mdCodeBlockBorder", text),
		quote: (text) => theme.fg("mdQuote", text),
		quoteBorder: (text) => theme.fg("mdQuoteBorder", text),
		hr: (text) => theme.fg("mdHr", text),
		listBullet: (text) => theme.fg("mdListBullet", text),
		bold: (text) => theme.bold(text),
		italic: (text) => theme.italic(text),
		strikethrough: (text) => theme.strikethrough(text),
		underline: (text) => theme.underline(text),
	};
}
export function renderMarkdownText(text: string, width: number, theme: Theme): string[] {
	if (width <= 0) return [];
	return new Markdown(cleanConsoleText(text), 0, 0, transcriptMarkdownTheme(theme), {
		color: (s) => theme.fg("text", s),
	})
		.render(width)
		.map((line) => truncateToWidth(line, width, ""));
}

function toolTitle(call: ConsoleToolCallPart): string {
	const args = call.arguments;
	const target = args.command ?? args.path ?? args.pattern;
	return `${call.name}${target === undefined ? "" : `  ${String(target)}`}`;
}

type SectionColor = "accent" | "muted" | "error" | "warning" | "success";

function toolState(result: ConsoleToolResultMessage | undefined, stopReason: string | undefined): string {
	if (!result && (stopReason === "aborted" || stopReason === "error")) return stopReason;
	if (!result || result.status === "running") return "running";
	return result.isError ? "error" : "done";
}

/** One render owns its document, tool-result lookup, and width-dependent layout. */
class TranscriptRenderer {
	readonly document: TranscriptDocument = { lines: [], sections: [] };
	readonly results = new Map<string, ConsoleToolResultMessage>();
	readonly width: number;
	readonly measure: number;
	readonly theme: Theme;
	readonly opts: RenderOpts;

	constructor(opts: RenderOpts) {
		this.opts = opts;
		this.theme = opts.theme;
		this.width = Math.max(0, opts.width);
		this.measure = Math.max(1, Math.min(100, this.width - 4));
	}

	paddedLine(line: string): string {
		const clipped = truncateToWidth(line, this.width, "");
		return clipped + " ".repeat(Math.max(0, this.width - visibleWidth(clipped)));
	}

	prose(text: string): string[] {
		return renderMarkdownText(text, this.measure, this.theme);
	}

	literal(text: string): string[] {
		return wrapTextWithAnsi(cleanConsoleText(text), this.measure);
	}

	add(id: string, label: string, body: string[], color: SectionColor = "muted", expanded?: boolean,
		kind: TranscriptSection["kind"] = "message"): void {
		const { document, theme, opts } = this;
		if (document.lines.length) document.lines.push(this.paddedLine(""));
		const start = document.lines.length;
		for (const line of wrapTextWithAnsi(cleanConsoleText(label), this.measure))
			document.lines.push(this.paddedLine(
				`${opts.selectedSectionId === id ? "›" : " "}${theme.fg(opts.selectedSectionId === id ? "accent" : color, theme.bold(line))}`,
			));
		for (const line of body) document.lines.push(this.paddedLine(` ${line}`));
		document.sections.push({ id, label, start, end: document.lines.length, expanded, kind });
	}

	renderMessage(message: ConsoleMessage, key: string): void {
		switch (message.role) {
			case "toolResult": return;
			case "user": {
				const text = typeof message.content === "string" ? message.content : message.content.map((p) => p.text).join("\n");
				this.add(key, "User", this.prose(text), "accent");
				return;
			}
			case "custom":
				this.add(key, `Message · ${cleanConsoleText(message.customType)}`, this.prose(message.content.map((p) => p.text).join("\n")));
				return;
			case "assistant":
				this.renderAssistant(message, key);
		}
	}

	renderAssistant(message: ConsoleAssistantMessage, key: string): void {
		for (let partIndex = 0; partIndex < message.content.length; partIndex++) {
			const part = message.content[partIndex];
			const partKey = `${key}:${partIndex}`;
			if (part.type === "toolCall") {
				this.renderTool(part, partKey, message.stopReason);
				continue;
			}
			const values = [part.type === "text" ? part.text : part.thinking];
			while (message.content[partIndex + 1]?.type === part.type) {
				const next = message.content[++partIndex];
				if (next.type === "text") values.push(next.text);
				else if (next.type === "thinking") values.push(next.thinking);
			}
			this.renderProse(partKey, part.type, values.join("\n\n"));
		}
		this.renderStop(message, key);
	}

	renderProse(key: string, type: "text" | "thinking", text: string): void {
		if (!text.trim()) return;
		if (type === "text") {
			this.add(key, "Assistant", this.prose(text));
		} else if (this.opts.sectionExpansion?.get(key) ?? this.opts.showThinking) {
			this.add(key, "Reasoning", this.prose(text).map((line) => this.theme.fg("muted", line)), "muted", true, "reasoning");
		} else {
			this.add(key, `Reasoning · collapsed · ${this.opts.thinkingHint ?? "ctrl+t"} expands`, [], "muted", false, "reasoning");
		}
	}

	expandedToolBody(part: ConsoleToolCallPart, result: ConsoleToolResultMessage | undefined, output: string): string[] {
		const body = [this.theme.fg("muted", "Input"), ...this.literal(JSON.stringify(part.arguments, null, 2))];
		if (result) body.push(this.theme.fg("muted", "Output"), ...this.literal(output).map((line) => this.theme.fg(result.isError ? "error" : "text", line)));
		return body;
	}

	collapsedToolBody(part: ConsoleToolCallPart, result: ConsoleToolResultMessage | undefined, output: string): string[] {
		const wrapped = output ? this.literal(output) : [];
		const count = Math.min(2, wrapped.length);
		const body = wrapped.slice(0, count).map((line) => this.theme.fg(result?.isError ? "error" : "text", line));
		if (wrapped.length > count || Object.keys(part.arguments).length)
			body.push(this.theme.fg("muted", `${wrapped.length > count ? `${wrapped.length - count} more lines · ` : ""}${this.opts.toolHint ?? "ctrl+o"} expands input and output`));
		return body;
	}

	renderTool(part: ConsoleToolCallPart, key: string, stopReason: string | undefined): void {
		const result = this.results.get(part.id);
		const failed = !result && (stopReason === "aborted" || stopReason === "error");
		const state = toolState(result, stopReason);
		const color = failed || result?.isError ? "error" : state === "running" ? "warning" : "muted";
		const title = cleanConsoleText(toolTitle(part)).replace(/\s+/g, " ");
		const output = result ? cleanConsoleText(result.content.map((p) => p.text).join("\n")) : "";
		if (this.opts.sectionExpansion?.get(key) ?? this.opts.expandedTools) {
			this.add(key, `${part.name} · ${state}`, this.expandedToolBody(part, result, output), color, true, "tool");
		} else {
			this.add(key, `${state === "running" ? "●" : state === "done" ? "✓" : "!"} ${truncateToWidth(title, Math.max(1, this.measure - state.length - 5), "…")} · ${state}`,
				this.collapsedToolBody(part, result, output), color, false, "tool");
		}
	}

	renderStop(message: ConsoleAssistantMessage, key: string): void {
		const hasToolCalls = message.content.some((part) => part.type === "toolCall");
		if (message.stopReason === "length") this.add(`${key}:stop`, "Response was truncated before completion.", [], "error");
		else if (!hasToolCalls && message.stopReason === "error")
			this.add(`${key}:stop`, "Error", this.literal(`Error: ${message.errorMessage || "Unknown error"}`), "error");
		else if (!hasToolCalls && message.stopReason === "aborted")
			this.add(`${key}:stop`, "Aborted", this.literal(message.errorMessage && message.errorMessage !== "Request was aborted" ? message.errorMessage : "Operation aborted"), "error");
	}
}

export function renderTranscript(messages: ConsoleMessage[], opts: RenderOpts): TranscriptDocument {
	const renderer = new TranscriptRenderer(opts);
	if (!renderer.width) return renderer.document;
	for (const message of messages) if (message.role === "toolResult") renderer.results.set(message.toolCallId, message);
	for (const [index, message] of messages.entries()) renderer.renderMessage(message, message.id ?? `message-${index}`);
	return renderer.document;
}

export function renderConversation(messages: ConsoleMessage[], opts: RenderOpts): string[] {
	return renderTranscript(messages, opts).lines;
}

/** Anchor a reader to a section and its relative line, not a stale absolute screen row. */
export function transcriptAnchor(document: TranscriptDocument, row: number): { id: string; fraction: number } | null {
	const section =
		document.sections.find((item) => item.start <= row && item.end > row) ??
		[...document.sections].reverse().find((item) => item.start <= row);
	return section
		? { id: section.id, fraction: Math.max(0, (row - section.start) / Math.max(1, section.end - section.start)) }
		: null;
}
export function restoreTranscriptAnchor(
	document: TranscriptDocument,
	anchor: ReturnType<typeof transcriptAnchor>,
): number | null {
	if (!anchor) return null;
	const section = document.sections.find((item) => item.id === anchor.id);
	return section
		? section.start +
				Math.min(section.end - section.start - 1, Math.floor(anchor.fraction * (section.end - section.start)))
		: null;
}
