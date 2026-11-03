/** Native structured results for bounded stash discovery. */
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { arr, bool, int, lit, nul, obj, opt, str, type Schema, union } from "@earendil-works/pi-schema";

/** Plain `{ type: "string", enum: [...] }` so providers without anyOf/const support accept the declaration. */
const StringEnum = <T extends readonly string[]>(values: T): Schema<T[number]> => ({ type: "string", enum: values });
import { STASH_STATES, stateLabel } from "./format.ts";
import { CHECKPOINT_NOTICE, checkpointMetadata, collectionId, type StashCollection } from "./collection.ts";
import { SEARCH_LIMITS } from "./search.ts";
import type { StashEntry } from "./store.ts";
import { boundedOutput, MAX_OUTPUT_BYTES, sanitizeTerminalText } from "./text.ts";

const count = () => int({ minimum: 0 });
const state = StringEnum([...STASH_STATES, "unknown", "provisional"]);
const provenance = {
	source: opt(union([str(), nul()])),
	workspace: opt(union([str(), nul()])),
};
const collection = StringEnum(["handovers", "checkpoints"] as const);
const record = obj({ id: str(), title: str(), state, ...provenance }, { open: false });
const searchMatch = obj(
	{
		id: str(),
		title: str(),
		state,
		...provenance,
		field: str(),
		start: count(),
		end: count(),
		excerptStart: count(),
		excerptEnd: count(),
		excerpt: str(),
	},
	{ open: false },
);

export const ListOutputSchema = union([
	obj(
		{
			kind: lit("recent"),
			collection,
			provisional: bool(),
			records: arr(record, { maxItems: 50 }),
			limit: int({ minimum: 1, maximum: 50 }),
			selectedCount: int({ minimum: 0, maximum: 50 }),
			omittedRecords: int({ minimum: 0, maximum: 50 }),
			textTruncated: bool(),
			limitReached: bool({
				description: "Selection reached the requested limit; not proof that more records exist.",
			}),
			nextCursor: nul({ description: "Recent listing has no continuation cursor." }),
			coverage: obj(
				{
					complete: nul({ description: "Recent listing does not measure store-wide coverage, even when empty." }),
				},
				{ open: false },
			),
		},
		{ open: false },
	),
	obj(
		{
			collection,
			provisional: bool(),
			matches: arr(searchMatch, { maxItems: SEARCH_LIMITS.matches }),
			skipped: arr(obj({ id: str(), reason: str() }, { open: false }), {
				maxItems: SEARCH_LIMITS.candidates,
			}),
			coverage: obj(
				{
					directoryEntries: count(),
					candidates: count(),
					from: count(),
					next: count(),
					visited: count(),
					bytesRead: count(),
					searched: count(),
					filtered: count(),
					deferred: count(),
					skippedTotal: count(),
					complete: bool(),
				},
				{ open: false },
			),
			nextCursor: union([str({ maxLength: 1024 }), nul()]),
			consistency: str(),
			representation: str(),
		},
		{ open: false },
	),
	obj(
		{
			kind: lit("error"),
			error: str({ maxLength: 2048 }),
			coverage: obj({ complete: lit(false) }, { open: false }),
			nextCursor: nul(),
		},
		{ open: false },
	),
]);

export type RecentRecord = {
	id: string;
	title: string;
	state: "open" | "active" | "closed" | "unknown" | "provisional";
	source?: string | null;
	workspace?: string | null;
};

/** Empty-state prose for a filtered recent list; shared by both entrypoints. */
export function emptyListText(tag: string | undefined, state: string | undefined): string {
	const line = (value: string) => sanitizeTerminalText(value).text.replace(/\n/g, "↵");
	const scopes = [tag ? `tag "${line(tag)}"` : undefined, state ? `state ${state}` : undefined].filter(
		(value): value is string => Boolean(value),
	);
	const scope = scopes.length > 0 ? ` with ${scopes.join(" and ")}` : "";
	return `No stashes found${scope}.`;
}

export function recentListResult(
	entries: StashEntry[],
	limit: number,
	emptyText: string,
	collection: StashCollection = "handovers",
): AgentToolResult<Record<string, unknown>> {
	const notice = collection === "checkpoints" ? `${CHECKPOINT_NOTICE}\n` : "";
	if (entries.length === 0)
		return {
			content: [{ type: "text", text: `${notice}${emptyText}` }],
			details: collection === "checkpoints" ? { count: 0, collection, provisional: true } : { count: 0 },
			structuredContent: recentListContent([], limit, 0, false, collection),
		};
	const rows = entries.map((entry) => recentListRow(entry, collection));
	if (rows[0] && notice) rows[0].text = notice + rows[0].text;
	const bounded = boundedOutput(
		rows.map((row) => row.text).join("\n"),
		"Lower limit or filter by tag for a narrower list.",
	);
	return {
		content: [{ type: "text", text: bounded.text }],
		structuredContent: recentListContent(rows, limit, bounded.outputChars, bounded.truncated, collection),
		details: {
			count: entries.length,
			collection,
			provisional: collection === "checkpoints",
			ids: entries.map((entry) => collectionId(entry.meta.id, collection)),
			states: entries.map((entry) =>
				collection === "checkpoints" ? "provisional" : sanitizeTerminalText(stateLabel(entry.meta, entry.previewError !== undefined)).text.replace(/\n/g, "↵"),
			),
			truncated: bounded.truncated,
		},
	};
}

function recentListRow(entry: StashEntry, collection: StashCollection) {
	const line = (value: string) => sanitizeTerminalText(value).text.replace(/\n/g, "↵");
	const tags = entry.meta.tags.length > 0 ? ` [${entry.meta.tags.map(line).join(", ")}]` : "";
	const title = line(entry.meta.title);
	const id = collectionId(entry.meta.id, collection);
	const provenance = collection === "checkpoints" ? checkpointMetadata(entry.meta) : undefined;
	return {
		text: `${id}\n  ${collection === "checkpoints" ? "provisional" : line(stateLabel(entry.meta, entry.previewError !== undefined))} · ${title}${tags}${collection === "checkpoints" ? `\n  Source: ${line(provenance?.source ?? "unknown")} · Workspace: ${line(provenance?.workspace ?? "unknown")}` : ""}`,
		record: {
			id,
			...provenance,
			title,
			state: collection === "checkpoints" ? ("provisional" as const) :
				entry.previewError !== undefined || entry.meta.invalidState !== undefined
					? ("unknown" as const)
					: entry.meta.state,
		},
	};
}

/** Only complete displayed rows enter the structured page; JSON escaping has its own byte cost. */
export function recentListContent(
	rows: { text: string; record: RecentRecord }[],
	limit: number,
	visibleChars: number,
	textTruncated: boolean,
	collection: StashCollection = "handovers",
) {
	const page = {
		kind: "recent" as const,
		collection,
		provisional: collection === "checkpoints",
		records: [] as RecentRecord[],
		limit,
		selectedCount: rows.length,
		omittedRecords: rows.length,
		textTruncated,
		limitReached: rows.length === limit,
		nextCursor: null,
		coverage: { complete: null },
	};
	let end = 0;
	for (const row of rows) {
		end += (end === 0 ? 0 : 1) + row.text.length;
		if (end > visibleChars) break;
		page.records.push(row.record);
		page.omittedRecords--;
		if (Buffer.byteLength(JSON.stringify(page), "utf8") > MAX_OUTPUT_BYTES) {
			page.records.pop();
			page.omittedRecords++;
			break;
		}
	}
	return page;
}
