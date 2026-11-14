import assert from "node:assert/strict";
import { it } from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { TuiAltScreen, getKeybindings, setKeybindings, type ProgramStatus, type Terminal, type TUI, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { AgentComposer } from "./agent-composer.ts";
import { TerminalController, TerminalScreen, terminalAdmission, terminalForms, terminalKeys, terminalTargetFile, parseTerminalArgs, suppressProcessWarnings, type TerminalCreation, type TerminalManager } from "./terminal-client.ts";
import { agentState, updateDraft } from "./dashboard-state.ts";
import { row, page, conversationFrame, deferred, theme } from "./dashboard-test-fixture.mts";

function snapshot(revision = "initial"): Awaited<ReturnType<TerminalManager["snapshot"]>> {
	return { entries: [], revision, partial: false, nextBefore: null, coverage: conversationFrame().coverage };
}

/**
 * Wait on asynchronous work, including the work view's bounded presentation interval, with a
 * deadline so a broken path fails instead of hanging.
 */
async function settle(condition: () => boolean, what = "the condition"): Promise<void> {
	const deadline = Date.now() + 2_000;
	while (!condition() && Date.now() < deadline) await new Promise<void>((resolve) => setTimeout(resolve, 1));
	assert.ok(condition(), `${what} never held`);
}

function fixture() {
	const calls: Array<{ method: string; input: Record<string, unknown>; launch?: boolean }> = [];
	const observers = new Map<string, Parameters<TerminalManager["observeLive"]>[2]>();
	let closes = 0;
	let releases = 0;
	let admission: () => Promise<unknown> = async () => ({ submissionId: 17, deduped: false });
	const responses = new Map<string, unknown>();
	const manager: TerminalManager = {
		resolveTarget: async (id) => (id === "@one" ? "a" : id),
		control: async (method, input, _caller, options) => {
			calls.push({ method, input, ...(options?.launch === undefined ? {} : { launch: options.launch }) });
			if (responses.has(method)) return responses.get(method);
			if (method === "submit") return admission();
			return {};
		},
		dashboardPage: async () => page([row("a", { state: "idle" }), row("b")]),
		snapshot: async () => snapshot(),
		observeLive: async (id, _scope, listener) => {
			observers.set(id, listener);
			return () => {
				releases++;
			};
		},
		subscribeRoster: () => () => {},
		close: async () => {
			closes++;
		},
	};
	const controller = new TerminalController({ manager, caller: { id: "terminal", cwd: "/work" } });
	return {
		controller,
		manager,
		calls,
		observers,
		responses,
		setAdmission: (value: () => Promise<unknown>) => {
			admission = value;
		},
		closes: () => closes,
		releases: () => releases,
	};
}

/** The attached terminal's screen on a fake terminal, with the program status it publishes. */
function screenFixture(controller: TerminalController, width = 100, height = 30) {
	const terminal = { rows: height, columns: width };
	const tui = { terminal, requestRender() {} } as unknown as TUI;
	const statuses: ProgramStatus[] = [];
	const titles: string[] = [];
	let done = 0;
	const screen = new TerminalScreen(tui, theme, terminalKeys(), controller, () => done++, (status) => statuses.push(status), (title) => titles.push(title));
	const lines = () => screen.render(terminal.columns).map((line) => stripVTControlCharacters(line.replace(/\x1b_[^\x07]*\x07/g, "")));
	const text = () => lines().join("\n");
	const click = (label: string) => {
		const shown = lines();
		for (let y = shown.length - 1; y >= 0; y--) {
			const x = shown[y]?.indexOf(label) ?? -1;
			if (x < 0) continue;
			const event: TuiMouseEvent = { type: "click", button: "left", x: x + 1, y, screenX: x + 1, screenY: y, width: terminal.columns, height: terminal.rows, shift: false, alt: false, ctrl: false, clickCount: 1 };
			return screen.handleMouse(event);
		}
		assert.fail(`no visible ${label}\n${shown.join("\n")}`);
	};
	const type = (value: string) => {
		for (const character of value) screen.handleInput(character);
	};
	return { screen, terminal, statuses, titles, done: () => done, lines, text, click, type };
}

it("terminal teardown awaits its manager and reuses the same close operation", async () => {
	const f = fixture();
	const gate = deferred();
	let closes = 0;
	f.manager.close = async () => {
		closes++;
		await gate.promise;
	};
	let settled = false;
	const first = f.controller.close().then(() => {
		settled = true;
	});
	const second = f.controller.close();
	assert.equal(settled, false);
	assert.equal(closes, 1);
	gate.resolve();
	await Promise.all([first, second]);
	assert.equal(settled, true);
});

it("admission is operator input whose answer stays in the target, with a receipt that states its facts", async () => {
	const f = fixture();
	f.setAdmission(async () => ({ submissionId: 31, conversationId: 1, identity: "a", deduped: false }));
	const first = await f.controller.admit("a", "literal /help", "steer");
	assert.equal(first.text, "Input admitted for a (submission 31; requested steer)");
	assert.deepEqual(f.calls.at(-1), { method: "submit", input: { sessionId: "a", message: "literal /help", whenBusy: "steer", origin: "operator", replyTo: "a" } });
	f.setAdmission(async () => ({ submissionId: 32, identity: "a", deduped: true }));
	assert.equal((await f.controller.admit("a", "next", "followUp")).text, "Input already admitted for a (submission 32; requested follow-up)");
	assert.equal(terminalAdmission({ submissionId: 9, identity: "a:7" }, "a:7", "steer"), "Input admitted for a:7 (submission 9; requested steer)");
	assert.throws(() => terminalAdmission({ submissionId: 9, identity: "b" }, "a", "steer"), /disagrees/);
	await f.controller.close();
});

it("unconfirmed input is kept per target, restores only over an unchanged draft and never sends", async () => {
	const f = fixture();
	f.setAdmission(async () => {
		throw new Error("unknown admission");
	});
	await assert.rejects(f.controller.admit("a", "original", "followUp"), /unknown admission/);
	await assert.rejects(f.controller.admit("a", "again", "steer"), /unknown admission/);
	assert.deepEqual(f.controller.unconfirmed("a"), [{ text: "original", mode: "followUp" }, { text: "again", mode: "steer" }]);
	assert.deepEqual(f.controller.unconfirmed("b"), []);
	assert.match(f.controller.failureReceipt("a", new Error("lost")), /Delivery not confirmed for a\. Your draft is kept.*More › Recover input/u);
	const state = agentState(f.controller.state, "a");
	updateDraft(state, "newer");
	const original = f.controller.unconfirmed("a")[0];
	assert.ok(original);
	const revision = state.draftRevision;
	updateDraft(state, "latest");
	assert.throws(() => f.controller.restoreUnconfirmed("a", original, revision, state.mode), /draft changed/);
	assert.equal(state.draft, "latest");
	f.controller.restoreUnconfirmed("a", original, state.draftRevision, state.mode);
	assert.equal(state.draft, "original");
	assert.equal(state.mode, "followUp");
	f.controller.discardUnconfirmed("a", original);
	assert.equal(f.controller.unconfirmed("a").length, 1);
	assert.equal(f.calls.filter((call) => call.method === "submit").length, 2, "recovery sends nothing");
	await f.controller.close();
});

it("a selection loads owner renderers from its host inventory and replaces them when the source changes", async () => {
	const root = mkdtempSync(join(tmpdir(), "agent-terminal-display-"));
	try {
		for (const name of ["one", "two"]) {
			mkdirSync(join(root, name));
			writeFileSync(join(root, name, "index.ts"), "");
			writeFileSync(join(root, name, "display.ts"), "");
		}
		const call = () => ({ render: () => [], invalidate() {} });
		const display = { version: 1, entry: "./display.ts", export: "toolDisplay" };
		const inventories: Record<string, unknown> = {
			a: { contributions: [{ name: "one", source: join(root, "one", "index.ts"), commands: [], display }], ordinaryOnly: [] },
			b: { contributions: [{ name: "two", source: join(root, "two", "index.ts"), commands: [], display }], ordinaryOnly: [] },
			c: { contributions: [{ name: "gone", source: join(root, "gone", "index.ts"), commands: [], display }], ordinaryOnly: [] },
		};
		const f = fixture();
		const control = f.manager.control;
		f.manager.control = async (method, input, caller) => (method === "status" ? { inventory: inventories[String(input.sessionId)] } : control(method, input, caller));
		const imported: string[] = [];
		const controller = new TerminalController({
			manager: f.manager,
			caller: { id: "terminal", cwd: "/work" },
			importModule: async (url) => {
				imported.push(url);
				const name = url.includes("/one/") ? "tool_one" : "tool_two";
				return { toolDisplay: () => ({ version: 1, tools: [{ name, renderCall: call }] }) };
			},
		});
		controller.select("a");
		await controller.displaySettled();
		const first = controller.toolDisplay;
		assert.equal(typeof first("tool_one")?.renderCall, "function");
		assert.equal(first("tool_two"), undefined);
		controller.select("b");
		assert.equal(controller.toolDisplay("tool_one"), undefined, "the previous source's renderers are gone before the new source answers");
		await controller.displaySettled();
		assert.equal(typeof controller.toolDisplay("tool_two")?.renderCall, "function");
		assert.notEqual(controller.toolDisplay, first);
		controller.select("c");
		await controller.displaySettled();
		assert.equal(controller.toolDisplay("tool_two"), undefined);
		assert.match(controller.display.diagnostics.join("\n"), /gone: display module unavailable/);
		assert.equal(imported.length, 2);
		assert.equal(f.calls.some((item) => item.method === "submit" || item.method === "abort" || item.method === "attach"), false, "selection starts nothing");
		await controller.close();
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

it("a late display answer from an earlier selection never replaces the current source", async () => {
	const f = fixture();
	const gate = deferred<unknown>();
	const control = f.manager.control;
	f.manager.control = async (method, input, caller) =>
		method === "status" && input.sessionId === "a" ? gate.promise : method === "status" ? { inventory: { contributions: [], ordinaryOnly: [] } } : control(method, input, caller);
	f.controller.select("a");
	f.controller.select("b");
	await f.controller.displaySettled();
	gate.resolve({ inventory: { contributions: [{ name: "late", source: "/nowhere/index.ts", commands: [], display: { version: 1, entry: "./display.ts", export: "toolDisplay" } }], ordinaryOnly: [] } });
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.deepEqual(f.controller.display.diagnostics, []);
	await f.controller.close();
});

it("a late owner-card inventory keeps the transcript and its reading position", async () => {
	const root = mkdtempSync(join(tmpdir(), "agent-terminal-lookup-"));
	try {
		mkdirSync(join(root, "one"));
		writeFileSync(join(root, "one", "index.ts"), "");
		writeFileSync(join(root, "one", "display.ts"), "");
		const inventory = {
			contributions: [{ name: "one", source: join(root, "one", "index.ts"), commands: [], display: { version: 1, entry: "./display.ts", export: "toolDisplay" } }],
			ordinaryOnly: [],
		};
		const gate = deferred<unknown>();
		const f = fixture();
		const control = f.manager.control;
		let statusReads = 0;
		// Only the selected host's inventory read is late; lineage and model reads answer normally.
		f.manager.control = async (method, input, caller) =>
			method === "status" && ++statusReads === 1 ? gate.promise : control(method, input, caller);
		f.manager.snapshot = async () => ({
			...snapshot(),
			entries: [{ id: "1", kind: "pi.user", model: [{ role: "user", content: Array.from({ length: 80 }, (_, index) => `Conversation line ${index + 1}`).join("\n"), timestamp: 0 }] }],
		});
		const controller = new TerminalController({
			manager: f.manager,
			caller: { id: "terminal", cwd: "/work" },
			importModule: async () => ({ toolDisplay: () => ({ version: 1, tools: [{ name: "owner_tool", renderCall: () => ({ render: () => [], invalidate() {} }) }] }) }),
		});
		const s = screenFixture(controller, 80, 24);
		try {
			await settle(() => /Conversation line 80/u.test(s.text()), "the conversation tail");
			s.screen.handleInput("\x1b[5~");
			const visible = () => s.lines().filter((line) => /Conversation line \d+/u.test(line));
			const before = visible();
			assert.ok(before.length > 5, "paging shows earlier lines");
			assert.doesNotMatch(before.join("\n"), /Conversation line 80/u, "paging left the tail");
			const reading = agentState(controller.state, "a").view;
			const position = { scroll: reading.scroll, anchor: reading.anchor ? { ...reading.anchor } : undefined, follow: reading.follow };
			gate.resolve({ inventory });
			await settle(() => controller.display.lookup("owner_tool") !== undefined, "the owner lookup");
			await new Promise<void>((resolve) => setImmediate(resolve));
			assert.deepEqual(visible(), before, "the transcript text and reading position survive the lookup change");
			assert.deepEqual({ scroll: reading.scroll, anchor: reading.anchor ? { ...reading.anchor } : undefined, follow: reading.follow }, position);
			s.screen.handleInput("\x1b[6~");
			assert.match(visible().join("\n"), /Conversation line 80/u, "paging still reaches the tail after the rebuild");
		} finally {
			s.screen.dispose();
			await controller.close();
		}
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

it("model metadata comes from the selected host's model list, read once per selection", async () => {
	const f = fixture();
	f.responses.set("models", {
		models: [
			{ provider: "test", modelId: "model", name: "Test model", reasoning: true, contextWindow: 200000 },
			{ provider: "test", modelId: "other", name: "Other model", reasoning: false, contextWindow: 64000 },
		],
		source: "available-snapshot",
		observedAt: new Date().toISOString(),
	});
	f.controller.select("a");
	await f.controller.displaySettled();
	assert.deepEqual(f.controller.modelInfo("test", "model"), { name: "Test model", reasoning: true, contextWindow: 200000 });
	assert.equal(f.controller.modelInfo("test", "other")?.name, "Other model");
	assert.equal(f.controller.modelInfo("test", "unlisted"), undefined, "a model the host did not list stays unknown");
	assert.deepEqual(f.calls.filter((call) => call.method === "models").map((call) => call.launch), [false], "selection reads the model list without starting a host");
	f.controller.select("b");
	assert.equal(f.controller.modelInfo("test", "model"), undefined, "the previous host's list is gone at once");
	await f.controller.close();
});

it("Connect starts the host and rereads the selected owner modules", async () => {
	const f = fixture();
	f.controller.select("a");
	await f.controller.displaySettled();
	const revision = f.controller.revision;
	await f.controller.connect("a");
	assert.equal(f.calls.filter((call) => call.method === "attach").length, 1);
	assert.ok(f.controller.revision > revision, "a reconnect is a new selection");
	await f.controller.displaySettled();
	assert.equal(f.calls.filter((call) => call.method === "status").length, 2);
	await f.controller.close();
});

it("owner view requests bind their captured target and honour withdrawal", async () => {
	const f = fixture();
	f.responses.set("command", { text: "listed", data: { items: 1 } });
	const aborted = new AbortController();
	aborted.abort();
	await assert.rejects(f.controller.panelRequest("a", "stash-list", {}, aborted.signal), /withdrawn before it was sent/);
	assert.equal(f.calls.length, 0);
	assert.deepEqual(await f.controller.panelRequest("a", "stash-list", { page: 1 }), { text: "listed", data: { items: 1 } });
	const sent = f.calls.at(-1);
	assert.equal(sent?.input.sessionId, "a");
	assert.equal(sent?.input.origin, "operator");
	assert.match(String(sent?.input.invocationId), /^[0-9a-f-]{36}$/u);
	f.responses.set("command", { data: {} });
	await assert.rejects(f.controller.panelRequest("a", "stash-list", {}), /without command text/);
	await f.controller.close();
});

function creation(): TerminalCreation & { validated: string[] } {
	const validated: string[] = [];
	return {
		validated,
		agentDir: "/agent",
		catalog: { getModel: () => undefined },
		validateModel: (model, level) => {
			validated.push(`${model.provider}/${model.modelId}:${level}`);
			return level;
		},
		trustUndecided: () => false,
	};
}

it("New conversation creates an independent conversation whose first message it owns", async () => {
	const f = fixture();
	const spawned: Array<{ input: Record<string, unknown>; caller: Record<string, unknown> }> = [];
	f.manager.spawn = async (input, caller, onCreated) => {
		spawned.push({ input: input as Record<string, unknown>, caller: caller as unknown as Record<string, unknown> });
		onCreated?.(row("new:1", { state: "starting" }));
		return { sessionId: "new:1", cwd: "/work/project" };
	};
	const services = creation();
	const controller = new TerminalController({ manager: f.manager, caller: { id: "terminal", cwd: "/work" }, creation: services });
	const created: string[] = [];
	const result = await controller.create({ prompt: "Plan the parser", preset: "worker", cwd: "/work/project", requestId: "request-1", onCreated: (item) => created.push(item.id) });
	assert.deepEqual(created, ["new:1"]);
	assert.deepEqual(spawned[0]?.input, { preset: "worker", cwd: "/work/project", origin: "operator", requestId: "request-1" });
	assert.equal(typeof spawned[0]?.caller.validateModel, "function");
	assert.equal(spawned[0]?.caller.preferenceCatalog, services.catalog);
	assert.deepEqual(f.calls.at(-1), { method: "submit", input: { sessionId: "new:1", message: "Plan the parser", whenBusy: "followUp", origin: "operator", replyTo: "new:1" } });
	assert.equal(result.sessionId, "new:1");
	assert.match(result.text, /^Started a conversation in project\. Input admitted for new \(submission 17; requested follow-up\)/u);
	const idle = await controller.create({ requestId: "request-2", onCreated: () => {} });
	assert.equal(idle.text, "Created an idle conversation in project");
	assert.equal(f.calls.filter((call) => call.method === "submit").length, 1, "an empty purpose sends nothing");
	f.setAdmission(async () => {
		throw new Error("host stopped");
	});
	const kept = await controller.create({ prompt: "Retry me", requestId: "request-3", onCreated: () => {} });
	assert.equal(kept.sessionId, "new:1");
	assert.match(kept.text, /first message was not confirmed/u);
	assert.equal(agentState(controller.state, "new:1").draft, "Retry me", "the purpose stays as the new conversation's draft");
	assert.match(agentState(controller.state, "new:1").receipt ?? "", /Delivery not confirmed/u);
	await assert.rejects(f.controller.create({ requestId: "request-4", onCreated: () => {} }), /Creation needs the configured model catalogue/);
	await controller.close();
});

it("restart reads the last target without persisting native conversation state", () => {
	const root = mkdtempSync(join(tmpdir(), "agent-terminal-target-"));
	try {
		const first = terminalTargetFile(root);
		assert.equal(first.read(), undefined);
		first.write("a:7");
		assert.equal(terminalTargetFile(root).read(), "a:7");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
	assert.deepEqual(parseTerminalArgs(["--theme", "light", "--session", "@one"]), { selectedTheme: "light", session: "@one" });
	assert.throws(() => parseTerminalArgs(["--theme", "system"]), /automatic\/system/);
	assert.throws(() => parseTerminalArgs(["--session"]), /incomplete/);
});

it("public native editor keeps configured history, nonempty Ctrl+D deletion and multiline text", () => {
	const keys = terminalKeys();
	keys.setUserBindings({ "tui.editor.historyPrevious": "ctrl+p", "tui.editor.historyNext": "ctrl+n" });
	const composer = new AgentComposer({ tui: { terminal: { rows: 24, columns: 80 }, requestRender() {} } as unknown as TUI, theme, keys, onSubmit() {}, onEscape() {} });
	composer.addToHistory("prior");
	composer.handleInput("\x10");
	assert.equal(composer.getText(), "prior");
	composer.setText("abc");
	composer.handleInput("\x01");
	composer.handleInput("\x04");
	assert.equal(composer.getText(), "bc");
	composer.setText("first");
	composer.handleInput("\x0a");
	composer.handleInput("second");
	assert.equal(composer.getText(), "first\nsecond");
});

it("configured interrupt keeps its native route without introducing Alt or F application bindings", () => {
	const keys = terminalKeys();
	keys.setUserBindings({ "app.interrupt": "ctrl+x" });
	let escaped = 0;
	const composer = new AgentComposer({ tui: { terminal: { rows: 24, columns: 80 }, requestRender() {} } as unknown as TUI, theme, keys, onSubmit() {}, onEscape() { escaped++; } });
	composer.setText("kept");
	composer.handleInput("\x18");
	assert.equal(escaped, 1);
	assert.equal(composer.getText(), "kept");
	keys.setUserBindings({ "app.interrupt": "alt+x" });
	composer.handleInput("\x1bx");
	assert.equal(escaped, 1);
	keys.setUserBindings({ "app.interrupt": "f1" });
	composer.handleInput("\x1bOP");
	assert.equal(escaped, 1);
	composer.handleInput("\x1b");
	assert.equal(escaped, 2);
});

it("the terminal opens the work view, Escape never detaches, and the footer detaches", async () => {
	const f = fixture();
	const s = screenFixture(f.controller);
	try {
		await settle(() => f.controller.selected === "a", "the first agent's selection");
		const heading = s.lines()[0] ?? "";
		assert.doesNotMatch(heading, /Detach/u, "the header holds no commands");
		assert.match((s.lines().at(-1) ?? "").trimEnd(), /ctrl\+d detach$/u, "the way out is the last footer control");
		s.screen.handleInput("\x1b");
		assert.equal(s.done(), 0, "Escape never detaches");
		const footer = s.lines().at(-1) ?? "";
		const x = footer.lastIndexOf("detach") + 1;
		s.screen.handleMouse({ type: "click", button: "left", x, y: s.terminal.rows - 1, screenX: x, screenY: s.terminal.rows - 1, width: s.terminal.columns, height: s.terminal.rows, shift: false, alt: false, ctrl: false, clickCount: 1 } as TuiMouseEvent);
		assert.equal(s.done(), 1);
		assert.equal(f.calls.some((call) => ["abort", "release", "submit", "attach"].includes(call.method)), false, "detaching sends no control to the native work");
	} finally {
		s.screen.dispose();
		await f.controller.close();
	}
});

it("Ctrl+D detaches from the list and deletes forward in a draft", async () => {
	const listed = fixture();
	const overList = screenFixture(listed.controller);
	try {
		await settle(() => listed.controller.selected === "a", "the first agent's selection");
		overList.screen.handleInput("\x04");
		assert.equal(overList.done(), 1, "the list's detach key closes the terminal");
	} finally {
		overList.screen.dispose();
		await listed.controller.close();
	}
	const f = fixture();
	const s = screenFixture(f.controller);
	try {
		await settle(() => f.controller.selected === "a", "the first agent's selection");
		s.screen.handleInput("\r");
		s.type("ab");
		s.screen.handleInput("\x01");
		s.screen.handleInput("\x04");
		assert.equal(agentState(f.controller.state, "a").draft, "b");
		assert.equal(s.done(), 0);
		s.screen.handleInput("\x04");
		s.screen.handleInput("\x04");
		assert.equal(s.done(), 1);
		assert.equal(f.calls.some((call) => ["abort", "release", "submit"].includes(call.method)), false, "closing sends no control to the native work");
	} finally {
		s.screen.dispose();
		await f.controller.close();
	}
});

it("only the terminal's own commands intercept composer text; other slash text is a literal message", async () => {
	const f = fixture();
	const s = screenFixture(f.controller);
	try {
		await settle(() => f.controller.selected === "a", "the first agent's selection");
		s.screen.handleInput("\r");
		s.type("/help");
		s.screen.handleInput("\r");
		await settle(() => f.calls.some((call) => call.method === "submit"), "the literal message");
		assert.equal(f.calls.find((call) => call.method === "submit")?.input.message, "/help");
		s.type("/agent enter @one");
		s.screen.handleInput("\r");
		await settle(() => agentState(f.controller.state, "a").draft === "", "the handled command");
		assert.equal(s.screen.view.selectedRow?.id, "a");
		s.type("/agent new");
		s.screen.handleInput("\r");
		await settle(() => /Creation needs the configured model catalogue/u.test(s.text()), "the reason New cannot start here");
		assert.equal(s.screen.view.focus.inspector, undefined, "no creation form opens without the model catalogue");
		s.type("/quit");
		s.screen.handleInput("\r");
		await settle(() => s.done() === 1, "/quit");
		assert.equal(f.calls.filter((call) => call.method === "submit").length, 1, "only the literal message was sent");
	} finally {
		s.screen.dispose();
		await f.controller.close();
	}
});

it("Recover input restores an unconfirmed message to the captured target's draft and never sends", async () => {
	const f = fixture();
	f.setAdmission(async () => {
		throw new Error("connection lost");
	});
	const s = screenFixture(f.controller);
	try {
		await settle(() => f.controller.selected === "a", "the first agent's selection");
		s.screen.handleInput("\r");
		s.type("original");
		s.screen.handleInput("\r");
		await settle(() => f.controller.unconfirmed("a").length === 1, "the unconfirmed input");
		const state = agentState(f.controller.state, "a");
		assert.equal(state.draft, "original", "a failed admission keeps the draft");
		assert.match(state.receipt ?? "", /Delivery not confirmed for a/u);
		updateDraft(state, "");
		s.screen.handleInput("\x1b");
		assert.equal(s.screen.view.focus.region, "list");
		if ((s.lines().at(-1) ?? "").includes("recover input")) s.click("recover input (1)");
		else {
			s.click("x more");
			s.click("Recover input (1)");
		}
		await settle(() => s.screen.view.focus.inspector === "Recover input", "the recovery form");
		assert.match(s.text(), /requested followUp · original/u);
		s.click("restore to the draft");
		await settle(() => state.draft === "original", "the restored draft");
		assert.equal(f.calls.filter((call) => call.method === "submit").length, 1, "recovery sends nothing");
	} finally {
		s.screen.dispose();
		await f.controller.close();
	}
});

it("New conversation in the terminal reuses one request identity until creation succeeds", async () => {
	const f = fixture();
	const requests: unknown[] = [];
	let fail = true;
	f.manager.spawn = async (input) => {
		requests.push((input as { requestId?: unknown }).requestId);
		if (fail) throw new Error("quota wall");
		return { sessionId: "new:1", cwd: "/work" };
	};
	const controller = new TerminalController({ manager: f.manager, caller: { id: "terminal", cwd: process.cwd() }, creation: creation() });
	const s = screenFixture(controller);
	try {
		await settle(() => controller.selected === "a", "the first agent's selection");
		s.screen.view.openNamedAction("new");
		s.type("Write the plan");
		const submit = () => {
			for (let step = 0; step < 4 && !/enter start/u.test(s.lines().at(-1) ?? ""); step++) s.screen.handleInput("\r");
			s.screen.handleInput("\r");
		};
		submit();
		await settle(() => /quota wall/u.test(s.text()), "the refusal");
		assert.equal(s.screen.view.focus.inspector, "New conversation", "a refused start keeps the form and its purpose");
		fail = false;
		submit();
		await settle(() => s.screen.view.focus.inspector === undefined, "the started conversation");
		assert.equal(requests.length, 2);
		assert.equal(requests[0], requests[1], "a retry carries the same request identity");
		assert.equal(f.calls.find((call) => call.method === "submit")?.input.replyTo, "new:1");
	} finally {
		s.screen.dispose();
		await controller.close();
	}
});

it("program status and title follow the selected conversation's live state and clear on loss and disposal", async () => {
	const f = fixture();
	const s = screenFixture(f.controller);
	try {
		await settle(() => f.observers.has("a"), "the first agent's observation");
		const busy = (revision: number, value: boolean) => ({ ...conversationFrame({ revision }), status: { ...conversationFrame().status, busy: value, name: "Parser work" } });
		f.observers.get("a")?.(busy(2, true), true, "live");
		await settle(() => s.statuses.at(-1)?.state === "working", "working status");
		assert.equal(s.titles.at(-1), "Parser work · work");
		f.observers.get("a")?.(busy(3, false), true, "live");
		await settle(() => s.statuses.at(-1)?.state === "idle", "idle status");
		const count = s.statuses.length;
		f.observers.get("a")?.(busy(4, false), true, "live");
		// Longer than the work view's presentation interval, so a repeated publication would have landed.
		await new Promise<void>((resolve) => setTimeout(resolve, 150));
		assert.equal(s.statuses.length, count, "an unchanged state is not published again");
		f.observers.get("a")?.(undefined, false, "unavailable");
		await settle(() => s.statuses.at(-1)?.state === "clear", "a cleared status");
		assert.equal(s.statuses.some((status) => status.state === "error"), false, "a lost observation never claims failure");
		s.screen.handleInput("\x1b[B");
		await settle(() => f.controller.selected === "b", "the next selection");
		assert.equal(s.statuses.at(-1)?.state, "clear", "a new target reports nothing before its first live observation");
		s.screen.dispose();
		assert.equal(s.statuses.at(-1)?.state, "clear");
		assert.equal(s.titles.at(-1), "");
	} finally {
		s.screen.dispose();
		await f.controller.close();
	}
});

it("fullscreen terminal dispatch gives page keys to the conversation", async () => {
	const f = fixture();
	f.manager.snapshot = async () => ({ ...snapshot(), entries: [{ id: "1", kind: "pi.user", model: [{ role: "user", content: Array.from({ length: 80 }, (_, index) => `Conversation line ${index + 1}`).join("\n"), timestamp: 0 }] }] });
	let input: (data: string) => void = () => {
		throw new Error("Terminal input is not attached");
	};
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
	screen.handleInput = (data) => {
		received.push(data);
		handle(data);
	};
	tui.addChild(screen);
	tui.setFocus(screen);
	try {
		tui.start();
		const text = () => stripVTControlCharacters(screen.render(80).join("\n"));
		await settle(() => /Conversation line 80/u.test(text()), "the conversation tail");
		tui.renderNow(true);
		const tail = text();
		input("\x1b[5~");
		tui.renderNow();
		assert.notEqual(text(), tail, "PageUp reads earlier lines");
		input("\x1b[6~");
		tui.renderNow();
		assert.deepEqual(received, ["\x1b[5~", "\x1b[6~"]);
		assert.equal(text(), tail);
	} finally {
		tui.stop({ preserveScreen: true });
		screen.dispose();
		await f.controller.close();
		setKeybindings(previous);
	}
});

it("terminal forms act on the captured target through native requests", async () => {
	const f = fixture();
	f.controller.select("b");
	const forms = terminalForms(f.controller, new Map(), row("a"));
	f.responses.set("configure", { outcome: "applied" });
	const configured = await forms.configure({ model: "test/model", thinkingLevel: "high" });
	assert.deepEqual(f.calls.at(-1), { method: "configure", input: { sessionId: "a", thinkingLevel: "high", model: { provider: "test", modelId: "model" } } });
	assert.deepEqual(configured, { text: "Updated configuration for “a”", sessionId: "a" });
	f.responses.set("configure", { outcome: "failed", reason: "model busy" });
	await assert.rejects(forms.configure({ thinkingLevel: "low" }), /Configuration failed for “a”: model busy/);
	f.responses.set("models", { models: "unreadable" });
	await assert.rejects(forms.models(), /Model list unavailable: the host answered with an unreadable list/);
	f.responses.set("models", { models: [{ provider: "other", modelId: "small", reasoning: false }, { provider: "test", modelId: "model", name: "Test model", reasoning: true }], source: "available-snapshot", observedAt: new Date().toISOString() });
	assert.deepEqual(await forms.models(), [{ identity: "other/small" }, { identity: "test/model", name: "Test model" }]);
	f.responses.set("status", { inventory: { contributions: [{ name: "fixture", source: "/x/index.ts", commands: [{ name: "fixture-command", description: "Does a thing" }] }], ordinaryOnly: [] } });
	assert.deepEqual((await forms.commands())?.map((choice) => choice.value), ["fixture-command", "reload"]);
	f.responses.set("command", { text: "done" });
	await forms.run("command", ["fixture-command", "args"]);
	const command = f.calls.at(-1);
	assert.deepEqual({ method: command?.method, sessionId: command?.input.sessionId, name: command?.input.name, args: command?.input.args, origin: command?.input.origin }, { method: "command", sessionId: "a", name: "fixture-command", args: "args", origin: "operator" });
	assert.match(String(command?.input.invocationId), /^[0-9a-f-]{36}$/u);
	for (const name of ["abort", "release"]) {
		await forms.run(name, []);
		assert.deepEqual(f.calls.at(-1), { method: name, input: { sessionId: "a" } });
	}
	assert.equal(f.controller.selected, "b", "forms never move the selection");
	await f.controller.close();
});

it("drops Node process warnings while the terminal owns the screen and restores them afterwards", async () => {
	const original = process.emitWarning;
	const seen: string[] = [];
	const listener = (warning: Error) => { seen.push(warning.message); };
	process.on("warning", listener);
	try {
		const restore = suppressProcessWarnings();
		process.emitWarning("painted over the work view", "ExperimentalWarning");
		restore();
		assert.equal(process.emitWarning, original);
		process.emitWarning("reported after the terminal closed", { code: "TERMINAL_TEST_WARNING" });
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.deepEqual(seen, ["reported after the terminal closed"]);
	} finally {
		process.off("warning", listener);
		process.emitWarning = original;
	}
});
