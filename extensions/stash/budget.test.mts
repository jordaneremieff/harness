import assert from "node:assert/strict";
import { test } from "node:test";
import type { UsageState } from "@earendil-works/pi-durable";
import { BUDGET_NOTICE, budgetAction, budgetContext, budgetNotice, budgetStatus, conversationCost, ORDINARY_COST } from "./budget.ts";

const budget = { contextTokens: 120000, costUsd: 5 };
const usage = (total: number) => ({ input: 10, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 11, cost: { input: total, output: 0, cacheRead: 0, cacheWrite: 0, total } });

test("budgets require an explicit positive token and dollar selection", () => {
	assert.deepEqual(budgetAction([]), { kind: "status" });
	assert.deepEqual(budgetAction(["off"]), { kind: "off" });
	assert.deepEqual(budgetAction(["120000", "5"]), { kind: "set", budget });
	assert.deepEqual(budgetAction(["1", ".5"]), { kind: "set", budget: { contextTokens: 1, costUsd: 0.5 } });
	for (const args of [["1"], ["off", "5"], ["0", "5"], ["1.5", "5"], ["1", "0"], ["NaN", "5"], ["1", "Infinity"], ["9007199254740992", "5"], ["1", "5", "extra"]]) assert.throws(() => budgetAction(args), /Usage:/);
	assert.match(budgetStatus(undefined), /disabled/);
	assert.match(budgetStatus(budget), /reset and compaction do not clear/);
});

test("absolute host context stays available independently of percentage and window", () => {
	assert.deepEqual(budgetContext(() => ({ tokens: 1234, percent: null, contextWindow: 0 })), { kind: "host_estimate", tokens: 1234 });
	for (const tokens of [null, NaN, Infinity, -1]) assert.deepEqual(budgetContext(() => ({ tokens, percent: 95, contextWindow: 10000 })), { kind: "unavailable" });
	assert.deepEqual(budgetContext(() => { throw new Error("host unavailable"); }), { kind: "unavailable" });
});

test("cost reads only the supplied conversation model and tool buckets", () => {
	assert.deepEqual(conversationCost({ models: { "provider/model": usage(1.25), "provider/other": usage(0.75) }, tools: { tool: usage(0.5) } }), { kind: "recorded", usd: 2.5 });
	assert.deepEqual(conversationCost({ models: {}, tools: {} }), { kind: "recorded", usd: 0 });
	assert.equal(conversationCost(undefined).kind, "unavailable");
	for (const amount of [0, NaN, Infinity, -1]) assert.equal(conversationCost({ models: { model: usage(amount) }, tools: {} }).kind, "unavailable");
	assert.equal(conversationCost({ models: { model: { ...usage(1), cost: undefined } }, tools: {} } as unknown as UsageState).kind, "unavailable");
});

test("notices distinguish estimates, missing cost, recorded cost and budget reach", () => {
	const text = budgetNotice(budget, { kind: "host_estimate", tokens: 120000 }, { kind: "recorded", usd: 6 });
	assert.ok(text.startsWith(BUDGET_NOTICE));
	assert.match(text, /host estimate: 120000 tokens/);
	assert.match(text, /USD 6\.000000 \/ USD 5 budget \(at or above budget\)/);
	assert.match(text, /price provenance and coverage are unverified/);
	assert.match(text, /not a billing or quota measurement/);
	assert.match(text, /an in-flight response is not included/);
	assert.match(text, /do not change percentage gates/);
	const unknown = budgetNotice(budget, { kind: "unavailable" }, ORDINARY_COST);
	assert.match(unknown, /context tokens: unavailable/);
	assert.match(unknown, /cumulative cost: unavailable/);
	assert.doesNotMatch(unknown, /USD 0\.000000/);
	assert.match(budgetNotice(budget, { kind: "request_estimate", tokens: 10 }, { kind: "recorded", usd: 1 }), /request estimate: 10 tokens.*below budget/);
});
