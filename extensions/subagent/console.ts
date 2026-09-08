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

export function renderTranscript(messages: ConsoleMessage[], opts: RenderOpts): TranscriptDocument {
	const { theme } = opts;
	const width = Math.max(0, opts.width);
	const document: TranscriptDocument = { lines: [], sections: [] };
	if (!width) return document;
	const measure = Math.max(1, Math.min(100, width - 4));
	const results = new Map<string, ConsoleToolResultMessage>();
	for (const message of messages) if (message.role === "toolResult") results.set(message.toolCallId, message);
	const paddedLine = (line: string): string => {
		const clipped = truncateToWidth(line, width, "");
		return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
	};
	const prose = (text: string): string[] => renderMarkdownText(text, measure, theme);
	const literal = (text: string): string[] => wrapTextWithAnsi(cleanConsoleText(text), measure);
	const add = (
		id: string,
		label: string,
		body: string[],
		color: "accent" | "muted" | "error" | "warning" | "success" = "muted",
		expanded?: boolean,
		kind: TranscriptSection["kind"] = "message",
	) => {
		if (document.lines.length) document.lines.push(paddedLine(""));
		const start = document.lines.length;
		for (const line of wrapTextWithAnsi(cleanConsoleText(label), measure))
			document.lines.push(
				paddedLine(
					`${opts.selectedSectionId === id ? "›" : " "}${theme.fg(opts.selectedSectionId === id ? "accent" : color, theme.bold(line))}`,
				),
			);
		for (const line of body) document.lines.push(paddedLine(` ${line}`));
		document.sections.push({ id, label, start, end: document.lines.length, expanded, kind });
	};
	for (const [index, message] of messages.entries()) {
		const key = message.id ?? `message-${index}`;
		if (message.role === "toolResult") continue;
		if (message.role === "user") {
			const text =
				typeof message.content === "string" ? message.content : message.content.map((p) => p.text).join("\n");
			add(key, "User", prose(text), "accent");
			continue;
		}
		if (message.role === "custom") {
			add(
				key,
				`Message · ${cleanConsoleText(message.customType)}`,
				prose(message.content.map((p) => p.text).join("\n")),
			);
			continue;
		}
		for (let partIndex = 0; partIndex < message.content.length; partIndex++) {
			const part = message.content[partIndex];
			const partKey = `${key}:${partIndex}`;
			if (part.type === "text" || part.type === "thinking") {
				const values = [part.type === "text" ? part.text : part.thinking];
				while (message.content[partIndex + 1]?.type === part.type) {
					const next = message.content[++partIndex];
					if (next.type === "text") values.push(next.text);
					else if (next.type === "thinking") values.push(next.thinking);
				}
				const text = values.join("\n\n");
				if (!text.trim()) continue;
				if (part.type === "text") add(partKey, "Assistant", prose(text));
				else if (opts.sectionExpansion?.get(partKey) ?? opts.showThinking)
					add(
						partKey,
						"Reasoning",
						prose(text).map((line) => theme.fg("muted", line)),
						"muted",
						true,
						"reasoning",
					);
				else
					add(
						partKey,
						`Reasoning · collapsed · ${opts.thinkingHint ?? "ctrl+t"} expands`,
						[],
						"muted",
						false,
						"reasoning",
					);
				continue;
			}
			const result = results.get(part.id);
			const failed = !result && (message.stopReason === "aborted" || message.stopReason === "error");
			const state = failed
				? message.stopReason!
				: result?.status === "running" || !result
					? "running"
					: result.isError
						? "error"
						: "done";
			const color = failed || result?.isError ? "error" : state === "running" ? "warning" : "muted";
			const title = cleanConsoleText(toolTitle(part)).replace(/\s+/g, " ");
			const output = result ? cleanConsoleText(result.content.map((p) => p.text).join("\n")) : "";
			if (opts.sectionExpansion?.get(partKey) ?? opts.expandedTools) {
				const args = JSON.stringify(part.arguments, null, 2);
				const body = [
					theme.fg("muted", "Input"),
					...literal(args),
					...(result
						? [
								theme.fg("muted", "Output"),
								...literal(output).map((line) => theme.fg(result.isError ? "error" : "text", line)),
							]
						: []),
				];
				add(partKey, `${part.name} · ${state}`, body, color, true, "tool");
			} else {
				const wrapped = output ? literal(output) : [];
				const count = Math.min(2, wrapped.length);
				const body = wrapped.slice(0, count).map((line) => theme.fg(result?.isError ? "error" : "text", line));
				if (wrapped.length > count || Object.keys(part.arguments).length)
					body.push(
						theme.fg(
							"muted",
							`${wrapped.length > count ? `${wrapped.length - count} more lines · ` : ""}${opts.toolHint ?? "ctrl+o"} expands input and output`,
						),
					);
				add(
					partKey,
					`${state === "running" ? "●" : state === "done" ? "✓" : "!"} ${truncateToWidth(title, Math.max(1, measure - state.length - 5), "…")} · ${state}`,
					body,
					color,
					false,
					"tool",
				);
			}
		}
		const hasToolCalls = message.content.some((part) => part.type === "toolCall");
		if (message.stopReason === "length") add(`${key}:stop`, "Response was truncated before completion.", [], "error");
		else if (!hasToolCalls && message.stopReason === "error")
			add(`${key}:stop`, "Error", literal(`Error: ${message.errorMessage || "Unknown error"}`), "error");
		else if (!hasToolCalls && message.stopReason === "aborted")
			add(
				`${key}:stop`,
				"Aborted",
				literal(
					message.errorMessage && message.errorMessage !== "Request was aborted"
						? message.errorMessage
						: "Operation aborted",
				),
				"error",
			);
	}
	return document;
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
	const section = anchor && document.sections.find((item) => item.id === anchor.id);
	return section
		? section.start +
				Math.min(section.end - section.start - 1, Math.floor(anchor!.fraction * (section.end - section.start)))
		: null;
}
