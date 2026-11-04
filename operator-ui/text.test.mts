import assert from "node:assert/strict";
import { it } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { visibleWidth } from "@earendil-works/pi-tui";
import { fitLine, plainLine, wrap } from "./text.ts";

it("plainLine removes control characters and collapses whitespace", () => {
	assert.equal(plainLine("clean text"), "clean text");
	assert.equal(plainLine("a\u001b[31mb\u001b[0m c"), "a b c");
	assert.equal(plainLine("a  b\t\tc   d"), "a b c d");
	assert.equal(plainLine("  padded  "), "padded");
	assert.equal(plainLine("zero\u0000byte\u007f"), "zero byte");
	assert.equal(plainLine(""), "");
});

it("fitLine pads short text to the exact visible width", () => {
	assert.equal(fitLine("ab", 5), "ab   ");
	assert.equal(fitLine("", 3), "   ");
	assert.equal(visibleWidth(fitLine("abc", 10)), 10);
	assert.equal(fitLine("abc", 0), "");
});

it("fitLine truncates long text to the exact visible width", () => {
	const line = fitLine("hello world", 6);
	assert.equal(visibleWidth(line), 6);
	assert.equal(stripVTControlCharacters(line).startsWith("hel"), true);
	assert.equal(stripVTControlCharacters(line).endsWith("..."), true);
	assert.equal(fitLine("hello world", 11), "hello world");
});

it("fitLine keeps ANSI styling intact and pads outside the styling", () => {
	const styled = "\u001b[31mred\u001b[0m";
	const line = fitLine(styled, 8);
	assert.equal(line, `${styled}     `);
	assert.equal(visibleWidth(line), 8);
	const colour = "\u001b[31mcrimson text\u001b[0m";
	const cut = fitLine(colour, 5);
	assert.equal(visibleWidth(cut), 5);
	assert.equal(stripVTControlCharacters(cut), "cr...", "a truncated line ends with an ellipsis inside the width");
	assert.ok(cut.startsWith("\u001b[31m"), "the styling of the kept text stays");
});

it("wrap respects the width and keeps every word", () => {
	assert.deepEqual(wrap("aa bb cc", 5), ["aa bb", "cc"]);
	assert.deepEqual(wrap("", 10), [""]);
	assert.deepEqual(wrap("one", 3), ["one"]);
	const lines = wrap("the quick brown fox jumps", 7);
	for (const line of lines) assert.ok(visibleWidth(line) <= 7, `line too wide: ${line}`);
	assert.equal(lines.join(" "), "the quick brown fox jumps");
});

it("wrap carries ANSI styling across the wrapped lines", () => {
	const lines = wrap("\u001b[31mred text\x1b[0m", 3);
	for (const line of lines) {
		assert.ok(visibleWidth(line) <= 3, `line too wide: ${JSON.stringify(line)}`);
		assert.ok(line.startsWith("\u001b[31m"), `a wrapped line keeps the colour: ${JSON.stringify(line)}`);
	}
	assert.equal(lines.map((line) => stripVTControlCharacters(line)).join(""), "redtext");
});
