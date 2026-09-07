import { createHash } from "node:crypto";
import { BODY_BYTES, type Catalog, decodeBody, readBody, resourceById } from "./catalog.ts";

export const ACCESS_DESCRIPTION =
	'Consult the Pillars corpus. Omit arguments for its inventory and available resource identifiers. Read resource:"governance" for consultation and application rules, then select entries by their inventory triggers. Returns actual current source text, not a compliance verdict. Each response is bounded to 32 KiB. For longer bodies, continue with the returned nextOffset and referenceBodyDigest; changed source requires a fresh read. Use pillars_usage only for retained access counts.';
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
}
export function parseAccess(input: unknown): Required<Pick<AccessRequest, "resource" | "offset">> & AccessRequest {
	if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("invalid_input");
	const args = input as Record<string, unknown>;
	if (Object.keys(args).some((key) => !["resource", "offset", "referenceBodyDigest"].includes(key)))
		throw new Error("invalid_input");
	const resource = args.resource ?? "inventory";
	const offset = args.offset ?? 0;
	if (
		typeof resource !== "string" ||
		!/^[a-z0-9][a-z0-9-]{0,63}$/.test(resource) ||
		!Number.isInteger(offset) ||
		(offset as number) < 0 ||
		(offset as number) > BODY_BYTES ||
		(args.referenceBodyDigest !== undefined &&
			(typeof args.referenceBodyDigest !== "string" || !/^[a-f0-9]{64}$/.test(args.referenceBodyDigest))) ||
		((offset as number) > 0 && args.referenceBodyDigest === undefined)
	)
		throw new Error("invalid_input");
	return { resource, offset: offset as number, referenceBodyDigest: args.referenceBodyDigest as string | undefined };
}

export async function access(
	catalog: Catalog | undefined,
	input: unknown = {},
	signal?: AbortSignal,
): Promise<AccessPage | AccessError> {
	let args: ReturnType<typeof parseAccess>;
	try {
		args = parseAccess(input);
	} catch {
		return { schema: "pillars-source-error", code: "invalid_input" };
	}
	if (!catalog) return { schema: "pillars-source-error", code: "source_unavailable" };
	const resource = resourceById(catalog, args.resource);
	if (!resource) return { schema: "pillars-source-error", code: "source_unavailable" };
	try {
		const body = await readBody(resource.path, signal);
		decodeBody(body);
		const referenceBodyDigest = digest(body);
		if (args.referenceBodyDigest && args.referenceBodyDigest !== referenceBodyDigest)
			return { schema: "pillars-source-error", code: "source_changed" };
		if (args.offset > body.length || (args.offset < body.length && (body[args.offset] & 0xc0) === 0x80))
			return { schema: "pillars-source-error", code: "invalid_input" };
		let end = Math.min(body.length, args.offset + 24000);
		while (end < body.length && (body[end] & 0xc0) === 0x80) end--;
		const page: AccessPage = {
			schema: "pillars-source",
			resource: resource.resourceId,
			referenceBodyDigest,
			bodyBytes: body.length,
			offset: args.offset,
			endOffset: end,
			text: decodeBody(body.subarray(args.offset, end)),
			...(end < body.length ? { nextOffset: end } : {}),
			...(resource.resourceClass === "inventory"
				? { resources: catalog.resources.map((item) => item.resourceId) }
				: {}),
		};
		while (Buffer.byteLength(JSON.stringify(page)) > 32768) {
			end = args.offset + Math.floor((end - args.offset) / 2);
			while (end > args.offset && (body[end] & 0xc0) === 0x80) end--;
			if (end === args.offset) throw new Error("source_unavailable");
			page.endOffset = end;
			page.nextOffset = end;
			page.text = decodeBody(body.subarray(args.offset, end));
		}
		return page;
	} catch {
		return { schema: "pillars-source-error", code: "source_unavailable" };
	}
}
