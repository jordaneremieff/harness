import assert from "node:assert/strict";
import { it } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { footerText, formatCost } from "./agent-footer.ts";
import { row } from "./dashboard-test-fixture.mts";
it("model truncation preserves reasoning and cost without repeating state", () => {
	for (const width of [80, 140]) {
		const text = footerText(
			row("one", { model: { provider: "long-provider", modelId: "界".repeat(200), thinkingLevel: "high" } }),
			width,
		);
		assert.ok(visibleWidth(text) <= width);
		assert.match(text, /high · \$0.42/);
		assert.match(text, /…/);
		assert.doesNotMatch(text, /working/);
	}
	assert.equal(formatCost(undefined), "$?");
	assert.equal(formatCost(0), "$0.00");
	assert.equal(formatCost(1, true), "$1.00+");
	assert.equal(formatCost(1), "$1.00");
	assert.equal(formatCost(undefined, true), "$?");
	assert.match(footerText(row("partial", { cost: 1, partial: true }), 80), /\$1\.00\+$/);
});
