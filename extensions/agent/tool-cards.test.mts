import { keyHint, keyText } from "@earendil-works/pi-coding-agent";
/** Host-injected keybinding hints, as Pi passes them to renderers. */
const cardKeys = { keyText, keyHint };
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { after, describe, it } from "node:test";
import { stripVTControlCharacters } from "node:util";
import type { AgentToolResult, Theme, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { OpenWorkDependencyView, OpenWorkDetails, OpenWorkView } from "./open-work.ts";
import { projectReportReceipt } from "./control-result.ts";
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
const previousNativeKeys = nativeTui.getKeybindings();
nativeTui.setKeybindings(new nativeTui.KeybindingsManager({ ...nativeTui.TUI_KEYBINDINGS, "app.tools.expand": { defaultKeys: "ctrl+o", description: "Expand tool output" } }));
after(() => nativeTui.setKeybindings(previousNativeKeys));
const theme = { fg: (_color: string, value: string) => value, bg: (_color: string, value: string) => value, getBgAnsi: () => "", bold: (value: string) => value } as unknown as Theme;
const screen = (component: { render(width: number): string[] }, width = 100) => component.render(width).map((line) => stripVTControlCharacters(line).trimEnd()).join("\n");
const context = (overrides: Partial<AgentCardContext> = {}): AgentCardContext => ({ ...cardKeys, args: {}, expanded: false, argsComplete: true, isError: false, ...overrides });
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

it("shows incomplete storage scan coverage and its status continuation", () => {
	const value = result({ conversations: [], coverage: { complete: false, scanned: 50, returned: 0, next: { tool: "agent_status", view: "storage-page", storageId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", cursor: {}, limit: 50 } } });
	const text = screen(renderAgentResult(value, { ...cardKeys, expanded: false, isPartial: false }, theme, context()), 180);
	assert.match(text, /Storage scan incomplete.*50 scanned.*0 returned on this page/u);
	assert.match(text, /coverage\.next using agent_status/u);
	assert.doesNotMatch(text, /agent_list discovers stored conversations/u);
});

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
		const final = renderAgentCall("agent_spawn", { prompt: "/project/location" }, theme, context({ ...cardKeys, expanded: true, lastComponent: initial }));
		assert.equal(initial, final);
		assert.match(screen(final), /project\/location/);
	});

	it("shows an argument hint only when a collapsed call hides or clips content", () => {
		assert.equal(screen(renderAgentCall("agent_status", { sessionId: "s" }, theme, context())), "agent_status · s\nselected status");
		assert.match(screen(renderAgentCall("agent_status", { sessionId: "s", detail: true }, theme, context())), /full detail/u);
		assert.doesNotMatch(screen(renderAgentCall("agent_attach", { sessionId: "s" }, theme, context())), /to expand/u);
		assert.match(screen(renderAgentCall("agent_attach", { sessionId: "s", model: "p/m" }, theme, context())), /Requested: p\/m/);
		assert.match(screen(renderAgentCall("agent_spawn", { prompt: "p".repeat(400) }, theme, context())), /\(ctrl\+o to expand\)/);
		assert.match(screen(renderListCall({ query: "q".repeat(400) }, theme, context())), /\(ctrl\+o to expand\)/);
	});

	it("escapes controls and fits narrow widths", () => {
		const hostile = "日本語 😀\x1b]52;c;data\x07\u202e";
		const view = renderAgentCall("agent_spawn", { model: `provider/${"long-".repeat(80)}`, prompt: hostile, cwd: "/project" }, theme, context());
		for (const width of [12, 24, 80, 160]) {
			assert.ok(view.render(width).every((line) => visibleWidth(line) <= width));
			assert.doesNotMatch(screen(view, width), /[\x1b\x07\u202e]/u);
		}
		const expanded = renderAgentCall("agent_spawn", { prompt: hostile }, theme, context({ ...cardKeys, expanded: true }));
		assert.ok(screen(expanded).includes(displayText(hostile)));
	});

	it("shows a send or steer target, reply reference, preview, and full submitted text", () => {
		for (const [renderer, name] of [[renderSendCall, "agent_send"], [renderSteerCall, "agent_steer"]] as const) {
			const args = { sessionId: "target-session", message: "First line\n\n**literal Markdown** and `code`\nLast line", replyTo: "message-reference" };
			const before = structuredClone(args);
			const collapsed = renderer(args, theme, context());
			assert.match(screen(collapsed), new RegExp(`${name} · target-session`));
			assert.match(screen(collapsed), /reply to message-reference/);
			assert.match(screen(collapsed), /First line \*\*literal Markdown\*\*/);
			assert.match(screen(collapsed), /\(ctrl\+o to expand\)/);
			const expanded = renderer(args, theme, context({ ...cardKeys, expanded: true, lastComponent: collapsed }));
			assert.equal(expanded, collapsed);
			assert.ok(screen(expanded).includes(args.message));
			assert.deepEqual(args, before);
		}
	});

	it("distinguishes pending, whitespace-only, and bounded messages", () => {
		assert.match(screen(renderSendCall({ sessionId: "t", message: " \n " }, theme, context())), /empty or whitespace-only message/);
		assert.match(screen(renderSendCall({ sessionId: "t", message: " " }, theme, context({ argsComplete: false }))), /message pending/);
		assert.doesNotMatch(screen(renderSendCall({}, theme, context())), /target pending|unknown|unavailable/);
		const message = `${"long line\n".repeat(5000)}EXACT_END`;
		const expanded = screen(renderSendCall({ sessionId: "t", message }, theme, context({ ...cardKeys, expanded: true })));
		assert.match(expanded, /Display limit: \d+ more UTF-16 code units/);
		assert.equal(displayPreview("a😀b", 2), "a…");
	});

	it("marks a compact summary call as self and keeps the summary text hidden", () => {
		const summary = "Objective: hand over the slice. Next: run the checks.";
		const text = screen(renderCompactCall({ sessionId: "current-session", summary }, theme, context()));
		assert.match(text, /agent_compact · this session · current-session/);
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
		const card = renderAgentResult(resultValue, { ...cardKeys, expanded: false, isPartial: false }, theme, context());
		const text = screen(card, 180);
		assert.match(text, /Parser review/);
		assert.match(text, /provider\/model · high/);
		assert.match(text, /Activity: working · tool read · 1 pending/);
		assert.match(text, /Running: read · call call-7/);
		assert.match(text, /Running: bash · call call-8 · pending/);
		assert.match(text, /Working on the task: Check the source\\u\{1b\}/);
		assert.match(text, /Saved: done · submission 3/);
		assert.match(text, /Capability limits: 1 configured extension without a native form/);
		assert.deepEqual(resultValue, before);
		for (const width of [12, 40, 100]) assert.ok(card.render(width).every((line) => visibleWidth(line) <= width));
		const expanded = screen(renderAgentResult(resultValue, { ...cardKeys, expanded: true, isPartial: false }, theme, context()), 240);
		assert.match(expanded, /"callId": "call-7"/);
	});

	it("marks a cold snapshot read-only instead of reporting it idle", () => {
		const readOnly = snapshotResult(conversationStatus({ busy: false, live: {} }), { live: false });
		const text = screen(renderAgentResult(readOnly, { ...cardKeys, expanded: false, isPartial: false }, theme, context()), 180);
		assert.match(text, /Read-only snapshot; live owner state unavailable/);
		assert.match(text, /Activity: idle/);
	});

	it("labels the newest text by state instead of claiming an in-progress reply", () => {
		const render = (status: Record<string, unknown>) => screen(renderAgentResult(snapshotResult(status), { ...cardKeys, expanded: false, isPartial: false }, theme, context()), 180);
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
		const text = screen(renderAgentResult(compact, { ...cardKeys, expanded: false, isPartial: false }, theme, context()), 180);
		assert.match(text, /Parser review/);
		assert.match(text, /provider\/model · high/);
		assert.match(text, /State: idle/);
		assert.match(text, /Capability limits: 1 configured extension without a native form/);
		assert.doesNotMatch(text, /Activity: idle · pending unknown/u);
	});

	it("shows a stalled delivery from the host status", () => {
		const status = result({ conversation: conversationStatus({ busy: false, live: {} }), inventory: { contributions: [], ordinaryOnly: [] }, pid: 1, storageId: "storage-a", deliveryError: "primary owner 18f6603b runs an agent extension with endpoint version 1; this host requires version 2. Restart that Pi process to load the current extension." });
		const text = screen(renderAgentResult(status, { ...cardKeys, expanded: false, isPartial: false }, theme, context()), 240);
		assert.match(text, /Delivery paused: /);
		assert.match(text, /Restart that Pi process/u);
	});

	it("shows an enriched mutation snapshot beside its receipt", () => {
		const fork = result({ conversationId: 2, identity: "storage-a:2", deduped: false, status: { conversation: conversationStatus({ name: "Forked review" }) } });
		const text = screen(renderAgentResult(fork, { ...cardKeys, expanded: false, isPartial: false }, theme, context()), 180);
		assert.match(text, /provider\/model · high/);
		assert.match(text, /Fork created · storage-a:2/);
	});

	it("keeps a successful mutation receipt when the post-mutation snapshot failed", () => {
		const fork = result({ conversationId: 2, identity: "storage-a:2", deduped: false, snapshotError: "claim refused after mutation" });
		const card = renderAgentResult(fork, { ...cardKeys, expanded: false, isPartial: false }, theme, context());
		const text = screen(card, 180);
		assert.match(text, /Snapshot unavailable: claim refused after mutation/);
		assert.match(text, /Fork created · storage-a:2/);
		assert.doesNotMatch(text, /Model: |Activity:/);
		for (const width of [12, 40, 100]) assert.ok(card.render(width).every((line) => visibleWidth(line) <= width));
	});

	it("accepts a bare conversation status and a conversations wrapper without inventing cost", () => {
		const bare = screen(renderAgentResult(result({ conversation: conversationStatus({ busy: false, live: {} }) }), { ...cardKeys, expanded: false, isPartial: false }, theme, context()), 180);
		assert.match(bare, /Activity: idle/);
		const wrapped = screen(renderAgentResult(result({ conversations: [conversationStatus(), conversationStatus({ identity: "storage-a:2", busy: false, live: {} })] }), { ...cardKeys, expanded: false, isPartial: false }, theme, context()), 180);
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
		const text = screen(renderAgentResult(result(details), { ...cardKeys, expanded: false, isPartial: false }, theme, context()), 180);
		assert.match(text, /5 conversations · 1 working · \$0\.75\+\n/);
		assert.match(text, /Parser review · working/);
		assert.match(text, /1 more conversation records/);
		assert.doesNotMatch(text, /≥|\+\?/);
		const complete = { ...details, sessions: details.sessions.map((row) => ({ ...row, partial: false })) };
		assert.match(screen(renderAgentResult(result(complete), { ...cardKeys, expanded: false, isPartial: false }, theme, context()), 180), /\$0\.75\n/);
		assert.match(text, /1 storage unavailable \(unknown, not absent\)/);
		assert.doesNotMatch(text, /· new/);
	});

	it("summarizes a discovery page with coverage and the next page", () => {
		const details = { rows: [{}, {}], nextCursor: "Y3Vyc29y", coverage: { complete: false, storagesVisited: 3, unavailable: [{ storageId: "s", reason: "x" }], catalog: { storages: 40, pass: "remainder", pending: 12, settled: 5 } }, observedAt: "t", authority: "Observation grants no control or task authority" };
		const text = screen(renderListResult(result(details), { ...cardKeys, expanded: false, isPartial: false }, theme, context()), 180);
		assert.match(text, /2 conversations on this page · 3 storages observed · 5 settled by publication · 1 storage unavailable \(unknown, not absent\)/);
		assert.match(text, /Next page available · 12 storage observations open; repeat with coverage\.next, including after an empty page/);
		const covered = screen(renderListResult(result({ rows: [], nextCursor: null, coverage: { complete: true, storagesVisited: 1, unavailable: [] } }), { ...cardKeys, expanded: false, isPartial: false }, theme, context()));
		assert.match(covered, /0 conversations on this page · 1 storage observed/);
		assert.match(covered, /Inventory covered; no further page/);
	});

	it("summarizes each inspect view against its returned bounds", () => {
		const history = { view: "history", sessionId: "s", conversationId: 1, entries: [{}, {}], nextCursor: { after: 1 }, order: "newestFirst", detail: "redacted" };
		assert.match(screen(renderInspectResult(result(history), { ...cardKeys, expanded: false, isPartial: false }, theme, context())), /history page · 2 entries/);
		assert.match(screen(renderInspectResult(result(history), { ...cardKeys, expanded: false, isPartial: false }, theme, context())), /older page available/);
		const primaryPage = { kind: "ordinary-primary", view: "exact", sessionId: "p", entries: [{ id: "f392f536" }], page: { offset: 0, endOffset: 16000, totalUnits: 24000 }, nextCursor: { view: "exact" } };
		const primaryCard = screen(renderInspectResult(result(primaryPage), { ...cardKeys, expanded: false, isPartial: false }, theme, context()));
		assert.match(primaryCard, /entry f392f536 · text 0-16000 of 24000/);
		assert.match(primaryCard, /more of this entry remains/);
		assert.match(screen(renderInspectResult(result({ ...primaryPage, nextCursor: undefined }), { ...cardKeys, expanded: false, isPartial: false }, theme, context())), /text complete/);
		const search = { view: "search", sessionId: "s", conversationId: 1, matches: [{}], nextCursor: { after: 1 }, coverage: { scannedEntries: 12, scannedBytes: 90, complete: false }, detail: "literal" };
		assert.match(screen(renderInspectResult(result(search), { ...cardKeys, expanded: false, isPartial: false }, theme, context())), /search · 1 match · 12 entries scanned/);
		assert.match(screen(renderInspectResult(result(search), { ...cardKeys, expanded: false, isPartial: false }, theme, context())), /Continuation available/);
		const exact = { view: "exact", sessionId: "s", conversationId: 1, entryId: 5, offset: 0, text: "{}", nextOffset: 1200, truncated: true, omissions: { providerSignatures: 2, imagePayloads: 1, redactedThinking: 0 } };
		const exactText = screen(renderInspectResult(result(exact), { ...cardKeys, expanded: false, isPartial: false }, theme, context()));
		assert.match(exactText, /entry 5 · offset 0/);
		assert.match(exactText, /more of this entry remains · clipped to the display bound · 3 omitted fields/);
		const activity = { view: "activity", sessionId: "s", conversationId: 1, turns: [{}, {}], nextCursor: { after: 1 }, coverage: { scannedEntries: 7, complete: false }, detail: "newest turns first" };
		assert.match(screen(renderInspectResult(result(activity), { ...cardKeys, expanded: false, isPartial: false }, theme, context())), /activity · 2 turns · 7 entries scanned/);
		assert.match(screen(renderInspectResult(result(activity), { ...cardKeys, expanded: false, isPartial: false }, theme, context())), /older turns available/);
		const saved = { view: "result", sessionId: "s", conversationId: 1, submissionId: 9, status: "done", entryId: 1, answerEntryId: 2, answer: "Final", usage: {} };
		const savedText = screen(renderInspectResult(result(saved), { ...cardKeys, expanded: false, isPartial: false }, theme, context()));
		assert.match(savedText, /saved result · done · submission 9/);
		assert.match(savedText, /assistant answer retained/);
	});

	it("keeps an empty or bounded page calibrated to the covered ancestry", () => {
		const empty = { view: "search", sessionId: "s", conversationId: 1, matches: [], nextCursor: null, coverage: { scannedEntries: 30, complete: true }, detail: "literal" };
		const text = screen(renderInspectResult(result(empty), { ...cardKeys, expanded: false, isPartial: false }, theme, context()));
		assert.match(text, /search · 0 matches · ancestry covered/);
		assert.doesNotMatch(text, /no matches|absent|not found/i);
	});

	it("keeps an unavailable release distinct from proof that no host runs", () => {
		const card = createAgentToolCards().agent_abort.renderResult({ ...result(undefined, "No verified native host endpoint; writer release is unconfirmed"), isError: true }, { ...cardKeys, expanded: false, isPartial: false }, theme, context());
		assert.match(screen(card), /writer release is unconfirmed/u);
		assert.doesNotMatch(screen(card), /not running|remains active/u);
	});

	it("shows unplaced inputs in a compact status and placement in admission and report receipts", () => {
		const options = { ...cardKeys, expanded: false, isPartial: false };
		const compact = (extra: Record<string, unknown>) => result({ format: "compact", omitted: [], conversation: { identity: "storage-a", conversationId: 1, busy: true, availability: "live",
			queue: { inbox: 2, submissions: 2 }, timers: 0, context: "unknown", omitted: [], detail: { tool: "agent_status", sessionId: "storage-a", detail: true }, ...extra } });
		assert.match(screen(renderAgentResult(compact({ unplaced: 2, oldest: 372000 }), options, theme, context()), 180), /timers · unplaced: 2, oldest: 6m 12s/u);
		assert.match(screen(renderAgentResult(compact({ unplaced: 0 }), options, theme, context()), 180), /timers · unplaced: 0$/mu);
		assert.doesNotMatch(screen(renderAgentResult(compact({}), options, theme, context()), 180), /unplaced/u);
		const line = /placed at the recipient's next tool boundary/u;
		const receipt = { submissionId: 9, conversationId: 1, deduped: false, identity: "storage-a" };
		const unplaced = screen(renderSendResult(result({ ...receipt, placement: "unplaced" }), options, theme, context()), 180);
		assert.match(unplaced, /submission 9 · unplaced/u);
		assert.match(unplaced, line);
		const placed = screen(renderSteerResult(result({ ...receipt, placement: "placed" }), options, theme, context()), 180);
		assert.match(placed, /submission 9 · placed/u);
		assert.doesNotMatch(placed, line);
		assert.doesNotMatch(screen(renderSendResult(result({ ...receipt, placement: "queued" }), options, theme, context()), 180), /submission 9 ·/u);
		assert.match(screen(renderAgentResult(result({ sessionId: "storage-a", admission: { ...receipt, placement: "unplaced" } }), options, theme, context()), 180), line);
		const retained = screen(renderSendResult(result({ sourceId: "report:one", ownerId: "storage-a", acknowledged: false, placement: "unplaced" }), options, theme, context({ args: { mode: "report" } })), 180);
		assert.match(retained, /Acknowledgement pending · unplaced/u);
		assert.match(retained, line);
		const parked = screen(renderSendResult(result({ sourceId: "report:one", ownerId: "storage-a", acknowledged: false, placement: "unplaced", delivery: "parked" }), options, theme, context({ args: { mode: "report" } })), 180);
		assert.match(parked, /Delivery parked; the report is not placed/u);
		assert.doesNotMatch(parked, line);
	});

	it("preserves withdrawn receipt placement without a context-placement or future-delivery claim", () => {
		const options = { ...cardKeys, expanded: false, isPartial: false };
		const native = { identity: "storage-a", conversationId: 1, submissionId: 9, placement: "withdrawn" };
		for (const source of [native, { sessionId: "storage-a", admitted: true, placement: "withdrawn" },
			{ sourceId: "report:one", acknowledged: false, placement: "withdrawn" },
			{ sourceId: "report:two", acknowledged: true, delivery: "admitted", placement: "withdrawn" }]) {
			const receipt = projectReportReceipt(source) as Record<string, unknown>;
			assert.equal(receipt.placement, "withdrawn");
			for (const render of [renderSendResult, renderSteerResult]) {
				const output = screen(render(result(receipt), options, theme, context()), 180);
				assert.match(output, /withdrawn/u);
				assert.match(output, /not in the recipient's inbox or transcript/u);
				assert.doesNotMatch(output, / · placed\b|next tool boundary|delivered to|queued for/u);
			}
		}
		const spawned = screen(renderAgentResult(result({ sessionId: "storage-a", admission: native }), options, theme, context()), 180);
		assert.match(spawned, /withdrawn/u);
		assert.match(spawned, /not in the recipient's inbox or transcript/u);
		assert.doesNotMatch(spawned, / · placed\b|next tool boundary/u);
	});

	it("shows a declared work item with its dependencies and a closed item with its final report row", () => {
		const card = createAgentToolCards().agent_work, options = { ...cardKeys, expanded: false, isPartial: false };
		const dependency = (n: number, state: OpenWorkDependencyView["state"]): OpenWorkDependencyView => ({ sessionId: `producer-${n}`, submissionId: n, requestId: `input-${n}`, state, inspect: { tool: "agent_inspect", view: "result", sessionId: `producer-${n}`, submissionId: n } });
		const item: OpenWorkView = { requestId: "request-1", submissionId: 3, requester: "storage-a", replyTo: "storage-a", origin: "model", note: "Two reviews remain", state: "open", declaredAt: 1, updatedAt: 1,
			dependencies: [dependency(1, "open"), dependency(2, "state-note"), dependency(3, "arrived"), dependency(4, "open"), dependency(5, "open")] };
		const open = screen(card.renderResult(result({ action: "continue", item }), options, theme, context()), 180);
		assert.match(open, /Work open · request request-1 · 5 dependencies/u);
		assert.match(open, /Final report to storage-a/u);
		assert.match(open, /Note: Two reviews remain/u);
		assert.match(open, /producer-2 · submission 2 · request input-2 · state-note/u);
		assert.match(open, /1 more dependencies/u);
		assert.doesNotMatch(open, /producer-5/u);
		const report = { sourceId: "report:work-final", requestId: "work-final:1:request-1", ownerId: "storage-a", acknowledged: false, createdAt: 2 };
		const closed = screen(card.renderResult(result({ action: "complete", requestId: "request-1", status: "failed", deduped: true, report, item: { ...item, state: "closed" } }), options, theme, context()), 180);
		assert.match(closed, /Work closed \(failed\) · request request-1 · already closed/u);
		assert.match(closed, /Final report retained · storage-a · acknowledgement pending/u);
		const empty: OpenWorkDetails = { action: "continue", item: { ...item, dependencies: [], updatedAt: 2 } };
		const emptyOutput = screen(card.renderResult(result(empty), options, theme, context()), 180);
		assert.match(emptyOutput, /Work open · request request-1 · 0 dependencies/u);
		assert.doesNotMatch(emptyOutput, /withdrawn|Work closed/u);
		const unavailable: OpenWorkDetails = { action: "continue", item: { ...item, dependencies: [{ ...dependency(1, "open"), unavailable: `Producer facts missing ${"x".repeat(300)}` }] } };
		const unavailableOutput = screen(card.renderResult(result(unavailable), options, theme, context()), 240);
		assert.match(unavailableOutput, /unavailable: Producer facts missing/u);
		assert.doesNotMatch(unavailableOutput, /x{121}/u);
		for (const status of ["stopped", "reset"] as const) {
			const retained: OpenWorkDetails = { action: "complete", requestId: item.requestId, status, deduped: true,
				item: { ...item, state: "closed", close: { status, message: "Stopped", at: 2, reportRequestId: report.requestId, delivery: "terminal", read: { tool: "agent_inspect", view: "result", sessionId: "storage-a:2", submissionId: item.submissionId, finalReport: true, offset: 0 } } } };
			const output = screen(card.renderResult(result(retained), options, theme, context()), 180);
			assert.ok(output.includes(`Work closed (${status})`));
			assert.match(output, /Final report delivery: terminal/u);
			assert.doesNotMatch(output, /Final report retained|acknowledgement pending/u);
		}
		const call = screen(card.renderCall({ action: "continue", request: "request-1", results: [{ sessionId: "producer-1", submissionId: 1 }], note: "Two reviews remain" }, theme, context()), 180);
		assert.match(call, /agent_work/u);
		assert.match(call, /request request-1 · 1 result reference/u);
	});

	it("shows admission receipts, fork, rewind, configure, abort, and command outcomes", () => {
		const receipt = { submissionId: 9, conversationId: 1, deduped: false, identity: "storage-a" };
		const send = screen(renderSendResult(result(receipt), { ...cardKeys, expanded: false, isPartial: false }, theme, context()));
		assert.match(send, /Admitted/);
		assert.match(send, /Admitted · storage-a/);
		assert.match(send, /submission 9/);
		assert.match(screen(renderSteerResult(result(receipt), { ...cardKeys, expanded: false, isPartial: false }, theme, context())), /Steer admitted/);
		assert.match(screen(renderAgentResult(result({ conversationId: 2, identity: "storage-a:2", deduped: false }), { ...cardKeys, expanded: false, isPartial: false }, theme, context())), /Fork created · storage-a:2/);
		const rewind = screen(renderAgentResult(result({ conversationId: 3, identity: "storage-a:3", predecessorEntryId: 5, submissionId: 11, deduped: false }), { ...cardKeys, expanded: false, isPartial: false }, theme, context()));
		assert.match(rewind, /Rewind submitted · storage-a:3/);
		assert.match(rewind, /forked before entry 5/);
		assert.match(rewind, /submission 11/);
		assert.match(screen(renderAgentResult(result({ conversationId: 1, identity: "storage-a" }), { ...cardKeys, expanded: false, isPartial: false }, theme, context())), /Configuration applied · storage-a/);
		const abort = createAgentToolCards().agent_abort.renderResult(result({ conversationId: 1, identity: "storage-a", background: false }), { ...cardKeys, expanded: false, isPartial: false }, theme, context());
		assert.match(screen(abort), /Abort requested · storage-a/);
		assert.match(screen(renderAbortCall({ sessionId: "storage-a", release: true }, theme, context())), /release host/);
		const release = createAgentToolCards().agent_abort.renderResult(result({ aborted: { identity: "storage-a" }, retiring: false, blockers: ["pending timer"], writesPlaced: 0 }), { ...cardKeys, expanded: false, isPartial: false }, theme, context());
		assert.match(screen(release), /Host remains active/);
		assert.match(screen(release), /pending timer/);
		const command = createAgentToolCards().agent_command.renderResult(result({ name: "reload", conversationId: 1, identity: "storage-a", text: "Reloaded 3 extensions" }), { ...cardKeys, expanded: false, isPartial: false }, theme, context());
		assert.match(screen(command), /Reloaded 3 extensions/);
		assert.match(screen(command), /command reload\nstorage-a/);
		const reload = createAgentToolCards().agent_command.renderResult(result({ sessionId: "storage-a", inventory: { contributions: [{}, {}] }, reloaded: true }), { ...cardKeys, expanded: false, isPartial: false }, theme, context());
		assert.match(screen(reload), /Host registrations reloaded/);
		assert.match(screen(reload), /2 native contributions installed/);
	});

	it("labels compact receipts, native results, partial, and error states", () => {
		const self = screen(renderCompactResult(result({ taskId: 5, status: "task" }), { ...cardKeys, expanded: false, isPartial: false }, theme, context({ args: { sessionId: "s", summary: "s" } })));
		assert.match(self, /Summary admitted · task 5/);
		assert.match(self, /Summary admitted · task 5/);
		const native = screen(renderCompactResult(result({ taskId: 6, status: "completed", entryId: 7 }), { ...cardKeys, expanded: false, isPartial: false }, theme, context({ args: { sessionId: "s" } })));
		assert.match(native, /Compaction completed · task 6/);
		assert.match(native, /summary entry 7/);
		assert.match(screen(renderCompactResult(result("queued"), { ...cardKeys, expanded: false, isPartial: true }, theme, context({ args: { summary: "s" } }))), /Compaction pending/);
		const error = renderCompactResult(result("refused"), { ...cardKeys, expanded: true, isPartial: false }, theme, context({ args: { summary: "s" }, isError: true }));
		assert.match(screen(error), /Compact error/);
		assert.doesNotMatch(screen(error), /receipt/);
	});

	it("falls back to a bounded preview for unexpected values and labels errors", () => {
		const raw = screen(renderListResult(result("inventory unreadable"), { ...cardKeys, expanded: false, isPartial: false }, theme, context()));
		assert.match(raw, /inventory unreadable/);
		assert.match(screen(renderListResult(result("denied\x1b[2J"), { ...cardKeys, expanded: false, isPartial: false }, theme, context({ isError: true }))), /List error/);
		assert.doesNotMatch(screen(renderListResult(result("denied\x1b[2J"), { ...cardKeys, expanded: false, isPartial: false }, theme, context({ isError: true }))), /\x1b/);
		assert.match(screen(renderAgentResult(result(undefined), { ...cardKeys, expanded: false, isPartial: true }, theme, context())), /Partial result/);
		assert.match(screen(renderAgentResult(result(undefined), { ...cardKeys, expanded: true, isPartial: false }, theme, context({ isError: true }))), /Tool error/);
	});

	it("bounds expanded source units and escape expansion separately", () => {
		const render = (value: string) => screen(renderAgentResult(result(undefined, value), { ...cardKeys, expanded: true, isPartial: false }, theme, context()), 800).replace(/\n/gu, "");
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
			{ details: { identity: id, name: "Catalog reader", kind: "receipt", status: "done", provider: "provider", modelId: "model", thinkingLevel: "high" }, heading: "result · Catalog reader" },
			{ details: { identity: id, handle: "@reader", kind: "report" }, heading: "report · @reader" },
			{ details: { senderIdentity: id, senderKind: "session", name: "Parser session", kind: "message" }, heading: "message from another session · Parser session" },
			{ details: { senderIdentity: id, senderKind: "session", observedPurpose: "Review the parser", kind: "message", provider: "provider" }, heading: "message from another session · Review the parser" },
			{ details: { senderIdentity: id, senderKind: "session", kind: "message" }, heading: `message from another session · ${id}` },
			{ details: { senderIdentity: id, senderKind: "session", name: "Parser session", kind: "report", threadId: "retained-thread", threadTitle: "Parser contract", operatorMessage: "The sourced event body" }, heading: "thread notice · Parser contract" },
			{ details: { identity: id, name: "Fallback reader", kind: "receipt", status: "done", liveOwner: false, fallback: true }, heading: "result · Fallback reader" },
			{ details: {}, heading: "message from another session" },
		];
		for (const { details, heading } of cases) {
			const card = renderPeerNoticeCard({ content: "Stored model body", details }, theme, false, cardKeys);
			assert.ok(card);
			const lines = screen(card, 240).split("\n").filter((line) => line.trim());
			assert.equal(lines[0]?.trim(), `[agent] ${heading}`);
			assert.doesNotMatch(lines[0] ?? "", /unknown|unavailable/u);
			if ("threadId" in details) {
				assert.match(lines.join("\n"), /The sourced event body/u);
				assert.doesNotMatch(lines.join("\n"), /Stored model body/u);
			}
			if (details.liveOwner === false) assert.match(lines.join("\n"), /No live owner; retained result only/u);
			const expanded = renderPeerNoticeCard({ content: "Stored model body", details }, theme, true, cardKeys);
			assert.ok(expanded);
			if (Object.keys(details).length) assert.ok(screen(expanded, 240).includes(id));
			for (const width of [20, 60, 120]) assert.ok(card.render(width).every((line) => visibleWidth(line) <= width));
		}
	});

	it("shows an unnamed session's full identity on a wide peer headline", () => {
		const identity = "12345678-1234-4234-8234-123456789abc";
		const card = renderPeerNoticeCard({ content: "Direct message", details: { senderIdentity: identity, senderKind: "session", kind: "message" } }, theme, false, cardKeys);
		assert.ok(card);
		assert.equal(screen(card, 240).split("\n").find((line) => line.trim())?.trim(), `[agent] message from another session · ${identity}`);
		assert.doesNotMatch(screen(card, 240).split("\n").find((line) => line.trim()) ?? "", /…|unknown|unavailable/u);
		assert.ok(card.render(24).every((line) => visibleWidth(line) <= 24));
	});

	it("preserves full source identities in expanded details", () => {
		const sourceId = `report:${"r".repeat(400)}`;
		const senderIdentity = "12345678-1234-4234-8234-123456789abc";
		const card = renderPeerNoticeCard({ content: "Report body", details: { name: "Reader", kind: "report", senderIdentity, sourceId } }, theme, true, cardKeys);
		assert.ok(card);
		const text = screen(card, 600);
		assert.ok(text.includes(`sourceId: ${sourceId}`));
		assert.ok(text.includes(`senderIdentity: ${senderIdentity}`));
	});

	it("keeps a check-in headline when elapsed time, cost and configuration are absent", () => {
		const card = renderPeerNoticeCard({ content: "Stored guidance", details: { name: "Reader", message: "Current step: review", checkIn: {} } }, theme, false, cardKeys);
		assert.ok(card);
		const lines = screen(card, 160).split("\n").filter((line) => line.trim());
		assert.equal(lines[0]?.trim(), "[agent] still working · Reader");
		assert.match(lines.join("\n"), /Current step: review/u);
		assert.doesNotMatch(lines[0] ?? "", /unknown|unavailable|elapsed|conversation total/u);
	});
	it("renders a receipt heading, Markdown body, and expanded source details", () => {
		const collapsed = renderAgentPeerMessage({ role: "custom", customType: "agent.peer", display: true, timestamp: 1, content: "**Review:** fix the token.\n\nKeep the identifier.", details: { submissionId: 9, identity: "storage-a", status: "done" } }, { ...cardKeys, expanded: false, outputPad: 1 }, theme);
		assert.ok(collapsed);
		const text = screen(collapsed);
		assert.match(text, /\[agent\] result · storage-a/);
		assert.match(text, /\.\.\. \(click or ctrl\+o to expand\)/u);
		assert.doesNotMatch(text, /Source details:|submissionId:|\/agent opens/u);
		assert.match(text, /Review: fix the token\./);
		assert.match(text, /Keep the identifier\./);
		assert.doesNotMatch(text, /\*\*|submissionId:/);
		const expanded = renderAgentPeerMessage({ role: "custom", customType: "agent.peer", display: true, timestamp: 1, content: "Body", details: { submissionId: 9, identity: "storage-a", status: "done" } }, { ...cardKeys, expanded: true, outputPad: 1 }, theme);
		assert.ok(expanded);
		const expandedText = screen(expanded);
		assert.match(expandedText, /Source details/);
		assert.match(expandedText, /submissionId: 9/);
		assert.match(expandedText, /not operator authority or task acceptance/);
	});

	it("uses the resolved display label in place of the raw identity", () => {
		const card = renderAgentPeerMessage({ role: "custom", customType: "agent.peer", display: true, timestamp: 1, content: "Done", details: { submissionId: 9, identity: "6de48f73-1111-4111-8111-111111111111", label: "poem task", status: "done" } }, { ...cardKeys, expanded: false, outputPad: 1 }, theme);
		assert.ok(card);
		const text = screen(card);
		assert.match(text, /\[agent\] result · poem task/);
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
			const card = renderAgentPeerMessage(message, { ...cardKeys, expanded, outputPad: 1 }, theme);
			assert.ok(card);
			const text = screen(card, 180);
			assert.match(text, /\[agent\] still working · reader\n\s*30m/u);
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
			checkIn: { conversationId: 1, requestId: "task", origin: "model", elapsedMs: 60_000, cost: null } } }, theme, true, cardKeys);
		assert.ok(card);
		const text = screen(card, 180);
		assert.match(text, /Display limit/u);
		assert.doesNotMatch(text, /OMITTED|not a finished answer/u);
	});

	it("renders hours and reads the check-in body from report.message", () => {
		const card = renderPeerNoticeCard({ content: "channel text", details: { label: "reader", message: "Current tool: bash.",
			checkIn: { conversationId: 1, requestId: "task", origin: "model", elapsedMs: 11_100_000, cost: 0 } } }, theme, false, cardKeys);
		assert.ok(card);
		const text = screen(card, 180);
		assert.match(text, /still working · reader\n\s*3h05m elapsed/u);
		assert.match(text, /Current tool: bash/u);
		assert.doesNotMatch(text, /185m/u);
	});

	it("labels a report and an unanswered receipt without claiming acceptance", () => {
		const reportCard = renderAgentPeerMessage({ role: "custom", customType: "agent.peer", display: true, timestamp: 1, content: "Progress report", details: { senderIdentity: "storage-b", sourceId: "report:1", acknowledged: false } }, { ...cardKeys, expanded: false, outputPad: 1 }, theme);
		assert.ok(reportCard);
		const report = screen(reportCard);
		assert.match(report, /\[agent\] report · storage-b/);
		assert.match(report, /Progress report/);
		const unansweredCard = renderAgentPeerMessage({ role: "custom", customType: "agent.peer", display: true, timestamp: 1, content: "No answer", details: { identity: "storage-a", status: "unanswered", reason: "aborted" } }, { ...cardKeys, expanded: false, outputPad: 1 }, theme);
		assert.ok(unansweredCard);
		const unanswered = screen(unansweredCard);
		assert.match(unanswered, /\[agent\] result · storage-a/);
		assert.match(unanswered, /Result unavailable or unanswered/);
		assert.match(unanswered, /aborted/);
	});

	it("shows source name, model, reasoning, warnings, exact IDs, and the full escaped body", () => {
		const hostile = `[2J‮${"long line\n".repeat(4000)}END`;
		const card = renderAgentPeerMessage({ role: "custom", customType: "agent.peer", display: true, timestamp: 1, content: hostile, details: { submissionId: 9, entryId: 4, answerEntryId: 5, requestId: "req-1", identity: "storage-a", status: "done", name: "Message reviewer", provider: "SelectedProvider", modelId: "MixedCase-Model", thinkingLevel: "high", liveOwner: false, saved: false } }, { ...cardKeys, expanded: true, outputPad: 1 }, theme);
		assert.ok(card);
		const text = screen(card, 180);
		assert.match(text, /\[agent\] result · Message reviewer/);
		assert.match(text, /name: Message reviewer/);
		assert.match(text, /SelectedProvider\/MixedCase-Model · high/);
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
		const card = renderAgentPeerMessage({ role: "custom", customType: "agent.peer", display: true, timestamp: 1, content, details: { label: "reader", status: "done" } }, { ...cardKeys, expanded: false, outputPad: 1 }, theme);
		assert.ok(card);
		const text = screen(card);
		assert.match(text, /\[agent\] result · reader/);
		assert.match(text, /SECOND READY/);
		assert.match(text, /\.\.\. \(click or ctrl\+o to expand\)/u);
		assert.doesNotMatch(text, /Source details:|\/agent opens/u);
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

	it("uses a padded two-tier header and keeps the body distinct", () => {
		const message = { role: "custom" as const, customType: "agent.peer", display: true, timestamp: 1, content: "A short answer.\n\n", details: { label: "A very long task label ".repeat(8), provider: "provider", modelId: "model", thinkingLevel: "high", status: "done" } };
		const before = structuredClone(message);
		const card = renderAgentPeerMessage(message, { ...cardKeys, expanded: false, outputPad: 1 }, theme);
		assert.ok(card);
		for (const width of [80, 140]) {
			const lines: string[] = card.render(width).map((line) => stripVTControlCharacters(line).trimEnd());
			assert.equal(lines.length, 7);
			assert.equal(lines[0]?.trim(), "");
			assert.match(lines[1] ?? "", /\[agent\] result · A very long/u);
			assert.equal(lines[2]?.trim(), "provider/model · high");
			assert.equal(lines[3]?.trim(), "");
			assert.equal(lines[4]?.trim(), "A short answer.");
			assert.equal(lines[5]?.trim(), "... (click or ctrl+o to expand)");
			assert.equal(lines[6]?.trim(), "");
			assert.ok(card.render(width).every((line) => visibleWidth(line) <= width));
			assert.doesNotMatch(lines.join("\n"), /Open:|Source details|opens the dashboard/);
		}
		assert.deepEqual(message, before);
	});

	it("bounds Markdown by visual lines and reveals the full body and source only when expanded", (t) => {
		const previousKeys = nativeTui.getKeybindings();
		nativeTui.setKeybindings(new nativeTui.KeybindingsManager({ ...nativeTui.TUI_KEYBINDINGS, "app.tools.expand": { defaultKeys: "ctrl+o", description: "Expand tool output" } }));
		t.after(() => nativeTui.setKeybindings(previousKeys));
		const content = `${Array.from({ length: 12 }, (_, index) => `- Result ${index + 1}: ${"word ".repeat(20)}`).join("\n")}\n\nFINAL_RESULT`;
		const message = { role: "custom" as const, customType: "agent.peer", display: true, timestamp: 1, content, details: { label: "reader", provider: "provider", modelId: "model", thinkingLevel: "high", status: "done", submissionId: 7 } };
		const collapsed = renderAgentPeerMessage(message, { ...cardKeys, expanded: false, outputPad: 1 }, theme);
		const expanded = renderAgentPeerMessage(message, { ...cardKeys, expanded: true, outputPad: 1 }, theme);
		assert.ok(collapsed && expanded);
		for (const width of [80, 140]) {
			const preview: string[] = collapsed.render(width).map((line) => stripVTControlCharacters(line).trimEnd());
			assert.equal(preview.length, 9, "two padded lines, a two-tier header, one separator, three body lines and one hint");
			const full: string[] = expanded.render(width).map((line) => stripVTControlCharacters(line).trimEnd());
			assert.match(preview[7] ?? "", /\.\.\. \(click or ctrl\+o to expand\)/u);
			assert.equal(preview[3]?.trim(), "");
			assert.deepEqual(preview.slice(4, 7), full.slice(4, 7));
			assert.equal(preview.filter((line) => /to expand/u.test(line)).length, 1);
			assert.doesNotMatch(preview.join("\n"), /^\s*…\s*$/mu);
			assert.doesNotMatch(preview.join("\n"), /FINAL_RESULT|Source details|Open:|opens the dashboard/);
			assert.match(full.join("\n"), /FINAL_RESULT/);
			assert.match(full.join("\n"), /submissionId: 7/);
			assert.equal(full.filter((line) => line.trim()).at(-1)?.trim(), "/agent opens the dashboard");
			assert.doesNotMatch(full.join("\n"), /more lines,|Source details:/);
			assert.ok(collapsed.render(width).every((line) => visibleWidth(line) <= width));
			assert.ok(expanded.render(width).every((line) => visibleWidth(line) <= width));
			collapsed.invalidate();
			assert.deepEqual(collapsed.render(width).map((line) => stripVTControlCharacters(line).trimEnd()), preview);
		}
		assert.equal(message.content, content);
	});

	it("matches Pi tool padding between adjacent short notices", () => {
		const message = { role: "custom" as const, customType: "agent.peer", display: true, timestamp: 1, content: "Short answer.", details: { label: "reader", provider: "provider", modelId: "model", thinkingLevel: "high", status: "done" } };
		for (const width of [80, 140]) {
			const components = Array.from({ length: 4 }, () => new CustomMessageComponent(message, renderAgentPeerMessage));
			const lines = components.flatMap((component) => component.render(width)).map((line) => stripVTControlCharacters(line).trimEnd());
			assert.equal(lines.length, 32, "four native separators and four padded two-tier cards with header separators and hints");
			assert.equal(lines.filter((line) => line.trim() === "").length, 16);
			assert.equal(lines.filter((line) => line.trim()).at(-1)?.trim(), "... (click or ctrl+o to expand)");
			const first = components[0];
			assert.ok(first);
			first.setExpanded(true);
			const full = screen(first, width);
			assert.match(full, /Source details/);
			assert.match(full, /\/agent opens the dashboard/);
		}
	});

	it("builds the same card from stored entry data for an agent conversation", () => {
		const card = renderPeerNoticeCard({ content: "Body text", details: { label: "reader", status: "done" } }, theme, false, cardKeys);
		assert.ok(card);
		assert.match(screen(card), /\[agent\] result · reader/);
		assert.match(screen(card), /Body text/);
	});
});

describe("agent tool card factory", () => {
	it("binds call and result renderers for every agent tool", () => {
		const cards = createAgentToolCards();
		assert.deepEqual(Object.keys(cards).sort(), ["agent_abort", "agent_attach", "agent_collaborate", "agent_command", "agent_compact", "agent_configure", "agent_fork", "agent_inspect", "agent_intent", "agent_list", "agent_place", "agent_profile", "agent_reset", "agent_rewind", "agent_send", "agent_spawn", "agent_status", "agent_steer", "agent_work"]);
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
