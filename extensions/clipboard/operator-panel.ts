/**
 * The clipboard browser for the attached Agent terminal. The client imports this module
 * locally and gives it a request route to the `clipboard` contribution command; the panel
 * itself is the same component the ordinary `/clipboard` overlay uses. Evaluating this module
 * registers nothing and opens no store.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import type { TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";
import { restoredNotice } from "./browser-operations.ts";
import { ClipboardPanel } from "./panel.ts";
import { readPanelAnswer, type ClipboardPanelRequest } from "./panel-protocol.ts";
import type { ClipboardEntry } from "./store.ts";

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

/** The facilities the attached terminal passes to an owner panel (docs/conventions/operator-panels.md). */
export interface OperatorPanelHost {
	readonly target: { readonly id: string; readonly name?: string };
	readonly theme: Theme;
	readonly tui: { requestRender(): void };
	rows(): number;
	request(data: JsonValue, signal?: AbortSignal): Promise<{ text: string; data?: JsonValue }>;
	readonly dialogs: { notify(text: string, type?: "info" | "warning" | "error"): void };
	close(): void;
}

export interface OperatorPanelInstance {
	render(width: number): string[];
	handleInput(data: string): void;
	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined;
	invalidate(): void;
	dispose(): void;
}

const key = (entry: Pick<ClipboardEntry, "id" | "archiveDate">) => ({ id: entry.id, ...(entry.archiveDate === undefined ? {} : { archiveDate: entry.archiveDate }) });

function open(host: OperatorPanelHost): OperatorPanelInstance {
	const ask = async (request: ClipboardPanelRequest, signal: AbortSignal) => readPanelAnswer(request, (await host.request(request as JsonValue, signal)).data);
	let disposed = false;
	const panel = new ClipboardPanel({
		entries: [],
		theme: host.theme,
		tui: host.tui,
		getMaxRows: () => host.rows(),
		done: (result) => {
			if (result.restored) {
				const notice = restoredNotice(result.restored, result.warning);
				host.dialogs.notify(notice.text, notice.type);
			}
			host.close();
		},
		onRecent: async (signal) => {
			const answer = await ask({ op: "recent" }, signal);
			if (answer.op !== "recent") throw new Error("unexpected answer");
			return { entries: answer.entries, hasMore: answer.hasMore };
		},
		onSearch: async (query, cursor, signal) => {
			const answer = await ask({ op: "search", query, ...(cursor === undefined ? {} : { cursor }) }, signal);
			if (answer.op !== "search") throw new Error("unexpected answer");
			return answer.page;
		},
		onPreview: async (entry, signal) => {
			const answer = await ask({ op: "preview", ...key(entry) }, signal);
			if (answer.op !== "preview") throw new Error("unexpected answer");
			return answer.entry;
		},
		onRestore: async (entry, signal) => {
			const answer = await ask({ op: "restore", ...key(entry) }, signal);
			if (answer.op !== "restore") throw new Error("unexpected answer");
			return answer.ok ? { ok: true, ...(answer.warning === undefined ? {} : { warning: answer.warning }) } : { ok: false, error: answer.error };
		},
	});
	// The list is loaded through the same route as Refresh, so an unreadable store shows as a read failure, not an empty history.
	const first = new AbortController();
	void ask({ op: "recent" }, first.signal).then(
		(answer) => { if (!disposed && answer.op === "recent") panel.replaceEntries(answer.entries, answer.hasMore); },
		(error) => { if (!disposed) host.dialogs.notify(`Could not read clipboard history: ${error instanceof Error ? error.message : String(error)}`, "error"); },
	);
	return {
		render: (width) => panel.render(width),
		handleInput: (data) => panel.handleInput(data),
		handleMouse: (event) => panel.handleMouse(event),
		invalidate: () => panel.invalidate(),
		dispose: () => { disposed = true; first.abort(); panel.dispose(); },
	};
}

export function operatorPanel(): { readonly version: 1; readonly title: string; open(host: OperatorPanelHost): OperatorPanelInstance } {
	return { version: 1, title: "Clipboard", open };
}
