import assert from "node:assert/strict";
import { it } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { initTheme, SessionManager, type KeybindingsManager, type Theme } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, KeybindingsManager as Keys, TUI_KEYBINDINGS, visibleWidth, type KeyId, type TUI } from "@earendil-works/pi-tui";
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
	const panel = new AgentDashboard(sources, tui, theme, keys, (request) => requests.push(request), { filter: "", focus: "conversation", views: new Map(), drafts: new Map() }, actions);
	const screen = (width = 120) => stripVTControlCharacters(panel.render(width).join("\n"));
	return { panel, sources, tui, terminal, screen, requests, native };
}

it("shows the selected native conversation with a rail, complete session selection and total spend", async () => {
	const rows = Array.from({ length: 75 }, (_, index) => row(String(index), { modifiedAt: Date.now() - index * 1000 }));
	rows[0].state = "working"; rows[0].owner = "window"; rows[0].currentTool = { name: "read", argument: "source.ts" };
	const f = fixture(rows); await tick();
	try {
		assert.equal(dashboardRecords(f.panel.state.snapshot, "").length, 75);
		assert.match(f.screen(200), /1 working.*\$93\.75 spent/);
		assert.match(f.screen(200), /Working · other window/);
		assert.match(f.screen(200), /read source.ts/);
		assert.match(f.screen(200), /Assistant result sentinel/);
		assert.doesNotMatch(f.screen(200), /The result is ready/);
		assert.doesNotMatch(f.screen(200), /select for model|Stored|Latest toolResult|omitted/);
		for (let index = 0; index < 74; index++) f.panel.handleInput("]");
		await tick(); assert.equal(f.panel.state.selected, "74");
		assert.match(f.screen(), /Session 74/);
		f.panel.handleInput("/"); f.panel.handleInput("test-model 74"); f.panel.handleInput("\r");
		assert.equal(f.panel.state.selected, "74"); assert.match(f.screen(), /1 of 75/);
	} finally { f.panel.dispose(); }
});

it("keeps unresolved ownership in Attention and bounds terminal outcomes by the shared observation time", async (t) => {
	const now = new Date(2026, 0, 3, 12).getTime();
	t.mock.timers.enable({ apis: ["Date"], now });
	const states = ["failed", "stopped", "interrupted", "unavailable"] as const;
	const day = 24 * 60 * 60 * 1000;
	const rows = states.flatMap((state) => [row(`recent-${state}`, { state, modifiedAt: now - 1000 }), row(`old-${state}`, { state, owner: state === "unavailable" ? "unknown" : undefined, modifiedAt: now - 2 * day })]);
	rows.push(row("boundary", { state: "failed", modifiedAt: now - day }), row("today", { modifiedAt: now }));
	const f = fixture(rows); await tick(); f.terminal.rows = 52;
	try {
		assert.match(f.screen(200), /6 need attention/);
		const ordered = dashboardRecords(f.panel.state.snapshot, "").map((item) => item.sessionId);
		assert.ok(ordered.indexOf("boundary") < ordered.indexOf("today"));
		assert.ok(["failed", "stopped", "interrupted"].every((state) => ordered.indexOf(`old-${state}`) > ordered.indexOf("today")));
		assert.ok(ordered.indexOf("old-unavailable") < ordered.indexOf("today"));
		assert.doesNotMatch(f.screen(200), /Orphaned/);
		const text = f.screen(200);
		assert.ok(text.indexOf(" Today") < text.indexOf(" Earlier"));
		assert.match(text, /! Session old-failed/);
		assert.match(text, /■ Session old-stopped/);
		t.mock.timers.tick(1);
		assert.match(f.screen(200), /6 need attention/);
		await f.panel.refresh();
		assert.match(f.screen(200), /5 need attention/);
		assert.ok(dashboardRecords(f.panel.state.snapshot, "").findIndex((item) => item.sessionId === "boundary") > 5);
	} finally { f.panel.dispose(); }
});

it("omits unknown duration but preserves an observed zero duration beside the conversation", async () => {
	let current = row("sample", { state: "working", durationMs: undefined });
	const f = fixture([current], { board: async () => [current] }); await tick(); f.terminal.rows = 52;
	try {
		assert.doesNotMatch(f.screen(200), /duration ·|NaN/);
		assert.match(f.screen(200), /4 tool calls · active/);
		current = { ...current, durationMs: 0 }; await f.panel.refresh();
		assert.match(f.screen(200), /0s duration · 4 tool calls/);
	} finally { f.panel.dispose(); }
});

it("retains selection by ID across refresh and filters name, place, model and state", async () => {
	const modifiedAt = Date.now();
	let rows = [row("one", { modifiedAt }), row("two", { modifiedAt })];
	const f = fixture(rows, { board: async () => rows }); await tick();
	try {
		f.panel.handleInput("]"); assert.equal(f.panel.state.selected, "two");
		f.panel.handleInput("j"); assert.equal(f.panel.state.selected, "two", "scroll never changes the session");
		rows = [row("two", { state: "working" }), row("one", { modifiedAt: 1 })];
		await f.panel.refresh(); assert.equal(f.panel.state.selected, "two");
		assert.equal(dashboardRecords(f.panel.state.snapshot, "working test-model two").length, 1);
		f.panel.handleInput("/"); f.panel.handleInput("no match"); assert.match(f.screen(), /No sessions match/);
		f.panel.handleInput("\x1b"); assert.equal(f.panel.state.filter, ""); assert.equal(f.panel.state.selected, "two");
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

it("keeps the selected session visible on the same surface at short and narrow sizes", async () => {
	const now = Date.now();
	const f = fixture(Array.from({ length: 20 }, (_, index) => row(String(index), { modifiedAt: now - index * 86400000 })));
	await tick();
	try {
		for (const [width, height] of [[100, 14], [80, 10]]) {
			f.terminal.rows = height;
			for (const key of ["]", "]", "[", "j", "k"]) {
				f.panel.handleInput(key); await tick();
				const screen = f.screen(width);
				assert.ok(screen.includes(`✓ Session ${f.panel.state.selected} `), `${width}x${height} selected session`);
				assert.doesNotMatch(screen, /SESSION\s+PLACE/);
			}
			assert.match(f.screen(width), /TAIL|BROWSE/);
		}
	} finally { f.panel.dispose(); }
});

it("reserves unique ID tails for colliding visible titles in the rail and narrow selector", async () => {
	const modifiedAt = Date.now();
	const rows = [row("first-a123456", { name: "probe", cwd: "/work/probe", modifiedAt }), row("second-b123456", { name: "probe", cwd: "/work/probe", modifiedAt }), row("other-c123456", { name: "probe", cwd: "/work/elsewhere", modifiedAt })];
	const f = fixture(rows); await tick();
	try {
		for (const width of [200, 120]) {
			const screen = f.screen(width);
			assert.match(screen, /probe a123456/); assert.match(screen, /probe b123456/); assert.match(screen, /probe c123456/);
		}
		assert.match(f.screen(80), /probe a123456/);
		f.panel.handleInput("]"); await tick(); assert.match(f.screen(80), /probe c123456/);
		f.panel.handleInput("/"); f.panel.handleInput("first-a123456"); f.panel.handleInput("\r");
		assert.match(f.screen(80), /probe a123456/);
		f.panel.state.filter = "";
		rows[0] = { ...rows[0], name: `${"长".repeat(60)} first` };
		rows[1] = { ...rows[1], name: `${"长".repeat(60)} second` };
		await f.panel.refresh();
		for (const width of [200, 120, 80]) {
			const lines = f.panel.render(width);
			const screen = stripVTControlCharacters(lines.join("\n"));
			assert.match(screen, /长.* a123456/);
			if (width >= 120) assert.match(screen, /长.* b123456/);
			assert.ok(lines.every((line) => visibleWidth(line) <= width));
		}
	} finally { f.panel.dispose(); }
});

it("renders native chat, follows fresh output, browses without jumps, and expands tools", async () => {
	const f = fixture(); let revision = 1;
	f.sources.conversation = async () => ({ entries: f.native.getBranch(), revision: String(revision), partial: false });
	for (let index = 0; index < 90; index++) f.native.appendMessage({ role: "user", content: `message ${index}`, timestamp: index + 3 });
	await tick();
	try {
		assert.match(f.screen(), /TAIL/); assert.match(f.screen(), /message 89/); assert.match(f.screen(), /earlier messages/);
		f.panel.handleInput("\x1b[H"); const browsing = f.screen(); assert.match(browsing, /BROWSE/);
		f.native.appendMessage({ role: "user", content: "fresh live output", timestamp: 100 }); revision++;
		await f.panel.refresh(); assert.doesNotMatch(f.screen(), /fresh live output/);
		f.panel.handleInput("\x1b[F"); assert.match(f.screen(), /fresh live output/);
		f.panel.handleInput("o"); f.panel.handleInput("\x1b[H"); assert.match(f.screen(), /User asks for a check/);
		assert.match(f.screen(), /Assistant result sentinel/);
		f.panel.handleInput("x"); assert.match(f.screen(), /User asks for a check/);
		f.panel.handleInput("\x1b"); assert.equal(f.requests.length, 1);
	} finally { f.panel.dispose(); }
});

it("keeps the follow marker, state and cost visible beside a long conversation title", async () => {
	const f = fixture([row("long", { name: `${"A long first message used as the title ".repeat(8)}END`, state: "failed", cost: 3.5 })]); await tick();
	try {
		for (const width of [120, 80, 40]) {
			const lines = f.panel.render(width);
			const heading = stripVTControlCharacters(lines.find((line) => line.includes("TAIL")) ?? "");
			assert.match(heading, /TAIL · Failed · \$3\.50/, `${width} columns`);
			assert.doesNotMatch(heading, /END/);
			assert.ok(visibleWidth(lines[1]) <= width);
		}
		f.panel.handleInput("\x1b[H");
		assert.match(f.screen(80), /BROWSE · Failed · \$3\.50/);
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

it("keeps a visible board responsive while a source read exceeds the visibility limit", async (t) => {
	t.mock.timers.enable({ apis: ["Date", "setInterval"], now: Date.now() });
	let calls = 0; let renders = 0; let release!: (rows: SessionDigest[]) => void;
	const f = fixture([], { board: async () => { calls++; return calls === 1 ? new Promise((resolve) => { release = resolve; }) : [row()]; } });
	f.tui.requestRender = () => { renders++; f.panel.render(120); };
	await tick();
	try {
		for (let index = 0; index < 8; index++) { t.mock.timers.tick(1000); await tick(); }
		assert.equal(calls, 1); assert.ok(renders >= 8);
		f.panel.handleInput("?"); assert.match(f.screen(), /Agent conversations/);
		f.panel.handleInput("\x1b");
		release([row()]); await tick(); t.mock.timers.tick(1000); await tick();
		assert.equal(calls, 2);
		f.panel.handleInput("\x1b"); assert.equal(f.requests.length, 1);
		t.mock.timers.tick(10000); await tick(); assert.equal(calls, 2);
	} finally { f.panel.dispose(); }
});

for (const resume of ["render", "key"] as const) it(`pauses unseen refresh and resumes on a later ${resume} without disabling Escape`, async (t) => {
	t.mock.timers.enable({ apis: ["Date", "setInterval"], now: Date.now() });
	let calls = 0; let requests = 0;
	const f = fixture([], { board: async () => { calls++; return [row()]; } });
	f.tui.requestRender = () => { requests++; }; await tick(); f.panel.render(120);
	try {
		for (let index = 0; index < 6; index++) { t.mock.timers.tick(1000); await tick(); }
		assert.equal(calls, 6);
		const pausedRequests = requests;
		t.mock.timers.tick(10000); await tick(); await f.panel.refresh();
		assert.equal(calls, 6); assert.equal(requests, pausedRequests);
		assert.deepEqual(f.requests, [], "a pause must not close another native overlay");
		if (resume === "render") f.panel.render(120); else f.panel.handleInput("?");
		t.mock.timers.tick(1000); await tick(); assert.equal(calls, 7);
		if (resume === "key") f.panel.handleInput("\x1b");
		f.panel.handleInput("\x1b"); assert.equal(f.requests.length, 1);
		t.mock.timers.tick(10000); await tick(); assert.equal(calls, 7);
	} finally { f.panel.dispose(); }
});

it("does not let a late source result restart a hidden board", async (t) => {
	t.mock.timers.enable({ apis: ["Date", "setInterval"], now: Date.now() });
	let calls = 0; let renders = 0; let release!: (rows: SessionDigest[]) => void;
	const f = fixture([], { board: async () => { calls++; return calls === 1 ? new Promise((resolve) => { release = resolve; }) : [row()]; } });
	f.tui.requestRender = () => { renders++; }; await tick();
	try {
		for (let index = 0; index < 6; index++) { t.mock.timers.tick(1000); await tick(); }
		const before = renders;
		release([row("late")]); await tick(); t.mock.timers.tick(10000); await tick();
		assert.equal(calls, 1); assert.equal(renders, before); assert.equal(f.panel.state.snapshot === undefined, true);
		f.panel.render(120); t.mock.timers.tick(1000); await tick();
		assert.equal(calls, 2); assert.equal(f.panel.state.snapshot?.sessions[0].sessionId, "sample");
	} finally { f.panel.dispose(); }
});

it("ignores a conversation result after Escape or disposal", async () => {
	let release!: (data: Awaited<ReturnType<AgentObservationSources["conversation"]>>) => void;
	const f = fixture(undefined, { conversation: async () => new Promise((resolve) => { release = resolve; }) }); await tick();
	f.panel.handleInput("\x1b"); release({ entries: [], revision: "late", partial: false }); await tick();
	assert.equal(f.requests.length, 1); assert.match(f.screen(), /Read in progress/); f.panel.dispose();
});

it("restores each session's passage, follow mode, earlier history and display settings across switches and fresh output", async () => {
	const a = SessionManager.inMemory("/work/a"); const b = SessionManager.inMemory("/work/b");
	for (let index = 0; index < 100; index++) a.appendMessage({ role: "user", content: `A${index} ${"passage words ".repeat(20)}`, timestamp: index });
	b.appendMessage({ role: "user", content: "B cause correction", timestamp: 1 });
	let revision = 1;
	const f = fixture([row("a", { modifiedAt: 2 }), row("b", { modifiedAt: 1 })], { conversation: async (id) => ({ entries: (id === "a" ? a : b).getBranch(), revision: String(revision), partial: false }) });
	await tick();
	try {
		f.screen(160); f.panel.handleInput("o"); f.screen(160); f.panel.handleInput("\x1b[H"); f.panel.handleInput("j"); f.panel.handleInput("j");
		f.panel.handleInput("x"); f.panel.handleInput("\x14"); f.screen(160);
		const before = structuredClone(f.panel.state.views.get("a"));
		assert.ok(before?.anchor); assert.ok(before.anchor.offset > 0); assert.equal(before.follow, false); assert.equal(before.messageLimit, 160);
		assert.equal(before.expanded, true); assert.equal(before.showThinking, true);
		f.panel.handleInput("]"); await tick(); assert.match(f.screen(80), /B cause correction/);
		assert.equal(f.panel.state.views.get("b")?.follow, true); assert.equal(f.panel.state.views.get("b")?.expanded, false);
		assert.equal(f.panel.state.views.get("b")?.messageLimit, 80); assert.equal(f.panel.state.views.get("b")?.showThinking, false);
		a.appendMessage({ role: "user", content: "new A output", timestamp: 101 }); revision++;
		await f.panel.refresh(); f.panel.handleInput("["); await tick();
		assert.match(f.screen(80), /A1 passage/); assert.doesNotMatch(f.screen(80), /new A output/);
		assert.deepEqual(f.panel.state.views.get("a")?.anchor, before.anchor);
		assert.equal(f.panel.state.views.get("a")?.messageLimit, 160);
		f.screen(160); await f.panel.refresh(); f.screen(160);
		assert.deepEqual(f.panel.state.views.get("a")?.anchor, before.anchor);
		f.panel.handleInput("\x1b[F"); assert.match(f.screen(160), /new A output/);
		f.panel.handleInput("]"); await tick(); f.screen(80);
		assert.equal(f.panel.state.views.get("b")?.follow, true);
	} finally { f.panel.dispose(); }
});

for (const width of [80, 160]) it(`keeps browse navigation monotonic after a near-tail anchor survives a resize to ${width} columns`, async () => {
	const f = fixture();
	for (let index = 0; index < 20; index++) f.native.appendMessage({ role: "user", content: `resize passage ${index}`, timestamp: index });
	f.sources.conversation = async () => ({ entries: f.native.getBranch(), revision: "resize", partial: false });
	await tick();
	try {
		f.terminal.rows = 12; f.screen(80);
		for (let index = 0; index < 5; index++) f.panel.handleInput("k");
		f.screen(80);
		const before = structuredClone(f.panel.state.views.get("sample")); assert.ok(before?.anchor); assert.ok(before.scroll > 0);
		f.terminal.rows = 48; f.screen(width);
		const view = f.panel.state.views.get("sample"); assert.ok(view);
		assert.deepEqual(view.anchor, before.anchor); assert.equal(view.scroll, before.scroll);
		for (const key of ["j", "\x1b[B"]) {
			const previous: number = view.scroll; f.panel.handleInput(key); f.screen(width);
			assert.equal(view.scroll, previous + 1, `${JSON.stringify(key)} moves down one line`);
		}
		for (const key of ["\x1b[6~", " "]) {
			const previous: number = view.scroll; f.panel.handleInput(key); f.screen(width);
			assert.ok(view.scroll >= previous, `${JSON.stringify(key)} never moves upward`);
		}
		for (const key of ["k", "\x1b[A"]) {
			const previous: number = view.scroll; f.panel.handleInput(key); f.screen(width);
			assert.equal(view.scroll, previous - 1, `${JSON.stringify(key)} moves up one line`);
		}
		const previous: number = view.scroll; f.panel.handleInput("\x1b[5~"); f.screen(width); assert.ok(view.scroll < previous);
		f.panel.handleInput("\x1b[H"); f.screen(width); assert.equal(view.scroll, 0);
		f.panel.handleInput("\x1b[F"); f.screen(width); assert.equal(view.follow, true);
		f.panel.state.actionResult = Array.from({ length: 60 }, (_, index) => `result ${index}`).join("\n");
		f.screen(width); f.panel.handleInput("\x1b[F"); const resultTail = f.screen(width);
		f.panel.handleInput("j"); assert.equal(f.screen(width), resultTail, "result navigation retains its full-page bound");
	} finally { f.panel.dispose(); }
});

it("keeps an anchor at the first loaded message when new messages move the tail window", async () => {
	const f = fixture(); let revision = 1;
	for (let index = 0; index < 90; index++) f.native.appendMessage({ role: "user", content: `window message ${index}`, timestamp: index });
	f.sources.conversation = async () => ({ entries: f.native.getBranch(), revision: String(revision), partial: false });
	await tick();
	try {
		f.screen(); f.panel.handleInput("\x1b[H"); f.panel.handleInput("j"); f.screen();
		const anchor = structuredClone(f.panel.state.views.get("sample")?.anchor); assert.ok(anchor);
		for (let index = 0; index < 5; index++) f.native.appendMessage({ role: "user", content: `new message ${index}`, timestamp: 100 + index });
		revision++; await f.panel.refresh(); f.screen();
		assert.deepEqual(f.panel.state.views.get("sample")?.anchor, anchor);
		assert.equal(f.panel.state.views.get("sample")?.follow, false);
		const earlier = f.screen().match(/\d+ earlier messages/)?.[0]; assert.ok(earlier);
		f.panel.handleInput("\x1b[F"); assert.ok(f.screen().includes(earlier), "the count describes the still-loaded document");
	} finally { f.panel.dispose(); }
});

it("isolates recipient drafts and native undo while preserving multiline pasted text through refusal", async () => {
	const calls: unknown[] = []; let reject = true;
	const f = fixture([row("a", { modifiedAt: 2 }), row("b", { modifiedAt: 1 })], {}, { run: async () => undefined, compose: async (...args) => { calls.push(args); if (reject) throw new Error("refused once"); return "Admitted"; } });
	await tick(); f.panel.focused = true;
	try {
		const payload = Array.from({ length: 14 }, (_, index) => `A draft café 世界 ${index}`).join("\n");
		f.panel.handleInput("\r"); f.panel.handleInput(`\x1b[200~${payload}\x1b[201~`); f.panel.handleInput("\x1b");
		assert.equal(f.panel.state.drafts.get("a"), payload);
		f.panel.handleInput("]"); await tick(); f.panel.handleInput("\r"); f.panel.handleInput("\x1f");
		assert.doesNotMatch(f.screen(), /A draft/); assert.equal(f.panel.state.drafts.get("b"), "");
		f.panel.handleInput("B[]"); f.panel.handleInput("\n"); f.panel.handleInput("next");
		assert.equal(f.panel.state.selected, "b"); assert.equal(calls.length, 0);
		f.panel.handleInput("\x1b"); assert.equal(f.panel.state.drafts.get("b"), "B[]\nnext");
		f.panel.handleInput("["); await tick(); f.panel.handleInput("\r"); f.panel.handleInput("\r"); await tick();
		assert.deepEqual(calls[0], ["send", "a", payload]); assert.equal(f.panel.state.drafts.get("a"), payload);
		assert.match(f.screen(), /refused once/);
		reject = false; f.panel.handleInput("\r"); await tick();
		assert.deepEqual(calls[1], ["send", "a", payload]); assert.equal(f.panel.state.drafts.has("a"), false);
		assert.equal(f.panel.state.drafts.get("b"), "B[]\nnext");
	} finally { f.panel.dispose(); }
});

it("never retargets a pending submission after blur, refresh or attempted navigation", async () => {
	let rows = [row("a", { modifiedAt: 2 }), row("b", { modifiedAt: 1 })];
	let reject!: (error: Error) => void; const calls: unknown[] = []; let actions = 0;
	const f = fixture(rows, { board: async () => rows }, { run: async () => { actions++; return undefined; }, compose: async (...args) => { calls.push(args); return new Promise((_resolve, fail) => { reject = fail; }); } });
	await tick();
	try {
		f.panel.handleInput("m"); f.panel.handleInput("correction for A"); f.panel.handleInput("\r"); await tick();
		f.panel.handleInput("\x1b"); f.panel.handleInput("]"); f.panel.handleInput("/"); f.panel.handleInput("n"); f.panel.handleInput("a");
		rows = [row("b", { state: "working" }), row("a", { modifiedAt: 1 })]; await f.panel.refresh();
		assert.equal(f.panel.state.selected, "a"); assert.equal(actions, 0); assert.deepEqual(f.requests, []);
		assert.deepEqual(calls, [["send", "a", "correction for A"]]);
		reject(new Error("delayed refusal")); await tick(); assert.equal(f.panel.state.drafts.get("a"), "correction for A");
		f.panel.handleInput("["); await tick(); assert.equal(f.panel.state.selected, "b");
		f.panel.handleInput("m"); assert.doesNotMatch(f.screen(), /Send to Session a|correction for A/);
		f.panel.handleInput("\x1b"); f.panel.handleInput("]"); await tick(); f.panel.handleInput("m");
		assert.match(f.screen(), /correction for A/);
	} finally { f.panel.dispose(); }
});

it("rejects a late conversation result for a different selected session", async () => {
	const late = SessionManager.inMemory("/work/b"); late.appendMessage({ role: "user", content: "late B content", timestamp: 1 });
	let release!: (data: Awaited<ReturnType<AgentObservationSources["conversation"]>>) => void;
	const f = fixture([row("a", { modifiedAt: 2 }), row("b", { modifiedAt: 1 })]);
	const normal = f.sources.conversation;
	f.sources.conversation = async (id) => id === "b" ? new Promise((resolve) => { release = resolve; }) : normal(id);
	await tick();
	try {
		f.panel.handleInput("]"); f.panel.handleInput("["); await tick();
		release({ entries: late.getBranch(), revision: "late", partial: false }); await tick();
		assert.equal(f.panel.state.selected, "a"); assert.match(f.screen(), /Assistant result sentinel/); assert.doesNotMatch(f.screen(), /late B content/);
	} finally { f.panel.dispose(); }
});

it("renders the complete focused editor or a resize notice without accepting hidden edits", async () => {
	const calls: unknown[] = [];
	const f = fixture(undefined, {}, { run: async () => undefined, compose: async (...args) => { calls.push(args); return "Admitted"; } });
	await tick(); f.panel.focused = true;
	try {
		const text = Array.from({ length: 20 }, (_, index) => `line ${index} 世界`).join("\n");
		f.panel.state.drafts.set("sample", text); f.panel.handleInput("m");
		for (const [width, height] of [[160, 40], [80, 24], [40, 20]]) {
			f.terminal.rows = height; const lines = f.panel.render(width);
			assert.ok(lines.length <= height - 2); assert.ok(lines.every((line) => visibleWidth(line) <= width));
			assert.equal(lines.filter((line) => line.includes(CURSOR_MARKER)).length, 1);
		}
		f.panel.focused = false; assert.ok(f.panel.render(80).every((line) => !line.includes(CURSOR_MARKER)));
		f.panel.focused = true; f.terminal.rows = 8; assert.match(f.screen(80), /Resize to edit/);
		f.panel.handleInput("hidden"); f.panel.handleInput("\r"); assert.equal(calls.length, 0); assert.equal(f.panel.state.drafts.get("sample"), text);
		f.panel.handleInput("\x1b"); assert.equal(f.requests.length, 0);
		f.terminal.rows = 36; f.panel.render(80); f.panel.handleInput("m");
		assert.ok(f.panel.render(80).some((line) => line.includes(CURSOR_MARKER)));
		assert.equal(f.panel.state.drafts.get("sample"), text);
	} finally { f.panel.dispose(); }
});

it("opens in Sessions, uses arrows to select, and Enter reads before any message draft", async () => {
	const f = fixture([row("a", { modifiedAt: 2 }), row("b", { modifiedAt: 1 })]);
	const calls: unknown[] = [];
	const panel = new AgentDashboard(f.sources, f.tui, theme, keys, () => {}, undefined, { run: async () => undefined, compose: async (...args) => { calls.push(args); return "sent"; } });
	await tick();
	try {
		const screen = () => stripVTControlCharacters(panel.render(80).join("\n"));
		assert.equal(panel.state.focus, "sessions");
		assert.match(screen(), /Sessions · ↑↓ select · Enter read/);
		assert.match(screen(), /Session a/); assert.match(screen(), /Session b/);
		assert.doesNotMatch(screen(), /Assistant result sentinel/);
		for (const width of [40, 80, 140]) {
			const text = stripVTControlCharacters(panel.render(width).join("\n"));
			for (const hint of ["Tab conversation", "/ find", "a actions", "m message", "n new", "? help", "Esc close"]) assert.ok(text.includes(hint), `${width}: ${hint}`);
		}
		panel.handleInput("\x1b[B"); await tick(); assert.equal(panel.state.selected, "b");
		panel.handleInput("\r"); assert.equal(panel.state.focus, "conversation");
		assert.match(screen(), /Assistant result sentinel/); assert.doesNotMatch(screen(), /Message draft/); assert.deepEqual(calls, []);
		panel.handleInput("\x1b[A"); assert.equal(panel.state.selected, "b");
		panel.handleInput("\x1b[Z"); assert.equal(panel.state.focus, "sessions");
		panel.render(140); assert.equal(panel.state.focus, "sessions");
		panel.handleInput("\x1b[A"); assert.equal(panel.state.selected, "a");
	} finally { panel.dispose(); f.panel.dispose(); }
});

it("keeps filter matches in Sessions and restores the prior focus, selection and filter on cancel", async () => {
	const f = fixture([row("a", { modifiedAt: 2 }), row("b", { modifiedAt: 1 })]); await tick();
	try {
		f.panel.handleInput("/"); f.panel.handleInput("Session b"); await tick();
		assert.equal(f.panel.state.focus, "sessions"); assert.equal(f.panel.state.selected, "b");
		f.panel.handleInput("\x1b"); assert.equal(f.panel.state.focus, "conversation"); assert.equal(f.panel.state.selected, "a"); assert.equal(f.panel.state.filter, "");
		f.panel.handleInput("/"); f.panel.handleInput("no match"); f.panel.handleInput("\r");
		assert.equal(f.panel.state.focus, "sessions"); assert.equal(f.panel.state.selected, undefined);
		assert.match(f.screen(80), /No sessions match/); assert.match(f.screen(80), /\/ find/); assert.doesNotMatch(f.screen(80), /m message/);
		f.panel.handleInput("\r"); assert.equal(f.panel.state.focus, "sessions");
		f.panel.handleInput("/"); f.panel.handleInput("\x15"); f.panel.handleInput("Session b"); f.panel.handleInput("\r");
		assert.equal(f.panel.state.focus, "sessions"); assert.equal(f.panel.state.selected, "b");
		f.panel.handleInput("\r"); assert.equal(f.panel.state.focus, "conversation");
	} finally { f.panel.dispose(); }
});

it("retains a recipient draft through focus changes and leaves foreign sessions read-only", async () => {
	const f = fixture([row("a", { modifiedAt: 2 }), row("b", { modifiedAt: 1, owner: "window", ownerLabel: "another window" })], {}, { run: async () => undefined, compose: async () => "sent" }); await tick();
	try {
		f.panel.handleInput("m"); f.panel.handleInput("Keep this draft"); f.panel.handleInput("\x1b");
		f.panel.handleInput("\t"); f.panel.handleInput("\x1b[B"); await tick();
		f.panel.handleInput("\r");
		assert.match(f.screen(80), /Read-only: Open in another window/);
		assert.doesNotMatch(f.screen(80), /m message|Enter message/);
		f.panel.handleInput("\t"); f.panel.handleInput("\x1b[A"); await tick();
		f.panel.handleInput("m"); assert.match(f.screen(80), /Keep this draft/); assert.equal(f.panel.state.selected, "a");
	} finally { f.panel.dispose(); }
});

for (const confirm of [["ctrl+y"], []] satisfies KeyId[][]) it(`honors ${confirm.length ? "remapped" : "disabled"} session confirmation`, async () => {
	const f = fixture();
	const configured = new Keys(TUI_KEYBINDINGS, { "tui.select.confirm": confirm, "tui.select.up": ["ctrl+p"], "tui.select.down": ["ctrl+n"] }) as KeybindingsManager;
	const panel = new AgentDashboard(f.sources, f.tui, theme, configured, () => {}); await tick();
	try {
		panel.handleInput("\r"); assert.equal(panel.state.focus, "sessions");
		const screen = stripVTControlCharacters(panel.render(100).join("\n"));
		assert.doesNotMatch(screen, /Enter read|↑↓ select/); assert.match(screen, /ctrl\+p\/ctrl\+n select/);
		panel.handleInput("?"); assert.doesNotMatch(panel.render(100).join("\n"), /Enter opens its conversation/); panel.handleInput("\x1b");
		if (confirm.length) { assert.match(screen, /ctrl\+y read/); panel.handleInput("\x19"); assert.equal(panel.state.focus, "conversation"); }
		else { panel.handleInput("\x19"); assert.equal(panel.state.focus, "sessions"); panel.handleInput("\t"); assert.equal(panel.state.focus, "conversation"); }
	} finally { panel.dispose(); f.panel.dispose(); }
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
