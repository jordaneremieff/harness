import assert from "node:assert/strict";
import { it } from "node:test";
import { UserMessageComponent } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
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
	assert.equal(earlier.estimated, false);
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
