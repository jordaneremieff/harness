import assert from "node:assert/strict";
import { test } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { initTheme, type ToolDefinition, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { KeybindingsManager, setKeybindings, type TUI, visibleWidth } from "@earendil-works/pi-tui";
import { toolDisplay } from "./display.ts";
import type { EditResult } from "./protocol.ts";
import { describeConfigEdit, executeConfigTool } from "./tools.ts";

initTheme("dark");
const bindings = (keys: "ctrl+o" | []) =>
	setKeybindings(new KeybindingsManager({ "app.tools.expand": { defaultKeys: keys } }));
bindings("ctrl+o");

const [{ name, renderCall, renderResult }] = toolDisplay().tools;
const tool = {
	name,
	label: "Config",
	description: "Edit settings",
	parameters: {} as ToolDefinition["parameters"],
	execute: async () => {
		throw new Error("Display cannot execute.");
	},
	renderCall,
	renderResult,
} satisfies ToolDefinition;
const args = {
	mode: "commit",
	changes: [{ id: "pi:/hideThinkingBlock", action: "set", value: true, scope: "global" }],
};
const tui = { requestRender() {} } as TUI;
function card(input: unknown = args) {
	return new ToolExecutionComponent(name, "edit-1", input, {}, tool, tui, "/");
}
function screen(component: ToolExecutionComponent, width = 110): string[] {
	const rows = component.render(width).map((row) => stripVTControlCharacters(row).trimEnd());
	assert.ok(rows.every((row) => visibleWidth(row) <= width));
	return rows.map((row) => row.trimStart());
}
function hints(rows: string[]) {
	return rows.filter((row) => row.startsWith("... ("));
}

const receipt: EditResult = {
	mode: "commit",
	outcome: "committed",
	summary: "Saved Hide thinking in Pi global settings.",
	documents: [
		{
			document: "pi-global",
			scope: "global",
			path: "settings.json",
			outcome: "committed",
			before: null,
			after: "revision",
			changes: [
				{
					id: "pi:/hideThinkingBlock",
					scope: "global",
					action: "set",
					status: "ok",
					problems: [],
					notes: [],
					apply: {
						state: "pending-reload",
						text: "This session still uses its loaded value. /reload loads the saved settings.",
					},
				},
			],
		},
	],
};
const executeEdit = (value: EditResult) => executeConfigTool(name, () => value, describeConfigEdit);

function settle(component: ToolExecutionComponent, result: Awaited<ReturnType<typeof executeEdit>>) {
	component.updateResult({ ...result, isError: result.isError === true });
}

test("Pi draws a single hint after the call, then after the result, and none when expanded", async () => {
	const component = card();
	const call = screen(component);
	assert.deepEqual(call.filter(Boolean), [
		"config_edit pi:/hideThinkingBlock",
		"save · 1 change · global",
		"... (ctrl+o to expand)",
	]);
	component.updateResult({ content: [], isError: false }, true);
	const partial = screen(component);
	assert.deepEqual(hints(partial), ["... (ctrl+o to expand)"]);
	assert.ok(partial.indexOf("Saving settings…") < partial.indexOf(hints(partial)[0]));

	const result = await executeEdit(receipt);
	assert.deepEqual(result.content, [{ type: "text", text: JSON.stringify(receipt) }]);
	settle(component, result);
	const settled = screen(component);
	assert.deepEqual(hints(settled), ["... (ctrl+o to expand)"]);
	assert.equal(settled[settled.indexOf("Saved the settings.") - 1], "");
	assert.ok(
		settled.includes(
			"pi:/hideThinkingBlock: This session still uses its loaded value. /reload loads the saved settings.",
		),
	);
	assert.equal(
		settled.some((row) => row.includes('"outcome"')),
		false,
	);
	assert.equal(settled.filter(Boolean).at(-1), hints(settled)[0]);

	component.setExpanded(true);
	const expanded = screen(component);
	assert.deepEqual(hints(expanded), []);
	assert.ok(expanded.includes("mode: commit"));
	assert.ok(expanded.some((row) => row.includes('"outcome":"committed"')));
	assert.ok(
		expanded.includes(
			"pi:/hideThinkingBlock: This session still uses its loaded value. /reload loads the saved settings.",
		),
	);
});

test("preview, partial save, and racing readback do not claim a live effect", async () => {
	for (const [value, expected, forbidden] of [
		[
			{ ...receipt, mode: "preview", outcome: "previewed", summary: "The change is valid." },
			"Preview passed validation; no settings were saved.",
			/\/reload/,
		],
		[{ ...receipt, outcome: "partial" }, "Saved only some of the changes.", /Saved the settings\./],
		[
			{
				...receipt,
				documents: [
					{ ...receipt.documents[0], error: "Another writer changed the file right after this write; read it again." },
				],
			},
			"Another writer changed the file right after this write; read it again.",
			/\/reload/,
		],
	] satisfies [EditResult, string, RegExp][]) {
		const component = card({ ...args, mode: value.mode });
		settle(component, await executeEdit(value));
		const collapsed = screen(component).join("\n");
		assert.ok(collapsed.includes(expected));
		assert.doesNotMatch(collapsed, forbidden);
	}
});

test("preview caps a single long body line at five visual rows and reports the rest", async () => {
	const component = card({ ...args, changes: [{ ...args.changes[0], id: `pi:/${"long".repeat(55)}` }] });
	settle(component, await executeEdit({ ...receipt, summary: `\x1b[31m${"x".repeat(700)}\x1b[0m` }));
	const narrow = screen(component, 48).filter(Boolean);
	assert.match(narrow[0], /^config_edit pi:\/long.*…$/);
	assert.equal(narrow.filter((row) => /^x+$/.test(row)).length, 5);
	assert.equal(narrow.at(-1), "... (14 more lines, ctrl+o to expand)");
	assert.doesNotMatch(narrow.join("\n"), /\[31m/);
});

test("a missing key omits the pre-result hint and offers a click after settlement", async (t) => {
	bindings([]);
	t.after(() => bindings("ctrl+o"));
	const component = card();
	assert.deepEqual(hints(screen(component)), []);
	settle(component, await executeEdit(receipt));
	assert.deepEqual(hints(screen(component)), ["... (click to expand)"]);
});

test("an execution error shows its diagnostic; an oversized result retains the model envelope", async () => {
	const component = card();
	const failure = await executeConfigTool(
		name,
		() => {
			throw new Error("The settings file is unreadable.");
		},
		describeConfigEdit,
	);
	assert.equal(failure.isError, true);
	assert.deepEqual(failure.content, [{ type: "text", text: '{"error":"The settings file is unreadable."}' }]);
	settle(component, failure);
	assert.ok(screen(component).includes("The settings file is unreadable."));
	const oversized = await executeEdit({ ...receipt, requestId: "x".repeat(100_000) });
	assert.equal(oversized.isError, undefined);
	assert.deepEqual(oversized.content, [
		{ type: "text", text: '{"error":"The result exceeds 98304 bytes; request fewer ids or a smaller page."}' },
	]);
	settle(component, oversized);
	assert.ok(screen(component).includes("[Result exceeded the output limit; complete details were not retained.]"));
});
