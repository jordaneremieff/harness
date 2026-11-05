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

/**
 * Terminal input for the keys a footer control can send when it is clicked. Every form is accepted
 * by pi-tui's key matching with and without the Kitty keyboard protocol, so one encoding serves
 * both protocol states.
 */
const INPUT: Readonly<Record<string, string>> = {
	up: "\u001b[A",
	down: "\u001b[B",
	right: "\u001b[C",
	left: "\u001b[D",
	home: "\u001b[H",
	end: "\u001b[F",
	pageUp: "\u001b[5~",
	pageDown: "\u001b[6~",
	insert: "\u001b[2~",
	delete: "\u001b[3~",
	f1: "\u001bOP",
	f2: "\u001bOQ",
	f3: "\u001bOR",
	f4: "\u001bOS",
	f5: "\u001b[15~",
	f6: "\u001b[17~",
	f7: "\u001b[18~",
	f8: "\u001b[19~",
	f9: "\u001b[20~",
	f10: "\u001b[21~",
	f11: "\u001b[23~",
	f12: "\u001b[24~",
	clear: "\u001b[E",
	enter: "\r",
	tab: "\t",
	"shift+tab": "\u001b[Z",
	escape: "\u001b",
	space: " ",
	backspace: "\u007f",
};

/** Modifier bits of a CSI-u sequence, in pi-tui's order. */
const MODIFIERS: Readonly<Record<string, number>> = { shift: 1, alt: 2, ctrl: 4, super: 8 };

/** Base keys a CSI-u sequence can carry: their unicode code points. */
const CODEPOINTS: Readonly<Record<string, number>> = { enter: 13, tab: 9, space: 32, backspace: 127 };

/**
 * Base keys that report their modifier as a sequence parameter instead of a code point: the
 * parameter replaces the `%` placeholder, one above the modifier mask.
 */
const SEQUENCED: Readonly<Record<string, string>> = {
	up: "\u001b[1;%A",
	down: "\u001b[1;%B",
	right: "\u001b[1;%C",
	left: "\u001b[1;%D",
	home: "\u001b[1;%H",
	end: "\u001b[1;%F",
	pageUp: "\u001b[5;%~",
	pageDown: "\u001b[6;%~",
	insert: "\u001b[2;%~",
	delete: "\u001b[3;%~",
	f1: "\u001b[1;%P",
	f2: "\u001b[1;%Q",
	f4: "\u001b[1;%S",
	f3: "\u001b[13;%~",
	f5: "\u001b[15;%~",
	f6: "\u001b[17;%~",
	f7: "\u001b[18;%~",
	f8: "\u001b[19;%~",
	f9: "\u001b[20;%~",
	f10: "\u001b[21;%~",
	f11: "\u001b[23;%~",
	f12: "\u001b[24;%~",
	/** The Clear key reports Shift and Ctrl only through its legacy forms. */
	"shift+clear": "\u001b[e",
	"ctrl+clear": "\u001bOe",
};

/** Keys whose classic modified form is the clearest encoding. */
const EXACT: Readonly<Record<string, string>> = { "shift+tab": "\u001b[Z" };

const single = (key: string) => [...key].length === 1;

/** Split a key id into its base key and modifier bits; an unknown or repeated word refuses. */
function parseModifiers(key: string): { base: string; mask: number } | undefined {
	if (key === "+") return { base: "+", mask: 0 };
	const parts = key.split("+");
	const base = parts.pop() ?? key;
	let mask = 0;
	for (const part of parts) {
		const bit = MODIFIERS[part];
		if (bit === undefined || (mask & bit) !== 0) return undefined;
		mask |= bit;
	}
	if (!base || parts.includes(base)) return undefined;
	return { base, mask };
}

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

/**
 * The input a key sends, so a click on its footer control delivers exactly that key. The encoding
 * covers the whole key syntax Pi accepts: letters, digits, symbols, the special and function keys,
 * and every combination of ctrl, shift, alt and super. A modified key is written as the sequence
 * its key matching accepts in both protocol states, so a click and the physical key always agree.
 * A key with no accepted form, such as a modified Escape, returns undefined and the caller reports
 * it instead of acting silently.
 */
/** Base names of the keys whose input id differs from the written key id. */
const BASE_NAMES: Readonly<Record<string, string>> = { esc: "escape", return: "enter" };

export function keyInput(key: string): string | undefined {
	if (EXACT[key] !== undefined) return EXACT[key];
	const parsed = parseModifiers(key);
	if (!parsed) return undefined;
	const name = BASE_NAMES[parsed.base] ?? parsed.base;
	if (parsed.mask === 0) return INPUT[name] ?? (single(name) ? name : undefined);
	return encodeModified(name, parsed.mask, key);
}

/** The sequence a modified key sends, or undefined for a key with no accepted form. */
function encodeModified(name: string, mask: number, key: string): string | undefined {
	if (name === "escape") return undefined;
	const fixed = SEQUENCED[key] ?? SEQUENCED[name];
	if (fixed !== undefined) return fixed.replace("%", String(mask + 1));
	const letter = /^([a-z])$/u.exec(name)?.[1];
	// A lone ctrl+letter keeps its classic one-byte form; every state accepts it.
	if (mask === MODIFIERS.ctrl && letter) return String.fromCharCode(letter.charCodeAt(0) - 96);
	const codepoint = CODEPOINTS[name] ?? ([...name].length === 1 ? name.codePointAt(0) : undefined);
	return codepoint === undefined ? undefined : `\u001b[${codepoint};${mask + 1}u`;
}
