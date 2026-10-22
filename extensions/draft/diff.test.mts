// Tests for the draft prose meter. The command line entry is meter.mts (run it with --help).
import assert from "node:assert/strict";
import test from "node:test";
import { buildReport } from "./scripts/analyze.mts";
import { analyzeDiff, parseDiff } from "./scripts/diff.mts";
import { analyzerFor, filler } from "./scripts/test-kit.mts";

const FIXTURE = [
	"diff --git a/docs/note.md b/docs/note.md",
	"index 1111111..2222222 100644",
	"--- a/docs/note.md",
	"+++ b/docs/note.md",
	"@@ -1,4 +1,6 @@",
	" # Note",
	" ",
	"+This is a pivotal step \u2014 really.",
	"+++ plus plus line to be honest",
	" Context with a dash \u2014 stays unreported.",
	"-Removed line with a dash \u2014 here.",
	" Last line.",
].join("\n");

function report(diff: string) {
	const analyzer = analyzerFor();
	const parsed = parseDiff(diff);
	const analysis = analyzeDiff(analyzer, parsed);
	return buildReport(analyzer, analysis.results, {
		inputKind: "diff",
		threshold: 35,
		rawLines: diff.split("\n").length,
		skippedFiles: analysis.skipped,
	});
}

test("parseDiff keeps new-file numbers and counts-driven hunk bodies", () => {
	const parsed = parseDiff(FIXTURE);
	assert.equal(parsed.files.length, 1);
	const hunk = parsed.files[0]?.hunks[0] ?? [];
	assert.deepEqual(
		hunk.filter((entry) => entry.added).map((entry) => entry.newLine),
		[3, 4],
	);
	assert.equal(hunk.find((entry) => entry.newLine === 4)?.text.startsWith("++ plus"), true);
});

test("only added lines are checked and findings use new-file line numbers", () => {
	const result = report(FIXTURE);
	const lines = result.hard.map((finding) => [finding.rule, finding.line, finding.file]);
	assert.deepEqual(lines, [
		["punctuation.em-dash", 3, "docs/note.md"],
		["epistemic.candour-frame", 4, "docs/note.md"],
	]);
	assert.equal(result.input.kind, "diff");
});

test("an added line that starts with two plus signs is analysed", () => {
	const diff = ["--- a/n.md", "+++ b/n.md", "@@ -0,0 +1,1 @@", "+++ frankly, no"].join("\n");
	assert.equal(report(diff).hard.length, 1);
});

test("fence state from context lines hides added code lines", () => {
	const diff = [
		"--- a/n.md",
		"+++ b/n.md",
		"@@ -10,3 +10,4 @@",
		" ```",
		"+to be honest in code",
		" ```",
		" tail",
	].join("\n");
	assert.equal(report(diff).hard.length, 0);
});

test("two hunks keep their own line numbers", () => {
	const diff = [
		"--- a/n.md",
		"+++ b/n.md",
		"@@ -1,1 +1,2 @@",
		" keep",
		"+a dash \u2014 one",
		"@@ -40,1 +41,2 @@",
		" keep",
		"+a dash \u2014 two",
	].join("\n");
	assert.deepEqual(
		report(diff).hard.map((finding) => finding.line),
		[2, 42],
	);
});

test("files without prose are skipped and listed, deleted files too", () => {
	const diff = [
		"diff --git a/data.json b/data.json",
		"--- a/data.json",
		"+++ b/data.json",
		"@@ -0,0 +1,1 @@",
		'+{"a": "to be honest"}',
		"diff --git a/old.md b/old.md",
		"--- a/old.md",
		"+++ /dev/null",
		"@@ -1,1 +0,0 @@",
		"-frankly gone",
	].join("\n");
	const result = report(diff);
	assert.equal(result.hard.length, 0);
	assert.deepEqual(result.omitted.skippedFiles, ["data.json", "old.md"]);
});

test("source files contribute comments only", () => {
	const diff = [
		"--- a/x.mts",
		"+++ b/x.mts",
		"@@ -0,0 +1,2 @@",
		'+const s = "to be honest";',
		"+// Frankly, this is slow.",
	].join("\n");
	const result = report(diff);
	assert.deepEqual(
		result.hard.map((finding) => [finding.rule, finding.line]),
		[["epistemic.candour-frame", 2]],
	);
});

test("the commit message in a patch preamble gets the commit checks", () => {
	const diff = [
		"commit 0123456789abcdef",
		"Author: A Person <a@example.org>",
		"Date:   Thu Oct 22 10:00:00 2026 +1100",
		"",
		"    I fixed the parser.",
		"",
		"diff --git a/a.md b/a.md",
		"--- a/a.md",
		"+++ b/a.md",
		"@@ -0,0 +1,1 @@",
		"+Plain text.",
	].join("\n");
	const rules = report(diff).hard.map((finding) => [finding.rule, finding.file]);
	assert.deepEqual(rules, [
		["commit.subject-period", "(commit message)"],
		["commit.subject-narrated", "(commit message)"],
	]);
});

test("a format-patch subject is read as the commit subject", () => {
	const diff = ["From: A <a@example.org>", "Subject: [PATCH 1/1] updates", "", "---", "--- a/a.md", "+++ b/a.md", "@@ -0,0 +1,1 @@", "+Text."].join("\n");
	assert.deepEqual(
		report(diff).hard.map((finding) => finding.rule),
		["commit.subject-generic"],
	);
});

test("scores cover added prose only", () => {
	const diff = ["--- a/a.md", "+++ b/a.md", "@@ -0,0 +1,3 @@", ...filler(80).split(". ").slice(0, 3).map((line) => `+${line}.`)].join("\n");
	const result = report(diff);
	assert.ok(result.input.words > 20);
	assert.equal(result.score.reliable, result.input.words >= 50);
});
