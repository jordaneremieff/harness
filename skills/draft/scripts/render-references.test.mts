// Tests for the draft prose meter. The command line entry is meter.mts (run it with --help).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { analyzeText } from "./analyze.mts";
import { driftedFiles, renderFindings, renderLexicon } from "./render-references.mts";
import { loadRules } from "./rules.mts";
import { analyzerFor } from "./test-kit.mts";

const set = loadRules();
const SCRIPT = fileURLToPath(new URL("./render-references.mts", import.meta.url));

test("the generated references match the rule data", () => {
	assert.deepEqual(driftedFiles(set), []);
});

test("--check passes on a current tree and --help prints usage", () => {
	const check = spawnSync(process.execPath, [SCRIPT, "--check"], { encoding: "utf8" });
	assert.equal(check.status, 0, check.stderr);
	const help = spawnSync(process.execPath, [SCRIPT, "--help"], { encoding: "utf8" });
	assert.equal(help.status, 0);
	assert.match(help.stdout, /^Usage:/);
});

test("every rule appears in the findings reference", () => {
	const findings = renderFindings(set);
	for (const rule of set.rules) assert.ok(findings.includes(`\`${rule.id}\``), rule.id);
});

test("every pattern and terms rule appears in the lexicon with its exemptions", () => {
	const lexicon = renderLexicon(set);
	for (const rule of set.rules.filter((entry) => entry.detector === undefined)) {
		assert.ok(lexicon.includes(`### ${rule.id}`), rule.id);
	}
	assert.ok(!lexicon.includes("### structure.bold-label"));
	assert.match(lexicon, /Exempt when/);
});

test("generated files carry a table of contents and a no-edit banner", () => {
	for (const text of [renderFindings(set), renderLexicon(set)]) {
		assert.match(text, /## Contents/);
		assert.match(text, /Do not edit it by hand/);
	}
});

test("the generated references pass the meter's own hard rules", () => {
	const analyzer = analyzerFor();
	const repair = readFileSync(fileURLToPath(new URL("../references/repair.md", import.meta.url)), "utf8");
	for (const text of [renderFindings(set), renderLexicon(set), repair]) {
		assert.deepEqual(analyzeText(analyzer, text, "md").hard, []);
	}
});
