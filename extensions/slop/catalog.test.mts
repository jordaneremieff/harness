import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { type Detector, fenced, parseDetectors, parseEntry, type Scope } from "./catalog.ts";
import { checkLines, segment, testExamples } from "./detect.ts";
import { starterDir } from "./store.ts";

function starters() {
	return readdirSync(starterDir)
		.filter((file) => file.endsWith(".md") && file !== "README.md")
		.map((file) => parseEntry(readFileSync(join(starterDir, file), "utf8"), file.slice(0, -3), true));
}

const entrySource = `---
id: release-diary
title: Release diary
domain: "code"
applies: ["comment", "reply", "document"]
---

# Release diary

## Recognition

A diary label appears in place of the comment's purpose.

## Cost

The comment does not explain what the code requires.

## Repair

Name the rule that the code preserves. Remove the comment if there is no rule.
`;
function fixture(detector?: Detector) {
	return parseEntry(
		`${entrySource}${detector ? `\n## Detectors\n\n${fenced("json", JSON.stringify([detector]))}` : ""}`,
		"release-diary",
	);
}
const scope: Scope[] = ["reply", "comment", "document"];
const detector: Detector = { id: "marker", in: scope, phrases: ["release diary"] };

test("every starter entry declares prompt and its examples agree with its detectors", () => {
	const entries = starters();
	assert.ok(entries.length);
	for (const entry of entries) assert.deepEqual(testExamples(entry).failures, [], entry.id);
});

test("frontmatter requires a matching id and title and only starter entries require prompt", () => {
	assert.equal(fixture().prompt, true);
	assert.throws(() => parseEntry(entrySource, "release-diary", true), /declare prompt/);
	assert.throws(() => parseEntry(entrySource, "another"), /id must equal/);
	assert.throws(() => parseEntry(entrySource.replace("# Release diary", "# Different"), "release-diary"), /heading/);
	assert.throws(() => parseEntry(entrySource.replace("## Cost", "## Notes"), "release-diary"), /Cost/);
	assert.throws(() => parseEntry(entrySource.replace('domain: "code"', 'domain: "other"'), "release-diary"), /domain/);
	assert.throws(() => parseEntry(`${entrySource}\n## Repair\n\na`, "release-diary"), /Duplicate section/);
});

test("detector validation rejects invalid and contradictory fields", () => {
	assert.throws(() => parseDetectors([{ ...detector, match: "other" }], scope), /unknown field match/);
	assert.throws(() => parseDetectors([{ ...detector, in: ["commit"] }], scope), /scopes from applies/);
	assert.throws(() => parseDetectors([{ ...detector, pattern: "x" }], scope), /exactly one/);
	assert.throws(() => parseDetectors([{ id: "regex", in: scope, pattern: "(" }], scope), /invalid regular expression/);
	assert.throws(() => parseDetectors([{ ...detector, per: 12 }], scope), /per requires limit/);
	assert.throws(() => parseDetectors([detector, detector], scope), /unique/);
});

test("detector validation refuses repetitions whose matching time grows faster than the line", () => {
	for (const pattern of ["(a+)+", "(?:\\w+\\s?)+:", "(?<name>a*)*", "(?<=\\S+):", "(?<![a-z]{2,}):"])
		assert.throws(() => parseDetectors([{ id: "risky", in: scope, pattern }], scope), /Bound the repetition/, pattern);
	for (const pattern of [
		"\\p{L}+(?:-\\p{L}+){1,12}",
		"(?<=\\S{1,40}[ \\t]{1,8}):",
		"[(+)]+x",
		"\\(a+\\)+",
		"(?:ab){2,}",
		"(?<!-\\p{L})x+",
	])
		assert.doesNotThrow(() => parseDetectors([{ id: "bounded", in: scope, pattern }], scope), pattern);
});

test("examples use file segmentation and count matches before the allowance", () => {
	const entry = fixture({ ...detector, limit: 100, paths: ["src/**/*.ts"] });
	entry.examples = [
		{ kind: "ts", verdict: "slop", text: "// release diary" },
		{ kind: "ts", verdict: "better", text: 'const s = "// release diary";' },
		{ kind: "ts", verdict: "better", text: "// release diary" },
		{ kind: "ts", verdict: "slop", text: 'const s = "// release diary";' },
	];
	entry.detectors.push({ ...detector, id: "dead", phrases: ["unseen"] });
	assert.deepEqual(testExamples(entry), {
		failures: ["Example 3 (better, ts): matched marker.", "Detector dead: no matching Slop example."],
		unmatched: ["Example 4 (slop, ts)"],
	});
});

test("Markdown skips non-prose without altering original line numbers", () => {
	const text = [
		"---",
		"title: release diary",
		"---",
		"> release diary",
		"```text",
		"release diary",
		"```",
		"`release diary` [visible](release diary) https://example.test/release-diary",
		"<!-- start",
		"release diary --> **RELEASE  diary**",
		"release `unrelated` diary",
		"### release diary",
		"A pre-release diary is still a phrase.",
		"norelease diaryword",
	].join("\n");
	const [found] = checkLines([fixture(detector)], segment({ kind: "reply", text }), new Set());
	assert.equal(found.count, 3);
	assert.deepEqual(
		found.locations.map((location) => location.line),
		[10, 12, 13],
	);
});

test("comment families keep strings out of comment scope", () => {
	const input = [
		{
			path: "doc.ts",
			text: 'const q = "// release diary"; /* release diary */ const r = `hi\n// release diary`; // release diary\n/**\n * release diary\n */',
			expected: [1, 2, 4],
		},
		{
			path: "doc.py",
			text: '#!/bin/release diary\ns = "# release diary"\ns = """\n# release diary\n"""\nvalue = 1 # release diary',
			expected: [6],
		},
		{
			path: "doc.html",
			text: '<a title="<!-- release diary -->">someone\'s text</a>\n<!-- release diary -->',
			expected: [2],
		},
	];
	for (const { path, text, expected } of input) {
		const [found] = checkLines([fixture(detector)], segment({ kind: "file", path, text }), new Set());
		assert.deepEqual(
			found.locations.map((location) => location.line),
			expected,
			path,
		);
	}
});

test("allowance, distinct, allow and lexicon apply only to the chosen scope and path", () => {
	const entry = fixture({
		id: "density",
		in: ["reply"],
		pattern: "hint[0-9]",
		limit: 2,
		per: 6,
		allow: ["Hint1"],
		lexicon: true,
		distinct: true,
	});
	const text = "hint1 hint2 hint3 HINT3 hint4 hint5 hint6 one two three four five";
	const [found] = checkLines([entry], segment({ kind: "reply", text }), new Set(["hint2"]));
	assert.equal(found?.count, undefined); // Four distinct matches fit the allowance for twelve words.
	const [next] = checkLines([entry], segment({ kind: "reply", text }), new Set());
	assert.equal(next.count, 5);
	assert.equal(next.allowance, 4);
	const constrained = fixture({ ...detector, paths: ["src/**/*.ts"] });
	for (const path of ["src/file.ts", "src/nested/file.ts"])
		assert.equal(
			checkLines([constrained], segment({ kind: "file", path, text: "// release diary" }), new Set()).length,
			1,
		);
	assert.equal(
		checkLines([constrained], segment({ kind: "file", path: "docs/file.ts", text: "// release diary" }), new Set())
			.length,
		0,
	);
	assert.equal(checkLines([constrained], segment({ kind: "reply", text: "release diary" }), new Set()).length, 0);
});

test("the starter overview's Entries section lists exactly the starter ids", () => {
	const ids = starters()
		.map((entry) => entry.id)
		.sort();
	const text = readFileSync(join(starterDir, "README.md"), "utf8");
	const body = /^## Entries\s*\n([\s\S]*?)(?=^## |(?![\s\S]))/m.exec(text)?.[1];
	assert.ok(body, "catalog overview must contain the Entries section");
	const listed = [...body.matchAll(/^- `([a-z0-9-]+)`:/gm)].map((match) => match[1]).sort();
	assert.deepEqual(listed, ids);
});

test("caseSensitive keeps letter case and modifier groups fail validation", () => {
	const entry = fixture({ id: "caseful", in: ["reply"], pattern: "\\p{Lu}atch", caseSensitive: true });
	const [finding] = checkLines([entry], segment({ kind: "reply", text: "Match match" }), new Set());
	assert.equal(finding.count, 1);
	assert.equal(finding.locations[0].match, "Match");
	for (const pattern of ["(?-i:a)", "x(?i-ms:y)"])
		assert.throws(() => parseDetectors([{ id: "modifiers", in: scope, pattern }], scope), /caseSensitive/);
	assert.doesNotThrow(() => parseDetectors([{ id: "literal", in: scope, pattern: "\\(\\?-i:literal\\)" }], scope));
});

test("the compatibility detector recognises affixes in identifier case conventions", () => {
	const entry = starters().find((item) => item.id === "compatibility-shims");
	assert.ok(entry);
	const identifiers = ["legacyFoo", "LegacyFoo", "LEGACY_FOO", "fooLegacy"];
	const [found] = checkLines(
		[entry],
		segment({ kind: "file", path: "file.ts", text: identifiers.join("\n") }),
		new Set(),
	);
	assert.deepEqual(
		found.locations.map((location) => location.match),
		identifiers,
	);
});
