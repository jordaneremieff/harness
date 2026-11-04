/**
 * Request and answer shapes of the stash browser's native route. The attached terminal transports
 * them as opaque JSON through the `stash` contribution command (docs/conventions/operator-panels.md).
 * Reads answer views and entries; effects answer their receipt text.
 */

import type { BrowserView } from "./browser-views.ts";
import type { StashEntry } from "./store.ts";

export type StashPanelRequest =
	| { op: "recent" }
	| { op: "archive"; query: string; cursor?: string }
	| { op: "preview"; id: string }
	| { op: "pickup"; id: string; note?: string }
	| { op: "close"; id: string; outcome: string }
	| { op: "release"; id: string }
	| { op: "reopen"; id: string }
	| { op: "rotate"; id: string };

export type StashPanelAnswer =
	| { op: "recent" | "archive"; view: BrowserView }
	| { op: "preview"; entry: StashEntry }
	| { op: "pickup" | "close" | "release" | "reopen" | "rotate"; id: string; text: string };

const MAX_TEXT = 4096;
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,219}$/u;
const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown, max = MAX_TEXT): value is string => typeof value === "string" && value.length > 0 && value.length <= max;
const identity = (value: unknown): value is string => typeof value === "string" && ID.test(value);

const readers: Record<string, (value: Record<string, unknown>) => StashPanelRequest> = {
	recent: () => ({ op: "recent" }),
	archive(value) {
		if (!text(value.query, 256) || (value.cursor !== undefined && !text(value.cursor))) throw new Error("stash archive search needs a bounded query and an optional cursor");
		return { op: "archive", query: value.query, ...(value.cursor === undefined ? {} : { cursor: value.cursor }) };
	},
	preview: (value) => byId("preview", value),
	release: (value) => byId("release", value),
	reopen: (value) => byId("reopen", value),
	rotate: (value) => byId("rotate", value),
	pickup(value) {
		if (!identity(value.id) || (value.note !== undefined && !text(value.note))) throw new Error("stash pickup needs a stash id and an optional bounded note");
		return { op: "pickup", id: value.id, ...(value.note === undefined ? {} : { note: value.note }) };
	},
	close(value) {
		if (!identity(value.id) || !text(value.outcome)) throw new Error("stash close needs a stash id and a concrete outcome");
		return { op: "close", id: value.id, outcome: value.outcome };
	},
};

function byId(op: "preview" | "release" | "reopen" | "rotate", value: Record<string, unknown>): StashPanelRequest {
	if (!identity(value.id)) throw new Error(`stash ${op} needs a stash id`);
	return { op, id: value.id };
}

/** Reject anything outside the finite request union before an operation runs. */
export function readPanelRequest(value: unknown): StashPanelRequest {
	if (!record(value) || typeof value.op !== "string") throw new Error("stash browser request must name an op");
	const reader = Object.hasOwn(readers, value.op) ? readers[value.op] : undefined;
	if (!reader) throw new Error(`stash browser request op ${value.op} is not supported`);
	return reader(value);
}

function entry(value: unknown): value is StashEntry {
	return record(value) && record(value.meta) && typeof value.meta.id === "string" && typeof value.meta.title === "string" && typeof value.meta.state === "string"
		&& Array.isArray(value.meta.tags) && typeof value.path === "string" && (value.preview === undefined || typeof value.preview === "string");
}

function view(value: unknown): value is BrowserView {
	return record(value) && (value.scope === "recent" || value.scope === "archive") && typeof value.query === "string" && (value.nextCursor === null || typeof value.nextCursor === "string")
		&& Array.isArray(value.entries) && value.entries.every(entry) && typeof value.hasMore === "boolean" && typeof value.stale === "boolean";
}

/** A malformed answer is an error the browser shows, never an empty store. */
export function readPanelAnswer(request: StashPanelRequest, value: unknown): StashPanelAnswer {
	if (!record(value) || value.op !== request.op) throw new Error("the host answered a different stash request");
	if (request.op === "recent" || request.op === "archive") {
		if (!view(value.view)) throw new Error("the host answered an unreadable stash view");
		return { op: request.op, view: value.view };
	}
	if (request.op === "preview") {
		if (!entry(value.entry)) throw new Error("the host answered an unreadable stash entry");
		return { op: "preview", entry: value.entry };
	}
	if (typeof value.id !== "string" || typeof value.text !== "string") throw new Error("the host answered an unreadable stash receipt");
	return { op: request.op, id: value.id, text: value.text };
}
