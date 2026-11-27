import assert from "node:assert/strict";
import test from "node:test";
import { stripVTControlCharacters } from "node:util";
import { initTheme, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { toolDisplay } from "./display.ts";
import { outcomeText, type ShowOutcome } from "./show.ts";

initTheme("dark", false);

function card(args: Record<string, unknown>, outcome: ShowOutcome) {
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
	component.updateResult({
		details: outcome,
		content: [{ type: "text", text: outcomeText(outcome) }],
		isError: !outcome.ok,
	});
	return {
		component,
		rows: () =>
			component
				.render(110)
				.map((row) => stripVTControlCharacters(row).trim())
				.filter(Boolean),
	};
}

test("the card distinguishes app pane preparation from pane creation", () => {
	const { component, rows } = card(
		{ app: "Brave", url: "https://example.test/" },
		{
			ok: true,
			label: "Brave",
			app: { name: "Brave", path: "/Applications/Brave.app", browser: true, running: false },
			show: ["AppPane", "--app", "/Applications/Brave.app", "--url", "https://example.test/"],
		},
	);
	assert.deepEqual(rows().slice(0, 2), ["apps_show Brave", "Prepared Brave for a new browser window; no pane opened."]);
	assert.equal(rows().length, 3);
	assert.doesNotMatch(rows().join("\n"), /example\.test|Applications/);
	component.setExpanded(true);
	assert.match(rows().join("\n"), /show: \["AppPane","--app"/);
	assert.doesNotMatch(rows().join("\n"), /to expand/);
});

test("the card names ambiguous application selection and discloses candidates", () => {
	const { component, rows } = card(
		{ app: "Notes" },
		{
			ok: false,
			error: '"Notes" matches several applications; name one of them exactly.',
			candidates: [{ name: "Notes", path: "/Applications/Notes.app", browser: false, running: false }],
		},
	);
	assert.match(rows()[1] ?? "", /matches several applications/);
	assert.doesNotMatch(rows().join("\n"), /Applications/);
	component.setExpanded(true);
	assert.match(rows().join("\n"), /Candidates: Notes/);
});
