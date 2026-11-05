import { decodeKittyPrintable, type KeyId, matchesKey } from "@earendil-works/pi-tui";

/** Short display names for pi-tui key ids, in the lower-case form of Pi's own key hints. */
const NAMES: Readonly<Record<string, string>> = {
	escape: "esc",
	esc: "esc",
	return: "enter",
	pageUp: "pgup",
	pageDown: "pgdn",
	up: "↑",
	down: "↓",
	left: "←",
	right: "→",
	delete: "del",
};

/** Terminal input for the keys a footer control can send when it is clicked. */
const INPUT: Readonly<Record<string, string>> = {
	up: "\u001b[A",
	down: "\u001b[B",
	right: "\u001b[C",
	left: "\u001b[D",
	home: "\u001b[H",
	end: "\u001b[F",
	pageUp: "\u001b[5~",
	pageDown: "\u001b[6~",
	enter: "\r",
	tab: "\t",
	"shift+tab": "\u001b[Z",
	escape: "\u001b",
	space: " ",
	backspace: "\u007f",
	"shift+enter": "\u001b[13;2u",
};

const single = (key: string) => [...key].length === 1;

/** Display text of one key id: "enter", "esc", "ctrl+o", "pgup", "↑", "/". */
export function keyText(key: string): string {
	const parts = key.split("+");
	const last = parts.pop() ?? key;
	return [...parts, NAMES[last] ?? last].join("+");
}

/** Display text of a control's keys: arrows run together ("↑↓"), other keys join with "/" ("pgup/pgdn"). */
export function keysText(keys: readonly string[]): string {
	const texts = keys.map(keyText);
	return texts.every((text) => /^[↑↓←→]$/u.test(text)) ? texts.join("") : texts.join("/");
}

/**
 * True when the terminal input is the key. One printable character matches itself, also when a
 * terminal with the Kitty keyboard protocol sends it as an escape sequence; other ids match through
 * pi-tui, so legacy and Kitty sequences both count.
 */
export function keyMatches(data: string, key: string): boolean {
	if (single(key)) return (decodeKittyPrintable(data) ?? data) === key;
	return matchesKey(data, key as KeyId);
}

/** The input a key sends, so a click on its footer control delivers exactly that key. */
export function keyInput(key: string): string | undefined {
	const known = INPUT[key];
	if (known !== undefined) return known;
	if (single(key)) return key;
	const ctrl = /^ctrl\+([a-z])$/u.exec(key);
	return ctrl?.[1] ? String.fromCharCode(ctrl[1].charCodeAt(0) - 96) : undefined;
}
