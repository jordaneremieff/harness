import assert from "node:assert/strict";
import { it } from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import type { Component, Focusable, TUI, TuiMouseEvent } from "@earendil-works/pi-tui";
import { TerminalController, TerminalScreen, terminalKeys, type TerminalManager } from "./terminal-client.ts";
import { PanelScreen } from "./terminal-panel.ts";
import type { OperatorPanelHost, OperatorPanelModule } from "./panel-modules.ts";
import { row, page, conversationFrame, deferred, theme } from "./dashboard-test-fixture.mts";

const descriptor = { version: 1, entry: "./panel.ts", export: "operatorPanel", command: "browse" } as const;

/** A fixture browser: Enter sends a request, Escape closes, and every render names the target and the last answer. */
function fixtureModule(): OperatorPanelModule & { hosts: OperatorPanelHost[] } {
	const hosts: OperatorPanelHost[] = [];
	return {
		version: 1, title: "Fixture browser", hosts,
		open(host) {
			hosts.push(host);
			let answer = "no answer";
			let disposed = false;
			return {
				render: (width) => [`fixture for ${host.target.id} rows ${host.rows()} ${answer}`.slice(0, width), "body line 2"],
				handleInput(data) {
					if (data === "\x1b") host.close();
					if (data === "\r") void host.request({ op: "recent" }).then((reply) => { answer = String(reply.data ?? reply.text); host.tui.requestRender(); }, (error) => { answer = `error ${String((error as Error).message)}`; host.tui.requestRender(); });
				},
				handleMouse: (event) => event.type === "click" && event.y === 1 ? { handled: true } : undefined,
				dispose() { disposed = true; },
				get disposed() { return disposed; },
			};
		},
	};
}

function fixture(module: OperatorPanelModule, root: string) {
	const calls: Array<{ method: string; input: Record<string, unknown> }> = [];
	const observers = new Map<string, Parameters<TerminalManager["observeLive"]>[2]>();
	let answer: Promise<unknown> = Promise.resolve({ name: "browse", text: "two entries", data: { entries: 2 } });
	const inventory = { contributions: [{ name: "owner", source: join(root, "owner", "index.ts"), commands: [{ name: "browse", description: "Browse" }], panel: descriptor }], ordinaryOnly: [] };
	const manager: TerminalManager = {
		resolveTarget: async (id) => id,
		control: async (method, input) => {
			calls.push({ method, input });
			if (method === "attach") return { status: { busy: false, cwd: "/work", agent: { thinkingLevel: "off" } } };
			if (method === "status") return { inventory };
			if (method === "command") return answer;
			return undefined;
		},
		dashboardPage: async () => page([row("a", { state: "idle" }), row("b")]),
		snapshot: async () => ({ entries: [], revision: "r", partial: false, nextBefore: null, coverage: conversationFrame().coverage }),
		observeLive: async (id, _scope, listener) => { observers.set(id, listener); return () => {}; },
		subscribeRoster: () => () => {},
		close: async () => {},
	};
	const controller = new TerminalController({ manager, caller: { id: "terminal", cwd: "/work" }, importModule: async () => ({ operatorPanel: () => module }) });
	const terminal = { rows: 24, columns: 80 };
	const overlays: Array<Component & Focusable> = [];
	const tui = { terminal, requestRender() {}, showOverlay(component: Component & Focusable) { overlays.push(component); component.focused = true; return { hide() {} }; } } as unknown as TUI;
	let done = 0;
	const screen = new TerminalScreen(tui, theme, terminalKeys(), controller, () => { done++; });
	return { controller, screen, calls, overlays, terminal, done: () => done, setAnswer: (value: Promise<unknown>) => { answer = value; } };
}

function ownerRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "terminal-panel-"));
	mkdirSync(join(root, "owner"));
	writeFileSync(join(root, "owner", "index.ts"), "");
	writeFileSync(join(root, "owner", "panel.ts"), "export function operatorPanel() {}");
	return root;
}

const click = (x: number, y: number, width = 80, height = 24): TuiMouseEvent => ({ type: "click", button: "left", x, y, width, height, screenX: x, screenY: y, clickCount: 1 } as unknown as TuiMouseEvent);
const plain = (lines: string[]) => lines.map(stripVTControlCharacters);

it("opens an advertised browser over the attached conversation, binds requests to it, and returns on Back", async () => {
	const root = ownerRoot();
	try {
		const module = fixtureModule();
		const f = fixture(module, root);
		await f.controller.attach("a"); await f.controller.displaySettled();
		assert.deepEqual(f.controller.panels.panels.map((panel) => [panel.contribution, panel.title, panel.command]), [["owner", "Fixture browser", "browse"]]);
		assert.ok(plain(f.screen.render(80)).at(-1)?.includes("Browsers"), "the footer offers the browsers");
		f.screen.openPanel("owner");
		const lines = plain(f.screen.render(80));
		assert.equal(lines.length, 24);
		assert.equal(lines[0], "fixture for a rows 23 no answer");
		assert.equal(lines[1], "body line 2");
		assert.ok(lines[23].startsWith("Back"), "the client footer keeps Back and Detach");
		f.screen.handleInput("\r");
		await new Promise((resolve) => setImmediate(resolve));
		const command = f.calls.find((call) => call.method === "command");
		assert.ok(command);
		assert.equal(command.input.sessionId, "a");
		assert.equal(command.input.name, "browse");
		assert.equal(command.input.origin, "operator");
		assert.deepEqual(command.input.data, { op: "recent" });
		assert.equal(typeof command.input.invocationId, "string");
		assert.match(plain(f.screen.render(80))[0], /\[object Object\]|two entries/);
		assert.equal(f.screen.handleMouse(click(3, 1))?.handled, true, "body clicks reach the owner panel");
		f.screen.handleMouse(click(1, 23));
		assert.ok(plain(f.screen.render(80)).some((line) => line.includes("Detach")) && !plain(f.screen.render(80))[0].startsWith("fixture"), "Back returns to the conversation");
		assert.equal(module.hosts.length, 1);
		await assert.rejects(module.hosts[0].request({ op: "late" }), /closed/, "a closed panel refuses new requests");
		assert.equal(f.done(), 0);
		await f.controller.close();
	} finally { rmSync(root, { recursive: true, force: true }); }
});

it("an attachment change closes the browser and a late answer is dropped", async () => {
	const root = ownerRoot();
	try {
		const module = fixtureModule();
		const f = fixture(module, root);
		await f.controller.attach("a"); await f.controller.displaySettled();
		f.screen.openPanel("owner");
		const gate = deferred<unknown>();
		f.setAnswer(gate.promise);
		const pending = module.hosts[0].request({ op: "slow" });
		await f.controller.attach("b");
		assert.ok(!plain(f.screen.render(80))[0].startsWith("fixture"), "the panel bound to a is gone after attaching b");
		gate.resolve({ text: "late", data: 1 });
		await assert.rejects(pending, /closed/);
		await f.controller.displaySettled();
		assert.equal(f.calls.filter((call) => call.method === "command").length, 1);
		await f.controller.close();
	} finally { rmSync(root, { recursive: true, force: true }); }
});

it("an unavailable browser is listed with its reason and never opens", async () => {
	const root = ownerRoot();
	try {
		const f = fixture(fixtureModule(), root);
		await f.controller.attach("a"); await f.controller.displaySettled();
		f.controller.panels = { panels: [{ contribution: "owner", command: "browse", title: "owner", unavailable: "export operatorPanel is not a function" }], diagnostics: ["owner: browser unavailable here"] };
		f.screen.openPanel("owner");
		const lines = plain(f.screen.render(80));
		assert.ok(lines.some((line) => line.includes("browser unavailable here")));
		assert.ok(!lines[0].startsWith("fixture"));
		await f.controller.close();
	} finally { rmSync(root, { recursive: true, force: true }); }
});

it("the panel screen rejects requests from a disposed instance and aborts outstanding ones", async () => {
	const module = fixtureModule();
	const gate = deferred<{ text: string }>();
	const signals: AbortSignal[] = [];
	const screen = new PanelScreen({ module, title: module.title, target: { id: "a" }, tui: { requestRender() {}, terminal: { rows: 10 } }, theme, dialogs: {} as never, request: (_data, signal) => { signals.push(signal); return gate.promise; }, onClose() {}, detach() {} });
	const pending = module.hosts[0].request({ op: "x" });
	screen.dispose();
	assert.equal(signals[0]?.aborted, true);
	gate.resolve({ text: "late" });
	await assert.rejects(pending, /closed/);
	await assert.rejects(module.hosts[0].request({ op: "y" }), /closed/);
	assert.deepEqual(screen.render(20).length, 10);
});
