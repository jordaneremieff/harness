import { createHash } from "node:crypto";
import { BODY_BYTES, type Catalog, decodeBody, type Resource, readBody, resourceById } from "./catalog.ts";
import { InputError, inputObject, received } from "./input.ts";

export const ACCESS_DESCRIPTION =
	'Consult and apply the Pillars corpus (principles, patterns, heuristics) that governs agent judgment. Call this at any judgment moment where a governing entry might bind: architectural or design decisions, trade-offs, option menus and comparisons, whether infrastructure is warranted, where information belongs, how much verification a claim needs, and flagging or repairing prose tells. Also call it when the operator says "check pillars", "what do the pillars say", or "apply pillars", asks for a decision to be evaluated against principles, patterns, or heuristics, or proposes, derives, revises, or challenges corpus entries. Do not call it for routine execution that needs no doctrine judgment or corpus consultation. Omit arguments for the inventory and available resource identifiers. Read resource:"governance" for consultation and application rules, then select entries by their inventory triggers. Returns actual current source text, not a compliance verdict. Each response is bounded to 32 KiB. For longer bodies, continue with the returned nextOffset and referenceBodyDigest; changed source requires a fresh read. Use pillars_usage only for retained access counts.';
export const digest = (body: Buffer): string => createHash("sha256").update(body).digest("hex");
export interface AccessRequest {
	resource?: string;
	offset?: number;
	referenceBodyDigest?: string;
}
export interface AccessPage {
	schema: "pillars-source";
	resource: string;
	referenceBodyDigest: string;
	bodyBytes: number;
	offset: number;
	endOffset: number;
	text: string;
	nextOffset?: number;
	resources?: string[];
}
export interface AccessError {
	schema: "pillars-source-error";
	code: "invalid_input" | "source_unavailable" | "source_changed";
	message?: string;
}
const RESOURCE_FORM = 'Use a resource identifier: 1–64 lowercase letters, digits, or hyphens, starting with a letter or digit. Call pillars with {} for the inventory and its resources list.';
const CONTINUATION_FORM = "Copy nextOffset and referenceBodyDigest from the same source page, or omit offset and referenceBodyDigest for a fresh read.";

function resourceHint(value: unknown, catalog?: Catalog): string | undefined {
	if (typeof value !== "string" || value.length > 67 || !catalog) return undefined;
	const base = value.endsWith(".md") ? value.slice(0, -3) : value;
	const exact = resourceById(catalog, base);
	if (exact) return exact.resourceId;
	// A unique single-character edit is a suggestion, never an accepted alias.
	const near = catalog.resources.filter(({ resourceId: id }) => {
		if (Math.abs(id.length - base.length) > 1) return false;
		let i = 0;
		while (i < Math.min(id.length, base.length) && id[i] === base[i]) i++;
		return id.slice(i + Number(id.length >= base.length)) === base.slice(i + Number(base.length >= id.length));
	});
	return near.length === 1 ? near[0].resourceId : undefined;
}
function resourceError(value: unknown, catalog: Catalog | undefined, reason: string): InputError {
	const hint = resourceHint(value, catalog);
	const valid = hint ? `Send ${JSON.stringify({ resource: hint })}. Call pillars with {} for the inventory.` : RESOURCE_FORM;
	const error = new InputError("resource", value, `${reason} ${valid}`);
	// Only a known corpus identifier plus its filename suffix is safe to echo.
	if (hint && value === `${hint}.md`) error.message = `resource: received ${JSON.stringify(value)}. ${reason} ${valid}`;
	return error;
}
export function parseAccess(input: unknown, catalog?: Catalog): Required<Pick<AccessRequest, "resource" | "offset">> & AccessRequest {
	const args = inputObject(input, ["resource", "offset", "referenceBodyDigest"]);
	const resource = args.resource === undefined ? "inventory" : args.resource;
	const offset = args.offset === undefined ? 0 : args.offset;
	if (typeof resource !== "string" || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(resource))
		throw resourceError(resource, catalog, "Invalid identifier format; filenames are not identifiers.");
	if (catalog && !resourceById(catalog, resource)) throw resourceError(resource, catalog, "The resource is an unknown identifier in this inventory.");
	if (typeof offset !== "number" || !Number.isInteger(offset) || offset < 0 || offset > BODY_BYTES)
		throw new InputError("offset", offset, `Use an integer from 0 through ${BODY_BYTES}. ${CONTINUATION_FORM}`);
	const referenceBodyDigest = args.referenceBodyDigest;
	if (
		referenceBodyDigest !== undefined &&
		(typeof referenceBodyDigest !== "string" || !/^[a-f0-9]{64}$/.test(referenceBodyDigest))
	)
		throw new InputError("referenceBodyDigest", referenceBodyDigest, `Use exactly 64 lowercase hexadecimal characters. ${CONTINUATION_FORM}`);
	if (offset > 0 && referenceBodyDigest === undefined)
		throw new InputError("referenceBodyDigest", referenceBodyDigest, `The digest is missing for a nonzero offset. ${CONTINUATION_FORM}`);
	return { resource, offset, referenceBodyDigest };
}

const PAGE_TEXT_BYTES = 24_000;
const PAGE_LIMIT_BYTES = 32_768;

function alignedEnd(body: Buffer, offset: number, end: number): number {
	let value = Math.min(end, body.length);
	while (value > offset && (body[value] & 0xc0) === 0x80) value--;
	return value;
}

function usableOffset(body: Buffer, offset: number): boolean {
	return offset <= body.length && (offset === body.length || (body[offset] & 0xc0) !== 0x80);
}

function buildPage(
	resource: Resource,
	body: Buffer,
	referenceBodyDigest: string,
	offset: number,
	end: number,
	resources?: string[],
): AccessPage {
	return {
		schema: "pillars-source",
		resource: resource.resourceId,
		referenceBodyDigest,
		bodyBytes: body.length,
		offset,
		endOffset: end,
		text: decodeBody(body.subarray(offset, end)),
		...(end < body.length ? { nextOffset: end } : {}),
		...(resources ? { resources } : {}),
	};
}

function fitPage(page: AccessPage, body: Buffer): void {
	while (Buffer.byteLength(JSON.stringify(page)) > PAGE_LIMIT_BYTES) {
		const end = alignedEnd(body, page.offset, page.offset + Math.floor((page.endOffset - page.offset) / 2));
		if (end === page.offset) throw new Error("source_unavailable");
		page.endOffset = end;
		page.nextOffset = end;
		page.text = decodeBody(body.subarray(page.offset, end));
	}
}

export async function access(
	catalog: Catalog | undefined,
	input: unknown = {},
	signal?: AbortSignal,
): Promise<AccessPage | AccessError> {
	let args: ReturnType<typeof parseAccess>;
	try {
		args = parseAccess(input, catalog);
	} catch (error) {
		if (!(error instanceof InputError)) throw error;
		return { schema: "pillars-source-error", code: "invalid_input", message: error.message };
	}
	if (!catalog) return { schema: "pillars-source-error", code: "source_unavailable" };
	const resource = resourceById(catalog, args.resource);
	if (!resource) return { schema: "pillars-source-error", code: "source_unavailable" };
	try {
		const body = await readBody(resource.path, signal);
		decodeBody(body);
		const referenceBodyDigest = digest(body);
		if (args.referenceBodyDigest && args.referenceBodyDigest !== referenceBodyDigest)
			return {
				schema: "pillars-source-error", code: "source_changed",
				message: `referenceBodyDigest: received ${received(args.referenceBodyDigest)} that does not match the current source. The source changed or the digest belongs to another body; omit offset and referenceBodyDigest for a fresh read.`,
			};
		if (!usableOffset(body, args.offset)) return {
			schema: "pillars-source-error", code: "invalid_input",
			message: `offset: received ${received(args.offset)}. ${args.offset > body.length ? `The offset is beyond the source body (${body.length} bytes).` : "The offset is inside a UTF-8 character."} ${CONTINUATION_FORM}`,
		};
		const end = alignedEnd(body, args.offset, Math.min(body.length, args.offset + PAGE_TEXT_BYTES));
		const resources =
			resource.resourceClass === "inventory" ? catalog.resources.map((item) => item.resourceId) : undefined;
		const page = buildPage(resource, body, referenceBodyDigest, args.offset, end, resources);
		fitPage(page, body);
		return page;
	} catch {
		return { schema: "pillars-source-error", code: "source_unavailable" };
	}
}
