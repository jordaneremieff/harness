import { str, int, arr, opt, obj, lit, union, type Schema } from "@earendil-works/pi-schema";
import { matchesSchema } from "./schema-check.ts";
import { textPrefix } from "./text-prefix.ts";

export const MAX_COLLABORATION_THREADS = 256;
export const MAX_COLLABORATION_MEMBERS = 64;
export const MAX_COLLABORATION_PAGE_BYTES = 48 * 1024;
export const MAX_COLLABORATION_EVENT_MESSAGE_UNITS = 8_000;
export const MAX_COLLABORATION_MESSAGE_UNITS = 24_000;
export type CollaborationMutationMethod = "collaboration-mutate" | "collaboration-message-parts";
export function collaborationMutationMethod(input: Readonly<Record<string, unknown>>): CollaborationMutationMethod {
	return (input.action === "post" || input.action === "close") &&
		typeof input.message === "string" &&
		input.message.length > MAX_COLLABORATION_EVENT_MESSAGE_UNITS
		? "collaboration-message-parts"
		: "collaboration-mutate";
}
export const COLLABORATION_THREAD_ID = /^([a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})\/([a-f0-9]{32})$/u;
const textSchema = (maxLength: number) => str({ minLength: 1, maxLength });
const StringEnum = <const T extends readonly string[]>(values: T): Schema<T[number]> => ({
	type: "string",
	enum: [...values],
});

const frameFields = {
	title: textSchema(160),
	purpose: textSchema(4000),
	authority: textSchema(4000),
	source: textSchema(2000),
	restrictions: textSchema(4000),
	acceptance: textSchema(4000),
	integrator: opt(textSchema(256)),
};
const participation = opt(
	str({
		description:
			"Create and join only. Use a short declaration (256 UTF-16 units); put details in a separate post. Empty text clears the declaration; omission preserves it.",
	}),
);
const message = str({
	minLength: 1,
	description:
		"Post and close require nonblank text, up to 24,000 UTF-16 units in one call. The thread links longer text across events and returns the final sequence. Leave accepts an optional message up to 8,000 units. For larger text, write a file under the working directory and post a summary with its path.",
});
const threadId = textSchema(128);
const limit = opt(int({ minimum: 1, maximum: 20 }));
const sequence = int({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const notify = opt(arr(textSchema(256), { maxItems: 16, uniqueItems: true }));
export const CollaborationActionParams = union([
	obj({ action: lit("create"), sessionId: opt(textSchema(256)), ...frameFields, participation, notify }),
	obj({
		action: lit("list"),
		sessionId: opt(textSchema(256)),
		query: opt(textSchema(256)),
		cursor: opt(textSchema(2048)),
		limit,
	}),
	obj({ action: lit("read"), threadId, before: opt(int({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER })), limit }),
	obj({
		action: lit("read"),
		threadId,
		after: sequence,
		knownFrameRevision: opt(int({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER })),
		limit,
	}),
	obj({ action: lit("join"), threadId, participation, source: opt(textSchema(2000)) }),
	obj({ action: lit("leave"), threadId, message: opt(message), source: opt(textSchema(2000)), notify }),
	obj({
		action: lit("post"),
		threadId,
		message,
		kind: opt(StringEnum(["contribution", "carried-authority"])),
		source: opt(textSchema(2000)),
		replyTo: opt(int({ minimum: 1 })),
		notify,
	}),
	obj({ action: lit("revise"), threadId, ...frameFields, notify }),
	obj({ action: lit("close"), threadId, message, source: opt(textSchema(2000)), notify }),
]);

/** Object-root parameters survive provider conversion; execution validates closed action branches. */
export const CollaborationParams = obj({
	action: {
		...StringEnum(["create", "list", "read", "join", "leave", "post", "revise", "close"]),
		description: "Select create, list, read, join, leave, post, revise or close.",
	},
	sessionId: opt(
		str({
			minLength: 1,
			maxLength: 256,
			description: "Create or list: select the storage through an exact agent identity.",
		}),
	),
	threadId: opt(
		str({
			minLength: 1,
			maxLength: 128,
			description: "Read, join, leave, post, revise or close: select the retained thread.",
		}),
	),
	title: opt(str({ minLength: 1, maxLength: 160, description: "Create and revise require the complete frame title." })),
	purpose: opt(
		str({ minLength: 1, maxLength: 4000, description: "Create and revise require the complete frame purpose." }),
	),
	authority: opt(
		str({
			minLength: 1,
			maxLength: 4000,
			description: "Create and revise require the attributed authority statement.",
		}),
	),
	source: opt(
		str({
			minLength: 1,
			maxLength: 2000,
			description:
				"Create, revise and carried-authority posts require source; join, leave, other posts and close accept it optionally.",
		}),
	),
	restrictions: opt(
		str({ minLength: 1, maxLength: 4000, description: "Create and revise require the complete frame restrictions." }),
	),
	acceptance: opt(
		str({
			minLength: 1,
			maxLength: 4000,
			description: "Create and revise require the complete frame acceptance criteria.",
		}),
	),
	integrator: opt(
		str({
			minLength: 1,
			maxLength: 256,
			description: "Create and revise: exact integration identity; omission selects the caller.",
		}),
	),
	participation,
	message: opt(message),
	kind: opt({
		...StringEnum(["contribution", "carried-authority"]),
		description: "Post only: attributed message category; carried-authority requires source.",
	}),
	replyTo: opt(int({ minimum: 1, description: "Post only: an earlier event sequence in this thread." })),
	notify: opt(
		arr(textSchema(256), {
			maxItems: 16,
			uniqueItems: true,
			description: "Create, leave, post, revise and close: exact identities that require active attention.",
		}),
	),
	query: opt(str({ minLength: 1, maxLength: 256, description: "List only: literal thread query." })),
	cursor: opt(
		str({ minLength: 1, maxLength: 2048, description: "List only: continuation returned by the previous list call." }),
	),
	before: opt(
		int({
			minimum: 1,
			maximum: Number.MAX_SAFE_INTEGER,
			description: "Read only: exclusive backward event cursor; do not combine with after.",
		}),
	),
	after: opt(
		int({
			minimum: 0,
			maximum: Number.MAX_SAFE_INTEGER,
			description: "Read only: exclusive forward event sequence; zero starts at the first event.",
		}),
	),
	knownFrameRevision: opt(
		int({
			minimum: 1,
			maximum: Number.MAX_SAFE_INTEGER,
			description:
				"Read only: with after, omit an unchanged frame at this revision. A read without after returns the frame and ignores it.",
		}),
	),
	limit: opt(int({ minimum: 1, maximum: 20, description: "List or read: maximum returned rows or events." })),
});

const actionFields: Record<string, readonly string[]> = {
	create: ["sessionId", ...Object.keys(frameFields), "participation", "notify"],
	list: ["sessionId", "query", "cursor", "limit"],
	read: ["threadId", "before", "after", "knownFrameRevision", "limit"],
	join: ["threadId", "participation", "source"],
	leave: ["threadId", "message", "source", "notify"],
	post: ["threadId", "message", "kind", "source", "replyTo", "notify"],
	revise: ["threadId", ...Object.keys(frameFields), "notify"],
	close: ["threadId", "message", "source", "notify"],
};
/** The host envelope includes a resolved sessionId even for a thread-addressed action. */
export function validateCollaborationAction(input: Record<string, unknown>, stage: "caller" | "host" = "caller"): void {
	const fields =
		typeof input.action === "string" && Object.hasOwn(actionFields, input.action)
			? actionFields[input.action]
			: undefined;
	if (!fields) throw new CollaborationReadError("invalid_request", "Unknown collaboration action");
	validateCollaborationTextLimits(input);
	const allowed = new Set([
		"action",
		"senderIdentity",
		"origin",
		"requestId",
		"ownerId",
		...(stage === "host" ? ["sessionId"] : []),
		"cwd",
		...fields,
	]);
	for (const key of Object.keys(input))
		if (!allowed.has(key))
			throw new CollaborationReadError(
				"invalid_request",
				key === "sessionId"
					? `Omit sessionId for action ${input.action}; threadId selects its storage`
					: `${key} is not valid for action ${input.action}; ${input.action} accepts ${fields.join(", ")}`,
			);
	if (input.action === "read") validateReadCursors(input);
	validateActionText(input);
	const publicInput = Object.fromEntries(
		Object.entries(input).filter(([key]) => key === "action" || fields.includes(key)),
	);
	if (!matchesSchema(CollaborationActionParams, publicInput))
		throw new CollaborationReadError(
			"invalid_request",
			`Invalid fields or selector combinations for action ${input.action}`,
		);
}
function validateReadCursors(input: Record<string, unknown>): void {
	if (input.after !== undefined && input.before !== undefined)
		throw new CollaborationReadError("invalid_request", "after and before are exclusive");
	if (input.knownFrameRevision !== undefined && input.after === undefined)
		throw new CollaborationReadError("invalid_request", "knownFrameRevision requires after");
	for (const [field, minimum] of [
		["after", 0],
		["before", 1],
		["knownFrameRevision", 1],
	] as const) {
		const value = input[field];
		if (value !== undefined && (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum))
			throw new CollaborationReadError(
				"invalid_request",
				`${field} must be a retained ${field === "knownFrameRevision" ? "frame revision" : "event cursor"}`,
			);
	}
}
function validateActionText(input: Record<string, unknown>): void {
	if (input.action === "create" || input.action === "revise") {
		for (const [key, max] of [
			["title", 160],
			["purpose", 4000],
			["authority", 4000],
			["source", 2000],
			["restrictions", 4000],
			["acceptance", 4000],
		] as const)
			collaborationText(input, key, max);
	}
	if (input.action === "post" || input.action === "close")
		collaborationText(input, "message", MAX_COLLABORATION_MESSAGE_UNITS);
	if (input.source !== undefined || (input.action === "post" && input.kind === "carried-authority"))
		collaborationText(input, "source", 2000);
}

export type CollaborationMember = { identity: string; contribution: string; joinedAt: number };
export type CollaborationFrame = {
	title: string;
	purpose: string;
	authority: string;
	source: string;
	restrictions: string;
	acceptance: string;
	integrator: string;
};
export type CollaborationThread = CollaborationFrame & {
	id: string;
	creator: string;
	createdAt: number;
	updatedAt: number;
	revision: number;
	closed: boolean;
	sequence: number;
	members: CollaborationMember[];
};
export type CollaborationEvent = {
	threadId: string;
	sequence: number;
	at: number;
	sender: string;
	origin: "model" | "operator";
	kind: string;
	message: string;
	source: string;
	replyTo: number | null;
	revision: number;
	notify: string[];
};
export type CollaborationSummary = {
	id: string;
	title: string;
	purpose: string;
	updatedAt: number;
	closed: boolean;
	members: number;
};
export type CollaborationEventView = CollaborationEvent & {
	atUtc: string | null;
	frameOmitted?: "current-frame-returned-separately";
};
export interface CollaborationPage {
	thread: CollaborationThread;
	events: CollaborationEventView[];
	nextBefore: number | null;
	pending: number;
	coverage: { complete: boolean; bytes: number };
}
export interface CollaborationForwardPage {
	direction: "forward";
	threadId: string;
	frameRevision: number;
	sequence: number;
	closed: boolean;
	thread?: CollaborationThread;
	events: CollaborationEventView[];
	next: null | {
		tool: "agent_collaborate";
		action: "read";
		threadId: string;
		after: number;
		knownFrameRevision: number;
		limit: number;
	};
	pending: number;
	coverage: { complete: boolean; bytes: number; after: number; through: number };
}
export interface CollaborationList {
	items: CollaborationSummary[];
	nextCursor: string | null;
	coverage: { complete: boolean; visited: number; omitted: number; unavailable?: number };
}
export interface CollaborationProjection {
	items: CollaborationSummary[];
	omitted: number;
	updatedAt: string;
}

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
	if (typeof value === "string" && value.length > max) {
		if (key === "participation")
			throw new Error(
				`participation exceeds ${max} UTF-16 units; use a short declaration, then post the details with action: post`,
			);
		if (key === "message")
			throw new Error(
				`message is ${value.length} UTF-16 units; the limit is ${max}. Write long content to a file under the working directory and post a short summary with its path, or use consecutive posts linked with replyTo. For leave or close, post the details before the final action.`,
			);
		throw new Error(
			`${key} exceeds the maximum length of ${max} characters${key === "title" ? "; shorten title to at most 160 characters and repeat the call" : ""}`,
		);
	}
	if (typeof value !== "string" || value.trim() === "")
		throw new Error(
			`${key} is required and must be nonblank text${key === "title" ? "; supply title as nonblank text in the create or revise call" : ""}`,
		);
	return value;
}

/** Pi's pre-handler validation omits schema descriptions, so these caps own their remedy. */
export function validateCollaborationTextLimits(input: Record<string, unknown>): void {
	const messageLimit =
		input.action === "post" || input.action === "close"
			? MAX_COLLABORATION_MESSAGE_UNITS
			: MAX_COLLABORATION_EVENT_MESSAGE_UNITS;
	for (const [key, max] of [
		["participation", 256],
		["message", messageLimit],
	] as const) {
		if (typeof input[key] === "string" && input[key].length > max) collaborationText(input, key, max);
	}
}

export function collaborationStorage(threadId: string): string {
	const match = COLLABORATION_THREAD_ID.exec(threadId);
	if (!match) throw new Error("threadId must be an identity returned by agent_collaborate");
	return match[1];
}

export function collaborationSummary(thread: CollaborationThread): CollaborationSummary {
	return {
		id: thread.id,
		title: thread.title,
		purpose: textPrefix(thread.purpose, 160),
		updatedAt: thread.updatedAt,
		closed: thread.closed,
		members: thread.members.length,
	};
}

export function parseCollaborationProjection(value: unknown, storageId: string): CollaborationProjection {
	if (!value || typeof value !== "object" || Buffer.byteLength(JSON.stringify(value)) > 4600)
		throw new Error("Invalid thread discovery projection");
	const data = value as CollaborationProjection;
	if (
		!Array.isArray(data.items) ||
		data.items.length > 8 ||
		!Number.isSafeInteger(data.omitted) ||
		data.omitted < 0 ||
		typeof data.updatedAt !== "string"
	)
		throw new Error("Invalid thread discovery projection");
	for (const item of data.items) {
		if (
			collaborationStorage(item.id) !== storageId ||
			typeof item.title !== "string" ||
			item.title.length > 160 ||
			typeof item.purpose !== "string" ||
			item.purpose.length > 160 ||
			typeof item.closed !== "boolean" ||
			!Number.isSafeInteger(item.updatedAt) ||
			!Number.isSafeInteger(item.members) ||
			item.members < 0 ||
			item.members > MAX_COLLABORATION_MEMBERS
		)
			throw new Error("Invalid thread discovery row");
	}
	return data;
}
