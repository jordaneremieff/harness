import assert from "node:assert/strict";
import { test } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { validateToolArguments } from "@earendil-works/pi-ai";
import { initTheme, type ToolDefinition, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { KeybindingsManager, setKeybindings, type TUI, visibleWidth } from "@earendil-works/pi-tui";
import { toolDisplay } from "./display.ts";
import type { EditResult } from "./protocol.ts";
import { EditParameters, editDisplay, executeConfigTool } from "./tools.ts";

initTheme("dark");
const bindings = (keys: "ctrl+o" | []) =>
	setKeybindings(new KeybindingsManager({ "app.tools.expand": { defaultKeys: keys } }));
bindings("ctrl+o");

const name = "config_edit";
function definition(toolName: string): ToolDefinition {
	const renderer = toolDisplay().tools.find((item) => item.name === toolName);
	assert.ok(renderer);
	return {
		...renderer,
		label: "Config",
		description: "Config settings",
		parameters: {} as ToolDefinition["parameters"],
		execute: async () => {
			throw new Error("Display cannot execute.");
		},
	};
}
const args = {
	mode: "commit",
	changes: [{ id: "pi:/hideThinkingBlock", action: "set", value: true, scope: "global" }],
};
const tui = { requestRender() {} } as TUI;
function card(input: unknown = args, toolName = name) {
	return new ToolExecutionComponent(toolName, "config-1", input, {}, definition(toolName), tui, "/");
}

function receiptOnly(component: ToolExecutionComponent, value: unknown) {
	component.updateResult({ content: [{ type: "text", text: JSON.stringify(value) }], isError: false });
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
const executeEdit = (value: EditResult) => executeConfigTool(name, () => value, editDisplay);

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
	assert.ok(expanded.includes("global: settings.json (committed)"));
	assert.ok(expanded.some((row) => row.includes("[withheld]")));
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

test("an error preserves its cause; a lost edit receipt preserves the known outcome", async () => {
	const component = card();
	const failure = await executeConfigTool(
		name,
		() => {
			throw new Error("The settings file is unreadable.");
		},
		editDisplay,
	);
	assert.equal(failure.isError, true);
	assert.deepEqual(failure.content, [{ type: "text", text: '{"error":"The settings file is unreadable."}' }]);
	settle(component, failure);
	assert.ok(screen(component).includes("The settings file is unreadable."));
	const document = receipt.documents[0];
	const largeChange = document.changes[0];
	const oversized = await executeEdit({
		...receipt,
		documents: [
			{
				...document,
				changes: Array.from({ length: 4 }, (_, i) => ({
					...largeChange,
					id: `custom:/sample${i}`,
					resolved: { source: "machine", value: "x".repeat(25_000) },
				})),
			},
		],
	});
	assert.equal(oversized.isError, true);
	assert.deepEqual(oversized.content, [
		{
			type: "text",
			text: '{"error":"Edit mode commit returned committed. The edit receipt exceeds 98304 bytes. Read the settings before another edit."}',
		},
	]);
	settle(component, oversized);
	const oversizeRows = screen(component);
	assert.ok(oversizeRows.includes("The edit receipt exceeds 98304 bytes. Read the settings before another edit."));
	assert.ok(oversizeRows.includes("Saved the settings."));
	assert.ok(oversizeRows.includes("[Result exceeded the output limit; complete details were not retained.]"));
});

test("the edit card withholds bare Pi diagnostics that include supplied values", () => {
	const value = "supplied-value";
	const base = "supplied-base";
	const description = "supplied-description";
	const input = {
		mode: "invalid",
		changes: [{ ...args.changes[0], value, base: { present: true, value: base }, description }],
	};
	const tool = { name, description: "Edit settings", parameters: EditParameters };
	const call = { type: "toolCall" as const, name, id: "edit-invalid", arguments: input };
	const cases = [
		{ call, echoed: [value, base, description] },
		{ call: { ...call, argumentsError: `Invalid input: ${value}` }, echoed: [value] },
	];
	for (const sample of cases) {
		assert.throws(
			() => validateToolArguments(tool, sample.call),
			(error) => {
				assert.ok(error instanceof Error);
				const original = error.message;
				for (const text of sample.echoed) assert.ok(original.includes(text));
				// Match the host carrier: an error flag and bare text with no Config result details.
				const result = { content: [{ type: "text", text: original }], isError: true };
				const component = card(input);
				component.updateResult(result);
				for (const expanded of [false, true]) {
					component.setExpanded(expanded);
					const rendered = screen(component).join("\n");
					assert.match(rendered, /diagnostic is withheld/);
					assert.doesNotMatch(rendered, /supplied-|(?:not )?saved|committed/i);
				}
				assert.equal(result.content[0].text, original);
				return true;
			},
		);
	}
});

test("retained edit envelopes recover the same outcome without echoing withheld inputs or result values", () => {
	const sentinel = "sample-withheld";
	const input = {
		...args,
		changes: [{ ...args.changes[0], value: sentinel, base: { present: true, value: sentinel } }],
	};
	const component = card(input);
	receiptOnly(component, receipt);
	const collapsed = screen(component);
	assert.ok(collapsed.includes("Saved the settings."));
	assert.ok(collapsed.some((row) => row.includes("/reload")));
	component.setExpanded(true);
	assert.doesNotMatch(screen(component).join("\n"), new RegExp(sentinel));

	receiptOnly(component, { mode: "commit", outcome: "committed", documents: "not a receipt" });
	assert.ok(screen(component).includes("Config returned an unrecognised receipt."));
});

test("config_find states coverage, keeps at most five match rows and gives the exact continuation", () => {
	const input = { query: "thinking", group: "pi", limit: 8 };
	const component = card(input, "config_find");
	assert.deepEqual(hints(screen(component)), []);
	receiptOnly(component, {
		total: 9,
		offset: 0,
		next: 8,
		coverage: ["One owner did not respond."],
		rows: Array.from({ length: 8 }, (_, i) => ({ id: `pi:/setting${i}`, label: `Setting ${i}`, source: "global" })),
	});
	const collapsed = screen(component);
	assert.ok(collapsed.includes("Returned matches 1–8 of 9. More matches are available."));
	assert.ok(collapsed.includes("[Discovery coverage is partial.]"));
	assert.equal(collapsed.filter((row) => row.startsWith("pi:/setting")).length, 5);
	assert.deepEqual(hints(collapsed), ["... (3 more lines, ctrl+o to expand)"]);
	component.setExpanded(true);
	assert.ok(
		screen(component).includes('Next call: config_find {"query":"thinking","group":"pi","limit":8,"offset":8}'),
	);
	assert.ok(screen(component).includes("One owner did not respond."));
	assert.deepEqual(hints(screen(component)), []);
});

test("config_get shows secret set-state, reports absent IDs, and distinguishes saved from loaded values", () => {
	const secret = "sample-withheld";
	const component = card({ ids: ["harness:/demo/secret", "pi:/theme", "pi:/missing"] }, "config_get");
	receiptOnly(component, {
		entries: [
			{
				id: "harness:/demo/secret",
				env: { name: "EXAMPLE_SECRET", set: true, secret: true },
				resolved: { value: secret, source: "env" },
				saved: { machine: { present: true, value: secret } },
				default: { value: secret },
			},
			{
				id: "pi:/theme",
				resolved: { value: "light", source: "global" },
				session: { value: "dark", differs: true },
				saved: { global: { present: true, value: "light" } },
			},
		],
		missing: ["pi:/missing"],
	});
	const collapsed = screen(component);
	assert.ok(collapsed.includes("Read 2 settings. 1 requested ID not found."));
	assert.ok(collapsed.includes("harness:/demo/secret: set in the environment; value withheld."));
	assert.ok(collapsed.includes("pi:/theme: resolved from global; loaded value differs."));
	component.setExpanded(true);
	const expanded = screen(component);
	assert.ok(expanded.includes('global: "light"'));
	assert.ok(expanded.includes('loaded: "dark"'));
	assert.doesNotMatch(expanded.join("\n"), new RegExp(secret));
});

test("config_get identifies an individually omitted value without reporting a failed read", () => {
	const component = card({ ids: ["custom:/large"] }, "config_get");
	receiptOnly(component, {
		entries: [
			{
				id: "custom:/large",
				resolved: {
					source: "machine",
					value: {
						omitted: "The value exceeds 32768 bytes; open it in /config.",
					},
				},
			},
		],
		missing: [],
	});
	const collapsed = screen(component);
	assert.ok(collapsed.includes("Read 1 setting."));
	assert.ok(collapsed.includes("[Values over 32768 bytes were not retained. Open them in /config.]"));
	component.setExpanded(true);
	assert.ok(screen(component).includes("resolved: [Value not retained]"));
});

test("config_tools separates the session selection, configured defaults, and refused or unconfirmed effects", () => {
	const component = card({ activate: ["grep", "absent"] }, "config_tools");
	const ordinary = {
		session: true,
		active: ["grep"],
		tools: [{ name: "grep", exposure: "deferred", active: true }],
		defaults: { resolved: ["read"] },
	};
	receiptOnly(component, { ...ordinary, change: { applied: true, activated: ["grep"] } });
	assert.ok(screen(component).includes("Pi activated 1 tool."));
	receiptOnly(component, {
		...ordinary,
		change: {
			applied: true,
			activated: ["grep"],
			deactivated: ["bash", "ls"],
			rejected: [{ name: "absent", reason: "Tool not found." }],
		},
	});
	const rows = screen(component);
	assert.ok(rows.includes("Pi activated 1 tool and deactivated 2 tools; rejected 1 tool name."));
	assert.ok(rows.includes("Pi activated grep."));
	assert.ok(rows.includes("Pi deactivated bash, ls."));
	assert.ok(rows.includes("Pi rejected absent. Tool not found."));
	assert.ok(rows.includes("This session selects grep."));
	assert.ok(rows.includes("New sessions default to read."));
	assert.doesNotMatch(
		rows.join("\n"),
		/(?:Activated|Deactivated|Selected in this session|Configured for new sessions):/u,
	);
	receiptOnly(component, { ...ordinary, change: { applied: false, activated: ["grep"] } });
	assert.ok(screen(component).includes("Pi did not confirm the full session selection."));
	assert.ok(screen(component).includes("[Some requested effects were not confirmed.]"));
	const empty = { ...ordinary, active: [], tools: [] };
	receiptOnly(component, { ...empty, defaults: { resolved: [] } });
	assert.ok(screen(component).includes("This session selects no tools."));
	assert.ok(screen(component).includes("No tools are configured for new sessions."));
	receiptOnly(component, { ...empty, session: false });
	const unavailable = screen(component);
	assert.ok(unavailable.includes("This host exposes no current-session tool controls."));
	assert.ok(unavailable.includes("New sessions default to read."));
	assert.ok(!unavailable.includes("This session selects no tools."));
	assert.deepEqual(hints(unavailable), []);
});
