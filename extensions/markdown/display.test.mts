import assert from "node:assert/strict";
import { test } from "node:test";
import { Text } from "@earendil-works/pi-tui";
import { createPublishTool } from "./publish.ts";
import { createLiveTool } from "./live-tool.ts";
import { toolDisplay } from "./display.ts";
import { MarkdownStore } from "./store.ts";
const theme = { fg: (_colour: string, value: string) => value, bold: (value: string) => value } as never;
const context = { expanded: false, isError: false, keyText: () => "ctrl+o" } as never;
function card(name: string) {
	const value = toolDisplay().tools.find((tool) => tool.name === name);
	assert.ok(value);
	const renderCall = value.renderCall, renderResult = value.renderResult;
	assert.ok(renderCall); assert.ok(renderResult); return { ...value, renderCall, renderResult };
}
function call(name: string, args: unknown, expanded = false): string {
	return card(name).renderCall(args, theme, { ...context as object, expanded } as never).render(120).join("\n");
}
function result(name: string, details: unknown, expanded = false, isError = false): string {
	return card(name).renderResult({ content: [], details }, { expanded } as never, theme, { ...context as object, isError } as never).render(120).join("\n");
}
test("Markdown display records share stable renderers across ordinary and attached tools", () => {
	const publication = toolDisplay();
	assert.equal(publication.version, 1);
	assert.deepEqual(publication.tools.map(({ name }) => name), ["markdown_publish", "markdown_read", "markdown_live"]);
	for (const value of publication.tools) assert.deepEqual(Object.keys(value).sort(), ["name", "renderCall", "renderResult"]);
	const publish = createPublishTool({ store: new MarkdownStore("/unused") });
	const live = createLiveTool(async () => undefined);
	assert.equal(publish.renderCall, card("markdown_publish").renderCall);
	assert.equal(publish.renderResult, card("markdown_publish").renderResult);
	assert.equal(live.renderCall, card("markdown_live").renderCall);
	assert.equal(live.renderResult, card("markdown_live").renderResult);
});
test("collapsed calls use tool names and concise subjects without document bodies", () => {
	const text = call("markdown_publish", { title: "A document", text: "private document body" });
	assert.match(text, /^markdown_publish · A document/u);
	assert.match(text, /ctrl\+o to expand arguments/u);
	assert.doesNotMatch(text, /private document body/u);
	assert.match(call("markdown_read", { kind: "published", query: "guide" }), /markdown_read · find published · guide/u);
	assert.match(call("markdown_live", { op: "apply", handle: "exact-handle", edits: [{ replacement: "not in the heading" }] }), /markdown_live · apply exact-handle/u);
	assert.doesNotMatch(call("markdown_live", { op: "apply", edits: [{ replacement: "not in the heading" }] }), /not in the heading/u);
	assert.match(call("markdown_publish", { title: "A document", text: "private document body" }, true), /private document body/u);
});
test("outcome cards preserve useful state and keep navigation ceremony out of collapsed results", () => {
	const saved = result("markdown_publish", { ok: true, documentId: "md-12345678901234567890", revision: 2, bytes: 100 });
	assert.match(saved, /Saved md-12345678901234567890 · revision 2 · 100 bytes/u);
	assert.doesNotMatch(saved, /Owner views|\/markdown|No window opened/u);
	assert.match(result("markdown_read", { op: "find", matched: 2, scanned: 8, bounded: true, unreadable: 1 }), /2 matched · 8 scanned · scan bounded · 1 unreadable/u);
	assert.match(result("markdown_live", { status: "ok", panes: [{ handle: "one" }] }), /1 connected pane/u);
	assert.match(result("markdown_live", { status: "ok", source: "hidden body", generation: 3, offset: 0, nextOffset: 20 }), /Read live source · generation 3 · offset 0 · next 20/u);
	assert.doesNotMatch(result("markdown_live", { status: "ok", source: "hidden body", generation: 3 }), /hidden body/u);
	assert.match(result("markdown_live", { status: "applied", generation: 4, retained: true }), /Applied · generation 4 · recovery retained/u);
	assert.match(result("markdown_live", { status: "stale", message: "Read the current buffer." }), /stale: Read the current buffer/u);
	assert.match(result("markdown_publish", { ok: false, error: { message: "Revision changed." } }), /Revision changed/u);
});
test("expanded cards show bounded escaped evidence and reuse the native component", () => {
	const unsafe = "title\u001b[31m\u202e";
	for (const expanded of [false, true]) {
		assert.doesNotMatch(call("markdown_publish", { title: unsafe, text: unsafe }, expanded), /[\u001b\u202e]/u);
		assert.doesNotMatch(result("markdown_live", { status: "error", message: unsafe }, expanded), /[\u001b\u202e]/u);
	}
	const shown = result("markdown_live", { status: "ok", source: "x".repeat(50_000), generation: 0 }, true);
	assert.match(shown, /Display limit/u); assert.ok(shown.length < 34_000);
	const previous = new Text("old", 0, 0);
	const reused = card("markdown_live").renderCall({ op: "list" }, theme, { ...context as object, lastComponent: previous } as never);
	assert.equal(reused, previous);
	const withoutKey = card("markdown_read").renderCall({}, theme, {} as never).render(120).join("\n");
	assert.match(withoutKey, /Expand for arguments/u); assert.doesNotMatch(withoutKey, /ctrl\+o/u);
});
test("retained JSON results remain readable when structured details are absent", () => {
	const rendered = card("markdown_live").renderResult({ content: [{ type: "text", text: JSON.stringify({ status: "applied", generation: 5, retained: true }) }], details: undefined }, { expanded: false } as never, theme, context).render(120).join("\n");
	assert.match(rendered, /Applied · generation 5 · recovery retained/u);
});
