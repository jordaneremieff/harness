import assert from "node:assert/strict";
import { it } from "node:test";
import type { AgentConversationEntry } from "./dashboard-types.ts";
import { contextTokens, usageText, compactTokens } from "./agent-usage.ts";

const usage = { input: 100, output: 20, cacheRead: 30, cacheWrite: 10, totalTokens: 160, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const assistant: AgentConversationEntry = { id: "1", kind: "pi.assistant", model: [{ role: "assistant", api: "openai-responses", provider: "test", model: "model", content: [], timestamp: 0, stopReason: "stop", usage }] };
it("token counts use the same compact units as the native footer", () => {
	for (const [tokens, expected] of [[999, "999"], [1000, "1.0k"], [9500, "9.5k"], [10000, "10k"], [163300, "163k"], [1000000, "1.0M"], [10000000, "10M"]] as const) assert.equal(compactTokens(tokens), expected);
	assert.equal(usageText(163300, 1000000), "context 163k/1.0M (16%)");
});
it("context uses the newest assistant usage and becomes unknown after compaction or reset", () => {
	assert.equal(contextTokens([assistant]), 160);
	for (const kind of ["pi.compaction", "pi.reset"]) {
		const rewrite = { id: "2", kind };
		assert.equal(contextTokens([assistant, rewrite]), undefined);
		assert.equal(contextTokens([rewrite, assistant]), 160);
	}
	assert.equal(contextTokens([]), undefined);
});
it("context shows tokens, window and percentage and totals include model and tool usage once", () => {
	assert.equal(usageText(160, 1000, { models: { "test/model": usage }, tools: { read: usage } }), "context 160/1.0k (16%) · tokens 280 in/40 out");
	assert.equal(usageText(undefined, 1000), "context ?/1.0k");
	assert.equal(usageText(160, undefined), "context 160");
});
