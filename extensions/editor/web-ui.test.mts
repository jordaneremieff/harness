import assert from "node:assert/strict";
import { test } from "node:test";
import { matchesThreadAnchor, rangeAt } from "./web/anchors.ts";
import type { DocRecord, ThreadAnchor } from "./web/types.ts";

test("selection at a context invocation depends on its point", () => {
	const text = "alpha\nβ😀";
	assert.deepEqual(rangeAt(text, 0, 5, 2), { start: 0, end: 5 });
	assert.deepEqual(rangeAt(text, 0, 5, 6), { start: 6, end: 7 });
	assert.deepEqual(rangeAt(text, 0, 5, 5), { start: 5, end: 5 });
	assert.deepEqual(rangeAt(text, 0, 5, 8), { start: 7, end: 9 });
	assert.deepEqual(rangeAt(text, 0, 5, text.length), { start: 9, end: 9 });
	assert.deepEqual(rangeAt(text, 6, 6), { start: 6, end: 6 });
});

test("a thread links back only to the exact document revision and quote", () => {
	const draft: DocRecord = { doc: "scratch:example", title: "Untitled", rev: 12, text: "one two one", dirty: true };
	const thread: ThreadAnchor = { id: "example", doc: draft.doc, rev: draft.rev, start: 8, end: 11, quote: "one" };
	assert.equal(matchesThreadAnchor(thread, draft), true);
	assert.equal(matchesThreadAnchor(thread, { ...draft, rev: 13 }), false);
	assert.equal(matchesThreadAnchor(thread, { ...draft, doc: "copy.txt" }), false);
	assert.equal(matchesThreadAnchor(thread, { ...draft, text: "one two two" }), false);
	assert.equal(matchesThreadAnchor({ ...thread, end: 99 }, draft), false);
	assert.equal(matchesThreadAnchor({ ...thread, target: { kind: "tab", key: draft.doc } }, draft), false);
});
