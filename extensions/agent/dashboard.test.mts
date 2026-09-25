import assert from "node:assert/strict";
import { it } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { initTheme, SessionManager, type KeybindingsManager, type Theme } from "@earendil-works/pi-coding-agent";
import { KeybindingsManager as Keys, TUI_KEYBINDINGS, visibleWidth, type TUI } from "@earendil-works/pi-tui";
import { AgentDashboard, dashboardRecords, dashboardText, elapsed, readAgentDashboard, showAgentDashboard, type AgentObservationSources, type DashboardActions } from "./dashboard.ts";
import type { SessionDigest } from "./dashboard-data.ts";

initTheme("dark");
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const keys = new Keys({ ...TUI_KEYBINDINGS, "app.tools.expand": { defaultKeys: ["ctrl+o"], description: "Tools" }, "app.thinking.toggle": { defaultKeys: ["ctrl+t"], description: "Thinking" } }) as KeybindingsManager;
const theme = { fg: (_: string, text: string) => text, bg: (_: string, text: string) => text, bold: (text: string) => text } as Theme;
function row(id = "sample", overrides: Partial<SessionDigest> = {}): SessionDigest {
	return { sessionId: id, name: `Session ${id}`, cwd: `/work/${id}`, path: `/store/${id}.jsonl`, live: false, createdAt: 1, modifiedAt: Date.now(), state: "done", cost: 1.25, partial: false, latestReply: "**The result is ready.**\n\nThe tests pass.", firstMessage: "TASK SENTINEL", durationMs: 60000, toolCalls: 4, model: { provider: "test", modelId: "test-model", thinkingLevel: "high" }, ...overrides };
}
function fixture(rows = [row()], overrides: Partial<AgentObservationSources> = {}, actions?: DashboardActions) {
	const native = SessionManager.inMemory("/work");
	native.appendMessage({ role: "user", content: "User asks for a check", timestamp: 1 });
	native.appendMessage({ role: "assistant", content: [{ type: "text", text: "Assistant result sentinel" }], api: "openai-responses", provider: "test", model: "test", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: 2 });
	const sources: AgentObservationSources = { board: async () => rows, sessions: async () => rows, runs: async () => [], conversation: async () => ({ entries: native.getBranch(), revision: "1", partial: false }), ...overrides };
	const terminal = { rows: 36 };
	const tui = { terminal, requestRender() {} } as unknown as TUI;
	const requests: unknown[] = [];
	const panel = new AgentDashboard(sources, tui, theme, keys, (request) => requests.push(request), undefined, actions);
	const screen = (width = 120) => stripVTControlCharacters(panel.render(width).join("\n"));
	return { panel, sources, tui, terminal, screen, requests, native };
}

it("shows one row per session, all records, meaningful state and spend before the latest reply", async () => {
	const rows = Array.from({ length: 75 }, (_, index) => row(String(index), { modifiedAt: Date.now() - index * 1000 }));
	rows[0].state = "working"; rows[0].owner = "window"; rows[0].currentTool = { name: "read", argument: "source.ts" };
	const f = fixture(rows); await tick();
	try {
		assert.equal(dashboardRecords(f.panel.state.snapshot, "").length, 75);
		assert.match(f.screen(200), /1 working.*\$93\.75 spent/);
		assert.match(f.screen(200), /Working · other window/);
		assert.match(f.screen(200), /read source.ts/);
		assert.ok(f.screen(200).indexOf("The result is ready") < f.screen(200).indexOf("TASK SENTINEL"));
		assert.doesNotMatch(f.screen(200), /select for model|Stored|Latest toolResult|omitted/);
		f.panel.handleInput("\x1b[F"); assert.equal(f.panel.state.selected, "74");
		assert.match(f.screen(), /Session 74/);
		f.panel.handleInput("/"); f.panel.handleInput("test-model 74"); f.panel.handleInput("\r");
		assert.equal(f.panel.state.selected, "74"); assert.match(f.screen(), /1 of 75/);
	} finally { f.panel.dispose(); }
});

it("retains selection by ID across refresh and filters name, place, model and state", async () => {
	let rows = [row("one"), row("two")];
	const f = fixture(rows, { board: async () => rows }); await tick();
	try {
		f.panel.handleInput("j"); assert.equal(f.panel.state.selected, "two");
		rows = [row("two", { state: "working" }), row("one", { modifiedAt: 1 })];
		await f.panel.refresh(); assert.equal(f.panel.state.selected, "two");
		assert.equal(dashboardRecords(f.panel.state.snapshot, "working test-model two").length, 1);
		f.panel.handleInput("/"); f.panel.handleInput("no match"); assert.match(f.screen(), /No sessions match/);
		f.panel.handleInput("\x1b"); assert.equal(f.panel.state.filter, "");
		rows = []; await f.panel.refresh(); assert.equal(f.panel.state.selected, undefined);
		assert.match(f.screen(), /No agent sessions yet/);
	} finally { f.panel.dispose(); }
});

it("fits terminal cells at wide, narrow and short dimensions including Unicode and controls", async () => {
	const f = fixture([row("unicode", { name: "宽字符 🧭 é\x1b[2J\r title", latestReply: "## A reply\n\n- First\n- Second\n\n```ts\nconst value = true;\n```" })]); await tick();
	try {
		for (const [width, height] of [[200, 52], [120, 36], [80, 24], [40, 12], [40, 8], [40, 7], [20, 6], [1, 1]]) {
			f.terminal.rows = height;
			f.panel.state.notice = "A receipt stays within the terminal";
			const lines = f.panel.render(width);
			assert.ok(lines.length <= Math.max(1, height - 2));
			assert.ok(lines.every((line) => visibleWidth(line) <= width), `${width} columns`);
			assert.doesNotMatch(lines.join("\n"), /\x1b\[2J/);
		}
	} finally { f.panel.dispose(); }
});

it("renders native chat, follows fresh output, browses without jumps, and expands tools", async () => {
	const f = fixture(); let revision = 1;
	f.sources.conversation = async () => ({ entries: f.native.getBranch(), revision: String(revision), partial: false });
	for (let index = 0; index < 90; index++) f.native.appendMessage({ role: "user", content: `message ${index}`, timestamp: index + 3 });
	await tick(); f.panel.handleInput("\r"); await tick();
	try {
		assert.match(f.screen(), /TAIL/); assert.match(f.screen(), /message 89/); assert.match(f.screen(), /earlier messages/);
		f.panel.handleInput("\x1b[H"); const browsing = f.screen(); assert.match(browsing, /BROWSE/);
		f.native.appendMessage({ role: "user", content: "fresh live output", timestamp: 100 }); revision++;
		await f.panel.refresh(); assert.doesNotMatch(f.screen(), /fresh live output/);
		f.panel.handleInput("\x1b[F"); assert.match(f.screen(), /fresh live output/);
		f.panel.handleInput("o"); f.panel.handleInput("\x1b[H"); assert.match(f.screen(), /User asks for a check/);
		assert.match(f.screen(), /Assistant result sentinel/);
		f.panel.handleInput("x"); assert.match(f.screen(), /User asks for a check/);
		f.panel.handleInput("\x1b"); assert.equal(f.panel.state.conversation, undefined);
	} finally { f.panel.dispose(); }
});

it("uses the native input, preserves rejected drafts, selects send or steer from fresh state, and blocks foreign control", async () => {
	let current = row("target", { live: true, owner: "here", state: "idle" });
	let reject = true;
	const calls: unknown[] = [];
	const f = fixture([current], { board: async () => [current] }, { run: async () => undefined, compose: async (...args) => { calls.push(args); if (reject) throw new Error("admission refused"); return "Native receipt"; } });
	await tick(); f.panel.focused = true;
	try {
		f.panel.handleInput("m"); f.panel.handleInput("hello 世界"); f.panel.handleInput("\r"); await tick();
		assert.match(f.screen(), /admission refused/); assert.match(f.screen(), /hello 世界/);
		assert.deepEqual(calls[0], ["send", "target", "hello 世界"]);
		reject = false; current = { ...current, state: "working" };
		f.panel.handleInput("\r"); await tick(); assert.deepEqual(calls[1], ["steer", "target", "hello 世界"]);
		assert.match(f.screen(), /Native receipt/); assert.equal(f.panel.state.drafts.size, 0);
		current = { ...current, owner: "window", ownerLabel: "Pi window (pid 22)" }; await f.panel.refresh();
		f.panel.handleInput("m"); assert.match(f.screen(), /Open in Pi window/); assert.equal(calls.length, 2);
		f.panel.handleInput("n"); f.panel.handleInput("a new task"); f.panel.handleInput("\r"); await tick();
		assert.deepEqual(calls[2], ["new", undefined, "a new task"]);
	} finally { f.panel.dispose(); }
});

it("coalesces refreshes, stops the live clock on disposal and rejects late reads", async (t) => {
	t.mock.timers.enable({ apis: ["setInterval"] });
	let calls = 0; let release!: (rows: SessionDigest[]) => void;
	const f = fixture([], { board: async () => { calls++; return new Promise((resolve) => { release = resolve; }); } });
	await tick(); t.mock.timers.tick(3000); assert.equal(calls, 1);
	release([row()]); await tick(); t.mock.timers.tick(1000); assert.equal(calls, 2);
	f.panel.dispose(); release([row("late")]); await tick(); t.mock.timers.tick(5000);
	assert.equal(calls, 2); assert.equal(f.panel.state.snapshot?.sessions[0].sessionId, "sample");
});

it("ignores a conversation result after Escape or disposal", async () => {
	let release!: (data: Awaited<ReturnType<AgentObservationSources["conversation"]>>) => void;
	const f = fixture(undefined, { conversation: async () => new Promise((resolve) => { release = resolve; }) }); await tick();
	f.panel.handleInput("\r"); f.panel.handleInput("\x1b"); release({ entries: [], revision: "late", partial: false }); await tick();
	assert.equal(f.panel.state.conversation, undefined); assert.doesNotMatch(f.screen(), /TAIL/); f.panel.dispose();
});

it("renders failures explicitly and gives headless callers a digest without opening TUI", async () => {
	const f = fixture([], { board: async () => { throw new Error("store denied"); } }); await tick();
	try {
		assert.match(f.screen(), /Store unavailable/); assert.match(f.screen(), /store denied/);
		const snapshot = await readAgentDashboard(f.sources); assert.match(dashboardText(snapshot), /store denied/);
		let notice = "";
		await showAgentDashboard(f.sources, { mode: "rpc", hasUI: true, ui: { notify: (text: string) => { notice = text; }, custom: () => assert.fail("no TUI") } } as never);
		assert.match(notice, /store denied/);
		assert.equal(elapsed(59000), "59s"); assert.equal(elapsed(60000), "1m0s"); assert.equal(elapsed(90000), "1m30s");
	} finally { f.panel.dispose(); }
});
