import assert from "node:assert/strict";
import { it } from "node:test";
import { fixture, source, row, turn, conversationFrame, page, theme, deferred } from "./dashboard-test-fixture.mts";
import { rosterLines, argumentSummary, activityOf } from "./dashboard-roster.ts";
import { dashboardGeometry } from "./dashboard-layout.ts";

it("activity summarizes string arguments without raw JSON, including published partial arguments", () => {
	assert.equal(argumentSummary('{"count":1,"path":"notes.md","text":"other"}'), "notes.md");
	assert.equal(argumentSummary('{"text":"first\\n second"'), "first second");
	assert.equal(argumentSummary('{"count":1,"enabled":true}'), "");
	assert.equal(argumentSummary("notes.md"), "notes.md");
	const agent = row("worker", { currentTool: { name: "any_tool", argument: '{"content":"review the notes"}' } });
	assert.equal(activityOf(agent), "any_tool review the notes");
	assert.doesNotMatch(activityOf(agent), /[{}]/);
});
it("roster rows show identity, state, activity, model, thinking, cost and relative time", () => {
	const agent = row("worker", { name: "Research", modifiedAt: 0, currentTool: { name: "read", argument: "notes.md" }, profile: { identity: "worker", role: "Research", handle: "@research", revision: "1", hasExpertise: false, updatedAt: 0 } });
	const text = rosterLines([agent], agent.id, 64, 12, 15 * 60000, theme, false).join("\n");
	for (const fact of ["@research · Research", "Working", "read notes.md", "test/model high", "$0.42", "15m ago"]) assert.ok(text.includes(fact), fact);
	assert.ok(dashboardGeometry(160, 45, 3).rosterWidth > 38);
	assert.match(rosterLines([row("worker", { name: "Work", currentTool: { name: "read", argument: "file" } })], "worker", 100, 4, 0, theme, true).join("\n"), /Work.*Working · read.*model high.*\$0.42.*just now/);
});
it("selected status keeps live usage and receipts separate from conversation and roster notices", async () => {
	const usage = { input: 100, output: 20, cacheRead: 30, cacheWrite: 10, totalTokens: 160, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
	const initial = conversationFrame();
	const frame = conversationFrame({ entries: [{ id: "1", kind: "pi.assistant", model: [{ role: "assistant", api: "openai-responses", provider: "test", model: "model", content: [], timestamp: 0, stopReason: "stop", usage }] }], status: { ...initial.status, usage: { models: { "test/model": usage }, tools: {} } } });
	const observed = source([row("one")]);
	observed.frame = () => frame;
	observed.availability = () => ({ state: "live", at: frame.observedAt });
	const f = fixture(160, 45, observed, { contextWindow: () => 1000, sessionFigures: async () => "agents this session: 1 working · 1 total · $0.42" });
	try {
		await turn();
		const state = f.state.agents.get("one");
		assert.ok(state);
		state.receipt = "Message admitted";
		const lines = f.ui.render(160);
		assert.match(lines[0], /Agents this session: 1 working · 1 total · \$0.42/);
		const boundary = lines.findIndex((line) => line.startsWith("─ "));
		const status = lines.slice(boundary + 1, lines.findIndex((line) => line.startsWith("╭─ Message to"))).join("\n");
		assert.doesNotMatch(status, /LIVE|RETAINED|Earlier messages available|Roster/);
		assert.match(status, /working · Responding/);
		assert.match(status, /test\/model · high/);
		assert.match(status, /context 160\/1.0k \(16%\) · tokens 140 in\/20 out/);
		assert.match(status, /Message admitted/);
	} finally { f.ui.dispose(); }
});
it("a late session total read does not recreate the selection after close", async () => {
	const gate = deferred<string>();
	const f = fixture(100, 30, source(), { sessionFigures: () => gate.promise });
	await turn();
	f.ui.dispose();
	gate.resolve("agents this session: 1 working · 1 total · $0.42");
	await turn();
	assert.equal(f.state.selected, undefined);
	assert.equal(f.state.agents.size, 0);
});
it("failed roster refresh keeps rows, suppresses transient errors and clears a persistent notice after success", async (t) => {
	t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
	let fail = false;
	let changed = () => {};
	const observed = source([row("good")]);
	observed.subscribeRoster = (listener) => { changed = listener; return () => {}; };
	observed.list = async () => { if (fail) throw new Error("refresh failure"); return page([row("good")]); };
	const f = fixture(100, 30, observed);
	const refresh = async () => { changed(); t.mock.timers.tick(250); await turn(); };
	try {
		await turn();
		fail = true;
		await refresh();
		assert.match(f.ui.render(100).join("\n"), /good/);
		assert.doesNotMatch(f.ui.render(100).join("\n"), /refresh failure/);
		await refresh(); await refresh();
		assert.match(f.ui.render(100).join("\n"), /Roster refresh unavailable; last roster shown/);
		fail = false;
		await refresh();
		assert.doesNotMatch(f.ui.render(100).join("\n"), /Roster refresh unavailable|refresh failure/);
	} finally { f.ui.dispose(); }
});
