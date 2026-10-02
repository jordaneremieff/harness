import assert from "node:assert/strict";
import { it } from "node:test";
import { initTheme, type KeybindingsManager, type Theme } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, KeybindingsManager as Keys, setKeybindings, TUI_KEYBINDINGS, type TUI, visibleWidth } from "@earendil-works/pi-tui";
import { PeerComposer } from "./peer-composer.ts";

initTheme("dark");
const theme = { fg: (_color: string, text: string) => text } as Theme;
// The app supplies its own keybinding table; the test supplies the pi-tui table with the app interrupt binding.
const keys = new Keys({ ...TUI_KEYBINDINGS, "app.interrupt": { defaultKeys: "escape", description: "Cancel or abort" }, "app.exit": { defaultKeys: "ctrl+d", description: "Exit" } }) as KeybindingsManager;

function composer(rows = 30) {
	const submitted: string[] = [];
	const escapes: number[] = [];
	const peer = new PeerComposer({
		tui: { terminal: { rows }, requestRender() {} } as unknown as TUI,
		theme,
		keys,
		onSubmit: (text) => submitted.push(text),
		onEscape: () => escapes.push(1),
	});
	return { peer, submitted, escapes };
}

it("submits through the callback and clears the native editor", () => {
	setKeybindings(keys);
	const { peer, submitted } = composer();
	peer.setText("line one\nline two");
	peer.handleInput("\r");
	assert.deepEqual(submitted, ["line one\nline two"]);
	assert.equal(peer.getText(), "");
});

it("routes escape to the window and keeps the draft", () => {
	setKeybindings(keys);
	const { peer, submitted, escapes } = composer();
	peer.setText("draft A");
	peer.handleInput("\x1b");
	assert.equal(peer.getText(), "draft A");
	assert.deepEqual(escapes, [1]);
	assert.deepEqual(submitted, []);
});

it("keeps exactly one caret for the focused composer", () => {
	setKeybindings(keys);
	const first = composer();
	const second = composer();
	first.peer.setText("left");
	second.peer.setText("right");
	first.peer.focused = true;
	second.peer.focused = false;
	assert.ok(first.peer.render(40).some((line) => line.includes(CURSOR_MARKER)));
	assert.ok(second.peer.render(40).every((line) => !line.includes(CURSOR_MARKER)));
	first.peer.focused = false;
	second.peer.focused = true;
	assert.ok(second.peer.render(40).some((line) => line.includes(CURSOR_MARKER)));
	assert.ok(first.peer.render(40).every((line) => !line.includes(CURSOR_MARKER)));
});

it("wraps long drafts inside the pane width", () => {
	setKeybindings(keys);
	const { peer } = composer();
	peer.setText("word ".repeat(60));
	for (const width of [80, 40, 20]) {
		assert.ok(peer.render(width).every((line) => visibleWidth(line) <= width), `width ${width}`);
	}
});
