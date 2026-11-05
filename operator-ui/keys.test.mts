import assert from "node:assert/strict";
import { it } from "node:test";
import { isKittyProtocolActive, setKittyProtocolActive } from "@earendil-works/pi-tui";
import { keyInput, keyMatches, keyText, keysText } from "./keys.ts";

it("keyText shortens pi-tui key ids to the footer's words", () => {
	assert.equal(keyText("escape"), "esc");
	assert.equal(keyText("pageUp"), "pgup");
	assert.equal(keyText("pageDown"), "pgdn");
	assert.equal(keyText("up"), "↑");
	assert.equal(keyText("down"), "↓");
	assert.equal(keyText("left"), "←");
	assert.equal(keyText("right"), "→");
	assert.equal(keyText("enter"), "enter");
	assert.equal(keyText("ctrl+o"), "ctrl+o");
	assert.equal(keyText("shift+tab"), "shift+tab");
	assert.equal(keyText("/"), "/");
});

it("keysText runs arrows together and joins other keys with a slash", () => {
	assert.equal(keysText(["up", "down"]), "↑↓");
	assert.equal(keysText(["left", "right"]), "←→");
	assert.equal(keysText(["pageUp", "pageDown"]), "pgup/pgdn");
	assert.equal(keysText(["shift+enter", "ctrl+j"]), "shift+enter/ctrl+j");
	assert.equal(keysText(["m", "tab"]), "m/tab");
	assert.equal(keysText(["enter"]), "enter");
});

it("keyMatches accepts the legacy input and the Kitty form of one printable key", () => {
	assert.equal(keyMatches("a", "a"), true);
	assert.equal(keyMatches("\u001b[97u", "a"), true, "Kitty CSI-u for a printable key is that key");
	assert.equal(keyMatches("b", "a"), false);
	assert.equal(keyMatches("\u001b[A", "up"), true);
	assert.equal(keyMatches("\u001b[B", "up"), false);
	assert.equal(keyMatches("\r", "enter"), true);
	assert.equal(keyMatches("\u001b", "escape"), true);
});

it("keyInput sends exactly the key a click stands for", () => {
	assert.equal(keyInput("up"), "\u001b[A");
	assert.equal(keyInput("down"), "\u001b[B");
	assert.equal(keyInput("pageDown"), "\u001b[6~");
	assert.equal(keyInput("enter"), "\r");
	assert.equal(keyInput("tab"), "\t");
	assert.equal(keyInput("shift+tab"), "\u001b[Z");
	assert.equal(keyInput("escape"), "\u001b");
	assert.equal(keyInput("ctrl+j"), "\n");
	assert.equal(keyInput("a"), "a");
	assert.equal(keyInput("alt+enter"), "\u001b[13;3u");
	assert.equal(keyInput("f13"), undefined, "a key with no known input sends nothing");
	assert.equal(keyInput("alt+escape"), undefined, "no form of a modified Escape is accepted");
	assert.equal(keyInput("alt+clear"), undefined, "no form of Alt+Clear is accepted");
});

/** The key syntax Pi accepts: letters, digits, symbols, special and function keys, and modifier combinations. */
const VOCABULARY: readonly string[] = [
	..."abcdefghijklmnopqrstuvwxyz".split(""),
	..."0123456789".split(""),
	..."`-=[]\\;',./!@#$%^&*()_+|~{}:<>?".split(""),
	"escape",
	"esc",
	"enter",
	"return",
	"tab",
	"space",
	"backspace",
	"delete",
	"insert",
	"clear",
	"home",
	"end",
	"pageUp",
	"pageDown",
	"up",
	"down",
	"left",
	"right",
	...Array.from({ length: 12 }, (_, index) => `f${index + 1}`),
	...["a", "1", "/", "enter", "tab", "space", "backspace", "up", "pageUp", "f1", "home", "delete"].flatMap((base) =>
		[
			"shift",
			"alt",
			"ctrl",
			"super",
			"ctrl+shift",
			"ctrl+alt",
			"shift+alt",
			"ctrl+super",
			"alt+super",
			"shift+super",
			"ctrl+shift+alt",
			"ctrl+shift+super",
		].map((modifier) => `${modifier}+${base}`),
	),
];

it("every key of the vocabulary a click can name matches its own input in both protocol states", () => {
	const before = isKittyProtocolActive();
	try {
		for (const kitty of [false, true]) {
			setKittyProtocolActive(kitty);
			for (const key of VOCABULARY) {
				const data = keyInput(key);
				assert.notEqual(data, undefined, `${key} has no input with kitty=${kitty}`);
				assert.equal(keyMatches(data as string, key), true, `${key} does not match ${JSON.stringify(data)} with kitty=${kitty}`);
			}
		}
	} finally {
		setKittyProtocolActive(before);
	}
});
