import { str, int, arr, opt, obj, type Schema } from "@earendil-works/pi-schema";

export const MAX_COLLABORATION_THREADS = 256;
export const MAX_COLLABORATION_MEMBERS = 64;
export const MAX_COLLABORATION_PAGE_BYTES = 48 * 1024;
export const COLLABORATION_THREAD_ID = /^([a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})\/([a-f0-9]{32})$/u;
const textSchema = (maxLength: number) => str({ minLength: 1, maxLength });
const StringEnum = <const T extends readonly string[]>(values: T): Schema<T[number]> => ({ type: "string", enum: [...values] });

export const CollaborationParams = obj({
	action: StringEnum(["create", "list", "read", "join", "leave", "post", "revise", "close"]),
	sessionId: opt(textSchema(256)),
	threadId: opt(textSchema(128)),
	title: opt(textSchema(160)),
	purpose: opt(textSchema(4000)),
	authority: opt(textSchema(4000)),
	source: opt(textSchema(2000)),
	restrictions: opt(textSchema(4000)),
	acceptance: opt(textSchema(4000)),
	integrator: opt(textSchema(256)),
	contribution: opt(str({ minLength: 1, description: "At most 256 characters. Write longer content to a file and post its path. The handler enforces this cap with that remedy." })),
	message: opt(str({ minLength: 1, description: "At most 8,000 characters. Write longer content to a file and post its path. The handler enforces this cap with that remedy." })),
	kind: opt(StringEnum(["contribution", "carried-authority"])),
	replyTo: opt(int({ minimum: 1 })),
	notify: opt(arr(textSchema(256), { maxItems: 16, uniqueItems: true })),
	query: opt(textSchema(256)),
	cursor: opt(textSchema(2048)),
	before: opt(int({ minimum: 1 })),
	limit: opt(int({ minimum: 1, maximum: 20 })),
});

export type CollaborationMember = { identity: string; contribution: string; joinedAt: number };
export type CollaborationFrame = {
	title: string; purpose: string; authority: string; source: string; restrictions: string; acceptance: string; integrator: string;
};
export type CollaborationThread = CollaborationFrame & {
	id: string; creator: string; createdAt: number; updatedAt: number; revision: number; closed: boolean; sequence: number; members: CollaborationMember[];
};
export type CollaborationEvent = {
	threadId: string; sequence: number; at: number; sender: string; origin: "model" | "operator";
	kind: string; message: string; source: string; replyTo: number | null; revision: number; notify: string[];
};
export type CollaborationSummary = { id: string; title: string; purpose: string; updatedAt: number; closed: boolean; members: number };
export interface CollaborationPage {
	thread: CollaborationThread;
	events: CollaborationEvent[];
	nextBefore: number | null;
	pending: number;
	coverage: { complete: boolean; bytes: number };
}
export interface CollaborationList {
	items: CollaborationSummary[];
	nextCursor: string | null;
	coverage: { complete: boolean; visited: number; omitted: number; unavailable?: number };
}
export interface CollaborationProjection { items: CollaborationSummary[]; omitted: number; updatedAt: string }

export class CollaborationReadError extends Error {
	readonly code: "invalid_request" | "not_found" | "source_unreadable";
	constructor(code: CollaborationReadError["code"], message: string) {
		super(message);
		this.name = "CollaborationReadError";
		this.code = code;
	}
}

export function collaborationText(input: Record<string, unknown>, key: string, max: number, optional = false): string {
	const value = input[key];
	if (value === undefined && optional) return "";
	if (typeof value === "string" && value.length > max) throw new Error(`${key} exceeds the maximum length of ${max} characters${key === "title" ? "; shorten title to at most 160 characters and repeat the call" : key === "contribution" || key === "message" ? "; write the full content to a file and post its path" : ""}`);
	if (typeof value !== "string" || value.trim() === "") throw new Error(`${key} is required and must be nonblank text${key === "title" ? "; supply title as nonblank text in the create or revise call" : ""}`);
	return value;
}

/** Pi's pre-handler validation omits schema descriptions, so these caps own their remedy. */
export function validateCollaborationTextLimits(input: Record<string, unknown>): void {
	for (const [key, max] of [["contribution", 256], ["message", 8000]] as const) {
		if (typeof input[key] === "string" && input[key].length > max) collaborationText(input, key, max);
	}
}

export function collaborationStorage(threadId: string): string {
	const match = COLLABORATION_THREAD_ID.exec(threadId);
	if (!match) throw new Error("threadId must be an identity returned by agent_collaborate");
	return match[1];
}

export function collaborationSummary(thread: CollaborationThread): CollaborationSummary {
	return { id: thread.id, title: thread.title, purpose: thread.purpose.slice(0, 160), updatedAt: thread.updatedAt, closed: thread.closed, members: thread.members.length };
}

export function parseCollaborationProjection(value: unknown, storageId: string): CollaborationProjection {
	if (!value || typeof value !== "object" || Buffer.byteLength(JSON.stringify(value)) > 4600) throw new Error("Invalid thread discovery projection");
	const data = value as CollaborationProjection;
	if (!Array.isArray(data.items) || data.items.length > 8 || !Number.isSafeInteger(data.omitted) || data.omitted < 0 || typeof data.updatedAt !== "string") throw new Error("Invalid thread discovery projection");
	for (const item of data.items) {
		if (collaborationStorage(item.id) !== storageId || typeof item.title !== "string" || item.title.length > 160 || typeof item.purpose !== "string" || item.purpose.length > 160 || typeof item.closed !== "boolean" || !Number.isSafeInteger(item.updatedAt) || !Number.isSafeInteger(item.members) || item.members < 0 || item.members > MAX_COLLABORATION_MEMBERS) throw new Error("Invalid thread discovery row");
	}
	return data;
}
