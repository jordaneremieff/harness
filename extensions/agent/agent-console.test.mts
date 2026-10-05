import assert from "node:assert/strict";
import { it } from "node:test";
import { fixture, turn, row, source, conversationFrame } from "./dashboard-test-fixture.mts";
import { agentState, updateDraft } from "./dashboard-state.ts";
import { stripVTControlCharacters } from "node:util";
import { sliceByColumn, visibleWidth } from "@earendil-works/pi-tui";
import { dashboardGeometry } from "./dashboard-layout.ts";
import { sessionAppearance } from "./dashboard-roster.ts";
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

function factSource(state: "working" | "idle" | "failed") {
	const observed = source([row("one", { name: "Recipient", state, error: state === "failed" ? "quota limit" : undefined, profile: { identity: "one", role: "", handle: "@recipient", revision: "1", hasExpertise: false, updatedAt: 0 } })]);
	const base = conversationFrame();
	const usage = { input: 100, output: 20, cacheRead: 30, cacheWrite: 10, totalTokens: 160, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
	observed.frame = () => conversationFrame({ entries: [{ id: "1", kind: "pi.assistant", model: [{ role: "assistant", provider: "test", model: "model", api: "openai-responses", timestamp: 0, content: [], stopReason: "stop", usage }] }], status: { ...base.status, busy: state === "working", usage: { models: { "test/model": usage }, tools: {} } } });
	observed.availability = () => ({ state: "live", at: base.observedAt });
	return observed;
}
for (const state of ["working", "idle", "failed"] as const) {
	for (const width of [164, 100, 80, 60]) {
		for (const consoleView of [false, true]) {
			it(`${state} right pane assigns each fact once at ${width} columns in ${consoleView ? "console" : "roster"}`, async () => {
				const f = fixture(width, 30, factSource(state), { contextWindow: () => 1000 });
				try {
					await turn(); if (consoleView) f.ui.handleInput("\r");
					const lines = f.ui.render(width).map(stripVTControlCharacters);
					assert.equal(lines.length, 30); assert.ok(lines.every((line) => visibleWidth(line) === width));
					const geometry = dashboardGeometry(width, 30, 0, consoleView);
					const paneX = geometry.wide ? geometry.rosterWidth + 1 : 0;
					const paneY = consoleView || geometry.wide ? 1 : 5;
					const right = lines.slice(paneY, -1).map((line) => sliceByColumn(line, paneX, width)).join("\n");
					const header = lines.slice(paneY, paneY + 2).map((line) => sliceByColumn(line, paneX, width));
					assert.match(header[0] ?? "", /@recipient · Recipient/);
					assert.match(header[1] ?? "", /test\/model · high/);
					assert.doesNotMatch(header.join("\n"), /ctx| in| out|\$/);
					for (const fact of ["test/model", "high", sessionAppearance[state].label, "160/1.0k (16%) ctx", "$0.42"]) assert.equal(right.split(fact).length - 1, 1, `${fact}: ${right}`);
					const caption = lines.slice(paneY).find((line) => line.includes("╭─")) ?? "";
					const effect = state === "working" ? "steer at next step" : "send";
					assert.match(caption, new RegExp(`╭─ ${effect}`));
					assert.doesNotMatch(caption, /working|idle|failed|test\/model|high|…/);
					const full = `${effect} · 160/1.0k (16%) ctx · $0.42 · 140 in · 20 out`;
					const count = visibleWidth(full) <= geometry.conversationWidth - 10 ? 1 : 0;
					for (const fact of ["140 in", "20 out"]) assert.equal(right.split(fact).length - 1, count, right);
				} finally { f.ui.dispose(); }
			});
		}
	}
}
it("caption drops traffic then cost then context while preserving the effect beside native hidden rows", async () => {
	const f = fixture(100, 30, factSource("working"), { contextWindow: () => 1000 });
	try {
		await turn();
		const state = agentState(f.state, "one");
		const caption = () => stripVTControlCharacters(f.ui.render(100).slice(1).find((line) => line.includes("╭─")) ?? "");
		assert.match(caption(), /steer at next step · 160\/1.0k \(16%\) ctx · \$0.42/);
		assert.doesNotMatch(caption(), / in| out/);
		f.ui.handleInput("\t"); f.ui.handleInput("\t");
		assert.match(caption(), /follow-up after answer/);
		updateDraft(state, Array.from({ length: 30 }, (_, index) => `draft ${index}`).join("\n"));
		assert.match(caption(), /follow-up after answer · 160\/1.0k \(16%\) ctx/);
		assert.doesNotMatch(caption(), /\$| in| out|…/);
		assert.match(caption(), /↑ \d+ lines/);
		(f.tui.terminal as { columns: number }).columns = 60;
		const narrow = stripVTControlCharacters(f.ui.render(60).slice(1).find((line) => line.includes("╭─")) ?? "");
		assert.match(narrow, /follow-up after answer/); assert.doesNotMatch(narrow, /ctx|\$| in| out|…/);
		assert.equal(state.mode, "followUp"); assert.equal(state.draft.split("\n").length, 30);
	} finally { f.ui.dispose(); }
});
it("composer caption shows delivery and usage without repeating identity or state", async () => {
	const observed = source([row("one", { name: "Recipient" })]);
	const base = conversationFrame();
	const usage = { input: 160, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 160, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
	observed.frame = () => conversationFrame({ entries: [{ id: "1", kind: "pi.assistant", model: [{ role: "assistant", provider: "test", model: "model", api: "openai-responses", timestamp: 0, content: [], stopReason: "stop", usage }] }], status: { ...base.status, usage: { models: { "test/model": usage }, tools: {} } } });
	observed.availability = () => ({ state: "live", at: base.observedAt });
	const f = fixture(164, 30, observed, { contextWindow: () => 1000 });
	try {
		await turn();
		assert.match(f.ui.render(164).join("\n"), /steer at next step · 160\/1.0k \(16%\) ctx · \$0.42 · 160 in · 0 out/);
		f.ui.handleInput("\t");
		f.ui.handleInput("\t");
		assert.match(f.ui.render(164).join("\n"), /follow-up after answer/);
		assert.doesNotMatch(f.ui.render(164).join("\n"), /Message Recipient/);
	} finally { f.ui.dispose(); }
	const absent = fixture(100, 30, source([row("empty", { state: "idle", model: undefined, cost: Number.NaN })]));
	try {
		await turn();
		const caption = absent.ui.render(100).find((line) => line.includes("╭─ send"));
		assert.ok(caption);
		assert.doesNotMatch(caption, /unknown|unavailable|\?|Model|ctx|\$/);
	} finally { absent.ui.dispose(); }
});
