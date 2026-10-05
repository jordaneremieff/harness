import assert from "node:assert/strict";
import { it } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { visibleWidth } from "@earendil-works/pi-tui";
import { footerText, formatCost } from "./agent-footer.ts";
import { row } from "./dashboard-test-fixture.mts";
it("detail facts use a model subheading and self-identifying known values", () => {
	for (const width of [58, 67, 100, 125, 162]) {
		const lines = footerText(row(), width, { context: 116000, window: 272000, input: 16000000, output: 48000 }).split("\n");
		assert.deepEqual(lines, ["test/model · high", "116k/272k (43%) ctx · 16M in · 48k out · $0.42"]);
		assert.ok(lines.every((line) => visibleWidth(line) <= width));
		assert.doesNotMatch(lines.join("\n"), /Model|Tokens|Context|Cost|\?/);
	}
	const painted: string[] = [];
	const text = footerText(row(), 67, {}, { fg: (color, value) => { assert.equal(color, "muted"); painted.push(value); return `\x1b[2m${value}\x1b[22m`; } });
	assert.equal(stripVTControlCharacters(text), "test/model · high\n$0.42");
	assert.deepEqual(painted, ["test/model · high", "$0.42"]);
});

it("detail facts omit absent values without dropping known zero or partial values", () => {
	const absent = row("absent", { model: undefined, cost: undefined });
	assert.equal(footerText(absent, 80), "");
	assert.equal(footerText(absent, 80, { window: 1000 }), "");
	assert.equal(footerText(absent, 80, { context: 160 }), "160 ctx");
	assert.equal(footerText(absent, 80, { input: 0 }), "0 in");
	assert.equal(footerText(absent, 80, { output: 0 }), "0 out");
	assert.equal(footerText(row("zero", { model: undefined, cost: 0 }), 80), "$0.00");
	assert.equal(footerText(row("partial", { model: undefined, cost: 1, partial: true }), 80), "$1.00+");
	assert.equal(footerText(row("invalid", { model: undefined, cost: Number.NaN }), 80), "");
});

it("model identifiers shorten only at available render width", () => {
	const model = { provider: "long-provider", modelId: `model-${"x".repeat(70)}`, thinkingLevel: "high" };
	assert.equal(footerText(row("one", { model }), 140).split("\n")[0], `${model.provider}/${model.modelId} · high`);
	for (const width of [40, 80, 140]) {
		const text = footerText(row("one", { model: { ...model, modelId: "界".repeat(200) } }), width);
		assert.ok(text.split("\n").every((line) => visibleWidth(line) <= width));
		assert.match(text, /long-provider\/.*… · high/);
		assert.doesNotMatch(text, /working|Model|Context|Tokens|Cost|\?/);
	}
	assert.equal(formatCost(undefined), "$?");
	assert.equal(formatCost(0), "$0.00");
	assert.equal(formatCost(1, true), "$1.00+");
	assert.equal(formatCost(1), "$1.00");
	assert.equal(formatCost(undefined, true), "$?");
});
