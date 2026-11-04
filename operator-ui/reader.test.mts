import assert from "node:assert/strict";
import { it } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { setKeybindings, KeybindingsManager, TUI_KEYBINDINGS } from "@earendil-works/pi-tui";
import { initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { HitMap } from "./hits.ts";
import { Reader } from "./reader.ts";

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
