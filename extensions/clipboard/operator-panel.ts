/**
 * The clipboard view for native hosts such as the attached Agent terminal. The host imports this
 * module locally and gives it a request route to the `clipboard` contribution command; the view
 * is the same one ordinary Pi mounts. Evaluating this module registers nothing and opens no store.
 */

import type { JsonValue, OperatorPanelModule, PanelHost } from "../../operator-ui/index.ts";
import { type ClipboardOperations, clipboardView } from "./operator-view.ts";
import { type ClipboardPanelRequest, readPanelAnswer } from "./panel-protocol.ts";

function operations(host: PanelHost): ClipboardOperations {
	const ask = async (request: ClipboardPanelRequest, signal: AbortSignal) => readPanelAnswer(request, (await host.request(request as JsonValue, signal)).data);
	const key = (entry: { id: string; archiveDate?: string }) => ({ id: entry.id, ...(entry.archiveDate === undefined ? {} : { archiveDate: entry.archiveDate }) });
	return {
		recent: async (signal) => {
			const answer = await ask({ op: "recent" }, signal);
			if (answer.op !== "recent") throw new Error("unexpected answer");
			return { entries: answer.entries, hasMore: answer.hasMore };
		},
		search: async (query, cursor, signal) => {
			const answer = await ask({ op: "search", query, ...(cursor === undefined ? {} : { cursor }) }, signal);
			if (answer.op !== "search") throw new Error("unexpected answer");
			return answer.page;
		},
		preview: async (entry, signal) => {
			const answer = await ask({ op: "preview", ...key(entry) }, signal);
			if (answer.op !== "preview") throw new Error("unexpected answer");
			return answer.entry;
		},
		restore: async (entry, signal) => {
			const answer = await ask({ op: "restore", ...key(entry) }, signal);
			if (answer.op !== "restore") throw new Error("unexpected answer");
			return answer.ok ? { ok: true } : { ok: false, error: answer.error };
		},
	};
}

export function operatorPanel(): OperatorPanelModule {
	return { version: 2, title: "Clipboard", open: (host) => clipboardView(host, operations(host)) };
}
