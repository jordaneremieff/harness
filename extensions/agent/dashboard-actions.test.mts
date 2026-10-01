import assert from "node:assert/strict";
import { it } from "node:test";
import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { KeybindingsManager as Keys, TUI_KEYBINDINGS, getKeybindings, setKeybindings, visibleWidth } from "@earendil-works/pi-tui";
import { AgentActionPicker } from "./dashboard-actions.ts";

const theme = { fg: (_: string, text: string) => text, bold: (text: string) => text } as Theme;
const choices = Array.from({ length: 18 }, (_, index) => ({ name: `action-${index}`, description: `Description for action ${index}: choose this action to inspect the selected session.` }));
const keys = new Keys(TUI_KEYBINDINGS) as KeybindingsManager;

it("keeps first and last actions visible within terminal bounds through resize", () => {
	const previous = getKeybindings(); setKeybindings(keys);
	const terminal = { rows: 24 }; const selected: unknown[] = [];
	const picker = new AgentActionPicker(choices, { terminal, requestRender() {} }, theme, keys, (value) => selected.push(value));
	try {
		assert.match(picker.render(80).join("\n"), /→ action-0/);
		picker.handleInput("\x1b[A"); assert.match(picker.render(80).join("\n"), /→ action-17/);
		for (const [width, height] of [[140, 36], [80, 24], [40, 12], [24, 10], [20, 8], [1, 1]]) {
			terminal.rows = height; const lines = picker.render(width);
			assert.ok(lines.length <= Math.max(1, height - 2), `${width}x${height} height ${lines.length}`);
			assert.ok(lines.every((line) => visibleWidth(line) <= width), `${width}x${height} width`);
			if (width >= 24 && height >= 10) assert.match(lines.join("\n"), /→ action-17/);
		}
		picker.handleInput("\r"); assert.deepEqual(selected, [], "hidden choices do not execute");
		terminal.rows = 24; picker.render(80); picker.handleInput("\r"); assert.deepEqual(selected, ["action-17"]);
	} finally { setKeybindings(previous); }
});

it("cancels without selecting an action and displays the selected description", () => {
	const previous = getKeybindings(); setKeybindings(keys);
	const selected: unknown[] = [];
	const picker = new AgentActionPicker(choices, { terminal: { rows: 24 }, requestRender() {} }, theme, keys, (value) => selected.push(value));
	try {
		picker.render(80); picker.handleInput("\x1b[B");
		assert.match(picker.render(80).join("\n"), /Description for action 1:/);
		picker.handleInput("\x1b"); assert.deepEqual(selected, [undefined]);
	} finally { setKeybindings(previous); }
});

it("uses configured native selection keys and labels, including disabled bindings", () => {
	const previous = getKeybindings();
	const configured = new Keys(TUI_KEYBINDINGS, { "tui.select.up": ["ctrl+p"], "tui.select.down": ["ctrl+n"], "tui.select.confirm": ["ctrl+y"], "tui.select.cancel": ["ctrl+g"] }) as KeybindingsManager;
	setKeybindings(configured);
	const terminal = { rows: 24 }; const selected: unknown[] = [];
	const picker = new AgentActionPicker(choices, { terminal, requestRender() {} }, theme, configured, (value) => selected.push(value));
	try {
		assert.match(picker.render(80).join("\n"), /ctrl\+p\/ctrl\+n select · ctrl\+y choose · ctrl\+g back/);
		picker.handleInput("\x1b[B"); picker.handleInput("\r"); assert.deepEqual(selected, []);
		picker.handleInput("\x0e"); assert.match(picker.render(80).join("\n"), /→ action-1/);
		picker.handleInput("\x19"); assert.deepEqual(selected, ["action-1"]);
		terminal.rows = 6; assert.match(picker.render(80).join("\n"), /ctrl\+g back/); picker.handleInput("\x07"); assert.deepEqual(selected, ["action-1", undefined]);
		const disabled = new Keys(TUI_KEYBINDINGS, { "tui.select.up": [], "tui.select.down": [], "tui.select.confirm": [], "tui.select.cancel": [] }) as KeybindingsManager;
		setKeybindings(disabled);
		const inert = new AgentActionPicker(choices, { terminal: { rows: 24 }, requestRender() {} }, theme, disabled, () => assert.fail("disabled keys"));
		assert.doesNotMatch(inert.render(80).at(-1) ?? "", /select|choose|back/);
		for (const key of ["\x1b[A", "\x1b[B", "\r", "\x1b"]) inert.handleInput(key);
	} finally { setKeybindings(previous); }
});
