import assert from "node:assert/strict";
import test from "node:test";
import { stripVTControlCharacters } from "node:util";
import { initTheme, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { toolDisplay } from "./display.ts";
import { contribution } from "./durable.ts";

initTheme("dark", false);

function card(args: Record<string, unknown>) {
	const tool = toolDisplay().tools[0];
	const component = new ToolExecutionComponent(
		tool.name,
		"fixture",
		args,
		undefined,
		tool,
		{ requestRender() {} } as unknown as TUI,
		".",
	);
	return {
		component,
		rows: () =>
			component
				.render(110)
				.map((row) => stripVTControlCharacters(row).trim())
				.filter(Boolean),
	};
}

test("Editor cards distinguish draft changes from disk writes and disclose the receipt", () => {
	const { component, rows } = card({
		op: "edit",
		doc: "notes.md",
		rev: 4,
		find: "private text",
		replace: "another private value",
	});
	const update = (rev: number) =>
		component.updateResult({
			isError: false,
			details: undefined,
			content: [{ type: "text", text: JSON.stringify({ doc: "notes.md", rev, dirty: true }) }],
		});
	update(5);
	assert.deepEqual(rows().slice(0, 2), [
		"editor edit notes.md",
		"Updated the draft (revision 5); nothing saved to disk.",
	]);
	assert.match(rows()[2] ?? "", /to expand/);
	assert.equal(rows().length, 3);
	component.setExpanded(true);
	assert.match(rows().join("\n"), /"dirty": true/);
	assert.doesNotMatch(rows().join("\n"), /private text|private value|to expand/);
	component.setExpanded(false);
	update(4);
	assert.equal(rows()[1], "Draft unchanged (revision 4).");
});

test("Editor cards qualify an empty partial search and retain a safe error", () => {
	const { component, rows } = card({ op: "search", query: "private text" });
	component.updateResult({
		isError: false,
		details: undefined,
		content: [{ type: "text", text: '{"hits":[],"limited":true}' }],
	});
	assert.equal(rows()[1], "No matches found; partial scan.");
	component.updateResult({
		isError: true,
		details: undefined,
		content: [{ type: "text", text: "Invalid selector: private text\x1b[2J" }],
	});
	assert.equal(rows()[1], "The Editor request failed.");
	assert.doesNotMatch(rows().join("\n"), /private text/);
	component.setExpanded(true);
	assert.match(rows().join("\n"), /Invalid selector: private text/);
	assert.doesNotMatch(component.render(110).join("\n"), /\x1b\[2J/u);
});

test("the Editor contribution advertises the same display module", () => {
	assert.deepEqual(contribution(import.meta.url).display, { version: 1, entry: "./display.ts", export: "toolDisplay" });
});
