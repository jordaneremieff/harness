import assert from "node:assert/strict";
import { it } from "node:test";
import { stripVTControlCharacters } from "node:util";
import type { ExtensionAPI, ExtensionContext, Theme, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { ORDINARY_CONTINUE_TEXT, ORDINARY_NOTE_CHARS, ORDINARY_WORK_DESCRIPTION, OrdinaryWorkParams, registerOrdinaryWork } from "./ordinary-work.ts";
import { matchesSchema } from "./schema-check.ts";
import { ordinaryWorkCard } from "./tool-cards.ts";

const theme = { fg: (_color: string, value: string) => value, bold: (value: string) => value } as unknown as Theme;

/** An object whose every member except the named ones throws, so a test shows what the code does not use. */
function only<T extends object>(members: T, name: string): T {
	return new Proxy(members, { get: (target, key) => { if (key in target) return target[key as keyof T]; throw new Error(`${name} must not use ${String(key)}`); } });
}

function fixture() {
	let tool: ToolDefinition | undefined;
	const card = ordinaryWorkCard();
	registerOrdinaryWork(only({ registerTool: (definition: ToolDefinition) => { tool = definition; } }, "the registration") as unknown as ExtensionAPI, card);
	assert.ok(tool);
	const registered = tool;
	assert.equal(registered.renderCall, card.renderCall, "the registered renderers are the caller's card references");
	assert.equal(registered.renderResult, card.renderResult);
	const context = only({}, "the tool") as unknown as ExtensionContext;
	return { tool: registered, run: (input: unknown) => registered.execute("call", input as never, undefined, undefined, context as never) };
}

it("ends the turn in continue and keeps the note nowhere outside the call", async () => {
	const f = fixture();
	const note = "Two workers review the parser. Their results arrive as events; nothing needs you until then.";
	const result = await f.run({ action: "continue", note });
	assert.equal(result.terminate, true, "no model request follows the only call of its batch");
	assert.deepEqual(result.content, [{ type: "text", text: ORDINARY_CONTINUE_TEXT }]);
	assert.deepEqual(result.details, { action: "continue", note }, "no widget, no session entry and no event hook: the context and the API stay unused");
	assert.deepEqual((result as { structuredContent?: unknown }).structuredContent, result.details);
	assert.equal((await f.run({ action: "continue", note: "One result is in; one worker still runs." })).terminate, true, "each call stands alone");

	for (const input of [{ action: "complete" }, { action: "continue" }, { action: "continue", note: "" }, { action: "continue", note, results: [] }, { note }]) {
		await assert.rejects(f.run(input), /agent_work takes action continue and a note/u, JSON.stringify(input));
	}
	assert.equal(matchesSchema(OrdinaryWorkParams, { action: "continue", note: "x".repeat(ORDINARY_NOTE_CHARS) }), true);
	assert.equal(matchesSchema(OrdinaryWorkParams, { action: "continue", note: "x".repeat(ORDINARY_NOTE_CHARS + 1) }), false);

	assert.match(ORDINARY_WORK_DESCRIPTION, /Put no internal identifier in the note \(no session, submission or request ID\)/u, "the note is text for the operator");
	assert.doesNotMatch(ORDINARY_WORK_DESCRIPTION, /widget|complete|result references\)/u, "the tool keeps no state to clear and asks for no reference");
	assert.match(f.tool.promptSnippet ?? "", /no chat text/u);
});

it("shows the note as the card of the call: at most three lines, and all of it when expanded", () => {
	const f = fixture();
	const card = { expanded: false, isError: false, keyText: () => "" };
	const lines = (note: unknown, width: number, context: Record<string, unknown> = card) => f.tool.renderCall?.({ action: "continue", note } as never, theme, context as never).render(width).map((line) => stripVTControlCharacters(line));

	assert.deepEqual(lines("Two workers run;\nnothing needs you.", 80), ["agent_work · Two workers run; nothing needs you."], "white space collapses and a short note takes one line");
	assert.deepEqual(lines(undefined, 80), ["agent_work"], "a call whose note did not arrive yet shows the title");

	const note = "Two workers run the parser review; their results arrive as events and need nothing from you until then. ".repeat(4).trim();
	const shown = lines(note, 40);
	assert.ok(shown);
	assert.equal(shown.length, 3, "a longer note takes at most three lines");
	assert.ok(shown.every((line) => line.length <= 40));
	assert.ok(shown[0].startsWith("agent_work · Two workers run the parser"));
	assert.match(shown[2], /…$/u, "a clipped note says so");
	const all = lines(note, 40, { ...card, expanded: true });
	assert.ok(all && all.length > 3);
	assert.equal(all.map((line) => line.trim()).join(" "), `agent_work · ${note}`, "an expanded card shows the complete note");

	const first = f.tool.renderCall?.({ action: "continue", note: "first" } as never, theme, card as never);
	const second = f.tool.renderCall?.({ action: "continue", note: "second" } as never, theme, { ...card, lastComponent: first } as never);
	assert.equal(second, first, "a rerender reuses the component");
	assert.deepEqual(second?.render(80).map((line) => stripVTControlCharacters(line)), ["agent_work · second"]);

	assert.deepEqual(f.tool.renderResult?.({ content: [{ type: "text", text: ORDINARY_CONTINUE_TEXT }] } as never, { expanded: false, isPartial: false }, theme, card as never).render(80), [], "the result adds no line");
	const failed = f.tool.renderResult?.({ content: [{ type: "text", text: "agent_work takes action continue and a note" }] } as never, { expanded: false, isPartial: false }, theme, { ...card, isError: true } as never).render(80).map((line) => stripVTControlCharacters(line));
	assert.deepEqual(failed, ["agent_work takes action continue and a note"], "a failed call shows its error");
});
