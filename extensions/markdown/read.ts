import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type * as Durable from "@earendil-works/pi-durable";
import { arr, bool, int, lit, obj, opt, str, union, type Static } from "@earendil-works/pi-schema";
import { toolDisplay } from "./display.ts";
import { coverageText, referenceSummary, ReferenceSummarySchema, type ReferenceSummary } from "./publish.ts";
import { type AssetRecord, type Completeness, type ContentOrigin, type DocumentKind, type DocumentRecord, type MarkdownStore, StoreError } from "./store.ts";

/** UTF-8 bytes of source text in one page. */
export const READ_PAGE_BYTES = 64 * 1024;
const FIND_ROWS = 20;
const LISTED_IMAGES = 32;
const IMAGE_REFERENCE_CHARS = 160;

export const ReadParameters = obj({
	document: opt(str({ minLength: 1, maxLength: 23, description: "Document ID, or a unique prefix of at least six characters such as md-1a2b3c. Omit it to find documents." })),
	revision: opt(int({ minimum: 1, description: "Exact revision to read. Defaults to the current revision." })),
	offset: opt(int({ minimum: 0, description: "Continue a page from its nextOffset, with the same revision." })),
	query: opt(str({ minLength: 1, maxLength: 200, description: "Without document: literal, case-insensitive text in document titles and IDs." })),
	kind: opt(union([lit("published"), lit("response"), lit("file")], { description: "Without document: the collection to search. Defaults to published." })),
}, { open: false });
export type ReadInput = Static<typeof ReadParameters>;

export type FoundDocument = { id: string; title: string; kind: DocumentKind; revision: number; bytes: number; digest: string; createdAt: string; updatedAt: string };
export type ListedImage = { reference: string; state: AssetRecord["state"]; reason?: string; mediaType?: string; bytes?: number; digest?: string };
export type ReadOutcome =
	| { ok: true; op: "find"; kind: DocumentKind; query?: string; rows: FoundDocument[]; matched: number; scanned: number; unreadable: number; bounded: boolean }
	| { ok: true; op: "read"; documentId: string; kind: DocumentKind; title: string; currentRevision: number; revision: number; revisionTitle: string; createdAt: string; digest: string; bytes: number; completeness: Completeness; selfContained?: boolean; references: ReferenceSummary; images?: ListedImage[]; imagesOmitted?: number; provenance: ContentOrigin; offset: number; nextOffset: number | null; chars: number; text: string }
	| { ok: false; error: { code: "invalid" | "not-found" | "store-failure"; message: string } };

const KindSchema = union([lit("published"), lit("response"), lit("file")]);
export const ReadOutcomeSchema = union([
	obj({ ok: lit(true), op: lit("find"), kind: KindSchema, query: opt(str()), rows: arr(obj({ id: str(), title: str(), kind: KindSchema, revision: int(), bytes: int(), digest: str(), createdAt: str(), updatedAt: str() })), matched: int(), scanned: int(), unreadable: int(), bounded: bool() }),
	obj({ ok: lit(true), op: lit("read"), documentId: str(), kind: KindSchema, title: str(), currentRevision: int(), revision: int(), revisionTitle: str(), createdAt: str(), digest: str(), bytes: int(), completeness: obj({ state: str() }, { open: true }), selfContained: opt(bool()), references: ReferenceSummarySchema, images: opt(arr(obj({ reference: str(), state: str() }, { open: true }))), imagesOmitted: opt(int()), provenance: obj({ kind: str(), capturedAt: str() }, { open: true }), offset: int(), nextOffset: union([int(), lit(null)]), chars: int(), text: str() }),
	obj({ ok: lit(false), error: obj({ code: union([lit("invalid"), lit("not-found"), lit("store-failure")]), message: str() }) }),
]);

const DESCRIPTION = "Find and read stored Markdown documents exactly, without opening a window. Without document, list the newest documents of one collection, optionally matching query against titles and IDs. With document, read the exact source of its current revision, or of a named revision, in pages of at most 64 KiB; continue with the returned offset and the same revision. The result names the current revision, the source digest and the reference coverage. To correct a published document, read its current revision, then call markdown_publish with document and expectedRevision set to that revision. After a conflict, read the revision that the conflict names before you publish again. Reading starts no work and changes nothing.";

function validate(params: ReadInput): void {
	if (!params || typeof params !== "object") throw new StoreError("invalid", "Supply a document, or omit it to find documents.");
	if (params.document === undefined && (params.revision !== undefined || params.offset !== undefined)) throw new StoreError("invalid", "A revision or offset needs a document.");
	if (params.offset !== undefined && params.offset > 0 && params.revision === undefined) throw new StoreError("invalid", "A continued page needs the revision of its first page.");
	if (params.document !== undefined && (params.query !== undefined || params.kind !== undefined)) throw new StoreError("invalid", "A query or kind finds documents; omit document to use it.");
	if (params.query !== undefined && (typeof params.query !== "string" || !params.query.trim() || /[\p{Cc}\ud800-\udfff]/u.test(params.query))) throw new StoreError("invalid", "A query must be nonempty text on one line.");
}
function row(record: DocumentRecord): FoundDocument {
	return { id: record.id, title: record.title, kind: record.kind, revision: record.revision, bytes: record.bytes, digest: record.digest, createdAt: record.createdAt, updatedAt: record.updatedAt };
}
async function find(store: MarkdownStore, params: ReadInput): Promise<ReadOutcome> {
	const kind = params.kind ?? "published";
	const needle = params.query?.trim().toLowerCase();
	const listing = await store.list({ kind, limit: FIND_ROWS, match: needle ? (record) => record.title.toLowerCase().includes(needle) || record.id.includes(needle) : undefined });
	return { ok: true, op: "find", kind, ...(params.query === undefined ? {} : { query: params.query }), rows: listing.documents.map(row), matched: listing.matched, scanned: listing.scanned, unreadable: listing.unreadable, bounded: listing.bounded };
}
/** A page never ends inside a surrogate pair; offsets count UTF-16 code units. */
export function sourcePage(source: string, offset: number, maxBytes = READ_PAGE_BYTES): { text: string; nextOffset: number | null } {
	if (!Number.isSafeInteger(offset) || offset < 0 || offset > source.length || (offset > 0 && offset < source.length && /[\uDC00-\uDFFF]/u.test(source[offset] ?? ""))) throw new StoreError("invalid", "The offset is not a character boundary of this revision.");
	let end = offset; let bytes = 0;
	while (end < source.length) {
		const point = String.fromCodePoint(source.codePointAt(end) ?? 0);
		const size = Buffer.byteLength(point);
		if (bytes + size > maxBytes) break;
		bytes += size; end += point.length;
	}
	return { text: source.slice(offset, end), nextOffset: end < source.length ? end : null };
}
function listedImages(items: AssetRecord[]): { images: ListedImage[]; imagesOmitted: number } | undefined {
	const images = items.filter((item) => item.kind === "image");
	if (!images.length) return undefined;
	return {
		images: images.slice(0, LISTED_IMAGES).map((item) => ({ reference: [...item.reference].slice(0, IMAGE_REFERENCE_CHARS).join(""), state: item.state, ...(item.reason ? { reason: item.reason } : {}), ...(item.mediaType ? { mediaType: item.mediaType } : {}), ...(item.bytes === undefined ? {} : { bytes: item.bytes }), ...(item.digest ? { digest: item.digest } : {}) })),
		imagesOmitted: Math.max(0, images.length - LISTED_IMAGES),
	};
}
async function readDocument(store: MarkdownStore, params: ReadInput & { document: string }): Promise<ReadOutcome> {
	const stored = await store.get(params.document, params.revision);
	const offset = params.offset ?? 0;
	const page = sourcePage(stored.source, offset);
	const { document, revision } = stored;
	return {
		ok: true, op: "read", documentId: document.id, kind: document.kind, title: document.title, currentRevision: document.revision,
		revision: revision.revision, revisionTitle: revision.title, createdAt: revision.createdAt, digest: revision.digest, bytes: revision.bytes,
		completeness: revision.completeness, ...(revision.selfContained === undefined ? {} : { selfContained: revision.selfContained }),
		references: referenceSummary(revision.references), ...(offset === 0 ? listedImages(revision.references.items) : {}),
		provenance: revision.contentOrigin, offset, nextOffset: page.nextOffset, chars: stored.source.length, text: page.text,
	};
}
/** Reads only: no window, reveal, publication or model work. */
export async function readStored(store: MarkdownStore, params: ReadInput): Promise<ReadOutcome> {
	try {
		validate(params);
		if (params.document === undefined) return await find(store, params);
		return await readDocument(store, { ...params, document: params.document });
	} catch (error) {
		if (error instanceof StoreError && (error.code === "invalid" || error.code === "not-found")) return { ok: false, error: { code: error.code, message: error.message.slice(0, 300) } };
		return { ok: false, error: { code: "store-failure", message: error instanceof StoreError ? error.message.slice(0, 300) : "The document store is unavailable." } };
	}
}

const line = (value: string) => [...value.replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, " ")].slice(0, 200).join("");
function findText(outcome: Extract<ReadOutcome, { op: "find" }>): string {
	const scope = `${outcome.bounded ? `the first ${outcome.scanned} scanned entries` : `${outcome.scanned} scanned entries`}`;
	const head = `${outcome.matched} ${outcome.kind} document${outcome.matched === 1 ? "" : "s"}${outcome.query === undefined ? "" : ` match ${JSON.stringify(outcome.query)}`} among ${scope}${outcome.matched > outcome.rows.length ? `; the newest ${outcome.rows.length} follow` : ""}${outcome.bounded ? ". The scan stopped before the end of the collection, so newer documents can exist" : ""}.`;
	const unreadable = outcome.unreadable ? [`${outcome.unreadable} document director${outcome.unreadable === 1 ? "y is" : "ies are"} unreadable and not listed.`] : [];
	const rows = outcome.rows.map((document) => `${document.id} · revision ${document.revision} · ${document.updatedAt} · ${line(document.title)}`);
	return [head, ...unreadable, ...rows, ...(outcome.rows.length ? ['Read one with markdown_read {"document":"<id>"}.'] : [])].join("\n");
}
function readHeader(outcome: Extract<ReadOutcome, { op: "read" }>): string {
	const end = outcome.offset + outcome.text.length;
	const position = outcome.nextOffset === null && outcome.offset === 0 ? "Complete source follows." : `Characters ${outcome.offset}\u2013${end} of ${outcome.chars} follow.${outcome.nextOffset === null ? "" : ` Continue with ${JSON.stringify({ document: outcome.documentId, revision: outcome.revision, offset: outcome.nextOffset })}.`}`;
	const coverage = coverageText(outcome.references, outcome.provenance.kind);
	const newer = outcome.revision === outcome.currentRevision ? "" : ` Revision ${outcome.currentRevision} is current.`;
	const partial = outcome.completeness.state === "partial" ? ` The captured response is partial (${outcome.completeness.reason ?? "unknown reason"}).` : "";
	const update = outcome.kind === "published" ? ` To correct it, publish with document ${outcome.documentId} and expectedRevision ${outcome.currentRevision}.` : "";
	return [`${outcome.documentId} revision ${outcome.revision} of ${outcome.currentRevision} · ${outcome.kind} · ${JSON.stringify(line(outcome.revisionTitle))} · ${outcome.bytes} bytes · ${outcome.digest}.${newer}${partial}${update}`, ...(coverage ? [coverage] : []), position].join("\n");
}
export function readText(outcome: ReadOutcome): { header: string; source?: string } {
	if (!outcome.ok) return { header: `Markdown read failed (${outcome.error.code}): ${outcome.error.message}` };
	if (outcome.op === "find") return { header: findText(outcome) };
	return { header: readHeader(outcome), source: outcome.text };
}
function content(outcome: ReadOutcome): { type: "text"; text: string }[] {
	const { header, source } = readText(outcome);
	return [{ type: "text", text: header }, ...(source === undefined ? [] : [{ type: "text" as const, text: source }])];
}

export function createReadTool(options: { store: MarkdownStore }): ToolDefinition<typeof ReadParameters, ReadOutcome> {
	const presentation = toolDisplay().tools.find((tool) => tool.name === "markdown_read");
	return { ...presentation, name: "markdown_read", label: "Markdown Read", description: DESCRIPTION, promptSnippet: "Find stored Markdown documents and read an exact revision in pages, for example before an update.", parameters: ReadParameters, outputSchema: ReadOutcomeSchema, async execute(_id, params) {
		const outcome = await readStored(options.store, params as ReadInput);
		return { content: content(outcome), details: outcome, structuredContent: outcome, isError: !outcome.ok };
	} };
}
export function createNativeReadTool(durable: typeof Durable, options: { store: MarkdownStore }): Durable.ToolRegistration<typeof ReadParameters, Durable.JsonObject> {
	return durable.defineTool({ name: "markdown_read", description: DESCRIPTION, parameters: ReadParameters, structuredOutputSchema: ReadOutcomeSchema, replay: "safe", async execute(params) {
		const outcome = await readStored(options.store, params as ReadInput);
		return { output: content(outcome), structuredOutput: outcome, details: outcome, isError: !outcome.ok };
	} });
}
