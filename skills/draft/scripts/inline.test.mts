// Tests for the draft prose meter. The command line entry is meter.mts (run it with --help).
import assert from "node:assert/strict";
import test from "node:test";
import { type InlineOut, inlinePass } from "./inline.mts";
import { makeViews } from "./views.mts";

function scan(text: string, links = true): { p: string; l: string; out: InlineOut } {
	const v = makeViews(text);
	const out: InlineOut = { links: [], inlineCode: 0 };
	inlinePass(text, 0, text.length, { links, tags: true, emphasis: true }, v, out);
	return { p: v.P.join(""), l: v.L.join(""), out };
}

test("code spans use matching backtick runs and may hold backticks", () => {
	const { p, out } = scan("a ``x ` y`` b `z` c");
	assert.equal(out.inlineCode, 2);
	assert.equal(p.replace(/\s+/g, " "), "a b c");
});

test("an unmatched backtick stays as text", () => {
	const { p, out } = scan("a ` b");
	assert.equal(out.inlineCode, 0);
	assert.ok(p.includes("b"));
});

test("escaped brackets are not links", () => {
	const { p } = scan("a \\[x\\](y) b");
	assert.ok(p.includes("(y)"));
});

test("link destinations may contain balanced parentheses", () => {
	const { p, out } = scan("[t](https://a.example/f_(g)) end");
	assert.equal(p.trim().replace(/\s+/g, " "), "t end");
	assert.equal(out.links.length, 0);
});

test("footnote markers and shortcut references are left alone", () => {
	const { p } = scan("note[^1] and [plain] text");
	assert.ok(p.includes("[^1]"));
	assert.ok(p.includes("[plain]"));
});

test("emphasis markers are blank but arithmetic stars stay", () => {
	const { p } = scan("**bold** and a * b");
	assert.ok(!p.includes("**"));
	assert.ok(p.includes("a * b"));
});

test("link scanning can be switched off", () => {
	const { p } = scan("[t](https://a.example/x)", false);
	assert.ok(p.includes("["));
});
