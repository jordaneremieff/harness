import { keyHint, keyText } from "@earendil-works/pi-coding-agent";
/** Host-injected keybinding hints, as Pi passes them to renderers. */
const cardKeys = { keyText, keyHint };
import assert from "node:assert/strict";
import { it } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import {
	defineTool,
	initTheme,
	ToolExecutionComponent,
	type Theme,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Text, type Component, type TUI } from "@earendil-works/pi-tui";
import { obj } from "@earendil-works/pi-schema";
import type { AgentConversationSummary } from "./dashboard-types.ts";
import {
	createAgentToolCards,
	ordinaryWorkCard,
	renderAgentPeerMessage,
	type AgentCardContext,
	type AgentCardLookup,
} from "./tool-cards.ts";
import { fixtures, fixtureResult, forkId, rows, targetId } from "./tool-card-fixture.mts";

initTheme("dark", false);
setFlagsFromString("--expose-gc");
const collect = runInNewContext("gc") as () => void;

/** The count of referents that survive collection. A weak referent stays alive until its job ends. */
async function surviving(references: readonly WeakRef<object>[]): Promise<number> {
	for (let attempt = 0; attempt < 5; attempt++) {
		await new Promise((resolve) => setImmediate(resolve));
		collect();
		if (references.every((reference) => reference.deref() === undefined)) return 0;
	}
	return references.filter((reference) => reference.deref() !== undefined).length;
}

const theme = {
	fg: (_color: string, value: string) => value,
	bg: (_color: string, value: string) => value,
	getBgAnsi: () => "",
	bold: (value: string) => value,
} as unknown as Theme;
const text = (lines: readonly string[]) => lines.map((line) => stripVTControlCharacters(line).trimEnd()).join("\n");
const context = (overrides: Partial<AgentCardContext> = {}): AgentCardContext => ({
	...cardKeys,
	args: {},
	expanded: false,
	argsComplete: true,
	isError: false,
	...overrides,
});

it("releases the cards of every earlier display update and frame of a tool row", async () => {
	const cards = createAgentToolCards(() => rows);
	const built: WeakRef<Component>[] = [];
	const track = (component: Component): Component => {
		built.push(new WeakRef(component));
		return component;
	};
	const card = cards.agent_brief;
	const tool = defineTool({
		name: "agent_brief",
		label: "agent_brief",
		description: "Renderer fixture",
		parameters: obj({}, { open: true }),
		renderCall: (args, cardTheme, cardContext) => track(card.renderCall(args, cardTheme, cardContext)),
		renderResult: (result, options, cardTheme, cardContext) =>
			track(card.renderResult(result, options, cardTheme, cardContext)),
		async execute() {
			throw new Error("Renderer fixtures must not execute.");
		},
	} as ToolDefinition);
	const row = new ToolExecutionComponent(
		"agent_brief",
		"fixture",
		fixtures.agent_brief.args,
		undefined,
		tool,
		{ requestRender() {} } as unknown as TUI,
		".",
	);
	row.setArgsComplete();
	row.updateResult({ ...fixtureResult(fixtures.agent_brief.details), isError: false }, false);
	for (let update = 0; update < 40; update++) {
		row.setExpanded(update % 2 === 0);
		for (let frame = 0; frame < 5; frame++) row.render(100);
	}
	assert.ok(built.length > 80, "every display update built a call card and a result card");
	// Pi keeps the call card and the result card of the last display update.
	assert.equal(await surviving(built.slice(0, -2)), 0);
	assert.equal(built.slice(-2).filter((reference) => reference.deref() !== undefined).length, 2);
	assert.match(text(row.render(100)), /agent_brief/u);
});

it("builds a call card again only when its observed target or the roster changed", async () => {
	let roster: readonly AgentConversationSummary[] = rows;
	const card = createAgentToolCards(() => roster).agent_send;
	const args = { sessionId: targetId, message: "Review the parser." };
	const state: NonNullable<AgentCardContext["state"]> = {};
	const call = card.renderCall(args, theme, context({ args, state }));
	// The grammar publishes the disclosure of each built call card in the shared renderer state.
	let first = state.grammarCall;
	assert.equal(typeof first, "function");
	const replaced = [new WeakRef(first as object)];
	const lines = call.render(100);
	assert.match(text(lines), /^agent_send Parser review/u);
	for (let frame = 0; frame < 20; frame++) assert.equal(call.render(100), lines, "an unchanged frame keeps its lines");
	assert.equal(state.grammarCall, first, "an unchanged frame builds no card");

	roster = [...rows];
	assert.equal(call.render(100), lines, "the same rows in another array change nothing");
	assert.equal(state.grammarCall, first);
	roster = rows.map((row) => ({ ...row, state: "working", cost: 3, modifiedAt: 9, partial: true }));
	assert.equal(call.render(100), lines, "a roster read that changed only activity builds no card");
	assert.equal(state.grammarCall, first);

	roster = [{ ...rows[0], name: "Renamed review" }, rows[1]];
	assert.match(text(call.render(100)), /^agent_send Renamed review/u);
	let renamed = state.grammarCall;
	assert.notEqual(renamed, first, "a changed roster row builds the card once");
	replaced.push(new WeakRef(renamed as object));
	call.render(100);
	assert.equal(state.grammarCall, renamed);

	card.renderResult(
		fixtureResult({
			identity: targetId,
			conversationId: 1,
			submissionId: 405,
			conversation: { identity: targetId, name: "Observed review", cwd: "/work", agent: {} },
		}),
		{ expanded: false, isPartial: false },
		theme,
		context({ args, state }),
	);
	assert.equal(state.observation?.name, "Observed review");
	assert.match(text(call.render(100)), /^agent_send Observed review/u);
	const afterResult = state.grammarCall;
	assert.notEqual(afterResult, renamed, "a newly observed target builds the card once");
	const settled = call.render(100);
	for (let frame = 0; frame < 20; frame++) assert.equal(call.render(100), settled);
	assert.equal(state.grammarCall, afterResult);

	// The card that a frame built keeps nothing of the cards it replaced.
	first = undefined;
	renamed = undefined;
	assert.equal(await surviving(replaced), 0);
	assert.equal(call.render(100), settled);
});

it("gives a delivery time on a call card its date when the day it names is over", (t) => {
	const at = new Date(2026, 10, 24, 23, 55);
	t.mock.timers.enable({ apis: ["Date"], now: at.getTime() - 60 * 60 * 1000 });
	const card = createAgentToolCards(() => rows).agent_send;
	const args = { sessionId: targetId, message: "Review the parser.", deliverAt: at.toISOString() };
	const state: NonNullable<AgentCardContext["state"]> = {};
	const call = card.renderCall(args, theme, context({ args, state }));
	const lines = call.render(100);
	assert.match(text(lines), /11:55 PM/u);
	assert.doesNotMatch(text(lines), /24 Nov/u);
	assert.equal(call.render(100), lines);
	t.mock.timers.tick(2 * 60 * 60 * 1000);
	assert.match(text(call.render(100)), /24 Nov 11:55 PM/u);
});

it("keeps the thread titles of the view on a call card with an observed target", () => {
	const lookup: AgentCardLookup = Object.assign(() => rows, { threadTitle: () => "Release thread" });
	const card = createAgentToolCards(lookup).agent_collaborate;
	const args = { action: "read", threadId: `${targetId}/0123456789abcdef0123456789abcdef` };
	const state: NonNullable<AgentCardContext["state"]> = {
		observation: { identity: targetId, name: "Observed review", cwd: "/work", agent: {} },
	};
	assert.match(text(card.renderCall(args, theme, context({ args, state })).render(100)), /Release thread/u);
});

it("draws a message card once for unchanged frames and again after a click", (t) => {
	const card = renderAgentPeerMessage(
		{
			role: "custom",
			customType: "agent.peer",
			display: true,
			timestamp: 1,
			content: "The parser accepts the frame.",
			details: { identity: targetId, name: "Catalog reader", kind: "receipt", status: "done" },
		} as Parameters<typeof renderAgentPeerMessage>[0],
		{ expanded: true, outputPad: 0, ...cardKeys } as Parameters<typeof renderAgentPeerMessage>[1],
		theme,
	);
	assert.ok(card);
	const draws = t.mock.method(Text.prototype, "render");
	const lines = card.render(100);
	const drawn = draws.mock.callCount();
	assert.ok(drawn > 0, "the expanded source facts are text rows");
	for (let frame = 0; frame < 20; frame++) assert.equal(card.render(100), lines);
	assert.equal(draws.mock.callCount(), drawn, "an unchanged frame draws no row again");
	const click = { type: "click", button: "left", x: 1, y: 1, width: 100, height: lines.length };
	assert.equal(card.handleMouse?.(click as never)?.handled, true);
	assert.notDeepEqual(card.render(100), lines, "a click collapses this card");
});

it("draws a state note once for unchanged frames, with the awaited agents as they are now", (t) => {
	let roster = rows;
	const card = ordinaryWorkCard("agent_yield", () => roster);
	const at = new Date(2026, 10, 24, 22, 42).getTime();
	t.mock.timers.enable({ apis: ["Date"], now: at + 60_000 });
	const details = { at, waiting: [{ sessionId: targetId, state: "admitted" }], waitingOmitted: 0 };
	const result = { content: [{ type: "text" as const, text: "Turn ended" }], details };
	const args = { note: "Not the result: one agent result is due." };
	const collapsed = card.renderResult(result, { expanded: false, isPartial: false }, theme, context({ args }));
	const lines = collapsed.render(100);
	assert.match(text(lines), /agent_yield Turn ended\n 1 agent result due · 10:42 PM\n/u);
	roster = rows.map((row) => ({ ...row, state: "working" as const }));
	for (let frame = 0; frame < 20; frame++) assert.equal(collapsed.render(100), lines);

	const expanded = card.renderResult(
		result,
		{ expanded: true, isPartial: false },
		theme,
		context({ args, expanded: true }),
	);
	assert.match(text(expanded.render(100)), /Parser review · provider\/model · high · now working/u);
	const shown = expanded.render(100);
	assert.equal(expanded.render(100), shown);
	roster = rows.map((row) => ({ ...row, state: "idle" as const }));
	assert.match(text(expanded.render(100)), /now idle/u);

	// The end time gains its date when the day it names is over.
	t.mock.timers.tick(24 * 60 * 60 * 1000);
	assert.match(text(collapsed.render(100)), /1 agent result due · 24 Nov 10:42 PM/u);
});

it("draws the expand hint of every card again after the expand key changed", () => {
	let key = "ctrl+o";
	const keys = { keyText: () => key, keyHint: (_binding: string, description: string) => `${key} ${description}` };
	const args = { sessionId: targetId, message: Array.from({ length: 30 }, (_, line) => `Line ${line}`).join("\n") };
	const card = createAgentToolCards(() => rows).agent_send;
	const call = card.renderCall(args, theme, context({ args, ...keys }));
	const callLines = call.render(100);
	assert.match(text(callLines), /ctrl\+o to expand/u);
	assert.equal(call.render(100), callLines);

	const message = renderAgentPeerMessage(
		{
			role: "custom",
			customType: "agent.peer",
			display: true,
			timestamp: 1,
			content: "The parser accepts the frame.",
			details: { identity: targetId, name: "Catalog reader", kind: "receipt", status: "done" },
		} as Parameters<typeof renderAgentPeerMessage>[0],
		{ expanded: false, outputPad: 0, ...keys } as Parameters<typeof renderAgentPeerMessage>[1],
		theme,
	);
	assert.ok(message);
	const messageLines = message.render(100);
	assert.match(text(messageLines), /ctrl\+o to expand/u);
	assert.equal(message.render(100), messageLines);

	const note = ordinaryWorkCard("agent_yield", () => rows);
	const noteArgs = { note: Array.from({ length: 12 }, (_, line) => `Note line ${line}.`).join("\n") };
	const collapsed = note.renderResult(
		{ content: [{ type: "text" as const, text: "Turn ended" }], details: { at: 1, waiting: [], waitingOmitted: 0 } },
		{ expanded: false, isPartial: false },
		theme,
		context({ args: noteArgs, ...keys }),
	);
	const noteLines = collapsed.render(100);
	assert.match(text(noteLines), /ctrl\+o to expand/u);
	assert.equal(collapsed.render(100), noteLines);

	// Pi builds the cards of a reloaded session before it reads the changed keybindings.
	key = "ctrl+e";
	for (const [name, component] of [
		["call card", call],
		["message card", message],
		["state note", collapsed],
	] as const) {
		const lines = component.render(100);
		assert.match(text(lines), /ctrl\+e to expand/u, name);
		assert.doesNotMatch(text(lines), /ctrl\+o/u, name);
		assert.equal(component.render(100), lines, `${name}: an unchanged frame keeps its lines`);
	}
});

it("keeps the lines of an expanded state note while its lookup returns a new empty array at each call", () => {
	const card = ordinaryWorkCard("agent_yield", () => []);
	const args = { note: "Not the result: one agent result is due." };
	const details = { at: 1, waiting: [{ sessionId: targetId, state: "admitted" }], waitingOmitted: 0 };
	const expanded = card.renderResult(
		{ content: [{ type: "text" as const, text: "Turn ended" }], details },
		{ expanded: true, isPartial: false },
		theme,
		context({ args, expanded: true }),
	);
	const lines = expanded.render(100);
	for (let frame = 0; frame < 20; frame++) assert.equal(expanded.render(100), lines);
});

it("builds a mounted call card again only when a roster fact that it drew changed", () => {
	let roster: readonly AgentConversationSummary[] = rows;
	const card = createAgentToolCards(() => roster).agent_send;
	const args = { sessionId: targetId, message: "Review the parser." };
	const state: NonNullable<AgentCardContext["state"]> = {};
	const call = card.renderCall(args, theme, context({ args, state }));
	const first = state.grammarCall;
	const lines = call.render(100);
	assert.match(text(lines), /^agent_send Parser review/u);

	const other = {
		...rows[1],
		id: "87654321-4321-4321-4321-cba987654321",
		storageId: "87654321-4321-4321-4321-cba987654321",
	};
	roster = [...rows, { ...other, name: "Another agent" }];
	assert.equal(call.render(100), lines, "a new agent that the card does not name builds no card");
	roster = [rows[0], { ...rows[1], name: "Renamed fork" }, { ...other, name: "Another agent" }];
	assert.equal(call.render(100), lines, "another agent's new name builds no card");
	assert.equal(state.grammarCall, first);

	roster = [...rows, { ...other, name: rows[0].name }];
	assert.match(
		text(call.render(100)),
		new RegExp(`^agent_send Parser review \\[${targetId}\\]`, "u"),
		"a second agent with the target's name builds the card with the identity",
	);
	assert.notEqual(state.grammarCall, first);
	roster = [{ ...rows[0], model: { provider: "provider", modelId: "other-model", thinkingLevel: "low" } }, rows[1]];
	assert.match(text(call.render(100)), /other-model/u, "the target's new model builds the card");
});

it("a mounted result card names its target with the roster of each frame", () => {
	let roster: readonly AgentConversationSummary[] = [];
	const cards = createAgentToolCards(() => roster);
	const args = { sessionId: forkId, entryId: 7 };
	const result = fixtureResult({ identity: `${targetId}:3`, conversationId: 3, source: forkId });
	const options = { expanded: false, isPartial: false };
	// Pi builds the cards of a resumed session before the first roster read.
	const mounted = cards.agent_fork.renderResult(result, options, theme, context({ args, state: {} }));
	const early = text(mounted.render(100));
	roster = [...rows, { ...rows[1], id: `${targetId}:3`, name: "New branch" }];
	const fresh = cards.agent_fork.renderResult(result, options, theme, context({ args, state: {} }));
	assert.notEqual(text(fresh.render(100)), early, "the roster changes what a fresh card shows");
	assert.equal(text(mounted.render(100)), text(fresh.render(100)));
	const settled = mounted.render(100);
	roster = roster.map((row) => ({ ...row, state: "working", cost: 2 }));
	assert.equal(mounted.render(100), settled, "a roster read that changed only activity builds no card");
});
