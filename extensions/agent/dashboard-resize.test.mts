import assert from "node:assert/strict";
import { it } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { TuiAltScreen, visibleWidth, type Terminal, type TuiMouseEvent, type Component } from "@earendil-works/pi-tui";
import { dashboardGeometry } from "./dashboard-layout.ts";
import { DashboardResize } from "./dashboard-resize.ts";
import { createDashboardState, agentState, updateDraft, type DashboardLayout } from "./dashboard-state.ts";
import { fixture, row, source, turn } from "./dashboard-test-fixture.mts";

function mouse(type: TuiMouseEvent["type"], x = 35, y = 8, patch: Partial<TuiMouseEvent> = {}): TuiMouseEvent {
	return { type, button: "left", x, y, screenX: x, screenY: y, width: 164, height: 44, shift: false, alt: false, ctrl: false, ...patch };
}
function controller(layout: DashboardLayout = {}) {
	const saves: DashboardLayout[] = [];
	const resize = new DashboardResize(layout, () => saves.push({ ...layout }));
	const paint = (width = 164, height = 44, screen = "roster") => {
		resize.begin(width, height, screen);
		const g = dashboardGeometry(width, height, 0, false, 0, 5, layout);
		if (g.wide) resize.add({ kind: "roster", x: g.rosterWidth - 1, y: 1, width: 2, height: height - 2, value: g.rosterWidth, min: 24, max: width - 61 });
		resize.add({ kind: "composer", x: width - 4, y: height - 9, width: 3, height: 1, value: layout.composerRows ?? 5, min: 5, max: 25 });
		return g;
	};
	paint();
	return { resize, saves, layout, paint };
}
for (const width of [60, 80, 99, 100, 120, 164, 240]) {
	it(`geometry preserves minimum panes and preferences at ${width} columns`, () => {
		for (const ratio of [undefined, 0.01, 0.4, 0.99]) {
			const layout = { rosterRatio: ratio, composerRows: 12 };
			const g = dashboardGeometry(width, 44, 14, false, 0, 5, layout);
			assert.equal(g.conversationWidth + (g.wide ? g.rosterWidth + 1 : 0), width);
			if (g.wide) { assert.ok(g.rosterWidth >= 24); assert.ok(g.conversationWidth >= 60); }
			assert.equal(layout.rosterRatio, ratio);
			assert.equal(dashboardGeometry(width, 44, 0, true, 0, 5, layout).conversationWidth, width);
		}
	});
}
it("gutter offset, cell coalescing, capture outside handles and one committed save", () => {
	const f = controller();
	assert.deepEqual(f.resize.handle(mouse("press", 35)), { handled: true, capture: true, render: true });
	assert.deepEqual(f.resize.handle(mouse("drag", 35)), { handled: true, render: false });
	assert.deepEqual(f.saves, []);
	f.resize.handle(mouse("drag", 51));
	assert.equal(Math.round((f.layout.rosterRatio ?? 0) * 163), 52);
	f.paint();
	f.resize.handle(mouse("drag", 300, -20));
	assert.equal(Math.round((f.layout.rosterRatio ?? 0) * 163), 103);
	assert.equal(f.resize.handle(mouse("release", 300, -20))?.handled, true);
	assert.equal(f.saves.length, 1);
});
it("cancel and abandoned gestures restore committed preferences without a write", () => {
	for (const end of ["escape", "move", "press", "key", "dimensions", "screen", "clear"]) {
		const f = controller({ rosterRatio: 0.4, composerRows: 8 });
		f.resize.handle(mouse("press", 64)); f.resize.handle(mouse("drag", 90)); f.paint();
		if (end === "escape") assert.equal(f.resize.input("\x1b"), true);
		if (end === "key") assert.equal(f.resize.input("x"), false);
		if (end === "move" || end === "press") f.resize.handle(mouse(end, 90));
		if (end === "dimensions") f.paint(120);
		if (end === "screen") f.paint(164, 44, "console");
		if (end === "clear") f.resize.clear();
		assert.deepEqual(f.layout, { rosterRatio: 0.4, composerRows: 8 });
		assert.deepEqual(f.saves, []);
		assert.equal(f.resize.selected, undefined);
	}
});
it("selection gestures and modifiers outside the precise strips remain unhandled", () => {
	const f = controller();
	for (const type of ["press", "drag", "release", "click"] as const) assert.equal(f.resize.handle(mouse(type, 10)), undefined);
	for (const patch of [{ shift: true }, { alt: true }, { ctrl: true }, { button: "right" as const }, { clickCount: 3 }]) assert.equal(f.resize.handle(mouse("click", 35, 8, patch)), undefined);
	assert.equal(f.resize.handle(mouse("click", 35, 8, { clickCount: 1 }))?.render, false);
	assert.deepEqual(f.layout, {});
});
it("the key after a lost release starts from committed handle geometry", () => {
	const f = controller();
	f.resize.handle(mouse("press", 35)); f.resize.handle(mouse("drag", 52)); f.paint();
	assert.equal(f.resize.input("r"), false);
	assert.deepEqual(f.layout, {}); assert.equal(f.resize.selected, undefined);
	f.resize.handle(mouse("press", 35)); f.resize.handle(mouse("drag", 36)); f.resize.handle(mouse("release", 36));
	assert.equal(Math.round((f.layout.rosterRatio ?? 0) * 163), 37);
});
it("double-click resets only the selected divider", () => {
	const f = controller({ rosterRatio: 0.4, composerRows: 8 });
	f.resize.handle(mouse("click", 64, 8, { clickCount: 2 }));
	assert.deepEqual(f.layout, { composerRows: 8 });
	f.paint(); f.resize.handle(mouse("click", 161, 35, { clickCount: 2 }));
	assert.deepEqual(f.layout, {});
	assert.deepEqual(f.saves, [{ composerRows: 8 }, {}]);
});
it("a clipped preference restores after stacked and narrow windows", () => {
	const f = controller({ rosterRatio: 0.6 });
	assert.equal(f.paint(100).rosterWidth, 39);
	assert.equal(f.paint(80).wide, false);
	assert.equal(f.paint(240).rosterWidth, 143);
	assert.deepEqual(f.layout, { rosterRatio: 0.6 });
});

interface MouseRuntime {
	renderedOverlayLayouts: Array<{ col: number; row: number; width: number; height: number; entry: { component: Component } }>;
	handleViewportInput(data: string): unknown;
	handleSelectionMouseEvent(raw: unknown): void;
}
function rawDispatcher(component: Component, width: number, height: number, selection?: unknown[]) {
	const native = new TuiAltScreen({ columns: width, rows: height, write() {} } as unknown as Terminal, false);
	native.requestRender = () => {};
	// Exercise installed SGR parsing and capture dispatch without starting a terminal.
	const runtime = native as unknown as MouseRuntime;
	runtime.renderedOverlayLayouts = [{ col: 0, row: 0, width, height, entry: { component } }];
	if (selection) runtime.handleSelectionMouseEvent = (raw) => { selection.push(raw); };
	return Object.assign((button: number, x: number, y: number, release = false) => runtime.handleViewportInput(`\x1b[<${button};${x + 1};${y + 1}${release ? "m" : "M"}`), { input: (data: string) => runtime.handleViewportInput(data) });
}
it("raw SGR drag dispatch reaches the dashboard across rerenders without changing drafts or focus", async () => {
	const saved: DashboardLayout[] = [];
	const f = fixture(164, 44, source([row("one"), row("two")]), { saveLayout: (value) => saved.push(value) });
	try {
		await turn();
		const state = agentState(f.state, "one"); updateDraft(state, "literal r 🧩"); state.draftRevision = 7;
		const render = () => { const lines = f.ui.render(164); assert.equal(lines.length, 44); assert.ok(lines.every((line) => visibleWidth(line) === 164)); return lines.map(stripVTControlCharacters); };
		render();
		const send = rawDispatcher(f.ui, 164, 44);
		send(0, 35, 8); render(); send(32, 51, 8);
		assert.match(render().at(-1) ?? "", /roster 52 · detail 111/);
		send(0, 51, 8, true); render();
		assert.equal(Math.round((f.state.layout.rosterRatio ?? 0) * 163), 52);
		assert.equal(saved.length, 1);
		assert.equal(f.state.selected, "one"); assert.equal(f.ui.navigation.screen, "roster");
		assert.equal(state.draft, "literal r 🧩"); assert.equal(state.draftRevision, 7);
		// A moved press stays a drag even after it returns to its starting cell.
		send(0, 52, 8); send(32, 60, 8); render(); send(32, 52, 8); render(); send(0, 52, 8, true); render();
		assert.equal(saved.length, 1); assert.equal(f.ui.navigation.screen, "roster");
		// Pi's stationary completed clicks carry the reset count.
		send(0, 52, 8); send(0, 52, 8, true); render();
		send(0, 52, 8); send(0, 52, 8, true); render();
		assert.equal(f.state.layout.rosterRatio, undefined);
		assert.equal(saved.length, 2);
		f.ui.handleInput("\t"); f.ui.render(164); f.ui.handleInput("r");
		assert.equal(agentState(f.state, "one").draft, "literal r 🧩r");
	} finally { f.ui.dispose(); }
});
it("raw composer grip drag increases rows, preserves its caption and resets on double-click", async () => {
	const f = fixture(164, 44);
	try {
		await turn();
		const render = () => f.ui.render(164).map(stripVTControlCharacters);
		const lines = render(); const y = lines.findIndex((line) => line.includes("┄┄┄")); assert.ok(y > 0);
		const send = rawDispatcher(f.ui, 164, 44);
		send(0, 161, y); render(); send(32, 161, y - 4); const dragged = render(); send(0, 161, y - 4, true);
		assert.equal(f.state.layout.composerRows, 9);
		assert.match(dragged.at(-1) ?? "", /draft 9/);
		assert.ok(dragged.some((line) => line.includes("━━━")));
		assert.ok(dragged.some((line) => line.includes("model │")));
		assert.ok(dragged.some((line) => line.includes("steer at next step")));
		const resetY = render().findIndex((line) => line.includes("┄┄┄"));
		send(0, 161, resetY); send(0, 161, resetY, true); render(); send(0, 161, resetY); send(0, 161, resetY, true); render();
		assert.equal(f.state.layout.composerRows, undefined);
	} finally { f.ui.dispose(); }
});
it("r on the roster is unbound and leaves the split and hints unchanged", async () => {
	const saved: DashboardLayout[] = [];
	const f = fixture(164, 44, source(), { saveLayout: (layout) => saved.push(layout) });
	try {
		await turn();
		const footer = stripVTControlCharacters(f.ui.render(164).at(-1) ?? "");
		assert.doesNotMatch(footer, /r resize/);
		f.ui.handleInput("r");
		const lines = f.ui.render(164).map(stripVTControlCharacters);
		assert.equal(f.ui.navigation.screen, "roster");
		assert.deepEqual(f.state.layout, {}); assert.deepEqual(saved, []);
		assert.equal(lines.at(-1), footer);
		assert.match(lines.join("\n"), /Tab to write to/);
		f.ui.handleInput("\x1b[C"); f.ui.handleInput("0");
		assert.deepEqual(f.state.layout, {});
		f.ui.handleInput("\t"); assert.equal(f.ui.navigation.screen, "message");
	} finally { f.ui.dispose(); }
});
it("short windows hide the composer grip without discarding the saved row preference", async () => {
	const saved: DashboardLayout[] = [];
	const f = fixture(164, 44, source(), { saveLayout: (layout) => saved.push(layout) });
	try {
		await turn();
		const y = f.ui.render(164).findIndex((line) => line.includes("┄┄┄")); assert.ok(y > 0);
		const send = rawDispatcher(f.ui, 164, 44);
		send(0, 161, y); send(32, 161, y - 1); f.ui.render(164); send(0, 161, y - 1, true);
		assert.deepEqual(saved, [{ composerRows: 6 }]);
		f.resize(80, 20); const small = f.ui.render(80);
		assert.equal(small.length, 20); assert.ok(!small.some((line) => line.includes("┄┄┄")));
		assert.equal(f.state.layout.composerRows, 6);
		f.resize(164, 44); assert.ok(f.ui.render(164).some((line) => line.includes("┄┄┄")));
		assert.equal(f.state.layout.composerRows, 6); assert.deepEqual(saved, [{ composerRows: 6 }]);
	} finally { f.ui.dispose(); }
});
it("save failure retains the local split and gives a restart notice", async () => {
	const f = fixture(164, 44, source(), { saveLayout() { throw new Error("rename failed"); } });
	try {
		await turn(); f.ui.render(164);
		const send = rawDispatcher(f.ui, 164, 44);
		send(0, 35, 8); send(32, 51, 8); f.ui.render(164); send(0, 51, 8, true);
		assert.ok(f.state.layout.rosterRatio);
		assert.match(f.ui.render(164).join("\n"), /restart persistence failed/);
	} finally { f.ui.dispose(); }
});
it("raw text drags use the native fallback and focus loss clears the abandoned resize", async () => {
	const f = fixture(164, 44); const selection: unknown[] = [];
	try {
		await turn(); f.ui.render(164); const send = rawDispatcher(f.ui, 164, 44, selection);
		send(0, 8, 8); send(32, 12, 8); send(0, 12, 8, true);
		assert.equal(selection.length, 3); assert.deepEqual(f.state.layout, {});
		send(0, 35, 8); send(32, 60, 8); f.ui.render(164); assert.ok(f.state.layout.rosterRatio);
		send.input("\x1b[O"); send(35, 60, 8); f.ui.render(164);
		assert.deepEqual(f.state.layout, {});
		// Captured bounds are stale after a terminal resize, even before the next render.
		send(0, 35, 8); send(32, 60, 8); f.resize(120, 32); send(32, 70, 8); send(0, 70, 8, true);
		assert.deepEqual(f.state.layout, {}); assert.equal(f.ui.navigation.screen, "roster");
	} finally { f.ui.dispose(); }
});
it("width and height changes preserve an entry reading anchor rather than resuming the tail", async () => {
	const observed = source();
	observed.snapshot = async () => ({ entries: [{ id: "entry", kind: "pi.user", model: [{ role: "user", content: Array.from({ length: 200 }, (_, i) => `Recorded line ${i}`).join("\n"), timestamp: 0 }] }], partial: false, revision: "1" });
	const f = fixture(164, 44, observed);
	try {
		await turn(); f.ui.render(164); f.ui.handleInput("\x1b[5~"); f.ui.render(164);
		const view = agentState(f.state, "storage:1").view;
		assert.equal(view.follow, false); const anchor = { ...view.anchor }; assert.equal(anchor.id, "entry");
		f.resize(120, 32); f.ui.render(120); assert.equal(view.follow, false); assert.deepEqual(view.anchor, anchor);
		f.resize(240, 44); f.ui.render(240); assert.equal(view.follow, false); assert.deepEqual(view.anchor, anchor);
	} finally { f.ui.dispose(); }
});
it("fresh dashboard state owns its layout separately", () => {
	const a = createDashboardState(); const b = createDashboardState(); a.layout.composerRows = 7; assert.deepEqual(b.layout, {});
});
