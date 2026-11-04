/** The footer menu, its session controls, and the composed overlay at small and shrinking viewports. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { ExtensionRunner, type ExtensionAPI, type SlashCommandInfo, type Theme } from "@earendil-works/pi-coding-agent";
import { TuiAltScreen, type TUI, type Terminal } from "@earendil-works/pi-tui";
import { CommandsPanel, createSelectorState, type CommandsPanelResult } from "./commands.ts";
import { ChoicePanel } from "./controls.ts";
import { collectDestinations, readDestinations, resolveDestinations } from "./destinations.ts";
import registerStatusline from "./index.ts";
import { StatusPanel } from "./statuses.ts";

const theme = { fg: (_c: string, text: string) => text, bold: (text: string) => text } as unknown as Theme;
const strip = (line: string) => stripVTControlCharacters(line);

function registration(name: string, over: Partial<SlashCommandInfo> = {}): SlashCommandInfo {
	return { name, description: `${name} description`, source: "extension", sourceInfo: { path: `/ext/${name}/index.ts`, source: "../../harness", scope: "user", origin: "package" }, ...over } as SlashCommandInfo;
}
const owner = (name: string) => `/ext/${name}/index.ts`;
const destination = (id: string, name: string, args?: string, label = id[0].toUpperCase() + id.slice(1)) => ({ id, label, command: { name, ...(args === undefined ? {} : { args }) }, owner: owner(name) });

/** The command inventory as Pi's own resolver names it when several extensions register one command name. */
function resolvedInventory(extensions: Array<{ path: string; commands: string[] }>): SlashCommandInfo[] {
	const runner = new ExtensionRunner(extensions.map((extension) => ({
		path: extension.path, resolvedPath: extension.path,
		sourceInfo: { path: extension.path, source: "../../harness", scope: "user", origin: "package" },
		handlers: new Map(), tools: new Map(), messageRenderers: new Map(), entryRenderers: new Map(), flags: new Map(), shortcuts: new Map(),
		commands: new Map(extension.commands.map((name) => [name, { name, description: `${name} description`, handler() {}, sourceInfo: { path: extension.path, source: "../../harness", scope: "user", origin: "package" } }])),
	})) as never, undefined as never, "/work", undefined as never, undefined as never);
	return runner.getRegisteredCommands().map((command) => ({ name: command.invocationName, description: command.description, source: "extension", sourceInfo: command.sourceInfo }));
}

/** A terminal that keeps everything the compositor writes and lets a test change its size. */
function fakeTerminal(columns: number, rows: number) {
	const writes: string[] = [];
	let resize: () => void = () => {};
	let input: (data: string) => void = () => {};
	const terminal: Terminal & { columns: number; rows: number } = {
		columns, rows, kittyProtocolActive: false,
		start(onInput, onResize) { input = onInput; resize = onResize; }, stop() {}, write(data) { writes.push(data); }, moveBy() {},
		hideCursor() {}, showCursor() {}, clearLine() {}, clearFromCursor() {}, clearScreen() {}, setTitle() {}, setProgress() {}, setProgramStatus() {}, async drainInput() {},
	};
	/** One left click as the terminal reports it: an SGR press then release at 1-based screen cells. */
	const click = (x: number, y: number) => { input(`\x1b[<0;${x + 1};${y + 1}M`); input(`\x1b[<0;${x + 1};${y + 1}m`); };
	return { terminal, writes, resize: () => resize(), text: () => strip(writes.join("")), click };
}

const overlayRows = (terminal: { rows: number }) => Math.max(1, Math.floor(terminal.rows * 0.85));
const OVERLAY = { width: "80%", minWidth: 40, maxHeight: "85%", anchor: "center" } as const;

describe("destinations", () => {
	it("keeps only well-formed version 1 entries with an owner and resolves them against the current inventory", () => {
		assert.equal(readDestinations({ version: 2, destinations: [] }), undefined);
		const read = readDestinations({
			version: 1,
			destinations: [
				destination("stash", "stash"),
				{ id: "Bad Id", label: "x", command: { name: "x" }, owner: owner("x") },
				destination("pillars", "pillars", "browse"),
				{ id: "nolabel", label: "   ", command: { name: "y" }, owner: owner("y") },
				{ id: "unowned", label: "Unowned", command: { name: "z" } },
			],
		});
		assert.deepEqual(read?.map((entry) => entry.id), ["stash", "pillars"]);
		const resolved = resolveDestinations(read ?? [], [registration("stash"), registration("pillars", { source: "prompt" })]);
		assert.equal(resolved[0].registration?.name, "stash");
		assert.match(resolved[1].unavailable ?? "", /not registered by its owner/);
	});

	it("binds a destination to its owner's registration under Pi's collision names and rejects missing or ambiguous owners", () => {
		const inventory = resolvedInventory([
			{ path: "/other/stash/index.ts", commands: ["stash"] },
			{ path: owner("stash"), commands: ["stash", "stash-extra"] },
			{ path: "/twice/index.ts", commands: ["twice"] },
			{ path: "/twice/index.ts", commands: ["twice"] },
		]);
		assert.deepEqual(inventory.map((command) => command.name), ["stash:1", "stash:2", "stash-extra", "twice:1", "twice:2"], "Pi suffixes same-name registrations");
		const resolved = resolveDestinations([
			destination("stash", "stash"),
			{ ...destination("foreign", "stash"), owner: "/missing/index.ts" },
			{ ...destination("twice", "twice"), owner: "/twice/index.ts" },
		], inventory);
		assert.equal(resolved[0].registration?.name, "stash:2", "the owner's registration keeps Pi's invocation name");
		assert.match(resolved[1].unavailable ?? "", /not registered by its owner/);
		assert.match(resolved[2].unavailable ?? "", /more than once/);
		const menu = new CommandsPanel({ commands: inventory, destinations: resolveDestinations([destination("stash", "stash")], inventory), controls: [], theme, rows: () => 20, state: createSelectorState(), draftPresent: () => false, replacedDraftPresent: () => false, done() {} });
		assert.ok(menu.render(60).map(strip).some((line) => line.includes("opens /stash:2")), "the menu names the actual invocation");
	});

	it("subscribes before requesting and replaces entries by id", () => {
		const handlers = new Map<string, (value: unknown) => void>();
		const emitted: string[] = [];
		const read = collectDestinations({ on: (event, handler) => { handlers.set(event, handler); }, emit: (event) => { emitted.push(event); } });
		assert.deepEqual(emitted, ["harness:operator-destination:request"]);
		handlers.get("harness:operator-destination:publish")?.({ version: 1, destinations: [destination("clipboard", "clipboard")] });
		handlers.get("harness:operator-destination:publish")?.({ version: 1, destinations: [{ ...destination("clipboard", "clipboard"), label: "Clipboard history" }] });
		assert.deepEqual(read().map((entry) => entry.label), ["Clipboard history"]);
	});
});

describe("menu", () => {
	function panel(over: { rows?: () => number; replaced?: boolean } = {}) {
		const results: CommandsPanelResult[] = [];
		const commands = [registration("stash"), registration("evo")];
		const instance = new CommandsPanel({
			commands,
			destinations: resolveDestinations([destination("stash", "stash", undefined, "Stashes"), destination("gone", "gone")], commands),
			controls: [{ id: "model", label: "Model…", description: "p/m now" }, { id: "reasoning", label: "Reasoning…", description: "high now" }, { id: "statuses", label: "Statuses", description: "2 entries" }],
			theme, rows: over.rows ?? (() => 20), state: createSelectorState(),
			draftPresent: () => false, replacedDraftPresent: () => over.replaced ?? false,
			done: (result) => results.push(result),
		});
		return { instance, results };
	}

	it("lists destinations, session controls and command search in that order and opens a destination directly", () => {
		const { instance, results } = panel();
		const lines = instance.render(60).map(strip);
		assert.equal(lines[0], "Menu");
		const order = ["Stashes", "Gone", "Model…", "Reasoning…", "Statuses", "Search commands…"].map((label) => lines.findIndex((line) => line.includes(label)));
		assert.ok(order.every((index, position) => index >= 0 && (position === 0 || index > order[position - 1])), lines.join("\n"));
		assert.ok(lines.some((line) => /Gone.*unavailable/.test(line)), "an unresolved destination explains itself");
		assert.ok(!lines.some((line) => /\bevo\b/.test(line)), "an effectful command stays behind search");
		instance.handleInput("\r");
		assert.deepEqual(results, [{ kind: "run", command: registration("stash"), args: "" }]);
	});

	it("routes the session controls and reaches search; Escape on search returns to the menu", () => {
		const { instance, results } = panel();
		instance.render(60);
		instance.handleInput("\x1b[B"); instance.handleInput("\x1b[B");
		instance.handleInput("\r");
		assert.deepEqual(results, [{ kind: "control", id: "model" }]);
		const again = panel();
		again.instance.render(60);
		for (let step = 0; step < 5; step++) again.instance.handleInput("\x1b[B");
		again.instance.handleInput("\r");
		assert.ok(again.instance.render(60).map(strip)[0].includes("Commands"), "search opened");
		again.instance.handleInput("\x1b");
		assert.equal(again.instance.render(60).map(strip)[0], "Menu");
		assert.deepEqual(again.results, []);
	});
});

describe("composed overlay reachability", () => {
	function compose(columns: number, rows: number, make: (rows: () => number) => { render(width: number): string[] } & Parameters<TUI["showOverlay"]>[0]) {
		const fake = fakeTerminal(columns, rows);
		const tui = new TuiAltScreen(fake.terminal);
		tui.addChild({ render: () => ["root"], invalidate() {} });
		tui.start();
		const component = make(() => overlayRows(fake.terminal));
		tui.showOverlay(component, OVERLAY);
		tui.renderNow(true);
		return { ...fake, tui, component };
	}

	it("keeps Close visible for the menu at 60x20 and 80x24 and after a height-only shrink", () => {
		for (const [columns, rows] of [[60, 20], [80, 24]] as const) {
			const commands = Array.from({ length: 40 }, (_, index) => registration(`command-${index}`));
			const composed = compose(columns, rows, (rowsNow) => new CommandsPanel({ commands, destinations: [], controls: [{ id: "model", label: "Model…", description: "p/m" }, { id: "reasoning", label: "Reasoning…", description: "high" }, { id: "statuses", label: "Statuses", description: "0" }], theme, rows: rowsNow, state: createSelectorState(), draftPresent: () => false, replacedDraftPresent: () => false, done() {} }));
			assert.ok(composed.text().includes("[Close]"), `${columns}x${rows} menu Close`);
			(composed.component as CommandsPanel).search();
			composed.writes.length = 0;
			composed.tui.renderNow(true);
			assert.ok(composed.text().includes("[Close]") && composed.text().includes("command-0"), `${columns}x${rows} search Close`);
			composed.terminal.rows = Math.floor(rows / 2);
			composed.resize();
			composed.writes.length = 0;
			composed.tui.renderNow(true);
			assert.ok(composed.text().includes("[Close]"), `${columns}x${Math.floor(rows / 2)} Close after a height-only shrink`);
			composed.tui.stop();
		}
	});

	it("keeps Close reachable in the populated menu after a height-only shrink from 60x20 to 60x12", () => {
		const commands = Array.from({ length: 12 }, (_, index) => registration(`command-${index}`));
		const results: CommandsPanelResult[] = [];
		const destinations = resolveDestinations(["agent", "clipboard", "pillars", "policy", "stash"].map((name) => destination(name, name)), [...commands, ...["agent", "clipboard", "pillars", "policy", "stash"].map((name) => registration(name))]);
		const composed = compose(60, 20, (rowsNow) => new CommandsPanel({ commands, destinations, controls: [{ id: "model", label: "Model\u2026", description: "p/m" }, { id: "reasoning", label: "Reasoning\u2026", description: "high" }, { id: "statuses", label: "Statuses", description: "0" }], theme, rows: rowsNow, state: createSelectorState(), draftPresent: () => false, replacedDraftPresent: () => false, done: (result) => results.push(result) }));
		const panel = composed.component as CommandsPanel;
		panel.handleInput("\x1b[B"); panel.handleInput("\x1b[B");
		composed.writes.length = 0;
		composed.tui.renderNow(true);
		assert.ok(composed.text().includes("[Close]") && composed.text().includes("Search commands"), "the whole populated menu fits at 60x20");
		composed.terminal.rows = 12;
		composed.resize();
		composed.writes.length = 0;
		composed.tui.renderNow(true);
		const shrunk = composed.text();
		assert.ok(shrunk.includes("[Close]"), `Close after the height-only shrink:\n${shrunk}`);
		assert.match(shrunk, /\(3\/9\)/, "the overflowing list keeps its position row and the selected item");
		const layout = (composed.tui as unknown as { renderedOverlayLayouts: Array<{ col: number; row: number; width: number; height: number }> }).renderedOverlayLayouts[0];
		assert.ok(layout);
		const lines = panel.render(layout.width).map(strip);
		const closeY = lines.findIndex((line) => line.includes("[Close]"));
		assert.ok(closeY >= 0 && closeY < layout.height, "Close sits inside the composed overlay height");
		composed.click(layout.col + lines[closeY].indexOf("[Close]") + 1, layout.row + closeY);
		assert.deepEqual(results, [undefined], "the composed click on Close closes the menu");
		composed.tui.stop();
	});

	it("reaches the final status entry at 80x24 and keeps Close after a shrink", () => {
		const statuses = new Map(Array.from({ length: 30 }, (_, index) => [`key-${index}`, `value ${index}`]));
		const composed = compose(80, 24, (rowsNow) => new StatusPanel({ theme, rows: rowsNow, read: () => statuses, done() {} }));
		const panel = composed.component as StatusPanel;
		for (let step = 0; step < 200 && !composed.text().includes("value 29"); step++) {
			panel.handleInput("\x1b[6~");
			composed.writes.length = 0;
			composed.tui.renderNow(true);
		}
		assert.ok(composed.text().includes("value 29"), "the last entry is reachable through the composed overlay");
		assert.ok(composed.text().includes("[Close]"));
		composed.terminal.rows = 12;
		composed.resize();
		composed.writes.length = 0;
		composed.tui.renderNow(true);
		assert.ok(composed.text().includes("[Close]"), "Close survives a height-only shrink");
		composed.tui.stop();
	});

	it("choice panels fit the row budget, select on click, and apply only through Apply or Enter", () => {
		const picks: Array<string | undefined> = [];
		const pick = (value: string | undefined) => { picks.push(value); };
		const choice = new ChoicePanel({ title: "Model", hint: "a/b now", items: Array.from({ length: 30 }, (_, index) => ({ value: `p/m${index}`, label: `p/m${index}` })), selected: "p/m3", theme, rows: () => 10, done: pick });
		let lines = choice.render(60).map(strip);
		assert.ok(lines.length <= 10 && lines.at(-1)?.includes("[Apply]") && lines.at(-1)?.includes("[Cancel]"), lines.join("\n"));
		const click = (x: number, y: number) => choice.handleMouse({ type: "click", button: "left", x, y, screenX: x, screenY: y, width: 60, height: lines.length, shift: false, alt: false, ctrl: false, clickCount: 1 });
		const row = (value: string) => lines.findIndex((line) => line.includes(` ${value}`) || line.includes(`\u203a ${value}`) || line.trim() === value);
		const otherRow = lines.findIndex((line, index) => index > 1 && !line.includes("p/m3") && /p\/m\d+/.test(line));
		assert.ok(otherRow > 1);
		const other = /p\/m\d+/.exec(lines[otherRow])?.[0] ?? "";
		assert.equal(click(2, otherRow)?.handled, true);
		assert.deepEqual(picks, [], "a row click only highlights; nothing is applied");
		lines = choice.render(60).map(strip);
		assert.ok(row(other) >= 0);
		const applyX = lines.at(-1)?.indexOf("[Apply]") ?? -1;
		assert.ok(applyX >= 0);
		assert.equal(click(applyX + 1, lines.length - 1)?.handled, true);
		assert.deepEqual(picks, [other], "Apply commits the highlighted value");
		const byEnter = new ChoicePanel({ title: "Model", hint: "", items: [{ value: "a", label: "a" }, { value: "b", label: "b" }], selected: "b", theme, rows: () => 10, done: pick });
		byEnter.render(40);
		byEnter.handleInput("\r");
		assert.deepEqual(picks, [other, "b"], "Enter remains the keyboard activation");
		const cancelByClick = new ChoicePanel({ title: "Reasoning", hint: "", items: [{ value: "low", label: "low" }, { value: "high", label: "high" }], selected: "low", theme, rows: () => 10, done: pick });
		const cancelLines = cancelByClick.render(40).map(strip);
		cancelByClick.handleMouse({ type: "click", button: "left", x: 2, y: 3, screenX: 2, screenY: 3, width: 40, height: cancelLines.length, shift: false, alt: false, ctrl: false, clickCount: 1 });
		const cancelX = cancelLines.at(-1)?.indexOf("[Cancel]") ?? -1;
		cancelByClick.handleMouse({ type: "click", button: "left", x: cancelX + 1, y: cancelLines.length - 1, screenX: cancelX + 1, screenY: cancelLines.length - 1, width: 40, height: cancelLines.length, shift: false, alt: false, ctrl: false, clickCount: 1 });
		assert.deepEqual(picks, [other, "b", undefined], "Cancel after a row click changes nothing");
		const cancelled = new ChoicePanel({ title: "Reasoning", hint: "", items: [{ value: "low", label: "low" }], theme, rows: () => 10, done: pick });
		cancelled.render(40);
		cancelled.handleInput("\x1b");
		assert.deepEqual(picks, [other, "b", undefined, undefined]);
	});
});

describe("session controls through the public API", () => {
	function host(model: { provider: string; id: string; name: string; reasoning: boolean }) {
		const calls: string[] = [];
		const handlers = new Map<string, (event: unknown, ctx: unknown) => Promise<void>>();
		const commands = new Map<string, { handler(args: string, ctx: unknown): Promise<void> }>();
		const notifications: string[] = [];
		let driver: ((component: { render(width: number): string[]; handleInput?(data: string): void }, resolve: (value: unknown) => void) => void) | undefined;
		const pi = {
			on: (event: string, handler: (event: unknown, ctx: unknown) => Promise<void>) => handlers.set(event, handler),
			registerCommand: (name: string, command: { handler(args: string, ctx: unknown): Promise<void> }) => commands.set(name, command),
			getCommands: () => [registration("stash")],
			sendUserMessage: () => { calls.push("sent"); },
			events: { on: () => () => {}, emit: () => {} },
			setModel: async (chosen: { provider: string; id: string }) => { calls.push(`setModel:${chosen.provider}/${chosen.id}`); return chosen.provider !== "unauth"; },
			getThinkingLevel: () => "high",
			setThinkingLevel: (level: string) => { calls.push(`setThinkingLevel:${level}`); },
		};
		registerStatusline(pi as unknown as ExtensionAPI);
		const available = [{ provider: "p", id: "m1", name: "One", reasoning: true }, { provider: "unauth", id: "m2", name: "Two", reasoning: false }, model];
		const ctx = {
			mode: "tui", hasUI: true, cwd: "/work", model, thinkingLevel: "high",
			modelRegistry: { getAvailable: () => available },
			sessionManager: { getEntries: () => [], getLeafId: () => null, getEntry: () => undefined },
			getContextUsage: () => ({ tokens: 1, contextWindow: 100, percent: 1 }),
			ui: { setFooter() {}, notify: (text: string) => notifications.push(text), custom: (factory: (tui: unknown, theme: unknown, keys: unknown, done: (value: unknown) => void) => unknown) => new Promise((resolve) => { const component = factory({ terminal: { rows: 30, columns: 100 }, requestRender() {} }, theme, {}, resolve) as { render(width: number): string[]; handleInput?(data: string): void }; driver?.(component, resolve); }), getEditorText: () => "", setEditorText() {}, pasteToEditor() {} },
		};
		return { pi, ctx, calls, notifications, commands, handlers, drive: (next: typeof driver) => { driver = next; } };
	}

	it("Model applies the chosen registry model through pi.setModel and reports a refusal; Cancel changes nothing", async () => {
		const h = host({ provider: "p", id: "m0", name: "Zero", reasoning: true });
		await h.handlers.get("session_start")?.({}, h.ctx);
		let opens = 0;
		h.drive((component) => {
			opens += 1;
			component.render(80);
			if (opens === 1) { component.handleInput?.("\r"); }
			else { component.handleInput?.("\x1b[A"); component.handleInput?.("\x1b[A"); component.handleInput?.("\r"); }
		});
		await h.commands.get("commands")?.handler("", h.ctx);
		assert.deepEqual(h.calls, ["setModel:p/m1"]);
		assert.match(h.notifications.at(-1) ?? "", /Model set to p\/m1/);
		h.calls.length = 0;
		opens = 0;
		h.drive((component) => {
			opens += 1;
			component.render(80);
			if (opens === 1) { component.handleInput?.("\r"); }
			else { component.handleInput?.("\x1b[A"); component.handleInput?.("\r"); }
		});
		await h.commands.get("commands")?.handler("", h.ctx);
		assert.deepEqual(h.calls, ["setModel:unauth/m2"]);
		assert.match(h.notifications.at(-1) ?? "", /refused unauth\/m2/);
		h.calls.length = 0;
		opens = 0;
		h.drive((component) => {
			opens += 1;
			component.render(80);
			if (opens === 1) { component.handleInput?.("\r"); }
			else component.handleInput?.("\x1b");
		});
		await h.commands.get("commands")?.handler("", h.ctx);
		assert.deepEqual(h.calls, [], "Cancel preserves the session model");
	});

	it("Reasoning applies a supported level through pi.setThinkingLevel and reports a model without levels", async () => {
		const h = host({ provider: "p", id: "m0", name: "Zero", reasoning: true });
		await h.handlers.get("session_start")?.({}, h.ctx);
		let opens = 0;
		h.drive((component) => {
			opens += 1;
			component.render(80);
			if (opens === 1) { component.handleInput?.("\x1b[B"); component.handleInput?.("\r"); }
			else { component.handleInput?.("\x1b[A"); component.handleInput?.("\r"); }
		});
		await h.commands.get("commands")?.handler("", h.ctx);
		assert.ok(h.calls.some((call) => call.startsWith("setThinkingLevel:")), JSON.stringify(h.calls));
		const plain = host({ provider: "p", id: "flat", name: "Flat", reasoning: false });
		await plain.handlers.get("session_start")?.({}, plain.ctx);
		let plainOpens = 0;
		plain.drive((component) => {
			plainOpens += 1;
			component.render(80);
			component.handleInput?.("\x1b[B"); component.handleInput?.("\r");
		});
		await plain.commands.get("commands")?.handler("", plain.ctx);
		assert.equal(plainOpens, 1);
		assert.match(plain.notifications.at(-1) ?? "", /has no reasoning levels/);
		assert.deepEqual(plain.calls, []);
	});
});
