/**
 * Request and answer shapes of the Pillars reader's native route. The attached terminal
 * transports them as opaque JSON through the `pillars` contribution command
 * (docs/conventions/operator-panels.md). Every operation is a read.
 */

import type { AccessError, AccessPage } from "./access.ts";
import type { BrowserEntry } from "./inventory.ts";

export type PillarsPanelRequest =
	| { op: "inventory" }
	| { op: "read"; resource: string; offset?: number; referenceBodyDigest?: string };

export type PillarsPanelAnswer =
	| { op: "inventory"; entries: BrowserEntry[] }
	| { op: "read"; page: AccessPage | AccessError };

const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const RESOURCE = /^[a-z0-9][a-z0-9-]{0,63}$/u;
const DIGEST = /^[a-f0-9]{64}$/u;

/** Reject anything outside the finite request union before a corpus read runs. */
export function readPanelRequest(value: unknown): PillarsPanelRequest {
	if (!record(value) || typeof value.op !== "string") throw new Error("pillars reader request must name an op");
	if (value.op === "inventory") return { op: "inventory" };
	if (value.op !== "read") throw new Error(`pillars reader request op ${value.op} is not supported`);
	if (typeof value.resource !== "string" || !RESOURCE.test(value.resource)) throw new Error("pillars read needs a resource identifier");
	const offset = value.offset;
	if (offset !== undefined && (typeof offset !== "number" || !Number.isSafeInteger(offset) || offset < 0)) throw new Error("pillars read offset must be a non-negative integer");
	const digest = value.referenceBodyDigest;
	if (digest !== undefined && (typeof digest !== "string" || !DIGEST.test(digest))) throw new Error("pillars read digest must be a SHA-256 hex digest");
	return { op: "read", resource: value.resource, ...(offset === undefined ? {} : { offset }), ...(digest === undefined ? {} : { referenceBodyDigest: digest }) };
}

function entry(value: unknown): value is BrowserEntry {
	return record(value) && ["resource", "title", "type", "index"].every((key) => typeof value[key] === "string");
}

function page(value: unknown): value is AccessPage | AccessError {
	if (!record(value)) return false;
	if (value.schema === "pillars-source-error") return typeof value.code === "string";
	return value.schema === "pillars-source" && typeof value.resource === "string" && typeof value.referenceBodyDigest === "string" && typeof value.text === "string"
		&& typeof value.offset === "number" && typeof value.endOffset === "number" && typeof value.bodyBytes === "number";
}

/** A malformed answer is an error the reader shows, never an empty corpus. */
export function readPanelAnswer(request: PillarsPanelRequest, value: unknown): PillarsPanelAnswer {
	if (!record(value) || value.op !== request.op) throw new Error("the host answered a different pillars request");
	if (request.op === "inventory") {
		if (!Array.isArray(value.entries) || !value.entries.every(entry)) throw new Error("the host answered an unreadable inventory");
		return { op: "inventory", entries: value.entries };
	}
	if (!page(value.page)) throw new Error("the host answered an unreadable source page");
	return { op: "read", page: value.page };
}
