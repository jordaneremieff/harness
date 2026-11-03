/** Native structured results for bounded stash discovery. */
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

/** Plain `{ type: "string", enum: [...] }` so providers without anyOf/const support accept the declaration. */
const StringEnum = <T extends readonly string[]>(values: T) => Type.Unsafe<T[number]>({ type: "string", enum: values });
import { STASH_STATES, stateLabel } from "./format.ts";
import { CHECKPOINT_NOTICE, checkpointMetadata, collectionId, type StashCollection } from "./collection.ts";
import { SEARCH_LIMITS } from "./search.ts";
import type { StashEntry } from "./store.ts";
import { boundedOutput, MAX_OUTPUT_BYTES, sanitizeTerminalText } from "./text.ts";

const count = () => Type.Integer({ minimum: 0 });
const state = StringEnum([...STASH_STATES, "unknown", "provisional"]);
const provenance = {
	source: Type.Optional(Type.Union([Type.String(), Type.Null()])),
	workspace: Type.Optional(Type.Union([Type.String(), Type.Null()])),
};
const collection = StringEnum(["handovers", "checkpoints"] as const);
const record = Type.Object({ id: Type.String(), title: Type.String(), state, ...provenance }, { additionalProperties: false });
const searchMatch = Type.Object(
	{
		id: Type.String(),
		title: Type.String(),
		state,
		...provenance,
		field: Type.String(),
		start: count(),
		end: count(),
		excerptStart: count(),
		excerptEnd: count(),
		excerpt: Type.String(),
	},
	{ additionalProperties: false },
);

export const ListOutputSchema = Type.Union([
	Type.Object(
		{
			kind: Type.Literal("recent"),
			collection,
			provisional: Type.Boolean(),
			records: Type.Array(record, { maxItems: 50 }),
			limit: Type.Integer({ minimum: 1, maximum: 50 }),
			selectedCount: Type.Integer({ minimum: 0, maximum: 50 }),
			omittedRecords: Type.Integer({ minimum: 0, maximum: 50 }),
			textTruncated: Type.Boolean(),
			limitReached: Type.Boolean({
				description: "Selection reached the requested limit; not proof that more records exist.",
			}),
			nextCursor: Type.Null({ description: "Recent listing has no continuation cursor." }),
			coverage: Type.Object(
				{
					complete: Type.Null({ description: "Recent listing does not measure store-wide coverage, even when empty." }),
				},
				{ additionalProperties: false },
			),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			collection,
			provisional: Type.Boolean(),
			matches: Type.Array(searchMatch, { maxItems: SEARCH_LIMITS.matches }),
			skipped: Type.Array(Type.Object({ id: Type.String(), reason: Type.String() }, { additionalProperties: false }), {
				maxItems: SEARCH_LIMITS.candidates,
			}),
			coverage: Type.Object(
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
					complete: Type.Boolean(),
				},
				{ additionalProperties: false },
			),
			nextCursor: Type.Union([Type.String({ maxLength: 1024 }), Type.Null()]),
			consistency: Type.String(),
			representation: Type.String(),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			kind: Type.Literal("error"),
			error: Type.String({ maxLength: 2048 }),
			coverage: Type.Object({ complete: Type.Literal(false) }, { additionalProperties: false }),
			nextCursor: Type.Null(),
		},
		{ additionalProperties: false },
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
