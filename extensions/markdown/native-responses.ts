import type * as Durable from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord/context";
import { RESPONSE_RESULTS, RESPONSE_VISITS, type RecentResponses, type ResponseSnapshot, responseRow, responseSnapshot, responseText } from "./responses.ts";

export interface NativeSource {
	conversation: Pick<Durable.Conversation, "id" | "entries">;
	durable: Pick<typeof Durable, "AssistantEntry">;
	storageId: string;
	cwd: string;
}
function snapshot(source: NativeSource, entry: Durable.EntryRecord): ResponseSnapshot | undefined {
	if (!source.durable.AssistantEntry.is(entry)) return undefined;
	const message = entry.model?.[0];
	if (message?.role !== "assistant") return undefined;
	return responseSnapshot(message, String(entry.id), { kind: "native-response", session: source.storageId, conversation: String(source.conversation.id), cwd: source.cwd });
}
function addRows(source: NativeSource, entries: readonly Durable.EntryRecord[], rows: RecentResponses["rows"], limit: number): void {
	for (const entry of entries) {
		const response = snapshot(source, entry);
		if (response) rows.push(responseRow(response));
		if (rows.length >= limit) break;
	}
}
/** The first page establishes a cutoff; every continuation keeps that inclusive bound. */
export async function recentNative(source: NativeSource, context: Context, options: { pageSize?: number; visits?: number; results?: number } = {}): Promise<RecentResponses> {
	const visits = Math.min(RESPONSE_VISITS, Math.max(1, options.visits ?? RESPONSE_VISITS));
	const results = Math.min(RESPONSE_RESULTS, Math.max(1, options.results ?? RESPONSE_RESULTS));
	const size = Math.min(100, Math.max(1, options.pageSize ?? 50));
	let cursor: Durable.Cursor | undefined;
	let cutoff: Durable.EntryId | undefined;
	let visited = 0;
	const rows: RecentResponses["rows"] = [];
	do {
		context.abortSignal?.throwIfAborted();
		const page = await source.conversation.entries({ order: "descending", ...(cutoff === undefined ? {} : { maxEntryId: cutoff }) }, Math.min(size, visits - visited), cursor, context);
		context.abortSignal?.throwIfAborted();
		cutoff ??= page.items[0]?.id;
		visited += page.items.length;
		addRows(source, page.items, rows, results);
		if (rows.length >= results) return { rows, cutoff: String(cutoff), visited, stop: "results" };
		cursor = page.next;
		if (!page.items.length && cursor) throw new Error("Native history returned an empty continuation page.");
	} while (cursor && visited < visits);
	return { rows, cutoff: cutoff === undefined ? null : String(cutoff), visited, stop: cursor ? "visits" : "end" };
}
export async function readNative(source: NativeSource, entryId: string, context: Context): Promise<ResponseSnapshot> {
	if (!/^[1-9]\d*$/u.test(entryId) || !Number.isSafeInteger(Number(entryId))) throw new Error("Invalid native entry identity.");
	const id = Number(entryId) as Durable.EntryId;
	const page = await source.conversation.entries({ minEntryId: id, maxEntryId: id, order: "descending" }, 1, undefined, context);
	context.abortSignal?.throwIfAborted();
	const entry = page.items[0];
	const response = entry?.id === id ? snapshot(source, entry) : undefined;
	if (!response) throw new Error("The response is not visible in the selected conversation.");
	responseText(response);
	return response;
}
