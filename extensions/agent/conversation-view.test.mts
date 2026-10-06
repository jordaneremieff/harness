import assert from "node:assert/strict";
import { it } from "node:test";
import { AssistantMessageComponent, UserMessageComponent } from "@earendil-works/pi-coding-agent";
import type { TUI, TuiMouseEvent } from "@earendil-works/pi-tui";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { stripVTControlCharacters } from "node:util";
import { ConversationView, ConversationHistory, boundedEntries } from "./conversation-view.ts";
import { AgentConversation } from "./dashboard-conversation.ts";
import type { AgentConversationEntry } from "./dashboard-types.ts";
import { agentState, createDashboardState } from "./dashboard-state.ts";
import { fixture } from "./dashboard-test-fixture.mts";
const user = (id: number): AgentConversationEntry => ({
	id: String(id),
	kind: "pi.user",
	model: [{ role: "user", content: `message ${id}`, timestamp: id }],
});
it("a repeated revision does not rebuild or rerender committed components", (t) => {
	const f = fixture();
	const render = t.mock.method(UserMessageComponent.prototype, "render");
	const entries = [user(1), user(2)];
	const conversation = new AgentConversation(entries, "/work", f.tui, false, false);
	conversation.render(80);
	const count = render.mock.callCount();
	conversation.update(entries);
	conversation.render(80);
	assert.equal(render.mock.callCount(), count);
	conversation.update([...entries, user(3)]);
	conversation.render(80);
	assert.equal(render.mock.callCount(), count + 1);
	f.ui.dispose();
});
it("an earlier prepend keeps the current entry anchor", () => {
	const state = agentState(createDashboardState(), "one").view;
	const tui = { requestRender() {} } as TUI;
	const view = new ConversationView(tui, state);
	view.setContent(
		Array.from({ length: 10 }, (_, index) => user(index + 10)),
		[],
		"/work",
	);
	view.render(80, 5);
	view.page(-3);
	view.save();
	const anchor = state.anchor;
	const before = view.render(80, 5);
	view.setContent(
		Array.from({ length: 20 }, (_, index) => user(index)),
		[],
		"/work",
	);
	view.reanchor();
	assert.deepEqual(view.render(80, 5), before);
	assert.deepEqual(state.anchor, anchor);
});
it("loaded-line positions track the visible range, tail and an empty viewport", () => {
	const state = agentState(createDashboardState(), "one").view;
	const view = new ConversationView({ requestRender() {} } as TUI, state);
	view.setContent(
		Array.from({ length: 10 }, (_, index) => user(index)),
		[],
		"/work",
	);
	view.render(80, 5);
	const tail = view.position();
	assert.equal(tail.end, true);
	assert.equal(tail.last, tail.total);
	assert.equal(tail.last - tail.first, 4);
	view.page(-3);
	view.render(80, 5);
	const earlier = view.position();
	assert.equal(earlier.end, false);
	assert.ok(earlier.last < tail.last);
	assert.equal(earlier.last - earlier.first, 4);
	assert.equal(tail.estimated, true);
	assert.equal(earlier.estimated, true);
	view.page(-100);
	view.render(80, 5);
	assert.equal(view.position().estimated, false);
	view.render(80, 0);
	assert.equal(view.position().first, 0);
	assert.equal(view.position().last, 0);
	view.setContent([], [], "/work");
	view.render(80, 5);
	assert.deepEqual(view.position(), { first: 0, last: 0, total: 0, end: true, estimated: false });
});
it("ten thousand retained entries are bounded before renderer construction", () => {
	const entries = Array.from({ length: 10000 }, (_, index) => user(index));
	const bounded = boundedEntries(entries);
	assert.equal(bounded.length, 800);
	assert.equal(bounded[0].id, "9200");
	assert.equal(bounded.at(-1)?.id, "9999");
});

it("history evicts distant pages and reloads the saved newer cursor without joining a gap", () => {
	const history = new ConversationHistory();
	history.tail({
		entries: Array.from({ length: 100 }, (_, index) => user(index + 900)),
		revision: "tail",
		partial: true,
		nextBefore: 900,
	});
	for (let before = 900; before > 0; before -= 100) {
		history.add(
			{
				entries: Array.from({ length: 100 }, (_, index) => user(before - 100 + index)),
				revision: String(before),
				partial: before > 100,
				nextBefore: before > 100 ? before - 100 : null,
			},
			before,
			String(before),
		);
		history.entries(String(before - 100));
	}
	assert.ok(history.loadedEntries <= 800);
	const entries = history.entries("0");
	assert.equal(entries[0].id, "0");
	assert.ok(Number(entries.at(-1)?.id) < 999);
	const newer = history.newer();
	assert.ok(newer);
	assert.ok(newer.upper);
	const upper = newer.upper;
	history.add(
		{
			entries: Array.from({ length: 100 }, (_, index) => user(upper - 100 + index)),
			revision: "reloaded",
			partial: true,
			nextBefore: upper - 100,
		},
		upper,
		String(upper - 101),
	);
	assert.ok(history.entries(String(upper - 101)).some((entry) => entry.id === String(upper - 1)));
	assert.ok(history.loadedEntries <= 800);
});
it("a live tail update preserves an older loaded range and its anchor", () => {
	const history = new ConversationHistory();
	history.tail({ entries: [user(20), user(21)], partial: true, revision: "tail", nextBefore: 20 });
	history.add({ entries: [user(18), user(19)], partial: true, revision: "older", nextBefore: 18 }, 20, "20");
	history.tail({ entries: [user(21), user(22)], partial: true, revision: "next", nextBefore: 21 }, "18");
	assert.deepEqual(
		history.entries("18").map((entry) => entry.id),
		["18", "19", "20", "21", "22"],
	);
});
it("viewport rendering does not render distant committed blocks", (t) => {
	const render = t.mock.method(UserMessageComponent.prototype, "render");
	const state = agentState(createDashboardState(), "one").view;
	const view = new ConversationView({ requestRender() {} } as TUI, state);
	view.setContent(
		Array.from({ length: 10000 }, (_, index) => user(index)),
		[],
		"/work",
	);
	const screen = view.render(80, 10);
	assert.ok(render.mock.callCount() < 100);
	assert.ok(screen.join("\n").includes("9999"));
	const count = render.mock.callCount();
	view.render(80, 10);
	assert.equal(render.mock.callCount(), count);
});
it("an oversized entry has an explicit marker inside the display-input bound", () => {
	const entries = boundedEntries([
		{ id: "1", kind: "pi.user", model: [{ role: "user", content: "x".repeat(5 * 1024 * 1024), timestamp: 0 }] },
	]);
	assert.ok(JSON.stringify(entries).length * 2 < 4 * 1024 * 1024);
	assert.match(JSON.stringify(entries), /Entry display limited/);
});

it("a prepend reuses unchanged committed components", (t) => {
	const render = t.mock.method(UserMessageComponent.prototype, "render");
	const conversation = new AgentConversation([user(2), user(3)], "/work", { requestRender() {} } as TUI, false, false);
	conversation.render(80);
	const before = render.mock.callCount();
	conversation.update([user(1), user(2), user(3)]);
	conversation.render(80);
	assert.equal(render.mock.callCount(), before + 1);
});
it("the display bound returns the cursor immediately before its retained range", () => {
	const history = new ConversationHistory();
	history.tail({
		entries: Array.from({ length: 10000 }, (_, index) => user(index + 1)),
		partial: false,
		revision: "all",
		nextBefore: null,
	});
	history.entries();
	assert.equal(history.earlier(), 9201);
	assert.equal(history.loadedEntries, 800);
});

function assistantEntry(id: string, timestamp: number, content: AssistantMessage["content"]): AgentConversationEntry {
	return { id, kind: "pi.assistant", model: [{ role: "assistant", content, api: "openai-responses", provider: "test", model: "test", timestamp, stopReason: "toolUse", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } }] };
}
const itemClick = (y: number, width = 80, height = 8): TuiMouseEvent => ({ type: "click", button: "left", x: 2, y, screenX: 2, screenY: y, width, height, shift: false, alt: false, ctrl: false, clickCount: 1 });
const readText = (view: ConversationView, height = 8) => view.render(80, height).map(stripVTControlCharacters);

it("individual tool choices survive live updates, eviction, rebuild and view reopen", () => {
	const state = agentState(createDashboardState(), "one").view;
	const tui = { requestRender() {} } as TUI;
	let view = new ConversationView(tui, state);
	const call = assistantEntry("call", 1, [{ type: "toolCall", id: "tool-id", name: "example_tool", arguments: { topic: "first" } }]);
	const done: AgentConversationEntry = { id: "result", kind: "pi.tool-result", model: [{ role: "toolResult", toolCallId: "tool-id", toolName: "example_tool", content: [{ type: "text", text: Array.from({ length: 30 }, (_, i) => `output ${i}`).join("\n") }], isError: false, timestamp: 2 }] };
	view.setContent([call], [], "/work");
	let lines = readText(view);
	assert.ok(view.handleMouse(itemClick(lines.findIndex((line) => line.includes("example_tool")))));
	assert.equal(state.toolExpanded.get("tool-id"), true);
	assert.equal(state.follow, false);
	view.save(); assert.ok(state.anchor, "save before repaint keeps the click anchor");
	view.setContent([call], [done], "/work");
	lines = readText(view, 40);
	assert.match(lines.join("\n"), /output 29/u);
	view.setContent([], [], "/work"); readText(view);
	view.setContent([call, done], [], "/work");
	assert.match(readText(view, 40).join("\n"), /output 29/u);
	state.showThinking = !state.showThinking;
	view.setContent([call, done], [], "/work");
	assert.match(readText(view, 40).join("\n"), /output 29/u);
	view.save(); view = new ConversationView(tui, state);
	view.setContent([call, done], [], "/work");
	assert.match(readText(view, 40).join("\n"), /output 29/u);
});

it("live thinking retains its native instance through commit but resets after eviction and reopen", (t) => {
	const state = agentState(createDashboardState(), "one").view;
	state.showThinking = false;
	const tui = { requestRender() {} } as TUI;
	const updates = t.mock.method(AssistantMessageComponent.prototype, "updateContent");
	let view = new ConversationView(tui, state);
	let live = assistantEntry("live:generation", 42, [{ type: "thinking", thinking: "reasoning sentinel" }]);
	view.setContent([], [live], "/work");
	const instance = updates.mock.calls.at(-1)?.this;
	let lines = readText(view);
	assert.ok(view.handleMouse(itemClick(lines.findIndex((line) => line.includes("Thinking...")))));
	live = assistantEntry("live:generation", 42, [{ type: "thinking", thinking: "updated reasoning sentinel" }]);
	view.setContent([], [live], "/work");
	assert.equal(updates.mock.calls.at(-1)?.this, instance);
	assert.match(readText(view).join("\n"), /updated reasoning sentinel/u);
	const committed = { ...live, id: "100" };
	view.setContent([committed], [], "/work");
	assert.equal(updates.mock.calls.at(-1)?.this, instance);
	assert.match(readText(view).join("\n"), /updated reasoning sentinel/u);
	const next = assistantEntry("live:generation", 43, [{ type: "thinking", thinking: "next turn sentinel" }]);
	view.setContent([committed], [next], "/work");
	assert.notEqual(updates.mock.calls.at(-1)?.this, instance);
	assert.doesNotMatch(readText(view, 20).join("\n"), /next turn sentinel/u);
	view.setContent([], [], "/work"); readText(view);
	view.setContent([committed], [], "/work");
	assert.doesNotMatch(readText(view).join("\n"), /updated reasoning sentinel/u);
	lines = readText(view);
	assert.ok(view.handleMouse(itemClick(lines.findIndex((line) => line.includes("Thinking...")))));
	view.save(); view = new ConversationView(tui, state);
	view.setContent([committed], [], "/work");
	assert.doesNotMatch(readText(view).join("\n"), /updated reasoning sentinel/u);
});

it("a thinking run at the tail stays visible through expand, collapse and updates", () => {
	const state = agentState(createDashboardState(), "one").view; state.showThinking = false;
	const view = new ConversationView({ requestRender() {} } as TUI, state);
	const entry = assistantEntry("long", 1, [{ type: "text", text: Array.from({ length: 70 }, (_, i) => `earlier text ${i}`).join("\n") }, { type: "thinking", thinking: `clicked reasoning\n${"detail\n".repeat(30)}` }]);
	view.setContent([entry], [], "/work");
	let lines = readText(view);
	assert.ok(view.handleMouse(itemClick(lines.findIndex((line) => line.includes("Thinking...")))));
	assert.ok(state.anchor);
	const anchor = { ...state.anchor };
	assert.equal(anchor.id, "long");
	view.save(); assert.deepEqual(state.anchor, anchor);
	lines = readText(view);
	assert.match(lines.join("\n"), /clicked reasoning/u);
	assert.equal(state.follow, false);
	assert.ok(view.handleMouse(itemClick(lines.findIndex((line) => line.includes("clicked reasoning")))));
	lines = readText(view);
	assert.match(lines.join("\n"), /Thinking/u);
	view.setContent([{ ...entry, data: { updated: true } }], [], "/work");
	assert.match(readText(view).join("\n"), /Thinking/u);
});

it("tool collapse clamps an anchor from the middle of a long card and disables follow", () => {
	const state = agentState(createDashboardState(), "one").view; state.expanded = true;
	const view = new ConversationView({ requestRender() {} } as TUI, state);
	const call = assistantEntry("call", 1, [{ type: "toolCall", id: "long-tool", name: "example_tool", arguments: {} }]);
	const done: AgentConversationEntry = { id: "result", kind: "pi.tool-result", model: [{ role: "toolResult", toolCallId: "long-tool", toolName: "example_tool", content: [{ type: "text", text: Array.from({ length: 100 }, (_, i) => `output ${i}`).join("\n") }], isError: false, timestamp: 2 }] };
	view.setContent([call, done], [], "/work"); readText(view);
	assert.ok(view.handleMouse(itemClick(2)));
	const lines = readText(view);
	assert.equal(state.follow, false);
	assert.equal(state.toolExpanded.get("long-tool"), false);
	assert.match(lines.join("\n"), /expand/u);
});

it("transcript clicks leave selection gestures, outside blocks and stale viewport events unhandled", () => {
	const state = agentState(createDashboardState(), "one").view;
	const view = new ConversationView({ requestRender() {} } as TUI, state);
	view.setContent([user(1)], [], "/work");
	readText(view);
	assert.equal(view.handleMouse(itemClick(1)), undefined);
	view.setContent([assistantEntry("thinking", 1, [{ type: "thinking", thinking: "reason" }])], [], "/work");
	const lines = readText(view); const y = lines.findIndex((line) => line.includes("reason"));
	for (const patch of [{ type: "press" }, { type: "drag" }, { type: "release" }, { shift: true }, { alt: true }, { ctrl: true }, { clickCount: 2 }, { button: "right" }, { width: 79 }, { height: 7 }]) assert.equal(view.handleMouse({ ...itemClick(y), ...patch } as TuiMouseEvent), undefined);
	assert.match(readText(view).join("\n"), /reason/u);
	assert.ok(view.handleMouse(itemClick(y)));
	assert.equal(view.handleMouse(itemClick(y)), undefined, "layout must repaint after a toggle");
});


it("collapse from the middle of thinking keeps its label visible before trailing text", () => {
	const state = agentState(createDashboardState(), "one").view;
	state.follow = false; state.scroll = 25; state.showThinking = true;
	const view = new ConversationView({ requestRender() {} } as TUI, state);
	const entry = assistantEntry("deep", 1, [
		{ type: "thinking", thinking: Array.from({ length: 60 }, (_, i) => `thought ${i}`).join("\n") },
		{ type: "text", text: Array.from({ length: 100 }, (_, i) => `after ${i}`).join("\n") },
	]);
	view.setContent([entry], [], "/work");
	assert.match(readText(view).join("\n"), /thought 26/);
	assert.ok(view.handleMouse(itemClick(2)));
	assert.match(readText(view).join("\n"), /Thinking\.\.\./);
	assert.equal(state.follow, false);
	view.setContent([{ ...entry, data: { revision: 2 } }], [], "/work");
	assert.match(readText(view).join("\n"), /Thinking\.\.\./);
});
