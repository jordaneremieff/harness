/** Archive and clipboard operations behind the browser; the ordinary command and the native panel route share them. */

import { pbCopy } from "./pb.ts";
import { searchEntries, type SearchPage } from "./search.ts";
import { type ClipboardEntry, readEntries } from "./store.ts";
import { shortField } from "./text.ts";

export type RestoreOutcome = { ok: true } | { ok: false; error: string };

/** Browser previews carry this content prefix; restore always reads the full archived record. */
export const PREVIEW_CONTENT_CHARS = 32 * 1024;
export const PANEL_ROWS = 200;
export const SEARCH_PAGE_LIMIT = 25;

/** Recent list: metadata and preview only, with no content prefix read for any row. */
export async function loadRecentEntries(dir: string, signal?: AbortSignal): Promise<{ entries: ClipboardEntry[]; hasMore: boolean }> {
	const loaded = await readEntries(dir, { limit: PANEL_ROWS + 1, contentChars: 0, signal });
	return { entries: loaded.slice(0, PANEL_ROWS), hasMore: loaded.length > PANEL_ROWS };
}

/** Read one record by stable id and its archive date; the date keeps the lookup on the selected record. */
export async function readExactEntry(
	dir: string,
	entry: Pick<ClipboardEntry, "id" | "archiveDate">,
	contentChars: number,
	signal?: AbortSignal,
): Promise<ClipboardEntry> {
	const archived = (await readEntries(dir, { id: entry.id, date: entry.archiveDate, contentChars, signal }))[0];
	if (!archived) throw new Error(`archive entry ${entry.id} is no longer available`);
	return archived;
}

/** Restore rereads the exact record in full and writes the clipboard; it adds no archive record. */
export async function restoreFromArchive(dir: string, entry: Pick<ClipboardEntry, "id" | "archiveDate">, signal?: AbortSignal): Promise<RestoreOutcome> {
	try {
		const archived = await readExactEntry(dir, entry, Number.POSITIVE_INFINITY, signal);
		await pbCopy(archived.content, signal);
	} catch (error) {
		return { ok: false, error: error instanceof Error ? error.message : String(error) };
	}
	return { ok: true };
}

export function searchArchive(dir: string, query: string, cursor: string | undefined, signal?: AbortSignal): Promise<SearchPage> {
	return searchEntries(dir, { query, cursor, limit: SEARCH_PAGE_LIMIT, signal });
}

/** One line for the operator after a successful restore. */
export function restoredNotice(restored: Pick<ClipboardEntry, "lines" | "chars" | "label">): { text: string } {
	const label = restored.label ? ` | ${shortField(restored.label)}` : "";
	return { text: `Restored (${restored.lines}L/${restored.chars}c)${label}` };
}
