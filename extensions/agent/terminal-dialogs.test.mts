import assert from "node:assert/strict";
import { it } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { setKeybindings, type Component, type Focusable, type TUI, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { terminalDialogs } from "./terminal-dialogs.ts";
import { terminalKeys } from "./terminal-client.ts";
import { modelChoices } from "./durable-runtime.ts";
import { theme } from "./dashboard-test-fixture.mts";

function harness(rows = 24) {
	const overlays: Array<Component & Focusable> = [];
	const hidden: Array<Component> = [];
	const tracked = new Set<() => void>();
	const notices: string[] = [];
	const tui = { terminal: { rows, columns: 80 }, requestRender() {}, showOverlay(component: Component & Focusable) { overlays.push(component); component.focused = true; return { hide() { hidden.push(component); } }; } } as unknown as TUI;
	const keys = terminalKeys();
	setKeybindings(keys);
	const dialogs = terminalDialogs({ tui, theme, keys, track: (cancel) => { tracked.add(cancel); return () => tracked.delete(cancel); }, notify: (text) => notices.push(text) });
	const top = () => overlays.at(-1) as Component & Focusable & { handleMouse(event: TuiMouseEvent): unknown };
	const plainLine = (line: string) => stripVTControlCharacters(line).replace(/\u001b_pi:[^\u0007]*\u0007/gu, "");
	const text = (width = 80) => top().render(width).map(plainLine).join("\n");
	const click = (x: number, y: number) => top().handleMouse({ type: "click", button: "left", x, y, screenX: x, screenY: y, width: 80, height: 24, shift: false, alt: false, ctrl: false });
	const rowOf = (needle: string) => top().render(80).map(plainLine).findIndex((line) => line.includes(needle));
	return { dialogs, overlays, hidden, tracked, notices, top, text, click, rowOf };
}

it("a choice dialog returns the value behind the label, filters long lists, and resolves on Enter", async () => {
	const h = harness();
	const choices = Array.from({ length: 20 }, (_, index) => ({ value: `provider/model-${index}`, label: `Model ${index} (display only)` }));
	const picked = h.dialogs.select("Pick a model", choices);
	assert.equal(h.tracked.size, 1, "an open interaction is tracked while it waits");
	assert.match(h.text(), /Filter:/u);
	for (const key of "model-1") h.top().handleInput?.(key);
	h.top().handleInput?.("\x1b[B");
	h.top().handleInput?.("\r");
	const value = await picked;
	assert.match(value ?? "", /^provider\/model-1\d?$/u);
	assert.notEqual(value, "Model 1 (display only)");
	assert.equal(h.tracked.size, 0);
	assert.equal(h.hidden.length, 1);
});

it("a choice dialog can be chosen by pointer, cancelled by Escape, and cancelled by disposal", async () => {
	const h = harness();
	const pointed = h.dialogs.select("Pick", [{ value: "a", label: "Alpha" }, { value: "b", label: "Beta" }]);
	const row = h.rowOf("Beta");
	assert.ok(row >= 0);
	h.click(3, row);
	assert.equal(await pointed, "b");
	const button = h.dialogs.select("Pick", [{ value: "a", label: "Alpha" }]);
	h.click(2, h.rowOf("[ Choose ]"));
	assert.equal(await button, "a");
	const escaped = h.dialogs.select("Pick", [{ value: "a", label: "Alpha" }]);
	h.top().handleInput?.("\x1b");
	assert.equal(await escaped, undefined);
	const disposed = h.dialogs.select("Pick", [{ value: "a", label: "Alpha" }]);
	for (const cancel of [...h.tracked]) cancel();
	assert.equal(await disposed, undefined);
	assert.equal(h.tracked.size, 0);
});

it("confirm applies only on the explicit action and reports cancellation as false", async () => {
	const h = harness();
	const refused = h.dialogs.confirm("Stop?", "History stays.", "Stop current work");
	h.top().handleInput?.("\r");
	assert.equal(await refused, false, "Cancel is the default choice");
	const accepted = h.dialogs.confirm("Stop?", "History stays.", "Stop current work");
	h.top().handleInput?.("\x1b[B");
	h.top().handleInput?.("\r");
	assert.equal(await accepted, true);
});

it("single-line and multiline editing prefill, apply with Enter, insert breaks, and cancel", async () => {
	const h = harness();
	const line = h.dialogs.input("Deadline", { initial: "+30m" });
	assert.match(h.text(), /\+30m/u);
	h.top().handleInput?.("5");
	h.top().handleInput?.("\r");
	assert.equal(await line, "+30m5");
	const multi = h.dialogs.editor("Handoff", "first");
	assert.match(h.text(), /\[ Apply \]/u);
	h.click(h.text().split("\n").find((entry) => entry.includes("[ Apply ]"))?.indexOf("[ New line ]") ?? 0, h.rowOf("[ New line ]"));
	h.top().handleInput?.("second");
	h.click(1, h.rowOf("[ Apply ]"));
	assert.equal(await multi, "first\nsecond");
	const cancelled = h.dialogs.editor("Handoff", "kept");
	h.top().handleInput?.("\x1b");
	assert.equal(await cancelled, undefined);
});

it("the reader wraps every line, scrolls by key and wheel, and closes by button", async () => {
	const h = harness(20);
	const long = `${"word ".repeat(60)}END`;
	const reading = h.dialogs.read("Profile", [long, ...Array.from({ length: 80 }, (_, index) => `line ${index}`)].join("\n"));
	const view = h.text(40);
	assert.match(view, /END/u, "a long line wraps instead of being cut at the right edge");
	assert.ok(h.top().render(40).length <= 18);
	h.top().handleInput?.("\x1b[6~");
	assert.doesNotMatch(h.text(40), /word word/u);
	h.top().handleMouse({ type: "wheel", button: "none", x: 2, y: 3, screenX: 2, screenY: 3, width: 40, height: 18, shift: false, alt: false, ctrl: false, wheelDelta: -3 });
	assert.match(h.text(40), /of \d+ lines/u);
	h.click(2, h.rowOf("[ Close ]"));
	await reading;
	assert.equal(h.tracked.size, 0);
});

it("the host model list is the runtime's last-known snapshot with its error qualification", () => {
	let probed = 0;
	const runtime = {
		getAvailableSnapshot: () => [{ provider: "b", id: "two", name: "Two", reasoning: false }, { provider: "a", id: "one", name: "One", reasoning: true }],
		getError: () => "refresh failed",
		getAvailable: () => { probed++; return []; },
	};
	const read = modelChoices({ services: { modelRuntime: runtime } as never });
	assert.deepEqual(read.models.map((model) => `${model.provider}/${model.modelId}`), ["a/one", "b/two"]);
	assert.equal(read.error, "refresh failed");
	assert.equal(read.source, "available-snapshot");
	assert.equal(probed, 0, "reading choices starts no credential or network check");
});
