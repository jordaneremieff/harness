import assert from "node:assert/strict";
import { it } from "node:test";
import { SessionManager, type KeybindingsManager, type Theme } from "@earendil-works/pi-coding-agent";
import { projectInspection } from "./worker.ts";
import { CURSOR_MARKER, KeybindingsManager as Keys, TUI_KEYBINDINGS, visibleWidth, type TUI } from "@earendil-works/pi-tui";
import { AgentDashboard, dashboardText, readAgentDashboard, type AgentObservationSources, type AgentSessionDescription } from "./dashboard.ts";

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const keys = new Keys(TUI_KEYBINDINGS) as KeybindingsManager;
const theme = { fg: (_color: string, text: string) => text, bg: (_color: string, text: string) => text } as Theme;
const sessions = [
	{ sessionId: "common-prefix-first", name: "Parser repair", cwd: "/work", modifiedAt: 2, live: true, operation: "op", model: { provider: "example", modelId: "reasoner", thinkingLevel: "high" }, provenance: "live" as const },
	{ sessionId: "common-prefix-second", firstMessage: "Review the release", cwd: "/work", modifiedAt: 1, live: false },
];
function fixture(overrides: Partial<AgentObservationSources> = {}) {
	const sources: AgentObservationSources = { sessions: async () => sessions, runs: async () => [], inspect: async (sessionId) => ({ sessionId, liveOwner: false, execution: { current: null, recovery: "read-only snapshot" }, result: undefined, entries: [{ id: "entry", parentId: null, type: "message", role: "assistant", preview: { text: "The regression passed.\nThe release remains held.", truncated: true }, text: "SERIALIZED-ONLY", truncated: true, nextOffset: 10 }], nextCursor: null, order: "newestFirst", detail: "source" }), ...overrides };
	const dimensions = { rows: 24 }; let paints = 0;
	const panel = new AgentDashboard(sources, { terminal: dimensions as TUI["terminal"], requestRender() { paints++; } }, theme, keys, () => {}, undefined, true);
	return { panel, dimensions, paints: () => paints, screen: (width = 120) => panel.render(width).join("\n") };
}

it("puts human identity before technical IDs and exposes state, model and controls", async () => {
	const f = fixture(); await tick();
	const text = f.screen();
	assert.match(text, /› Parser repair/);
	assert.match(text, /Active · reasoner · high/);
	assert.match(text, /Review the release/);
	for (const hint of ["/ filter", "Tab runs/sessions", "a actions", "r refresh", "q close"]) assert.ok(text.includes(hint));
	assert.ok(text.indexOf("Parser repair") < text.indexOf("common-prefix-first"));
	f.panel.handleInput("\x1b[F"); assert.equal(f.panel.state.selected.sessions, "common-prefix-second");
	f.panel.handleInput("\x1b[H"); assert.equal(f.panel.state.selected.sessions, "common-prefix-first");
});

it("shows bounded readable text before source and retains its partial label", async () => {
	const f = fixture(); await tick(); f.panel.handleInput("\r"); await tick();
	const text = f.screen();
	assert.match(text, /The regression passed/);
	assert.match(text, /Partial text/);
	assert.match(text, /Live owner state unavailable/);
	assert.doesNotMatch(text, /SERIALIZED-ONLY/);
});

it("labels projected inspection omissions in both the preview and exact-entry reader", async () => {
	const manager = SessionManager.inMemory();
	const entryId = manager.appendMessage({ role: "user", content: [{ type: "image", data: "BINARY-PAYLOAD".repeat(2000), mimeType: "image/png" }, { type: "text", text: "Readable evidence", textSignature: "OPAQUE-PAYLOAD".repeat(2000) }], timestamp: 1 });
	const calls: unknown[] = [];
	const f = fixture({ inspect: async (id, options) => { calls.push(options); return projectInspection(manager, id, options); } });
	await tick(); f.panel.handleInput("\r"); await tick();
	assert.match(f.screen(), /Readable evidence/);
	assert.match(f.screen(), /1 provider signatures; 1 image payloads; 0 redacted/);
	f.panel.handleInput("\r"); await tick();
	const lines = f.panel.state.reader?.lines.join("\n") ?? "";
	assert.match(lines, /Inspection source, not raw storage/);
	assert.match(lines, /1 provider signatures; 1 image payloads; 0 redacted/);
	assert.match(lines, /omitted: image data/);
	assert.doesNotMatch(lines, /BINARY-PAYLOAD|OPAQUE-PAYLOAD/);
	assert.deepEqual(calls, [{ limit: 12 }, { limit: 12, entryId, offset: 0 }]);
	f.panel.dispose();
});

it("follows native focus into the filter, keeps Enter, and clears Escape", async () => {
	const f = fixture(); await tick(); f.panel.focused = true; f.panel.handleInput("/");
	f.panel.handleInput("release");
	assert.match(f.screen(), new RegExp(CURSOR_MARKER));
	assert.equal(f.panel.state.selected.sessions, "common-prefix-second");
	f.panel.focused = false; assert.ok(!f.screen().includes(CURSOR_MARKER));
	f.panel.focused = true; f.panel.handleInput("\r"); assert.equal(f.panel.state.filter, "release");
	assert.ok(!f.screen().includes(CURSOR_MARKER));
	f.panel.handleInput("/"); f.panel.handleInput("\x1b"); assert.equal(f.panel.state.filter, "");
	assert.match(f.screen(), /2 total · 2 matching/);
});

it("rejects stale selected metadata and late completion after disposal", async () => {
	const pending = new Map<string, (data: AgentSessionDescription) => void>();
	const f = fixture({ describe: (id) => new Promise((resolve) => pending.set(id, resolve)) });
	await tick(); f.panel.handleInput("j");
	pending.get("common-prefix-first")?.({ name: "Wrong target", provenance: "live", model: { provider: "old", modelId: "stale", thinkingLevel: "low" }, parentSessionIds: ["wrong-parent"] });
	pending.get("common-prefix-second")?.({ provenance: "stored", model: { provider: "example", modelId: "saved", thinkingLevel: "high" }, parentSessionIds: ["known-parent"] });
	await tick(); assert.match(f.screen(), /example\/saved · high · stored/); assert.match(f.screen(), /Stored · saved · high/); assert.match(f.screen(), /known-parent/); assert.doesNotMatch(f.screen(), /wrong-parent/);
	f.panel.handleInput("r"); await tick(); f.panel.dispose(); const paints = f.paints();
	pending.get("common-prefix-second")?.({ provenance: "stored", parentSessionIds: [] }); await tick(); assert.equal(f.paints(), paints);
});

it("hides absent continuation hints and labels the action chooser without a selected target", async () => {
	const f = fixture(); await tick(); f.panel.handleInput("\r"); await tick();
	assert.doesNotMatch(f.screen().split("\n").slice(-4).join("\n"), /o older/);
	const empty = fixture({ sessions: async () => [] }); await tick(); assert.match(empty.screen(), /a all actions/);
	const chunk = fixture({ inspect: async (sessionId) => ({ sessionId, liveOwner: false, execution: { current: null, recovery: "snapshot" }, entryId: "entry", offset: 0, text: "last chunk", truncated: false, nextOffset: null }) });
	await tick(); chunk.panel.handleInput("\r"); await tick();
	assert.doesNotMatch(chunk.screen().split("\n").slice(-4).join("\n"), /n next chunk/);
});

it("keeps configuration errors visible in the reader and refreshes the selected description", async () => {
	let calls = 0;
	const f = fixture({ describe: async () => { if (++calls === 1) throw new Error("read failed sentinel"); return { provenance: "stored", model: { provider: "example", modelId: "new-config", thinkingLevel: "low" }, parentSessionIds: ["parent-exact"] }; } });
	await tick(); f.panel.handleInput("\r"); await tick(); assert.match(f.screen(), /Configuration unavailable: read failed sentinel/);
	f.panel.handleInput("r"); await tick(); const text = f.screen();
	assert.match(text, /new-config · low · stored/); assert.doesNotMatch(text, /read failed sentinel/);
	assert.ok(text.indexOf("Known parents: parent-exact") < text.indexOf("The regression passed"));
	assert.equal(text.split("new-config").length - 1, 1);
});

it("includes already available configuration and known parents in non-TUI snapshots", async () => {
	const text = dashboardText(await readAgentDashboard({ sessions: async () => [{ ...sessions[0], parentSessionIds: ["parent-exact"] }], runs: async () => [] }));
	assert.match(text, /Model: example\/reasoner · high · live/);
	assert.match(text, /Known parents: parent-exact/);
});

it("keeps selected stored configuration visible at narrow sizes and sanitizes model control sequences", async () => {
	const f = fixture({ describe: async () => ({ provenance: "stored", model: { provider: "example", modelId: "saved", thinkingLevel: "high" }, parentSessionIds: [] }), sessions: async () => [{ ...sessions[0], model: { provider: "example", modelId: "bad\x1b[2Jmodel", thinkingLevel: "high" } }] });
	await tick(); f.dimensions.rows = 18;
	const lines = f.panel.render(60); assert.ok(lines.every((line) => visibleWidth(line) <= 60));
	assert.match(lines.join("\n"), /example\/saved · high · stored/);
	assert.doesNotMatch(lines.join("\n"), /\x1b\[2J/);
});
