import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { it, type TestContext } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { defineTool, initTheme, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { obj } from "@earendil-works/pi-schema";
import { type KeyId, type TUI, visibleWidth } from "@earendil-works/pi-tui";
import { toolDisplay } from "./display.ts";

const requirePi = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"));
const tui: typeof import("@earendil-works/pi-tui") = await import(requirePi.resolve("@earendil-works/pi-tui"));
const ui = { requestRender() {} } as unknown as TUI;
const privateText = "private clipboard fixture";
const sourceId = "a".repeat(64);

function theme(t: TestContext, keys: KeyId | KeyId[] = "ctrl+g") {
	initTheme("dark", false);
	const previous = tui.getKeybindings();
	tui.setKeybindings(
		new tui.KeybindingsManager({
			...tui.TUI_KEYBINDINGS,
			"app.tools.expand": { defaultKeys: keys, description: "Expand tool output" },
		}),
	);
	t.after(() => tui.setKeybindings(previous));
}

function card(name: string, args: Record<string, unknown> = {}, complete = true) {
	const display = toolDisplay().tools.find((tool) => tool.name === name);
	assert.ok(display);
	const definition = defineTool({
		...display,
		label: name,
		description: "Display fixture",
		parameters: obj({}, { open: true }),
		async execute() {
			throw new Error("Display fixture must not execute");
		},
	});
	const component = new ToolExecutionComponent(name, "fixture", args, { outputPad: 1 }, definition, ui, ".");
	if (complete) component.setArgsComplete();
	return component;
}

function screen(component: ToolExecutionComponent, width = 120): string {
	return component
		.render(width)
		.map((row) => stripVTControlCharacters(row).trim())
		.filter(Boolean)
		.join("\n");
}

function result(text: string, details?: unknown, isError = false) {
	return { content: [{ type: "text" as const, text }], details, isError };
}

it("discloses only the size of a copy argument before and after expansion", (t) => {
	theme(t);
	const component = card("clipboard_copy", { content: `${privateText}😀`, label: "archive this" }, false);
	assert.equal(screen(component), "clipboard_copy archive this\ncontent still arriving");
	component.setArgsComplete();
	assert.match(screen(component), /26 characters/);
	assert.doesNotMatch(screen(component), /expand/);
	component.setExpanded(true);
	assert.match(screen(component), /content: 26 characters/);
	assert.doesNotMatch(screen(component), /private clipboard fixture|😀/);
	component.setExpanded(false);
	component.updateResult(result(`Preview: ${privateText}`, { lines: 1, chars: 26, id: "archive-id" }));
	assert.match(screen(component), /Copied to the clipboard \(26 characters · 1 line\)\. Archive entry archive-id\./);
	assert.doesNotMatch(screen(component), /private clipboard fixture|more lines/);
	assert.match(screen(component), /\.\.\. \(ctrl\+g to expand\)$/);
	component.setExpanded(true);
	assert.match(screen(component), /Preview: private clipboard fixture/);
	assert.doesNotMatch(screen(component), /content: private|to expand/);
});

it("keeps the confirmed clipboard write separate from an archive failure or opt-out", (t) => {
	theme(t);
	const component = card("clipboard_copy", { content: privateText });
	component.updateResult(
		result(`Preview: ${privateText}`, { chars: 25, lines: 1, id: "not-archived", archiveError: "Permission denied" }),
	);
	assert.match(
		screen(component),
		/Copied to the clipboard \(25 characters · 1 line\)\.\n\[Clipboard history write failed: Permission denied\]/,
	);
	assert.doesNotMatch(screen(component), /Archive entry not-archived|private clipboard fixture/);
	component.updateResult(result("Receipt", { chars: 25, lines: 1, archived: false }));
	assert.match(screen(component), /Copied to the clipboard .* without archiving\./);
	assert.doesNotMatch(screen(component), /write failed/);
});

it("does not preview host copy diagnostics that echo private arguments", (t) => {
	theme(t);
	const component = card("clipboard_copy");
	component.updateResult(
		result(`Invalid arguments: ${privateText}\nReceived arguments:\n${privateText}`, undefined, true),
	);
	assert.equal(screen(component), "clipboard_copy\nClipboard copy failed.\n... (ctrl+g to expand)");
	component.setExpanded(true);
	assert.match(screen(component), /Invalid arguments: private clipboard fixture/);
	assert.doesNotMatch(screen(component), /to expand/);
});

it("keeps clipboard bodies hidden when collapsed and offers exact read continuations", (t) => {
	theme(t, []);
	for (const tool of ["clipboard_get", "clipboard_paste"]) {
		const args = tool === "clipboard_get" ? { id: "entry-1", max_chars: 4 } : { max_chars: 4 };
		const component = card(tool, args);
		assert.doesNotMatch(screen(component), /expand/);
		component.updateResult(result(privateText, { chars: 25, lines: 1, sourceId, nextOffset: 4 }));
		assert.match(screen(component), /more content follows\.\n\.\.\. \(click to expand\)$/);
		assert.doesNotMatch(screen(component), /private clipboard fixture|a{64}|more lines/);
		component.setExpanded(true);
		const expanded = screen(component, 190);
		assert.match(expanded, /private clipboard fixture/);
		assert.ok(expanded.includes(`${tool} ${JSON.stringify({ ...args, offset: 4, sourceId })}`));
		assert.doesNotMatch(expanded, /to expand/);
	}
});

it("distinguishes empty clipboard, empty history, partial archive page and thrown failure", (t) => {
	theme(t);
	const paste = card("clipboard_paste");
	paste.updateResult(result(`Clipboard is empty.\nsourceId: ${sourceId}`, { chars: 0 }));
	assert.match(screen(paste), /Clipboard is empty\./);
	paste.setExpanded(true);
	assert.ok(screen(paste).includes(sourceId));
	const recent = card("clipboard_list");
	recent.updateResult(result("Clipboard history is empty.", { count: 0, hasMore: false }));
	assert.match(screen(recent), /No clipboard history entries\./);
	assert.doesNotMatch(screen(recent), /to expand/);
	const list = card("clipboard_list", { query: "example", date: "2026-01-02" });
	list.updateResult(
		result(
			JSON.stringify({
				query: "example",
				date: "2026-01-02",
				matches: [],
				hasMore: true,
				stop: "record-limit",
				nextCursor: "full-cursor",
				scan: { malformed: 2 },
				note: "Model guidance",
			}),
		),
	);
	assert.match(screen(list), /No matches on this clipboard archive page; the scan has more pages\./);
	assert.match(screen(list), /\[Partial coverage: archive records skipped\]/);
	assert.doesNotMatch(screen(list), /Model guidance|full-cursor/);
	list.setExpanded(true);
	assert.match(screen(list), /clipboard_list \{"query":"example","date":"2026-01-02","cursor":"full-cursor"\}/);
	list.setExpanded(false);
	list.updateResult(result("clipboard_list cancelled", { count: 0 }, true));
	assert.match(screen(list), /clipboard_list cancelled/);
	assert.doesNotMatch(screen(list), /No matches|to expand/);
});

it("keeps stable IDs until width clips them and hands off a single hint after a result", (t) => {
	theme(t);
	const id = `entry-${"界".repeat(105)}`;
	const component = card("clipboard_restore", { id, date: "2026-01-02" });
	assert.ok(screen(component, 300).includes(id));
	assert.doesNotMatch(screen(component, 300), /expand/);
	assert.match(screen(component, 60), /clipboard_restore .*…\ndate .*\n\.\.\. \(ctrl\+g to expand\)$/);
	component.updateResult(result("", undefined), true);
	assert.match(screen(component, 60), /Restoring to the clipboard…\n\.\.\. \(ctrl\+g to expand\)$/);
	component.updateResult(result("Restored", { id, chars: 1, lines: 1 }));
	assert.match(
		screen(component, 60),
		/Restored to the clipboard \(1 character · 1 line\)\.\n\.\.\. \(ctrl\+g to expand\)$/,
	);
	assert.equal(screen(component, 60).match(/to expand/g)?.length, 1);
	assert.doesNotMatch(screen(component, 300), /expand/);
	for (const raw of component.render(60)) {
		assert.ok(visibleWidth(raw) <= 60);
		assert.doesNotMatch(raw, /\x1b\[0m/);
	}
});

it("bounds long diagnostics in both views and does not count undisclosed private lines", (t) => {
	theme(t);
	const component = card("clipboard_get", { id: "entry-1" });
	component.updateResult(result(`Archive error\n${"x".repeat(242)}\u202e\x1b[31m\tTail`, undefined, true));
	assert.doesNotMatch(screen(component, 40), /xxxx|Tail|more line/);
	assert.match(screen(component, 50), /\.\.\. \(ctrl\+g to expand\)/);
	component.setExpanded(true);
	assert.match(screen(component), /Tail/);
	assert.doesNotMatch(screen(component), /\u202e|\[31m|to expand/);
	component.updateResult(result(`${"x".repeat(32_001)}TAIL`, undefined, true));
	assert.match(screen(component), /\[Truncated: showing 32000 of 32005 characters\]/);
	assert.doesNotMatch(screen(component), /TAIL/);
});
