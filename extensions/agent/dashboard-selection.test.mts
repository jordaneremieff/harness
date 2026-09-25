import assert from "node:assert/strict";
import { it } from "node:test";
import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { KeybindingsManager as Keys, TUI_KEYBINDINGS, visibleWidth, type TUI } from "@earendil-works/pi-tui";
import { AgentDashboard, dashboardRecords, readAgentDashboard, type AgentInspection, type AgentObservationSources } from "./dashboard.ts";

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const keys = new Keys(TUI_KEYBINDINGS) as KeybindingsManager;
const theme = { fg: (_: string, text: string) => text, bg: (_: string, text: string) => text, bold: (text: string) => text, italic: (text: string) => text, strikethrough: (text: string) => text, underline: (text: string) => text } as Theme;
const now = Date.now();
const sessions = ["alpha", "bravo"].map((id, i) => ({ sessionId: `session-${id}`, name: "Parser audit", firstMessage: "Check the parser.", cwd: `/work/${id}`, modifiedAt: now - i * 90000, live: true, operation: i ? null : "operation", model: { provider: "sample", modelId: "reasoner", thinkingLevel: "high" } }));
function inspection(id: string, text = "Latest meaningful result"): AgentInspection {
	return { sessionId: id, liveOwner: false, execution: { current: null, recovery: "snapshot" }, entries: [
		{ id: "metadata", parentId: null, type: "session_info", role: undefined, text: "{}", truncated: false, nextOffset: null, preview: { text: "Static name", truncated: false } },
		{ id: "message-id", parentId: null, type: "message", role: "assistant", text: "{}", truncated: false, nextOffset: null, preview: { text, truncated: true } },
	], result: undefined, nextCursor: 1, order: "newestFirst", detail: "source" };
}
function fixture(overrides: Partial<AgentObservationSources> = {}) {
	const calls: string[] = []; let paints = 0;
	const sources: AgentObservationSources = { sessions: async () => sessions.map((row) => ({ ...row })), runs: async () => [], inspect: async (id) => { calls.push(id); return inspection(id); }, ...overrides };
	const panel = new AgentDashboard(sources, { terminal: { rows: 24 } as TUI["terminal"], requestRender() { paints++; } }, theme, keys, () => {});
	return { panel, calls, paints: () => paints };
}
it("renders selected message text, modification age, and duplicate identities at both roster widths", async () => {
	const f = fixture(); await tick();
	for (const width of [80, 120]) {
		const lines = f.panel.render(width); const text = lines.join("\n");
		assert.ok(lines.every((line) => visibleWidth(line) <= width));
		for (const value of ["Latest assistant", "partial text", "Latest meaningful result", "Check the parser", "[alpha]", "[bravo]", "mod 1m30s"]) assert.ok(text.includes(value), `${width}: ${value}`);
		assert.doesNotMatch(text, /Static name/);
	}
	assert.deepEqual(f.calls, ["session-alpha"]);
	f.panel.render(80); f.panel.render(120); assert.equal(f.calls.length, 1);
	f.panel.handleInput("j"); await tick(); assert.deepEqual(f.calls, ["session-alpha", "session-bravo"]);
	f.panel.dispose();
});
it("reserves a distinct ID suffix for colliding directories and long names", async () => {
	const f = fixture({ sessions: async () => sessions.map((row) => ({ ...row, cwd: "/work/same", name: "Long title ".repeat(20) })) }); await tick();
	for (const width of [80, 120]) {
		const text = f.panel.render(width).join("\n"); assert.match(text, /\[-alpha\]/); assert.match(text, /\[-bravo\]/);
	}
	f.panel.dispose();
});
it("uses distinct suffixes when directory names collide with ID suffixes", async () => {
	const f = fixture({ sessions: async () => [
		{ ...sessions[0], sessionId: "id-111111", cwd: "/work/abcdef" },
		{ ...sessions[1], sessionId: "id-abcdef", cwd: "/work/shared" },
		{ ...sessions[1], sessionId: "id-333333", cwd: "/work/shared" },
	] }); await tick();
	for (const width of [80, 120]) {
		const labels = f.panel.render(width).filter((line) => line.includes("Parser audit [")).map((line) => line.match(/Parser audit \[[^\]]+\]/)?.[0]);
		assert.equal(labels.length, 3); assert.equal(new Set(labels).size, 3);
	}
	f.panel.dispose();
});
it("renders compact and wide selected Markdown without hiding the body after a heading", async () => {
	const f = fixture({ inspect: async (id) => inspection(id, "# Result\n\nThe **parser** is ready.") }); await tick();
	for (const width of [80, 120]) {
		const screen = f.panel.render(width).join("\n");
		assert.match(screen, /Result/); assert.match(screen, /The parser is ready/); assert.doesNotMatch(screen, /# Result|\*\*parser\*\*/);
	}
	f.panel.dispose();
});
it("retains selected-only model search across inventory refresh", async () => {
	let descriptions = 0;
	const f = fixture({ sessions: async () => [{ ...sessions[0], model: undefined, live: false }], describe: async () => {
		descriptions++; return { provenance: "stored", parentSessionIds: [], model: { provider: "sample", modelId: "selected-model", thinkingLevel: "low" } };
	} }); await tick();
	f.panel.handleInput("/"); f.panel.handleInput("selected-model"); f.panel.handleInput("\r");
	await f.panel.refresh(); await tick();
	assert.match(f.panel.render(120).join("\n"), /1 matching/); assert.equal(f.panel.state.selected.sessions, "session-alpha");
	assert.equal(descriptions, 2); assert.deepEqual(f.calls, ["session-alpha", "session-alpha"]); f.panel.dispose();
});
it("restarts selected preview when late model metadata satisfies a confirmed filter", async () => {
	let resolve!: (data: Awaited<ReturnType<NonNullable<AgentObservationSources["describe"]>>>) => void;
	const f = fixture({ sessions: async () => [{ ...sessions[0], model: undefined, live: false }], describe: () => new Promise((done) => { resolve = done; }) }); await tick();
	f.panel.handleInput("/"); f.panel.handleInput("selected-model"); f.panel.handleInput("\r");
	assert.match(f.panel.render(120).join("\n"), /0 matching/);
	resolve({ provenance: "stored", parentSessionIds: [], model: { provider: "sample", modelId: "selected-model", thinkingLevel: "low" } }); await tick();
	assert.match(f.panel.render(120).join("\n"), /1 matching/); assert.match(f.panel.render(120).join("\n"), /Latest meaningful result/);
	assert.deepEqual(f.calls, ["session-alpha", "session-alpha"]); f.panel.dispose();
});
it("searches known displayed states and model fields before the row cap without inspecting other sessions", async () => {
	const rows = [
		...sessions,
		...(["stopping", "cleanup-incomplete", "terminal", "replacement-failed"] as const).map((hostState) => ({ ...sessions[1], sessionId: hostState, hostState, live: false })),
		{ ...sessions[1], sessionId: "stored", live: false },
		{ ...sessions[1], sessionId: "detached", detachedRunId: "run" },
	];
	const snapshot = await readAgentDashboard({ sessions: async () => rows, runs: async () => [] });
	for (const query of ["Active", "Open here", "Stored", "Detached", "Host stopping", "cleanup-incomplete", "terminal", "replacement-failed", "sample/reasoner", "high"]) assert.ok(dashboardRecords(snapshot.sessions, query).matching > 0, query);
	const f = fixture({ sessions: async () => rows }); await tick();
	for (const width of [80, 120]) {
		f.panel.handleInput("/"); f.panel.handleInput("reasoner"); f.panel.handleInput("\r");
		assert.match(f.panel.render(width).join("\n"), /8 matching/);
		f.panel.handleInput("/"); f.panel.handleInput("\x1b");
		f.panel.handleInput("/"); f.panel.handleInput("active"); f.panel.handleInput("\r");
		assert.match(f.panel.render(width).join("\n"), /1 matching/);
		f.panel.handleInput("/"); f.panel.handleInput("\x1b");
	}
	assert.deepEqual(f.calls, ["session-alpha"]); f.panel.dispose();
});
it("cancels old preview reads and ignores stale success, stale failure, empty selection, and disposal", async () => {
	const pending: { id: string; signal?: AbortSignal; resolve: (data: AgentInspection) => void; reject: (error: Error) => void }[] = [];
	const f = fixture({ inspect: (id, _options, signal) => new Promise((resolve, reject) => pending.push({ id, signal, resolve, reject })) });
	await tick(); f.panel.handleInput("j"); await tick(); assert.equal(pending[0].signal?.aborted, true);
	pending[0].resolve(inspection("session-alpha", "STALE")); pending[1].resolve(inspection("session-bravo", "Current result")); await tick();
	assert.match(f.panel.render(80).join("\n"), /Current result/); assert.doesNotMatch(f.panel.render(120).join("\n"), /STALE/);
	f.panel.handleInput("r"); await tick();
	f.panel.handleInput("/"); f.panel.handleInput("no match"); await tick(); assert.equal(pending[2].signal?.aborted, true);
	pending[2].reject(new Error("STALE FAILURE")); await tick(); assert.doesNotMatch(f.panel.render(120).join("\n"), /STALE FAILURE/);
	f.panel.handleInput("\x1b"); await tick(); f.panel.dispose(); const paints = f.paints();
	assert.equal(pending[3].signal?.aborted, true); pending[3].resolve(inspection("session-alpha", "LATE")); await tick(); assert.equal(f.paints(), paints);
});
it("labels preview errors, no recent message text, and selected configuration search without a transcript scan", async () => {
	const failed = fixture({ inspect: async () => { throw new Error("read failed"); } }); await tick();
	assert.match(failed.panel.render(80).join("\n"), /Latest text unavailable/); assert.match(failed.panel.render(80).join("\n"), /read failed/); failed.panel.dispose();
	const empty = fixture({ inspect: async (id) => ({ ...inspection(id), entries: [], nextCursor: 1 }) }); await tick();
	assert.match(empty.panel.render(120).join("\n"), /No message text in the recent page/); empty.panel.dispose();
	const model = fixture({ describe: async () => ({ provenance: "stored", parentSessionIds: [], model: { provider: "sample", modelId: "selected-model", thinkingLevel: "low" } }) }); await tick();
	model.panel.handleInput("/"); model.panel.handleInput("selected-model"); model.panel.handleInput("\r");
	assert.match(model.panel.render(120).join("\n"), /1 matching/); assert.equal(model.calls.length, 1); model.panel.dispose();
});
