import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { test } from "node:test";
import { runInNewContext } from "node:vm";

const window = { explorer: {} as Pick<ExplorerApp, "editing"> };
runInNewContext(stripTypeScriptTypes(readFileSync(new URL("./editing.ts", import.meta.url), "utf8")), {
	window,
	TextEncoder,
});
const editing = window.explorer.editing;

void test("normalises textarea line breaks and restores the file's dominant ending", () => {
	const crlf = "alpha\r\nbeta\r\n\r\n";
	assert.equal(editing.lineEnding(crlf), "crlf");
	assert.equal(editing.normalise(crlf), "alpha\nbeta\n\n");
	assert.equal(editing.restore(editing.normalise(crlf), "crlf"), crlf);
	assert.equal(editing.lineEnding("alpha\nbeta\n"), "lf");
	assert.equal(editing.lineEnding("alpha\rbeta\r"), "cr");
	assert.equal(editing.restore("alpha\nbeta\n", "cr"), "alpha\rbeta\r");
	assert.equal(editing.lineEnding("alpha\nbeta\r\n"), "lf");
	assert.equal(editing.lineEnding(""), "lf");
});

void test("detects tabs and the usual increase in spaces", () => {
	assert.equal(editing.indentUnit("start\n\tone\n\t\ttwo\n"), "\t");
	assert.equal(editing.indentUnit("start\n    one\n        two\n    three\n"), "    ");
	assert.equal(editing.indentUnit("start\n  one\n    two\n  three\n"), "  ");
	assert.equal(editing.indentUnit("start\n"), "  ");
	assert.equal(editing.nextIndent("text\n\t  word", 12), "\t  ");
});

void test("indents only selected lines and preserves the selection", () => {
	const indent = editing.indentLines("one\ntwo\nthree\n", 1, 8, "  ", false);
	assert.deepEqual({ ...indent }, { from: 0, to: 7, value: "  one\n  two", start: 3, end: 12 });
	const outdent = editing.indentLines("  one\n  two\nthree\n", 3, 12, "  ", true);
	assert.deepEqual({ ...outdent }, { from: 0, to: 11, value: "one\ntwo", start: 1, end: 8 });
	const caret = editing.indentLines("one\n\ttwo", 5, 5, "\t", true);
	assert.deepEqual({ ...caret }, { from: 4, to: 8, value: "two", start: 4, end: 4 });
});

void test("rejects absolute, parent, Git metadata and image paths before create", () => {
	assert.equal(editing.validNewPath("notes/todo.md"), true);
	assert.equal(editing.validNewPath("日本語/café"), true);
	for (const path of ["", "/etc/root", "a//b", "a/../b", "a/./b", "a/.GiT/config", "folder/", "logo.SVG", "c\nd"]) {
		assert.equal(editing.validNewPath(path), false, path);
	}
});
