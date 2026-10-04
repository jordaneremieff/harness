import assert from "node:assert/strict";
import { it } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { defineTool, initTheme, ToolExecutionComponent, type ExtensionAPI, type ExtensionContext, type ExtensionToolContext, type ToolDefinition, type Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth, type TUI } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import register from "./index.ts";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Harness, Conversation } from "@earendil-works/pi-durable";
import { compactConversation } from "./durable-controls.ts";
import { createAgentToolCards, type AgentCardContext } from "./tool-cards.ts";

initTheme("dark", false);
const identity = "12345678-1234-4234-8234-123456789abc";
const theme = { fg: (_color: string, value: string) => value, bold: (value: string) => value } as unknown as Theme;
const screen = (component: { render(width: number): string[] }, width = 240) => component.render(width).map((line) => stripVTControlCharacters(line).trimEnd()).join("\n");
const context = (overrides: Partial<AgentCardContext> = {}): AgentCardContext => ({ expanded: false, argsComplete: true, ...overrides });

it("captures self context once at execution and keeps it stable through native row rerenders", async () => {
	const tools = new Map<string, ToolDefinition>();
	register({ events: { emit() {} }, on: () => () => {}, registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool), registerCommand() {}, registerShortcut() {}, registerMessageRenderer() {}, getThinkingLevel: () => "high" } as unknown as ExtensionAPI);
	const registered = tools.get("agent_compact");
	assert.ok(registered?.execute);
	let reads = 0;
	const usage = { tokens: 12000, contextWindow: 48000, percent: 25 };
	const ctx = { sessionManager: { getSessionId: () => identity, getSessionName: () => "Parser session" }, model: { provider: "provider", id: "model" }, thinkingLevel: "high", getContextUsage: () => { reads++; return usage; } } as unknown as ExtensionContext;
	const args = { sessionId: identity, summary: "Preserve the task, authority, exclusions and next action." };
	const result = await registered.execute("compact-call", args, undefined, undefined, ctx as ExtensionToolContext);
	assert.equal(result.content[0]?.type === "text" ? result.content[0].text : "", "Continuity summary queued for this completed tool batch.");
	assert.equal(reads, 1);
	usage.tokens = 44000;
	usage.percent = 91.7;
	const tool = defineTool({ name: "agent_compact", label: "Compact", description: "Native row fixture", parameters: Type.Object({}), renderCall: registered.renderCall, renderResult: registered.renderResult, async execute() { throw new Error("The row does not execute a tool."); } });
	const row = new ToolExecutionComponent("agent_compact", "compact-call", args, undefined, tool, { requestRender() {} } as unknown as TUI, ".");
	row.setArgsComplete();
	row.markExecutionStarted();
	row.updateResult({ ...result, isError: false });
	let rendered = screen(row);
	assert.match(rendered, /this session · Parser session/u);
	assert.match(rendered, /provider\/model.*high/u);
	assert.equal((rendered.match(/provider\/model/gu) ?? []).length, 1);
	assert.equal((rendered.match(/Parser session/gu) ?? []).length, 1);
	assert.match(rendered, /Before: 12000 tokens · 48000 window · 25\.0%/u);
	assert.match(rendered, new RegExp(`Summary: ${args.summary.length} chars`, "u"));
	assert.match(rendered, /Summary queued/u);
	assert.doesNotMatch(rendered, /44000|91\.7|completed|After:|unknown|unavailable/u);
	assert.doesNotMatch(rendered.split("\n").find((line) => line.includes("agent_compact")) ?? "", /…/u);
	for (const width of [20, 40, 80]) assert.ok(row.render(width).every((line) => visibleWidth(line) <= width));
	row.setExpanded(true);
	assert.ok(screen(row, 500).includes(identity));
	row.setExpanded(false);
	rendered = screen(row);
	assert.match(rendered, /Before: 12000 tokens · 48000 window · 25\.0%/u);
	assert.doesNotMatch(rendered, /44000|91\.7|After:/u);
	assert.equal(reads, 1, "rendering does not query current context again");
});

it("shows only observed other-agent configuration, context facts and retained summary size", () => {
	const cards = createAgentToolCards();
	const state = {};
	const args = { sessionId: identity };
	const details = { status: "completed", taskId: 9, compaction: { identity, name: "Other parser", provider: "provider", modelId: "model", thinkingLevel: "off", before: { contextWindow: 48000 }, summaryChars: 150 } };
	const result = { content: [{ type: "text" as const, text: JSON.stringify(details) }], details };
	const ctx = context({ args, state });
	cards.agent_compact.renderResult(result, { expanded: false, isPartial: false }, theme, ctx);
	const text = `${screen(cards.agent_compact.renderCall(args, theme, ctx))}\n${screen(cards.agent_compact.renderResult(result, { expanded: false, isPartial: false }, theme, ctx))}`;
	assert.match(text, /agent_compact · Other parser/u);
	assert.match(text, /provider\/model.*off/u);
	assert.match(text, /Before: 48000 window/u);
	assert.match(text, /Summary: 150 chars/u);
	assert.doesNotMatch(text, /unknown|unavailable|tokens|After:/u);
	const absent = { status: "queued", compaction: { identity, self: true, before: { tokens: null, percent: null } } };
	const missing = screen(cards.agent_compact.renderResult({ content: [{ type: "text", text: "queued" }], details: absent }, { expanded: false, isPartial: false }, theme, context()));
	assert.doesNotMatch(missing, /unknown|unavailable|Before:|After:|completed/u);
});

it("retains a completed compaction outcome when its optional summary-size read fails", async () => {
	const harness = { waitForTask: async () => ({ state: { outcome: { status: "completed", result: { entryId: 7 } } } }), commit: async () => { throw new Error("retained entry read failed"); } } as unknown as Harness;
	const conversation = { compact: async () => 9 } as unknown as Conversation;
	const outcome = await compactConversation(harness, conversation, undefined, true, BACKGROUND_CONTEXT);
	assert.equal(outcome.status, "completed");
	assert.equal(outcome.entryId, 7);
	assert.equal(Object.hasOwn(outcome, "summaryChars"), false);
	assert.equal(outcome.summarySizeError, "retained entry read failed");
	const rendered = screen(createAgentToolCards().agent_compact.renderResult({ content: [{ type: "text", text: JSON.stringify(outcome) }], details: outcome }, { expanded: false, isPartial: false }, theme, context()));
	assert.match(rendered, /Compaction completed/u);
	assert.match(rendered, /Summary size read failed: retained entry read failed/u);
	assert.doesNotMatch(rendered, /Compact error|Summary: \d+ chars/u);
});

it("keeps complete target, operation, thread and revision identities at wide widths", () => {
	const cards = createAgentToolCards();
	for (const [name, card] of Object.entries(cards)) {
		if (name === "agent_list") continue;
		const args = { sessionId: `${identity}:12345678901234567890`, action: "read", message: "Task", name: "command" };
		const callArgs = name === "agent_intent" ? { action: "clear" } : args;
		const state = name === "agent_intent" ? { observation: { identity: args.sessionId } } : undefined;
		const rendered = screen(card.renderCall(callArgs, theme, context({ state })), 600);
		assert.ok(rendered.includes(args.sessionId), name);
		assert.doesNotMatch(rendered.split("\n")[0] ?? "", /…/u, name);
		const narrow = card.renderCall(callArgs, theme, context({ state })).render(24);
		assert.ok(narrow.every((line) => visibleWidth(line) <= 24), name);
		assert.ok(screen(card.renderCall(callArgs, theme, context({ expanded: true, state })), 600).includes(args.sessionId), name);
	}
	const operationId = `operation-${"a".repeat(160)}`;
	assert.ok(screen(cards.agent_inspect.renderCall({ sessionId: identity, operationId }, theme, context()), 600).includes(operationId));
	const threadId = `${identity}/${"b".repeat(32)}`;
	assert.ok(screen(cards.agent_collaborate.renderCall({ action: "read", threadId }, theme, context()), 600).includes(threadId));
	const revision = "c".repeat(64);
	const profile = { identity, role: "Review", revision, live: false };
	assert.ok(screen(cards.agent_profile.renderResult({ content: [{ type: "text", text: JSON.stringify(profile) }], details: profile }, { expanded: false, isPartial: false }, theme, context()), 600).includes(revision));
});
