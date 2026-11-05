import assert from "node:assert/strict";
import { it } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { Text, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { DashboardMouse } from "./dashboard-mouse.ts";
import { fixture, row, source, turn } from "./dashboard-test-fixture.mts";
import { agentState, createDashboardState } from "./dashboard-state.ts";
import type { AgentConversationEntry } from "./dashboard-types.ts";

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
/** Visible text: styling and the zero-width cursor markers removed, so columns match the screen. */
const visible = (lines: string[]) => lines.map((line) => stripVTControlCharacters(line.replace(/\x1b_[^\x07]*\x07/g, "")));

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

it("a control click opens its form beside the conversation, the inspector wheel scrolls, and the way out returns", async () => {
	const f = fixture(140, 24, source([row("one", { state: "idle" })]));
	const lines = () => visible(f.ui.render(140));
	const click = (needle: string) => {
		const p = point(lines(), needle);
		return f.ui.handleMouse(event(p.x, p.y, 140, 24));
	};
	try {
		await turn();
		await turn();
		click("c configure");
		assert.equal(f.ui.focus.inspector, "Configure");
		assert.deepEqual(f.calls, [], "opening a form sends nothing");
		f.ui.handleInput("\x1b");
		assert.equal(f.ui.focus.inspector, undefined);
		f.ui.handleInput("\x1b");
		assert.equal(f.ui.focus.region, "list");
		click("? help");
		assert.equal(f.ui.focus.inspector, "Help");
		const before = lines().join("\n");
		const body = point(lines(), "Machine execution preferences");
		f.ui.handleMouse(event(body.x, body.y + 1, 140, 24, { type: "wheel", wheelDelta: 5 }));
		assert.notEqual(lines().join("\n"), before, "the wheel over the inspector reads further");
		click("close help");
		assert.equal(f.ui.focus.inspector, undefined);
		assert.deepEqual(f.calls, []);
	} finally {
		f.ui.dispose();
	}
});

it("the More menu wheel reaches Details and opens it only when chosen", async () => {
	const f = fixture(140, 24, source([row("one", { state: "idle" })]));
	const lines = () => visible(f.ui.render(140));
	try {
		await turn();
		await turn();
		const footer = lines().at(-1) ?? "";
		const more = footer.lastIndexOf("x more");
		assert.ok(more >= 0);
		f.ui.handleMouse(event(more + 1, lines().length - 1, 140, 24));
		const menu = lines().findIndex((line) => line.trimEnd() === "More");
		assert.ok(menu >= 0, "the More menu shows its heading");
		assert.equal(f.ui.handleMouse(event(2, menu + 1, 140, 24, { type: "wheel", wheelDelta: 100 }))?.handled, true);
		assert.match(lines().join("\n"), /›\s+i\s+Exact times/, "the wheel moves the menu selection only");
		assert.equal(f.ui.focus.inspector, undefined);
		f.ui.handleInput("\x1b[A");
		assert.match(lines().join("\n"), /›\s+Stop and release host/);
		f.ui.handleInput("\x1b[A");
		assert.match(lines().join("\n"), /›\s+Details/);
		f.ui.handleInput("\r");
		assert.equal(f.ui.focus.inspector, "Details");
		assert.deepEqual(f.calls, []);
	} finally {
		f.ui.dispose();
	}
});

for (const width of [80, 140]) {
	it(`list clicks select passively, times toggle by click, and the message field keeps its draft at ${width}`, async () => {
		const f = fixture(
			width,
			30,
			source([
				row("alpha", { name: "Agent alpha", state: "done" }),
				row("bravo", { name: "Agent bravo", state: "done" }),
			]),
		);
		const lines = () => visible(f.ui.render(width));
		const click = (text: string) => {
			const p = point(lines(), text);
			return f.ui.handleMouse(event(p.x, p.y, width, 30));
		};
		try {
			await turn();
			click("Agent bravo");
			await turn();
			assert.equal(f.state.selected, "bravo");
			assert.equal(f.ui.focus.region, "list");
			click("d ago");
			assert.equal(f.state.exactTime, true);
			const exact = new Date(0).toLocaleString("en-US", { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", hour12: true });
			assert.ok(lines().join("\n").includes(exact));
			click(exact);
			assert.equal(f.state.exactTime, false, "a second click on a time switches it back");
			const field = point(lines(), "╭─ To Agent bravo");
			assert.equal(f.ui.handleMouse(event(field.x + 3, field.y + 1, width, 30))?.handled, true);
			assert.equal(f.ui.focus.region, "composer");
			f.ui.handleInput("draft retained");
			assert.equal(f.state.agents.get("bravo")?.draft, "draft retained");
			const p = point(lines(), "d ago");
			assert.equal(f.ui.handleMouse(event(p.x, p.y, width, 30, { type: "drag" })), undefined);
			assert.equal(f.state.exactTime, false);
			f.ui.handleInput("\x1b");
			assert.equal(f.ui.focus.region, "list");
			assert.equal(f.state.agents.get("bravo")?.draft, "draft retained");
			click("Agent alpha");
			await turn();
			assert.equal(f.state.agents.get("alpha")?.draft ?? "", "", "selection never moves a draft between agents");
			assert.equal(f.state.agents.get("bravo")?.draft, "draft retained");
			f.resize(width + 1, 30);
			assert.equal(f.ui.handleMouse(event(p.x, p.y, width, 30)), undefined, "a click drawn for another size acts on nothing");
		} finally {
			f.ui.dispose();
		}
	});
	it(`wheel over the list keeps the message recipient and the conversation wheel keeps focus at ${width}`, async () => {
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
			await turn();
			f.ui.handleInput("\r");
			f.ui.handleInput("fixed draft");
			const recipient = f.state.selected;
			assert.ok(recipient);
			const before = f.ui.render(width).join("\n");
			f.ui.handleMouse(event(2, 3, width, 30, { type: "wheel", wheelDelta: 3 }));
			assert.equal(f.state.selected, recipient);
			assert.equal(f.ui.focus.region, "composer");
			assert.equal(f.state.agents.get(recipient)?.draft, "fixed draft");
			assert.notEqual(f.ui.render(width).join("\n"), before);
			const line = point(visible(f.ui.render(width)), "Line 9");
			f.ui.handleMouse(event(line.x, line.y, width, 30, { type: "wheel", wheelDelta: -3 }));
			assert.equal(f.ui.focus.region, "composer");
			assert.equal(f.state.agents.get(recipient)?.view.follow, false);
			f.ui.handleInput("\x1b");
			f.ui.handleInput("\x1b[B");
			assert.ok(f.ui.render(width).join("\n").includes("▌"));
		} finally {
			f.ui.dispose();
		}
	});
}

for (const width of [80, 140]) {
	it(`flat roster block clicks select the correct agent at ${width}`, async () => {
		const f = fixture(width, 30, source([row("work", { name: "Worker", modifiedAt: 3 }), row("done", { name: "Finished", state: "done", modifiedAt: 2 }), row("failed", { name: "Failure", state: "failed", error: "quota limit", modifiedAt: 1 })]));
		try {
			await turn();
			// The side list shows all three agents; the 80-column strip shows the newest two.
			const target = width >= 100 ? { name: "Failure", id: "failed" } : { name: "Finished", id: "done" };
			const lines = f.ui.render(width).map(stripVTControlCharacters);
			const block = point(lines, target.name);
			assert.equal(f.ui.handleMouse(event(5, block.y + 1, width, 30))?.handled, true, "a click on the facts line selects its agent");
			assert.equal(f.state.selected, target.id);
			await turn();
			const next = point(f.ui.render(width).map(stripVTControlCharacters), "Worker");
			assert.equal(f.ui.handleMouse(event(5, next.y, width, 30))?.handled, true, "a click on the name line selects its agent");
			assert.equal(f.state.selected, "work");
		} finally { f.ui.dispose(); }
	});
}

const interactiveUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const interactiveEntries: AgentConversationEntry[] = [
	{ id: "user", kind: "pi.user", model: [{ role: "user", content: "Outside card sentinel", timestamp: 1 }] },
	// A thinking-only message keeps its hidden-thinking row; a message with a tool call shows the tool instead.
	{ id: "thinking", kind: "pi.assistant", model: [{ role: "assistant", content: [{ type: "thinking", thinking: "Thinking run sentinel" }], api: "openai-responses", provider: "test", model: "test", timestamp: 2, stopReason: "stop", usage: interactiveUsage }] },
	{ id: "assistant", kind: "pi.assistant", model: [{ role: "assistant", content: [{ type: "toolCall", id: "clicked-tool", name: "example_tool", arguments: { topic: "named" } }], api: "openai-responses", provider: "test", model: "test", timestamp: 3, stopReason: "toolUse", usage: interactiveUsage }] },
];
for (const [width, height] of [[140, 45], [80, 32]]) for (const start of ["list", "composer", "conversation"] as const) {
	it(`single transcript clicks toggle tools and thinking from the ${start} at ${width} and move focus to the conversation`, async () => {
		const observed = source(); observed.snapshot = async () => ({ entries: interactiveEntries, partial: false, revision: "interactive", nextBefore: null });
		const retained = createDashboardState(); retained.hideThinkingBlock = true;
		const f = fixture(width, height, observed, undefined, retained);
		try {
			await turn();
			await turn();
			if (start === "composer") f.ui.handleInput("\r");
			if (start === "conversation") f.ui.handleInput("\t");
			assert.equal(f.ui.focus.region, start);
			const read = () => visible(f.ui.render(width));
			const tool = point(read(), "example_tool");
			for (const patch of [{ type: "press" }, { type: "drag" }, { type: "release" }, { ctrl: true }, { shift: true }, { alt: true }, { clickCount: 2 }]) assert.equal(f.ui.handleMouse(event(tool.x, tool.y, width, height, patch as Partial<TuiMouseEvent>)), undefined);
			assert.ok(f.ui.handleMouse(event(tool.x, tool.y, width, height))?.handled);
			assert.equal(f.ui.focus.region, "conversation");
			const state = agentState(retained, "storage:1").view;
			assert.equal(state.toolExpanded.get("clicked-tool"), true);
			assert.equal(state.follow, false);
			const thinking = point(read(), "▸ Thinking");
			assert.ok(f.ui.handleMouse(event(thinking.x, thinking.y, width, height))?.handled);
			assert.match(read().join("\n"), /Thinking run sentinel/u);
			const shown = point(read(), "Thinking run sentinel");
			assert.ok(f.ui.handleMouse(event(shown.x, shown.y, width, height))?.handled);
			assert.doesNotMatch(read().join("\n"), /Thinking run sentinel/u);
			f.ui.render(width);
			f.ui.handleInput("\x0f");
			assert.equal(state.toolExpanded.size, 0);
			assert.equal(state.expanded, true);
			f.ui.handleInput("\x14");
			assert.match(read().join("\n"), /Thinking run sentinel/u);
			assert.equal(state.showThinking, true);
			assert.deepEqual(f.calls, []);
		} finally { f.ui.dispose(); }
	});
}
it("a top region callback returning false never activates an earlier region", () => {
	const mouse = new DashboardMouse(); mouse.reset(80, 24);
	let earlier = 0;
	mouse.add({ x: 0, y: 0, width: 10, height: 10, click: () => earlier++ });
	mouse.add({ x: 0, y: 0, width: 10, height: 10, click: () => false });
	assert.equal(mouse.handle(event(2, 2, 80, 24)), undefined);
	assert.equal(earlier, 0);
});

it("dashboard reopen retains tool choices and anchor but not discarded thinking instances", async () => {
	const observed = source(); observed.snapshot = async () => ({ entries: interactiveEntries, partial: false, revision: "interactive", nextBefore: null });
	const retained = createDashboardState(); retained.hideThinkingBlock = true;
	let f = fixture(140, 45, observed, undefined, retained);
	try {
		await turn();
		let lines = f.ui.render(140).map(stripVTControlCharacters);
		let item = point(lines, "example_tool");
		assert.ok(f.ui.handleMouse(event(item.x, item.y, 140, 45))?.handled);
		lines = f.ui.render(140).map(stripVTControlCharacters);
		item = point(lines, "▸ Thinking");
		assert.ok(f.ui.handleMouse(event(item.x, item.y, 140, 45))?.handled);
		const state = agentState(retained, "storage:1").view;
		const anchor = state.anchor;
		f.ui.dispose();
		f = fixture(140, 45, observed, undefined, retained);
		await turn();
		lines = f.ui.render(140).map(stripVTControlCharacters);
		assert.doesNotMatch(lines.join("\n"), /Thinking run sentinel/u);
		assert.match(lines.join("\n"), /topic: named/u);
		assert.equal(state.toolExpanded.get("clicked-tool"), true);
		assert.match(lines.join("\n"), /▸ Thinking/u);
		assert.deepEqual(state.anchor, anchor);
		assert.equal(state.follow, false);
	} finally { f.ui.dispose(); }
});


it("dashboard reopen uses the current runtime renderer rather than a retained definition", async () => {
	const observed = source(); observed.snapshot = async () => ({ entries: interactiveEntries, partial: false, revision: "custom", nextBefore: null });
	for (const title of ["first runtime", "second runtime", undefined]) {
		const retained = createDashboardState();
		const f = fixture(140, 45, observed, { toolDisplay: () => title ? { renderCall: () => new Text(title) } : undefined }, retained);
		try {
			await turn();
			const lines = f.ui.render(140).map(stripVTControlCharacters);
			assert.match(lines.join("\n"), /example_tool · /u, "the collapsed tool is one summary line");
			const item = point(lines, "example_tool");
			assert.ok(f.ui.handleMouse(event(item.x, item.y, 140, 45))?.handled);
			const text = f.ui.render(140).map(stripVTControlCharacters).join("\n");
			assert.ok(text.includes(title ?? "example_tool"));
			if (title !== "first runtime") assert.doesNotMatch(text, /first runtime/);
			if (title !== "second runtime") assert.doesNotMatch(text, /second runtime/);
		} finally { f.ui.dispose(); }
	}
});
