/**
 * Request and answer shapes of the clipboard browser's native route. The attached terminal
 * transports them as opaque JSON through the `clipboard` contribution command
 * (docs/conventions/operator-panels.md); both ends validate with these readers.
 */

import type { SearchPage } from "./search.ts";
import type { ClipboardEntry } from "./store.ts";

export type ClipboardPanelRequest =
	| { op: "recent" }
	| { op: "search"; query: string; cursor?: string }
	| { op: "preview"; id: string; archiveDate?: string }
	| { op: "restore"; id: string; archiveDate?: string };

export type ClipboardPanelAnswer =
	| { op: "recent"; entries: ClipboardEntry[]; hasMore: boolean }
	| { op: "search"; page: SearchPage }
	| { op: "preview"; entry: ClipboardEntry }
	| { op: "restore"; ok: true }
	| { op: "restore"; ok: false; error: string };

const MAX_QUERY_CHARS = 256;
const MAX_ID_CHARS = 200;

const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown, max: number): value is string => typeof value === "string" && value.length > 0 && value.length <= max;
const optionalText = (value: unknown, max: number): value is string | undefined => value === undefined || text(value, max);

/** Reject anything outside the finite request union before an operation runs. */
export function readPanelRequest(value: unknown): ClipboardPanelRequest {
	if (!record(value) || typeof value.op !== "string") throw new Error("clipboard browser request must name an op");
	switch (value.op) {
		case "recent":
			return { op: "recent" };
		case "search":
			if (!text(value.query, MAX_QUERY_CHARS) || !optionalText(value.cursor, 4096)) throw new Error("clipboard search needs a bounded query and an optional cursor");
			return { op: "search", query: value.query, ...(value.cursor === undefined ? {} : { cursor: value.cursor }) };
		case "preview":
		case "restore":
			if (!text(value.id, MAX_ID_CHARS) || !optionalText(value.archiveDate, 10)) throw new Error(`clipboard ${value.op} needs an entry id and an optional archive date`);
			return { op: value.op, id: value.id, ...(value.archiveDate === undefined ? {} : { archiveDate: value.archiveDate }) };
		default:
			throw new Error(`clipboard browser request op ${value.op} is not supported`);
	}
}

function entry(value: unknown): value is ClipboardEntry {
	return record(value) && typeof value.id === "string" && typeof value.timestamp === "string" && typeof value.preview === "string" && typeof value.content === "string"
		&& typeof value.lines === "number" && typeof value.chars === "number"
		&& (value.label === undefined || typeof value.label === "string") && (value.archiveDate === undefined || typeof value.archiveDate === "string")
		&& (value.contentTruncated === undefined || typeof value.contentTruncated === "boolean");
}

function page(value: unknown): value is SearchPage {
	return record(value) && Array.isArray(value.matches) && (value.nextCursor === null || typeof value.nextCursor === "string") && typeof value.hasMore === "boolean"
		&& typeof value.stop === "string" && record(value.scan);
}

function restoreAnswer(value: Record<string, unknown>): ClipboardPanelAnswer {
	if (value.ok === true) return { op: "restore", ok: true };
	if (value.ok === false && typeof value.error === "string") return { op: "restore", ok: false, error: value.error };
	throw new Error("the host answered an unreadable restore outcome");
}

const readers: { [K in ClipboardPanelRequest["op"]]: (value: Record<string, unknown>) => ClipboardPanelAnswer } = {
	recent(value) {
		if (!Array.isArray(value.entries) || !value.entries.every(entry) || typeof value.hasMore !== "boolean") throw new Error("the host answered an unreadable recent list");
		return { op: "recent", entries: value.entries, hasMore: value.hasMore };
	},
	search(value) {
		if (!page(value.page)) throw new Error("the host answered an unreadable search page");
		return { op: "search", page: value.page };
	},
	preview(value) {
		if (!entry(value.entry)) throw new Error("the host answered an unreadable entry");
		return { op: "preview", entry: value.entry };
	},
	restore: restoreAnswer,
};

/** Keep the browser honest about what the host answered: a malformed answer is an error, never an empty store. */
export function readPanelAnswer(request: ClipboardPanelRequest, value: unknown): ClipboardPanelAnswer {
	if (!record(value) || value.op !== request.op) throw new Error("the host answered a different clipboard request");
	return readers[request.op](value);
}
