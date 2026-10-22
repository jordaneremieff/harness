// Tests for the draft prose meter. The command line entry is meter.mts (run it with --help).
import assert from "node:assert/strict";
import test from "node:test";
import { blank, blankAll, blankText, indentOf, makeViews, trimUrl } from "./scripts/views.mts";

test("blank keeps line breaks and length", () => {
	const view = "ab\ncd".split("");
	blank(view, 0, 5);
	assert.equal(view.join(""), "  \n  ");
});

test("blankText leaves the raw view, blankAll clears all three", () => {
	const v = makeViews("abc");
	blankText(v, 0, 1);
	assert.equal(v.R.join(""), "abc");
	blankAll(v, 1, 3);
	assert.equal(v.R.join(""), "a  ");
});

test("indentOf counts spaces and tabs", () => {
	assert.equal(indentOf("  x"), 2);
	assert.equal(indentOf("\tx"), 4);
});

test("trimUrl removes trailing punctuation and unmatched brackets only", () => {
	assert.equal(trimUrl("https://a.example/x)."), "https://a.example/x");
	assert.equal(trimUrl("https://a.example/f_(g)"), "https://a.example/f_(g)");
	assert.equal(trimUrl("https://a.example/x**"), "https://a.example/x");
});
