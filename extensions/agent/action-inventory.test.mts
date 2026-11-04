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
/** Visible text only: terminal styling and the zero-width cursor markers removed, so columns match the screen. */
const plain = (lines: string[]) => lines.map((line) => stripVTControlCharacters(line.replace(/\x1b_[^\x07]*\x07/g, "")));
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
	assert.match(f.footer(80), /^alpha · bravo · charlie · delta │ More \(x\) · Close \(Esc\)/);
	const narrow = f.footer(28);
	assert.match(narrow, /^More \(x\) · Close \(Esc\)/);
	assert.doesNotMatch(narrow, /delta|│/);
	assert.ok(narrow.trimEnd().length <= 28);
	assert.doesNotMatch(f.footer(40, false), /More/);
});

it("destinations stay in the footer at every width, after the item actions and before the menu", () => {
	const ran: string[] = [];
	const f = inventory(() => [
		{ id: "open", label: "Open", keys: ["enter"], main: true, run: () => ran.push("open") },
		{ id: "message", label: "Message", keys: ["m"], main: true, run: () => ran.push("message") },
		{ id: "threads", label: "Threads", keys: ["t"], main: true, navigation: true, run: () => ran.push("threads") },
		{ id: "efforts", label: "Efforts", keys: ["b"], main: true, navigation: true, run: () => ran.push("efforts") },
	]);
	assert.match(f.footer(80), /^Open · Message │ Threads · Efforts · More \(x\) · Close \(Esc\)/);
	const narrow = f.footer(44);
	assert.match(narrow, /^Threads · Efforts · More \(x\) · Close \(Esc\)/, "item actions drop before destinations");
	assert.ok(narrow.trimEnd().length <= 44);
	const footer = f.footer(80);
	f.mouse.handle(click(footer.indexOf("Efforts"), 23, 80, 24));
	f.footer(80);
	f.mouse.handle(click(footer.indexOf("Message"), 23, 80, 24));
	assert.deepEqual(ran, ["efforts", "message"]);
});

it("pointer and keyboard dispatch the same action record and a disabled action explains itself", () => {
	const ran: string[] = [];
	const refused: string[] = [];
	const f = inventory(() => [
		{ id: "go", label: "Go", keys: ["g"], main: true, run: () => ran.push("go") },
		{ id: "blocked", label: "Blocked", keys: ["k"], main: true, disabled: "Select an agent first", run: () => ran.push("blocked") },
	], refused);
	const footer = f.footer(80);
	f.mouse.handle(click(footer.indexOf("Go"), 23, 80, 24));
	assert.equal(f.subject.handleInput("g"), true);
	assert.deepEqual(ran, ["go", "go"]);
	f.footer(80);
	f.mouse.handle(click(footer.indexOf("Blocked"), 23, 80, 24));
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
	f.mouse.handle(click(footer.indexOf("one"), 23, 80, 24));
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

const TARGET_ACTIONS = ["Configure", "Tasks", "Fork", "Rewind", "Compact", "Reset context", "Schedule message", "Scheduled messages", "Run command", "Profile", "Details", "Stop and release host"];
const VIEW_ACTIONS = ["New conversation", "Threads", "Efforts", "Help"];

for (const [width, height] of [[60, 20], [80, 24], [164, 44]] as const) {
	it(`every work view action is reachable through labelled controls or their More menu at ${width}x${height}`, async () => {
		const f = fixture(width, height, source([row("one", { state: "idle" })]), {
			collaborate: async () => ({ items: [], nextCursor: null, coverage: { complete: true, visited: 0, omitted: 0 } }),
			efforts: async () => {
				throw new Error("Related efforts are not read by the controls");
			},
		});
		const lines = () => plain(f.ui.render(width));
		const press = (p: { x: number; y: number }) => f.ui.handleMouse(click(p.x, p.y, width, height));
		/** The labels on the line that holds `anchor`, plus the labels its More menu lists. */
		const reachable = (anchor: string) => {
			const shown = lines();
			const y = shown.findIndex((line) => line.includes(anchor));
			assert.ok(y >= 0, `no line holds ${anchor}`);
			const line = shown[y] ?? "";
			const more = line.lastIndexOf("More…");
			if (more < 0) return line;
			press({ x: more + 1, y });
			let menu = "";
			for (let step = 0; step < 16; step++) {
				menu += lines().join("\n");
				f.ui.handleInput("\x1b[B");
			}
			f.ui.handleInput("\x1b");
			return `${line}\n${menu}`;
		};
		try {
			await turn();
			await turn();
			const heading = reachable("Agents");
			for (const label of VIEW_ACTIONS) assert.match(heading, new RegExp(label), `${label} from the heading`);
			const target = reachable("Configure");
			for (const label of TARGET_ACTIONS) assert.match(target, new RegExp(label), `${label} for the selected agent`);
			assert.doesNotMatch(lines().join("\n"), /\(x\)|\bt threads|\bn new/, "controls read as labels, not letter shortcuts");
			assert.equal(lines().length, height);
			f.ui.openNamedAction("tasks");
			assert.equal(f.ui.focus.inspector, "Tasks");
			f.ui.handleInput("\x1b");
			assert.equal(f.ui.focus.inspector, undefined, "Escape leaves the inspector");
			assert.deepEqual(f.calls, [], "reading the controls runs nothing");
		} finally {
			f.ui.dispose();
		}
	});
}

it("Tab reaches the heading controls, and Enter there runs the focused control", async () => {
	const f = fixture(164, 44, source([row("one", { state: "idle" })]));
	try {
		await turn();
		await turn();
		f.ui.render(164);
		for (let step = 0; step < 4; step++) f.ui.handleInput("\t");
		assert.equal(f.ui.focus.region, "heading");
		f.ui.handleInput("\r");
		assert.equal(f.ui.focus.inspector, "New conversation", "the first heading control is New conversation");
		assert.deepEqual(f.calls, []);
	} finally {
		f.ui.dispose();
	}
});

it("a disabled control names its reason and keeps the selected recipient and draft", async () => {
	const f = fixture(164, 44, source([row("one", { state: "working" })]), { newAgent: undefined, newUnavailable: "Creation is not wired here" });
	try {
		await turn();
		await turn();
		f.ui.handleInput("\r");
		f.ui.handleInput("keep this");
		const configure = locate(plain(f.ui.render(164)), "Configure");
		f.ui.handleMouse(click(configure.x, configure.y, 164, 44));
		assert.match(plain(f.ui.render(164)).join("\n"), /Stop current work first; the owner configures idle agents only/);
		const start = locate(plain(f.ui.render(164)), "New conversation");
		f.ui.handleMouse(click(start.x, start.y, 164, 44));
		assert.match(plain(f.ui.render(164)).join("\n"), /Creation is not wired here/);
		assert.equal(f.ui.selectedRow?.id, "one");
		assert.equal(f.state.agents.get("one")?.draft, "keep this");
		assert.equal(f.ui.focus.inspector, undefined, "a refused control opens nothing");
		assert.deepEqual(f.calls, []);
	} finally {
		f.ui.dispose();
	}
});
