import assert from "node:assert/strict";
import { it } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { KeybindingsManager, setKeybindings, TUI_KEYBINDINGS, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { Browser, type BrowserOptions } from "./browser.ts";
import { MORE_CHORD } from "./controls.ts";
import { NavigationFrame } from "./frame.ts";
import { keyInput } from "./keys.ts";
import type { Action, OperatorView, ViewHost } from "./view.ts";

initTheme("dark");
setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS));

const theme = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as Theme;

const plain = (line: string) => stripVTControlCharacters(line);
const ENTER = "\r";
const SHIFT_TAB = "\u001b[Z";
const RIGHT = "\u001b[C";

interface Item {
	readonly id: string;
	readonly text: string;
}

const ITEMS: Item[] = [
	{ id: "a", text: "Alpha record" },
	{ id: "b", text: "Beta record" },
];

/** A frame with one destination, so the footer and its click targets are the real ones. */
function open(open: (host: ViewHost) => OperatorView, patch: { rows?: number; controls?: () => readonly Action[] } = {}) {
	const frame = new NavigationFrame({
		theme,
		target: { id: "session", label: "This session" },
		destinations: () => [{ key: "records", label: "Records", open }],
		rows: () => patch.rows ?? 12,
		requestRender: () => {},
		close: () => {},
		...(patch.controls ? { controls: patch.controls } : {}),
	});
	return frame;
}

function mouse(x: number, y: number, width: number, height: number, pressed: { shift?: boolean; alt?: boolean } = {}): TuiMouseEvent {
	return { type: "click", button: "left", x, y, screenX: x, screenY: y, width, height, shift: pressed.shift ?? false, alt: pressed.alt ?? false, ctrl: false, clickCount: 1 } as TuiMouseEvent;
}

function screen(frame: NavigationFrame, width: number): string[] {
	return frame.render(width).map((line) => plain(line).trimEnd());
}

function footer(frame: NavigationFrame, width: number): string {
	return screen(frame, width).at(-1) ?? "";
}

/** A browser with an owner Enter action, the shape that took Enter at scope focus before. */
function records(host: ViewHost, options: { items?: readonly Item[]; actions?: BrowserOptions<Item>["actions"]; submit?: (query: string) => void } = {}) {
	const browser = new Browser<Item>({
		title: "Records",
		host,
		key: (item) => item.id,
		line: (item) => item.text,
		detail: (item) => (item ? `Detail of ${item.text}` : "Nothing selected"),
		actions: options.actions ?? (() => []),
		scopes: [
			{ id: "all", label: "All" },
			{ id: "mine", label: "Mine" },
		],
		scope: () => "all",
		search: { change: () => {}, ...(options.submit ? { submit: options.submit } : {}) },
	});
	browser.setItems(options.items ?? ITEMS);
	return browser;
}

it("Enter at scope focus returns to the list and runs no owner action", () => {
	const ran: string[] = [];
	let browser: Browser<Item> | undefined;
	const frame = open((host) => {
		browser = records(host, { actions: () => [{ id: "pickup", label: "Pick up", key: "enter", primary: true, run: () => ran.push("pickup") }] });
		return browser;
	});
	frame.render(80);
	frame.handleInput(SHIFT_TAB);
	assert.match(footer(frame, 80), /enter list/, "the scope row names Enter as the way to the list");
	frame.handleInput(ENTER);
	assert.deepEqual(ran, [], "Enter reached the view, not the owner action");
	assert.ok(browser?.keys().some((hint) => hint.label === "select"), "the list is focused again");
	assert.match(footer(frame, 80), /enter pick up/, "at list focus Enter runs the owner action");
	assert.ok(browser?.keys().some((hint) => hint.keys.includes("right") && hint.label === "open"), "Right opens the detail");
});

it("a click on the scope row's enter list returns to the list and runs no owner action", () => {
	const ran: string[] = [];
	const frame = open((host) => records(host, { actions: () => [{ id: "pickup", label: "Pick up", key: "enter", primary: true, run: () => ran.push("pickup") }] }));
	frame.render(80);
	frame.handleInput(SHIFT_TAB);
	const x = footer(frame, 80).indexOf("enter list");
	assert.ok(x > 0, `the footer shows enter list: ${footer(frame, 80)}`);
	frame.handleMouse(mouse(x, 11, 80, 12));
	assert.deepEqual(ran, [], "a click on the hint sends Enter to the view");
	assert.match(footer(frame, 80), /enter pick up/);
});

it("Enter at list focus still runs the owner's Enter action without opening the detail", () => {
	const ran: string[] = [];
	let browser: Browser<Item> | undefined;
	const frame = open((host) => {
		browser = records(host, { actions: (item) => [{ id: "pickup", label: "Pick up", key: "enter", primary: true, run: () => ran.push(`pickup:${item?.id}`) }] });
		return browser;
	});
	frame.render(80);
	frame.handleInput(ENTER);
	assert.deepEqual(ran, ["pickup:a"]);
	assert.ok(browser?.keys().some((hint) => hint.label === "select"), "the list stays focused");
	frame.handleInput(RIGHT);
	assert.deepEqual(ran, ["pickup:a"], "Right opens the detail instead of acting");
	assert.match(footer(frame, 80), /↑↓ scroll/, "the nested detail is focused");
	assert.ok(screen(frame, 80).some((line) => line.includes("Detail of Alpha record")), "the detail shows the selected record");
});

it("a modified or wrongly sized click during search leaves editing on and keeps Enter for the search", () => {
	const submitted: string[] = [];
	const ran: string[] = [];
	let browser: Browser<Item> | undefined;
	const frame = open((host) => {
		browser = records(host, {
			actions: () => [{ id: "pickup", label: "Pick up", key: "enter", primary: true, run: () => ran.push("pickup") }],
			submit: (query) => submitted.push(query),
		});
		return browser;
	});
	frame.render(80);
	frame.handleInput("/");
	assert.equal(browser?.editing(), true, "the search field has focus");
	frame.handleMouse(mouse(3, 5, 80, 12, { shift: true }));
	assert.equal(browser?.editing(), true, "a shift click keeps the search focused for native selection");
	frame.handleMouse(mouse(3, 5, 80, 12, { alt: true }));
	assert.equal(browser?.editing(), true, "an alt click keeps the search focused");
	frame.handleMouse(mouse(3, 5, 78, 12));
	assert.equal(browser?.editing(), true, "a click drawn for another width changes nothing");
	frame.handleMouse(mouse(3, 5, 80, 13));
	assert.equal(browser?.editing(), true, "a click drawn for another height changes nothing");
	frame.handleInput("l");
	frame.handleInput(ENTER);
	assert.deepEqual(submitted, ["l"], "Enter submitted the search");
	assert.deepEqual(ran, [], "and never picked anything up");
	assert.equal(browser?.editing(), false);
});

it("while a search field is edited a short footer shows the More chord, and x stays text", () => {
	let browser: Browser<Item> | undefined;
	const frame = open(
		(host) => {
			browser = records(host);
			return browser;
		},
		{ rows: 24, controls: () => [{ id: "expand", label: "Expand", key: "ctrl+e", primary: true, run: () => {} }] },
	);
	frame.render(60);
	frame.handleInput("/");
	const row = footer(frame, 60);
	assert.match(row, /ctrl\+n more/, `the row shows the chord while editing: ${row}`);
	assert.doesNotMatch(row, /(^|· )x more/);
	frame.handleInput("x");
	assert.equal(browser?.query, "x", "x inserted the letter");
	assert.match(footer(frame, 60), /ctrl\+n more/, "the letter did not open More");
	frame.handleInput(keyInput(MORE_CHORD) ?? "");
	assert.ok(screen(frame, 60).some((line) => line.startsWith("More")), "the chord opened More");
	assert.ok(screen(frame, 60).some((line) => /ctrl\+e/.test(line)), "More lists the hidden frame control");
	assert.doesNotMatch(footer(frame, 60), /more/, "the menu replaces the row");
	frame.handleInput(keyInput(MORE_CHORD) ?? "");
	assert.ok(!screen(frame, 60).some((line) => line.startsWith("More")), "the chord closed More again");
	assert.equal(browser?.query, "x", "the query survives the menu");
});

it("the More menu pages forward from its page down entry and back from its page up entry", () => {
	const items = Array.from({ length: 40 }, (_, index) => ({ id: String(index + 1), text: `Record ${index + 1}` }));
	let browser: Browser<Item> | undefined;
	const frame = open(
		(host) => {
			browser = records(host, {
				items,
				actions: () => [
					{ id: "note", label: "Note", key: "d", primary: true, run: () => {} },
					{ id: "attach", label: "Attach", key: "a", primary: true, run: () => {} },
					{ id: "configure", label: "Configure", key: "c", primary: true, run: () => {} },
					{ id: "threads", label: "Threads", key: "t", primary: true, run: () => {} },
				],
			});
			return browser;
		},
		{ rows: 24 },
	);
	browser?.select("30");
	frame.render(80);
	assert.match(footer(frame, 80), /x more/);
	frame.handleInput("x");
	const menu = screen(frame, 80);
	const up = menu.findIndex((line) => line.includes("pgup"));
	const down = menu.findIndex((line) => line.includes("pgdn"));
	assert.ok(up > 0 && down > 0 && up !== down, "the menu lists page up and page down as separate entries");
	frame.handleMouse(mouse(10, down, 80, 24));
	assert.equal(browser?.selected?.id, "40", "the page down entry moved the selection forward");
	frame.handleInput("x");
	const again = screen(frame, 80).findIndex((line) => line.includes("pgup"));
	assert.ok(again > 0);
	frame.handleMouse(mouse(10, again, 80, 24));
	assert.equal(browser?.selected?.id, "21", "the page up entry moved it back");
});

it("a hint whose key has no encoding reports the key instead of dropping the click", () => {
	const seen: string[] = [];
	const view: OperatorView = {
		title: "Keys",
		render: (_width, height) => Array.from({ length: height }, () => ""),
		handleInput: (data) => {
			seen.push(data);
			return true;
		},
		keys: () => [{ keys: ["ctrl+escape"], label: "close all" }],
	};
	const frame = open(() => view);
	const row = footer(frame, 80);
	const x = row.indexOf("ctrl+esc close all");
	assert.ok(x >= 0, `the hint is on the row: ${row}`);
	frame.handleMouse(mouse(x, 11, 80, 12));
	assert.deepEqual(seen, [], "an unencodable key reaches no handler");
	assert.ok(screen(frame, 80).some((line) => line.includes("The ctrl+esc key has no clickable form here.")), "the click names the key it could not send");
});

it("an action whose key a hint claims lists in More without that key", () => {
	const ran: string[] = [];
	const view: OperatorView = {
		title: "Keys",
		render: (_width, height) => Array.from({ length: height }, () => ""),
		handleInput: () => true,
		keys: () => [{ keys: ["d"], label: "details", priority: 0 }],
		actions: () => [{ id: "do", label: "Delete", key: "d", primary: true, run: () => ran.push("delete") }],
	};
	const frame = open(() => view, { rows: 8 });
	const row = footer(frame, 80);
	assert.match(row, /d details/, "the hint keeps its key");
	assert.doesNotMatch(row, /d delete/, "the action leaves the row");
	frame.handleInput("d");
	assert.deepEqual(ran, [], "the claimed key reaches the view, not the action");
	frame.handleInput("x");
	const menu = screen(frame, 80);
	const entry = menu.findIndex((line) => line.includes("Delete"));
	assert.ok(entry > 0, "More lists the action");
	assert.doesNotMatch(menu[entry] ?? "", /d\s+Delete/u, "the entry shows no key");
	frame.handleMouse(mouse(5, entry, 80, 8));
	assert.deepEqual(ran, ["delete"], "the entry runs the action");
});
