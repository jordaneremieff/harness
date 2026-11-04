import assert from "node:assert/strict";
import { it } from "node:test";
import { stripVTControlCharacters } from "node:util";
import type { TuiMouseEvent } from "@earendil-works/pi-tui";
import { ActionInventory, type ScreenAction } from "./action-inventory.ts";
import { DashboardMouse } from "./dashboard-mouse.ts";
import { fixture, row, source, theme, turn } from "./dashboard-test-fixture.mts";

const click = (x: number, y: number, width: number, height: number, patch: Partial<TuiMouseEvent> = {}): TuiMouseEvent => ({
	type: "click", button: "left", x, y, screenX: x, screenY: y, width, height, shift: false, alt: false, ctrl: false, clickCount: 1, ...patch,
});
const plain = (lines: string[]) => lines.map(stripVTControlCharacters);
const locate = (lines: string[], needle: string) => {
	const y = lines.findIndex((line) => line.includes(needle));
	assert.ok(y >= 0, `Missing ${needle}`);
	return { x: lines[y]?.indexOf(needle) ?? 0, y };
};

function inventory(actions: () => ScreenAction[], refused: string[] = []) {
	const mouse = new DashboardMouse();
	const subject = new ActionInventory(actions, (reason) => refused.push(reason));
	const footer = (width: number, menu = true) => {
		mouse.reset(width, 24);
		const back: ScreenAction = { id: "back", label: "Close", keys: ["escape"], run() {} };
		return stripVTControlCharacters(subject.footer(mouse, 23, width, back, theme, menu));
	};
	return { subject, mouse, footer };
}

it("the footer always keeps the menu control and the way out, dropping main actions from the end", () => {
	const make = () => ["alpha", "bravo", "charlie", "delta"].map((id): ScreenAction => ({ id, label: id, keys: [id[0] ?? ""], main: true, run() {} }));
	const f = inventory(make);
	assert.match(f.footer(80), /a alpha · b bravo · c charlie · d delta · x more · Esc close/);
	const narrow = f.footer(30);
	assert.match(narrow, /x more · Esc close/);
	assert.doesNotMatch(narrow, /delta/);
	assert.ok(narrow.trimEnd().length <= 30);
	assert.doesNotMatch(f.footer(40, false), /x more/);
});

it("pointer and keyboard dispatch the same action record and a disabled action explains itself", () => {
	const ran: string[] = [];
	const refused: string[] = [];
	const f = inventory(() => [
		{ id: "go", label: "Go", keys: ["g"], main: true, run: () => ran.push("go") },
		{ id: "blocked", label: "Blocked", keys: ["k"], main: true, disabled: "Select an agent first", run: () => ran.push("blocked") },
	], refused);
	const footer = f.footer(80);
	f.mouse.handle(click(footer.indexOf("g go"), 23, 80, 24));
	assert.equal(f.subject.handleInput("g"), true);
	assert.deepEqual(ran, ["go", "go"]);
	f.footer(80);
	f.mouse.handle(click(footer.indexOf("k blocked"), 23, 80, 24));
	assert.equal(f.subject.handleInput("k"), true);
	assert.deepEqual(ran, ["go", "go"]);
	assert.deepEqual(refused, ["Select an agent first", "Select an agent first"]);
	assert.equal(f.subject.handleInput("g", true), false, "typed text is not a shortcut while a field is being edited");
});

it("a click on a stale footer runs the action as it is now, never the replaced one", () => {
	let label = "one";
	const ran: string[] = [];
	const f = inventory(() => [{ id: label, label, keys: ["g"], main: true, run: () => ran.push(label) }]);
	const footer = f.footer(80);
	label = "two";
	f.mouse.handle(click(footer.indexOf("g one"), 23, 80, 24));
	assert.deepEqual(ran, [], "the action that was drawn no longer exists");
});

it("the menu lists every action with disabled reasons, selects by pointer, and runs only on choose", () => {
	const ran: string[] = [];
	const f = inventory(() => [
		{ id: "one", label: "One", keys: ["o"], description: "First", run: () => ran.push("one") },
		{ id: "two", label: "Two", disabled: "Needs a thing", run: () => ran.push("two") },
		{ id: "three", label: "Three", keys: ["enter"], run: () => ran.push("three") },
	]);
	assert.equal(f.subject.handleInput("x"), true);
	assert.equal(f.subject.open, true);
	const draw = () => plain(f.subject.render(60, 24, "Agents", "roster", theme));
	let lines = draw();
	assert.match(lines.join("\n"), /One · o/);
	assert.match(lines.join("\n"), /Two · unavailable/);
	assert.match(lines.join("\n"), /Needs a thing/);
	const three = locate(lines, "Three");
	f.subject.handleMouse(click(three.x, three.y, 60, 24));
	assert.deepEqual(ran, [], "selecting a row does not run it");
	lines = draw();
	assert.match(lines.join("\n"), /› Three/);
	f.subject.handleMouse(click(2, 23, 60, 24));
	assert.deepEqual(ran, ["three"]);
	assert.equal(f.subject.open, false);
	f.subject.handleInput("x");
	draw();
	f.subject.handleInput("\x1b[A");
	f.subject.handleInput("\r");
	assert.deepEqual(ran, ["three"], "a disabled action stays in the menu");
	assert.equal(f.subject.open, true);
	f.subject.handleInput("\x1b");
	assert.equal(f.subject.open, false);
});

for (const [width, height] of [[60, 20], [80, 24], [164, 44]] as const) {
	it(`every roster action is reachable through visible controls at ${width}x${height}`, async () => {
		const ran: string[] = [];
		const f = fixture(width, height, source([row("one", { state: "idle" })]), {
			action: async (name) => { ran.push(name); return undefined; },
		});
		const lines = () => plain(f.ui.render(width));
		const press = (needle: string) => { const p = locate(lines(), needle); return f.ui.handleMouse(click(p.x, p.y, width, height)); };
		try {
			await turn();
			const footer = lines().at(-1) ?? "";
			assert.match(footer, /x more/);
			assert.match(footer, /Esc close/);
			press("x more");
			const menu = lines().join("\n");
			for (const label of ["Open", "Message", "Actions", "Threads", "Efforts", "New agent", "Tasks", "Find", "Help", "Exact times"]) assert.match(menu, new RegExp(label), label);
			assert.ok(plain(f.ui.render(width)).length === height);
			press("Find");
			press("Enter choose");
			assert.equal(f.ui.navigation.screen, "find");
			assert.match(lines().at(-1) ?? "", /Esc cancel find/);
			f.ui.handleInput("\x1b");
			press("x more");
			press("Tasks");
			press("Enter choose");
			assert.equal(f.ui.navigation.screen, "tasks");
			assert.match(lines().at(-1) ?? "", /Esc back/);
			f.ui.handleInput("\x1b");
			assert.equal(f.ui.navigation.screen, "roster");
			assert.deepEqual(ran, []);
		} finally {
			f.ui.dispose();
		}
	});
}

it("a disabled roster action names its reason and keeps the selected recipient and draft", async () => {
	const f = fixture(80, 24, source([]));
	try {
		await turn();
		f.ui.handleInput("a");
		assert.equal(f.ui.navigation.screen, "roster");
		const footer = plain(f.ui.render(80));
		assert.match(footer.join("\n"), /Select an agent first/);
	} finally {
		f.ui.dispose();
	}
});
