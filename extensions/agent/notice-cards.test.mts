import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { it } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { initTheme, keyHint, keyText, type ExtensionAPI, type MessageRenderer, type Theme } from "@earendil-works/pi-coding-agent";
import { planningBudgetSelfBody, planningBudgetSelfFacts } from "./continuity-budget.ts";
import register from "./index.ts";
import { PLANNING_BUDGET_NOTICE } from "./ordinary-continuity.ts";
import { SELF_COMPACTION_NOTICE } from "./self-compaction.ts";
import { renderAgentCompactionMessage, renderAgentPlanningBudgetMessage } from "./tool-cards.ts";

initTheme("dark", false);
const nativeTui = await import(createRequire(import.meta.resolve("@earendil-works/pi-coding-agent")).resolve("@earendil-works/pi-tui"));
function expandKey(t: { after(fn: () => void): void }): void {
	const previous = nativeTui.getKeybindings();
	nativeTui.setKeybindings(new nativeTui.KeybindingsManager({ ...nativeTui.TUI_KEYBINDINGS, "app.tools.expand": { defaultKeys: "ctrl+o", description: "Expand tool output" } }));
	t.after(() => nativeTui.setKeybindings(previous));
}
const colors: Array<{ color: string; value: string }> = [];
const theme = { fg: (color: string, value: string) => { colors.push({ color, value }); return value; }, bg: (_color: string, value: string) => value, getBgAnsi: () => "", bold: (value: string) => value } as unknown as Theme;

function render(renderer: MessageRenderer, customType: string, content: string, expanded = false): string[] {
	const message = { role: "custom" as const, customType, display: true, timestamp: 0, content };
	const component = renderer(message, { expanded, outputPad: 1, keyText, keyHint }, theme);
	assert.ok(component);
	return component.render(80).map((line) => stripVTControlCharacters(line).trimEnd());
}

it("the ordinary entry registers a renderer for each displayed agent message", async () => {
	const renderers = new Map<string, unknown>();
	await register({ events: { emit() {}, on: () => () => {} }, on: () => () => {}, registerTool() {}, registerCommand() {}, registerShortcut() {}, registerMessageRenderer: (type: string, renderer: unknown) => renderers.set(type, renderer), registerToolRenderer() {}, getThinkingLevel: () => "off" } as unknown as ExtensionAPI);
	assert.equal(renderers.get(SELF_COMPACTION_NOTICE), renderAgentCompactionMessage);
	assert.equal(renderers.get(PLANNING_BUDGET_NOTICE), renderAgentPlanningBudgetMessage);
	assert.ok(renderers.has("agent.peer"));
});

it("a preempted self-compaction shows the [agent] label in Pi's label colour and the whole notice", (t) => {
	expandKey(t);
	colors.length = 0;
	const content = "Self-compaction was not applied because an earlier boundary handler already proposed compaction. Inspect the current context before another request.";
	const lines = render(renderAgentCompactionMessage, SELF_COMPACTION_NOTICE, content);
	assert.equal(lines[1], " [agent] Compaction not applied");
	assert.equal(lines[2], "");
	assert.match(lines.slice(3).join(" "), /Self-compaction was not applied .* another request\./u);
	assert.doesNotMatch(lines.join("\n"), /to expand/u);
	assert.deepEqual(colors.filter(({ color }) => color === "customMessageLabel").map(({ value }) => value), ["[agent]"]);
});

it("a long notice collapses to three preview lines with the expansion hint and expands to the full text", (t) => {
	expandKey(t);
	const content = ["First line", "", "Second line", "", "Third line", "", "Fourth line", "", "Fifth line"].join("\n");
	const collapsed = render(renderAgentCompactionMessage, SELF_COMPACTION_NOTICE, content);
	assert.deepEqual(collapsed.slice(3, 7), [" First line", "", " Second line", " ... (6 more lines, ctrl+o to expand)"]);
	const expanded = render(renderAgentCompactionMessage, SELF_COMPACTION_NOTICE, content, true).join("\n");
	for (const line of ["First line", "Third line", "Fifth line"]) assert.ok(expanded.includes(line), line);
	assert.doesNotMatch(expanded, /to expand/u);
});

it("a planning-budget notice names the crossing, the tokens and the model from its own text", (t) => {
	expandKey(t);
	const content = planningBudgetSelfBody(210_000, 200_000, "provider/model-6.1", Date.UTC(2026, 10, 15));
	assert.deepEqual(planningBudgetSelfFacts(content), { tokens: 210_000, budget: 200_000, model: "provider/model-6.1" });
	const lines = render(renderAgentPlanningBudgetMessage, PLANNING_BUDGET_NOTICE, content);
	assert.deepEqual(lines.slice(1, 4), [" [agent] Planning budget reached", " 210000 of 200000 tokens · provider/model-6.1", ""]);
	assert.match(lines.slice(4).join(" "), /Context use reached 210000 tokens/u);
	assert.equal(planningBudgetSelfFacts("Another text."), undefined);
	assert.deepEqual(render(renderAgentPlanningBudgetMessage, PLANNING_BUDGET_NOTICE, "Another text.").slice(1, 4), [" [agent] Planning budget reached", "", " Another text."], "unknown facts add no second header line");
});

it("terminal control sequences in a notice never reach the card", (t) => {
	expandKey(t);
	const content = "Notice \x1b[31mred\x1b[0m \x1b]0;title\x07 end";
	for (const renderer of [renderAgentCompactionMessage, renderAgentPlanningBudgetMessage]) {
		for (const expanded of [false, true]) {
			const component = renderer({ role: "custom", customType: "fixture", display: true, timestamp: 0, content }, { expanded, outputPad: 1, keyText, keyHint }, theme);
			assert.ok(component);
			assert.doesNotMatch(component.render(80).join("\n"), /\x1b\]|\x07|\x1b\[31m/u);
		}
	}
});
