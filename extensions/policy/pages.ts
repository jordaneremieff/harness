/** Byte-bounded pages of inspection listings, continued by stateless cursors bound to the listing they page. */
import { contentRevision } from "./rule.ts";

/** Cursor syntax that tool schemas accept: unpadded base64url. */
export const PAGE_CURSOR_PATTERN = "^[A-Za-z0-9_-]{1,512}$";
const CURSOR = new RegExp(PAGE_CURSOR_PATTERN);
const FINGERPRINT = /^[a-f0-9]{12}$/;

export interface PageRequest {
	/** The view and selection that a cursor continues; a cursor for another selection refuses. */
	view: string;
	id?: string;
	cursor?: string;
	/** Identity of the complete listing; a cursor issued for a different listing refuses. */
	fingerprint: string;
	/** Bytes that the entries of one page may use. A page always holds at least one entry. */
	budget: number;
}

export interface Page<T> {
	entries: T[];
	/** Zero-based index of the first entry of this page. */
	start: number;
	total: number;
	/** Repeat the same view and id with this cursor for the next entries; null when this page ends the listing. */
	nextCursor: string | null;
}

/** The page facts that every paged view reports, in text and in tool details. */
export type PageSummary = {
	start: number;
	returned: number;
	total: number;
	nextCursor: string | null;
};

/** Identity of a listing for cursor binding: any change to the value changes the identity. */
export function listingFingerprint(value: unknown): string {
	return contentRevision(value);
}

export function pageSummary(page: Page<unknown>): PageSummary {
	return { start: page.start, returned: page.entries.length, total: page.total, nextCursor: page.nextCursor };
}

/** One-line page statement for text views, with 1-based inclusive positions. */
export function pageLine(page: PageSummary, noun: string): string {
	const range = page.returned === 0 ? "none" : `${page.start + 1}-${page.start + page.returned}`;
	return `page: ${noun} ${range} of ${page.total} | next cursor: ${page.nextCursor ?? "(none)"}`;
}

function encodeCursor(view: string, id: string | null, offset: number, fingerprint: string): string {
	return Buffer.from(JSON.stringify([view, id, offset, fingerprint]), "utf8").toString("base64url");
}

function malformed(): Error {
	return new Error("The policy_rules cursor is malformed. Start again without a cursor.");
}

function decodeCursor(cursor: string): { view: string; id: string | null; offset: number; fingerprint: string } {
	if (!CURSOR.test(cursor)) throw malformed();
	let value: unknown;
	try {
		value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
	} catch {
		throw malformed();
	}
	if (!Array.isArray(value) || value.length !== 4) throw malformed();
	const [view, id, offset, fingerprint] = value as unknown[];
	if (
		typeof view !== "string" ||
		(id !== null && typeof id !== "string") ||
		typeof offset !== "number" ||
		!Number.isSafeInteger(offset) ||
		offset < 1 ||
		typeof fingerprint !== "string" ||
		!FINGERPRINT.test(fingerprint)
	)
		throw malformed();
	return { view, id, offset, fingerprint };
}

/**
 * Select the entries of one page. Pages stay within the byte budget except when one entry alone exceeds it,
 * so every page makes progress. A resumed page refuses a cursor from another view or id, or from a listing
 * that changed since the cursor was issued.
 */
export function pageEntries<T>(entries: readonly T[], size: (entry: T) => number, request: PageRequest): Page<T> {
	const id = request.id ?? null;
	let start = 0;
	if (request.cursor !== undefined) {
		const cursor = decodeCursor(request.cursor);
		if (cursor.view !== request.view || cursor.id !== id)
			throw new Error(
				"This cursor continues a different policy_rules view or id. Repeat the view and id that issued it, or start again without a cursor.",
			);
		if (cursor.fingerprint !== request.fingerprint)
			throw new Error("The listing changed after this cursor was issued. Start again without a cursor.");
		if (cursor.offset >= entries.length) throw malformed();
		start = cursor.offset;
	}
	const selected: T[] = [];
	let used = 0;
	for (let index = start; index < entries.length; index++) {
		const bytes = size(entries[index]);
		if (selected.length > 0 && used + bytes > request.budget) break;
		selected.push(entries[index]);
		used += bytes;
	}
	const end = start + selected.length;
	return {
		entries: selected,
		start,
		total: entries.length,
		nextCursor: end < entries.length ? encodeCursor(request.view, id, end, request.fingerprint) : null,
	};
}
