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

for (const { name, value, expected } of [
	{ name: "embedded end delimiter", value: "before\u001b[201~after", expected: "beforeafter" },
	{ name: "embedded start delimiter", value: "before\u001b[200~after", expected: "beforeafter" },
	{ name: "repeated delimiters", value: "a\u001b[200~\u001b[201~b\u001b[201~\u001b[200~c", expected: "abc" },
	{ name: "boundary delimiters", value: "\u001b[200~value\u001b[201~", expected: "value" },
	{ name: "terminal sequences", value: "\u001b[31mred\u001b[0m\u001b[2C\u001b]0;title\u0007text", expected: "redtext" },
	{ name: "control-only input", value: "\u0000\u0001\u0007\u0008\u000b\u000c\u000e\u001b\u001f\u007f\u0080\u009f", expected: "" },
	{ name: "empty input", value: "", expected: "" },
	{ name: "line breaks and tabs", value: "a\r\nb\rc\nd\te", expected: "abcd    e" },
	{ name: "spaces and Unicode", value: "  Καλημέρα 👩🏽‍💻 e\u0301  ", expected: "  Καλημέρα 👩🏽‍💻 e\u0301  " },
]) {
	it(`programmatic field replacement normalises ${name} and places the cursor last`, () => {
		const field = new TextField("Name", value);
		assert.equal(field.value, expected);
		field.handleInput("!");
		assert.equal(field.value, `${expected}!`);
		field.handleInput("\u001b[D");
		field.value = value;
		assert.equal(field.value, expected);
		field.handleInput("!");
		assert.equal(field.value, `${expected}!`);
	});
}

it("programmatic replacement preserves focus and reports no interactive change", () => {
	const changes: string[] = [];
	const field = new TextField("Name", "first\u001b[201~value", (value) => changes.push(value));
	field.focused = true;
	field.value = "next\u001b[200~value";
	assert.equal(field.focused, true);
	assert.deepEqual(changes, []);
	field.handleInput("!");
	assert.equal(field.value, "nextvalue!");
	assert.deepEqual(changes, ["nextvalue!"]);
});

it("interactive paste keeps native whitespace handling and change callbacks", () => {
	const changes: string[] = [];
	const field = new TextField("Name", "", (value) => changes.push(value));
	field.handleInput("\u001b[200~first\r\nsecond\tlast");
	assert.equal(field.value, "");
	assert.deepEqual(changes, []);
	field.handleInput("\u001b[201~");
	assert.equal(field.value, "firstsecond    last");
	assert.deepEqual(changes, ["firstsecond    last"]);
	field.handleInput("!");
	assert.equal(field.value, "firstsecond    last!");
	assert.deepEqual(changes, ["firstsecond    last", "firstsecond    last!"]);
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
