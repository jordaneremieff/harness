import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ExtensionCommandContext, KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { KeybindingsManager as Keys, TUI_KEYBINDINGS, visibleWidth, type TUI } from "@earendil-works/pi-tui";
import { AgentDashboard, dashboardRecords, dashboardText, readAgentDashboard, showAgentDashboard, type AgentInspection, type AgentObservationSources, type DashboardState } from "./dashboard.ts";
import { createAgentCommand } from "./command.ts";
import type { DetachedRunView } from "./detached.ts";
import { defined } from "./test-assertions.mts";

const theme = { fg: (_color: string, value: string) => value, bg: (_color: string, value: string) => value } as Theme;
const keys = new Keys(TUI_KEYBINDINGS) as KeybindingsManager;
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const run: DetachedRunView = { runId: "run-1", sessionId: "original", currentSessionId: "current", sessionsRoot: "/sessions", agentDir: "/agent", cwd: "/work", prompt: "Audit parser", logFile: "/log", startedAt: "2026-01-01", pid: 1, launchState: "started", state: "failed", error: "Failure sentinel", summary: "Result sentinel", progress: { runId: "run-1", updatedAt: "2026-01-02", entryCount: 4, lastText: "Progress sentinel" } };
function inspection(sessionId = "active"): AgentInspection {
	return { sessionId, liveOwner: false, execution: { current: null, recovery: "read-only snapshot" }, capture: { mode: "read-only", snapshot: true, available: true, bytes: 12, unfinishedTail: true, liveState: "unavailable" }, result: { text: "Retained sentinel", nextOffset: 20, truncated: true }, entries: [{ id: "source-entry", parentId: null, type: "message", role: "assistant", preview: { text: "Preview sentinel", truncated: true }, text: "Preview sentinel", nextOffset: 12, truncated: true }], nextCursor: 5, order: "newestFirst", detail: "Use entryId and offset" };
}
function sources(): AgentObservationSources {
	return { sessions: async () => [
		{ sessionId: "saved", cwd: "/work/saved", modifiedAt: 1, live: false },
		{ sessionId: "active", name: "Parser", cwd: "/work/active", modifiedAt: 2, live: true, operation: "op" },
	], runs: async () => [run], inspect: async (id) => inspection(id) };
}
function fixture(data = sources(), suppliedKeys = keys) {
	const dimensions = { rows: 24 };
	const state: DashboardState = { tab: "sessions", filter: "", selected: {} };
	let paints = 0; let closes = 0;
	const panel = new AgentDashboard(data, { terminal: dimensions as TUI["terminal"], requestRender() { paints++; } }, theme, suppliedKeys, () => { closes++; }, state, true);
	return { panel, state, dimensions, paints: () => paints, closes: () => closes, screen: (width = 100) => panel.render(width).join("\n") };
}

describe("agent dashboard observations", () => {
	it("reports owner boundaries and keeps run error, result and progress independent", async () => {
		const snapshot = await readAgentDashboard(sources());
		assert.equal(snapshot.sessions.records.length, 2);
		const text = dashboardText(snapshot);
		for (const value of ["Active", "Stored; owner state unavailable", "Session: current", "Failure sentinel", "Result sentinel", "Progress sentinel", "recorded, not a live query", "/agent help"]) assert.ok(text.includes(value), value);
	});
	it("renders unavailable host states in text and compact rows without live claims", async () => {
		for (const hostState of ["stopping", "cleanup-incomplete", "terminal", "replacement-failed"] as const) {
			const data = { ...sources(), sessions: async () => [{ sessionId: "closed", cwd: "/work", modifiedAt: 1, live: false, provenance: "stored" as const, hostState }] };
			const text = dashboardText(await readAgentDashboard(data));
			assert.match(text, new RegExp(`Host ${hostState}; stored metadata`, "u"));
			const f = fixture(data); await tick();
			assert.match(f.screen(), new RegExp(`Host ${hostState}`, "u"));
			assert.doesNotMatch(f.screen(), /Open here|Active/u);
			f.panel.handleInput("\x1b");
		}
	});
	it("distinguishes empty and unavailable sources and preserves the full error for the reader", async () => {
		const empty = dashboardText(await readAgentDashboard({ sessions: async () => [], runs: async () => [] }));
		assert.match(empty, /Sessions: 0 total; 0 shown; 0 omitted\nNone found/);
		const message = `storage\x1b[2J ${"x".repeat(700)} ERROR-END`;
		const data = { ...sources(), sessions: () => { throw new Error(message); } };
		const snapshot = await readAgentDashboard(data);
		assert.equal(snapshot.sessions.error, message);
		assert.match(dashboardText(snapshot), /Sessions: unavailable/);
		assert.match(dashboardText(snapshot), /Result sentinel/);
		assert.doesNotMatch(dashboardText(snapshot), /\x1b/);
		const f = fixture(data); await tick(); f.panel.handleInput("\r");
		assert.equal(f.state.reader?.lines[0], message);
		assert.doesNotMatch(f.screen(), /\x1b/);
	});
	it("filters the complete inventory before the display cap with exact disjoint counts", async () => {
		const snapshot = await readAgentDashboard({ sessions: async () => Array.from({ length: 80 }, (_, i) => ({ sessionId: `session-${i}`, cwd: "x".repeat(10000), name: i === 0 ? "unique oldest" : "\x1b[31m".repeat(10000), modifiedAt: i, live: false })), runs: async () => [] });
		assert.match(dashboardText(snapshot), /80 total; 50 shown; 30 omitted/);
		assert.ok(dashboardText(snapshot).length < 42000);
		assert.doesNotMatch(dashboardText(snapshot), /\x1b/);
		const view = dashboardRecords(snapshot.sessions, "unique oldest");
		assert.deepEqual([view.total, view.matching, view.records.length, view.omitted], [80, 1, 1, 0]);
		assert.equal(view.records[0].kind === "session" && view.records[0].session.sessionId, "session-0");
	});
});

describe("agent dashboard interaction", () => {
	it("selects compact rows, retains identity across reorder, filters, changes tabs and refreshes only on request", async () => {
		let reads = 0; const data = sources();
		const f = fixture({ ...data, sessions: async () => { reads++; return (await data.sessions()).map((row) => ({ ...row, name: `revision-${reads}`, operation: reads > 1 ? null : row.operation, modifiedAt: row.sessionId === "saved" && reads > 1 ? 10 : row.modifiedAt })); } });
		assert.match(f.screen(), /Read in progress/); await tick();
		assert.equal(reads, 1); assert.match(f.screen(), /revision-1/);
		f.panel.handleInput("j"); assert.equal(f.state.selected.sessions, "saved");
		f.panel.handleInput("k"); assert.equal(f.state.selected.sessions, "active");
		f.panel.handleInput("r"); await tick(); assert.equal(f.state.selected.sessions, "active");
		assert.match(f.screen(), /revision-2/);
		f.panel.handleInput("/"); f.panel.handleInput("saved"); f.panel.handleInput("\r");
		assert.equal(f.state.selected.sessions, "saved"); assert.match(f.screen(), /2 total · 1 matching · 1 shown · 0 omitted/);
		f.state.filter = ""; f.panel.handleInput("\t"); assert.match(f.screen(), /Failure sentinel/);
		assert.equal(reads, 2);
		f.panel.handleInput("q"); assert.equal(f.closes(), 0);
		f.panel.handleInput("\x1b"); f.panel.handleInput("\x1b"); f.panel.handleInput("r");
		assert.equal(f.closes(), 1); assert.equal(reads, 2);
	});
	it("keeps close and help visible on short terminals and fits narrow Unicode output", async () => {
		const f = fixture(); await tick();
		for (const rows of [3, 4, 6, 12, 24]) {
			f.dimensions.rows = rows;
			for (const width of [1, 30, 48, 100]) {
				const lines = f.panel.render(width);
				assert.ok(lines.length <= rows - 2); assert.ok(lines.every((line) => visibleWidth(line) <= width));
				if (width >= 30) assert.match(lines.slice(-3).join("\n"), /Esc close/);
			}
		}
		f.panel.handleInput("\r"); await tick(); f.dimensions.rows = 6;
		assert.match(f.screen(30), /Esc back/);
	});
	it("honors configured select/cancel and suppresses disposed inventory responses", async () => {
		let finish!: (value: []) => void;
		const f = fixture({ ...sources(), sessions: () => new Promise<[]>((resolve) => { finish = resolve; }) }, new Keys(TUI_KEYBINDINGS, { "tui.select.cancel": "ctrl+x" }) as KeybindingsManager);
		await tick(); f.panel.handleInput("r"); f.panel.handleInput("\x18"); assert.equal(f.closes(), 1);
		const paints = f.paints(); finish([]); await tick(); assert.equal(f.paints(), paints);
		f.panel.dispose(); await f.panel.refresh(); assert.equal(f.paints(), paints);
	});
	it("keeps Escape and configured cancel active in every dashboard mode", async () => {
		for (const cancel of ["\x1b", "\x18"]) {
			const f = fixture(sources(), new Keys(TUI_KEYBINDINGS, { "tui.select.cancel": "ctrl+x" }) as KeybindingsManager); await tick();
			f.panel.handleInput("/"); f.panel.handleInput("parser"); f.panel.handleInput(cancel);
			assert.equal(f.state.filter, ""); assert.doesNotMatch(f.screen(), /Type to filter/);
			f.panel.handleInput("?"); assert.match(f.screen(), /Agent help/);
			f.panel.handleInput(cancel); assert.doesNotMatch(f.screen(), /Agent help/);
			f.panel.handleInput("\r"); await tick(); assert.ok(f.state.reader);
			f.panel.handleInput(cancel); assert.equal(f.state.reader, undefined); assert.equal(f.closes(), 0);
			f.panel.handleInput(cancel); assert.equal(f.closes(), 1);
		}
	});
	it("opens actual inspection pages and follows exact cursors and chunk offsets without complete-result claims", async () => {
		const calls: unknown[] = [];
		const f = fixture({ ...sources(), inspect: async (id, options) => {
			calls.push([id, options]); const base = inspection(id);
			if (options.entryId) return { sessionId: id, liveOwner: true, execution: base.execution, entryId: options.entryId, offset: options.offset ?? 0, text: `Full source ${"界".repeat(100)}`, nextOffset: options.offset ? null : 12000, truncated: !options.offset };
			return base;
		} });
		await tick(); f.panel.handleInput("\r"); await tick();
		assert.match(f.screen(), /Live owner state unavailable/);
		assert.match(defined(f.state.reader).lines.join("\n"), /partial preview/);
		f.panel.handleInput("\r"); await tick(); assert.match(f.screen(), /Partial entry; next offset 12000/);
		f.panel.handleInput("n"); await tick(); assert.match(f.screen(), /Final entry chunk/);
		f.panel.handleInput("b"); assert.match(defined(f.state.reader).lines.join("\n"), /Retained sentinel/);
		f.panel.handleInput("o"); await tick();
		assert.deepEqual(calls, [["active", { limit: 12 }], ["active", { limit: 12 }], ["active", { limit: 12, entryId: "source-entry", offset: 0 }], ["active", { limit: 12, entryId: "source-entry", offset: 12000 }], ["active", { limit: 12, cursor: 5 }]]);
		f.panel.handleInput("b"); assert.equal(f.state.reader, undefined);
	});
	it("ignores stale inspection after back, target change, close and failed reads", async () => {
		let finish!: (value: AgentInspection) => void;
		const f = fixture({ ...sources(), inspect: () => new Promise((resolve) => { finish = resolve; }) });
		await tick(); f.panel.handleInput("\r"); f.panel.handleInput("b"); f.panel.handleInput("j");
		finish(inspection()); await tick(); assert.equal(f.state.reader, undefined); assert.equal(f.state.selected.sessions, "saved");
		f.panel.handleInput("\r"); f.panel.handleInput("\x1b"); f.panel.handleInput("\x1b"); const paints = f.paints(); finish(inspection()); await tick(); assert.equal(f.paints(), paints);
		const failed = fixture({ ...sources(), inspect: async () => { throw new Error("owner unavailable exact"); } });
		await tick(); failed.panel.handleInput("\r"); await tick(); assert.match(failed.screen(), /owner unavailable exact/);
	});
	it("opens full recorded run fields and inspects its current native session ID", async () => {
		let inspected: string | undefined;
		const f = fixture({ ...sources(), inspect: async (id) => { inspected = id; return inspection(id); } });
		await tick(); f.panel.handleInput("\t"); f.panel.handleInput("\r");
		const text = defined(f.state.reader).lines.join("\n");
		for (const sentinel of ["Failure sentinel", "Result sentinel", "Progress sentinel", "2026-01-02", "Session: current"]) assert.ok(text.includes(sentinel));
		f.panel.handleInput("s"); await tick(); assert.equal(inspected, "current");
		f.panel.handleInput("o"); await tick();
		f.panel.handleInput("r"); await tick();
		f.panel.handleInput("b"); assert.match(defined(f.state.reader).lines.join("\n"), /Progress sentinel/);
	});
	it("keeps the reader's action target when an inventory refresh removes its row", async () => {
		const data = sources(); let resolve!: (rows: Awaited<ReturnType<typeof data.sessions>>) => void;
		let calls = 0; let request: unknown;
		const panel = new AgentDashboard({ ...data, sessions: async () => ++calls === 1 ? data.sessions() : new Promise((done) => { resolve = done; }) }, { terminal: { rows: 24 } as TUI["terminal"], requestRender() {} }, theme, keys, (value) => { request = value; }, undefined, true);
		await tick(); panel.handleInput("r"); await tick(); panel.handleInput("\r"); await tick();
		resolve([]); await tick(); panel.handleInput("a");
		assert.equal((request as { target: { session: { sessionId: string } } }).target.session.sessionId, "active");
	});
	it("waits for an inspection before opening actions and scrolls short-terminal help", async () => {
		let finish!: (value: AgentInspection) => void;
		const f = fixture({ ...sources(), inspect: () => new Promise((done) => { finish = done; }) });
		await tick(); f.panel.handleInput("\r"); f.panel.handleInput("a"); assert.equal(f.closes(), 0);
		finish(inspection()); await tick(); f.dimensions.rows = 6; f.panel.handleInput("?");
		const before = f.screen(40); f.panel.handleInput("\x1b[6~"); assert.notEqual(f.screen(40), before);
		f.panel.handleInput("b"); assert.ok(f.state.reader); f.panel.handleInput("\x1b"); f.panel.handleInput("\x1b"); assert.equal(f.closes(), 1);
	});
	it("routes bare commands to bounded mode-specific snapshots without model output", async (t) => {
		const notices: string[] = []; const output: string[] = [];
		const command = createAgentCommand([], sources());
		const ctx = { mode: "rpc", hasUI: true, ui: { notify: (text: string) => notices.push(text), custom: () => { throw new Error("no terminal"); } } } as unknown as ExtensionCommandContext;
		await command.handler("", ctx); assert.match(notices[0], /Agent dashboard/);
		await command.handler("help", ctx); assert.match(notices[1], /Actions:/);
		t.mock.method(process.stderr, "write", (text: string) => { output.push(text); return true; });
		for (const mode of ["print", "json"]) await showAgentDashboard(sources(), { ...ctx, mode, hasUI: false } as ExtensionCommandContext);
		assert.equal(output.length, 2); assert.ok(output.every((text) => text.includes("Result sentinel")));
	});
});
