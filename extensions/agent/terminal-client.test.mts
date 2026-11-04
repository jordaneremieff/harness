import assert from "node:assert/strict";
import { it } from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { CURSOR_MARKER, TuiAltScreen, getKeybindings, setKeybindings, type Component, type Focusable, type Terminal, type TUI } from "@earendil-works/pi-tui";
import { AgentComposer } from "./agent-composer.ts";
import { TerminalController, TerminalScreen, terminalAdmission, terminalKeys, terminalTargetFile, parseTerminalArgs, type TerminalManager } from "./terminal-client.ts";
import { terminalAction } from "./terminal-actions.ts";
import { scriptedDialogs } from "./terminal-dialog-fixture.mts";
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
	const responses = new Map<string, unknown>();
	const manager: TerminalManager = {
		resolveTarget: async (id) => id === "@one" ? "a" : id,
		control: async (method, input) => {
			calls.push({ method, input });
			if (method === "attach") return { status: { busy: false, cwd: "/work", agent: { thinkingLevel: "off" } } };
			return responses.has(method) ? responses.get(method) : admission;
		},
		dashboardPage: async () => page([row("a", { state: "idle" }), row("b")]),
		snapshot: async () => snapshot(),
		observeLive: async (id, _scope, listener) => { observers.set(id, listener); return () => { releases++; }; },
		subscribeRoster: () => () => {},
		close: async () => { closes++; },
	};
	const controller = new TerminalController({ manager, caller: { id: "terminal", cwd: "/work" } });
	return { controller, manager, calls, observers, responses, setAdmission: (value: Promise<unknown>) => { admission = value; }, closes: () => closes, releases: () => releases };
}

it("terminal teardown awaits its manager and reuses the same close operation", async () => {
	const f = fixture(), gate = deferred();
	let closes = 0;
	f.manager.close = async () => { closes++; await gate.promise; };
	let settled = false;
	const first = f.controller.close().then(() => { settled = true; });
	const second = f.controller.close();
	assert.equal(settled, false);
	assert.equal(closes, 1);
	gate.resolve(); await Promise.all([first, second]);
	assert.equal(settled, true);
});

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

function screenFixture(controller: TerminalController, publishStatus?: (status: import("@earendil-works/pi-tui").ProgramStatus) => void) {
	const renderWaiters: Array<{ ready?: () => boolean; resolve(): void }> = [];
	const terminal = { rows: 24, columns: 80 };
	const overlays: Array<Component & Focusable> = [];
	const tui = { terminal, requestRender() { for (const waiter of renderWaiters.splice(0)) { if (!waiter.ready || waiter.ready()) waiter.resolve(); else renderWaiters.push(waiter); } }, showOverlay(component: Component & Focusable) { overlays.push(component); component.focused = true; tui.requestRender(); return { hide() { tui.requestRender(); } }; } } as unknown as TUI;
	let done = 0;
	/** A render condition that no paint satisfies fails within the deadline instead of hanging the run. */
	const afterRender = (ready?: () => boolean, deadlineMs = 5000) => ready?.() ? Promise.resolve() : new Promise<void>((resolve, reject) => {
		const waiter = { ready, resolve: () => { clearTimeout(timer); resolve(); } };
		const timer = setTimeout(() => {
			const index = renderWaiters.indexOf(waiter);
			if (index >= 0) renderWaiters.splice(index, 1);
			reject(new Error(`No render satisfied the awaited condition within ${deadlineMs} ms`));
		}, deadlineMs);
		renderWaiters.push(waiter);
	});
	return { screen: new TerminalScreen(tui, theme, terminalKeys(), controller, () => { done++; }, publishStatus), done: () => done, terminal, overlays, afterRender };
}

it("the main console is full-width; /agent and Escape return without a work control", async () => {
	const f = fixture(); await f.controller.attach("a");
	const { screen } = screenFixture(f.controller);
	f.controller.setDraft("kept");
	screen.handleInput("\x1b");
	assert.ok(screen.render(80).map(stripVTControlCharacters).some((line) => line.includes("Agents")));
	screen.handleInput("\x1b");
	assert.ok(screen.render(80).map(stripVTControlCharacters).some((line) => line.includes("Dashboard")));
	assert.ok(screen.render(80).map(stripVTControlCharacters).some((line) => line.includes("Detach")));
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
	const cancelled = await terminalAction(f.controller, scriptedDialogs([undefined]), "abort", captured);
	assert.equal(cancelled, undefined); assert.equal(f.calls.some((call) => call.method === "abort"), false);
	const declined = await terminalAction(f.controller, scriptedDialogs([false]), "release", captured);
	assert.equal(declined, undefined); assert.equal(f.calls.some((call) => call.method === "release"), false);
	await terminalAction(f.controller, scriptedDialogs([true]), "abort", captured);
	assert.equal(f.calls.at(-1)?.method, "abort");
	assert.equal(f.calls.at(-1)?.input.sessionId, "a");
	await terminalAction(f.controller, scriptedDialogs([true]), "release", captured);
	assert.equal(f.calls.at(-1)?.method, "release");
	assert.equal(f.calls.at(-1)?.input.sessionId, "a");
	assert.equal(f.controller.target, "b");
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

it("configuration chooses the model and reasoning from the host's list and applies them to the captured target", async () => {
	const f = fixture(); await f.controller.attach("a");
	f.responses.set("models", { models: [{ provider: "test", modelId: "model", name: "Test model", reasoning: true }, { provider: "other", modelId: "small", reasoning: false }], source: "available-snapshot", observedAt: new Date().toISOString() });
	f.responses.set("configure", { outcome: "applied" });
	const captured = row("a");
	await f.controller.attach("b");
	const dialogs = scriptedDialogs(["model", "test/model", "reasoning", "high", "apply"]);
	const result = await terminalAction(f.controller, dialogs, "configure", captured);
	const offered = dialogs.calls.find((call) => call.title.startsWith("Model"))?.choices;
	assert.deepEqual(offered?.map((choice) => choice.value), ["other/small", "test/model"]);
	assert.match(offered?.[1]?.label ?? "", /Test model/);
	const configure = f.calls.find((call) => call.method === "configure");
	assert.deepEqual({ ...configure?.input }, { sessionId: "a", model: { provider: "test", modelId: "model" }, thinkingLevel: "high" });
	assert.equal(result?.sessionId, "a");
	assert.equal(dialogs.remaining(), 0);
	f.controller.close();
});

it("a refused configuration returns to the staged fields and cancelling writes nothing", async () => {
	const f = fixture(); await f.controller.attach("a");
	f.responses.set("configure", { outcome: "failed", reason: "model busy" });
	const refused = scriptedDialogs(["reasoning", "low", "apply", "cancel"]);
	assert.equal(await terminalAction(f.controller, refused, "configure", row("a")), undefined);
	assert.equal(f.calls.filter((call) => call.method === "configure").length, 1);
	assert.ok(refused.calls.some((call) => call.kind === "notify" && /model busy/.test(call.title)));
	const cancelled = scriptedDialogs([undefined]);
	assert.equal(await terminalAction(f.controller, cancelled, "configure", row("a")), undefined);
	assert.equal(f.calls.filter((call) => call.method === "configure").length, 1);
	f.controller.close();
});

it("a host that cannot list models names the problem instead of asking for a typed identity", async () => {
	const f = fixture(); await f.controller.attach("a");
	f.responses.set("models", { models: "unreadable" });
	const dialogs = scriptedDialogs(["model", "cancel"]);
	await terminalAction(f.controller, dialogs, "configure", row("a"));
	assert.ok(dialogs.calls.some((call) => call.kind === "notify" && /Model list unavailable/.test(call.title)));
	assert.equal(dialogs.calls.some((call) => call.kind === "input"), false);
	f.controller.close();
});

it("native commands come from the target host's inventory and carry invocation IDs", async () => {
	const f = fixture(); await f.controller.attach("a");
	f.responses.set("status", { inventory: { contributions: [{ name: "fixture", source: "/x/index.ts", commands: [{ name: "fixture-command", description: "Does a thing" }] }], ordinaryOnly: [] } });
	const dialogs = scriptedDialogs(["fixture-command", "args", true]);
	await terminalAction(f.controller, dialogs, "command", row("a"));
	assert.deepEqual(dialogs.calls[0]?.choices?.map((choice) => choice.value), ["fixture-command", "reload"]);
	assert.equal(f.calls.at(-1)?.input.name, "fixture-command");
	assert.equal(f.calls.at(-1)?.input.args, "args");
	assert.equal(f.calls.at(-1)?.input.sessionId, "a");
	assert.match(String(f.calls.at(-1)?.input.invocationId), /^[0-9a-f-]{36}$/);
	f.controller.close();
});

it("dashboard sends display the same native admission facts", async () => {
	const f = fixture(); await f.controller.attach("a");
	f.setAdmission(Promise.resolve({ submissionId: 73, identity: "a", deduped: true }));
	const { screen, afterRender } = screenFixture(f.controller);
	const roster = afterRender(() => screen.render(140).map(stripVTControlCharacters).join("\n").includes("Open \u00b7 Message"));
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

it("recovery dialogs are selectable, restore only the captured target and never send", async () => {
	const f = fixture(); await f.controller.attach("a");
	const gate = deferred(); f.setAdmission(gate.promise.then(() => { throw new Error("unknown"); }));
	f.controller.setDraft("original"); f.controller.setMode("followUp");
	const failed = assert.rejects(f.controller.send()); gate.resolve(); await failed;
	const { screen, overlays, afterRender } = screenFixture(f.controller);
	f.controller.setDraft("/agent recover"); screen.handleInput("\r");
	const first = overlays.at(-1); assert.ok(first);
	assert.equal(first.focused, true);
	assert.match(first.render(100).map(stripVTControlCharacters).join("\n"), /requested followUp · original/);
	const next = afterRender(() => overlays.length === 2);
	first.handleInput?.("\r"); await next;
	await f.controller.attach("b"); f.controller.setDraft("B draft");
	const restored = afterRender(() => f.controller.state.agents.get("a")?.draft === "original");
	const second = overlays.at(-1);
	second?.handleInput?.("\x1b[B"); second?.handleInput?.("\r"); await restored;
	assert.equal(f.controller.draftState?.draft, "B draft");
	assert.equal(f.controller.state.agents.get("a")?.mode, "followUp");
	assert.equal(f.calls.filter((call) => call.method === "submit").length, 1);
	screen.dispose(); f.controller.close();
});

it("fullscreen terminal dispatch gives page keys to the native conversation screen", async () => {
	const f = fixture();
	f.manager.snapshot = async () => ({ ...snapshot(), entries: [{ id: "1", kind: "pi.user", model: [{ role: "user", content: Array.from({ length: 80 }, (_, index) => `Conversation line ${index + 1}`).join("\n"), timestamp: 0 }] }] });
	await f.controller.attach("a");
	let input: (data: string) => void = () => { throw new Error("Terminal input is not attached"); };
	const terminal: Terminal = {
		columns: 80, rows: 24, kittyProtocolActive: false,
		start(onInput) { input = onInput; }, stop() {}, write() {}, moveBy() {},
		hideCursor() {}, showCursor() {}, clearLine() {}, clearFromCursor() {},
		clearScreen() {}, setTitle() {}, setProgress() {}, setProgramStatus() {}, async drainInput() {},
	};
	const previous = getKeybindings();
	const keys = terminalKeys();
	setKeybindings(keys);
	const tui = new TuiAltScreen(terminal);
	const screen = new TerminalScreen(tui, theme, keys, f.controller, () => {});
	const received: string[] = [];
	const handle = screen.handleInput.bind(screen);
	screen.handleInput = (data) => { received.push(data); handle(data); };
	tui.addChild(screen);
	tui.setFocus(screen);
	try {
		tui.start();
		tui.renderNow(true);
		const text = () => stripVTControlCharacters(screen.render(80).join("\n"));
		const tail = text();
		input("\x1b[5~");
		tui.renderNow();
		assert.equal(text() !== tail, true);
		input("\x1b[6~");
		tui.renderNow();
		assert.deepEqual(received, ["\x1b[5~", "\x1b[6~"]);
		assert.equal(text(), tail);
	} finally {
		tui.stop({ preserveScreen: true });
		screen.dispose();
		f.controller.close();
		setKeybindings(previous);
	}
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
	const roster = afterRender(() => screen.render(140).map(stripVTControlCharacters).join("\n").includes("Open \u00b7 Message"));
	screen.openDashboard(); await roster; screen.handleInput("m");
	f.controller.setDraft("dashboard text"); screen.handleInput("\r"); await started.promise;
	f.controller.setMode("followUp");
	const applied = afterRender(() => f.controller.draftState?.receipt?.includes("submission 81") === true);
	dashboardAck.resolve({ submissionId: 81 }); await applied;
	assert.equal(f.controller.draftState?.draft, ""); assert.equal(f.controller.draftState?.mode, "followUp");
	screen.dispose(); f.controller.close();
});

it("long recovery text is readable in full and its action buttons stay on screen", async () => {
	const f = fixture(); await f.controller.attach("a");
	const gate = deferred(); f.setAdmission(gate.promise.then(() => { throw new Error("unknown"); }));
	f.controller.setDraft(Array.from({ length: 300 }, (_, i) => `retained line ${i}`).join("\n"));
	const failed = assert.rejects(f.controller.send()); gate.resolve(); await failed;
	const { screen, overlays, afterRender, terminal } = screenFixture(f.controller);
	f.controller.setDraft("/agent recover"); screen.handleInput("\r");
	let next = afterRender(() => overlays.length === 2);
	overlays.at(-1)?.handleInput?.("\r"); await next;
	next = afterRender(() => overlays.length === 3);
	overlays.at(-1)?.handleInput?.("\r"); await next;
	const reader = overlays.at(-1); assert.ok(reader);
	for (const height of [20, 100]) {
		terminal.rows = height; const lines = reader.render(100); const text = lines.map(stripVTControlCharacters).join("\n");
		assert.ok(lines.length <= Math.floor(height * 0.9));
		assert.match(text, /of 300 lines/); assert.match(text, /\[ Close \]/);
	}
	reader.handleInput?.("\x1b[6~"); reader.handleInput?.("\x1b[6~");
	assert.doesNotMatch(reader.render(100).map(stripVTControlCharacters).join("\n"), /retained line 0\b/);
	reader.handleInput?.("\x1b");
	assert.equal(overlays.length, 3, "the reader returns to the recovery choices");
	screen.dispose(); f.controller.close();
});

it("an attachment loads owner renderers from its host inventory and replaces them when the source changes", async () => {
	const root = mkdtempSync(join(tmpdir(), "agent-terminal-display-"));
	try {
		for (const name of ["one", "two"]) { mkdirSync(join(root, name)); writeFileSync(join(root, name, "index.ts"), ""); writeFileSync(join(root, name, "display.ts"), ""); }
		const call = () => ({ render: () => [], invalidate() {} });
		const inventories: Record<string, unknown> = {
			a: { contributions: [{ name: "one", source: join(root, "one", "index.ts"), commands: [], display: { version: 1, entry: "./display.ts", export: "toolDisplay" } }], ordinaryOnly: [] },
			b: { contributions: [{ name: "two", source: join(root, "two", "index.ts"), commands: [], display: { version: 1, entry: "./display.ts", export: "toolDisplay" } }], ordinaryOnly: [] },
			c: { contributions: [{ name: "gone", source: join(root, "gone", "index.ts"), commands: [], display: { version: 1, entry: "./display.ts", export: "toolDisplay" } }], ordinaryOnly: [] },
		};
		const f = fixture();
		const control = f.manager.control;
		f.manager.control = async (method, input, caller) => method === "status" ? { inventory: inventories[String(input.sessionId)] } : control(method, input, caller);
		const imported: string[] = [];
		const controller = new TerminalController({ manager: f.manager, caller: { id: "terminal", cwd: "/work" }, importModule: async (url) => {
			imported.push(url);
			const name = url.includes("/one/") ? "tool_one" : "tool_two";
			return { toolDisplay: () => ({ version: 1, tools: [{ name, renderCall: call }] }) };
		} });
		await controller.attach("a"); await controller.displaySettled();
		const first = controller.toolDisplay;
		assert.equal(typeof first("tool_one")?.renderCall, "function");
		assert.equal(first("tool_two"), undefined);
		await controller.attach("b");
		assert.equal(controller.toolDisplay("tool_one"), undefined, "the previous source's renderers are gone before the new source answers");
		await controller.displaySettled();
		assert.equal(controller.toolDisplay("tool_one"), undefined);
		assert.equal(typeof controller.toolDisplay("tool_two")?.renderCall, "function");
		assert.notEqual(controller.toolDisplay, first);
		await controller.attach("c"); await controller.displaySettled();
		assert.equal(controller.toolDisplay("tool_two"), undefined);
		assert.match(controller.display.diagnostics.join("\n"), /gone: display module unavailable/);
		assert.equal(imported.length, 2);
		assert.equal(f.calls.some((call) => call.method === "submit" || call.method === "abort"), false);
		await controller.close();
	} finally { rmSync(root, { recursive: true, force: true }); }
});

it("a late display answer from an earlier selection never replaces the current source", async () => {
	const f = fixture();
	const gate = deferred<unknown>();
	const control = f.manager.control;
	f.manager.control = async (method, input, caller) => method === "status" && input.sessionId === "a" ? gate.promise : method === "status" ? { inventory: { contributions: [], ordinaryOnly: [] } } : control(method, input, caller);
	await f.controller.attach("a");
	await f.controller.attach("b"); await f.controller.displaySettled();
	gate.resolve({ inventory: { contributions: [{ name: "late", source: "/nowhere/index.ts", commands: [], display: { version: 1, entry: "./display.ts", export: "toolDisplay" } }], ordinaryOnly: [] } });
	await Promise.resolve();
	assert.deepEqual(f.controller.display.diagnostics, []);
	await f.controller.close();
});

function usageFrame(revision: number, total: number, model = { provider: "test", modelId: "model" }, thinkingLevel = "high") {
	const base = conversationFrame({ revision });
	return { ...base, status: { ...base.status, busy: false, usage: { models: { [`${model.provider}/${model.modelId}`]: { cost: { total } } }, tools: {} } as never, agent: { ...base.status.agent, model, thinkingLevel } } } as typeof base;
}

it("recorded cost follows each new usage observation without reattaching", async () => {
	const f = fixture(); await f.controller.attach("a");
	const { screen } = screenFixture(f.controller);
	f.observers.get("a")?.(usageFrame(2, 0.5), true, "live");
	assert.equal(f.controller.row?.cost, 0.5);
	assert.match(stripVTControlCharacters(screen.render(120).join("\n")), /~\$0\.50/);
	f.observers.get("a")?.(usageFrame(3, 1.25), true, "live");
	assert.equal(f.controller.row?.cost, 1.25);
	assert.equal(f.controller.row?.partial, false);
	assert.match(stripVTControlCharacters(screen.render(120).join("\n")), /~\$1\.25/);
	assert.equal(f.calls.filter((call) => call.method === "attach").length, 1);
	screen.dispose(); f.controller.close();
});

it("an unreadable cost entry makes the total unknown instead of a smaller number", async () => {
	const f = fixture(); await f.controller.attach("a");
	const frame = usageFrame(2, 0.5);
	(frame.status as { usage: unknown }).usage = { models: { "test/model": { cost: { total: 0.5 } }, "other/model": {} }, tools: {} };
	f.observers.get("a")?.(frame, true, "live");
	assert.equal(f.controller.row?.partial, true);
	assert.ok(Number.isNaN(f.controller.row?.cost));
	f.controller.close();
});

it("model and reasoning metadata come from the host's model list and follow a model change", async () => {
	const f = fixture();
	f.responses.set("models", { models: [
		{ provider: "test", modelId: "model", name: "Test model", reasoning: true, contextWindow: 200000 },
		{ provider: "test", modelId: "other", name: "Other model", reasoning: false, contextWindow: 64000 },
	], source: "available-snapshot", observedAt: new Date().toISOString() });
	await f.controller.attach("a"); await f.controller.displaySettled();
	const { screen } = screenFixture(f.controller);
	f.observers.get("a")?.(usageFrame(2, 0.1), true, "live");
	assert.equal(f.controller.currentModelInfo()?.name, "Test model");
	let shown = stripVTControlCharacters(screen.render(120).join("\n"));
	assert.match(shown, /Test model/); assert.match(shown, /\[high\]/);
	f.observers.get("a")?.(usageFrame(3, 0.1, { provider: "test", modelId: "other" }, "off"), true, "live");
	assert.equal(f.controller.currentModelInfo()?.name, "Other model");
	shown = stripVTControlCharacters(screen.render(120).join("\n"));
	assert.match(shown, /Other model/); assert.doesNotMatch(shown, /Test model/);
	f.observers.get("a")?.(usageFrame(4, 0.1, { provider: "test", modelId: "unlisted" }, "off"), true, "live");
	assert.equal(f.controller.currentModelInfo(), undefined, "a model the host did not list stays unknown");
	assert.equal(f.calls.filter((call) => call.method === "models").length, 1, "frames never trigger another model read");
	screen.dispose(); f.controller.close();
});

it("a lost observation keeps the last facts, labels them retained and marks the cost partial", async () => {
	const f = fixture(); await f.controller.attach("a");
	const { screen } = screenFixture(f.controller);
	f.observers.get("a")?.(usageFrame(2, 0.5), true, "live");
	f.observers.get("a")?.(undefined, false, "unavailable");
	const shown = stripVTControlCharacters(screen.render(120).join("\n"));
	assert.match(shown, /Connection unavailable; last observed data shown/);
	assert.equal(f.controller.row?.partial, true);
	assert.match(shown, /~\$0\.50\+/);
	screen.dispose(); f.controller.close();
});

it("program status follows live busy state, switches targets, blocks only on a local dialog and clears on loss and disposal", async () => {
	const f = fixture(); await f.controller.attach("a");
	const output: Array<{ state: string; kind?: string }> = [];
	const { screen, overlays } = screenFixture(f.controller, (status) => output.push(status));
	const states = () => output.map((item) => item.state);
	const busy = (revision: number, value: boolean) => ({ ...conversationFrame({ revision }), status: { ...conversationFrame().status, busy: value } });
	f.observers.get("a")?.(busy(2, true), true, "live");
	assert.equal(output.at(-1)?.state, "working");
	f.observers.get("a")?.(busy(3, false), true, "live");
	assert.equal(output.at(-1)?.state, "idle");
	const awaiting = { ...busy(4, true), status: { ...busy(4, true).status, awaiting: { runId: 1, heldInputs: [], results: [], queuedInputCount: 0, queueSnapshot: "committed InboxDoc", omitted: { heldInputs: 0, results: 0 }, producers: [], omittedProducers: 0, likelyCycle: [], coverage: "one hop; remote graph incomplete" } } };
	f.observers.get("a")?.(awaiting as never, true, "live");
	assert.equal(output.at(-1)?.state, "working", "waiting for another agent is not a human question");
	f.observers.get("a")?.(busy(5, false), true, "live");
	const before = output.length;
	f.observers.get("a")?.(busy(6, false), true, "live");
	assert.equal(output.length, before, "an unchanged state is not published again");
	f.observers.get("a")?.(undefined, false, "unavailable");
	assert.equal(output.at(-1)?.state, "clear", "a lost observation clears activity and does not claim failure");
	assert.equal(states().includes("error"), false);
	f.observers.get("a")?.(busy(7, true), true, "live");
	assert.equal(output.at(-1)?.state, "working");
	await f.controller.attach("b");
	assert.equal(output.at(-1)?.state, "clear", "the old target is cleared, and the new target reports nothing before its first live observation");
	f.observers.get("b")?.(busy(1, false), true, "live");
	assert.equal(output.at(-1)?.state, "idle");
	assert.equal(overlays.length, 0);
	screen.dispose();
	assert.equal(output.at(-1)?.state, "clear");
	f.controller.close();
});

it("an open terminal dialog reports a question and its closing restores the live state", async () => {
	const f = fixture(); await f.controller.attach("a");
	const gate = deferred(); f.setAdmission(gate.promise.then(() => { throw new Error("unknown"); }));
	f.controller.setDraft("original");
	const failed = assert.rejects(f.controller.send()); gate.resolve(); await failed;
	const output: Array<{ state: string; kind?: string; message?: string }> = [];
	const { screen, overlays } = screenFixture(f.controller, (status) => output.push(status));
	f.controller.setDraft("/agent recover"); screen.handleInput("\r");
	assert.ok(overlays.length > 0);
	assert.deepEqual(output.at(-1), { state: "blocked", app: "pi-agent", kind: "question", message: "Answer: Unconfirmed inputs for a" }, "the dialog title names the question");
	overlays.at(-1)?.handleInput?.("\x1b");
	assert.notEqual(output.at(-1)?.state, "blocked");
	assert.doesNotMatch(JSON.stringify(output), /original/);
	screen.dispose(); f.controller.close();
});

function mouseAt(x: number, y: number, width: number, height: number, patch: Partial<import("@earendil-works/pi-tui").TuiMouseEvent> = {}): import("@earendil-works/pi-tui").TuiMouseEvent {
	return { type: "click", button: "left", x, y, screenX: x, screenY: y, width, height, shift: false, alt: false, ctrl: false, clickCount: 1, ...patch };
}
const toolEntries = [
	{ id: "1", kind: "pi.user", model: [{ role: "user", content: "Outside card sentinel", timestamp: 1 }] },
	{ id: "2", kind: "pi.assistant", model: [{ role: "assistant", content: [{ type: "toolCall", id: "clicked-tool", name: "example_tool", arguments: { topic: "named" } }], api: "openai-responses", provider: "test", model: "test", timestamp: 2, stopReason: "toolUse", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } }] },
];
const find = (lines: string[], needle: string) => { const y = lines.findIndex((line) => line.includes(needle)); assert.ok(y >= 0, needle); return { x: lines[y]?.indexOf(needle) ?? 0, y }; };

it("transcript pointer events reach the native tool card and leave outside text to selection", async () => {
	const f = fixture();
	f.manager.snapshot = async () => ({ ...snapshot(), entries: toolEntries as never });
	await f.controller.attach("a");
	const { screen, terminal } = screenFixture(f.controller);
	const draw = () => screen.render(80).map(stripVTControlCharacters);
	const tool = find(draw(), "example_tool");
	for (const patch of [{ type: "press" }, { type: "drag" }, { type: "release" }, { ctrl: true }, { clickCount: 2 }]) assert.equal(screen.handleMouse(mouseAt(tool.x, tool.y, 80, terminal.rows, patch as never)), undefined);
	assert.ok(screen.handleMouse(mouseAt(tool.x, tool.y, 80, terminal.rows))?.handled);
	assert.equal(f.controller.draftState?.view.toolExpanded.get("clicked-tool"), true);
	assert.equal(f.calls.some((call) => call.method === "submit" || call.method === "abort"), false);
	screen.dispose(); f.controller.close();
});

it("visible Dashboard, Back, Latest and Detach controls act on the attached conversation and detach keeps native work", async () => {
	const f = fixture(); await f.controller.attach("a");
	const { screen, done, terminal } = screenFixture(f.controller);
	const draw = () => screen.render(80).map(stripVTControlCharacters);
	const press = (needle: string) => { const p = find(draw(), needle); return screen.handleMouse(mouseAt(p.x, p.y, 80, terminal.rows)); };
	assert.match(draw().at(-1) ?? "", /Dashboard · Back · Latest │ Detach \(Esc\)/);
	press("Back");
	assert.match(draw().join("\n"), /No previous conversation/);
	const state = f.controller.draftState; assert.ok(state);
	state.view.follow = false; state.view.anchor = { id: "1", offset: 3 };
	press("Latest");
	assert.equal(state.view.follow, true); assert.equal(state.view.anchor, undefined);
	state.view.follow = false;
	press("Dashboard");
	assert.ok(screen.render(80).map(stripVTControlCharacters).some((line) => line.includes("Agents")));
	screen.closeDashboard();
	f.controller.setDraft("kept");
	press("Detach");
	assert.equal(done(), 1);
	assert.equal(f.controller.draftState?.draft, "kept");
	assert.equal(f.calls.some((call) => ["abort", "release", "submit"].includes(call.method)), false, "detaching sends no control to the native work");
	screen.dispose(); f.controller.close();
});

it("the earlier-history row loads earlier entries by click and a stale click after resize does nothing", async () => {
	const f = fixture();
	let earlier = 0;
	f.manager.snapshot = async (_id, params) => { if (params && "before" in params) earlier++; return { ...snapshot(), entries: toolEntries as never, nextBefore: 7 }; };
	await f.controller.attach("a");
	const { screen, terminal } = screenFixture(f.controller);
	const lines = screen.render(80).map(stripVTControlCharacters);
	assert.match(lines[0] ?? "", /Earlier history/);
	terminal.rows = 30;
	assert.equal(screen.handleMouse(mouseAt(2, 0, 80, 30)), undefined, "a click reported for a new size cannot use geometry drawn for the old one");
	assert.equal(earlier, 0);
	screen.render(80);
	assert.ok(screen.handleMouse(mouseAt(2, 0, 80, 30))?.handled);
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(earlier, 1);
	screen.dispose(); f.controller.close();
});

it("a roster notice refreshes another peer's name and model on cards while one conversation stays attached", async () => {
	const f = fixture();
	const peer = "11111111-2222-4333-8444-555555555555";
	let peerRow = row(peer, { storageId: peer, name: "Peer first", model: { provider: "acme", modelId: "model-one", thinkingLevel: "low" } });
	let rosterReads = 0;
	const gate = deferred<void>();
	let holdNext = false;
	f.manager.dashboardPage = async () => { rosterReads++; const read = peerRow; if (holdNext) { holdNext = false; await gate.promise; } return page([row("a", { state: "idle" }), row("b"), read]); };
	let notice: () => void = () => {};
	f.manager.subscribeRoster = (listener) => { notice = listener; return () => {}; };
	const call = { id: "send-1", kind: "pi.assistant", model: [{ role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "agent_send", arguments: { sessionId: peer, message: "Review the parser" } }], api: "openai-responses", provider: "test", model: "test", timestamp: 2, stopReason: "toolUse", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } }] };
	f.manager.snapshot = async () => ({ ...snapshot(), entries: [call] as never });
	await f.controller.close();
	const controller = new TerminalController({ manager: { ...f.manager, close: async () => {} }, caller: { id: "terminal", cwd: "/work" } });
	await controller.attach("a");
	const { screen } = screenFixture(controller);
	const text = () => screen.render(120).map(stripVTControlCharacters).join("\n");
	assert.match(text(), /Peer first/);
	assert.match(text(), /acme\/model-one/);
	const reads = rosterReads;
	peerRow = { ...peerRow, name: "Peer renamed", model: { provider: "acme", modelId: "model-two", thinkingLevel: "high" } };
	notice();
	for (let step = 0; step < 20 && !/Peer renamed/.test(text()); step++) await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(controller.target, "a", "the attached conversation is unchanged");
	assert.match(text(), /Peer renamed/, "the peer card repaints with the refreshed name");
	assert.match(text(), /acme\/model-two/);
	assert.doesNotMatch(text(), /Peer first/);
	assert.ok(rosterReads > reads, "the refresh read the roster outside paint");
	holdNext = true;
	peerRow = { ...peerRow, name: "Peer stale" };
	notice();
	await new Promise<void>((resolve) => setImmediate(resolve));
	peerRow = { ...peerRow, name: "Peer current" };
	await controller.attach("b");
	gate.resolve();
	for (let step = 0; step < 10; step++) await new Promise<void>((resolve) => setImmediate(resolve));
	const names = controller.observedRows().map((item) => item.name);
	assert.ok(names.includes("Peer current"), "the new attachment reads its own roster");
	assert.ok(!names.includes("Peer stale"), "an answer read for the earlier attachment is dropped");
	screen.dispose(); await controller.close();
});
