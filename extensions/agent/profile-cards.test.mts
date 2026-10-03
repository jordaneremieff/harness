import assert from "node:assert/strict";
import { it } from "node:test";
import { createAgentToolCards, renderListResult, renderProfileResult } from "./tool-cards.ts";
import { theme } from "./dashboard-test-fixture.mts";
import { stripVTControlCharacters } from "node:util";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
const result = (details: unknown): AgentToolResult<unknown> => ({ content: [{ type: "text", text: JSON.stringify(details) }], details });
const screen = (card: { render(width: number): string[] }, width = 80) => card.render(width).map(stripVTControlCharacters).join("\n");
it("profile tool cards keep expertise on demand and show conflicts distinctly", () => {
	const profile = { identity: "root", handle: "@history", name: "History", role: "Review decisions", expertise: "Saved source pointer", revision: "abc", live: false, model: { provider: "fixture", modelId: "model" }, thinkingLevel: "high", requests: [] };
	for (const width of [32, 120]) {
		const text = screen(renderProfileResult(result(profile), { expanded: false, isPartial: false }, theme, { expanded: false }), width);
		assert.match(text, /@history/);
		assert.match(text, /Review decisions/);
		assert.doesNotMatch(text, /Saved source pointer/);
	}
	assert.match(screen(renderProfileResult(result(profile), { expanded: true, isPartial: false }, theme, { expanded: true })), /Saved source\s+pointer/);
	assert.match(screen(renderProfileResult(result({ outcome: "conflict", profile }), { expanded: false, isPartial: false }, theme, { expanded: false })), /Profile conflict; no change/);
	assert.ok(createAgentToolCards().agent_profile);
});
it("list tool cards show retained handles and roles rather than only record counts", () => {
	const details = { rows: [{ identity: "root", handle: "@history", name: "History", role: "Review decisions" }, { identity: "old", role: null }], nextCursor: null, coverage: { complete: true, storagesVisited: 2, unavailable: [], profileHints: { complete: false, unknownStorages: 1, omitted: 0 } } };
	const text = screen(renderListResult(result(details), { expanded: false, isPartial: false }, theme, { expanded: false }));
	assert.match(text, /@history · History/);
	assert.match(text, /Role: Review decisions/);
	assert.match(text, /unknown profile coverage/);
	assert.match(text, /Profile search incomplete/);
});
