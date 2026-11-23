import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { it } from "node:test";
import { stripVTControlCharacters } from "node:util";
import {
	CustomMessageComponent,
	initTheme,
	keyHint,
	keyText,
	type ExtensionAPI,
	type MessageRenderer,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import { planningBudgetSelfBody, planningBudgetSelfFacts } from "./continuity-budget.ts";
import register from "./index.ts";
import { PLANNING_BUDGET_NOTICE } from "./ordinary-continuity.ts";
import { SELF_COMPACTION_NOTICE } from "./self-compaction.ts";
import {
	renderAgentApplicationMessage,
	renderAgentCompactionMessage,
	renderAgentPeerMessage,
	renderAgentPlanningBudgetMessage,
} from "./tool-cards.ts";

initTheme("dark", false);
const piTheme = (
	await import(
		new URL("./modes/interactive/theme/theme.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href
	)
).theme as Theme;
const nativeTui = await import(
	createRequire(import.meta.resolve("@earendil-works/pi-coding-agent")).resolve("@earendil-works/pi-tui")
);
function expandKey(t: { after(fn: () => void): void }): void {
	const previous = nativeTui.getKeybindings();
	nativeTui.setKeybindings(
		new nativeTui.KeybindingsManager({
			...nativeTui.TUI_KEYBINDINGS,
			"app.tools.expand": { defaultKeys: "ctrl+o", description: "Expand tool output" },
		}),
	);
	t.after(() => nativeTui.setKeybindings(previous));
}
const colors: Array<{ color: string; value: string }> = [];
const theme = {
	fg: (color: string, value: string) => {
		colors.push({ color, value });
		return value;
	},
	bg: (_color: string, value: string) => value,
	getBgAnsi: () => "",
	bold: (value: string) => value,
} as unknown as Theme;

function render(
	renderer: MessageRenderer,
	customType: string,
	content: string,
	expanded = false,
	details?: unknown,
): string[] {
	const message = { role: "custom" as const, customType, display: true, timestamp: 0, content, details };
	const component = renderer(message, { expanded, outputPad: 1, keyText, keyHint }, theme);
	assert.ok(component);
	return component.render(80).map((line) => stripVTControlCharacters(line).trimEnd());
}

it("the ordinary entry registers a renderer for each displayed agent message", async () => {
	const renderers = new Map<string, unknown>();
	await register({
		events: { emit() {}, on: () => () => {} },
		on: () => () => {},
		registerTool() {},
		registerCommand() {},
		registerShortcut() {},
		registerMessageRenderer: (type: string, renderer: unknown) => renderers.set(type, renderer),
		registerToolRenderer() {},
		getThinkingLevel: () => "off",
	} as unknown as ExtensionAPI);
	assert.equal(renderers.get("application-message"), renderAgentApplicationMessage);
	assert.equal(renderers.get(SELF_COMPACTION_NOTICE), renderAgentCompactionMessage);
	assert.equal(renderers.get(PLANNING_BUDGET_NOTICE), renderAgentPlanningBudgetMessage);
	assert.ok(renderers.has("agent.peer"));
});

it("shows the application, its request facts and a preview of the body without changing the message", (t) => {
	expandKey(t);
	const header = "[Notebook] #a2b3c4d5 · follows #f0e1d2c3 · Notes · pane 42 · reply in your final message";
	const message = {
		role: "custom" as const,
		customType: "application-message",
		display: true,
		timestamp: 0,
		details: {
			version: 1,
			source: "notebook",
			application: "Notebook",
			subject: "Notes",
			place: "pane 42",
			id: "A2B3C4D5-9841-4DCA-9911-D6F18AFABF4F",
			follows: "F0E1D2C3-9841-4DCA-9911-D6F18AFABF4F",
			reply: "final",
		},
		content: `${header}\n\n\x1b[31m**Body preview**\x1b[0m\r\n\r\nSecond paragraph.\n\nThird paragraph.\n\nLast 👩‍💻 paragraph.`,
	};
	const before = structuredClone(message);
	const show = (expanded: boolean) => {
		const component = renderAgentApplicationMessage(message, { expanded, outputPad: 1, keyText, keyHint }, theme);
		assert.ok(component);
		const lines = component.render(120);
		assert.doesNotMatch(lines.join("\n"), /\x1b\[31m|\r|\u200d/u);
		return lines.map((line) => stripVTControlCharacters(line).trimEnd()).join("\n");
	};
	const collapsed = show(false);
	assert.match(collapsed, /\[agent\] Notebook · Notes\n #a2b3c4d5 · follows #f0e1d2c3 · reply requested · pane 42/u);
	assert.match(collapsed, /Body preview/u);
	assert.doesNotMatch(collapsed, /\[Notebook\]|Last/u);
	assert.match(collapsed, /to expand/u);
	const expanded = show(true);
	assert.ok(expanded.includes(header));
	assert.match(expanded, /Last 👩💻 paragraph\./u);
	assert.equal(expanded.match(/Body preview/gu)?.length, 1);
	assert.deepEqual(message, before);
});

it("shows a message without a reply, predecessor or place", () => {
	const lines = render(
		renderAgentApplicationMessage,
		"application-message",
		"[Notebook] #abcd1234 · Notes · no reply needed\n\nSaved.",
		false,
		{
			version: 1,
			source: "notebook",
			application: "Notebook",
			id: "ABCD1234-1234-4111-8111-111111111111",
			subject: "Notes",
			reply: "none",
		},
	);
	assert.deepEqual(lines.slice(1, 5), [" [agent] Notebook · Notes", " #abcd1234 · no reply needed", "", " Saved."]);
});

it("a preempted self-compaction shows the [agent] label in Pi's label colour and the whole notice", (t) => {
	expandKey(t);
	colors.length = 0;
	const content =
		"Self-compaction was not applied because an earlier boundary handler already proposed compaction. Inspect the current context before another request.";
	const lines = render(renderAgentCompactionMessage, SELF_COMPACTION_NOTICE, content);
	assert.equal(lines[1], " [agent] Compaction not applied");
	assert.equal(lines[2], "");
	assert.match(lines.slice(3).join(" "), /Self-compaction was not applied .* another request\./u);
	assert.doesNotMatch(lines.join("\n"), /to expand/u);
	assert.deepEqual(
		colors.filter(({ color }) => color === "customMessageLabel").map(({ value }) => value),
		["[agent]"],
	);
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
	assert.deepEqual(lines.slice(1, 4), [
		" [agent] Planning budget reached",
		" 210000 of 200000 tokens · provider/model-6.1",
		"",
	]);
	assert.match(lines.slice(4).join(" "), /Context use reached 210000 tokens/u);
	assert.equal(planningBudgetSelfFacts("Another text."), undefined);
	assert.deepEqual(
		render(renderAgentPlanningBudgetMessage, PLANNING_BUDGET_NOTICE, "Another text.").slice(1, 4),
		[" [agent] Planning budget reached", "", " Another text."],
		"unknown facts add no second header line",
	);
});

it("terminal control sequences in a notice never reach the card", (t) => {
	expandKey(t);
	const content = "Notice \x1b[31mred\x1b[0m \x1b]0;title\x07 end";
	for (const renderer of [renderAgentCompactionMessage, renderAgentPlanningBudgetMessage]) {
		for (const expanded of [false, true]) {
			const component = renderer(
				{ role: "custom", customType: "fixture", display: true, timestamp: 0, content },
				{ expanded, outputPad: 1, keyText, keyHint },
				theme,
			);
			assert.ok(component);
			assert.doesNotMatch(component.render(80).join("\n"), /\x1b\]|\x07|\x1b\[31m/u);
		}
	}
});

/** Every reset inside a row restores the message background, so the row background never breaks. */
function assertContinuousBackground(row: string, background: string): void {
	assert.ok(row.startsWith(background), "the row starts on the message background");
	const body = row.endsWith("\x1b[49m") ? row.slice(0, -5) : row;
	for (const match of body.matchAll(/\x1b\[(?:0|49)?m/gu))
		assert.ok(
			body.startsWith(background, (match.index ?? 0) + match[0].length),
			`a reset at ${match.index} restores the background`,
		);
}

it("peer, communication and notice hints dim the key, mute the rest and keep the row background", (t) => {
	expandKey(t);
	const background = piTheme.getBgAnsi("customMessageBg");
	const dim = piTheme.getFgAnsi("dim");
	const muted = piTheme.getFgAnsi("muted");
	const content = ["First line", "", "Second line", "", "Third line"].join("\n");
	for (const [renderer, details] of [
		[renderAgentPeerMessage, { kind: "report", name: "Parser review" }],
		[renderAgentCompactionMessage, undefined],
	] as const) {
		const component = new CustomMessageComponent(
			{ role: "custom", customType: "fixture", display: true, timestamp: 0, content, details },
			renderer as MessageRenderer,
		);
		const rows = component.render(80);
		const hint = rows.find((row) => stripVTControlCharacters(row).includes("to expand"));
		assert.ok(hint);
		assert.equal(stripVTControlCharacters(hint).trim(), "... (2 more lines, ctrl+o to expand)");
		assert.ok(hint.includes(`${dim}ctrl+o`), "the key is dimmed");
		assert.ok(hint.includes(`${muted}... (2 more lines, `), "the rest is muted");
		for (const row of rows.filter((line) => line.length > 0)) assertContinuousBackground(row, background);
	}
});

it("message cards remove control sequences and keep tabs", () => {
	const content = "Tab\there \x1b[31mred\x1b[0m \u202ebidi\u202c";
	const lines = render(renderAgentCompactionMessage, SELF_COMPACTION_NOTICE, content);
	assert.match(lines.join("\n"), /Tab\s+here red bidi/u);
	assert.doesNotMatch(lines.join("\n"), /\\u\{|\\t|\x1b\[31m|\u202e/u, "no visible escape text and no raw control");
});
