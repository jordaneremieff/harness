import assert from "node:assert/strict";
import { it } from "node:test";
import type { TUI } from "@earendil-works/pi-tui";
import { AgentComposer } from "./agent-composer.ts";
import { keys, theme } from "./dashboard-test-fixture.mts";
it("native editor preserves expanded paste until confirmed admission and keeps slash text literal", () => {
	const sent: string[] = [];
	const changes: string[] = [];
	let backs = 0;
	const composer = new AgentComposer({
		tui: { terminal: { rows: 45, columns: 140 }, requestRender() {} } as unknown as TUI,
		theme,
		keys,
		onSubmit: (text) => sent.push(text),
		onChange: (text) => changes.push(text),
		onEscape: () => {
			backs++;
		},
	});
	composer.focused = true;
	const text = `/help\n${"draft ".repeat(300)}`;
	composer.handleInput(`\x1b[200~${text}\x1b[201~`);
	composer.handleInput("\r");
	assert.deepEqual(sent, [text]);
	assert.equal(composer.getText(), text);
	composer.handleInput("\x1b");
	assert.equal(backs, 1);
	composer.setText("");
	composer.handleInput("\x04");
	assert.equal(composer.getText(), "");
	composer.handleInput("local draft");
	composer.handleInput("\x03");
	assert.equal(composer.getText(), "");
	assert.ok(changes.length);
});
it("F and Alt events do not route to application controls", () => {
	const sent: string[] = [];
	const composer = new AgentComposer({
		tui: { terminal: { rows: 24, columns: 80 }, requestRender() {} } as unknown as TUI,
		theme,
		keys,
		onSubmit: (text) => sent.push(text),
		onEscape() {},
	});
	composer.handleInput("text");
	composer.handleInput("\x1b[17~");
	composer.handleInput("\x1bn");
	assert.equal(composer.getText(), "text");
	assert.deepEqual(sent, []);
});
