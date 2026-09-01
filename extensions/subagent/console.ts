/**
 * Pure transcript renderer for subagent workers.
 *
 * Turns a worker's conversation into terminal lines that look like pi's real
 * interactive console: full-width user bands, plain assistant prose, thinking
 * blocks, and status-painted tool boxes. The renderer is PURE — no component,
 * no lifecycle, no I/O, no globals. Every returned string is ONE physical
 * terminal line of exactly `opts.width` visible columns, already ANSI-styled
 * with theme tokens and background-painted, ready for a TUI `render(width)`
 * to emit directly.
 *
 * Block model (mirrors pi's console layout):
 *   - a user message is a full-width band painted with `userMessageBg`;
 *   - assistant text and thinking are plain lines indented one space;
 *   - each tool call is one box, painted by status (`toolPendingBg` while
 *     running, `toolSuccessBg` on success, `toolErrorBg` on error), with a
 *     title header and the complete transcript result;
 *   - exactly one plain blank line separates consecutive blocks, and no
 *     blank line precedes the first block.
 *   - `toolResult` messages are never rendered directly; tool boxes consume
 *     them by `toolCallId` (indexed once up front).
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

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
	/** Live status; "running" marks a synthetic in-flight result carrying partial content. */
	status?: "running" | "complete" | "error";
}
export type ConsoleMessage = ConsoleUserMessage | ConsoleAssistantMessage | ConsoleToolResultMessage;

export interface RenderOpts {
	/** Total terminal columns; every output line MUST be exactly this many visible columns. */
	width: number;
	/** Theme for `theme.fg(token, text)`, `theme.bg(token, text)`, `theme.bold`, `theme.italic`. */
	theme: Theme;
}

/** Background tokens this renderer paints with (subset of ThemeBg). */
type BgToken = "userMessageBg" | "customMessageBg" | "toolPendingBg" | "toolSuccessBg" | "toolErrorBg";
/**
 * ANSI escape sequences, applied to reduce tool output to plain text before
 * previewing. `theme.fg`/`bg` never run through this — only raw tool result
 * content.
 *
 * Ordered deliberately: OSC first (both BEL- and ST-terminated, since an
 * ST-terminated OSC would otherwise survive and paint its payload), then CSI,
 * then SS3, then the remaining two-character introducer forms such as ESC (B.
 * Anything left is handled by the C0/C1 sweep in `sanitize` — a stray control
 * byte occupies no display column but does move the cursor, which silently
 * breaks the renderer's exact-width contract.
 */
const ANSI_PASSES: RegExp[] = [
	/(?:\u001b\]|\u009d)(?:[^\u0007\u001b]|\u001b(?!\\))*(?:\u0007|\u001b\\)/g,
	/(?:\u001b\[|\u009b)[0-?]*[ -/]*[@-~]/g,
	/\u001bO[ -~]/g,
	/\u001b[ -/]*[0-~]/g,
];

/** Remove complete terminal escape sequences while preserving their text. */
export function stripTerminalSequences(text: string): string {
	let stripped = text;
	for (const pass of ANSI_PASSES) stripped = stripped.replace(pass, "");
	return stripped;
}

function isBlank(text: string): boolean {
	return text.trim() === "";
}

export function renderConversation(messages: ConsoleMessage[], opts: RenderOpts): string[] {
	const { width, theme } = opts;

	// Inner content width of a padded block: 1 space margin on each side.
	const contentWidth = Math.max(0, width - 2);
	const wrapWidth = Math.max(1, width - 2);

	const out: string[] = [];
	/** True once any line has been emitted; governs the between-blocks blank. */
	let emitted = false;

	/** One plain blank line before a new top-level block, unless it is the first line of the conversation. */
	const pushSpacer = (): void => {
		if (emitted) out.push(" ".repeat(width));
	};

	/** Plain (no background) line, truncated then padded to exactly `width` visible columns. */
	const plainLine = (content: string): string => {
		const truncated = truncateToWidth(content, width, "");
		return truncated + " ".repeat(Math.max(0, width - visibleWidth(truncated)));
	};

	/** Full-width background-only line. */
	const bgBlank = (token: BgToken): string => theme.bg(token, " ".repeat(width));

	/**
	 * Padded block line: `bg(" " + inner(padded to width-2) + " ")` — a 1-space
	 * margin on each side with the background filling the whole line. Inner text
	 * is truncated to the content width and padded by VISIBLE width (never JS
	 * length), so ANSI styling cannot skew the padding.
	 */
	const padPaint = (token: BgToken, innerText: string): string => {
		const inner = truncateToWidth(innerText, contentWidth, "");
		const innerWidth = visibleWidth(inner);
		const padded = innerWidth >= contentWidth ? inner : inner + " ".repeat(contentWidth - innerWidth);
		const left = Math.max(0, Math.floor((width - contentWidth) / 2));
		const right = Math.max(0, width - contentWidth - left);
		return theme.bg(token, " ".repeat(left) + padded + " ".repeat(right));
	};

	// Index tool results once; tool boxes consume them by toolCallId.
	const resultsById = new Map<string, ConsoleToolResultMessage>();
	for (const m of messages) {
		if (m.role === "toolResult") resultsById.set(m.toolCallId, m);
	}

	// ---- blocks ------------------------------------------------------------

	/** Full-width user band: blank bg line, wrapped text, blank bg line. */
	const renderUser = (msg: ConsoleUserMessage): void => {
		pushSpacer();
		out.push(bgBlank("userMessageBg"));
		const text = sanitize(typeof msg.content === "string" ? msg.content : msg.content.map((p) => p.text).join("\n"));
		for (const line of wrapTextWithAnsi(text, wrapWidth)) {
			out.push(padPaint("userMessageBg", theme.fg("userMessageText", line)));
		}
		out.push(bgBlank("userMessageBg"));
		emitted = true;
	};

	/** Plain assistant prose, indented one space, no background. */
	const renderTextRun = (text: string): void => {
		pushSpacer();
		for (const line of wrapTextWithAnsi(sanitize(text), wrapWidth)) {
			out.push(plainLine(` ${theme.fg("text", line)}`));
		}
		emitted = true;
	};

	/** One thinking block, always rendered in full. */
	const renderThinking = (parts: ConsoleThinkingPart[]): void => {
		pushSpacer();
		const text = sanitize(parts.map((p) => p.thinking).join("\n\n"));
		for (const line of wrapTextWithAnsi(text, wrapWidth)) {
			out.push(plainLine(` ${theme.italic(theme.fg("thinkingText", line))}`));
		}
		emitted = true;
	};

	/** Blank line + one error-styled line. Matches pi's AssistantMessage layout
	 * (a Spacer(1) then a single themed error Text). */
	const renderErrorLine = (text: string): void => {
		if (emitted) out.push(" ".repeat(width));
		out.push(plainLine(` ${theme.fg("error", text)}`));
		emitted = true;
	};

	/**
	 * The tail pi renders after an assistant message, reproduced exactly from
	 * dist/modes/interactive/components/assistant-message.js:
	 *
	 * - stopReason "length" always prints the truncation line, tool calls or not
	 *   — a length stop can land mid-tool-call, and without this a truncated
	 *   transcript reads as a complete one.
	 * - otherwise, only when there are no tool calls (tool components carry the
	 *   error themselves): "aborted" prints errorMessage unless it is the generic
	 *   "Request was aborted", and "error" prints an "Error: " prefix with
	 *   "Unknown error" as the fallback.
	 */
	const renderStopTail = (msg: ConsoleAssistantMessage, hasToolCalls: boolean): void => {
		if (msg.stopReason === "length") {
			renderErrorLine("Response was truncated before completion.");
			return;
		}
		if (hasToolCalls) return;
		if (msg.stopReason === "aborted") {
			renderErrorLine(
				msg.errorMessage && msg.errorMessage !== "Request was aborted" ? msg.errorMessage : "Operation aborted",
			);
		} else if (msg.stopReason === "error") {
			renderErrorLine(`Error: ${msg.errorMessage || "Unknown error"}`);
		}
	};

	/** Title header for a tool box, per tool. */
	const toolTitle = (name: string, args: Record<string, unknown>): string => {
		switch (name) {
			case "bash":
				return `$ ${String(args.command ?? "")}`;
			case "read":
				return `read ${String(args.path ?? "")}`;
			case "write":
				return `write ${String(args.path ?? "")}`;
			case "edit":
				return `edit ${String(args.path ?? "")}`;
			case "grep":
				return `grep /${String(args.pattern ?? "")}/`;
			case "find":
				return `find ${String(args.pattern ?? "")}`;
			case "ls":
				return `ls ${String(args.path ?? "")}`;
			case "submit_result":
				return "submit_result";
			default:
				return Object.keys(args).length > 0 ? `${name} ${JSON.stringify(args)}` : name;
		}
	};

	/**
	 * Strip ANSI/C0/C1 control bytes from RAW model/user text before it is
	 * wrapped: a stray control byte occupies no display column but does move the
	 * cursor, breaking the renderer's exact-width contract. Applied to user,
	 * assistant, and thinking text (tool-result previews already used it).
	 */
	const sanitize = (text: string): string => {
		let out = stripTerminalSequences(text);
		// Layout controls become spaces BEFORE the control sweep so words on either
		// side of a tab or carriage return do not fuse. Mirrors cleanConsoleInput in
		// panel.ts; \n survives because the caller splits on it.
		out = out.replace(/\t/g, "   ").replace(/[\r\v\f]/g, " ");
		// Everything else in C0/DEL/C1 is unprintable: NUL, BEL, BS, and the eight-
		// bit control range all corrupt the paint if they reach a rendered line.
		return out.replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/g, "");
	};

	/**
	 * Tool output inside a result box. Transcript content is always complete;
	 * there is no display mode that collapses evidence.
	 *
	 * pi's console also prints an elapsed line ("Took …s") for bash boxes, but
	 * the input shape carries no per-tool start timestamps, so the elapsed line
	 * is deliberately omitted — nothing is invented.
	 */
	const resultPreview = (_name: string, result: ConsoleToolResultMessage): string[] => {
		// A synthetic running result carries partial output: show it dimmed inside the pending box instead of nothing until completion.
		const running = result.status === "running";
		const style = (s: string): string =>
			running ? theme.fg("dim", s) : result.isError ? theme.fg("error", s) : theme.fg("toolOutput", s);
		const text = sanitize(result.content.map((p) => p.text).join("\n"));
		if (running && text === "") return [];
		return text.split("\n").map(style);
	};

	const renderToolCall = (call: ConsoleToolCallPart, stopReason?: string): void => {
		const result = resultsById.get(call.id);
		const running = result?.status === "running";
		// A resultless tool call on an aborted/errored run never finished: render error-styled with a status label, never as pending.
		const failed = !result && (stopReason === "aborted" || stopReason === "error");
		const bg: BgToken = failed
			? "toolErrorBg"
			: !result || running
				? "toolPendingBg"
				: result.isError
					? "toolErrorBg"
					: "toolSuccessBg";
		pushSpacer();
		out.push(bgBlank(bg));
		const header = toolTitle(call.name, call.arguments);
		const labelled = failed ? `${header} [${stopReason}]` : running ? `${header} [running]` : header;
		// Wrap the header (long commands/paths) instead of truncating its tail.
		for (const wl of wrapTextWithAnsi(labelled, contentWidth)) {
			out.push(padPaint(bg, theme.fg("toolTitle", theme.bold(wl))));
		}
		const preview = result ? resultPreview(call.name, result) : [];
		if (preview.length > 0) {
			out.push(bgBlank(bg));
			for (const line of preview) {
				for (const wl of wrapTextWithAnsi(line, contentWidth)) out.push(padPaint(bg, wl));
			}
		}
		out.push(bgBlank(bg));
		emitted = true;
	};

	// ---- conversation walk -------------------------------------------------

	for (const msg of messages) {
		if (msg.role === "user") {
			renderUser(msg);
			continue;
		}
		if (msg.role === "toolResult") {
			continue; // consumed by tool boxes via resultsById; never rendered directly
		}
		// assistant — walk content parts in order: text runs, thinking runs, tool boxes.
		const hasToolCalls = msg.content.some((p) => p.type === "toolCall");
		let i = 0;
		while (i < msg.content.length) {
			const part = msg.content[i];
			if (part.type === "text") {
				const texts = [part.text];
				i++;
				for (; i < msg.content.length; i++) {
					const next = msg.content[i];
					if (next.type !== "text") break;
					texts.push(next.text);
				}
				if (texts.some((t) => !isBlank(t))) renderTextRun(texts.join("\n"));
			} else if (part.type === "thinking") {
				const thinking: ConsoleThinkingPart[] = [part];
				i++;
				for (; i < msg.content.length; i++) {
					const next = msg.content[i];
					if (next.type !== "thinking") break;
					thinking.push(next);
				}
				if (thinking.some((p) => !isBlank(p.thinking))) renderThinking(thinking);
			} else {
				renderToolCall(part, msg.stopReason);
				i++;
			}
		}
		renderStopTail(msg, hasToolCalls);
	}

	return out;
}
