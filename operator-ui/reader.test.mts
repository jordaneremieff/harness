import assert from "node:assert/strict";
import { it } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { setKeybindings, KeybindingsManager, TUI_KEYBINDINGS } from "@earendil-works/pi-tui";
import { initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { HitMap } from "./hits.ts";
import { layoutText, Reader } from "./reader.ts";

initTheme("dark");
setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS));

const theme = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as Theme;

const lines = (count: number) => Array.from({ length: count }, (_, index) => `line ${index + 1}`);

function page(reader: Reader, height: number, width = 30) {
	const hits = new HitMap();
	hits.begin(width, height);
	// The last column is the scrollbar track or thumb; the text is everything before it.
	const rows = reader.render(width, height, theme, hits, 0, 0).map((row) => stripVTControlCharacters(row).replace(/[\u2503\u2502]$/u, "").trimEnd());
	return { rows, hits };
}

it("setContent with the same key keeps the reading offset", () => {
	const reader = new Reader();
	reader.setContent(lines(10), "record");
	page(reader, 3);
	reader.scroll(4);
	assert.equal(reader.position.first, 5);
	reader.setContent(lines(10), "record");
	const after = page(reader, 3);
	assert.equal(reader.position.first, 5);
	assert.deepEqual(after.rows.map((row) => row.trim()), ["line 5", "line 6", "line 7"]);
});

it("setContent with a new key starts at the top", () => {
	const reader = new Reader();
	reader.setContent(lines(10), "first");
	page(reader, 3);
	reader.scroll(6);
	assert.equal(reader.position.first, 7);
	reader.setContent(lines(6), "second");
	const after = page(reader, 3);
	assert.equal(reader.position.first, 1);
	assert.deepEqual(after.rows.map((row) => row.trim()), ["line 1", "line 2", "line 3"]);
});

it("content without a key always starts at the top", () => {
	const reader = new Reader();
	reader.setContent(lines(8));
	page(reader, 2);
	reader.scroll(3);
	reader.setContent(lines(8));
	page(reader, 2);
	assert.equal(reader.position.first, 1);
});

it("the offset never runs past the last page", () => {
	const reader = new Reader();
	reader.setContent(lines(5), "record");
	page(reader, 3);
	reader.scroll(99);
	assert.equal(reader.position.first, 3);
	reader.scroll(-99);
	assert.equal(reader.position.first, 1);
});

it("the wheel scrolls the reader", () => {
	const reader = new Reader();
	reader.setContent(lines(8), "record");
	const first = page(reader, 3);
	assert.deepEqual(first.hits.handle({ type: "wheel", button: "none", x: 0, y: 1, screenX: 0, screenY: 1, width: 30, height: 3, shift: false, alt: false, ctrl: false, wheelDelta: 2 }), { handled: true, render: true });
	assert.equal(reader.position.first, 3);
});

it("page keys scroll by a page and home returns to the top", () => {
	const reader = new Reader();
	reader.setContent(lines(12), "record");
	page(reader, 4);
	reader.handleInput("\x1b[6~");
	assert.equal(reader.position.first, 4, "a page keeps one line of the previous page in view");
	reader.handleInput("\x1b[H");
	assert.equal(reader.position.first, 1);
});

it("long text is wrapped to the given width", () => {
	const reader = new Reader();
	reader.setContent("aaa bbb ccc ddd", "record");
	const wide = page(reader, 4, 40);
	assert.equal(wide.rows[0]?.trim(), "aaa bbb ccc ddd");
	reader.setContent("aaa bbb ccc ddd", "record");
	const narrow = page(reader, 4, 7);
	assert.equal(narrow.rows[0]?.trim(), "aaa bbb");
	assert.equal(narrow.rows[1]?.trim(), "ccc ddd");
});

it("equal content at an equal width keeps its layout, and a different key still starts at the top", () => {
	const first = layoutText(undefined, "alpha beta gamma", 8);
	assert.ok(first.layout);
	const again = layoutText(first.layout, `alpha beta ${["gamma"].join("")}`, 8);
	assert.equal(again.layout, first.layout, "equal strings reuse the retained layout");
	assert.equal(again.lines, first.layout.lines);

	const resized = layoutText(first.layout, "alpha beta gamma", 12);
	assert.notEqual(resized.layout, first.layout, "a different width rebuilds the layout");
	const changed = layoutText(first.layout, "alpha beta delta", 8);
	assert.notEqual(changed.layout, first.layout, "different text rebuilds the layout");

	const reader = new Reader();
	reader.setContent("one\ntwo\nthree\nfour\nfive", "record");
	page(reader, 2);
	reader.scroll(2);
	assert.equal(reader.position.first, 3);
	reader.setContent("one\ntwo\nthree\nfour\nfive", "record");
	page(reader, 2);
	assert.equal(reader.position.first, 3, "the same key keeps the position with the reused layout");
	reader.setContent("six\nseven\neight\nnine\nten", "next");
	const after = page(reader, 2);
	assert.equal(reader.position.first, 1, "the key, not the content, decides the scroll reset");
	assert.deepEqual(after.rows.map((row) => row.trim()), ["six", "seven"]);
});

it("retains no layout beyond the input and line bounds", () => {
	const long = "x".repeat(1_048_577);
	assert.equal(layoutText(undefined, long, 10).layout, undefined, "input above 1 Mi UTF-16 units is not retained");
	assert.ok(layoutText(undefined, "x".repeat(1_048_576), 1024).layout, "input at the bound is retained");
	const manyLines = "\n".repeat(32_768);
	assert.equal(layoutText(undefined, manyLines, 80).layout, undefined, "more than 32,768 display lines is not retained");
	assert.ok(layoutText(undefined, "\n".repeat(32_767), 80).layout, "32,768 display lines is retained");
});

it("array and callback content is laid out on every render", () => {
	let supplier = 0;
	const reader = new Reader();
	reader.setContent((width) => {
		supplier += 1;
		return [`${width}`];
	}, "dynamic");
	assert.equal(page(reader, 1, 20).rows[0]?.trim(), "19");
	assert.equal(page(reader, 1, 20).rows[0]?.trim(), "19", "a callback supplier is read again with the new width");
	assert.equal(supplier, 2);
	reader.setContent(["plain", "array"], "array");
	assert.deepEqual(page(reader, 2, 20).rows.map((row) => row.trim()), ["plain", "array"]);
});
