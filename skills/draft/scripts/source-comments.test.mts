// Tests for the draft prose meter. The command line entry is meter.mts (run it with --help).
import assert from "node:assert/strict";
import test from "node:test";
import { cleanSourceComments, sourceComments } from "./source-comments.mts";

test("comments are copied and code, strings and regexes are blank", () => {
	const source = [
		"const url = 'http://example.org'; // trailing note",
		'const text = "// not a comment";',
		"const tpl = `a $" + "{'/* nope */'} b`;",
		"const re = /\\/\\/ also not/;",
		"/** Block comment. */",
		"function f() { return 1 / 2; }",
	].join("\n");
	const comments = sourceComments(source);
	assert.ok(comments.includes("trailing note"));
	assert.ok(comments.includes("Block comment."));
	for (const gone of ["not a comment", "nope", "also not", "example.org"]) assert.ok(!comments.includes(gone), gone);
	assert.equal(comments.length, source.length);
});

test("nested template expressions return to the template text", () => {
	const source = "const a = `x $" + "{`inner // not` + y} // still template`;\n// real\n";
	const comments = sourceComments(source);
	assert.ok(!comments.includes("not"));
	assert.ok(!comments.includes("still template"));
	assert.ok(comments.includes("real"));
});

test("division after a name is not a regex start", () => {
	const comments = sourceComments("const a = b / c; // note after division\n");
	assert.ok(comments.includes("note after division"));
});

test("pragma comments and the shebang are skipped", () => {
	const comments = sourceComments("#!/usr/bin/env node\n// biome-ignore lint: reason\n/* eslint-disable */\n// kept\n");
	assert.ok(!comments.includes("biome"));
	assert.ok(!comments.includes("eslint"));
	assert.ok(comments.includes("kept"));
});

test("leading stars of block comment lines are blank", () => {
	const comments = sourceComments("/**\n * First line.\n * Second line.\n */\n");
	assert.ok(!comments.includes("*"));
	assert.ok(comments.includes("First line."));
});

test("jsdoc tags, type braces, parameter names and examples are blank", () => {
	const cleaned = cleanSourceComments(" Adds.\n @param {number} a the first\n @returns {number} the sum\n @example\n add(1, 2);\n @see other\n");
	assert.ok(cleaned.includes("Adds."));
	assert.ok(cleaned.includes("the first"));
	assert.ok(!cleaned.includes("add(1"));
	assert.ok(!cleaned.includes("@param"));
	assert.ok(!cleaned.includes("number"));
});
