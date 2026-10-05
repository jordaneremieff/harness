import assert from "node:assert/strict";
import { it } from "node:test";
import { fixture, turn, row, source, conversationFrame } from "./dashboard-test-fixture.mts";
import { agentState } from "./dashboard-state.ts";
it("opened console focuses the editor and routes all letters and slash text only to the agent", async () => {
	const sent: Array<{ id: string; text: string; mode: string }> = [];
	const f = fixture(80, 24, undefined, {
		submit: async (input) => {
			sent.push(input);
			return { text: "admitted" };
		},
	});
	await turn();
	f.ui.handleInput("\r");
	f.ui.render(80);
	f.ui.handleInput("/help n a ? !literal");
	f.ui.handleInput("\t");
	assert.equal(agentState(f.state, "storage:1").mode, "followUp");
	f.ui.handleInput("\r");
	await turn();
	assert.deepEqual(sent, [{ id: "storage:1", text: "/help n a ? !literal", mode: "followUp" }]);
	assert.equal(agentState(f.state, "storage:1").mode, "steer");
	f.ui.handleInput("\x1b");
	assert.equal(f.ui.navigation.screen, "roster");
	f.ui.dispose();
});
it("refused admission retains the draft and disposition", async () => {
	const f = fixture(80, 24, undefined, {
		submit: async () => {
			throw new Error("owner refused");
		},
	});
	await turn();
	f.ui.handleInput("\t");
	f.ui.handleInput("retained");
	f.ui.handleInput("\t");
	f.ui.handleInput("\r");
	await turn();
	const state = agentState(f.state, "storage:1");
	assert.equal(state.draft, "retained");
	assert.equal(state.mode, "followUp");
	assert.match(state.receipt ?? "", /Delivery not confirmed/);
	f.ui.dispose();
});

it("composer caption shows target state, delivery mode and known model, context and cost facts", async () => {
	const observed = source([row("one", { name: "Recipient" })]);
	const base = conversationFrame();
	const usage = { input: 160, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 160, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
	observed.frame = () => conversationFrame({ entries: [{ id: "1", kind: "pi.assistant", model: [{ role: "assistant", provider: "test", model: "model", api: "openai-responses", timestamp: 0, content: [], stopReason: "stop", usage }] }], status: { ...base.status, usage: { models: { "test/model": usage }, tools: {} } } });
	observed.availability = () => ({ state: "live", at: base.observedAt });
	const f = fixture(164, 30, observed, { contextWindow: () => 1000 });
	try {
		await turn();
		assert.match(f.ui.render(164).join("\n"), /working · steer at next step · test\/model · high · 16% ctx · \$0.42/);
		f.ui.handleInput("\t");
		f.ui.handleInput("\t");
		assert.match(f.ui.render(164).join("\n"), /working · follow-up after answer/);
		assert.doesNotMatch(f.ui.render(164).join("\n"), /Message Recipient/);
	} finally { f.ui.dispose(); }
	const absent = fixture(100, 30, source([row("empty", { state: "idle", model: undefined, cost: Number.NaN })]));
	try {
		await turn();
		const caption = absent.ui.render(100).find((line) => line.includes("╭─ idle · send"));
		assert.ok(caption);
		assert.doesNotMatch(caption, /unknown|unavailable|\?|Model|ctx|\$/);
	} finally { absent.ui.dispose(); }
});
