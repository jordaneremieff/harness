import { validUnicode } from "./responses.ts";

export type CommentState = "open" | "closed";
export type CommentAction =
	| { op: "comments"; commentState: CommentState; offset: number; expectedVersion?: number }
	| { op: "setComment"; commentId: string; commentState: CommentState; expectedVersion: number };

export interface SentComment {
	commentId: string;
	threadId: string;
	kind: "question" | "annotation" | "overall";
	ordinal: number;
	text: string;
	quote?: string;
	madeOnRevision?: number;
	commentState: CommentState;
	version: number;
}
export type CommentResult =
	| {
			status: "comments";
			commentState: CommentState;
			version: number;
			comments: SentComment[];
			total: number;
			offset: number;
			nextOffset?: number;
	  }
	| { status: "commentSet"; commentId: string; commentState: CommentState; version: number };

const count = (value: unknown, min = 0): value is number =>
	typeof value === "number" && Number.isSafeInteger(value) && value >= min;
const state = (value: unknown): value is CommentState => value === "open" || value === "closed";
const id = (value: unknown): value is string =>
	typeof value === "string" && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}:(?:0|[1-9]|[1-4][0-9]|50)$/u.test(value);
const text = (value: unknown, max: number): value is string =>
	typeof value === "string" && value.length > 0 && validUnicode(value) && Buffer.byteLength(value) <= max;

export function readCommentAction(record: Record<string, unknown>): CommentAction {
	if (record.op === "comments") {
		const commentState = record.commentState === undefined ? "open" : record.commentState;
		const offset = record.offset === undefined ? 0 : record.offset;
		if (
			!state(commentState) ||
			!count(offset) ||
			((offset > 0 || record.expectedVersion !== undefined) && !count(record.expectedVersion))
		)
			throw new Error("List comments by state. Continue with nextOffset and the same sheet version.");
		return {
			op: "comments",
			commentState,
			offset,
			...(record.expectedVersion !== undefined ? { expectedVersion: record.expectedVersion as number } : {}),
		};
	}
	if (
		record.op !== "setComment" ||
		!id(record.commentId) ||
		!state(record.commentState) ||
		!count(record.expectedVersion, 1)
	)
		throw new Error("A review change needs the listed comment ID, its current version and the requested state.");
	return {
		op: "setComment",
		commentId: record.commentId,
		commentState: record.commentState,
		expectedVersion: record.expectedVersion,
	};
}

function readRow(value: unknown, commentState: CommentState): SentComment {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid comment row.");
	const r = value as Record<string, unknown>;
	if (
		!id(r.commentId) ||
		!count(r.ordinal) ||
		typeof r.threadId !== "string" ||
		r.commentId !== `${r.threadId}:${r.ordinal}` ||
		!(
			((r.kind === "question" || r.kind === "overall") && r.ordinal === 0) ||
			(r.kind === "annotation" && r.ordinal > 0)
		) ||
		r.commentState !== commentState ||
		!count(r.version, 1) ||
		!text(r.text, 128 * 1024) ||
		(r.quote !== undefined && !text(r.quote, 8192)) ||
		(r.madeOnRevision !== undefined && !count(r.madeOnRevision, 1))
	)
		throw new Error("Invalid comment identity, version or content.");
	return {
		commentId: r.commentId,
		threadId: r.threadId,
		kind: r.kind,
		ordinal: r.ordinal,
		text: r.text,
		...(r.quote !== undefined ? { quote: r.quote } : {}),
		...(r.madeOnRevision !== undefined ? { madeOnRevision: r.madeOnRevision } : {}),
		commentState,
		version: r.version,
	};
}

export function readCommentResult(r: Record<string, unknown>, action: CommentAction): CommentResult {
	if (
		action.op === "setComment" &&
		r.status === "commentSet" &&
		r.commentId === action.commentId &&
		r.commentState === action.commentState &&
		count(r.version, 1) &&
		(r.version === action.expectedVersion || r.version === action.expectedVersion + 1)
	)
		return { status: "commentSet", commentId: action.commentId, commentState: action.commentState, version: r.version };
	if (action.op !== "comments") throw new Error("The reader did not confirm the requested comment change.");
	return readCommentPage(r, action);
}

function readCommentPage(
	r: Record<string, unknown>,
	action: Extract<CommentAction, { op: "comments" }>,
): CommentResult {
	if (
		r.status === "comments" &&
		r.commentState === action.commentState &&
		r.offset === action.offset &&
		count(r.total) &&
		count(r.version) &&
		(action.expectedVersion === undefined || r.version === action.expectedVersion) &&
		Array.isArray(r.comments) &&
		r.comments.length <= 20
	) {
		const comments = r.comments.map((entry) => readRow(entry, action.commentState));
		const end = action.offset + comments.length;
		if (
			end > r.total ||
			(end !== r.total && !comments.length) ||
			(end === r.total ? r.nextOffset !== undefined : r.nextOffset !== end) ||
			new Set(comments.map((c) => c.commentId)).size !== comments.length
		)
			throw new Error("Invalid comment page coverage.");
		if (
			comments.length > 1 &&
			comments.reduce((n, c) => n + Buffer.byteLength(c.text) + Buffer.byteLength(c.quote ?? ""), 0) > 64 * 1024
		)
			throw new Error("Comment page exceeds its text limit.");
		return {
			status: "comments",
			commentState: action.commentState,
			version: r.version,
			comments,
			total: r.total,
			offset: action.offset,
			...(end !== r.total ? { nextOffset: end } : {}),
		};
	}
	throw new Error("The reader did not confirm the requested comment operation.");
}
