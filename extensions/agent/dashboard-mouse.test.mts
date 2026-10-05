import assert from "node:assert/strict";
import { it } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { isKittyProtocolActive, setKittyProtocolActive, type TUI, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { AgentComposer } from "./agent-composer.ts";
import { DashboardMouse, mouseHints } from "./dashboard-mouse.ts";
import { fixture, keys, row, source, theme, turn } from "./dashboard-test-fixture.mts";

const event = (
	x: number,
	y: number,
	width: number,
	height: number,
	patch: Partial<TuiMouseEvent> = {},
): TuiMouseEvent => ({
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
	...patch,
});
function point(lines: string[], text: string) {
	const y = lines.findIndex((line) => line.includes(text));
	assert.ok(y >= 0, `Missing ${text}`);
	const line = lines[y];
	assert.ok(line);
	return { x: line.indexOf(text), y };
}
it("mouse regions leave selection gestures, modifiers, invalid cells and stale layouts unhandled", () => {
	const mouse = new DashboardMouse();
	let clicks = 0;
	let delta = 0;
	mouse.reset(80, 24);
	mouse.add({
		x: 2,
		y: 2,
		width: 10,
		height: 3,
		click: () => {
			clicks++;
		},
		wheel: (value) => {
			delta = value;
		},
	});
	for (const patch of [
		{ type: "press" },
		{ type: "drag" },
		{ type: "release" },
		{ type: "move" },
		{ clickCount: 2 },
		{ clickCount: 3 },
		{ shift: true },
		{ alt: true },
		{ ctrl: true },
		{ button: "right" },
		{ width: 81 },
		{ x: -1 },
		{ x: Number.NaN },
		{ y: 24 },
	] as Partial<TuiMouseEvent>[])
		assert.equal(mouse.handle(event(3, 3, 80, 24, patch)), undefined);
	assert.equal(clicks, 0);
	assert.equal(mouse.handle(event(3, 3, 80, 24))?.focus, true);
	assert.equal(clicks, 1);
	assert.deepEqual(mouse.handle(event(3, 3, 80, 24, { type: "wheel", wheelDelta: -3 })), {
		handled: true,
		render: true,
	});
	assert.equal(delta, -3);
	mouse.reset();
	assert.equal(mouse.handle(event(3, 3, 80, 24)), undefined);
});
it("hint hit areas include only visible hints and split paired keys", () => {
	const mouse = new DashboardMouse();
	const calls: string[] = [];
	mouse.reset(80, 24);
	const line = mouseHints(mouse, 23, ["↑↓ select", "PgUp/PgDn read", "enter choose"], "esc back", 80, (key) =>
		calls.push(key),
	);
	for (const text of ["↑", "↓", "pgup", "pgdn", "enter", "esc"]) mouse.handle(event(line.indexOf(text), 23, 80, 24));
	assert.deepEqual(calls, ["\x1b[A", "\x1b[B", "\x1b[5~", "\x1b[6~", "\r", "\x1b"]);
	mouse.reset(20, 24);
	const clipped = mouseHints(mouse, 23, ["enter choose", "r refresh"], "esc back", 20, (key) => calls.push(key));
	assert.doesNotMatch(clipped, /refresh/);
	assert.equal(mouse.handle(event(19, 23, 20, 24)), undefined);
});
it("the Ctrl+J hint inserts a native newline without submission in either terminal protocol", () => {
	const previous = isKittyProtocolActive();
	try {
		for (const active of [false, true]) {
			setKittyProtocolActive(active);
			const sent: string[] = [];
			const composer = new AgentComposer({
				tui: { terminal: { rows: 24, columns: 80 }, requestRender() {} } as unknown as TUI,
				theme,
				keys,
				onSubmit: (text) => sent.push(text),
				onEscape() {},
			});
			const mouse = new DashboardMouse();
			mouse.reset(80, 24);
			const line = mouseHints(mouse, 23, ["Ctrl+J newline"], "esc back", 80, (data) => composer.handleInput(data));
			composer.handleInput("First");
			assert.equal(mouse.handle(event(line.indexOf("ctrl+j"), 23, 80, 24))?.handled, true);
			assert.deepEqual(sent, []);
			composer.handleInput("Second");
			assert.equal(composer.getText(), "First\nSecond");
			composer.handleInput("\r");
			assert.deepEqual(sent, ["First\nSecond"]);
		}
	} finally {
		setKittyProtocolActive(previous);
	}
});
it("action clicks select before execution and help wheel preserves the native back path", async () => {
	const actions: string[] = [];
	const f = fixture(140, 24, source([row("one", { state: "idle" })]), {
		action: async (name) => {
			actions.push(name);
			return undefined;
		},
	});
	const lines = () => f.ui.render(140).map(stripVTControlCharacters);
	const click = (needle: string) => {
		const p = point(lines(), needle);
		return f.ui.handleMouse(event(p.x, p.y, 140, 24));
	};
	try {
		await turn();
		click("a actions");
		click("Configure");
		assert.deepEqual(actions, []);
		click("enter choose");
		await turn();
		assert.deepEqual(actions, ["configure"]);
		f.ui.handleInput("\x1b");
		f.ui.handleInput("?");
		const before = lines().join("\n");
		f.ui.handleMouse(event(5, 5, 140, 24, { type: "wheel", wheelDelta: 5 }));
		assert.notEqual(lines().join("\n"), before);
		click("esc back");
		assert.equal(f.ui.navigation.screen, "roster");
	} finally {
		f.ui.dispose();
	}
});
it("the Actions wheel reaches Details after scrolling past the last action", async () => {
	const actions: string[] = [];
	const f = fixture(140, 24, source([row("one", { state: "idle" })]), {
		action: async (name) => {
			actions.push(name);
			return undefined;
		},
	});
	const lines = () => f.ui.render(140).map(stripVTControlCharacters);
	const click = (needle: string) => {
		const p = point(lines(), needle);
		return f.ui.handleMouse(event(p.x, p.y, 140, 24));
	};
	try {
		await turn();
		click("a actions");
		const p = point(lines(), "Configure");
		assert.equal(f.ui.handleMouse(event(p.x, p.y, 140, 24, { type: "wheel", wheelDelta: 100 }))?.handled, true);
		assert.deepEqual(actions, []);
		click("enter choose");
		await turn();
		assert.deepEqual(actions, ["status"]);
	} finally {
		f.ui.dispose();
	}
});
for (const width of [80, 140]) {
	it(`roster mouse selects, opens, focuses and toggles shared static times at ${width}`, async () => {
		const f = fixture(
			width,
			30,
			source([
				row("alpha", { name: "Agent alpha", state: "done" }),
				row("bravo", { name: "Agent bravo", state: "done" }),
			]),
		);
		const lines = () => f.ui.render(width).map(stripVTControlCharacters);
		const click = (text: string) => {
			const p = point(lines(), text);
			return f.ui.handleMouse(event(p.x, p.y, width, 30));
		};
		try {
			await turn();
			click("Agent bravo");
			await turn();
			assert.equal(f.state.selected, "bravo");
			assert.equal(f.ui.navigation.screen, "roster");
			click("d ago");
			assert.equal(f.state.exactTime, true);
			assert.ok(lines().join("\n").includes(new Date(0).toLocaleString("en-US", { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", hour12: true })));
			f.ui.handleInput("i");
			assert.equal(f.state.exactTime, false);
			click("enter open");
			assert.equal(f.ui.navigation.screen, "console");
			f.ui.handleInput("\x1b");
			lines();
			click("done · send");
			assert.equal(f.ui.navigation.screen, "message");
			f.ui.handleInput("draft retained");
			assert.equal(f.state.agents.get("bravo")?.draft, "draft retained");
			const p = point(lines(), "d ago");
			assert.equal(f.ui.handleMouse(event(p.x, p.y, width, 30, { type: "drag" })), undefined);
			assert.equal(f.state.exactTime, false);
			assert.equal(f.state.agents.get("bravo")?.draft, "draft retained");
			click("done · send");
			click("draft retained");
			f.ui.handleInput("\x1b");
			assert.equal(f.ui.navigation.screen, "roster");
			assert.equal(f.state.agents.get("bravo")?.draft, "draft retained");
			f.resize(width + 1, 30);
			assert.equal(f.ui.handleMouse(event(p.x, p.y, width, 30)), undefined);
		} finally {
			f.ui.dispose();
		}
	});
	it(`wheel over roster keeps the message recipient and conversation wheel keeps focus at ${width}`, async () => {
		const observed = source(Array.from({ length: 15 }, (_, n) => row(`id${n}`, { name: `Agent${n}`, state: "done" })));
		observed.snapshot = async () => ({
			entries: [
				{
					id: "1",
					kind: "pi.user",
					model: [
						{ role: "user", content: Array.from({ length: 100 }, (_, n) => `Line ${n}`).join("\n"), timestamp: 0 },
					],
				},
			],
			partial: false,
			revision: "1",
			nextBefore: null,
		});
		const f = fixture(width, 30, observed);
		try {
			await turn();
			f.ui.handleInput("m");
			f.ui.handleInput("fixed draft");
			const recipient = f.state.selected;
			assert.ok(recipient);
			const before = f.ui.render(width).join("\n");
			f.ui.handleMouse(event(2, 3, width, 30, { type: "wheel", wheelDelta: 3 }));
			assert.equal(f.state.selected, recipient);
			assert.equal(f.ui.navigation.screen, "message");
			assert.equal(f.state.agents.get(recipient)?.draft, "fixed draft");
			assert.notEqual(f.ui.render(width).join("\n"), before);
			f.ui.handleMouse(event(width - 2, 10, width, 30, { type: "wheel", wheelDelta: -3 }));
			assert.equal(f.ui.navigation.screen, "message");
			assert.equal(f.state.agents.get(recipient)?.view.follow, false);
			f.ui.handleInput("\x1b");
			f.ui.handleInput("\x1b[B");
			assert.ok(f.ui.render(width).join("\n").includes("▌"));
		} finally {
			f.ui.dispose();
		}
	});
}

it("lowercase hints retain click actions for every named key", () => {
	const mouse = new DashboardMouse();
	const calls: string[] = [];
	mouse.reset(200, 24);
	const line = mouseHints(mouse, 23, ["Enter open", "Tab message", "Space toggle", "Ctrl+J newline", "Ctrl+O tools", "Ctrl+T thinking", "PgUp/PgDn read"], "Esc back", 200, (key) => calls.push(key));
	assert.equal(line, line.toLowerCase());
	for (const key of ["enter", "tab", "space", "ctrl+j", "ctrl+o", "ctrl+t", "pgup", "pgdn", "esc"]) {
		assert.equal(mouse.handle(event(line.indexOf(key), 23, 200, 24))?.handled, true, key);
	}
	assert.deepEqual(calls, ["\r", "\t", " ", "\x1b[106;5u", "\x0f", "\x14", "\x1b[5~", "\x1b[6~", "\x1b"]);
});

for (const width of [80, 140]) {
	it(`flat roster block clicks select the correct agent at ${width}`, async () => {
		const f = fixture(width, 30, source([row("work", { name: "Worker", modifiedAt: 3 }), row("done", { name: "Finished", state: "done", modifiedAt: 2 }), row("failed", { name: "Failure", state: "failed", error: "quota limit", modifiedAt: 1 })]));
		try {
			await turn();
			const lines = f.ui.render(width).map(stripVTControlCharacters);
			const block = point(lines, "Failure");
			assert.equal(f.ui.handleMouse(event(5, block.y + (width >= 100 ? 2 : 0), width, 30))?.handled, true);
			assert.equal(f.state.selected, "failed");
			await turn();
			const next = point(f.ui.render(width).map(stripVTControlCharacters), "Finished");
			assert.equal(f.ui.handleMouse(event(5, next.y + (width >= 100 ? 1 : 0), width, 30))?.handled, true);
			assert.equal(f.state.selected, "done");
		} finally { f.ui.dispose(); }
	});
}
