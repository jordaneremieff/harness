import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type * as Durable from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord/context";
import type { LiveConfig } from "./live-protocol.ts";
import { withLiveShow } from "./live-launch.ts";
import { arr, bool, int, lit, obj, opt, str, union, type Static } from "@earendil-works/pi-schema";
import { toolDisplay } from "./display.ts";
import { hasPaneRevision, paneCommand } from "./pane-command.ts";
import { coverageText, referenceSummary, ReferenceSummarySchema, type ReferenceSummary } from "./publish.ts";
import { type AssetRecord, type Completeness, type ContentOrigin, type DocumentKind, type DocumentRecord, type MarkdownStore, StoreError } from "./store.ts";

/** UTF-8 bytes of source text in one page. */
export const READ_PAGE_BYTES = 64 * 1024;
const FIND_ROWS = 20;
/** A source search reads the listed revisions, newest first, up to these document and byte bounds. */
export const SEARCH_LIMITS = { documents: 200, bytes: 32 * 1024 * 1024 } as const;
const EXCERPT_CHARS = 160;
const LISTED_IMAGES = 32;
const IMAGE_REFERENCE_CHARS = 160;

export const ReadParameters = obj({
	document: opt(str({ minLength: 1, maxLength: 23, description: "Document ID, or a unique prefix of at least six characters such as md-1a2b3c. Omit it to find documents." })),
	revision: opt(int({ minimum: 1, description: "Exact revision to read. Defaults to the current revision." })),
	offset: opt(int({ minimum: 0, description: "Continue a page from its nextOffset, with the same revision." })),
	query: opt(str({ minLength: 1, maxLength: 200, description: "Without document: literal, case-insensitive text in document titles and IDs." })),
	contains: opt(str({ minLength: 1, maxLength: 200, description: "Without document: literal, case-insensitive text in the current revision's source. Searches at most 200 documents, newest first." })),
	kind: opt(union([lit("published"), lit("response"), lit("file")], { description: "Without document: the collection to search. Defaults to published." })),
}, { open: false });
export type ReadInput = Static<typeof ReadParameters>;

export type FoundDocument = { id: string; title: string; kind: DocumentKind; revision: number; bytes: number; digest: string; createdAt: string; updatedAt: string; excerpt?: { line: number; text: string } };
/** Coverage of a source search: the documents and bytes read, and whether every candidate was read. */
export type SourceSearch = { contains: string; candidates: number; searched: number; bytes: number; complete: boolean; unreadable: number };
export type ListedImage = { reference: string; state: AssetRecord["state"]; reason?: string; mediaType?: string; bytes?: number; digest?: string };
export type ReadOutcome =
	| { ok: true; op: "find"; kind: DocumentKind; query?: string; search?: SourceSearch; rows: FoundDocument[]; matched: number; scanned: number; unreadable: number; bounded: boolean }
	| { ok: true; op: "read"; documentId: string; kind: DocumentKind; title: string; currentRevision: number; revision: number; revisionTitle: string; createdAt: string; digest: string; bytes: number; completeness: Completeness; selfContained?: boolean; references: ReferenceSummary; images?: ListedImage[]; imagesOmitted?: number; provenance: ContentOrigin; offset: number; nextOffset: number | null; chars: number; text: string; show?: string[]; paneInput?: string; showUnavailable?: string }
	| { ok: false; error: { code: "invalid" | "not-found" | "store-failure"; message: string } };

const KindSchema = union([lit("published"), lit("response"), lit("file")]);
export const ReadOutcomeSchema = union([
	obj({ ok: lit(true), op: lit("find"), kind: KindSchema, query: opt(str()), search: opt(obj({ contains: str(), candidates: int(), searched: int(), bytes: int(), complete: bool(), unreadable: int() })), rows: arr(obj({ id: str(), title: str(), kind: KindSchema, revision: int(), bytes: int(), digest: str(), createdAt: str(), updatedAt: str(), excerpt: opt(obj({ line: int(), text: str() })) })), matched: int(), scanned: int(), unreadable: int(), bounded: bool() }),
	obj({ ok: lit(true), op: lit("read"), documentId: str(), kind: KindSchema, title: str(), currentRevision: int(), revision: int(), revisionTitle: str(), createdAt: str(), digest: str(), bytes: int(), completeness: obj({ state: str() }, { open: true }), selfContained: opt(bool()), references: ReferenceSummarySchema, images: opt(arr(obj({ reference: str(), state: str() }, { open: true }))), imagesOmitted: opt(int()), provenance: obj({ kind: str(), capturedAt: str() }, { open: true }), offset: int(), nextOffset: union([int(), lit(null)]), chars: int(), text: str(), show: opt(arr(str())), paneInput: opt(str()), showUnavailable: opt(str()) }),
	obj({ ok: lit(false), error: obj({ code: union([lit("invalid"), lit("not-found"), lit("store-failure")]), message: str() }) }),
]);

const DESCRIPTION = "Find and read stored Markdown documents exactly, without opening a window. Without document, list the newest documents of one collection, optionally matching query against titles and IDs and contains against the current source (a bounded search that reports its coverage). With document, read the exact source of its current revision, or of a named revision, in pages of at most 64 KiB; continue with the returned offset and the same revision. The result names the current revision, the source digest and the reference coverage. For a connected pane, use markdown_live to read or edit its actual buffer. To correct a stored publication instead, read its current revision, then call markdown_publish with document and expectedRevision set to that revision. After a conflict, read the revision that the conflict names before you publish again. Reading starts no model work and leaves stored document content unchanged.";

function validate(params: ReadInput): void {
	if (!params || typeof params !== "object") throw new StoreError("invalid", "Supply a document, or omit it to find documents.");
	if (params.document === undefined && (params.revision !== undefined || params.offset !== undefined)) throw new StoreError("invalid", "A revision or offset needs a document.");
	if (params.offset !== undefined && params.offset > 0 && params.revision === undefined) throw new StoreError("invalid", "A continued page needs the revision of its first page.");
	if (params.document !== undefined && (params.query !== undefined || params.kind !== undefined || params.contains !== undefined)) throw new StoreError("invalid", "A query, contains or kind finds documents; omit document to use it.");
	for (const value of [params.query, params.contains]) if (value !== undefined && (typeof value !== "string" || !value.trim() || /[\p{Cc}\ud800-\udfff]/u.test(value))) throw new StoreError("invalid", "Search text must be nonempty text on one line.");
}
function row(record: DocumentRecord): FoundDocument {
	return { id: record.id, title: record.title, kind: record.kind, revision: record.revision, bytes: record.bytes, digest: record.digest, createdAt: record.createdAt, updatedAt: record.updatedAt };
}
async function find(store: MarkdownStore, params: ReadInput): Promise<ReadOutcome> {
	const kind = params.kind ?? "published";
	const needle = params.query?.toLowerCase();
	const match = needle ? (record: DocumentRecord) => record.title.toLowerCase().includes(needle) || record.id.includes(needle) : undefined;
	const listing = await store.list({ kind, limit: params.contains === undefined ? FIND_ROWS : undefined, match });
	const base = { ok: true as const, op: "find" as const, kind, ...(params.query === undefined ? {} : { query: params.query }), scanned: listing.scanned, unreadable: listing.unreadable, bounded: listing.bounded };
	if (params.contains === undefined) return { ...base, rows: listing.documents.map(row), matched: listing.matched };
	const found = await searchSources(store, listing.documents, params.contains);
	return { ...base, search: found.search, rows: found.rows.slice(0, FIND_ROWS), matched: found.rows.length };
}
/**
 * Reads the listed revisions newest first until the bounds stop it, and keeps those whose source
 * contains the text, with the first matching line. Case folding can change a string's length,
 * so the excerpt is the original line at the line number found in the folded text.
 */
async function searchSources(store: MarkdownStore, candidates: DocumentRecord[], contains: string): Promise<{ rows: FoundDocument[]; search: SourceSearch }> {
	const needle = contains.toLowerCase();
	const rows: FoundDocument[] = [];
	let searched = 0; let bytes = 0; let unreadable = 0;
	for (const candidate of candidates) {
		if (searched >= SEARCH_LIMITS.documents || bytes + candidate.bytes > SEARCH_LIMITS.bytes) break;
		searched++; bytes += candidate.bytes;
		let source: string;
		try { source = (await store.get(candidate.id, candidate.revision)).source; } catch { unreadable++; continue; }
		const folded = source.toLowerCase();
		const at = folded.indexOf(needle);
		if (at < 0) continue;
		const lineBreak = /\r\n|[\r\n]/u;
		const line = folded.slice(0, at).split(lineBreak).length;
		const text = [...(source.split(lineBreak)[line - 1] ?? "").trim()].slice(0, EXCERPT_CHARS).join("");
		rows.push({ ...row(candidate), excerpt: { line, text } });
	}
	return { rows, search: { contains, candidates: candidates.length, searched, bytes, complete: searched === candidates.length, unreadable } };
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
async function readDocument(store: MarkdownStore, params: ReadInput & { document: string }, app: string | undefined): Promise<ReadOutcome> {
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
		...(offset === 0 ? paneCommand(app, store.root, document.id, params.revision === undefined ? undefined : revision) : {}),
	};
}
/** Reads only: no window, reveal, publication or model work. `app` names the installed reader for the pane command. */
export async function readStored(store: MarkdownStore, params: ReadInput, app?: string): Promise<ReadOutcome> {
	try {
		validate(params);
		if (params.document === undefined) return await find(store, params);
		return await readDocument(store, { ...params, document: params.document }, app);
	} catch (error) {
		if (error instanceof StoreError && (error.code === "invalid" || error.code === "not-found")) return { ok: false, error: { code: error.code, message: error.message.slice(0, 300) } };
		return { ok: false, error: { code: "store-failure", message: error instanceof StoreError ? error.message.slice(0, 300) : "The document store is unavailable." } };
	}
}

const line = (value: string) => [...value.replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, " ")].slice(0, 200).join("");
type Found = Extract<ReadOutcome, { op: "find" }>;
function findText(outcome: Found): string {
	const head = `${findSubject(outcome)} ${findScope(outcome)}${findLimits(outcome)}.`;
	const unreadable = outcome.unreadable ? [`${outcome.unreadable} document director${outcome.unreadable === 1 ? "y is" : "ies are"} unreadable and not listed.`] : [];
	const failed = outcome.search?.unreadable ?? 0;
	const unsearched = failed ? [`${failed} document${failed === 1 ? " could not be read and was" : "s could not be read and were"} not searched.`] : [];
	const rows = outcome.rows.flatMap((document) => [`${document.id} · revision ${document.revision} · ${document.updatedAt} · ${line(document.title)}`, ...(document.excerpt ? [`  line ${document.excerpt.line}: ${line(document.excerpt.text)}`] : [])]);
	return [head, ...unreadable, ...unsearched, ...rows, ...(outcome.rows.length ? ['Read one with markdown_read {"document":"<id>"}.'] : [])].join("\n");
}
function findSubject(outcome: Found): string {
	const one = outcome.matched === 1;
	const contains = outcome.search ? ` ${one ? "contains" : "contain"} ${JSON.stringify(outcome.search.contains)}` : "";
	const query = outcome.query === undefined ? "" : `${outcome.search ? " and" : ""} match ${JSON.stringify(outcome.query)}`;
	return `${outcome.matched} ${outcome.kind} document${one ? "" : "s"}${contains}${query}`;
}
function findScope(outcome: Found): string {
	const scanned = outcome.bounded ? `the first ${outcome.scanned} scanned entries` : `${outcome.scanned} scanned entries`;
	return outcome.search ? `among ${outcome.search.searched} searched of ${outcome.search.candidates} candidates in ${scanned}` : `among ${scanned}`;
}
function findLimits(outcome: Found): string {
	const parts = [
		outcome.matched > outcome.rows.length ? `; the newest ${outcome.rows.length} follow` : "",
		outcome.bounded ? ". The scan stopped before the end of the collection, so newer documents can exist" : "",
		outcome.search && !outcome.search.complete ? ". The source search stopped at its bound, so older candidates were not searched" : "",
	];
	return parts.join("");
}
function readHeader(outcome: Extract<ReadOutcome, { op: "read" }>): string {
	const end = outcome.offset + outcome.text.length;
	const position = outcome.nextOffset === null && outcome.offset === 0 ? "Complete source follows." : `Characters ${outcome.offset}\u2013${end} of ${outcome.chars} follow.${outcome.nextOffset === null ? "" : ` Continue with ${JSON.stringify({ document: outcome.documentId, revision: outcome.revision, offset: outcome.nextOffset })}.`}`;
	const coverage = coverageText(outcome.references, outcome.provenance.kind);
	const newer = outcome.revision === outcome.currentRevision ? "" : ` Revision ${outcome.currentRevision} is current.`;
	const partial = outcome.completeness.state === "partial" ? ` The captured response is partial (${outcome.completeness.reason ?? "unknown reason"}).` : "";
	const update = outcome.kind !== "published" ? "" : outcome.revision === outcome.currentRevision
		? ` To correct it, publish with document ${outcome.documentId} and expectedRevision ${outcome.revision}.`
		: ` Before a correction, read the current revision with markdown_read ${JSON.stringify({ document: outcome.documentId, revision: outcome.currentRevision })}. This historical text is not the update base.`;
	const show: string[] = [];
	if (outcome.show) {
		const input = outcome.paneInput ? `type ${JSON.stringify(outcome.paneInput.trimEnd())} and Enter into a reader pane that you opened, or ` : "";
		const run = `run ${JSON.stringify(outcome.show)} as the program of a new pane.`;
		if (hasPaneRevision(outcome.show)) show.push(`To show revision ${outcome.revision}, ${run}`);
		else if (outcome.revision !== outcome.currentRevision) show.push(`Current revision only: this reader build cannot pin revision ${outcome.revision}. To show the current revision, ${input}${run}`);
		else show.push(`To show it, ${input}${run} This opens the revision that is current when used.`);
	}
	return [`${outcome.documentId} revision ${outcome.revision} of ${outcome.currentRevision} · ${outcome.kind} · ${JSON.stringify(line(outcome.revisionTitle))} · ${outcome.bytes} bytes · ${outcome.digest}.${newer}${partial}${update}`, ...(coverage ? [coverage] : []), ...show, position].join("\n");
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

export function createReadTool(options: { store: MarkdownStore; app?: string; connection?: (context: ExtensionContext) => Promise<LiveConfig> }): ToolDefinition<typeof ReadParameters, ReadOutcome> {
	const presentation = toolDisplay().tools.find((tool) => tool.name === "markdown_read");
	return { ...presentation, name: "markdown_read", label: "Markdown Read", description: DESCRIPTION, promptSnippet: "Find stored Markdown documents and read an exact revision in pages, for example before an update.", parameters: ReadParameters, outputSchema: ReadOutcomeSchema, async execute(_id, params, _signal, _update, context) {
		let outcome = await readStored(options.store, params as ReadInput, options.app);
		const connection = options.connection;
		if (outcome.ok && outcome.op === "read") outcome = await withLiveShow(outcome, options.app, connection ? () => connection(context) : undefined, _signal);
		return { content: content(outcome), details: outcome, structuredContent: outcome, isError: !outcome.ok };
	} };
}
export function createNativeReadTool(durable: typeof Durable, options: { store: MarkdownStore; app?: string; connection?: (conversation: Durable.ConversationId, context: Context) => Promise<LiveConfig> }): Durable.ToolRegistration<typeof ReadParameters, Durable.JsonObject> {
	return durable.defineTool({ name: "markdown_read", description: DESCRIPTION, parameters: ReadParameters, structuredOutputSchema: ReadOutcomeSchema, replay: "safe",
		// A source page can be all newlines; both limits also reserve room for the header and launch guidance.
		outputLimits: { maxBytes: READ_PAGE_BYTES * 2, maxLines: READ_PAGE_BYTES + 128 }, async execute(params, api, context) {
		let outcome = await readStored(options.store, params as ReadInput, options.app);
		const connection = options.connection;
		if (outcome.ok && outcome.op === "read") outcome = await withLiveShow(outcome, options.app, connection ? () => connection(api.conversationId, context) : undefined, context.abortSignal);
		return { output: content(outcome), structuredOutput: outcome, details: outcome, isError: !outcome.ok };
	} });
}
