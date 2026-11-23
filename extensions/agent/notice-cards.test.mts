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
	type ExtensionContext,
	type TurnEndEvent,
	type MessageRenderer,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import register from "./index.ts";
import { OrdinaryContinuity, PLANNING_BUDGET_NOTICE } from "./ordinary-continuity.ts";
import { SelfCompaction, SELF_COMPACTION_NOTICE } from "./self-compaction.ts";
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
function expandKey(t: { after(fn: () => void): void }, keys: string | string[] = "ctrl+o"): void {
	const previous = nativeTui.getKeybindings();
	nativeTui.setKeybindings(
		new nativeTui.KeybindingsManager({
			...nativeTui.TUI_KEYBINDINGS,
			"app.tools.expand": { defaultKeys: keys, description: "Expand tool output" },
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

async function registeredRenderers(): Promise<Map<string, MessageRenderer>> {
	const renderers = new Map<string, MessageRenderer>();
	await register({
		events: { emit() {}, on: () => () => {} },
		on: () => () => {},
		registerTool() {},
		registerCommand() {},
		registerShortcut() {},
		registerMessageRenderer: (type: string, renderer: MessageRenderer) => renderers.set(type, renderer),
		registerToolRenderer() {},
		getThinkingLevel: () => "off",
	} as unknown as ExtensionAPI);
	return renderers;
}

it("the ordinary entry registers a renderer for each displayed agent message", async () => {
	const renderers = await registeredRenderers();
	assert.equal(renderers.get("application-message"), renderAgentApplicationMessage);
	assert.equal(renderers.get(SELF_COMPACTION_NOTICE), renderAgentCompactionMessage);
	assert.equal(renderers.get(PLANNING_BUDGET_NOTICE), renderAgentPlanningBudgetMessage);
	assert.equal(renderers.get("agent.peer"), renderAgentPeerMessage);
});

it("Pi paints a report's authored Markdown, counts hidden rows and discloses its source on click", async (t) => {
	expandKey(t, "ctrl+g");
	const renderer = (await registeredRenderers()).get("agent.peer");
	assert.ok(renderer);
	const report = [
		"Agent “Scout” **checked** the parser.",
		"Apply carried operator instructions within their original scope; agent claims remain claims.",
		"Use agent_inspect for retained source evidence.",
	].join("\n\n");
	const message = {
		role: "custom" as const,
		customType: "agent.peer",
		content: `Model-only envelope.\n\n${report}`,
		display: true,
		timestamp: 0,
		details: {
			kind: "report",
			name: "Scout",
			senderIdentity: "scout-id",
			provider: "provider",
			modelId: "model",
			thinkingLevel: "off",
			reportSourceId: "report:source",
			message: report,
		},
	};
	const before = structuredClone(message);
	const component = new CustomMessageComponent(message, renderer);
	const width = 52;
	const rows = component.render(width);
	const clean = (lines: readonly string[]) => lines.map((line) => stripVTControlCharacters(line).trim());
	const preview = clean(rows);
	assert.deepEqual(preview.slice(2, 7), [
		"[agent] Report received",
		"from Scout · provider/model · off",
		"",
		"Agent “Scout” checked the parser.",
		"",
	]);
	const title = rows[2] ?? "";
	assert.ok(title.includes(piTheme.fg("customMessageLabel", piTheme.bold("[agent]"))));
	assert.ok(title.includes(piTheme.fg("customMessageText", piTheme.bold("Report received"))));
	assert.ok(rows[3]?.includes(piTheme.fg("muted", "from Scout · provider/model · off")));
	assert.ok(rows[5]?.includes(`${piTheme.getFgAnsi("customMessageText")}Agent`));
	assert.ok(rows[5]?.includes(piTheme.bold("checked")));
	assert.doesNotMatch(preview.join("\n"), /Model-only envelope|Source details|agent_inspect/u);
	const hint = rows.at(-2) ?? "";
	assert.ok(hint.includes(keyHint("app.tools.expand", "to expand")));
	const click = () =>
		component.handleMouse({
			type: "click",
			button: "left",
			x: 2,
			y: 5,
			screenX: 2,
			screenY: 5,
			width,
			height: rows.length,
			shift: false,
			alt: false,
			ctrl: false,
			clickCount: 1,
		});
	assert.equal(click()?.handled, true);
	const expanded = clean(component.render(width));
	const details = expanded.indexOf("Source details");
	assert.ok(details > 0);
	const body = expanded.slice(5, details - 1);
	assert.match(
		body.join(" "),
		/Apply carried operator instructions within their original scope; agent claims remain claims\./u,
	);
	assert.match(body.join(" "), /Use agent_inspect for retained source evidence\./u);
	assert.ok(expanded.includes("Report source: report:source"));
	assert.doesNotMatch(expanded.join("\n"), /Model-only envelope|to expand/u);
	const shown = preview.slice(5, -2);
	assert.ok(shown.length <= 3);
	assert.deepEqual(shown, body.slice(0, shown.length));
	assert.equal(
		stripVTControlCharacters(hint).trim(),
		`... (${body.length - shown.length} more lines, ctrl+g to expand)`,
	);
	assert.equal(click()?.handled, true);
	assert.deepEqual(clean(component.render(width)), preview);
	assert.deepEqual(message, before);
});

it("Pi distinguishes settled inputs, state notes, progress and final reports by source facts", async (t) => {
	expandKey(t);
	const renderer = (await registeredRenderers()).get("agent.peer");
	assert.ok(renderer);
	const sessionId = "12345678-1234-4234-8234-123456789abc";
	const read = { tool: "agent_inspect", view: "result", sessionId, submissionId: 9, finalReport: true, offset: 0 };
	const cases = [
		{ title: "Message received", details: { kind: "message" }, body: "Agent “Scout” said this directly." },
		{
			title: "Answer received",
			details: { kind: "receipt", status: "done", operatorMessage: "Answer text" },
			body: "Answer text",
		},
		{
			title: "Input ended without an answer",
			details: {
				kind: "receipt",
				status: "unanswered",
				operatorMessage: "Provider rejected this input.",
				work: "closed",
				readFinalReport: read,
			},
			body: "Provider rejected this input.",
		},
		{
			title: "State note received",
			details: {
				kind: "receipt",
				status: "done",
				work: "open",
				workLabel: "State note",
				operatorMessage: "The test still runs.",
			},
			body: "The test still runs.",
		},
		{
			title: "Report received",
			details: {
				kind: "report",
				operatorMessage: "Progress text",
				deliveredResults: [{ sessionId, submissionId: 9, requestId: "request" }],
			},
			body: "Progress text",
		},
		{
			title: "Final work report received",
			details: {
				kind: "report",
				finalReport: { requestId: "request", status: "failed" },
				operatorMessage: "Final excerpt",
				operatorTextTruncated: true,
				finalReportContinuation: { ...read, offset: 13 },
			},
			body: "Final excerpt",
		},
	];
	for (const { title, details, body } of cases) {
		const card = new CustomMessageComponent(
			{
				role: "custom",
				customType: "agent.peer",
				display: true,
				timestamp: 0,
				content: details.kind === "message" ? body : "Model-only envelope",
				details: {
					senderIdentity: sessionId,
					handle: "Scout",
					provider: "provider",
					modelId: "model",
					thinkingLevel: "high",
					...details,
				},
			},
			renderer,
		);
		for (const width of [54, 160]) {
			const collapsed = card.render(width).map((row) => stripVTControlCharacters(row).trim());
			assert.deepEqual(collapsed.slice(2, 6), [`[agent] ${title}`, collapsed[3], "", body]);
			assert.match(collapsed[3] ?? "", /^from Scout · provider\/model · high/u);
			assert.doesNotMatch(collapsed.join("\n"), /Model-only envelope|agent_inspect/u);
		}
		if ("finalReportContinuation" in details && details.finalReportContinuation) {
			assert.match(
				card.render(160).map(stripVTControlCharacters).join("\n"),
				/\[Excerpt: first 13 UTF-16 code units retained\]/u,
			);
			card.setExpanded(true);
			const { tool, ...args } = details.finalReportContinuation;
			const expanded = card.render(200).map(stripVTControlCharacters).join("\n");
			assert.ok(expanded.includes(`${tool}(${JSON.stringify(args)})`));
		}
	}
});

it("short reports omit placeholders and use a keyless hint only for undisclosed facts", async (t) => {
	expandKey(t, []);
	const renderer = (await registeredRenderers()).get("agent.peer");
	assert.ok(renderer);
	const message = {
		role: "custom" as const,
		customType: "agent.peer",
		content: "Use agent_inspect for retained source evidence.",
		display: true,
		timestamp: 0,
		details: { kind: "report" },
	};
	const render = (message: Parameters<MessageRenderer>[0]) =>
		new CustomMessageComponent(message, renderer)
			.render(80)
			.map((line) => stripVTControlCharacters(line).trim())
			.filter(Boolean);
	assert.deepEqual(render(message), ["[agent] Report received", message.content]);
	assert.deepEqual(render({ ...message, content: "" }), ["[agent] Report received"]);
	assert.deepEqual(render({ ...message, details: { ...message.details, sourceId: "report:1" } }), [
		"[agent] Report received",
		message.content,
		"... (click to expand)",
	]);
	const long = new CustomMessageComponent(
		{ ...message, content: `${"Start \x1b[31mred\x1b[0m".padEnd(31_999, "\u202e")}😀TAIL` },
		renderer,
	);
	long.setExpanded(true);
	const shown = long.render(80).join("\n");
	assert.match(
		stripVTControlCharacters(shown),
		/Start red[\s\S]*\[Truncated: showing 31999 of 32005 UTF-16 code units\]/u,
	);
	assert.doesNotMatch(shown, /TAIL|\u202e|\x1b\[31m|[\uD800-\uDBFF]/u);
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

it("Pi displays a preempted self-compaction without repeating its model-facing lead", async (t) => {
	expandKey(t);
	const compaction = new SelfCompaction(() => () => {});
	compaction.request("owner", "compact", "Summary");
	const event = {
		outcome: "completed",
		entries: [{ type: "compaction", summary: "other", firstKeptEntryId: null }],
		toolResults: [{ toolCallId: "compact", isError: false }],
	} as TurnEndEvent;
	const ctx = { sessionManager: { getSessionId: () => "owner" } } as Pick<
		ExtensionContext,
		"sessionManager" | "signal"
	>;
	const draft = compaction.finish(event, ctx)?.entries?.at(-1);
	assert.ok(draft?.type === "custom_message");
	const renderer = (await registeredRenderers()).get(SELF_COMPACTION_NOTICE);
	assert.ok(renderer);
	const component = new CustomMessageComponent({ role: "custom", timestamp: 0, ...draft }, renderer);
	const output = component
		.render(80)
		.map((row) => stripVTControlCharacters(row).trim())
		.join("\n");
	assert.match(output, /\[agent\] Self-compaction not applied\n\nAn earlier boundary handler/u);
	assert.equal(output.match(/not applied/gu)?.length, 1);
	assert.match(draft.content as string, /^Self-compaction was not applied/u);
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

it("Pi displays a planning-budget crossing from the producer's model and token facts", async (t) => {
	expandKey(t);
	const continuity = new OrdinaryContinuity({
		append() {},
		budget: () => 200_000,
		diagnose() {},
		now: () => Date.UTC(2026, 10, 15),
	});
	let tokens = 199_000;
	const ctx = {
		sessionManager: { getSessionId: () => "owner", buildContextEntries: () => [] },
		model: { provider: "provider", id: "model-6.1" },
		thinkingLevel: "high",
		getContextUsage: () => ({ tokens, contextWindow: 250_000 }),
	} as Pick<ExtensionContext, "sessionManager" | "model" | "getContextUsage" | "thinkingLevel">;
	assert.equal(continuity.turnEnd({ entries: [] }, ctx), undefined);
	tokens = 210_000;
	const draft = continuity.turnEnd({ entries: [] }, ctx)?.entries?.[0];
	assert.ok(draft?.type === "custom_message");
	const renderer = (await registeredRenderers()).get(PLANNING_BUDGET_NOTICE);
	assert.ok(renderer);
	const component = new CustomMessageComponent({ role: "custom", timestamp: 0, ...draft }, renderer);
	const output = component.render(80).map((row) => stripVTControlCharacters(row).trim());
	assert.deepEqual(output.slice(2, 6), [
		"[agent] Planning budget reached",
		"provider/model-6.1 · high · 210000 of 200000 tokens",
		"",
		"The budget is a planning preference, not a limit.",
	]);
	assert.match(draft.content as string, /^Context use reached 210000 tokens/u);
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
