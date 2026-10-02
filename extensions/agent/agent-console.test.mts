import assert from "node:assert/strict";
import { it } from "node:test";
import { fixture, turn } from "./dashboard-test-fixture.mts";
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
