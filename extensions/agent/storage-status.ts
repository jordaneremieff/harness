import type { Cursor } from "@earendil-works/pi-durable";

export const STORAGE_STATUS_ID_PATTERN = "^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$";
export interface StorageStatusPageInput {
	readonly view: "storage-page";
	readonly storageId: string;
	readonly cursor?: Cursor;
	readonly limit?: number;
}

function record(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Select one exact native storage without name resolution or global discovery. */
export function storageStatusPageInput(value: unknown): StorageStatusPageInput & { readonly limit: number } {
	if (!record(value) || value.view !== "storage-page") throw new Error("Storage status requires view: storage-page");
	for (const key of Object.keys(value)) if (!["view", "storageId", "cursor", "limit"].includes(key)) throw new Error(`Storage status does not accept ${key}`);
	if (typeof value.storageId !== "string" || !new RegExp(STORAGE_STATUS_ID_PATTERN, "u").test(value.storageId)) throw new Error("Storage status requires an exact bare native storageId");
	if (value.cursor !== undefined && !record(value.cursor)) throw new Error("Storage status cursor must be a backend-owned JSON record");
	const limit = value.limit === undefined ? 50 : value.limit;
	if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error("Storage status limit must be an integer from 1 to 50");
	return { view: "storage-page", storageId: value.storageId, limit, ...(value.cursor === undefined ? {} : { cursor: value.cursor as Cursor }) };
}

/** Provider object schemas declare all fields; execution enforces mutually exclusive selectors. */
export function validateStatusSelectors(value: Readonly<Record<string, unknown>>): void {
	if (value.view === "storage-page") { storageStatusPageInput(value); return; }
	for (const key of ["storageId", "cursor", "limit"]) if (value[key] !== undefined) throw new Error(`${key} requires view: storage-page with an exact storageId. Omit ${key} for every other view: each returns one bounded result with no page selector.`);
	if (value.view !== undefined && value.view !== "fleet") throw new Error("Status view must be fleet or storage-page");
	if (value.view === "fleet" && value.sessionId !== undefined) throw new Error("Fleet status does not accept sessionId");
}

/** The cold snapshot adds cwd locally; it never becomes a public page selector. */
export function storageStatusScanInput(params: Readonly<Record<string, unknown>> | undefined, storageId: string): StorageStatusPageInput & { readonly limit: number } {
	const { cwd: _cwd, ...input } = params ?? {};
	const page = Object.keys(input).length === 0 ? { view: "storage-page" as const, storageId, limit: 50 } : storageStatusPageInput(input);
	if (page.storageId !== storageId) throw new Error("Storage status target differs from the selected host");
	return page;
}

/** Page-local scan coverage preserves the backend cursor and invents no total. */
export function storageStatusCoverage(storageId: string, limit: number, scanned: number, returned: number, next: Cursor | undefined) {
	return { complete: next === undefined, returned, scanned, next: next === undefined ? null : { tool: "agent_status" as const, view: "storage-page" as const, storageId, cursor: next, limit } };
}
