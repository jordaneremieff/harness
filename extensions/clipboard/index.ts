/** macOS clipboard tools, stable history retrieval, and the /clipboard overlay. */

import type { Static } from "@earendil-works/pi-schema";
import { fileURLToPath } from "node:url";
import { type ExtensionAPI, type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import { publishSettings } from "./settings.ts";
import { clipboardContribution } from "./durable.ts";
import {
	clipboardCopy,
	clipboardGet,
	clipboardList,
	clipboardPaste,
	clipboardRestore,
	COPY_DESCRIPTION,
	COPY_GUIDELINES,
	COPY_SNIPPET,
	CopyParams,
	GET_DESCRIPTION,
	GET_SNIPPET,
	GetParams,
	LIST_DESCRIPTION,
	LIST_GUIDELINES,
	LIST_SNIPPET,
	ListParams,
	PASTE_DESCRIPTION,
	PASTE_SNIPPET,
	PasteParams,
	RESTORE_DESCRIPTION,
	RESTORE_SNIPPET,
	RestoreParams,
} from "./operations.ts";
import { type RestoreOutcome, ClipboardPanel } from "./panel.ts";
import { pbCopy } from "./pb.ts";
import { toolDisplay } from "./display.ts";
import { searchEntries } from "./search.ts";
import { appendEntry, type ClipboardEntry, makeEntry, readEntries, resolveClipboardDir } from "./store.ts";
import { safeLine, shortField } from "./text.ts";

const storeDir = () => resolveClipboardDir(process.env, getAgentDir());
const errorText = (error: unknown) => safeLine(error instanceof Error ? error.message : String(error));
/** Browser previews carry this content prefix; restore always reads the full archived record. */
const PREVIEW_CONTENT_CHARS = 32 * 1024;
const PANEL_ROWS = 200;
const SEARCH_PAGE_LIMIT = 25;

async function notifyRecent(ctx: ExtensionContext): Promise<void> {
	try {
		const entries = await readEntries(storeDir(), { limit: 5, contentChars: 0 });
		ctx.ui.notify(
			entries.length === 0
				? "Clipboard history is empty."
				: `Clipboard: ${entries.length} recent entries. Use clipboard_list in this mode.`,
			"info",
		);
	} catch (error) {
		ctx.ui.notify(`Could not open clipboard history: ${errorText(error)}`, "error");
	}
}

/** Recent list: metadata and preview only, with no content prefix read for any row. */
async function loadRecentEntries(signal?: AbortSignal): Promise<{ entries: ClipboardEntry[]; hasMore: boolean }> {
	const loaded = await readEntries(storeDir(), { limit: PANEL_ROWS + 1, contentChars: 0, signal });
	return { entries: loaded.slice(0, PANEL_ROWS), hasMore: loaded.length > PANEL_ROWS };
}

/** Read one record by stable id and its archive date; the date keeps the lookup on the selected record. */
async function readExactEntry(
	entry: ClipboardEntry,
	contentChars: number,
	signal: AbortSignal,
): Promise<ClipboardEntry> {
	const archived = (
		await readEntries(storeDir(), { id: entry.id, date: entry.archiveDate, contentChars, signal })
	)[0];
	if (!archived) throw new Error(`archive entry ${entry.id} is no longer available`);
	return archived;
}

async function restoreFromArchive(entry: ClipboardEntry, signal: AbortSignal): Promise<RestoreOutcome> {
	let archived: ClipboardEntry;
	try {
		archived = await readExactEntry(entry, Number.POSITIVE_INFINITY, signal);
		await pbCopy(archived.content, signal);
	} catch (error) {
		return { ok: false, error: error instanceof Error ? error.message : String(error) };
	}
	const warning = await appendEntry(
		storeDir(),
		makeEntry(archived.content, archived.label ? `${archived.label} (restored)` : "restored"),
	);
	return warning ? { ok: true, warning } : { ok: true };
}

function notifyRestored(
	ctx: ExtensionContext,
	result: { restored?: ClipboardEntry; warning?: string } | undefined,
): void {
	if (!result?.restored) return;
	const label = result.restored.label ? ` | ${shortField(result.restored.label)}` : "";
	const message = `Restored (${result.restored.lines}L/${result.restored.chars}c)${label}${
		result.warning ? `. Archive warning: ${safeLine(result.warning)}` : ""
	}`;
	ctx.ui.notify(message, result.warning ? "warning" : "info");
}

export default function (pi: ExtensionAPI) {
	const stopSettings = publishSettings(pi.events, { agentDir: getAgentDir() });
	pi.on("session_shutdown", () => stopSettings());
	pi.events.emit(
		"durable:contribution",
		clipboardContribution(fileURLToPath(import.meta.url), pi.events, stopSettings),
	);

	const presentation = new Map(toolDisplay().tools.map((tool) => [tool.name, tool]));
	const presentationFor = (name: string) => {
		const tool = presentation.get(name);
		if (!tool) throw new Error(`clipboard display descriptor lacks ${name}`);
		return { renderCall: tool.renderCall, renderResult: tool.renderResult, renderShell: tool.renderShell };
	};

	pi.registerTool<typeof CopyParams, Record<string, unknown>>({
		name: "clipboard_copy",
		label: "Clipboard copy",
		description: COPY_DESCRIPTION,
		promptSnippet: COPY_SNIPPET,
		promptGuidelines: COPY_GUIDELINES,
		parameters: CopyParams,
		...presentationFor("clipboard_copy"),
		async execute(_toolCallId, params: Static<typeof CopyParams>, signal) {
			return clipboardCopy(storeDir(), params, signal);
		},
	});

	pi.registerTool<typeof PasteParams, Record<string, unknown>>({
		name: "clipboard_paste",
		label: "Clipboard paste",
		description: PASTE_DESCRIPTION,
		promptSnippet: PASTE_SNIPPET,
		parameters: PasteParams,
		...presentationFor("clipboard_paste"),
		async execute(_toolCallId, params: Static<typeof PasteParams>, signal) {
			return clipboardPaste(params, signal);
		},
	});

	pi.registerTool<typeof ListParams, Record<string, unknown>>({
		name: "clipboard_list",
		label: "Clipboard list",
		description: LIST_DESCRIPTION,
		promptSnippet: LIST_SNIPPET,
		promptGuidelines: LIST_GUIDELINES,
		parameters: ListParams,
		...presentationFor("clipboard_list"),
		async execute(_toolCallId, params: Static<typeof ListParams>, signal) {
			return clipboardList(storeDir(), params, signal);
		},
	});

	pi.registerTool<typeof GetParams, Record<string, unknown>>({
		name: "clipboard_get",
		label: "Clipboard get",
		description: GET_DESCRIPTION,
		promptSnippet: GET_SNIPPET,
		parameters: GetParams,
		...presentationFor("clipboard_get"),
		async execute(_toolCallId, params: Static<typeof GetParams>, signal) {
			return clipboardGet(storeDir(), params, signal);
		},
	});

	pi.registerTool<typeof RestoreParams, Record<string, unknown>>({
		name: "clipboard_restore",
		label: "Clipboard restore",
		description: RESTORE_DESCRIPTION,
		promptSnippet: RESTORE_SNIPPET,
		parameters: RestoreParams,
		...presentationFor("clipboard_restore"),
		async execute(_toolCallId, params: Static<typeof RestoreParams>, signal) {
			return clipboardRestore(storeDir(), params, signal);
		},
	});

	pi.registerCommand("clipboard", {
		description: "Browse clipboard history in an interactive overlay (recent, archive search, preview, restore)",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") {
				await notifyRecent(ctx);
				return;
			}
			let loaded: { entries: ClipboardEntry[]; hasMore: boolean };
			try {
				loaded = await loadRecentEntries();
			} catch (error) {
				ctx.ui.notify(`Could not open clipboard history: ${errorText(error)}`, "error");
				return;
			}
			const { entries, hasMore } = loaded;
			const result = await ctx.ui.custom<{ restored?: ClipboardEntry; warning?: string }>(
				(tui, theme, _keybindings, done) =>
					new ClipboardPanel({
						entries,
						theme,
						tui,
						getMaxRows: () => Math.max(1, tui.terminal.rows - 2),
						hasMore,
						done,
						onRestore: restoreFromArchive,
						onPreview: (entry, signal) => readExactEntry(entry, PREVIEW_CONTENT_CHARS, signal),
						onRecent: loadRecentEntries,
						onSearch: (query, cursor, signal) =>
							searchEntries(storeDir(), { query, cursor, limit: SEARCH_PAGE_LIMIT, signal }),
					}),
				{ overlay: true, overlayOptions: { width: "88%", minWidth: 40, anchor: "center", margin: 1 } },
			);
			notifyRestored(ctx, result);
		},
	});

	const publishDisplay = () => pi.events.emit("harness:tool-display:publish", toolDisplay());
	pi.events.on("harness:tool-display:request", (request) => {
		if (typeof request === "object" && request !== null && "version" in request && request.version === 1) {
			publishDisplay();
		}
	});
	publishDisplay();
}
