import assert from "node:assert/strict";
import { it } from "node:test";
import type { AgentConversationEntry } from "./dashboard-types.ts";
import { contextTokens, usageFacts, compactTokens, ordinaryReportedUsage } from "./agent-usage.ts";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

const usage = { input: 100, output: 20, cacheRead: 30, cacheWrite: 10, totalTokens: 160, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const ordinaryEntry = (type: "usage" | "compaction" | "branch_summary", cost: number | undefined): SessionEntry => ({ type, id: "entry", parentId: null, timestamp: "2026-01-01T00:00:00Z", ...(cost === undefined ? {} : { usage: { ...usage, cost: { ...usage.cost, total: cost } } }) }) as SessionEntry;
it("ordinary reported usage includes summary and auxiliary costs without claiming missing or omitted usage", () => {
	assert.deepEqual(ordinaryReportedUsage([ordinaryEntry("usage", 1), ordinaryEntry("compaction", 2), ordinaryEntry("branch_summary", 3)]), { reportedCost: 6, partial: false });
	assert.deepEqual(ordinaryReportedUsage([ordinaryEntry("compaction", undefined), ordinaryEntry("usage", Number.NaN), ordinaryEntry("usage", 1)]), { reportedCost: 1, partial: true });
	assert.deepEqual(ordinaryReportedUsage(Array.from({ length: 4097 }, () => ordinaryEntry("usage", 1))), { reportedCost: 4096, partial: true });
	assert.deepEqual(ordinaryReportedUsage([]), { reportedCost: 0, partial: false });
});
const assistant: AgentConversationEntry = { id: "1", kind: "pi.assistant", model: [{ role: "assistant", api: "openai-responses", provider: "test", model: "model", content: [], timestamp: 0, stopReason: "stop", usage }] };
it("token counts use the same compact units as the native footer", () => {
	for (const [tokens, expected] of [[999, "999"], [1000, "1.0k"], [9500, "9.5k"], [10000, "10k"], [163300, "163k"], [1000000, "1.0M"], [10000000, "10M"]] as const) assert.equal(compactTokens(tokens), expected);
});
it("context uses the newest assistant usage and becomes unknown after compaction or reset", () => {
	assert.equal(contextTokens([assistant]), 160);
	for (const kind of ["pi.compaction", "pi.reset"]) {
		const rewrite = { id: "2", kind };
		assert.equal(contextTokens([assistant, rewrite]), undefined);
		assert.equal(contextTokens([rewrite, assistant]), 160);
	}
	assert.equal(contextTokens([]), undefined);
	const message = assistant.model?.[0];
	assert.ok(message?.role === "assistant");
	assert.equal(contextTokens([{ ...assistant, model: [{ ...message, usage: { ...usage, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 } }] }]), 0);
});
it("usage facts keep unknown values and total model and tool usage once", () => {
	assert.deepEqual(usageFacts(160, 1000, { models: { "test/model": usage }, tools: { read: usage } }), { context: 160, window: 1000, input: 280, output: 40 });
	assert.deepEqual(usageFacts(undefined, 1000), { context: undefined, window: 1000 });
	for (const window of [undefined, 0, -1, Number.NaN, Number.POSITIVE_INFINITY])
		assert.deepEqual(usageFacts(160, window), { context: 160, window: undefined });
});
