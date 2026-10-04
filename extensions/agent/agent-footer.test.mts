import assert from "node:assert/strict";
import { it } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { footerText, formatCost } from "./agent-footer.ts";
import { row } from "./dashboard-test-fixture.mts";
it("header facts form two aligned rows at wide and narrow pane widths", () => {
	for (const width of [58, 67, 100, 125, 162]) {
		const lines = footerText(row(), width, { context: 116000, window: 272000, input: 16000000, output: 48000 }).split("\n");
		assert.equal(lines.length, 2);
		assert.ok(lines.every((line) => visibleWidth(line) <= width));
		assert.match(lines[0], /Model +model · high · test/);
		assert.match(lines[1], /Context +116k\/272k \(43%\)/);
		assert.equal(lines[0].indexOf("Tokens"), 31, "the fact columns stay together at every pane width");
		assert.equal(lines[0].indexOf("Tokens"), lines[1].indexOf("Cost"));
		assert.doesNotMatch(lines.join("\n"), /In\/out/);
		assert.match(lines[0], /16M.*48k/);
	}
	assert.match(footerText(row(), 67), /Context +\?/);
	assert.match(footerText(row(), 67, { context: 160 }), /Context +160 +Cost/);
	assert.match(footerText(row(), 67, { window: 1000 }), /Context +\? +Cost/);
});

it("model truncation preserves reasoning and cost without repeating state", () => {
	for (const width of [80, 140]) {
		const text = footerText(
			row("one", { model: { provider: "long-provider", modelId: "界".repeat(200), thinkingLevel: "high" } }),
			width,
		);
		assert.ok(text.split("\n").every((line) => visibleWidth(line) <= width));
		assert.match(text, /high · long-provider/);
		assert.match(text, /Context/);
		assert.match(text, /…/);
		assert.doesNotMatch(text, /working/);
	}
	assert.equal(formatCost(undefined), "$?");
	assert.equal(formatCost(0), "$0.00");
	assert.equal(formatCost(1, true), "$1.00+");
	assert.equal(formatCost(1), "$1.00");
	assert.equal(formatCost(undefined, true), "$?");
	assert.match(footerText(row("partial", { cost: 1, partial: true }), 80).trimEnd(), /\$1\.00\+$/);
});
