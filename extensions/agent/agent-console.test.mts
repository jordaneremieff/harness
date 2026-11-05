import assert from "node:assert/strict";
import { it } from "node:test";
import { fixture, turn, row, source, page, conversationFrame } from "./dashboard-test-fixture.mts";
import { agentState, updateDraft } from "./dashboard-state.ts";
import { stripVTControlCharacters } from "node:util";
import { visibleWidth, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { sessionAppearance } from "./dashboard-roster.ts";
import { buildLiveEntries } from "./live-frames.ts";

/** Visible text: styling and the zero-width cursor markers removed, so columns match the screen. */
const visible = (lines: string[]) => lines.map((line) => stripVTControlCharacters(line.replace(/\x1b_[^\x07]*\x07/g, "")));
const click = (x: number, y: number, width: number, height: number): TuiMouseEvent => ({ type: "click", button: "left", x, y, screenX: x, screenY: y, width, height, shift: false, alt: false, ctrl: false, clickCount: 1 });

/** Click the visible text, as the operator would. */
function clickText(f: ReturnType<typeof fixture>, text: string): void {
	const { columns, rows } = f.tui.terminal;
	const lines = visible(f.ui.render(columns));
	for (let y = 0; y < lines.length; y++) {
		const x = lines[y]?.indexOf(text) ?? -1;
		if (x >= 0) {
			f.ui.handleMouse(click(x + 1, y, columns, rows));
			return;
		}
	}
	assert.fail(`no visible ${text}`);
}

it("dashboard close releases a native nested renderer timer through the console", async (t) => {
	const intervals = t.mock.method(globalThis, "setInterval");
	const clears = t.mock.method(globalThis, "clearInterval");
	const observed = source([row("one", { state: "working" })]);
	const live = buildLiveEntries({ nestedTools: [{ callId: "parent/key", parentCallId: "parent", parentTaskId: 1, taskId: 2, name: "bash", arguments: { command: "echo synthetic" }, status: "running", output: "partial" }] }, []);
	observed.frame = () => conversationFrame({ entries: [], live });
	const f = fixture(100, 30, observed);
	try {
		agentState(f.state, "one").view.toolExpanded.set("parent/key", true);
		await turn();
		f.ui.render(100);
		const toolTimers = intervals.mock.calls.filter((call) => call.arguments[1] === 1000);
		assert.equal(toolTimers.length, 1);
		f.ui.dispose(); f.ui.dispose();
		const toolClears = clears.mock.calls.filter((call) => call.arguments[0] === toolTimers[0].result);
		assert.equal(toolClears.length, 1);
	} finally {
		f.ui.dispose();
		for (const call of intervals.mock.calls) clearInterval(call.result);
	}
});

it("the message field takes every letter and slash text literally for the selected agent", async () => {
	const sent: Array<{ id: string; text: string; mode: string }> = [];
	const f = fixture(80, 24, undefined, {
		submit: async (input) => {
			sent.push(input);
			return { text: "admitted" };
		},
	});
	await turn();
	f.ui.handleInput("\r");
	assert.equal(f.ui.focus.region, "composer");
	f.ui.render(80);
	f.ui.handleInput("/help n a ? !literal");
	clickText(f, "Steer at next step ⇄");
	assert.equal(agentState(f.state, "storage:1").mode, "followUp");
	assert.equal(f.ui.focus.region, "composer", "choosing the delivery effect keeps the message field");
	f.ui.handleInput("\r");
	await turn();
	assert.deepEqual(sent, [{ id: "storage:1", text: "/help n a ? !literal", mode: "followUp" }]);
	assert.equal(agentState(f.state, "storage:1").mode, "steer", "the next message starts as steer again");
	f.ui.handleInput("\x1b");
	assert.equal(f.ui.focus.region, "list");
	f.ui.dispose();
});
it("refused admission retains the draft and disposition", async () => {
	const f = fixture(80, 24, undefined, {
		submit: async () => {
			throw new Error("owner refused");
		},
	});
	await turn();
	f.ui.handleInput("\r");
	f.ui.handleInput("retained");
	clickText(f, "Steer at next step ⇄");
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
	for (const width of [164, 100, 80, 60]) for (const writing of [false, true]) {
		it(`${state} target facts appear once, the state under the name and the status under the message field, at ${width}${writing ? " while writing" : ""}`, async () => {
			const f = fixture(width, 30, factSource(state), { modelInfo: () => ({ name: "Example model", reasoning: true, contextWindow: 1000 }) });
			try {
				await turn();
				await turn();
				if (writing) f.ui.handleInput("\r");
				const lines = visible(f.ui.render(width));
				assert.equal(lines.length, 30); assert.ok(lines.every((line) => visibleWidth(line) === width));
				const wide = width >= 100;
				const paneX = wide ? (lines[1]?.indexOf("│") ?? 0) + 1 : 0;
				const paneY = wide ? 1 : 9;
				const pane = lines.slice(paneY).map((line) => line.slice(paneX));
				const right = pane.join("\n");
				const header = pane[0] ?? "";
				assert.equal(header.split("Recipient").length - 1, 1, "the header shows one label, not the handle pair");
				assert.doesNotMatch(header, /@recipient/);
				assert.doesNotMatch(pane[0] ?? "", /model|high|%|\$/);
				assert.match(pane[1] ?? "", new RegExp(sessionAppearance[state].label), "the state sits on the line under the name");
				const bottom = pane.findIndex((line) => line.includes("╰─"));
				const facts = pane.findIndex((line) => /Example model \[high\].*16%.*160\/1.0k/.test(line));
				assert.ok(bottom > 0 && facts > bottom, "the status lines sit under the message field, as in the main session");
				assert.match(pane[facts + 1] ?? "", /\/work/);
				for (const fact of ["Example model", "[high]", "16%", "160/1.0k", "~$0.42"]) assert.equal(right.split(fact).length - 1, 1, right);
				const caption = pane.find((line) => line.includes("╭─")) ?? "";
				assert.match(caption, /╭─ To Recipient /);
				assert.match(caption, state === "working" ? /Steer at next step ⇄/ : /^(?!.*(Steer|Follow-up)).*$/u, "only a working agent's message field names a delivery choice");
				assert.doesNotMatch(caption, /Working|Idle|Failed|model|high|%|\$|hit|ctx| in| out/);
				const status = "Example model [high] │ ██░░░░░░░░ 16% │ 160/1.0k │ ~$0.42 │ ● 21% hit";
				assert.equal(right.split("21% hit").length - 1, width - paneX > visibleWidth(status) ? 1 : 0);
			} finally { f.ui.dispose(); }
		});
	}
}
it("the delivery effect and a long draft stay on the message field without other facts", async () => {
	const f = fixture(100, 30, factSource("working"), { modelInfo: () => ({ name: "Example model", reasoning: true, contextWindow: 1000 }) });
	try {
		await turn(); await turn();
		const state = agentState(f.state, "one");
		f.ui.handleInput("\r");
		clickText(f, "Steer at next step ⇄");
		updateDraft(state, Array.from({ length: 30 }, (_, index) => `draft ${index}`).join("\n"));
		const caption = () => visible(f.ui.render(f.tui.terminal.columns)).slice(1).find((line) => line.includes("╭─")) ?? "";
		assert.match(caption(), /Follow-up after answer/); assert.match(caption(), /↑ \d+ lines/);
		assert.doesNotMatch(caption(), /model|high|ctx|%|\$| in| out/);
		f.resize(60, 30);
		assert.match(caption(), /Follow-up after answer/);
		assert.equal(state.mode, "followUp"); assert.equal(state.draft.split("\n").length, 30);
	} finally { f.ui.dispose(); }
});
it("project statistics include only the selected agent's loaded delegates", async () => {
	const observed = source([row("one", { modifiedAt: 100 }), row("child", { creatingOwnerId: "one", cost: 1 }), row("other", { creatingOwnerId: "primary", cost: 99 })]);
	const list = observed.list; observed.list = async () => { const page = await list(); return { ...page, coverage: { ...page.coverage, complete: false } }; };
	const f = fixture(164, 30, observed, { branch: async () => "main" });
	try {
		await turn(); await turn();
		assert.match(visible(f.ui.render(164)).join("\n"), /\/work \(main\) │ agents: 1\/1\+ active · ~\$1\.00/);
		const before = f.ui.focus;
		f.ui.handleMouse({ type: "press", button: "left", x: 100, y: 28, screenX: 100, screenY: 28, width: 164, height: 30, shift: false, alt: false, ctrl: false });
		assert.deepEqual(f.ui.focus, before, "a press on the figures changes nothing");
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
		assert.match(visible(f.ui.render(80)).join("\n"), /\/two \(topic\)/);
		const updated = reads.length; notify(); t.mock.timers.tick(250); await turn();
		assert.equal(reads.length, updated);
	} finally { f.ui.dispose(); }
});
