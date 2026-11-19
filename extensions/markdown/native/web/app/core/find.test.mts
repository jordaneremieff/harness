import assert from "node:assert/strict";
import { test } from "node:test";
import { scripts, plain } from "../../test/load.mts";
const { reader } = scripts(["app/core/find.ts"]);
const matches = (text: string, query: string) => reader.find.literal(query)(text);
const ranges = (text: string, query: string) => plain(matches(text, query));
test("expanding lowercase characters do not move the reported offsets", () => {
	assert.deepEqual(ranges("İx", "x"), [{ start: 1, end: 2 }]);
	assert.deepEqual(ranges("İx", "X"), [{ start: 1, end: 2 }]);
	assert.deepEqual(ranges("😀İx", "X"), [{ start: 3, end: 4 }]);
	assert.deepEqual(ranges("aİbİc", "İ"), [
		{ start: 1, end: 2 },
		{ start: 3, end: 4 },
	]);
});
test("search matches are literal and non-overlapping", () => {
	assert.deepEqual(ranges("aaaa", "aa"), [
		{ start: 0, end: 2 },
		{ start: 2, end: 4 },
	]);
	assert.deepEqual(ranges("aaa", "aa"), [{ start: 0, end: 2 }]);
	assert.deepEqual(ranges("İİx", "x"), [{ start: 2, end: 3 }]);
	assert.deepEqual(ranges("a.b axb", "a.b"), [{ start: 0, end: 3 }]);
	assert.deepEqual(ranges("a.b [x] (y) $", "[x]"), [{ start: 4, end: 7 }]);
	assert.deepEqual(ranges("a.b [x] (y) $", "$"), [{ start: 12, end: 13 }]);
	assert.deepEqual(ranges("a.b [x] (y) $", "."), [{ start: 1, end: 2 }]);
	assert.deepEqual(ranges("a*b", "*"), [{ start: 1, end: 2 }]);
	assert.deepEqual(ranges("abc", ""), []);
});
test("simple Unicode case folding keeps original offsets", () => {
	assert.deepEqual(ranges("Éclair éclair", "é"), [
		{ start: 0, end: 1 },
		{ start: 7, end: 8 },
	]);
	assert.deepEqual(ranges("i\u0307x", "i\u0307"), [{ start: 0, end: 2 }]);
	// The trade-off against lowercasing: U+0130 has only a full (expanding) lowercase mapping, so
	// Unicode simple case folding does not match it from "i".
	assert.deepEqual(ranges("i\u0307x", "i"), [{ start: 0, end: 1 }]);
	assert.deepEqual(ranges("İx", "i"), []);
});
test("replacement slices use the original UTF-16 offsets", () => {
	const source = "İx";
	const [match] = matches(source, "X");
	assert.equal(source.slice(match.start, match.end), "x");
	assert.equal(`${source.slice(0, match.start)}y${source.slice(match.end)}`, "İy");
});
