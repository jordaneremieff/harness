import assert from "node:assert/strict";
import { it } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { footerText, formatCost } from "./agent-footer.ts";
import { row } from "./dashboard-test-fixture.mts";
it("model truncation preserves reasoning, cost, and state", () => {
	for (const width of [80, 140]) {
		const text = footerText(
			row("one", { model: { provider: "long-provider", modelId: "界".repeat(200), thinkingLevel: "high" } }),
			width,
		);
		assert.ok(visibleWidth(text) <= width);
		assert.match(text, /high · \$0.42 · working/);
		assert.match(text, /…/);
	}
	assert.equal(formatCost(undefined), "$?");
	assert.equal(formatCost(0), "$0.00");
	assert.equal(formatCost(1, true), "≥$1.00");
});
