// Tests for the draft prose meter. The command line entry is meter.mts (run it with --help).
import assert from "node:assert/strict";
import test from "node:test";
import { type BlockOpts, runBlocks } from "./scripts/blocks.mts";
import { makeViews } from "./scripts/views.mts";

const ALL: BlockOpts = {
	fences: true,
	indented: true,
	front: true,
	comments: true,
	links: true,
	tags: true,
	headings: true,
	lists: true,
	tables: true,
	quotes: true,
	emphasis: true,
};

function blocks(text: string, opts: BlockOpts = ALL) {
	const starts = [0];
	for (let i = 0; i < text.length; i++) if (text[i] === "\n") starts.push(i + 1);
	const v = makeViews(text);
	return { result: runBlocks(text, starts, opts, v), prose: v.P.join("") };
}

test("line kinds follow the block structure", () => {
	const { result } = blocks("# H\n\npara\n\n- item\n\n> quote\n\n---\n\n```\ncode\n```\n");
	assert.deepEqual(
		result.lines.map((line) => line.kind),
		["heading", "blank", "para", "blank", "list", "blank", "quote", "blank", "rule", "blank", "code", "code", "code", "blank"],
	);
});

test("a fence opened inside a list item may be indented", () => {
	const { result, prose } = blocks("- item\n\n      ```\n      hidden\n      ```\n\nafter\n");
	assert.equal(result.fenceCount, 1);
	assert.ok(!prose.includes("hidden"));
	assert.ok(prose.includes("after"));
});

test("a backtick fence info string may not hold a backtick", () => {
	const { result } = blocks("``` not `a fence`\ntext\n");
	assert.equal(result.fenceCount, 0);
});

test("front matter needs a closing marker to count", () => {
	assert.equal(blocks("---\ntitle: x\n").result.lines[0]?.kind, "rule");
	assert.equal(blocks("---\ntitle: x\n---\nbody\n").result.lines[0]?.kind, "meta");
});

test("a multi-line comment hides its lines and ends on the closing marker", () => {
	const { prose, result } = blocks("a <!-- start\nmiddle\nend --> b\n");
	assert.ok(!prose.includes("middle"));
	assert.ok(prose.includes("a"));
	assert.ok(prose.includes("b"));
	assert.equal(result.lines[1]?.kind, "meta");
});

test("table rows are units and separator rows are not", () => {
	const { result } = blocks("| a | b |\n|---|---|\n| c | d |\n");
	assert.deepEqual(
		result.units.map((unit) => unit.kind),
		["table", "table"],
	);
});

test("reference definitions are not prose", () => {
	const { prose } = blocks("[ref]: https://example.org/x\ntext\n");
	assert.ok(!prose.includes("example.org"));
	assert.ok(prose.includes("text"));
});

test("a thematic break made of list markers does not open a list", () => {
	const { result } = blocks("- - -\n\n    code after\n");
	assert.equal(result.lines[0]?.kind, "rule");
	assert.equal(result.lines[2]?.kind, "code");
});

test("plain options leave markdown markers alone except list markers", () => {
	const plain: BlockOpts = { ...ALL, fences: false, indented: false, front: false, comments: false, links: false, tags: false, headings: false, tables: false, quotes: false, emphasis: false };
	const { prose } = blocks("# not heading\n- item\n", plain);
	assert.ok(prose.includes("# not heading"));
	assert.ok(!prose.includes("- item"));
});
