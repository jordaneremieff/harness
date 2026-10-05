import assert from "node:assert/strict";
import { it } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { visibleWidth } from "@earendil-works/pi-tui";
import { modelSubheading, formatCost } from "./agent-footer.ts";
import { row } from "./dashboard-test-fixture.mts";
it("model subheading contains identity only and uses muted text", () => {
	for (const width of [58, 67, 100, 125, 162]) {
		const text = modelSubheading(row(), width);
		assert.equal(text, "test/model · high");
		assert.ok(visibleWidth(text) <= width);
		assert.doesNotMatch(text, /ctx| in| out|\$|Model|Tokens|Context|Cost|\?/);
	}
	const painted: string[] = [];
	const text = modelSubheading(row(), 67, { fg: (color, value) => { assert.equal(color, "muted"); painted.push(value); return `\x1b[2m${value}\x1b[22m`; } });
	assert.equal(stripVTControlCharacters(text), "test/model · high");
	assert.deepEqual(painted, ["test/model · high"]);
});
it("model subheading omits absent identity regardless of known usage cost", () => {
	for (const cost of [undefined, 0, 1, Number.NaN]) assert.equal(modelSubheading(row("absent", { model: undefined, cost }), 80), "");
});
it("model identifiers shorten only at available render width", () => {
	const model = { provider: "long-provider", modelId: `model-${"x".repeat(70)}`, thinkingLevel: "high" };
	assert.equal(modelSubheading(row("one", { model }), 140), `${model.provider}/${model.modelId} · high`);
	for (const width of [40, 80, 140]) {
		const text = modelSubheading(row("one", { model: { ...model, modelId: "界".repeat(200) } }), width);
		assert.ok(visibleWidth(text) <= width);
		assert.match(text, /long-provider\/.*… · high/);
		assert.doesNotMatch(text, /working|Model|Context|Tokens|Cost|\?/);
	}
	assert.equal(formatCost(undefined), "$?");
	assert.equal(formatCost(0), "$0.00");
	assert.equal(formatCost(1, true), "$1.00+");
	assert.equal(formatCost(1), "$1.00");
	assert.equal(formatCost(undefined, true), "$?");
});
