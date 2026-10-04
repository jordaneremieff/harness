import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { describe, it } from "node:test";
import { stripVTControlCharacters } from "node:util";
import type { AgentToolResult, Theme, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { CustomMessageComponent, initTheme } from "@earendil-works/pi-coding-agent";
import { KeybindingsManager, TUI_KEYBINDINGS, setKeybindings, visibleWidth } from "@earendil-works/pi-tui";
import {
	createAgentToolCards,
	displayPreview,
	displayText,
	renderAbortCall,
	renderAgentCall,
	renderAgentResult,
	renderCommandCall,
	renderCompactCall,
	renderCompactResult,
	renderInspectCall,
	renderInspectResult,
	renderListCall,
	renderListResult,
	renderSendCall,
	renderSendResult,
	renderSteerCall,
	renderSteerResult,
	renderAgentPeerMessage,
	operatorNoticeBody,
	renderPeerNoticeCard,
	type AgentCardContext,
} from "./tool-cards.ts";

initTheme("dark", false);
setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS));
// Native key hints read the TUI instance resolved by the coding-agent package.
const nativeTui = await import(createRequire(import.meta.resolve("@earendil-works/pi-coding-agent")).resolve("@earendil-works/pi-tui"));
const theme = { fg: (_color: string, value: string) => value, bg: (_color: string, value: string) => value, getBgAnsi: () => "", bold: (value: string) => value } as unknown as Theme;
const screen = (component: { render(width: number): string[] }, width = 100) => component.render(width).map((line) => stripVTControlCharacters(line).trimEnd()).join("\n");
const context = (overrides: Partial<AgentCardContext> = {}): AgentCardContext => ({ args: {}, expanded: false, argsComplete: true, isError: false, ...overrides });
const result = (details: unknown, text = JSON.stringify(details)): AgentToolResult<unknown> => ({ content: [{ type: "text", text }], details });
const conversationStatus = (overrides: Record<string, unknown> = {}) => ({
	conversationId: 1, identity: "storage-a", name: "Parser review", busy: true, cwd: "/work", lastText: "Check the source\u001b",
	live: { run: { taskId: 7 }, tools: [{ callId: "call-7", name: "read", status: "running" }, { callId: "call-8", name: "bash", status: "pending" }] },
	inbox: { items: [{ id: 1, mode: "steer", content: "queued" }] }, usage: {},
	agent: { model: { provider: "provider", modelId: "model" }, thinkingLevel: "high", extensions: ["a"], tools: ["read", "bash"], cwd: "/work" },
	tasks: [{ id: 7, kind: "pi.generation", status: "running", background: false, abortRequested: false }],
	submissions: [{ id: 3, type: "input", status: "done", entryId: 1, answerEntryId: 2 }],
	...overrides,
});
const snapshotResult = (status: Record<string, unknown>, outer: Record<string, unknown> = {}) => result({ sessionId: "storage-a", cwd: "/work", status: { conversation: status, inventory: { contributions: [], ordinaryOnly: ["/ext/ordinary.ts"] }, ...outer }, admission: { submissionId: 9, conversationId: 1, deduped: false, identity: "storage-a" }, lifetime: "independent host process" });

describe("agent call cards", () => {
	it("shows explicit requests without unresolved default chatter", () => {
		const spawn = screen(renderAgentCall("agent_spawn", { name: "Parser review", model: "provider/model", thinkingLevel: "high" }, theme, context()), 160);
		assert.match(spawn, /agent_spawn · Parser review/);
		assert.match(spawn, /Requested: provider\/model · high/);
		assert.doesNotMatch(spawn, /Model: |snapshot/);
		assert.doesNotMatch(screen(renderAgentCall("agent_spawn", {}, theme, context())), /Requested:|unresolved/);
		assert.doesNotMatch(screen(renderAgentCall("agent_place", { area: "project" }, theme, context())), /Requested:|unresolved/);
		assert.doesNotMatch(screen(renderAgentCall("agent_configure", { sessionId: "target", name: "" }, theme, context())), /Requested:|unresolved/);
		assert.match(screen(renderAgentCall("agent_configure", { sessionId: "target", model: "provider/model" }, theme, context())), /Requested: provider\/model/);
		assert.doesNotMatch(screen(renderAgentCall("agent_status", {}, theme, context())), /Requested:/);
	});

	it("renders a bare heading for missing arguments and reuses its component", () => {
		const initial = renderAgentCall("agent_spawn", null, theme, context());
		assert.match(screen(initial), /^agent_spawn/);
		const final = renderAgentCall("agent_spawn", { prompt: "/project/location" }, theme, context({ expanded: true, lastComponent: initial }));
		assert.equal(initial, final);
		assert.match(screen(final), /project\/location/);
	});

	it("shows an argument hint only when a collapsed call hides or clips content", () => {
		assert.equal(screen(renderAgentCall("agent_status", { sessionId: "s" }, theme, context())), "agent_status · s");
		assert.doesNotMatch(screen(renderAgentCall("agent_attach", { sessionId: "s" }, theme, context())), /expand for full details/);
		assert.match(screen(renderAgentCall("agent_attach", { sessionId: "s", model: "p/m" }, theme, context())), /Requested: p\/m/);
		assert.match(screen(renderAgentCall("agent_spawn", { prompt: "p".repeat(400) }, theme, context())), /expand for full details/);
		assert.match(screen(renderListCall({ query: "q".repeat(400) }, theme, context())), /expand for full details/);
	});

	it("escapes controls and fits narrow widths", () => {
		const hostile = "日本語 😀\x1b]52;c;data\x07\u202e";
		const view = renderAgentCall("agent_spawn", { model: `provider/${"long-".repeat(80)}`, prompt: hostile, cwd: "/project" }, theme, context());
		for (const width of [12, 24, 80, 160]) {
			assert.ok(view.render(width).every((line) => visibleWidth(line) <= width));
			assert.doesNotMatch(screen(view, width), /[\x1b\x07\u202e]/u);
		}
		const expanded = renderAgentCall("agent_spawn", { prompt: hostile }, theme, context({ expanded: true }));
		assert.ok(screen(expanded).includes(displayText(hostile)));
	});

	it("shows a send or steer target, reply reference, preview, and full submitted text", () => {
		for (const [renderer, name] of [[renderSendCall, "agent_send"], [renderSteerCall, "agent_steer"]] as const) {
			const args = { sessionId: "target-session", message: "First line\n\n**literal Markdown** and `code`\nLast line", replyTo: "message-reference" };
			const before = structuredClone(args);
			const collapsed = renderer(args, theme, context());
			assert.match(screen(collapsed), new RegExp(`${name} → target-s…`));
			assert.match(screen(collapsed), /reply to message-…/);
			assert.match(screen(collapsed), /First line \*\*literal Markdown\*\*/);
			assert.match(screen(collapsed), /expand for full details/);
			const expanded = renderer(args, theme, context({ expanded: true, lastComponent: collapsed }));
			assert.equal(expanded, collapsed);
			assert.ok(screen(expanded).includes(args.message));
			assert.deepEqual(args, before);
		}
	});

	it("distinguishes pending, whitespace-only, and bounded messages", () => {
		assert.match(screen(renderSendCall({ sessionId: "t", message: " \n " }, theme, context())), /empty or whitespace-only message/);
		assert.match(screen(renderSendCall({ sessionId: "t", message: " " }, theme, context({ argsComplete: false }))), /message pending/);
		assert.match(screen(renderSendCall({}, theme, context())), /\(target pending\)/);
		const message = `${"long line\n".repeat(5000)}EXACT_END`;
		const expanded = screen(renderSendCall({ sessionId: "t", message }, theme, context({ expanded: true })));
		assert.match(expanded, /Display limit: \d+ more UTF-16 code units/);
		assert.equal(displayPreview("a😀b", 2), "a…");
	});

	it("marks a compact summary call as self and keeps the summary text hidden", () => {
		const summary = "Objective: hand over the slice. Next: run the checks.";
		const text = screen(renderCompactCall({ sessionId: "current-session", summary }, theme, context()));
		assert.match(text, /agent_compact · self · current-…/);
		assert.match(text, new RegExp(`Summary: ${summary.length} chars`));
		assert.doesNotMatch(text, /Objective: hand over/);
		const plain = screen(renderCompactCall({ sessionId: "worker-session" }, theme, context()));
		assert.match(plain, /Compacts after abort/);
		assert.match(plain, /[Ii]nstructions: none/);
		assert.match(screen(renderCompactCall({ sessionId: "w", instructions: "Keep the API section" }, theme, context())), /[Ii]nstructions: present/);
		assert.doesNotMatch(screen(renderCompactCall({ sessionId: "w", instructions: "Keep the API section" }, theme, context())), /Keep the API section/);
	});

	it("summarizes list, inspect, abort, and command calls", () => {
		const list = screen(renderListCall({ query: "renderer", cwd: "/srv/work", limit: 5, cursor: "Y3Vyc29y" }, theme, context()));
		assert.match(list, /agent_list · query renderer/);
		assert.match(list, /cwd \/srv\/work · limit 5 · continuation page/);
		const inspect = screen(renderInspectCall({ sessionId: "s", view: "search", query: "needle", source: "assistant", continuation: "dGV4dA" }, theme, context()));
		assert.match(inspect, /view search · query needle · source assistant · continuation/);
		assert.match(screen(renderInspectCall({ sessionId: "s", view: "activity" }, theme, context())), /view activity · limit 4 \(default\)/);
		assert.match(screen(renderAbortCall({ sessionId: "s" }, theme, context())), /agent_abort · s/);
		assert.match(screen(renderCommandCall({ sessionId: "s", name: "reload", args: "--force" }, theme, context())), /agent_command · reload → s/);
		assert.match(screen(renderCommandCall({ sessionId: "s", name: "reload", args: "--force" }, theme, context())), /args --force/);
		assert.match(screen(renderInspectCall({}, theme, context())), /\(target pending\)/);
	});
});

describe("agent result cards", () => {
	it("shows the snapshot model, activity, running tools, pending input, and capability limits", () => {
		const resultValue = snapshotResult(conversationStatus());
		const before = structuredClone(resultValue);
		const card = renderAgentResult(resultValue, { expanded: false, isPartial: false }, theme, context());
		const text = screen(card, 180);
		assert.match(text, /Parser review/);
		assert.match(text, /Model: provider\/model · thinking high/);
		assert.match(text, /Activity: working · tool read · 1 pending/);
		assert.match(text, /Running: read · call call-7/);
		assert.match(text, /Running: bash · call call-8 · pending/);
		assert.match(text, /Working on the task: Check the source\\u\{1b\}/);
		assert.match(text, /Saved: done · submission 3/);
		assert.match(text, /Capability limits: 1 configured extension without a native form/);
		assert.deepEqual(resultValue, before);
		for (const width of [12, 40, 100]) assert.ok(card.render(width).every((line) => visibleWidth(line) <= width));
		const expanded = screen(renderAgentResult(resultValue, { expanded: true, isPartial: false }, theme, context()), 240);
		assert.match(expanded, /"callId": "call-7"/);
	});

	it("marks a cold snapshot read-only instead of reporting it idle", () => {
		const readOnly = snapshotResult(conversationStatus({ busy: false, live: {} }), { live: false });
		const text = screen(renderAgentResult(readOnly, { expanded: false, isPartial: false }, theme, context()), 180);
		assert.match(text, /Read-only snapshot; live owner state unavailable/);
		assert.match(text, /Activity: idle/);
	});

	it("labels the newest text by state instead of claiming an in-progress reply", () => {
		const render = (status: Record<string, unknown>) => screen(renderAgentResult(snapshotResult(status), { expanded: false, isPartial: false }, theme, context()), 180);
		assert.match(render(conversationStatus({ busy: true, lastText: "Ran crash-1." })), /Working on the task: Ran crash-1\./);
		assert.match(render(conversationStatus({ busy: false, live: {}, lastText: "Ran crash-1." })), /Latest message: Ran crash-1\./);
		assert.match(render(conversationStatus({ busy: false, live: {}, lastText: "Done reviewing." })), /Latest message: Done reviewing\./);
		const idle = render(conversationStatus({ busy: false, live: {}, lastText: "Ran crash-1." }));
		assert.doesNotMatch(idle, /Assistant in progress/u);
		assert.doesNotMatch(idle, /Latest input|Latest reply/u);
		assert.match(render(conversationStatus({ busy: false, live: {}, lastText: "Done reviewing.", lastTextRole: "assistant" })), /Latest reply: Done reviewing\./);
		assert.match(render(conversationStatus({ busy: true, lastText: "Check the parser", lastTextRole: "user" })), /Working on input: Check the parser/);
		assert.match(render(conversationStatus({ busy: false, live: {}, lastText: "Check the parser", lastTextRole: "user" })), /Latest input: Check the parser/);
	});

	it("renders a compact mutation status with state and capability limits", () => {
		const compact = result({ sessionId: "storage-a", cwd: "/work", admission: { submissionId: 9, conversationId: 1, deduped: false }, status: { identity: "storage-a", conversationId: 1, name: "Parser review", cwd: "/work", busy: false, state: "idle", agent: { model: { provider: "provider", modelId: "model" }, thinkingLevel: "high" }, limits: { ordinaryOnly: ["/ext/ordinary.ts"] } } });
		const text = screen(renderAgentResult(compact, { expanded: false, isPartial: false }, theme, context()), 180);
		assert.match(text, /Parser review/);
		assert.match(text, /Model: provider\/model · thinking high/);
		assert.match(text, /State: idle/);
		assert.match(text, /Capability limits: 1 configured extension without a native form/);
		assert.doesNotMatch(text, /Activity: idle · pending unknown/u);
	});

	it("shows a stalled delivery from the host status", () => {
		const status = result({ conversation: conversationStatus({ busy: false, live: {} }), inventory: { contributions: [], ordinaryOnly: [] }, pid: 1, storageId: "storage-a", deliveryError: "primary owner 18f6603b runs an agent extension with endpoint version 1; this host requires version 2. Restart that Pi process to load the current extension." });
		const text = screen(renderAgentResult(status, { expanded: false, isPartial: false }, theme, context()), 240);
		assert.match(text, /Delivery paused: /);
		assert.match(text, /Restart that Pi process/u);
	});

	it("shows an enriched mutation snapshot beside its receipt", () => {
		const fork = result({ conversationId: 2, identity: "storage-a:2", deduped: false, status: { conversation: conversationStatus({ name: "Forked review" }) } });
		const text = screen(renderAgentResult(fork, { expanded: false, isPartial: false }, theme, context()), 180);
		assert.match(text, /Model: provider\/model · thinking high/);
		assert.match(text, /Fork created · storage-…:2/);
	});

	it("keeps a successful mutation receipt when the post-mutation snapshot failed", () => {
		const fork = result({ conversationId: 2, identity: "storage-a:2", deduped: false, snapshotError: "claim refused after mutation" });
		const card = renderAgentResult(fork, { expanded: false, isPartial: false }, theme, context());
		const text = screen(card, 180);
		assert.match(text, /Snapshot unavailable: claim refused after mutation/);
		assert.match(text, /Fork created · storage-…:2/);
		assert.doesNotMatch(text, /Model: |Activity:/);
		for (const width of [12, 40, 100]) assert.ok(card.render(width).every((line) => visibleWidth(line) <= width));
	});

	it("accepts a bare conversation status and a conversations wrapper without inventing cost", () => {
		const bare = screen(renderAgentResult(result({ conversation: conversationStatus({ busy: false, live: {} }) }), { expanded: false, isPartial: false }, theme, context()), 180);
		assert.match(bare, /Activity: idle/);
		const wrapped = screen(renderAgentResult(result({ conversations: [conversationStatus(), conversationStatus({ identity: "storage-a:2", busy: false, live: {} })] }), { expanded: false, isPartial: false }, theme, context()), 180);
		assert.match(wrapped, /2 conversations · 1 working/);
		assert.doesNotMatch(wrapped, /\$0\.00/);
	});

	it("summarizes a status overview with unavailable storage counters", () => {
		const details = {
			sessions: [
				{ id: "a", name: "Parser review", state: "working", cost: 0.25, partial: false },
				{ id: "b", name: "Reviewer", state: "idle", cost: 0.5, partial: true },
				{ id: "c", state: "done", cost: 0, partial: false },
				{ id: "d", state: "failed", cost: 0, partial: false },
				{ id: "e", state: "new", cost: 0, partial: false },
			],
			failures: [{ storageId: "broken", error: "unreadable" }],
		};
		const text = screen(renderAgentResult(result(details), { expanded: false, isPartial: false }, theme, context()), 180);
		assert.match(text, /5 conversations · 1 working · \$0\.75\+\n/);
		assert.match(text, /Parser review · working/);
		assert.match(text, /1 more conversation records/);
		assert.doesNotMatch(text, /≥|\+\?/);
		const complete = { ...details, sessions: details.sessions.map((row) => ({ ...row, partial: false })) };
		assert.match(screen(renderAgentResult(result(complete), { expanded: false, isPartial: false }, theme, context()), 180), /\$0\.75\n/);
		assert.match(text, /1 storage unavailable \(unknown, not absent\)/);
		assert.doesNotMatch(text, /· new/);
	});

	it("summarizes a discovery page with coverage and the next page", () => {
		const details = { rows: [{}, {}], nextCursor: "Y3Vyc29y", coverage: { complete: false, storagesVisited: 3, unavailable: [{ storageId: "s", reason: "x" }] }, observedAt: "t", authority: "Observation grants no control or task authority" };
		const text = screen(renderListResult(result(details), { expanded: false, isPartial: false }, theme, context()));
		assert.match(text, /2 conversations on this page · 3 storages scanned · 1 storage unavailable \(unknown, not absent\)/);
		assert.match(text, /Next page available; repeat with nextCursor/);
		const covered = screen(renderListResult(result({ rows: [], nextCursor: null, coverage: { complete: true, storagesVisited: 1, unavailable: [] } }), { expanded: false, isPartial: false }, theme, context()));
		assert.match(covered, /0 conversations on this page · 1 storage scanned/);
		assert.match(covered, /Inventory covered; no further page/);
	});

	it("summarizes each inspect view against its returned bounds", () => {
		const history = { view: "history", sessionId: "s", conversationId: 1, entries: [{}, {}], nextCursor: { after: 1 }, order: "newestFirst", detail: "redacted" };
		assert.match(screen(renderInspectResult(result(history), { expanded: false, isPartial: false }, theme, context())), /history page · 2 entries/);
		assert.match(screen(renderInspectResult(result(history), { expanded: false, isPartial: false }, theme, context())), /older page available/);
		const search = { view: "search", sessionId: "s", conversationId: 1, matches: [{}], nextCursor: { after: 1 }, coverage: { scannedEntries: 12, scannedBytes: 90, complete: false }, detail: "literal" };
		assert.match(screen(renderInspectResult(result(search), { expanded: false, isPartial: false }, theme, context())), /search · 1 match · 12 entries scanned/);
		assert.match(screen(renderInspectResult(result(search), { expanded: false, isPartial: false }, theme, context())), /Continuation available/);
		const exact = { view: "exact", sessionId: "s", conversationId: 1, entryId: 5, offset: 0, text: "{}", nextOffset: 1200, truncated: true, omissions: { providerSignatures: 2, imagePayloads: 1, redactedThinking: 0 } };
		const exactText = screen(renderInspectResult(result(exact), { expanded: false, isPartial: false }, theme, context()));
		assert.match(exactText, /entry 5 · offset 0/);
		assert.match(exactText, /more of this entry remains · clipped to the display bound · 3 omitted fields/);
		const activity = { view: "activity", sessionId: "s", conversationId: 1, turns: [{}, {}], nextCursor: { after: 1 }, coverage: { scannedEntries: 7, complete: false }, detail: "newest turns first" };
		assert.match(screen(renderInspectResult(result(activity), { expanded: false, isPartial: false }, theme, context())), /activity · 2 turns · 7 entries scanned/);
		assert.match(screen(renderInspectResult(result(activity), { expanded: false, isPartial: false }, theme, context())), /older turns available/);
		const saved = { view: "result", sessionId: "s", conversationId: 1, submissionId: 9, status: "done", entryId: 1, answerEntryId: 2, answer: "Final", usage: {} };
		const savedText = screen(renderInspectResult(result(saved), { expanded: false, isPartial: false }, theme, context()));
		assert.match(savedText, /saved result · done · submission 9/);
		assert.match(savedText, /assistant answer retained/);
	});

	it("keeps an empty or bounded page calibrated to the covered ancestry", () => {
		const empty = { view: "search", sessionId: "s", conversationId: 1, matches: [], nextCursor: null, coverage: { scannedEntries: 30, complete: true }, detail: "literal" };
		const text = screen(renderInspectResult(result(empty), { expanded: false, isPartial: false }, theme, context()));
		assert.match(text, /search · 0 matches · ancestry covered/);
		assert.doesNotMatch(text, /no matches|absent|not found/i);
	});

	it("shows admission receipts, fork, rewind, configure, abort, and command outcomes", () => {
		const receipt = { submissionId: 9, conversationId: 1, deduped: false, identity: "storage-a" };
		const send = screen(renderSendResult(result(receipt), { expanded: false, isPartial: false }, theme, context()));
		assert.match(send, /Admitted/);
		assert.match(send, /Admitted · storage-…/);
		assert.match(send, /submission 9/);
		assert.match(screen(renderSteerResult(result(receipt), { expanded: false, isPartial: false }, theme, context())), /Steer admitted/);
		assert.match(screen(renderAgentResult(result({ conversationId: 2, identity: "storage-…:2", deduped: false }), { expanded: false, isPartial: false }, theme, context())), /Fork created · storage-…:2/);
		const rewind = screen(renderAgentResult(result({ conversationId: 3, identity: "storage-a:3", predecessorEntryId: 5, submissionId: 11, deduped: false }), { expanded: false, isPartial: false }, theme, context()));
		assert.match(rewind, /Rewind submitted · storage-…:3/);
		assert.match(rewind, /forked before entry 5/);
		assert.match(rewind, /submission 11/);
		assert.match(screen(renderAgentResult(result({ conversationId: 1, identity: "storage-…" }), { expanded: false, isPartial: false }, theme, context())), /Configuration applied · storage-…/);
		const abort = createAgentToolCards().agent_abort.renderResult(result({ conversationId: 1, identity: "storage-a", background: false }), { expanded: false, isPartial: false }, theme, context());
		assert.match(screen(abort), /Abort requested · storage-…/);
		const command = createAgentToolCards().agent_command.renderResult(result({ name: "reload", conversationId: 1, identity: "storage-a", text: "Reloaded 3 extensions" }), { expanded: false, isPartial: false }, theme, context());
		assert.match(screen(command), /Reloaded 3 extensions/);
		assert.match(screen(command), /command reload\nstorage-…/);
		const reload = createAgentToolCards().agent_command.renderResult(result({ sessionId: "storage-a", inventory: { contributions: [{}, {}] }, reloaded: true }), { expanded: false, isPartial: false }, theme, context());
		assert.match(screen(reload), /Host registrations reloaded/);
		assert.match(screen(reload), /2 native contributions installed/);
	});

	it("labels compact receipts, native results, partial, and error states", () => {
		const self = screen(renderCompactResult(result({ taskId: 5, status: "task" }), { expanded: false, isPartial: false }, theme, context({ args: { sessionId: "s", summary: "s" } })));
		assert.match(self, /Summary admitted · task 5/);
		assert.match(self, /Summary admitted · task 5/);
		const native = screen(renderCompactResult(result({ taskId: 6, status: "completed", entryId: 7 }), { expanded: false, isPartial: false }, theme, context({ args: { sessionId: "s" } })));
		assert.match(native, /Compaction completed · task 6/);
		assert.match(native, /summary entry 7/);
		assert.match(screen(renderCompactResult(result("queued"), { expanded: false, isPartial: true }, theme, context({ args: { summary: "s" } }))), /Compaction pending/);
		const error = renderCompactResult(result("refused"), { expanded: true, isPartial: false }, theme, context({ args: { summary: "s" }, isError: true }));
		assert.match(screen(error), /Compact error/);
		assert.doesNotMatch(screen(error), /receipt/);
	});

	it("falls back to a bounded preview for unexpected values and labels errors", () => {
		const raw = screen(renderListResult(result("inventory unreadable"), { expanded: false, isPartial: false }, theme, context()));
		assert.match(raw, /inventory unreadable/);
		assert.match(screen(renderListResult(result("denied\x1b[2J"), { expanded: false, isPartial: false }, theme, context({ isError: true }))), /List error/);
		assert.doesNotMatch(screen(renderListResult(result("denied\x1b[2J"), { expanded: false, isPartial: false }, theme, context({ isError: true }))), /\x1b/);
		assert.match(screen(renderAgentResult(result(undefined), { expanded: false, isPartial: true }, theme, context())), /Partial result/);
		assert.match(screen(renderAgentResult(result(undefined), { expanded: true, isPartial: false }, theme, context({ isError: true }))), /Tool error/);
	});

	it("bounds expanded source units and escape expansion separately", () => {
		const render = (value: string) => screen(renderAgentResult(result(undefined, value), { expanded: true, isPartial: false }, theme, context()), 800).replace(/\n/gu, "");
		const source = "\u202e".repeat(32_000);
		const escaped = "\\u{202e}".repeat(32_000);
		assert.equal(escaped.length, 256_000);
		assert.equal(render(source), escaped);
		assert.equal(render(`${source}OMITTED`), `${escaped}[Display limit: 7 more UTF-16 code units. Full text remains in native history.]`);
		assert.equal(render(`${"x".repeat(31_999)}\u{e0001}OMITTED`), `${"x".repeat(31_999)}[Display limit: 9 more UTF-16 code units. Full text remains in native history.]`);
	});
});

describe("agent result notice card", () => {
	it("shows sourced sender names and plain kinds without optional-fact placeholders", () => {
		const id = "12345678-1234-4234-8234-123456789abc";
		const cases = [
			{ details: { identity: id, name: "Catalog reader", kind: "receipt", status: "done", provider: "provider", modelId: "model", thinkingLevel: "high" }, heading: "Catalog reader · result · provider/model high" },
			{ details: { identity: id, handle: "@reader", kind: "report" }, heading: "@reader · report" },
			{ details: { senderIdentity: id, senderKind: "session", name: "Parser session", kind: "message" }, heading: "Parser session · message from another session" },
			{ details: { senderIdentity: id, senderKind: "session", observedPurpose: "Review the parser", kind: "message", provider: "provider" }, heading: "Review the parser · message from another session · provider: provider" },
			{ details: { senderIdentity: id, senderKind: "session", kind: "message" }, heading: "12345678 · message from another session" },
			{ details: { senderIdentity: id, senderKind: "session", name: "Parser session", kind: "report", threadId: "retained-thread", threadTitle: "Parser contract", operatorMessage: "The sourced event body" }, heading: "Parser contract · Parser session · thread notice" },
			{ details: { identity: id, name: "Fallback reader", kind: "receipt", status: "done", liveOwner: false, fallback: true }, heading: "Fallback reader · result" },
			{ details: {}, heading: "message from another session" },
		];
		for (const { details, heading } of cases) {
			const card = renderPeerNoticeCard({ content: "Stored model body", details }, theme, false);
			assert.ok(card);
			const lines = screen(card, 240).split("\n");
			assert.equal(lines[0]?.trim(), `[agent] ${heading}`);
			assert.doesNotMatch(lines[0] ?? "", /unknown|unavailable/u);
			if ("threadId" in details) {
				assert.match(lines.join("\n"), /The sourced event body/u);
				assert.doesNotMatch(lines.join("\n"), /Stored model body/u);
			}
			if (details.liveOwner === false) assert.match(lines.join("\n"), /No live owner; retained result only/u);
			const expanded = renderPeerNoticeCard({ content: "Stored model body", details }, theme, true);
			assert.ok(expanded);
			if (Object.keys(details).length) assert.ok(screen(expanded, 240).includes(id));
			for (const width of [20, 60, 120]) assert.ok(card.render(width).every((line) => visibleWidth(line) <= width));
		}
	});

	it("preserves full source identities in expanded details", () => {
		const sourceId = `report:${"r".repeat(400)}`;
		const senderIdentity = "12345678-1234-4234-8234-123456789abc";
		const card = renderPeerNoticeCard({ content: "Report body", details: { name: "Reader", kind: "report", senderIdentity, sourceId } }, theme, true);
		assert.ok(card);
		const text = screen(card, 600);
		assert.ok(text.includes(`sourceId: ${sourceId}`));
		assert.ok(text.includes(`senderIdentity: ${senderIdentity}`));
	});

	it("keeps a check-in headline when elapsed time, cost and configuration are absent", () => {
		const card = renderPeerNoticeCard({ content: "Stored guidance", details: { name: "Reader", message: "Current step: review", checkIn: {} } }, theme, false);
		assert.ok(card);
		const lines = screen(card, 160).split("\n");
		assert.equal(lines[0]?.trim(), "[agent] Reader · still working");
		assert.match(lines.join("\n"), /Current step: review/u);
		assert.doesNotMatch(lines[0] ?? "", /unknown|unavailable|elapsed|conversation total/u);
	});
	it("renders a receipt heading, Markdown body, and expanded source details", () => {
		const collapsed = renderAgentPeerMessage({ role: "custom", customType: "agent.peer", display: true, timestamp: 1, content: "**Review:** fix the token.\n\nKeep the identifier.", details: { submissionId: 9, identity: "storage-a", status: "done" } }, { expanded: false, outputPad: 1 }, theme);
		assert.ok(collapsed);
		const text = screen(collapsed);
		assert.match(text, /\[agent\] storage-a · result/);
		assert.doesNotMatch(text, /Open:|Source details:|\/agent opens|to expand/);
		assert.match(text, /Review: fix the token\./);
		assert.match(text, /Keep the identifier\./);
		assert.doesNotMatch(text, /\*\*|submissionId:/);
		const expanded = renderAgentPeerMessage({ role: "custom", customType: "agent.peer", display: true, timestamp: 1, content: "Body", details: { submissionId: 9, identity: "storage-a", status: "done" } }, { expanded: true, outputPad: 1 }, theme);
		assert.ok(expanded);
		const expandedText = screen(expanded);
		assert.match(expandedText, /Source details/);
		assert.match(expandedText, /submissionId: 9/);
		assert.match(expandedText, /not operator authority or task acceptance/);
	});

	it("uses the resolved display label in place of the raw identity", () => {
		const card = renderAgentPeerMessage({ role: "custom", customType: "agent.peer", display: true, timestamp: 1, content: "Done", details: { submissionId: 9, identity: "6de48f73-1111-4111-8111-111111111111", label: "poem task", status: "done" } }, { expanded: false, outputPad: 1 }, theme);
		assert.ok(card);
		const text = screen(card);
		assert.match(text, /\[agent\] poem task · result/);
		assert.doesNotMatch(text, /6de48f73/);
	});

	for (const cost of [0.125, 0, null]) it(`renders a check-in with elapsed time and cost ${cost}`, () => {
		const checkIn = { conversationId: 1, requestId: "task", origin: "model", elapsedMs: 1_800_000, cost };
		const digest = "Tool calls: 4. Current tool: bash, 8 minutes since tool-call entry. Latest reply: tests in progress.";
		const message = { role: "custom" as const, customType: "agent.peer", display: true, timestamp: 1,
			content: "Agent “reader” still working, not finished. Assess the task.\n\nUnrelated report body.",
			details: { label: "reader", senderIdentity: "storage-b", sourceId: "checkin:1:1", message: digest, checkIn } };
		const before = structuredClone(message);
		for (const expanded of [false, true]) {
			const card = renderAgentPeerMessage(message, { expanded, outputPad: 1 }, theme);
			assert.ok(card);
			const text = screen(card, 180);
			assert.match(text, /\[agent\] reader · still working · 30m/u);
			if (cost === null) assert.doesNotMatch(text, /conversation total|unavailable/u);
			else assert.match(text, new RegExp(`\\$${cost.toFixed(3).replace(".", "\\.")} conversation total`, "u"));
			assert.match(text, /Tool calls: 4/u);
			assert.doesNotMatch(text, /Unrelated report body|· report|· finished|Reported result/u);
			for (const width of [20, 60, 120]) assert.ok(card.render(width).every((line) => visibleWidth(line) <= width));
		}
		assert.deepEqual(message, before);
	});

	it("bounds a check-in digest in the expanded notice", () => {
		const card = renderPeerNoticeCard({ content: "not a finished answer", details: { label: "reader", message: `${"x".repeat(32_000)}OMITTED`,
			checkIn: { conversationId: 1, requestId: "task", origin: "model", elapsedMs: 60_000, cost: null } } }, theme, true);
		assert.ok(card);
		const text = screen(card, 180);
		assert.match(text, /Display limit/u);
		assert.doesNotMatch(text, /OMITTED|not a finished answer/u);
	});

	it("renders hours and reads the check-in body from report.message", () => {
		const card = renderPeerNoticeCard({ content: "channel text", details: { label: "reader", message: "Current tool: bash.",
			checkIn: { conversationId: 1, requestId: "task", origin: "model", elapsedMs: 11_100_000, cost: 0 } } }, theme, false);
		assert.ok(card);
		const text = screen(card, 180);
		assert.match(text, /still working · 3h05m elapsed/u);
		assert.match(text, /Current tool: bash/u);
		assert.doesNotMatch(text, /185m/u);
	});

	it("labels a report and an unanswered receipt without claiming acceptance", () => {
		const reportCard = renderAgentPeerMessage({ role: "custom", customType: "agent.peer", display: true, timestamp: 1, content: "Progress report", details: { senderIdentity: "storage-b", sourceId: "report:1", acknowledged: false } }, { expanded: false, outputPad: 1 }, theme);
		assert.ok(reportCard);
		const report = screen(reportCard);
		assert.match(report, /\[agent\] storage-b · report/);
		assert.match(report, /Progress report/);
		const unansweredCard = renderAgentPeerMessage({ role: "custom", customType: "agent.peer", display: true, timestamp: 1, content: "No answer", details: { identity: "storage-a", status: "unanswered", reason: "aborted" } }, { expanded: false, outputPad: 1 }, theme);
		assert.ok(unansweredCard);
		const unanswered = screen(unansweredCard);
		assert.match(unanswered, /\[agent\] storage-a · result/);
		assert.match(unanswered, /Result unavailable or unanswered/);
		assert.match(unanswered, /aborted/);
	});

	it("shows source name, model, reasoning, warnings, exact IDs, and the full escaped body", () => {
		const hostile = `[2J‮${"long line\n".repeat(4000)}END`;
		const card = renderAgentPeerMessage({ role: "custom", customType: "agent.peer", display: true, timestamp: 1, content: hostile, details: { submissionId: 9, entryId: 4, answerEntryId: 5, requestId: "req-1", identity: "storage-a", status: "done", name: "Message reviewer", provider: "SelectedProvider", modelId: "MixedCase-Model", thinkingLevel: "high", liveOwner: false, saved: false } }, { expanded: true, outputPad: 1 }, theme);
		assert.ok(card);
		const text = screen(card, 180);
		assert.match(text, /\[agent\] Message reviewer · result/);
		assert.match(text, /name: Message reviewer/);
		assert.match(text, /SelectedProvider\/MixedCase-Model · thinking: high/);
		assert.match(text, /No live owner; retained result only/);
		assert.match(text, /Result not saved; retained only by the live owner/);
		assert.match(text, /submissionId: 9/);
		assert.match(text, /entryId: 4/);
		assert.match(text, /answerEntryId: 5/);
		assert.match(text, /requestId: req-1/);
		assert.match(text, /END/);
		assert.doesNotMatch(text, /Display limit/);
		assert.doesNotMatch(text, /[‮]/u);
		for (const width of [20, 60, 120]) assert.ok(card.render(width).every((line) => visibleWidth(line) <= width));
	});

	it("hides model-facing caveat sentences from the operator body and keeps the answer", () => {
		const content = "Agent “reader” finished. Results do not establish task acceptance. Carried operator decisions retain their original scope; agent claims remain claims.\n\nSECOND READY\n\nUse agent_inspect for retained source evidence.";
		const card = renderAgentPeerMessage({ role: "custom", customType: "agent.peer", display: true, timestamp: 1, content, details: { label: "reader", status: "done" } }, { expanded: false, outputPad: 1 }, theme);
		assert.ok(card);
		const text = screen(card);
		assert.match(text, /\[agent\] reader · result/);
		assert.match(text, /SECOND READY/);
		assert.doesNotMatch(text, /Open:|Source details:|\/agent opens|to expand/);
		assert.doesNotMatch(text, /Results do not establish/);
		assert.doesNotMatch(text, /agent_inspect/);
		assert.doesNotMatch(text, /Agent “reader” finished\./);
	});

	it("scopes caveat removal to display and keeps report bodies", () => {
		assert.equal(operatorNoticeBody("Agent “reader” finished. Results do not establish task acceptance. Carried operator decisions retain their original scope; agent claims remain claims.\n\nbody\n\nUse agent_inspect for retained source evidence."), "body");
		assert.equal(operatorNoticeBody("Agent “reader” sent a report. Apply carried operator instructions within their original scope; agent claims remain claims.\n\nreport body"), "report body");
		assert.equal(operatorNoticeBody("plain body"), "plain body");
		const stored = "Answer. Results do not establish task acceptance. Carried operator decisions retain their original scope; agent claims remain claims.";
		assert.equal(operatorNoticeBody(stored), "Answer.");
		assert.match(stored, /Results do not establish/, "the stored model content is unchanged");
	});

	it("keeps the label, outcome, model and reasoning on one line without extra spacing", () => {
		const message = { role: "custom" as const, customType: "agent.peer", display: true, timestamp: 1, content: "A short answer.\n\n", details: { label: "A very long task label ".repeat(8), provider: "provider", modelId: "model", thinkingLevel: "high", status: "done" } };
		const before = structuredClone(message);
		const card = renderAgentPeerMessage(message, { expanded: false, outputPad: 1 }, theme);
		assert.ok(card);
		for (const width of [80, 140]) {
			const lines: string[] = card.render(width).map((line) => stripVTControlCharacters(line).trimEnd());
			assert.equal(lines.length, 2);
			assert.match(lines[0] ?? "", /\[agent\] A very long.* · result · provider\/model high/);
			assert.equal(lines[1]?.trim(), "A short answer.");
			assert.ok(card.render(width).every((line) => visibleWidth(line) <= width));
			assert.doesNotMatch(lines.join("\n"), /Open:|Source details|to expand|opens the dashboard/);
		}
		assert.deepEqual(message, before);
	});

	it("bounds Markdown by visual lines and reveals the full body and source only when expanded", (t) => {
		const previousKeys = nativeTui.getKeybindings();
		nativeTui.setKeybindings(new nativeTui.KeybindingsManager({ ...nativeTui.TUI_KEYBINDINGS, "app.tools.expand": { defaultKeys: "ctrl+o", description: "Expand tool output" } }));
		t.after(() => nativeTui.setKeybindings(previousKeys));
		const content = `${Array.from({ length: 12 }, (_, index) => `- Result ${index + 1}: ${"word ".repeat(20)}`).join("\n")}\n\nFINAL_RESULT`;
		const message = { role: "custom" as const, customType: "agent.peer", display: true, timestamp: 1, content, details: { label: "reader", provider: "provider", modelId: "model", thinkingLevel: "high", status: "done", submissionId: 7 } };
		const collapsed = renderAgentPeerMessage(message, { expanded: false, outputPad: 1 }, theme);
		const expanded = renderAgentPeerMessage(message, { expanded: true, outputPad: 1 }, theme);
		assert.ok(collapsed && expanded);
		for (const width of [80, 140]) {
			const preview: string[] = collapsed.render(width).map((line) => stripVTControlCharacters(line).trimEnd());
			assert.equal(preview.length, 10, "one headline, eight body lines and one truncation hint");
			const full: string[] = expanded.render(width).map((line) => stripVTControlCharacters(line).trimEnd());
			const source = full.findIndex((line) => line.trim() === "Source details");
			const bodyLines = source - 2;
			assert.match(preview[9] ?? "", new RegExp(`… \\(${bodyLines - 8} more lines, ctrl\\+o to expand\\)`));
			assert.doesNotMatch(preview.join("\n"), /FINAL_RESULT|Source details|Open:|opens the dashboard/);
			assert.match(full.join("\n"), /FINAL_RESULT/);
			assert.match(full.join("\n"), /submissionId: 7/);
			assert.equal(full.at(-1)?.trim(), "/agent opens the dashboard");
			assert.doesNotMatch(full.join("\n"), /more lines,|Source details:/);
			assert.ok(collapsed.render(width).every((line) => visibleWidth(line) <= width));
			assert.ok(expanded.render(width).every((line) => visibleWidth(line) <= width));
			collapsed.invalidate();
			assert.deepEqual(collapsed.render(width).map((line) => stripVTControlCharacters(line).trimEnd()), preview);
		}
		assert.equal(message.content, content);
	});

	it("uses only Pi's normal separator between adjacent short notices", () => {
		const message = { role: "custom" as const, customType: "agent.peer", display: true, timestamp: 1, content: "Short answer.", details: { label: "reader", provider: "provider", modelId: "model", thinkingLevel: "high", status: "done" } };
		for (const width of [80, 140]) {
			const components = Array.from({ length: 4 }, () => new CustomMessageComponent(message, renderAgentPeerMessage));
			const lines = components.flatMap((component) => component.render(width)).map((line) => stripVTControlCharacters(line).trimEnd());
			assert.equal(lines.length, 12, "four native separators, four headlines, four answer lines");
			assert.equal(lines.filter((line) => line.trim() === "").length, 4);
			assert.equal(lines.at(-1)?.trim(), "Short answer.");
			const first = components[0];
			assert.ok(first);
			first.setExpanded(true);
			const full = screen(first, width);
			assert.match(full, /Source details/);
			assert.match(full, /\/agent opens the dashboard/);
		}
	});

	it("builds the same card from stored entry data for an agent conversation", () => {
		const card = renderPeerNoticeCard({ content: "Body text", details: { label: "reader", status: "done" } }, theme, false);
		assert.ok(card);
		assert.match(screen(card), /\[agent\] reader · result/);
		assert.match(screen(card), /Body text/);
	});
});

describe("agent tool card factory", () => {
	it("binds call and result renderers for every native tool", () => {
		const cards = createAgentToolCards();
		assert.deepEqual(Object.keys(cards).sort(), ["agent_abort", "agent_attach", "agent_collaborate", "agent_command", "agent_compact", "agent_configure", "agent_fork", "agent_inspect", "agent_list", "agent_place", "agent_profile", "agent_reset", "agent_rewind", "agent_send", "agent_spawn", "agent_status", "agent_steer"]);
		for (const [name, card] of Object.entries(cards)) {
			assert.equal(typeof card.renderCall, "function", `${name} renderCall`);
			assert.equal(typeof card.renderResult, "function", `${name} renderResult`);
			assert.ok(screen(card.renderCall({}, theme, context())).includes(name));
		}
		const registered: Pick<ToolDefinition, "renderCall" | "renderResult"> = cards.agent_status;
		assert.equal(typeof registered.renderCall, "function");
		assert.equal(typeof registered.renderResult, "function");
	});
});
