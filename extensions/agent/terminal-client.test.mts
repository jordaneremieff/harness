import assert from "node:assert/strict";
import { it } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { CURSOR_MARKER, type Component, type Focusable, type TUI } from "@earendil-works/pi-tui";
import { AgentComposer } from "./agent-composer.ts";
import { TerminalController, TerminalScreen, terminalAdmission, terminalKeys, terminalTargetFile, parseTerminalArgs, type TerminalManager } from "./terminal-client.ts";
import { terminalAction, parseTerminalConfiguration } from "./terminal-actions.ts";
import { row, page, conversationFrame, deferred, theme } from "./dashboard-test-fixture.mts";

function snapshot(revision = "initial"): Awaited<ReturnType<TerminalManager["snapshot"]>> {
	return { entries: [], revision, partial: false, nextBefore: null, coverage: conversationFrame().coverage };
}

function fixture() {
	const calls: Array<{ method: string; input: Record<string, unknown> }> = [];
	const observers = new Map<string, Parameters<TerminalManager["observeLive"]>[2]>();
	let closes = 0;
	let releases = 0;
	let admission: Promise<unknown> = Promise.resolve({ submissionId: 17, deduped: false });
	const manager: TerminalManager = {
		resolveTarget: async (id) => id === "@one" ? "a" : id,
		control: async (method, input) => { calls.push({ method, input }); return method === "attach" ? { status: { busy: false, cwd: "/work", agent: { thinkingLevel: "off" } } } : admission; },
		dashboardPage: async () => page([row("a", { state: "idle" }), row("b")]),
		snapshot: async () => snapshot(),
		observeLive: async (id, _scope, listener) => { observers.set(id, listener); return () => { releases++; }; },
		subscribeRoster: () => () => {},
		close: () => { closes++; },
	};
	const controller = new TerminalController({ manager, caller: { id: "terminal", cwd: "/work" } });
	return { controller, manager, calls, observers, setAdmission: (value: Promise<unknown>) => { admission = value; }, closes: () => closes, releases: () => releases };
}

it("A-B-A retains target drafts, anchor and expansion, and fences late A frames", async () => {
	const f = fixture();
	await f.controller.attach("@one");
	f.controller.setDraft("draft A");
	const a = f.controller.draftState;
	assert.ok(a);
	a.view.anchor = { id: "1", offset: 2 }; a.view.follow = false; a.view.expanded = true;
	await f.controller.attach("b");
	f.controller.setDraft("draft B");
	f.observers.get("a")?.(conversationFrame({ revision: 9 }), true, "live");
	assert.equal(f.controller.target, "b");
	assert.equal(f.controller.frame, undefined);
	assert.equal(f.controller.draftState?.draft, "draft B");
	await f.controller.attach("a");
	assert.equal(f.controller.draftState, a);
	assert.deepEqual(a.view.anchor, { id: "1", offset: 2 });
	assert.equal(a.view.expanded, true);
	assert.equal(a.draft, "draft A");
	assert.equal(f.calls.filter((call) => call.method === "submit").length, 0);
	f.controller.close();
});

it("late admission changes only its captured target and submitted draft revision", async () => {
	const f = fixture();
	await f.controller.attach("a");
	const ack = deferred<unknown>(); f.setAdmission(ack.promise);
	f.controller.setDraft("original");
	const sending = f.controller.send();
	f.controller.setDraft("replacement");
	await f.controller.attach("b"); f.controller.setDraft("B");
	ack.resolve({ submissionId: 17, deduped: false }); await sending;
	assert.equal(f.controller.draftState?.draft, "B");
	assert.equal(f.controller.draftState?.receipt, undefined);
	await f.controller.attach("a");
	assert.equal(f.controller.draftState?.draft, "replacement");
	assert.deepEqual(f.controller.draftState?.history, ["original"]);
	f.setAdmission(Promise.resolve({ submissionId: 17, deduped: false }));
	await f.controller.send();
	assert.equal(f.controller.draftState?.draft, "");
	f.controller.setDraft("follow"); f.controller.setMode("followUp"); await f.controller.send();
	assert.equal(f.calls.at(-1)?.input.whenBusy, "followUp");
	assert.equal(f.calls.at(-1)?.input.replyTo, "a");
	f.controller.close();
});

it("restoring submitted text after a change does not clear the newer draft revision", async () => {
	const f = fixture(); await f.controller.attach("a");
	const ack = deferred<unknown>(); f.setAdmission(ack.promise);
	f.controller.setDraft("same"); const sending = f.controller.send();
	f.controller.setDraft("different"); f.controller.setDraft("same");
	ack.resolve({ submissionId: 17, deduped: false }); await sending;
	assert.equal(f.controller.draftState?.draft, "same");
	f.controller.close();
});

it("a late snapshot cannot replace a newer selection or a closed controller", async () => {
	const f = fixture();
	const a = deferred<Awaited<ReturnType<TerminalManager["snapshot"]>>>();
	const started = deferred();
	f.manager.snapshot = async (id) => { if (id === "a") { started.resolve(); return a.promise; } return snapshot("B"); };
	const attaching = f.controller.attach("a"); await started.promise;
	await f.controller.attach("b");
	a.resolve(snapshot("late A")); await attaching;
	assert.equal(f.controller.target, "b"); assert.equal(f.controller.snapshot?.revision, "B");
	f.controller.close(); f.controller.close();
	assert.equal(f.closes(), 1);
	assert.equal(f.calls.some((call) => call.method === "abort"), false);
	assert.ok(f.releases() > 0);
});

it("exact nonroot attachment does not require membership in the bounded roster", async () => {
	const f = fixture(); await f.controller.attach("a:7");
	assert.equal(f.controller.target, "a:7"); assert.equal(f.controller.row?.id, "a:7");
	assert.ok(Number.isNaN(f.controller.row?.cost));
	assert.equal(f.controller.row?.owner, "unknown");
	assert.equal(f.controller.row?.creatingOwnerId, undefined);
	f.controller.close();
});

it("restart reads the last target without persisting native conversation state", () => {
	const root = mkdtempSync(join(tmpdir(), "agent-terminal-target-"));
	try { const first = terminalTargetFile(root); assert.equal(first.read(), undefined); first.write("a:7"); assert.equal(terminalTargetFile(root).read(), "a:7"); }
	finally { rmSync(root, { recursive: true, force: true }); }
	assert.deepEqual(parseTerminalArgs(["--theme", "light", "--session", "@one"]), { selectedTheme: "light", session: "@one" });
	assert.throws(() => parseTerminalArgs(["--theme", "system"]), /automatic\/system/);
	assert.throws(() => parseTerminalArgs(["--session"]), /incomplete/);
});

function screenFixture(controller: TerminalController) {
	const renderWaiters: Array<{ ready?: () => boolean; resolve(): void }> = [];
	const terminal = { rows: 24, columns: 80 };
	const overlays: Array<Component & Focusable> = [];
	const tui = { terminal, requestRender() { for (const waiter of renderWaiters.splice(0)) { if (!waiter.ready || waiter.ready()) waiter.resolve(); else renderWaiters.push(waiter); } }, showOverlay(component: Component & Focusable) { overlays.push(component); component.focused = true; tui.requestRender(); return { hide() { tui.requestRender(); } }; } } as unknown as TUI;
	let done = 0;
	return { screen: new TerminalScreen(tui, theme, terminalKeys(), controller, () => { done++; }), done: () => done, terminal, overlays, afterRender: (ready?: () => boolean) => ready?.() ? Promise.resolve() : new Promise<void>((resolve) => renderWaiters.push({ ready, resolve })) };
}

it("the main console is full-width; /agent and Escape return without a work control", async () => {
	const f = fixture(); await f.controller.attach("a");
	const { screen } = screenFixture(f.controller);
	f.controller.setDraft("kept");
	screen.handleInput("\x1b");
	assert.ok(screen.render(80).map(stripVTControlCharacters).some((line) => line.includes("Agents")));
	screen.handleInput("\x1b");
	assert.ok(screen.render(80).map(stripVTControlCharacters).some((line) => line.includes("Shared input")));
	assert.equal(f.controller.draftState?.draft, "kept");
	assert.equal(f.controller.target, "a");
	assert.equal(f.calls.some((call) => call.method === "abort" || call.method === "submit"), false);
	f.controller.setDraft("/agent"); screen.handleInput("\r");
	assert.ok(screen.render(80).map(stripVTControlCharacters).some((line) => line.includes("Agents")));
	screen.dispose(); f.controller.close();
});

it("empty startup retains a navigation input after the dashboard closes", () => {
	const f = fixture(); const { screen, done } = screenFixture(f.controller);
	screen.openDashboard(); screen.handleInput("\x1b");
	assert.ok(screen.render(80).map(stripVTControlCharacters).some((line) => line.includes("Command:")));
	screen.handleInput("/agent"); screen.handleInput("\r");
	assert.ok(screen.render(80).map(stripVTControlCharacters).some((line) => line.includes("Agents")));
	screen.handleInput("\x1b"); screen.handleInput("\x04"); assert.equal(done(), 1);
	screen.dispose(); f.controller.close();
});

it("public native editor keeps configured history, nonempty Ctrl+D deletion and multiline text", () => {
	const keys = terminalKeys(); keys.setUserBindings({ "tui.editor.historyPrevious": "ctrl+p", "tui.editor.historyNext": "ctrl+n" });
	const composer = new AgentComposer({ tui: { terminal: { rows: 24, columns: 80 }, requestRender() {} } as unknown as TUI, theme, keys, onSubmit() {}, onEscape() {} });
	composer.addToHistory("prior"); composer.handleInput("\x10"); assert.equal(composer.getText(), "prior");
	composer.setText("abc"); composer.handleInput("\x01"); composer.handleInput("\x04"); assert.equal(composer.getText(), "bc");
	composer.setText("first"); composer.handleInput("\x0a"); composer.handleInput("second"); assert.equal(composer.getText(), "first\nsecond");
});

it("native action confirmation cancels safely and uses the captured target", async () => {
	const f = fixture(); await f.controller.attach("a");
	const captured = row("a");
	await f.controller.attach("b");
	const cancelled = await terminalAction(f.controller, async () => undefined, "abort", captured);
	assert.equal(cancelled, undefined); assert.equal(f.calls.some((call) => call.method === "abort"), false);
	await terminalAction(f.controller, async () => "stop", "abort", captured);
	assert.equal(f.calls.at(-1)?.input.sessionId, "a");
	assert.equal(f.controller.target, "b");
	await assert.rejects(terminalAction(f.controller, async () => '{"sessionId":"other"}', "configure", captured), /Use only/);
	f.controller.close();
});

it("admission receipts state native identity, submission, deduplication and requested mode", async () => {
	const f = fixture(); await f.controller.attach("a");
	f.controller.row = row("a", { state: "working" });
	f.setAdmission(Promise.resolve({ submissionId: 31, conversationId: 1, identity: "a", deduped: false }));
	f.controller.setDraft("literal /help"); await f.controller.send();
	assert.equal(f.controller.draftState?.receipt, "Input admitted for a (submission 31; requested steer)");
	f.setAdmission(Promise.resolve({ submissionId: 32, identity: "a", deduped: true }));
	f.controller.setDraft("next"); f.controller.setMode("followUp"); await f.controller.send();
	assert.equal(f.controller.draftState?.receipt, "Input already admitted for a (submission 32; requested follow-up)");
	assert.equal(terminalAdmission({ submissionId: 9, identity: "a:7" }, "a:7", "steer"), "Input admitted for a:7 (submission 9; requested steer)");
	assert.throws(() => terminalAdmission({ submissionId: 9, identity: "b" }, "a", "steer"), /disagrees/);
	assert.doesNotMatch(f.controller.draftState?.receipt ?? "", /queued|placed/);
	f.controller.close();
});

it("uncertain input failure retains the target's draft, mode and history", async () => {
	const f = fixture(); await f.controller.attach("a");
	const gate = deferred();
	f.setAdmission(gate.promise.then(() => { throw new Error("connection lost"); }));
	f.controller.setDraft("retained"); f.controller.setMode("followUp");
	const failed = assert.rejects(f.controller.send(), /connection lost/);
	gate.resolve(); await failed;
	assert.equal(f.controller.draftState?.draft, "retained");
	assert.equal(f.controller.draftState?.mode, "followUp");
	assert.deepEqual(f.controller.draftState?.history, []);
	assert.match(f.controller.draftState?.receipt ?? "", /Delivery not confirmed/);
	assert.equal(f.controller.draftState?.pending, undefined);
	f.controller.close();
});

it("standalone New is visibly unavailable and neither letter nor Enter starts creation", async () => {
	const f = fixture();
	f.manager.dashboardPage = async () => { const empty = page([]); return { ...empty, coverage: { ...empty.coverage, complete: false } }; };
	const { screen, afterRender } = screenFixture(f.controller);
	const text = () => screen.render(100).map(stripVTControlCharacters).join("\n");
	const loaded = afterRender(() => /New unavailable/.test(text()) && /Incomplete/.test(text())); screen.openDashboard(); await loaded;
	assert.match(text(), /New unavailable/);
	assert.match(text(), /Incomplete/);
	assert.doesNotMatch(text(), /n new|Enter new agent/);
	screen.handleInput("n"); assert.match(text(), /New agent is unavailable/);
	screen.handleInput("\r"); assert.doesNotMatch(text(), /Enter starts/);
	assert.equal(f.calls.length, 0);
	screen.dispose(); f.controller.close();
});

it("late enter and earlier failures do not replace another target's notice", async () => {
	const f = fixture(); await f.controller.attach("a");
	const { screen, afterRender } = screenFixture(f.controller);
	const gate = deferred();
	f.manager.resolveTarget = async (id) => { if (id === "missing") { await gate.promise; throw new Error("late enter failure"); } return id; };
	f.controller.setDraft("/agent enter missing"); screen.handleInput("\r");
	await f.controller.attach("b");
	const shown = afterRender(); gate.resolve(); await shown;
	assert.doesNotMatch(screen.render(120).join("\n"), /late enter failure/);
	const earlier = deferred(); const started = deferred();
	f.controller.snapshot = { entries: [], partial: false, revision: "earlier", nextBefore: 1 };
	f.manager.snapshot = async () => { started.resolve(); await earlier.promise; throw new Error("late history failure"); };
	screen.handleInput("\x1b[5~"); await started.promise;
	f.manager.snapshot = async () => snapshot("A");
	await f.controller.attach("a");
	const historyShown = afterRender(); earlier.resolve(); await historyShown;
	assert.doesNotMatch(screen.render(120).join("\n"), /late history failure/);
	screen.dispose(); f.controller.close();
});

it("unavailable observation is visible and a live observation clears it", async () => {
	const f = fixture(); await f.controller.attach("a");
	const { screen } = screenFixture(f.controller);
	const frame = conversationFrame();
	f.observers.get("a")?.(frame, true, "live");
	f.observers.get("a")?.(undefined, false, "unavailable");
	assert.equal(f.controller.availability?.state, "unavailable");
	assert.match(screen.render(120).join("\n"), /Connection unavailable/);
	f.observers.get("a")?.(frame, true, "live");
	assert.doesNotMatch(screen.render(120).join("\n"), /Connection unavailable/);
	screen.dispose(); f.controller.close();
});

it("resize and dashboard return keep native focus, draft, expansion and reading state", async () => {
	const f = fixture(); await f.controller.attach("a");
	const { screen, terminal } = screenFixture(f.controller);
	f.controller.setDraft("first\nsecond");
	const state = f.controller.draftState; assert.ok(state);
	state.view.showThinking = true; state.view.expanded = true; state.view.follow = false;
	state.view.anchor = { id: "1", offset: 0 };
	assert.ok(screen.render(80).some((line) => line.includes(CURSOR_MARKER)));
	terminal.rows = 12; assert.match(screen.render(50).join("\n"), /Resize to use/);
	terminal.rows = 30;
	screen.handleInput("\x1b"); screen.handleInput("\x1b");
	screen.render(120);
	assert.equal(state.draft, "first\nsecond"); assert.equal(state.view.expanded, true); assert.equal(state.view.showThinking, true);
	assert.equal(state.view.follow, false);
	screen.dispose(); f.controller.close();
});

it("only documented terminal commands intercept slash text, including the quit exception", async () => {
	const f = fixture(); await f.controller.attach("a");
	const { screen, done, afterRender } = screenFixture(f.controller);
	const admitted = afterRender(() => f.controller.draftState?.receipt?.startsWith("Input admitted") === true); f.controller.setDraft("/help"); screen.handleInput("\r"); await admitted;
	assert.equal(f.calls.at(-1)?.input.message, "/help");
	f.controller.setDraft("/quit"); screen.handleInput("\r"); assert.equal(done(), 1);
	assert.equal(f.calls.filter((call) => call.method === "submit").length, 1);
	screen.dispose(); f.controller.close();
});

it("configure advertises and passes the native model object, and commands have invocation IDs", async () => {
	const f = fixture(); await f.controller.attach("a");
	let shown: string[] = [];
	await terminalAction(f.controller, async (_title, lines) => { shown = lines; return '{"model":{"provider":"test","modelId":"model"},"thinkingLevel":"high"}'; }, "configure", row("a"));
	assert.match(shown.join("\n"), /provider.*modelId/);
	assert.deepEqual(f.calls.at(-1)?.input.model, { provider: "test", modelId: "model" });
	assert.throws(() => parseTerminalConfiguration('{"model":"test/model"}'), /provider\/model string/);
	const answers = ["fixture-command", "args"];
	await terminalAction(f.controller, async () => answers.shift(), "command", row("a"));
	assert.equal(f.calls.at(-1)?.input.name, "fixture-command");
	assert.equal(f.calls.at(-1)?.input.sessionId, "a");
	assert.match(String(f.calls.at(-1)?.input.invocationId), /^[0-9a-f-]{36}$/);
	f.controller.close();
});

it("dashboard sends display the same native admission facts", async () => {
	const f = fixture(); await f.controller.attach("a");
	f.setAdmission(Promise.resolve({ submissionId: 73, identity: "a", deduped: true }));
	const { screen, afterRender } = screenFixture(f.controller);
	const roster = afterRender(() => screen.render(140).map(stripVTControlCharacters).join("\n").includes("tab message"));
	screen.openDashboard(); await roster;
	screen.handleInput("m");
	f.controller.setDraft("from dashboard");
	const receipt = afterRender(() => f.controller.draftState?.receipt?.includes("submission 73") === true);
	screen.handleInput("\r"); await receipt;
	assert.equal(f.controller.draftState?.receipt, "Input already admitted for a (submission 73; requested steer)");
	assert.equal(f.calls.at(-1)?.input.message, "from dashboard");
	screen.dispose(); f.controller.close();
});

it("uncertain A input survives edits, B navigation, failure, repeated failure and explicit restoration", async () => {
	const f = fixture(); await f.controller.attach("a");
	const gate = deferred(); f.setAdmission(gate.promise.then(() => { throw new Error("unknown admission"); }));
	f.controller.setDraft("original"); f.controller.setMode("followUp");
	const failed = assert.rejects(f.controller.send(), /unknown admission/);
	f.controller.setDraft("newer"); f.controller.setMode("steer");
	await f.controller.attach("b"); f.controller.setDraft("B draft");
	gate.resolve(); await failed;
	assert.deepEqual(f.controller.unconfirmed("a"), [{ text: "original", mode: "followUp" }]);
	assert.equal(f.controller.draftState?.draft, "B draft");
	await f.controller.attach("a");
	assert.equal(f.controller.draftState?.draft, "newer"); assert.equal(f.controller.draftState?.mode, "steer");
	assert.deepEqual(f.controller.draftState?.history, []);
	const again = deferred(); f.setAdmission(again.promise.then(() => { throw new Error("again"); }));
	const failedAgain = assert.rejects(f.controller.send(), /again/); again.resolve(); await failedAgain;
	assert.equal(f.controller.unconfirmed("a").length, 2);
	const original = f.controller.unconfirmed("a")[0];
	const state = f.controller.draftState; assert.ok(state);
	const revision = state.draftRevision;
	f.controller.setDraft("latest");
	assert.throws(() => f.controller.restoreUnconfirmed("a", original, revision, "steer"), /draft changed/);
	f.controller.restoreUnconfirmed("a", original, state.draftRevision, state.mode);
	assert.equal(state.draft, "original"); assert.equal(state.mode, "followUp");
	assert.equal(f.controller.unconfirmed("a").length, 2);
	f.controller.discardUnconfirmed("a", original); assert.equal(f.controller.unconfirmed("a").length, 1);
	assert.equal(f.calls.filter((call) => call.method === "submit").length, 2);
	f.controller.close();
});

it("recovery dialogs forward native input focus and restore only the captured target without sending", async () => {
	const f = fixture(); await f.controller.attach("a");
	const gate = deferred(); f.setAdmission(gate.promise.then(() => { throw new Error("unknown"); }));
	f.controller.setDraft("original"); f.controller.setMode("followUp");
	const failed = assert.rejects(f.controller.send()); gate.resolve(); await failed;
	const { screen, overlays, afterRender } = screenFixture(f.controller);
	f.controller.setDraft("/agent recover"); screen.handleInput("\r");
	const first = overlays.at(-1); assert.ok(first);
	assert.equal(first.focused, true); assert.ok(first.render(100).some((line) => line.includes(CURSOR_MARKER)));
	first.focused = false; assert.ok(first.render(100).every((line) => !line.includes(CURSOR_MARKER)));
	first.focused = true;
	const next = afterRender(() => overlays.length === 2);
	first.handleInput?.("1"); first.handleInput?.("\r"); await next;
	await f.controller.attach("b"); f.controller.setDraft("B draft");
	const restored = afterRender(() => f.controller.state.agents.get("a")?.draft === "original");
	overlays.at(-1)?.handleInput?.("restore"); overlays.at(-1)?.handleInput?.("\r"); await restored;
	assert.equal(f.controller.draftState?.draft, "B draft");
	assert.equal(f.controller.state.agents.get("a")?.mode, "followUp");
	assert.equal(f.calls.filter((call) => call.method === "submit").length, 1);
	screen.dispose(); f.controller.close();
});

it("configured interrupt keeps its native route without introducing Alt or F application bindings", () => {
	const keys = terminalKeys(); keys.setUserBindings({ "app.interrupt": "ctrl+x" });
	let escaped = 0;
	const composer = new AgentComposer({ tui: { terminal: { rows: 24, columns: 80 }, requestRender() {} } as unknown as TUI, theme, keys, onSubmit() {}, onEscape() { escaped++; } });
	composer.setText("kept"); composer.handleInput("\x18"); assert.equal(escaped, 1); assert.equal(composer.getText(), "kept");
	keys.setUserBindings({ "app.interrupt": "alt+x" }); composer.handleInput("\x1bx"); assert.equal(escaped, 1);
	keys.setUserBindings({ "app.interrupt": "f1" }); composer.handleInput("\x1bOP"); assert.equal(escaped, 1);
	composer.handleInput("\x1b"); assert.equal(escaped, 2);
});

it("late admission keeps a mode-only edit in the main console and dashboard", async () => {
	const main = fixture(); await main.controller.attach("a");
	const ack = deferred<unknown>(); main.setAdmission(ack.promise);
	main.controller.setDraft("main text"); const sending = main.controller.send();
	main.controller.setMode("followUp"); ack.resolve({ submissionId: 80 }); await sending;
	assert.equal(main.controller.draftState?.draft, ""); assert.equal(main.controller.draftState?.mode, "followUp");
	main.controller.close();
	const f = fixture(); await f.controller.attach("a");
	const dashboardAck = deferred<unknown>(); f.setAdmission(dashboardAck.promise);
	const started = deferred(); const control = f.manager.control;
	f.manager.control = async (method, input, caller) => { if (method === "submit") started.resolve(); return control(method, input, caller); };
	const { screen, afterRender } = screenFixture(f.controller);
	const roster = afterRender(() => screen.render(140).map(stripVTControlCharacters).join("\n").includes("tab message"));
	screen.openDashboard(); await roster; screen.handleInput("m");
	f.controller.setDraft("dashboard text"); screen.handleInput("\r"); await started.promise;
	f.controller.setMode("followUp");
	const applied = afterRender(() => f.controller.draftState?.receipt?.includes("submission 81") === true);
	dashboardAck.resolve({ submissionId: 81 }); await applied;
	assert.equal(f.controller.draftState?.draft, ""); assert.equal(f.controller.draftState?.mode, "followUp");
	screen.dispose(); f.controller.close();
});

it("long recovery text never clips the action effects, focused input or footer", async () => {
	const f = fixture(); await f.controller.attach("a");
	const gate = deferred(); f.setAdmission(gate.promise.then(() => { throw new Error("unknown"); }));
	f.controller.setDraft(Array.from({ length: 300 }, (_, i) => `retained line ${i}`).join("\n"));
	const failed = assert.rejects(f.controller.send()); gate.resolve(); await failed;
	const { screen, overlays, afterRender, terminal } = screenFixture(f.controller);
	f.controller.setDraft("/agent recover"); screen.handleInput("\r");
	const next = afterRender(() => overlays.length === 2);
	overlays.at(-1)?.handleInput?.("1"); overlays.at(-1)?.handleInput?.("\r"); await next;
	const dialog = overlays.at(-1); assert.ok(dialog);
	for (const height of [20, 100]) {
		terminal.rows = height; const lines = dialog.render(100); const text = lines.map(stripVTControlCharacters).join("\n");
		assert.ok(lines.length <= Math.floor(height * 0.9));
		assert.match(text, /restore replaces/); assert.match(text, /discard removes/); assert.match(text, /text lines omitted/);
		assert.match(text, /Type restore or discard/); assert.match(text, /Enter applies/);
		assert.ok(lines.some((line) => line.includes(CURSOR_MARKER)));
	}
	screen.dispose(); f.controller.close();
});
