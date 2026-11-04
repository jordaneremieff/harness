import assert from "node:assert/strict";
import { it } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { setKeybindings, KeybindingsManager, TUI_KEYBINDINGS } from "@earendil-works/pi-tui";
import { initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { TextArea, TextField } from "./field.ts";

initTheme("dark");
setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS));

const theme = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as Theme;

const cursor = /\u001b_pi:[a-z/]*\u0007/g;
const plain = (line: string) => stripVTControlCharacters(line.replace(cursor, ""));

it("a text field renders its value with no prompt prefix", () => {
	const field = new TextField("Name", "Grace");
	const line = plain(field.render(24, theme, 10));
	assert.ok(line.startsWith("Name"));
	assert.ok(line.includes("Grace"));
	assert.ok(!line.includes(">"), `unexpected prompt prefix in ${line}`);
	assert.equal(line.trim(), "Name      Grace");
});

it("an empty unfocused text field shows its placeholder", () => {
	const field = new TextField("Name", "");
	const line = plain(field.render(24, theme, 10, "type a name"));
	assert.ok(line.includes("type a name"));
});

it("a text field reports every value change", () => {
	const changes: string[] = [];
	const field = new TextField("Name", "", (value) => changes.push(value));
	field.handleInput("h");
	field.handleInput("i");
	assert.equal(field.value, "hi");
	assert.deepEqual(changes, ["h", "hi"]);
	field.handleInput("\r");
	assert.equal(field.value, "hi");
	assert.deepEqual(changes, ["h", "hi"]);
	field.handleInput("\u007f");
	assert.equal(field.value, "h");
	assert.deepEqual(changes, ["h", "hi", "h"]);
});

it("typing moves the cursor instead of appending at the start", () => {
	const field = new TextField("Name", "");
	field.handleInput("ab");
	field.handleInput("\x1b[D");
	field.handleInput("x");
	assert.equal(field.value, "axb");
});

it("a text area inserts a new line on Enter", () => {
	const changes: string[] = [];
	const area = new TextArea("Body", theme, () => {}, "first", 4, (value) => changes.push(value));
	area.handleInput("\r");
	area.handleInput("second");
	assert.equal(area.value, "first\nsecond");
	assert.deepEqual(changes, ["first\n", "first\nsecond"]);
});

it("a text area renders its label above its rows", () => {
	const area = new TextArea("Body", theme, () => {}, "note", 2);
	const rows = area.render(20, theme).map(plain);
	assert.equal(rows[0]?.trim(), "Body");
	assert.ok(rows[1]?.includes("note"));
	assert.equal(rows.length, 3);
});
