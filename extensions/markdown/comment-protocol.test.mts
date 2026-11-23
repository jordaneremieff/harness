import assert from "node:assert/strict";
import test from "node:test";
import { readCommentAction, readCommentResult } from "./comment-protocol.ts";

const threadId = "990deca7-e149-4116-803f-fbcc55c36229";
const item = {
	commentId: `${threadId}:1`,
	threadId,
	ordinal: 1,
	kind: "annotation",
	text: "Expand the example",
	quote: "milk",
	madeOnRevision: 3,
	commentState: "open",
	version: 2,
};
const page = {
	status: "comments",
	commentState: "open",
	version: 4,
	offset: 0,
	total: 2,
	nextOffset: 1,
	comments: [item],
};

test("comment pages keep origin and state, not the reader's source anchor or private inputs", () => {
	const action = readCommentAction({ op: "comments" });
	assert.deepEqual(action, { op: "comments", commentState: "open", offset: 0 });
	assert.deepEqual(
		readCommentResult({ ...page, comments: [{ ...item, sourceAnchor: "**milk**", draft: "not sent" }] }, action),
		page,
	);
	assert.throws(
		() => readCommentResult({ ...page, comments: [{ ...item, commentId: `${threadId}:2` }] }, action),
		/comments\[0\]\.commentId/u,
	);
	assert.throws(() => readCommentResult({ ...page, comments: [] }, action), /comments/u);
	assert.throws(() => readCommentResult({ ...page, nextOffset: 2 }, action), /nextOffset/u);
	assert.throws(() => readCommentAction({ op: "comments", offset: 1 }));
	const next = readCommentAction({ op: "comments", offset: 1, expectedVersion: 4 });
	assert.throws(
		() => readCommentResult({ ...page, offset: 1, total: 2, nextOffset: undefined, version: 5 }, next),
		/version/u,
	);
});

test("an addressed receipt confirms only the requested item, version and state", () => {
	const close = readCommentAction({
		op: "setComment",
		commentId: item.commentId,
		commentState: "closed",
		expectedVersion: 2,
	});
	const receipt = { status: "commentSet", commentId: item.commentId, commentState: "closed", version: 3 };
	assert.deepEqual(readCommentResult(receipt, close), receipt);
	assert.throws(() => readCommentResult({ ...receipt, version: 4 }, close), /version/u);
	assert.throws(() => readCommentResult({ ...receipt, commentState: "open" }, close), /commentState/u);
	assert.throws(() => readCommentAction({ ...close, commentId: `${threadId}:51` }));
});
