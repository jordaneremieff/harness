import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { it } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { defineTool, initTheme, ToolExecutionComponent, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { createAgentToolCards } from "./tool-cards.ts";
import { fixtures, fixtureResult, rows, targetId, forkId } from "./tool-card-fixture.mts";

type NativeContext = Parameters<NonNullable<ToolDefinition["renderCall"]>>[2];

initTheme("dark", false);
const nativeTui = await import(createRequire(import.meta.resolve("@earendil-works/pi-coding-agent")).resolve("@earendil-works/pi-tui"));
const screen = (component: ToolExecutionComponent, width = 240) => component.render(width).map((line) => stripVTControlCharacters(line).trim()).filter(Boolean).join("\n");
const hints = (value: string) => value.split("\n").filter((line) => /to expand|expand for full/u.test(line));
const fullId = /[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}/u;

for (const [name, fixture] of Object.entries(fixtures)) it(`${name} uses the installed tool row lifecycle for one hint and concise collapsed facts`, (t) => {
	const previousKeys = nativeTui.getKeybindings();
	nativeTui.setKeybindings(new nativeTui.KeybindingsManager({ ...nativeTui.TUI_KEYBINDINGS, "app.tools.expand": { defaultKeys: "ctrl+o", description: "Expand tool output" } }));
	t.after(() => nativeTui.setKeybindings(previousKeys));
	const cards = createAgentToolCards(() => rows);
	const card = cards[name];
	assert.ok(card);
	const calls: NativeContext[] = [];
	const results: NativeContext[] = [];
	const tool = defineTool({
		name, label: name, description: "Renderer fixture", parameters: Type.Object({}),
		renderCall(args, theme, context) { calls.push(context); return card.renderCall(args, theme, context); },
		renderResult(result, options, theme, context) { results.push(context); return card.renderResult(result, options, theme, context); },
		async execute() { throw new Error("Renderer fixtures must not execute."); },
	});
	const component = new ToolExecutionComponent(name, "fixture", {}, undefined, tool, { requestRender() {} } as unknown as TUI, ".");
	component.updateArgs({ ...fixture.args, message: "Review" });
	assert.equal(hints(screen(component)).length, 0, "incomplete streamed arguments show no hint");
	component.updateArgs(fixture.args);
	component.setArgsComplete();
	assert.ok(hints(screen(component)).length <= 1);
	const beforeStart = calls.length;
	const sharedState = calls.at(-1)?.state;
	component.markExecutionStarted();
	assert.ok(calls.length > beforeStart, "execution start redraws the call");
	assert.equal(calls.at(-1)?.executionStarted, true);
	assert.equal(calls.at(-1)?.state, sharedState);
	assert.equal(hints(screen(component)).length, 0);
	const result = { ...fixtureResult(fixture.details), isError: false };
	const before = structuredClone({ args: fixture.args, result });
	component.updateResult(result, true);
	assert.equal(results.at(-1)?.state, sharedState, "call and result share one native state object");
	assert.equal(results.at(-1)?.isPartial, true);
	assert.ok(hints(screen(component)).length <= 1);
	component.updateResult(result);
	for (const width of [40, 80, 240]) assert.ok(hints(screen(component, width)).length <= 1);
	const collapsed = screen(component);
	if (name === "agent_collaborate") assert.ok(collapsed.includes(String(fixture.args.threadId)));
	else assert.doesNotMatch(collapsed, fullId);
	for (const label of ["Parser review", "Fork review"]) assert.ok((collapsed.split(label).length - 1) <= 1, `${label} appears once`);
	if (!["agent_fork", "agent_rewind"].includes(name)) assert.ok((collapsed.split("provider/model").length - 1) <= 1, "model facts appear once");
	assert.doesNotMatch(collapsed, /not proof|not task acceptance|controls escaped|unresolved|Deduplicated against/u);
	component.setExpanded(true);
	const expanded = screen(component);
	assert.equal(hints(expanded).length, 0);
	assert.ok(expanded.includes(targetId) || expanded.includes(forkId), "expanded native source keeps full identities");
	component.setExpanded(false);
	assert.equal(screen(component), collapsed);
	assert.deepEqual({ args: fixture.args, result }, before, "rendering changes neither arguments nor results");
});

function nativeRow(name: string, args: Record<string, unknown>, details: unknown, lookupRows = rows): ToolExecutionComponent {
	const card = createAgentToolCards(() => lookupRows)[name];
	const tool = defineTool({ name, label: name, description: "Renderer fixture", parameters: Type.Object({}), ...card, async execute() { throw new Error("Renderer fixtures must not execute."); } });
	const component = new ToolExecutionComponent(name, "fixture", args, undefined, tool, { requestRender() {} } as unknown as TUI, ".");
	component.setArgsComplete();
	component.markExecutionStarted();
	component.updateResult({ ...fixtureResult(details), isError: false });
	return component;
}

it("place receipts omit labels and models already shown in the card", () => {
	const place = nativeRow("agent_place", { area: "/work", topic: "Parser review", prompt: "Review the parser" }, fixtures.agent_spawn.details);
	const rendered = screen(place);
	assert.match(rendered, /Admitted · submission 405/u);
	assert.equal(rendered.split("Parser review").length - 1, 1);
	assert.equal(rendered.split("provider/model").length - 1, 1);
});

it("new fork facts survive an incomplete roster and applied settings preserve host adjustments", () => {
	const fork = nativeRow("agent_fork", fixtures.agent_fork.args, fixtures.agent_fork.details, rows.slice(0, 1));
	const forkText = screen(fork);
	assert.match(forkText, /Fork created · Fork review/u);
	assert.match(forkText, /provider\/model · high/u);
	assert.equal((forkText.match(/Fork review/gu) ?? []).length, 1);
	const snapshot = { identity: targetId, conversationId: 1, name: "Parser review", busy: false, state: "idle", agent: { model: { provider: "provider", modelId: "new-model" }, thinkingLevel: "low" } };
	const configured = nativeRow("agent_configure", { sessionId: targetId, model: "provider/new-model", thinkingLevel: "high" }, { identity: targetId, conversationId: 1, status: snapshot });
	assert.match(screen(configured), /provider\/new-model · low/u);
	assert.match(screen(configured), /Configuration applied/u);
});

it("scheduled messages and timer cancellation name their actual outcomes without duplicate targets", () => {
	const scheduled = nativeRow("agent_send", { sessionId: targetId, message: "Later", deliverAt: "2026-10-05T00:00:00.000Z" }, { identity: targetId, conversationId: 1, timerId: 7, deadline: Date.parse("2026-10-05T00:00:00.000Z") });
	assert.match(screen(scheduled), /Scheduled · timer 7 · 2026-10-05T00:00:00.000Z/u);
	assert.doesNotMatch(screen(scheduled), /Admitted/u);
	const canceled = nativeRow("agent_abort", { sessionId: targetId, timerId: 7 }, { timerId: 7, status: "cancelled", outcome: "marked" });
	assert.match(screen(canceled), /timer 7/u);
	assert.match(screen(canceled), /Timer cancelled/u);
	const fired = nativeRow("agent_abort", { sessionId: targetId, timerId: 7 }, { timerId: 7, status: "fired", outcome: "unchanged" });
	assert.match(screen(fired), /Timer fired · unchanged/u);
});

it("collaboration pages, reset refusals, and raw error previews keep detail behind expansion", () => {
	const collaboration = nativeRow("agent_collaborate", { action: "read", threadId: `${targetId}/0123456789abcdef0123456789abcdef` }, { thread: { title: "Parser plan", closed: false, members: [{ identity: targetId }] }, events: [], pending: 1, coverage: { complete: false } });
	assert.match(screen(collaboration), /Parser plan · open · 1 members/u);
	assert.match(screen(collaboration), /bounded page/u);
	assert.ok(screen(collaboration).includes(`${targetId}/0123456789abcdef0123456789abcdef`));
	const reset = nativeRow("agent_reset", { sessionId: targetId }, { text: "Reset did not place for “Parser review”: unavailable." });
	assert.match(screen(reset), /Reset not placed: unavailable/u);
	const error = nativeRow("agent_status", { sessionId: targetId }, `Storage ${targetId} is unavailable`);
	assert.ok(screen(error).includes(targetId));
	error.setExpanded(true);
	assert.match(screen(error), new RegExp(targetId));
});

it("a primary continuity receipt and expanded messages use plain labels", () => {
	const compact = nativeRow("agent_compact", { sessionId: targetId, summary: "Keep facts" }, { text: "Continuity summary queued for this completed tool batch.", status: "queued", compaction: { identity: targetId, self: true } });
	assert.match(screen(compact), /Summary queued/u);
	assert.doesNotMatch(screen(compact), /at this tool batch|does not establish/u);
	const send = nativeRow("agent_send", fixtures.agent_send.args, fixtures.agent_send.details);
	send.setExpanded(true);
	assert.match(screen(send), /Message:/u);
	assert.doesNotMatch(screen(send), /Submitted message|controls escaped/u);
});

it("same-target message receipts omit repeated facts but newly resolved and different targets retain their labels", () => {
	const cards = createAgentToolCards(() => rows);
	const context = { expanded: false, argsComplete: true, executionStarted: true, state: {} };
	const render = (args: Record<string, unknown>, identity: string) => cards.agent_send.renderResult(fixtureResult({ identity, conversationId: 1, submissionId: 405 }), { expanded: false, isPartial: false }, { fg: (_color: string, text: string) => text } as never, { ...context, args }).render(240).join("\n");
	assert.match(render({ sessionId: targetId }, targetId), /^Admitted · submission 405/u);
	assert.match(render({ sessionId: "@unobserved" }, targetId), /provider\/model · high\nAdmitted · Parser review · submission 405/u);
	assert.match(render({ sessionId: targetId }, forkId), /provider\/model · high\nAdmitted · Fork review · submission 405/u);
});
