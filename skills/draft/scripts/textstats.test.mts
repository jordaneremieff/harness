// Tests for the draft prose meter. The command line entry is meter.mts (run it with --help).
import assert from "node:assert/strict";
import test from "node:test";
import { countWords, splitSentences, wordSpans } from "./textstats.mts";

test("countWords counts hyphenated and apostrophe words once", () => {
	assert.equal(countWords("A well-known tool doesn't fail."), 5);
	assert.equal(countWords(""), 0);
	assert.equal(countWords("naïve café"), 2);
});

test("wordSpans return offsets into the text", () => {
	const spans = wordSpans("ab cd");
	assert.deepEqual(spans, [
		{ start: 0, end: 2 },
		{ start: 3, end: 5 },
	]);
});

test("splitSentences splits on terminal punctuation before a capital", () => {
	const text = "One thing. Another thing! A third? Yes.";
	assert.equal(splitSentences(text).length, 4);
});

test("splitSentences keeps abbreviations inside one sentence", () => {
	assert.equal(splitSentences("Use a tool, e.g. the linter. Then run it.").length, 2);
	assert.equal(splitSentences("Ask Dr. Chen about it. She knows.").length, 2);
});

test("a unit without terminal punctuation is one sentence", () => {
	assert.equal(splitSentences("a short list phrase").length, 1);
});
