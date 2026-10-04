import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { describe, it } from "node:test";
import { stripVTControlCharacters } from "node:util";
import type { AgentToolResult, Theme } from "@earendil-works/pi-coding-agent";
import { initTheme } from "@earendil-works/pi-coding-agent";
import type { AgentConversationSummary } from "./dashboard-types.ts";
import { createAgentToolCards, type AgentCardContext } from "./tool-cards.ts";

initTheme("dark", false);
const nativeTui = await import(createRequire(import.meta.resolve("@earendil-works/pi-coding-agent")).resolve("@earendil-works/pi-tui"));
const theme = { fg: (_color: string, value: string) => value, bold: (value: string) => value } as unknown as Theme;
const screen = (component: { render(width: number): string[] }) => component.render(240).map((line) => stripVTControlCharacters(line).trimEnd()).join("\n");
const context = (overrides: Partial<AgentCardContext> = {}): AgentCardContext => ({ args: {}, expanded: false, argsComplete: true, isError: false, ...overrides });
const id = "12345678-1234-1234-1234-123456789abc";
const model = { provider: "provider", modelId: "model", thinkingLevel: "high" };
const row: AgentConversationSummary = { id, storageId: id, name: "Parser review", cwd: "/work", model, modifiedAt: 1, owner: "unknown", state: "idle", cost: 0, partial: false };
const details = { identity: id, conversationId: 1, submissionId: 405, deduped: false };
const receipt: AgentToolResult<unknown> = { content: [{ type: "text", text: JSON.stringify(details) }], details };
const hintCount = (value: string) => (value.match(/to expand|expand for full/gu) ?? []).length;

describe("human-readable agent targets", () => {
	it("uses observed names, model and provider on every targeted call, with full IDs expanded", () => {
		const cards = createAgentToolCards(() => [row]);
		for (const [name, card] of Object.entries(cards).filter(([name]) => name !== "agent_list" && name !== "agent_place" && name !== "agent_intent")) {
			const args = { sessionId: id, name: "reload", message: "Task", action: "read" };
			const collapsed = screen(card.renderCall(args, theme, context({ executionStarted: true })));
			assert.match(collapsed, /Parser review\nprovider\/model · high/u, name);
			assert.doesNotMatch(collapsed, new RegExp(id), name);
			assert.ok(screen(card.renderCall(args, theme, context({ expanded: true }))).includes(id), name);
		}
	});

	it("resolves handle targets and handle reuse on spawn", () => {
		const profile = { identity: id, handle: "@parser", role: "Review source", revision: "abc", hasExpertise: false, updatedAt: null };
		const cards = createAgentToolCards(() => [{ ...row, profile }]);
		for (const name of ["agent_send", "agent_steer", "agent_status"]) {
			assert.match(screen(cards[name].renderCall({ sessionId: "@parser", message: "Task" }, theme, context())), /@parser\nprovider\/model · high/u);
		}
		assert.match(screen(cards.agent_spawn.renderCall({ handle: "parser" }, theme, context())), /@parser\nprovider\/model · high/u);
		assert.ok(screen(cards.agent_spawn.renderCall({ handle: "parser" }, theme, context({ expanded: true }))).includes(id));
		assert.ok(screen(cards.agent_send.renderCall({ sessionId: "@parser", message: "Task" }, theme, context({ expanded: true }))).includes(id));
		assert.match(screen(cards.agent_send.renderResult(receipt, { expanded: false, isPartial: false }, theme, context())), /provider\/model · high\nAdmitted · @parser/u);
	});

	it("falls back to the full identity and retains unknown handles", () => {
		const cards = createAgentToolCards();
		assert.ok(screen(cards.agent_send.renderCall({ sessionId: id, message: "Task" }, theme, context())).includes(`agent_send · ${id}`));
		assert.ok(screen(cards.agent_abort.renderCall({ sessionId: `${id}:7` }, theme, context())).includes(`${id}:7`));
		assert.match(screen(cards.agent_send.renderCall({ sessionId: "@unknown", message: "Task" }, theme, context())), /agent_send · @unknown/u);
		assert.ok(screen(cards.agent_send.renderCall({ sessionId: id, message: "Task" }, theme, context({ expanded: true }))).includes(id));
	});

	it("disambiguates repeated names only without distinct handles", () => {
		const other = { ...row, id: "87654321-1234-1234-1234-123456789abc" };
		const cards = createAgentToolCards(() => [row, other]);
		assert.ok(screen(cards.agent_status.renderCall({ sessionId: id }, theme, context())).includes(`Parser review [${id}]`));
		assert.doesNotMatch(screen(createAgentToolCards(() => [row]).agent_status.renderCall({ sessionId: id }, theme, context())), /\[/u);
		const differentModel = { ...other, model: { ...model, modelId: "other-model" } };
		assert.doesNotMatch(screen(createAgentToolCards(() => [row, differentModel]).agent_status.renderCall({ sessionId: id }, theme, context())), /\[/u);
	});

	it("uses one hint across call and result during partial, final, expanded and repeated renders", (t) => {
		const previousKeys = nativeTui.getKeybindings();
		nativeTui.setKeybindings(new nativeTui.KeybindingsManager({ ...nativeTui.TUI_KEYBINDINGS, "app.tools.expand": { defaultKeys: "ctrl+o", description: "Expand tool output" } }));
		t.after(() => nativeTui.setKeybindings(previousKeys));
		const cards = createAgentToolCards(() => [row]);
		for (const name of Object.keys(cards)) {
			const card = cards[name];
			const args = { sessionId: id, message: "Task\n".repeat(80), instructions: "Keep facts", background: true, view: "history", query: "q".repeat(400), action: "read" };
			const state = {};
			assert.equal(hintCount(screen(card.renderCall(args, theme, context({ state, argsComplete: false })))), 0);
			assert.ok(hintCount(screen(card.renderCall(args, theme, context({ state })))) <= 1);
			const phases = [{ expanded: false, isPartial: true }, { expanded: false, isPartial: false }, { expanded: true, isPartial: true }, { expanded: true, isPartial: false }, { expanded: false, isPartial: true }, { expanded: false, isPartial: false }];
			for (const { expanded, isPartial } of phases) {
				const ctx = context({ args, state, expanded, executionStarted: true, isPartial });
				const combined = `${screen(card.renderCall(args, theme, ctx))}\n${screen(card.renderResult(receipt, { expanded, isPartial }, theme, ctx))}`;
				assert.ok(hintCount(combined) <= (expanded ? 0 : 1), name);

			}
		}
	});

	it("shares hint ownership without execution flags and respects missing model facts", () => {
		const cards = createAgentToolCards(() => [{ ...row, model: undefined }]);
		const args = { sessionId: id, message: "Task\n".repeat(80) };
		const state = {};
		const ctx = context({ args, state });
		const call = screen(cards.agent_send.renderCall(args, theme, ctx));
		const output = screen(cards.agent_send.renderResult(receipt, { expanded: false, isPartial: false }, theme, ctx));
		assert.match(call, /Parser review/u);
		assert.doesNotMatch(call, /unknown|unavailable/u);
		assert.equal(hintCount(call) + hintCount(output), 1);
		const off = createAgentToolCards(() => [{ ...row, model: { ...model, thinkingLevel: "off" } }]);
		assert.match(screen(off.agent_send.renderCall(args, theme, context())), /\nprovider\/model · off\n/u);
	});

	it("keeps admission concise, labels the target, and preserves the full result", () => {
		const cards = createAgentToolCards(() => [row]);
		const before = structuredClone(receipt);
		const collapsed = screen(cards.agent_send.renderResult(receipt, { expanded: false, isPartial: false }, theme, context({ args: { sessionId: id }, executionStarted: true })));
		assert.equal(collapsed.split("\n")[0], "Admitted · submission 405");
		assert.doesNotMatch(collapsed, /not proof|submitted|12345678/u);
		assert.ok(screen(cards.agent_send.renderResult(receipt, { expanded: true, isPartial: false }, theme, context({ expanded: true }))).includes(id));
		assert.deepEqual(receipt, before);
	});
});
