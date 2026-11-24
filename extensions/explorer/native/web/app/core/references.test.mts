import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { test } from "node:test";
import { runInNewContext } from "node:vm";

const window = { explorer: {} } as Window;
runInNewContext(stripTypeScriptTypes(readFileSync(new URL("./references.ts", import.meta.url), "utf8")), { window });
const { find, lineLabel } = window.explorer.references;
const refs = (text: string) =>
	JSON.parse(JSON.stringify(find(text))).map((item: ExplorerReferenceSpan) => ({
		text: text.slice(item.start, item.end),
		ref: item.ref,
	}));

test("links file locations written with a colon or a line fragment", () => {
	assert.deepEqual(refs("See src/router.ts:12 and lib/a.go:3–9, also docs/guide.md#L4-L7."), [
		{ text: "src/router.ts:12", ref: { kind: "lines", path: "src/router.ts", start: 12, end: 12 } },
		{ text: "lib/a.go:3–9", ref: { kind: "lines", path: "lib/a.go", start: 3, end: 9 } },
		{ text: "docs/guide.md#L4-L7", ref: { kind: "lines", path: "docs/guide.md", start: 4, end: 7 } },
	]);
	assert.deepEqual(refs("router.ts:40-41"), [
		{ text: "router.ts:40-41", ref: { kind: "lines", path: "router.ts", start: 40, end: 41 } },
	]);
});

test("links line spans of the current file in prose and short forms", () => {
	assert.deepEqual(refs("Lines 4 to 8 call it; line 12 too; L3-L5 and L9."), [
		{ text: "Lines 4 to 8", ref: { kind: "lines", start: 4, end: 8 } },
		{ text: "line 12", ref: { kind: "lines", start: 12, end: 12 } },
		{ text: "L3-L5", ref: { kind: "lines", start: 3, end: 5 } },
		{ text: "L9", ref: { kind: "lines", start: 9, end: 9 } },
	]);
});

test("links commits and two-dot ranges that mix digits and letters", () => {
	assert.deepEqual(refs("Fixed in 3b59add; compare 1a2b3c4d..9f8e7d6c."), [
		{ text: "3b59add", ref: { kind: "commit", commit: "3b59add" } },
		{ text: "1a2b3c4d..9f8e7d6c", ref: { kind: "range", base: "1a2b3c4d", head: "9f8e7d6c" } },
	]);
});

test("leaves numbers, words, versions, times and URLs alone", () => {
	for (const text of [
		"1234567 retries",
		"deadbeef",
		"version 1.2.3:4",
		"at 10:30",
		"https://example.com/src/a.ts:12",
		"node.js",
		"../outside.ts:3",
		".git/config:1",
		"lines 9 to 3",
		"Line 0",
	])
		assert.deepEqual(refs(text), [], text);
});

test("links a bare path only when it has a folder and an extension", () => {
	assert.deepEqual(refs("Open src/retry/policy.ts or README.md"), [
		{ text: "src/retry/policy.ts", ref: { kind: "file", path: "src/retry/policy.ts" } },
	]);
});

test("labels line spans compactly", () => {
	assert.equal(lineLabel(4, 4), "L4");
	assert.equal(lineLabel(4, 9), "L4–9");
});
