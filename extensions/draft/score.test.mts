// Tests for the draft prose meter. The command line entry is meter.mts (run it with --help).
import assert from "node:assert/strict";
import test from "node:test";
import { loadRules } from "./scripts/rules.mts";
import { computeScore, countAnchors } from "./scripts/score.mts";
import { buildDoc } from "./scripts/detect.mts";
import { extract } from "./scripts/extract.mts";
import { filler, run } from "./scripts/test-kit.mts";

const scoring = loadRules().scoring;

test("relative and absolute path anchors retain whole filename prefixes", () => {
	for (const path of ["src/core/file.mts", "/var/log/app.log", "a-b/c.d/file.ts", "./src/core/file.ts"]) {
		assert.equal(countAnchors(buildDoc(extract(`The path is ${path}.`, "md"))), 1, path);
	}
	assert.equal(countAnchors(buildDoc(extract("word-".repeat(40000), "md"))), 0);
});

test("computeScore returns zero for empty input and no band under the word floor", () => {
	const score = computeScore({ words: 0, sentenceLengths: [], anchors: 0, hits: [] }, scoring);
	assert.equal(score.sq, 0);
	assert.equal(score.reliable, false);
	assert.equal(score.band, null);
});

test("a clean paragraph of real length is reliable and green", () => {
	const report = run(filler(120));
	assert.equal(report.score.reliable, true);
	assert.equal(report.score.band, "green");
	assert.ok(report.score.sq < scoring.bands.green);
});

test("dense stock vocabulary raises the lexical component and the band", () => {
	const slop =
		"This pivotal tapestry delves into a vibrant, holistic landscape. It is crucial to harness a robust paradigm and foster seamless synergy. The multifaceted interplay underscores a testament to bespoke, comprehensive and dynamic design across the ever-evolving realm of modern work.";
	const report = run(`${slop}\n\n${slop}`);
	assert.ok(report.score.components.lexical.value > 0.5, JSON.stringify(report.score.components.lexical));
	assert.notEqual(report.score.band, "green");
});

test("one isolated hit counts for less than the same hit inside a cluster", () => {
	const isolated = run(`${filler(100)} The result was pivotal for the team. ${filler(100)}`);
	const clustered = run(
		`${filler(100)} The result was pivotal, vibrant, holistic and seamless for the team. ${filler(100)}`,
	);
	const a = isolated.score.components.lexical.metrics.weighted ?? 0;
	const b = clustered.score.components.lexical.metrics.weighted ?? 0;
	assert.ok(a > 0 && b > (a * 4) / 2, `isolated ${a} clustered ${b}`);
});

test("hard findings never feed the score", () => {
	const plain = run(`${filler(120)}\n\n- Label text\n\nA dash here.\n`);
	const withHard = run(`${filler(120)}\n\n- **Label:** text\n\nA dash \u2014 here.\n`);
	assert.ok(withHard.hard.length >= 2);
	assert.equal(plain.hard.length, 0);
	assert.equal(withHard.score.sq, plain.score.sq);
});

test("anchors reduce the epistemic ratio", () => {
	const fluff = "It is important to note that the plan works. In conclusion, the plan works.";
	const bare = run(`${filler(60)} ${fluff}`);
	const anchored = run(
		`${filler(60)} ${fluff} The files \`a_b.txt\` and \`c_d.txt\` changed in v1.2.3 after 40 ms at /var/log/app/run.log on 2024-01-02.`,
	);
	assert.ok(
		(bare.score.components.epistemic.metrics.fluffToAnchorRatio ?? 0) >
			(anchored.score.components.epistemic.metrics.fluffToAnchorRatio ?? 0),
	);
});

test("burstiness is not measured below the sentence minimum", () => {
	const report = run("One short sentence here. Another short one.");
	assert.equal(report.score.components.geometry.metrics.sentenceLengthCv, null);
});

test("the calibration block is always present and names its cohort", () => {
	const report = run(filler(60));
	assert.equal(report.calibration.status, "calibrated-on-model-written-benchmark");
	assert.match(report.calibration.cohort ?? "", /model-written benchmark/);
	assert.equal(report.calibration.date, "2026-10-22");
});
