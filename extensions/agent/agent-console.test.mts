import assert from "node:assert/strict";
import { it } from "node:test";
import { fixture, turn, row, source, page, conversationFrame } from "./dashboard-test-fixture.mts";
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
	for (const width of [164, 100, 80, 60]) for (const consoleView of [false, true]) {
		it(`${state} right pane assigns facts once below the composer at ${width} in ${consoleView ? "console" : "roster"}`, async () => {
			const f = fixture(width, 30, factSource(state), { modelInfo: () => ({ name: "Example model", reasoning: true, contextWindow: 1000 }) });
			try {
				await turn(); if (consoleView) f.ui.handleInput("\r");
				const lines = f.ui.render(width).map(stripVTControlCharacters);
				assert.equal(lines.length, 30); assert.ok(lines.every((line) => visibleWidth(line) === width));
				const geometry = dashboardGeometry(width, 30, 0, consoleView);
				const paneX = geometry.wide ? geometry.rosterWidth + 1 : 0;
				const paneY = consoleView || geometry.wide ? 1 : 5;
				const pane = lines.slice(paneY, -1).map((line) => sliceByColumn(line, paneX, width));
				const right = pane.join("\n");
				assert.match(pane[0], /@recipient · Recipient/);
				assert.match(pane[0], new RegExp(sessionAppearance[state].label));
				assert.doesNotMatch(pane[0], /model|high|%|\$/);
				assert.match(pane.at(-2) ?? "", /Example model \[high\].*16%.*160\/1.0k/);
				assert.match(pane.at(-1) ?? "", /\/work/);
				for (const fact of ["Example model", "[high]", "16%", "160/1.0k", "~$0.42"]) assert.equal(right.split(fact).length - 1, 1, right);
				const caption = pane.find((line) => line.includes("╭─")) ?? "";
				const effect = state === "working" ? "steer at next step" : "send";
				assert.match(caption, new RegExp(`╭─ ${effect} ─`));
				assert.doesNotMatch(caption, /working|idle|failed|model|high|%|\$|hit|ctx| in| out|…/);
				assert.equal(right.split("21% hit").length - 1, geometry.conversationWidth >= visibleWidth("Example model [high] │ ██░░░░░░░░ 16% │ 160/1.0k │ ~$0.42 │ ● 21% hit") ? 1 : 0);
			} finally { f.ui.dispose(); }
		});
	}
}
it("effect-only caption preserves mode and draft beside native hidden rows", async () => {
	const f = fixture(100, 30, factSource("working"), { modelInfo: () => ({ name: "Example model", reasoning: true, contextWindow: 1000 }) });
	try {
		await turn(); const state = agentState(f.state, "one");
		f.ui.handleInput("\t"); f.ui.handleInput("\t");
		updateDraft(state, Array.from({ length: 30 }, (_, index) => `draft ${index}`).join("\n"));
		const caption = () => stripVTControlCharacters(f.ui.render(f.tui.terminal.columns).slice(1).find((line) => line.includes("╭─")) ?? "");
		assert.match(caption(), /follow-up after answer/); assert.match(caption(), /↑ \d+ lines/);
		assert.doesNotMatch(caption(), /model|high|ctx|%|\$| in| out|…/);
		(f.tui.terminal as { columns: number }).columns = 60;
		assert.match(caption(), /follow-up after answer/);
		assert.equal(state.mode, "followUp"); assert.equal(state.draft.split("\n").length, 30);
	} finally { f.ui.dispose(); }
});
it("project statistics include only the selected agent's loaded delegates", async () => {
	const observed = source([row("one", { modifiedAt: 100 }), row("child", { creatingOwnerId: "one", cost: 1 }), row("other", { creatingOwnerId: "primary", cost: 99 })]);
	const list = observed.list; observed.list = async () => { const page = await list(); return { ...page, coverage: { ...page.coverage, complete: false } }; };
	const f = fixture(164, 30, observed, { branch: async () => "main" });
	try {
		await turn(); await turn();
		assert.match(f.ui.render(164).at(-2) ?? "", /\/work \(main\) │ agents: 1\/1\+ active · ~\$1.00/);
		const before = f.ui.navigation.screen;
		f.ui.handleMouse({ type: "press", button: "left", x: 100, y: 28, screenX: 100, screenY: 28, width: 164, height: 30, shift: false, alt: false, ctrl: false });
		assert.equal(f.ui.navigation.screen, before);
	} finally { f.ui.dispose(); }
});

it("cwd events refresh the branch, while ordinary renders never launch reads", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
	let current = row("one", { cwd: "/one" });
	let notify = () => {};
	const observed = source([current]);
	observed.list = async () => page([current]);
	observed.subscribeRoster = (listener) => { notify = listener; return () => {}; };
	const reads: string[] = [];
	const f = fixture(80, 24, observed, { branch: async (cwd) => { reads.push(cwd); return cwd === "/one" ? "main" : "topic"; } });
	try {
		await turn(); const count = reads.length;
		for (let index = 0; index < 10; index++) f.ui.render(80);
		assert.equal(reads.length, count);
		current = { ...current, cwd: "/two" }; notify(); t.mock.timers.tick(250); await turn();
		assert.equal(reads.at(-1), "/two");
		assert.match(f.ui.render(80).at(-2) ?? "", /\/two \(topic\)/);
		const updated = reads.length; notify(); t.mock.timers.tick(250); await turn();
		assert.equal(reads.length, updated);
	} finally { f.ui.dispose(); }
});
