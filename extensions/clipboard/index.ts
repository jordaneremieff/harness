/** macOS clipboard tools, stable history retrieval, and the /clipboard view in the shared browsing frame. */

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
import { openOperatorFrame, publishOperatorViews, type ViewHost } from "../../operator-ui/index.ts";
import { loadRecentEntries, PREVIEW_CONTENT_CHARS, readExactEntry, restoreFromArchive, searchArchive } from "./browser-operations.ts";
import { toolDisplay } from "./display.ts";
import { type ClipboardOperations, clipboardView, createClipboardViewState } from "./operator-view.ts";
import { readEntries, resolveClipboardDir } from "./store.ts";
import { safeLine } from "./text.ts";

const OWNER = fileURLToPath(import.meta.url);
const storeDir = () => resolveClipboardDir(process.env, getAgentDir());
const errorText = (error: unknown) => safeLine(error instanceof Error ? error.message : String(error));

/** The archive operations behind the ordinary view, read at the moment of each call. */
const archiveOperations: ClipboardOperations = {
	recent: (signal) => loadRecentEntries(storeDir(), signal),
	search: (query, cursor, signal) => searchArchive(storeDir(), query, cursor, signal),
	preview: (entry, signal) => readExactEntry(storeDir(), entry, PREVIEW_CONTENT_CHARS, signal),
	restore: (entry, signal) => restoreFromArchive(storeDir(), entry, signal),
};

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

export default function (pi: ExtensionAPI) {
	const viewState = createClipboardViewState();
	publishOperatorViews(pi, {
		version: 2,
		owner: OWNER,
		views: [{ id: "clipboard", label: "Clipboard", command: { name: "clipboard" }, order: 20, view: (_ctx, host: ViewHost) => clipboardView(host, archiveOperations, viewState) }],
	});
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
		description: "Browse clipboard history: recent entries, archive search, the exact record, and Restore",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") {
				await notifyRecent(ctx);
				return;
			}
			await openOperatorFrame(pi, ctx, { owner: OWNER, id: "clipboard" });
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
