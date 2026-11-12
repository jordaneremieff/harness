import assert from "node:assert/strict";
import { it } from "node:test";
import { stripVTControlCharacters } from "node:util";
import type { ExtensionAPI, ExtensionContext, Theme, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { ORDINARY_CONTINUE_TEXT, ORDINARY_WORK_ENTRY, ORDINARY_WORK_WIDGET, registerOrdinaryWork } from "./ordinary-work.ts";
import { ordinaryWorkCard } from "./tool-cards.ts";

type WidgetContent = undefined | string[] | ((tui: TUI, theme: Theme) => Component);
const plain = (content: WidgetContent) => Array.isArray(content) ? content : undefined;
const theme = { fg: (_color: string, value: string) => value, bold: (value: string) => value } as unknown as Theme;

function fixture() {
	const entries: { type: "custom"; customType: string; data: unknown }[] = [];
	const widgets: [string, WidgetContent][] = [];
	const starts: ((event: unknown, ctx: ExtensionContext) => void)[] = [];
	let tool: ToolDefinition | undefined;
	let now = Date.UTC(2026, 10, 12, 3, 4);
	const card = ordinaryWorkCard();
	registerOrdinaryWork({
		registerTool: (definition: ToolDefinition) => { tool = definition; },
		appendEntry: (customType: string, data: unknown) => { entries.push({ type: "custom", customType, data }); },
		on: (name: string, handler: (event: unknown, ctx: ExtensionContext) => void) => { if (name === "session_start") starts.push(handler); },
	} as unknown as ExtensionAPI, card, () => now);
	assert.ok(tool);
	const registered = tool;
	assert.equal(registered.renderCall, card.renderCall, "the registered renderers are the caller's card references");
	assert.equal(registered.renderResult, card.renderResult);
	const context = (hasUI: boolean) => ({ hasUI, ui: { setWidget: (key: string, content: WidgetContent) => { widgets.push([key, content]); } }, sessionManager: { getBranch: () => entries } }) as unknown as ExtensionContext;
	const lines = (content: WidgetContent, width = 40) => typeof content === "function" ? content(undefined as unknown as TUI, theme).render(width).map((line) => stripVTControlCharacters(line)) : undefined;
	return {
		entries, widgets, tool: registered, context, lines,
		at: (value: number) => { now = value; },
		start: (ctx: ExtensionContext) => { for (const handler of starts) handler({}, ctx); },
		run: (input: unknown, ctx: ExtensionContext) => registered.execute("call", input as never, undefined, undefined, ctx as never),
	};
}

it("ends the turn in continue with the note in one widget, keeps the note across a reload, and clears it in complete", async () => {
	const f = fixture();
	const ui = f.context(true);
	const note = "Two workers run the parser review; their results arrive as events and need nothing from you until then. ".repeat(4).trim();
	const first = await f.run({ action: "continue", note }, ui);
	assert.equal(first.terminate, true, "no model request follows the only call of its batch");
	assert.deepEqual(first.content, [{ type: "text", text: ORDINARY_CONTINUE_TEXT }]);
	assert.deepEqual(first.details, { action: "continue", note, at: Date.UTC(2026, 10, 12, 3, 4) });
	assert.deepEqual(f.entries, [{ type: "custom", customType: ORDINARY_WORK_ENTRY, data: { note, at: Date.UTC(2026, 10, 12, 3, 4) } }]);
	const title = `agent state · ${new Date(Date.UTC(2026, 10, 12, 3, 4)).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
	assert.deepEqual(f.widgets.map(([key]) => key), [ORDINARY_WORK_WIDGET, ORDINARY_WORK_WIDGET], "one widget, set twice");
	assert.deepEqual(f.widgets[0][1], [title, note], "first as string lines, which is all that RPC mode takes");
	assert.equal(typeof f.widgets[1][1], "function", "then as the component that replaces the lines in the TUI");
	const shown = f.lines(f.widgets[1][1]);
	assert.ok(shown);
	assert.equal(shown[0], title, "the title carries the local time of the note");
	assert.equal(shown.length, 4, "the note takes at most three lines");
	assert.ok(shown.every((line) => line.length <= 40));
	assert.match(shown[3], /…$/u, "a longer note is clipped");
	assert.ok(shown[1].startsWith("Two workers run the parser review"));

	const card = { expanded: false, isError: false, keyText: () => "" } as never;
	const call = f.tool.renderCall?.({ action: "continue", note: "Two workers run;\nnothing needs you." } as never, theme, card);
	assert.deepEqual(call?.render(80).map((line) => stripVTControlCharacters(line)), ["agent_work · Two workers run; nothing needs you."], "the card is the note on one line");
	assert.deepEqual(call?.render(20).map((line) => stripVTControlCharacters(line)), ["agent_work · Two wo…"], "a longer note is clipped to the line");
	assert.deepEqual(f.tool.renderResult?.(first as never, { expanded: false, isPartial: false }, theme, card).render(80), [], "the result adds no line");

	f.at(Date.UTC(2026, 10, 12, 3, 9));
	const second = await f.run({ action: "continue", note: "One result is in; one worker still runs." }, ui);
	assert.equal(second.terminate, true);
	assert.deepEqual(plain(f.widgets[2][1])?.slice(1), ["One result is in; one worker still runs."]);
	assert.deepEqual(f.lines(f.widgets[3][1])?.slice(1), ["One result is in; one worker still runs."], "a repeated continue replaces the note");

	// A reload registers the tool again and reads the newest entry of the branch.
	const reloaded = fixture();
	reloaded.entries.push(...f.entries);
	const reloadedUi = reloaded.context(true);
	reloaded.start(reloadedUi);
	assert.deepEqual(plain(reloaded.widgets[0][1])?.slice(1), ["One result is in; one worker still runs."]);
	assert.deepEqual(reloaded.lines(reloaded.widgets[1][1])?.slice(1), ["One result is in; one worker still runs."]);

	const done = await f.run({ action: "complete" }, ui);
	assert.equal(done.terminate, undefined, "complete does not end the turn");
	assert.deepEqual(done.details, { action: "complete", cleared: true });
	assert.deepEqual(f.widgets.at(-1), [ORDINARY_WORK_WIDGET, undefined], "complete clears the widget");
	assert.deepEqual(f.entries.at(-1)?.data, { note: null, at: Date.UTC(2026, 10, 12, 3, 9) });
	assert.deepEqual((await f.run({ action: "complete" }, ui)).details, { action: "complete", cleared: false });
	const cleared = fixture();
	cleared.entries.push(...f.entries);
	cleared.start(cleared.context(true));
	assert.deepEqual(cleared.widgets, [[ORDINARY_WORK_WIDGET, undefined]], "a cleared note does not come back after a reload");

	const headless = fixture();
	const stored = await headless.run({ action: "continue", note: "No operator is here." }, headless.context(false));
	assert.equal(stored.terminate, true, "without a UI the tool stores the note and ends the turn");
	assert.deepEqual([headless.entries.length, headless.widgets.length], [1, 0]);
	await assert.rejects(headless.run({ action: "continue" }, headless.context(false)), /continue requires note/u);
	await assert.rejects(headless.run({ action: "complete", note: "x" }, headless.context(false)), /complete takes only action/u);
});
