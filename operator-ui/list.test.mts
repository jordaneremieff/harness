import assert from "node:assert/strict";
import { it } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { setKeybindings, KeybindingsManager, TUI_KEYBINDINGS } from "@earendil-works/pi-tui";
import { initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { HitMap } from "./hits.ts";
import { ListView } from "./list.ts";

initTheme("dark");
setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS));

const theme = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as Theme;

const names = ["one", "two", "three", "four", "five"];
const items = (which: string[] = names) => which.map((name) => ({ name }));

function list(patch: { onSelect?: (name: string | undefined) => void; onOpen?: (name: string) => void } = {}) {
	return new ListView<{ name: string }>({
		key: (item) => item.name,
		line: (item) => item.name,
		onSelect: (item) => patch.onSelect?.(item?.name),
		onOpen: (item) => patch.onOpen?.(item.name),
	});
}

function mouse(x: number, y: number, width: number, height: number, patch: { type?: "click" | "wheel"; wheelDelta?: number; clickCount?: number } = {}) {
	return {
		type: "click",
		button: "left",
		x,
		y,
		screenX: x,
		screenY: y,
		width,
		height,
		shift: false,
		alt: false,
		ctrl: false,
		...patch,
	} as const;
}

const render = (view: ListView<{ name: string }>, height: number) => {
	const hits = new HitMap();
	hits.begin(20, height);
	const lines = view.render(20, height, theme, hits, 0, 0).map((line) => stripVTControlCharacters(line).trim());
	return { lines, hits };
};

it("setItems keeps the selection by key when the rows change", () => {
	const selected: Array<string | undefined> = [];
	const view = list({ onSelect: (name) => selected.push(name) });
	view.setItems(items());
	assert.equal(view.selected?.name, "one");
	view.select("two");
	view.setItems(items(["three", "two", "one"]));
	assert.equal(view.selected?.name, "two");
	view.setItems(items(["one", "three", "five"]));
	assert.equal(view.selected?.name, "three");
	view.setItems([]);
	assert.equal(view.selected, undefined);
});

it("setItems prefers the requested key over the previous selection", () => {
	const view = list();
	view.setItems(items());
	view.setItems(items(), "four");
	assert.equal(view.selected?.name, "four");
});

it("the wheel scrolls the window without changing the selection", () => {
	const view = list();
	view.setItems(items());
	view.focused = true;
	const before = render(view, 2);
	assert.deepEqual(before.lines, ["\u203aone", "two"], "the focused list marks its selected row");
	assert.deepEqual(before.hits.handle(mouse(5, 1, 20, 2, { type: "wheel", wheelDelta: 2 })), { handled: true, render: true });
	assert.equal(view.selected?.name, "one");
	const after = render(view, 2);
	assert.deepEqual(after.lines, ["three", "four"]);
	assert.equal(view.selected?.name, "one");
});

it("a click selects the row under it", () => {
	const selected: Array<string | undefined> = [];
	const view = list({ onSelect: (name) => selected.push(name) });
	view.setItems(items());
	const page = render(view, 3);
	assert.deepEqual(page.hits.handle(mouse(2, 1, 20, 3)), { handled: true, render: true, focus: true });
	assert.equal(view.selected?.name, "two");
	assert.deepEqual(selected, ["one", "two"], "the first rows select their first item, then the click selects the second");
});

it("Enter opens the selected item", () => {
	const opened: string[] = [];
	const view = list({ onOpen: (name) => opened.push(name) });
	view.setItems(items());
	view.select("three");
	assert.equal(view.handleInput("\r"), true);
	assert.deepEqual(opened, ["three"]);
});

it("a double click opens the row under it", () => {
	const opened: string[] = [];
	const view = list({ onOpen: (name) => opened.push(name) });
	view.setItems(items());
	const page = render(view, 3);
	assert.deepEqual(page.hits.handle(mouse(2, 2, 20, 3, { clickCount: 2 })), { handled: true, render: true, focus: true });
	assert.equal(view.selected?.name, "three");
	assert.deepEqual(opened, ["three"]);
});

it("a single click selects without opening", () => {
	const opened: string[] = [];
	const view = list({ onOpen: (name) => opened.push(name) });
	view.setItems(items());
	const page = render(view, 3);
	page.hits.handle(mouse(2, 2, 20, 3));
	assert.equal(view.selected?.name, "three");
	assert.deepEqual(opened, []);
});

it("arrow keys move the selection and keep it visible", () => {
	const view = list();
	view.setItems(items());
	const page = render(view, 2);
	view.handleInput("\x1b[B");
	view.handleInput("\x1b[B");
	assert.equal(view.selected?.name, "three");
	const moved = render(view, 2);
	assert.deepEqual(moved.lines, ["two", "three"]);
	assert.equal(page.lines.length, 2);
});
