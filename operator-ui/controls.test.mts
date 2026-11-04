import assert from "node:assert/strict";
import { it } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { HitMap } from "./hits.ts";
import { ActionBar } from "./controls.ts";
import type { Action } from "./view.ts";

const theme = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as Theme;

const plain = (line: string) => stripVTControlCharacters(line);

interface MousePatch {
	readonly type?: "click" | "wheel";
	readonly wheelDelta?: number;
	readonly clickCount?: number;
}

function mouse(x: number, y: number, width: number, height: number, patch: MousePatch = {}) {
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

function action(id: string, label: string, patch: Partial<Action> = {}): Action {
	return { id, label, run: () => runs.push(id), ...patch };
}

const runs: string[] = [];
const barActions = (): Action[] => [
	action("save", "Save", { primary: true }),
	action("copy", "Copy", { primary: true }),
	action("export", "Export"),
	action("delete", "Delete"),
];

it("primary actions render first and the rest overflow into More", () => {
	runs.length = 0;
	const bar = new ActionBar(() => {});
	const hits = new HitMap();
	hits.begin(40, 1);
	const line = plain(bar.render(barActions(), 40, theme, hits, 0));
	assert.ok(line.includes("Save"));
	assert.ok(line.includes("Copy"));
	assert.ok(line.includes("More…"));
	assert.ok(!line.includes("Export"));
	assert.ok(!line.includes("Delete"));
	assert.ok(line.indexOf("Save") < line.indexOf("Copy"));
	assert.ok(line.indexOf("Copy") < line.indexOf("More…"));
});

it("controls that do not fit move into More, never out of reach", () => {
	runs.length = 0;
	const bar = new ActionBar(() => {});
	const hits = new HitMap();
	// Save, Copy and More need 25 columns; 20 leave room for Save and More only.
	hits.begin(20, 1);
	const line = plain(bar.render(barActions(), 20, theme, hits, 0));
	assert.ok(line.includes("Save"));
	assert.ok(line.includes("More…"));
	assert.ok(!line.includes("Copy"));
	hits.handle(mouse(10, 0, 20, 1));
	assert.equal(bar.menuShown, true);
	const menuHits = new HitMap();
	menuHits.begin(20, 6);
	const menu = bar.renderMenu(barActions(), 20, 6, theme, menuHits, 0).map(plain);
	assert.ok(menu.some((row) => row.includes("Copy")), "the control that did not fit is in the menu");
});

it("measure matches the width the bar renders when nothing has to overflow", () => {
	const bar = new ActionBar(() => {});
	const actions = barActions();
	const width = ActionBar.measure(actions);
	const hits = new HitMap();
	hits.begin(width, 1);
	const line = bar.render(actions, width, theme, hits, 0);
	assert.equal(visibleWidth(line), width);
	assert.ok(plain(line).includes("Save"));
	assert.ok(plain(line).includes("Copy"));
	assert.ok(plain(line).includes("More…"));
});

it("a disabled action never runs and reports its reason through the refused callback", () => {
	runs.length = 0;
	const refused: string[] = [];
	const bar = new ActionBar((reason) => refused.push(reason));
	const actions: Action[] = [
		{ id: "save", label: "Save", primary: true, disabled: "the draft is empty", run: () => runs.push("save") },
		action("copy", "Copy", { primary: true }),
	];
	const hits = new HitMap();
	hits.begin(30, 1);
	const line = bar.render(actions, 30, theme, hits, 0);
	assert.ok(plain(line).includes("Save"));
	const clicked = hits.handle(mouse(2, 0, 30, 1));
	assert.deepEqual(clicked, { handled: true, render: true });
	assert.deepEqual(runs, []);
	assert.deepEqual(refused, ["the draft is empty"]);
});

it("the menu lists every action and runs only the chosen one", () => {
	runs.length = 0;
	const bar = new ActionBar(() => {});
	const actions = barActions();
	const barHits = new HitMap();
	barHits.begin(8, 1);
	const line = bar.render(actions, 8, theme, barHits, 0);
	assert.equal(plain(line).trim(), "More…");
	assert.deepEqual(barHits.handle(mouse(3, 0, 8, 1)), { handled: true, render: true });
	assert.equal(bar.menuShown, true);
	const menuHits = new HitMap();
	menuHits.begin(20, 6);
	const menu = bar.renderMenu(actions, 20, 6, theme, menuHits, 0);
	const labels = menu.map((row) => plain(row));
	for (const name of ["Save", "Copy", "Export", "Delete"]) assert.ok(labels.some((row) => row.includes(name)), `${name} missing from menu`);
	assert.deepEqual(menuHits.handle(mouse(0, 3, 20, 6)), { handled: true, render: true });
	assert.deepEqual(runs, ["export"]);
	assert.equal(bar.menuShown, false);
});

it("a menu taller than its rows states the hidden count, and that row reveals the rest", () => {
	runs.length = 0;
	const bar = new ActionBar(() => {});
	const actions = Array.from({ length: 8 }, (_, index) => action(`a${index}`, `Action ${index}`));
	const barHits = new HitMap();
	barHits.begin(8, 1);
	bar.render(actions, 8, theme, barHits, 0);
	barHits.handle(mouse(3, 0, 8, 1));
	const menuHits = new HitMap();
	menuHits.begin(40, 5);
	let menu = bar.renderMenu(actions, 40, 5, theme, menuHits, 0).map(plain);
	assert.equal(menu.length, 5);
	assert.match(menu.at(-1) ?? "", /\u2193 5 more/u, "the last row counts the actions below");
	assert.ok(!menu.some((row) => row.includes("Action 7")));
	assert.deepEqual(menuHits.handle(mouse(2, 4, 40, 5)), { handled: true, render: true });
	assert.deepEqual(runs, [], "the count row scrolls; it runs nothing");
	menuHits.begin(40, 5);
	menu = bar.renderMenu(actions, 40, 5, theme, menuHits, 0).map(plain);
	assert.match(menu[0] ?? "", /\u2191 \d+ more/u, "the heading counts the actions above");
	for (let step = 0; step < 3; step++) {
		menuHits.handle(mouse(2, 4, 40, 5));
		menuHits.begin(40, 5);
		menu = bar.renderMenu(actions, 40, 5, theme, menuHits, 0).map(plain);
	}
	assert.ok(menu.some((row) => row.includes("Action 7")), "the last action comes into view");
});

it("closing the menu keeps the actions available on the bar", () => {
	runs.length = 0;
	const bar = new ActionBar(() => {});
	const actions = barActions();
	const barHits = new HitMap();
	barHits.begin(8, 1);
	bar.render(actions, 8, theme, barHits, 0);
	barHits.handle(mouse(3, 0, 8, 1));
	assert.equal(bar.menuShown, true);
	bar.closeMenu();
	assert.equal(bar.menuShown, false);
});
