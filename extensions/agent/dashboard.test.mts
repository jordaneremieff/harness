import assert from "node:assert/strict";
import { it } from "node:test";
import { fixture, source, row, page, turn } from "./dashboard-test-fixture.mts";
import { agentState } from "./dashboard-state.ts";
it("the dashboard opens on the roster and Esc returns without a primary mutation", async () => {
	const f = fixture();
	await turn();
	assert.equal(f.ui.navigation.screen, "roster");
	assert.match(f.ui.render(80).join("\n"), /storage:1/);
	f.ui.handleInput("x");
	assert.match(f.ui.render(80).join("\n"), /Tab to write/);
	f.ui.handleInput("\x1b");
	assert.equal(f.counts().closes, 1);
});
it("find has a separate text destination and Esc clears the committed filter before close", async () => {
	const f = fixture(80, 24, source([row("one"), row("two")]));
	await turn();
	f.ui.handleInput("/");
	f.ui.handleInput("two");
	f.ui.handleInput("\r");
	assert.equal(f.state.filter, "two");
	assert.equal(f.state.selected, "two");
	f.ui.handleInput("\x1b");
	assert.equal(f.state.filter, "");
	assert.equal(f.counts().closes, 0);
	f.ui.handleInput("\x1b");
	assert.equal(f.counts().closes, 1);
});
it("a late send receipt keeps a newer draft and never changes focus", async () => {
	let finish!: () => void;
	const gate = new Promise<void>((resolve) => {
		finish = resolve;
	});
	const sent: string[] = [];
	const f = fixture(80, 24, source([row("one"), row("two")]), {
		submit: async (input) => {
			sent.push(input.id);
			await gate;
			return { text: "admitted" };
		},
	});
	await turn();
	f.ui.handleInput("\t");
	f.ui.handleInput("first");
	f.ui.handleInput("\r");
	f.ui.handleInput("\x1b");
	f.ui.handleInput("\x1b[B");
	assert.equal(f.state.selected, "two");
	agentState(f.state, "one").draft = "newer";
	finish();
	await turn();
	assert.deepEqual(sent, ["one"]);
	assert.equal(f.state.selected, "two");
	assert.equal(f.ui.navigation.screen, "roster");
	assert.equal(agentState(f.state, "one").draft, "newer");
	f.ui.dispose();
});
it("new agent returns to roster and selects the created identity", async () => {
	const rows = [row("one")];
	const observed = source(rows);
	const f = fixture(80, 24, observed, {
		newAgent: async () => {
			rows.push(row("two"));
			return { text: "Started", sessionId: "two" };
		},
	});
	await turn();
	f.ui.handleInput("n");
	f.ui.handleInput("task");
	f.ui.handleInput("\r");
	await turn();
	assert.equal(f.state.selected, "two");
	assert.equal(f.ui.navigation.screen, "roster");
	assert.equal(f.state.newTask, "");
	f.ui.dispose();
});

it("a conversation that failed to read while its host started rereads when its roster row changes", async (t) => {
	t.mock.timers.enable({ apis: ["setInterval", "setTimeout", "Date"] });
	let current = row("new", { state: "working", modifiedAt: 1 });
	const observed = source([current]);
	let rosterChange = () => {};
	const refreshed: string[] = [];
	let reads = 0;
	observed.subscribeRoster = (listener) => {
		rosterChange = listener;
		return () => {};
	};
	observed.list = async () => page([current]);
	observed.refresh = (id) => refreshed.push(id);
	observed.snapshot = async () => {
		reads++;
		if (reads === 1) throw new Error("ENOENT: no such file or directory, stat '/store/durable/new.sqlite'");
		return {
			entries: [{ id: "1", kind: "pi.user", model: [{ role: "user", content: "Write the note", timestamp: 0 }] }],
			partial: false,
			revision: "2",
			nextBefore: null,
		};
	};
	const f = fixture(80, 24, observed);
	await turn();
	await turn();
	assert.match(f.ui.render(80).join("\n"), /Conversation unavailable/);
	rosterChange();
	t.mock.timers.tick(250);
	await turn();
	assert.deepEqual(refreshed, []);
	current = row("new", { state: "idle", modifiedAt: 2, cost: 0.43 });
	rosterChange();
	t.mock.timers.tick(250);
	await turn();
	await turn();
	assert.deepEqual(refreshed, ["new"]);
	assert.equal(reads, 2);
	const screen = f.ui.render(80).join("\n");
	assert.doesNotMatch(screen, /Conversation unavailable/);
	assert.match(screen, /Write the note/);
	f.ui.dispose();
});

it("Load more is selected before admission and loaded coverage survives reconciliation", async (t) => {
	t.mock.timers.enable({ apis: ["setInterval", "setTimeout", "Date"] });
	const observed = source();
	let rosterChange = () => {};
	const calls: Array<string | undefined> = [];
	observed.subscribeRoster = (listener) => {
		rosterChange = listener;
		return () => {};
	};
	observed.list = async (input) => {
		calls.push(input?.cursor);
		return input?.cursor
			? {
					...page([row("c")]),
					coverage: { complete: true, storagesVisited: 1, skipped: 2, omitted: 0, nextCursor: null },
				}
			: {
					...page([row("a"), row("b")]),
					coverage: { complete: false, storagesVisited: 1, skipped: 1, omitted: 0, nextCursor: "more" },
				};
	};
	const f = fixture(80, 24, observed);
	await turn();
	f.ui.handleInput("\x1b[B");
	f.ui.handleInput("\x1b[B");
	assert.deepEqual(calls, [undefined]);
	assert.match(f.ui.render(80).join("\n"), /› Load more agents/);
	f.ui.handleInput("\r");
	await turn();
	assert.deepEqual(calls, [undefined, "more"]);
	assert.match(f.ui.render(80).join("\n"), /3 agents/);
	rosterChange();
	t.mock.timers.tick(250);
	await turn();
	assert.deepEqual(calls, [undefined, "more", undefined, "more"]);
	assert.match(f.ui.render(80).join("\n"), /3 stores skipped/);
	f.ui.dispose();
});

it("Tasks opens a resolved unloaded conversation, releases its graph, and Esc returns to roster", async () => {
	const observed = source([row("storage")]);
	let active = false;
	let releases = 0;
	const selected: Array<string | undefined> = [];
	observed.select = (id) => selected.push(id);
	observed.releaseTasks = () => {
		if (active) releases++;
		active = false;
	};
	observed.tasks = async () => {
		active = true;
		return {
			scope: "tasks",
			storageId: "storage",
			revision: 1,
			observedAt: new Date(0).toISOString(),
			coverage: { complete: true, live: true },
			labels: [{ conversationId: 2, identity: "storage:2", name: "Child" }],
			tasks: [
				{
					id: 1,
					kind: "turn",
					conversationId: 2,
					background: false,
					abortRequested: false,
					status: "running",
					phase: "model",
					waitsOn: [],
					conversations: [2],
				},
			],
		};
	};
	const f = fixture(80, 24, observed);
	await turn();
	f.ui.handleInput("a");
	f.ui.handleInput("\x1b[B");
	f.ui.handleInput("\x1b[B");
	f.ui.handleInput("\r");
	await turn();
	assert.equal(f.ui.navigation.screen, "tasks");
	f.ui.handleInput("\r");
	await turn();
	assert.equal(f.ui.navigation.screen, "console");
	assert.equal(f.state.selected, "storage:2");
	assert.ok(selected.includes("storage:2"));
	assert.equal(active, false);
	assert.equal(releases, 1);
	const screen = f.ui.render(80).join("\n");
	assert.match(screen, /Child/);
	assert.match(screen, /\$\?/);
	f.ui.handleInput("\x1b");
	assert.equal(f.ui.navigation.screen, "roster");
	f.ui.dispose();
});
