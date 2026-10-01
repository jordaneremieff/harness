import assert from "node:assert/strict";
import { it } from "node:test";
import { initTheme, type KeybindingsManager, type Theme } from "@earendil-works/pi-coding-agent";
import {
	CURSOR_MARKER,
	KeybindingsManager as Keys,
	setKeybindings,
	type TUI,
	TUI_KEYBINDINGS,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { AgentMessageEditor } from "./dashboard-composer.ts";

initTheme("dark");
const theme = { fg: (_color: string, text: string) => text } as Theme;

function composer(rows = 30): { editor: AgentMessageEditor; submitted: string[] } {
	const submitted: string[] = [];
	const editor = new AgentMessageEditor({ terminal: { rows }, requestRender() {} } as unknown as TUI, theme, (text) =>
		submitted.push(text),
	);
	return { editor, submitted };
}
const manyLines = (count: number, prefix: string) =>
	Array.from({ length: count }, (_, index) => `${prefix} ${index}`).join("\n");

it("submits the full multiline draft through the callback and clears content", () => {
	const { editor, submitted } = composer();
	editor.setText("line one\nline two");
	editor.handleInput("\r");
	assert.deepEqual(submitted, ["line one\nline two"]);
	assert.equal(editor.getText(), "");
});

it("inserts newlines without submitting", () => {
	const { editor, submitted } = composer();
	editor.handleInput("\x1b\r");
	editor.handleInput("\n");
	assert.equal(editor.getText(), "\n\n");
	assert.deepEqual(submitted, []);
});

it("preserves Unicode text through restore, typing, and submit", () => {
	const { editor, submitted } = composer();
	editor.setText("héllo 🧭 — café");
	assert.equal(editor.getText(), "héllo 🧭 — café");
	editor.handleInput("\r");
	assert.deepEqual(submitted, ["héllo 🧭 — café"]);
	const typed = composer();
	typed.editor.handleInput("a");
	typed.editor.handleInput("🧭");
	assert.equal(typed.editor.getText(), "a🧭");
});

it("keeps draft text until an explicit submit", () => {
	const { editor, submitted } = composer();
	editor.setText("draft A");
	editor.handleInput("\x1b");
	assert.equal(editor.getText(), "draft A");
	editor.setText("draft B");
	assert.equal(editor.getText(), "draft B");
	assert.deepEqual(submitted, []);
});

it("keeps the native backslash-enter newline workaround", () => {
	const { editor, submitted } = composer();
	editor.setText("end\\");
	editor.handleInput("\r");
	assert.deepEqual(submitted, []);
	assert.equal(editor.getText(), "end\n");
});

it("follows host-installed keybindings for submit and newline through the native editor", () => {
	const keys = new Keys({
		...TUI_KEYBINDINGS,
		"tui.input.submit": { defaultKeys: ["ctrl+s"], description: "Submit" },
		"tui.input.newLine": { defaultKeys: ["ctrl+g"], description: "New line" },
	}) as KeybindingsManager;
	setKeybindings(keys);
	try {
		const { editor, submitted } = composer();
		editor.setText("remapped");
		editor.handleInput("\r");
		assert.deepEqual(submitted, []);
		assert.equal(editor.getText(), "remapped");
		editor.handleInput("\x13");
		assert.deepEqual(submitted, ["remapped"]);
		editor.setText("next");
		editor.handleInput("\x07");
		assert.equal(editor.getText(), "next\n");
		assert.deepEqual(submitted, ["remapped"]);
	} finally {
		setKeybindings(new Keys(TUI_KEYBINDINGS));
	}
});

it("reports an empty submit as an empty string", () => {
	const { editor, submitted } = composer();
	editor.handleInput("\r");
	assert.deepEqual(submitted, [""]);
});

it("bounds rendered height to the native visible cap and terminal width", () => {
	const tall = composer(30);
	tall.editor.setText(manyLines(20, "line"));
	const lines = tall.editor.render(60);
	assert.equal(lines.length, 9 + 2);
	assert.ok(lines.every((line) => visibleWidth(line) <= 60));
	const short = composer(8);
	short.editor.setText(manyLines(12, "row"));
	assert.equal(short.editor.render(40).length, 5 + 2);
});

it("wraps long draft lines within narrow widths", () => {
	const { editor } = composer(30);
	editor.setText(`${"word ".repeat(40)}`);
	for (const width of [60, 24, 12]) {
		const lines = editor.render(width);
		assert.ok(
			lines.every((line) => visibleWidth(line) <= width),
			`width ${width}`,
		);
		assert.ok(lines.length <= 9 + 2);
	}
});

it("expands a native paste marker to the full payload for reading and submission", () => {
	const { editor, submitted } = composer(30);
	const payload = Array.from({ length: 12 }, (_, index) => `héllo 🧭 ligne ${index} — ok`).join("\n");
	editor.handleInput(`\x1b[200~${payload}\x1b[201~`);
	assert.ok(editor.render(60).some((line) => line.includes("[paste #1")));
	assert.equal(editor.getText(), payload);
	editor.handleInput("\r");
	assert.deepEqual(submitted, [payload]);
});

it("forwards focus and emits the native cursor marker only while focused", () => {
	const { editor } = composer(30);
	editor.setText("abc");
	editor.focused = true;
	assert.ok(editor.render(40).some((line) => line.includes(CURSOR_MARKER)));
	editor.focused = false;
	assert.ok(editor.render(40).every((line) => !line.includes(CURSOR_MARKER)));
});
