import assert from "node:assert/strict";
import { it } from "node:test";
import { stripVTControlCharacters } from "node:util";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { actionControl, actionLabel, type Control, Footer, menuControl } from "./controls.ts";
import { HitMap } from "./hits.ts";
import type { Action } from "./view.ts";

const theme = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as Theme;

const plain = (line: string) => stripVTControlCharacters(line);

function mouse(x: number, y: number, width: number, height: number) {
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
		clickCount: 1,
	} as const;
}

const runs: string[] = [];

function control(id: string, keys: readonly string[], label: string, patch: Partial<Control> = {}): Control {
	return { id, keys, label, run: (key) => runs.push(`${id}:${key}`), ...patch };
}

const nav = () => control("nav", ["up", "down"], "select", { priority: 0 });
const act = () => control("act", ["enter"], "run", { priority: 1 });
const mid = () => control("mid", ["d"], "details", { priority: 2 });
const low = () => control("low", ["tab"], "focus", { priority: 3 });
const exit = () => control("exit", ["escape"], "close", { priority: 0 });

function draw(footer: Footer, controls: readonly Control[], width: number, menu: readonly Control[] = []) {
	const hits = new HitMap();
	hits.begin(width, 1);
	const line = plain(footer.render(controls, width, theme, hits, 0, 0, menu)).trimEnd();
	return { line, hits };
}

it("controls render as key label pairs, in order, with the way out last", () => {
	runs.length = 0;
	const { line } = draw(new Footer(), [nav(), act(), control("more-like", ["enter"], "open", { priority: 1 }), exit()], 80);
	assert.equal(line, "↑↓ select · enter run · enter open · esc close");
	assert.ok(line.indexOf("select") < line.indexOf("run"));
	assert.ok(line.indexOf("open") < line.indexOf("esc close"));
});

it("a click runs the key of its control, and a gap between controls runs nothing", () => {
	runs.length = 0;
	const { line, hits } = draw(new Footer(), [nav(), act(), exit()], 80);
	const at = line.indexOf("enter run");
	assert.deepEqual(hits.handle(mouse(at, 0, 80, 1)), { handled: true, render: true });
	assert.deepEqual(runs, ["act:enter"]);
	runs.length = 0;
	const gap = line.indexOf(" · ", line.indexOf("select"));
	assert.equal(hits.handle(mouse(gap, 0, 80, 1)), undefined, "a separator is inert");
	assert.deepEqual(runs, []);
});

it("a control with two keys has one target per token, and each token sends its own key", () => {
	runs.length = 0;
	const select = draw(new Footer(), [nav(), exit()], 80);
	assert.equal(select.line, "↑↓ select · esc close");
	select.hits.handle(mouse(0, 0, 80, 1));
	select.hits.handle(mouse(1, 0, 80, 1));
	select.hits.handle(mouse(2, 0, 80, 1));
	assert.deepEqual(runs, ["nav:up", "nav:down"], "a click beyond the tokens does nothing");
	runs.length = 0;
	const page = draw(new Footer(), [control("page", ["pageUp", "pageDown"], "read", { priority: 0 }), exit()], 80);
	assert.equal(page.line, "pgup/pgdn read · esc close");
	page.hits.handle(mouse(0, 0, 80, 1));
	page.hits.handle(mouse(5, 0, 80, 1));
	page.hits.handle(mouse(4, 0, 80, 1));
	assert.deepEqual(runs, ["page:pageUp", "page:pageDown"], "the slash between keys is inert");
});

it("a short row drops the highest priority first and keeps priority 0 on the row", () => {
	runs.length = 0;
	const footer = new Footer();
	const wide = draw(footer, [nav(), act(), mid(), low(), exit()], 120);
	assert.equal(wide.line, "↑↓ select · enter run · d details · tab focus · esc close");
	const narrow = draw(footer, [nav(), act(), mid(), low(), exit()], 50);
	assert.equal(narrow.line, "↑↓ select · enter run · x more · esc close");
	assert.ok(!narrow.line.includes("details"));
	assert.ok(!narrow.line.includes("tab focus"));
	assert.ok(narrow.line.startsWith("↑↓ select"), "the first navigation key never leaves the row");
	assert.ok(narrow.line.endsWith("esc close"), "the way out never leaves the row");
});

it("the More menu lists every hidden control with its key and runs only the chosen one", () => {
	runs.length = 0;
	const footer = new Footer();
	const controls = [nav(), act(), mid(), low(), exit()];
	const narrow = draw(footer, controls, 50);
	const at = narrow.line.indexOf("x more");
	narrow.hits.handle(mouse(at, 0, 50, 1));
	assert.equal(footer.menuShown, true);
	const menuHits = new HitMap();
	menuHits.begin(40, 4);
	const menu = footer.renderMenu(40, 4, theme, menuHits, 0).map(plain);
	assert.match(menu[0] ?? "", /^More/);
	assert.ok(menu.some((row) => row.includes("d") && row.includes("details")), "the hidden control keeps its key");
	assert.ok(menu.some((row) => row.includes("focus")));
	assert.deepEqual(menuHits.handle(mouse(5, 2, 40, 4)), { handled: true, render: true });
	assert.deepEqual(runs, ["low:tab"], "only the chosen entry runs");
	assert.equal(footer.menuShown, false);
});

it("the menu counts the entries above and below, and the count row runs nothing", () => {
	runs.length = 0;
	const footer = new Footer();
	const entries = Array.from({ length: 8 }, (_, index) => control(`i${index}`, ["qwertyui"[index] ?? "q"], `Item ${index}`, { priority: 2 }));
	const row = draw(footer, [exit()], 40, entries);
	assert.equal(row.line, "x more · esc close");
	row.hits.handle(mouse(0, 0, 40, 1));
	const menuHits = new HitMap();
	menuHits.begin(40, 5);
	const menu = footer.renderMenu(40, 5, theme, menuHits, 0).map(plain);
	assert.equal(menu.length, 5);
	assert.match(menu.at(-1) ?? "", /↓ 5 more/);
	assert.equal(menuHits.handle(mouse(2, 4, 40, 5)), undefined, "the count row is informational");
	assert.deepEqual(runs, []);
	assert.equal(footer.menuInput("\u001b[F"), true, "End reaches the last entry");
	const after = footer.renderMenu(40, 5, theme, menuHits, 0).map(plain);
	assert.match(after[0] ?? "", /↑ 5 more/);
	assert.ok(after.some((row) => row.includes("Item 7")));
	assert.equal(footer.menuInput("\r"), true);
	assert.deepEqual(runs, ["i7:i"]);
	assert.equal(footer.menuShown, false);
});

it("the menu consumes its keys and closes on Escape or the More key", () => {
	const footer = new Footer();
	const { line, hits } = draw(footer, [control("a", ["a"], "alpha", { priority: 0 }), exit()], 80, [control("b", ["b"], "bravo")]);
	hits.handle(mouse(line.indexOf("x more"), 0, 80, 1));
	assert.equal(footer.menuShown, true);
	assert.equal(footer.menuInput("\u001b[B"), true, "Down moves inside the menu");
	assert.equal(footer.menuInput("\u001b"), true);
	assert.equal(footer.menuShown, false);
	footer.toggleMenu();
	assert.equal(footer.menuShown, true);
	footer.menuInput("x");
	assert.equal(footer.menuShown, false, "the More key closes the menu");
	assert.equal(footer.menuInput("a"), false, "keys pass through while the menu is closed");
});

it("footer targets come from the last render, so a resize moves them", () => {
	runs.length = 0;
	const footer = new Footer();
	const controls = [
		nav(),
		control("open", ["enter"], "open", { priority: 1 }),
		control("attach", ["a"], "attach", { priority: 1 }),
		control("config", ["c"], "configure", { priority: 1 }),
		control("tasks", ["k"], "tasks", { priority: 1 }),
		control("threads", ["t"], "threads", { priority: 1 }),
		exit(),
	];
	const wide = draw(footer, controls, 120);
	const threadX = wide.line.indexOf("t threads");
	assert.ok(threadX > 0);
	const narrow = draw(footer, controls, 70);
	assert.ok(!narrow.line.includes("threads"), "the last item action left the short row");
	assert.ok(narrow.line.includes("x more"));
	narrow.hits.handle(mouse(threadX, 0, 70, 1));
	assert.deepEqual(runs, ["exit:escape"], "the old position now belongs to the way out");
	runs.length = 0;
	const moreX = narrow.line.indexOf("x more");
	narrow.hits.handle(mouse(moreX, 0, 70, 1));
	assert.equal(footer.menuShown, true, "the drawn position of More opens the menu");
});

it("action controls carry the action's wording, key and state", () => {
	const calls: string[] = [];
	const disabled: Action = { id: "note", label: "Pick up with note…", short: "note", key: "a", disabled: "No stash selected", run: () => {} };
	const controlOf = actionControl(disabled, (id) => calls.push(id));
	assert.ok(controlOf);
	assert.deepEqual(controlOf.keys, ["a"]);
	assert.equal(controlOf.label, "note");
	assert.equal(controlOf.disabled, "No stash selected");
	controlOf.run("a");
	assert.deepEqual(calls, ["note"], "the control re-reads the action when it runs");
	assert.equal(actionControl({ id: "fork", label: "Fork", run: () => {} }, () => {}), undefined, "an action without a key has no footer control");
	assert.equal(actionLabel({ label: "Apply" }), "apply");
	assert.equal(actionLabel({ label: "Read more", short: "read more" }), "read more");
	assert.equal(actionLabel({ label: "2 results" }), "2 results", "a label that is not a word keeps its form");
	const menuEntry = menuControl(disabled, () => {});
	assert.deepEqual(menuEntry.keys, ["a"], "a menu entry keeps the key it no longer shows on the row");
});
