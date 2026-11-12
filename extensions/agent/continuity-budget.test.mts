import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { it } from "node:test";
import { planningBudgetBody, planningBudgetCrossed, planningBudgetSelfBody, planningBudgetSelfId, planningBudgetSourceId } from "./continuity-budget.ts";

it("detects a same-run planning-budget crossing below the model window, not an initial high sample", () => {
	assert.equal(planningBudgetCrossed(249_999, 250_000, 250_000, 500_000), true);
	assert.equal(planningBudgetCrossed(undefined, 250_000, 250_000, 500_000), false);
	assert.equal(planningBudgetCrossed(250_000, 300_000, 250_000, 500_000), false);
	assert.equal(planningBudgetCrossed(200_000, 249_999, 250_000, 500_000), false);
	for (const budget of [undefined, 0, Number.NaN, 500_000, 600_000]) assert.equal(planningBudgetCrossed(1, 700_000, budget, 500_000), false);
	assert.equal(planningBudgetCrossed(1, 250_000, 250_000, undefined), false);
});

it("uses the exact explicit recipient/producer/run tuple for report deduplication", () => {
	const expected = `child-budget:${createHash("sha256").update('["owner","worker:2",4]').digest("hex")}`;
	assert.equal(planningBudgetSourceId("owner", "worker:2", 4), expected);
	assert.notEqual(planningBudgetSourceId("other", "worker:2", 4), expected);
	assert.notEqual(planningBudgetSourceId("owner", "worker:2", 5), expected);
	assert.equal(planningBudgetBody("worker:2", 250_000, 250_000, "provider/model"), "Child worker:2 reported 250000 context tokens, at or above its planning budget of 250000 for provider/model. The budget is a planning preference, not a limit.");
	assert.equal(planningBudgetSelfId(10, 3), "agent.budget:10:3");
	assert.equal(planningBudgetSelfBody(300_000, 300_000, "provider/model", 0), "Context use reached 300000 tokens at 1970-01-01T00:00:00.000Z, at or above the planning budget of 300000 for provider/model. The budget is a planning preference, not a limit.");
});
