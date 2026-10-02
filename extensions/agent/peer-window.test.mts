import assert from "node:assert/strict";
import { it } from "node:test";
import { stripVTControlCharacters } from "node:util";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { initTheme, type KeybindingsManager, type Theme } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, KeybindingsManager as Keys, setKeybindings, TUI_KEYBINDINGS, type TUI, visibleWidth } from "@earendil-works/pi-tui";
import type { AgentConversationEntry, AgentConversationPage, AgentConversationSnapshot, AgentConversationSummary } from "./dashboard-types.ts";
import type { ConversationFrame, ObservationFrame, TaskGraphRow, TasksFrame } from "./live-frames.ts";
import { createPeerWindowState, type PeerAgentActions, type PeerAgentSource, type PeerWindowState, type PrimaryObserver, type PrimarySnapshot } from "./peer-contract.ts";
import { createPeerObservationSource, type PeerObservationHost } from "./peer-observation.ts";
import { PeerWindow } from "./peer-window.ts";

initTheme("dark");
const theme = { fg: (_color: string, text: string) => text, bg: (_color: string, text: string) => text, bold: (text: string) => text } as Theme;
const keys = new Keys({ ...TUI_KEYBINDINGS, "app.interrupt": { defaultKeys: "escape", description: "Cancel or abort" }, "app.exit": { defaultKeys: "ctrl+d", description: "Exit" } }) as KeybindingsManager;
setKeybindings(keys);

const F2 = "\x1bOQ";
const F3 = "\x1bOR";
const F4 = "\x1bOS";
const F5 = "\x1b[15~";
const F6 = "\x1b[17~";
const F7 = "\x1b[18~";
const PAGE_UP = "\x1b[5~";
const DOWN = "\x1b[B";
const ENTER = "\r";
const ESCAPE = "\x1b";

const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

function userEntry(id: string, text: string, timestamp = 1): AgentConversationEntry {
	return { id, kind: "pi.user", model: [{ role: "user", content: text, timestamp }] };
}
function assistantEntry(id: string, text: string, timestamp = 2): AgentConversationEntry {
	const message: AssistantMessage = { role: "assistant", api: "openai-completions", provider: "test", model: "m", content: [{ type: "text", text }], stopReason: "stop", timestamp, usage };
	return { id, kind: "pi.assistant", model: [message] };
}
function toolResultEntry(id: string, toolCallId: string, text: string): AgentConversationEntry {
	return { id, kind: "pi.tool-result", model: [{ role: "toolResult", toolCallId, toolName: "bash", content: [{ type: "text", text }], isError: false, timestamp: 3 }] };
}
const snapshotCoverage = { complete: true, entries: 0, bytes: 0, hiddenExcluded: 0, entryLimitReached: false, byteLimitReached: false };
function liveFrame(over: Partial<ConversationFrame>): ConversationFrame {
	return { scope: "conversation", storageId: "storage", conversationId: 1, revision: 1, observedAt: new Date(0).toISOString(), entries: [], nextBefore: null, live: [], status: {} as ConversationFrame["status"], coverage: snapshotCoverage, ...over };
}
function tasksFrame(tasks: readonly TaskGraphRow[], labels: TasksFrame["labels"]): TasksFrame {
	return { scope: "tasks", storageId: "storage", revision: 1, observedAt: new Date(0).toISOString(), tasks, labels, coverage: { complete: true, live: true } };
}

class FakePrimary implements PrimaryObserver {
	value: PrimarySnapshot;
	sent: Array<{ text: string; mode: string }> = [];
	handed: Array<{ text: string; previous: string }> = [];
	editor = "";
	private readonly listeners = new Set<() => void>();
	private queued: AgentConversationEntry[] = [];
	constructor(entries: readonly AgentConversationEntry[] = [userEntry("u1", "hello primary")]) {
		this.value = {
			descriptor: { id: "primary", kind: "primary", name: "this Pi", cwd: "/work", model: "test/m", thinkingLevel: "high", state: "primary" },
			entries,
			revision: "p1",
			live: [],
			liveRevision: "l1",
			busy: false,
		};
	}
	attach(): void {}
	observe(): void {}
	subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
	queueNotice(entry: AgentConversationEntry): void { this.queued.push(entry); }
	refresh(): void {
		if (this.queued.length) this.value = { ...this.value, revision: `${this.value.revision}+`, entries: [...this.value.entries, ...this.queued] };
		this.queued = [];
		for (const listener of [...this.listeners]) listener();
	}
	snapshot(): PrimarySnapshot { return this.value; }
	sendPlain(text: string, mode: string): void { this.sent.push({ text, mode }); }
	handoffToNative(text: string): string { const previous = this.editor; this.editor = text; this.handed.push({ text, previous }); return previous; }
	nativeDraft(): string { return this.editor; }
}

class FakeSource implements PeerAgentSource {
	rows: AgentConversationSummary[] = [];
	snapshots = new Map<string, AgentConversationSnapshot & { nextBefore?: number | null }>();
	frames = new Map<string, ConversationFrame>();
	taskFrames = new Map<string, TasksFrame>();
	earlierCalls: Array<{ id: string; before: number }> = [];
	earlierImpl?: (id: string, before: number) => Promise<{ entries: AgentConversationEntry[]; nextBefore: number | null }>;
	async list(): Promise<AgentConversationPage> {
		return { rows: this.rows, coverage: { complete: true, storagesVisited: 1, skipped: 0, omitted: 0, nextCursor: null }, observedAt: new Date(0).toISOString() };
	}
	async snapshot(id: string): Promise<AgentConversationSnapshot & { nextBefore?: number | null }> {
		const snapshot = this.snapshots.get(id);
		if (!snapshot) throw new Error(`no snapshot for ${id}`);
		return snapshot;
	}
	frame(id: string): ConversationFrame | undefined {
		return this.frames.get(id);
	}
	async tasks(id: string): Promise<TasksFrame> {
		const frame = this.taskFrames.get(id);
		if (!frame) throw new Error(`no tasks for ${id}`);
		return frame;
	}
	async earlier(id: string, before: number): Promise<{ entries: AgentConversationEntry[]; nextBefore: number | null }> {
		this.earlierCalls.push({ id, before });
		if (!this.earlierImpl) throw new Error(`no earlier page for ${id}`);
		return this.earlierImpl(id, before);
	}
}

function agentRow(id = "agent:a"): AgentConversationSummary {
	return { id, storageId: id, name: "reader", firstMessage: "read the file", cwd: "/work/agent", model: { provider: "test", modelId: "m", thinkingLevel: "high" }, modifiedAt: 0, owner: "here", state: "idle", cost: 0.25, partial: false };
}

interface Harness {
	window: PeerWindow;
	primary: FakePrimary;
	source: FakeSource;
	state: PeerWindowState;
	actions: Array<{ name: string; input: unknown }>;
	done: () => number;
	tui: { terminal: { rows: number; columns: number }; requestRender(): void };
}

function agentState(id = "agent:a"): PeerWindowState {
	const state = createPeerWindowState();
	state.right = { kind: "agent", id };
	return state;
}

function harness(options: { rows?: number; columns?: number; primary?: FakePrimary; rowsValue?: AgentConversationSummary[]; snapshots?: Map<string, AgentConversationSnapshot & { nextBefore?: number | null }>; configuredState?: PeerWindowState; runActions?: (target: AgentConversationSummary | undefined) => Promise<{ text: string; sessionId?: string } | undefined>; source?: PeerAgentSource } = {}): Harness {
	const tui = { terminal: { rows: options.rows ?? 45, columns: options.columns ?? 140 }, requestRender() {} };
	const primary = options.primary ?? new FakePrimary();
	const fake = new FakeSource();
	fake.rows = options.rowsValue ?? [];
	fake.snapshots = options.snapshots ?? new Map();
	const source = options.source ?? fake;
	const actions: Array<{ name: string; input: unknown }> = [];
	const impl: PeerAgentActions = {
		async submit(input) { actions.push({ name: "submit", input }); return { text: "Sent", sessionId: input.id }; },
		async newAgent(input) { actions.push({ name: "new", input }); return { text: "Created agent", sessionId: "agent:new1" }; },
		async fork(input) { actions.push({ name: "fork", input }); return { text: "Forked", sessionId: "agent:fork1" }; },
		async repair(input) { actions.push({ name: "repair", input }); return { text: "Repaired", sessionId: "agent:fix1" }; },
	};
	let doneCount = 0;
	const state = options.configuredState ?? createPeerWindowState();
	const window = new PeerWindow(tui as unknown as TUI, theme, keys, () => { doneCount++; }, state, { source, primary, actions: impl, runActions: options.runActions, cwd: "/work", sessionId: "session-1", now: () => 0, refreshMs: 0 });
	return { window, primary, source: fake, state, actions, done: () => doneCount, tui };
}

function type(window: PeerWindow, text: string): void {
	for (const char of text) window.handleInput(char);
}

function caretCount(lines: readonly string[]): number {
	return lines.join("\n").split(CURSOR_MARKER).length - 1;
}

it("renders both panes at 140x45 and 80x24 with every line inside the terminal width", async () => {
	const state = agentState();
	const h = harness({ rows: 45, columns: 140, rowsValue: [agentRow()], snapshots: new Map([["agent:a", { entries: [userEntry("a1", "agent task"), assistantEntry("a2", "agent answer")], partial: false, revision: "a-r1" }]]), configuredState: state });
	await h.window.ready();
	let lines = h.window.render(140);
	assert.equal(lines.length, 45);
	assert.ok(lines.every((line) => visibleWidth(line) <= 140));
	const joined = lines.join("\n");
	assert.match(joined, /All 1/);
	assert.match(joined, /F2 primary · F3 agent · F4 expand · F6 All · F7 new · F8 tasks · PgUp\/PgDn scroll · \/help · Esc Pi/);
	assert.match(joined, /Primary · this Pi/);
	assert.match(joined, /Agent · reader/);

	h.tui.terminal.rows = 24;
	lines = h.window.render(80);
	assert.equal(lines.length, 24);
	assert.ok(lines.every((line) => visibleWidth(line) <= 80), "no line exceeds the terminal width at 80x24");
	const narrow = lines.join("\n");
	assert.match(narrow, /Primary · this Pi/);
	assert.match(narrow, /Agent · reader/);
	assert.match(narrow, /Esc Pi/);
	assert.doesNotMatch(narrow, /\/help/, "the narrow strip drops the help hint first");
	assert.match(narrow, /F2 primary · F3 agent/);
});

it("docks each pane composer and footer at the bottom with aligned rows", async () => {
	for (const [width, rows] of [[140, 45], [80, 24]] as const) {
		const primary = new FakePrimary([userEntry("u1", "short primary note")]);
		const h = harness({ rows, columns: width, rowsValue: [agentRow()], snapshots: new Map([["agent:a", { entries: [userEntry("a1", "short agent task")], partial: false, revision: "r1" }]]), configuredState: agentState(), primary });
		await h.window.ready();
		const lines = h.window.render(width).map(stripVTControlCharacters);
		const leftWidth = Math.max(1, Math.floor((width - 1) / 2));
		const left = lines.map((line) => line.slice(0, leftWidth));
		const right = lines.map((line) => line.slice(leftWidth + 1));
		const bottom = rows - 1;
		assert.match(left[bottom], /mode auto/, `footer at ${width}x${rows}`);
		assert.match(right[bottom], /mode auto/, `footer at ${width}x${rows}`);
		assert.match(left[bottom - 1], /^─/);
		assert.match(right[bottom - 1], /^─/);
		assert.match(left[bottom - 3], /^─/);
		assert.match(right[bottom - 3], /^─/);
		const primaryRow = left.findIndex((line) => line.includes("short primary note"));
		assert.ok(primaryRow >= 3 && primaryRow <= 12, `short primary content at row ${primaryRow} of ${width}x${rows}`);
		const agentRowIndex = right.findIndex((line) => line.includes("short agent task"));
		assert.ok(agentRowIndex >= 3 && agentRowIndex <= 12, `short agent content at row ${agentRowIndex} of ${width}x${rows}`);
		for (const index of [Math.floor(rows / 2), rows - 8, rows - 6, rows - 5]) {
			assert.equal(left[index].trim(), "", `blank row ${index} above the primary composer at ${width}x${rows}`);
			assert.equal(right[index].trim(), "", `blank row ${index} above the agent composer at ${width}x${rows}`);
		}
	}
});

it("shows the primary cost and run state from its observer reading", async () => {
	const primary = new FakePrimary();
	primary.value = { ...primary.value, descriptor: { ...primary.value.descriptor, cost: 0.25, state: "idle" } };
	const h = harness({ primary });
	await h.window.ready();
	assert.match(h.window.render(140).join("\n"), /test\/m high · \$0\.25 · ○ idle · mode auto/);
	primary.value = { ...primary.value, descriptor: { ...primary.value.descriptor, state: "working" } };
	assert.match(h.window.render(140).join("\n"), /\$0\.25 · ● working/);
});

it("renders the agent peer notice card in the primary pane without model caveats", async () => {
	const notice: AgentConversationEntry = {
		id: "notice-1",
		kind: "pi.custom_message",
		model: [{ role: "user", content: "Operator-visible card placeholder", timestamp: 3 }],
		data: { customType: "agent.peer", content: "Agent “reader” finished. Results do not establish task acceptance. Carried operator decisions retain their original scope; agent claims remain claims.\n\nSECOND READY\n\nUse agent_inspect for retained source evidence.", details: { label: "reader", status: "done" } },
	};
	const primary = new FakePrimary([notice]);
	const h = harness({ primary });
	await h.window.ready();
	const screen = h.window.render(160).join("\n");
	assert.match(screen, /\[agent\] reader · finished/);
	assert.match(screen, /SECOND READY/);
	assert.match(screen, /Open: \/agent or Ctrl\+Alt\+G/);
	assert.doesNotMatch(screen, /Results do not establish/);
	assert.doesNotMatch(screen, /agent_inspect/);
});

it("renders the live agent frame and replaces its partial at commit without duplicates", async () => {
	const h = harness({ rowsValue: [agentRow()], snapshots: new Map([["agent:a", { entries: [userEntry("u1", "task")], partial: false, revision: "snap" }]]), configuredState: agentState() });
	h.source.frames.set("agent:a", liveFrame({
		revision: 1,
		entries: [userEntry("u1", "task")],
		live: [assistantEntry("live:generation", "partial text"), toolResultEntry("live:tool:t1", "t1", "running output")],
	}));
	await h.window.ready();
	let screen = h.window.render(160).join("\n");
	assert.match(screen, /partial text/);
	assert.match(screen, /running output/);
	assert.equal(screen.split("partial text").length - 1, 1);
	assert.equal(screen.split("running output").length - 1, 1);

	h.source.frames.set("agent:a", liveFrame({
		revision: 2,
		entries: [userEntry("u1", "task"), assistantEntry("a2", "committed text"), toolResultEntry("tr1", "t1", "finished output")],
		live: [],
	}));
	await h.window.refresh();
	screen = h.window.render(160).join("\n");
	assert.match(screen, /committed text/);
	assert.match(screen, /finished output/);
	assert.equal(screen.split("committed text").length - 1, 1, "the committed assistant block appears once");
	assert.doesNotMatch(screen, /partial text/);
	assert.doesNotMatch(screen, /running output/);
});

it("opens the live task graph and selects a conversation peer", async () => {
	const h = harness({ rowsValue: [agentRow()], snapshots: new Map([["agent:a", { entries: [userEntry("u1", "task")], partial: false, revision: "r1" }]]), configuredState: agentState() });
	h.source.taskFrames.set("agent:a", tasksFrame([
		{ id: 1, kind: "agent", conversationId: 2, background: false, abortRequested: false, status: "running" as TaskGraphRow["status"], phase: "tool", waitsOn: [], conversations: [] },
		{ id: 2, kind: "tool", conversationId: 2, owner: 1, background: true, abortRequested: false, status: "pending" as TaskGraphRow["status"], phase: "", waitsOn: [], conversations: [2] },
	], [{ conversationId: 2, identity: "agent:other", name: "Other agent" }]));
	await h.window.ready();
	h.window.handleInput("\x1bOR"); // F3: focus the agent pane.
	h.window.handleInput("\x1b[19~"); // F8: tasks.
	await flush();
	let screen = stripVTControlCharacters(h.window.render(140).join("\n"));
	assert.match(screen, /TASKS {2}2 tasks · live/);
	assert.match(screen, /agent · running tool/);
	assert.match(screen, /tool · pending · background/);

	h.window.handleInput(ENTER);
	await flush();
	screen = stripVTControlCharacters(h.window.render(140).join("\n"));
	assert.doesNotMatch(screen, /TASKS {2}2 tasks/, "the tasks view closes on selection");
	assert.ok([h.state.left, h.state.right].some((slot) => slot?.kind === "agent" && slot.id === "agent:other"), "the task conversation opens as a peer");
});

it("shows a quiet primary notice in the open window without reopening it", async () => {
	const primary = new FakePrimary([]);
	const h = harness({ primary });
	await h.window.ready();
	h.window.render(140);
	primary.queueNotice({
		id: "quiet-1",
		kind: "pi.custom_message",
		model: [{ role: "user", content: "placeholder", timestamp: 5 }],
		data: { customType: "agent.peer", content: "Agent “reader” finished.\n\nQUIET BODY", details: { label: "reader", status: "done" } },
	});
	assert.doesNotMatch(h.window.render(140).join("\n"), /QUIET BODY/, "the cached projection hides the append until the observer re-reads");
	primary.refresh();
	const screen = h.window.render(140).join("\n");
	assert.match(screen, /QUIET BODY/);
	assert.match(screen, /\[agent\] reader · finished/);
});

it("pairs the primary with the working agent on first open", async () => {
	const working = { ...agentRow("agent:busy"), state: "working" as const, modifiedAt: 1 };
	const idle = { ...agentRow("agent:idle"), state: "idle" as const, modifiedAt: 5 };
	const h = harness({ rowsValue: [idle, working], snapshots: new Map([["agent:busy", { entries: [userEntry("a1", "busy task")], partial: false, revision: "r1" }], ["agent:idle", { entries: [], partial: false, revision: "r2" }]]) });
	await h.window.ready();
	assert.deepEqual(h.state.right, { kind: "agent", id: "agent:busy" }, "the default pair shows the working agent");
	assert.equal(h.state.selectedAgent, "agent:busy");
	const rendered = h.window.render(140).join("\n");
	assert.match(rendered, /Primary · this Pi/);
	assert.match(rendered, /Agent · reader/);
});

it("keeps one caret and retains each peer draft across a focus switch", async () => {
	const h = harness({ rowsValue: [agentRow()], snapshots: new Map([["agent:a", { entries: [userEntry("a1", "agent task")], partial: false, revision: "r1" }]]), configuredState: agentState() });
	await h.window.ready();
	type(h.window, "primary draft");
	assert.equal(caretCount(h.window.render(140)), 1, "only the focused composer shows a caret");
	h.window.handleInput(F3);
	assert.equal(caretCount(h.window.render(140)), 1, "focus moved, still exactly one caret");
	type(h.window, "agent draft");
	h.window.handleInput(F2);
	assert.equal(caretCount(h.window.render(140)), 1);
	assert.equal(h.state.panes.get("primary")?.draft, "primary draft");
	assert.equal(h.state.panes.get("agent:agent:a")?.draft, "agent draft");
	const rendered = h.window.render(140).join("\n");
	assert.match(rendered, /primary draft/);
	assert.match(rendered, /agent draft/);
});

it("expands and restores the focused pane without losing the pair", async () => {
	const h = harness({ rowsValue: [agentRow()], snapshots: new Map([["agent:a", { entries: [userEntry("a1", "task")], partial: false, revision: "r1" }]]), configuredState: agentState() });
	await h.window.ready();
	type(h.window, "draft");
	h.window.handleInput(F4);
	assert.equal(h.state.expanded, "left");
	let rendered = h.window.render(140).join("\n");
	assert.match(rendered, /Primary · this Pi/);
	assert.doesNotMatch(rendered, /Agent · reader/);
	h.window.handleInput(F4);
	assert.equal(h.state.expanded, undefined);
	rendered = h.window.render(140).join("\n");
	assert.match(rendered, /Primary · this Pi/);
	assert.match(rendered, /Agent · reader/);
	assert.equal(h.state.panes.get("primary")?.draft, "draft");
});

it("closes a pane without touching work and reopens it with draft, scroll, and focus", async () => {
	const entries = Array.from({ length: 80 }, (_, index) => index % 2 ? assistantEntry(`a${index}`, `agent line ${index}`) : userEntry(`u${index}`, `user line ${index}`));
	const h = harness({ rows: 24, columns: 80, rowsValue: [agentRow()], snapshots: new Map([["agent:a", { entries, partial: false, revision: "r1" }]]), configuredState: agentState() });
	await h.window.ready();
	h.window.render(80);
	h.window.handleInput(F3);
	type(h.window, "unsent agent draft");
	h.window.handleInput(PAGE_UP);
	h.window.render(80);
	assert.equal(h.state.panes.get("agent:agent:a")?.view.follow, false, "scrolling up leaves follow mode");
	assert.ok((h.state.panes.get("agent:agent:a")?.view.scroll ?? 0) > 0);

	h.window.handleInput(F5);
	assert.equal(h.state.right, undefined, "close removes the pane only");
	assert.equal(h.state.panes.get("agent:agent:a")?.draft, "unsent agent draft", "the draft state survives close");
	h.window.handleInput(F6);
	assert.match(h.window.render(80).join("\n"), /All peers/);
	h.window.handleInput(DOWN);
	h.window.handleInput(ENTER);
	h.window.render(80);
	assert.deepEqual(h.state.right, { kind: "agent", id: "agent:a" });
	assert.equal(h.state.focus, "right");
	assert.equal(h.state.panes.get("agent:agent:a")?.view.follow, false, "the reading position survives reopen");
	assert.match(h.window.render(80).join("\n"), /unsent agent draft/);
});

it("hands slash input and the Continue action to the native editor without submitting", async () => {
	const h = harness();
	await h.window.ready();
	h.primary.editor = "native draft";
	type(h.window, "/model");
	h.window.handleInput(ENTER);
	assert.deepEqual(h.primary.sent, [], "the slash text is never submitted from the window");
	assert.deepEqual(h.primary.handed.map((item) => item.text), ["/model"]);
	assert.equal(h.state.nativeDraftBefore, "native draft");
	assert.equal(h.done(), 1, "the window exits to native Pi");

	const reopened = harness({ configuredState: h.state });
	await reopened.window.ready();
	assert.match(reopened.window.render(140).join("\n"), /native draft saved/, "the replaced native draft stays discoverable");

	const second = harness();
	await second.window.ready();
	type(second.window, "a template draft");
	second.window.handleInput("\x15"); // Clear the command line without losing the retained draft.
	type(second.window, "/continue");
	second.window.handleInput(ENTER);
	assert.deepEqual(second.primary.sent, [], "Continue never submits");
	assert.deepEqual(second.primary.handed.map((item) => item.text), ["a template draft"]);
	assert.equal(second.done(), 1);
});

it("submits plain primary text with the displayed mode and clears the draft", async () => {
	const h = harness();
	await h.window.ready();
	type(h.window, "hello there");
	h.window.handleInput(ENTER);
	assert.deepEqual(h.primary.sent, [{ text: "hello there", mode: "auto" }]);
	h.window.render(140);
	assert.equal(h.state.panes.get("primary")?.draft, "");
});

it("submits agent text through the existing controls and honors the steer mode", async () => {
	const h = harness({ rowsValue: [agentRow()], snapshots: new Map([["agent:a", { entries: [userEntry("a1", "task")], partial: false, revision: "r1" }]]), configuredState: agentState() });
	await h.window.ready();
	h.window.handleInput(F3);
	type(h.window, "do the task");
	h.window.handleInput(ENTER);
	await flush();
	assert.deepEqual(h.actions[0], { name: "submit", input: { id: "agent:a", text: "do the task", mode: "send" } });
	type(h.window, "/steer");
	h.window.handleInput(ENTER);
	type(h.window, "change of plan");
	h.window.handleInput(ENTER);
	await flush();
	assert.deepEqual(h.actions[1], { name: "submit", input: { id: "agent:a", text: "change of plan", mode: "steer" } });
});

it("selects the peer created by New", async () => {
	const h = harness({ rowsValue: [agentRow()], snapshots: new Map([["agent:a", { entries: [userEntry("a1", "first")], partial: false, revision: "r1" }]]), configuredState: agentState() });
	await h.window.ready();
	h.window.handleInput(F7);
	type(h.window, "new task");
	h.window.handleInput(ENTER);
	await flush();
	assert.deepEqual(h.actions.at(-1), { name: "new", input: { prompt: "new task" } });
	const slots = [h.state.left, h.state.right].filter((slot) => slot?.kind === "agent" && slot.id === "agent:new1");
	assert.equal(slots.length, 1, "the created peer is visible");
	assert.equal(h.state.focus === "left" ? h.state.left?.kind === "agent" : h.state.right?.kind === "agent", true, "focus follows the created peer");
});

it("places Fork beside its source and Repair with the operator's correction", async () => {
	const h = harness({ rowsValue: [agentRow()], snapshots: new Map([["agent:a", { entries: [userEntry("a1", "first"), assistantEntry("a2", "second")], partial: false, revision: "r1" }]]), configuredState: agentState() });
	await h.window.ready();
	h.window.handleInput(F3);
	type(h.window, "/fork");
	h.window.handleInput(ENTER);
	h.window.handleInput(ENTER);
	await flush();
	assert.deepEqual(h.actions.at(-1), { name: "fork", input: { id: "agent:a", entryId: "a2" } });
	const forkVisible = [h.state.left, h.state.right].filter((slot) => slot?.kind === "agent" && slot.id === "agent:fork1");
	assert.equal(forkVisible.length, 1, "the fork is placed beside its source");
	const sourceVisible = [h.state.left, h.state.right].filter((slot) => slot?.kind === "agent" && slot.id === "agent:a");
	assert.equal(sourceVisible.length, 1, "the source stays visible");

	const repaired = harness({ rowsValue: [agentRow()], snapshots: new Map([["agent:a", { entries: [userEntry("a1", "first"), assistantEntry("a2", "second")], partial: false, revision: "r1" }]]), configuredState: agentState() });
	await repaired.window.ready();
	repaired.window.handleInput(F3);
	type(repaired.window, "/repair");
	repaired.window.handleInput(ENTER);
	repaired.window.handleInput(ENTER);
	type(repaired.window, "use the other file");
	repaired.window.handleInput(ENTER);
	await flush();
	assert.deepEqual(repaired.actions.at(-1), { name: "repair", input: { id: "agent:a", entryId: "a2", correction: "use the other file" } });
});

it("returns to native Pi on Escape without submitting or aborting anything", async () => {
	const h = harness();
	await h.window.ready();
	type(h.window, "unfinished");
	h.window.handleInput(ESCAPE);
	assert.equal(h.done(), 1);
	assert.deepEqual(h.primary.sent, []);
	assert.equal(h.state.panes.get("primary")?.draft, "unfinished", "the draft stays recoverable for the next open");
});

it("opens the command-layer action list from the View menu", async () => {
	const targets: Array<AgentConversationSummary | undefined> = [];
	const h = harness({
		rowsValue: [agentRow()],
		snapshots: new Map([["agent:a", { entries: [userEntry("a1", "task")], partial: false, revision: "r1" }]]),
		configuredState: agentState(),
		runActions: async (target) => { targets.push(target); return { text: "Action outcome" }; },
	});
	await h.window.ready();
	h.window.handleInput(F3);
	type(h.window, "/view");
	h.window.handleInput(ENTER);
	for (let index = 0; index < 5; index++) h.window.handleInput(DOWN);
	h.window.handleInput(ENTER);
	await flush();
	assert.equal(targets.length, 1);
	assert.equal(targets[0]?.id, "agent:a");
	assert.equal(h.state.notice, "Action outcome");
});

it("prepends an earlier page without losing the reading position", async () => {
	const newest = Array.from({ length: 60 }, (_, index) => userEntry(`p2-${index}`, `page two line ${index}`));
	const h = harness({ rows: 24, columns: 80, rowsValue: [{ ...agentRow(), firstMessage: undefined }], snapshots: new Map([["agent:a", { entries: newest, partial: true, revision: "page-2", nextBefore: 100 }]]), configuredState: agentState() });
	h.source.earlierImpl = async () => ({ entries: [userEntry("p1-0", "page one line 0"), userEntry("p1-1", "page one line 1")], nextBefore: 50 });
	await h.window.ready();
	h.window.handleInput(F3);
	h.window.render(80);
	type(h.window, "/scroll top");
	h.window.handleInput(ENTER);
	const before = stripVTControlCharacters(h.window.render(80).join("\n")).split("\n");
	const beforeRow = before.findIndex((line) => line.includes("page two line 0"));
	assert.ok(beforeRow >= 3);
	assert.equal(h.state.panes.get("agent:agent:a")?.view.anchor?.id, "p2-0");

	type(h.window, "/scroll top");
	h.window.handleInput(ENTER);
	await flush();
	assert.equal(h.source.earlierCalls.length, 1);
	const after = stripVTControlCharacters(h.window.render(80).join("\n")).split("\n");
	assert.equal(after.findIndex((line) => line.includes("page two line 0")), beforeRow, "the anchored block stays on its row after the prepend");
	assert.equal(h.state.panes.get("agent:agent:a")?.view.anchor?.id, "p2-0");
});

it("drops the summary first task once the real first entry loads", async () => {
	const h = harness({ rowsValue: [{ ...agentRow(), firstMessage: "first task line" }], snapshots: new Map([["agent:a", { entries: [userEntry("p2-0", "second message")], partial: true, revision: "page-2", nextBefore: 100 }]]), configuredState: agentState() });
	h.source.earlierImpl = async () => ({ entries: [userEntry("first", "first task line")], nextBefore: null });
	await h.window.ready();
	h.window.handleInput(F3);
	let screen = stripVTControlCharacters(h.window.render(140).join("\n"));
	assert.equal(screen.split("first task line").length - 1, 1, "the summary block fills the gap before the page loads");

	type(h.window, "/scroll top");
	h.window.handleInput(ENTER);
	await flush();
	screen = stripVTControlCharacters(h.window.render(140).join("\n"));
	assert.equal(screen.split("first task line").length - 1, 1, "the real first entry replaces the summary block, not both");
	assert.match(screen, /Start of conversation · 0 earlier/);
});

it("does not issue overlapping earlier reads", async () => {
	const newest = Array.from({ length: 40 }, (_, index) => userEntry(`p2-${index}`, `line ${index}`));
	const h = harness({ rows: 24, columns: 80, rowsValue: [agentRow()], snapshots: new Map([["agent:a", { entries: newest, partial: true, revision: "r", nextBefore: 100 }]]), configuredState: agentState() });
	let resolvePage!: (page: { entries: AgentConversationEntry[]; nextBefore: number | null }) => void;
	h.source.earlierImpl = () => new Promise((resolve) => { resolvePage = resolve; });
	await h.window.ready();
	h.window.handleInput(F3);
	h.window.render(80);
	type(h.window, "/scroll top");
	h.window.handleInput(ENTER);
	h.window.handleInput(PAGE_UP);
	h.window.handleInput(PAGE_UP);
	assert.equal(h.source.earlierCalls.length, 1, "a read in flight blocks a second read");
	resolvePage({ entries: [userEntry("p1-0", "older line")], nextBefore: 50 });
	await flush();
	h.window.render(80);
	type(h.window, "/scroll top");
	h.window.handleInput(ENTER);
	await flush();
	type(h.window, "/scroll top");
	h.window.handleInput(ENTER);
	await flush();
	assert.equal(h.source.earlierCalls.length, 2, "the next page reads once the first settles");
});

it("re-attaches live observation when the window reopens and shows new entries", async () => {
	let observeCalls = 0;
	const listeners = new Set<(frame: ObservationFrame, fresh: boolean) => void>();
	const host: PeerObservationHost = {
		async list() { return { rows: [agentRow()], coverage: { complete: true, storagesVisited: 1, skipped: 0, omitted: 0, nextCursor: null }, observedAt: new Date(0).toISOString() }; },
		async snapshot() { return { entries: [], partial: false, revision: "snapshot", nextBefore: null, coverage: { complete: true, entries: 0, bytes: 0, hiddenExcluded: 0, entryLimitReached: false, byteLimitReached: false } }; },
		async observeLive(_id, scope, listener) { if (scope !== "conversation") return undefined; observeCalls++; listeners.add(listener); return () => { listeners.delete(listener); }; },
	};
	const source = createPeerObservationSource(host);
	const push = (frame: ConversationFrame): void => { for (const listener of [...listeners]) listener(frame, false); };
	const state = agentState();
	const first = harness({ configuredState: state, source });
	await first.window.ready();
	push(liveFrame({ revision: 1, entries: [userEntry("u1", "first task")] }));
	assert.match(stripVTControlCharacters(first.window.render(140).join("\n")), /first task/);
	first.window.dispose();
	assert.equal(listeners.size, 0, "the closed window releases its observation");

	const second = harness({ configuredState: state, source });
	await second.window.ready();
	assert.equal(observeCalls, 2, "the reopened window re-attaches the observation");
	push(liveFrame({ revision: 2, entries: [userEntry("u1", "first task"), userEntry("u2", "second task")] }));
	assert.match(stripVTControlCharacters(second.window.render(140).join("\n")), /second task/);
	second.window.dispose();
});

it("keeps a 1,000-block transcript warm at 140 columns inside the frame budget", async (t) => {
	const entries: AgentConversationEntry[] = [];
	for (let index = 0; index < 1000; index++) {
		const id = `b${index}`;
		if (index % 3 === 0) entries.push(userEntry(id, `user block ${index}`, index));
		else if (index % 3 === 1) entries.push(assistantEntry(id, `assistant block ${index}\n${"code line ".repeat(20)}`, index));
		else entries.push({ id, kind: "pi.tool-result", model: [{ role: "toolResult", toolCallId: `call-${index}`, toolName: "read", content: [{ type: "text", text: `tool output ${index}` }], isError: false, timestamp: index }] });
	}
	const h = harness({ rows: 45, columns: 140, rowsValue: [agentRow("agent:long")], snapshots: new Map([["agent:long", { entries, partial: false, revision: "long-r1" }]]), configuredState: agentState("agent:long") });
	await h.window.ready();
	const first = h.window.render(140);
	assert.ok(first.every((line) => visibleWidth(line) <= 140));
	const bottomLine = stripVTControlCharacters(first[44]);
	assert.match(bottomLine.slice(0, 69), /mode auto/, "the long primary transcript still docks the footer at the bottom");
	assert.match(bottomLine.slice(70), /mode auto/, "the long agent transcript still docks the footer at the bottom");
	const samples: number[] = [];
	for (let index = 0; index < 200; index++) {
		h.window.handleInput("x");
		const start = performance.now();
		const lines = h.window.render(140);
		samples.push(performance.now() - start);
		assert.ok(lines.every((line) => visibleWidth(line) <= 140));
	}
	samples.sort((a, b) => a - b);
	const p50 = samples[Math.floor(0.5 * (samples.length - 1))];
	const p95 = samples[Math.floor(0.95 * (samples.length - 1))];
	const max = samples[samples.length - 1];
	// Scheduler noise can spike a single frame under a parallel suite, so the worst-frame
	// gate allows at most 1% of warm frames above 50ms instead of the absolute maximum.
	const slowLimit = Math.max(1, Math.floor(samples.length * 0.01));
	const slow = samples.filter((value) => value > 50).length;
	t.diagnostic(`warm render at 140x45 over 200 frames: p50 ${p50.toFixed(2)}ms · p95 ${p95.toFixed(2)}ms · max ${max.toFixed(2)}ms · over 50ms ${slow}/${samples.length}`);
	assert.ok(p95 <= 16, `warm-frame p95 ${p95.toFixed(2)}ms must be at most 16ms`);
	assert.ok(slow <= slowLimit, `at most ${slowLimit} of ${samples.length} warm frames may exceed 50ms; saw ${slow}`);
});
