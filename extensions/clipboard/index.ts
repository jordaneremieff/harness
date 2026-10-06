/** macOS clipboard tools, stable history retrieval, and the /clipboard overlay. */

import { fileURLToPath } from "node:url";
import { type ExtensionAPI, type ToolDefinition, type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";
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
import { ClipboardPanel, type RestoreOutcome } from "./panel.ts";
import { pbCopy } from "./pb.ts";
import {
	renderCopyCall,
	renderCopyResult,
	renderGetCall,
	renderGetResult,
	renderListCall,
	renderListResult,
	renderPasteCall,
	renderPasteResult,
	renderRestoreCall,
	renderRestoreResult,
} from "./presentation.ts";
import { appendEntry, type ClipboardEntry, makeEntry, readEntries, resolveClipboardDir } from "./store.ts";
import { safeLine, shortField } from "./text.ts";

const storeDir = () => resolveClipboardDir(process.env, getAgentDir());
const errorText = (error: unknown) => safeLine(error instanceof Error ? error.message : String(error));

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

async function loadPanelEntries(): Promise<{ entries: ClipboardEntry[]; hasMore: boolean }> {
	const loaded = await readEntries(storeDir(), { limit: 201, contentChars: 32 * 1024 });
	return { entries: loaded.slice(0, 200), hasMore: loaded.length > 200 };
}

async function restoreFromArchive(entry: ClipboardEntry, signal: AbortSignal): Promise<RestoreOutcome> {
	let archived: ClipboardEntry | undefined;
	try {
		archived = (await readEntries(storeDir(), { id: entry.id, signal }))[0];
		if (!archived) return { ok: false, error: `archive entry ${entry.id} is no longer available` };
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
	const displayTools: Pick<ToolDefinition, "name" | "renderCall" | "renderResult" | "renderShell">[] = [];
	const registerTool: ExtensionAPI["registerTool"] = (tool) => {
		pi.registerTool(tool);
		const { name, renderCall, renderResult, renderShell } = tool;
		if (renderCall || renderResult || renderShell) {
			displayTools.push({ name, renderCall, renderResult, renderShell } as (typeof displayTools)[number]);
		}
	};
	pi.events.emit("durable:contribution", clipboardContribution(fileURLToPath(import.meta.url)));

	registerTool<typeof CopyParams, Record<string, unknown>>({
		name: "clipboard_copy",
		label: "Clipboard copy",
		description: COPY_DESCRIPTION,
		promptSnippet: COPY_SNIPPET,
		promptGuidelines: COPY_GUIDELINES,
		parameters: CopyParams,
		renderCall: (args, theme, context) => renderCopyCall(args, theme, context),
		renderResult: (result, options, theme, context) => renderCopyResult(result, options, theme, context),
		async execute(_toolCallId, params, signal) {
			return clipboardCopy(storeDir(), params, signal);
		},
	});

	registerTool<typeof PasteParams, Record<string, unknown>>({
		name: "clipboard_paste",
		label: "Clipboard paste",
		description: PASTE_DESCRIPTION,
		promptSnippet: PASTE_SNIPPET,
		parameters: PasteParams,
		renderCall: (args, theme, context) => renderPasteCall(args, theme, context),
		renderResult: (result, options, theme, context) => renderPasteResult(result, options, theme, context),
		async execute(_toolCallId, params, signal) {
			return clipboardPaste(params, signal);
		},
	});

	registerTool<typeof ListParams, Record<string, unknown>>({
		name: "clipboard_list",
		label: "Clipboard list",
		description: LIST_DESCRIPTION,
		promptSnippet: LIST_SNIPPET,
		promptGuidelines: LIST_GUIDELINES,
		parameters: ListParams,
		renderCall: (args, theme, context) => renderListCall(args, theme, context),
		renderResult: (result, options, theme, context) => renderListResult(result, options, theme, context),
		async execute(_toolCallId, params, signal) {
			return clipboardList(storeDir(), params, signal);
		},
	});

	registerTool<typeof GetParams, Record<string, unknown>>({
		name: "clipboard_get",
		label: "Clipboard get",
		description: GET_DESCRIPTION,
		promptSnippet: GET_SNIPPET,
		parameters: GetParams,
		renderCall: (args, theme, context) => renderGetCall(args, theme, context),
		renderResult: (result, options, theme, context) => renderGetResult(result, options, theme, context),
		async execute(_toolCallId, params, signal) {
			return clipboardGet(storeDir(), params, signal);
		},
	});

	registerTool<typeof RestoreParams, Record<string, unknown>>({
		name: "clipboard_restore",
		label: "Clipboard restore",
		description: RESTORE_DESCRIPTION,
		promptSnippet: RESTORE_SNIPPET,
		parameters: RestoreParams,
		renderCall: (args, theme, context) => renderRestoreCall(args, theme, context),
		renderResult: (result, options, theme, context) => renderRestoreResult(result, options, theme, context),
		async execute(_toolCallId, params, signal) {
			return clipboardRestore(storeDir(), params, signal);
		},
	});

	pi.registerCommand("clipboard", {
		description: "Browse clipboard history in an interactive overlay (filter, preview, restore)",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") {
				await notifyRecent(ctx);
				return;
			}
			let loaded: { entries: ClipboardEntry[]; hasMore: boolean };
			try {
				loaded = await loadPanelEntries();
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
					}),
				{ overlay: true, overlayOptions: { width: "88%", minWidth: 40, anchor: "center", margin: 1 } },
			);
			notifyRestored(ctx, result);
		},
	});
	const publishDisplay = () => pi.events.emit("harness:tool-display:publish", { version: 1, tools: displayTools });
	pi.events.on("harness:tool-display:request", (request) => {
		if (typeof request === "object" && request !== null && "version" in request && request.version === 1) {
			publishDisplay();
		}
	});
	publishDisplay();
}
