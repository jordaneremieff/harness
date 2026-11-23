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

function invalid(field: string): never {
	throw new Error(`Invalid ${field} in the comment result.`);
}

function rowIdentity(
	r: Record<string, unknown>,
	row: string,
): Pick<SentComment, "commentId" | "threadId" | "kind" | "ordinal"> {
	if (!id(r.commentId)) invalid(`${row}.commentId`);
	if (!count(r.ordinal)) invalid(`${row}.ordinal`);
	if (typeof r.threadId !== "string") invalid(`${row}.threadId`);
	if (r.commentId !== `${r.threadId}:${r.ordinal}`) invalid(`${row}.commentId`);
	if (
		!(
			((r.kind === "question" || r.kind === "overall") && r.ordinal === 0) ||
			(r.kind === "annotation" && r.ordinal > 0)
		)
	)
		invalid(`${row}.kind`);
	return { commentId: r.commentId, threadId: r.threadId, kind: r.kind, ordinal: r.ordinal };
}

function readRow(value: unknown, commentState: CommentState, index: number): SentComment {
	const row = `comments[${index}]`;
	if (!value || typeof value !== "object" || Array.isArray(value)) invalid(row);
	const r = value as Record<string, unknown>;
	const identity = rowIdentity(r, row);
	if (r.commentState !== commentState) invalid(`${row}.commentState`);
	if (!count(r.version, 1)) invalid(`${row}.version`);
	if (!text(r.text, 128 * 1024)) invalid(`${row}.text`);
	if (r.quote !== undefined && !text(r.quote, 8192)) invalid(`${row}.quote`);
	if (r.madeOnRevision !== undefined && !count(r.madeOnRevision, 1)) invalid(`${row}.madeOnRevision`);
	return {
		...identity,
		text: r.text,
		...(r.quote !== undefined ? { quote: r.quote } : {}),
		...(r.madeOnRevision !== undefined ? { madeOnRevision: r.madeOnRevision } : {}),
		commentState,
		version: r.version,
	};
}

export function readCommentResult(r: Record<string, unknown>, action: CommentAction): CommentResult {
	if (action.op === "comments") return readCommentPage(r, action);
	if (r.status !== "commentSet") invalid("status");
	if (r.commentId !== action.commentId) invalid("commentId");
	if (r.commentState !== action.commentState) invalid("commentState");
	if (!count(r.version, 1) || (r.version !== action.expectedVersion && r.version !== action.expectedVersion + 1))
		invalid("version");
	return { status: "commentSet", commentId: action.commentId, commentState: action.commentState, version: r.version };
}

function pageEnd(comments: SentComment[], offset: number, total: number, nextOffset: unknown): number {
	const end = offset + comments.length;
	if (end > total) invalid("total");
	if (end !== total && !comments.length) invalid("comments");
	if (end === total ? nextOffset !== undefined : nextOffset !== end) invalid("nextOffset");
	const ids = new Set<string>();
	for (const [index, item] of comments.entries()) {
		if (ids.has(item.commentId)) invalid(`comments[${index}].commentId`);
		ids.add(item.commentId);
	}
	if (
		comments.length > 1 &&
		comments.reduce((n, c) => n + Buffer.byteLength(c.text) + Buffer.byteLength(c.quote ?? ""), 0) > 64 * 1024
	)
		invalid("comments");
	return end;
}

function readCommentPage(
	r: Record<string, unknown>,
	action: Extract<CommentAction, { op: "comments" }>,
): CommentResult {
	if (r.status !== "comments") invalid("status");
	if (r.commentState !== action.commentState) invalid("commentState");
	if (r.offset !== action.offset) invalid("offset");
	if (!count(r.total)) invalid("total");
	if (!count(r.version) || (action.expectedVersion !== undefined && r.version !== action.expectedVersion))
		invalid("version");
	if (!Array.isArray(r.comments) || r.comments.length > 20) invalid("comments");
	const comments = r.comments.map((entry, index) => readRow(entry, action.commentState, index));
	const end = pageEnd(comments, action.offset, r.total, r.nextOffset);
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
