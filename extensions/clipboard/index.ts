/** macOS clipboard tools, stable history retrieval, and the /clipboard overlay. */

import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { ClipboardPanel } from "./panel.ts";
import { pbCopy, pbPaste } from "./pb.ts";
import { appendEntry, makeEntry, readEntries, resolveClipboardDir, type ClipboardEntry } from "./store.ts";
import { boundedOutput, sanitizeTerminalText } from "./text.ts";

const PAGE_CHARS = 8000;
const PAGE_LINES = 1900;
const storeDir = () => resolveClipboardDir(process.env, getAgentDir());
const safe = (value: string) => sanitizeTerminalText(value).text;
const safeLine = (value: string) => safe(value).replace(/\n/g, "↵");
const shortField = (value: string, max = 200) => Array.from(safeLine(value)).slice(0, max).join("");

const CopyParams = Type.Object({
	content: Type.String({ description: "Content to copy to the clipboard", maxLength: 8 * 1024 * 1024 }),
	label: Type.Optional(Type.String({ description: "Brief label for what was copied", maxLength: 200 })),
});

const PasteParams = Type.Object({
	offset: Type.Optional(Type.Integer({ description: "Unicode-character offset (default 0)", minimum: 0, default: 0 })),
	max_chars: Type.Optional(
		Type.Integer({ description: `Maximum Unicode characters in this page (default and max ${PAGE_CHARS})`, minimum: 1, maximum: PAGE_CHARS, default: PAGE_CHARS }),
	),
});

const ListParams = Type.Object({
	limit: Type.Optional(Type.Integer({ description: "Max entries (default 10, max 50)", minimum: 1, maximum: 50, default: 10 })),
	date: Type.Optional(Type.String({ description: "YYYY-MM-DD local date", pattern: "^\\d{4}-\\d{2}-\\d{2}$" })),
});

const GetParams = Type.Object({
	id: Type.String({ description: "Stable entry id from clipboard_list", minLength: 1, maxLength: 200 }),
	date: Type.Optional(Type.String({ description: "YYYY-MM-DD local date to narrow the scan", pattern: "^\\d{4}-\\d{2}-\\d{2}$" })),
	offset: Type.Optional(Type.Integer({ description: "Unicode-character offset (default 0)", minimum: 0, default: 0 })),
	max_chars: Type.Optional(
		Type.Integer({ description: `Maximum Unicode characters in this page (default and max ${PAGE_CHARS})`, minimum: 1, maximum: PAGE_CHARS, default: PAGE_CHARS }),
	),
});

const RestoreParams = Type.Object({
	id: Type.String({ description: "Stable entry id from clipboard_list", minLength: 1, maxLength: 200 }),
	date: Type.Optional(Type.String({ description: "YYYY-MM-DD local date to narrow the scan", pattern: "^\\d{4}-\\d{2}-\\d{2}$" })),
});

interface Page {
	text: string;
	offset: number;
	nextOffset?: number;
	totalChars: number;
}

function countCharacters(content: string): number {
	let count = 0;
	for (const _char of content) count++;
	return count;
}

function pageText(content: string, offset: number, maxChars: number, totalChars: number): Page {
	const start = Math.min(Math.max(0, offset), totalChars);
	let sourceIndex = 0;
	let consumed = 0;
	let lines = 1;
	let text = "";
	for (const char of content) {
		if (sourceIndex++ < start) continue;
		if (consumed >= maxChars || (char === "\n" && lines >= PAGE_LINES)) break;
		text += char;
		consumed++;
		if (char === "\n") lines++;
	}
	const next = start + consumed;
	return { text, offset: start, nextOffset: next < totalChars ? next : undefined, totalChars };
}

function pageResult(
	prefix: string,
	content: string,
	offset: number,
	maxChars: number,
	totalChars: number,
	continuation: (next: number) => string,
) {
	const page = pageText(content, offset, maxChars, totalChars);
	const sanitized = sanitizeTerminalText(page.text);
	const more = page.nextOffset === undefined ? "" : `\n\n[More content available. ${continuation(page.nextOffset)}]`;
	const bounded = boundedOutput(`${prefix}\n\n${sanitized.text}${more}`, page.nextOffset === undefined ? undefined : continuation(page.nextOffset));
	return { page, sanitized, bounded };
}

export default function (pi: ExtensionAPI) {
	pi.registerTool<typeof CopyParams, Record<string, unknown>>({
		name: "clipboard_copy",
		label: "Clipboard copy",
		description:
			"Copy content to the macOS clipboard. Every write is appended to the private daily archive at <agentDir>/clipboard/YYYY-MM-DD.jsonl.",
		promptSnippet: "Copy content to the macOS clipboard for pasting into external destinations",
		promptGuidelines: [
			"Use clipboard_copy when the operator asks for content to copy-paste. Do not use the clipboard archive as storage for a handover or durable reference.",
			"If the operator asks to recover something previously copied, use clipboard_list then clipboard_restore; if they ask what is currently on the clipboard, use clipboard_paste.",
		],
		parameters: CopyParams,
		async execute(_toolCallId, params, signal) {
			if (signal?.aborted) throw new Error("clipboard_copy cancelled");
			try {
				await pbCopy(params.content, signal);
			} catch (error) {
				throw new Error(`pbcopy failed: ${error instanceof Error ? error.message : String(error)}`);
			}
			const entry = makeEntry(params.content, params.label);
			const archiveError = await appendEntry(storeDir(), entry);
			const label = params.label ? ` | ${safeLine(params.label)}` : "";
			const warning = archiveError ? `\nWarning: archive write failed: ${safeLine(archiveError)}` : "";
			const preview = safeLine(entry.preview);
			const previewTruncated = entry.chars > countCharacters(entry.preview);
			return {
				content: [
					{
						type: "text" as const,
						text: `Copied to clipboard${label} (${entry.lines} lines, ${entry.chars} chars)${warning}\nPreview: ${preview}${previewTruncated ? "…" : ""}`,
					},
				],
				details: { id: entry.id, lines: entry.lines, chars: entry.chars, label: params.label, archiveError: archiveError ?? undefined },
			};
		},
	});

	pi.registerTool<typeof PasteParams, Record<string, unknown>>({
		name: "clipboard_paste",
		label: "Clipboard paste",
		description:
			"Read the current macOS clipboard. Output is paged and capped; use offset from a truncated response to continue. Do not call speculatively.",
		promptSnippet: "Read the current macOS clipboard contents",
		parameters: PasteParams,
		async execute(_toolCallId, params, signal) {
			if (signal?.aborted) throw new Error("clipboard_paste cancelled");
			let content: string;
			try {
				content = await pbPaste(signal);
			} catch (error) {
				throw new Error(`pbpaste failed: ${error instanceof Error ? error.message : String(error)}`);
			}
			if (content.length === 0) {
				return { content: [{ type: "text" as const, text: "Clipboard is empty." }], details: { lines: 0, chars: 0 } };
			}
			const offset = params.offset ?? 0;
			const totalCharacters = countCharacters(content);
			if (offset >= totalCharacters) throw new Error(`clipboard offset ${offset} is outside ${totalCharacters} characters`);
			const lines = content.split("\n").length;
			const result = pageResult(
				`Clipboard contents (${lines} lines, ${totalCharacters} characters):`,
				content,
				offset,
				params.max_chars ?? PAGE_CHARS,
				totalCharacters,
				(next) => `Call clipboard_paste with offset ${next} to continue.`,
			);
			return {
				content: [{ type: "text" as const, text: result.bounded.text }],
				details: {
					lines,
					chars: totalCharacters,
					offset: result.page.offset,
					nextOffset: result.page.nextOffset,
					truncated: result.page.nextOffset !== undefined || result.bounded.truncated,
					controlsEscaped: result.sanitized.changed,
				},
			};
		},
	});

	async function findEntry(id: string, date: string | undefined, toolName: string): Promise<ClipboardEntry> {
		if (!id) throw new Error(`${toolName} requires a stable id from clipboard_list`);
		const entry = (await readEntries(storeDir(), { date, id }))[0];
		if (!entry) throw new Error(`no clipboard entry with id "${safeLine(id)}"${date ? ` for ${date}` : ""}`);
		return entry;
	}

	pi.registerTool<typeof ListParams, Record<string, unknown>>({
		name: "clipboard_list",
		label: "Clipboard list",
		description:
			"List entries from the append-only clipboard archive, newest first. Returns the stable ids used by clipboard_get and clipboard_restore.",
		promptSnippet: "List archived clipboard entries with stable ids",
		promptGuidelines: [
			"Use clipboard_list to find previously copied content, then clipboard_get to read one entry or clipboard_restore to put it back on the clipboard.",
		],
		parameters: ListParams,
		async execute(_toolCallId, params, signal) {
			if (signal?.aborted) throw new Error("clipboard_list cancelled");
			const scope = params.date ? ` for ${params.date}` : "";
			const limit = params.limit ?? 10;
			const entries = await readEntries(storeDir(), { date: params.date, limit: limit + 1, contentChars: 0 });
			const hasMore = entries.length > limit;
			const shown = entries.slice(0, limit);
			if (shown.length === 0) {
				return { content: [{ type: "text" as const, text: `Clipboard history${scope} is empty.` }], details: { count: 0, hasMore: false } };
			}
			const rows = shown.map((entry) => {
				const timestamp = safeLine(entry.timestamp.replace("T", " ").substring(0, 19));
				const label = entry.label ? ` [${shortField(entry.label)}]` : "";
				return `- ${timestamp}${label} (${entry.lines}L/${entry.chars}c)\n  id: ${entry.id}\n  ${shortField(entry.preview, 100)}`;
			});
			const more = hasMore ? "\n\n(More entries available; narrow by date to inspect older history.)" : "";
			const bounded = boundedOutput(
				`Clipboard history${scope} (${shown.length}${hasMore ? "+" : ""} entries, newest first):\n\n${rows.join("\n")}${more}`,
				"Lower limit or pass a date for a narrower list.",
			);
			return {
				content: [{ type: "text" as const, text: bounded.text }],
				details: {
					count: shown.length,
					hasMore,
					ids: shown.map((entry) => entry.id),
					truncated: hasMore || bounded.truncated,
				},
			};
		},
	});

	pi.registerTool<typeof GetParams, Record<string, unknown>>({
		name: "clipboard_get",
		label: "Clipboard get",
		description:
			"Read one archived clipboard entry by stable id from clipboard_list. Output is paged and capped; use offset from a truncated response to continue.",
		promptSnippet: "Read one archived clipboard entry by stable id",
		parameters: GetParams,
		async execute(_toolCallId, params, signal) {
			if (signal?.aborted) throw new Error("clipboard_get cancelled");
			const entry = await findEntry(params.id, params.date, "clipboard_get");
			const offset = params.offset ?? 0;
			const totalCharacters = entry.chars;
			if (offset >= totalCharacters && totalCharacters > 0) {
				throw new Error(`clipboard entry offset ${offset} is outside ${totalCharacters} characters`);
			}
			const label = entry.label ? ` | ${shortField(entry.label)}` : "";
			const result = pageResult(
				`Entry ${entry.id}${label} (${entry.lines} lines, ${totalCharacters} characters, ${safeLine(entry.timestamp)}):`,
				entry.content,
				offset,
				params.max_chars ?? PAGE_CHARS,
				totalCharacters,
				(next) => `Call clipboard_get with id "${entry.id}" and offset ${next} to continue.`,
			);
			return {
				content: [{ type: "text" as const, text: result.bounded.text }],
				details: {
					id: entry.id,
					lines: entry.lines,
					chars: totalCharacters,
					offset: result.page.offset,
					nextOffset: result.page.nextOffset,
					truncated: result.page.nextOffset !== undefined || result.bounded.truncated,
					controlsEscaped: result.sanitized.changed,
				},
			};
		},
	});

	pi.registerTool<typeof RestoreParams, Record<string, unknown>>({
		name: "clipboard_restore",
		label: "Clipboard restore",
		description:
			"Copy one archived entry back to the macOS clipboard by stable id from clipboard_list. The restore is archived as a new entry.",
		promptSnippet: "Restore an archived entry to the macOS clipboard",
		parameters: RestoreParams,
		async execute(_toolCallId, params, signal) {
			if (signal?.aborted) throw new Error("clipboard_restore cancelled");
			const entry = await findEntry(params.id, params.date, "clipboard_restore");
			try {
				// The signal must reach the child: without it an abort waits out the
				// 30s pbcopy timeout instead of rejecting promptly.
				await pbCopy(entry.content, signal);
			} catch (error) {
				throw new Error(`pbcopy failed: ${error instanceof Error ? error.message : String(error)}`);
			}
			const archiveError = await appendEntry(storeDir(), makeEntry(entry.content, entry.label ? `${entry.label} (restored)` : "restored"));
			const warning = archiveError ? ` Warning: archive write failed: ${safeLine(archiveError)}` : "";
			return {
				content: [
					{
						type: "text" as const,
						text: `Restored ${entry.id} to clipboard (${entry.lines} lines, ${entry.chars} chars).${warning}`,
					},
				],
				details: { id: entry.id, lines: entry.lines, chars: entry.chars, archiveError: archiveError ?? undefined },
			};
		},
	});

	pi.registerCommand("clipboard", {
		description: "Browse clipboard history in an interactive overlay (filter, preview, restore)",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				try {
					const entries = await readEntries(storeDir(), { limit: 5, contentChars: 0 });
					ctx.ui.notify(
						entries.length === 0
							? "Clipboard history is empty."
							: `Clipboard: ${entries.length} recent entries. Use clipboard_list in this mode.`,
						"info",
					);
				} catch (error) {
					ctx.ui.notify(`Could not open clipboard history: ${safeLine(error instanceof Error ? error.message : String(error))}`, "error");
				}
				return;
			}
			let entries: ClipboardEntry[];
			let hasMore = false;
			try {
				const loaded = await readEntries(storeDir(), { limit: 201, contentChars: 32 * 1024 });
				hasMore = loaded.length > 200;
				entries = loaded.slice(0, 200);
			} catch (error) {
				ctx.ui.notify(`Could not open clipboard history: ${safeLine(error instanceof Error ? error.message : String(error))}`, "error");
				return;
			}
			const result = await ctx.ui.custom<{ restored?: ClipboardEntry; warning?: string }>(
				(tui, theme, _keybindings, done) =>
					new ClipboardPanel({
						entries,
						theme,
						tui,
						getMaxRows: () => Math.max(1, tui.terminal.rows - 2),
						hasMore,
						done,
						onRestore: async (entry) => {
							let archived: ClipboardEntry | undefined;
							try {
								archived = (await readEntries(storeDir(), { id: entry.id }))[0];
								if (!archived) return { ok: false, error: `archive entry ${entry.id} is no longer available` };
								await pbCopy(archived.content);
							} catch (error) {
								return { ok: false, error: error instanceof Error ? error.message : String(error) };
							}
							const warning = await appendEntry(
								storeDir(),
								makeEntry(archived.content, archived.label ? `${archived.label} (restored)` : "restored"),
							);
							return warning ? { ok: true, warning } : { ok: true };
						},
					}),
				{ overlay: true, overlayOptions: { width: "88%", minWidth: 40, anchor: "center", margin: 1 } },
			);
			if (result?.restored) {
				const label = result.restored.label ? ` | ${shortField(result.restored.label)}` : "";
				const message = `Restored (${result.restored.lines}L/${result.restored.chars}c)${label}${
					result.warning ? `. Archive warning: ${safeLine(result.warning)}` : ""
				}`;
				ctx.ui.notify(message, result.warning ? "warning" : "info");
			}
		},
	});
}
