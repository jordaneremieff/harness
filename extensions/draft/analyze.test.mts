// Tests for the draft prose meter. The command line entry is meter.mts (run it with --help).
import assert from "node:assert/strict";
import test from "node:test";
import { analyzeText, exitCodeFor, PER_RULE_CAP } from "./scripts/analyze.mts";
import { analyzerFor, filler, run } from "./scripts/test-kit.mts";

test("findings carry one-based line and column", () => {
	const report = run("First line.\nSecond \u2014 line.\n");
	const finding = report.hard[0];
	assert.equal(finding?.line, 2);
	assert.equal(finding?.column, 8);
	assert.equal(finding?.rule, "punctuation.em-dash");
});

test("listed findings are capped per rule and the rest is counted", () => {
	const text = Array.from({ length: PER_RULE_CAP + 25 }, (_, i) => `Line ${i} has a dash \u2014 here.`).join("\n\n");
	const report = run(text);
	assert.equal(report.hard.length, PER_RULE_CAP);
	assert.equal(report.omitted.hard, 25);
	assert.equal(report.omitted.byRule["punctuation.em-dash"], 25);
});

test("exit code combines hard findings and the score gate", () => {
	const clean = run(filler(100));
	assert.equal(exitCodeFor(clean), 0);
	const hard = run(`${filler(100)} A dash \u2014 here.`);
	assert.equal(exitCodeFor(hard), 1);
	const gate = { ...clean, score: { ...clean.score, sq: 50, threshold: 35 } };
	assert.equal(exitCodeFor(gate), 2);
	const both = { ...hard, score: { ...hard.score, sq: 50, threshold: 35 } };
	assert.equal(exitCodeFor(both), 3);
	const unreliable = { ...clean, score: { ...clean.score, sq: 50, reliable: false, threshold: 35 } };
	assert.equal(exitCodeFor(unreliable), 0);
});

test("a large input finishes within a fixed time", () => {
	const big = filler(120000);
	const started = Date.now();
	const report = analyzeText(analyzerFor(), big, "md");
	assert.ok(Date.now() - started < 15000);
	assert.ok(report.input.words > 100000);
});

test("report fields describe the input", () => {
	const report = run("# Title\n\nOne sentence here. Two sentences here.\n");
	assert.equal(report.input.kind, "md");
	assert.equal(report.input.lines, 3);
	assert.equal(report.contract, 1);
});
