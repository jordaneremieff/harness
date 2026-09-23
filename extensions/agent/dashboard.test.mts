import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ExtensionCommandContext, KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { KeybindingsManager as Keys, TUI_KEYBINDINGS, visibleWidth, type TUI } from "@earendil-works/pi-tui";
import { AgentDashboard, dashboardText, readAgentDashboard, showAgentDashboard, type AgentObservationSources } from "./dashboard.ts";
import { createAgentCommand } from "./command.ts";
import type { DetachedRunView } from "./detached.ts";

const theme = { fg: (_color: string, value: string) => value } as Theme;
const keys = new Keys(TUI_KEYBINDINGS) as KeybindingsManager;
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const run: DetachedRunView = { runId: "run-1", sessionId: "original", currentSessionId: "current", sessionsRoot: "/sessions", agentDir: "/agent", cwd: "/work", prompt: "Audit parser", logFile: "/log", startedAt: "2026-01-01", pid: 1, launchState: "started", state: "finished", summary: "Result sentinel" };
function sources(): AgentObservationSources {
	return { sessions: async () => [
		{ sessionId: "saved", cwd: "/work/saved", modifiedAt: 1, live: false },
		{ sessionId: "active", name: "Parser", cwd: "/work/active", modifiedAt: 2, live: true, operation: "op" },
	], runs: async () => [run] };
}

describe("agent dashboard observations", () => {
	it("reports known state without interpreting stored metadata as live status", async () => {
		const snapshot = await readAgentDashboard(sources());
		assert.equal(snapshot.sessions.total, 2);
		assert.match(snapshot.sessions.rows[0][0], /Active work/);
		const text = dashboardText(snapshot);
		assert.match(text, /Stored; owner state unavailable/);
		assert.match(text, /Session: current/);
		assert.match(text, /Result sentinel/);
		assert.match(text, /recorded, not a live query/);
		assert.match(text, /\/agent help/);
	});

	it("distinguishes empty and unavailable sources, including synchronous failure", async () => {
		const empty = dashboardText(await readAgentDashboard({ sessions: async () => [], runs: async () => [] }));
		assert.match(empty, /Sessions: 0 total; 0 shown; 0 omitted\nNone found/);
		const unavailable = await readAgentDashboard({ sessions: () => { throw new Error("storage\x1b[2J unavailable"); }, runs: sources().runs });
		assert.match(dashboardText(unavailable), /Sessions: unavailable/);
		assert.match(dashboardText(unavailable), /Result sentinel/);
		assert.doesNotMatch(dashboardText(unavailable), /\x1b/);
	});

	it("bounds records and text while reporting every omitted record", async () => {
		const snapshot = await readAgentDashboard({ sessions: async () => Array.from({ length: 80 }, (_, i) => ({ sessionId: `session-${i}`, cwd: "x".repeat(10000), name: "\x1b[31m".repeat(10000), modifiedAt: i, live: false })), runs: async () => [] });
		assert.match(dashboardText(snapshot), /80 total; 50 shown; 30 omitted/);
		assert.ok(dashboardText(snapshot).length < 33000);
		assert.doesNotMatch(dashboardText(snapshot), /\x1b/);
	});
});

describe("agent dashboard interaction", () => {
	it("refreshes only on request, pages, resizes, switches views, and closes once", async () => {
		let reads = 0; let paints = 0; let closes = 0;
		const dimensions = { rows: 20 };
		const terminal = dimensions as TUI["terminal"];
		const data = sources();
		const panel = new AgentDashboard({ ...data, sessions: async () => { reads++; return (await data.sessions()).map((row) => ({ ...row, name: `revision-${reads}` })); } }, { terminal, requestRender() { paints++; } }, theme, keys, () => { closes++; });
		assert.match(panel.render(60).join("\n"), /Read in progress/);
		await tick();
		assert.equal(reads, 1);
		assert.match(panel.render(100).join("\n"), /revision-1/);
		dimensions.rows = 14;
		panel.handleInput("j");
		assert.match(panel.render(100).join("\n"), /Page 2\/2/);
		panel.handleInput("k");
		assert.match(panel.render(100).join("\n"), /Page 1\/2/);
		panel.handleInput("r"); await tick();
		assert.match(panel.render(100).join("\n"), /revision-2/);
		panel.handleInput("\t");
		assert.match(panel.render(100).join("\n"), /Result sentinel/);
		for (const width of [1, 30, 48, 100]) {
			const lines = panel.render(width);
			assert.ok(lines.length <= terminal.rows - 2);
			assert.ok(lines.every((line) => visibleWidth(line) <= width));
		}
		assert.equal(reads, 2);
		panel.handleInput("q"); panel.handleInput("q"); panel.handleInput("r");
		assert.equal(closes, 1); assert.equal(reads, 2); assert.ok(paints > 0);
	});

	it("honors configured cancellation and ignores refresh results after disposal", async () => {
		let finish!: (value: []) => void; let paints = 0; let closes = 0;
		const panel = new AgentDashboard({ sessions: () => new Promise<[]>((resolve) => { finish = resolve; }), runs: async () => [] }, { terminal: { rows: 24 } as TUI["terminal"], requestRender() { paints++; } }, theme, new Keys(TUI_KEYBINDINGS, { "tui.select.cancel": "ctrl+x" }) as KeybindingsManager, () => { closes++; });
		await tick();
		panel.handleInput("r");
		panel.handleInput("\x18"); assert.equal(closes, 1);
		const prior = paints; finish([]); await tick();
		assert.equal(paints, prior);
		panel.dispose(); await panel.refresh(); assert.equal(paints, prior);
	});

	it("uses a terminal-sized native overlay instead of the shared editor dock", async () => {
		let options: unknown;
		await showAgentDashboard(sources(), { mode: "tui", hasUI: true, ui: { custom: async (_factory: unknown, supplied: unknown) => { options = supplied; } } } as unknown as ExtensionCommandContext);
		assert.deepEqual(options, { overlay: true, overlayOptions: { width: "100%", maxHeight: "100%", margin: { top: 1, bottom: 1 } } });
	});

	it("routes bare commands to a dashboard and leaves explicit help available", async () => {
		const notices: string[] = [];
		const command = createAgentCommand([], sources());
		const ctx = { mode: "rpc", hasUI: true, ui: { notify: (text: string) => notices.push(text), custom: () => { throw new Error("RPC must not create a terminal component"); } } } as unknown as ExtensionCommandContext;
		await command.handler("", ctx);
		assert.match(notices[0], /Agent dashboard/);
		await command.handler("help", ctx);
		assert.match(notices[1], /Actions:/);
	});

	it("uses stderr for no-UI diagnostics, not protocol stdout or a discarded notification", async (t) => {
		const output: string[] = [];
		t.mock.method(process.stderr, "write", (text: string) => { output.push(text); return true; });
		for (const mode of ["print", "json"]) await showAgentDashboard(sources(), { mode, hasUI: false, ui: { notify: () => { throw new Error("no UI"); }, custom: () => { throw new Error("no TUI"); } } } as unknown as ExtensionCommandContext);
		assert.equal(output.length, 2);
		assert.ok(output.every((text) => text.includes("Result sentinel")));
	});
});
