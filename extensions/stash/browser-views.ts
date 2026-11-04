/** The views the browser shows and the reads that build them; the ordinary host and the native route share them. */

import { join } from "node:path";
import { parseFrontmatter } from "./format.ts";
import { type SearchMatch, type SearchPage, searchStashes } from "./search.ts";
import { listStashes, normalizeMeta, readStash, type StashEntry } from "./store.ts";
import { sanitizeTerminalText } from "./text.ts";

export interface BrowserView {
	scope: "recent" | "archive";
	query: string;
	/** Cursor that produced the current archive page; undefined for the first page. */
	cursor: string | undefined;
	nextCursor: string | null;
	entries: StashEntry[];
	hasMore: boolean;
	coverage: string | undefined;
	stale: boolean;
}

const PREVIEW_DISPLAY_BYTES = 64 * 1024;
const RECENT_ROWS = 200;
const safeLine = (value: string) => sanitizeTerminalText(value).text.replace(/\n/g, "\u21b5");

/** Read the selected artifact on demand; the panel cancels it when the selection moves. */
export async function loadSelectedPreview(dir: string, entry: StashEntry, signal?: AbortSignal): Promise<StashEntry> {
	const result = await readStash(dir, entry.meta.id, signal);
	if (!result.ok) throw new Error(result.error);
	const parsed = parseFrontmatter(result.content);
	const bytes = Buffer.byteLength(parsed.body, "utf8");
	const body = bytes > PREVIEW_DISPLAY_BYTES ? Buffer.from(parsed.body, "utf8").subarray(0, PREVIEW_DISPLAY_BYTES).toString("utf8") : parsed.body;
	return {
		meta: normalizeMeta(`${entry.meta.id}.md`, parsed.meta),
		path: result.path,
		preview: body,
		previewTruncated: bytes > PREVIEW_DISPLAY_BYTES,
		previewError: undefined,
	};
}

/** Archive matches carry identity and state only; the body is read when the row is selected. */
function matchEntry(dir: string, match: SearchMatch): StashEntry {
	return {
		meta: normalizeMeta(`${match.id}.md`, {
			title: match.title,
			state: match.state,
			created: match.id.match(/^\d{8}T\d{6}Z/)?.[0],
		} as Parameters<typeof normalizeMeta>[1]),
		path: join(dir, `${match.id}.md`),
		preview: undefined,
		previewTruncated: undefined,
		previewError: undefined,
	};
}

function coverageText(page: SearchPage): string {
	const c = page.coverage;
	const more = page.nextCursor ? " \u00b7 more pages: Continue" : "";
	const skipped = c.skippedTotal > 0 ? ` \u00b7 ${c.skippedTotal} skipped` : "";
	const scope = page.matches.length === 0 ? "no matches on this page \u00b7 " : `${page.matches.length} matches \u00b7 `;
	return `${scope}${c.visited} visited${skipped} \u00b7 coverage ${c.complete ? "complete" : "partial"}${more}`;
}

export async function loadRecent(dir: string, signal?: AbortSignal): Promise<BrowserView> {
	const loaded = await listStashes(dir, { limit: RECENT_ROWS + 1 }, signal);
	return { scope: "recent", query: "", cursor: undefined, nextCursor: null, entries: loaded.slice(0, RECENT_ROWS), hasMore: loaded.length > RECENT_ROWS, coverage: undefined, stale: false };
}

/** Run one archive page. A rejected cursor or store change keeps the prior view and marks it stale. */
export async function loadArchive(dir: string, query: string, cursor: string | undefined, prior: BrowserView | undefined, signal?: AbortSignal): Promise<BrowserView> {
	try {
		const page = await searchStashes(dir, { query, cursor }, signal);
		return { scope: "archive", query, cursor, nextCursor: page.nextCursor, entries: page.matches.map((match) => matchEntry(dir, match)), hasMore: page.nextCursor !== null, coverage: coverageText(page), stale: false };
	} catch (error) {
		if (prior?.scope !== "archive") throw error;
		return { ...prior, stale: true, coverage: safeLine(error instanceof Error ? error.message : String(error)) };
	}
}
