import { isAbsolute } from "node:path";
import { SOURCE_BYTES, type Completeness, type RecentResponses, type ResponseOrigin, type ResponseSnapshot, responseDigest, responseText, validUnicode } from "./responses.ts";

export const PAGE_BYTES = 256 * 1024;
export type MarkdownRequest = { op: "recent" } | { op: "response"; entryId: string; offset: number } | { op: "published"; cursor?: string };
export interface DocumentRow { id: string; title: string; revision: number; bytes: number; kind: "published" | "response" | "file"; digest: string; updatedAt: string }
export interface ResponsePage {
	op: "response";
	entryId: string;
	timestamp?: number;
	offset: number;
	nextOffset: number | null;
	text: string;
	chars: number;
	bytes: number;
	digest: string;
	parts: number[];
	stop: string;
	completeness: Completeness;
	provenance: ResponseOrigin;
}
export type MarkdownAnswer = ({ op: "recent" } & RecentResponses) | ResponsePage | { op: "published"; rows: DocumentRow[]; root: string; storeId?: string; limited: boolean; nextCursor?: string };
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const integer = (value: unknown, max = SOURCE_BYTES): value is number => Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= max;
const timestamp = (value: unknown): boolean => value === undefined || (typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= 8.64e15);
const text = (value: unknown, max: number): value is string => typeof value === "string" && value.length > 0 && value.length <= max && validUnicode(value);
const keys = (value: Record<string, unknown>, allowed: string[]) => Object.keys(value).every((key) => allowed.includes(key));
const digest = (value: unknown): value is string => typeof value === "string" && /^sha256:[a-f0-9]{64}$/u.test(value);
const complete = (value: unknown): value is Completeness => record(value) && (value.state === "complete" || value.state === "partial") && (value.reason === undefined || ["length", "aborted", "error", "tool-use"].includes(String(value.reason))) && (value.note === undefined || text(value.note, 500));
const origin = (value: unknown): value is ResponseOrigin => record(value) && ["ordinary-response", "native-response"].includes(String(value.kind)) && text(value.entry, 200) && text(value.model, 500) && text(value.capturedAt, 100) && ["host", "session", "conversation", "cwd"].every((key) => value[key] === undefined || text(value[key], 4096)) && Array.isArray(value.parts) && value.parts.length <= SOURCE_BYTES && value.parts.every((part) => record(part) && integer(part.chars));
export function readPanelRequest(value: unknown): MarkdownRequest {
	if (record(value)) {
		if (value.op === "recent" && keys(value, ["op"])) return { op: "recent" };
		if (value.op === "published" && keys(value, ["op", "cursor"]) && (value.cursor === undefined || text(value.cursor, 200))) return { op: "published", ...(value.cursor === undefined ? {} : { cursor: value.cursor }) };
		if (value.op === "response" && keys(value, ["op", "entryId", "offset"]) && text(value.entryId, 200) && /^[1-9]\d*$/u.test(value.entryId) && Number.isSafeInteger(Number(value.entryId)) && integer(value.offset)) return { op: "response", entryId: value.entryId, offset: value.offset };
	}
	throw new Error("Invalid Markdown request; expected recent, response with entryId and offset, or published.");
}
function readListingAnswer(value: Record<string, unknown>): MarkdownAnswer | undefined {
	if (value.op === "recent" && Array.isArray(value.rows) && value.rows.length <= 30 && value.rows.every((row) => record(row) && text(row.entryId, 200) && timestamp(row.timestamp) && typeof row.preview === "string" && row.preview.length <= 320 && integer(row.bytes, Number.MAX_SAFE_INTEGER) && text(row.stop, 100) && complete(row.completeness)) && (value.cutoff === null || text(value.cutoff, 200)) && integer(value.visited, 2000) && ["end", "visits", "results", "missing"].includes(String(value.stop))) return value as unknown as MarkdownAnswer;
	if (value.op === "published" && Array.isArray(value.rows) && value.rows.length <= 2000 && value.rows.every((row) => record(row) && typeof row.id === "string" && /^md-[a-f0-9]{20}$/u.test(row.id) && text(row.title, 400) && integer(row.revision, Number.MAX_SAFE_INTEGER) && Number(row.revision) > 0 && integer(row.bytes) && ["published", "response", "file"].includes(String(row.kind)) && digest(row.digest) && text(row.updatedAt, 100)) && text(value.root, 4096) && isAbsolute(value.root) && (value.storeId === undefined ? value.rows.length === 0 : typeof value.storeId === "string" && /^[a-f0-9]{32}$/u.test(value.storeId)) && typeof value.limited === "boolean" && (value.nextCursor === undefined || text(value.nextCursor, 200))) return value as unknown as MarkdownAnswer;
	return undefined;
}
export function readPanelAnswer(request: MarkdownRequest, value: unknown): MarkdownAnswer {
	if (!record(value) || value.op !== request.op) throw new Error("The host returned a different Markdown operation.");
	const listing = readListingAnswer(value);
	if (listing) return listing;
	if (value.op === "response" && request.op === "response" && value.entryId === request.entryId && value.offset === request.offset && timestamp(value.timestamp) && integer(value.chars) && integer(value.bytes) && typeof value.text === "string" && validUnicode(value.text) && Buffer.byteLength(value.text) <= PAGE_BYTES && (value.nextOffset === null || integer(value.nextOffset)) && digest(value.digest) && Array.isArray(value.parts) && value.parts.length > 0 && value.parts.every((size) => integer(size) && size > 0) && text(value.stop, 100) && complete(value.completeness) && origin(value.provenance)) {
		const end = request.offset + value.text.length;
		if (end <= value.chars && (value.nextOffset === null ? end === value.chars : value.nextOffset === end && end > request.offset && end < value.chars) && value.parts.reduce((sum: number, size: number) => sum + size, 2 * (value.parts.length - 1)) === value.chars && value.provenance.entry === request.entryId && JSON.stringify(value.provenance.parts.map((part) => part.chars)) === JSON.stringify(value.parts)) return value as unknown as ResponsePage;
	}
	throw new Error("The host returned malformed Markdown data.");
}
/** Offsets count UTF-16 units; a page never ends inside a surrogate pair. */
export function responsePage(response: ResponseSnapshot, offset: number): ResponsePage {
	const source = responseText(response);
	if (!integer(offset) || offset > source.length || (offset > 0 && /[\uDC00-\uDFFF]/u.test(source[offset] ?? ""))) throw new Error("Invalid response page boundary.");
	let end = offset;
	let bytes = 0;
	while (end < source.length) {
		const point = String.fromCodePoint(source.codePointAt(end) ?? 0);
		const size = Buffer.byteLength(point);
		if (bytes + size > PAGE_BYTES) break;
		bytes += size;
		end += point.length;
	}
	return { op: "response", entryId: response.entryId, timestamp: response.timestamp, offset, nextOffset: end < source.length ? end : null, text: source.slice(offset, end), chars: source.length, bytes: Buffer.byteLength(source), digest: responseDigest(source), parts: response.parts.map((part) => part.length), stop: response.stop, completeness: response.completeness, provenance: response.provenance };
}
export async function acquireResponse(entryId: string, ask: (request: MarkdownRequest) => Promise<MarkdownAnswer>, signal: AbortSignal): Promise<ResponseSnapshot> {
	let first: ResponsePage | undefined;
	let source = "";
	for (let pageNumber = 0; pageNumber < 10; pageNumber++) {
		signal.throwIfAborted();
		const request: MarkdownRequest = { op: "response", entryId, offset: source.length };
		const answer = readPanelAnswer(request, await ask(request));
		signal.throwIfAborted();
		if (answer.op !== "response") throw new Error("Unexpected response page.");
		first ??= answer;
		if (answer.digest !== first.digest || answer.bytes !== first.bytes || answer.chars !== first.chars || JSON.stringify(answer.parts) !== JSON.stringify(first.parts) || answer.stop !== first.stop || answer.timestamp !== first.timestamp || JSON.stringify(answer.completeness) !== JSON.stringify(first.completeness) || answer.provenance.session !== first.provenance.session || answer.provenance.conversation !== first.provenance.conversation || answer.provenance.model !== first.provenance.model) throw new Error("The response changed between pages; no document was saved.");
		source += answer.text;
		if (Buffer.byteLength(source) > SOURCE_BYTES) throw new Error("Response source limit exceeded.");
		if (answer.nextOffset === null) {
			if (source.length !== first.chars || Buffer.byteLength(source) !== first.bytes || responseDigest(source) !== first.digest) throw new Error("Response digest or size mismatch; no document was saved.");
			let offset = 0;
			const parts = first.parts.map((length, index) => {
				if (index > 0 && source.slice(offset - 2, offset) !== "\n\n") throw new Error("Response part boundary mismatch.");
				const part = source.slice(offset, offset + length);
				offset += length + 2;
				return part;
			});
			return { entryId, parts, timestamp: first.timestamp, stop: first.stop, completeness: first.completeness, provenance: first.provenance };
		}
	}
	throw new Error("Response page limit exceeded; no document was saved.");
}
