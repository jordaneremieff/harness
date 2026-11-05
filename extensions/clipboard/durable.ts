/**
 * Native Pi Durable form of the clipboard tools.
 *
 * The ordinary factory emits this contribution on the `durable:contribution`
 * channel. A Durable session host builds the extension from it, so Durable
 * agents keep the clipboard capability without ordinary session APIs. The
 * archive stays the external store the ordinary tools use; this contribution
 * adds no Durable documents.
 *
 * Replay classification: paste, list, and get only read the clipboard or the
 * archive, so a rerun after process loss repeats no external effect. Copy and
 * restore write the clipboard, so a rerun would overwrite newer clipboard
 * content; copy also appends an archive record.
 *
 * The ordinary tools expose presentation details but no structured content, so
 * the native tools map content to output and keep the details object.
 * Without a structured schema, Pi Durable supplies bounded output text to
 * nested callers through structuredOutput.
 */

import type * as Durable from "@earendil-works/pi-durable";
import { loadRecentEntries, PREVIEW_CONTENT_CHARS, readExactEntry, restoreFromArchive, searchArchive } from "./browser-operations.ts";
import { readPanelRequest, type ClipboardPanelAnswer, type ClipboardPanelRequest } from "./panel-protocol.ts";
import { publishSettings, type SettingsBus } from "./settings.ts";
import {
	clipboardCopy,
	clipboardGet,
	clipboardList,
	clipboardPaste,
	clipboardRestore,
	CLIPBOARD_GUIDANCE,
	COPY_DESCRIPTION,
	CopyParams,
	GET_DESCRIPTION,
	GetParams,
	LIST_DESCRIPTION,
	ListParams,
	PASTE_DESCRIPTION,
	PasteParams,
	RESTORE_DESCRIPTION,
	RestoreParams,
} from "./operations.ts";
import { resolveClipboardDir } from "./store.ts";
import { safeLine, shortField } from "./text.ts";

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

/** One command invocation as the agent host dispatches it; this slice reads these members. */
export interface DurableCommandCall {
	readonly args: string;
	readonly data?: JsonValue;
	readonly origin?: "operator" | "model";
	readonly host: DurableContributionHost;
	readonly context: { readonly abortSignal?: AbortSignal };
	readonly invocationId: string;
}

export interface DurableCommand {
	readonly name: string;
	readonly description: string;
	run(call: DurableCommandCall): Promise<string | { text: string; data?: JsonValue }>;
}

/** Durable extension name; unique across contributions. */
export interface DurableContribution {
	readonly name: string;
	/** Absolute path of the emitting extension's entrypoint. */
	readonly source: string;
	/** Side-effect-free presentation module for standalone tool cards. */
	readonly display: { readonly version: 1; readonly entry: "./display.ts"; readonly export: "toolDisplay" };
	/** The browser module for the attached terminal and the command that serves it. */
	readonly panel: { readonly version: 1; readonly entry: "./operator-panel.ts"; readonly export: "operatorPanel"; readonly command: "clipboard" };
	readonly commands: readonly DurableCommand[];
	/** Build the native extension for one session host; called once per host. */
	create(host: DurableContributionHost): Durable.Extension | Promise<Durable.Extension>;
}

/** The host members this contribution uses. */
export interface DurableContributionHost {
	/** The host's pi-durable module. Take every pi-durable runtime value from it. */
	readonly durable: typeof Durable;
	readonly agentDir: string;
	onClose(dispose: () => void | Promise<void>): void;
}

async function nativeResult(
	operation: Promise<{
		content: NonNullable<Durable.ToolExecutionResult["output"]>;
		details: Durable.ToolExecutionResult["details"];
	}>,
): Promise<Durable.ToolExecutionResult> {
	const { content, details } = await operation;
	return { output: content, details };
}

export const CLIPBOARD_COMMAND_DESCRIPTION = "Browse clipboard history: recent entries as text, or the browser's structured reads and restore";

/** Chord carries JSON; drop undefined members before an answer crosses the wire. */
const json = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** Text callers get a bounded recent listing; exact records stay with clipboard_list and clipboard_get. */
async function recentListing(dir: string, signal: AbortSignal | undefined): Promise<string> {
	const { entries, hasMore } = await loadRecentEntries(dir, signal);
	if (entries.length === 0) return "Clipboard history is empty.";
	const lines = entries.slice(0, 10).map((entry) => `${entry.id} · ${entry.timestamp} · ${shortField(entry.label ?? entry.preview, 80)} · ${entry.chars}c`);
	return `Clipboard history: ${entries.length}${hasMore ? "+" : ""} recent entries. Use clipboard_list and clipboard_get for exact records.\n${lines.join("\n")}`;
}

async function answerRequest(dir: string, request: ClipboardPanelRequest, signal: AbortSignal | undefined): Promise<ClipboardPanelAnswer> {
	switch (request.op) {
		case "recent": return { op: "recent", ...(await loadRecentEntries(dir, signal)) };
		case "search": return { op: "search", page: await searchArchive(dir, request.query, request.cursor, signal) };
		case "preview": return { op: "preview", entry: await readExactEntry(dir, request, PREVIEW_CONTENT_CHARS, signal) };
		case "restore": return { op: "restore", ...(await restoreFromArchive(dir, request, signal)) };
	}
}

/** One bounded line about the answer for text consumers of the same command. */
function answerSummary(request: ClipboardPanelRequest, answer: ClipboardPanelAnswer): string {
	switch (answer.op) {
		case "recent": return `${answer.entries.length}${answer.hasMore ? "+" : ""} recent entries`;
		case "search": return `${answer.page.matches.length} matches; stop ${answer.page.stop}`;
		case "preview": return `entry ${answer.entry.id} (${answer.entry.chars}c)`;
		case "restore": {
			const id = request.op === "restore" ? request.id : "";
			return answer.ok ? `restored ${id}` : `restore failed: ${safeLine(answer.error)}`;
		}
	}
}

/** The browser's operations against this host's archive. */
async function runBrowserCommand(dir: string, call: DurableCommandCall): Promise<string | { text: string; data: JsonValue }> {
	const signal = call.context.abortSignal;
	if (call.data === undefined) return recentListing(dir, signal);
	const request = readPanelRequest(call.data);
	const answer = await answerRequest(dir, request, signal);
	return { text: answerSummary(request, answer), data: json(answer) as unknown as JsonValue };
}

/** The ordinary entrypoint this contribution speaks for, as its factory resolves it. */
export function clipboardContribution(
	source: string,
	bus: SettingsBus,
	stopFactoryPublisher: () => void,
): DurableContribution {
	return {
		name: "clipboard",
		source,
		display: { version: 1, entry: "./display.ts", export: "toolDisplay" },
		panel: { version: 1, entry: "./operator-panel.ts", export: "operatorPanel", command: "clipboard" },
		commands: [{
			name: "clipboard",
			description: CLIPBOARD_COMMAND_DESCRIPTION,
			run: (call) => runBrowserCommand(resolveClipboardDir(process.env, call.host.agentDir), call),
		}],
		create(host) {
			stopFactoryPublisher();
			host.onClose(publishSettings(bus, { agentDir: host.agentDir }));
			const durable = host.durable;
			const storeDir = () => resolveClipboardDir(process.env, host.agentDir);
			return durable.defineExtension({
				name: "clipboard",
				tools: [
					durable.defineTool({
						name: "clipboard_copy",
						description: COPY_DESCRIPTION,
						parameters: CopyParams,
						replay: "unsafe",
						execute: (args, _api, context) => nativeResult(clipboardCopy(storeDir(), args, context.abortSignal)),
					}),
					durable.defineTool({
						name: "clipboard_paste",
						description: PASTE_DESCRIPTION,
						parameters: PasteParams,
						replay: "safe",
						execute: (args, _api, context) => nativeResult(clipboardPaste(args, context.abortSignal)),
					}),
					durable.defineTool({
						name: "clipboard_list",
						description: LIST_DESCRIPTION,
						parameters: ListParams,
						replay: "safe",
						execute: (args, _api, context) => nativeResult(clipboardList(storeDir(), args, context.abortSignal)),
					}),
					durable.defineTool({
						name: "clipboard_get",
						description: GET_DESCRIPTION,
						parameters: GetParams,
						replay: "safe",
						execute: (args, _api, context) => nativeResult(clipboardGet(storeDir(), args, context.abortSignal)),
					}),
					durable.defineTool({
						name: "clipboard_restore",
						description: RESTORE_DESCRIPTION,
						parameters: RestoreParams,
						replay: "unsafe",
						execute: (args, _api, context) => nativeResult(clipboardRestore(storeDir(), args, context.abortSignal)),
					}),
				],
				sections: [durable.section("clipboard", () => CLIPBOARD_GUIDANCE)],
			});
		},
	};
}
