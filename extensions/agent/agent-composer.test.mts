import assert from "node:assert/strict";
import { it } from "node:test";
import { visibleWidth, type TUI, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { stripVTControlCharacters } from "node:util";
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
for (const width of [12, 80, 140]) {
	it(`framed native editor maps first, last and wrapped text cells at ${width}`, () => {
		const composer = new AgentComposer({
			tui: { terminal: { rows: 36, columns: width }, requestRender() {} } as unknown as TUI,
			theme,
			keys,
			onSubmit() {},
			onEscape() {},
		});
		composer.focused = true;
		const render = () => {
			const lines = composer.render(width, "Message to agent").map(stripVTControlCharacters);
			assert.ok(lines.every((line) => visibleWidth(line) === width));
			assert.ok(lines[0]?.startsWith("╭"));
			assert.ok(lines.at(-1)?.endsWith("╯"));
			return lines;
		};
		const click = (x: number, y: number, type: TuiMouseEvent["type"] = "click") =>
			composer.handleMouse({
				type,
				button: "left",
				clickCount: 1,
				x,
				y,
				screenX: x,
				screenY: y,
				width,
				height: render().length,
				shift: false,
				alt: false,
				ctrl: false,
			});
		assert.ok(render()[1]?.startsWith("│"));
		composer.setText("abcdef");
		click(1, 1);
		composer.handleInput("|");
		assert.equal(composer.getText(), "|abcdef");
		composer.setText("abcdef");
		click(width - 2, 1);
		composer.handleInput("|");
		assert.equal(composer.getText(), "abcdef|");
		const prefix = "a".repeat(width - 3);
		composer.setText(`${prefix}bcdef`);
		click(1, 2);
		composer.handleInput("|");
		assert.equal(composer.getText(), `${prefix}|bcdef`);
		composer.setText("界abc");
		click(3, 1);
		composer.handleInput("|");
		assert.equal(composer.getText(), "界|abc");
		for (const type of ["press", "drag", "release"] as const) assert.equal(click(2, 1, type), undefined);
		assert.equal(click(0, 1), undefined);
		assert.equal(click(width - 1, 1), undefined);
	});
}
it("framed composer retains native hidden-line indicators", () => {
	const composer = new AgentComposer({
		tui: { terminal: { rows: 36, columns: 80 }, requestRender() {} } as unknown as TUI,
		theme,
		keys,
		onSubmit() {},
		onEscape() {},
	});
	composer.setText(Array.from({ length: 12 }, (_, index) => `Line ${index}`).join("\n"));
	assert.match(composer.render(80)[0] ?? "", /↑ \d+ lines/);
	for (let index = 0; index < 12; index++) composer.handleInput("\x1b[A");
	assert.match(composer.render(80).at(-1) ?? "", /↓ \d+ lines/);
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
